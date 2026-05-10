#!/usr/bin/env node
/**
 * Top-level campaign orchestrator. Drives the iteration loop:
 *
 *   1. Refresh oracle snapshot (or use --stale).
 *   2. Refresh expected_answer on every campaign hero spec.
 *   3. Run hero scenarios via run-hero.mjs.
 *   4. Score each transcript via score-hero-vs-expected.mjs.
 *   5. Emit CAMPAIGN-PROOF.md + per-question summary.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs --filter cost
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs --only cost-top-by-volume
 *   LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs --score-only      # re-score saved transcripts, no agent runs
 *   LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs --stale --score-only
 */
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(evalRoot, 'fixtures', 'hero');

function parseArgs(argv) {
  const out = { filter: null, only: null, scoreOnly: false, stale: false, skipRefresh: false, minPass: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') out.filter = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--score-only') out.scoreOnly = true;
    else if (a === '--stale') out.stale = true;
    else if (a === '--skip-refresh') out.skipRefresh = true;
    else if (a === '--min-pass') out.minPass = parseInt(argv[++i], 10);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);

// ── 1+2. Refresh snapshot + expected_answers (unless skipped) ───────
if (!opts.skipRefresh && !opts.scoreOnly) {
  const refreshArgs = ['bin/refresh-expected.mjs'];
  if (opts.stale) refreshArgs.push('--stale');
  console.error(`[campaign] refresh-expected ${opts.stale ? '--stale' : '(fresh snapshot)'}`);
  const r = spawnSync('node', refreshArgs, { cwd: evalRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[campaign] refresh-expected failed; aborting');
    process.exit(2);
  }
}

// ── 3. Pick the campaign specs (cost / error-levels / stability) ────
const specs = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f, full: join(fixturesDir, f) }))
  .filter(({ full }) => {
    const s = JSON.parse(readFileSync(full, 'utf8'));
    if (!s.category) return false;
    if (opts.only && s.id !== opts.only) return false;
    if (opts.filter && s.category !== opts.filter && !s.id.includes(opts.filter)) return false;
    return true;
  });

console.error(`[campaign] running ${specs.length} hero scenarios (mode=${opts.scoreOnly ? 'score-only' : 'run+score'})`);

// ── 4. Run + score each ─────────────────────────────────────────────
const results = [];
for (const { full, name } of specs) {
  const spec = JSON.parse(readFileSync(full, 'utf8'));
  console.error(`\n=== ${spec.id} (${spec.category}) ===`);

  let transcriptPath;
  if (opts.scoreOnly) {
    // Use the most recent transcript for this scenario, if any.
    const reportsDir = join(evalRoot, 'reports', 'hero', spec.id);
    if (!existsSync(reportsDir)) {
      console.error(`  [skip] no reports dir at ${reportsDir} — run with agent first`);
      continue;
    }
    const subdirs = readdirSync(reportsDir).filter((d) => statSync(join(reportsDir, d)).isDirectory());
    if (subdirs.length === 0) {
      console.error(`  [skip] no run subdirs in ${reportsDir}`);
      continue;
    }
    subdirs.sort();
    transcriptPath = join(reportsDir, subdirs[subdirs.length - 1], 'transcript.json');
  } else {
    // Run hero-runner; it writes transcript + verdict + SUMMARY.
    const r = spawnSync('node', ['bin/run-hero.mjs', full], { cwd: evalRoot, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`  [warn] run-hero exit ${r.status}; will still try to score`);
    }
    // Locate the just-created transcript.
    const reportsDir = join(evalRoot, 'reports', 'hero', spec.id);
    const subdirs = readdirSync(reportsDir).filter((d) => statSync(join(reportsDir, d)).isDirectory());
    subdirs.sort();
    transcriptPath = join(reportsDir, subdirs[subdirs.length - 1], 'transcript.json');
  }

  if (!existsSync(transcriptPath)) {
    console.error(`  [skip] transcript missing at ${transcriptPath}`);
    continue;
  }

  // Score it.
  const sr = spawnSync('node', ['bin/score-hero-vs-expected.mjs', transcriptPath], {
    cwd: evalRoot,
    stdio: 'inherit',
  });
  results.push({ id: spec.id, category: spec.category, transcriptPath, passed: sr.status === 0 });
}

// ── 5. Aggregate CAMPAIGN-PROOF.md ──────────────────────────────────
const outDir = join(evalRoot, 'reports', 'hero');
mkdirSync(outDir, { recursive: true });
const proofPath = join(outDir, 'CAMPAIGN-PROOF.md');
const passed = results.filter((r) => r.passed).length;
const lines = [];
lines.push('# Campaign proof artifact');
lines.push('');
lines.push(`**${passed} / ${results.length} questions PASS** (drift=0, pattern_match≥0.7, chain≥0.7, value_delivered≥0.7)`);
lines.push('');
lines.push('Generated by `bin/run-campaign.mjs`. Re-runnable: any reviewer can run `LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs --score-only --stale` to re-score the saved transcripts against the latest expected_answers.');
lines.push('');
lines.push('## Per-question results');
lines.push('');
lines.push('| ID | Category | Status | Transcript |');
lines.push('|---|---|---|---|');
for (const r of results) {
  lines.push(`| \`${r.id}\` | ${r.category} | ${r.passed ? '✓ PASS' : '✗ FAIL'} | \`${r.transcriptPath.replace(evalRoot + '/', '')}\` |`);
}
lines.push('');
lines.push('## Open gaps');
lines.push('');
const gaps = JSON.parse(readFileSync(join(evalRoot, 'gaps', 'gaps.json'), 'utf8'));
const open = gaps.filter((g) => g.fix_status === 'open');
const fixed = gaps.filter((g) => g.fix_status === 'fixed');
lines.push(`- Open: ${open.length}`);
lines.push(`- Fixed: ${fixed.length}`);
lines.push(`- Total: ${gaps.length}`);
if (open.length > 0) {
  lines.push('');
  lines.push('| Question | Kind | Description |');
  lines.push('|---|---|---|');
  for (const g of open) {
    lines.push(`| \`${g.question_id}\` | ${g.gap_kind} | ${g.gap_description.replace(/\|/g, '\\|')} |`);
  }
}

writeFileSync(proofPath, lines.join('\n') + '\n');
console.error(`\n[campaign] ${passed}/${results.length} PASS`);
console.error(`[campaign] proof artifact: ${proofPath}`);
console.error(`[campaign] gaps file:     ${join(evalRoot, 'gaps', 'gaps.json')}`);

// Gate: by default exit non-zero if not every scenario PASSES. With
// --min-pass=N, accept any run that produces at least N passes — used
// by CI to gate on regression below the documented baseline rather
// than on the documented variance (e.g., stability-newly-emerged
// fluctuates around 0.30/0.45/0.65 vd; baseline=14/15).
const gate = opts.minPass != null ? passed >= opts.minPass : passed === results.length;
if (!gate) {
  console.error(`[campaign] gate FAILED: ${passed}/${results.length} pass, required ${opts.minPass ?? results.length}`);
  process.exit(1);
}
process.exit(0);
