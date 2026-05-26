#!/usr/bin/env node
/**
 * Chaos injector — ships synthetic events to the otel-demo CloudWatch log group
 * to exercise the find_* detectors against real pipeline data.
 *
 * Usage:
 *   node eval/bin/run-chaos-injector.mjs \
 *     --log-group /aws/eks/log10x-otel-demo/cluster \
 *     --log-stream chaos-injector-2026-05-25 \
 *     --scenarios incident-cluster,skew-78,uuid-in-body,constant-slot \
 *     --minutes-per 10 \
 *     --total-minutes 480 \
 *     --rate-per-sec 5 \
 *     --timeline /tmp/autonomous-run-19ecafa/chaos-timeline.jsonl
 *
 * Default: rotates through all built-in scenarios, 10 min each, ~5 events/sec,
 * runs for total-minutes or until SIGTERM. Rate-capped at 100 events/sec hard.
 *
 * Cost guard: at 5 events/sec across an 8h overnight run, that's 144K events
 * × ~500 bytes = ~72 MB. CloudWatch PutLogEvents is metered at $0.50/GB —
 * about $0.04 for the night. Well under the $80 cap.
 */

import cwlPkg from '/Users/talweiss/git/l1x-co/log10x-mcp/node_modules/@aws-sdk/client-cloudwatch-logs/dist-cjs/index.js';
const { CloudWatchLogsClient, PutLogEventsCommand, CreateLogStreamCommand, DescribeLogStreamsCommand } = cwlPkg;
import { writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ── CLI args ────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const LOG_GROUP = args['log-group'] ?? '/aws/eks/log10x-otel-demo/cluster';
const LOG_STREAM = args['log-stream'] ?? `chaos-injector-${new Date().toISOString().slice(0, 10)}`;
const SCENARIOS = (args['scenarios'] ?? 'incident-cluster,skew-78,uuid-in-body,constant-slot,dns-failure').split(',').filter(Boolean);
const MINUTES_PER = Number(args['minutes-per'] ?? '10');
const TOTAL_MINUTES = Number(args['total-minutes'] ?? '480');
const RATE_PER_SEC = Math.min(100, Number(args['rate-per-sec'] ?? '5'));
const TIMELINE = args['timeline'] ?? `/tmp/chaos-timeline-${Date.now()}.jsonl`;
const REGION = args['region'] ?? process.env.AWS_REGION ?? 'us-east-1';

// ── Scenarios ───────────────────────────────────────────────────────────
const scenarios = {
  // Three patterns sharing root cause "dial tcp lookup opensearch failed".
  // find_incident_cluster should detect them as one cluster.
  'incident-cluster': () => [
    { msg: 'dial tcp lookup opensearch failed: no such host (chaos-' + randomUUID() + ')', service: 'opentelemetry-collector', level: 'ERROR' },
    { msg: 'flush dial tcp lookup opensearch retry exhausted after 3 attempts', service: 'opentelemetry-collector', level: 'ERROR' },
    { msg: 'queue worker dial tcp lookup opensearch error giving up', service: 'opentelemetry-collector', level: 'ERROR' },
  ],
  // High-skew slot: same template structure across events, but one SLOT
  // value dominates at 78%. Variation in the dominant slot must be in a
  // value the templater extracts as a slot, NOT in the template path.
  // We use http_status as the dominant slot: every event is `audit
  // verb=GET status=$ duration=$ uri=$` with status=200 (78%) or
  // status=404 (22%). The verb stays constant so it doesn't fork the
  // symbolMessage; status varies into a slot value the templater
  // captures.
  'skew-78': () => {
    const isOk = Math.random() < 0.78;
    return [{
      msg: `audit verb=GET status=${isOk ? '200' : '404'} duration=${Math.floor(Math.random() * 500)}ms uri=/api/v1/nodes/eks-master`,
      service: 'kube-apiserver-audit',
      level: 'INFO',
    }];
  },
  // UUID-in-body anti-pattern: every event has a unique auditID UUID.
  // find_uuid_in_body should detect auditID slot as uuid-shaped with ~100% cardinality.
  'uuid-in-body': () => [{
    msg: `{"auditID":"${randomUUID()}","level":"Metadata","verb":"get","stage":"ResponseComplete","apiVersion":"audit.k8s.io/v1"}`,
    service: 'kube-apiserver-audit',
    level: 'INFO',
  }],
  // Constant slot: apiVersion is always "audit.k8s.io/v1", kind is always "Event".
  // find_constant_slots should detect both.
  'constant-slot': () => [{
    msg: `{"apiVersion":"audit.k8s.io/v1","kind":"Event","level":"RequestResponse","userID":"${randomUUID().slice(0, 8)}","verb":"watch","stage":"ResponseComplete"}`,
    service: 'kube-apiserver-audit',
    level: 'INFO',
  }],
  // The classic DNS-failure incident: composite of incident-cluster + other diagnostic events.
  'dns-failure': () => {
    const id = randomUUID().slice(0, 8);
    return [
      { msg: `dial tcp: lookup opensearch on 172.20.0.10:53: no such host (req=${id})`, service: 'opentelemetry-collector', level: 'ERROR' },
      { msg: `Resolver retry timeout for opensearch: queue=${id} attempt=3`, service: 'opentelemetry-collector', level: 'WARN' },
      { msg: `Flush failed: not retryable error: Permanent error: dial tcp lookup opensearch (queue=${id})`, service: 'opentelemetry-collector', level: 'ERROR' },
    ];
  },
};

// ── Main loop ───────────────────────────────────────────────────────────
const client = new CloudWatchLogsClient({ region: REGION });

async function ensureLogStream() {
  try {
    const existing = await client.send(new DescribeLogStreamsCommand({
      logGroupName: LOG_GROUP,
      logStreamNamePrefix: LOG_STREAM,
    }));
    if (existing.logStreams?.some(s => s.logStreamName === LOG_STREAM)) {
      return existing.logStreams.find(s => s.logStreamName === LOG_STREAM).uploadSequenceToken;
    }
    await client.send(new CreateLogStreamCommand({ logGroupName: LOG_GROUP, logStreamName: LOG_STREAM }));
    return undefined; // new stream has no token
  } catch (e) {
    console.error(`Failed to ensure log stream: ${e.message}`);
    throw e;
  }
}

function logTimeline(entry) {
  appendFileSync(TIMELINE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      out[key] = val;
      if (val !== 'true') i++;
    }
  }
  return out;
}

async function pushBatch(events, sequenceToken) {
  const cmd = new PutLogEventsCommand({
    logGroupName: LOG_GROUP,
    logStreamName: LOG_STREAM,
    logEvents: events.map(e => ({
      timestamp: Date.now(),
      message: JSON.stringify({
        chaos: true,
        scenario: e.scenario,
        service: e.service,
        level: e.level,
        message: e.msg,
      }),
    })),
    sequenceToken,
  });
  const resp = await client.send(cmd);
  return resp.nextSequenceToken;
}

async function main() {
  writeFileSync(TIMELINE, ''); // truncate
  console.error(`[chaos] Starting injector. Log group: ${LOG_GROUP}, stream: ${LOG_STREAM}`);
  console.error(`[chaos] Scenarios: ${SCENARIOS.join(', ')}, rotation: ${MINUTES_PER}min, total: ${TOTAL_MINUTES}min, rate: ${RATE_PER_SEC}/sec`);
  console.error(`[chaos] Timeline: ${TIMELINE}`);

  let sequenceToken = await ensureLogStream();
  logTimeline({ event: 'start', logGroup: LOG_GROUP, logStream: LOG_STREAM, scenarios: SCENARIOS, ratePerSec: RATE_PER_SEC });

  const totalEndAt = Date.now() + TOTAL_MINUTES * 60 * 1000;
  let scenarioIdx = 0;
  let stopRequested = false;
  process.on('SIGTERM', () => { stopRequested = true; console.error('[chaos] SIGTERM received, finishing current batch'); });
  process.on('SIGINT', () => { stopRequested = true; console.error('[chaos] SIGINT received, finishing current batch'); });

  while (!stopRequested && Date.now() < totalEndAt) {
    const scenario = SCENARIOS[scenarioIdx % SCENARIOS.length];
    const scenarioEndAt = Date.now() + MINUTES_PER * 60 * 1000;
    logTimeline({ event: 'scenario_start', scenario });
    console.error(`[chaos] [${new Date().toISOString()}] scenario=${scenario} for ${MINUTES_PER}min`);

    let eventsThisScenario = 0;
    while (!stopRequested && Date.now() < scenarioEndAt && Date.now() < totalEndAt) {
      // Build a batch up to RATE_PER_SEC events.
      const generator = scenarios[scenario];
      if (!generator) {
        console.error(`[chaos] Unknown scenario: ${scenario}, skipping`);
        break;
      }
      const batch = [];
      for (let i = 0; i < RATE_PER_SEC && batch.length < 100; i++) {
        const events = generator();
        for (const e of events) batch.push({ ...e, scenario });
      }
      try {
        sequenceToken = await pushBatch(batch, sequenceToken);
        eventsThisScenario += batch.length;
      } catch (e) {
        // Sequence token mismatch is recoverable: re-fetch and retry once.
        if (/InvalidSequenceTokenException|DataAlreadyAcceptedException/.test(e.message)) {
          sequenceToken = await ensureLogStream();
          try {
            sequenceToken = await pushBatch(batch, sequenceToken);
            eventsThisScenario += batch.length;
          } catch (retryErr) {
            logTimeline({ event: 'push_error', scenario, error: retryErr.message });
            console.error(`[chaos] push retry failed: ${retryErr.message}`);
          }
        } else {
          logTimeline({ event: 'push_error', scenario, error: e.message });
          console.error(`[chaos] push failed: ${e.message}`);
        }
      }
      // Pause 1 sec between batches.
      await new Promise(r => setTimeout(r, 1000));
    }
    logTimeline({ event: 'scenario_end', scenario, eventsPushed: eventsThisScenario });
    console.error(`[chaos] scenario ${scenario} ended, pushed ${eventsThisScenario} events`);
    scenarioIdx++;
  }

  logTimeline({ event: 'stop' });
  console.error('[chaos] Stopped.');
}

main().catch(e => {
  console.error(`[chaos] Fatal: ${e.message}`);
  logTimeline({ event: 'fatal', error: e.message });
  process.exit(1);
});
