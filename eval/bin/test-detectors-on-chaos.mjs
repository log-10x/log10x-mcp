#!/usr/bin/env node
/**
 * Pull recent chaos events from CloudWatch (written by run-chaos-injector.mjs)
 * and run them through the 4 differentiated detector tools. This is the
 * integration test that exercises the templater + detector pipeline on real
 * pipeline data that DOES aggregate (chaos events are intentionally crafted
 * to share template structures within each scenario).
 *
 * Output to stdout: JSONL records of detector behavior on real chaos data.
 * Also appends to /tmp/autonomous-run-19ecafa/eval-results.jsonl with
 * fixture_id prefixed by "chaos-integration-".
 */
import cwlPkg from '/Users/talweiss/git/l1x-co/log10x-mcp/node_modules/@aws-sdk/client-cloudwatch-logs/dist-cjs/index.js';
import { appendFileSync } from 'node:fs';
const { CloudWatchLogsClient, FilterLogEventsCommand } = cwlPkg;
import { executeFindSkew } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/find-skew.js';
// find_constant_slots / find_uuid_in_body / find_incident_cluster removed
// pre-launch (2026-05-28). Their chaos scenarios still exist in the
// injector for reference but are no longer evaluated by any tool.

const RESULTS_PATH = process.env.EVAL_RESULTS_PATH ?? '/tmp/autonomous-run-19ecafa/eval-results.jsonl';
const LOG_GROUP = '/aws/eks/log10x-otel-demo/cluster';
const LOG_STREAM = process.env.CHAOS_LOG_STREAM ?? 'chaos-injector-overnight-2026-05-25';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const client = new CloudWatchLogsClient({ region: REGION });

// Pull last N minutes of chaos events grouped by scenario.
async function pullChaosEventsByScenario(minutesBack = 30) {
  const endTime = Date.now();
  const startTime = endTime - minutesBack * 60 * 1000;
  const byScenario = new Map();
  let nextToken;
  let total = 0;
  do {
    const resp = await client.send(new FilterLogEventsCommand({
      logGroupName: LOG_GROUP,
      logStreamNames: [LOG_STREAM],
      startTime,
      endTime,
      nextToken,
      limit: 1000,
    }));
    for (const ev of resp.events ?? []) {
      try {
        const parsed = JSON.parse(ev.message);
        if (!parsed.chaos) continue;
        const scenario = parsed.scenario;
        const arr = byScenario.get(scenario) ?? [];
        // Feed the inner message (the actual log content) to the templater,
        // not the envelope.
        arr.push(parsed.message);
        byScenario.set(scenario, arr);
        total++;
      } catch {
        // skip non-JSON
      }
    }
    nextToken = resp.nextToken;
    if (!nextToken) break;
  } while (total < 5000);
  return { byScenario, total };
}

async function testDetector(name, fn, events, opts = {}) {
  const started = Date.now();
  try {
    const out = await fn({ events, privacy_mode: true, min_events: 5, min_sample_count: 5, cardinality_ratio_threshold: 0.85, ...opts });
    const findingsCount = (out?.data?.findings ?? out?.data?.clusters ?? []).length;
    return {
      fixture_id: `chaos-integration-${name}`,
      tool: name,
      events_in: events.length,
      output_schema_valid: out?.schema_version === '1.0',
      output_findings_count: findingsCount,
      output_summary_headline: out?.summary?.headline,
      sample_finding: findingsCount > 0 ? (out.data.findings?.[0] ?? out.data.clusters?.[0]) : null,
      passed: findingsCount >= 1,
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    return {
      fixture_id: `chaos-integration-${name}`,
      tool: name,
      events_in: events.length,
      error: e.message,
      passed: false,
      duration_ms: Date.now() - started,
    };
  }
}

async function main() {
  console.error(`Pulling last 30min of chaos events from ${LOG_GROUP} / ${LOG_STREAM}...`);
  const { byScenario, total } = await pullChaosEventsByScenario(30);
  console.error(`Pulled ${total} chaos events across ${byScenario.size} scenarios:`);
  for (const [s, evs] of byScenario) {
    console.error(`  ${s}: ${evs.length} events`);
  }
  console.error('');

  const records = [];

  // skew-78 scenario should trigger find_skew (verb=get dominant).
  const skewEvents = byScenario.get('skew-78') ?? [];
  if (skewEvents.length >= 5) {
    const r = await testDetector('find_skew_on_chaos_skew_78', executeFindSkew, skewEvents, { min_concentration: 0.6 });
    records.push(r);
    console.log(JSON.stringify(r));
  } else {
    console.error(`skew-78 scenario only has ${skewEvents.length} events — need >= 5`);
  }

  // find_constant_slots / find_uuid_in_body / find_incident_cluster
  // were removed pre-launch. Their chaos scenarios are skipped here.

  for (const r of records) {
    appendFileSync(RESULTS_PATH, JSON.stringify(r) + '\n');
  }

  const passed = records.filter(r => r.passed).length;
  console.error(`\nSummary: ${passed}/${records.length} detector integration tests passed against real chaos data.`);
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
