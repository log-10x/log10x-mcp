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
  try {
    if (!scope) {
      throw new Error(
        'CloudWatch scope is required — pass `scope` as a log group name (`/aws/ecs/my-svc`) or a prefix wildcard (`/aws/ecs/*`).'
      );
    }
    if (scope.includes('*')) {
      const prefix = scope.replace(/\*+$/, '').replace(/\*/g, '');
      let nextToken: string | undefined;
      do {
        const resp = await retryWithBackoff(() =>
          client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken, limit: 50 }))
        );
        for (const g of resp.logGroups || []) {
          if (g.logGroupName) logGroups.push(g.logGroupName);
        }
        nextToken = resp.nextToken;
        if (shouldStop(deadline, events.length, opts.targetEventCount)) break;
      } while (nextToken && logGroups.length < 200);
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
  const BUCKET_COUNT = 24;
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
                limit: 10000,
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
 * Detect CloudWatch daily ingest volume.
 *
 * Approach: DescribeLogGroups returns `storedBytes` per log group (total
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
    let weightedRetentionDays = 0;
    let neverExpireCount = 0;
    let weightedCount = 0;
    for (const g of groups) {
      const bytes = g.storedBytes ?? 0;
      if (bytes <= 0) continue;
      totalBytes += bytes;
      const retention = g.retentionInDays;
      if (retention && retention > 0) {
        weightedRetentionDays += retention * bytes;
        weightedCount += bytes;
      } else {
        neverExpireCount++;
      }
    }
    if (totalBytes === 0) {
      return { errorNote: 'CloudWatch: matching log groups have 0 storedBytes (cold / empty)' };
    }
    // Effective retention: bytes-weighted average across groups WITH
    // retention set. Groups with NEVER_EXPIRE get a 30-day-floor default
    // so we don't divide by infinity — callers see the disclaimer.
    const effectiveRetention =
      weightedCount > 0 ? weightedRetentionDays / weightedCount : 30;
    const days = Math.max(1, Math.min(365, effectiveRetention));
    const dailyGb = totalBytes / (1024 ** 3) / days;
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
      source: `CloudWatch DescribeLogGroups (${groups.length} group${groups.length === 1 ? '' : 's'}, ~${Math.round(days)}d retention)${neverExpireNote}`,
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
