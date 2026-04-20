/**
 * Batch-prettify raw snake_case pattern identities into 3-5-word
 * human-readable names via **MCP sampling**.
 *
 * The MCP sampling API (`server.createMessage`) asks the host — the same
 * chat app the user is already in (Claude Desktop, Cursor, etc.) — to
 * run the prompt through *its* LLM using the user's existing
 * credentials. No Log10x-side endpoint, no egress to our infrastructure,
 * no extra API key. The user's host does whatever privacy + compliance
 * enforcement they already trust.
 *
 * When the host doesn't support sampling (capability probe fails or the
 * `createMessage` call throws), fail-soft back to raw identities plus a
 * one-line appendix note. The report still renders — just less pretty.
 *
 * Design note: we send templated pattern identities (variable values
 * already stripped by the templater) along with severity + service.
 * No raw log content. Far lower sensitivity than the paste Lambda,
 * which sent raw log lines.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const PROMPT_HEADER = [
  'You are generating short human-readable names for log event patterns.',
  'Each row below is one templatized pattern — variable values have been replaced with underscores.',
  'Your job: produce a 3-5-word title-case name for each pattern.',
  '',
  'Rules:',
  '  - Focus on the specific class, method, or operation. Do NOT use the service name (users already know the service).',
  '  - Look for CamelCase class names, method names, HTTP verbs, queue/cache operations, error types.',
  '  - Every pattern MUST get a DIFFERENT name. No repeats.',
  '  - Respond with EXACTLY one line per data row, numbered from 1, in the form:',
  '      INDEX | NAME',
  '  - No header row, no commentary, no markdown — just one `INDEX | NAME` line per pattern.',
  '',
  'Patterns:',
].join('\n');

const LINE_RE = /^(\d+)\s*\|\s*(.+)$/;

export interface PrettifyInput {
  identity: string; // snake_case identity — the key we return against
  service?: string;
  severity?: string;
  count: number;
  bytes: number;
}

export interface PrettifyOptions {
  /**
   * The MCP server instance. Sampling is a server-side capability.
   * When undefined (e.g., server not yet bound to a transport), the
   * call fails-soft to "not available."
   */
  server?: McpServer;
  /** Timeout in ms for the sampling round-trip. Default 30s. */
  timeoutMs?: number;
  /** Max tokens the host is allowed to generate. Default scales with input. */
  maxTokens?: number;
}

export interface PrettifyResult {
  /** identity → pretty name. Missing entries mean the model didn't return one. */
  names: Record<string, string>;
  /** Short reason string when the call failed or returned nothing. */
  errorNote?: string;
}

/**
 * Ask the MCP host's LLM to generate pretty names for a batch of pattern
 * identities. Always returns; never throws.
 */
export async function prettifyPatterns(
  patterns: PrettifyInput[],
  opts: PrettifyOptions
): Promise<PrettifyResult> {
  if (patterns.length === 0) return { names: {} };
  if (!opts.server) {
    return {
      names: {},
      errorNote: 'MCP server handle not available — sampling skipped.',
    };
  }

  // Cheap capability probe: if the host didn't advertise sampling, bail
  // fast with a clear note rather than waiting for a request error.
  const clientCaps = opts.server.server.getClientCapabilities?.();
  if (clientCaps && !clientCaps.sampling) {
    return {
      names: {},
      errorNote:
        'MCP host does not advertise the `sampling` capability. ' +
        'Pattern names remain as raw identities. ' +
        '(Hosts that support sampling: Claude Desktop, Claude Code. Cursor + others vary.)',
    };
  }

  const csv = buildCsv(patterns);
  const prompt = `${PROMPT_HEADER}\n${csv}\n\nRespond now with ${patterns.length} lines:`;

  // Budget ~20 tokens per pattern (3-5 words × ~3 tokens + formatting).
  const maxTokens = opts.maxTokens ?? Math.max(256, patterns.length * 25);

  try {
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), opts.timeoutMs ?? 30_000);

    const res = await opts.server.server.createMessage(
      {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: prompt },
          },
        ],
        maxTokens,
        // Request a small / fast model if the host lets us pick.
        modelPreferences: {
          hints: [{ name: 'claude-3-5-haiku' }, { name: 'haiku' }],
          speedPriority: 0.7,
          intelligencePriority: 0.3,
        },
        systemPrompt:
          'You produce concise, task-specific names. Reply with exactly the requested number of `INDEX | NAME` lines and nothing else.',
      },
      { signal: abort.signal }
    );
    clearTimeout(t);

    const content = res.content;
    const aiText = content.type === 'text' ? content.text.trim() : '';
    if (!aiText) {
      return { names: {}, errorNote: 'Sampling returned non-text or empty content.' };
    }

    const names: Record<string, string> = {};
    for (const line of aiText.split('\n')) {
      const m = LINE_RE.exec(line.trim());
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      const name = m[2].trim();
      if (idx >= 0 && idx < patterns.length && name) {
        names[patterns[idx].identity] = name;
      }
    }
    if (Object.keys(names).length === 0) {
      return {
        names: {},
        errorNote: 'Sampling response did not match the expected `INDEX | NAME` format.',
      };
    }
    return { names };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return {
      names: {},
      errorNote: `Sampling call failed: ${msg.slice(0, 200)}`,
    };
  }
}

/**
 * CSV-ish serialization the model can scan row-by-row. Columns: INDEX,
 * pattern (underscores-to-spaces for readability), severity, service.
 */
function buildCsv(patterns: PrettifyInput[]): string {
  const lines = ['INDEX | PATTERN | SEVERITY | SERVICE'];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const display = p.identity.replace(/_/g, ' ').slice(0, 200);
    lines.push(`${i + 1} | ${display} | ${p.severity || '-'} | ${p.service || '-'}`);
  }
  return lines.join('\n');
}
