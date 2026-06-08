/**
 * log10x_validate — test-drive Log10x pipeline config changes locally.
 *
 * Workflow this tool enables:
 *
 *   1. Agent drafts a new JS module (e.g. a GeoRefCityObject-style
 *      constructor, a groupFilter helper, or a full stream.yaml override).
 *   2. Agent synthesizes 3-20 sample event lines that represent the shape
 *      the change needs to handle (from natural-language intent, or by
 *      copying observed production samples).
 *   3. Agent calls log10x_validate with the draft + samples.
 *   4. Tool runs the local `tenx @apps/mcp` CLI against the input, captures
 *      emitted templates + encoded events + stdout (including any
 *      TenXConsole.log the JS emitted for inspection) + stderr.
 *   5. Tool returns structured output. Agent decides whether to proceed to
 *      deploy, iterate, or discard.
 *
 * Runs fully local — no network, no cluster access, no persistence.
 * Requires a local `tenx` CLI install and the workspace config tree on
 * disk (see `LOG10X_TENX_CONFIG_ROOT` / `LOG10X_TENX_MODULES_ROOT`).
 *
 * Intended callers: agents preparing PRs to the config repo or proposing
 * engine-adjacent JS changes. NOT a general "run my log pipeline" tool —
 * use the existing log10x_resolve_batch (privacy_mode=true) for that.
 */

import { z } from 'zod';
import { runValidate } from '../lib/validate-runner.js';
import { DevCliNotInstalledError } from '../lib/dev-cli.js';

export const validateSchema = {
  input_lines: z
    .array(z.string())
    .min(1)
    .max(500)
    .describe(
      'Sample event lines piped to the pipeline via stdin, one line per event. 3-20 lines is typical. Caller is responsible for generating realistic shapes — e.g., if testing a timestamp filter, include events with timestamps straddling the filter boundary.'
    ),
  extra_files: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Map of path → file contents, overlaid on the shipped config tree. Paths starting with `config/` land under `${LOG10X_TENX_CONFIG_ROOT}`, paths starting with `modules/` land under `${LOG10X_TENX_MODULES_ROOT}`, everything else defaults to the config tree. Examples: `pipelines/run/initialize/custom/my-debug.js` (auto-discovered by @apps/mcp), `apps/cloud/streamer/stream/my-filter.js` (for streamer testing). Mounted files OVERRIDE any shipped file at the same path.'
    ),
  pipeline_app: z
    .string()
    .default('@apps/mcp')
    .describe(
      'Launch config to invoke. Default `@apps/mcp` — the stdin/stdout scaffold shipped alongside this tool. Set to a different `@apps/...` path (e.g. `@apps/dev`) to exercise a different pipeline shape. The named app MUST be on the CLI config search path.'
    ),
  extra_args: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .describe(
      'Additional `key value` CLI args appended to `tenx @<app>`. Each element is a [key, value] pair. Examples: `[["stdoutWriteObjects", "false"]]` to suppress object encoding, `[["symbolPaths", "/my/symbols"]]` to override the symbol path.'
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(60_000)
    .describe(
      'Hard cap on CLI wall time in milliseconds. Default 60s. Killed with SIGTERM if exceeded.'
    ),
};

interface ValidateArgs {
  input_lines: string[];
  extra_files?: Record<string, string>;
  pipeline_app: string;
  extra_args?: Array<[string, string]>;
  timeout_ms: number;
}

export async function executeValidate(args: ValidateArgs): Promise<string> {
  let result;
  try {
    result = await runValidate({
      input_lines: args.input_lines,
      extra_files: args.extra_files,
      pipeline_app: args.pipeline_app,
      extra_args: args.extra_args,
      timeout_ms: args.timeout_ms,
    });
  } catch (e) {
    if (e instanceof DevCliNotInstalledError) return e.message;
    throw e;
  }

  const lines: string[] = [];
  lines.push(`## log10x_validate`);
  lines.push('');
  lines.push(`**Pipeline**: \`${args.pipeline_app}\``);
  lines.push(`**Input events**: ${args.input_lines.length}`);
  lines.push(`**Exit code**: ${result.exitCode}`);
  lines.push(`**Wall time**: ${result.wallTimeMs}ms`);
  if (result.cliVersion) lines.push(`**CLI**: ${result.cliVersion}`);
  lines.push('');

  if (result.exitCode !== 0) {
    lines.push(`### ⚠ Non-zero exit`);
    lines.push('');
    lines.push('Pipeline did not run to completion. Check `stderr` below.');
    lines.push('');
  }

  if (result.consoleLines.length > 0) {
    lines.push(`### TenXConsole output (${result.consoleLines.length} lines)`);
    lines.push('');
    lines.push('```');
    for (const l of result.consoleLines.slice(0, 60)) lines.push(l);
    if (result.consoleLines.length > 60) {
      lines.push(`… ${result.consoleLines.length - 60} more lines elided`);
    }
    lines.push('```');
    lines.push('');
  }

  if (result.templates.length > 0) {
    lines.push(`### Templates (${result.templates.length})`);
    lines.push('');
    lines.push('| templateHash | template |');
    lines.push('|---|---|');
    for (const t of result.templates.slice(0, 50)) {
      lines.push(`| \`${t.templateHash}\` | \`${t.template.replace(/\|/g, '\\|')}\` |`);
    }
    lines.push('');
  }

  if (result.events.length > 0) {
    lines.push(`### Events (${result.events.length})`);
    lines.push('');
    lines.push('| # | templateHash | tokens |');
    lines.push('|---|---|---|');
    for (let i = 0; i < Math.min(result.events.length, 50); i++) {
      const e = result.events[i];
      lines.push(
        `| ${i} | \`${e.templateHash}\` | ${e.tokens
          .slice(0, 8)
          .map((t) => `\`${t}\``)
          .join(', ')}${e.tokens.length > 8 ? '…' : ''} |`,
      );
    }
    lines.push('');
  }

  if (result.stderr.trim().length > 0) {
    lines.push(`### stderr`);
    lines.push('');
    lines.push('```');
    const trimmed = result.stderr.trim();
    lines.push(trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n… (truncated)' : trimmed);
    lines.push('```');
    lines.push('');
  }

  if (
    result.exitCode === 0 &&
    result.events.length === 0 &&
    result.templates.length === 0 &&
    result.consoleLines.length <= 5
  ) {
    lines.push(
      `**Note**: Pipeline exited cleanly but produced no events, templates, or console output. Either the sample input didn't match any pipeline expectations, or mounted code dropped every event without logging. Check mounted \`shouldLoad\` predicates.`,
    );
  }

  return lines.join('\n');
}
