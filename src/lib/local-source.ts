/**
 * Local-source POC sampling: pulls log lines directly from the
 * customer's own infrastructure (Kubernetes pods, local files/globs;
 * docker containers and journald in follow-up work) when no log
 * analyzer connection is available.
 *
 * Use cases:
 *   - Prospect has no Datadog / Splunk / Elastic / etc. connection
 *   - Prospect has the connection but is unwilling to share API
 *     credentials yet (security review pending)
 *   - The SIEM-attached path failed and the LLM agent has explicit
 *     user consent to fall through (caller responsibility)
 *
 * Output framing in the renderer is different from SIEM-attached
 * mode: the dollar figure is NOT a prediction of the prospect's
 * actual bill, because we only see Kubernetes pod stdout — not
 * CloudTrail, ALB access logs, app logs from VMs, or anything else
 * the SIEM ingests. The local-source path renders an industry
 * pricing matrix ("at Datadog list price, this would be $X/yr; at
 * Splunk list price, $Y/yr") and forces the user to declare the
 * sample representative via the sample-composition table.
 */

import { spawn } from 'child_process';
import { open, readdir, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';

export interface LocalSourceOptions {
  /** Kubernetes namespace; default 'default'. Pass '*' for all namespaces. */
  namespace?: string;
  /**
   * How far back to read logs per pod. Translated to `kubectl logs
   * --since=<window>`. Default '1h'.
   */
  window?: string;
  /** Cap on log lines pulled per pod. Default 5000. */
  perPodLimit?: number;
  /** Cap on number of pods sampled. Default 20. */
  maxPods?: number;
  /** Per-pod kubectl timeout in ms. Default 10000. */
  perPodTimeoutMs?: number;
  /** Override `kubectl` binary path (test seam). */
  kubectlPath?: string;
}

export interface LocalSourceResult {
  /** Raw log lines pulled across all sampled sources. */
  events: string[];
  /** Total bytes pulled (sum of line lengths). */
  totalBytes: number;
  /** Per-source breakdown for the sample-composition table. */
  composition: Array<{ source: string; bytes: number; lines: number; pct: number }>;
  /** Sources (pods / files) that were considered but failed (e.g., access denied). */
  failedSources: string[];
  /** Wall time spent pulling. */
  wallTimeMs: number;
  /** Notes for the report (kubectl-not-installed, no-pods-found, etc.). */
  notes: string[];
}

export interface FileSourceOptions {
  /**
   * Files, directories, or glob patterns (`*`, `**`, `?`). A directory is
   * read one level deep (non-recursive); use `dir/**` for the full tree.
   */
  paths: string[];
  /** Cap on number of files sampled. Default 50. */
  maxFiles?: number;
  /** Cap on log lines pulled per file (tail). Default 10000. */
  perFileLimit?: number;
  /** Read at most this many bytes from the end of each file. Default 16 MiB. */
  maxBytesPerFile?: number;
}

/**
 * Pull log lines from the customer's Kubernetes cluster and aggregate
 * them by pod for the sample-composition table.
 *
 * Failure modes (any of which set the appropriate note + return what
 * partial data was collected):
 *   - kubectl not installed → returns empty result with note
 *   - no pods in namespace → returns empty with note
 *   - per-pod kubectl logs failure → skip pod, add to `failedSources`
 *   - per-pod timeout → skip pod, add to `failedSources`
 */
export async function sampleFromKubectl(
  opts: LocalSourceOptions = {}
): Promise<LocalSourceResult> {
  const namespace = opts.namespace ?? 'default';
  const window = opts.window ?? '1h';
  const perPodLimit = opts.perPodLimit ?? 5000;
  const maxPods = opts.maxPods ?? 20;
  const perPodTimeoutMs = opts.perPodTimeoutMs ?? 10_000;
  const kubectlPath = opts.kubectlPath ?? 'kubectl';

  const start = Date.now();
  const notes: string[] = [];
  const failedSources: string[] = [];
  const events: string[] = [];
  const compositionMap = new Map<string, { bytes: number; lines: number }>();

  // 1. Enumerate pods.
  let podRefs: Array<{ namespace: string; name: string }>;
  try {
    podRefs = await listPods(kubectlPath, namespace, perPodTimeoutMs);
  } catch (e) {
    const msg = (e as Error).message;
    if (/ENOENT|not found/i.test(msg)) {
      notes.push('kubectl binary not found on PATH — install kubectl or set kubectlPath.');
    } else {
      notes.push(`kubectl get pods failed: ${msg.slice(0, 200)}`);
    }
    return {
      events: [],
      totalBytes: 0,
      composition: [],
      failedSources: [],
      wallTimeMs: Date.now() - start,
      notes,
    };
  }

  if (podRefs.length === 0) {
    notes.push(`No pods found in namespace "${namespace}".`);
    return {
      events: [],
      totalBytes: 0,
      composition: [],
      failedSources: [],
      wallTimeMs: Date.now() - start,
      notes,
    };
  }

  // 2. Random-sample down to maxPods.
  const sampled = pickRandom(podRefs, maxPods);

  // 3. Pull logs per pod, sequentially. Sequential keeps kubectl from
  // hammering the API server; the per-pod call is short-lived.
  for (const pod of sampled) {
    const podKey = `${pod.namespace}/${pod.name}`;
    try {
      const lines = await readPodLogs(
        kubectlPath,
        pod.namespace,
        pod.name,
        window,
        perPodLimit,
        perPodTimeoutMs
      );
      let podBytes = 0;
      for (const line of lines) {
        if (line.length === 0) continue;
        events.push(line);
        podBytes += Buffer.byteLength(line, 'utf8');
      }
      const existing = compositionMap.get(podKey) ?? { bytes: 0, lines: 0 };
      existing.bytes += podBytes;
      existing.lines += lines.length;
      compositionMap.set(podKey, existing);
    } catch (e) {
      failedSources.push(`${podKey}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const totalBytes = Array.from(compositionMap.values()).reduce(
    (s, v) => s + v.bytes,
    0
  );

  const composition = Array.from(compositionMap.entries())
    .map(([source, v]) => ({
      source,
      bytes: v.bytes,
      lines: v.lines,
      pct: totalBytes > 0 ? (v.bytes / totalBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    events,
    totalBytes,
    composition,
    failedSources,
    wallTimeMs: Date.now() - start,
    notes,
  };
}

/**
 * Pure helper: random subsample without replacement. Exported for tests.
 */
export function pickRandom<T>(items: T[], n: number, rng: () => number = Math.random): T[] {
  if (items.length <= n) return items.slice();
  // Reservoir sampling.
  const reservoir = items.slice(0, n);
  for (let i = n; i < items.length; i++) {
    const j = Math.floor(rng() * (i + 1));
    if (j < n) reservoir[j] = items[i];
  }
  return reservoir;
}

async function listPods(
  kubectlPath: string,
  namespace: string,
  timeoutMs: number
): Promise<Array<{ namespace: string; name: string }>> {
  const args =
    namespace === '*'
      ? ['get', 'pods', '--all-namespaces', '-o', 'json']
      : ['get', 'pods', '-n', namespace, '-o', 'json'];
  const stdout = await runCommand(kubectlPath, args, timeoutMs);
  const parsed = JSON.parse(stdout) as {
    items?: Array<{ metadata?: { namespace?: string; name?: string } }>;
  };
  const items = parsed.items ?? [];
  return items
    .map((it) => ({
      namespace: it.metadata?.namespace ?? '',
      name: it.metadata?.name ?? '',
    }))
    .filter((p) => p.name);
}

async function readPodLogs(
  kubectlPath: string,
  namespace: string,
  pod: string,
  window: string,
  perPodLimit: number,
  timeoutMs: number
): Promise<string[]> {
  const args = [
    'logs',
    '-n',
    namespace,
    pod,
    `--since=${window}`,
    `--tail=${perPodLimit}`,
  ];
  const stdout = await runCommand(kubectlPath, args, timeoutMs);
  return stdout.split('\n').filter((s) => s.length > 0);
}

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

// ── File / glob source ──────────────────────────────────────────────────────

/**
 * Pull log lines from local files — the serverless-estate analog of
 * `sampleFromKubectl`. A host with no cluster (100% Lambda shops, plain
 * VMs, a laptop with a downloaded log bundle) samples from files or glob
 * patterns instead. Reads the TAIL of each file so a multi-GB log costs
 * at most `maxBytesPerFile` of IO.
 *
 * Failure modes mirror the kubectl sampler: unmatched patterns and
 * unreadable files become notes / `failedSources`, never throws.
 */
export async function sampleFromFiles(opts: FileSourceOptions): Promise<LocalSourceResult> {
  const maxFiles = opts.maxFiles ?? 50;
  const perFileLimit = opts.perFileLimit ?? 10_000;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 16 * 1024 * 1024;

  const start = Date.now();
  const notes: string[] = [];
  const failedSources: string[] = [];
  const events: string[] = [];
  const compositionMap = new Map<string, { bytes: number; lines: number }>();

  const empty = () => ({
    events: [],
    totalBytes: 0,
    composition: [],
    failedSources,
    wallTimeMs: Date.now() - start,
    notes,
  });

  if (!opts.paths || opts.paths.length === 0) {
    notes.push('No paths supplied — pass files, directories, or glob patterns.');
    return empty();
  }

  // 1. Expand each requested path to concrete files.
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const raw of opts.paths) {
    let expanded: string[];
    try {
      expanded = await expandPathPattern(raw);
    } catch (e) {
      failedSources.push(`${raw}: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    if (expanded.length === 0) {
      notes.push(`No files matched "${raw}".`);
    }
    for (const f of expanded) {
      if (!seen.has(f)) {
        seen.add(f);
        matched.push(f);
      }
    }
  }

  if (matched.length === 0) {
    notes.push('No files matched any of the supplied paths.');
    return empty();
  }

  // 2. Random-sample down to maxFiles, same policy as the pod sampler.
  const sampled = pickRandom(matched, maxFiles);
  if (matched.length > maxFiles) {
    notes.push(`${matched.length} files matched; sampled ${maxFiles} (raise maxFiles to widen).`);
  }

  // 3. Tail each file.
  for (const file of sampled) {
    try {
      const lines = await readFileTail(file, perFileLimit, maxBytesPerFile);
      let fileBytes = 0;
      let fileLines = 0;
      for (const line of lines) {
        if (line.length === 0) continue;
        events.push(line);
        fileBytes += Buffer.byteLength(line, 'utf8');
        fileLines++;
      }
      compositionMap.set(file, { bytes: fileBytes, lines: fileLines });
    } catch (e) {
      failedSources.push(`${file}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const totalBytes = Array.from(compositionMap.values()).reduce((s, v) => s + v.bytes, 0);

  const composition = Array.from(compositionMap.entries())
    .map(([source, v]) => ({
      source,
      bytes: v.bytes,
      lines: v.lines,
      pct: totalBytes > 0 ? (v.bytes / totalBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    events,
    totalBytes,
    composition,
    failedSources,
    wallTimeMs: Date.now() - start,
    notes,
  };
}

/** Cap on files collected per pattern while walking (runaway-glob guard). */
const GLOB_WALK_FILE_CAP = 2000;

const GLOB_CHARS = /[*?]/;

/**
 * Expand one requested path:
 *   - literal file → itself
 *   - literal directory → its plain files, one level (use `dir/**` to recurse)
 *   - glob (`*`, `?`, `**`) → walk from the longest literal prefix directory
 */
async function expandPathPattern(raw: string): Promise<string[]> {
  const p = resolve(raw);

  if (!GLOB_CHARS.test(p)) {
    const st = await stat(p); // throws for missing paths → failedSources
    if (st.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => join(p, e.name));
    }
    return st.isFile() ? [p] : [];
  }

  const segs = p.split(sep).filter((s) => s.length > 0);
  let literalEnd = 0;
  while (literalEnd < segs.length && !GLOB_CHARS.test(segs[literalEnd])) literalEnd++;
  const baseDir = sep + segs.slice(0, literalEnd).join(sep);
  const patSegs = segs.slice(literalEnd);

  const out: string[] = [];
  const budget = { remaining: GLOB_WALK_FILE_CAP };
  await walkCollect(baseDir, [], patSegs, out, budget);
  return out;
}

async function walkCollect(
  dir: string,
  relSegs: string[],
  patSegs: string[],
  out: string[],
  budget: { remaining: number }
): Promise<void> {
  if (budget.remaining <= 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip silently, the pattern note covers zero-match
  }
  for (const e of entries) {
    if (budget.remaining <= 0) return;
    const childRel = [...relSegs, e.name];
    if (e.isFile()) {
      if (globSegmentsMatch(patSegs, childRel)) {
        out.push(join(dir, e.name));
        budget.remaining--;
      }
    } else if (e.isDirectory() && couldMatchPrefix(patSegs, childRel)) {
      await walkCollect(join(dir, e.name), childRel, patSegs, out, budget);
    }
  }
}

/**
 * Segment-wise glob match. `**` spans zero or more segments; `*` and `?`
 * stay within one segment. Exported for tests.
 */
export function globSegmentsMatch(pat: string[], segs: string[]): boolean {
  if (pat.length === 0) return segs.length === 0;
  const head = pat[0];
  const rest = pat.slice(1);
  if (head === '**') {
    for (let i = 0; i <= segs.length; i++) {
      if (globSegmentsMatch(rest, segs.slice(i))) return true;
    }
    return false;
  }
  if (segs.length === 0) return false;
  if (!segmentMatch(head, segs[0])) return false;
  return globSegmentsMatch(rest, segs.slice(1));
}

function segmentMatch(pat: string, seg: string): boolean {
  let rx = '';
  for (const c of pat) {
    if (c === '*') rx += '.*';
    else if (c === '?') rx += '.';
    else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`).test(seg);
}

/** Prune the walk: can `segs` still grow into a match for `pat`? */
function couldMatchPrefix(pat: string[], segs: string[]): boolean {
  for (let i = 0; i < segs.length; i++) {
    if (i >= pat.length) return false;
    if (pat[i] === '**') return true;
    if (!segmentMatch(pat[i], segs[i])) return false;
  }
  return true;
}

/**
 * Read the last `maxBytes` of a file, drop the leading partial line when
 * truncated, and return at most the last `maxLines` non-empty lines.
 */
async function readFileTail(path: string, maxLines: number, maxBytes: number): Promise<string[]> {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    const readBytes = Math.min(st.size, maxBytes);
    if (readBytes === 0) return [];
    const buf = Buffer.alloc(readBytes);
    await fh.read(buf, 0, readBytes, st.size - readBytes);
    let text = buf.toString('utf8');
    if (readBytes < st.size) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    const lines = text.split('\n').filter((s) => s.length > 0);
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  } finally {
    await fh.close();
  }
}
