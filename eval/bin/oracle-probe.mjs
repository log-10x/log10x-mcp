#!/usr/bin/env node
/**
 * Smoke-test the Prometheus oracle against the configured eval env, AND
 * dump a full snapshot to eval/oracle/expected/<ts>.json for the
 * anti-hallucination campaign to consume.
 *
 * Usage:
 *   LOG10X_EVAL_ENV=demo node bin/oracle-probe.mjs              # print only
 *   LOG10X_EVAL_ENV=demo node bin/oracle-probe.mjs --snapshot   # also write JSON
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const oracle = await import(resolve(evalRoot, 'build-eval/prom-oracle.js'));

const writeSnapshot = process.argv.includes('--snapshot');

const env = loadEvalEnv();
console.error(`[oracle-probe] env=${env.mode} envId=${env.envId.slice(0, 8)}...`);

const snap = await oracle.fullSnapshot(env);

console.log('');
console.log(`Total volume (24h):       ${(snap.total_volume_24h_bytes / 1e9).toFixed(2)} GB`);
console.log(`Pattern cardinality:      ${snap.pattern_cardinality}`);
console.log(`Distinct services:        ${snap.service_split.length}  [${snap.service_split.slice(0, 5).map((s) => s.value).join(', ')}]`);
console.log(`Distinct namespaces:      ${snap.namespace_split.length}  [${snap.namespace_split.slice(0, 5).map((s) => s.value).join(', ')}]`);
console.log(`Reporter freshness (s):   edge=${snap.freshness_seconds.edge.toFixed(1)} cloud=${snap.freshness_seconds.cloud === Infinity ? 'never' : snap.freshness_seconds.cloud.toFixed(1)}`);
console.log('');
console.log('Top 5 patterns by 24h volume:');
for (const p of snap.top_patterns_24h.slice(0, 5)) {
  console.log(`  ${(p.bytes / 1e6).toFixed(1).padStart(8)} MB  ${(p.severity || '-').padEnd(6)} ${(p.service || '-').padEnd(8)} ${p.hash.slice(0, 80)}`);
}
console.log('');
console.log('Severity split:');
for (const s of snap.severity_split) {
  console.log(`  ${(s.bytes / 1e6).toFixed(1).padStart(8)} MB  ${s.severity}`);
}
console.log('');
console.log('Top 5 growth deltas (24h vs prior 24h):');
for (const g of snap.growth_deltas_24h) {
  console.log(`  +${(g.delta_bytes / 1e3).toFixed(1).padStart(8)} KB  ${g.hash.slice(0, 80)}`);
}
console.log('');
console.log(`Newly emerged (5m, silent at 1h offset): ${snap.newly_emerged_5m_vs_1h.length}`);
for (const e of snap.newly_emerged_5m_vs_1h) {
  console.log(`  ${e.rate_5m.toFixed(4)} ev/s  ${e.hash.slice(0, 80)}`);
}

if (writeSnapshot) {
  const ts = snap.taken_at.replace(/[:.]/g, '-');
  const outDir = join(evalRoot, 'oracle', 'expected');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${ts}.json`);
  writeFileSync(outPath, JSON.stringify(snap, null, 2) + '\n');
  // Also write a stable "latest.json" symlink-equivalent.
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(snap, null, 2) + '\n');
  console.log('');
  console.log(`[oracle-probe] snapshot written: ${outPath}`);
  console.log(`[oracle-probe] latest pointer:   ${join(outDir, 'latest.json')}`);
}
