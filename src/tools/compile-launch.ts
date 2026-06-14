/**
 * Shared launch orchestration for the compiler tools — spawn the engine
 * detached, persist the job record, and then EITHER wait inline up to a budget
 * for completion (bounded-synchronous) OR hand back a pollable job id.
 *
 * This is the anti-drop shape: the common case (a small compile, and every
 * re-run, which reuses prior units) finishes inside `maxWaitMs`, so the tool
 * returns the finished library + diagnostics in a single call and there is no
 * second phase for an agent to forget. A genuinely long first compile overruns
 * the budget and returns a running handle — but the run finishes on its own
 * (it is detached) and writes to a PINNED output folder, so the work is never
 * lost: polling log10x_compile_status collects it, and because the output is
 * pinned, simply calling the same tool again later returns the finished library
 * near-instantly.
 *
 * Both log10x_compile and log10x_compile_link funnel through here so they share
 * the same precondition handling, record shape, and wait behaviour.
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
  type CompileConfig,
  type CompileSpawnHandle,
} from '../lib/compile-runner.js';
import { DevCliNotInstalledError, DockerNotAvailableError } from '../lib/dev-cli.js';
import {
  jobDir,
  writeJobRecord,
  reapJob,
  readJobRecord,
  type CompileJobRecord,
  type CompileJobKind,
} from '../lib/compile-jobs.js';
import { executeCompileStatus } from './compile-status.js';

/** How often the inline wait re-checks the job (via the compile_status logic). */
const POLL_INTERVAL_MS = 2500;

export interface LaunchParams {
  cfg: CompileConfig;
  kind: CompileJobKind;
  /** Human description of the sources, for headlines. */
  sources: string;
  runtimeName: string;
  mode: 'auto' | 'docker' | 'local';
  /** Inline wait budget in ms; 0 = return the handle immediately. */
  maxWaitMs: number;
  /** Tool name for envelope attribution. */
  tool: string;
  scopeWindow: string;
  candidatesCount: number;
  /** Tool-specific fields merged into the handle payload (e.g. output_folder). */
  startedPayloadExtra: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function launchCompileJob(p: LaunchParams): Promise<string | StructuredOutput> {
  const jobId = randomUUID();
  const workspaceDir = jobDir(jobId);
  const logPath = join(workspaceDir, p.kind === 'link' ? 'link.log' : 'compile.log');
  const containerName = `log10x-${p.kind}-${jobId}`;

  // Spawn detached, mapping the same precondition failures the synchronous
  // runner surfaced (docker missing / non-cloud flavor / helm repo add) to
  // branchable envelopes — these throw BEFORE anything is spawned.
  let handle: CompileSpawnHandle;
  try {
    handle = await spawnCompileDetached(
      p.cfg,
      { workspaceDir, logPath, containerName },
      { modeOverride: p.mode },
    );
  } catch (e) {
    if (
      e instanceof DevCliNotInstalledError ||
      e instanceof DockerNotAvailableError ||
      e instanceof NotCloudFlavorError
    ) {
      return buildNotConfiguredEnvelope({ tool: p.tool, kind: 'generic', remediation: e.message });
    }
    if (e instanceof HelmRepoAddError) {
      return buildChassisErrorEnvelope({
        tool: p.tool,
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
    kind: p.kind,
    mode: handle.mode,
    image: handle.image,
    container_name: handle.containerName,
    pid: handle.pid,
    output_folder: p.cfg.output.folder,
    library_file: p.cfg.output.libraryFile,
    log_file: logPath,
    job_dir: workspaceDir,
    overlay_dir: handle.overlayDir,
    helm_home_dir: handle.helmHomeDir,
    started_at: Date.now(),
    timeout_ms: p.cfg.timeoutMs,
    sources: p.sources,
    runtime_name: p.runtimeName,
  };
  try {
    await writeJobRecord(record);
  } catch (e) {
    // The engine is already running but we couldn't persist the handle — kill
    // it rather than orphan an untracked container, and surface the failure.
    await reapJob(record).catch(() => {});
    throw e;
  }

  // Fire-and-forget.
  if (p.maxWaitMs <= 0) {
    return handoffEnvelope(p, record, handle, 0);
  }

  // Bounded-synchronous: poll via the same compile_status logic (which probes,
  // captures the exit code, and reaps on terminal). Return the rich status
  // readout the moment it finishes inside the budget; otherwise hand back a
  // running handle to poll or re-collect.
  const deadline = Date.now() + p.maxWaitMs;
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const env = await executeCompileStatus({ job_id: jobId, log_lines: 40, view: 'summary' });
    const rec = await readJobRecord(jobId);
    if (rec?.ended_at !== undefined) {
      return env;
    }
    if (Date.now() >= deadline) {
      return handoffEnvelope(p, record, handle, Date.now() - record.started_at);
    }
  }
}

/** The running-handle envelope: returned for fire-and-forget or on overrun. */
function handoffEnvelope(
  p: LaunchParams,
  record: CompileJobRecord,
  handle: CompileSpawnHandle,
  waitedMs: number,
): StructuredOutput {
  const immediate = waitedMs <= 0;
  const noun = p.kind === 'link' ? 'Link' : 'Compile';
  const waitedS = Math.round(waitedMs / 1000);
  const headline = immediate
    ? `${noun} job \`${record.job_id}\` started (${handle.mode}) over ${p.sources}. Poll log10x_compile_status with this job_id.`
    : `${noun} job \`${record.job_id}\` still running after ${waitedS}s over ${p.sources}. Poll log10x_compile_status, or call ${p.tool} again later to collect it.`;
  const human_summary = immediate
    ? `Started ${p.kind} job ${record.job_id} via ${handle.mode} over ${p.sources}. It runs detached; call log10x_compile_status({ job_id: "${record.job_id}" }) to watch it and collect the library when it completes.`
    : `${noun} job ${record.job_id} is still running after ${waitedS}s (it ran past the inline wait). It finishes on its own and writes to ${record.output_folder} regardless, so the work is not lost: poll log10x_compile_status({ job_id: "${record.job_id}" }) to watch it, or just call ${p.tool} again with the same arguments later — the output is pinned, so a completed run is collected near-instantly in one call.`;
  const actions: Action[] = [
    {
      tool: 'log10x_compile_status',
      args: { job_id: record.job_id },
      reason: 'poll the job — progress, scan/link diagnostics, and the linked library when done',
    },
  ];
  return buildChassisEnvelope({
    tool: p.tool,
    view: 'summary',
    headline,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: p.scopeWindow,
      window_basis: 'explicit',
      candidates_count: p.candidatesCount,
      candidates_usable: p.candidatesCount,
    },
    payload: {
      job_id: record.job_id,
      job_status: 'running',
      mode: handle.mode,
      image: handle.image ?? null,
      library_file: record.library_file,
      runtime_name: record.runtime_name,
      sources: p.sources,
      started_at: record.started_at,
      timeout_ms: record.timeout_ms,
      log_file: record.log_file,
      ...p.startedPayloadExtra,
    },
    human_summary,
    actions,
  });
}
