/**
 * log10x_advise_install
 *
 * Sits in front of the four app-specific advisors (reporter, reducer,
 * retriever). Takes a DiscoverySnapshot + optional goal and recommends
 * the right install path based on what's detected.
 *
 * Two call modes:
 *   - `goal` given: returns a single concrete plan (install+verify+
 *     teardown) for the top-ranked path. No table — straight to the
 *     install commands. Use this when the caller knows what they want.
 *   - no `goal`: returns a ranked table of candidate paths with
 *     rationale + blockers, plus a structured block with the top pick's
 *     resolved args so a follow-up call can re-invoke with `goal=<winner>`
 *     or call the app-specific advisor directly.
 *
 * The tool never installs anything itself — it produces a markdown
 * checklist the user (or a subagent) executes.
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { buildReporterPlan } from '../lib/advisor/reporter.js';
import { buildRetrieverPlan } from '../lib/advisor/retriever.js';
import { renderPlan } from '../lib/advisor/render.js';
import {
  recommendInstallMode,
  type InstallGoal,
  type ModeRecommendation,
  type RankedAlternative,
} from '../lib/advisor/mode.js';
import type { OutputDestination } from '../lib/advisor/reporter-forwarders.js';
import { resolveAdvisorDestination } from '../lib/advisor/dest-resolve.js';

export const adviseInstallSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  goal: z
    .enum(['just-metrics', 'cut-cost', 'compact', 'archive'])
    .optional()
    .describe(
      'What the user is trying to achieve. When given, the tool returns a single concrete install plan for the best-matching path. When omitted, the tool returns a ranked table of candidate paths + the top pick\'s resolved args so the caller can re-invoke with `goal` or jump to `log10x_advise_{reporter,reducer,retriever}` directly. Values: `just-metrics` (cost attribution + pattern fingerprinting, no filtering), `cut-cost` (regulate: filter/sample events in-flight), `compact` (regulate + ~20-40x volume reduction via compact encoding — only on fluent-bit/fluentd 1.0.7), `archive` (Retriever: long-term S3 archive + forensic query).'
    ),
  api_key: z
    .string()
    .optional()
    .describe('Log10x license key. Required for a complete install plan when `goal` is given.'),
  namespace: z
    .string()
    .optional()
    .describe('Target namespace override. Default: snapshot.recommendations.suggestedNamespace.'),
  release_name: z
    .string()
    .optional()
    .describe('Helm release name override. Default: `my-<app>` (e.g., `my-reporter`).'),
  destination: z
    .enum(['mock', 'elasticsearch', 'splunk', 'datadog', 'cloudwatch'])
    .optional()
    .describe('Output destination. When omitted: auto-detects from ambient SIEM credentials (DD_API_KEY → datadog, SPLUNK_HOST+SPLUNK_TOKEN → splunk, ELASTIC_URL → elasticsearch, AWS chain → cloudwatch); single match is used; multiple → ambiguous error; none → falls back to `mock` (safe for dogfooding).'),
  output_host: z.string().optional().describe('Host for non-mock destinations.'),
  splunk_hec_token: z.string().optional().describe('Required when destination=splunk.'),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Plan scope when `goal` is given. Default: `all`.'),
};

const schemaObj = z.object(adviseInstallSchema);
export type AdviseInstallArgs = z.infer<typeof schemaObj>;

export async function executeAdviseInstall(args: AdviseInstallArgs): Promise<string> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return [
      `# Install advisor — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
  }

  const rec = recommendInstallMode({
    snapshot,
    goal: args.goal as InstallGoal | undefined,
  });

  // Mode A: goal given → emit a single concrete plan for the top pick.
  if (args.goal) {
    return await renderConcretePlan(rec, args, snapshot.snapshotId);
  }

  // Mode B: no goal → emit the ranked table + structured top-pick args.
  return renderRanked(rec, snapshot.snapshotId);
}

async function renderConcretePlan(
  rec: ModeRecommendation,
  args: AdviseInstallArgs,
  snapshotId: string
): Promise<string> {
  const top = rec.topPick;
  const header = renderHeader(rec, args.goal!);

  // If the top pick is blocked (every candidate for this goal is unavailable),
  // short-circuit to the table with a clear blocker explanation.
  if (top.blocker) {
    return [
      header,
      '## Blocker',
      `The best-matching path for goal=\`${args.goal}\` is currently blocked:`,
      '',
      `- **${top.label}** — ${top.blocker}`,
      '',
      'Full ranking:',
      '',
      renderAltTable(rec.alternatives),
      '',
      `_Snapshot: \`${snapshotId}\`._`,
    ].join('\n');
  }

  const snapshot = getSnapshot(snapshotId)!;
  const action = args.action ?? 'all';

  // Resolve destination once for the reporter/reducer branch. Retriever
  // doesn't take a destination arg so we skip resolution there.
  const destResolution =
    top.args.app === 'retriever'
      ? { kind: 'resolved' as const, destination: 'mock' as const, note: undefined }
      : await resolveAdvisorDestination(args.destination);
  if (destResolution.kind === 'ambiguous') return destResolution.markdown;
  const destination = destResolution.destination;
  const destNote = destResolution.note ? `_${destResolution.note}_\n\n` : '';

  // Route: retriever → buildRetrieverPlan; reporter/reducer → buildReporterPlan.
  let planMd: string;
  if (top.args.app === 'retriever') {
    const plan = await buildRetrieverPlan({
      snapshot,
      releaseName: args.release_name,
      namespace: args.namespace ?? top.args.namespace,
      apiKey: args.api_key,
      skipInstall: action === 'verify' || action === 'teardown',
      skipVerify: action === 'install' || action === 'teardown',
      skipTeardown: action === 'install' || action === 'verify',
    });
    planMd = renderPlan(plan, action);
  } else {
    const plan = await buildReporterPlan({
      snapshot,
      app: top.args.app,
      shape: top.args.shape,
      forwarder: top.args.forwarder,
      optimize: top.args.optimize,
      releaseName: args.release_name,
      namespace: args.namespace ?? top.args.namespace,
      apiKey: args.api_key,
      destination: destination as OutputDestination,
      outputHost: args.output_host,
      splunkHecToken: args.splunk_hec_token,
      skipInstall: action === 'verify' || action === 'teardown',
      skipVerify: action === 'install' || action === 'teardown',
      skipTeardown: action === 'install' || action === 'verify',
    });
    planMd = renderPlan(plan, action);
  }

  return [header, destNote + planMd].join('\n');
}

function renderRanked(rec: ModeRecommendation, snapshotId: string): string {
  const lines: string[] = [];
  lines.push('# Install advisor — mode ranking');
  lines.push('');
  lines.push('_No `goal` was given, so the advisor surfaces all candidate paths with their detection-based ranking. Pick one and re-invoke with `goal=<matching-goal>` for a concrete install plan, or call `log10x_advise_{reporter,reducer,retriever}` directly with the resolved args below._');
  lines.push('');

  // Detection summary.
  lines.push('## Detection');
  for (const d of rec.detectionSummary) lines.push(`- ${d}`);
  lines.push('');

  if (rec.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of rec.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  // Ranking.
  lines.push('## Candidates (ranked)');
  lines.push('');
  lines.push(renderAltTable(rec.alternatives));
  lines.push('');

  // Top pick + resolved args (machine-readable fenced block).
  lines.push('## Top pick');
  lines.push(`**${rec.topPick.label}** — ${rec.topPick.rationale}`);
  lines.push('');
  lines.push('Resolved args (feed into `log10x_advise_{reporter,reducer,retriever}` directly):');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(rec.topPick.args, null, 2));
  lines.push('```');
  lines.push('');

  // Rationale.
  lines.push('## Rationale');
  lines.push(rec.rationale);
  lines.push('');

  lines.push('---');
  lines.push(`_Snapshot: \`${snapshotId}\`._`);
  return lines.join('\n');
}

function renderHeader(rec: ModeRecommendation, goal: InstallGoal): string {
  const lines: string[] = [];
  lines.push(`# Install advisor — goal=${goal}`);
  lines.push('');
  lines.push('## Detection');
  for (const d of rec.detectionSummary) lines.push(`- ${d}`);
  lines.push('');
  if (rec.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of rec.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push('## Decision');
  lines.push(rec.rationale);
  lines.push('');
  lines.push('_Alternatives the advisor considered:_');
  lines.push('');
  lines.push(renderAltTable(rec.alternatives));
  lines.push('');
  return lines.join('\n');
}

function renderAltTable(alts: RankedAlternative[]): string {
  const rows: string[] = [];
  rows.push('| Rank | Option | Score | Status | Why |');
  rows.push('|---|---|---|---|---|');
  for (let i = 0; i < alts.length; i++) {
    const a = alts[i];
    const status = a.blocker ? `**blocked**: ${escapePipe(a.blocker)}` : 'available';
    rows.push(
      `| ${i + 1} | ${escapePipe(a.label)} | ${a.score} | ${status} | ${escapePipe(a.rationale)} |`
    );
  }
  return rows.join('\n');
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|');
}
