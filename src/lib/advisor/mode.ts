/**
 * Mode recommender — picks the right install path from a discovery
 * snapshot (+ optional goal).
 *
 * Sits in front of `buildReporterPlan` / `buildRetrieverPlan` and decides:
 *   - Which app: reporter / reducer / retriever
 *   - Which deployment shape: inline (replace forwarder) / standalone
 *     (parallel DaemonSet) / standalone-retriever
 *   - Which forwarder (when inline)
 *   - Whether to enable compact encoding (optimize)
 *   - Which namespace
 *
 * The recommendation is produced purely from `DiscoverySnapshot` fields —
 * no additional probes. Keep it side-effect-free so the advise tool can
 * call it cheaply multiple times per snapshot.
 *
 * Rule priority (first matching wins, but we evaluate ALL rules so the
 * returned `alternatives` list covers the rejected options too):
 *
 *   1. goal='archive' → retriever (require S3+SQS+IRSA in snapshot)
 *   2. no forwarder detected (or kind='unknown') → standalone reporter
 *   3. forwarder detected, but NOT helm-managed → standalone reporter
 *      (we can't upgrade a hand-rolled DaemonSet to a log10x-repackaged
 *      version without rewriting their manifests)
 *   4. forwarder is helm-managed logstash → standalone reporter (chart
 *      broken for sidecar mode; surface migration note)
 *   5. forwarder is helm-managed fluent-bit/fluentd/filebeat/otel-collector (all 1.0.7):
 *        goal='compact'     → inline reducer + optimize=true
 *        goal='cut-cost'    → inline reducer
 *        goal='just-metrics'→ inline reporter (standalone is alt)
 *        no goal            → inline reporter (standalone is alt)
 *
 * Already-installed apps are surfaced as warnings — we don't silently
 * refuse to recommend a duplicate install, but the note makes it clear.
 */

import type {
  DiscoverySnapshot,
  DetectedForwarder,
  ForwarderKind,
} from '../discovery/types.js';
import type { AdvisorApp, DeploymentShape } from './reporter.js';

/** Goals a user might want to achieve. Optional — inference works without one. */
export type InstallGoal = 'just-metrics' | 'cut-cost' | 'compact' | 'archive';

/** A fully-resolved args bundle that `buildReporterPlan` / `buildRetrieverPlan` can consume. */
export interface ResolvedInstallArgs {
  app: AdvisorApp | 'retriever';
  shape: DeploymentShape;
  /** Detected forwarder (for context in standalone plans; drives chart for inline). */
  forwarder?: ForwarderKind;
  /** Only set when app='reducer' and target forwarder supports it. */
  optimize?: boolean;
  /** Target namespace. */
  namespace: string;
}

/** One candidate mode with its score + rationale. Higher score = better match. */
export interface RankedAlternative {
  /** Short label: "standalone reporter", "inline reducer (fluent-bit) + optimize", etc. */
  label: string;
  args: ResolvedInstallArgs;
  /** Detection-based score. Alternatives are sorted descending by this. */
  score: number;
  /** One-line reason why this option ranks where it does. */
  rationale: string;
  /**
   * If set, this mode is NOT installable right now. Callers should still
   * see it in the list so they know it was considered, but the top pick
   * will never be a blocked alternative.
   */
  blocker?: string;
}

/** The full recommendation. */
export interface ModeRecommendation {
  /** The highest-scoring non-blocked alternative. Always set. */
  topPick: RankedAlternative;
  /** All candidates (including topPick), sorted descending by score. */
  alternatives: RankedAlternative[];
  /** One-paragraph prose explaining what was detected + why the top pick won. */
  rationale: string;
  /** Terse bullet list of the detection signals the recommendation is based on. */
  detectionSummary: string[];
  /**
   * Warnings surfaced from the snapshot that the user should see above
   * the recommendation (e.g., "reporter is already installed").
   */
  warnings: string[];
}

// ── Scoring constants ──
//
// Picked so rule priority is monotonic: a direct goal match beats a
// fallback; a blocked alt is always lower than any installable alt.
const SCORE_DIRECT_GOAL_MATCH = 100;
const SCORE_GOAL_FIT = 80;
const SCORE_DEFAULT_FIT = 60;
const SCORE_FALLBACK = 40;
const SCORE_ALTERNATIVE_OK = 50;
const SCORE_BLOCKED = 0;

// ── Detection helpers ──

/** True when the forwarder workload looks helm-managed (has helm provenance labels). */
function isHelmManaged(f: DetectedForwarder): boolean {
  const labels = f.labels ?? {};
  return Boolean(
    labels['app.kubernetes.io/managed-by'] === 'Helm' ||
      labels['helm.sh/chart'] ||
      labels['helm.sh/release']
  );
}

/** Pick the most relevant forwarder from the snapshot (prefer helm-managed, prefer ready). */
function pickPrimaryForwarder(snapshot: DiscoverySnapshot): DetectedForwarder | undefined {
  const candidates = snapshot.kubectl.forwarders.filter((f) => f.kind !== 'unknown');
  if (candidates.length === 0) return undefined;
  const helm = candidates.find(isHelmManaged);
  return helm ?? candidates.find((f) => f.readyReplicas > 0) ?? candidates[0];
}

/** True when the snapshot has enough AWS signal to plan a retriever install. */
function retrieverInfraPresent(snapshot: DiscoverySnapshot): boolean {
  const r = snapshot.recommendations;
  const sqs = r.retrieverSqsUrls ?? {};
  return Boolean(r.retrieverS3Bucket) && Object.values(sqs).some((v) => Boolean(v));
}

// ── Core recommender ──

export interface RecommendOpts {
  snapshot: DiscoverySnapshot;
  goal?: InstallGoal;
  /** Override forwarder detection (bypasses snapshot). */
  forwarder?: ForwarderKind;
}

export function recommendInstallMode(opts: RecommendOpts): ModeRecommendation {
  const { snapshot, goal } = opts;
  const namespace = snapshot.recommendations.suggestedNamespace ?? 'logging';
  const primary = pickPrimaryForwarder(snapshot);
  const detectedKind: ForwarderKind = opts.forwarder ?? primary?.kind ?? snapshot.recommendations.existingForwarder ?? 'unknown';
  const helmManaged = primary ? isHelmManaged(primary) : false;

  const detectionSummary: string[] = [];
  detectionSummary.push(
    primary
      ? `Forwarder: **${primary.kind}** in \`${primary.namespace}\` (${helmManaged ? 'helm-managed' : 'hand-rolled'}, image \`${primary.image}\`).`
      : 'No forwarder detected in probed namespaces.'
  );
  detectionSummary.push(
    `Namespace suggestion: \`${namespace}\`${snapshot.recommendations.existingForwarderNamespace ? ` (from detected forwarder)` : ''}.`
  );
  if (snapshot.kubectl.log10xApps.length > 0) {
    // Dedup by kind+namespace so a retriever's 7 subcomponent CronJobs
    // don't render as "retriever(demo), retriever(demo), retriever(demo)…".
    const seen = new Set<string>();
    const condensed: string[] = [];
    for (const a of snapshot.kubectl.log10xApps) {
      const k = `${a.kind}(${a.namespace})`;
      if (!seen.has(k)) {
        seen.add(k);
        condensed.push(k);
      }
    }
    detectionSummary.push(`Log10x apps already in cluster: ${condensed.join(', ')}.`);
  }
  if (snapshot.aws.available) {
    const retrieverReady = retrieverInfraPresent(snapshot);
    detectionSummary.push(
      `AWS reachable (${snapshot.aws.region ?? 'region unknown'}); retriever infra ${retrieverReady ? '**present**' : 'missing'}.`
    );
  } else {
    detectionSummary.push('AWS CLI not reachable — retriever advice will be best-effort.');
  }

  const warnings: string[] = [];
  if (snapshot.recommendations.alreadyInstalled.reporter) {
    warnings.push(
      `A Reporter is already installed in \`${snapshot.recommendations.alreadyInstalled.reporter}\`. Installing another duplicates metric emission — tear down first, or target a different namespace.`
    );
  }
  if (snapshot.recommendations.alreadyInstalled.reducer) {
    warnings.push(
      `A Reducer is already installed in \`${snapshot.recommendations.alreadyInstalled.reducer}\`. Two reducers on the same event stream double-filter — tear one down before installing another.`
    );
  }

  // Enumerate candidates.
  const alts: RankedAlternative[] = [];

  // ── Standalone reporter (always a valid option) ──
  alts.push(makeStandaloneAlt({ detectedKind, namespace, goal, helmManaged, primary }));

  // ── Inline options, one per supported forwarder kind when applicable ──
  if (detectedKind !== 'unknown') {
    alts.push(...makeInlineAlts({ detectedKind, namespace, goal, helmManaged }));
  } else {
    // No detected forwarder — surface inline fluent-bit as an option but
    // score it lower (the user would be installing a forwarder from scratch).
    alts.push(...makeInlineAlts({ detectedKind: 'fluent-bit', namespace, goal, helmManaged: false }));
  }

  // ── Retriever option (independent of forwarder state) ──
  alts.push(makeRetrieverAlt({ snapshot, namespace, goal }));

  // Sort: installable (no blocker) first, then by score desc.
  alts.sort((a, b) => {
    const aBlocked = Boolean(a.blocker);
    const bBlocked = Boolean(b.blocker);
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    return b.score - a.score;
  });

  const topPick = alts.find((a) => !a.blocker) ?? alts[0];

  const rationale = buildRationale(topPick, detectedKind, helmManaged, goal);

  return {
    topPick,
    alternatives: alts,
    rationale,
    detectionSummary,
    warnings,
  };
}

// ── Alternative builders ──

function makeStandaloneAlt(params: {
  detectedKind: ForwarderKind;
  namespace: string;
  goal: InstallGoal | undefined;
  helmManaged: boolean;
  primary: DetectedForwarder | undefined;
}): RankedAlternative {
  const { detectedKind, namespace, goal, helmManaged, primary } = params;

  // Goal compatibility: standalone is ALWAYS report-mode only. Block when
  // the user explicitly wants cut-cost / compact. (They still see it in
  // the list, but the top pick can't land there.)
  let blocker: string | undefined;
  if (goal === 'cut-cost' || goal === 'compact') {
    blocker = `standalone is report-mode only (metrics, no filtering or encoded output). For goal=${goal} you need an inline install that hooks into the forwarder's output path.`;
  }
  if (goal === 'archive') {
    blocker = 'standalone reporter is metrics-only; goal=archive requires the Retriever (S3 + SQS).';
  }

  // Scoring:
  //   - goal=just-metrics → this is the direct match
  //   - no goal → reporter is the conservative default
  //   - no forwarder / unknown / hand-rolled / logstash → strongly preferred
  //   - helm-managed fluent-bit/fluentd → lower than inline (user can safely upgrade)
  let score = SCORE_DEFAULT_FIT;
  let rationale = '';
  if (goal === 'just-metrics') {
    score = SCORE_DIRECT_GOAL_MATCH;
    rationale = 'Standalone reporter — report-mode, non-invasive, matches goal=just-metrics directly.';
  } else if (!primary || detectedKind === 'unknown') {
    score = SCORE_DIRECT_GOAL_MATCH;
    rationale = 'No forwarder detected — reporter-10x ships its own fluent-bit, so it works anywhere.';
  } else if (!helmManaged) {
    score = SCORE_DIRECT_GOAL_MATCH;
    rationale = `Detected forwarder is hand-rolled — inline would require rewriting your manifests; reporter-10x runs in parallel, zero-touch.`;
  } else if (detectedKind === 'logstash') {
    score = SCORE_DIRECT_GOAL_MATCH;
    rationale = 'log10x-elastic/logstash chart is architecturally broken for sidecar mode (tenx wants to be a child process of logstash, chart runs it as a separate container). Standalone reporter-10x is the recommended path.';
  } else {
    score = SCORE_ALTERNATIVE_OK;
    rationale = 'Standalone reporter is always a safe alternative — non-invasive, report-mode only.';
  }

  return {
    label: 'Standalone Reporter (reporter-10x)',
    args: {
      app: 'reporter',
      shape: 'standalone',
      forwarder: primary?.kind,
      namespace,
    },
    score: blocker ? SCORE_BLOCKED : score,
    rationale,
    blocker,
  };
}

function makeInlineAlts(params: {
  detectedKind: ForwarderKind;
  namespace: string;
  goal: InstallGoal | undefined;
  helmManaged: boolean;
}): RankedAlternative[] {
  const { detectedKind, namespace, goal, helmManaged } = params;
  const alts: RankedAlternative[] = [];

  // Only produce inline alts for the detected forwarder kind — recommending
  // an inline fluent-bit install on a cluster running fluentd would mean
  // telling the user to rip out their fluentd. Outside the detection guard
  // we only surface standalone (above).

  if (detectedKind === 'unknown') return alts;

  // Blocker: non-helm-managed forwarder can't be safely replaced inline.
  const helmBlocker = helmManaged
    ? undefined
    : `detected forwarder is not helm-managed — inline install would replace it with a log10x-repackaged chart, which means rewriting your existing manifests. Use shape=standalone or helm-install the user's forwarder first.`;

  // Blocker: logstash chart is broken for sidecar mode.
  const logstashBlocker =
    detectedKind === 'logstash'
      ? 'log10x-elastic/logstash chart is architecturally broken for sidecar mode (stdin wiring, independent of chart version). Pick fluent-bit/fluentd/filebeat/otel-collector or shape=standalone.'
      : undefined;

  // Inline reporter.
  // No-goal case: this is the conservative default when the user has a
  // helm-managed, replaceable forwarder — no extra DaemonSet, no event
  // modification, just metrics. Ranks above Inline Reducer because
  // report-mode touches the event path less than regulate-mode does.
  alts.push({
    label: `Inline Reporter (${detectedKind})`,
    args: {
      app: 'reporter',
      shape: 'inline',
      forwarder: detectedKind,
      namespace,
    },
    score: goal === 'just-metrics'
      ? SCORE_DIRECT_GOAL_MATCH
      : goal === undefined
        ? SCORE_GOAL_FIT
        : SCORE_FALLBACK,
    rationale:
      goal === 'just-metrics'
        ? `Inline reporter on helm-managed ${detectedKind} — metrics + pattern fingerprinting inside the existing forwarder.`
        : `Inline reporter — tenx logic inside the forwarder you already run; metrics only, no event modification.`,
    blocker: helmBlocker ?? logstashBlocker,
  });

  // Inline reducer (filter/sample).
  // No-goal case: reducer sits BELOW reporter (conservative default).
  // Users who want filtering state that goal explicitly.
  alts.push({
    label: `Inline Reducer (${detectedKind})`,
    args: {
      app: 'reducer',
      shape: 'inline',
      forwarder: detectedKind,
      namespace,
    },
    score:
      goal === 'cut-cost'
        ? SCORE_DIRECT_GOAL_MATCH
        : goal === 'compact'
          ? SCORE_GOAL_FIT
          : goal === 'just-metrics'
            ? SCORE_FALLBACK
            : SCORE_ALTERNATIVE_OK,
    rationale:
      goal === 'cut-cost'
        ? `Inline reducer on ${detectedKind} — filter/sample rules applied in-flight, events emitted back through the forwarder.`
        : `Inline reducer — full filter/sample/compact engine on the forwarder's event path. No filtering rules applied by default; escalate to this over Inline Reporter only when you want event modification.`,
    blocker: helmBlocker ?? logstashBlocker,
  });

  // Inline reducer + optimize (compact encoding).
  // All 5 forwarder charts now ship at 1.0.7 with a unified optimize path
  // (kind=optimize launches @apps/reducer + reducerOptimize=true env
  // var). Logstash still hits its architectural sidecar bug regardless
  // of optimize, so the logstashBlocker above handles that case.
  const optimizeBlocker = undefined;
  alts.push({
    label: `Inline Reducer + Compact (${detectedKind})`,
    args: {
      app: 'reducer',
      shape: 'inline',
      forwarder: detectedKind,
      optimize: true,
      namespace,
    },
    score:
      goal === 'compact'
        ? SCORE_DIRECT_GOAL_MATCH
        : goal === 'cut-cost'
          ? SCORE_GOAL_FIT
          : SCORE_ALTERNATIVE_OK,
    rationale:
      goal === 'compact'
        ? `Inline reducer + optimize on ${detectedKind} — compact encoding (~20-40x volume reduction) applied in-flight.`
        : `Inline reducer + optimize — maximum volume reduction; events emitted in compact \`~templateHash,vars\` form.`,
    blocker: helmBlocker ?? logstashBlocker ?? optimizeBlocker,
  });

  return alts;
}

function makeRetrieverAlt(params: {
  snapshot: DiscoverySnapshot;
  namespace: string;
  goal: InstallGoal | undefined;
}): RankedAlternative {
  const { snapshot, namespace, goal } = params;
  const infraReady = retrieverInfraPresent(snapshot);
  let blocker: string | undefined;
  if (!infraReady) {
    blocker = `Retriever requires an S3 bucket + SQS queues + IRSA-annotated SA — none detected in snapshot. Provision via Terraform first (see docs/apps/cloud/retriever/setup), or set \`retrieverS3Bucket\` hint in discovery.`;
  }
  const score =
    goal === 'archive'
      ? infraReady
        ? SCORE_DIRECT_GOAL_MATCH
        : SCORE_BLOCKED
      : SCORE_ALTERNATIVE_OK;

  return {
    label: 'Retriever (S3 archive + query)',
    args: {
      app: 'retriever',
      shape: 'standalone',
      namespace,
    },
    score,
    rationale:
      goal === 'archive'
        ? infraReady
          ? 'Retriever — long-term S3 archive with Bloom-filter index; detected AWS infra is compatible.'
          : 'Retriever matches goal=archive but required AWS infra is missing — blocker before install.'
        : 'Retriever — separate pillar for long-term archive + forensic query; consider alongside a Reporter/Reducer install.',
    blocker,
  };
}

function buildRationale(
  top: RankedAlternative,
  detectedKind: ForwarderKind,
  helmManaged: boolean,
  goal: InstallGoal | undefined
): string {
  const parts: string[] = [];
  if (goal) parts.push(`Goal: **${goal}**.`);
  parts.push(
    detectedKind === 'unknown'
      ? 'No forwarder detected.'
      : `Detected forwarder: **${detectedKind}** (${helmManaged ? 'helm-managed' : 'hand-rolled'}).`
  );
  parts.push(`Top pick: **${top.label}** — ${top.rationale}`);
  return parts.join(' ');
}
