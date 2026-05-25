/**
 * log10x_configure_compact
 *
 * Emits a `gh` PR command against the compact receiver's cap-lookup CSV
 * (`pipelines/run/receive/compact/compact-cap.csv` by default). Mirrors
 * `log10x_configure_regulator` shape: two-phase service-to-container
 * resolution, gitops-friendly PR rendering. This tool is a renderer +
 * resolver, not a writer — the agent runs the emitted snippet to open a
 * PR that the human reviews and merges.
 *
 * Compact's per-event decision is binary (compact via `encode()` or
 * preserve `fullText`), so there is no derivation step — the operator
 * picks containers to compact, the tool emits the rows. Unlisted
 * containers fall back to `compactReceiverDefault` in the engine.
 *
 * Two-phase flow:
 *   Phase 1 — agent calls with `service=<name>` (no `containers`). Tool
 *     resolves the service to a candidate set of k8s_container values
 *     via Prometheus, presents them with observed volume, and asks the
 *     agent to confirm.
 *   Phase 2 — agent re-calls with `containers=[<...>]`. Tool emits the
 *     PR command.
 *
 * Zero engine ask: the resolution query uses existing receive-aggregator
 * metrics (all_events_summaryBytes_total labeled by k8s_container).
 * Gitops PR uses the same `gh` machinery as configure_regulator.
 *
 * Engine contract (post-WS3): the cap-file is CSV with a `container,value`
 * header; each entry decides `true` (compact) or `false` (preserve), with
 * optional `:<untilEpochSec>[:<reason>]` suffix. The engine hot-reloads
 * on in-place writes (the gitops pattern). Kubernetes ConfigMap mounts
 * don't reload — see the compact module's doc.md.
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import {
  resolveBackend,
  CustomerMetricsNotConfiguredError,
  formatDetectionTrace,
} from '../lib/customer-metrics.js';
import { loadEnvironments } from '../lib/environments.js';
import type { PrometheusResponse } from '../lib/api.js';

// ─── constants ────────────────────────────────────────────────────────
const DEFAULT_LOOKUP_PATH = 'pipelines/run/receive/compact/compact-cap.csv';

// ─── schema ───────────────────────────────────────────────────────────
export const configureCompactSchema = {
  service: z
    .string()
    .describe(
      'Customer-vocabulary name of the service to configure (e.g., `payment-service`). The tool resolves this to a set of `k8s_container` values via Prometheus and asks the agent to confirm if multiple candidates match.'
    ),
  containers: z
    .array(z.string())
    .optional()
    .describe(
      'Explicit list of k8s_container values to apply the decision to. If omitted, the tool resolves `service` to candidates and presents them; the agent re-calls with this parameter to commit. Each entry becomes one row in the cap CSV.'
    ),
  decision: z
    .enum(['true', 'false'])
    .default('true')
    .describe(
      'Per-container decision to write into the cap-file. `true` (default) compacts via `encode()` — typical use, 20-40× volume reduction. `false` explicitly preserves `fullText` for the listed containers, beating the `compactReceiverDefault` (use sparingly: audit/compliance containers that must stay verbose even when default is opt-in).'
    ),
  until_epoch_sec: z
    .number()
    .int()
    .optional()
    .describe(
      'Optional Unix-epoch (seconds) expiry for the decision. Past it the entry self-heals to a no-op and the container falls back to `compactReceiverDefault`. Omit for an open-ended decision.'
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'Optional free-text audit string written into each row (commas are escaped to semicolons to preserve CSV integrity). Defaults to "MCP-configured compaction for <service>".'
    ),
  observationDays: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe(
      'Days of Prometheus history to use for candidate-container observed volume. Default 7 (captures a full weekday/weekend cycle).'
    ),
  snapshot_id: z
    .string()
    .optional()
    .describe(
      'ID returned by `log10x_discover_env`. Used to resolve `gitops_repo` and `lookup_path` defaults. Either `snapshot_id` or `gitops_repo` is required.'
    ),
  gitops_repo: z
    .string()
    .optional()
    .describe(
      'Owner/name of the customer gitops repo (e.g., `acme/log10x-config`). Used when no snapshot is provided. Falls back to `gitops.repo` in `~/.log10x/envs.json` if omitted.'
    ),
  gitops_branch: z.string().optional().describe('Base branch for the PR. Default: `main`.'),
  lookup_path: z
    .string()
    .optional()
    .describe(`Repo-relative path to the cap-file CSV. Default: \`${DEFAULT_LOOKUP_PATH}\`.`),
  current_csv: z
    .string()
    .optional()
    .describe(
      'Existing CSV content (header + rows). If omitted, the tool emits commands to fetch it from the repo before computing the diff. Pass it for a one-shot output.'
    ),
};

const schemaObj = z.object(configureCompactSchema);
export type ConfigureCompactArgs = z.infer<typeof schemaObj>;

type ResolvedTarget = ConfigureCompactArgs & {
  gitops_repo: string;
  lookup_path: string;
};

// ─── main entry ───────────────────────────────────────────────────────
export async function executeConfigureCompact(
  args: ConfigureCompactArgs
): Promise<string> {
  // Phase 0: resolve gitops target.
  const target = await resolveTarget(args);
  if ('error' in target) return target.error;

  // Phase 1: Prometheus backend.
  let backend;
  try {
    const r = await resolveBackend();
    if (!r.backend) {
      throw new CustomerMetricsNotConfiguredError(formatDetectionTrace(r.trace));
    }
    backend = r.backend;
  } catch (e: any) {
    return renderError(
      'Customer metrics backend not configured',
      e?.message ?? String(e)
    );
  }

  // Phase 2: service → candidate containers if not yet committed.
  if (!args.containers || args.containers.length === 0) {
    return await renderResolutionPrompt(args, backend);
  }

  // Phase 3: emit PR command (no derivation needed; compact decision is binary).
  return renderResult(args, target.resolved);
}

// ─── target resolution ────────────────────────────────────────────────
async function resolveTarget(
  args: ConfigureCompactArgs
): Promise<{ resolved: ResolvedTarget } | { error: string }> {
  let repo: string | undefined = args.gitops_repo;
  let lookupPath: string | undefined = args.lookup_path;

  // 1. Active env from envs.json.
  if (!repo) {
    try {
      const envs = await loadEnvironments();
      const active = (envs as any)?.activeEnv;
      if (active?.gitops?.repo) {
        repo = active.gitops.repo;
        lookupPath = lookupPath ?? active.gitops.compactLookupPath ?? undefined;
      }
    } catch {
      // non-fatal
    }
  }

  // 2. Snapshot fallback.
  if (!repo && args.snapshot_id) {
    const snapshot = getSnapshot(args.snapshot_id);
    if (!snapshot) {
      return {
        error: renderError(
          'snapshot not found',
          `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min). Run \`log10x_discover_env\` again or pass \`gitops_repo\` directly.`
        ),
      };
    }
    repo = (snapshot as any)?.recommendations?.gitopsRepo;
  }

  if (!repo) {
    return {
      error: renderError(
        'gitops repo not resolved',
        'Pass `gitops_repo` (owner/name), set `gitops.repo` in `~/.log10x/envs.json` for a stable per-env default, or pass `snapshot_id` so the tool can read it from the discovered receiver pod.'
      ),
    };
  }

  return {
    resolved: {
      ...args,
      gitops_repo: repo,
      lookup_path: lookupPath ?? DEFAULT_LOOKUP_PATH,
    },
  };
}

// ─── service-to-container resolution ──────────────────────────────────
interface Candidate {
  container: string;
  observedGB: number;
  distinctPods: number;
}

async function renderResolutionPrompt(
  args: ConfigureCompactArgs,
  backend: any
): Promise<string> {
  const service = args.service;
  const days = args.observationDays ?? 7;

  const filter = `k8s_container=~".*${promEscape(service)}.*"`;
  const bytesQ = `sum by (k8s_container)(increase(all_events_summaryBytes_total{${filter}}[${days}d])) / 1e9`;
  const podsQ = `count by (k8s_container)(count by (k8s_container, k8s_pod)(rate(all_events_summaryBytes_total{${filter}}[5m]) > 0))`;

  const [bytesRes, podsRes] = await Promise.all([
    backend.queryInstant(bytesQ) as Promise<PrometheusResponse>,
    backend.queryInstant(podsQ) as Promise<PrometheusResponse>,
  ]);

  const candidates = new Map<string, Candidate>();
  for (const r of bytesRes.data.result) {
    const k = r.metric.k8s_container;
    if (!k) continue;
    candidates.set(k, {
      container: k,
      observedGB: parseFloat(r.value?.[1] ?? '0'),
      distinctPods: 0,
    });
  }
  for (const r of podsRes.data.result) {
    const k = r.metric.k8s_container;
    if (!k) continue;
    const cur = candidates.get(k) ?? {
      container: k,
      observedGB: 0,
      distinctPods: 0,
    };
    cur.distinctPods = Math.round(parseFloat(r.value?.[1] ?? '0'));
    candidates.set(k, cur);
  }

  if (candidates.size === 0) {
    return renderError(
      'no containers match the service',
      `No \`k8s_container\` values matched substring \`${service}\` over the last ${days} days. Check the service name; you can list known services with \`log10x_services\`.`
    );
  }

  const sorted = [...candidates.values()].sort(
    (a, b) => b.observedGB - a.observedGB
  );
  const exact = candidates.get(service);

  const lines: string[] = [];
  lines.push(`# configure_compact — resolve \`service=${service}\` to containers`);
  lines.push('');
  lines.push(
    `Found **${candidates.size}** k8s_container value(s) matching \`${service}\` over the last ${days} days:`
  );
  lines.push('');
  lines.push('| k8s_container | observed (GB) | distinct pods |');
  lines.push('|---|---:|---:|');
  for (const c of sorted) {
    const marker = c.container === service ? ' ← exact match' : '';
    lines.push(
      `| \`${c.container}\`${marker} | ${c.observedGB.toFixed(2)} | ${c.distinctPods} |`
    );
  }
  lines.push('');

  const decision = args.decision ?? 'true';
  if (exact) {
    lines.push(
      `**Recommendation**: apply the decision to \`${service}\` only (the primary container). Sidecars (e.g., istio-proxy, datadog-agent) typically have predictable volumes and benefit less from per-container compaction.`
    );
    lines.push('');
    lines.push('To proceed with the default:');
    lines.push('');
    lines.push('```');
    lines.push(
      `configure_compact(service="${service}", containers=["${service}"], decision="${decision}")`
    );
    lines.push('```');
    lines.push('');
    lines.push('Add other containers to the array to include them — each gets the same decision.');
  } else {
    lines.push(
      `No exact match for \`${service}\`. Pick the container(s) the decision should apply to:`
    );
    lines.push('');
    lines.push('```');
    const allList = sorted.map((c) => `"${c.container}"`).join(', ');
    lines.push(
      `configure_compact(service="${service}", containers=[${allList}], decision="${decision}")`
    );
    lines.push('```');
  }
  lines.push('');
  lines.push(
    `When you re-call with \`containers=[...]\`, the tool emits the \`gh\` PR command against your gitops repo.`
  );

  return lines.join('\n');
}

// ─── rendering ────────────────────────────────────────────────────────
function renderResult(
  args: ConfigureCompactArgs,
  resolved: ResolvedTarget
): string {
  const containers = args.containers!;
  const decision = args.decision ?? 'true';
  const action = decision === 'true' ? 'compact via `encode()`' : 'preserve `fullText`';

  const out: string[] = [];
  out.push(`# configure_compact — \`${args.service}\``);
  out.push('');
  out.push(
    `**Containers** (${containers.length}): ${containers.map((c) => `\`${c}\``).join(', ')}`
  );
  out.push(`**Decision**: \`${decision}\` (${action})`);
  if (args.until_epoch_sec) {
    const dt = new Date(args.until_epoch_sec * 1000).toISOString();
    out.push(`**Expires**: \`${args.until_epoch_sec}\` (${dt})`);
  }
  out.push('');

  out.push(renderPrCommand(args, resolved));
  return out.join('\n');
}

function renderPrCommand(
  args: ConfigureCompactArgs,
  resolved: ResolvedTarget
): string {
  const repo = resolved.gitops_repo;
  const branch = args.gitops_branch ?? 'main';
  const lookupPath = resolved.lookup_path;
  const decision = args.decision ?? 'true';
  const reason =
    args.reason ?? `MCP-configured compaction for ${args.service}`;
  const safeReason = reason.replace(/,/g, ';');
  const ttl = args.until_epoch_sec ? String(args.until_epoch_sec) : '';
  const prBranch = `mcp/compact-cap-${slug(args.service)}-${Date.now()}`;
  const prTitle = `compact-cap: configure ${args.service} (${containers(args).length} container${containers(args).length === 1 ? '' : 's'})`;

  // Row value shape: `<decision>[:<untilEpochSec>][:<reason>]`. Engine parser
  // walks colon-separated fields; empty middle field is fine.
  const value =
    ttl || safeReason
      ? `${decision}:${ttl}${safeReason ? ':' + safeReason : ''}`
      : decision;

  const baseline = parseCsv(args.current_csv);
  const merged = new Map(baseline.rows);
  for (const c of containers(args)) {
    merged.set(c, value);
  }
  const newCsv = renderCsv(merged);

  const out: string[] = [];
  out.push('## Apply via `gh`');
  out.push('');
  out.push(
    `Creates a PR against \`${repo}\` (\`${branch}\`). Review and merge through your normal workflow. The engine hot-reloads the cap-file on the next gitops poll; **no pipeline restart, no event drops**.`
  );
  out.push('');
  out.push('```bash');
  out.push('set -euo pipefail');
  out.push(`REPO=${shellQuote(repo)}`);
  out.push(`BASE=${shellQuote(branch)}`);
  out.push(`LOOKUP_PATH=${shellQuote(lookupPath)}`);
  out.push(`BRANCH=${shellQuote(prBranch)}`);
  out.push(`PR_TITLE=${shellQuote(prTitle)}`);
  out.push('');
  out.push('TMPFILE=$(mktemp)');
  out.push("cat > \"$TMPFILE\" <<'CSV_EOF'");
  out.push(newCsv.trimEnd());
  out.push('CSV_EOF');
  out.push('');
  out.push('# Resolve current file SHA (empty if file does not exist yet).');
  out.push(
    'CUR_SHA=$(gh api "/repos/$REPO/contents/$LOOKUP_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)'
  );
  out.push('');
  out.push('# Create the working branch from BASE (ignore if already exists).');
  out.push(
    'BASE_SHA=$(gh api "/repos/$REPO/git/refs/heads/$BASE" --jq .object.sha)'
  );
  out.push('gh api -X POST "/repos/$REPO/git/refs" \\');
  out.push('  -f ref="refs/heads/$BRANCH" \\');
  out.push('  -f sha="$BASE_SHA" >/dev/null 2>&1 || true');
  out.push('');
  out.push('# Commit content via the contents API.');
  out.push('CONTENT_B64=$(base64 < "$TMPFILE" | tr -d "\\n")');
  out.push('PUT_ARGS=( -X PUT "/repos/$REPO/contents/$LOOKUP_PATH"');
  out.push('  -f branch="$BRANCH"');
  out.push('  -f message="$PR_TITLE"');
  out.push('  -f content="$CONTENT_B64" )');
  out.push('[ -n "$CUR_SHA" ] && PUT_ARGS+=( -f sha="$CUR_SHA" )');
  out.push('gh api "${PUT_ARGS[@]}"');
  out.push('');
  out.push('# Open PR.');
  out.push('gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \\');
  out.push('  --title "$PR_TITLE" \\');
  const action = decision === 'true' ? 'compact via `encode()`' : 'preserve `fullText`';
  const body =
    `MCP-configured compaction decision for service \`${args.service}\`.\n\n` +
    `- Containers (${containers(args).length}): ${containers(args).map((c) => `\`${c}\``).join(', ')}\n` +
    `- Decision: \`${decision}\` (${action})\n` +
    (args.until_epoch_sec
      ? `- Expires: ${args.until_epoch_sec} (${new Date(args.until_epoch_sec * 1000).toISOString()})\n`
      : '') +
    `\nDerived via log10x_configure_compact.`;
  out.push(`  --body ${shellQuote(body)}`);
  out.push('```');
  out.push('');

  if (!args.current_csv) {
    out.push(
      '> **Note**: `current_csv` was not provided. The tool computed the diff against an empty baseline. If the file already exists in the repo, fetch it first and re-call this tool with `current_csv` for an accurate merged diff:'
    );
    out.push('>');
    out.push('> ```bash');
    out.push(
      `> gh api "/repos/${repo}/contents/${lookupPath}?ref=${branch}" --jq .content | base64 -d`
    );
    out.push('> ```');
  }

  out.push('');
  out.push('## After merge');
  out.push('');
  out.push(
    "The receiver pod's gitops puller refetches the file. `FileResourceLookup.reset()` fires on the file-watcher event; new decisions take effect within the poll interval. **No pod restart, no event drops.**"
  );
  out.push('');
  out.push(
    '> **Caveat**: hot-reload requires in-place writes (the gitops pattern). Kubernetes `ConfigMap` mounts swap the file via a symlink rename — the engine\'s watcher will not see the change. Source the cap-file from a gitops pull, not from a CM mount.'
  );

  return out.join('\n');
}

// ─── CSV helpers ──────────────────────────────────────────────────────
interface CsvData {
  header: string[];
  rows: Map<string, string>;
}
function parseCsv(content?: string): CsvData {
  if (!content) return { header: ['container', 'value'], rows: new Map() };
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: ['container', 'value'], rows: new Map() };
  const header = lines[0].split(',');
  const rows = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(',');
    if (idx < 0) continue;
    const k = lines[i].substring(0, idx).trim();
    const v = lines[i].substring(idx + 1);
    if (k) rows.set(k, v);
  }
  return { header, rows };
}

function renderCsv(rows: Map<string, string>): string {
  const out = ['container,value'];
  for (const [k, v] of [...rows.entries()].sort()) out.push(`${k},${v}`);
  return out.join('\n') + '\n';
}

// ─── small utilities ──────────────────────────────────────────────────
function containers(args: ConfigureCompactArgs): string[] {
  return args.containers ?? [];
}
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function promEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase();
}
function renderError(title: string, body: string): string {
  return `# configure_compact — ${title}\n\n${body}`;
}
