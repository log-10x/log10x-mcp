#!/usr/bin/env node
/**
 * Emit N parametric hero scenarios under eval/fixtures/hero/generated/.
 *
 * Usage:
 *   node eval/bin/generate-scenarios.mjs --count 20 --seed 42
 *
 * Each generated spec has its `expected_answer.top_patterns` empty;
 * use `bin/refresh-expected.mjs` against a live oracle to populate
 * pattern lists / severity splits before running them as sub-agent
 * scenarios.
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { generateScenarios } = await import(resolve(evalRoot, 'build-eval/scenario-generator.js'));

function parseArgs(argv) {
  const out = { count: 10, seed: 1, clean: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') out.count = parseInt(argv[++i], 10);
    else if (a === '--seed') out.seed = parseInt(argv[++i], 10);
    else if (a === '--clean') out.clean = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: generate-scenarios.mjs --count <n> --seed <n> [--clean]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);
const outDir = resolve(evalRoot, 'fixtures/hero/generated');
mkdirSync(outDir, { recursive: true });

if (opts.clean) {
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.json')) unlinkSync(join(outDir, f));
  }
  console.error(`[generate] cleaned ${outDir}`);
}

const specs = generateScenarios(opts.count, opts.seed);
for (const s of specs) {
  writeFileSync(join(outDir, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n');
}
console.error(`[generate] wrote ${specs.length} scenarios → ${outDir}`);
for (const s of specs) console.error(`  ${s.id}`);
