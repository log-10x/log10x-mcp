/**
 * Persistent credentials at `~/.log10x/credentials`.
 *
 * Written by `log10x_signin_complete` after the BE returns an API key
 * (or after the pasted-key path validates one), read by
 * `loadEnvironments` when no `LOG10X_API_KEY` env var is set, wiped by
 * `log10x_signout`.
 *
 * Living outside the MCP host's config means a single sign-in works
 * across every MCP host on the same machine (Claude Desktop, Cursor,
 * Continue, future CLIs). The user signs in once per machine — not once
 * per host. It also avoids editing the host's config file, which would
 * require restarting the host to take effect.
 *
 * File mode is 0600 so other users on the same machine can't read it.
 * Directory mode is 0700 for the same reason.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Credentials {
  /** Long-lived Log10x API key minted by the BE. */
  apiKey: string;
  /** ISO-8601 timestamp when these credentials were written. */
  signedInAt?: string;
  /**
   * Auth0 access token retained from the device-flow signin. Needed by
   * the install wizard to mint a user-scoped license JWT via
   * `POST /api/v1/license` (which only accepts Bearer Auth0 tokens, not
   * the Log10x API key). Absent on the pasted-API-key signin path —
   * the wizard falls back to the anonymous demo license in that case.
   */
  auth0AccessToken?: string;
  /**
   * Auth0 refresh token. The device flow asks for the `offline_access`
   * scope so we get one. Used to refresh the access token when it
   * expires (typically 24h) without forcing the user to re-sign in.
   */
  auth0RefreshToken?: string;
  /** ISO-8601 expiry of `auth0AccessToken`. */
  auth0AccessTokenExpiresAt?: string;
}

function credentialsPath(): string {
  // Allow override for tests; default to ~/.log10x/credentials.
  if (process.env.LOG10X_CREDENTIALS_PATH) {
    return process.env.LOG10X_CREDENTIALS_PATH;
  }
  return path.join(os.homedir(), '.log10x', 'credentials');
}

/**
 * Read the saved credentials. Returns `null` when the file is missing
 * (the common case on a fresh machine) — callers should treat that as
 * "not signed in" rather than an error.
 *
 * Throws on other I/O errors (permission denied, malformed JSON) so a
 * misconfigured machine fails loudly instead of silently downgrading
 * to demo.
 */
export async function readCredentials(): Promise<Credentials | null> {
  const file = credentialsPath();
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
  const c = parsed as Partial<Credentials>;
  if (!c || typeof c.apiKey !== 'string' || c.apiKey.length === 0) {
    throw new Error(`${file} is missing a non-empty "apiKey" field`);
  }
  return {
    apiKey: c.apiKey,
    signedInAt: typeof c.signedInAt === 'string' ? c.signedInAt : undefined,
    auth0AccessToken:
      typeof c.auth0AccessToken === 'string' ? c.auth0AccessToken : undefined,
    auth0RefreshToken:
      typeof c.auth0RefreshToken === 'string' ? c.auth0RefreshToken : undefined,
    auth0AccessTokenExpiresAt:
      typeof c.auth0AccessTokenExpiresAt === 'string'
        ? c.auth0AccessTokenExpiresAt
        : undefined,
  };
}

/**
 * Write credentials to disk with restrictive permissions. Creates the
 * parent directory if missing.
 */
export async function writeCredentials(c: Credentials): Promise<string> {
  const file = credentialsPath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(
    { ...c, signedInAt: c.signedInAt || new Date().toISOString() },
    null,
    2
  );
  await fs.writeFile(file, body + '\n', { mode: 0o600 });
  return file;
}

/**
 * Delete the credentials file. Idempotent: returns `false` if the file
 * was already absent, `true` if it was actually removed.
 */
export async function clearCredentials(): Promise<boolean> {
  const file = credentialsPath();
  try {
    await fs.unlink(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Exposed for diagnostics / status messages. */
export function getCredentialsPath(): string {
  return credentialsPath();
}
