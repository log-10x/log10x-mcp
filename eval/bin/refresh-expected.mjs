#!/usr/bin/env node
/**
 * Refresh the `expected_answer` block on every campaign hero spec
 * against the latest oracle snapshot.
 *
 * Reads:
 *   eval/oracle/expected/latest.json     (oracle snapshot)
 *   eval/fixtures/hero/<id>.json         (hero specs with category)
 *
 * Writes:
 *   eval/fixtures/hero/<id>.json         (in-place; expected_answer set)
 *
 * Usage:
 *   LOG10X_EVAL_ENV=demo node bin/refresh-expected.mjs            # take a fresh snapshot first
 *   LOG10X_EVAL_ENV=demo node bin/refresh-expected.mjs --stale    # use existing latest.json
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const oracle = await import(resolve(evalRoot, 'build-eval/prom-oracle.js'));
const expectedAnswer = await import(resolve(evalRoot, 'build-eval/expected-answer.js'));

const stale = process.argv.includes('--stale');

const env = loadEvalEnv();
const latestPath = join(evalRoot, 'oracle', 'expected', 'latest.json');

let snap;
if (stale && existsSync(latestPath)) {
  snap = JSON.parse(readFileSync(latestPath, 'utf8'));
  console.error(`[refresh-expected] using stale snapshot from ${snap.taken_at}`);
} else {
  console.error('[refresh-expected] taking fresh oracle snapshot...');
  snap = await oracle.fullSnapshot(env);
  writeFileSync(latestPath, JSON.stringify(snap, null, 2) + '\n');
  const tsPath = join(evalRoot, 'oracle', 'expected', `${snap.taken_at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(tsPath, JSON.stringify(snap, null, 2) + '\n');
  console.error(`[refresh-expected] snapshot taken ${snap.taken_at}`);
}

const fixturesDir = join(evalRoot, 'fixtures', 'hero');
const specs = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).map((f) => join(fixturesDir, f));

let updated = 0;
let skipped = 0;
for (const path of specs) {
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (!spec.category) {
    skipped++;
    continue;
  }
  const computed = expectedAnswer.computeExpectedAnswer(spec.id, snap);
  if (!computed) {
    console.error(`[refresh-expected] no computer for spec id=${spec.id}; skipping`);
    skipped++;
    continue;
  }
  spec.expected_answer = computed;
  writeFileSync(path, JSON.stringify(spec, null, 2) + '\n');
  updated++;
  console.error(`  ✓ ${spec.id}`);
}

console.error(`[refresh-expected] updated=${updated} skipped=${skipped}`);
