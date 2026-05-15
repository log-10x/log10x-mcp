/**
 * log10x_pattern_mitigate
 *
 * Single user-facing entry point for "this pattern costs too much, what
 * are my options". Replaces the prior split where the user had to know
 * the difference between an exclusion filter, a forwarder drop, a 10x
 * mute PR, and a 10x compact PR — each exposed via a different tool.
 *
 * The tool:
 *   1. Reads env capability (receiver deployed? retriever deployed?
 *      GitOps repo configured?) from the active env's config + an
 *      optional snapshot.
 *   2. Renders a four-option menu in user terms (drop @ analyzer / drop
 *      @ forwarder / mute @ 10x / compact @ 10x), DIMMING options that
 *      aren't available in this env so the user never picks a path that
 *      requires infra they don't have.
 *   3. Emits structured NEXT_ACTIONS pointing at the right sub-tool for
 *      each option, so the agent can route on the user's choice in one
 *      hop.
 *   4. Always lists log10x_dependency_check as a required pre-action for
 *      the drop/mute options — keeps the deterministic safety gate
 *      enforced.
 *
 * Discoverability surface:
 *   - top_patterns / cost_drivers / event_lookup already point users at
 *     mitigation paths via their agent-only NEXT_ACTIONS. Those routes
 *     get updated to point at THIS tool, not directly at exclusion_filter.
 *   - System-prompt rule (separately): when a cost-bearing tool surfaces
 *     a pattern and the user's framing is cost-related, the agent should
 *     proactively offer "want me to show you options for reducing this?"
 *     — and call this tool when they say yes.
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { loadEnvironments } from '../lib/environments.js';
import { agentOnly } from '../lib/agent-only.js';
import { fmtPattern, normalizePattern } from '../lib/format.js';

export const patternMitigateSchema = {
  pattern: z
    .string()
    .min(1)
    .describe('The pattern identity to mitigate. Pass the canonical name from a prior log10x_top_patterns / log10x_cost_drivers / log10x_event_lookup row.'),
  service: z
    .string()
    .optional()
    .describe('Optional service scope. When set, options that target a single service (forwarder drop, exclusion filter) are scoped to it.'),
  snapshot_id: z
    .string()
    .optional()
    .describe('Snapshot from log10x_discover_env. Used to detect which 10x components are deployed in the active env (receiver, retriever, GitOps wiring). Without it, the tool still works but may dim PR-based options if the active env\'s envs.json does not list a gitops repo.'),
};

export interface PatternMitigateArgs {
  pattern: string;
  service?: string;
  snapshot_id?: string;
}

interface Capabilities {
  /** Receiver pod was discovered (snapshot has a receiver app) OR the active env has a gitops repo. Either way, the mute/compact PR options are reachable. */
  canMute: boolean;
  canCompact: boolean;
  /** Retriever was discovered — muted events would land in S3 archive recoverably. */
  hasRetrieverArchive: boolean;
  /** Source of the gitops_repo, if any. Used in the rendered explanation so the user understands where the PR will be opened. */
  gitopsRepo?: string;
  gitopsSource?: 'envs.json' | 'snapshot' | 'env-var';
  /** Setup hint text when canMute/canCompact are false, explaining what's missing. */
  setupHint?: string;
}

async function detectCapabilities(snapshotId?: string): Promise<Capabilities> {
  const out: Capabilities = { canMute: false, canCompact: false, hasRetrieverArchive: false };

  // Source 1: active env's gitops field (envs.json). Wins over later sources
  // because envs.json is user-declared per-env config.
  try {
    const envs = await loadEnvironments();
    const active = envs.lastUsed ?? envs.default;
    if (active?.gitops?.repo) {
      out.gitopsRepo = active.gitops.repo;
      out.gitopsSource = 'envs.json';
      out.canMute = true;
      out.canCompact = true;
    }
  } catch {
    // ignore; fall through to env-var / snapshot
  }

  // Source 2: LOG10X_GH_REPO env var. Read directly because in demo-mode or
  // when no LOG10X_METRICS_* is set, the env-var doesn't propagate through
  // `loadEnvironments` to an EnvConfig. This direct read is the
  // "no-other-config" path that still lets the user point at a repo.
  if (!out.gitopsRepo && process.env.LOG10X_GH_REPO) {
    out.gitopsRepo = process.env.LOG10X_GH_REPO;
    out.gitopsSource = 'env-var';
    out.canMute = true;
    out.canCompact = true;
  }

  // Source 3: snapshot from kubectl discovery. Fills in retriever-archive
  // detection always; only sets gitopsRepo if the env-side sources above
  // didn't already provide one.
  if (snapshotId) {
    const snap = getSnapshot(snapshotId);
    if (snap) {
      if (!out.gitopsRepo && snap.recommendations.receiverGitopsRepo) {
        out.gitopsRepo = snap.recommendations.receiverGitopsRepo;
        out.gitopsSource = 'snapshot';
        out.canMute = true;
        out.canCompact = true;
      }
      // Retriever presence: a snapshot retains the bucket name when a
      // retriever app was discovered with an S3-target env var.
      if (snap.recommendations.retrieverS3Bucket) {
        out.hasRetrieverArchive = true;
      }
    }
  }

  if (!out.canMute && !out.canCompact) {
    out.setupHint =
      'To enable mute/compact at the 10x engine, set `gitops.repo` (owner/name) in your `~/.log10x/envs.json` entry — or export `LOG10X_GH_REPO=<owner/name>` — or pass a `snapshot_id` from `log10x_discover_env` against a cluster with a receiver pod that has `GH_ENABLED=true` + `GH_REPO=<owner/name>` set.';
  }

  return out;
}

export async function executePatternMitigate(args: PatternMitigateArgs): Promise<string> {
  const pattern = normalizePattern(args.pattern);
  const displayPattern = fmtPattern(pattern);
  const scopeNote = args.service ? ` (service: ${args.service})` : '';

  const caps = await detectCapabilities(args.snapshot_id);

  const lines: string[] = [];
  lines.push(`Mitigation options for \`${displayPattern}\`${scopeNote}`);
  lines.push('');
  lines.push('Pick one. Each option trades off speed-to-effect, where in the pipeline it cuts, and what happens to your data.');
  lines.push('');

  // Option 1 — SIEM-side. Always available; just needs the user to know
  // their analyzer vendor. We don't need to detect this from the cluster.
  lines.push('**1. Drop it at your analyzer.** Fastest. Save a config in Datadog / Splunk / Elastic / CloudWatch and the cost stops within minutes. Events still flow through your pipeline up to the analyzer — they just don\'t get indexed or stored. Easy to undo in the same UI.');
  lines.push('');

  // Option 2 — Forwarder-side. Also always available (every customer has
  // some forwarder); generation is via the same exclusion_filter tool with
  // a different vendor arg.
  lines.push('**2. Drop it at your forwarder.** Same idea as option 1 but one step earlier. The events never even leave your environment, so on top of analyzer savings you also save the bandwidth between your forwarder and your analyzer. Requires editing your fluent-bit / fluentd / logstash / filebeat config and reloading it (seconds to minutes).');
  lines.push('');

  // Option 3 — Mute at 10x edge. Gated on capability.
  if (caps.canMute) {
    const archiveNote = caps.hasRetrieverArchive
      ? 'Your env has the 10x S3 archive enabled, so the muted events are still saved in your own S3 bucket and you can search them later if you need them.'
      : 'Your env does NOT currently have the 10x S3 archive enabled — once muted, events are gone. Add the archive (Retriever) if recoverable history matters.';
    const sourceTag = caps.gitopsSource ? ` (PR target resolved from ${caps.gitopsSource})` : '';
    lines.push(`**3. Mute it inside the 10x engine.** We open a PR against \`${caps.gitopsRepo}\`${sourceTag}, you merge, and the cost stops within minutes of merge. ${archiveNote}`);
  } else {
    lines.push('**3. Mute it inside the 10x engine.** _Not available in this env._ Requires a configured GitOps target (either `gitops.repo` in your envs.json, `LOG10X_GH_REPO` env var, or a discovered receiver pod with `GH_REPO` set).');
  }
  lines.push('');

  // Option 4 — Compact at 10x edge. Same gating as option 3.
  if (caps.canCompact) {
    const sourceTag = caps.gitopsSource ? ` (PR target resolved from ${caps.gitopsSource})` : '';
    lines.push(`**4. Shrink it instead of dropping it.** Same PR + merge flow as option 3, against \`${caps.gitopsRepo}\`${sourceTag}, but the events keep flowing. The 10x engine compresses each one losslessly so it lands at your analyzer typically 5–10× smaller — still fully searchable. Pick this when you actually need the data (compliance, dashboards rely on the raw fields, etc.).`);
  } else {
    lines.push('**4. Shrink it instead of dropping it.** _Not available in this env — same setup as option 3._');
  }
  lines.push('');

  if (caps.setupHint) {
    lines.push(`_To unlock options 3 and 4: ${caps.setupHint}_`);
    lines.push('');
  }

  lines.push('Before any drop is applied, your dependency check has to pass — it\'s the safety gate that confirms no dashboards or alerts depend on this pattern.');
  lines.push('');
  lines.push('Which option do you want?');

  // Structured next-action hints. Always include dependency_check first so
  // the agent treats it as the required precursor. Then one entry per
  // option that's actually available, so when the user picks a number the
  // agent has the right next call ready.
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_dependency_check',
      args: { pattern },
      reason: 'safety gate — verifies no dashboards/alerts/saved-searches depend on the pattern before any drop is applied',
    },
    {
      tool: 'log10x_exclusion_filter',
      args: { pattern, vendor: 'datadog' },
      reason: 'option 1 — analyzer-side exclusion (replace vendor:datadog with the user\'s actual analyzer when known)',
    },
    {
      tool: 'log10x_exclusion_filter',
      args: { pattern, vendor: 'fluentbit' },
      reason: 'option 2 — forwarder-side drop (replace vendor:fluentbit with the user\'s actual forwarder when known)',
    },
  ];
  if (caps.canMute) {
    nextActions.push({
      tool: 'log10x_advise_receiver',
      args: { pattern, ...(caps.gitopsRepo ? { gitops_repo: caps.gitopsRepo } : {}) },
      reason: 'option 3 — generate the GitOps PR diff for muting at the 10x receiver',
    });
  }
  if (caps.canCompact) {
    nextActions.push({
      tool: 'log10x_advise_compact',
      args: { compact: [pattern], ...(caps.gitopsRepo ? { gitops_repo: caps.gitopsRepo } : {}) },
      reason: 'option 4 — generate the GitOps PR diff for losslessly compacting',
    });
  }

  lines.push('');
  lines.push(agentOnly(
    `Routing constraint: do not call any drop/mute/compact sub-tool until the user picks an option. ` +
    `When they do, route option 1 → log10x_exclusion_filter with their analyzer vendor; option 2 → same tool with their forwarder vendor; ` +
    `option 3 → log10x_advise_receiver; option 4 → log10x_advise_compact. ` +
    `For options 1 and 3, call log10x_dependency_check first and present its findings before generating the drop config.` +
    (caps.gitopsRepo ? ` Resolved gitops_repo: ${caps.gitopsRepo} (source: ${caps.gitopsSource}).` : '')
  ));
  lines.push('');
  lines.push(renderNextActions(nextActions));

  return lines.join('\n');
}
