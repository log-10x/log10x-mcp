/**
 * Auth0 OAuth 2.0 Device Authorization Flow client (RFC 8628).
 *
 * Used by `log10x_signin`. The flow:
 *
 *   1. POST `{AUTH0_DOMAIN}/oauth/device/code` with our public client_id
 *      → get back `device_code`, `user_code`, `verification_uri`,
 *        `verification_uri_complete`, `interval`, `expires_in`.
 *   2. The MCP shows the user the verification URL (Auth0 already
 *      embeds the user_code in `verification_uri_complete`) and
 *      launches their browser to it.
 *   3. The user lands on Auth0's universal login page where they pick
 *      GitHub, Google, or any other social/db connection enabled on
 *      our `mcp_backend` Auth0 client. They complete the chosen IdP's
 *      OAuth, Auth0 mints a session, then prompts them to confirm the
 *      device authorization.
 *   4. Poll `{AUTH0_DOMAIN}/oauth/token` every `interval` seconds with
 *      `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Auth0
 *      responds with `authorization_pending` (HTTP 403) until the user
 *      confirms, then 200 + `access_token`/`id_token`/`refresh_token`.
 *
 * The Auth0 client must be of `app_type=native` and have the device_code
 * grant enabled. Client_id is public per RFC 8628 (appears in the
 * verification URL the user sees in their browser).
 *
 * References:
 *   - https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow
 *   - https://datatracker.ietf.org/doc/html/rfc8628
 */

/** Auth0 custom domain. Override via env for staging/forks. */
export const LOG10X_AUTH0_DOMAIN =
  process.env.LOG10X_AUTH0_DOMAIN || 'auth.log10x.com';

/** Auth0 native client id for the MCP. Public by design (appears in
 *  the user's verification URL during Device Flow). Override via env to
 *  point an MCP build at a different tenant (e.g. staging). */
export const LOG10X_AUTH0_CLIENT_ID =
  process.env.LOG10X_AUTH0_CLIENT_ID || 'GfMSX6pk0GVXlsZSMp0cEEGPtMTjLeQo';

/** Scopes for the device-code request.
 *  - `openid` is required for Auth0 to issue an ID token at all.
 *  - `profile` and `email` populate the standard OIDC claims so the
 *    backend's /userinfo lookup returns a real email + name.
 *  - `offline_access` requests a refresh_token so the user could
 *    re-issue access tokens later without going through Device Flow
 *    again. The MCP itself doesn't currently use it (we exchange the
 *    access_token for a long-lived api_key and then forget the Auth0
 *    session), but it's cheap to ask for and lets future flows refresh
 *    without a fresh login. */
export const REQUESTED_SCOPES = 'openid profile email offline_access';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Auth0 returns this with the user_code already embedded. Prefer
   *  it over manually building one. */
  verification_uri_complete: string;
  /** Seconds the device_code is valid; usually 900 (15 min). */
  expires_in: number;
  /** Minimum poll interval in seconds; usually 5. */
  interval: number;
}

export interface AccessTokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type: string;
}

/**
 * Step 1: ask Auth0 for a device + user code.
 */
export async function requestDeviceCode(
  clientId: string = LOG10X_AUTH0_CLIENT_ID,
  scope: string = REQUESTED_SCOPES,
  domain: string = LOG10X_AUTH0_DOMAIN
): Promise<DeviceCodeResponse> {
  const url = `https://${domain}/oauth/device/code`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Auth0 device-code request failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as DeviceCodeResponse & { error?: string; error_description?: string };
  if (json.error) {
    throw new Error(
      `Auth0 device-code error: ${json.error}${json.error_description ? `: ${json.error_description}` : ''}`
    );
  }
  if (!json.device_code || !json.user_code || !json.verification_uri_complete) {
    throw new Error('Auth0 device-code response is missing required fields');
  }
  return json;
}

export interface PollOptions {
  deviceCode: string;
  /** Seconds between polls (from `requestDeviceCode`). */
  interval: number;
  /** Total polling deadline in seconds. */
  expiresIn: number;
  clientId?: string;
  domain?: string;
  /** Optional callback to log/render progress on each poll. */
  onTick?: (elapsedSec: number) => void;
}

/**
 * Step 2/3: poll until Auth0 gives us an access token, the user
 * declines, or the device_code expires. Honors the `slow_down`
 * back-pressure signal by adding 5s to the interval each time.
 *
 * Auth0 returns these errors as HTTP 403 with a JSON body of
 * `{error: ..., error_description: ...}`. We don't surface the 403
 * itself as an error; we read the body and decide based on `error`.
 */
export async function pollForAccessToken(opts: PollOptions): Promise<AccessTokenResponse> {
  const clientId = opts.clientId || LOG10X_AUTH0_CLIENT_ID;
  const domain = opts.domain || LOG10X_AUTH0_DOMAIN;
  const url = `https://${domain}/oauth/token`;
  const startedAt = Date.now();
  let interval = Math.max(1, opts.interval);
  while (true) {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsed >= opts.expiresIn) {
      throw new Error('Auth0 device code expired before authorization completed. Run sign-in again.');
    }
    if (opts.onTick) opts.onTick(elapsed);

    await sleep(interval * 1000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: opts.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });

    let json: Partial<AccessTokenResponse> & { error?: string; error_description?: string };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      const body = await res.text().catch(() => '');
      throw new Error(`Auth0 token poll returned non-JSON: HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    if (res.ok && json.access_token) {
      return {
        access_token: json.access_token,
        id_token: json.id_token,
        refresh_token: json.refresh_token,
        scope: json.scope,
        expires_in: json.expires_in,
        token_type: json.token_type || 'Bearer',
      };
    }

    switch (json.error) {
      case 'authorization_pending':
        // User has not confirmed yet. Keep polling.
        continue;
      case 'slow_down':
        // Auth0 asks us to back off. Add 5s per RFC 8628.
        interval += 5;
        continue;
      case 'expired_token':
        throw new Error('Auth0 device code expired. Run sign-in again.');
      case 'access_denied':
        throw new Error('Authorization was denied. Re-run sign-in if that was a mistake.');
      case 'invalid_grant':
        throw new Error(
          'Auth0 rejected the device_code (invalid_grant). The code may already have been used or has expired. Run sign-in again.'
        );
      default:
        throw new Error(
          `Unexpected Auth0 token response: HTTP ${res.status}: ${json.error || 'no error and no token'}${
            json.error_description ? `: ${json.error_description}` : ''
          }`
        );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
