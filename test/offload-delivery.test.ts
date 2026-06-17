/**
 * offload-delivery verifier acceptance tests.
 *
 * The verifier closes the loop between the engine's `routeState="offload"`
 * STAMP and what actually landed in the sink. It exists to catch the two
 * failure modes the rest of the MCP is blind to because everything trusts
 * the stamp:
 *   - SILENT LOSS: stamped offload bytes but the sink is empty/frozen.
 *   - COPY-EVERYTHING (leak): the sink also carries drop/pass events, so the
 *     "offloaded" bytes never actually left the SIEM (the exact shape found
 *     live on the otel demo).
 *
 * Every verdict is driven through injected deps — no AWS, no metric backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyOffloadDelivery,
  type OffloadDeliveryDeps,
  type S3ObjectMeta,
} from '../src/lib/offload-delivery.js';

const NOW = 1_750_000_000_000; // fixed clock
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function jsonl(...recs: Array<Record<string, unknown>>): string {
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Build deps from a fixed object list + a body map + a stamped-bytes value. */
function deps(opts: {
  objects: S3ObjectMeta[];
  bodies?: Record<string, string>;
  stamped?: number | null;
  listThrows?: string;
  getThrows?: boolean;
}): OffloadDeliveryDeps {
  return {
    async listObjects() {
      if (opts.listThrows) throw new Error(opts.listThrows);
      return opts.objects;
    },
    async getObject(_bucket, key) {
      if (opts.getThrows) throw new Error('AccessDenied');
      return opts.bodies?.[key] ?? '';
    },
    async stampedOffloadBytes() {
      return opts.stamped ?? null;
    },
  };
}

const args = (over: Record<string, unknown> = {}) => ({
  bucket: 'tenx-retriever-acct',
  prefix: 'app/',
  recencyMinutes: 30,
  sampleObjects: 3,
  nowMs: NOW,
  ...over,
});

test('not_configured: no bucket → verdict not_configured, no AWS touched', async () => {
  const r = await verifyOffloadDelivery(args({ bucket: undefined }), deps({ objects: [] }));
  assert.equal(r.verdict, 'not_configured');
});

test('verified: recent objects, all routeState=offload → verified', async () => {
  const key = 'app/dt=1/node-x/0.txt';
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: key, Size: 2048, LastModified: minsAgo(2) }],
      bodies: {
        [key]: jsonl(
          { routeState: 'offload', tenx_hash: 'a', kubernetes: { container_name: 'cart' } },
          { routeState: 'offload', tenx_hash: 'b', kubernetes: { container_name: 'recommendation' } },
        ),
      },
      stamped: 5 * 1024 * 1024,
    }),
  );
  assert.equal(r.verdict, 'verified');
  assert.equal(r.recent_object_count, 1);
  assert.equal(r.sampled_events, 2);
  assert.deepEqual(r.leak_routestates, []);
  assert.equal(r.sampled_routestates.offload, 2);
  assert.equal(r.delivered_bytes_recent, 2048);
});

test('leak: sink also carries drop/pass → verdict leak (copy-everything detector)', async () => {
  const key = 'app/dt=1/node-x/9.txt';
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: key, Size: 4096, LastModified: minsAgo(1) }],
      bodies: {
        [key]: jsonl(
          { routeState: 'offload', tenx_hash: 'a' },
          { routeState: 'drop', tenx_hash: 'b' },
          { routeState: 'pass', tenx_hash: 'c' },
          { routeState: 'offload', tenx_hash: 'd' },
        ),
      },
      stamped: 5 * 1024 * 1024,
    }),
  );
  assert.equal(r.verdict, 'leak');
  assert.equal(r.sampled_events, 4);
  assert.equal(r.sampled_routestates.offload, 2);
  assert.deepEqual(r.leak_routestates.sort(), ['drop', 'pass']);
  assert.match(r.message, /overclaim/i);
});

test('silent_loss: stamped offload bytes but no recent objects → silent_loss', async () => {
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: 'app/old.txt', Size: 100, LastModified: minsAgo(600) }],
      stamped: 12 * 1024 * 1024,
    }),
  );
  assert.equal(r.verdict, 'silent_loss');
  assert.equal(r.recent_object_count, 0);
  assert.match(r.message, /phantom|not reaching/i);
});

test('silent_loss: stamped bytes, completely empty bucket → silent_loss', async () => {
  const r = await verifyOffloadDelivery(args(), deps({ objects: [], stamped: 1024 }));
  assert.equal(r.verdict, 'silent_loss');
  assert.equal(r.total_object_count, 0);
});

test('stale: old objects, no stamp → stale (not a loss, just idle/stopped)', async () => {
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: 'app/old.txt', Size: 100, LastModified: minsAgo(120) }],
      stamped: 0,
    }),
  );
  assert.equal(r.verdict, 'stale');
});

test('idle: no stamp + empty bucket → idle (configured, unused)', async () => {
  const r = await verifyOffloadDelivery(args(), deps({ objects: [], stamped: 0 }));
  assert.equal(r.verdict, 'idle');
});

test('unverified: list throws (no creds) → unverified, never claims a verdict', async () => {
  const r = await verifyOffloadDelivery(
    args(),
    deps({ objects: [], stamped: 5_000_000, listThrows: 'Unable to locate credentials' }),
  );
  assert.equal(r.verdict, 'unverified');
  assert.match(r.message, /credential|ListBucket/i);
});

test('unverified: recent objects exist but getObject denied → unverified (live but unchecked)', async () => {
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: 'app/new.txt', Size: 500, LastModified: minsAgo(1) }],
      getThrows: true,
      stamped: 1024,
    }),
  );
  assert.equal(r.verdict, 'unverified');
  assert.equal(r.recent_object_count, 1);
});

test('stampedOffloadBytes=null (no backend): pure offload sink still → verified on liveness+purity', async () => {
  const key = 'app/new.txt';
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: key, Size: 1000, LastModified: minsAgo(1) }],
      bodies: { [key]: jsonl({ routeState: 'offload' }) },
      stamped: null,
    }),
  );
  assert.equal(r.verdict, 'verified');
  assert.equal(r.stamped_offload_bytes, null);
});

test('purity samples BOTH newest and oldest recent objects → an aging-out leak is caught', async () => {
  // 4 recent objects: the 2 newest are pure offload (forwarder just fixed),
  // the 2 oldest (still in the recency window) carry a leak from before the
  // fix. Boundary sampling (newest + oldest) must catch it; a newest-only
  // sample would falsely return 'verified'.
  const objects: S3ObjectMeta[] = [
    { Key: 'k_new1', Size: 10, LastModified: minsAgo(1) },
    { Key: 'k_new2', Size: 10, LastModified: minsAgo(2) },
    { Key: 'k_old1', Size: 10, LastModified: minsAgo(3) },
    { Key: 'k_old2', Size: 10, LastModified: minsAgo(4) },
  ];
  const bodies = {
    k_new1: jsonl({ routeState: 'offload' }),
    k_new2: jsonl({ routeState: 'offload' }),
    k_old1: jsonl({ routeState: 'drop' }),
    k_old2: jsonl({ routeState: 'drop' }),
  };
  // sampleObjects:1 → samples newest (k_new1) + oldest (k_old2); the leak in
  // the aging-out oldest object is caught.
  const r = await verifyOffloadDelivery(
    args({ sampleObjects: 1 }),
    deps({ objects, bodies, stamped: 1024 }),
  );
  assert.equal(r.verdict, 'leak');
  assert.ok(r.leak_routestates.includes('drop'));
});

test('unparseable bodies but live objects → unverified (cannot assert purity, NOT "verified")', async () => {
  const key = 'app/blob.bin';
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: key, Size: 999, LastModified: minsAgo(1) }],
      bodies: { [key]: 'not json at all\n{also not\n' },
      stamped: 1024,
    }),
  );
  assert.equal(r.verdict, 'unverified');
  assert.equal(r.sampled_events, 0);
  assert.match(r.message, /UNVERIFIED|no parseable|cannot be confirmed/i);
});

test('future-dated decoy objects cannot fake freshness → silent_loss when stamped', async () => {
  // All objects dated far in the future (beyond the 10m skew bound) must NOT
  // count as recent; with stamped offload bytes that is a silent loss, not a
  // false "verified" with a 0s-ago age.
  const future = new Date(NOW + 48 * 3600_000).toISOString();
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: 'k_future', Size: 999, LastModified: future }],
      bodies: { k_future: jsonl({ routeState: 'offload' }) },
      stamped: 5_000_000,
    }),
  );
  assert.equal(r.verdict, 'silent_loss');
  assert.equal(r.recent_object_count, 0);
});

test('small forward clock skew (within the 10m bound) still counts as recent', async () => {
  const key = 'k_skew';
  const nearFuture = new Date(NOW + 5 * 60_000).toISOString(); // 5m ahead
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: key, Size: 10, LastModified: nearFuture }],
      bodies: { [key]: jsonl({ routeState: 'offload' }) },
      stamped: 1024,
    }),
  );
  assert.equal(r.verdict, 'verified');
});

test('missing routeState field tallies as <none> and counts as a leak', async () => {
  const key = 'app/new.txt';
  const r = await verifyOffloadDelivery(
    args(),
    deps({
      objects: [{ Key: key, Size: 10, LastModified: minsAgo(1) }],
      bodies: { [key]: jsonl({ routeState: 'offload' }, { tenx_hash: 'x' /* no routeState */ }) },
      stamped: 1024,
    }),
  );
  assert.equal(r.verdict, 'leak');
  assert.ok(r.leak_routestates.includes('<none>'));
});
