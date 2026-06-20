/**
 * Agent-client abstraction so the hero-runner can drive either Claude
 * (Anthropic SDK) or Grok (xAI chat-completions API) through the same
 * tool-use loop.
 *
 * The internal message + content-block shape is the Anthropic shape
 * (text / tool_use / tool_result), because that's what the existing
 * loop + transcript persistence already speak. The Grok client converts
 * to OpenAI-shape on send and back to Anthropic-shape on receive.
 *
 * The judge path stays Anthropic-only by design — it's the fixed
 * anti-hallucination evaluator across models. Mixing judge models per
 * runner-model would make the value_delivered axis unreproducible.
 */

import Anthropic from '@anthropic-ai/sdk';

export type AgentTextBlock = { type: 'text'; text: string };
export type AgentToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type AgentToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type AgentContentBlock = AgentTextBlock | AgentToolUseBlock | AgentToolResultBlock;

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentContentBlock[];
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: object;
}

export interface AgentRequest {
  system: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  maxTokens: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentResponse {
  content: Array<AgentTextBlock | AgentToolUseBlock>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';
  /**
   * Token usage for this single API call. The runner sums these
   * across all call() invocations to produce a per-run total. Both
   * Anthropic and xAI return per-call usage in their responses; the
   * client extracts and normalizes to this shape. inputTokens
   * includes any cached / cache-read tokens (we account for them as
   * regular input tokens for cost-table simplicity).
   */
  usage: AgentUsage;
}

export interface AgentClient {
  modelId: string;
  vendor: 'anthropic' | 'xai' | 'openai' | 'google';
  call(req: AgentRequest): Promise<AgentResponse>;
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_GROK_MODEL = 'grok-4-latest';
const DEFAULT_OPENAI_MODEL = 'gpt-5';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';

export function selectAgentClient(modelSpec: string | undefined): AgentClient {
  const spec = (modelSpec ?? 'claude').toLowerCase();
  if (spec === 'claude' || spec.startsWith('claude-')) {
    const id = spec === 'claude' ? DEFAULT_CLAUDE_MODEL : modelSpec!;
    return new AnthropicAgentClient(id);
  }
  if (spec === 'grok' || spec.startsWith('grok-')) {
    const id = spec === 'grok' ? DEFAULT_GROK_MODEL : modelSpec!;
    return new GrokAgentClient(id);
  }
  if (spec === 'openai' || spec === 'gpt' || spec.startsWith('gpt-') || spec.startsWith('o1') || spec.startsWith('o3')) {
    const id = (spec === 'openai' || spec === 'gpt') ? DEFAULT_OPENAI_MODEL : modelSpec!;
    return new OpenAIAgentClient(id);
  }
  if (spec === 'gemini' || spec === 'google' || spec.startsWith('gemini-')) {
    const id = (spec === 'gemini' || spec === 'google') ? DEFAULT_GEMINI_MODEL : modelSpec!;
    return new GeminiAgentClient(id);
  }
  throw new Error(
    `unknown agent model: ${modelSpec}. Use 'claude' | 'grok' | 'openai' (or 'gpt') | 'gemini', or a specific model id.`
  );
}

class AnthropicAgentClient implements AgentClient {
  vendor = 'anthropic' as const;
  private client = new Anthropic();
  constructor(public modelId: string) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY required for Anthropic runner');
    }
  }

  async call(req: AgentRequest): Promise<AgentResponse> {
    // Prompt-cache the stable prefix. Render order is tools -> system ->
    // messages, so one cache_control breakpoint on the system block caches the
    // tool catalog too (~55k tokens for the MCP's 65 schemas). Within a
    // conversation, calls 2..N re-read that prefix at ~0.1x input price instead
    // of re-billing it in full each turn — the dominant cost of a multi-call
    // run. Prompt caching is GA, so it works on the regular messages.create
    // path without a beta header; SDK 0.30.1 lacks the cache_control type on
    // the non-beta params, but the field passes through the existing cast.
    // Eval-only: real MCP hosts manage their own tool-definition caching.
    const system = req.system
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;
    const createParams = {
      model: this.modelId,
      max_tokens: req.maxTokens,
      system,
      tools: req.tools,
      messages: req.messages,
    } as unknown as Parameters<typeof this.client.messages.create>[0];

    // Phase 13 fix: the Anthropic SDK occasionally hangs at parallel
    // scale (Phases 6, 9, 10, 11, 12 all lost runs to this). We now
    // wrap each call with an explicit AbortController-backed timeout
    // and retry on timeout / transient network errors. Tested to
    // unblock the ~80% hang rate observed at N=20 parallel.
    const PER_CALL_TIMEOUT_MS = 180_000; // 3 minutes per single call
    const MAX_ATTEMPTS = 4;
    const retryableErrorCodes = new Set([
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'ECONNRESET',
      'ETIMEDOUT',
      'AbortError',
      'ECONNREFUSED',
    ]);
    let lastErr: unknown;
    let resp:
      | {
          content: Array<{ type: string; [k: string]: unknown }>;
          stop_reason: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        }
      | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
      try {
        resp = (await this.client.messages.create(createParams, {
          signal: controller.signal,
        })) as unknown as {
          content: Array<{ type: string; [k: string]: unknown }>;
          stop_reason: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        clearTimeout(timeoutHandle);
        break;
      } catch (err) {
        clearTimeout(timeoutHandle);
        lastErr = err;
        const code =
          (err as { name?: string; code?: string; cause?: { code?: string } }).code ??
          (err as { cause?: { code?: string } }).cause?.code ??
          (err as { name?: string }).name ??
          '';
        const statusFromSdk = (err as { status?: number }).status;
        // SDK-level overload / capacity errors also worth retrying
        const retryableStatus =
          statusFromSdk === 429 ||
          statusFromSdk === 500 ||
          statusFromSdk === 502 ||
          statusFromSdk === 503 ||
          statusFromSdk === 504 ||
          statusFromSdk === 529; // Anthropic-specific overloaded
        if (
          (retryableErrorCodes.has(code) || retryableStatus) &&
          attempt < MAX_ATTEMPTS - 1
        ) {
          const backoffMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }
    if (!resp) {
      throw (lastErr ?? new Error('Anthropic call: exhausted retries with no error captured'));
    }
    const content = resp.content.filter(
      (b): b is AgentTextBlock | AgentToolUseBlock => b.type === 'text' || b.type === 'tool_use'
    ) as unknown as Array<AgentTextBlock | AgentToolUseBlock>;
    const u = resp.usage ?? {};
    return {
      content,
      stopReason: resp.stop_reason as AgentResponse['stopReason'],
      usage: {
        inputTokens:
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      },
    };
  }
}

class GrokAgentClient implements AgentClient {
  vendor = 'xai' as const;
  private apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  private baseUrl = 'https://api.x.ai/v1/chat/completions';

  constructor(public modelId: string) {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY or XAI_API_KEY required for Grok runner');
    }
  }

  async call(req: AgentRequest): Promise<AgentResponse> {
    const openaiMessages = toOpenAIMessages(req.system, req.messages);
    // xAI's function-tools validator is stricter than Anthropic about
    // shared sub-schemas. Apply the same strip pass we use for Gemini
    // so $ref / $defs / additionalProperties don't trip the 400. Real
    // MCP servers emit these for shared types; both vendors reject them.
    const openaiTools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: stripUnsupportedSchemaKeys(t.input_schema),
      },
    }));

    const body = {
      model: this.modelId,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: req.maxTokens,
    };

    // xAI returns 503 "model is at capacity" intermittently and 429
    // on burst rates. Retry on both with exponential backoff. Also
    // retry on fetch-level network errors (UND_ERR_HEADERS_TIMEOUT,
    // UND_ERR_SOCKET) — Grok occasionally hangs >5min and trips
    // undici's default header timeout. Other 4xx fail fast.
    let r: Response | undefined;
    const retryStatuses = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
    const retryErrorCodes = new Set([
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'ECONNRESET',
      'ETIMEDOUT',
    ]);
    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        r = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const code =
          (err as { cause?: { code?: string }; code?: string }).cause?.code ??
          (err as { code?: string }).code ??
          '';
        if (retryErrorCodes.has(code) && attempt < maxRetries) {
          const backoffMs = Math.min(2000 * Math.pow(2, attempt), 30000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw err;
      }
      if (r.ok) break;
      if (!retryStatuses.has(r.status) || attempt === maxRetries) {
        const errText = await r.text();
        throw new Error(`Grok API ${r.status}: ${errText.slice(0, 500)}`);
      }
      const backoffMs = Math.min(2000 * Math.pow(2, attempt), 30000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    if (!r || !r.ok) {
      throw new Error(`Grok API: exhausted retries without success`);
    }
    const data = (await r.json()) as {
      choices?: Array<{
        message: { role: string; content?: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`Grok: no choices in response: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const m = choice.message;
    const content: Array<AgentTextBlock | AgentToolUseBlock> = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = { _unparseable_arguments: tc.function.arguments };
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }
    const stopReason: AgentResponse['stopReason'] =
      choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'stop'
          ? 'end_turn'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'other';
    const u = data.usage ?? {};
    return {
      content,
      stopReason,
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
      },
    };
  }
}

/**
 * OpenAI agent client — same chat-completions wire format as Grok (xAI is
 * OpenAI-compatible by design), so the conversion helpers are shared.
 * Only the auth, endpoint, and per-vendor retry quirks differ.
 */
class OpenAIAgentClient implements AgentClient {
  vendor = 'openai' as const;
  private apiKey = process.env.OPENAI_API_KEY;
  private baseUrl = 'https://api.openai.com/v1/chat/completions';

  constructor(public modelId: string) {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY required for OpenAI runner');
    }
  }

  async call(req: AgentRequest): Promise<AgentResponse> {
    const openaiMessages = toOpenAIMessages(req.system, req.messages);
    const openaiTools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    // GPT-5 / o1 / o3 reject `max_tokens`; they require `max_completion_tokens`.
    // Send the modern field for any model name that looks like it's in those
    // families, and fall back to `max_tokens` for legacy gpt-4* etc.
    const usesCompletionTokens =
      /^gpt-5/i.test(this.modelId) || /^o[13]/i.test(this.modelId);
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: openaiMessages,
      tools: openaiTools,
    };
    if (usesCompletionTokens) {
      body.max_completion_tokens = req.maxTokens;
    } else {
      body.max_tokens = req.maxTokens;
    }

    const retryStatuses = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
    const retryErrorCodes = new Set([
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'ECONNRESET',
      'ETIMEDOUT',
    ]);
    const maxRetries = 4;
    let r: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        r = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const code =
          (err as { cause?: { code?: string }; code?: string }).cause?.code ??
          (err as { code?: string }).code ??
          '';
        if (retryErrorCodes.has(code) && attempt < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2000 * Math.pow(2, attempt), 30000))
          );
          continue;
        }
        throw err;
      }
      if (r.ok) break;
      if (!retryStatuses.has(r.status) || attempt === maxRetries) {
        const errText = await r.text();
        throw new Error(`OpenAI API ${r.status}: ${errText.slice(0, 500)}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000 * Math.pow(2, attempt), 30000))
      );
    }
    if (!r || !r.ok) {
      throw new Error('OpenAI API: exhausted retries without success');
    }
    const data = (await r.json()) as {
      choices?: Array<{
        message: { role: string; content?: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`OpenAI: no choices in response: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const m = choice.message;
    const content: Array<AgentTextBlock | AgentToolUseBlock> = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = { _unparseable_arguments: tc.function.arguments };
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }
    const stopReason: AgentResponse['stopReason'] =
      choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'stop'
          ? 'end_turn'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'other';
    const u = data.usage ?? {};
    return {
      content,
      stopReason,
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
      },
    };
  }
}

/**
 * Gemini agent client — Google's generative-language API uses a different
 * shape from Anthropic/OpenAI:
 *   - `systemInstruction` instead of a system message
 *   - `contents[]` with `parts[]` per turn (vs Anthropic blocks)
 *   - tools wrapped in `{ function_declarations: [...] }`
 *   - tool_use → `parts[].functionCall { name, args }`
 *   - tool_result → user role with `parts[].functionResponse { name, response }`
 *   - finishReason values are upper-case strings ("STOP", "TOOL_USE_ENDED").
 *
 * The conversion happens in toGeminiContents() below. We round-trip the
 * Anthropic-shape internal `messages` array on send/receive so the rest
 * of the runner doesn't have to care which vendor we're talking to.
 */
class GeminiAgentClient implements AgentClient {
  vendor = 'google' as const;
  private apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  private baseUrl: string;

  constructor(public modelId: string) {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) required for Gemini runner');
    }
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:generateContent?key=${this.apiKey}`;
  }

  async call(req: AgentRequest): Promise<AgentResponse> {
    const contents = toGeminiContents(req.messages);
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents,
      tools: [
        {
          function_declarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: stripUnsupportedSchemaKeys(t.input_schema),
          })),
        },
      ],
      generationConfig: { maxOutputTokens: req.maxTokens },
    };

    const retryStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
    const retryErrorCodes = new Set([
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'ECONNRESET',
      'ETIMEDOUT',
    ]);
    const maxRetries = 4;
    let r: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        r = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const code =
          (err as { cause?: { code?: string }; code?: string }).cause?.code ??
          (err as { code?: string }).code ??
          '';
        if (retryErrorCodes.has(code) && attempt < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2000 * Math.pow(2, attempt), 30000))
          );
          continue;
        }
        throw err;
      }
      if (r.ok) break;
      if (!retryStatuses.has(r.status) || attempt === maxRetries) {
        const errText = await r.text();
        throw new Error(`Gemini API ${r.status}: ${errText.slice(0, 500)}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000 * Math.pow(2, attempt), 30000))
      );
    }
    if (!r || !r.ok) {
      throw new Error('Gemini API: exhausted retries without success');
    }
    const data = (await r.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }>; role?: string };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error(`Gemini: empty candidate in response: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const content: Array<AgentTextBlock | AgentToolUseBlock> = [];
    let toolUseSeq = 0;
    for (const p of candidate.content.parts) {
      if (p.text) content.push({ type: 'text', text: p.text });
      if (p.functionCall) {
        // Gemini doesn't return a tool_use id; synthesize one so the
        // round-trip through the runner's tool_result message has a key.
        content.push({
          type: 'tool_use',
          id: `gem-${Date.now()}-${toolUseSeq++}`,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
        });
      }
    }
    const fr = candidate.finishReason ?? '';
    const stopReason: AgentResponse['stopReason'] =
      fr === 'STOP'
        ? content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
        : fr === 'MAX_TOKENS' ? 'max_tokens' : 'other';
    const u = data.usageMetadata ?? {};
    return {
      content,
      stopReason,
      usage: {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
      },
    };
  }
}

/**
 * Convert the runner's internal Anthropic-shape messages into Gemini's
 * `contents[]`. Tool results from prior turns become user-role messages
 * with `functionResponse` parts; tool_use blocks the model emitted last
 * turn become model-role messages with `functionCall` parts.
 *
 * Gemini's tool_use id has no equivalent in the wire format — they pair
 * function calls and responses by `name` only, so we just emit the name
 * and let the model match by position.
 */
function toGeminiContents(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    let lookupName = '';
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: block.name, args: block.input } });
        lookupName = block.name;
      } else if (block.type === 'tool_result') {
        // Try to look up the name from the prior assistant message; if it
        // isn't trivially available, fall back to "tool" as the name and
        // let Gemini take it. Most fixtures only call one tool per turn.
        const name =
          findToolNameForUseId(out, block.tool_use_id) || lookupName || 'tool';
        let responseObj: Record<string, unknown>;
        try {
          // Gemini wants a structured response; try to parse JSON, else
          // wrap the string in a { result } object.
          const parsed = JSON.parse(block.content);
          responseObj = typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : { result: parsed };
        } catch {
          responseObj = { result: block.content };
        }
        parts.push({ functionResponse: { name, response: responseObj } });
      }
    }
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

/** Walk previously-built Gemini contents to recover the tool name for a
 *  given Anthropic tool_use id. Since we keep the Anthropic shape
 *  internally, the prior `tool_use` block lives on an `assistant`-typed
 *  message that hasn't yet been pushed to Gemini contents. As a
 *  practical fallback we just return undefined here and let the caller's
 *  `lookupName` heuristic handle it. */
function findToolNameForUseId(_contents: unknown[], _id: string): string | undefined {
  return undefined;
}

/**
 * Gemini's tool-parameters validator rejects a few JSON Schema keys
 * that OpenAI/Anthropic accept (notably `additionalProperties`, `$schema`,
 * sometimes `default`). Strip the known-bad ones recursively before
 * sending. Keep this list minimal — adding more breaks legitimate uses.
 */
function stripUnsupportedSchemaKeys(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((x) => stripUnsupportedSchemaKeys(x));
  if (schema && typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    // `const: X` → `enum: [X]`. Semantically equivalent JSON Schema,
    // but Gemini's function_declarations validator only understands
    // `enum`. Common with z.literal(...) in Zod-derived schemas.
    if ('const' in obj) {
      const value = obj.const;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'const') continue;
        if (k === 'additionalProperties' || k === '$schema') continue;
        out[k] = stripUnsupportedSchemaKeys(v);
      }
      out.enum = [value];
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'additionalProperties' || k === '$schema') continue;
      // $ref + $defs/definitions: the MCP server emits these for shared
      // sub-schemas. Gemini's validator rejects $ref outright. Strip
      // both so the tool stays callable with a slightly looser schema
      // at the ref-site; the top-level shape (what the model picks
      // arg names from) is preserved.
      if (k === '$ref' || k === '$defs' || k === 'definitions') continue;
      out[k] = stripUnsupportedSchemaKeys(v);
    }
    return out;
  }
  return schema;
}

/**
 * Price table for the supported runner models, in USD per 1M tokens.
 * Used by hero-runner to convert per-call usage into a per-run cost.
 * Conservative numbers from the vendors' published pricing as of
 * Q2 2026 — refine when vendors change pricing.
 */
export const RUNNER_MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Anthropic
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-opus-4-7': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  // xAI
  'grok-4-latest': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'grok-4-0709': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // OpenAI — approx Q1 2026 list price
  'gpt-5': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'gpt-5.2': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  // Google — approx Q1 2026 list price
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 5.0 },
  'gemini-3.1-pro-preview': { inputPerMTok: 1.25, outputPerMTok: 5.0 },
};

export function computeCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): { usd: number; pricingFound: boolean } {
  const p = RUNNER_MODEL_PRICING[modelId];
  if (!p) {
    return { usd: 0, pricingFound: false };
  }
  const usd = (inputTokens / 1e6) * p.inputPerMTok + (outputTokens / 1e6) * p.outputPerMTok;
  return { usd, pricingFound: true };
}

function toOpenAIMessages(system: string, messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'user') {
      const toolResults = m.content.filter((b): b is AgentToolResultBlock => b.type === 'tool_result');
      const texts = m.content.filter((b): b is AgentTextBlock => b.type === 'text');
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
      }
      if (texts.length > 0) {
        out.push({ role: 'user', content: texts.map((t) => t.text).join('\n') });
      }
    } else {
      const toolUses = m.content.filter((b): b is AgentToolUseBlock => b.type === 'tool_use');
      const texts = m.content.filter((b): b is AgentTextBlock => b.type === 'text');
      const msg: Record<string, unknown> = { role: 'assistant' };
      msg.content = texts.length > 0 ? texts.map((t) => t.text).join('\n') : null;
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }));
      }
      out.push(msg);
    }
  }
  return out;
}
