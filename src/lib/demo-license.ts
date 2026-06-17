/**
 * Persisted demo license for the QUERY surface.
 *
 * A not-signed-in user installs an engine with an anonymous 14-day demo
 * license (`POST /api/v1/license/demo`). That same license is the credential
 * that lets the MCP read the data the engine writes — via the `/api/v1/demo/*`
 * routes with `Authorization: Bearer`. To read back what the engine wrote, the
 * MCP must use the SAME license (same demo tenant), so we persist the minted
 * JWT here and reuse it for both the install plan and the query path.
 *
 * Stored separately from `~/.log10x/credentials` because that file requires an
 * `apiKey` (a signed-in artifact); a pure-demo user has none. This is the
 * pure-read leaf module: it does NOT import `license-api.ts`, so the mint +
 * reuse helper (`getOrMintDemoLicense`) lives there and depends on this, not
 * the other way around — no import cycle.
 *
 * File mode is 0600 / dir 0700, same as the credentials store.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface StoredDemoLicense {
  /** The demo license JWT (Bearer credential for /api/v1/demo/*). */
  jwt: string;
  /** Unix epoch seconds when the JWT expires (from its `exp` claim). */
  expiresAtEpochSec?: number;
  /** License id from the JWT payload (when present). */
  licenseId?: string;
  /** ISO-8601 when this license was minted/stored. */
  mintedAt?: string;
}

function demoLicensePath(): string {
  // Allow override for tests; default to ~/.log10x/demo-license.json.
  if (process.env.LOG10X_DEMO_LICENSE_PATH) {
    return process.env.LOG10X_DEMO_LICENSE_PATH;
  }
  return path.join(os.homedir(), '.log10x', 'demo-license.json');
}

/** Treat a license with under this much validity left as expired. */
const EXPIRY_SKEW_SEC = 5 * 60;

/**
 * `true` if the license is at/past expiry (within a small skew). A license
 * with no known expiry is treated as usable — the gateway is the final
 * arbiter and will 401 a truly-dead token.
 */
export function isDemoLicenseExpired(
  lic: { expiresAtEpochSec?: number },
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (lic.expiresAtEpochSec === undefined) return false;
  return lic.expiresAtEpochSec - EXPIRY_SKEW_SEC <= nowSec;
}

/**
 * Read the persisted demo license. Returns `null` when the file is missing
 * (the common case) or holds no usable JWT. Throws only on a genuinely
 * malformed/unreadable file so a broken machine fails loudly.
 */
export async function readDemoLicense(): Promise<StoredDemoLicense | null> {
  const file = demoLicensePath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const c = parsed as Partial<StoredDemoLicense>;
  if (!c || typeof c.jwt !== 'string' || c.jwt.length === 0) return null;
  return {
    jwt: c.jwt,
    expiresAtEpochSec: typeof c.expiresAtEpochSec === 'number' ? c.expiresAtEpochSec : undefined,
    licenseId: typeof c.licenseId === 'string' ? c.licenseId : undefined,
    mintedAt: typeof c.mintedAt === 'string' ? c.mintedAt : undefined,
  };
}

/** Persist a demo license with restrictive permissions. Returns the path written. */
export async function writeDemoLicense(lic: {
  jwt: string;
  expiresAtEpochSec?: number;
  licenseId?: string;
}): Promise<string> {
  const file = demoLicensePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const body: StoredDemoLicense = {
    jwt: lic.jwt,
    expiresAtEpochSec: lic.expiresAtEpochSec,
    licenseId: lic.licenseId,
    mintedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** Delete the persisted demo license. Returns `true` if a file was removed. */
export async function clearDemoLicense(): Promise<boolean> {
  const file = demoLicensePath();
  try {
    await fs.unlink(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Exposed for diagnostics / status messages. */
export function getDemoLicensePath(): string {
  return demoLicensePath();
}
