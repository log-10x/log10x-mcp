/**
 * Computes a `ExpectedAnswer` block for a hero question from a captured
 * oracle snapshot. The campaign treats the snapshot as authoritative —
 * if the oracle says "top-3 by 24h are X/Y/Z", that's what the agent
 * is expected to surface. Any deviation is flagged as a gap.
 *
 * One function per question; the dispatcher picks the right one based
 * on `question_id`. New questions add a new branch here. Authoring is
 * deliberately opinionated: the planner decides what "correct" means
 * for each question (top-N by what metric, what severity slice, etc.)
 * and that decision is committed in code.
 */
import type { ExpectedAnswer, CampaignHeroSpec } from './types.js';
import type { OracleSnapshot } from './prom-oracle.js';

/**
 * Top-3 patterns by 24h volume, with their severity + service tags.
 * Used by cost-q1 (top patterns), cost-q3 (current cost), and
 * stability-q5 (what dominates).
 */
function topPatternsByVolume(snap: OracleSnapshot, n: number = 3): ExpectedAnswer['top_patterns'] {
  return snap.top_patterns_24h.slice(0, n).map((p) => ({
    name: p.hash,
    bytes_24h: p.bytes,
    severity: p.severity || undefined,
    service: p.service || undefined,
  }));
}

/**
 * The actual cost-driver growth deltas — patterns whose 24h-vs-prior-
 * 24h delta is positive. cost_drivers tool emits "no movement" on the
 * stable demo env, so we accept either:
 *   - the agent surfaces the actual growth deltas (Kafka metadata
 *     churn etc.) via investigate / cost_drivers with longer windows
 *   - OR the agent correctly reports "no growth in last 24h" and
 *     pivots to current-rank
 * The expected_answer captures the actual deltas so the scorer can
 * grade against either path.
 */
function growthDeltaPatterns(snap: OracleSnapshot, n: number = 3): ExpectedAnswer['top_patterns'] {
  return snap.growth_deltas_24h.slice(0, n).map((g) => ({
    name: g.hash,
    bytes_24h: g.delta_bytes,
  }));
}

/**
 * Compute the expected answer for a given question id from a snapshot.
 * Returns null if the question_id is unknown — caller decides how to
 * handle (typically: use whatever expected_answer is already in the
 * fixture).
 */
export function computeExpectedAnswer(
  questionId: string,
  snap: OracleSnapshot
): ExpectedAnswer | null {
  switch (questionId) {
    // ── Cost category ────────────────────────────────────────────────
    case 'cost-top-by-volume':
      return {
        summary: `Top patterns by 24h volume on the demo env are dominated by OTel collector self-emitted patterns; ${snap.top_patterns_24h[0]?.hash || '(unknown)'} is #1.`,
        top_patterns: topPatternsByVolume(snap, 5),
        must_mention: [
          // Top-3 hash names; agent is expected to quote at least one.
          ...(snap.top_patterns_24h.slice(0, 3).map((p) => p.hash.split('_')[0]).filter(Boolean)),
        ],
        expected_tool_chain: ['log10x_top_patterns'],
        expected_oracle_query: `topk(5, sum by (message_pattern, tenx_user_service, severity_level)(increase(all_events_summaryBytes_total[24h])))`,
        snapshot_ts: snap.taken_at,
      };
    case 'cost-bill-driver':
      return {
        summary: `Cost growth in the last 24h is dominated by Kafka metadata churn + OTel exporter retry errors. cost_drivers may report 'no drivers detected' on stable replay; correct response is either the actual growth deltas OR the truthful-negative + fallback to top_patterns.`,
        top_patterns: growthDeltaPatterns(snap, 5),
        must_mention: [], // Hard to require specific words; pattern-match score handles this.
        must_not_mention: [
          // Old documented top patterns that are NO LONGER top-of-bill.
          'cart_cartstore is the top driver',
          'cart_cartstore drives the bill',
        ],
        expected_tool_chain: ['log10x_cost_drivers'],
        expected_oracle_query: `topk(5, sum by (message_pattern)(increase(all_events_summaryBytes_total[24h])) - sum by (message_pattern)(increase(all_events_summaryBytes_total[24h] offset 1d)))`,
        snapshot_ts: snap.taken_at,
      };
    case 'cost-week-over-week':
      return {
        summary: `Demo env is a continuous-replay env; week-over-week growth is near zero. Correct answer recognizes the stable run-rate and reports total volume + top contributors.`,
        top_patterns: topPatternsByVolume(snap, 3),
        must_mention: [], // accept "stable" / "no growth" / actual deltas
        expected_tool_chain: ['log10x_cost_drivers'],
        snapshot_ts: snap.taken_at,
      };
    case 'cost-mute-candidates':
      return {
        summary: `Safest mute candidates are high-volume patterns with no severity (or DEBUG/TRACE), which on this env are the OTel collector internals. Agent must mention dependency_check before suggesting mute.`,
        top_patterns: snap.top_patterns_24h
          .filter((p) => !p.severity || p.severity === 'DEBUG' || p.severity === 'TRACE')
          .slice(0, 3)
          .map((p) => ({ name: p.hash, bytes_24h: p.bytes, severity: p.severity || undefined })),
        must_mention: ['dependency_check', 'exclusion_filter'],
        expected_tool_chain: ['log10x_top_patterns', 'log10x_dependency_check', 'log10x_exclusion_filter'],
        snapshot_ts: snap.taken_at,
      };
    case 'cost-namespace-attribution':
      return {
        summary: `On the demo env, ${snap.namespace_split[0]?.value || '(unknown)'} is the top namespace by volume, with ${((snap.namespace_split[0]?.bytes || 0) / 1e9).toFixed(2)} GB / 24h. ${snap.namespace_split.length === 2 && snap.namespace_split[0]?.value === '(empty)' ? 'NOTE: 99.96% of volume has empty k8s_namespace label — a real labeling gap, not a single namespace dominating.' : ''}`,
        top_patterns: [],
        must_mention: snap.namespace_split[0]?.value === '(empty)' ? ['(empty)'] : [snap.namespace_split[0]?.value || 'otel-demo'],
        expected_namespaces: snap.namespace_split.slice(0, 5).map((n) => ({ name: n.value, bytes_24h: n.bytes })),
        expected_tool_chain: ['log10x_list_by_label'],
        expected_oracle_query: `topk(5, sum by (k8s_namespace)(increase(all_events_summaryBytes_total[24h])))`,
        snapshot_ts: snap.taken_at,
      };

    // ── Error-levels category ────────────────────────────────────────
    case 'error-severity-distribution':
      return {
        summary: `83% of demo-env volume is UNTAGGED (no severity_level label). ERROR is the second-largest tier at ~8.6% / 464MB. CRITICAL is rare (~2MB).`,
        top_patterns: [],
        must_mention: ['ERROR'],
        expected_severity_split: Object.fromEntries(snap.severity_split.map((s) => [s.severity, s.bytes])),
        expected_tool_chain: ['log10x_list_by_label'], // list_by_label severity_level
        expected_oracle_query: `sum by (severity_level)(increase(all_events_summaryBytes_total[24h]))`,
        snapshot_ts: snap.taken_at,
      };
    case 'error-top-error-pattern':
      return {
        summary: `The top ERROR-severity pattern is service_instance_id_service_name_otelcol_contrib_service_version_otelcol at ~397MB / 24h. Total ERROR volume is ~464MB / 24h.`,
        top_patterns: snap.top_patterns_24h
          .filter((p) => p.severity === 'ERROR')
          .slice(0, 3)
          .map((p) => ({ name: p.hash, bytes_24h: p.bytes, severity: 'ERROR' })),
        must_mention: ['service_instance_id', 'ERROR'],
        expected_tool_chain: ['log10x_top_patterns'],
        expected_oracle_query: `topk(3, sum by (message_pattern)(increase(all_events_summaryBytes_total{severity_level="ERROR"}[24h])))`,
        snapshot_ts: snap.taken_at,
      };
    case 'error-investigate-pattern':
      return {
        summary: `Investigation of the top ERROR pattern should produce a coherent report (acute-spike or stable). Expected to use log10x_investigate with the resolved pattern name.`,
        top_patterns: snap.top_patterns_24h.filter((p) => p.severity === 'ERROR').slice(0, 1).map((p) => ({ name: p.hash, bytes_24h: p.bytes, severity: 'ERROR' })),
        expected_tool_chain: ['log10x_investigate'],
        snapshot_ts: snap.taken_at,
      };
    case 'error-untagged-explanation':
      return {
        summary: `83% of demo-env volume is UNTAGGED severity_level. This is a labeling-quality issue, not a service issue. Expected response: identify the untagged share, recommend severity enrichment, NOT recommend muting.`,
        top_patterns: [],
        must_mention: ['untagged'],
        must_not_mention: ['mute the untagged'],
        expected_severity_split: Object.fromEntries(snap.severity_split.map((s) => [s.severity, s.bytes])),
        expected_tool_chain: ['log10x_list_by_label'],
        snapshot_ts: snap.taken_at,
      };
    case 'error-critical-events':
      return {
        summary: `CRITICAL severity has ~2MB / 24h on the demo env (rare). Expected: agent identifies these patterns specifically and reports the volume.`,
        top_patterns: [],
        expected_severity_split: { CRITICAL: snap.severity_split.find((s) => s.severity === 'CRITICAL')?.bytes ?? 0 },
        expected_tool_chain: ['log10x_list_by_label', 'log10x_top_patterns'],
        expected_oracle_query: `topk(5, sum by (message_pattern)(increase(all_events_summaryBytes_total{severity_level="CRITICAL"}[24h])))`,
        snapshot_ts: snap.taken_at,
      };

    // ── Stability category ───────────────────────────────────────────
    case 'stability-pipeline-health':
      return {
        summary: `Edge tier is healthy (metrics fresh within ${snap.freshness_seconds.edge.toFixed(0)}s). Cloud tier has zero metrics — the every-5-min cronjob does not exist on this env. Expected: agent runs doctor and reports both findings.`,
        top_patterns: [],
        must_mention: ['edge', 'cloud'],
        expected_freshness_seconds: snap.freshness_seconds,
        expected_tool_chain: ['log10x_doctor'],
        snapshot_ts: snap.taken_at,
      };
    case 'stability-newly-emerged':
      return {
        summary: `In the last 1 hour, ${snap.newly_emerged_5m_vs_1h.length} patterns newly emerged. Top: ${snap.newly_emerged_5m_vs_1h[0]?.hash || '(none)'}.`,
        top_patterns: snap.newly_emerged_5m_vs_1h.slice(0, 5).map((e) => ({ name: e.hash, bytes_24h: 0 })),
        must_mention: snap.newly_emerged_5m_vs_1h.length > 0 ? [snap.newly_emerged_5m_vs_1h[0].hash.split('_')[0]] : [],
        expected_tool_chain: ['log10x_top_patterns', 'log10x_investigate'],
        snapshot_ts: snap.taken_at,
      };
    case 'stability-services-emitting':
      return {
        summary: `Only ${snap.service_split.length} distinct services in metrics on demo env. ${snap.service_split.slice(0, 3).map((s) => `${s.value}=${(s.bytes / 1e6).toFixed(1)}MB`).join(', ')}. Note: most volume is untagged service.`,
        top_patterns: [],
        must_mention: ['email'],
        expected_tool_chain: ['log10x_services'],
        expected_oracle_query: `sum by (tenx_user_service)(increase(all_events_summaryBytes_total[24h]))`,
        snapshot_ts: snap.taken_at,
      };
    case 'stability-env-sweep':
      return {
        summary: `Environment-wide investigation should run cleanly and surface either growth/decline drivers OR a truthful-negative. Top movers from oracle: ${snap.growth_deltas_24h.slice(0, 3).map((g) => g.hash).join(', ') || '(none)'}.`,
        top_patterns: growthDeltaPatterns(snap, 3),
        expected_tool_chain: ['log10x_investigate'],
        snapshot_ts: snap.taken_at,
      };
    case 'stability-cloud-reporter-missing':
      return {
        summary: `Cloud reporter cronjob does NOT exist on this env. Expected: agent diagnoses absence (via doctor or services) and notes that cloud-tier metrics are zero.`,
        top_patterns: [],
        must_mention: ['cloud'],
        expected_freshness_seconds: { cloud: Infinity },
        expected_tool_chain: ['log10x_doctor'],
        snapshot_ts: snap.taken_at,
      };

    default:
      return null;
  }
}

/**
 * Refresh expected_answer for every spec in a list against a fresh
 * snapshot. Returns the updated list.
 */
export function refreshAll(
  specs: CampaignHeroSpec[],
  snap: OracleSnapshot
): CampaignHeroSpec[] {
  return specs.map((spec) => {
    const computed = computeExpectedAnswer(spec.id, snap);
    if (computed) {
      return { ...spec, expected_answer: computed };
    }
    return spec;
  });
}
