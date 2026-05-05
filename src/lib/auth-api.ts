/**
 * Calls to the Log10x BE auth endpoints. Kept separate from `api.ts`
 * because these are credential-exchange calls that don't take a
 * `LOG10X_API_KEY` (the goal IS to get one).
 */

const DEFAULT_BASE = 'https://prometheus.log10x.com';

function getBase(): string {
  return process.env.LOG10X_API_BASE || DEFAULT_BASE;
}

export interface SigninResponse {
  /** Long-lived Log10x API key. Persist this. */
  api_key: string;
  /** User's email. The backend reads it from the Auth0 user record's
   *  email attribute. May be empty if Auth0 didn't capture one
   *  (e.g. a misconfigured social connection); the MCP should treat
   *  empty as "no email" and continue. */
  username: string;
}

/**
 * POST /api/v1/auth/token with an Auth0 access_token (issued via the
 * Device Authorization Flow against `auth.log10x.com`). The BE calls
 * Auth0's `/userinfo` to resolve the `sub`, then looks up the user
 * record via the Management API and returns the long-lived api_key
 * stored in `app_metadata.api_key`.
 *
 * The Auth0 access_token is single-use from the MCP's perspective:
 * we don't keep it after this exchange. The api_key is what
 * authenticates every subsequent log10x call.
 */
export async function exchangeAuth0TokenForApiKey(auth0AccessToken: string): Promise<SigninResponse> {
  const url = new URL('/api/v1/auth/token', getBase()).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: auth0AccessToken }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Log10x BE rejected the Auth0 access token: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as Partial<SigninResponse>;
  if (!json.api_key) {
    throw new Error(`Log10x BE response missing api_key: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return {
    api_key: json.api_key,
    username: json.username || '',
  };
}
