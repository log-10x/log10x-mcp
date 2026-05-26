#!/usr/bin/env node
/**
 * Doc-side page templater.
 *
 * For each tool that has a captured envelope under
 * docs/_includes/tool-envelopes/<tool>.{input,output}.json, locate its
 * markdown page under docs/apps/mcp/tools/<...> and replace any existing
 * "Tool schema (advanced)" block (or insert before the file end if none
 * exists) with the new 4-admonition "Schema and samples" section:
 *
 *   ## :material-code-json: Schema and samples
 *   ??? tenx-input-example "Input example"      ← real JSON we sent
 *   ??? tenx-input-schema  "Input schema"       ← args table from Zod
 *   ??? tenx-output-example "Output example"    ← captured envelope (trimmed)
 *   ??? tenx-output-schema  "Output schema"     ← typed-data TS shape
 *
 * The Input schema table is generated from the Zod inputSchema by reading
 * the published tool definition from `tools/list` (via the same capture
 * harness, separate route). The Output schema TS interface is generated
 * from the captured envelope's data block fields.
 *
 * Idempotent: re-running rewrites only the Schema-and-samples section,
 * preserving the front-matter, opening prose, Example chat block, More
 * to ask, and Prerequisites sections.
 *
 * Usage:
 *   node scripts/update-tool-docs.mjs              # all captured tools
 *   node scripts/update-tool-docs.mjs services     # one tool
 *   LOG10X_DOCS_ROOT=/path/to/docs node ...        # override docs root
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = process.env.LOG10X_DOCS_ROOT
  ? resolve(process.env.LOG10X_DOCS_ROOT)
  : resolve(repoRoot, '..', 'mksite-tmp', 'docs');
const envelopesDir = join(docsRoot, '_includes', 'tool-envelopes');
const toolsDir = join(docsRoot, 'apps', 'mcp', 'tools');

// Tool name -> markdown page path. Derived from the docs nav structure;
// missing pages get logged and skipped.
const PAGE_PATH = {
  // costs
  top_patterns:    'costs/top-patterns.md',
  services:        'costs/services.md',
  savings:         'costs/savings.md',
  discover_labels: 'costs/discover-labels.md',
  // identify
  event_lookup:      'resolution/event-lookup.md',
  resolve_batch:     'resolution/resolve-batch.md',
  pattern_trend:     'resolution/pattern-trend.md',
  extract_templates: 'resolution/extract-templates.md',
  pattern_examples:  'investigation/pattern-examples.md',
  // investigate
  investigate:                  'investigation/investigate.md',
  correlate_cross_pillar:       'investigation/correlate-cross-pillar.md',
  translate_metric_to_patterns: 'investigation/translate-metric-to-patterns.md',
  customer_metrics_query:       'investigation/customer-metrics-query.md',
  discover_join:                'investigation/discover-join.md',
  // detect
  find_skew:             'detect/find-skew.md',
  find_constant_slots:   'detect/find-constant-slots.md',
  find_uuid_in_body:     'detect/find-uuid-in-body.md',
  find_incident_cluster: 'detect/find-incident-cluster.md',
  // drop
  pattern_mitigate:  'drop/pattern-mitigate.md',
  dependency_check:  'drop/dependency-check.md',
  // retrieve
  retriever_query:  'retrieve/retriever-query.md',
  retriever_series: 'retrieve/retriever-series.md',
  backfill_metric:  'retrieve/backfill-metric.md',
  // install
  discover_env:        'install/discover-env.md',
  doctor:              'account/health-check.md',
  advise_install:      'install/advise-install.md',
  advise_reporter:     'install/advise-reporter.md',
  advise_receiver:     'install/advise-receiver.md',
  advise_retriever:    'install/advise-retriever.md',
  configure_compact:   'install/configure-compact.md',
  configure_regulator: 'install/configure-regulator.md',
  configure_env:       'account/configure-env.md',
  // account
  login_status:    'account/login-status.md',
  // signin_start + signin_complete share one page (account/signin.md);
  // we update it once on the first signin_* tool only to avoid double-rewrite.
  signin_start:    'account/signin.md',
  signin_complete: null,
  signout:         'account/signout.md',
  update_settings: 'account/update-settings.md',
  create_env:      'account/create-env.md',
  update_env:      'account/update-env.md',
  delete_env:      'account/delete-env.md',
  rotate_api_key:  'account/rotate-api-key.md',
  // poc (synthetic captures)
  poc_from_siem_submit: 'poc/poc-from-siem-submit.md',
  poc_from_siem_status: 'poc/poc-from-siem-status.md',
  poc_from_local:       'poc/poc-from-local.md',
};

// ── Helpers ────────────────────────────────────────────────────────

/** Trim long arrays / base64 strings so the doc snapshot stays readable. */
function trimForDoc(node, depth = 0) {
  if (Array.isArray(node)) {
    if (node.length === 0) return node;
    // Long arrays: keep first 3 elements + a marker, recurse into each kept entry.
    if (node.length > 3) {
      const kept = node.slice(0, 3).map((x) => trimForDoc(x, depth + 1));
      kept.push(`... ${node.length - 3} more elided`);
      return kept;
    }
    return node.map((x) => trimForDoc(x, depth + 1));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      // trend_bytes_per_sec and similar large-number-array fields: trim hard.
      if (Array.isArray(v) && v.length > 6 && v.every((x) => typeof x === 'number')) {
        out[k] = [...v.slice(0, 3), `... ${v.length - 3} more elided`];
        continue;
      }
      // long base64 PNGs: already replaced by capture script, but be safe.
      if (k === 'data' && typeof v === 'string' && v.length > 200) {
        out[k] = '<base64 PNG omitted; rendered at runtime>';
        continue;
      }
      out[k] = trimForDoc(v, depth + 1);
    }
    return out;
  }
  return node;
}

/** Build a TypeScript-style schema from an envelope's data block. */
function tsSchemaFromData(data) {
  if (data === null || data === undefined) return '// data: null';
  if (typeof data !== 'object' || Array.isArray(data)) {
    return `// data: ${tsTypeOf(data)}`;
  }
  return `interface ToolData {\n${tsBodyFromObject(data, '  ')}\n}`;
}

function tsBodyFromObject(obj, indent) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    const ty = tsTypeOf(v);
    lines.push(`${indent}${k}: ${ty};`);
  }
  return lines.join('\n');
}

function tsTypeOf(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'unknown[]';
    const first = v[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return `Array<{\n    ${Object.entries(first).map(([k, vv]) => `${k}: ${tsTypeOf(vv)}`).join(';\n    ')};\n  }>`;
    }
    return `${tsTypeOf(first)}[]`;
  }
  if (typeof v === 'object') {
    const inner = Object.entries(v).map(([k, vv]) => `${k}: ${tsTypeOf(vv)}`).join('; ');
    return `{ ${inner} }`;
  }
  return 'unknown';
}

// GitHub repo for source links.
const REPO_URL = 'https://github.com/log-10x/log10x-mcp/blob/main';

// Mapping from tool name to its actual source file under src/tools/. Most are
// derived by tool_name.replace(/_/g, '-') but a few don't match (the file
// contains multiple registered tools, or it was renamed at some point).
const SOURCE_FILE = {
  // Multiple tools registered from one file.
  poc_from_siem_submit: 'src/tools/poc-from-siem.ts',
  poc_from_siem_status: 'src/tools/poc-from-siem.ts',
  signin_start:         'src/tools/signin.ts',
  signin_complete:      'src/tools/signin.ts',
  // Filename diverges from tool name.
  pattern_trend:        'src/tools/trend.ts',
};

function sourcePathFor(toolName) {
  return SOURCE_FILE[toolName] ?? `src/tools/${toolName.replace(/_/g, '-')}.ts`;
}

function sourceLink(toolName) {
  const path = sourcePathFor(toolName);
  return `[\`${path}\`](${REPO_URL}/${path})`;
}

/** Generic helper: turn any repo-relative path into a clickable GitHub link. */
function repoLink(repoPath) {
  return `[\`${repoPath}\`](${REPO_URL}/${repoPath})`;
}

/** Render the new "Schema and samples" section for a tool. */
function renderSchemaSection(toolName, inputJson, outputEnvelope) {
  const trimmedOut = trimForDoc(outputEnvelope);
  const tsSchema = tsSchemaFromData(outputEnvelope.data);
  const headline = outputEnvelope.summary?.headline ?? '';
  return `## :material-code-json: Schema and samples

??? tenx-input-example "Input example"

    Real call against the demo env (captured by ${repoLink('scripts/capture-tool-envelopes.mjs')}).

    \`\`\`json
${indent(JSON.stringify(inputJson, null, 2), '    ')}
    \`\`\`

??? tenx-input-schema "Input schema"

    See the Zod schema in ${sourceLink(toolName)}. The agent-facing JSON Schema is published via \`tools/list\` (every Zod \`.default(...)\` materializes as a \`default\` field; every \`.describe(...)\` becomes the \`description\`).

??? tenx-output-example "Output example"

    Real envelope from the demo env. \`view: "summary"\` returns the full \`StructuredOutput\` with typed \`data\`. Long arrays + base64 PNG bodies trimmed for readability; the real call returns them in full.

    Headline (the 1-line agent-facing answer):

    > _${headline.replace(/_/g, '\\_')}_

    \`\`\`json
${indent(JSON.stringify(trimmedOut, null, 2), '    ')}
    \`\`\`

??? tenx-output-schema "Output schema"

    The \`data\` block inside the [StructuredOutput envelope](../index.md#json-by-default-output):

    \`\`\`typescript
${indent(tsSchema, '    ')}
    \`\`\`

    Envelope-level fields the agent should also read: \`summary.headline\` (1-line answer), \`actions[]\` (next-call chain hints as \`{tool, args, reason}\`), \`truncated: boolean\`, \`images[]\` (PNG attachments where applicable), \`schema_epoch\` (engine-ID stability boundary).`;
}

function indent(text, pad) {
  return text.split('\n').map((l) => pad + l).join('\n');
}

/** Replace any existing Schema-section in a page with the new content. */
function rewritePage(pagePath, newSection) {
  const orig = readFileSync(pagePath, 'utf8');
  // The "Schema and samples" H2 (this script's output) gets fully replaced.
  // The legacy single `??? tenx-config "Tool schema (advanced)"` block also
  // gets replaced. We anchor on whichever appears first.
  const newH2Anchor = '## :material-code-json: Schema and samples';
  const legacyAnchor = '??? tenx-config "Tool schema (advanced)"';
  const newH2Idx = orig.indexOf(newH2Anchor);
  const legacyIdx = orig.indexOf(legacyAnchor);
  let cut;
  if (newH2Idx >= 0) {
    cut = newH2Idx;
  } else if (legacyIdx >= 0) {
    cut = legacyIdx;
  } else {
    // No prior schema section — append at end with one blank line spacer.
    const trimmed = orig.replace(/\s+$/, '');
    writeFileSync(pagePath, `${trimmed}\n\n${newSection}\n`);
    return 'appended';
  }
  const head = orig.slice(0, cut).replace(/\s+$/, '');
  writeFileSync(pagePath, `${head}\n\n${newSection}\n`);
  return newH2Idx >= 0 ? 'replaced-new' : 'replaced-legacy';
}

// ── Main ──────────────────────────────────────────────────────────

function main() {
  const filter = process.argv[2] ?? '';
  const tools = readdirSync(envelopesDir)
    .filter((f) => f.endsWith('.output.json'))
    .map((f) => f.replace(/\.output\.json$/, ''))
    .filter((t) => filter === '' || t.includes(filter));

  if (tools.length === 0) {
    process.stderr.write(`No tool envelopes found in ${envelopesDir} matching "${filter}"\n`);
    process.exit(1);
  }

  let updated = 0;
  let missing = 0;
  for (const tool of tools) {
    const pagePath = PAGE_PATH[tool];
    if (pagePath === null) {
      // Intentional skip: another tool covers the same page.
      continue;
    }
    if (!pagePath) {
      process.stderr.write(`SKIP ${tool}: no entry in PAGE_PATH map\n`);
      continue;
    }
    const fullPath = join(toolsDir, pagePath);
    if (!existsSync(fullPath)) {
      process.stderr.write(`SKIP ${tool}: page missing at ${pagePath}\n`);
      missing++;
      continue;
    }
    const inputJson = JSON.parse(readFileSync(join(envelopesDir, `${tool}.input.json`), 'utf8'));
    const outputEnvelope = JSON.parse(readFileSync(join(envelopesDir, `${tool}.output.json`), 'utf8'));
    const section = renderSchemaSection(tool, inputJson, outputEnvelope);
    const mode = rewritePage(fullPath, section);
    updated++;
    process.stderr.write(`  ${tool}: ${mode} (${pagePath})\n`);
  }
  process.stderr.write(`\nUpdated ${updated} pages; ${missing} pages missing.\n`);
}

main();
