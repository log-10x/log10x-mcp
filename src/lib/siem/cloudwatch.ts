/**
 * CloudWatch Logs connector.
 *
 * Uses FilterLogEvents for scoped retrieval across one or more log groups.
 * Supports wildcard log-group patterns via DescribeLogGroups (`/aws/ecs/*`).
 *
 * Credential discovery:
 *   - `env`: explicit AWS_* env vars present (AWS_ACCESS_KEY_ID + AWS_REGION, etc.)
 *   - `ambient`: defaultProvider() resolves credentials from the chain
 *     (instance metadata, ~/.aws/credentials, SSO cache, etc.)
 *   - `none`: nothing resolvable
 *
 * Pagination: FilterLogEvents returns nextToken; we paginate until
 * targetEventCount reached, time exhausted, or the API says "no more".
 *
 * Rate limiting: AWS throttling exceptions are retried with exponential
 * backoff. Transient 5xx errors are retried up to 3× per request.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
  type FilteredLogEvent,
  type LogGroup,
} from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
  VolumeDetectionOptions,
  VolumeDetectionResult,
} from './index.js';

import { shouldStop, sleep, retryWithBackoff, parseWindowMs } from './_retry.js';
import { randomTimeBuckets, perBucketCap } from './_sampling.js';

/**
 * Default stratified-sampling bucket count for CloudWatch pulls.
 *
 * Exported because the offline export-plan emitter
 * (`lib/siem/export-plan/cloudwatch.ts`) renders a shell script that must
 * draw the SAME sample this connector draws — same bucket count, same
 * per-bucket cap — or a fenced POC and a live POC over the same window
 * would report different pattern mixes for reasons that have nothing to do
 * with the logs. One constant, two callers.
 */
export const CLOUDWATCH_BUCKET_COUNT = 24;

/** Per-request event ceiling CloudWatch's FilterLogEvents accepts. */
export const CLOUDWATCH_PAGE_LIMIT = 10_000;

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const hasExplicitKey = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const hasProfile = Boolean(process.env.AWS_PROFILE);
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

  if (hasExplicitKey) {
    return {
      available: true,
      source: 'env',
      details: { region: region || 'not-set', via: 'AWS_ACCESS_KEY_ID' },
    };
  }
  if (hasProfile && region) {
    return {
      available: true,
      source: 'cli_config',
      details: { region, profile: process.env.AWS_PROFILE },
    };
  }
  // Try ambient resolution (SSO cache, instance profile, ECS task role). This
  // is the most common case for devs already logged in via `aws sso login`.
  try {
    const provider = fromNodeProviderChain();
    const creds = await Promise.race([
      provider(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    if (creds && typeof creds === 'object' && 'accessKeyId' in creds) {
      return {
        available: true,
        source: 'ambient',
        details: { region: region || 'us-east-1 (default)' },
      };
    }
    return { available: false, source: 'none' };
  } catch {
    return { available: false, source: 'none' };
  }
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const toMs = Date.now();
  const fromMs = toMs - windowMs;

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const client = new CloudWatchLogsClient({ region, maxAttempts: 3 });

  const events: FilteredLogEvent[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  const notes: string[] = [];

  const scope = opts.scope || '';
  // Resolve log-group(s). Wildcard → DescribeLogGroups(prefix=...) expand.
  let logGroups: string[] = [];

  // DescribeLogGroups by name prefix, paginated (empty prefix = list all).
  const expand = async (prefix: string): Promise<string[]> => {
    const out: string[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await retryWithBackoff(() =>
        client.send(
          new DescribeLogGroupsCommand(
            prefix
              ? { logGroupNamePrefix: prefix, nextToken, limit: 50 }
              : { nextToken, limit: 50 },
          ),
        ),
      );
      for (const g of resp.logGroups || []) {
        if (g.logGroupName) out.push(g.logGroupName);
      }
      nextToken = resp.nextToken;
      if (shouldStop(deadline, events.length, opts.targetEventCount)) break;
    } while (nextToken && out.length < 200);
    return out;
  };

  try {
    if (!scope) {
      // Auto-discovery: a 10x-powered forwarder ships to a /log10x or
      // /tenx log group by convention. Probe those prefixes and use
      // what's there — the agent shouldn't have to know the group name
      // when it's discoverable. If neither convention resolves, fail
      // LOUD with the groups that DO exist so the caller can pass
      // `scope` — never silently return empty (that reads as "no
      // events" and hides a config gap).
      for (const conv of ['/log10x', '/tenx']) {
        logGroups = await expand(conv);
        if (logGroups.length > 0) {
          notes.push(`scope auto-discovered: ${logGroups.length} group(s) under "${conv}*"`);
          break;
        }
      }
      if (logGroups.length === 0) {
        const present = (await expand('')).slice(0, 15);
        throw new Error(
          'no `scope` given and no /log10x or /tenx log group found (10x-forwarder convention). ' +
            'Pass `scope` as a log group name or prefix wildcard (`/aws/ecs/*`). ' +
            (present.length
              ? `Log groups present: ${present.join(', ')}`
              : 'No log groups exist in this account/region.'),
        );
      }
    } else if (scope.includes('*')) {
      const prefix = scope.replace(/\*+$/, '').replace(/\*/g, '');
      logGroups = await expand(prefix);
      if (logGroups.length === 0) {
        throw new Error(`No log groups matched prefix "${prefix}"`);
      }
    } else {
      logGroups = [scope];
    }
  } catch (e) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: scope,
        reasonStopped: 'error',
        notes: [`scope_resolution_failed: ${(e as Error).message}`],
      },
    };
  }

  opts.onProgress({ step: `resolved ${logGroups.length} log group(s)`, pct: 3, eventsFetched: 0 });

  const filterPattern = opts.query || undefined;

  // Stratified random sampling: 24 child sub-windows scattered across
  // the parent window with per-run RNG. For each bucket, iterate the
  // resolved log groups; bucketCap limits the total events across all
  // groups within one bucket so a single chatty group can't monopolize.
  // Bucket count is caller-tunable. Default 24 for time-representative
  // sampling; a low value (e.g. 1) collapses to a fast recent-window
  // pull for callers that just need a quick sample (top_patterns).
  const BUCKET_COUNT = Math.max(1, opts.buckets ?? CLOUDWATCH_BUCKET_COUNT);
  const buckets = randomTimeBuckets(fromMs, toMs, BUCKET_COUNT);
  const bucketCap = perBucketCap(opts.targetEventCount, BUCKET_COUNT);
  const queryUsed = `${logGroups.join(',')}${filterPattern ? ` | ${filterPattern}` : ''}`;

  bucketLoop: for (const bucket of buckets) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    let bucketEvents = 0;
    for (let gi = 0; gi < logGroups.length; gi++) {
      if (bucketEvents >= bucketCap) break;
      if (shouldStop(deadline, events.length, opts.targetEventCount)) {
        reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
        break bucketLoop;
      }
      const logGroupName = logGroups[gi];
      let nextToken: string | undefined;
      while (bucketEvents < bucketCap) {
        if (shouldStop(deadline, events.length, opts.targetEventCount)) {
          reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
          break bucketLoop;
        }
        try {
          const resp = await retryWithBackoff(() =>
            client.send(
              new FilterLogEventsCommand({
                logGroupName,
                startTime: bucket.fromMs,
                endTime: bucket.toMs,
                filterPattern,
                limit: CLOUDWATCH_PAGE_LIMIT,
                nextToken,
              })
            )
          );
          if (resp.events && resp.events.length > 0) {
            for (const ev of resp.events) {
              if (bucketEvents >= bucketCap) break;
              events.push(ev);
              bucketEvents++;
            }
          }
          nextToken = resp.nextToken;
          if (!nextToken) break; // group/bucket exhausted
        } catch (e) {
          const msg = (e as Error).message || '';
          notes.push(`bucket_${bucket.index}_${logGroupName}_error: ${msg.slice(0, 200)}`);
          break; // non-fatal per group/bucket
        }
        opts.onProgress({
          step: `cloudwatch bucket ${bucket.index + 1}/${BUCKET_COUNT} group ${gi + 1}/${logGroups.length}`,
          pct: Math.min(
            50,
            Math.round(((bucket.index + bucketEvents / bucketCap) / BUCKET_COUNT) * 50)
          ),
          eventsFetched: events.length,
        });
      }
    }
  }

  // Fill pass. The stratified pass reads 24 child windows that together cover
  // a quarter of the parent window, so when those run dry below target the
  // pull used to stop and call the source exhausted after reading about a
  // quarter of it (5,228 of 20,160 events on a 1h window). Read the rest of
  // the window, skipping events already taken, before saying so.
  if (reasonStopped === 'source_exhausted' && events.length < opts.targetEventCount) {
    const seen = new Set(events.map((e) => e.eventId).filter(Boolean) as string[]);
    fillLoop: for (const logGroupName of logGroups) {
      let nextToken: string | undefined;
      for (;;) {
        if (shouldStop(deadline, events.length, opts.targetEventCount)) {
          reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
          break fillLoop;
        }
        try {
          const resp = await retryWithBackoff(() =>
            client.send(
              new FilterLogEventsCommand({
                logGroupName,
                startTime: fromMs,
                endTime: toMs,
                filterPattern,
                limit: CLOUDWATCH_PAGE_LIMIT,
                nextToken,
              })
            )
          );
          for (const ev of resp.events ?? []) {
            if (ev.eventId && seen.has(ev.eventId)) continue;
            if (ev.eventId) seen.add(ev.eventId);
            events.push(ev);
            if (events.length >= opts.targetEventCount) break;
          }
          nextToken = resp.nextToken;
          if (!nextToken) break;
        } catch (e) {
          notes.push(`fill_${logGroupName}_error: ${((e as Error).message || '').slice(0, 200)}`);
          break;
        }
        opts.onProgress({ step: `cloudwatch fill ${logGroupName}`, pct: 50, eventsFetched: events.length });
      }
    }
    if (events.length >= opts.targetEventCount) reasonStopped = 'target_reached';
  }

  client.destroy();

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: `${logGroups.join(',')}${filterPattern ? ` | ${filterPattern}` : ''}`,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

// Unused but kept for semantic parity; await yields to other connectors.
async function _settleMs(ms: number): Promise<void> {
  await sleep(ms);
}

/**
 * Billed daily ingest from the AWS/Logs `IncomingBytes` metric: the exact
 * uncompressed bytes CloudWatch charges ingestion on, per log group. Averaged
 * over the last 7 full days that carry data. Returns null when the metric is
 * unreadable (no cloudwatch:GetMetricData permission) or empty, so the caller
 * falls back to the storedBytes estimate.
 */
export async function incomingBytesDailyAverage(
  groupNames: string[],
  region: string,
  now: number = Date.now(),
  client: { send: (cmd: GetMetricDataCommand) => Promise<{ MetricDataResults?: Array<{ Values?: number[] }> }> } =
    new CloudWatchClient({ region, maxAttempts: 3 }),
): Promise<{ dailyBytes: number; days: number } | null> {
  const names = groupNames.slice(0, 500);
  if (names.length === 0) return null;
  const end = new Date(Math.floor(now / 86_400_000) * 86_400_000); // midnight UTC, full days only
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const perDay = new Map<number, number>(); // day index -> bytes across groups
  try {
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      const resp = await client.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          MetricDataQueries: batch.map((g, j) => ({
            Id: `g${i + j}`,
            MetricStat: {
              Metric: { Namespace: 'AWS/Logs', MetricName: 'IncomingBytes', Dimensions: [{ Name: 'LogGroupName', Value: g }] },
              Period: 86_400,
              Stat: 'Sum',
            },
          })),
        })
      );
      for (const r of resp.MetricDataResults ?? []) {
        (r.Values ?? []).forEach((v, k) => perDay.set(k, (perDay.get(k) ?? 0) + (v || 0)));
      }
    }
  } catch {
    return null;
  } finally {
    (client as { destroy?: () => void }).destroy?.();
  }
  const days = [...perDay.values()].filter((v) => v > 0);
  if (days.length === 0) return null;
  return { dailyBytes: days.reduce((a, b) => a + b, 0) / days.length, days: days.length };
}

/**
 * Detect CloudWatch daily ingest volume.
 *
 * Preferred: the AWS/Logs IncomingBytes metric (billed, uncompressed bytes).
 * Fallback approach: DescribeLogGroups returns `storedBytes` per log group (total
 * on-disk bytes, INCLUDING historical data across the retention window).
 * Divide by retention days to get a daily-ingest estimate.
 *
 * Caveats:
 *   - When a log group has retention NEVER_EXPIRE, we fall back to a
 *     30-day assumption. Reported with a disclaimer in the source label.
 *   - When scope is narrowed to a single log group (not a wildcard),
 *     the detected volume is ONLY that log group's ingest, not the
 *     account's total. Correct for the pattern-extrapolation math
 *     because the pull also targets that log group.
 *   - AWS rotates storedBytes lazily; very-recent bursts may undercount.
 */
async function detectDailyVolumeGb(opts: VolumeDetectionOptions): Promise<VolumeDetectionResult> {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const client = new CloudWatchLogsClient({ region, maxAttempts: 3 });
  try {
    const scope = opts.scope || '';
    const prefix = scope.includes('*')
      ? scope.replace(/\*+$/, '').replace(/\*/g, '')
      : scope;
    const groups: LogGroup[] = [];
    let nextToken: string | undefined;
    const maxPages = 10;
    for (let p = 0; p < maxPages; p++) {
      const resp = await client.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: prefix || undefined,
          nextToken,
          limit: 50,
        })
      );
      if (resp.logGroups) groups.push(...resp.logGroups);
      if (!resp.nextToken) break;
      nextToken = resp.nextToken;
    }
    if (groups.length === 0) {
      return {
        errorNote: `CloudWatch describeLogGroups returned 0 groups for prefix "${prefix || '(all)'}"`,
      };
    }
    let totalBytes = 0;
    let dailyBytes = 0; // sum of per-group bytes/retention
    let neverExpireCount = 0;
    let weightedRetentionDays = 0; // kept only for the display label
    let retentionBytes = 0;
    for (const g of groups) {
      const bytes = g.storedBytes ?? 0;
      if (bytes <= 0) continue;
      totalBytes += bytes;
      const retention = g.retentionInDays;
      // Apply the disclosed NEVER_EXPIRE assumption (30d) PER GROUP so the
      // estimate matches the note, instead of dividing never-expire bytes
      // by whatever retention the other groups happen to have. Clamp each
      // retention to [1,365] to preserve prior bounding behavior.
      const effDays =
        retention && retention > 0
          ? Math.max(1, Math.min(365, retention))
          : 30;
      dailyBytes += bytes / effDays;
      if (retention && retention > 0) {
        weightedRetentionDays += retention * bytes;
        retentionBytes += bytes;
      } else {
        neverExpireCount++;
      }
    }
    // Billed ingest first. storedBytes is COMPRESSED storage, so dividing it
    // by retention understates what CloudWatch bills for ingestion (measured
    // 11x low on /log10x/otel-demo: 49.7 MB/day from storedBytes against
    // 560.8 MB/day of IncomingBytes).
    const incoming = await incomingBytesDailyAverage(
      groups.map((g) => g.logGroupName ?? '').filter(Boolean),
      region,
    );
    if (incoming) {
      return {
        dailyGb: incoming.dailyBytes / (1024 ** 3),
        source: `CloudWatch IncomingBytes metric (${groups.length} group${groups.length === 1 ? '' : 's'}, ${incoming.days}-day average of billed ingest)`,
      };
    }
    if (totalBytes === 0) {
      return { errorNote: 'CloudWatch: matching log groups have 0 storedBytes (cold / empty)' };
    }
    const dailyGb = dailyBytes / (1024 ** 3);
    // Display-only blended retention for the source label (bytes-weighted
    // across groups WITH retention set; falls back to the 30d assumption).
    const days = Math.round(
      retentionBytes > 0 ? weightedRetentionDays / retentionBytes : 30
    );
    const neverExpireNote =
      neverExpireCount > 0 ? ` — ${neverExpireCount} group(s) have NEVER_EXPIRE retention; assumed 30d for that subset` : '';
    // When any log group has NEVER_EXPIRE retention, the 30-day floor
    // is a guess: real ingest could be anywhere from 0.3× (data has
    // accumulated for 90+ days) to 3× (data is much fresher than 30d).
    // Surface that as a range so the headline cost reflects the
    // assumption.
    const rangeMultiplier =
      neverExpireCount > 0 ? { low: 0.3, high: 3 } : undefined;
    return {
      dailyGb,
      source: `CloudWatch DescribeLogGroups (${groups.length} group${groups.length === 1 ? '' : 's'}, ~${Math.round(days)}d retention; stored bytes are compressed, so billed ingest is higher; grant cloudwatch:GetMetricData for the exact IncomingBytes figure)${neverExpireNote}`,
      ...(rangeMultiplier ? { rangeMultiplier } : {}),
    };
  } catch (e) {
    return { errorNote: `CloudWatch volume detection failed: ${(e as Error).message.slice(0, 200)}` };
  } finally {
    client.destroy();
  }
}

export const cloudwatchConnector: SiemConnector = {
  id: 'cloudwatch',
  displayName: 'Amazon CloudWatch Logs',
  discoverCredentials,
  pullEvents,
  detectDailyVolumeGb,
};
