/**
 * Volume-lens honesty contract for log10x_pattern_detail.
 *
 * pattern_detail loads its env from loadEnvironments() internally, so it
 * cannot take an injected backend. We stand up a local mock-Prometheus HTTP
 * server and point LOG10X_METRICS_* at it (with HOME redirected to a temp dir
 * so no on-disk envs.json collides).
 *
 * pattern_detail-specific: the factor is computed from an ENV-WIDE total query
 * (sum(...{tenx_env="X"}[30d])), NOT the pattern's own per-service total.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GB, L, asRecord } from './volume-lens-tool-harness.js';

const GB_N = GB;

// Per-service breakdown: payment 30 GB, cart 18 GB (pattern total 48 GB).
// ENV total over 30d = 480 GB (pattern << env). Factor basis = env total.
const SERVICE_BREAKDOWN = [
  { metric: { [L.service]: 'payment', [L.severity]: 'ERROR' }, value: [0, String(30 * GB_N)] },
  { metric: { [L.service]: 'cart', [L.severity]: 'INFO' }, value: [0, String(18 * GB_N)] },
];
const ENV_30D_BYTES = 480 * GB_N;

function vector(result: unknown[]) {
  return { status: 'success', data: { resultType: 'vector', result } };
}
function emptyV() { return vector([]); }

function route(query: string) {
  if (query.startsWith('count(')) return emptyV(); // edge probe → cloud
  // ENV-wide total: sum(increase(...{tenx_env="cloud"}[30d])) with no `by`.
  if (query.startsWith('sum(increase') && !query.includes(' by ')) {
    return vector([{ metric: {}, value: [0, String(ENV_30D_BYTES)] }]);
  }
  // per-service breakdown: sum by (service, severity) (... [30d])
  if (query.includes(`by (${L.service}, ${L.severity})`)) {
    return vector(SERVICE_BREAKDOWN);
  }
  return emptyV(); // first-seen, name resolve, etc.
}

let server: Server;
let baseUrl: string;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const query = u.searchParams.get('query') ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(route(query)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  for (const k of ['HOME', 'LOG10X_METRICS_BACKEND_KIND', 'LOG10X_METRICS_URL', 'LOG10X_METRICS_AUTH_TYPE', 'LOG10X_API_KEY', 'LOG10X_ENV_ID', 'LOG10X_METRICS_NICKNAME']) {
    savedEnv[k] = process.env[k];
  }
  process.env.HOME = mkdtempSync(join(tmpdir(), 'vlens-home-'));
  delete process.env.LOG10X_API_KEY;
  delete process.env.LOG10X_ENV_ID;
  process.env.LOG10X_METRICS_BACKEND_KIND = 'prometheus';
  process.env.LOG10X_METRICS_URL = baseUrl;
  process.env.LOG10X_METRICS_AUTH_TYPE = 'none';
  process.env.LOG10X_METRICS_NICKNAME = 'test';
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Env = { data: Record<string, unknown>; summary: Record<string, unknown>; warnings?: string[] };

async function run(args: Record<string, unknown>) {
  // dynamic import so env vars are set before the module reads them
  const { executePatternDetail } = await import('../src/tools/pattern-detail.js');
  const out = await executePatternDetail({ pattern_hash: 'h_pay', include_samples: false, ...args });
  return out as unknown as Env;
}
const p = (o: Env) => asRecord(o.data.payload);
const sd = (o: Env) => asRecord(o.data.source_disclosure);
const hl = (o: Env) => String(asRecord(o.summary).headline ?? '');

// env basis: 480 GB / 30d window → 480 GB/mo.
const MONTHLY_GB = 480;

test('pattern_detail: factor-1 (no arg) = no stamp, no prefix', async () => {
  const out = await run({});
  assert.equal((p(out).volume_lens as Record<string, unknown>).lensed, false);
  assert.equal(sd(out).volume_scale_factor, undefined);
  assert.ok(!hl(out).startsWith('[Projected to '));
});

test('pattern_detail: factor from ENV total not pattern total; magnitudes scale, shares invariant', async () => {
  const base = p(await run({}));
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 3 }));
  const lens = lp.volume_lens as Record<string, unknown>;
  // pattern total is 48 GB; if factor used that, requesting 3×480 GB would be
  // ~30. It must be ~3 (basis is the 480 GB env total).
  assert.ok(Math.abs((lens.factor as number) - 3) < 1e-6, `factor ${lens.factor} should be ~3`);
  assert.ok(Math.abs((lp.total_bytes as number) - (base.total_bytes as number) * 3) < 1);
  const bsvc = base.services as Array<Record<string, unknown>>;
  const lsvc = lp.services as Array<Record<string, unknown>>;
  for (let i = 0; i < bsvc.length; i++) {
    assert.ok(Math.abs((lsvc[i].bytes as number) - (bsvc[i].bytes as number) * 3) < 1, `bytes[${i}]`);
    assert.equal(lsvc[i].share_pct, bsvc[i].share_pct, `share_pct[${i}]`);
  }
  // trend series scales (empty here → trivially equal length 0)
  assert.equal((lp.trend_time_series as unknown[]).length, (base.trend_time_series as unknown[]).length);
});

test('pattern_detail: stamp + prefix + warning iff lensed', async () => {
  const out = await run({ monthly_volume_gb: MONTHLY_GB * 5 });
  const disc = sd(out);
  assert.equal(disc.volume_actual_gb, MONTHLY_GB);
  assert.equal(disc.volume_projected_gb, MONTHLY_GB * 5);
  assert.equal(disc.volume_scale_factor, 5);
  assert.ok(hl(out).startsWith('[Projected to '));
  assert.equal((out.warnings ?? [])[0], disc.volume_projection_note);
});
