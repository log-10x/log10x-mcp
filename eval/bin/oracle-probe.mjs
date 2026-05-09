#!/usr/bin/env node
/**
 * Smoke-test the Prometheus oracle against the configured eval env.
 * Prints what the env's Prometheus actually has — independent of MCP.
 *
 * Usage: LOG10X_EVAL_ENV=demo node bin/oracle-probe.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const oracle = await import(resolve(evalRoot, 'build-eval/prom-oracle.js'));

const env = loadEvalEnv();
console.log(`[oracle-probe] env=${env.mode} envId=${env.envId.slice(0, 8)}...`);

const [tot, services, card, top, ns] = await Promise.all([
  oracle.totalVolume(env, '24h'),
  oracle.services(env, '24h'),
  oracle.patternCardinality(env, '24h'),
  oracle.topPatterns(env, '24h', 5),
  oracle.topByLabel(env, 'k8s_namespace', '24h', 3),
]);

console.log('');
console.log(`Total volume (24h):       ${(tot / 1e9).toFixed(2)} GB`);
console.log(`Pattern cardinality:      ${card}`);
console.log(`Distinct services:        ${services.length}  [${services.slice(0, 5).join(', ')}${services.length > 5 ? ', ...' : ''}]`);
console.log('');
console.log('Top 5 patterns by 24h volume:');
for (const p of top) {
  console.log(`  ${(p.bytes / 1e6).toFixed(1).padStart(8)} MB  ${p.severity.padEnd(6)} ${p.service.padEnd(20)} ${p.hash.slice(0, 80)}`);
}
console.log('');
console.log('Top namespaces:');
for (const r of ns) {
  console.log(`  ${(r.bytes / 1e6).toFixed(1).padStart(8)} MB  ${r.value}`);
}
