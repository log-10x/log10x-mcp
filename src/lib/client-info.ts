/**
 * The MCP client's product name and version from an `initialize` request,
 * for the hosted demo's session-open log line only (SOC 2 ruling,
 * 2026-11-13): name and version, nothing else from initialize (no title,
 * websiteUrl, icons or capabilities, no IP, no headers), each cut to 64
 * characters, a field left out when absent or not a string. Never sent to
 * self-telemetry or PostHog, and never logged on a user's own install: the
 * only caller is the Streamable HTTP server's session-open handler.
 *
 * Why: on 2026-11-13 an outside AI agent used the demo for seven minutes and
 * nothing recorded which client it was.
 */
const MAX_LEN = 64;

export function clientInfoFields(initializeBody: unknown): { client_name?: string; client_version?: string } {
  const info = (initializeBody as { params?: { clientInfo?: Record<string, unknown> } } | null)?.params?.clientInfo;
  if (!info || typeof info !== 'object') return {};
  const out: { client_name?: string; client_version?: string } = {};
  if (typeof info.name === 'string' && info.name !== '') out.client_name = info.name.slice(0, MAX_LEN);
  if (typeof info.version === 'string' && info.version !== '') out.client_version = info.version.slice(0, MAX_LEN);
  return out;
}
