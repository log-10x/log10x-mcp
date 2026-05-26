/**
 * License JWT fetch helpers — mints credentials for the **ENGINE-ACTION
 * surface** of the gateway (see `./auth-model.ts` for the full model).
 *
 * The engine (Reporter, Receiver, Retriever) takes a license JWT as
 * its credential — the helm chart's `log10xLicenseJwt` value, mounted
 * as a file at `TENX_LICENSE_FILE` inside the pod. The JWT is ES256-
 * signed by the Log10x backend and verified locally by the engine
 * against an embedded public key (no online check required at engine
 * startup).
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
 * **Important separation** — distinct from the api_key
 * (`LOG10X_API_KEY` / `X-10X-Auth`), which authenticates the MCP
 * against the user-action surface (`./api.ts`, `tenx_api_authorizer`).
 * The license JWT is engine-only: it flows into the helm values the
 * MCP emits, and from there into the engine pod's Kubernetes Secret.
 * The MCP itself never sends a license JWT on its own requests — those
 * routes (`/write`, `/agent/whoami`) belong to the engine. Conversely,
 * never send an api_key to `tenx_license_authorizer`-gated routes;
 * the authorizer will reject it.
 *
 * The Auth0-token → license JWT path exists specifically so MCP and
 * web-console tools can mint engine credentials directly from the
 * user's signin session, without needing the api_key as an intermediate.
 */

import { log } from './log.js';
import './auth-model.js';
import { readCredentials, writeCredentials, type Credentials } from './credentials.js';
import { refreshAuth0AccessToken } from './auth0-device-flow.js';

const DEFAULT_BASE = 'https://prometheus.log10x.com';

/** How early before `auth0AccessTokenExpiresAt` we proactively refresh, in ms. */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

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
 * Higher-level license acquisition for the install wizard. Routes between
 * the user-scoped and demo paths based on what credentials are on hand:
 *
 *   1. Signed in with a non-expired Auth0 access token → fetch user JWT
 *   2. Signed in with an expired access token + refresh token → refresh,
 *      persist the new tokens, then fetch user JWT
 *   3. Signed in via pasted API key (no Auth0 tokens) → fall back to demo
 *      JWT (we can't mint a user license without Auth0 credentials)
 *   4. Not signed in → fetch demo JWT
 *
 * Always returns *something* on success. Callers get `{ jwt, isDemoLicense, ... }`
 * and can render appropriate UI based on which path was taken.
 */
export interface AcquireLicenseResult extends LicenseResult {
  /** True when the demo endpoint was used (anonymous, 14-day). */
  isDemoLicense: boolean;
  /** Why this path was taken — surfaced in wizard output for transparency. */
  reason: 'signed-in-user' | 'refreshed-then-user' | 'pasted-key-fallback' | 'not-signed-in';
}

export async function acquireLicenseForWizard(): Promise<AcquireLicenseResult> {
  const creds = await readCredentials().catch(() => null);

  // Path 4: not signed in.
  if (!creds || !creds.apiKey) {
    const lic = await fetchDemoLicense();
    return { ...lic, isDemoLicense: true, reason: 'not-signed-in' };
  }

  // Path 3: pasted-key signin — no Auth0 tokens to use against /license.
  // Demo fallback is the honest answer; the wizard surfaces "sign in via
  // device flow to get a user-scoped license."
  if (!creds.auth0AccessToken && !creds.auth0RefreshToken) {
    const lic = await fetchDemoLicense();
    return { ...lic, isDemoLicense: true, reason: 'pasted-key-fallback' };
  }

  // Path 1 / 2: signed in with Auth0 — try the access token, refreshing
  // if it's expired (or close to expiring).
  let accessToken = creds.auth0AccessToken;
  let reason: AcquireLicenseResult['reason'] = 'signed-in-user';

  const now = Date.now();
  const expiresAt = creds.auth0AccessTokenExpiresAt
    ? Date.parse(creds.auth0AccessTokenExpiresAt)
    : Number.POSITIVE_INFINITY;
  const needsRefresh =
    !accessToken ||
    (Number.isFinite(expiresAt) && now + ACCESS_TOKEN_REFRESH_SKEW_MS >= expiresAt);

  if (needsRefresh) {
    if (!creds.auth0RefreshToken) {
      // Access token expired and no refresh token to recover with. Fall
      // back to demo and tell the user to sign in again.
      log.warn('license.access_token_expired_no_refresh');
      const lic = await fetchDemoLicense();
      return { ...lic, isDemoLicense: true, reason: 'pasted-key-fallback' };
    }
    try {
      const refreshed = await refreshAuth0AccessToken(creds.auth0RefreshToken);
      accessToken = refreshed.access_token;
      reason = 'refreshed-then-user';
      // Persist the rotated tokens so subsequent calls don't re-refresh.
      const newExpiresAt = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : undefined;
      const updated: Credentials = {
        ...creds,
        auth0AccessToken: refreshed.access_token,
        // Auth0 may rotate the refresh token; keep whichever is current.
        auth0RefreshToken: refreshed.refresh_token ?? creds.auth0RefreshToken,
        auth0AccessTokenExpiresAt: newExpiresAt,
      };
      await writeCredentials(updated).catch((e) => {
        log.warn('license.credentials_write_failed', { msg: (e as Error).message });
      });
    } catch (e) {
      log.warn('license.refresh_failed', { msg: (e as Error).message });
      // Refresh blew up. Demo fallback is the safe path.
      const lic = await fetchDemoLicense();
      return { ...lic, isDemoLicense: true, reason: 'pasted-key-fallback' };
    }
  }

  if (!accessToken) {
    // Defensive — should be unreachable now.
    const lic = await fetchDemoLicense();
    return { ...lic, isDemoLicense: true, reason: 'pasted-key-fallback' };
  }

  try {
    const lic = await fetchUserLicense(accessToken);
    return { ...lic, isDemoLicense: false, reason };
  } catch (e) {
    log.warn('license.user_fetch_failed_falling_back_to_demo', {
      msg: (e as Error).message,
    });
    const demo = await fetchDemoLicense();
    return { ...demo, isDemoLicense: true, reason: 'pasted-key-fallback' };
  }
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
