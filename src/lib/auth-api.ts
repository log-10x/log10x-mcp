/**
 * Calls to the Log10x BE auth endpoints. Kept separate from `api.ts`
 * because these are credential-exchange calls that don't take a
 * `LOG10X_API_KEY` (the goal IS to get one).
 */

const DEFAULT_BASE = 'https://prometheus.log10x.com';

function getBase(): string {
  return process.env.LOG10X_API_BASE || DEFAULT_BASE;
}

export interface GithubSigninResponse {
  /** Long-lived Log10x API key. Persist this. */
  api_key: string;
  /** User's email — used as their human-readable identity. */
  username: string;
  /** GitHub login (e.g. "talweiss"). */
  github_login: string;
  /** True for fresh signups, false when an existing account was matched. */
  is_new_account: boolean;
}

/**
 * POST /api/v1/auth/github with a verified GitHub access token. The BE
 * verifies the token against api.github.com, looks up or creates the
 * matching Log10x account, and returns an API key.
 */
export async function exchangeGithubTokenForApiKey(githubToken: string): Promise<GithubSigninResponse> {
  const url = new URL('/api/v1/auth/github', getBase()).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_token: githubToken }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Log10x BE rejected GitHub token: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as Partial<GithubSigninResponse>;
  if (!json.api_key) {
    throw new Error(`Log10x BE response missing api_key: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return {
    api_key: json.api_key,
    username: json.username || '',
    github_login: json.github_login || '',
    is_new_account: !!json.is_new_account,
  };
}
