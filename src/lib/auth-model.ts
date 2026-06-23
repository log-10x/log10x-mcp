/**
 * # Authentication model — Log10x gateway ↔ MCP
 *
 * This file is the canonical reference for which credential goes where.
 * Read it before touching anything that sends a header to the gateway,
 * persists a credential to disk, or wires a credential into a helm
 * chart. The model has stayed stable since 2026-05 by design, and the
 * doc is here so accidental drift is easy to spot in review.
 *
 * The gateway has TWO concurrent auth surfaces. They serve different
 * purposes and the authorizers reject the wrong credential, so mixing
 * them up surfaces fast — but knowing which goes where saves a debug
 * round-trip.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## Surface A — User actions (api_key)
 * ─────────────────────────────────────────────────────────────────────
 *
 * | Field          | Value                                            |
 * |----------------|--------------------------------------------------|
 * | Header         | `X-10X-Auth: <apiKey>` or `<apiKey>/<envId>`     |
 * | Authorizer     | `tenx_api_authorizer` (looks the key up)         |
 * | Lifetime       | long-lived; rotated via `/user/rotate-key`       |
 * | Scope          | per-env (envId composed into the header value)   |
 * | Acquired via   | `POST /api/v1/auth/token` (exchanges Auth0 token)|
 *
 * Used for: every gateway call the MCP makes on the user's behalf —
 * queries (top_patterns, whats_changing, retriever_query, etc.), env
 * management (create / update / delete env), profile + settings,
 * billing, marketplace link.
 *
 * Persisted at: `~/.log10x/credentials` → `apiKey` field.
 * Also overridable via `LOG10X_API_KEY` env var (CI/CD escape hatch).
 *
 * Implementation: [api.ts](./api.ts) for the gateway calls,
 * [auth-api.ts](./auth-api.ts) for the Auth0-token exchange that mints
 * it, [credentials.ts](./credentials.ts) for the on-disk storage.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## Surface B — Engine actions (license JWT)
 * ─────────────────────────────────────────────────────────────────────
 *
 * | Field          | Value                                              |
 * |----------------|----------------------------------------------------|
 * | Header         | `Authorization: Bearer <licenseJwt>`               |
 * | Authorizer     | `tenx_license_authorizer` (verifies signature)     |
 * | Lifetime       | trial-anchored (idempotent re-issuance, same exp)  |
 * | Scope          | tenant_id baked into JWT payload                   |
 * | Acquired via   | `POST /api/v1/license/demo` (anonymous, 14-day) OR |
 * |                | `POST /api/v1/license` (Auth0 Bearer, user-scoped) |
 *
 * Used for: the **engine pods** the MCP instructs the user to deploy.
 * The license JWT is baked into helm values as `log10xLicenseJwt` and
 * mounted as a file in the engine container (`TENX_LICENSE_FILE`). The
 * engine consumes it for two things: writing metrics to the gateway
 * (`POST /api/v1/write` — license_authorizer-gated), and identifying
 * itself (`/agent/whoami`).
 *
 * **Demo-read exception (the one place the MCP itself sends a license
 * JWT):** a not-signed-in user who installs an engine with an anonymous
 * demo license has no api_key, so Surface A can't read their data back.
 * For that case the MCP queries the `/api/v1/demo/*` mirror of the read
 * endpoints with `Authorization: Bearer <demoLicenseJwt>` — the SAME demo
 * license the engine writes with, so reads and writes share the demo
 * tenant. These reads are bounded to the last 3h and rate limited, and
 * `query_ai` is not available. See `metrics-backend.ts` (`log10x_demo`
 * backend) and `environments.ts` (Path 4.5). A *user-scoped* license JWT
 * is still engine-only and never used by the MCP for reads.
 *
 * Persisted at: the Auth0-minted *user* license is never persisted (it
 * lives only in the emitted helm values + the engine pod's k8s Secret).
 * The anonymous *demo* license IS persisted at
 * `~/.log10x/demo-license.json` (`demo-license.ts`) so the engine-install
 * plan and the demo-read path reuse ONE demo identity. The user license
 * is fetched fresh on demand when emitting an install plan.
 *
 * Implementation: [license-api.ts](./license-api.ts) for the gateway
 * minting calls (used by `advise-install.ts`),
 * [demo-license.ts](./demo-license.ts) for demo-license persistence +
 * reuse, [metrics-backend.ts](./metrics-backend.ts) for the `log10x_demo`
 * read backend.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## Auth0 as the unified front door
 * ─────────────────────────────────────────────────────────────────────
 *
 * The user authenticates ONCE per machine via Auth0 device flow
 * (`log10x_signin_start` / `log10x_signin_complete`). The resulting
 * Auth0 access + refresh tokens are persisted at
 * `~/.log10x/credentials` (alongside the api_key) and feed TWO distinct
 * exchanges over the user's session:
 *
 *   1. **Auth0 → api_key** — done once at signin time. The api_key is
 *      stored long-lived; subsequent MCP calls don't need Auth0 again
 *      for user-action queries.
 *
 *   2. **Auth0 → license JWT** — done on demand by the install wizard
 *      when emitting a plan. Refreshes the Auth0 access token via the
 *      stored refresh_token if it's expired.
 *
 * **Why two exchanges?** Different problems. The api_key gives the MCP
 * a long-lived, env-scoped credential for chatty per-request calls
 * (queries / settings). The license JWT is a separate credential class
 * because engines run in customer infrastructure and must NOT have the
 * user's api_key (a user's api_key can manage their account; an engine
 * pod with stolen access shouldn't be able to delete envs).
 *
 * The license-via-Auth0 path was designed specifically so the MCP and
 * the web console can mint engine credentials with the user's signin
 * session ALONE — no api_key required, no separate "engine secret"
 * dance. Don't reach for the api_key when you mean to mint a license.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## Where each credential lives in this codebase
 * ─────────────────────────────────────────────────────────────────────
 *
 * | Credential          | Stored at                          | Sent to                   |
 * |---------------------|------------------------------------|---------------------------|
 * | Auth0 access token  | `~/.log10x/credentials`            | `/api/v1/license` (mint)  |
 * | Auth0 refresh token | `~/.log10x/credentials`            | Auth0 `/oauth/token`      |
 * | api_key             | `~/.log10x/credentials` (long-lived)| MCP↔gateway user calls    |
 * | license JWT (user)  | helm values + k8s Secret (transient)| engine pod runtime        |
 * | license JWT (demo)  | `~/.log10x/demo-license.json`      | engine pod + MCP `/api/v1/demo/*` reads |
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## Don't drift — quick checks
 * ─────────────────────────────────────────────────────────────────────
 *
 * Before sending a header, ask:
 *
 *   - Am I calling on behalf of the USER (querying their data, managing
 *     their account)? → Use api_key, `X-10X-Auth` header. See `api.ts`.
 *
 *   - Am I calling on behalf of an ENGINE (writing metrics from a pod,
 *     identifying as a runtime)? → Use license JWT, `Authorization:
 *     Bearer` header. These belong to the engine pods we instruct users
 *     to deploy. The ONE exception where the MCP sends a license JWT on
 *     its own request is the demo-read path (`/api/v1/demo/*` with an
 *     anonymous demo license, for not-signed-in users) — see Surface B.
 *
 *   - Am I MINTING credentials? → Use Auth0 token, `Authorization:
 *     Bearer` header. See `license-api.ts` (for license JWT) or
 *     `auth-api.ts` (for api_key).
 *
 * If you find an `X-10X-Auth` header carrying a JWT, or an
 * `Authorization: Bearer` header carrying an api_key — that's drift.
 * The authorizers will reject the wrong shape; the bug is at the
 * sender.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## If you want to consolidate later
 * ─────────────────────────────────────────────────────────────────────
 *
 * Notes for whoever revisits this:
 *
 * 1. The api_key could in principle be replaced with direct Auth0
 *    Bearer + a separate env-scope header. That would require:
 *    - `tenx_api_authorizer` accepts `Authorization: Bearer <auth0-jwt>`
 *      and validates via Auth0 `/userinfo` (same pattern as
 *      `tenx_license_authorizer` for engine routes)
 *    - env-scoping moves to `X-10X-Env` or a path segment
 *    - `POST /api/v1/auth/token` becomes optional (kept as the api_key
 *      mint endpoint for CI/CD / `LOG10X_API_KEY` env var, which still
 *      need a non-interactive credential)
 *    - MCP swaps `api.ts` to send Bearer + env header
 *
 * 2. The license JWT path is already as consolidated as it gets — it's
 *    the canonical engine credential and shouldn't be merged with the
 *    user surface (different threat model, different scope).
 *
 * 3. CI/CD / `LOG10X_API_KEY` env-var users are the floor on how far
 *    the api_key path can be deprecated — they have no Auth0 session
 *    to draw on, so the api_key path must always exist for them.
 */

// This module is documentation-only. The single export below exists so
// other files can import it as a syntactic anchor — finding all
// references via `grep "from './auth-model.js'"` surfaces every place
// in the code that intentionally points at this doc.
export const AUTH_MODEL_REF = 'src/lib/auth-model.ts';
