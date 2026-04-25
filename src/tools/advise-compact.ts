/**
 * log10x_advise_compact
 *
 * Emits a literal `gh` PR command + the file diff for a compactRegulator
 * change against the customer's GitOps repo. Two modes:
 *
 *   mode='csv' (default) — edit `compact-lookup.csv`. Per-pattern decisions.
 *     Engine reloads the CSV via FileResourceLookup.reset() on the next
 *     gitops poll. **No pipeline restart, no event drops.**
 *
 *   mode='js' — replace `compact-object-global.js` with new predicate
 *     logic. Use when CSV-keyed lookup is insufficient (e.g., regex
 *     match, multi-field-set OR clauses, complex semantics). The
 *     ResourceReloadUnit detects the .js change and calls
 *     restartPipeline() — there is a brief drain + relaunch.
 *
 * Design: this tool is a *renderer*, not a decider. The agent decides
 * what changes (typically using log10x_top_patterns + log10x_cost_drivers
 * for CSV mode; or by reading the current JS + describing the new logic)
 * and passes the result here. The tool emits the diff + a shell snippet
 * — keeping write operations under user control.
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';

export const adviseCompactSchema = {
  gitops_repo: z
    .string()
    .optional()
    .describe(
      'Owner/name of the customer GitOps repo the regulator pod pulls config from (e.g., `acme/log10x-config`). Must match `GH_REPO` set on the regulator pod. Optional when `snapshot_id` is given AND the snapshot detected a regulator pod with `GH_REPO` set — the tool resolves it automatically.'
    ),
  snapshot_id: z
    .string()
    .optional()
    .describe(
      'ID returned by `log10x_discover_env`. When given, the tool resolves `gitops_repo` and `lookup_path` from the running regulator pod\'s env vars (`GH_REPO`, `compactRegulatorLookupFile`). Either `snapshot_id` or `gitops_repo` must be provided.'
    ),
  gitops_branch: z
    .string()
    .optional()
    .describe('Base branch for the PR. Default: `main`.'),
  mode: z
    .enum(['csv', 'js'])
    .optional()
    .describe(
      'What to update. `csv` (default): edit the per-pattern lookup file (engine hot-reloads, no restart). `js`: replace the `compact-object-global.js` predicate (engine triggers a pipeline restart). Pick `js` only when CSV-keyed lookup is insufficient — e.g., the new predicate needs regex, multi-field-set OR semantics, or external state.'
    ),
  lookup_path: z
    .string()
    .optional()
    .describe(
      'Repo-relative path to the compact lookup CSV (mode=csv). Default: `pipelines/run/regulate/compact/compact-lookup.csv` — matches the recommended layout where JS predicate + lookup CSV co-locate in one dir.'
    ),
  js_path: z
    .string()
    .optional()
    .describe(
      'Repo-relative path to the predicate JS file (mode=js). Default: `pipelines/run/regulate/compact/compact-object-global.js`.'
    ),
  field_names: z
    .array(z.string())
    .optional()
    .describe(
      'TenXObject fields joined with `_` to form each event\'s lookup key (must match the regulator\'s `compactRegulatorFieldNames`). Default: `[symbolMessage]`. Used in mode=csv to format example keys in the PR description.'
    ),
  compact: z
    .array(z.string())
    .optional()
    .describe(
      '(mode=csv) Field-set keys to ADD with `true` (compact via encode()). Each entry is the joined key, e.g. `payment_retry_gateway_timeout`.'
    ),
  preserve: z
    .array(z.string())
    .optional()
    .describe(
      '(mode=csv) Field-set keys to ADD with `false` (preserve fullText, e.g. audit/compliance patterns). Use when `compactRegulatorDefault: true` and you want specific patterns to opt OUT of compaction.'
    ),
  remove: z
    .array(z.string())
    .optional()
    .describe(
      '(mode=csv) Field-set keys to REMOVE from the lookup (revert to `compactRegulatorDefault` for those patterns).'
    ),
  current_csv: z
    .string()
    .optional()
    .describe(
      '(mode=csv) Existing CSV content (header + rows). If omitted, the tool emits commands to fetch the current file from the repo before computing the diff. If you already have it (e.g. from `gh api ... | base64 -d`), pass it here for a complete one-shot output.'
    ),
  new_js: z
    .string()
    .optional()
    .describe(
      '(mode=js) Full replacement contents for `compact-object-global.js`. Required when mode=js. Must include the `// @loader: tenx` header, the `@tenx/tenx` import, and an `export class CompactObject extends TenXObject { ... }` declaration with a `shouldEncode` getter. The agent typically composes this by reading the current JS and editing the predicate body.'
    ),
  current_js: z
    .string()
    .optional()
    .describe(
      '(mode=js, optional) The existing JS contents — if provided, the diff section shows changed/added/removed line counts. The PR proceeds either way; `current_js` is purely for diff rendering.'
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'Short rationale (1-2 lines) for the PR description. Example: "OPS-5123: spike on payment_retry; compact through end of incident."'
    ),
  default_decision: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      '(mode=csv) Current value of `compactRegulatorDefault` on the regulator pod (informational; included in the PR description so reviewers know whether entries opt INTO or OUT OF compaction). Default: `false`.'
    ),
};

const schemaObj = z.object(adviseCompactSchema);
export type AdviseCompactArgs = z.infer<typeof schemaObj>;

const DEFAULT_LOOKUP_PATH = 'pipelines/run/regulate/compact/compact-lookup.csv';
const DEFAULT_JS_PATH = 'pipelines/run/regulate/compact/compact-object-global.js';
const DEFAULT_FIELD_NAMES = ['symbolMessage'];
const CSV_HEADER = 'key,value';

interface ParsedCsv {
  rows: Map<string, string>;
}

function parseCsv(content: string | undefined): ParsedCsv {
  const rows = new Map<string, string>();
  if (!content) return { rows };
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase().startsWith('key,value')) continue;
    const idx = trimmed.indexOf(',');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) rows.set(key, value);
  }
  return { rows };
}

function renderCsv(rows: Map<string, string>): string {
  const sorted = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [CSV_HEADER, ...sorted.map(([k, v]) => `${k},${v}`)];
  return lines.join('\n') + '\n';
}

interface DiffSummary {
  added: Array<{ key: string; value: string }>;
  changed: Array<{ key: string; from: string; to: string }>;
  removed: Array<{ key: string; from: string }>;
  unchanged: number;
}

function diff(before: Map<string, string>, after: Map<string, string>): DiffSummary {
  const added: DiffSummary['added'] = [];
  const changed: DiffSummary['changed'] = [];
  const removed: DiffSummary['removed'] = [];
  let unchanged = 0;
  for (const [key, value] of after) {
    if (!before.has(key)) {
      added.push({ key, value });
    } else if (before.get(key) !== value) {
      changed.push({ key, from: before.get(key)!, to: value });
    } else {
      unchanged++;
    }
  }
  for (const [key, value] of before) {
    if (!after.has(key)) {
      removed.push({ key, from: value });
    }
  }
  return { added, changed, removed, unchanged };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolves gitops_repo + lookup_path from a snapshot_id when the caller
 * didn't pass them explicitly. Returns a markdown error string when
 * neither source supplies a repo.
 */
function resolveTarget(args: AdviseCompactArgs): { resolved: AdviseCompactArgs } | { error: string } {
  if (args.gitops_repo) {
    return { resolved: args };
  }
  if (!args.snapshot_id) {
    return {
      error: [
        '# compactRegulator advisor — missing target',
        '',
        'Pass either `gitops_repo` (owner/name) or `snapshot_id` (from `log10x_discover_env`). With a snapshot, the tool resolves the repo from the running regulator pod\'s `GH_REPO` env var.',
      ].join('\n'),
    };
  }
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return {
      error: [
        '# compactRegulator advisor — snapshot not found',
        '',
        `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min). Run \`log10x_discover_env\` again, then re-call this tool with the new snapshot_id (or pass \`gitops_repo\` directly).`,
      ].join('\n'),
    };
  }
  const repo = snapshot.recommendations.regulatorGitopsRepo;
  if (!repo) {
    return {
      error: [
        '# compactRegulator advisor — regulator GitOps not configured',
        '',
        `Snapshot \`${args.snapshot_id}\` did not detect a regulator pod with \`GH_ENABLED=true\` + \`GH_REPO=<owner/name>\` set. The compactRegulator GitOps flow requires a regulator already running with the GitOps env vars wired.`,
        '',
        '**Next steps**:',
        '- If you haven\'t installed the regulator yet, call `log10x_advise_regulator` (or `log10x_advise_install` with `goal=compact`). The plan now includes a "GitOps — MCP-managed runtime config" section that lists every env var to set, including `GH_ENABLED`, `GH_REPO`, `GH_TOKEN`, and `compactRegulatorLookupFile`.',
        '- If the regulator is already running but GitOps env vars are missing, edit the helm values (or the pod\'s env block) to add them.',
        '- To bypass discovery, re-call this tool with `gitops_repo=<owner/name>` directly.',
      ].join('\n'),
    };
  }
  // Snapshot also gives us a default lookup_path, if known.
  const resolved: AdviseCompactArgs = {
    ...args,
    gitops_repo: repo,
    lookup_path:
      args.lookup_path ?? snapshot.recommendations.regulatorCompactLookupFile ?? undefined,
  };
  return { resolved };
}

export async function executeAdviseCompact(args: AdviseCompactArgs): Promise<string> {
  const r = resolveTarget(args);
  if ('error' in r) return r.error;
  const resolved = r.resolved;
  const mode = resolved.mode ?? 'csv';
  if (mode === 'js') {
    return executeJsMode(resolved);
  }
  return executeCsvMode(resolved);
}

async function executeCsvMode(args: AdviseCompactArgs): Promise<string> {
  // Guaranteed non-null by resolveTarget at the public entry point.
  const repo = args.gitops_repo as string;
  const branch = args.gitops_branch ?? 'main';
  const lookupPath = args.lookup_path ?? DEFAULT_LOOKUP_PATH;
  const fieldNames = args.field_names && args.field_names.length > 0 ? args.field_names : DEFAULT_FIELD_NAMES;
  const compactKeys = args.compact ?? [];
  const preserveKeys = args.preserve ?? [];
  const removeKeys = args.remove ?? [];
  const reason = args.reason?.trim() ?? '';
  const defaultDecision = args.default_decision ?? 'false';

  if (compactKeys.length + preserveKeys.length + removeKeys.length === 0) {
    return [
      '# compactRegulator advisor — nothing to do',
      '',
      'No keys passed in `compact`, `preserve`, or `remove`. Nothing to write.',
      '',
      'Typical flow:',
      '1. Run `log10x_top_patterns` to identify cost-driver patterns.',
      '2. Decide which to compact (high-volume, low-debug-value) vs preserve (audit, compliance).',
      '3. Re-call this tool with the keys partitioned across `compact` / `preserve` / `remove`.',
      '',
      'For predicate-logic changes (regex, multi-field-set OR, etc.), use `mode=js` with the new JS contents in `new_js`.',
    ].join('\n');
  }

  const overlapCompactPreserve = compactKeys.filter((k) => preserveKeys.includes(k));
  if (overlapCompactPreserve.length > 0) {
    return [
      '# compactRegulator advisor — invalid input',
      '',
      `Keys appear in both \`compact\` and \`preserve\`: ${overlapCompactPreserve.join(', ')}.`,
      'A field-set key can be one or the other, not both. Resolve and re-call.',
    ].join('\n');
  }

  const before = parseCsv(args.current_csv).rows;
  const after = new Map(before);
  for (const k of compactKeys) after.set(k, 'true');
  for (const k of preserveKeys) after.set(k, 'false');
  for (const k of removeKeys) after.delete(k);

  const summary = diff(before, after);
  const newCsv = renderCsv(after);

  const fieldNameStr = fieldNames.join('_');
  const prTitle =
    summary.added.length + summary.changed.length + summary.removed.length === 1
      ? `compact: update 1 entry`
      : `compact: update ${summary.added.length + summary.changed.length + summary.removed.length} entries`;

  const prBranchHint = `mcp/compact-${Date.now()}`;

  const out: string[] = [];
  out.push(`# compactRegulator advisor — PR plan for \`${repo}\``);
  out.push('');
  out.push(`**Lookup file**: \`${lookupPath}\``);
  out.push(`**Field-set key format**: \`${fieldNameStr}\` (joined with \`_\`)`);
  out.push(`**Default decision** (no entry matches): \`${defaultDecision}\``);
  out.push('');
  out.push('## Diff');
  out.push('');
  if (summary.added.length > 0) {
    out.push(`### Added (${summary.added.length})`);
    for (const { key, value } of summary.added) {
      const semantic = value === 'true' ? 'compact via encode()' : 'preserve fullText';
      out.push(`- \`${key},${value}\` — ${semantic}`);
    }
    out.push('');
  }
  if (summary.changed.length > 0) {
    out.push(`### Changed (${summary.changed.length})`);
    for (const { key, from, to } of summary.changed) {
      out.push(`- \`${key}\`: \`${from}\` → \`${to}\``);
    }
    out.push('');
  }
  if (summary.removed.length > 0) {
    out.push(`### Removed (${summary.removed.length}) — revert to default \`${defaultDecision}\``);
    for (const { key, from } of summary.removed) {
      out.push(`- \`${key}\` (was \`${from}\`)`);
    }
    out.push('');
  }
  out.push(`Total entries after change: **${after.size}** (was ${before.size}, unchanged ${summary.unchanged})`);
  out.push('');

  out.push('## New file content');
  out.push('');
  out.push('```csv');
  out.push(newCsv.trimEnd());
  out.push('```');
  out.push('');

  out.push('## Apply via `gh`');
  out.push('');
  out.push('Pick one of the two flows below. Both create a PR against `' + repo + '` (`' + branch + '`) — review and merge through your normal workflow. The engine hot-reloads the CSV via `FileResourceLookup.reset()` on next gitops poll; **no pipeline restart, no event drops**.');
  out.push('');

  out.push('### Flow A — single shell snippet (one paste)');
  out.push('');
  out.push('```bash');
  out.push('set -euo pipefail');
  out.push(`REPO=${shellQuote(repo)}`);
  out.push(`BASE=${shellQuote(branch)}`);
  out.push(`LOOKUP_PATH=${shellQuote(lookupPath)}`);
  out.push(`BRANCH=${shellQuote(prBranchHint)}`);
  out.push(`PR_TITLE=${shellQuote(prTitle)}`);
  out.push('');
  out.push('# Write new CSV to a tempfile');
  out.push('TMPFILE=$(mktemp)');
  out.push("cat > \"$TMPFILE\" <<'CSV_EOF'");
  out.push(newCsv.trimEnd());
  out.push('CSV_EOF');
  out.push('');
  out.push('# Fetch current SHA (needed for update; empty for create)');
  out.push('CUR_SHA=$(gh api "/repos/$REPO/contents/$LOOKUP_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)');
  out.push('');
  out.push('# Commit the new content on a fresh branch (gh api creates the branch if absent)');
  out.push('CONTENT_B64=$(base64 < "$TMPFILE" | tr -d "\\n")');
  out.push('PUT_ARGS=( -X PUT "/repos/$REPO/contents/$LOOKUP_PATH"');
  out.push(`  -f branch="$BRANCH"`);
  out.push(`  -f message="$PR_TITLE"`);
  out.push(`  -f content="$CONTENT_B64" )`);
  out.push('[ -n "$CUR_SHA" ] && PUT_ARGS+=( -f sha="$CUR_SHA" )');
  out.push('gh api "${PUT_ARGS[@]}"');
  out.push('');
  out.push('# Open the PR');
  out.push(`gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \\`);
  out.push(`  --title "$PR_TITLE" \\`);
  out.push(`  --body ${shellQuote(buildPrBody(summary, lookupPath, fieldNameStr, defaultDecision, reason))}`);
  out.push('```');
  out.push('');

  out.push('### Flow B — clone + edit + push (if you prefer a local working copy)');
  out.push('');
  out.push('```bash');
  out.push(`gh repo clone ${repo} /tmp/gitops-${Date.now()} -- --depth 1 --branch ${branch}`);
  out.push(`cd /tmp/gitops-${Date.now()}`);
  out.push(`git checkout -b ${prBranchHint}`);
  out.push(`mkdir -p "$(dirname ${lookupPath})"`);
  out.push(`cat > ${lookupPath} <<'CSV_EOF'`);
  out.push(newCsv.trimEnd());
  out.push('CSV_EOF');
  out.push(`git add ${lookupPath}`);
  out.push(`git commit -m ${shellQuote(prTitle)}`);
  out.push(`git push -u origin ${prBranchHint}`);
  out.push(`gh pr create --base ${branch} --title ${shellQuote(prTitle)}`);
  out.push('```');
  out.push('');

  if (!args.current_csv) {
    out.push('> **Note**: `current_csv` was not provided. The tool computed the diff against an empty baseline. If the file already exists in the repo, fetch it first and re-call this tool with `current_csv` for an accurate diff:');
    out.push('>');
    out.push('> ```bash');
    out.push(`> gh api "/repos/${repo}/contents/${lookupPath}?ref=${branch}" --jq .content | base64 -d`);
    out.push('> ```');
    out.push('');
  }

  out.push('## After merge');
  out.push('');
  out.push(`The regulator pod\'s gitops puller (\`pipelines/gitops/config.yaml\`, default 30s poll) re-fetches the file. \`FileResourceLookup.reset()\` fires on the file-watcher event. New entries take effect within the poll interval. **No pod restart, no event drops.**`);
  out.push('');
  out.push('To verify in-cluster after merge:');
  out.push('```bash');
  out.push('kubectl logs -l app.kubernetes.io/name=regulator -c regulator --tail=200 | grep -i "resource reload"');
  out.push('# expected line within ~30s of merge:');
  out.push('# resource reload: resetting pipeline unit ... modified resources: [...compact-lookup.csv]');
  out.push('```');

  return out.join('\n');
}

function buildPrBody(
  summary: DiffSummary,
  lookupPath: string,
  fieldNameStr: string,
  defaultDecision: string,
  reason: string
): string {
  const lines: string[] = [];
  lines.push('Compact-lookup update authored via the log10x MCP advisor.');
  lines.push('');
  lines.push(`**File**: \`${lookupPath}\``);
  lines.push(`**Key format**: \`${fieldNameStr}\` (joined with underscores)`);
  lines.push(`**Default decision** (no entry matches): \`${defaultDecision}\``);
  if (reason) {
    lines.push('');
    lines.push(`**Rationale**: ${reason}`);
  }
  lines.push('');
  lines.push('### Changes');
  if (summary.added.length > 0) {
    lines.push(`- Added ${summary.added.length}: ${summary.added.map((e) => `\`${e.key}\`=\`${e.value}\``).join(', ')}`);
  }
  if (summary.changed.length > 0) {
    lines.push(`- Changed ${summary.changed.length}: ${summary.changed.map((e) => `\`${e.key}\` ${e.from}→${e.to}`).join(', ')}`);
  }
  if (summary.removed.length > 0) {
    lines.push(`- Removed ${summary.removed.length}: ${summary.removed.map((e) => `\`${e.key}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('Engine impact: lookup hot-reloads via `FileResourceLookup.reset()` on the next gitops poll. No pipeline restart.');
  return lines.join('\n');
}

interface JsLineDiff {
  added: number;
  removed: number;
  unchanged: number;
}

function lineDiff(before: string | undefined, after: string): JsLineDiff {
  const beforeLines = (before ?? '').split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of afterLines) (beforeSet.has(l) ? unchanged++ : added++);
  for (const l of beforeLines) (afterSet.has(l) ? null : removed++);
  return { added, removed, unchanged };
}

function validateJsContents(js: string): string | null {
  if (!js.includes('// @loader: tenx')) {
    return 'missing `// @loader: tenx` header — the engine\'s script parser uses this to recognize the file as a tenx module';
  }
  if (!js.match(/import\s+\{[^}]*\}\s+from\s+['"]@tenx\/tenx['"]/)) {
    return 'missing `import { ... } from \'@tenx/tenx\'` — predicate must import the framework symbols it uses (TenXObject, TenXEnv, TenXLookup, TenXString, etc.)';
  }
  if (!js.match(/export\s+class\s+CompactObject\s+extends\s+TenXObject\s*\{/)) {
    return 'missing `export class CompactObject extends TenXObject { ... }` — the engine binds the predicate via this class name';
  }
  if (!js.match(/get\s+shouldEncode\s*\(\s*\)\s*\{/)) {
    return 'missing `get shouldEncode() { ... }` getter on `CompactObject` — the forwarder output stream calls this per event';
  }
  return null;
}

async function executeJsMode(args: AdviseCompactArgs): Promise<string> {
  // Guaranteed non-null by resolveTarget at the public entry point.
  const repo = args.gitops_repo as string;
  const branch = args.gitops_branch ?? 'main';
  const jsPath = args.js_path ?? DEFAULT_JS_PATH;
  const newJs = args.new_js;
  const reason = args.reason?.trim() ?? '';

  if (!newJs || newJs.trim().length === 0) {
    return [
      '# compactRegulator advisor (js mode) — missing input',
      '',
      'Required arg `new_js` is empty. Pass the FULL replacement contents of `compact-object-global.js` (the tool overwrites the file rather than patching it).',
      '',
      'Typical flow:',
      '1. Fetch the current JS from the repo:',
      '   ```bash',
      `   gh api "/repos/${repo}/contents/${jsPath}?ref=${branch}" --jq .content | base64 -d`,
      '   ```',
      '2. Edit the predicate body. Common shapes:',
      '   - Add a regex match: `if (TenXString.matches(this.fullText, "^GET /healthz")) return false;`',
      '   - Multi-field OR: lookup against several fieldSets and OR the results.',
      '   - External-flag gate: `if (TenXEnv.get("compactKillSwitch") == "true") return false;`',
      '3. Re-call this tool with `mode=js`, `new_js=<full new contents>`, and optionally `current_js=<old contents>` for a line-diff in the output.',
      '',
      '**Engine impact when this PR merges**: ResourceReloadUnit detects the .js change and calls `restartPipeline()`. There is a brief drain + relaunch (typically <5s on a regulator pod). For zero-restart changes, prefer `mode=csv`.',
    ].join('\n');
  }

  const validationErr = validateJsContents(newJs);
  if (validationErr) {
    return [
      '# compactRegulator advisor (js mode) — invalid `new_js`',
      '',
      `The replacement JS does not match the shape the engine\'s script parser expects: ${validationErr}.`,
      '',
      'Re-call with a corrected `new_js`. Reference the current shape:',
      '',
      '```bash',
      `gh api "/repos/${repo}/contents/${jsPath}?ref=${branch}" --jq .content | base64 -d`,
      '```',
    ].join('\n');
  }

  const stats = lineDiff(args.current_js, newJs);
  const prBranchHint = `mcp/compact-js-${Date.now()}`;
  const prTitle = 'compact: replace shouldEncode predicate (pipeline restart)';

  const out: string[] = [];
  out.push(`# compactRegulator advisor (js mode) — PR plan for \`${repo}\``);
  out.push('');
  out.push(`**Predicate file**: \`${jsPath}\``);
  out.push(`**Engine impact**: \`ResourceReloadUnit\` watches \`.js\` files. On change → \`restartPipeline()\` (brief drain + relaunch). **NOT a hot reload.** Use \`mode=csv\` instead if a per-pattern lookup change suffices.`);
  out.push('');
  out.push('## Diff (line-set, not positional)');
  out.push('');
  if (args.current_js) {
    const total = stats.added + stats.removed + stats.unchanged;
    out.push(`- Lines added: **${stats.added}**`);
    out.push(`- Lines removed: **${stats.removed}**`);
    out.push(`- Lines unchanged: ${stats.unchanged} of ${total}`);
  } else {
    out.push('_`current_js` not provided — diff is the full new file (treated as create-or-overwrite)._');
  }
  out.push('');

  out.push('## New file content');
  out.push('');
  out.push('```javascript');
  out.push(newJs.trimEnd());
  out.push('```');
  out.push('');

  out.push('## Apply via `gh`');
  out.push('');
  out.push('```bash');
  out.push('set -euo pipefail');
  out.push(`REPO=${shellQuote(repo)}`);
  out.push(`BASE=${shellQuote(branch)}`);
  out.push(`JS_PATH=${shellQuote(jsPath)}`);
  out.push(`BRANCH=${shellQuote(prBranchHint)}`);
  out.push(`PR_TITLE=${shellQuote(prTitle)}`);
  out.push('');
  out.push('TMPFILE=$(mktemp)');
  out.push("cat > \"$TMPFILE\" <<'JS_EOF'");
  out.push(newJs.trimEnd());
  out.push('JS_EOF');
  out.push('');
  out.push('CUR_SHA=$(gh api "/repos/$REPO/contents/$JS_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)');
  out.push('CONTENT_B64=$(base64 < "$TMPFILE" | tr -d "\\n")');
  out.push('PUT_ARGS=( -X PUT "/repos/$REPO/contents/$JS_PATH"');
  out.push(`  -f branch="$BRANCH"`);
  out.push(`  -f message="$PR_TITLE"`);
  out.push(`  -f content="$CONTENT_B64" )`);
  out.push('[ -n "$CUR_SHA" ] && PUT_ARGS+=( -f sha="$CUR_SHA" )');
  out.push('gh api "${PUT_ARGS[@]}"');
  out.push('');
  out.push(`gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \\`);
  out.push(`  --title "$PR_TITLE" \\`);
  out.push(`  --body ${shellQuote(buildJsPrBody(jsPath, stats, !!args.current_js, reason))}`);
  out.push('```');
  out.push('');

  out.push('## After merge');
  out.push('');
  out.push(`The regulator pod\'s gitops puller fetches the new JS on its next poll. The \`ResourceReloadUnit\` (engine 1.0.10+) sees the file change, classifies \`.js\` as a config file, and calls \`pipeline.restart()\`. Drain + relaunch is typically under 5 seconds for a regulator pod, but it IS a real restart — events in flight may be re-emitted by the upstream forwarder once tenx is back.`);
  out.push('');
  out.push('To verify in-cluster after merge:');
  out.push('```bash');
  out.push('kubectl logs -l app.kubernetes.io/name=regulator -c regulator --tail=200 | grep -i "config file.*changed, restarting pipeline"');
  out.push('# expected line within ~30s of merge:');
  out.push('# Config file .../compact-object-global.js changed, restarting pipeline.');
  out.push('```');

  return out.join('\n');
}

function buildJsPrBody(jsPath: string, stats: JsLineDiff, hasBaseline: boolean, reason: string): string {
  const lines: string[] = [];
  lines.push('Compact predicate (`shouldEncode`) replacement authored via the log10x MCP advisor.');
  lines.push('');
  lines.push(`**File**: \`${jsPath}\``);
  if (hasBaseline) {
    lines.push(`**Diff**: +${stats.added} / -${stats.removed} (${stats.unchanged} unchanged)`);
  } else {
    lines.push('**Diff**: full replacement (no baseline supplied to the advisor)');
  }
  if (reason) {
    lines.push('');
    lines.push(`**Rationale**: ${reason}`);
  }
  lines.push('');
  lines.push('### Engine impact');
  lines.push('`ResourceReloadUnit` watches `.js` files. On change → `restartPipeline()` (brief drain + relaunch — NOT a hot reload like CSV changes).');
  lines.push('');
  lines.push('Reviewer checklist:');
  lines.push('- Predicate still gates on `compactRegulatorLookupFile` via `static shouldLoad(c) { ... }` so the module remains opt-in.');
  lines.push('- `shouldEncode` returns `false` for `!this.isObject` and `this.isDropped` (defensive guards).');
  lines.push('- No `parts[N]` indexing on a local `var parts = TenXString.split(...)` — translates to a field lookup, returns empty (DSL gap).');
  lines.push('- No `===` or `!==` (tenx DSL comparisons are content-based with `==` / `TenXString.startsWith` etc).');
  return lines.join('\n');
}
