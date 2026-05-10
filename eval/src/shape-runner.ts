/**
 * Shape-coverage runner.
 *
 * Reads `eval/shapes/<shape>/fabrications/<id>.json`, splices each
 * fabrication's `splice_finalText` into a base transcript, re-scores
 * via the unmodified campaign scorer, compares actual verdict against
 * `expected_verdict`, and emits a coverage matrix.
 *
 * The point is to measure whether the scorer reliably detects each
 * catalogued failure shape. A shape is "covered" iff at least one of
 * its fabrications produces the expected verdict (PASS for controls,
 * FAIL for fabrications).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreAgainstExpected, loadTranscript } from './campaign-scorer.js';
import { loadEvalEnv } from './env.js';

export interface FabricationSpec {
  /** Stable id within the shape directory (used for output paths). */
  id: string;
  /** Shape this fabrication belongs to (must match parent dir name). */
  shape: string;
  /** Path (relative to eval/) of the transcript to fork. */
  base_transcript: string;
  /** Replacement finalText. The agent's bashCommands are preserved. */
  splice_finalText: string;
  /** Expected verdict after rescoring the spliced transcript. */
  expected_verdict: 'should_pass' | 'should_fail';
  /** Human-readable note about why this fabrication targets this shape. */
  rationale: string;
}

export interface ShapeRunResult {
  shape: string;
  fabrication_id: string;
  expected_verdict: 'should_pass' | 'should_fail';
  actual_passed: boolean;
  matched: boolean;
  axes_summary: string;
}

export interface ShapeCoverageMatrix {
  total_shapes: number;
  total_fabrications: number;
  correctly_classified: number;
  shapes_with_at_least_one_correct: number;
  coverage_score: number; // shapes_with_at_least_one_correct / total_shapes
  per_shape: Record<string, { correct: number; total: number }>;
  results: ShapeRunResult[];
}

/**
 * Score one fabrication. Returns the run result without persisting
 * anything to gaps.json (caller is responsible for snapshot/restore).
 */
export async function runFabrication(
  evalRoot: string,
  fab: FabricationSpec
): Promise<ShapeRunResult> {
  const baseTxPath = resolve(evalRoot, fab.base_transcript);
  if (!existsSync(baseTxPath)) {
    throw new Error(`base transcript not found: ${baseTxPath}`);
  }

  // Fork the transcript: same spec / bashCommands, replace finalText.
  const baseTranscript = JSON.parse(readFileSync(baseTxPath, 'utf8'));
  const fork = JSON.parse(JSON.stringify(baseTranscript));
  fork.finalText = fab.splice_finalText;

  // Persist the fork beside the fabrication spec so the score is
  // re-runnable.
  const runDir = resolve(evalRoot, 'shapes', fab.shape, 'runs', fab.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'transcript.json'), JSON.stringify(fork, null, 2) + '\n');

  // Look up the spec (the campaign-scorer needs expected_answer).
  const specPath = resolve(evalRoot, 'fixtures/hero', `${fork.spec.id}.json`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));

  // Recover prior judge scores from the original transcript's
  // verdict.json if present (so judge axes carry over rather than
  // becoming -1 and effectively disabling the value axes).
  const origVerdictPath = baseTxPath.replace(/transcript\.json$/, 'verdict.json');
  let judgeScores;
  try {
    const v = JSON.parse(readFileSync(origVerdictPath, 'utf8'));
    if (v.valueDelivered?.score !== undefined) {
      judgeScores = {
        value_delivered: v.valueDelivered.score,
        value_received: v.valueReceived?.score ?? -1,
      };
    }
  } catch {
    // no prior judge — value axes will be -1 (ungated)
  }

  const env = loadEvalEnv();
  const result = await scoreAgainstExpected({
    transcript: loadTranscript(join(runDir, 'transcript.json')),
    spec,
    env,
    judgeScores,
  });

  const actualPassed = result.verdict.passed;
  const matched = fab.expected_verdict === (actualPassed ? 'should_pass' : 'should_fail');

  // Persist the scored verdict for inspection.
  writeFileSync(
    join(runDir, 'campaign-verdict.json'),
    JSON.stringify({ fabrication: fab, verdict: result.verdict, gaps: result.gaps }, null, 2) + '\n'
  );

  return {
    shape: fab.shape,
    fabrication_id: fab.id,
    expected_verdict: fab.expected_verdict,
    actual_passed: actualPassed,
    matched,
    axes_summary: result.verdict.axes_summary,
  };
}

/**
 * Walk eval/shapes/<shape>/fabrications/*.json, run each, build the
 * coverage matrix. Snapshots and restores gaps.json around the run
 * so shape-test gap records don't pollute production state.
 */
export async function runAllShapes(evalRoot: string): Promise<ShapeCoverageMatrix> {
  const gapsPath = resolve(evalRoot, 'gaps/gaps.json');
  const gapsBackup = resolve(evalRoot, 'gaps/.gaps.shape-runner.bak.json');
  let restoreNeeded = false;
  if (existsSync(gapsPath)) {
    copyFileSync(gapsPath, gapsBackup);
    restoreNeeded = true;
  }

  const shapesDir = resolve(evalRoot, 'shapes');
  const catalogPath = join(shapesDir, 'catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const shapeIds: string[] = catalog.shapes.map((s: { id: string }) => s.id);

  const results: ShapeRunResult[] = [];

  try {
    for (const shape of shapeIds) {
      const fabsDir = join(shapesDir, shape, 'fabrications');
      if (!existsSync(fabsDir)) continue;
      const files = readdirSync(fabsDir).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const fab: FabricationSpec = JSON.parse(readFileSync(join(fabsDir, file), 'utf8'));
        // Ensure the shape field matches the parent dir.
        if (fab.shape !== shape) {
          throw new Error(`fabrication ${file}: shape "${fab.shape}" does not match dir "${shape}"`);
        }
        const r = await runFabrication(evalRoot, fab);
        results.push(r);
      }
    }
  } finally {
    if (restoreNeeded) copyFileSync(gapsBackup, gapsPath);
  }

  // Aggregate
  const perShape: Record<string, { correct: number; total: number }> = {};
  for (const id of shapeIds) perShape[id] = { correct: 0, total: 0 };
  for (const r of results) {
    perShape[r.shape].total++;
    if (r.matched) perShape[r.shape].correct++;
  }
  const shapesWithAtLeastOneCorrect = Object.entries(perShape).filter(
    ([id, x]) => x.total > 0 && x.correct > 0 && _shapeHasFabricationOfKind(shapesDir, id)
  ).length;
  const correctlyClassified = results.filter((r) => r.matched).length;

  return {
    total_shapes: shapeIds.length,
    total_fabrications: results.length,
    correctly_classified: correctlyClassified,
    shapes_with_at_least_one_correct: shapesWithAtLeastOneCorrect,
    coverage_score: shapesWithAtLeastOneCorrect / shapeIds.length,
    per_shape: perShape,
    results,
  };
}

// A shape is "covered" iff at least one should_fail fabrication is
// caught. A shape with only should_pass controls passing is not
// proof of detection capability.
function _shapeHasFabricationOfKind(shapesDir: string, shape: string): boolean {
  const fabsDir = `${shapesDir}/${shape}/fabrications`;
  if (!existsSync(fabsDir)) return false;
  const files = readdirSync(fabsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const fab = JSON.parse(readFileSync(`${fabsDir}/${file}`, 'utf8'));
    if (fab.expected_verdict === 'should_fail') return true;
  }
  return false;
}

/**
 * Render the coverage matrix as markdown for COVERAGE.md.
 */
export function renderCoverageMarkdown(m: ShapeCoverageMatrix): string {
  const lines: string[] = [];
  lines.push('# Shape coverage matrix');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- **Shapes catalogued**: ${m.total_shapes}`);
  lines.push(`- **Fabrications evaluated**: ${m.total_fabrications}`);
  lines.push(`- **Correctly classified**: ${m.correctly_classified} / ${m.total_fabrications}`);
  lines.push(
    `- **Shapes with ≥ 1 should_fail fabrication correctly caught**: ${m.shapes_with_at_least_one_correct} / ${m.total_shapes}`
  );
  lines.push(`- **Coverage score**: ${(m.coverage_score * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('## Per shape');
  lines.push('');
  lines.push('| Shape | Correct / Total | Status |');
  lines.push('|---|---|---|');
  for (const [shape, counts] of Object.entries(m.per_shape)) {
    const status = counts.total === 0 ? 'no fabrications' : counts.correct > 0 ? 'covered' : 'uncovered';
    lines.push(`| \`${shape}\` | ${counts.correct} / ${counts.total} | ${status} |`);
  }
  lines.push('');
  lines.push('## Per fabrication');
  lines.push('');
  lines.push('| Shape | Fabrication | Expected | Actual | Match? | Axes |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of m.results) {
    lines.push(
      `| \`${r.shape}\` | \`${r.fabrication_id}\` | ${r.expected_verdict} | ${
        r.actual_passed ? 'PASS' : 'FAIL'
      } | ${r.matched ? '✓' : '✗'} | \`${r.axes_summary}\` |`
    );
  }
  return lines.join('\n') + '\n';
}

// Convenience entry for CLI bin script
export async function main(evalRoot?: string, opts?: { minCoverage?: number }) {
  const root = evalRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const matrix = await runAllShapes(root);
  const md = renderCoverageMarkdown(matrix);
  const coveragePath = resolve(root, 'shapes/COVERAGE.md');
  writeFileSync(coveragePath, md);
  console.error(`[shapes] coverage ${(matrix.coverage_score * 100).toFixed(1)}% (${matrix.shapes_with_at_least_one_correct}/${matrix.total_shapes})`);
  console.error(`[shapes] correctly classified ${matrix.correctly_classified}/${matrix.total_fabrications}`);
  console.error(`[shapes] wrote ${coveragePath}`);
  const min = opts?.minCoverage;
  if (min != null && matrix.coverage_score < min) {
    console.error(`[shapes] gate FAILED: coverage ${matrix.coverage_score.toFixed(3)} < required ${min.toFixed(3)}`);
    process.exit(1);
  }
  return matrix;
}
