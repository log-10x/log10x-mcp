/**
 * MCP app runner: feed raw event lines to the tenx `@apps/mcp-file` app
 * and return parsed templates + encoded events + aggregated rows.
 *
 * Wraps `runDevCliFileOutput` from dev-cli.ts with:
 *   - automatic unique `runtimeName` generation
 *   - output file parsing via cli-output-parser
 *   - temp-dir cleanup on success or error
 *   - configurable timeout
 *
 * Used by `log10x_measure_compaction` to feed SIEM-fetched events through
 * the engine and measure real compaction ratios from the resulting
 * `encoded.log` byte counts.
 */

import { rm } from 'fs/promises';
import { runDevCliFileOutput, DevCliNotInstalledError } from './dev-cli.js';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
  type Template,
  type EncodedEvent,
  type AggregatedRow,
} from './cli-output-parser.js';

export interface McpAppRunnerResult {
  templates: Map<string, Template>;
  encodedLines: EncodedEvent[];
  aggregatedRows: AggregatedRow[];
  wallTimeMs: number;
  runtimeName: string;
}

export interface McpAppRunnerOptions {
  /** Wall-clock timeout in milliseconds. Default 300,000ms (5 minutes). */
  timeoutMs?: number;
  /**
   * Unique name for the /tmp/log10x-mcp-pull/<name> output directory.
   * Defaults to `measure-<timestamp>-<pid>`.
   */
  runtimeName?: string;
}

/**
 * Pipe `events` (newline-separated raw log lines) through tenx
 * `@apps/mcp-file`, then parse and return the three artifact files.
 *
 * Cleans up the temp dir before returning (both on success and error).
 * The caller does not need to manage the `/tmp/log10x-mcp-pull/<name>/`
 * directory.
 */
export async function runMcpAppOnEvents(
  events: string[],
  opts: McpAppRunnerOptions = {},
): Promise<McpAppRunnerResult> {
  if (events.length === 0) {
    return {
      templates: new Map(),
      encodedLines: [],
      aggregatedRows: [],
      wallTimeMs: 0,
      runtimeName: opts.runtimeName ?? `measure-${Date.now()}-${process.pid}`,
    };
  }

  const runtimeName = opts.runtimeName ?? `measure-${Date.now()}-${process.pid}`;
  const rawLogText = events.join('\n');

  let tempDir: string | undefined;
  try {
    const result = await runDevCliFileOutput(rawLogText, runtimeName);
    tempDir = result.tempDir;

    const templates = parseTemplates(result.templatesJson);
    const encodedLines = parseEncoded(result.encodedLog);
    const aggregatedRows = parseAggregated(result.aggregatedCsv);

    return {
      templates,
      encodedLines,
      aggregatedRows,
      wallTimeMs: result.wallTimeMs,
      runtimeName,
    };
  } catch (e) {
    // Re-throw DevCliNotInstalledError as-is — caller needs to distinguish
    // this case to emit a user-actionable message.
    if (e instanceof DevCliNotInstalledError) throw e;
    throw new Error(
      `tenx @apps/mcp-file run failed for runtimeName=${runtimeName}: ${(e as Error).message}`
    );
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
