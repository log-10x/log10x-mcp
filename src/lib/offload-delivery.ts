/**
 * Offload delivery verifier — closes the loop between the engine's
 * `routeState="offload"` STAMP and what actually LANDED in the customer's
 * offload sink (S3).
 *
 * The rest of the MCP trusts the stamp: cost / savings / commitment_report /
 * offload-status all read `all_events_summaryBytes_total{routeState=...}` and
 * NEVER check the sink. That makes two real failure modes invisible:
 *
 *   1. SILENT LOSS — the engine stamps `offload`, but the forwarder never
 *      routes those events to S3 (missing s3 plugin, wrong bucket, bad IAM).
 *      The metric still shows the "saving"; no bytes were actually offloaded.
 *
 *   2. COPY-EVERYTHING — the forwarder ships ALL events to the sink AND to
 *      the SIEM (the exact shape found on the otel demo: an `@type copy`
 *      proof config). The "offloaded" bytes never left the SIEM, so the
 *      saving is phantom — yet the stamp reports it as real.
 *
 * This verifier issues three falsifiable checks against the LIVE sink:
 *   - LIVENESS — recent objects exist under the bucket/prefix.
 *   - PURITY   — sampled sink objects carry ONLY `routeState="offload"`.
 *                A sink that also holds `drop`/`pass` events is the
 *                copy-everything tell (the forwarder isn't filtering).
 *   - NOT-LOSS — if the engine stamped offload bytes in the window but the
 *                sink has no recent objects, delivery is broken.
 *
 * Byte-for-byte reconciliation is deliberately NOT a pass/fail gate: S3
 * stores the JSON-wrapped fullText, the metric counts engine summaryBytes —
 * different units. The delivered/stamped relationship is informational only.
 *
 * Dependencies are injectable so the suite drives every verdict without AWS
 * or a metric backend (mirrors the `retriever-probe.ts` ProbeDeps pattern).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * The honest end states. Mapped to doctor pass/warn/fail by the caller:
 *   fail  ← silent_loss, leak
 *   warn  ← unverified, stale
 *   pass  ← verified, idle, not_configured
 */
export type OffloadDeliveryVerdict =
  | 'verified'        // recent objects, pure (offload-only), delivery is real
  | 'silent_loss'     // engine stamped offload bytes but the sink is empty/frozen
  | 'leak'            // sink also carries non-offload events (copy-everything)
  | 'stale'           // objects exist but none recent, and no current stamp
  | 'idle'            // no stamped bytes + no recent objects: configured, unused
  | 'unverified'      // could not read the sink (no creds / list error)
  | 'not_configured'; // no offload bucket resolved

export interface RouteStateTally {
  [routeState: string]: number;
}

export interface OffloadDeliveryResult {
  verdict: OffloadDeliveryVerdict;
  bucket?: string;
  prefix?: string;
  /** Objects modified within the recency window. */
  recent_object_count: number;
  /** All objects under the prefix (subject to the lister's own ceiling). */
  total_object_count: number;
  /** Age of the newest object in seconds; null when none/unparseable. */
  newest_object_age_sec: number | null;
  /** Sum of `.Size` over recent objects (raw sink bytes, not metric bytes). */
  delivered_bytes_recent: number;
  /** Engine-stamped offload bytes in the window; null when unavailable. */
  stamped_offload_bytes: number | null;
  /** Total event lines parsed across the sampled objects. */
  sampled_events: number;
  /** routeState → count across sampled events. */
  sampled_routestates: RouteStateTally;
  /** Non-`offload` routeStates found in the sink (the leak set). */
  leak_routestates: string[];
  /** One-line human summary. */
  message: string;
}

export interface S3ObjectMeta {
  Key: string;
  Size?: number;
  LastModified?: string;
}

export interface OffloadDeliveryDeps {
  /** List objects under bucket/prefix. Throws on a real error (e.g. NoSuchBucket). */
  listObjects(bucket: string, prefix: string): Promise<S3ObjectMeta[]>;
  /** Fetch one object's body (newline-delimited JSON events). */
  getObject(bucket: string, key: string): Promise<string>;
  /**
   * Engine-stamped offload bytes over the window (PromQL
   * `sum(increase(all_events_summaryBytes_total{routeState="offload"}[w]))`).
   * Returns null when no metric backend is wired — the verifier then relies
   * on liveness + purity alone and cannot assert silent_loss.
   */
  stampedOffloadBytes(): Promise<number | null>;
}

export interface OffloadDeliveryArgs {
  bucket?: string;
  prefix?: string;
  /** Recency window in minutes for "recent" + stale detection. Default 30. */
  recencyMinutes?: number;
  /** How many newest objects to sample for the purity check. Default 3. */
  sampleObjects?: number;
  /** Injected clock (unix-ms) for deterministic tests. Default Date.now(). */
  nowMs?: number;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${Math.round(n)} B`;
}

function ageStr(sec: number | null): string {
  if (sec === null) return 'never';
  if (sec < 90) return `${sec}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  return `${(sec / 3600).toFixed(1)}h ago`;
}

function trunc(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 200);
}

function empty(verdict: OffloadDeliveryVerdict, over: Partial<OffloadDeliveryResult>): OffloadDeliveryResult {
  return {
    verdict,
    recent_object_count: 0,
    total_object_count: 0,
    newest_object_age_sec: null,
    delivered_bytes_recent: 0,
    stamped_offload_bytes: null,
    sampled_events: 0,
    sampled_routestates: {},
    leak_routestates: [],
    message: '',
    ...over,
  };
}

/**
 * Verify that engine-stamped offload is actually delivered to (and only to)
 * the configured sink. Pure given its deps — no global state.
 */
export async function verifyOffloadDelivery(
  args: OffloadDeliveryArgs,
  deps: OffloadDeliveryDeps,
): Promise<OffloadDeliveryResult> {
  const bucket = args.bucket;
  const prefix = args.prefix ?? '';
  const recencyMin = args.recencyMinutes ?? 30;
  const sampleN = Math.max(1, args.sampleObjects ?? 3);
  const now = args.nowMs ?? Date.now();

  if (!bucket) {
    return empty('not_configured', {
      message: 'No active offload destination configured; offload delivery is not verifiable.',
    });
  }

  // Stamped side (engine) — may be null if no metric backend.
  let stamped: number | null = null;
  try {
    stamped = await deps.stampedOffloadBytes();
  } catch {
    stamped = null;
  }
  const stampedActive = (stamped ?? 0) > 0;

  // Sink side (S3).
  let objects: S3ObjectMeta[];
  try {
    objects = await deps.listObjects(bucket, prefix);
  } catch (e) {
    return empty('unverified', {
      bucket,
      prefix,
      stamped_offload_bytes: stamped,
      message:
        `Could not list s3://${bucket}/${prefix} (${trunc(e)}). Offload delivery is UNVERIFIED — ` +
        `check AWS credentials and s3:ListBucket on the offload bucket.`,
    });
  }

  // Recency, with a forward clock-skew bound: an object dated more than
  // SKEW_MS in the future is NOT counted as recent and cannot set "newest".
  // Without this, a forwarder writing future-dated decoy objects could fake
  // freshness (newestAgeSec would clamp to 0) and mask a stale/empty sink.
  const SKEW_MS = 10 * 60_000;
  const cutoff = now - recencyMin * 60_000;
  const futureBound = now + SKEW_MS;
  const withTs = objects.map((o) => ({ o, ts: o.LastModified ? Date.parse(o.LastModified) : NaN }));
  const recent = withTs.filter((x) => Number.isFinite(x.ts) && x.ts > cutoff && x.ts <= futureBound);
  let newestTs = -Infinity;
  for (const x of withTs) if (Number.isFinite(x.ts) && x.ts <= futureBound && x.ts > newestTs) newestTs = x.ts;
  const newestAgeSec = newestTs > -Infinity ? Math.max(0, Math.round((now - newestTs) / 1000)) : null;
  const deliveredBytesRecent = recent.reduce((s, x) => s + (x.o.Size ?? 0), 0);

  // No recent delivery.
  if (recent.length === 0) {
    if (stampedActive) {
      return empty('silent_loss', {
        bucket,
        prefix,
        total_object_count: objects.length,
        newest_object_age_sec: newestAgeSec,
        stamped_offload_bytes: stamped,
        message:
          `Engine stamped ${fmtBytes(stamped!)} as offload in the window, but s3://${bucket}/${prefix} ` +
          `has no objects in the last ${recencyMin}m (newest ${ageStr(newestAgeSec)}). Offload is NOT reaching ` +
          `the sink — the forwarder routeState routing is missing, misconfigured, or pointed at the wrong bucket. ` +
          `Any saving claimed for these bytes is phantom.`,
      });
    }
    if (objects.length > 0) {
      return empty('stale', {
        bucket,
        prefix,
        total_object_count: objects.length,
        newest_object_age_sec: newestAgeSec,
        stamped_offload_bytes: stamped,
        message:
          `s3://${bucket}/${prefix} has objects but none in the last ${recencyMin}m (newest ${ageStr(newestAgeSec)}), ` +
          `and no offload bytes are being stamped now. Offload appears idle/stopped, not actively delivering.`,
      });
    }
    return empty('idle', {
      bucket,
      prefix,
      stamped_offload_bytes: stamped,
      message:
        `No offload bytes stamped and no objects in s3://${bucket}/${prefix}. Offload is configured but not in use.` +
        (stamped === null
          ? ' (No metric backend available, so a silent delivery loss cannot be fully ruled out here.)'
          : ''),
    });
  }

  // Purity — sample BOTH the newest and the oldest objects within the recent
  // window (deduped). Newest catches a leak that just started; oldest catches
  // a leak still aging out of the window after a fix. A newest-only sample
  // would return a false "verified" while poisoned objects from before a fix
  // still sit in the window. (Boundary sampling, not exhaustive — a leak only
  // in the middle of a large window can still slip; documented limitation.)
  const byNewest = [...recent].sort((a, b) => b.ts - a.ts);
  const sampleSet = new Map<string, S3ObjectMeta>();
  for (const x of byNewest.slice(0, sampleN)) sampleSet.set(x.o.Key, x.o);
  for (const x of byNewest.slice(-sampleN)) sampleSet.set(x.o.Key, x.o);
  const sampleObjs = [...sampleSet.values()];

  // Fetch in parallel (bounded by ≤ 2*sampleN objects) so the purity probe
  // can't serialize into a multi-minute block on a slow sink.
  const fetched = await Promise.all(
    sampleObjs.map((o) =>
      deps.getObject(bucket, o.Key).then(
        (body) => ({ ok: true as const, body }),
        () => ({ ok: false as const, body: '' }),
      ),
    ),
  );
  const tally: RouteStateTally = {};
  let sampled = 0;
  let fetchErr = false;
  for (const r of fetched) {
    if (!r.ok) {
      fetchErr = true;
      continue;
    }
    for (const line of r.body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec: { routeState?: unknown };
      try {
        rec = JSON.parse(t) as { routeState?: unknown };
      } catch {
        continue;
      }
      const rs = typeof rec.routeState === 'string' ? rec.routeState : '<none>';
      tally[rs] = (tally[rs] ?? 0) + 1;
      sampled++;
    }
  }

  const leakStates = Object.keys(tally).filter((rs) => rs !== 'offload');

  // Live objects exist but none yielded a parseable event. Do NOT call that
  // "verified" — a forwarder writing empty/binary/compressed blobs (or a
  // denied GetObject) must not pass as delivered. Purity is unasserted →
  // unverified, never verified.
  if (sampled === 0) {
    return empty('unverified', {
      bucket,
      prefix,
      recent_object_count: recent.length,
      total_object_count: objects.length,
      newest_object_age_sec: newestAgeSec,
      delivered_bytes_recent: deliveredBytesRecent,
      stamped_offload_bytes: stamped,
      message: fetchErr
        ? `s3://${bucket}/${prefix} has ${recent.length} recent object(s) but they could not be read for the ` +
          `purity check (s3:GetObject denied or fetch error). Delivery is live but UNVERIFIED for leaks.`
        : `s3://${bucket}/${prefix} has ${recent.length} recent object(s) but none contained a parseable ` +
          `routeState event (empty/binary/compressed objects). Delivery is live but UNVERIFIED — the offload ` +
          `slice cannot be confirmed.`,
    });
  }

  // Copy-everything leak — the sink holds events the forwarder should NOT
  // have routed there. This is the saving-overclaim detector.
  if (leakStates.length > 0) {
    const offloadN = tally['offload'] ?? 0;
    const leakN = sampled - offloadN;
    return empty('leak', {
      bucket,
      prefix,
      recent_object_count: recent.length,
      total_object_count: objects.length,
      newest_object_age_sec: newestAgeSec,
      delivered_bytes_recent: deliveredBytesRecent,
      stamped_offload_bytes: stamped,
      sampled_events: sampled,
      sampled_routestates: tally,
      leak_routestates: leakStates,
      message:
        `s3://${bucket}/${prefix} carries non-offload events (${leakN}/${sampled} sampled are ` +
        `${leakStates.join('/')}, not offload). The forwarder is routing more than the offload slice ` +
        `(copy-everything): those bytes also remain in the SIEM, so the offload saving is overclaimed. ` +
        `Fix the forwarder to route only routeState=="offload" to this sink.`,
    });
  }

  // Recent + pure → real delivery.
  return empty('verified', {
    bucket,
    prefix,
    recent_object_count: recent.length,
    total_object_count: objects.length,
    newest_object_age_sec: newestAgeSec,
    delivered_bytes_recent: deliveredBytesRecent,
    stamped_offload_bytes: stamped,
    sampled_events: sampled,
    sampled_routestates: tally,
    message:
      `Offload delivery verified: ${recent.length} recent object(s) in s3://${bucket}/${prefix} ` +
      `(newest ${ageStr(newestAgeSec)}), and ${sampled}/${sampled} sampled events are routeState=offload (no leak)` +
      `${stamped !== null
        ? `. Engine stamped ${fmtBytes(stamped)} offload in the window; the sink received ${fmtBytes(deliveredBytesRecent)} of raw objects ` +
          `(units differ — JSON fullText vs metric summaryBytes — so this is a sanity figure, not a reconciliation)`
        : ''}.`,
  });
}

// ── Default deps (real aws CLI) ─────────────────────────────────────────────

async function defaultListObjects(bucket: string, prefix: string): Promise<S3ObjectMeta[]> {
  try {
    // `aws s3api list-objects-v2` AUTO-PAGINATES (the CLI follows
    // NextContinuationToken internally and merges all pages — verified live at
    // 54k+ keys on a single call). Do NOT add a manual token loop. The ceiling
    // is maxBuffer (~150 bytes/key JSON → 32 MB covers ~200k keys).
    const { stdout } = await execFileP(
      'aws',
      ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--output', 'json'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as { Contents?: S3ObjectMeta[] };
    return parsed.Contents ?? [];
  } catch (e) {
    const stderr = (e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? '';
    if (stderr.includes('NoSuchBucket')) throw new Error(`offload bucket does not exist: ${bucket}`);
    throw new Error(`aws s3api list-objects-v2 failed: ${stderr.slice(0, 300)}`);
  }
}

async function defaultGetObject(bucket: string, key: string): Promise<string> {
  // Sampled in parallel by verifyOffloadDelivery, so this per-object 10s bound
  // is the worst-case latency the purity probe adds, not 10s × sampleObjects.
  const { stdout } = await execFileP('aws', ['s3', 'cp', `s3://${bucket}/${key}`, '-'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}

/**
 * Build default deps. `stampedOffloadBytes` has no AWS-free default — the
 * caller (doctor / commitment_report) wires it to a PromQL query because it
 * needs the EnvConfig + executor. Without it, pass `() => Promise.resolve(null)`
 * and the verifier runs on liveness + purity alone.
 */
export function defaultOffloadDeliveryDeps(
  stampedOffloadBytes: () => Promise<number | null> = async () => null,
): OffloadDeliveryDeps {
  return {
    listObjects: defaultListObjects,
    getObject: defaultGetObject,
    stampedOffloadBytes,
  };
}
