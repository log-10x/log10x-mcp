/**
 * Transcript parser. Reads a JSONL file in Anthropic Messages shape and
 * extracts the prompt, tool calls, tool results, and final assistant text.
 *
 * Mirrors the extraction logic in `test-agent-scorer.mjs` (the existing
 * scorer at the repo root). Reuse-by-equivalence rather than re-import:
 * test-agent-scorer.mjs is a CLI that runs at import time, which would
 * fight with our typed pipeline. The functions are small enough that
 * having a typed copy here is cleaner than refactoring the upstream.
 */

import { readFileSync } from 'node:fs';
import type { TranscriptEvent } from './types.js';

export interface ParsedTranscript {
  path: string;
  prompt: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults: Array<{ tool_use_id: string; text: string; isError: boolean; bytes: number }>;
  finalText: string;
  termination: { status: 'completed' | 'error' | 'unknown'; detail: string };
  events: TranscriptEvent[];
}

export function parseTranscript(path: string): ParsedTranscript {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const events: TranscriptEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }

  const prompt = extractPrompt(events);
  const toolCalls = extractToolCalls(events);
  const toolResults = extractToolResults(events);
  const finalText = extractFinalText(events);
  const termination = classifyTermination(events);

  return { path, prompt, toolCalls, toolResults, finalText, termination, events };
}

function extractPrompt(events: TranscriptEvent[]): string {
  for (const e of events) {
    if (e.type === 'user' && typeof e.message?.content === 'string') {
      return e.message.content;
    }
  }
  return '';
}

function extractToolCalls(
  events: TranscriptEvent[]
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const out: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const e of events) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block.type === 'tool_use') {
        out.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  return out;
}

function extractToolResults(
  events: TranscriptEvent[]
): Array<{ tool_use_id: string; text: string; isError: boolean; bytes: number }> {
  const out: Array<{ tool_use_id: string; text: string; isError: boolean; bytes: number }> = [];
  for (const e of events) {
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block.type === 'tool_result') {
        const text = block.content.map((c) => c.text).join('');
        out.push({
          tool_use_id: block.tool_use_id,
          text,
          isError: !!block.is_error,
          bytes: text.length,
        });
      }
    }
  }
  return out;
}

function extractFinalText(events: TranscriptEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      const textBlocks = e.message.content.filter((b) => b.type === 'text');
      if (textBlocks.length > 0) {
        return textBlocks.map((b) => (b as { type: 'text'; text: string }).text).join('\n');
      }
    }
  }
  return '';
}

function classifyTermination(events: TranscriptEvent[]): {
  status: 'completed' | 'error' | 'unknown';
  detail: string;
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
      return { status: 'completed', detail: 'end_turn' };
    }
  }
  return { status: 'unknown', detail: 'no end_turn marker' };
}
