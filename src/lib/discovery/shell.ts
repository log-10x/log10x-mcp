/**
 * Safe shell helper for the discovery probes.
 *
 * Rules:
 *   - Never interpolate user strings into a shell; always pass argv.
 *   - Always cap wall-time with a timeout; probes run from an MCP tool
 *     that the agent blocks on, so a hung kubectl is an outage.
 *   - Return structured {stdout, stderr, exitCode, ms} — no throwing
 *     on non-zero exit. Callers decide what a failure means
 *     (e.g., `aws sts` failing ≠ a bug; it just means AWS isn't configured).
 */

import { spawn } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
  /** The argv we ran, joined for display. Safe to log — no secrets here. */
  cmd: string;
  /** True if we killed the process for exceeding the timeout. */
  timedOut: boolean;
}

export interface RunOpts {
  /** Hard wall-time cap, milliseconds. Default 10_000. */
  timeoutMs?: number;
  /** Extra env vars to set for the child. Merged on top of process.env. */
  env?: Record<string, string>;
  /** If true, stdout > this many bytes is truncated. Default 2MB. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Run a command with structured argv. Never passes through a shell.
 *
 *   await run('kubectl', ['get', 'pods', '-n', 'demo'])
 */
export function run(bin: string, args: string[], opts: RunOpts = {}): Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const started = Date.now();
  const cmd = `${bin} ${args.join(' ')}`;

  return new Promise<ShellResult>((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\n[spawn-error] ${err.message}`,
        exitCode: -1,
        ms: Date.now() - started,
        cmd,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        ms: Date.now() - started,
        cmd,
        timedOut,
      });
    });
  });
}

/** Same as run(), but parse stdout as JSON. Returns undefined on non-zero exit or parse error. */
export async function runJson<T = unknown>(
  bin: string,
  args: string[],
  opts: RunOpts = {}
): Promise<{ result: ShellResult; parsed?: T }> {
  const result = await run(bin, args, opts);
  if (result.exitCode !== 0) return { result };
  try {
    return { result, parsed: JSON.parse(result.stdout) as T };
  } catch {
    return { result };
  }
}
