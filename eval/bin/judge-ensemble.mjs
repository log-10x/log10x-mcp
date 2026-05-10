#!/usr/bin/env node
/**
 * Re-judge one or more saved hero transcripts via the multi-judge
 * ensemble. Writes eval/reports/hero/JUDGE-ENSEMBLE.md.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... [XAI_API_KEY=...] \
 *     node eval/bin/judge-ensemble.mjs \
 *       eval/reports/hero/<id>/<ts>/transcript.json [more...]
 *
 * Pass --all to score every transcript that exists under
 * eval/reports/hero/.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { judgeEnsemble, renderEnsembleMarkdown } = await import(
  resolve(evalRoot, 'build-eval/judge-ensemble.js')
);
const { loadTranscript } = await import(resolve(evalRoot, 'build-eval/campaign-scorer.js'));

function discoverAllTranscripts() {
  const out = [];
  const root = resolve(evalRoot, 'reports/hero');
  for (const scenario of readdirSync(root)) {
    const sdir = join(root, scenario);
    if (!statSync(sdir).isDirectory()) continue;
    for (const ts of readdirSync(sdir)) {
      const tdir = join(sdir, ts);
      if (!statSync(tdir).isDirectory()) continue;
      const tx = join(tdir, 'transcript.json');
      try {
        if (statSync(tx).isFile()) out.push(tx);
      } catch {
        // skip
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
let paths;
if (args.includes('--all')) {
  paths = discoverAllTranscripts();
} else if (args.length > 0) {
  paths = args;
} else {
  console.error('Usage: judge-ensemble.mjs [--all] | <transcript.json> [...]');
  process.exit(2);
}

console.error(`[ensemble] scoring ${paths.length} transcripts`);

const results = [];
for (const p of paths) {
  const tx = loadTranscript(resolve(p));
  const specId = tx.spec.id;
  const specPath = resolve(evalRoot, 'fixtures/hero', `${specId}.json`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  console.error(`[ensemble] ${specId} (${p})`);
  try {
    const r = await judgeEnsemble(spec, tx);
    results.push(r);
    console.error(
      `  → vd σ=${r.value_delivered_sigma.toFixed(3)}, vr σ=${r.value_received_sigma.toFixed(3)}, disagreement=${r.any_disagreement}`
    );
  } catch (e) {
    console.error(`  → FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const outPath = resolve(evalRoot, 'reports/hero/JUDGE-ENSEMBLE.md');
writeFileSync(outPath, renderEnsembleMarkdown(results));
console.error(`[ensemble] wrote ${outPath}`);
