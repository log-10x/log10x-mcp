#!/usr/bin/env node
/**
 * Run the end-to-end cross-validation pipeline:
 *   real log lines (S3) → resolve_batch (templater) → identity hashes
 *   → Prometheus oracle (live env metrics) → round-trip status
 *
 * Usage: LOG10X_EVAL_ENV=demo node bin/cross-validate.mjs
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { runCrossValidation, renderCrossValidationReport } = await import(
  resolve(evalRoot, 'build-eval/cross-validate.js')
);

const env = loadEvalEnv();
console.error(`[cross-validate] env=${env.mode} starting…`);

const report = await runCrossValidation(env);

// Write report alongside the regular reports/ tree
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(evalRoot, 'reports', 'cross-validate', ts);
mkdirSync(outDir, { recursive: true });
const md = renderCrossValidationReport(report);
writeFileSync(join(outDir, 'report.md'), md);
writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(report, null, 2));

console.error('');
console.error(md);
console.error('');
console.error(`[cross-validate] ${outDir}`);

process.exit(report.status === 'fail' ? 1 : 0);
