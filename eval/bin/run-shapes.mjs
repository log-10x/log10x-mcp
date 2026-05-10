#!/usr/bin/env node
/**
 * Drive the shape-coverage harness.
 *
 * Usage:
 *   LOG10X_EVAL_ENV=demo node eval/bin/run-shapes.mjs
 *     [--min-coverage 0.27]
 *
 * The flag gates CI on a minimum fraction of shapes covered. The
 * initial baseline (set after porting the adversarial fabrications
 * into shapes) is ~0.27 (4 of 15 shapes catch at least one
 * should_fail fabrication). A drop = scorer regression.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { minCoverage: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-coverage') out.minCoverage = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Usage: run-shapes.mjs [--min-coverage <float>]',
          '',
          'Scores every fabrication under eval/shapes/<shape>/fabrications/ against',
          'the unmodified campaign scorer; writes eval/shapes/COVERAGE.md.',
          '',
          'Exits non-zero if --min-coverage is provided and the actual coverage',
          'drops below it (CI regression gate).',
        ].join('\n')
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);

const { main } = await import(resolve(evalRoot, 'build-eval/shape-runner.js'));
await main(evalRoot, { minCoverage: opts.minCoverage });
