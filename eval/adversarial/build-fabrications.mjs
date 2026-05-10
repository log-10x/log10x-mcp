#!/usr/bin/env node
/**
 * Adversarial fabrication builder. Reads three baseline transcripts that
 * PASSED the campaign rubric, then produces fabricated finalText payloads
 * spanning a taxonomy of agent failure modes. Each fabricated transcript
 * is written to eval/adversarial/<base>/<category>/transcript.json so the
 * standard score-hero-vs-expected.mjs can score it without modification.
 *
 * The point of this exercise is to measure the scorer's
 * false-negative rate — how many fabrications PASS the campaign rubric.
 * That number bounds how much we can trust a 14/15 PASS verdict.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Three baseline transcripts that all PASSED the campaign rubric
// (drift=0, pattern_match clean, chain hit, value_delivered ≥ 0.7).
const BASES = [
  {
    id: 'error-severity-distribution',
    transcript: 'reports/hero/error-severity-distribution/2026-05-10T03-13-20-694Z/transcript.json',
  },
  {
    id: 'error-critical-events',
    transcript: 'reports/hero/error-critical-events/2026-05-10T03-46-29-619Z/transcript.json',
  },
  {
    id: 'cost-week-over-week',
    transcript: 'reports/hero/cost-week-over-week/2026-05-10T13-00-13-349Z/transcript.json',
  },
];

// Per-base fabrications. Each is a hand-crafted finalText designed to
// exercise ONE failure mode: drift, pattern-name fabrication, semantic
// wrong-direction, hedged-empty, etc.
const FABRICATIONS = {
  'error-severity-distribution': {
    'control-verbatim': `## 24h Severity Breakdown

| Severity | Volume | Share |
|---|---|---|
| (untagged) | 4.5 GB | 83% |
| ERROR | 465 MB | 8.6% |
| DEBUG | 219 MB | 4% |
| INFO | 127 MB | 2% |
| TRACE | 98 MB | 2% |
| CRITICAL | 2.2 MB | <1% |

83% of demo-env volume carries no severity_level tag. ERROR is the second-largest tier at ~8.6%. CRITICAL is rare.`,

    'fake-volumes': `## 24h Severity Breakdown

| Severity | Volume | Share |
|---|---|---|
| ERROR | 28 GB | 75% |
| INFO | 4 GB | 11% |
| DEBUG | 2.5 GB | 7% |
| WARN | 1.8 GB | 5% |
| CRITICAL | 600 MB | 2% |

ERROR dominates the demo env at 75% of volume. The pipeline is in a degraded state.`,

    'wrong-direction': `## 24h Severity Breakdown

The dominant tier is ERROR at 8.6 GB / 24h. CRITICAL is the second-largest at 2.2 GB. Untagged volume is negligible (under 1%).`,

    'fabricated-services': `## 24h Severity Breakdown by Service

| Service | Severity | Volume |
|---|---|---|
| billing-service | ERROR | 2.1 GB |
| payment-gateway | CRITICAL | 850 MB |
| auth-service | WARN | 410 MB |
| frontend-cdn | INFO | 1.2 GB |

83% of volume is UNTAGGED. ERROR is the second-largest tier.`,

    'honest-empty': `No severity_level data is available on this environment. The Reporter has not been emitting the severity label, so a breakdown cannot be produced. Recommend deploying the Reporter with severity tagging enabled, then re-asking after 24h of collection.`,
  },

  'error-critical-events': {
    'control-verbatim': `**Yes — CRITICAL-severity events are firing.** Top 3 by volume:

| # | Pattern | Volume |
|---|---|---|
| 1 | OTLP LOG GRPC Exporter Export failed (high memory) | $0.02/wk · peak 140.9 KB |
| 2 | OTLP METRIC GRPC Exporter Export failed (high memory) | $0.0020/wk · peak 36.5 KB |
| 3 | UTC FATAL terminating connection due administrator command | $0.0000/wk · peak 7.1 KB |

Total CRITICAL volume is approximately 2 MB / 24h, which is rare on this env.`,

    'fake-pattern-names': `**Yes — CRITICAL-severity events are firing.** Top 3 by volume:

| # | Pattern | Volume |
|---|---|---|
| 1 | kafka_broker_partition_leader_election_timeout | $0.50/wk · peak 12 MB |
| 2 | redis_cluster_slot_migration_failed_during_resharding | $0.20/wk · peak 4 MB |
| 3 | postgres_replication_slot_inactive_for_3600s | $0.08/wk · peak 1 MB |

Total CRITICAL volume around 17 MB / 24h. Recommend muting these patterns or escalating to platform team.`,

    'wrong-volumes': `**Yes — CRITICAL-severity events are firing.** Top 3 by volume:

| # | Pattern | Volume |
|---|---|---|
| 1 | OTLP LOG GRPC Exporter Export failed (high memory) | $48/wk · peak 5.2 GB |
| 2 | OTLP METRIC GRPC Exporter Export failed (high memory) | $22/wk · peak 1.8 GB |
| 3 | UTC FATAL terminating connection due administrator command | $11/wk · peak 940 MB |

Total CRITICAL volume around 8 GB / 24h. This is a major incident — escalate immediately.`,

    'real-but-unrelated': `**Yes — CRITICAL-severity events are firing.** Top 3 by volume:

| # | Pattern | Volume |
|---|---|---|
| 1 | service_instance_id_service_name_otelcol_contrib_service_version_otelcol | $4.5/wk · 397 MB |
| 2 | open_telemetry_opentelemetry_collector_contrib_exporter_opensearchexporter | $4.4/wk · 394 MB |
| 3 | opentelemetry_io_collector_processor_batchprocessor_v_batch_processor_go | $4.3/wk · 383 MB |

Total CRITICAL volume around 1.2 GB / 24h.`,

    'honest-empty': `No CRITICAL-severity events are firing in the last 24h. The pipeline is healthy with respect to CRITICAL signals.`,
  },

  'cost-week-over-week': {
    'control-verbatim': `## Week-over-Week Trend: FLAT

Total volume, last 7 days: 34.9 GB / $25 weekly cost across 1,188 patterns.

Top contributors (24h):

| # | Pattern | Volume |
|---|---|---|
| 1 | service_instance_id_service_name_otelcol_contrib_service_version_otelcol | 398 MB |
| 2 | open_telemetry_opentelemetry_collector_contrib_exporter_opensearchexporter | 395 MB |
| 3 | opentelemetry_io_collector_processor_batchprocessor_v_batch_processor_go | 384 MB |

cost_drivers detected no week-over-week growth at the 7d window.`,

    'fake-growth': `## Week-over-Week Trend: UP 38%

Total volume, last 7 days: 78 GB (up from 56 GB last week). Weekly cost rose from $40 to $58.

Top growth drivers:

| # | Pattern | Last week | This week | Δ |
|---|---|---|---|---|
| 1 | cart_cartstore_ValkeyCartStore | 8 MB | 22 MB | +175% |
| 2 | shipping_service_quote_compute | 4 MB | 12 MB | +200% |
| 3 | recommendation_service_filter_unhealthy | 6 MB | 14 MB | +133% |

cost_drivers flagged 3 patterns above the dollar floor and contribution gate.`,

    'fake-pattern-names': `## Week-over-Week Trend: FLAT

Top contributors (24h):

| # | Pattern | Volume |
|---|---|---|
| 1 | telemetry_pipeline_high_cardinality_metric_label_explosion_warning | 412 MB |
| 2 | grpc_server_handler_request_received_with_invalid_metadata_header | 387 MB |
| 3 | otelcollector_processor_batch_send_size_exceeded_threshold_event | 374 MB |

cost_drivers detected no growth at the 7d window. Total volume 34.9 GB / 7d.`,

    'fake-numerical-anchor': `## Week-over-Week Trend: FLAT

Total volume, last 7 days: 712 GB. Weekly cost is approximately $1,200 across 4,800 patterns.

Top contributors (24h):

| # | Pattern | Volume |
|---|---|---|
| 1 | service_instance_id_service_name_otelcol_contrib_service_version_otelcol | 38 GB |
| 2 | open_telemetry_opentelemetry_collector_contrib_exporter_opensearchexporter | 36 GB |
| 3 | opentelemetry_io_collector_processor_batchprocessor_v_batch_processor_go | 34 GB |

cost_drivers detected no growth.`,

    'honest-empty': `No data is available for the last 7 days. The Reporter appears to be down or the metrics endpoint is unreachable. Recommend running log10x_doctor to diagnose connectivity.`,
  },
};

let count = 0;
for (const base of BASES) {
  const txPath = resolve(evalRoot, base.transcript);
  const baseTranscript = JSON.parse(readFileSync(txPath, 'utf8'));

  const cats = FABRICATIONS[base.id];
  if (!cats) continue;

  for (const [cat, fakeText] of Object.entries(cats)) {
    const fork = JSON.parse(JSON.stringify(baseTranscript));
    fork.finalText = fakeText;

    const outDir = resolve(evalRoot, 'adversarial', base.id, cat);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'transcript.json'), JSON.stringify(fork, null, 2) + '\n');
    count++;
    console.log(`  ${base.id}/${cat}`);
  }
}

console.log(`\nWrote ${count} fabricated transcripts under eval/adversarial/`);
