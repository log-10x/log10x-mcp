import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetricsBackend,
  looksLikeLiteralSecret,
  resolveVarReference,
  MetricsBackendConfigError,
  type MetricsBackendConfig,
} from '../src/lib/metrics-backend.js';

const ORIGINAL_FETCH = global.fetch;

interface MockCall {
  url: string;
  init?: RequestInit;
}

function setupMockFetch(responses: Array<Response | Error>) {
  const calls: MockCall[] = [];
  let i = 0;
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    const r = responses[i];
    i += 1;
    if (r instanceof Error) throw r;
    if (!r) throw new Error('mock fetch: out of responses');
    return r;
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PROM_OK = { status: 'success', data: { resultType: 'vector', result: [] } };
const LABEL_LIST_OK = { status: 'success', data: ['a', 'b', 'c'] };

beforeEach(() => {
  // Clear any env vars that might affect ${VAR} resolution
  delete process.env.MB_TEST_TOKEN;
  delete process.env.MB_TEST_USER;
  delete process.env.MB_TEST_PASSWORD;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.MB_TEST_TOKEN;
  delete process.env.MB_TEST_USER;
  delete process.env.MB_TEST_PASSWORD;
});

// ── ${VAR} reference resolution ──────────────────────────────────────────

test('resolveVarReference: literal value passes through unchanged', () => {
  assert.equal(resolveVarReference('https://example.test'), 'https://example.test');
  assert.equal(resolveVarReference('plain-value'), 'plain-value');
});

test('resolveVarReference: resolves ${VAR} from process.env', () => {
  process.env.MB_TEST_TOKEN = 'abc123';
  assert.equal(resolveVarReference('${MB_TEST_TOKEN}'), 'abc123');
});

test('resolveVarReference: throws when ${VAR} is unset', () => {
  assert.throws(
    () => resolveVarReference('${MB_TEST_TOKEN}'),
    (err: Error) => err instanceof MetricsBackendConfigError && err.message.includes('MB_TEST_TOKEN') && err.message.includes('unset')
  );
});

test('resolveVarReference: only matches the exact ${VAR} pattern, not embedded', () => {
  // Embedded references (e.g., url with token in the middle) aren't supported
  // by design — too easy to accidentally leak. Only whole-field references.
  assert.equal(resolveVarReference('prefix-${MB_TEST_TOKEN}-suffix'), 'prefix-${MB_TEST_TOKEN}-suffix');
});

// ── Literal secret detector ──────────────────────────────────────────────

test('looksLikeLiteralSecret: long random alphanumeric string is flagged', () => {
  assert.equal(looksLikeLiteralSecret('FAKE_TEST_FIXTURE_aaa111bbb222ccc333dd'), true);
  assert.equal(looksLikeLiteralSecret('xai-FAKE_TEST_FIXTURE_AAA111BBB222CCC333DDD444EEE555FFF666GGG777HHH888III999JJJ'), true);
});

test('looksLikeLiteralSecret: short strings pass', () => {
  assert.equal(looksLikeLiteralSecret('short'), false);
  assert.equal(looksLikeLiteralSecret('us-east-1'), false);
  assert.equal(looksLikeLiteralSecret('my-project'), false);
});

test('looksLikeLiteralSecret: ${VAR} references pass', () => {
  assert.equal(looksLikeLiteralSecret('${ANYTHING_LONG_ENOUGH_TO_TRIGGER_LENGTH}'), false);
});

test('looksLikeLiteralSecret: URLs and paths pass', () => {
  assert.equal(looksLikeLiteralSecret('https://prom.acme.internal/api/v1/query'), false);
  assert.equal(looksLikeLiteralSecret('/home/user/.config/gcloud/application_default_credentials.json'), false);
});

test('looksLikeLiteralSecret: letters-only or digits-only long strings pass', () => {
  // No mix → looks like a sentence or a hash, not a credential
  assert.equal(looksLikeLiteralSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(looksLikeLiteralSecret('11111111111111111111111111111111'), false);
});

// ── Factory: secret-guard refuses literal credentials ────────────────────

test('createMetricsBackend: rejects literal-looking apiKey for log10x', () => {
  const config: MetricsBackendConfig = {
    kind: 'log10x',
    apiKey: 'FAKE_TEST_FIXTURE_aaa111bbb222ccc333dd-this-looks-like-a-real-key',
    envId: '6aa99191-f827-4579-a96a-c0ebdfe73884',
  };
  assert.throws(
    () => createMetricsBackend(config),
    (err: Error) => err instanceof MetricsBackendConfigError && err.message.includes('log10x.apiKey')
  );
});

test('createMetricsBackend: accepts ${VAR} reference for apiKey', () => {
  process.env.MB_TEST_TOKEN = 'FAKE_TEST_FIXTURE_aaa111bbb222ccc333dd-real-key';
  const backend = createMetricsBackend({
    kind: 'log10x',
    apiKey: '${MB_TEST_TOKEN}',
    envId: '6aa99191-f827-4579-a96a-c0ebdfe73884',
  });
  assert.equal(backend.kind, 'log10x');
});

test('createMetricsBackend: rejects literal-looking bearer token', () => {
  assert.throws(
    () => createMetricsBackend({
      kind: 'prometheus',
      url: 'http://prom.acme.internal',
      auth: { type: 'bearer', token: 'sk-proj-2XpVxxTNAIMhqx1GquX0v71geiNqlMWfhDS4A4v9' },
    }),
    (err: Error) => err instanceof MetricsBackendConfigError && err.message.includes('auth.token')
  );
});

// ── Factory: dispatches to the right adapter ─────────────────────────────

test('createMetricsBackend: dispatches log10x kind', () => {
  const b = createMetricsBackend({ kind: 'log10x', apiKey: 'short', envId: 'e' });
  assert.equal(b.kind, 'log10x');
  assert.equal(b.endpoint, 'https://prometheus.log10x.com');
});

test('createMetricsBackend: dispatches prometheus kind', () => {
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.acme.internal:9090',
    auth: { type: 'none' },
  });
  assert.equal(b.kind, 'prometheus');
  assert.equal(b.endpoint, 'http://prom.acme.internal:9090');
});

test('createMetricsBackend: dispatches mimir kind', () => {
  const b = createMetricsBackend({
    kind: 'mimir',
    url: 'https://mimir.acme.internal/prometheus',
    auth: { type: 'none' },
    orgId: 'tenant-x',
  });
  assert.equal(b.kind, 'mimir');
});

test('createMetricsBackend: dispatches datadog kind and derives URL from site', () => {
  const b = createMetricsBackend({
    kind: 'datadog',
    site: 'us5.datadoghq.com',
    apiKey: 'short',
    appKey: 'short',
  });
  assert.equal(b.kind, 'datadog');
  assert.equal(b.endpoint, 'https://api.us5.datadoghq.com');
});

test('createMetricsBackend: strips trailing slash from endpoint URL', () => {
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.acme.internal:9090///',
    auth: { type: 'none' },
  });
  assert.equal(b.endpoint, 'http://prom.acme.internal:9090');
});

// ── log10x adapter: HTTP calls ───────────────────────────────────────────

test('log10x adapter: queryInstant sends X-10X-Auth header and right URL', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({ kind: 'log10x', apiKey: 'k1', envId: 'e1' });
  await b.queryInstant('up');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://prometheus.log10x.com/api/v1/query?query=up'));
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['X-10X-Auth'], 'k1/e1');
});

test('log10x adapter: listLabelValues with window adds start/end', async () => {
  const { calls } = setupMockFetch([jsonResponse(LABEL_LIST_OK)]);
  const b = createMetricsBackend({ kind: 'log10x', apiKey: 'k1', envId: 'e1' });
  await b.listLabelValues('service', { windowSeconds: 3600 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/label/service/values');
  assert.ok(url.searchParams.get('start'));
  assert.ok(url.searchParams.get('end'));
});

// ── log10x_demo adapter (Bearer demo license → /api/v1/demo/*) ────────────

const DEMO_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJkZW1vLXh5eiJ9.sig';

test('createMetricsBackend: dispatches log10x_demo kind', () => {
  const b = createMetricsBackend({ kind: 'log10x_demo', licenseJwt: DEMO_JWT });
  assert.equal(b.kind, 'log10x_demo');
  assert.equal(b.endpoint, 'https://prometheus.log10x.com');
});

test('log10x_demo: does NOT trip the literal-secret guard on the JWT', () => {
  // A JWT is long + alphanumeric; the demo path must be exempt from the guard.
  assert.doesNotThrow(() =>
    createMetricsBackend({ kind: 'log10x_demo', licenseJwt: DEMO_JWT })
  );
});

test('log10x_demo: queryInstant hits /api/v1/demo/query with Bearer auth', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({ kind: 'log10x_demo', licenseJwt: DEMO_JWT });
  await b.queryInstant('up');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/demo/query');
  assert.equal(url.searchParams.get('query'), 'up');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['Authorization'], `Bearer ${DEMO_JWT}`);
  assert.equal(headers['X-10X-Auth'], undefined);
});

test('log10x_demo: queryRange uses the demo path and clamps start into the 3h window', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({ kind: 'log10x_demo', licenseJwt: DEMO_JWT });
  const now = Math.floor(Date.now() / 1000);
  // Ask for 24h of data; the backend must clamp start to ~now-3h.
  await b.queryRange('up', now - 24 * 3600, now, 60);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/demo/query_range');
  const start = Number(url.searchParams.get('start'));
  const minStart = now - 3 * 3600;
  assert.ok(start >= minStart - 5, `start ${start} should be clamped to ~${minStart}`);
});

test('log10x_demo: queryRange refuses a range entirely older than the window', async () => {
  setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({ kind: 'log10x_demo', licenseJwt: DEMO_JWT });
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => b.queryRange('up', now - 10 * 3600, now - 6 * 3600, 60),
    /demo window|last 3 hours/i
  );
});

test('log10x_demo: listLabelValues bounds the window to 3h max', async () => {
  const { calls } = setupMockFetch([jsonResponse(LABEL_LIST_OK)]);
  const b = createMetricsBackend({ kind: 'log10x_demo', licenseJwt: DEMO_JWT });
  await b.listLabelValues('service', { windowSeconds: 24 * 3600 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/demo/label/service/values');
  const start = Number(url.searchParams.get('start'));
  const end = Number(url.searchParams.get('end'));
  assert.ok(end - start <= 3 * 3600 + 5, `window ${end - start}s must be <= 3h`);
});

// ── prometheus adapter: auth modes ───────────────────────────────────────

test('prometheus adapter (none auth): no Authorization header', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'none' },
  });
  await b.queryInstant('up');
  const headers = (calls[0].init?.headers || {}) as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test('prometheus adapter (bearer): adds Authorization: Bearer <token>', async () => {
  process.env.MB_TEST_TOKEN = 'bearer-xyz';
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'bearer', token: '${MB_TEST_TOKEN}' },
  });
  await b.queryInstant('up');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer bearer-xyz');
});

test('prometheus adapter (basic): Base64-encodes user:password', async () => {
  process.env.MB_TEST_PASSWORD = 'p@ssw0rd';
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'basic', user: 'alice', password: '${MB_TEST_PASSWORD}' },
  });
  await b.queryInstant('up');
  const headers = calls[0].init?.headers as Record<string, string>;
  const expected = 'Basic ' + Buffer.from('alice:p@ssw0rd').toString('base64');
  assert.equal(headers.Authorization, expected);
});

test('prometheus adapter (header): sends custom-named header', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'header', name: 'X-API-Key', value: 'short-non-secret-value' },
  });
  await b.queryInstant('up');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['X-API-Key'], 'short-non-secret-value');
});

test('prometheus adapter: 5xx triggers retry, then succeeds', async () => {
  process.env.LOG10X_RETRY_BASE_MS = '1';
  const { calls } = setupMockFetch([
    new Response('upstream failure', { status: 503, statusText: 'Service Unavailable' }),
    new Response('upstream failure', { status: 503, statusText: 'Service Unavailable' }),
    jsonResponse(PROM_OK),
  ]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'none' },
  });
  const res = await b.queryInstant('up');
  assert.equal(res.status, 'success');
  assert.equal(calls.length, 3);
  delete process.env.LOG10X_RETRY_BASE_MS;
});

test('prometheus adapter: 4xx (non-429) does NOT retry', async () => {
  const { calls } = setupMockFetch([new Response('forbidden', { status: 403, statusText: 'Forbidden' })]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'none' },
  });
  await assert.rejects(() => b.queryInstant('up'), /403/);
  assert.equal(calls.length, 1, 'should fail immediately, not retry');
});

test('prometheus adapter: non-2xx response throws with status + body', async () => {
  const { calls } = setupMockFetch([new Response('forbidden', { status: 403, statusText: 'Forbidden' })]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'none' },
  });
  await assert.rejects(
    () => b.queryInstant('up'),
    (err: Error) => err.message.includes('403') && err.message.includes('forbidden')
  );
  assert.equal(calls.length, 1);
});

// ── mimir / cortex adapters: X-Scope-OrgID ──────────────────────────────

test('mimir adapter: sends X-Scope-OrgID when orgId is set', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'mimir',
    url: 'http://mimir.test:9009',
    auth: { type: 'none' },
    orgId: 'team-platform',
  });
  await b.queryInstant('up');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['X-Scope-OrgID'], 'team-platform');
});

test('mimir adapter: omits X-Scope-OrgID when orgId is unset', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'mimir',
    url: 'http://mimir.test:9009',
    auth: { type: 'none' },
  });
  await b.queryInstant('up');
  const headers = (calls[0].init?.headers || {}) as Record<string, string>;
  assert.equal(headers['X-Scope-OrgID'], undefined);
});

test('cortex adapter: always sends X-Scope-OrgID (required by type)', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'cortex',
    url: 'http://cortex.test:9009',
    auth: { type: 'none' },
    orgId: 'tenant-42',
  });
  await b.queryInstant('up');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['X-Scope-OrgID'], 'tenant-42');
});

// ── datadog adapter ─────────────────────────────────────────────────────

test('datadog adapter: site -> endpoint URL', () => {
  const b = createMetricsBackend({
    kind: 'datadog',
    site: 'us5.datadoghq.com',
    apiKey: 'short',
    appKey: 'short',
  });
  assert.equal(b.endpoint, 'https://api.us5.datadoghq.com');
});

test('datadog adapter: tolerates leading https:// in site', () => {
  const b = createMetricsBackend({
    kind: 'datadog',
    site: 'https://us5.datadoghq.com/',
    apiKey: 'short',
    appKey: 'short',
  });
  assert.equal(b.endpoint, 'https://api.us5.datadoghq.com');
});

test('datadog adapter: sends DD-API-KEY + DD-APPLICATION-KEY headers', async () => {
  process.env.MB_TEST_TOKEN = 'dd-api-resolved';
  process.env.MB_TEST_USER = 'dd-app-resolved';
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'datadog',
    site: 'us5.datadoghq.com',
    apiKey: '${MB_TEST_TOKEN}',
    appKey: '${MB_TEST_USER}',
  });
  await b.queryInstant('topk(5, up)');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['DD-API-KEY'], 'dd-api-resolved');
  assert.equal(headers['DD-APPLICATION-KEY'], 'dd-app-resolved');
  assert.ok(calls[0].url.startsWith('https://api.us5.datadoghq.com/api/v1/query'));
});

// ── stub adapters throw with helpful messages ────────────────────────────

test('amp adapter: throws AWS-credentials error when no creds in env', async () => {
  // AmpBackend is implemented (SigV4 against the `aps` service); with no
  // AWS creds in the environment it surfaces a clear credentials error
  // before any network call. awsCredentials() reads only AWS_ACCESS_KEY_ID
  // + AWS_SECRET_ACCESS_KEY, so clearing them makes this deterministic.
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  const b = createMetricsBackend({
    kind: 'amp',
    url: 'https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-x/',
    region: 'us-east-1',
  });
  await assert.rejects(() => b.queryInstant('up'), /AWS credentials/);
});

test('gcp_managed_prom adapter: requires accessToken or serviceAccountKeyFile', () => {
  // GcpManagedPromBackend is implemented (OAuth2 JWT-bearer token minting).
  // Its constructor refuses a config that provides neither a pre-minted
  // accessToken nor a serviceAccountKeyFile, so the throw now happens at
  // createMetricsBackend() time rather than on queryInstant().
  assert.throws(
    () =>
      createMetricsBackend({
        kind: 'gcp_managed_prom',
        url: 'https://monitoring.googleapis.com/v1/projects/log10x-poc/location/global/prometheus',
        projectId: 'log10x-poc',
      }),
    (err: Error) =>
      err instanceof MetricsBackendConfigError &&
      err.message.includes('accessToken') &&
      err.message.includes('serviceAccountKeyFile')
  );
});

test('grafana_cloud_prom adapter: Basic auths with instance id as user + api key as password', async () => {
  // GrafanaCloudBackend is now a thin Prometheus subclass: HTTP Basic with
  // the grafana.com instance id as the user and the API key as the password.
  // It performs a real prom query; mock fetch so the test is hermetic.
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'grafana_cloud_prom',
    url: 'https://prometheus-prod-13.grafana.net/api/prom',
    user: '1234',
    apiKey: 'short',
  });
  const res = await b.queryInstant('up');
  assert.equal(res.status, 'success');
  const headers = calls[0].init?.headers as Record<string, string>;
  const expected = 'Basic ' + Buffer.from('1234:short').toString('base64');
  assert.equal(headers.Authorization, expected);
  assert.ok(calls[0].url.startsWith('https://prometheus-prod-13.grafana.net/api/prom/api/v1/query?query=up'));
});

// ── queryRange wiring ───────────────────────────────────────────────────

test('prometheus adapter: queryRange includes start/end/step params', async () => {
  const { calls } = setupMockFetch([jsonResponse(PROM_OK)]);
  const b = createMetricsBackend({
    kind: 'prometheus',
    url: 'http://prom.test:9090',
    auth: { type: 'none' },
  });
  await b.queryRange('rate(up[5m])', 1000, 2000, 60);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/query_range');
  assert.equal(url.searchParams.get('query'), 'rate(up[5m])');
  assert.equal(url.searchParams.get('start'), '1000');
  assert.equal(url.searchParams.get('end'), '2000');
  assert.equal(url.searchParams.get('step'), '60');
});
