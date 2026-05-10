#!/usr/bin/env node
/**
 * Mutation testing driver.
 *
 * For each mutation in src/mutator.ts:
 *   1. Snapshot the targeted source file.
 *   2. Apply the mutation (string find-and-replace).
 *   3. Rebuild eval (tsc).
 *   4. Run the shape suite (bin/run-shapes.mjs); capture coverage / classification diff.
 *   5. Restore the source.
 *   6. Tag mutation as `killed-by: <shape>...` (the matched_count dropped) or `survived` (no diff).
 *
 * A surviving mutation = dead defense; record in
 * eval/audits/dead-defense-<date>.md for follow-up.
 *
 * Usage:
 *   LOG10X_EVAL_ENV=demo node eval/bin/mutation-test.mjs [--quick]
 *
 * --quick limits to the first 5 mutations for fast smoke; default runs all.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { MUTATIONS } = await import(resolve(evalRoot, 'build-eval/mutator.js'));

const opts = { quick: false };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--quick') opts.quick = true;
}

const mutations = opts.quick ? MUTATIONS.slice(0, 5) : MUTATIONS;

// Baseline: run shapes once with no mutation.
console.error(`[mutation] establishing baseline...`);
const baseline = runShapeSuite();
console.error(
  `[mutation] baseline correctly_classified=${baseline.correctlyClassified}/${baseline.totalFabrications}, coverage=${baseline.coverageScore.toFixed(3)}`
);

const results = [];
for (const mut of mutations) {
  const srcPath = resolve(evalRoot, mut.file);
  if (!existsSync(srcPath)) {
    console.error(`[mutation] SKIP missing file: ${srcPath}`);
    continue;
  }
  const backup = readFileSync(srcPath, 'utf8');
  let mutated;
  if (typeof mut.find === 'string') {
    if (!backup.includes(mut.find)) {
      console.error(`[mutation] SKIP ${mut.id}: anchor not found in ${mut.file}`);
      results.push({ ...mut, status: 'anchor_missing' });
      continue;
    }
    mutated = backup.replace(mut.find, mut.replace);
  } else {
    if (!mut.find.test(backup)) {
      console.error(`[mutation] SKIP ${mut.id}: regex anchor not found`);
      results.push({ ...mut, status: 'anchor_missing' });
      continue;
    }
    mutated = backup.replace(mut.find, mut.replace);
  }

  writeFileSync(srcPath, mutated);
  console.error(`[mutation] applied ${mut.id} → ${mut.file}`);

  // Rebuild eval (tsc) so the change is reflected in build-eval/.
  const build = spawnSync('npm', ['run', 'build'], { cwd: evalRoot, encoding: 'utf8' });
  if (build.status !== 0) {
    console.error(`[mutation] BUILD FAILED for ${mut.id} — likely a syntax-breaking mutation`);
    writeFileSync(srcPath, backup);
    results.push({ ...mut, status: 'build_failed', stderr: build.stderr.slice(0, 200) });
    continue;
  }

  // Run shapes suite.
  let after;
  try {
    after = runShapeSuite();
  } catch (e) {
    console.error(`[mutation] shape suite errored: ${e}`);
    after = null;
  }

  // Restore source.
  writeFileSync(srcPath, backup);

  if (!after) {
    results.push({ ...mut, status: 'suite_errored' });
    continue;
  }

  // Mutation killed if classification flipped on at least one fabrication.
  const killedFabs = diffFabrications(baseline.perFabrication, after.perFabrication);
  results.push({
    ...mut,
    status: killedFabs.length > 0 ? 'killed' : 'survived',
    killed_by: killedFabs,
    baseline_correct: baseline.correctlyClassified,
    after_correct: after.correctlyClassified,
  });
  console.error(
    `[mutation] ${mut.id} → ${killedFabs.length > 0 ? 'killed' : 'survived'} (correct: ${baseline.correctlyClassified} → ${after.correctlyClassified})`
  );
}

// Final rebuild after all mutations restored.
spawnSync('npm', ['run', 'build'], { cwd: evalRoot });

// Write the audit doc.
const audit = renderAudit(results, baseline, mutations.length);
const auditDir = resolve(evalRoot, 'audits');
mkdirSync(auditDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const auditPath = resolve(auditDir, `dead-defense-${today}.md`);
writeFileSync(auditPath, audit);
console.error(`[mutation] wrote ${auditPath}`);

const survived = results.filter((r) => r.status === 'survived');
const killed = results.filter((r) => r.status === 'killed');
console.error(`[mutation] summary: ${killed.length} killed, ${survived.length} survived, ${results.length - killed.length - survived.length} skipped/errored`);
process.exit(survived.length > 0 ? 1 : 0);

// ─── helpers ────────────────────────────────────────────────────────

function runShapeSuite() {
  const r = spawnSync('node', [resolve(evalRoot, 'bin/run-shapes.mjs')], {
    cwd: evalRoot,
    encoding: 'utf8',
    env: { ...process.env, LOG10X_EVAL_ENV: process.env.LOG10X_EVAL_ENV ?? 'demo' },
  });
  if (r.status !== 0) {
    // Continue — we want the result even if coverage gate fails.
  }
  // Parse COVERAGE.md to recover per-fabrication classification.
  const md = readFileSync(resolve(evalRoot, 'shapes/COVERAGE.md'), 'utf8');
  const perFabrication = {};
  let correct = 0;
  let total = 0;
  let coverageScore = 0;
  const covMatch = md.match(/Coverage score\*\*:\s*(\d+(\.\d+)?)%/);
  if (covMatch) coverageScore = parseFloat(covMatch[1]) / 100;
  const classifyMatch = md.match(/Correctly classified\*\*:\s*(\d+)\s*\/\s*(\d+)/);
  if (classifyMatch) {
    correct = parseInt(classifyMatch[1], 10);
    total = parseInt(classifyMatch[2], 10);
  }
  // Per-fabrication rows: lines starting with `| \`shape\` | \`fab\` | ... | ✓ or ✗ |`
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*\w+\s*\|\s*\w+\s*\|\s*(✓|✗)\s*\|/);
    if (m) {
      perFabrication[`${m[1]}/${m[2]}`] = m[3] === '✓';
    }
  }
  return { correctlyClassified: correct, totalFabrications: total, coverageScore, perFabrication };
}

function diffFabrications(baseline, after) {
  const flipped = [];
  for (const key of Object.keys(baseline)) {
    if (after[key] !== undefined && baseline[key] !== after[key]) {
      flipped.push(key);
    }
  }
  return flipped;
}

function renderAudit(results, baseline, total) {
  const survived = results.filter((r) => r.status === 'survived');
  const killed = results.filter((r) => r.status === 'killed');
  const skipped = results.filter((r) => !['survived', 'killed'].includes(r.status));

  const lines = [];
  lines.push('# Mutation testing audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- **Baseline** correctly_classified: ${baseline.correctlyClassified} / ${baseline.totalFabrications}`);
  lines.push(`- **Mutations tested**: ${total}`);
  lines.push(`- **Killed** (at least one shape test caught the mutation): ${killed.length}`);
  lines.push(`- **Survived** (mutation passed through unnoticed = dead defense): ${survived.length}`);
  lines.push(`- **Skipped / errored**: ${skipped.length}`);
  lines.push('');

  if (survived.length > 0) {
    lines.push('## Survived (dead defense candidates)');
    lines.push('');
    lines.push('Each entry represents a scorer change that did NOT trip any existing test.');
    lines.push('Either the code path is unreachable in practice (delete it), or it lacks a test (add one).');
    lines.push('');
    for (const r of survived) {
      lines.push(`### \`${r.id}\``);
      lines.push(`- **File**: \`${r.file}\``);
      lines.push(`- **Mutation**: ${r.description}`);
      lines.push('- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)');
      lines.push('');
    }
  }

  if (killed.length > 0) {
    lines.push('## Killed (live defenses)');
    lines.push('');
    lines.push('| Mutation | File | Fabrications that flipped |');
    lines.push('|---|---|---|');
    for (const r of killed) {
      lines.push(`| \`${r.id}\` | \`${r.file}\` | ${(r.killed_by ?? []).map((k) => `\`${k}\``).join(', ')} |`);
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## Skipped / errored');
    lines.push('');
    for (const r of skipped) {
      lines.push(`- \`${r.id}\` (${r.status}): ${r.stderr ?? r.description}`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}
