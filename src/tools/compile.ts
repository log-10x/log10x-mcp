/**
 * log10x_compile — run the Log10x Compiler app to generate a symbol library.
 *
 * Scans a local folder of source code / binaries with the CLOUD-flavor
 * Compiler app (`tenx @apps/compiler`) and writes a symbol library — per-file
 * `.10x.json` units plus a linked `.10x.tar` — that the 10x runtime later uses
 * to assign hidden classes (TenXTemplates) to events.
 *
 * Backend: Docker-first. By default it runs the cloud image
 * log10x/compiler-10x (which is cloud-flavor by construction); if the caller
 * has a local CLOUD-flavor `tenx` it can use that instead. The Edge (native /
 * JIT) flavor cannot compile and is refused with a clear remediation.
 *
 * v1 scope: a single local source folder in, local artifacts out — no remote
 * pull (GitHub / Helm / Docker image) and no push/distribution. Those are
 * additive: the runner's CompileConfig descriptor carries the seams.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type StructuredOutput, type Action } from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  type ChassisStatus,
} from '../lib/chassis-envelope.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import {
  runCompile,
  NotCloudFlavorError,
  type CompileConfig,
  type CompileRunResult,
} from '../lib/compile-runner.js';
import { DevCliNotInstalledError, DockerNotAvailableError } from '../lib/dev-cli.js';

const TOOL = 'log10x_compile';

export const compileSchema = {
  source_path: z
    .string()
    .describe(
      'Absolute path to the local folder of source code / binaries to scan. The compiler recursively traverses it for supported languages (Java, Go, Python, JS/TS, Scala, C/C++, C#) and binaries. Note: .jar files are not scanned directly — provide extracted .class files.',
    ),
  output_path: z
    .string()
    .optional()
    .describe(
      'Absolute path where the symbol library is written (the .10x.json units and the linked .10x.tar). Defaults to a fresh temp directory, returned in the result as data.payload.output.folder.',
    ),
  library_name: z
    .string()
    .default('symbols')
    .describe(
      'Base name for the linked .10x.tar library file and the compile runtimeName. Sanitized to [A-Za-z0-9_.-].',
    ),
  mode: z
    .enum(['auto', 'docker', 'local'])
    .default('auto')
    .describe(
      'Execution backend. `auto` (default) prefers Docker (cloud image, guaranteed cloud flavor) and falls back to a local cloud-flavor tenx. `docker` forces the image (LOG10X_COMPILER_IMAGE or LOG10X_TENX_IMAGE, default log10x/compiler-10x:latest). `local` forces the binary (LOG10X_TENX_PATH or `tenx` on PATH) and refuses if it is not the cloud flavor. A local install provides only the compiler engine; local-folder compilation (this tool) works with it, but full capabilities — pulling source from GitHub/Helm/Docker registries — additionally require `git`/`docker`/`helm` on the host. The docker `compiler-10x` image bundles all of those, which is why Docker is the default.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(1_800_000)
    .describe(
      'Hard cap on compile wall time in milliseconds. Default 1,800,000 (30 min) — the first compile of a large codebase typically runs 10–30 min; subsequent runs are near-instant via checksum reuse.',
    ),
};

interface CompileArgs {
  source_path: string;
  output_path?: string;
  library_name: string;
  mode: 'auto' | 'docker' | 'local';
  timeout_ms: number;
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : 'symbols';
}

function defaultOutputDir(runtimeName: string): string {
  return join(tmpdir(), 'log10x-mcp-compile', `${runtimeName}-${Date.now()}-${process.pid}`, 'symbols');
}

/** Last `n` non-empty lines of the combined engine log, for the result. */
function logTail(result: CompileRunResult, n: number): string[] {
  const merged = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return merged.slice(-n);
}

function humanByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function executeCompile(args: CompileArgs): Promise<string | StructuredOutput> {
  // ── 1. Validate the source folder ──
  let srcStat;
  try {
    srcStat = await fs.stat(args.source_path);
  } catch {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `source_path does not exist: ${args.source_path}. Pass an absolute path to a folder of source code / binaries.`,
      },
    });
  }
  if (!srcStat.isDirectory()) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `source_path must be a directory, not a file: ${args.source_path}.`,
      },
    });
  }

  // ── 2. Build the compile config ──
  const runtimeName = sanitizeName(args.library_name);
  const outputFolder = resolve(args.output_path ?? defaultOutputDir(runtimeName));
  const cfg: CompileConfig = {
    inputs: [{ kind: 'local', path: resolve(args.source_path) }],
    output: {
      folder: outputFolder,
      libraryFile: join(outputFolder, `${runtimeName}.10x.tar`),
      runtimeName,
    },
    license: process.env.TENX_LICENSE_KEY || process.env.LOG10X_LICENSE_KEY || undefined,
    timeoutMs: args.timeout_ms,
  };

  // ── 3. Run, mapping precondition failures to branchable envelopes ──
  let result: CompileRunResult;
  try {
    result = await runCompile(cfg, { modeOverride: args.mode });
  } catch (e) {
    if (
      e instanceof DevCliNotInstalledError ||
      e instanceof DockerNotAvailableError ||
      e instanceof NotCloudFlavorError
    ) {
      return buildNotConfiguredEnvelope({ tool: TOOL, kind: 'generic', remediation: e.message });
    }
    throw e;
  }

  // ── 4. Shape the result ──
  const { exitCode, timedOut, output } = result;
  const producedSymbols = output.unitCount > 0 || output.libraries.length > 0;
  const ok = exitCode === 0;

  const library = output.libraries[0];
  const libraryDesc = library ? `${library.path} (${humanByteSize(library.bytes)})` : 'none';
  const payload = {
    mode: result.mode,
    image: result.image ?? null,
    flavor: result.flavor ?? null,
    flavor_verified: result.flavorVerified,
    exit_code: exitCode,
    timed_out: timedOut,
    wall_time_ms: result.wallTimeMs,
    source_path: cfg.inputs[0].path,
    output: {
      folder: output.folder,
      unit_count: output.unitCount,
      library_files: output.libraries,
    },
    log_tail: logTail(result, 40),
  };

  if (!ok && !producedSymbols) {
    // Hard failure — engine exited non-zero and wrote nothing.
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: timedOut ? 'backend_timeout' : 'local_processing_failed',
        retryable: timedOut,
        suggested_backoff_ms: null,
        hint: timedOut
          ? `Compile timed out after ${args.timeout_ms}ms. Raise timeout_ms or scope source_path to a smaller tree.`
          : `Compiler (${result.mode}) exited ${exitCode} with no symbols produced. See data.payload.log_tail.`,
      },
      contextPayload: payload,
    });
  }

  const status: ChassisStatus = ok ? (producedSymbols ? 'success' : 'no_signal') : 'partial';
  const headline = ok
    ? producedSymbols
      ? `Compiled ${output.unitCount} symbol unit${output.unitCount === 1 ? '' : 's'} → ${libraryDesc}.`
      : `Compiler ran cleanly but produced no symbols from ${cfg.inputs[0].path} — check the source folder contains supported file types.`
    : `Compiler exited ${exitCode} with partial output (${output.unitCount} unit${output.unitCount === 1 ? '' : 's'}). See data.payload.log_tail.`;

  const human_summary = ok
    ? producedSymbols
      ? `Compiled ${output.unitCount} symbol unit${output.unitCount === 1 ? '' : 's'} from ${cfg.inputs[0].path} into ${output.folder} via ${result.mode} in ${result.wallTimeMs}ms${library ? `, linked to ${library.path}` : ''}.`
      : `The compiler ran to completion via ${result.mode} but found no symbols in ${cfg.inputs[0].path}. Confirm the folder holds supported source/binary files (extracted .class, not .jar).`
    : `The compiler exited ${exitCode} via ${result.mode} but still wrote ${output.unitCount} unit${output.unitCount === 1 ? '' : 's'} to ${output.folder}. Treat as partial; inspect data.payload.log_tail before using the library.`;

  // Next step: smoke-test the freshly compiled library against sample events
  // by pointing the validate tool's symbolPaths at the output folder.
  const actions: Action[] =
    ok && producedSymbols
      ? [
          {
            tool: 'log10x_validate',
            args: { extra_args: [['symbolPaths', output.folder]] },
            reason: 'smoke-test the compiled symbol library against a few sample event lines (supply input_lines)',
          },
        ]
      : [];

  return buildChassisEnvelope({
    tool: TOOL,
    view: 'summary',
    headline,
    status,
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: 'local_compile',
      window_basis: 'explicit',
      candidates_count: output.unitCount,
      candidates_usable: output.libraries.length,
    },
    payload,
    human_summary,
    actions,
  });
}
