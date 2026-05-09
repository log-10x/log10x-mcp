#!/usr/bin/env node
/**
 * Compare two report directories — typically a baseline (committed under
 * eval/baselines/<sha>/) vs the latest reports/ directory. Exits non-zero
 * if any scenario regresses, so CI can gate on the diff.
 *
 * Usage:
 *   node bin/diff-runs.mjs <baseline-dir> <current-dir>
 *
 * Both dirs are expected to contain <scenario-id>/<timestamp>/verdict.json
 * paths. The script picks the LATEST timestamp under each scenario when
 * multiple exist (matching how reports/ accumulates over time).
 *
 * Regression definition:
 *   - passedCriteria flipped from true → false
 *   - reasoning, value, or autonomy dropped by > 0.1
 *   - hallucination grew by > 0.1
 *   - new ground-truth assertion failed
 *
 * upstream_rate_limit flagged runs are excluded (transient infra).
 */
import { resolve, join } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const [, , baselineArg, currentArg] = process.argv;
if (!baselineArg || !currentArg) {
  console.error('Usage: diff-runs.mjs <baseline-dir> <current-dir>');
  process.exit(2);
}
const baselineDir = resolve(baselineArg);
const currentDir = resolve(currentArg);

function loadLatest(rootDir) {
  const out = {};
  let scenarios = [];
  try {
    scenarios = readdirSync(rootDir);
  } catch (e) {
    console.error(`Cannot read ${rootDir}: ${e.message}`);
    process.exit(2);
  }
  for (const sid of scenarios) {
    const sdir = join(rootDir, sid);
    let stat;
    try {
      stat = statSync(sdir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const tsDirs = readdirSync(sdir).filter((t) => statSync(join(sdir, t)).isDirectory());
    if (tsDirs.length === 0) continue;
    tsDirs.sort();
    const latest = tsDirs[tsDirs.length - 1];
    const verdictPath = join(sdir, latest, 'verdict.json');
    try {
      out[sid] = JSON.parse(readFileSync(verdictPath, 'utf8'));
    } catch (e) {
      console.error(`[skip] ${sid}/${latest}: ${e.message}`);
    }
  }
  return out;
}

const baseline = loadLatest(baselineDir);
const current = loadLatest(currentDir);

const allIds = new Set([...Object.keys(baseline), ...Object.keys(current)]);
const regressions = [];
const improvements = [];

for (const id of [...allIds].sort()) {
  const b = baseline[id];
  const c = current[id];
  if (!b) {
    if (c?.passedCriteria) improvements.push({ id, kind: 'new-pass' });
    else regressions.push({ id, kind: 'new-fail', detail: 'new scenario; not passing' });
    continue;
  }
  if (!c) {
    regressions.push({ id, kind: 'missing', detail: 'scenario absent from current run' });
    continue;
  }

  const skipForRateLimit =
    (c.flags || []).includes('upstream_rate_limit') ||
    (b.flags || []).includes('upstream_rate_limit');
  if (skipForRateLimit) {
    console.error(`[skip] ${id} — upstream_rate_limit flagged`);
    continue;
  }

  if (b.passedCriteria && !c.passedCriteria) {
    regressions.push({ id, kind: 'pass→fail', detail: `outcome=${c.outcome}` });
  } else if (!b.passedCriteria && c.passedCriteria) {
    improvements.push({ id, kind: 'fail→pass' });
  }

  for (const k of ['reasoning', 'value', 'autonomy']) {
    const delta = (c.scores?.[k] ?? 0) - (b.scores?.[k] ?? 0);
    if (delta < -0.1) {
      regressions.push({ id, kind: `${k}-drop`, detail: `${b.scores[k].toFixed(2)} → ${c.scores[k].toFixed(2)}` });
    }
  }
  const hDelta = (c.scores?.hallucination ?? 0) - (b.scores?.hallucination ?? 0);
  if (hDelta > 0.1) {
    regressions.push({ id, kind: 'hallucination-grew', detail: `${b.scores.hallucination.toFixed(2)} → ${c.scores.hallucination.toFixed(2)}` });
  }

  const bGTFails = (b.groundTruth || []).filter((g) => !g.passed).map((g) => g.description);
  const cGTFails = (c.groundTruth || []).filter((g) => !g.passed).map((g) => g.description);
  for (const fail of cGTFails) {
    if (!bGTFails.includes(fail)) {
      regressions.push({ id, kind: 'new-gt-fail', detail: fail });
    }
  }
}

console.log(`# Diff: ${baselineDir} → ${currentDir}`);
console.log('');
console.log(`Regressions: ${regressions.length}`);
for (const r of regressions) console.log(`  - [${r.id}] ${r.kind}${r.detail ? ` — ${r.detail}` : ''}`);
console.log('');
console.log(`Improvements: ${improvements.length}`);
for (const r of improvements) console.log(`  + [${r.id}] ${r.kind}`);

process.exit(regressions.length > 0 ? 1 : 0);
