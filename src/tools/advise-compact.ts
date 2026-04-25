/**
 * log10x_advise_compact
 *
 * Emits a literal `gh` PR command + the file diff for a compactRegulator
 * lookup-CSV update against the customer's GitOps repo. The engine hot-reloads
 * the CSV without a pipeline restart, so per-pattern compaction decisions
 * land in seconds once the PR is merged.
 *
 * v1 scope: CSV edits only. JS predicate updates (which trigger a full
 * pipeline restart via ResourceReloadUnit) are a follow-up.
 *
 * Design: this tool is a *renderer*, not a decider. The agent decides which
 * patterns to compact (typically using log10x_top_patterns + log10x_cost_drivers)
 * and passes the lists to this tool. The tool emits the CSV diff + a shell
 * snippet the user runs — keeping write operations under user control.
 */

import { z } from 'zod';

export const adviseCompactSchema = {
  gitops_repo: z
    .string()
    .describe(
      'Owner/name of the customer GitOps repo the regulator pod pulls config from (e.g., `acme/log10x-config`). Must match `GH_REPO` set on the regulator pod.'
    ),
  gitops_branch: z
    .string()
    .optional()
    .describe('Base branch for the PR. Default: `main`.'),
  lookup_path: z
    .string()
    .optional()
    .describe(
      'Repo-relative path to the compact lookup CSV. Default: `pipelines/run/regulate/compact/compact-lookup.csv` — matches the recommended layout where JS predicate + lookup CSV co-locate in one dir.'
    ),
  field_names: z
    .array(z.string())
    .optional()
    .describe(
      'TenXObject fields joined with `_` to form each event\'s lookup key (must match the regulator\'s `compactRegulatorFieldNames`). Default: `[symbolMessage]`. Used here only to format example keys in the PR description.'
    ),
  compact: z
    .array(z.string())
    .optional()
    .describe(
      'Field-set keys to ADD with `true` (compact via encode()). Each entry is the joined key, e.g. `payment_retry_gateway_timeout`.'
    ),
  preserve: z
    .array(z.string())
    .optional()
    .describe(
      'Field-set keys to ADD with `false` (preserve fullText, e.g. audit/compliance patterns). Use when `compactRegulatorDefault: true` and you want specific patterns to opt OUT of compaction.'
    ),
  remove: z
    .array(z.string())
    .optional()
    .describe(
      'Field-set keys to REMOVE from the lookup (revert to `compactRegulatorDefault` for those patterns).'
    ),
  current_csv: z
    .string()
    .optional()
    .describe(
      'Existing CSV content (header + rows). If omitted, the tool emits commands to fetch the current file from the repo before computing the diff. If you already have it (e.g. from `gh api ... | base64 -d`), pass it here for a complete one-shot output.'
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
      'Current value of `compactRegulatorDefault` on the regulator pod (informational; included in the PR description so reviewers know whether entries opt INTO or OUT OF compaction). Default: `false`.'
    ),
};

const schemaObj = z.object(adviseCompactSchema);
export type AdviseCompactArgs = z.infer<typeof schemaObj>;

const DEFAULT_LOOKUP_PATH = 'pipelines/run/regulate/compact/compact-lookup.csv';
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

export async function executeAdviseCompact(args: AdviseCompactArgs): Promise<string> {
  const repo = args.gitops_repo;
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
