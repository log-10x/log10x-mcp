/**
 * log10x_configure_regulator
 *
 * Derives a per-container byte cap for the rate regulator from a monthly
 * dollar budget, validates against five sanity checks pulled from the
 * customer's Prometheus, and emits a `gh` PR command against the rate
 * regulator's cap-lookup CSV (`pipelines/run/receive/rate/caps.csv` by
 * default). This tool is a renderer + derivation, not a writer. The
 * agent runs the emitted `gh` snippet to open a PR that the human
 * reviews and merges. Same shape as log10x_configure_compact (the
 * compact-side equivalent).
 *
 * Two-phase flow (decision γ from the design pass):
 *   Phase 1 — agent calls with `service=<name>` + budget args (no
 *     `containers`). Tool resolves the service to a candidate set of
 *     k8s_container values via Prometheus, presents them, and asks the
 *     agent to confirm.
 *   Phase 2 — agent re-calls with the same args plus `containers=[<...>]`.
 *     Tool derives the cap, runs sanity checks, and emits the PR command.
 *
 * Zero engine ask: every query runs against existing receive-aggregator
 * metrics (all_events_summaryBytes_total + emitted_events_summaryBytes_total,
 * labeled by k8s_container, symbolMessage, k8s_pod, level).
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
const WINDOWS_PER_MONTH = 8640; // 4-minute windows × 12/hr × 24 × 30
const DEFAULT_LOOKUP_PATH = 'pipelines/run/receive/rate/caps.csv';
const RESET_INTERVAL_MS = 240000; // matches rateReceiverResetIntervalMs default (4m)
const MIN_COVERAGE = 0.8; // sanity check 1: ≥80% of window must have data
const MAX_SENSIBLE_CAP_BYTES = 100 * 1024 * 1024; // sanity check 4: >100MB → "too generous" warning
const GROWTH_WARN_PCT = 0.3; // soft-warn if pattern count grew >30% in last 3d

// ─── schema ───────────────────────────────────────────────────────────
export const configureRegulatorSchema = {
  service: z
    .string()
    .describe(
      'Customer-vocabulary name of the service to configure (e.g., `payment-service`). The tool resolves this to a set of `k8s_container` values via Prometheus and asks the agent to confirm if multiple candidates match.'
    ),
  budget: z
    .number()
    .positive()
    .describe(
      'Monthly dollar budget for this service. The derived cap is sized so the regulator never burns more than `runawayFraction` (default 5%) of this budget per month, given `simultaneousRunaways` patterns going hot at once across each selected container.'
    ),
  costPerGB: z
    .number()
    .positive()
    .describe('Customer ingestion rate in $/GB. Converts dollar budget to byte budget.'),
  containers: z
    .array(z.string())
    .optional()
    .describe(
      'Explicit list of k8s_container values to apply the cap to. If omitted, the tool resolves `service` to candidates and presents them; the agent re-calls with this parameter to commit. Each entry becomes one row in the cap CSV at the same derived cap.'
    ),
  runawayFraction: z
    .number()
    .min(0.001)
    .max(0.5)
    .default(0.05)
    .describe(
      'Fraction of budget tolerable as runaway burn before the cap engages. Default 0.05 (5%).'
    ),
  simultaneousRunaways: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe(
      'Expected upper bound on patterns running hot at once on a single container in one window. Higher values produce tighter caps (more protective). Default 5 — a product judgment from observed incident shapes (typical runaway = 1-2 distinct patterns; 5 is conservative).'
    ),
  observationDays: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe(
      'Days of Prometheus history to use for active-pattern count, top-pattern volume, container scale, and observation-coverage sanity. Default 7 (captures a full weekday/weekend cycle).'
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
    .describe(`Repo-relative path to the cap CSV. Default: \`${DEFAULT_LOOKUP_PATH}\`.`),
  current_csv: z
    .string()
    .optional()
    .describe(
      'Existing CSV content (header + rows). If omitted, the tool emits commands to fetch it from the repo before computing the diff. Pass it for a one-shot output.'
    ),
};

const schemaObj = z.object(configureRegulatorSchema);
export type ConfigureRegulatorArgs = z.infer<typeof schemaObj>;

type ResolvedTarget = ConfigureRegulatorArgs & {
  gitops_repo: string;
  lookup_path: string;
};

// ─── main entry ───────────────────────────────────────────────────────
export async function executeConfigureRegulator(
  args: ConfigureRegulatorArgs
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

  // Phase 2: γ resolution (service → candidate containers) if not yet committed.
  if (!args.containers || args.containers.length === 0) {
    return await renderResolutionPrompt(args, backend);
  }

  // Phase 3: sanity checks against the committed container set.
  const checks = await runSanityChecks(args, backend, args.containers);

  // Phase 4: derive cap (math is per-container, scaled by container count).
  const derivation = deriveCap({
    budget: args.budget,
    costPerGB: args.costPerGB,
    runawayFraction: args.runawayFraction ?? 0.05,
    simultaneousRunaways: args.simultaneousRunaways ?? 5,
    containers: args.containers.length,
  });

  // Phase 5: render (refusal if blocking, otherwise full plan + PR command).
  return renderResult(args, target.resolved, derivation, checks);
}

// ─── target resolution ────────────────────────────────────────────────
async function resolveTarget(
  args: ConfigureRegulatorArgs
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
        lookupPath = lookupPath ?? active.gitops.lookupPath ?? undefined;
      }
    } catch {
      // non-fatal
    }
  }

  // 2. Snapshot fallback. The snapshot's `recommendations` doesn't yet have a
  //    field for the rate-cap-lookup path (that's a follow-up enrichment to
  //    discovery); for now we only pull `gitopsRepo` if exposed.
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

// ─── service-to-container resolution (γ) ─────────────────────────────
interface Candidate {
  container: string;
  observedGB: number;
  distinctPods: number;
}

async function renderResolutionPrompt(
  args: ConfigureRegulatorArgs,
  backend: any
): Promise<string> {
  const service = args.service;
  const days = args.observationDays ?? 7;

  // observedGB and pod count for any k8s_container whose name contains the
  // service substring. Run both queries in parallel.
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
  lines.push(`# configure_regulator — resolve \`service=${service}\` to containers`);
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

  if (exact) {
    lines.push(
      `**Recommendation**: apply the cap to \`${service}\` only (the primary container). Sidecars (e.g., istio-proxy, datadog-agent) are typically platform-owned with predictable volumes and don't need a per-service cap.`
    );
    lines.push('');
    lines.push('To proceed with the default:');
    lines.push('');
    lines.push('```');
    lines.push(
      `configure_regulator(service="${service}", budget=${args.budget}, costPerGB=${args.costPerGB}, containers=["${service}"])`
    );
    lines.push('```');
    lines.push('');
    lines.push('To include the worker container or sidecars, add them to the array — the same derived cap will apply to each.');
  } else {
    lines.push(
      `No exact match for \`${service}\`. Pick the container(s) the cap should apply to:`
    );
    lines.push('');
    lines.push('```');
    const allList = sorted.map((c) => `"${c.container}"`).join(', ');
    lines.push(
      `configure_regulator(service="${service}", budget=${args.budget}, costPerGB=${args.costPerGB}, containers=[${allList}])`
    );
    lines.push('```');
  }
  lines.push('');
  lines.push(
    `When you re-call with \`containers=[...]\`, the tool runs sanity checks, derives the cap, and emits the \`gh\` PR command against your gitops repo.`
  );

  return lines.join('\n');
}

// ─── sanity checks ────────────────────────────────────────────────────
interface SanityResult {
  blocking: boolean;
  warnings: string[];
  data: {
    coverage: number;
    currentSpendGB: number;
    topPatternBytes: { symbolMessage: string; bytes: number }[];
    p95Pods: number;
    patternGrowthPct: number;
  };
}

async function runSanityChecks(
  args: ConfigureRegulatorArgs,
  backend: any,
  containers: string[]
): Promise<SanityResult> {
  const days = args.observationDays ?? 7;
  const containerRegex = containers.map(promEscape).join('|');
  const filter = `k8s_container=~"${containerRegex}"`;
  const windowsExpected = days * 24 * 12; // 5-minute buckets per day

  // 1. coverage — distinct 5-minute buckets in the observation window with data.
  const coverageQ = `count_over_time((sum(rate(all_events_summaryBytes_total{${filter}}[5m])) > 0)[${days}d:5m])`;
  // 2. 30-day spend in GB.
  const spendQ = `sum(increase(all_events_summaryBytes_total{${filter}}[30d])) / 1e9`;
  // 3. top-5 patterns by bytes-per-window.
  const topPatternsQ = `topk(5, sum by (symbolMessage)(increase(all_events_summaryBytes_total{${filter}}[${Math.round(RESET_INTERVAL_MS / 1000)}s])))`;
  // 5. p95 pod count across selected containers.
  const p95PodsQ = `quantile_over_time(0.95, sum(count by (k8s_pod)(rate(all_events_summaryBytes_total{${filter}}[5m]) > 0))[${days}d:5m])`;
  // growth: distinct symbolMessages in last 3d vs the prior 4d.
  const recentPatternsQ = `count(count by (symbolMessage)(increase(all_events_summaryBytes_total{${filter}}[3d]) > 0))`;
  const olderPatternsQ = `count(count by (symbolMessage)(increase(all_events_summaryBytes_total{${filter}}[4d] offset 3d) > 0))`;

  const [covRes, spendRes, topRes, podsRes, recentPatRes, olderPatRes] =
    await Promise.all([
      backend.queryInstant(coverageQ) as Promise<PrometheusResponse>,
      backend.queryInstant(spendQ) as Promise<PrometheusResponse>,
      backend.queryInstant(topPatternsQ) as Promise<PrometheusResponse>,
      backend.queryInstant(p95PodsQ) as Promise<PrometheusResponse>,
      backend.queryInstant(recentPatternsQ) as Promise<PrometheusResponse>,
      backend.queryInstant(olderPatternsQ) as Promise<PrometheusResponse>,
    ]);

  const coverageBuckets = scalarFromResult(covRes);
  const coverage = windowsExpected > 0 ? coverageBuckets / windowsExpected : 0;
  const currentSpendGB = scalarFromResult(spendRes);
  const topPatternBytes = topRes.data.result.map((r) => ({
    symbolMessage: r.metric.symbolMessage ?? '<no-symbol>',
    bytes: parseFloat(r.value?.[1] ?? '0'),
  }));
  const p95Pods = Math.round(scalarFromResult(podsRes));
  const recentPats = scalarFromResult(recentPatRes);
  const olderPats = scalarFromResult(olderPatRes);
  const patternGrowthPct = olderPats > 0 ? (recentPats - olderPats) / olderPats : 0;

  const warnings: string[] = [];
  let blocking = false;

  // Sanity 1
  if (coverage < MIN_COVERAGE) {
    blocking = true;
    warnings.push(
      `**Insufficient observation**: only ${(coverage * 100).toFixed(0)}% of the ${days}-day window has data (need ≥${(MIN_COVERAGE * 100).toFixed(0)}%). The service may be new or recently scaled. Wait a few more days, or pass \`observationDays=1\` to derive from a shorter recent window.`
    );
  }

  // Sanity 2
  const currentSpend$ = currentSpendGB * args.costPerGB;
  if (currentSpend$ > args.budget) {
    blocking = true;
    warnings.push(
      `**Budget below current spend**: this service currently costs roughly $${currentSpend$.toFixed(2)}/month at $${args.costPerGB}/GB (${currentSpendGB.toFixed(2)} GB over the last 30 days). The requested budget of $${args.budget}/month is lower than the baseline. Either raise the budget or address the baseline volume first (top patterns are listed below for reference).`
    );
  }

  // Growth-rate flag (advisory; doesn't block)
  if (coverage >= MIN_COVERAGE && patternGrowthPct > GROWTH_WARN_PCT) {
    warnings.push(
      `**Growth-rate flag**: distinct pattern count grew ${(patternGrowthPct * 100).toFixed(0)}% in the last 3 days vs the prior 4 days. The derived cap may need re-tuning sooner than usual.`
    );
  }

  return {
    blocking,
    warnings,
    data: {
      coverage,
      currentSpendGB,
      topPatternBytes,
      p95Pods,
      patternGrowthPct,
    },
  };
}

// ─── derivation ───────────────────────────────────────────────────────
interface Derivation {
  capBytes: number;
  capHuman: string;
  worstCaseMonthly$: number;
  sensitivity: { simRunaways: number; capBytes: number }[];
  inputs: {
    budget: number;
    costPerGB: number;
    runawayFraction: number;
    simultaneousRunaways: number;
    containers: number;
  };
}

function deriveCap(p: {
  budget: number;
  costPerGB: number;
  runawayFraction: number;
  simultaneousRunaways: number;
  containers: number;
}): Derivation {
  const budgetBytes = (p.budget / p.costPerGB) * 1e9;
  const runawayBudget = budgetBytes * p.runawayFraction;
  const cap =
    runawayBudget /
    (p.simultaneousRunaways * p.containers * WINDOWS_PER_MONTH);
  const worstCaseBytes =
    cap * p.simultaneousRunaways * p.containers * WINDOWS_PER_MONTH;
  const worstCase$ = (worstCaseBytes / 1e9) * p.costPerGB;

  const sensitivity = [3, 5, 10].map((n) => ({
    simRunaways: n,
    capBytes: runawayBudget / (n * p.containers * WINDOWS_PER_MONTH),
  }));

  return {
    capBytes: cap,
    capHuman: humanBytes(cap),
    worstCaseMonthly$: worstCase$,
    sensitivity,
    inputs: { ...p },
  };
}

// ─── rendering ────────────────────────────────────────────────────────
function renderResult(
  args: ConfigureRegulatorArgs,
  resolved: ResolvedTarget,
  derivation: Derivation,
  checks: SanityResult
): string {
  const containers = args.containers!;
  const out: string[] = [];
  out.push(`# configure_regulator — derived cap for \`${args.service}\``);
  out.push('');
  out.push(
    `**Containers** (${containers.length}): ${containers.map((c) => `\`${c}\``).join(', ')}`
  );
  out.push(`**Budget**: $${args.budget}/month at $${args.costPerGB}/GB`);
  out.push('');

  if (checks.warnings.length > 0) {
    out.push('## Sanity checks');
    out.push('');
    for (const w of checks.warnings) out.push(`- ${w}`);
    out.push('');
  }

  if (checks.blocking) {
    out.push('## Result: refused');
    out.push('');
    out.push(
      'A blocking sanity check fired (see above). No cap was derived; no PR command was emitted. Address the issue and re-call.'
    );
    return out.join('\n');
  }

  // Derived cap + math
  out.push('## Derived cap');
  out.push('');
  const windowMin = Math.round(RESET_INTERVAL_MS / 1000 / 60);
  out.push(
    `**Cap**: ${derivation.capHuman} per pattern per container per ${windowMin}-minute window`
  );
  out.push(
    `**Worst-case monthly**: $${derivation.worstCaseMonthly$.toFixed(2)} (≤ ${((args.runawayFraction ?? 0.05) * 100).toFixed(0)}% of $${args.budget} budget, assuming ${args.simultaneousRunaways ?? 5} runaway patterns per container per window)`
  );
  out.push('');

  // Sensitivity
  out.push(
    `The derived cap of ${derivation.capHuman} assumes up to ${args.simultaneousRunaways ?? 5} patterns can misbehave simultaneously per container. If your runaway incidents typically involve fewer distinct patterns, lower this assumption to raise the cap:`
  );
  out.push('');
  for (const s of derivation.sensitivity) {
    const def = args.simultaneousRunaways ?? 5;
    const tag = s.simRunaways === def ? ' ← default' : '';
    const note =
      s.simRunaways < def
        ? '(more permissive; legitimate bursts less likely to be sampled)'
        : s.simRunaways > def
          ? '(more protective; runaway burn capped harder)'
          : '';
    out.push(
      `- \`simultaneousRunaways=${s.simRunaways}\` → cap = **${humanBytes(s.capBytes)}** ${note}${tag}`
    );
  }
  out.push('');

  // Top patterns flag (sanity 3 — informational warning)
  const overTop = checks.data.topPatternBytes.filter((p) => p.bytes > derivation.capBytes);
  if (overTop.length > 0) {
    out.push(
      `> **Top patterns over the derived cap** — these patterns currently produce more than the derived cap per window. They will be sampled aggressively at the severity floor under this configuration. Either add them to the mute file (\`rateReceiverLookupFile\`), raise the budget, or accept the sampling:`
    );
    out.push('>');
    for (const p of overTop) {
      out.push(`>   - \`${p.symbolMessage}\`: ${humanBytes(p.bytes)}/window`);
    }
    out.push('');
  }

  // Sanity 4 informational
  if (derivation.capBytes > MAX_SENSIBLE_CAP_BYTES) {
    out.push(
      `> **Cap is very generous**: the derived cap (${derivation.capHuman}) is well above typical runaway pattern sizes. The regulator will rarely engage. Consider a tighter budget if active protection is desired.`
    );
    out.push('');
  }

  // Sanity 5 informational
  out.push(
    `**Observed scale** (over last ${args.observationDays ?? 7} days): ${checks.data.p95Pods} p95 pod replicas across selected containers, ${checks.data.topPatternBytes.length} top patterns sampled, current 30-day spend ≈ $${(checks.data.currentSpendGB * args.costPerGB).toFixed(2)}.`
  );
  out.push('');

  out.push(renderPrCommand(args, resolved, derivation));
  return out.join('\n');
}

function renderPrCommand(
  args: ConfigureRegulatorArgs,
  resolved: ResolvedTarget,
  derivation: Derivation
): string {
  const repo = resolved.gitops_repo;
  const branch = args.gitops_branch ?? 'main';
  const lookupPath = resolved.lookup_path;
  const reason = `MCP-derived cap for ${args.service} at $${args.budget}/month`;
  const prBranch = `mcp/rate-cap-${slug(args.service)}-${Date.now()}`;
  const prTitle = `rate-cap: configure ${args.service} (${args.containers!.length} container${args.containers!.length === 1 ? '' : 's'})`;

  const baseline = parseCsv(args.current_csv);
  const merged = new Map(baseline.rows);
  for (const c of args.containers!) {
    // CSV row value: <bytes>::<reason>  (untilEpochSec empty = no expiry)
    const value = `${Math.round(derivation.capBytes)}::${reason.replace(/,/g, ';')}`;
    merged.set(c, value);
  }
  const newCsv = renderCsv(merged);

  const out: string[] = [];
  out.push('## Apply via `gh`');
  out.push('');
  out.push(
    `Creates a PR against \`${repo}\` (\`${branch}\`). Review and merge through your normal workflow. The engine hot-reloads the cap CSV on the next gitops poll; **no pipeline restart, no event drops**.`
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
  const body =
    `MCP-derived rate-regulator cap for service \`${args.service}\`.\n\n` +
    `- Containers (${args.containers!.length}): ${args.containers!.map((c) => `\`${c}\``).join(', ')}\n` +
    `- Cap: ${derivation.capHuman} per pattern per container per ${Math.round(RESET_INTERVAL_MS / 1000 / 60)}-minute window\n` +
    `- Budget: $${args.budget}/month at $${args.costPerGB}/GB\n` +
    `- Worst-case monthly spend at this cap: $${derivation.worstCaseMonthly$.toFixed(2)}\n` +
    `- runawayFraction: ${args.runawayFraction ?? 0.05}, simultaneousRunaways: ${args.simultaneousRunaways ?? 5}\n\n` +
    `Derived via log10x_configure_regulator.`;
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
    'The receiver pod\'s gitops puller refetches the file. `FileResourceLookup.reset()` fires on the file-watcher event; new caps take effect within the poll interval. **No pod restart, no event drops.**'
  );

  return out.join('\n');
}

// ─── CSV helpers ──────────────────────────────────────────────────────
interface CsvData {
  header: string[];
  rows: Map<string, string>;
}
function parseCsv(content?: string): CsvData {
  if (!content) return { header: ['container', 'cap'], rows: new Map() };
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: ['container', 'cap'], rows: new Map() };
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
  const out = ['container,cap'];
  for (const [k, v] of [...rows.entries()].sort()) out.push(`${k},${v}`);
  return out.join('\n') + '\n';
}

// ─── small utilities ──────────────────────────────────────────────────
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function promEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase();
}
function humanBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024)
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${Math.round(b)} bytes`;
}
function scalarFromResult(res: PrometheusResponse): number {
  if (!res?.data?.result || res.data.result.length === 0) return 0;
  return parseFloat(res.data.result[0]?.value?.[1] ?? '0');
}
function renderError(title: string, body: string): string {
  return `# configure_regulator — ${title}\n\n${body}`;
}
