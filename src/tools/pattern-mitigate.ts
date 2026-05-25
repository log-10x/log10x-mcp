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
  /**
   * Detected forwarder kind from the snapshot's `existingForwarder` (set by
   * `classifyForwarderImage` against the cluster's running pods). When set,
   * option 2's vendor is pre-filled. When undefined, the menu acknowledges
   * the gap explicitly so the agent asks rather than guessing fluent-bit.
   */
  forwarderKind?: 'fluentbit' | 'fluentd' | 'filebeat' | 'logstash' | 'otel-collector' | 'unknown';
  /**
   * Detected analyzer vendor — from envs.json, LOG10X_ANALYZER env var,
   * or the user profile's `metadata.analyzer_vendor`. Used to render
   * option 1 with the actual analyzer name and to pre-fill the
   * exclusion_filter `vendor` arg. Loose string because the mitigate
   * menu must support analyzers that exclusion_filter doesn't yet
   * generate native configs for (NewRelic, Dynatrace, etc.); the agent
   * tells the user to apply manually in that case.
   */
  analyzerVendor?: string;
  /** Setup hint text when canMute/canCompact are false, explaining what's missing. */
  setupHint?: string;
}

/**
 * SIEM vendors the exclusion_filter tool can generate native configs for.
 * Anything outside this set still gets named in option 1's prose but is
 * flagged as "apply manually via the analyzer UI".
 */
const NATIVE_EXCLUSION_VENDORS = new Set(['datadog', 'splunk', 'elasticsearch', 'cloudwatch']);

const ANALYZER_DISPLAY: Record<string, string> = {
  datadog: 'Datadog',
  splunk: 'Splunk',
  'splunk-obs': 'Splunk Observability',
  elasticsearch: 'Elasticsearch',
  opensearch: 'OpenSearch',
  cloudwatch: 'AWS CloudWatch',
  'azure-monitor': 'Azure Monitor / Log Analytics',
  'new-relic': 'New Relic',
  'gcp-logging': 'Google Cloud Logging',
  dynatrace: 'Dynatrace',
  sumo: 'Sumo Logic',
  'grafana-loki': 'Grafana Loki',
  coralogix: 'Coralogix',
  logzio: 'Logz.io',
  crowdstrike: 'CrowdStrike Falcon LogScale',
  victorialogs: 'VictoriaLogs',
};

function analyzerLabel(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return ANALYZER_DISPLAY[token] ?? token;
}

async function detectCapabilities(snapshotId?: string): Promise<Capabilities> {
  const out: Capabilities = { canMute: false, canCompact: false, hasRetrieverArchive: false };

  // Source 1: active env's gitops field + forwarder field (envs.json).
  // Wins over later sources because envs.json is user-declared per-env config.
  try {
    const envs = await loadEnvironments();
    const active = envs.lastUsed ?? envs.default;
    if (active?.gitops?.repo) {
      out.gitopsRepo = active.gitops.repo;
      out.gitopsSource = 'envs.json';
      out.canMute = true;
      out.canCompact = true;
    }
    if (active?.forwarder && active.forwarder !== 'unknown') {
      out.forwarderKind = active.forwarder;
    }
    if (active?.analyzer) {
      out.analyzerVendor = active.analyzer;
    }
  } catch {
    // ignore; fall through to env-var / snapshot
  }

  // Source 2: env-var fallbacks. Read directly because in demo-mode or
  // when no LOG10X_METRICS_* is set, env vars don't propagate through
  // `loadEnvironments` to an EnvConfig. This direct read is the
  // "no-other-config" path that still lets the user supply config.
  if (!out.gitopsRepo && process.env.LOG10X_GH_REPO) {
    out.gitopsRepo = process.env.LOG10X_GH_REPO;
    out.gitopsSource = 'env-var';
    out.canMute = true;
    out.canCompact = true;
  }
  if (!out.forwarderKind && process.env.LOG10X_FORWARDER) {
    // Reuse the same parser the env-loader uses so aliases like
    // "fluent-bit", "otel", "beats" normalize identically.
    const raw = process.env.LOG10X_FORWARDER.trim().toLowerCase();
    const map: Record<string, Capabilities['forwarderKind']> = {
      'fluent-bit': 'fluentbit', fluentbit: 'fluentbit', fluent_bit: 'fluentbit',
      fluentd: 'fluentd', 'fluent-d': 'fluentd',
      filebeat: 'filebeat', beats: 'filebeat',
      logstash: 'logstash',
      otel: 'otel-collector', otelcol: 'otel-collector',
      'otel-collector': 'otel-collector', 'opentelemetry-collector': 'otel-collector',
    };
    if (map[raw]) out.forwarderKind = map[raw];
  }
  if (!out.analyzerVendor && process.env.LOG10X_ANALYZER) {
    // Same alias normalization as env-loader's parseAnalyzerEnv. Inline
    // copy keeps the file self-contained without a cross-module import.
    const s = process.env.LOG10X_ANALYZER.trim().toLowerCase();
    const aliases: Record<string, string> = {
      datadog: 'datadog', dd: 'datadog',
      splunk: 'splunk', 'splunk enterprise': 'splunk',
      'splunk observability': 'splunk-obs', 'splunk-obs': 'splunk-obs', signalfx: 'splunk-obs',
      elasticsearch: 'elasticsearch', elastic: 'elasticsearch', kibana: 'elasticsearch', elk: 'elasticsearch',
      opensearch: 'opensearch',
      cloudwatch: 'cloudwatch', cw: 'cloudwatch', 'aws cloudwatch': 'cloudwatch', 'cloudwatch logs': 'cloudwatch',
      azure: 'azure-monitor', 'azure monitor': 'azure-monitor', 'azure-monitor': 'azure-monitor', 'log analytics': 'azure-monitor', sentinel: 'azure-monitor',
      'new relic': 'new-relic', newrelic: 'new-relic', nr: 'new-relic',
      gcp: 'gcp-logging', 'gcp logging': 'gcp-logging', 'google cloud': 'gcp-logging', 'google cloud logging': 'gcp-logging', stackdriver: 'gcp-logging',
      dynatrace: 'dynatrace', dt: 'dynatrace',
      sumo: 'sumo', 'sumo logic': 'sumo', sumologic: 'sumo',
      grafana: 'grafana-loki', loki: 'grafana-loki', 'grafana loki': 'grafana-loki',
      coralogix: 'coralogix',
      logzio: 'logzio', 'logz.io': 'logzio', logz: 'logzio',
      crowdstrike: 'crowdstrike', 'crowdstrike falcon': 'crowdstrike', 'falcon logscale': 'crowdstrike', humio: 'crowdstrike',
      victorialogs: 'victorialogs', 'victoria logs': 'victorialogs', vlog: 'victorialogs', vlogs: 'victorialogs',
    };
    out.analyzerVendor = aliases[s] ?? process.env.LOG10X_ANALYZER.trim();
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
      // Forwarder kind. `existingForwarder` is set by the discovery code's
      // `classifyForwarderImage` against running pods in the cluster.
      // Possible values: fluentbit / fluentd / filebeat / logstash /
      // otel-collector / unknown. Only fill in if a higher-priority
      // source (envs.json or env-var) didn't already declare one — those
      // are user-explicit and should win.
      if (!out.forwarderKind && snap.recommendations.existingForwarder) {
        out.forwarderKind = snap.recommendations.existingForwarder;
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

  // Option 1 — SIEM-side. Always available conceptually; the wording
  // depends on whether we know the user's specific analyzer.
  const analyzerName = analyzerLabel(caps.analyzerVendor);
  const analyzerSupported = caps.analyzerVendor ? NATIVE_EXCLUSION_VENDORS.has(caps.analyzerVendor) : false;
  if (analyzerName && analyzerSupported) {
    lines.push(
      `**1. Drop it at ${analyzerName}.** Fastest. We generate a ready-to-apply ${analyzerName} exclusion config; you paste it (or apply via API) and the cost stops within minutes. Events still flow through your pipeline up to ${analyzerName} — they just don't get indexed or stored. Easy to undo in the same UI.`
    );
  } else if (analyzerName) {
    lines.push(
      `**1. Drop it at ${analyzerName}.** Fastest. Apply an exclusion in ${analyzerName} and the cost stops within minutes. Events still flow through your pipeline up to ${analyzerName} — they just don't get indexed. Note: log10x_exclusion_filter doesn't yet generate native configs for ${analyzerName} (supports Datadog, Splunk, Elasticsearch, AWS CloudWatch); you'd apply this one manually in the ${analyzerName} UI for now.`
    );
  } else {
    lines.push(
      `**1. Drop it at your analyzer.** Fastest. Save a config in your log analyzer and the cost stops within minutes. Events still flow through your pipeline up to the analyzer — they just don't get indexed or stored. We could not auto-detect which analyzer you ship to — log10x_exclusion_filter can generate native configs for Datadog, Splunk, Elasticsearch, and AWS CloudWatch. For any other analyzer the agent should ask the user and either generate the config (when supported) or hand-instruct apply (when not).`
    );
  }
  lines.push('');

  // Option 2 — Forwarder-side. Generation is via the same exclusion_filter
  // tool with the forwarder-vendor arg. If we know which forwarder the
  // customer is running (from the snapshot), we name it; otherwise we
  // list the supported ones and let the agent ask.
  const knownForwarder = caps.forwarderKind && caps.forwarderKind !== 'unknown';
  const forwarderLabel: Record<NonNullable<Capabilities['forwarderKind']>, string> = {
    fluentbit: 'Fluent Bit',
    fluentd: 'Fluentd',
    filebeat: 'Filebeat',
    logstash: 'Logstash',
    'otel-collector': 'OpenTelemetry Collector',
    unknown: 'forwarder',
  };
  if (knownForwarder) {
    lines.push(
      `**2. Drop it at your forwarder (${forwarderLabel[caps.forwarderKind!]}).** Same idea as option 1 but one step earlier. The events never even leave your environment, so on top of analyzer savings you also save the bandwidth between your forwarder and your analyzer. Requires editing your ${forwarderLabel[caps.forwarderKind!]} config and reloading it (seconds to minutes).`
    );
  } else {
    lines.push(
      '**2. Drop it at your forwarder.** Same idea as option 1 but one step earlier. The events never even leave your environment, so on top of analyzer savings you also save the bandwidth between your forwarder and your analyzer. We could not auto-detect which forwarder you run (no snapshot or no recognized image) — supported: Fluent Bit, Fluentd, Filebeat, Logstash, OpenTelemetry Collector. If you pick option 2 the agent should ask which one and then generate the right config.'
    );
  }
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
      args: {
        pattern,
        vendor: analyzerSupported ? caps.analyzerVendor! : 'datadog',
      },
      reason: analyzerSupported
        ? `option 1 — analyzer-side exclusion (auto-detected analyzer: ${caps.analyzerVendor})`
        : caps.analyzerVendor
          ? `option 1 — analyzer-side exclusion (detected analyzer: ${caps.analyzerVendor}, but log10x_exclusion_filter doesn't generate native configs for it; agent should hand-instruct rather than call this entry blindly)`
          : `option 1 — analyzer-side exclusion (vendor unknown; agent should confirm with user before generating config)`,
    },
    {
      tool: 'log10x_exclusion_filter',
      args: { pattern, vendor: knownForwarder ? caps.forwarderKind! : 'fluentbit' },
      reason: knownForwarder
        ? `option 2 — forwarder-side drop (auto-detected forwarder: ${caps.forwarderKind})`
        : 'option 2 — forwarder-side drop (forwarder unknown; agent should confirm with user before generating config)',
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
      tool: 'log10x_configure_compact',
      args: { service: pattern, ...(caps.gitopsRepo ? { gitops_repo: caps.gitopsRepo } : {}) },
      reason: 'option 4 — resolve the service to its containers and generate the GitOps PR diff for per-container compaction',
    });
  }

  lines.push('');
  lines.push(agentOnly(
    `Routing constraint: do not call any drop/mute/compact sub-tool until the user picks an option. ` +
    `When they do, route option 1 → log10x_exclusion_filter with their analyzer vendor; option 2 → same tool with their forwarder vendor; ` +
    `option 3 → log10x_advise_receiver; option 4 → log10x_configure_compact. ` +
    `For options 1 and 3, call log10x_dependency_check first and present its findings before generating the drop config. ` +
    `log10x_exclusion_filter emits an exact tenx_hash drop as the primary config (precise, collision-proof) for structured-field vendors when the env's pipeline carries tenx_hash, with the message-regex form as fallback; the raw-line forwarders rsyslog/syslog-ng/promtail have no structured field so they keep the regex form. For options 1/2 on structured vendors, frame it as a precise drop, not an approximate regex match.` +
    (caps.gitopsRepo ? ` Resolved gitops_repo: ${caps.gitopsRepo} (source: ${caps.gitopsSource}).` : '')
  ));
  lines.push('');
  lines.push(renderNextActions(nextActions));

  return lines.join('\n');
}
