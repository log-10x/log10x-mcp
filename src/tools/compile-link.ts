/**
 * log10x_compile_link — link an existing folder of `.10x.json` symbol units
 * into a single `.10x.tar` library, with no source scan.
 *
 * This is the same Cloud-flavor Compiler app (`@apps/compiler`) invoked with
 * link-only args: point `outputSymbolFolder` at the units folder and mount no
 * source, so the engine reuses the units already on disk (scans 0 new files)
 * and merges them into the library. No separate link app or pipeline — just
 * the right invocation, which is a CompileConfig with `inputs: []` and the
 * output folder set to the units folder. It therefore reuses the whole async
 * spawn + job machinery: this tool starts a `link`-kind job and you poll it
 * with log10x_compile_status exactly like a compile.
 *
 * Use it to re-link after editing/pruning units, to merge a units tree that was
 * produced piecemeal, or to (re)build a library from units alone.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { type StructuredOutput, type Action } from '../lib/output-types.js';
import { buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import {
  spawnCompileDetached,
  NotCloudFlavorError,
  HelmRepoAddError,
  type CompileConfig,
} from '../lib/compile-runner.js';
import { DevCliNotInstalledError, DockerNotAvailableError } from '../lib/dev-cli.js';
import { jobDir, writeJobRecord, reapJob, type CompileJobRecord } from '../lib/compile-jobs.js';
import { sanitizeName } from './compile.js';
import { z } from 'zod';

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
      'Execution backend, same contract as log10x_compile_start: `auto` prefers the cloud compiler image, `docker` forces it, `local` uses a cloud-flavor tenx. The Edge flavor is refused.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(600_000)
    .describe(
      'Hard cap on link wall time in ms. Default 600,000 (10 min) — linking is much faster than scanning, but a very large units tree can still take minutes.',
    ),
};

interface CompileLinkArgs {
  units_path: string;
  library_name: string;
  mode: 'auto' | 'docker' | 'local';
  timeout_ms: number;
}

/** Count the `.10x.json` units under a folder (recursive), capped for speed. */
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
        hint: `No .10x.json symbol units found under ${unitsPath} — nothing to link. Compile sources first with log10x_compile_start (its output folder is a valid units_path).`,
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

  const jobId = randomUUID();
  const workspaceDir = jobDir(jobId);
  const logPath = join(workspaceDir, 'link.log');
  const containerName = `log10x-link-${jobId}`;
  const sources = `link ${unitsPath}`;

  let handle;
  try {
    handle = await spawnCompileDetached(
      cfg,
      { workspaceDir, logPath, containerName },
      { modeOverride: args.mode },
    );
  } catch (e) {
    if (
      e instanceof DevCliNotInstalledError ||
      e instanceof DockerNotAvailableError ||
      e instanceof NotCloudFlavorError
    ) {
      return buildNotConfiguredEnvelope({ tool: TOOL, kind: 'generic', remediation: e.message });
    }
    if (e instanceof HelmRepoAddError) {
      // Not reachable for link-only (no helm), but keep the mapping uniform.
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: e.message,
        },
      });
    }
    throw e;
  }

  const record: CompileJobRecord = {
    job_id: jobId,
    kind: 'link',
    mode: handle.mode,
    image: handle.image,
    container_name: handle.containerName,
    pid: handle.pid,
    output_folder: unitsPath,
    library_file: cfg.output.libraryFile,
    log_file: logPath,
    job_dir: workspaceDir,
    overlay_dir: handle.overlayDir,
    helm_home_dir: handle.helmHomeDir,
    started_at: Date.now(),
    timeout_ms: cfg.timeoutMs,
    sources,
    runtime_name: runtimeName,
  };
  try {
    await writeJobRecord(record);
  } catch (e) {
    await reapJob(record).catch(() => {});
    throw e;
  }

  const headline = `Link job \`${jobId}\` started (${handle.mode}) over ${unitCount} unit${unitCount === 1 ? '' : 's'} in ${unitsPath}. Poll log10x_compile_status with this job_id.`;
  const actions: Action[] = [
    {
      tool: 'log10x_compile_status',
      args: { job_id: jobId },
      reason: 'poll the link job — progress, link diagnostics, and the linked library when done',
    },
  ];

  return buildChassisEnvelope({
    tool: TOOL,
    view: 'summary',
    headline,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: `${runtimeName}_link`,
      window_basis: 'explicit',
      candidates_count: unitCount,
      candidates_usable: unitCount,
    },
    payload: {
      job_id: jobId,
      job_status: 'running',
      mode: handle.mode,
      image: handle.image ?? null,
      units_path: unitsPath,
      unit_count: unitCount,
      library_file: cfg.output.libraryFile,
      runtime_name: runtimeName,
      started_at: record.started_at,
      timeout_ms: cfg.timeoutMs,
      log_file: logPath,
    },
    human_summary: `Started link job ${jobId} via ${handle.mode} over ${unitCount} symbol unit${unitCount === 1 ? '' : 's'} in ${unitsPath}. The compiler links detached (no source scan); call log10x_compile_status({ job_id: "${jobId}" }) to watch it and collect ${runtimeName}.10x.tar when it completes.`,
    actions,
  });
}
