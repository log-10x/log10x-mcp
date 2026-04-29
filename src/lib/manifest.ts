/**
 * Remote manifest fetch — lets the Log10x team iterate on tool descriptions,
 * titles, annotations, and visibility without shipping an npm release.
 *
 * **Trust model**: The manifest can ONLY refine metadata for tools that are
 * already implemented in this package. It cannot add executable logic, change
 * input schemas, or route handlers anywhere new. A compromised manifest
 * endpoint can:
 *   - rewrite a tool description (LLM prompt-injection surface)
 *   - hide an existing tool (denial-of-feature)
 * It cannot:
 *   - run new code
 *   - exfiltrate user data (no data flows to the manifest endpoint; only a
 *     GET request is made; the manifest URL never sees prompts, args, or
 *     results)
 *   - upgrade itself to a schema this client doesn't already understand
 *     (`MAX_KNOWN_MANIFEST_VERSION` pin — newer manifests are rejected)
 *
 * **Failure modes are silent fallbacks** — DNS failure, timeout, 404, 500,
 * malformed JSON, schema mismatch, unknown manifest_version, min_client_version
 * we can't satisfy: all fall through to the on-disk cache, then to the
 * package-baked defaults. The MCP must boot whether or not the manifest endpoint
 * is reachable.
 *
 * **User opt-outs**:
 *   - `LOG10X_MANIFEST_DISABLED=1` — no fetch, no cache read, package defaults.
 *   - `LOG10X_MANIFEST_URL=...` — point at a self-hosted / pinned manifest
 *     (enterprise + air-gapped use cases).
 */
import { promises as fs, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from './log.js';

/**
 * Highest manifest schema version this client knows how to read. A manifest
 * with `manifest_version > MAX_KNOWN_MANIFEST_VERSION` is rejected outright —
 * future schemas (handler refs, new tools, signed payloads) require a newer
 * client, never a silent forward-upgrade. Bump this only when src/lib/manifest.ts
 * actually handles the new fields.
 */
export const MAX_KNOWN_MANIFEST_VERSION = 1;

const DEFAULT_MANIFEST_URL = 'https://dl.log10x.com/mcp/v1/manifest.json';

/** Boot fetch budget — past this, callers fall back to cache/defaults. */
const FETCH_TIMEOUT_MS = 2000;

const ToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .optional();

const ToolOverrideSchema = z.object({
  description: z.string().optional(),
  title: z.string().optional(),
  annotations: ToolAnnotationsSchema,
  enabled: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  /** Free-form note appended to the description when `deprecated: true`. */
  deprecationMessage: z.string().optional(),
});

const NoticeSchema = z.object({
  level: z.enum(['info', 'warn']),
  message: z.string(),
  /** ISO-8601 timestamp; notices past this are dropped at apply time. */
  showUntil: z.string().optional(),
});

const ManifestSchema = z.object({
  manifestVersion: z.number().int().positive(),
  generatedAt: z.string().optional(),
  /** Semver string. If our client's version is below this, manifest is dropped. */
  minClientVersion: z.string().optional(),
  tools: z.record(z.string(), ToolOverrideSchema).optional(),
  globalNotices: z.array(NoticeSchema).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ToolOverride = z.infer<typeof ToolOverrideSchema>;
export type ManifestNotice = z.infer<typeof NoticeSchema>;

/** Where the loader caches the last good manifest. Override via env for tests. */
function cachePath(): string {
  if (process.env.LOG10X_MANIFEST_CACHE_PATH) {
    return process.env.LOG10X_MANIFEST_CACHE_PATH;
  }
  return path.join(os.homedir(), '.log10x', 'manifest-cache.json');
}

/**
 * Walk up from this module's location until we find the file. Used to
 * resolve `package.json` and the shipped `default-manifest.json` regardless
 * of whether we're running from `build/lib/` (production) or
 * `test-build/src/lib/` (tests).
 */
function findUpwards(filename: string): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, filename);
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function manifestUrl(): string {
  return process.env.LOG10X_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

function isDisabled(): boolean {
  return process.env.LOG10X_MANIFEST_DISABLED === '1';
}

/**
 * Compare two semver strings (`a >= b`). Returns true when `a` is at least
 * as new as `b`. Tolerates missing patch/minor (`1.5` ≥ `1.4.9`). Anything
 * unparseable returns true (fail-open — never block on a malformed comparison).
 */
function semverGte(a: string, b: string): boolean {
  const parse = (s: string): number[] => {
    const parts = s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
    if (parts.some((n) => Number.isNaN(n))) return [];
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const av = parse(a);
  const bv = parse(b);
  if (av.length === 0 || bv.length === 0) return true;
  for (let i = 0; i < 3; i++) {
    if (av[i] > bv[i]) return true;
    if (av[i] < bv[i]) return false;
  }
  return true;
}

/**
 * Validate a parsed JSON object against the manifest schema and apply the
 * version-pinning rules. Returns the typed manifest if it's safe to use,
 * or `null` with a logged reason otherwise.
 */
function validateManifest(raw: unknown, clientVersion: string): Manifest | null {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn('manifest.invalid_schema', { issues: parsed.error.issues.slice(0, 3) });
    return null;
  }
  const m = parsed.data;
  if (m.manifestVersion > MAX_KNOWN_MANIFEST_VERSION) {
    log.warn('manifest.version_too_new', {
      manifestVersion: m.manifestVersion,
      maxKnown: MAX_KNOWN_MANIFEST_VERSION,
    });
    return null;
  }
  if (m.minClientVersion && !semverGte(clientVersion, m.minClientVersion)) {
    log.warn('manifest.client_too_old', {
      clientVersion,
      minRequired: m.minClientVersion,
    });
    return null;
  }
  return m;
}

async function fetchRemote(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      log.warn('manifest.fetch_http_error', { status: res.status, url });
      return null;
    }
    return await res.json();
  } catch (e) {
    log.warn('manifest.fetch_failed', { url, err: (e as Error).message });
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function readCache(): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(raw: unknown): Promise<void> {
  const target = cachePath();
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(raw), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (e) {
    log.warn('manifest.cache_write_failed', { err: (e as Error).message });
  }
}

/**
 * The package-baked manifest, loaded synchronously at module load from
 * the `default-manifest.json` shipped at the repo root. This is the
 * source of truth for every tool's title/description/annotations — the
 * registerLog10xTool helper in index.ts reads from it at registration
 * time so each registerTool site doesn't have to inline its copy.
 *
 * Throws on first import if the file is missing or invalid — this is a
 * BUILD-TIME error (someone removed the JSON or shipped a malformed
 * payload), not a runtime fallback case.
 */
function loadPackageDefaultManifest(): Manifest {
  const file = findUpwards('default-manifest.json');
  if (!file) {
    throw new Error(
      '[log10x-mcp] default-manifest.json not found — package is missing its tool metadata. ' +
        'Reinstall the package or check that `files` in package.json includes default-manifest.json.'
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(
      `[log10x-mcp] default-manifest.json at ${file} is malformed JSON: ${(e as Error).message}`
    );
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[log10x-mcp] default-manifest.json at ${file} fails schema validation: ` +
        JSON.stringify(parsed.error.issues.slice(0, 3))
    );
  }
  if (parsed.data.manifestVersion > MAX_KNOWN_MANIFEST_VERSION) {
    throw new Error(
      `[log10x-mcp] default-manifest.json declares manifestVersion=${parsed.data.manifestVersion} ` +
        `but this client only knows ${MAX_KNOWN_MANIFEST_VERSION}.`
    );
  }
  return parsed.data;
}

const PACKAGE_DEFAULT_MANIFEST: Manifest = loadPackageDefaultManifest();

/**
 * Look up a tool's package-default metadata (title, description,
 * annotations). Throws if the tool isn't in the manifest — that's a
 * build-time error: index.ts is registering a tool whose metadata
 * was never extracted into default-manifest.json.
 */
export function getPackageDefaultTool(name: string): ToolOverride {
  const meta = PACKAGE_DEFAULT_MANIFEST.tools?.[name];
  if (!meta) {
    throw new Error(
      `[log10x-mcp] no default-manifest.json entry for tool "${name}". ` +
        'Add it to default-manifest.json before registering the tool.'
    );
  }
  return meta;
}

/** Read-only access to the package default manifest. Tests use this. */
export function getPackageDefaultManifest(): Manifest {
  return PACKAGE_DEFAULT_MANIFEST;
}

let cachedManifest: Manifest | null = null;
let manifestLoaded = false;

/**
 * Fetch the remote manifest (with on-disk cache fallback) and validate it
 * against the schema + version pins. Idempotent — repeated calls return the
 * already-loaded manifest without re-fetching. Stores the result in a
 * module-level singleton; reads via `getManifest()`.
 */
export async function loadManifest(clientVersion: string): Promise<Manifest | null> {
  if (manifestLoaded) return cachedManifest;
  manifestLoaded = true;
  if (isDisabled()) {
    log.info('manifest.disabled');
    return null;
  }
  const remote = await fetchRemote(manifestUrl());
  if (remote !== null) {
    const validated = validateManifest(remote, clientVersion);
    if (validated) {
      cachedManifest = validated;
      // Awaiting the cache write so the next boot's offline fallback is
      // already in place — typically <5ms on local disk, dwarfed by the
      // network fetch we just did.
      await writeCache(remote);
      log.info('manifest.loaded', {
        source: 'remote',
        version: validated.manifestVersion,
        tools: Object.keys(validated.tools ?? {}).length,
      });
      return cachedManifest;
    }
  }
  const cached = await readCache();
  if (cached !== null) {
    const validated = validateManifest(cached, clientVersion);
    if (validated) {
      cachedManifest = validated;
      log.info('manifest.loaded', {
        source: 'cache',
        version: validated.manifestVersion,
        tools: Object.keys(validated.tools ?? {}).length,
      });
      return cachedManifest;
    }
  }
  log.info('manifest.fallback_to_defaults');
  return null;
}

/** Return whatever was loaded by the most recent `loadManifest` call. */
export function getManifest(): Manifest | null {
  return cachedManifest;
}

/** Resets the module-level cache. Tests only. */
export function _resetForTests(): void {
  cachedManifest = null;
  manifestLoaded = false;
}

/**
 * Filter notices that have an explicit `showUntil` in the past. Notices
 * without `showUntil` are always shown.
 */
export function activeNotices(m: Manifest | null): ManifestNotice[] {
  if (!m?.globalNotices) return [];
  const now = Date.now();
  return m.globalNotices.filter((n) => {
    if (!n.showUntil) return true;
    const t = Date.parse(n.showUntil);
    return Number.isNaN(t) || t > now;
  });
}

/**
 * Patch already-registered tools with manifest-supplied metadata. Called
 * exactly once during boot, after every `server.registerTool(...)` has run
 * and the registry map is fully populated. Tools the manifest names but the
 * package doesn't ship are logged + skipped (forward-compat: a future
 * manifest can mention tools that exist in a newer client).
 *
 * `enabled: false` calls `.disable()` on the SDK's RegisteredTool, which hides
 * the tool from `tools/list` so the LLM never sees it.
 *
 * `deprecated: true` prefixes the description with a `[DEPRECATED]` marker
 * (plus the manifest-supplied reason if any) — the tool stays callable but
 * the LLM is steered toward the recommended replacement via the description.
 */
export function applyManifestToTools(
  manifest: Manifest,
  registry: Map<string, RegisteredTool>
): void {
  if (!manifest.tools) return;
  for (const [name, override] of Object.entries(manifest.tools)) {
    const tool = registry.get(name);
    if (!tool) {
      log.warn('manifest.unknown_tool', { name });
      continue;
    }
    if (override.enabled === false) {
      tool.disable();
      log.info('manifest.tool_disabled', { name });
      continue;
    }
    const updates: Parameters<typeof tool.update>[0] = {};
    if (override.title !== undefined) updates.title = override.title;
    if (override.annotations !== undefined) updates.annotations = override.annotations;
    let description = override.description;
    if (override.deprecated) {
      const base = description ?? tool.description ?? '';
      const reason = override.deprecationMessage
        ? `[DEPRECATED: ${override.deprecationMessage}]`
        : '[DEPRECATED]';
      description = `${reason} ${base}`.trim();
    }
    if (description !== undefined) updates.description = description;
    if (Object.keys(updates).length > 0) {
      tool.update(updates);
      log.info('manifest.tool_updated', { name, fields: Object.keys(updates) });
    }
  }
}

/**
 * Read this package's version from package.json by walking up from this
 * module's location. Used to enforce `min_client_version` in manifests.
 *
 * Returns `'unknown'` on any failure — the manifest validator treats
 * an unparseable client version as "satisfies any requirement" (fail-open),
 * matching how unknown semver comparisons resolve in `semverGte`.
 */
export function readClientVersion(): string {
  const file = findUpwards('package.json');
  if (!file) return 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
