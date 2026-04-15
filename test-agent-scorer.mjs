#!/usr/bin/env node
/**
 * Sub-agent transcript scorer.
 *
 * Reads a JSONL transcript from an async Agent run and extracts:
 *   - initial prompt
 *   - every MCP tool_use call (name + input)
 *   - tool_result sizes
 *   - final assistant text
 *   - termination reason (completed / rate_limited / error)
 *
 * Then scores the run on 6 dimensions (max 12):
 *   tool_selection  0-2   did it pick the right tool for the question
 *   parameters      0-2   were args sensible (timeframe, filters, etc)
 *   sequencing      0-2   did it chain tools in a reasonable order
 *   accuracy        0-3   did the final answer match what the tools returned
 *   hallucination   0-1   1 if no fabricated numbers/names, 0 otherwise
 *   follow_through  0-2   did it actually answer the question asked
 *
 * Manual scoring fields are left as null — this script produces the raw
 * structured data, a human (or a judge LLM) fills in the scores.
 *
 * Usage:  node test-agent-scorer.mjs <transcript.output> [transcript2 ...]
 *         node test-agent-scorer.mjs --dir /path/to/tasks/
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function parseTranscript(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const events = lines.map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { return { _parseError: true, _line: i, _raw: l.slice(0, 200) }; }
  });

  const prompt = extractInitialPrompt(events);
  const toolCalls = extractToolCalls(events);
  const toolResults = extractToolResults(events);
  const finalText = extractFinalAssistantText(events);
  const termination = classifyTermination(events);

  return {
    path,
    agentId: events[0]?.agentId ?? 'unknown',
    prompt: prompt?.slice(0, 400),
    promptChars: prompt?.length ?? 0,
    toolCalls,
    toolCallCount: toolCalls.length,
    mcpToolCallCount: toolCalls.filter(t => t.name.startsWith('mcp__log10x__')).length,
    toolResultsSummary: summarizeResults(toolResults),
    finalText,
    finalTextChars: finalText?.length ?? 0,
    termination,
    scores: {
      tool_selection: null,
      parameters: null,
      sequencing: null,
      accuracy: null,
      hallucination: null,
      follow_through: null,
    },
  };
}

function extractInitialPrompt(events) {
  const first = events.find(e => e.type === 'user' && typeof e.message?.content === 'string');
  return first?.message?.content;
}

function extractToolCalls(events) {
  const calls = [];
  for (const e of events) {
    if (e.message?.role !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use') {
        calls.push({
          id: c.id,
          name: c.name,
          input: c.input,
        });
      }
    }
  }
  return calls;
}

function extractToolResults(events) {
  const results = [];
  for (const e of events) {
    if (e.type !== 'user') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_result') {
        const textChunks = Array.isArray(c.content)
          ? c.content.filter(x => x.type === 'text' || x.type === 'tool_reference').map(x => x.text ?? x.tool_name ?? '')
          : [String(c.content ?? '')];
        results.push({
          tool_use_id: c.tool_use_id,
          preview: textChunks.join(' | ').slice(0, 300),
          size: textChunks.join('').length,
          is_error: c.is_error === true,
        });
      }
    }
  }
  return results;
}

function summarizeResults(results) {
  return {
    count: results.length,
    errors: results.filter(r => r.is_error).length,
    totalBytes: results.reduce((s, r) => s + r.size, 0),
    previews: results.slice(0, 3).map(r => r.preview),
  };
}

function extractFinalAssistantText(events) {
  // Walk from the end backwards, find the last assistant message with text content.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.message?.role !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const textParts = content.filter(c => c.type === 'text').map(c => c.text);
    if (textParts.length > 0) return textParts.join('\n');
  }
  return null;
}

function classifyTermination(events) {
  // Look at the very last event. If it's a rate limit message, flag it.
  const last = events[events.length - 1];
  const raw = JSON.stringify(last ?? {}).toLowerCase();
  if (raw.includes("you've hit your limit") || raw.includes('rate limit')) {
    return { status: 'rate_limited', detail: 'quota exceeded mid-run' };
  }
  if (raw.includes('error') && last?.message?.role !== 'assistant') {
    return { status: 'error', detail: 'unknown error at tail' };
  }
  // Check stop_reason on the last assistant message
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.message?.role === 'assistant' && e.message?.stop_reason) {
      return { status: e.message.stop_reason === 'end_turn' ? 'completed' : e.message.stop_reason, detail: '' };
    }
  }
  return { status: 'unknown', detail: '' };
}

function renderRun(run) {
  const out = [];
  out.push('='.repeat(80));
  out.push(`Agent: ${run.agentId}`);
  out.push(`File:  ${run.path}`);
  out.push(`Status: ${run.termination.status}${run.termination.detail ? ' — ' + run.termination.detail : ''}`);
  out.push('');
  out.push(`Prompt (${run.promptChars} chars):`);
  out.push('  ' + (run.prompt ?? '(none)').replace(/\n/g, '\n  '));
  out.push('');
  out.push(`Tool calls: ${run.toolCallCount} total, ${run.mcpToolCallCount} MCP`);
  run.toolCalls.forEach((c, i) => {
    const args = JSON.stringify(c.input ?? {}).slice(0, 120);
    out.push(`  ${i + 1}. ${c.name}  ${args}`);
  });
  out.push('');
  out.push(`Tool results: ${run.toolResultsSummary.count} (${run.toolResultsSummary.errors} errors, ${run.toolResultsSummary.totalBytes} bytes)`);
  out.push('');
  out.push(`Final text (${run.finalTextChars} chars):`);
  if (run.finalText) {
    out.push('  ' + run.finalText.slice(0, 800).replace(/\n/g, '\n  '));
    if (run.finalText.length > 800) out.push(`  ... [+${run.finalText.length - 800} more chars]`);
  } else {
    out.push('  (no final text — agent never finished)');
  }
  out.push('');
  out.push('Scores (fill in manually):');
  for (const [k, v] of Object.entries(run.scores)) {
    out.push(`  ${k.padEnd(16)} ${v ?? '_'}`);
  }
  out.push('');
  return out.join('\n');
}

// --- main ---
const args = process.argv.slice(2);
let files = [];
if (args[0] === '--dir') {
  const dir = args[1];
  files = readdirSync(dir).filter(f => f.endsWith('.output')).map(f => join(dir, f));
} else if (args.length > 0) {
  files = args;
} else {
  console.error('Usage: node test-agent-scorer.mjs <transcript.output> [more...]');
  console.error('       node test-agent-scorer.mjs --dir /path/to/tasks/');
  process.exit(1);
}

const runs = [];
for (const f of files) {
  try {
    const st = statSync(f);
    if (st.size === 0) continue;
    runs.push(parseTranscript(f));
  } catch (e) {
    console.error(`skip ${f}: ${e.message}`);
  }
}

runs.sort((a, b) => a.path.localeCompare(b.path));
for (const r of runs) console.log(renderRun(r));

// Summary
console.log('='.repeat(80));
console.log(`TOTAL: ${runs.length} runs`);
const byStatus = runs.reduce((acc, r) => { acc[r.termination.status] = (acc[r.termination.status] || 0) + 1; return acc; }, {});
for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k}: ${v}`);
console.log(`  total MCP tool calls: ${runs.reduce((s, r) => s + r.mcpToolCallCount, 0)}`);
