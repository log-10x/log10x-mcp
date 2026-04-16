/**
 * log10x_extract_templates — extract the template library from a log corpus.
 *
 * Runs the local tenx CLI against inline events, raw text, or a file path,
 * producing the full set of structural pattern identities (templateHash +
 * template body) with per-template event counts and severity distribution.
 *
 * Doubles as a **validator** when optional `expected` assertions are
 * provided: the tool runs the same pipeline, then checks the output
 * against min_templates, required_patterns, and forbidden_merges.
 * Pass/fail per assertion is reported in the output.
 */

import { promises as fs } from 'fs';
import { z } from 'zod';
import { runDevCliStdin, runDevCliFile, DevCliNotInstalledError, DevCliRunError } from '../lib/dev-cli.js';

export const extractTemplatesSchema = {
  source: z.enum(['file', 'events', 'text']).describe(
    'Input mode. `file`: read from a local path/glob. `events`: array of raw log lines. `text`: newline-separated log events as a single string.'
  ),
  path: z.string().optional().describe('Local file path or glob when source=file.'),
  events: z.array(z.string()).optional().describe('Inline log lines when source=events.'),
  text: z.string().optional().describe('Raw text blob when source=text.'),
  top_n: z.number().min(1).max(200).default(50).describe('Max templates to return.'),
  expected: z.object({
    min_templates: z.number().optional().describe('Minimum number of distinct templates expected.'),
    required_patterns: z.array(z.string()).optional().describe(
      'Substrings that must appear in at least one template body.'
    ),
    forbidden_merges: z.array(z.array(z.string()).min(2).max(2)).optional().describe(
      'Pairs of substrings that must NOT appear in the same template body. Use to assert the templater never merges two structurally-distinct events into one identity.'
    ),
  }).optional().describe(
    'Optional assertions — turns extraction into validation. Each assertion reports pass/fail in the output.'
  ),
};

interface ExtractArgs {
  source: 'file' | 'events' | 'text';
  path?: string;
  events?: string[];
  text?: string;
  top_n: number;
  expected?: {
    min_templates?: number;
    required_patterns?: string[];
    forbidden_merges?: string[][];
  };
}

export async function executeExtractTemplates(args: ExtractArgs): Promise<string> {
  // ── 1. Run the CLI ──
  const result = args.source === 'file'
    ? await runFile(args)
    : await runStdin(args);

  // ── 2. Parse output ──
  const templateLines = result.templatesJson.trim().split('\n').filter(Boolean);
  const encodedLines = result.encodedLog.trim().split('\n').filter(Boolean);

  interface TemplateEntry {
    templateHash: string;
    template: string;
    count: number;
  }

  const templateMap = new Map<string, TemplateEntry>();
  for (const line of templateLines) {
    try {
      const parsed = JSON.parse(line) as { templateHash: string; template: string };
      templateMap.set(parsed.templateHash, {
        templateHash: parsed.templateHash,
        template: parsed.template,
        count: 0,
      });
    } catch { /* skip unparseable */ }
  }

  // Count events per template from encoded.log
  for (const line of encodedLines) {
    const hash = line.split(',')[0]?.replace(/^~/, '');
    if (hash && templateMap.has(hash)) {
      templateMap.get(hash)!.count++;
    }
  }

  const templates = [...templateMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, args.top_n);

  // ── 3. Render output ──
  const lines: string[] = [];
  lines.push(`## Template Extraction`);
  lines.push('');
  lines.push(
    `${encodedLines.length} events → ${templateMap.size} distinct templates. ` +
    `CLI wall time: ${result.wallTimeMs}ms. CLI version: ${result.cliVersion || 'unknown'}.`
  );
  lines.push('');

  if (templates.length > 0) {
    lines.push(`### Top ${templates.length} templates by event count`);
    lines.push('');
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const pct = encodedLines.length > 0
        ? ` (${((t.count / encodedLines.length) * 100).toFixed(1)}%)`
        : '';
      lines.push(`**#${i + 1}** \`${t.templateHash}\` · ${t.count} events${pct}`);
      lines.push(`  ${truncate(t.template, 200)}`);
      lines.push('');
    }
  } else {
    lines.push('_No templates extracted. The CLI may not have processed any events._');
    lines.push('');
  }

  // ── 4. Assertions ──
  if (args.expected) {
    lines.push('### Assertions');
    lines.push('');

    const allBodies = templates.map((t) => t.template);
    let totalAssertions = 0;
    let passed = 0;

    if (args.expected.min_templates !== undefined) {
      totalAssertions++;
      const ok = templateMap.size >= args.expected.min_templates;
      if (ok) passed++;
      lines.push(
        `${ok ? 'PASS' : 'FAIL'}: min_templates >= ${args.expected.min_templates} (actual: ${templateMap.size})`
      );
    }

    if (args.expected.required_patterns) {
      for (const pattern of args.expected.required_patterns) {
        totalAssertions++;
        const found = allBodies.some((b) => b.includes(pattern));
        if (found) passed++;
        lines.push(
          `${found ? 'PASS' : 'FAIL'}: required_pattern "${truncate(pattern, 60)}" ${found ? 'found' : 'NOT found'} in template bodies`
        );
      }
    }

    if (args.expected.forbidden_merges) {
      for (const [a, b] of args.expected.forbidden_merges) {
        totalAssertions++;
        const merged = allBodies.some(
          (body) => body.includes(a) && body.includes(b)
        );
        const ok = !merged;
        if (ok) passed++;
        lines.push(
          `${ok ? 'PASS' : 'FAIL'}: forbidden_merge ["${truncate(a, 40)}", "${truncate(b, 40)}"] — ${merged ? 'MERGED (templates share a body containing both)' : 'not merged (correctly separated)'}`
        );
      }
    }

    lines.push('');
    lines.push(`**${passed}/${totalAssertions} assertions passed.**`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Helpers ──

async function runStdin(args: ExtractArgs) {
  let text: string;
  if (args.source === 'events') {
    if (!Array.isArray(args.events) || args.events.length === 0) {
      throw new Error('source=events requires a non-empty `events` array.');
    }
    text = args.events.join('\n');
  } else if (args.source === 'text') {
    if (!args.text?.trim()) {
      throw new Error('source=text requires non-empty `text`.');
    }
    text = args.text;
  } else {
    throw new Error('Invalid source for stdin mode.');
  }
  return runDevCliStdin(text);
}

async function runFile(args: ExtractArgs) {
  if (!args.path) {
    throw new Error('source=file requires a `path` argument.');
  }
  return runDevCliFile(args.path);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
