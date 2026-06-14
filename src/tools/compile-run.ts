/**
 * log10x_compile — compile a symbol library from any mix of sources, waiting
 * inline for the result when it is quick and handing back a pollable job when
 * it is not.
 *
 * This is the primary, agent-facing compiler entry point. It validates the
 * sources, spawns the Cloud-flavor Compiler app, and waits up to `max_wait_ms`
 * (default 45s) for completion: a small compile, and EVERY re-run (which reuses
 * prior units via the pinned output folder), finishes in that window and the
 * tool returns the finished library plus the full scan/link diagnostics in one
 * call. A long first compile of a large tree overruns the wait and returns a
 * running job_id — the run still finishes on its own and writes to the pinned
 * output, so it is collected by polling log10x_compile_status or by simply
 * calling this tool again later. `max_wait_ms: 0` returns the job_id
 * immediately (fire-and-forget).
 *
 * Validation, the source set, credentials, output pinning, and the cloud-flavor
 * gate are shared with compile.ts (`prepareCompile`); the launch + wait is
 * shared with log10x_compile_link via compile-launch.ts.
 */

import { z } from 'zod';
import { type StructuredOutput } from '../lib/output-types.js';
import { type CompileConfig } from '../lib/compile-runner.js';
import { compileSchema, prepareCompile, describeSources, type CompileArgs } from './compile.js';
import { launchCompileJob } from './compile-launch.js';

const TOOL = 'log10x_compile';

/** Source/credential surface (compileSchema) plus the inline-wait budget. */
export const compileToolSchema = {
  ...compileSchema,
  max_wait_ms: z
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(45_000)
    .describe(
      'How long to wait inline (ms) for the compile to finish before handing back a job_id to poll. Default 45,000 (45s): small compiles and re-runs (which reuse prior units) finish inside this and return the library + diagnostics in ONE call. A long first compile of a large tree returns a running job_id you poll with log10x_compile_status — or just call this tool again later, since the output is pinned and a finished run is collected near-instantly. 0 = fire-and-forget (return the job_id immediately).',
    ),
};

interface CompileToolArgs extends CompileArgs {
  max_wait_ms: number;
}

/**
 * prepareCompile returns the built config OR a ready error envelope; the
 * envelope always carries `schema_version` (the outer StructuredOutput) and a
 * CompileConfig never does, so that key is the discriminant.
 */
function isErrorEnvelope(x: CompileConfig | StructuredOutput): x is StructuredOutput {
  return 'schema_version' in x;
}

/** Compact source-mix label for the scope window. */
function sourceWindow(args: CompileArgs): string {
  return (
    [
      args.source_path ? 'local' : null,
      args.github_repos?.length ? 'github' : null,
      args.docker_images?.length ? 'images' : null,
      args.helm_charts?.length ? 'helm' : null,
      args.artifactory_instance ? 'artifactory' : null,
    ]
      .filter(Boolean)
      .join('+') + '_compile'
  );
}

export async function executeCompile(args: CompileToolArgs): Promise<string | StructuredOutput> {
  const prep = await prepareCompile(args);
  if (isErrorEnvelope(prep)) {
    return prep;
  }
  const cfg = prep;

  return launchCompileJob({
    cfg,
    kind: 'compile',
    sources: describeSources(args),
    runtimeName: cfg.output.runtimeName,
    mode: args.mode,
    maxWaitMs: args.max_wait_ms,
    tool: TOOL,
    scopeWindow: sourceWindow(args),
    candidatesCount: cfg.inputs.length,
    startedPayloadExtra: { output_folder: cfg.output.folder },
  });
}
