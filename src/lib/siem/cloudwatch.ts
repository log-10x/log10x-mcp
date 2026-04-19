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
} from '@aws-sdk/client-cloudwatch-logs';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
} from './index.js';

import { shouldStop, sleep, retryWithBackoff, parseWindowMs } from './_retry.js';

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
  const endTime = Date.now();
  const startTime = endTime - windowMs;

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

  // Pull across log groups round-robin. AWS charges per-call, so we keep
  // the filter pattern specific and the page size at the upper bound (10,000).
  const filterPattern = opts.query || undefined;

  for (let gi = 0; gi < logGroups.length; gi++) {
    const logGroupName = logGroups[gi];
    let nextToken: string | undefined;
    let groupExhausted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (shouldStop(deadline, events.length, opts.targetEventCount)) {
        reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
        break;
      }
      try {
        const resp = await retryWithBackoff(() =>
          client.send(
            new FilterLogEventsCommand({
              logGroupName,
              startTime,
              endTime,
              filterPattern,
              limit: 10000,
              nextToken,
            })
          )
        );
        if (resp.events && resp.events.length > 0) {
          for (const ev of resp.events) events.push(ev);
        }
        nextToken = resp.nextToken;
        if (!nextToken) {
          groupExhausted = true;
          break;
        }
      } catch (e) {
        const msg = (e as Error).message || '';
        notes.push(`filter_error on ${logGroupName}: ${msg.slice(0, 200)}`);
        // Non-fatal per group — move on.
        groupExhausted = true;
        break;
      }
      opts.onProgress({
        step: `pulling from ${logGroupName} (${gi + 1}/${logGroups.length})`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
    }
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    if (gi === logGroups.length - 1 && groupExhausted) {
      reasonStopped = 'source_exhausted';
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

export const cloudwatchConnector: SiemConnector = {
  id: 'cloudwatch',
  displayName: 'Amazon CloudWatch Logs',
  discoverCredentials,
  pullEvents,
};
