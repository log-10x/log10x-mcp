/**
 * JSONL transcript writer in Anthropic Messages API shape.
 *
 * Both the deterministic and autonomous runners append events here so the
 * scorer / judge consume identical artifacts regardless of mode.
 *
 * Each line is one JSON object matching `TranscriptEvent` from types.ts.
 * The shape mirrors what `test-agent-scorer.mjs` already parses.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TranscriptEvent, ContentBlock, StepLog } from './types.js';

export class TranscriptWriter {
  private stream: ReturnType<typeof createWriteStream>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'w' });
  }

  writeUserPrompt(text: string, agentId?: string): void {
    const event: TranscriptEvent = {
      type: 'user',
      message: { role: 'user', content: text },
      ...(agentId ? { agentId } : {}),
    };
    this.stream.write(JSON.stringify(event) + '\n');
  }

  writeToolUse(id: string, name: string, input: Record<string, unknown>): void {
    const event: TranscriptEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input } as ContentBlock],
      },
    };
    this.stream.write(JSON.stringify(event) + '\n');
  }

  writeToolResult(toolUseId: string, text: string, isError: boolean): void {
    const block: ContentBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text }],
      is_error: isError,
    };
    const event: TranscriptEvent = {
      type: 'user',
      message: { role: 'user', content: [block] },
    };
    this.stream.write(JSON.stringify(event) + '\n');
  }

  writeFinalAssistantText(text: string, stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' = 'end_turn'): void {
    const event: TranscriptEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: stopReason,
        content: [{ type: 'text', text } as ContentBlock],
      },
    };
    this.stream.write(JSON.stringify(event) + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

export class StepLogWriter {
  private stream: ReturnType<typeof createWriteStream>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'w' });
  }

  write(entry: StepLog): void {
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}
