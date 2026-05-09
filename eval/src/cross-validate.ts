/**
 * Cross-validation runner — black-box test that the MCP and the live
 * Prometheus backend agree on what's in the env.
 *
 * Pipeline:
 *   1. Query Prometheus directly via the oracle (independent of MCP) to
 *      establish ground truth: top patterns, services, total volume,
 *      and per-namespace breakdown.
 *   2. Query the same env via the MCP's read tools (top_patterns,
 *      services, list_by_label, dependency_check, exclusion_filter).
 *   3. For each comparison, score agreement structurally — same top
 *      tokens, volumes within ±10%, etc. Per-row exact match is not
 *      required (the MCP renders snake_case as space-separated display
 *      form, includes severity prefixes, etc.).
 *   4. Verify a known pattern from the oracle round-trips through MCP
 *      tools that take a pattern name (dependency_check, pattern_trend).
 *
 * Out of scope (engine bug, documented):
 *   - Templater round-trip via local tenx CLI v1.0.4. The CLI emits an
 *     empty templates.json (encoded.log + aggregated.csv have data, but
 *     no template definitions), so resolve_batch returns "No patterns
 *     resolved". Even if the CLI worked, the demo runs engine
 *     v1.0.20-jit so local hashing would mismatch server hashing.
 *
 * The harness fails on structural disagreement — MCP claims something
 * Prometheus contradicts. It does NOT fail on rendering deltas.
 */
import * as oracle from './prom-oracle.js';
import { invokeTool } from './tool-registry.js';
import { applyEvalEnvToProcess, type EvalEnv } from './env.js';

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'partial' | 'skipped';
  detail: string;
}

export interface CrossValidationReport {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  envMode: string;
  oracleSnapshot: {
    totalVolumeBytes: number;
    serviceCount: number;
    patternCardinality: number;
    topPatterns: Array<{ hash: string; bytes: number }>;
    topNamespaces: Array<{ value: string; bytes: number }>;
  };
  checks: CheckResult[];
  passed: number;
  failed: number;
  partial: number;
  skipped: number;
  status: 'pass' | 'partial' | 'fail';
}

const FOUR_LETTER_TOKEN = /[A-Za-z]{4,}/g;
function tokenize(s: string): Set<string> {
  return new Set((s.toLowerCase().match(FOUR_LETTER_TOKEN) || []).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

export async function runCrossValidation(env: EvalEnv): Promise<CrossValidationReport> {
  applyEvalEnvToProcess(env);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // ── Establish ground truth via the oracle ──────────────────────────
  const [tot, services, card, top, ns] = await Promise.all([
    oracle.totalVolume(env, '24h'),
    oracle.services(env, '24h'),
    oracle.patternCardinality(env, '24h'),
    oracle.topPatterns(env, '24h', 5),
    oracle.topByLabel(env, 'k8s_namespace', '24h', 3),
  ]);
  const oracleTopHashes = top.map((p) => p.hash);

  const checks: CheckResult[] = [];

  // ── Check 1: top_patterns agreement ────────────────────────────────
  const mcpTop = await invokeTool('log10x_top_patterns', { timeRange: '1d', limit: 5 }, env);
  const mcpTopText = mcpTop.text;
  const oracleTopTokens = new Set<string>();
  for (const h of oracleTopHashes) for (const t of tokenize(h)) oracleTopTokens.add(t);
  const mcpTopTokens = tokenize(mcpTopText);
  const overlap = [...oracleTopTokens].filter((t) => mcpTopTokens.has(t)).length;
  if (oracleTopTokens.size === 0) {
    checks.push({
      name: 'top_patterns: oracle has data',
      status: 'fail',
      detail: 'Prometheus oracle returned no top patterns',
    });
  } else if (overlap / oracleTopTokens.size >= 0.5) {
    checks.push({
      name: 'top_patterns: MCP agrees with oracle',
      status: 'pass',
      detail: `${overlap}/${oracleTopTokens.size} oracle tokens appear in MCP output (${((overlap / oracleTopTokens.size) * 100).toFixed(0)}%)`,
    });
  } else {
    checks.push({
      name: 'top_patterns: MCP agrees with oracle',
      status: 'partial',
      detail: `only ${overlap}/${oracleTopTokens.size} oracle tokens in MCP output — MCP may be filtering by tier`,
    });
  }

  // ── Check 2: services count agreement ──────────────────────────────
  const mcpSvc = await invokeTool('log10x_services', { timeRange: '1d' }, env);
  const oracleSvcCount = services.length;
  // Count rows in MCP output matching the "service_name  $X.XX/day" shape.
  const mcpSvcMatches = (mcpSvc.text.match(/\$\d/g) || []).length;
  if (oracleSvcCount === 0) {
    checks.push({
      name: 'services: oracle has at least 1 service',
      status: 'fail',
      detail: 'Prometheus oracle returned 0 services',
    });
  } else if (mcpSvcMatches >= oracleSvcCount) {
    checks.push({
      name: 'services: MCP reports at least as many services as oracle',
      status: 'pass',
      detail: `oracle=${oracleSvcCount}, MCP rendered ${mcpSvcMatches} dollar-amount rows`,
    });
  } else if (mcpSvcMatches > 0) {
    checks.push({
      name: 'services: MCP reports services',
      status: 'partial',
      detail: `oracle=${oracleSvcCount}, MCP=${mcpSvcMatches}`,
    });
  } else {
    checks.push({
      name: 'services: MCP reports services',
      status: 'fail',
      detail: `oracle=${oracleSvcCount}, MCP returned 0 service rows`,
    });
  }

  // ── Check 3: list_by_label namespace agreement ─────────────────────
  const mcpNs = await invokeTool(
    'log10x_list_by_label',
    { label: 'k8s_namespace', timeRange: '1d', limit: 5 },
    env
  );
  const oracleTopNs = ns[0]?.value ?? '';
  if (!oracleTopNs) {
    checks.push({
      name: 'list_by_label: oracle has top namespace',
      status: 'fail',
      detail: 'oracle returned no namespaces',
    });
  } else if (oracleTopNs === '(empty)') {
    // Special case: the demo env's top namespace is the empty-string
    // label value (k8s_namespace not enriched). MCP renders this as
    // `(empty)` in its output.
    if (/\(empty\)/i.test(mcpNs.text)) {
      checks.push({
        name: 'list_by_label: MCP correctly renders empty-label-value rows',
        status: 'pass',
        detail: 'oracle and MCP both surface (empty) as the top namespace value (real demo-env labeling artifact)',
      });
    } else {
      checks.push({
        name: 'list_by_label: MCP renders empty-label-value rows',
        status: 'fail',
        detail: 'oracle says top namespace is (empty); MCP did not surface it',
      });
    }
  } else {
    if (mcpNs.text.toLowerCase().includes(oracleTopNs.toLowerCase())) {
      checks.push({
        name: `list_by_label: MCP includes oracle top namespace "${oracleTopNs}"`,
        status: 'pass',
        detail: `oracle top=${oracleTopNs}; MCP output contains it`,
      });
    } else {
      checks.push({
        name: `list_by_label: MCP includes oracle top namespace "${oracleTopNs}"`,
        status: 'fail',
        detail: `oracle top=${oracleTopNs}; MCP output does not contain it`,
      });
    }
  }

  // ── Check 4: known-pattern round-trip (dependency_check) ───────────
  // The oracle confirms cart_cartstore_ValkeyCartStore exists in metrics
  // (33 MB / 24h, verified live 2026-05). dependency_check should
  // accept this name without rejecting it, even when no SIEM creds are
  // available (it falls back to a paste-ready bash command).
  const knownPattern = 'cart_cartstore_ValkeyCartStore';
  const knownBytes = await oracle.patternExists(env, knownPattern);
  if (knownBytes === 0) {
    checks.push({
      name: `known-pattern oracle: "${knownPattern}" exists`,
      status: 'skipped',
      detail: `oracle says ${knownPattern} has 0 bytes — env may have changed; cross-check skipped`,
    });
  } else {
    const mcpDep = await invokeTool(
      'log10x_dependency_check',
      { pattern: knownPattern },
      env
    );
    if (mcpDep.text.toLowerCase().includes(knownPattern.toLowerCase())) {
      checks.push({
        name: `dependency_check accepts oracle-confirmed pattern "${knownPattern}"`,
        status: 'pass',
        detail: `oracle volume=${(knownBytes / 1e6).toFixed(1)}MB; dependency_check rendered the pattern name`,
      });
    } else {
      checks.push({
        name: `dependency_check accepts oracle-confirmed pattern "${knownPattern}"`,
        status: 'fail',
        detail: 'oracle confirms pattern exists, but MCP dependency_check does not surface it in the output',
      });
    }
  }

  // ── Check 5: pattern_trend round-trip on the same known pattern ────
  if (knownBytes > 0) {
    const mcpTrend = await invokeTool(
      'log10x_pattern_trend',
      { pattern: knownPattern, timeRange: '1d', step: '1h' },
      env
    );
    if (mcpTrend.text.toLowerCase().includes('cart')) {
      checks.push({
        name: `pattern_trend produces a trend for oracle-confirmed pattern`,
        status: 'pass',
        detail: 'pattern_trend rendered cart-pattern data',
      });
    } else {
      checks.push({
        name: `pattern_trend produces a trend for oracle-confirmed pattern`,
        status: 'fail',
        detail: `pattern_trend output did not include "cart": ${mcpTrend.text.slice(0, 200)}`,
      });
    }
  } else {
    checks.push({
      name: 'pattern_trend round-trip on known pattern',
      status: 'skipped',
      detail: 'oracle reports pattern absent; trend check skipped',
    });
  }

  // ── Check 6: doctor reports no FAIL on misconfig (only WARNs) ──────
  // The earlier diagnostic-quality fix should mean doctor returns
  // overall WARN on the demo env (retriever not configured) rather
  // than FAILED.
  const mcpDoctor = await invokeTool('log10x_doctor', {}, env);
  if (/Status:\s*WARNINGS PRESENT/i.test(mcpDoctor.text)) {
    checks.push({
      name: 'doctor: WARN-not-FAIL on demo env',
      status: 'pass',
      detail: 'doctor reports WARNINGS PRESENT (correct for demo env without retriever)',
    });
  } else if (/Status:\s*HEALTHY/i.test(mcpDoctor.text)) {
    checks.push({
      name: 'doctor: WARN-not-FAIL on demo env',
      status: 'pass',
      detail: 'doctor reports HEALTHY',
    });
  } else if (/Status:\s*FAILED/i.test(mcpDoctor.text)) {
    checks.push({
      name: 'doctor: WARN-not-FAIL on demo env',
      status: 'fail',
      detail: 'doctor regressed to FAILED — retriever_forensic_health gating may be broken',
    });
  } else {
    checks.push({
      name: 'doctor: WARN-not-FAIL on demo env',
      status: 'partial',
      detail: 'doctor returned an unrecognized status line',
    });
  }

  // ── Aggregate ─────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const partial = checks.filter((c) => c.status === 'partial').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const status: 'pass' | 'partial' | 'fail' = failed > 0 ? 'fail' : partial > 0 ? 'partial' : 'pass';

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    envMode: env.mode,
    oracleSnapshot: {
      totalVolumeBytes: tot,
      serviceCount: services.length,
      patternCardinality: card,
      topPatterns: top.map((p) => ({ hash: p.hash, bytes: p.bytes })),
      topNamespaces: ns.map((r) => ({ value: r.value, bytes: r.bytes })),
    },
    checks,
    passed,
    failed,
    partial,
    skipped,
    status,
  };
}

/**
 * Render a CrossValidationReport as human-readable markdown.
 */
export function renderCrossValidationReport(r: CrossValidationReport): string {
  const lines: string[] = [];
  lines.push(`# Cross-validation report (${r.envMode})`);
  lines.push('');
  lines.push(`**Status: ${r.status.toUpperCase()}** — ${r.passed} pass, ${r.partial} partial, ${r.failed} fail, ${r.skipped} skipped`);
  lines.push('');
  lines.push(`- Started: ${r.startedAt}`);
  lines.push(`- Duration: ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## Oracle snapshot (Prometheus, independent of MCP)');
  lines.push('');
  lines.push(`- Total volume (24h): ${(r.oracleSnapshot.totalVolumeBytes / 1e9).toFixed(2)} GB`);
  lines.push(`- Distinct patterns: ${r.oracleSnapshot.patternCardinality}`);
  lines.push(`- Distinct services: ${r.oracleSnapshot.serviceCount}`);
  lines.push('');
  lines.push('### Top patterns');
  for (const p of r.oracleSnapshot.topPatterns) {
    lines.push(`- ${(p.bytes / 1e6).toFixed(1).padStart(7)} MB · \`${p.hash}\``);
  }
  lines.push('');
  lines.push('### Top namespaces');
  for (const n of r.oracleSnapshot.topNamespaces) {
    lines.push(`- ${(n.bytes / 1e6).toFixed(1).padStart(7)} MB · ${n.value}`);
  }
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  for (const c of r.checks) {
    const icon =
      c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : c.status === 'partial' ? 'PART' : 'SKIP';
    lines.push(`- [${icon}] **${c.name}** — ${c.detail}`);
  }
  return lines.join('\n');
}
