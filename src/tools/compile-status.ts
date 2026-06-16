/**
 * log10x_compile_status, poll an async Compiler run started by
 * log10x_compile, and surface what the engine is actually doing.
 *
 * Reads the disk job record, probes liveness (docker container / local pid),
 * scans the output folder for produced units + the linked `.10x.tar`, and
 * parses the engine's `printResults` JSON out of the captured log. The first
 * time it sees a terminal run it captures the exit code into the record and
 * frees the container, so repeat polls stay cheap and idempotent and the
 * compiled library stays readable.
 *
 * The point of this tool is to make the compiler NOT a black box at scale: it
 * promotes the engine's scan-failure aggregates (how many files failed, by
 * language, with capped samples) and the link report (merge/exclude counts +
 * the symbol-type histogram) into the envelope, instead of leaving them
 * buried in a multi-hundred-thousand-line log. Those diagnostics appear once
 * the compiler-10x image carries the engine `scanHealth` / `linkReport`
 * change; on an older image the tool degrades to unit counts + a log tail.
 */

import { z } from 'zod';
import { type StructuredOutput, type Action } from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  type ChassisStatus,
} from '../lib/chassis-envelope.js';
import { scanSymbolOutputs } from '../lib/compile-runner.js';
import {
  readJobRecord,
  writeJobRecord,
  removeJobContainer,
  probeDockerContainer,
  probeLocalPid,
  readJobLog,
  tailLines,
  parseCompileResults,
  type CompileJobRecord,
  type CompileResultsDoc,
  type ScanHealth,
  type LinkReport,
} from '../lib/compile-jobs.js';

const TOOL = 'log10x_compile_status';

/**
 * Grace window after spawn during which a docker container that is not yet
 * inspectable (`gone`) is treated as still-starting rather than finished,
 * `docker run` takes a moment to register the container, and the run keeps it
 * (no `--rm`) so a real completion always shows as `exited`, never `gone`.
 */
const STARTUP_GRACE_MS = 30_000;

export const compileStatusSchema = {
  job_id: z
    .string()
    .describe('The job id returned by log10x_compile (data.payload.job_id).'),
  log_lines: z
    .number()
    .int()
    .min(0)
    .max(400)
    .default(40)
    .describe(
      'How many trailing engine-log lines to include in data.payload.log_tail (credential-redacted). 0 to omit. Raise it when diagnosing a failed run.',
    ),
  view: z
    .literal('summary')
    .default('summary')
    .optional()
    .describe('summary returns the typed envelope (data.payload.job_status, .diagnostics, .output, .log_tail).'),
};

interface CompileStatusArgs {
  job_id: string;
  log_lines: number;
  view?: 'summary';
}

type JobStatus = 'running' | 'completed' | 'failed' | 'timed_out';

function humanByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

/** Shape the per-phase diagnostics + scan/link aggregates for the payload. */
function buildDiagnostics(results: CompileResultsDoc | null): {
  results_available: boolean;
  phases: Array<{
    operation: string | null;
    status: string | null;
    traversed_files: number | null;
    scanned_files: number | null;
    output_files: number | null;
    warns: number | null;
    errors: number | null;
  }>;
  scan_health: {
    files_failed: number;
    failed_by_language: Record<string, number>;
    failure_samples: Array<{ name: string; language: string; reason: string }>;
  } | null;
  link_report: {
    merged_files: number;
    skipped_files: number;
    excluded_by_folder: number;
    excluded_by_file_name: number;
    merged_repos_count: number;
    non_merged_repos_count: number;
    symbols_by_type: Record<string, number>;
    symbols_excluded_by_type: number;
  } | null;
} {
  if (!results || !results.phases) {
    return { results_available: false, phases: [], scan_health: null, link_report: null };
  }
  const phases = results.phases.map((p) => ({
    operation: p.operation ?? null,
    status: p.status ?? null,
    traversed_files: p.traversedFiles ?? null,
    scanned_files: p.scannedFiles ?? null,
    output_files: p.outputFiles ?? null,
    warns: p.warns ?? null,
    errors: p.errors ?? null,
  }));

  const health: ScanHealth | undefined = results.phases.find((p) => p.scanHealth)?.scanHealth;
  const link: LinkReport | undefined = results.phases.find((p) => p.linkReport)?.linkReport;

  return {
    results_available: true,
    phases,
    scan_health: health
      ? {
          files_failed: health.filesFailed,
          failed_by_language: health.failedByLanguage,
          failure_samples: health.failureSamples,
        }
      : null,
    link_report: link
      ? {
          merged_files: link.mergedFilesSize,
          skipped_files: link.skippedFilesSize,
          excluded_by_folder: link.excludedByFolder,
          excluded_by_file_name: link.excludedByFileName,
          merged_repos_count: link.mergedRepos.length,
          non_merged_repos_count: link.nonMergedRepos.length,
          symbols_by_type: link.symbolsByType,
          symbols_excluded_by_type: link.symbolsExcludedByType,
        }
      : null,
  };
}

/** Top-N entries of a count map, descending. */
function topEntries(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export async function executeCompileStatus(
  args: CompileStatusArgs,
): Promise<string | StructuredOutput> {
  const record = await readJobRecord(args.job_id);
  if (!record) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `Unknown compile job_id "${args.job_id}". It was never started or its record has been cleaned up. Start a fresh compile with log10x_compile.`,
      },
    });
  }

  // Resolve terminal state. A record carrying ended_at was already captured on
  // a prior poll, trust it and skip the live probe (the container is gone).
  let terminal = record.ended_at !== undefined;
  let timedOut = false;
  let exitCode: number | null = record.exit_code ?? null;

  if (!terminal) {
    const live =
      record.mode === 'docker' && record.container_name
        ? await probeDockerContainer(record.container_name)
        : record.pid !== undefined
          ? probeLocalPid(record.pid)
          : { state: 'gone' as const, exitCode: null };
    const elapsed = Date.now() - record.started_at;
    // Because the async run keeps its container (no `--rm`), a FINISHED docker
    // run is always inspectable as `exited`. So `gone` (no such object) can only
    // mean the container is not registered YET (the `docker run` client is still
    // creating it), within a startup grace, that is still-running, not done.
    // Reaping here would race-kill the just-starting container. Past the grace a
    // still-`gone` container never materialized (the client failed to start it).
    const stillStarting =
      live.state === 'gone' && record.mode === 'docker' && elapsed < STARTUP_GRACE_MS;
    const inFlight = live.state === 'running' || stillStarting;
    if (inFlight && elapsed > record.timeout_ms) {
      // Overran the wall-cap, free the container and mark it timed out.
      terminal = true;
      timedOut = true;
      exitCode = null;
      await removeJobContainer(record);
      record.ended_at = Date.now();
      record.exit_code = null;
      await writeJobRecord(record).catch(() => {});
    } else if (!inFlight) {
      // Exited (true terminal), or gone past the startup grace (never started),
      // capture the outcome once, then free the container.
      terminal = true;
      exitCode = live.exitCode;
      await removeJobContainer(record);
      record.ended_at = Date.now();
      record.exit_code = exitCode;
      await writeJobRecord(record).catch(() => {});
    }
  }

  // Always read outputs, log, and diagnostics, even mid-run, to show progress.
  const scanned = await scanSymbolOutputs(record.output_folder);
  const logText = await readJobLog(record);
  const tail = args.log_lines > 0 ? tailLines(logText, args.log_lines) : [];
  const results = parseCompileResults(logText);
  const diagnostics = buildDiagnostics(results);

  const producedSymbols = scanned.unitCount > 0 || scanned.libraries.some((l) => l.bytes > 0);
  const elapsedMs = (record.ended_at ?? Date.now()) - record.started_at;
  const library = scanned.libraries[0];

  let jobStatus: JobStatus;
  let chassisStatus: ChassisStatus;
  if (!terminal) {
    jobStatus = 'running';
    chassisStatus = 'partial';
  } else if (timedOut) {
    jobStatus = 'timed_out';
    chassisStatus = 'error';
  } else {
    // Docker gives a true exit code; local can't read one post-hoc, so fall
    // back to the engine's own success flag (printResults), then to whether
    // any symbols were produced.
    const ok =
      record.mode === 'docker' ? exitCode === 0 : (results?.success ?? producedSymbols);
    if (ok && producedSymbols) {
      jobStatus = 'completed';
      chassisStatus = 'success';
    } else if (ok && !producedSymbols) {
      jobStatus = 'completed';
      chassisStatus = 'no_signal';
    } else if (!ok && producedSymbols) {
      jobStatus = 'failed';
      chassisStatus = 'partial';
    } else {
      jobStatus = 'failed';
      chassisStatus = 'error';
    }
  }

  const headline = buildHeadline(record, jobStatus, scanned, library, elapsedMs, diagnostics);
  const human_summary = buildHumanSummary(record, jobStatus, scanned, library, elapsedMs, diagnostics, exitCode);

  const actions: Action[] = [];
  if (jobStatus === 'running') {
    actions.push({
      tool: 'log10x_compile_status',
      args: { job_id: record.job_id },
      reason: 'still running; poll again for progress and the linked library',
    });
  } else if (jobStatus === 'completed' && producedSymbols) {
    actions.push({
      tool: 'log10x_validate',
      args: { extra_args: [['symbolPaths', record.output_folder]] },
      reason: 'smoke-test the compiled library against a few sample event lines (supply input_lines)',
    });
    if (library) {
      actions.push({
        tool: 'log10x_place_symbols',
        args: { library_path: library.path },
        reason: 'deliver the linked library to where the deployed receiver/reporter retrieves symbols (git commit + rollout, or hot-reload)',
        role: 'optional-followup',
      });
    }
  }

  return buildChassisEnvelope({
    tool: TOOL,
    view: 'summary',
    headline,
    status: chassisStatus,
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: `${record.runtime_name}_compile`,
      window_basis: 'explicit',
      candidates_count: scanned.unitCount,
      candidates_usable: scanned.libraries.length,
    },
    payload: {
      job_id: record.job_id,
      job_status: jobStatus,
      mode: record.mode,
      image: record.image ?? null,
      exit_code: exitCode,
      elapsed_ms: elapsedMs,
      timed_out: timedOut,
      sources: record.sources,
      output: {
        folder: record.output_folder,
        unit_count: scanned.unitCount,
        empty_unit_count: scanned.emptyUnitCount,
        library_files: scanned.libraries,
      },
      diagnostics,
      log_tail: tail,
    },
    human_summary,
    actions,
  });
}

function buildHeadline(
  record: CompileJobRecord,
  jobStatus: JobStatus,
  scanned: { unitCount: number },
  library: { path: string; bytes: number } | undefined,
  elapsedMs: number,
  diagnostics: ReturnType<typeof buildDiagnostics>,
): string {
  const failed = diagnostics.scan_health?.files_failed ?? 0;
  const failedClause = failed > 0 ? `, ${failed} file${failed === 1 ? '' : 's'} failed to scan` : '';
  const noun = record.kind === 'link' ? 'Link' : 'Compile';
  switch (jobStatus) {
    case 'running':
      return `${noun} job \`${record.job_id}\` running, ${humanDuration(elapsedMs)} elapsed, ${scanned.unitCount} unit${scanned.unitCount === 1 ? '' : 's'} so far${failedClause}. Poll again.`;
    case 'completed': {
      const lib = library ? `${library.path} (${humanByteSize(library.bytes)})` : 'no library';
      return scanned.unitCount > 0
        ? `${noun} job \`${record.job_id}\` done: ${scanned.unitCount} unit${scanned.unitCount === 1 ? '' : 's'} → ${lib}${failedClause}.`
        : `${noun} job \`${record.job_id}\` ran cleanly but produced no symbols from ${record.sources}.`;
    }
    case 'timed_out':
      return `${noun} job \`${record.job_id}\` timed out after ${humanDuration(elapsedMs)} (${scanned.unitCount} unit${scanned.unitCount === 1 ? '' : 's'} written). Raise timeout_ms or narrow the sources.`;
    case 'failed':
      return `${noun} job \`${record.job_id}\` failed${record.exit_code != null ? ` (exit ${record.exit_code})` : ''} after ${humanDuration(elapsedMs)}${failedClause}. See data.payload.log_tail.`;
  }
}

function buildHumanSummary(
  record: CompileJobRecord,
  jobStatus: JobStatus,
  scanned: { unitCount: number; emptyUnitCount: number },
  library: { path: string; bytes: number } | undefined,
  elapsedMs: number,
  diagnostics: ReturnType<typeof buildDiagnostics>,
  exitCode: number | null,
): string {
  const noun = record.kind === 'link' ? 'Link' : 'Compile';
  if (jobStatus === 'running') {
    const base = `${noun} job ${record.job_id} (${record.mode}) over ${record.sources} has been running ${humanDuration(elapsedMs)} and has written ${scanned.unitCount} symbol unit${scanned.unitCount === 1 ? '' : 's'} so far.`;
    const pace =
      record.kind === 'link'
        ? 'Linking is fast. Poll again shortly.'
        : 'First compiles of a large tree take 10–30 min.';
    return diagnostics.results_available
      ? `${base} ${scanFailureSentence(diagnostics)} Poll log10x_compile_status again for the final library and link report.`
      : `${base} The engine has not printed its results block yet. Poll again. ${pace}`;
  }

  const parts: string[] = [];
  if (jobStatus === 'completed') {
    parts.push(
      scanned.unitCount > 0
        ? `${noun} job ${record.job_id} completed via ${record.mode} in ${humanDuration(elapsedMs)}: ${scanned.unitCount} symbol unit${scanned.unitCount === 1 ? '' : 's'}${library ? `, linked to ${library.path} (${humanByteSize(library.bytes)})` : ', no library file'}.`
        : `${noun} job ${record.job_id} ran to completion via ${record.mode} but found no symbols in ${record.sources}. Confirm the sources hold supported source/binary files (extracted .class, not .jar).`,
    );
  } else if (jobStatus === 'timed_out') {
    parts.push(
      `${noun} job ${record.job_id} timed out after ${humanDuration(elapsedMs)} (cap ${humanDuration(record.timeout_ms)}); ${scanned.unitCount} unit${scanned.unitCount === 1 ? '' : 's'} were written before it was stopped. Raise timeout_ms or scope the sources smaller and start again.`,
    );
  } else {
    parts.push(
      `${noun} job ${record.job_id} failed${exitCode != null ? ` (exit ${exitCode})` : ''} via ${record.mode} after ${humanDuration(elapsedMs)}; it wrote ${scanned.unitCount} unit${scanned.unitCount === 1 ? '' : 's'}. Inspect data.payload.log_tail before using any partial library.`,
    );
  }
  if (scanned.emptyUnitCount > 0) {
    parts.push(
      `${scanned.emptyUnitCount} unit${scanned.emptyUnitCount === 1 ? ' was' : 's were'} emitted empty: every symbol filtered out (the default symbol.types keeps class/enum/log/exec only).`,
    );
  }
  if (diagnostics.results_available) {
    parts.push(scanFailureSentence(diagnostics));
    parts.push(linkReportSentence(diagnostics));
  }
  return parts.filter(Boolean).join(' ');
}

/** One sentence on scan failures, by language, with a sample. */
function scanFailureSentence(diagnostics: ReturnType<typeof buildDiagnostics>): string {
  const health = diagnostics.scan_health;
  if (!health || health.files_failed === 0) {
    return diagnostics.results_available ? 'No files failed to scan.' : '';
  }
  const byLang = topEntries(health.failed_by_language, 3)
    .map(([lang, n]) => `${lang} ${n}`)
    .join(', ');
  const sample = health.failure_samples[0];
  const sampleClause = sample ? ` Example: ${sample.name}, ${sample.reason}.` : '';
  return `${health.files_failed} file${health.files_failed === 1 ? '' : 's'} failed to scan (top: ${byLang}).${sampleClause}`;
}

/** One sentence on the link report, merge counts + the symbol-type mix. */
function linkReportSentence(diagnostics: ReturnType<typeof buildDiagnostics>): string {
  const link = diagnostics.link_report;
  if (!link) return '';
  const types = topEntries(link.symbols_by_type, 4)
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  const excluded =
    link.excluded_by_folder + link.excluded_by_file_name > 0
      ? ` (${link.excluded_by_folder + link.excluded_by_file_name} excluded by folder/name filters)`
      : '';
  return `Linked ${link.merged_files} unit file${link.merged_files === 1 ? '' : 's'}${excluded}${types ? `; symbols by type: ${types}` : ''}.`;
}
