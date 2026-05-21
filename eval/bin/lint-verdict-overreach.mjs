#!/usr/bin/env node
/**
 * Verdict-overreach lint (validation gate #6, mechanical half).
 *
 * The cross-pillar A/B/SRE comparison and the tool audit
 * (eval/TOOL-AUDIT.md) found the recurring anti-pattern: tools that
 * ASSERT a judgment ("RISING", "safe to drop", "is a cost driver",
 * "filter 80%") instead of returning trustworthy context. A live
 * reasoner reads the same data and judges it better in situ, so the
 * asserted verdict is at best ignored and at worst parroted wrong.
 *
 * This lint flags those asserted-judgment strings in tool RENDER code
 * (user-facing markdown + agent channels). It is the guard that keeps
 * de-verdicting (TOOL-AUDIT Phase 2) from regressing.
 *
 * It is intentionally RED until the de-verdict pass lands. A line can
 * be exempted — for a legitimately neutral use of a flagged word — with
 * a trailing `// verdict-lint-ok: <reason>` comment.
 *
 * Heuristic (no TS parse): a line is a violation when the banned token
 * appears, the line carries a string-literal quote (` ' "), and the
 * line is not a pure comment. Tune RULES per-tool as each is read.
 *
 * Usage: node eval/bin/lint-verdict-overreach.mjs
 * Exits non-zero if any un-exempted violation remains.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpRoot = resolve(evalRoot, '..');
const srcTools = resolve(mcpRoot, 'src/tools');
const srcLib = resolve(mcpRoot, 'src/lib');

/**
 * Banned asserted-verdict patterns. `files` scopes a rule to the tools
 * where that verdict is the audit finding; `null` = all scanned files.
 * Keep patterns tight — they must catch the assertion, not neutral
 * mentions (use `// verdict-lint-ok` for the rare false positive).
 */
const RULES = [
  {
    label: 'asserted-trend',
    // trend.ts: stop ASSERTING RISING/FALLING; return the fine series + signed delta.
    pattern: /\b(RISING|FALLING)\b/,
    files: ['trend.ts'],
    note: 'trend must return the fine series + signed % delta, not an asserted RISING/FALLING label',
  },
  {
    label: 'safe-to-drop',
    // dependency-check.ts: stop asserting "safe to drop/remove"; return the dependency context.
    // (The one hit is the anti-verdict CONSTRAINT line, exempted with verdict-lint-ok.)
    pattern: /safe to (drop|remove)/i,
    files: ['dependency-check.ts'],
    note: 'dependency_check must return dependents, not assert "safe to drop"',
  },
  {
    label: 'ai-filter-verdict',
    // event-lookup.ts: the AI prompt must NOT elicit a routing verdict
    // (ACTION filter/keep/reduce + FILTER_PCT "% safe to filter"). Classify
    // factually; the cost/severity/sample context is already returned.
    pattern: /(FILTER_PCT|safe to filter)/i,
    files: ['event-lookup.ts'],
    note: 'event_lookup must classify factually, not elicit/emit an AI "% safe to filter" routing verdict',
  },
  {
    label: 'real-regression',
    // event-lookup.ts: show the short+7d corroboration FACTS, don't assert the conclusion.
    pattern: /treat as a real regression/i,
    files: ['event-lookup.ts'],
    note: 'event_lookup must show the short+7d corroboration facts, not assert "treat as a real regression"',
  },
];

function listTsFiles(dir, filter) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isFile() && p.endsWith('.ts') && filter(e)) out.push(p);
  }
  return out;
}

// Scan all tool render files + the *-render.ts libs. Per-rule `files`
// narrows where a given verdict pattern applies.
const scanned = [
  ...listTsFiles(srcTools, () => true),
  ...listTsFiles(srcLib, (e) => e.endsWith('-render.ts')),
];

const QUOTE = /[`'"]/;
function isPureComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const violations = [];
for (const file of scanned) {
  const base = file.split('/').pop();
  const applicable = RULES.filter((r) => !r.files || r.files.includes(base));
  if (applicable.length === 0) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/verdict-lint-ok/.test(line)) continue;
    if (isPureComment(line)) continue;
    if (!QUOTE.test(line)) continue; // only user-facing string literals
    for (const r of applicable) {
      if (r.pattern.test(line)) {
        violations.push({
          file: file.replace(mcpRoot + '/', ''),
          line: i + 1,
          label: r.label,
          note: r.note,
          text: line.trim().slice(0, 120),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`[lint-verdict-overreach] ${violations.length} asserted-verdict violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.label}] ${v.text}`);
    console.error(`      → ${v.note}`);
  }
  console.error('');
  console.error('Fix: return the context, not the verdict. Or exempt a neutral use with');
  console.error('a trailing `// verdict-lint-ok: <reason>` comment.');
  process.exit(1);
}

console.error(`[lint-verdict-overreach] clean — scanned ${scanned.length} render files, no asserted verdicts`);
