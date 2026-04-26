/**
 * GitHub OAuth Device Flow client.
 *
 * Used by `log10x_signin` when no GitHub token is available via
 * `gh auth token`. The flow:
 *
 *   1. POST `/login/device/code` with our public client_id → get back
 *      `user_code`, `device_code`, `verification_uri`, `interval`, `expires_in`.
 *   2. The MCP shows the user the verification URL (pre-filled with
 *      `user_code`) and launches their browser to it.
 *   3. Poll `/login/oauth/access_token` every `interval` seconds.
 *      GitHub responds with `authorization_pending` until the user
 *      authorizes, then with `access_token` once they do (or with
 *      `expired_token` / `access_denied` on terminal failures).
 *
 * The GitHub OAuth App must have **Enable Device Flow** ticked in its
 * settings, otherwise `/login/device/code` returns
 * `device_flow_disabled`.
 *
 * References:
 *   - https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** OAuth App / GitHub App client ID. Public by design — appears in users'
 *  browser URLs during authorize. Override via env for forks/staging. */
export const LOG10X_GITHUB_CLIENT_ID =
  process.env.LOG10X_GITHUB_CLIENT_ID || 'Ov23liszFwRlDLtIDSXI';

/** Scopes we request. `read:user` for `id` + `login` + `name`,
 *  `user:email` for the verified primary email when the user keeps
 *  theirs private on the public profile. Both are non-write. */
export const REQUESTED_SCOPES = 'read:user user:email';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Seconds the device_code is valid; usually 900 (15 min). */
  expires_in: number;
  /** Minimum poll interval in seconds; usually 5. */
  interval: number;
}

export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * Step 1: ask GitHub for a device + user code.
 */
export async function requestDeviceCode(
  clientId: string = LOG10X_GITHUB_CLIENT_ID,
  scope: string = REQUESTED_SCOPES
): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub device-code request failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as DeviceCodeResponse & { error?: string; error_description?: string };
  if ((json as { error?: string }).error) {
    throw new Error(
      `GitHub device-code error: ${json.error}${json.error_description ? ` — ${json.error_description}` : ''}`
    );
  }
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('GitHub device-code response is missing required fields');
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
  /** Optional callback to log/render progress on each poll. */
  onTick?: (elapsedSec: number) => void;
}

/**
 * Step 2/3: poll until GitHub gives us an access token, the user
 * declines, or the device_code expires. Honors GitHub's `slow_down`
 * back-pressure signal by adding 5s to the interval each time.
 */
export async function pollForAccessToken(opts: PollOptions): Promise<AccessTokenResponse> {
  const clientId = opts.clientId || LOG10X_GITHUB_CLIENT_ID;
  const startedAt = Date.now();
  let interval = Math.max(1, opts.interval);
  while (true) {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsed >= opts.expiresIn) {
      throw new Error('GitHub device code expired before authorization completed — run sign-in again');
    }
    if (opts.onTick) opts.onTick(elapsed);

    await sleep(interval * 1000);

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: opts.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });

    if (!res.ok) {
      // 4xx / 5xx without a JSON OAuth error → unexpected. Surface it.
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub token poll failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as Partial<AccessTokenResponse> & {
      error?: string;
      error_description?: string;
    };

    if (json.access_token) {
      return {
        access_token: json.access_token,
        token_type: json.token_type || 'bearer',
        scope: json.scope || '',
      };
    }

    switch (json.error) {
      case 'authorization_pending':
        // User hasn't authorized yet. Keep polling.
        continue;
      case 'slow_down':
        // GitHub asks us to back off — add 5s per their docs.
        interval += 5;
        continue;
      case 'expired_token':
        throw new Error('GitHub device code expired — run sign-in again');
      case 'access_denied':
        throw new Error('You denied authorization — re-run sign-in if that was a mistake');
      case 'unsupported_grant_type':
      case 'incorrect_client_credentials':
      case 'incorrect_device_code':
        throw new Error(
          `GitHub rejected the device-flow request (${json.error}). The OAuth App may not have Device Flow enabled — check at https://github.com/settings/developers and tick "Enable Device Flow".`
        );
      default:
        throw new Error(
          `Unexpected GitHub token response: ${json.error || 'no error and no token'}${
            json.error_description ? ` — ${json.error_description}` : ''
          }`
        );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pre-fill the user_code into the verification URL so the user just
 * has to click "Authorize" — no manual code typing.
 *
 * GitHub publishes both `verification_uri` (https://github.com/login/device)
 * and `verification_uri_complete` (with the code embedded) in some
 * responses; we don't rely on the latter, we build it ourselves so the
 * shape is deterministic.
 */
export function buildVerificationUrlWithCode(verificationUri: string, userCode: string): string {
  try {
    const u = new URL(verificationUri);
    u.searchParams.set('user_code', userCode);
    return u.toString();
  } catch {
    // Fallback if the URL parse fails for any reason.
    const sep = verificationUri.includes('?') ? '&' : '?';
    return `${verificationUri}${sep}user_code=${encodeURIComponent(userCode)}`;
  }
}
