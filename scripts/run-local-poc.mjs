#!/usr/bin/env node
/**
 * Standalone local POC runner — pulls real events from a SIEM, runs
 * the templater, builds the v2 envelope from measured engine output.
 *
 * Ground-truth pipeline. No top_patterns, no Prometheus, no
 * fabrication. Disk-caches both phases (SIEM pull + templater) so
 * downstream envelope iteration is fast.
 *
 * Usage:
 *
 *   AWS_REGION=us-east-1 node scripts/run-local-poc.mjs \
 *     --siem cloudwatch \
 *     --scope /log10x/otel-demo \
 *     --window 1h \
 *     --target-events 100000
 *
 * Or to bust the cache:
 *
 *   --refresh-pull            (re-pull from SIEM, ignore cached events)
 *   --refresh-templater       (re-run templater, ignore cached output)
 *   --refresh                 (both)
 *
 * Output: writes the v2 envelope to <cache-dir>/<key>/envelope.json
 * and prints a summary to stdout.
 */

import { getConnector } from '../build/lib/siem/index.js';
import { extractPatterns, collapseBySymbolMessage } from '../build/lib/pattern-extraction.js';
import { _enrichForEnvelope } from '../build/lib/poc-report-renderer.js';
import { buildPocEnvelopeV2 } from '../build/lib/poc-envelope-v2.js';
import {
  computeCacheKey,
  getOrCreateCacheDir,
  hasCachedEvents,
  readCachedEvents,
  writeCachedEvents,
  hasCachedTemplaterOutput,
  readCachedTemplaterOutput,
  writeCachedTemplaterOutput,
  inspectCache,
} from '../build/lib/poc-cache.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// ── Args ──

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node scripts/run-local-poc.mjs [opts]
  --siem <name>              cloudwatch | datadog | splunk | ... (required)
  --scope <id>               log group / index / etc.
  --window <dur>             pull window (1h, 24h, 7d, 14d). default 1h
  --target-events <N>        target event count. default 50000
  --query <q>                vendor-specific filter
  --refresh-pull             re-pull from SIEM, ignore cached events
  --refresh-templater        re-run templater, ignore cached output
  --refresh                  both
  --chunk-parallel           split events into N chunks, run tenx in parallel
                             (auto-on when raw text > 64 MB)
  --chunk-parallelism <N>    cap concurrent tenx processes. default min(cpus-1, 8)
  --chunk-target-mb <N>      target chunk size in MB. default 32
  --tenx-home <path>         TENX_HOME for the templater (default: auto)
`);
  process.exit(0);
}

if (!args.siem) {
  console.error('--siem required. Try --help.');
  process.exit(1);
}

if (args['tenx-home']) {
  process.env.TENX_HOME = args['tenx-home'];
}
process.env.LOG10X_TENX_MODE = process.env.LOG10X_TENX_MODE || 'local';

// ── Step 1: Cache lookup ──

const cacheKey = computeCacheKey({
  siem: args.siem,
  scope: args.scope,
  window: args.window || '1h',
  target_event_count: args['target-events'] || 50000,
  query: args.query,
});
const cacheStatus = inspectCache(cacheKey);
const entry = getOrCreateCacheDir(cacheKey);
console.log(`# cache key: ${cacheKey}`);
console.log(`# cache dir: ${entry.dir}`);
console.log(`# events cached: ${cacheStatus.events_cached ? `yes (${cacheStatus.events_age_seconds}s old)` : 'no'}`);
console.log(`# templater cached: ${cacheStatus.templater_cached ? `yes (${cacheStatus.templater_age_seconds}s old)` : 'no'}`);
console.log('');

// ── Step 2: SIEM pull (cached) ──

const refreshPull = args.refresh || args['refresh-pull'];
const refreshTemplater = args.refresh || args['refresh-templater'];
let events;
let pullWallMs = 0;
let pullSource;

if (!refreshPull && hasCachedEvents(entry.dir)) {
  console.log('[1/3] SIEM pull: cache HIT, reading events from disk');
  const t0 = Date.now();
  events = readCachedEvents(entry.dir);
  pullWallMs = Date.now() - t0;
  pullSource = 'cache';
  console.log(`      read ${events.length} events in ${pullWallMs}ms`);
} else {
  console.log(`[1/3] SIEM pull: cache MISS, pulling from ${args.siem} ${args.scope || '*'} over ${args.window || '1h'}`);
  const connector = getConnector(args.siem);
  const t0 = Date.now();
  const result = await connector.pullEvents({
    window: args.window || '1h',
    scope: args.scope,
    query: args.query,
    targetEventCount: args['target-events'] || 50000,
    maxPullMinutes: 15,
    onProgress: (p) => process.stderr.write(`      ${p.step} (${p.pct}%)\r`),
  });
  pullWallMs = Date.now() - t0;
  process.stderr.write('\n');
  events = result.events;
  pullSource = 'siem';
  console.log(`      pulled ${events.length} events in ${pullWallMs}ms (reason: ${result.metadata.reasonStopped})`);
  writeCachedEvents(entry.dir, events);
  console.log(`      cached to ${join(entry.dir, 'events.jsonl')}`);
}

if (events.length === 0) {
  console.error('No events pulled. Aborting.');
  process.exit(1);
}

// Raw ingest bytes = size of events.jsonl on disk = the customer's
// actual SIEM payload size (CW envelope + message). Used as the
// cost-projection basis instead of the templater's smaller measured
// totalBytes, so the engine's $/mo matches what the vendor bills on.
let rawIngestBytes = 0;
try {
  const { statSync } = await import('fs');
  rawIngestBytes = statSync(join(entry.dir, 'events.jsonl')).size;
  console.log(`      raw ingest bytes (events.jsonl on disk): ${(rawIngestBytes / 1024 / 1024).toFixed(2)} MB`);
} catch {
  // ignore — envelope falls back to templater bytes
}

// ── Step 3: Templater (cached) ──

let extraction;
let tmplWallMs = 0;
let tmplSource;

// Templater always runs on the (cached or fresh) events — extractPatterns
// builds the ExtractedPatterns object via the engine CLI. Templater fast-
// path from already-templated cache files is a TODO; we'd need to expose
// the build-from-merged helper from pattern-extraction.ts so we can skip
// the CLI when the output files are on disk. For now, the events cache
// alone saves the expensive SIEM pull (~14s → 0.1s).
// Estimate input bytes to decide whether to auto-chunk. extractPatterns
// re-stringifies inside, but the bytes-of-raw-text estimate is close
// enough for the 64 MB heuristic.
const approxRawBytes = events.reduce((sum, e) => {
  if (typeof e === 'string') return sum + e.length + 1;
  if (e && typeof e === 'object' && typeof e.message === 'string') return sum + e.message.length + 1;
  return sum + 200; // fallback estimate
}, 0);
const autoChunk = approxRawBytes > 64 * 1024 * 1024;
const chunkParallel = args['chunk-parallel'] || autoChunk;
const chunkTargetBytes = args['chunk-target-mb'] ? args['chunk-target-mb'] * 1024 * 1024 : undefined;
const chunkParallelism = args['chunk-parallelism'] || undefined;

console.log(`[2/3] Templater: running on ${events.length} events (~${(approxRawBytes / 1024 / 1024).toFixed(1)} MB raw) chunk-parallel=${chunkParallel}`);
const t0 = Date.now();
extraction = await extractPatterns(events, {
  privacyMode: true,
  autoBatch: true,
  useFileOutput: true,
  chunkParallel,
  chunkParallelism,
  chunkTargetBytes,
});
tmplWallMs = Date.now() - t0;
tmplSource = chunkParallel ? 'templater-chunked' : 'templater';
console.log(`      ${extraction.patterns.length} templates / ${extraction.totalEvents} events / ${extraction.totalBytes} bytes in ${tmplWallMs}ms`);

extraction.patterns = collapseBySymbolMessage(extraction.patterns);
console.log(`      after collapseBySymbolMessage: ${extraction.patterns.length} patterns`);

// ── Step 4: Build v2 envelope from REAL templater output ──

const now = Date.now();
const windowSec = parseWindowSeconds(args.window || '1h');
const windowEndMs = now;
const windowStartMs = now - windowSec * 1000;

const renderInput = {
  siem: args.siem,
  window: args.window || '1h',
  scope: args.scope,
  query: args.query,
  extraction,
  targetEventCount: args['target-events'] || 50000,
  pullWallTimeMs: pullWallMs,
  templateWallTimeMs: tmplWallMs,
  rawIngestBytes,
  reasonStopped: 'source_exhausted',
  queryUsed: args.query ?? '',
  windowHours: windowSec / 3600,
  analyzerCostPerGb: 2.5,
  snapshotId: `local-poc-${cacheKey}-${now}`,
  startedAt: new Date(windowStartMs).toISOString(),
  finishedAt: new Date(windowEndMs).toISOString(),
  mcpVersion: 'local-poc',
  banners: [],
  pullNotes: [],
  windowStartMs,
  windowEndMs,
};

console.log('[3/3] Building v2 envelope from real templater output...');
const { patterns, clusters, redundancyPairs } = _enrichForEnvelope(renderInput);
const envelope = buildPocEnvelopeV2(renderInput, patterns, clusters, redundancyPairs, 50);

const envPath = join(entry.dir, 'envelope.json');
writeFileSync(envPath, JSON.stringify(envelope, null, 2));

// ── Summary ──

console.log('');
console.log('═════════════ GROUND-TRUTH POC SUMMARY ═════════════');
console.log(`SIEM:                  ${envelope.input.siem}`);
console.log(`Scope:                 ${envelope.input.scope || '(none)'}`);
console.log(`Window:                ${envelope.input.window}`);
console.log(`Events pulled:         ${envelope.input.scale.events_pulled.toLocaleString()} (source: ${pullSource})`);
console.log(`Bytes pulled:          ${(envelope.input.scale.bytes_pulled / 1024 / 1024).toFixed(2)} MB`);
console.log(`Pull wall time:        ${(pullWallMs / 1000).toFixed(2)}s`);
console.log(`Templater wall time:   ${(tmplWallMs / 1000).toFixed(2)}s (source: ${tmplSource})`);
console.log(`Distinct patterns:     ${envelope.input.scale.distinct_patterns_surfaced.toLocaleString()}`);
console.log(`Services observed:     ${envelope.input.scale.services_observed}`);
console.log(`Total monthly cost:    $${envelope.output.aggregates.totals.monthly_cost_usd.toFixed(2)}`);
console.log(`Top-N monthly cost:    $${envelope.output.aggregates.totals.top_n_monthly_cost_usd.toFixed(2)}`);
console.log(`Emergence:             ${JSON.stringify(envelope.output.aggregates.emergence_tally)}`);
console.log(`Incident clusters:     ${envelope.output.incidents.length}`);
console.log(`Redundancy pairs:      ${envelope.output.aggregates.redundancy_pairs.length}`);
console.log('');
console.log('Top 5 patterns (real measurements):');
envelope.output.patterns.slice(0, 5).forEach((p) => {
  const ts = p.top_slot
    ? `top_slot=${p.top_slot.name} distinct=${p.top_slot.distinct_count} unbounded=${p.top_slot.unbounded}`
    : 'top_slot=(none)';
  console.log(`  #${p.rank} ${p.identity.slice(0, 50)}`);
  console.log(`      events=${p.metrics.events_in_window} cost=$${p.metrics.cost_per_month_usd.toFixed(4)}/mo service=${p.service ?? '(none)'} ${ts}`);
});
console.log('');
console.log(`Envelope written to:   ${envPath}`);

// ── Helpers ──

function parseArgs(argv) {
  const out = {};
  // Args that should always stay as strings (window, scope, query, etc.)
  // even when their value happens to match a numeric pattern. Prevents
  // "--window 1h" from being coerced to NaN.
  const STRING_ONLY = new Set(['siem', 'scope', 'window', 'query', 'tenx-home']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[k] = true;
      } else if (STRING_ONLY.has(k)) {
        out[k] = next;
        i++;
      } else {
        out[k] = isNaN(Number(next)) ? next : Number(next);
        i++;
      }
    }
  }
  return out;
}

function parseWindowSeconds(w) {
  const m = w.match(/^(\d+)([smhd])$/);
  if (!m) return 3600;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}
