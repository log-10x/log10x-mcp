/**
 * Zero-click GitHub auth path: probe `gh auth token` and verify the
 * resulting token has the scopes we need.
 *
 * If the user already has the GitHub CLI installed and authenticated
 * (`gh auth login`), we can skip the entire device-flow round trip and
 * complete sign-in with no browser interaction at all. This matches
 * how `gh extension install` and other CLI ecosystems get free auth.
 *
 * On any failure (gh not installed, not logged in, scopes too narrow,
 * token rejected by GitHub) we return null and the caller falls back
 * to the device flow. Failure is always silent; we never surface a
 * "gh not found" error to the user — the device-flow path is the
 * documented happy path.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execP = promisify(exec);

/**
 * Returns a usable GitHub access token from `gh auth token`, or null
 * if the gh CLI isn't installed / not logged in / its token doesn't
 * cover the scopes we need.
 */
export async function tryGhCliToken(requiredScopes: string[]): Promise<string | null> {
  let token: string;
  try {
    const { stdout } = await execP('gh auth token', { timeout: 3000 });
    token = stdout.trim();
  } catch {
    return null;
  }
  if (!token) return null;

  // Verify scopes. GitHub returns the token's granted scopes in the
  // `X-OAuth-Scopes` response header on /user.
  let res: Response;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const grantedHeader = res.headers.get('x-oauth-scopes') || '';
  const granted = grantedHeader.split(',').map((s) => s.trim()).filter(Boolean);
  // gh's "default" scopes are a superset of what we need; this is
  // belt-and-suspenders for users who created a custom token with
  // narrower scopes.
  const hasAll = requiredScopes.every((s) => granted.includes(s));
  if (!hasAll) return null;
  return token;
}
