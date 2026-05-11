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

export interface AgentResponse {
  content: Array<AgentTextBlock | AgentToolUseBlock>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';
}

export interface AgentClient {
  modelId: string;
  vendor: 'anthropic' | 'xai';
  call(req: AgentRequest): Promise<AgentResponse>;
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_GROK_MODEL = 'grok-4-latest';

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
  throw new Error(
    `unknown agent model: ${modelSpec}. Use 'claude' | 'grok' or a specific model id.`
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
    const createParams = {
      model: this.modelId,
      max_tokens: req.maxTokens,
      system: req.system,
      tools: req.tools,
      messages: req.messages,
    } as unknown as Parameters<typeof this.client.messages.create>[0];
    const resp = (await this.client.messages.create(createParams)) as unknown as {
      content: Array<{ type: string; [k: string]: unknown }>;
      stop_reason: string;
    };
    const content = resp.content.filter(
      (b): b is AgentTextBlock | AgentToolUseBlock => b.type === 'text' || b.type === 'tool_use'
    ) as unknown as Array<AgentTextBlock | AgentToolUseBlock>;
    return {
      content,
      stopReason: resp.stop_reason as AgentResponse['stopReason'],
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
    const openaiTools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const body = {
      model: this.modelId,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: req.maxTokens,
    };

    const r = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Grok API ${r.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await r.json()) as {
      choices?: Array<{
        message: { role: string; content?: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
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
    return { content, stopReason };
  }
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
