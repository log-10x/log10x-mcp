/**
 * log10x_compile_link, link an existing folder of `.10x.json` symbol units
 * into a single `.10x.tar` library, with no source scan.
 *
 * This is the same Cloud-flavor Compiler app (`@apps/compiler`) invoked with
 * link-only args: point `outputSymbolFolder` at the units folder and mount no
 * source, so the engine reuses the units already on disk (scans 0 new files)
 * and merges them into the library. No separate link app or pipeline, just
 * the right invocation, which is a CompileConfig with `inputs: []` and the
 * output folder set to the units folder. It therefore reuses the whole launch +
 * wait machinery (compile-launch.ts): like log10x_compile it waits inline up to
 * `max_wait_ms` (linking is usually fast, so it normally returns the linked
 * library in one call) and otherwise hands back a job_id you poll with
 * log10x_compile_status.
 *
 * Use it to re-link after editing/pruning units, to merge a units tree that was
 * produced piecemeal, or to (re)build a library from units alone.
 */

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type StructuredOutput } from '../lib/output-types.js';
import { buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { type CompileConfig } from '../lib/compile-runner.js';
import { sanitizeName } from './compile.js';
import { launchCompileJob } from './compile-launch.js';

const TOOL = 'log10x_compile_link';

export const compileLinkSchema = {
  units_path: z
    .string()
    .describe(
      'Absolute path to a folder of .10x.json symbol units (produced by a prior compile) to link into a single .10x.tar library. Traversed recursively; the existing units are merged with NO source re-scan, and the .10x.tar is written into this same folder.',
    ),
  library_name: z
    .string()
    .default('symbols')
    .describe('Base name for the linked .10x.tar and the runtimeName. Sanitized to [A-Za-z0-9_.-].'),
  mode: z
    .enum(['auto', 'docker', 'local'])
    .default('auto')
    .describe(
      'Execution backend, same contract as log10x_compile: `auto` prefers the cloud compiler image, `docker` forces it, `local` uses a cloud-flavor tenx. The Edge flavor is refused.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(600_000)
    .describe(
      'Hard cap on link wall time in ms. Default 600,000 (10 min). Linking is much faster than scanning, but a very large units tree can still take minutes.',
    ),
  max_wait_ms: z
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(45_000)
    .describe(
      'How long to wait inline (ms) for the link to finish before handing back a job_id to poll. Default 45,000 (45s). Linking usually finishes inside this and returns the library in ONE call. A very large units tree returns a running job_id you poll with log10x_compile_status. 0 = fire-and-forget.',
    ),
};

interface CompileLinkArgs {
  units_path: string;
  library_name: string;
  mode: 'auto' | 'docker' | 'local';
  timeout_ms: number;
  max_wait_ms: number;
}

/** Count the `.10x.json` units under a folder (recursive). */
async function countUnits(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const rel of entries) {
    if (rel.endsWith('.10x.json')) n++;
  }
  return n;
}

export async function executeCompileLink(args: CompileLinkArgs): Promise<string | StructuredOutput> {
  const unitsPath = resolve(args.units_path);

  let stat;
  try {
    stat = await fs.stat(unitsPath);
  } catch {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `units_path does not exist: ${unitsPath}. Pass an absolute path to a folder of .10x.json symbol units from a prior compile.`,
      },
    });
  }
  if (!stat.isDirectory()) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `units_path must be a directory, not a file: ${unitsPath}.`,
      },
    });
  }
  const unitCount = await countUnits(unitsPath);
  if (unitCount === 0) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `No .10x.json symbol units found under ${unitsPath}. Nothing to link. Compile sources first with log10x_compile (its output folder is a valid units_path).`,
      },
    });
  }

  // Link-only = the compiler with output.folder pointed at the units folder and
  // NO source inputs: the engine reuses the on-disk units (scans 0 new) and
  // merges them into output.libraryFile.
  const runtimeName = sanitizeName(args.library_name);
  const cfg: CompileConfig = {
    inputs: [],
    output: {
      folder: unitsPath,
      libraryFile: join(unitsPath, `${runtimeName}.10x.tar`),
      runtimeName,
    },
    license: process.env.TENX_LICENSE_KEY || process.env.LOG10X_LICENSE_KEY || undefined,
    timeoutMs: args.timeout_ms,
  };

  return launchCompileJob({
    cfg,
    kind: 'link',
    sources: `link ${unitsPath}`,
    runtimeName,
    mode: args.mode,
    maxWaitMs: args.max_wait_ms,
    tool: TOOL,
    scopeWindow: `${runtimeName}_link`,
    candidatesCount: unitCount,
    startedPayloadExtra: { units_path: unitsPath, unit_count: unitCount },
  });
}
