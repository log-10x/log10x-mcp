/**
 * log10x_compile_start — kick off a Compiler run asynchronously.
 *
 * Compiling a large codebase runs 10–30 min, so this tool does NOT block: it
 * validates the sources, spawns the Cloud-flavor Compiler app detached
 * (docker container or local cloud `tenx`), writes a disk job record, and
 * returns a `job_id` immediately. Poll `log10x_compile_status` with that id to
 * watch progress, read scan/link diagnostics, and collect the linked
 * `.10x.tar` library once the run finishes.
 *
 * Sources, credentials, output pinning, and the cloud-flavor gate are all
 * shared with the synchronous validation in compile.ts (`prepareCompile`) —
 * this tool only swaps the blocking run for a detached spawn + job record.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type StructuredOutput, type Action } from '../lib/output-types.js';
import { buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import {
  spawnCompileDetached,
  NotCloudFlavorError,
  HelmRepoAddError,
} from '../lib/compile-runner.js';
import { DevCliNotInstalledError, DockerNotAvailableError } from '../lib/dev-cli.js';
import {
  jobDir,
  writeJobRecord,
  reapJob,
  type CompileJobRecord,
} from '../lib/compile-jobs.js';
import {
  compileSchema,
  prepareCompile,
  describeSources,
  type CompileArgs,
} from './compile.js';
import { type CompileConfig } from '../lib/compile-runner.js';

const TOOL = 'log10x_compile_start';

/** Same source/credential surface as the synchronous compiler. */
export const compileStartSchema = compileSchema;

/**
 * prepareCompile returns the built config OR a ready-to-return error envelope.
 * The envelope always carries `schema_version` (the outer StructuredOutput);
 * a CompileConfig never does — so that key is the discriminant.
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

export async function executeCompileStart(args: CompileArgs): Promise<string | StructuredOutput> {
  // Validate + build the config (or get back a ready error envelope).
  const prep = await prepareCompile(args);
  if (isErrorEnvelope(prep)) {
    return prep;
  }
  const cfg = prep;

  const jobId = randomUUID();
  const workspaceDir = jobDir(jobId);
  const logPath = join(workspaceDir, 'compile.log');
  const containerName = `log10x-compile-${jobId}`;
  const sources = describeSources(args);

  // Spawn detached, mapping the same precondition failures the synchronous
  // runner surfaced (docker missing / non-cloud flavor / helm repo add) to
  // branchable envelopes — these throw BEFORE anything is spawned.
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
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `${e.message}. Check the helm_repos url (an http(s):// chart-repo index) and that the repo is reachable.`,
        },
      });
    }
    throw e;
  }

  const record: CompileJobRecord = {
    job_id: jobId,
    kind: 'compile',
    mode: handle.mode,
    image: handle.image,
    container_name: handle.containerName,
    pid: handle.pid,
    output_folder: cfg.output.folder,
    library_file: cfg.output.libraryFile,
    log_file: logPath,
    job_dir: workspaceDir,
    overlay_dir: handle.overlayDir,
    helm_home_dir: handle.helmHomeDir,
    started_at: Date.now(),
    timeout_ms: cfg.timeoutMs,
    sources,
    runtime_name: cfg.output.runtimeName,
  };
  try {
    await writeJobRecord(record);
  } catch (e) {
    // The engine is already running but we couldn't persist the handle — kill
    // it rather than orphan an untracked container, and surface the failure.
    await reapJob(record).catch(() => {});
    throw e;
  }

  const headline = `Compile job \`${jobId}\` started (${handle.mode}) over ${sources}. Poll log10x_compile_status with this job_id.`;
  const actions: Action[] = [
    {
      tool: 'log10x_compile_status',
      args: { job_id: jobId },
      reason: 'poll the compile — progress, scan/link diagnostics, and the linked library when done',
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
      window: sourceWindow(args),
      window_basis: 'explicit',
      candidates_count: cfg.inputs.length,
      candidates_usable: cfg.inputs.length,
    },
    payload: {
      job_id: jobId,
      job_status: 'running',
      mode: handle.mode,
      image: handle.image ?? null,
      output_folder: cfg.output.folder,
      library_file: cfg.output.libraryFile,
      runtime_name: cfg.output.runtimeName,
      sources,
      started_at: record.started_at,
      timeout_ms: cfg.timeoutMs,
      log_file: logPath,
    },
    human_summary: `Started compile job ${jobId} via ${handle.mode} over ${sources}. The compiler runs detached; call log10x_compile_status({ job_id: "${jobId}" }) to watch scan progress, read per-language scan-failure and link diagnostics, and collect the linked library when the run completes. First compiles of a large tree take 10–30 min; re-runs of the same sources are near-instant via checksum reuse.`,
    actions,
  });
}
