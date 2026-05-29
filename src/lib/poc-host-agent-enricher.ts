/**
 * Host-agent enrichment for the POC v2 envelope.
 *
 * After the engine produces measured findings (per-pattern $/mo,
 * growth, incident clusters, action recommendations), this module
 * asks the MCP host's LLM to contribute operational context the
 * engine cannot see:
 *
 *   1. Causal hypothesis — was there a deploy/config change that
 *      explains a GROWING or NEW pattern?
 *   2. Dependency safety — are there alerts/dashboards/queries that
 *      reference a pattern we recommend muting (would the mute
 *      silence something important)?
 *   3. Code-level root-cause refinement — given the engine's
 *      `bug_hypothesis`, what's the specific code change the agent
 *      can suggest using its access to source / docs?
 *   4. Prioritization — given the customer's context, which of the
 *      top-N findings should ship this sprint vs. backlog?
 *
 * The host agent has tools we don't (kubectl, source code, helm,
 * Grafana, PagerDuty, the customer's other MCPs). We have data it
 * doesn't (14d measured patterns, deterministic fingerprints, real
 * costs). Together the report is richer than either alone.
 *
 * Honest constraints:
 *   - Token budget capped per session (default 8k output tokens)
 *   - Graceful no-op when host doesn't advertise the `sampling`
 *     capability — common for cron / headless / non-Claude hosts
 *   - Single round-trip with a structured-JSON prompt; if parsing
 *     fails we attach the raw text as `raw_response` and move on
 *   - Auditable: every contribution carries a `tools_inspected` list
 *     so the customer sees what the agent says it looked at
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PocEnvelopeV2, PatternOutput } from './poc-envelope-v2.js';

export interface AgentContribution {
  /**
   * Which loop produced this contribution. Multiple loops may apply
   * to the same pattern (e.g., a GROWING pattern flagged for `mute`
   * gets both `operational_context` and `dependency_safety`).
   */
  loop: 'operational_context' | 'dependency_safety' | 'code_fix_refinement' | 'prioritization';
  /** Top-N pattern indices this contribution applies to. */
  target_pattern_indices: number[];
  /**
   * What the agent says it inspected: ['kubectl_events', 'grafana_dashboards',
   * 'source_code', 'helm_release', 'pagerduty_rules', etc.]. Surfaces the
   * audit trail to the customer — if the agent claims to have checked
   * something, the customer can verify.
   */
  tools_inspected: string[];
  /**
   * 1-3 sentence findings from the agent. Quoted verbatim by the
   * customer's report writer.
   */
  findings: string[];
  /** `high` / `medium` / `low` — how strongly the agent stands behind the contribution. */
  confidence: 'high' | 'medium' | 'low';
  /**
   * Free-form raw response when structured parsing failed. Lets the
   * customer's agent recover the content even when the JSON contract
   * didn't survive.
   */
  raw_response?: string;
}

export interface AgentEnrichmentResult {
  contributions: AgentContribution[];
  metadata: {
    host_capability: 'sampling_supported' | 'sampling_unsupported' | 'host_unavailable';
    tokens_spent: number;
    calls_attempted: number;
    calls_succeeded: number;
    skipped_reason?: string;
  };
}

export interface EnrichOptions {
  /** MCP server instance. Sampling is server-side; without it we no-op. */
  server?: McpServer;
  /** Per-session output token cap. Default 8000. */
  maxTokensTotal?: number;
  /** Per-call timeout. Default 60s — agent enrichment may inspect external tools. */
  timeoutMs?: number;
  /**
   * Cap on top-N patterns considered for enrichment. Default 10 —
   * agent attention is finite; the head of the cost distribution is
   * what matters anyway.
   */
  topN?: number;
}

/**
 * Run the enrichment loops against the v2 envelope. Returns an
 * AgentEnrichmentResult that the caller attaches to the envelope's
 * `output.agent_enrichment` field. Never throws — failures degrade
 * to empty contributions with an `errorNote`-equivalent metadata field.
 */
export async function enrichWithHostAgent(
  envelope: PocEnvelopeV2,
  opts: EnrichOptions = {},
): Promise<AgentEnrichmentResult> {
  const result: AgentEnrichmentResult = {
    contributions: [],
    metadata: {
      host_capability: 'host_unavailable',
      tokens_spent: 0,
      calls_attempted: 0,
      calls_succeeded: 0,
    },
  };

  if (!opts.server) {
    result.metadata.skipped_reason = 'mcp_server_handle_not_available';
    return result;
  }

  const clientCaps = opts.server.server.getClientCapabilities?.();
  if (clientCaps && !clientCaps.sampling) {
    result.metadata.host_capability = 'sampling_unsupported';
    result.metadata.skipped_reason = 'host_does_not_advertise_sampling';
    return result;
  }
  result.metadata.host_capability = 'sampling_supported';

  const maxTokensTotal = opts.maxTokensTotal ?? 8000;
  const topN = Math.min(opts.topN ?? 10, envelope.output.patterns.length);
  const patternsForEnrichment = envelope.output.patterns.slice(0, topN);

  // Single consolidated call instead of one per loop. Lower latency,
  // lower token cost, and the host LLM can reason across all findings
  // at once instead of treating them in isolation.
  const prompt = buildConsolidatedEnrichmentPrompt(envelope, patternsForEnrichment);
  result.metadata.calls_attempted = 1;

  try {
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), opts.timeoutMs ?? 60_000);
    const res = await opts.server.server.createMessage(
      {
        messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
        maxTokens: maxTokensTotal,
        modelPreferences: {
          hints: [{ name: 'claude-sonnet' }, { name: 'sonnet' }],
          speedPriority: 0.3,
          intelligencePriority: 0.7,
        },
        systemPrompt:
          'You contribute operational context that the engine analysis cannot see: kubectl events, ' +
          'source code, helm releases, dashboards, alert rules. Reply with structured JSON matching the ' +
          'schema in the prompt. Be honest about what you actually inspected vs. inferred. List the tools ' +
          'you used in tools_inspected so the customer can verify.',
      },
      { signal: abort.signal },
    );
    clearTimeout(t);
    const text = res.content?.type === 'text' ? res.content.text : '';
    // Approximate output tokens — close enough for budget bookkeeping.
    result.metadata.tokens_spent = Math.ceil(text.length / 4);
    result.metadata.calls_succeeded = 1;

    const parsed = parseEnrichmentResponse(text);
    if (parsed.contributions.length > 0) {
      result.contributions = parsed.contributions;
    } else {
      // Structured parse failed — preserve the agent's text for the
      // downstream report writer to quote.
      result.contributions = [
        {
          loop: 'operational_context',
          target_pattern_indices: patternsForEnrichment.map((_, i) => i),
          tools_inspected: [],
          findings: [],
          confidence: 'low',
          raw_response: text.slice(0, 2000),
        },
      ];
    }
  } catch (e) {
    result.metadata.skipped_reason = `enrichment_call_failed: ${(e as Error).message.slice(0, 200)}`;
  }

  return result;
}

/**
 * Exposed for testing / dry-runs. The standalone POC runner uses this
 * to print the per-finding errand prompt for a real envelope without
 * actually round-tripping to an MCP host.
 */
export function _buildEnrichmentPromptForTest(
  envelope: PocEnvelopeV2,
  patterns: PatternOutput[],
): string {
  return buildConsolidatedEnrichmentPrompt(envelope, patterns);
}

function buildConsolidatedEnrichmentPrompt(
  envelope: PocEnvelopeV2,
  patterns: PatternOutput[],
): string {
  const findings = patterns.map((p, i) => ({
    index: i,
    identity: p.identity,
    service: p.service,
    severity: p.severity,
    cost_per_month_usd: p.metrics.cost_per_month_usd,
    events_in_window: p.metrics.events_in_window,
    emergence: p.emergence.category,
    acceleration_ratio: p.emergence.acceleration_ratio,
    first_seen_iso: p.emergence.first_seen_iso,
    top_slot: p.top_slot
      ? { name: p.top_slot.name, distinct_count: p.top_slot.distinct_count, unbounded: p.top_slot.unbounded }
      : null,
    actions: {
      code_fix_applicable: p.actions.code_fix.applicable,
      code_fix_hypothesis: p.actions.code_fix.bug_hypothesis,
      forwarder_exclusion_applicable: p.actions.forwarder_exclusion.applicable,
      regulate_cap_applicable: p.actions.regulate_cap.applicable,
      regulate_cap_expected_drop_pct: p.actions.regulate_cap.expected_drop_pct,
      regulate_cap_rationale: p.actions.regulate_cap.rationale,
    },
  }));

  // Per-finding errand instructions are computed from the engine's
  // recommendation. The agent should follow these — they say
  // exactly which tool to invoke and what to look for. Generic
  // "use whatever tools you have" produces generic findings.
  const errands = patterns
    .map((p, i) => errandsForFinding(p, i))
    .filter((e) => e.steps.length > 0);

  return [
    `# Engine POC findings — please contribute operational context`,
    ``,
    `## What the engine measured (you cannot reproduce this)`,
    ``,
    `- SIEM: ${envelope.input.siem}`,
    `- Window: ${envelope.input.window.start_iso} to ${envelope.input.window.end_iso} (${(envelope.input.window.duration_seconds / 86400).toFixed(1)} days)`,
    `- Events analyzed: ${envelope.input.scale.events_pulled.toLocaleString()}`,
    `- Bytes analyzed: ${(envelope.input.scale.bytes_pulled / 1024 ** 3).toFixed(3)} GB`,
    `- Distinct patterns surfaced: ${envelope.input.scale.distinct_patterns_surfaced.toLocaleString()}`,
    `- Methodology: deterministic engine fingerprints over the full window`,
    `- Monthly cost projection: $${envelope.output.aggregates.totals.monthly_cost_usd.toFixed(2)}`,
    ``,
    `## Your job: run errands that produce facts the engine cannot see`,
    ``,
    `You have tools the engine doesn't: kubectl, source code, helm release history,`,
    `Grafana dashboards, alert rules, PagerDuty rotations, the customer's other MCPs.`,
    `The engine has data you don't: deterministic pattern fingerprints, full-window`,
    `cost measurements, emergence classification across 14 days.`,
    ``,
    `For each finding the engine surfaced, follow the per-finding errand below. Each`,
    `errand specifies exactly which tool to use and what fact to extract. If a tool`,
    `is unavailable in your environment, skip it and lower confidence — DO NOT`,
    `fabricate. The audit trail (\`tools_inspected\`) is the customer's verification.`,
    ``,
    `## Findings (top ${patterns.length}, by monthly cost)`,
    ``,
    '```json',
    JSON.stringify(findings, null, 2),
    '```',
    ``,
    `## Per-finding errands`,
    ``,
    errands.map((e) => formatErrand(e)).join('\n\n'),
    ``,
    `## Output schema (respond with valid JSON in this exact shape)`,
    ``,
    '```json',
    `{`,
    `  "contributions": [`,
    `    {`,
    `      "loop": "operational_context" | "dependency_safety" | "code_fix_refinement" | "prioritization",`,
    `      "target_pattern_indices": [0, 1, ...],`,
    `      "tools_inspected": ["kubectl_events", "grafana_dashboards", "source_code", "helm_history", ...],`,
    `      "findings": ["1-3 sentence finding strings, quoting the tool output verbatim where possible"],`,
    `      "confidence": "high" | "medium" | "low"`,
    `    }`,
    `  ]`,
    `}`,
    '```',
    ``,
    `Confidence rubric:`,
    `  - **high**: you ran the suggested tool and got an unambiguous result quoted in findings`,
    `  - **medium**: you ran the tool but the result was ambiguous, or inferred from related signal`,
    `  - **low**: tool unavailable, you guessed, OR you didn't actually look — be honest`,
    ``,
    `Respond now with only the JSON object, no other prose.`,
  ].join('\n');
}

interface FindingErrand {
  index: number;
  identity: string;
  steps: string[];
}

/**
 * Produce per-finding errand instructions keyed off the engine's
 * recommendation. Each step is a concrete tool invocation the agent
 * should attempt, not a vague "use your tools" hint. This is the
 * core of the "errands" framing: the engine's measured facts gate
 * which tools the agent should reach for.
 */
function errandsForFinding(p: PatternOutput, index: number): FindingErrand {
  const steps: string[] = [];
  const svc = p.service ?? '(unknown service)';

  // 1) Emergence -> kubectl events around first_seen_iso. This is
  // the highest-leverage errand: a deploy correlation collapses
  // the agent's investigation surface from "all causes" to "what
  // changed at T-30m before first_seen".
  if (p.emergence.category === 'new' || p.emergence.category === 'recent_burst') {
    const firstSeen = p.emergence.first_seen_iso ?? '(unknown)';
    steps.push(
      `**operational_context** — first_seen=${firstSeen} (emergence=${p.emergence.category}). ` +
        `Run \`kubectl get events --field-selector involvedObject.kind=Deployment -A --sort-by='.lastTimestamp'\` ` +
        `and look for a deploy / rollout / restart of ${svc} within 30 minutes BEFORE ${firstSeen}. ` +
        `If found, quote the event reason and the involved object name.`,
    );
  }
  if (p.emergence.category === 'growing' && p.emergence.acceleration_ratio && p.emergence.acceleration_ratio > 1.5) {
    steps.push(
      `**operational_context** — acceleration=${p.emergence.acceleration_ratio.toFixed(2)}x. ` +
        `Run \`helm history ${svc} -n <namespace>\` to find recent upgrades. Quote the chart version and revision date.`,
    );
  }

  // 2) regulate_cap dropping ~all volume -> dependency safety check.
  // If we mute a pattern that drives an alert or dashboard panel,
  // we silence the customer's operations. Catch this before the
  // recommendation lands.
  if (p.actions.regulate_cap.applicable && p.actions.regulate_cap.expected_drop_pct >= 0.95) {
    steps.push(
      `**dependency_safety** — engine recommends a cap that drops ${(p.actions.regulate_cap.expected_drop_pct * 100).toFixed(0)}% of this pattern's volume ($${p.metrics.cost_per_month_usd.toFixed(2)}/mo savings). ` +
        `Before applying, grep the customer's Grafana JSON / Splunk saved searches / Datadog monitors / ` +
        `PagerDuty alert rules for the pattern identity \`${p.identity.slice(0, 60)}\` or a meaningful substring. ` +
        `If ANY reference exists, downgrade the recommendation to \`forwarder_exclusion\` and flag the conflict.`,
    );
  }

  // 3) code_fix.applicable=true -> source code lookup. The
  // engine gives a hypothesis ("missing retry / unbounded
  // logging in tight loop"); the agent translates it into a
  // concrete code change.
  if (p.actions.code_fix.applicable && p.actions.code_fix.bug_hypothesis) {
    steps.push(
      `**code_fix_refinement** — engine hypothesis: "${p.actions.code_fix.bug_hypothesis}". ` +
        `Search the ${svc} source for a log statement matching \`${p.identity.slice(0, 50)}\`. ` +
        `Quote the file:line, the function name, and propose a specific 1-3 line change (rate-limit, ` +
        `dedupe, add backoff, fix the underlying error). If you can't locate the source, say so explicitly.`,
    );
  }

  // 4) top_slot=unbounded -> potential UUID/timestamp in body.
  // The slot field name tells the agent WHICH log statement to
  // look for.
  if (p.top_slot && p.top_slot.unbounded && p.top_slot.distinct_count > 100) {
    steps.push(
      `**code_fix_refinement** — slot \`${p.top_slot.name}\` is unbounded (${p.top_slot.distinct_count} distinct values across ${p.metrics.events_in_window} events). ` +
        `This is a high-cardinality variable embedded in the log body. Find the source line and either ` +
        `pull the variable into a structured field, drop it, or sample it. Quote file:line.`,
    );
  }

  return { index, identity: p.identity, steps };
}

function formatErrand(e: FindingErrand): string {
  return [
    `### Finding #${e.index} — \`${e.identity.slice(0, 80)}\``,
    ...e.steps.map((s) => `- ${s}`),
  ].join('\n');
}

function parseEnrichmentResponse(text: string): { contributions: AgentContribution[] } {
  // Strip code fences if the model wrapped the JSON.
  const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return { contributions: [] };
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (!Array.isArray(parsed.contributions)) return { contributions: [] };
    const contributions: AgentContribution[] = [];
    for (const c of parsed.contributions) {
      if (!c || typeof c !== 'object') continue;
      const loop = c.loop;
      if (!['operational_context', 'dependency_safety', 'code_fix_refinement', 'prioritization'].includes(loop)) continue;
      const target = Array.isArray(c.target_pattern_indices)
        ? c.target_pattern_indices.filter((n: unknown) => typeof n === 'number')
        : [];
      const tools = Array.isArray(c.tools_inspected) ? c.tools_inspected.filter((s: unknown) => typeof s === 'string') : [];
      const findings = Array.isArray(c.findings) ? c.findings.filter((s: unknown) => typeof s === 'string') : [];
      const confidence = ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'low';
      contributions.push({ loop, target_pattern_indices: target, tools_inspected: tools, findings, confidence });
    }
    return { contributions };
  } catch {
    return { contributions: [] };
  }
}
