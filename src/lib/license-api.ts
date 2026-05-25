/**
 * License JWT fetch helpers.
 *
 * The engine (Reporter, Receiver, Retriever) takes a license JWT as its
 * credential — the helm chart's `log10xLicenseJwt` value, mounted as a
 * file at `TENX_LICENSE_FILE` inside the pod. The JWT is ES256-signed
 * by the Log10x backend and verified locally by the engine against an
 * embedded public key (no online check required at engine startup).
 *
 * Two ways to mint one, both via the public gateway:
 *
 *   - `POST /api/v1/license/demo` — public, no auth. Mints a 14-day
 *     anonymous demo JWT bound to the demo tenant id. Used when the
 *     MCP user hasn't signed in and wants to try an install.
 *
 *   - `POST /api/v1/license` — Auth0 access token in `Authorization:
 *     Bearer`. Mints a JWT bound to the caller's default-environment
 *     tenant id. Idempotent — same license_id + same exp on repeat
 *     calls within the trial window.
 *
 * Distinct from `LOG10X_API_KEY`, which authenticates the MCP itself
 * against the gateway's MCP / Console routes (`X-10X-Auth` header,
 * `tenx_api_authorizer` lambda). The license JWT only flows into the
 * engine pods in install plans — the MCP doesn't use it for its own
 * HTTP calls.
 */

import { log } from './log.js';

const DEFAULT_BASE = 'https://prometheus.log10x.com';

function getBase(): string {
  return process.env.LOG10X_API_BASE || DEFAULT_BASE;
}

/** Common error class so callers can pattern-match on auth vs network. */
export class LicenseFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LicenseFetchError';
  }
}

export interface LicenseResult {
  /** The JWT itself, suitable for piping into helm `log10xLicenseJwt`. */
  jwt: string;
  /** Unix epoch seconds when the JWT expires. Parsed from the JWT payload. */
  expiresAtEpochSec?: number;
  /** License id from the JWT payload (when present). */
  licenseId?: string;
}

/**
 * Fetch a 14-day anonymous demo license JWT. No auth required. Safe to
 * call from any context — including from a not-logged-in MCP session
 * that's been asked to produce an install plan.
 */
export async function fetchDemoLicense(): Promise<LicenseResult> {
  const url = new URL('/api/v1/license/demo', getBase()).toString();
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST' });
  } catch (e) {
    throw new LicenseFetchError(
      `Network error reaching ${url}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new LicenseFetchError(
      `POST /api/v1/license/demo returned HTTP ${res.status}: ${body}`,
      res.status
    );
  }
  return parseLicenseResponse(await res.json());
}

/**
 * Fetch an authenticated user license JWT. The caller provides an Auth0
 * access token (obtained via the device flow in `signin_*`). The minted
 * JWT is bound to the user's default environment.
 *
 * Re-issuance is idempotent: same `license_id` and `exp` on repeat calls
 * within the trial window.
 */
export async function fetchUserLicense(auth0AccessToken: string): Promise<LicenseResult> {
  const url = new URL('/api/v1/license', getBase()).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth0AccessToken}` },
    });
  } catch (e) {
    throw new LicenseFetchError(
      `Network error reaching ${url}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new LicenseFetchError(
      `POST /api/v1/license returned HTTP ${res.status}: ${body}`,
      res.status
    );
  }
  return parseLicenseResponse(await res.json());
}

/**
 * Decode the JWT response. The gateway's license lambdas return shapes
 * that include the JWT plus metadata; we accept a few likely field
 * names defensively rather than tying ourselves to one schema.
 */
function parseLicenseResponse(raw: unknown): LicenseResult {
  if (!raw || typeof raw !== 'object') {
    throw new LicenseFetchError('License endpoint returned a non-object response body');
  }
  const obj = raw as Record<string, unknown>;
  const jwt =
    (typeof obj.license === 'string' && obj.license) ||
    (typeof obj.license_jwt === 'string' && obj.license_jwt) ||
    (typeof obj.jwt === 'string' && obj.jwt) ||
    '';
  if (!jwt) {
    throw new LicenseFetchError(
      'License endpoint response missing JWT field (expected `license`, `license_jwt`, or `jwt`)'
    );
  }
  const claims = tryDecodeJwtClaims(jwt);
  return {
    jwt,
    expiresAtEpochSec:
      typeof claims.exp === 'number' ? claims.exp : undefined,
    licenseId:
      typeof claims.license_id === 'string' ? claims.license_id :
      typeof claims.jti === 'string' ? claims.jti :
      undefined,
  };
}

/**
 * Lenient JWT claims decoder. Splits on `.`, base64-url decodes the
 * payload, and JSON.parses. Returns `{}` on any failure — the rest of
 * the code falls back gracefully when claims are absent.
 */
function tryDecodeJwtClaims(jwt: string): Record<string, unknown> {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return {};
    const payload = parts[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    log.debug('license.jwt_decode_failed', { msg: (e as Error).message });
    return {};
  }
}
