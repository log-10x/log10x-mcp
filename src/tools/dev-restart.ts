/**
 * log10x_dev_restart — forcibly exit the MCP server process so the
 * host respawns a fresh instance with an updated build.
 *
 * ONLY registered when LOG10X_DEV_MODE=true is set at server startup.
 * Never visible in production tool listings.
 *
 * Usage: call with no arguments. The tool returns a confirmation
 * envelope and schedules process.exit(0) 100ms later so the response
 * can be flushed to the MCP host before the process disappears.
 * After the respawn, re-fetch tool schemas — the new process may have
 * a different tool set if the build changed.
 */

import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const devRestartSchema = {};

export function executeDevRestart(): StructuredOutput {
  const envelope = buildEnvelope({
    tool: 'log10x_dev_restart',
    view: 'summary',
    summary: {
      headline: 'MCP server restarting in 100ms. Re-load tool schemas after respawn.',
    },
    data: {},
    actions: [],
  });

  // Schedule exit after the envelope has been returned and serialised by
  // the MCP transport layer. 100ms is enough for the stdio flush.
  setTimeout(() => process.exit(0), 100);

  return envelope;
}
