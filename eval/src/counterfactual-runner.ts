/**
 * Counterfactual injection harness — verdict-delta computation.
 *
 * Given a CounterfactualSpec + pre/post oracle snapshots + a saved
 * hero transcript run against the post-injection env, computes a
 * three-layer verdict:
 *
 *   1. Metric layer: did Prometheus reflect the planted change?
 *   2. Agent layer: did the agent's bashCommands include the
 *      required cross-pillar tool? Did the synthesis mention the
 *      planted signal?
 *   3. Synthesis layer: existing campaign-scorer verdict.
 *
 * The orchestrator binary (`bin/run-counterfactual-scenario.mjs`)
 * drives the docker stack, snapshots, generator, and the hero-run.
 * This module just assembles the verdict from the recorded state.
 */
import type {
  CounterfactualSpec,
  CounterfactualVerdict,
  CampaignVerdict,
  CampaignHeroSpec,
} from './types.js';
import type { SavedTranscript } from './campaign-scorer.js';
import { scoreAgainstExpected } from './campaign-scorer.js';
import { extractToolChainFromBash } from './hero-oracle.js';
import {
  totalVolume,
  services as oracleServices,
  topPatterns as oracleTopPatterns,
  severitySplit as oracleSeveritySplit,
} from './prom-oracle.js';
import type { EvalEnv } from './env.js';

export interface OracleSnapshot {
  taken_at: string;
  range: string;
  total_volume_bytes: number;
  service_names: string[];
  severity_split: Record<string, number>;
  top_pattern_names: string[];
}

/**
 * Probe the oracle for a focused snapshot used by the counterfactual
 * runner. Smaller than the full `prom-oracle.dumpExpectedSnapshot`
 * (which includes 30d growth windows and freshness probes); we only
 * need labels that the counterfactual deltas check.
 */
export async function takeSnapshot(env: EvalEnv, range: string = '15m'): Promise<OracleSnapshot> {
  const [total, svcs, splitRows, tops] = await Promise.all([
    totalVolume(env, range),
    oracleServices(env, range),
    oracleSeveritySplit(env, range),
    oracleTopPatterns(env, range, 20),
  ]);
  const splitMap: Record<string, number> = {};
  for (const row of splitRows) splitMap[row.severity] = row.bytes;
  return {
    taken_at: new Date().toISOString(),
    range,
    total_volume_bytes: total,
    service_names: svcs,
    severity_split: splitMap,
    top_pattern_names: tops.map((t) => t.hash),
  };
}

/**
 * Compute the metric-layer verdict from the pre/post snapshots + spec.
 */
export function computeMetricVerdict(
  spec: CounterfactualSpec,
  scenarioIdx: number,
  pre: OracleSnapshot,
  post: OracleSnapshot
): CounterfactualVerdict['metric_layer'] {
  const predicted = spec.sensitive_scenarios[scenarioIdx].predicted_metric_delta;
  const notes: string[] = [];
  const observed: Record<string, unknown> = {};
  let satisfied = true;

  if (predicted.service_appears) {
    const appeared =
      !pre.service_names.includes(predicted.service_appears) &&
      post.service_names.includes(predicted.service_appears);
    observed.service_appears = {
      expected: predicted.service_appears,
      pre_present: pre.service_names.includes(predicted.service_appears),
      post_present: post.service_names.includes(predicted.service_appears),
      satisfied: appeared,
    };
    if (!appeared) {
      satisfied = false;
      notes.push(
        `service "${predicted.service_appears}" did not appear in post-snapshot (pre=${pre.service_names.length} svcs, post=${post.service_names.length} svcs)`
      );
    }
  }

  if (predicted.severity_bytes_increase_at_least) {
    const sev = predicted.severity_bytes_increase_at_least.severity;
    const required = predicted.severity_bytes_increase_at_least.bytes;
    const preBytes = pre.severity_split[sev] ?? 0;
    const postBytes = post.severity_split[sev] ?? 0;
    const delta = postBytes - preBytes;
    observed.severity_bytes_delta = {
      severity: sev,
      pre_bytes: preBytes,
      post_bytes: postBytes,
      delta,
      required,
      satisfied: delta >= required,
    };
    if (delta < required) {
      satisfied = false;
      notes.push(
        `${sev} bytes Δ ${delta.toFixed(0)} < required ${required} (pre=${preBytes.toFixed(0)}, post=${postBytes.toFixed(0)})`
      );
    }
  }

  if (predicted.top_patterns_added && predicted.top_patterns_added.length > 0) {
    const fuzzNorm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const preSet = new Set(pre.top_pattern_names.map(fuzzNorm));
    const postSet = new Set(post.top_pattern_names.map(fuzzNorm));
    const added: string[] = [];
    const missing: string[] = [];
    for (const wanted of predicted.top_patterns_added) {
      const n = fuzzNorm(wanted);
      const inPre = [...preSet].some((p) => p.includes(n) || n.includes(p));
      const inPost = [...postSet].some((p) => p.includes(n) || n.includes(p));
      if (!inPre && inPost) added.push(wanted);
      else missing.push(wanted);
    }
    observed.top_patterns_added = {
      expected: predicted.top_patterns_added,
      added,
      missing,
      satisfied: missing.length === 0,
    };
    if (missing.length > 0) {
      satisfied = false;
      notes.push(`top_patterns missing additions: ${missing.join(', ')}`);
    }
  }

  if (predicted.newly_emerged_contains) {
    // Heuristic: any post-only top pattern name containing the substring.
    const fuzzNorm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const needle = fuzzNorm(predicted.newly_emerged_contains);
    const preSet = new Set(pre.top_pattern_names.map(fuzzNorm));
    const postOnly = post.top_pattern_names
      .map(fuzzNorm)
      .filter((p) => !preSet.has(p));
    const hit = postOnly.some((p) => p.includes(needle));
    observed.newly_emerged_contains = {
      expected_substring: predicted.newly_emerged_contains,
      post_only_names: postOnly,
      satisfied: hit,
    };
    if (!hit) {
      satisfied = false;
      notes.push(
        `newly_emerged: no post-only top pattern contains "${predicted.newly_emerged_contains}"`
      );
    }
  }

  return { predicted_satisfied: satisfied, observed, notes };
}

/**
 * Compute the agent-layer verdict from the spec + transcript.
 */
export function computeAgentVerdict(
  spec: CounterfactualSpec,
  scenarioIdx: number,
  transcript: SavedTranscript
): CounterfactualVerdict['agent_layer'] {
  const predicted = spec.sensitive_scenarios[scenarioIdx].predicted_agent_behavior;
  const notes: string[] = [];
  const toolsCalled = extractToolChainFromBash(transcript.bashCommands);

  let satisfied = true;

  const mentionsFound: string[] = [];
  const mentionsMissing: string[] = [];
  if (predicted.must_mention_correlation && predicted.must_mention_correlation.length > 0) {
    const lower = transcript.finalText.toLowerCase();
    for (const phrase of predicted.must_mention_correlation) {
      if (lower.includes(phrase.toLowerCase())) mentionsFound.push(phrase);
      else mentionsMissing.push(phrase);
    }
    if (mentionsMissing.length > 0) {
      satisfied = false;
      notes.push(`synthesis missing: ${mentionsMissing.join(', ')}`);
    }
  }

  if (predicted.must_call_tool && predicted.must_call_tool.length > 0) {
    const calledSet = new Set(toolsCalled);
    // Special handling: `kubectl` isn't an MCP tool — it would show up
    // as a raw bash invocation. Check bashCommands.cmd for it.
    const cmdBlob = transcript.bashCommands.map((c) => c.cmd).join(' ');
    const missing: string[] = [];
    for (const t of predicted.must_call_tool) {
      if (t === 'kubectl') {
        if (!/\bkubectl\b/.test(cmdBlob)) missing.push(t);
      } else if (!calledSet.has(t)) {
        missing.push(t);
      }
    }
    if (missing.length > 0) {
      satisfied = false;
      notes.push(`agent did not call expected tool(s): ${missing.join(', ')}`);
    }
  }

  return {
    predicted_satisfied: satisfied,
    tools_called: toolsCalled,
    mentions_found: mentionsFound,
    mentions_missing: mentionsMissing,
    notes,
  };
}

/**
 * Score the synthesis layer via the existing campaign-scorer. Wraps
 * the verdict into the counterfactual shape.
 */
export async function computeSynthesisVerdict(
  transcript: SavedTranscript,
  heroSpec: CampaignHeroSpec,
  env: EvalEnv
): Promise<CounterfactualVerdict['synthesis_layer']> {
  const r = await scoreAgainstExpected({ transcript, spec: heroSpec, env });
  return {
    passed: r.verdict.passed,
    axes_summary: r.verdict.axes_summary,
  };
}

/**
 * Assemble the full counterfactual verdict from all three layers.
 */
export function assembleVerdict(args: {
  spec: CounterfactualSpec;
  scenarioIdx: number;
  runId: string;
  metricLayer: CounterfactualVerdict['metric_layer'];
  agentLayer: CounterfactualVerdict['agent_layer'];
  synthesisLayer: CounterfactualVerdict['synthesis_layer'];
}): CounterfactualVerdict {
  const { spec, scenarioIdx, runId, metricLayer, agentLayer, synthesisLayer } = args;
  const passed =
    metricLayer.predicted_satisfied &&
    agentLayer.predicted_satisfied &&
    synthesisLayer.passed;
  return {
    spec_id: spec.id,
    scenario_id: spec.sensitive_scenarios[scenarioIdx].scenario_id,
    run_id: runId,
    metric_layer: metricLayer,
    agent_layer: agentLayer,
    synthesis_layer: synthesisLayer,
    passed,
    emitted_at: new Date().toISOString(),
  };
}

export function renderVerdictMarkdown(v: CounterfactualVerdict): string {
  const lines: string[] = [];
  lines.push(`# Counterfactual verdict: ${v.spec_id} × ${v.scenario_id}`);
  lines.push('');
  lines.push(`- **Overall**: ${v.passed ? 'PASS' : 'FAIL'}`);
  lines.push(`- **run_id**: \`${v.run_id}\``);
  lines.push(`- **emitted_at**: ${v.emitted_at}`);
  lines.push('');
  lines.push('## Layer 1 — Metric');
  lines.push(`- predicted_satisfied: **${v.metric_layer.predicted_satisfied}**`);
  for (const n of v.metric_layer.notes) lines.push(`  - ${n}`);
  lines.push('```json');
  lines.push(JSON.stringify(v.metric_layer.observed, null, 2));
  lines.push('```');
  lines.push('## Layer 2 — Agent behavior');
  lines.push(`- predicted_satisfied: **${v.agent_layer.predicted_satisfied}**`);
  lines.push(`- tools_called: \`${v.agent_layer.tools_called.join(', ') || '(none)'}\``);
  if (v.agent_layer.mentions_found.length > 0) {
    lines.push(`- mentions_found: ${v.agent_layer.mentions_found.join(', ')}`);
  }
  if (v.agent_layer.mentions_missing.length > 0) {
    lines.push(`- mentions_missing: ${v.agent_layer.mentions_missing.join(', ')}`);
  }
  for (const n of v.agent_layer.notes) lines.push(`  - ${n}`);
  lines.push('## Layer 3 — Synthesis');
  lines.push(`- passed: **${v.synthesis_layer.passed}**`);
  lines.push(`- axes: \`${v.synthesis_layer.axes_summary}\``);
  return lines.join('\n') + '\n';
}
