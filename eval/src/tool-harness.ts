/**
 * ToolHarness — abstracts how the autonomous runner discovers tool
 * declarations and executes tool calls. Two implementations:
 *
 *   1. InProcessToolHarness — calls the build/tools/*.js execute
 *      functions directly via tool-registry.ts. Fast, no subprocess
 *      overhead, but skips the MCP wire format entirely. Default.
 *
 *   2. StdioMcpHarness — spawns `build/index.js` as a child process
 *      and talks to it over stdio + JSON-RPC via the official
 *      `@modelcontextprotocol/sdk`. Same transport every real MCP
 *      client uses (Claude Desktop, Cursor, Cline). Catches schema
 *      drift between what `src/index.ts` registers and what
 *      `tool-registry.ts` mirrors, plus wire-format / serialization
 *      bugs. ~2-3s per scenario for spawn + handshake.
 *
 * The autonomous runner takes a ToolHarness, so both transports run
 * the same loop and produce the same transcript shape. The judge,
 * scoring, and ground-truth code don't know which transport ran.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { invokeTool, TOOL_NAMES, TOOL_SCHEMAS } from './tool-registry.js';
import type { EvalEnv } from './env.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export type TransportKind = 'in-process' | 'stdio';

export interface ToolDecl {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolInvocation {
  text: string;
  isError: boolean;
  durationMs: number;
}

export interface ToolHarness {
  transport: TransportKind;
  listTools(): Promise<{ tools: ToolDecl[]; missingSchemas: string[] }>;
  invoke(name: string, args: Record<string, unknown>): Promise<ToolInvocation>;
  shutdown(): Promise<void>;
}

// ─── In-process implementation ─────────────────────────────────────────

export class InProcessToolHarness implements ToolHarness {
  transport: TransportKind = 'in-process';
  constructor(private env: EvalEnv) {}

  async listTools(): Promise<{ tools: ToolDecl[]; missingSchemas: string[] }> {
    const missingSchemas: string[] = [];
    const tools = TOOL_NAMES.map((name) => {
      const zodSchema = TOOL_SCHEMAS[name];
      let input_schema: Record<string, unknown>;
      if (zodSchema) {
        const jsonSchema = zodToJsonSchema(zodSchema as unknown as Parameters<typeof zodToJsonSchema>[0], {
          $refStrategy: 'none',
          target: 'openApi3',
        }) as Record<string, unknown>;
        delete jsonSchema.$schema;
        delete jsonSchema.definitions;
        input_schema = jsonSchema;
      } else {
        missingSchemas.push(name);
        input_schema = { type: 'object', additionalProperties: true };
      }
      return {
        name,
        description: `Log10x MCP tool ${name}. Read input_schema.properties for the exact arg names and types.`,
        input_schema,
      };
    });
    return { tools, missingSchemas };
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<ToolInvocation> {
    try {
      const r = await invokeTool(name, args, this.env);
      return { text: r.text, isError: r.isError, durationMs: r.durationMs };
    } catch (e) {
      return {
        text: `Tool ${name} not registered in eval harness: ${(e as Error).message}`,
        isError: true,
        durationMs: 0,
      };
    }
  }

  async shutdown(): Promise<void> {
    // No subprocess; nothing to release.
  }
}

// ─── Stdio MCP implementation ──────────────────────────────────────────

interface StdioOptions {
  /** Absolute path to log10x-mcp's build/index.js. Required. */
  serverEntryPath: string;
  /** Force the server's mode-detect via LOG10X_MCP_FORCE_MODE. Defaults
   *  to 'analysis_pending' so both analysis + install-advisor tools
   *  register against the demo env without running a TSDB probe. */
  forceMode?: 'analysis' | 'analysis_pending' | 'poc';
  /** Extra env vars to forward to the subprocess. Merged onto the
   *  baseline (LOG10X_* extracted from EvalEnv + inherited PATH). */
  extraEnv?: Record<string, string>;
  /**
   * Pre-supplied answers for the server's `elicitation/create` requests.
   *
   * Wizard-style tools (today: log10x_advise_install) call
   * `server.elicitInput({ message, requestedSchema })` when they need
   * an answer from the user. In a real host (Claude Desktop, Cursor),
   * the host renders a form to the user and returns the answer over
   * the MCP wire. In tests we play the role of the host: the harness
   * registers an `ElicitRequestSchema` handler on the Client and
   * answers from `wizardAnswers` keyed by the requested property name.
   *
   * Without this, the server's `clientSupportsElicitation()` returns
   * false (capabilities empty) and the wizard falls back to its
   * markdown-question path. That path is NOT what real users hit —
   * Claude Desktop / Cursor users always go through elicitation.
   */
  wizardAnswers?: Record<string, unknown>;
}

export class StdioMcpHarness implements ToolHarness {
  transport: TransportKind = 'stdio';
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private env: EvalEnv, private opts: StdioOptions) {}

  private async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath, // current node binary; avoids PATH-resolution issues on Windows
        args: [this.opts.serverEntryPath],
        env: {
          // Inherit a minimal safe slice of process.env so node can find
          // its own libs (NODE_PATH, etc.) and the shell PATH; then
          // override the LOG10X_* keys with the eval's resolved values.
          PATH: process.env.PATH ?? '',
          NODE_PATH: process.env.NODE_PATH ?? '',
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
          USERPROFILE: process.env.USERPROFILE ?? '',
          APPDATA: process.env.APPDATA ?? '',
          LOG10X_API_KEY: this.env.apiKey,
          LOG10X_ENV_ID: this.env.envId,
          LOG10X_API_BASE: this.env.apiBase,
          ...(this.env.retrieverUrl ? { __SAVE_LOG10X_RETRIEVER_URL__: this.env.retrieverUrl } : {}),
          LOG10X_MCP_FORCE_MODE: this.opts.forceMode ?? 'analysis_pending',
          // Quiet the server's own stderr logs unless overridden.
          LOG10X_MCP_LOG_LEVEL: process.env.LOG10X_MCP_LOG_LEVEL ?? 'warn',
          ...(this.opts.extraEnv ?? {}),
        },
      });
      // Declare elicitation capability so the server's
      // `clientSupportsElicitation()` check passes and the wizard
      // exercises its form-based question flow (the real-customer
      // path) rather than falling back to markdown-question prose.
      const client = new Client(
        { name: 'log10x-eval-harness', version: '1.0.0' },
        { capabilities: { elicitation: {} } }
      );
      // Register the elicitation handler BEFORE connect so the server
      // sees a capable client at handshake.
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        return this.handleElicitation(request.params);
      });
      await client.connect(transport);
      this.client = client;
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Respond to a server-initiated `elicitation/create` request. Real
   * hosts render a form to the user; we look up answers in
   * `opts.wizardAnswers` keyed by the requested property name (which
   * matches the wizard's `answer_field` for each question).
   *
   * Three response shapes per the MCP spec:
   *   - `{ action: 'accept', content }`  → user filled the form
   *   - `{ action: 'decline' }`          → user explicitly said no
   *   - `{ action: 'cancel' }`           → user closed the form
   *
   * We accept when we have ALL required properties; we decline (rather
   * than partial-accept) when a required property is missing — the
   * wizard's elicitation block treats a decline as "fall back to
   * markdown" and the fixture author gets a clear signal that
   * wizardAnswers needs to be extended.
   */
  private handleElicitation(
    params: { message?: string; requestedSchema?: Record<string, unknown> }
  ): { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } {
    const answers = this.opts.wizardAnswers ?? {};
    const schema = (params.requestedSchema ?? {}) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    const content: Record<string, unknown> = {};
    let missing = 0;
    for (const key of Object.keys(properties)) {
      if (key in answers) {
        content[key] = answers[key];
      } else if (required.includes(key)) {
        missing++;
      }
    }
    if (missing > 0) {
      return { action: 'decline' };
    }
    return { action: 'accept', content };
  }

  async listTools(): Promise<{ tools: ToolDecl[]; missingSchemas: string[] }> {
    await this.connect();
    const resp = await this.client!.listTools();
    // resp.tools is Array<{ name, description?, inputSchema }>
    const tools = resp.tools.map((t) => ({
      name: t.name,
      description: t.description ?? `Log10x MCP tool ${t.name}.`,
      input_schema: (t.inputSchema ?? { type: 'object', additionalProperties: true }) as Record<string, unknown>,
    }));
    // missingSchemas only applies to the in-process harness — the
    // stdio path always gets a schema from the server, even if it's
    // the open-object fallback for tools the server registered
    // without a Zod shape.
    return { tools, missingSchemas: [] };
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<ToolInvocation> {
    await this.connect();
    const started = Date.now();
    try {
      const result = await this.client!.callTool({ name, arguments: args });
      // result.content is an array of content blocks; we concatenate
      // text blocks (the harness's transcript writer expects a single
      // string per tool result).
      const text = Array.isArray(result.content)
        ? (result.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text!)
            .join('')
        : '';
      return {
        text,
        isError: !!result.isError,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      return {
        text: `MCP callTool('${name}') threw: ${(e as Error).message}`,
        isError: true,
        durationMs: Date.now() - started,
      };
    }
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } catch {
      // Best-effort. The subprocess gets SIGTERM via the transport's
      // own teardown; if that already happened, close() may throw.
    }
    this.client = null;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Build a ToolHarness for the requested transport. The orchestrator
 * now defaults autonomous-mode runs to `'stdio'` so tests go through
 * the real MCP wire by default (catches schema drift + exercises the
 * elicitation path). `'in-process'` stays available for fast smoke
 * checks. The default serverEntryPath is computed off this file's
 * compiled location; callers can override via `opts.serverEntryPath`
 * when running against a non-default build.
 */
export function buildToolHarness(
  env: EvalEnv,
  transport: TransportKind,
  opts?: Partial<StdioOptions>
): ToolHarness {
  if (transport === 'in-process') {
    return new InProcessToolHarness(env);
  }
  // Default path: this file lives at <repo>/eval/build-eval/tool-harness.js
  // after compilation. Three dirname ups gets to <repo>, then `build/index.js`
  // is the MCP server's entry. `fileURLToPath` handles the file:// → path
  // conversion correctly on Windows (raw string-replace breaks because
  // file:///C:/... has an empty authority + leading slash).
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultEntry = resolve(here, '..', '..', 'build', 'index.js');
  return new StdioMcpHarness(env, {
    serverEntryPath: opts?.serverEntryPath ?? defaultEntry,
    forceMode: opts?.forceMode,
    extraEnv: opts?.extraEnv,
    wizardAnswers: opts?.wizardAnswers,
  });
}

// ─── Unused import guard ───────────────────────────────────────────────
// zod is imported for the side effect of re-exporting types compatible
// with TOOL_SCHEMAS' generic; reference it here so the import isn't
// stripped by ts-prune-like tools when this file is the only consumer
// of zod in some build configs.
const _z = z;
void _z;
