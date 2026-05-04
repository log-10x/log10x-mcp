import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadManifest,
  getManifest,
  applyManifestToTools,
  activeNotices,
  getPackageDefaultManifest,
  getPackageDefaultTool,
  _resetForTests,
  type Manifest,
} from '../src/lib/manifest.js';

// Use a per-test cache file under the OS temp dir so we don't touch the
// real ~/.log10x/. LOG10X_MANIFEST_CACHE_PATH is the documented test override.
const TMP_CACHE = path.join(os.tmpdir(), 'log10x-mcp-test-manifest-cache.json');

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  _resetForTests();
  process.env.LOG10X_MANIFEST_CACHE_PATH = TMP_CACHE;
  delete process.env.LOG10X_MANIFEST_URL;
  delete process.env.LOG10X_MANIFEST_DISABLED;
  await fs.rm(TMP_CACHE, { force: true });
  globalThis.fetch = originalFetch;
});

function stubFetchOnce(body: unknown, ok = true, status = 200): void {
  globalThis.fetch = (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function stubFetchReject(err: Error): void {
  globalThis.fetch = (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

test('loadManifest: happy path — fetches, validates, caches', async () => {
  const remote: Manifest = {
    manifestVersion: 1,
    tools: { log10x_cost_drivers: { description: 'override desc' } },
  };
  stubFetchOnce(remote);
  const m = await loadManifest('1.5.0');
  assert.ok(m);
  assert.equal(m!.tools!.log10x_cost_drivers!.description, 'override desc');
  // Cache file should exist with the same payload
  const onDisk = JSON.parse(await fs.readFile(TMP_CACHE, 'utf-8'));
  assert.deepEqual(onDisk, remote);
});

test('loadManifest: idempotent — second call returns cached singleton without re-fetching', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ manifestVersion: 1 }) };
  }) as unknown as typeof fetch;
  await loadManifest('1.5.0');
  await loadManifest('1.5.0');
  assert.equal(calls, 1);
  assert.ok(getManifest());
});

test('loadManifest: LOG10X_MANIFEST_DISABLED=1 → no fetch, returns null', async () => {
  process.env.LOG10X_MANIFEST_DISABLED = '1';
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ manifestVersion: 1 }) };
  }) as unknown as typeof fetch;
  const m = await loadManifest('1.5.0');
  assert.equal(m, null);
  assert.equal(called, false);
});

test('loadManifest: rejects manifest_version > MAX_KNOWN, falls through', async () => {
  stubFetchOnce({ manifestVersion: 999, tools: {} });
  const m = await loadManifest('1.5.0');
  assert.equal(m, null);
});

test('loadManifest: rejects when min_client_version > our version', async () => {
  stubFetchOnce({ manifestVersion: 1, minClientVersion: '99.0.0' });
  const m = await loadManifest('1.5.0');
  assert.equal(m, null);
});

test('loadManifest: accepts when our client version meets minClientVersion', async () => {
  stubFetchOnce({ manifestVersion: 1, minClientVersion: '1.0.0' });
  const m = await loadManifest('1.5.0');
  assert.ok(m);
});

test('loadManifest: malformed schema is rejected (no crash)', async () => {
  stubFetchOnce({ tools: 'not-an-object' });
  const m = await loadManifest('1.5.0');
  assert.equal(m, null);
});

test('loadManifest: HTTP error falls back to cache', async () => {
  // Seed cache with a valid manifest first
  await fs.mkdir(path.dirname(TMP_CACHE), { recursive: true });
  await fs.writeFile(
    TMP_CACHE,
    JSON.stringify({ manifestVersion: 1, tools: { foo: { description: 'cached' } } })
  );
  stubFetchOnce(null, false, 500);
  const m = await loadManifest('1.5.0');
  assert.ok(m);
  assert.equal(m!.tools!.foo!.description, 'cached');
});

test('loadManifest: network error + no cache → null (graceful)', async () => {
  stubFetchReject(new Error('ENOTFOUND'));
  const m = await loadManifest('1.5.0');
  assert.equal(m, null);
});

test('loadManifest: invalid cached JSON is treated as no-cache', async () => {
  await fs.mkdir(path.dirname(TMP_CACHE), { recursive: true });
  await fs.writeFile(TMP_CACHE, 'not json {{{');
  stubFetchReject(new Error('offline'));
  const m = await loadManifest('1.5.0');
  assert.equal(m, null);
});

// ── applyManifestToTools ──────────────────────────────────────────────

interface FakeTool {
  description?: string;
  title?: string;
  annotations?: Record<string, unknown>;
  enabled: boolean;
  disabled: number;
  updated: Array<Record<string, unknown>>;
  disable(): void;
  enable(): void;
  update(u: Record<string, unknown>): void;
}

function fakeTool(initial: Partial<FakeTool> = {}): FakeTool {
  const t: FakeTool = {
    description: initial.description,
    title: initial.title,
    annotations: initial.annotations,
    enabled: true,
    disabled: 0,
    updated: [],
    disable() {
      this.enabled = false;
      this.disabled++;
    },
    enable() {
      this.enabled = true;
    },
    update(u) {
      this.updated.push(u);
      if (typeof u.title === 'string') this.title = u.title;
      if (typeof u.description === 'string') this.description = u.description;
      if (u.annotations) this.annotations = u.annotations as Record<string, unknown>;
    },
  };
  return t;
}

test('applyManifestToTools: enabled=false → disables the tool', () => {
  const tool = fakeTool();
  const reg = new Map<string, any>([['t1', tool]]);
  applyManifestToTools(
    { manifestVersion: 1, tools: { t1: { enabled: false } } },
    reg as never
  );
  assert.equal(tool.enabled, false);
  assert.equal(tool.disabled, 1);
});

test('applyManifestToTools: description override is applied via update()', () => {
  const tool = fakeTool({ description: 'orig' });
  const reg = new Map<string, any>([['t1', tool]]);
  applyManifestToTools(
    { manifestVersion: 1, tools: { t1: { description: 'overridden' } } },
    reg as never
  );
  assert.equal(tool.description, 'overridden');
});

test('applyManifestToTools: deprecated=true prefixes [DEPRECATED]', () => {
  const tool = fakeTool({ description: 'tool body' });
  const reg = new Map<string, any>([['t1', tool]]);
  applyManifestToTools(
    {
      manifestVersion: 1,
      tools: { t1: { deprecated: true, deprecationMessage: 'use t2 instead' } },
    },
    reg as never
  );
  assert.match(tool.description ?? '', /^\[DEPRECATED: use t2 instead\]/);
  assert.match(tool.description ?? '', /tool body/);
});

test('applyManifestToTools: unknown tool name is logged + skipped, no throw', () => {
  const tool = fakeTool();
  const reg = new Map<string, any>([['known', tool]]);
  applyManifestToTools(
    { manifestVersion: 1, tools: { does_not_exist: { description: 'x' } } },
    reg as never
  );
  // Known tool untouched
  assert.equal(tool.updated.length, 0);
});

test('applyManifestToTools: empty override produces no update call', () => {
  const tool = fakeTool({ description: 'orig' });
  const reg = new Map<string, any>([['t1', tool]]);
  applyManifestToTools({ manifestVersion: 1, tools: { t1: {} } }, reg as never);
  assert.equal(tool.updated.length, 0);
  assert.equal(tool.description, 'orig');
});

// ── activeNotices ──────────────────────────────────────────────────────

test('activeNotices: returns notices without showUntil', () => {
  const out = activeNotices({
    manifestVersion: 1,
    globalNotices: [{ level: 'info', message: 'hi' }],
  });
  assert.equal(out.length, 1);
});

test('activeNotices: filters out notices past showUntil', () => {
  const out = activeNotices({
    manifestVersion: 1,
    globalNotices: [
      { level: 'info', message: 'expired', showUntil: '2000-01-01T00:00:00Z' },
      { level: 'warn', message: 'live', showUntil: '9999-01-01T00:00:00Z' },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].message, 'live');
});

test('activeNotices: null manifest → empty list', () => {
  assert.deepEqual(activeNotices(null), []);
});

// ── package-default manifest ──────────────────────────────────────────

test('getPackageDefaultManifest: ships every registered tool with title + description', () => {
  const m = getPackageDefaultManifest();
  assert.equal(m.manifestVersion, 1);
  // Spot-check a few tools that index.ts registers
  const required = [
    'log10x_cost_drivers',
    'log10x_investigate',
    'log10x_signin_start',
    'log10x_signin_complete',
    'log10x_advise_install',
    'log10x_rotate_api_key',
  ];
  for (const name of required) {
    const tool = m.tools?.[name];
    assert.ok(tool, `expected tool ${name} in default manifest`);
    assert.ok(typeof tool.title === 'string' && tool.title.length > 0, `${name} missing title`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 50, `${name} missing description`);
  }
});

test('getPackageDefaultTool: returns the entry for a known tool', () => {
  const t = getPackageDefaultTool('log10x_cost_drivers');
  assert.equal(t.title, 'Cost drivers');
  assert.equal(t.annotations?.readOnlyHint, true);
});

test('getPackageDefaultTool: throws for an unknown tool name', () => {
  assert.throws(
    () => getPackageDefaultTool('log10x_does_not_exist'),
    /no default-manifest.json entry/
  );
});
