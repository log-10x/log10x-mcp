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
import { agentOnly } from '../lib/agent-only.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';

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
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope (data.templates[], data.event_count, data.assertions). markdown wraps the rendered report in data.markdown.'),
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
  view?: 'summary' | 'markdown';
}

interface ExtractTemplatesSummary {
  event_count: number;
  distinct_templates: number;
  shown_templates: number;
  cli_wall_time_ms: number;
  cli_version: string | null;
  templates: Array<{
    rank: number;
    template_hash: string;
    template: string;
    event_count: number;
    share_pct: number;
  }>;
  assertions?: {
    passed: number;
    total: number;
    results: Array<{ kind: 'min_templates' | 'required_pattern' | 'forbidden_merge'; ok: boolean; detail: string }>;
  };
}

export async function executeExtractTemplates(args: ExtractArgs): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const telemetry = newTelemetry();
  const sumOut: { data?: ExtractTemplatesSummary } = {};
  const md = await executeExtractTemplatesInner(args, sumOut);
  if (view === 'markdown' || !sumOut.data) {
    return buildMarkdownEnvelope({
      tool: 'log10x_extract_templates',
      summary: { headline: md.split('\n').find((l) => l.trim().length > 0)?.slice(0, 200) ?? 'extract_templates result' },
      markdown: md,
    });
  }
  const d = sumOut.data;
  const headline = `${d.event_count} events → ${d.distinct_templates} distinct template${d.distinct_templates !== 1 ? 's' : ''}${d.assertions ? ` (${d.assertions.passed}/${d.assertions.total} assertions passed)` : ''}.`;
  return buildEnvelope({
    tool: 'log10x_extract_templates',
    view: 'summary',
    summary: { headline },
    data: { ...d, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    truncated: d.shown_templates < d.distinct_templates,
    actions: d.templates.length > 0
      ? [
          { tool: 'log10x_resolve_batch', args: { source: args.source, path: args.path, events: args.events, text: args.text }, reason: 'richer per-pattern triage with variable concentrations on the same input' },
        ]
      : [],
  });
}

async function executeExtractTemplatesInner(args: ExtractArgs, sumOut?: { data?: ExtractTemplatesSummary }): Promise<string> {
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

  // Discoverability: after extracting templates locally, the natural
  // chain is to look up the resulting canonical names against the live
  // env or to run richer per-pattern triage on the same input.
  lines.push('');
  lines.push(agentOnly(
    `Suggested next calls: ` +
    `Look up an extracted template against the live Reporter for cost / severity / services / trend → pass its canonical name (e.g. 'Payment_Gateway_Timeout') to log10x_event_lookup. ` +
    `Richer per-pattern triage with variable concentrations on the same input → log10x_resolve_batch (same input format, structured per-pattern output).`
  ));

  if (sumOut) {
    let assertions: ExtractTemplatesSummary['assertions'];
    if (args.expected) {
      const allBodies = templates.map((t) => t.template);
      const results: NonNullable<ExtractTemplatesSummary['assertions']>['results'] = [];
      let passed = 0;
      if (args.expected.min_templates !== undefined) {
        const ok = templateMap.size >= args.expected.min_templates;
        if (ok) passed++;
        results.push({ kind: 'min_templates', ok, detail: `min_templates >= ${args.expected.min_templates} (actual: ${templateMap.size})` });
      }
      if (args.expected.required_patterns) {
        for (const pattern of args.expected.required_patterns) {
          const found = allBodies.some((b) => b.includes(pattern));
          if (found) passed++;
          results.push({ kind: 'required_pattern', ok: found, detail: `required_pattern "${truncate(pattern, 60)}" ${found ? 'found' : 'NOT found'}` });
        }
      }
      if (args.expected.forbidden_merges) {
        for (const [a, b] of args.expected.forbidden_merges) {
          const merged = allBodies.some((body) => body.includes(a) && body.includes(b));
          const ok = !merged;
          if (ok) passed++;
          results.push({ kind: 'forbidden_merge', ok, detail: `forbidden_merge ["${truncate(a, 40)}", "${truncate(b, 40)}"] — ${merged ? 'MERGED' : 'separated correctly'}` });
        }
      }
      assertions = { passed, total: results.length, results };
    }
    sumOut.data = {
      event_count: encodedLines.length,
      distinct_templates: templateMap.size,
      shown_templates: templates.length,
      cli_wall_time_ms: result.wallTimeMs,
      cli_version: result.cliVersion ?? null,
      templates: templates.map((t, i) => ({
        rank: i + 1,
        template_hash: t.templateHash,
        template: t.template,
        event_count: t.count,
        share_pct: encodedLines.length > 0 ? (t.count / encodedLines.length) * 100 : 0,
      })),
      assertions,
    };
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
