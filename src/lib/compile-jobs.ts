/**
 * Compile job registry — the disk-backed state that lets the compiler tools
 * run a long compile asynchronously: `log10x_compile` spawns the engine
 * detached and writes a job record; `compile_status` reads the record back,
 * probes liveness, tails the log, and parses the engine's `printResults` JSON
 * once the run finishes.
 *
 * WHY DISK, NOT IN-MEMORY
 *
 * A compile of a large codebase runs 10–30 min. The MCP server can restart in
 * that window (config reload, crash, redeploy). A disk record keyed by job id,
 * plus liveness probed from the container name (docker) / pid (local), means
 * `compile_status` keeps working across a server restart — the running engine
 * is owned by dockerd / the OS process group, not by this Node process.
 *
 * WHY THE DOCKER RUN DROPS `--rm`
 *
 * The synchronous runner uses `--rm` because it awaits the client and reads
 * the exit code from it. Async can't await, so the container must survive its
 * own exit long enough for `compile_status` to read a TRUE exit code via
 * `docker inspect` and recover output via `docker logs` (even if the streaming
 * client died with an MCP restart). `compile_status` removes the container and
 * reaps the job dir once it has read a terminal state.
 *
 * SECRETS
 *
 * The job record NEVER holds credential values — only the env-var names that
 * were set. On a failed launch the engine dumps its resolved options (which
 * include credential values) to stderr; `redactSecrets` masks those by key
 * pattern, so a leaked token is scrubbed without this layer ever persisting
 * the value to disk.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Root for per-job state: overlays, the engine log, and the record file. */
const JOBS_ROOT = join(tmpdir(), 'log10x-mcp-compile', 'jobs');

/** What the engine writes per pull source the run touched. */
export type CompileJobKind = 'compile' | 'link';

/**
 * The persisted handle for one async engine run. Written by `log10x_compile`,
 * read by `compile_status`. Holds locations and liveness keys only — no
 * secret values.
 */
export interface CompileJobRecord {
  job_id: string;
  kind: CompileJobKind;
  mode: 'docker' | 'local';
  /** Docker image (docker mode) — for the status header. */
  image?: string;
  /** Container name — the docker-mode liveness + exit-code + log key. */
  container_name?: string;
  /** Child pid — the local-mode liveness key. */
  pid?: number;
  /** Stable per-source output folder (units + the linked `.10x.tar`). */
  output_folder: string;
  /** Expected linked library path under `output_folder`. */
  library_file: string;
  /** Engine stdout+stderr, streamed here by the detached client. */
  log_file: string;
  /** Per-job workspace (overlays + log + this record); reaped on completion. */
  job_dir: string;
  /** Pull-config overlay dir to clean once the run is terminal (if any). */
  overlay_dir?: string;
  /** Shared helm-home to clean once the run is terminal (if any). */
  helm_home_dir?: string;
  /** Epoch ms the run was spawned. */
  started_at: number;
  /** Wall-time cap in ms; `compile_status` flags a timed-out run past it. */
  timeout_ms: number;
  /** Human description of the sources, for the status headline. */
  sources: string;
  /** Compile runtimeName / library stem. */
  runtime_name: string;
  /**
   * Captured by `compile_status` the first time it observes a terminal run:
   * the engine exit code (docker; null when local/unknown). Its presence —
   * together with `ended_at` — marks the record terminal so later polls read
   * the outcome from the record without re-probing a removed container.
   */
  exit_code?: number | null;
  /** Epoch ms the run was first observed terminal. */
  ended_at?: number;
}

export function jobsRoot(): string {
  return JOBS_ROOT;
}

export function jobDir(jobId: string): string {
  return join(JOBS_ROOT, jobId);
}

function jobRecordPath(jobId: string): string {
  return join(jobDir(jobId), 'job.json');
}

/** Persist the record atomically enough for a single-writer (log10x_compile). */
export async function writeJobRecord(record: CompileJobRecord): Promise<void> {
  await mkdir(record.job_dir, { recursive: true });
  await writeFile(jobRecordPath(record.job_id), JSON.stringify(record, null, 2), 'utf8');
}

/** Read a record back, or null if the id is unknown / the record is gone. */
export async function readJobRecord(jobId: string): Promise<CompileJobRecord | null> {
  try {
    const raw = await readFile(jobRecordPath(jobId), 'utf8');
    return JSON.parse(raw) as CompileJobRecord;
  } catch {
    return null;
  }
}

/** Terminal vs in-flight state of the underlying engine process. */
export interface LivenessResult {
  /** running = still going; exited = finished (exitCode set in docker mode); gone = process/container no longer known. */
  state: 'running' | 'exited' | 'gone';
  /** Engine exit code when known (docker `inspect` only); null otherwise. */
  exitCode: number | null;
}

/**
 * Probe a docker container's State via `docker inspect`. Because the async
 * spawn omits `--rm`, an exited container is still inspectable for its true
 * exit code. A removed/unknown container reports `gone`.
 */
export async function probeDockerContainer(containerName: string): Promise<LivenessResult> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', containerName],
      { timeout: 10_000 },
    );
    const [status, code] = stdout.trim().split(/\s+/);
    if (status === 'running' || status === 'created' || status === 'restarting') {
      return { state: 'running', exitCode: null };
    }
    // exited / dead / paused — treat as terminal and surface the exit code.
    const exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
    return { state: 'exited', exitCode };
  } catch {
    // `No such object` (removed) or the docker CLI is unavailable.
    return { state: 'gone', exitCode: null };
  }
}

/**
 * Probe a local process by pid. `kill(pid, 0)` throws ESRCH when the process
 * is gone and EPERM when it exists but is owned by another user (still alive).
 * Local mode can't recover a true exit code post-hoc, so a dead pid reports
 * `exited` with a null code — the caller infers success from the output.
 */
export function probeLocalPid(pid: number): LivenessResult {
  try {
    process.kill(pid, 0);
    return { state: 'running', exitCode: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      return { state: 'running', exitCode: null };
    }
    return { state: 'exited', exitCode: null };
  }
}

/**
 * Recover the engine log for a job. Prefers the streamed log file; falls back
 * to `docker logs <container>` when the file is empty/missing (the streaming
 * client died — typically an MCP restart mid-run). Always redacted.
 */
export async function readJobLog(record: CompileJobRecord): Promise<string> {
  let text = '';
  try {
    text = await readFile(record.log_file, 'utf8');
  } catch {
    text = '';
  }
  if (text.trim().length === 0 && record.mode === 'docker' && record.container_name) {
    try {
      const { stdout, stderr } = await execFileAsync('docker', ['logs', record.container_name], {
        timeout: 15_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      text = `${stdout}\n${stderr}`;
    } catch {
      // container removed / docker gone — nothing to recover
    }
  }
  return redactSecrets(text);
}

/** Last `n` non-empty lines of an already-redacted log. */
export function tailLines(text: string, n: number): string[] {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n);
}

/**
 * Mask credential values by KEY pattern — independent of the value, so nothing
 * secret has to be persisted to match against. Catches the engine's
 * resolved-option dump on a failed launch (`githubPullToken=...`,
 * `dockerPassword: ...`, `ARTIFACTORY_TOKEN=...`) and Authorization headers.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /\b([A-Za-z_]*(?:token|password|secret|passwd|apikey|api_key)[A-Za-z_]*)(\s*[=:]\s*)(\S+)/gi,
      '$1$2***',
    )
    // Authorization values are multi-token (`Bearer <jwt>`), so mask to EOL.
    .replace(/\b(Authorization\s*:\s*).*/gi, '$1***');
}

// ── printResults parsing ────────────────────────────────────────────────────

/** Per-language scan-failure counts + capped samples (engine `ScanHealth`). */
export interface ScanHealth {
  filesFailed: number;
  failedByLanguage: Record<string, number>;
  failureSamples: Array<{ name: string; language: string; reason: string }>;
}

/** Merge/exclude counters + symbol-type histogram (engine `LinkReport`). */
export interface LinkReport {
  mergedFilesSize: number;
  skippedFilesSize: number;
  excludedByFolder: number;
  excludedByFileName: number;
  mergedRepos: string[];
  nonMergedRepos: string[];
  symbolsByType: Record<string, number>;
  symbolsExcludedByType: number;
}

/** One phase row of the engine `printResults` JSON (a scan/link producer). */
export interface CompilePhase {
  operation?: string;
  status?: string;
  traversedFiles?: number;
  scannedFiles?: number;
  outputFiles?: number;
  warns?: number;
  errors?: number;
  /** Present only on a compiler-10x image carrying the diagnostics change. */
  scanHealth?: ScanHealth;
  /** Present only on a compiler-10x image carrying the diagnostics change. */
  linkReport?: LinkReport;
}

/** The engine `printResults` document (ScanObserverOutput). */
export interface CompileResultsDoc {
  inputPathsSet?: string[];
  outputPathsSet?: string[];
  success?: boolean;
  phases?: CompilePhase[];
}

/**
 * Pull the engine's `printResults` JSON out of the captured log. The console
 * appender prints it as one pretty-printed object (keys inputPathsSet /
 * outputPathsSet / success / phases). We brace-match the LAST balanced object
 * that parses and carries a `phases` key, so a console log-line prefix or
 * trailing progress lines don't defeat it. Returns null until the run has
 * printed results (i.e. reached the report phase).
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function parseCompileResults(logText: string): CompileResultsDoc | null {
  // Scan every '{' that follows a `"phases"` mention and brace-match outward,
  // taking the last one that parses — the report is printed once, near the end.
  let result: CompileResultsDoc | null = null;
  let searchFrom = 0;
  while (true) {
    const phasesAt = logText.indexOf('"phases"', searchFrom);
    if (phasesAt < 0) break;
    searchFrom = phasesAt + 1;
    const open = logText.lastIndexOf('{', phasesAt);
    if (open < 0) continue;
    const candidate = matchBalanced(logText, open);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as CompileResultsDoc;
      if (Array.isArray(parsed.phases)) result = parsed;
    } catch {
      // Not the object we want (the chosen '{' wasn't the document root).
    }
  }
  return result;
}

/** Return the substring from `open` ('{') to its matching '}', or null. */
function matchBalanced(text: string, open: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Remove a job's container (best-effort) and delete its workspace (overlays,
 * log, record). Called once `compile_status` has read a terminal state, so the
 * run's resources don't accumulate across many compiles.
 */
export async function reapJob(record: CompileJobRecord): Promise<void> {
  if (record.mode === 'docker' && record.container_name) {
    await execFileAsync('docker', ['rm', '-f', record.container_name], { timeout: 15_000 }).catch(
      () => {},
    );
  }
  // The helm-home is its own temp dir (prep ran pre-step containers into it),
  // outside the job dir, so reap it explicitly. The overlay dir lives INSIDE
  // the job dir and goes with it.
  if (record.helm_home_dir) {
    await rm(record.helm_home_dir, { recursive: true, force: true }).catch(() => {});
  }
  await rm(record.job_dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Free a terminated run's heavy resources — remove the container and the pull
 * overlays / helm-home it no longer needs — but KEEP the job dir (log + record)
 * and the output folder. Called by `compile_status` the first time it captures
 * a terminal outcome, so the container doesn't linger while repeat polls and
 * the compiled library stay readable.
 */
export async function removeJobContainer(record: CompileJobRecord): Promise<void> {
  if (record.mode === 'docker' && record.container_name) {
    await execFileAsync('docker', ['rm', '-f', record.container_name], { timeout: 15_000 }).catch(
      () => {},
    );
  }
  if (record.overlay_dir) {
    await rm(record.overlay_dir, { recursive: true, force: true }).catch(() => {});
  }
  if (record.helm_home_dir) {
    await rm(record.helm_home_dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Spawn a detached process with stdout+stderr redirected to `logPath`, fully
 * decoupled from this process's event loop (no retained pipes). Returns the
 * child pid. Used by the runner's async spawn for both docker and local.
 */
export async function spawnToLog(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; logPath: string },
): Promise<number> {
  const { openSync, closeSync } = await import('node:fs');
  // The job dir may not exist yet (a local-source compile writes no overlay,
  // and the record is persisted only after the spawn) — create it first.
  await mkdir(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, 'a');
  try {
    const child = spawn(cmd, args, {
      env: opts.env || process.env,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    child.unref();
    return child.pid ?? -1;
  } finally {
    closeSync(fd);
  }
}
