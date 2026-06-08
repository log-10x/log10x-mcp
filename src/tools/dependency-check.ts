/**
 * log10x_dependency_check — find SIEM dependencies on a pattern.
 *
 * Two execution paths:
 *
 *   1. **In-process scan** (preferred). When credentials for the resolved
 *      SIEM are present in the environment, this tool issues read-only
 *      API calls directly (Splunk REST, Datadog SDK, CloudWatch SDK,
 *      Kibana saved-objects) and returns counts + names + console URLs
 *      of matching dashboards / alerts / saved searches / monitors /
 *      metric filters. Fully read-only — no POST/PUT/DELETE.
 *
 *   2. **Paste-ready bash fallback**. When credentials are missing (or
 *      the in-process scan errors before producing results), the tool
 *      returns the original `curl + python3 siem-check-<vendor>.py`
 *      block so the user can run the scan themselves.
 *
 * Vendor selection:
 *   - When `vendor` is omitted, auto-detect via the same resolver
 *     `log10x_poc_from_siem_submit` uses. Single SIEM detected → use it.
 *     Multiple → return a structured "pick one" error listing the
 *     candidates. None → require an explicit vendor argument.
 *   - The dep-check tool covers 4 of 8 SIEMs in the registry: datadog,
 *     splunk, elasticsearch, cloudwatch. Auto-detection is restricted to
 *     that subset so a user with only ClickHouse/GCP/Azure creds gets a
 *     clear "no supported SIEM detected" message instead of being
 *     silently routed to a vendor we don't have a script for.
 */

import { z } from 'zod';
import { normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import {
  resolveSiemSelection,
  formatAmbiguousError,
} from '../lib/siem/resolve.js';
import {
  DEP_CHECK_VENDORS,
  checkDeps,
  renderDepCheckResult,
} from '../lib/siem/deps/index.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { newChassisTelemetry, recordQuery, buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { loadEnvironments } from '../lib/environments.js';
import { resolvePatternHashFromMetrics } from '../lib/resolve-pattern-hash.js';

export const dependencyCheckSchema = {
  pattern: z.string().min(1).describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  vendor: z
    .enum(['datadog', 'splunk', 'elasticsearch', 'cloudwatch'])
    .optional()
    .describe(
      'SIEM vendor to scan. Omit to auto-detect from ambient credentials (DD_API_KEY+DD_APP_KEY → datadog; SPLUNK_HOST+SPLUNK_TOKEN → splunk; ELASTIC_URL → elasticsearch; AWS chain → cloudwatch). When multiple SIEMs are configured, the tool returns an "ambiguous" error listing them — pass vendor= to disambiguate. When the resolved SIEM has live credentials the scan runs in-process and returns actual dashboard/alert/saved-search names + URLs; otherwise the tool falls back to a paste-ready bash command.'
    ),
  service: z.string().optional().describe('Service name to scope the scan'),
  severity: z.string().optional().describe('Severity level'),
};

const VENDOR_CONFIG: Record<
  string,
  { label: string; script: string; envSetup: string; envNote: string }
> = {
  datadog: {
    label: 'Datadog',
    script: 'siem-check-datadog.py',
    envSetup: 'export DD_API_KEY="<YOUR_API_KEY>"\nexport DD_APP_KEY="<YOUR_APP_KEY>"',
    envNote: 'Create an Application Key at: Organization Settings > Application Keys',
  },
  splunk: {
    label: 'Splunk',
    script: 'siem-check-splunk.py',
    envSetup:
      'export SPLUNK_URL="https://<YOUR_SPLUNK>:8089"\nexport SPLUNK_TOKEN="<YOUR_BEARER_TOKEN>"',
    envNote: 'Create a token at: Settings > Tokens (requires user role)',
  },
  elasticsearch: {
    label: 'Elasticsearch',
    script: 'siem-check-elasticsearch.py',
    envSetup: 'export ES_URL="https://<YOUR_ES>:9200"\nexport ES_API_KEY="<YOUR_API_KEY>"',
    envNote: 'Create an API key at: Stack Management > API Keys',
  },
  cloudwatch: {
    label: 'CloudWatch',
    script: 'siem-check-cloudwatch.py',
    envSetup:
      '# Uses standard AWS credentials (env vars, ~/.aws/credentials, or IAM role)\npip3 install boto3',
    envNote: 'Requires: logs:Describe*, cloudwatch:Describe*, cloudwatch:GetDashboard',
  },
};

export interface DependencyCheckArgs {
  pattern: string;
  vendor?: string;
  service?: string;
  severity?: string;
}

interface DependencyCheckSummary {
  pattern: string;
  vendor?: string;
  execution_mode: 'in_process' | 'paste_ready' | 'vendor_required' | 'ambiguous';
  scan_ran: boolean;
  dependencies: Array<{ kind: string; name: string; url?: string }>;
  safe_to_drop_recommendation: 'safe' | 'blocked' | 'unverifiable';
  human_summary: string;
  note?: string;
  /**
   * Pattern existence validation result. `checked=true` means a metrics-backend
   * query was issued; `exists` is null when not checked. When checked=true and
   * exists=false, a warning is prepended to the headline.
   */
  pattern_validation: {
    checked: boolean;
    exists: boolean | null;
    basis: 'metrics_backend' | 'not_checked';
  };
}

// Three sentences max, plain prose. No markdown syntax. Distilled from
// the structured data — what vendor was scanned, how many dependencies
// were found, whether the safety verdict can be trusted.
function buildHumanSummary(d: DependencyCheckSummary): string {
  if (d.execution_mode === 'vendor_required') {
    return `dependency_check could not run: no SIEM credentials detected and no vendor argument supplied. Pass vendor=<name> or set credentials for a supported SIEM (datadog, splunk, elasticsearch, cloudwatch). Recommendation is unverifiable until a scan runs.`;
  }
  if (d.execution_mode === 'ambiguous') {
    return `dependency_check could not run: multiple SIEMs configured and no vendor argument supplied. Pass vendor=<name> to disambiguate. Recommendation is unverifiable until a scan runs.`;
  }
  if (d.execution_mode === 'paste_ready') {
    return `dependency_check did not run in-process against ${d.vendor ?? 'the analyzer'} for \`${d.pattern}\`; a paste-ready scan command was returned instead. Recommendation is unverifiable until the user runs the command locally and reports back. Do not treat this as safe-to-drop.`;
  }
  const count = d.dependencies.length;
  const verdict = d.safe_to_drop_recommendation;
  return `Scanned ${d.vendor ?? 'analyzer'} for dependencies on \`${d.pattern}\` and found ${count} matching ${count === 1 ? 'dependency' : 'dependencies'}. Verdict: ${verdict}${verdict === 'blocked' ? ' — review the listed dashboards / alerts / saved searches before mute or drop.' : verdict === 'safe' ? ' — no dependencies blocking a mute or drop.' : '.'}`;
}

export async function executeDependencyCheck(args: DependencyCheckArgs): Promise<import('../lib/output-types.js').StructuredOutput> {
  const telemetry = newChassisTelemetry();

  // Defense-in-depth: reject empty / whitespace-only pattern before any
  // CloudWatch (or other vendor) scan. An empty needle matches every
  // alarm/dashboard and produces bogus 'blocked' verdicts.
  if (typeof args.pattern !== 'string' || args.pattern.trim().length === 0) {
    return buildChassisErrorEnvelope({
      tool: 'log10x_dependency_check',
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'pattern is required and must be non-empty',
      },
      telemetry,
      source_disclosure: {},
    });
  }

  // Pattern existence validation. Attempt a cheap metrics-backend probe when
  // an env is configured — does NOT block the tool on failure, only discloses.
  const patternValidation: DependencyCheckSummary['pattern_validation'] = {
    checked: false,
    exists: null,
    basis: 'not_checked',
  };
  try {
    const envs = await loadEnvironments();
    const env = envs.default ?? envs.lastUsed;
    if (env) {
      const canonicalPattern = normalizePattern(args.pattern);
      const hash = await resolvePatternHashFromMetrics(env, canonicalPattern);
      patternValidation.checked = true;
      patternValidation.exists = hash !== undefined;
      patternValidation.basis = 'metrics_backend';
      recordQuery(telemetry);
    }
  } catch {
    // Non-fatal — patternValidation stays at not_checked defaults.
  }

  const sumOut: { data?: DependencyCheckSummary } = {};
  await executeDependencyCheckInner(args, sumOut);
  if (!sumOut.data) {
    const hint = 'inner pass produced no structured data';
    return buildChassisErrorEnvelope({
      tool: 'log10x_dependency_check',
      err: { error_type: 'local_processing_failed', retryable: false, suggested_backoff_ms: null, hint },
      telemetry,
      source_disclosure: {},
    });
  }
  const d = sumOut.data;
  d.human_summary = buildHumanSummary(d);
  d.pattern_validation = patternValidation;
  const patternNotFoundWarning =
    patternValidation.checked && patternValidation.exists === false
      ? `Warning: pattern \`${d.pattern}\` not found in metrics backend. Continuing with dependency scan, but verify the name before applying any action. `
      : '';
  const headline = `${patternNotFoundWarning}\`${d.pattern}\`: ${d.dependencies.length} dependencies found in ${d.vendor ?? 'analyzer'} (recommendation: ${d.safe_to_drop_recommendation})`;

  // Build scan_scope for defect 34A: surface what was actually scanned.
  // cycle-4 depcheck-surfaces: report the surfaces THIS vendor's scanner
  // queries, not a fixed all-vendor union (e.g. CloudWatch has no
  // saved_searches/monitors; Datadog has no metric_filters).
  const VENDOR_SURFACES: Record<string, string[]> = {
    cloudwatch: ['dashboards', 'alarms', 'metric_filters'],
    datadog: ['dashboards', 'monitors'],
    splunk: ['dashboards', 'alerts', 'saved_searches'],
    elasticsearch: ['dashboards', 'alerts'],
  };
  const vendorSurfaces =
    (d.vendor && VENDOR_SURFACES[d.vendor]) ||
    ['dashboards', 'alerts', 'saved_searches', 'monitors', 'metric_filters'];
  const scan_scope = {
    surfaces_scanned: d.scan_ran ? vendorSurfaces : ([] as string[]),
    surfaces_skipped: d.scan_ran ? [] : vendorSurfaces,
    execution_mode: d.execution_mode,
    scan_ran: d.scan_ran,
    vendor: d.vendor,
  };

  return buildChassisEnvelope({
    tool: 'log10x_dependency_check',
    view: 'summary',
    headline,
    status: d.scan_ran ? 'success' : (d.execution_mode === 'vendor_required' || d.execution_mode === 'ambiguous' ? 'error' : 'partial'),
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: { siem_vendor: d.vendor },
    scope: {
      window: 'point_in_time',
      window_basis: 'auto_default',
      candidates_failed: d.scan_ran ? [] : [d.execution_mode],
    },
    payload: { ...d, scan_scope },
    human_summary: d.human_summary,
    ...((!d.scan_ran && (d.execution_mode === 'vendor_required' || d.execution_mode === 'ambiguous')) ? {
      error: {
        error_type: d.execution_mode === 'ambiguous' ? 'ambiguous_destination' as const : 'missing_destination' as const,
        retryable: false,
        suggested_backoff_ms: null,
        hint: d.note ?? `${d.execution_mode}: pass vendor= to disambiguate or set SIEM credentials`,
      },
    } : {}),
    telemetry,
  });
}

async function executeDependencyCheckInner(args: DependencyCheckArgs, sumOut?: { data?: DependencyCheckSummary }): Promise<string> {
  const pattern = normalizePattern(args.pattern);
  const tokens = pattern.split('_').filter((t) => t.length > 0);

  const resolution = await resolveSiemSelection({
    explicit: args.vendor,
    restrictTo: DEP_CHECK_VENDORS,
  });

  const defaultPatternValidation: DependencyCheckSummary['pattern_validation'] = {
    checked: false, exists: null, basis: 'not_checked',
  };
  if (resolution.kind === 'none') {
    if (sumOut) {
      sumOut.data = {
        pattern, execution_mode: 'vendor_required', scan_ran: false, dependencies: [],
        safe_to_drop_recommendation: 'unverifiable',
        human_summary: '',
        note: 'no SIEM credentials detected and no vendor arg supplied',
        pattern_validation: defaultPatternValidation,
      };
    }
    return [
      'Dependency Check — vendor required',
      '',
      `No SIEM credentials detected and no \`vendor\` arg supplied. Pass \`vendor=<name>\` (one of: ${DEP_CHECK_VENDORS.join(', ')}) to generate a paste-ready scan command, or set credentials for one of the supported SIEMs and re-run for an in-process scan.`,
      '',
      'Detection summary:',
      `  Probed ${resolution.probedIds.join(', ')}; none reported available credentials.`,
    ].join('\n');
  }

  if (resolution.kind === 'ambiguous') {
    if (sumOut) {
      sumOut.data = {
        pattern, execution_mode: 'ambiguous', scan_ran: false, dependencies: [],
        safe_to_drop_recommendation: 'unverifiable',
        human_summary: '',
        note: `multiple SIEMs configured: ${resolution.candidates.map((c) => c.id).join(', ')}`,
        pattern_validation: defaultPatternValidation,
      };
    }
    return formatAmbiguousError(resolution.candidates, 'vendor');
  }

  const vendor = resolution.id;
  const wasExplicit = resolution.selectionMethod === 'explicit';

  // Try the in-process scan first. The vendor checker returns its own
  // `error` field when creds aren't actually present (which can happen
  // even after the resolver picked the vendor — e.g., Elasticsearch
  // creds satisfy the resolver but the dep-check needs Kibana too).
  const scan = await checkDeps(vendor, { pattern, tokens, service: args.service, severity: args.severity });
  let result: string;
  let scanRan: boolean;
  if (!scan.error) {
    const detectedNote =
      !wasExplicit && resolution.note ? `\n_${resolution.note}_\n` : '';
    result = detectedNote + renderDepCheckResult(scan);
    scanRan = true;
  } else {
    // Fallback: emit the bash command. Surface why we fell back, so the
    // caller knows whether to set extra env vars (e.g., KIBANA_URL) or
    // accept that they'll run the script themselves.
    result = renderBashFallback(vendor, scan.error, pattern, tokens, args, wasExplicit, resolution.note);
    scanRan = false;
  }

  // Structured NEXT_ACTIONS for autonomous chain agents. After dependency
  // check, the canonical next steps are: generate a mute config (if no
  // critical dependencies surfaced) or look at the events (to confirm
  // what's being muted). When the scan didn't run (paste-mode fallback),
  // exclusion_filter is still suggested but with explicit acknowledgement
  // that no scan was performed — caller's responsibility to verify.
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_exclusion_filter',
      args: { pattern, vendor: args.vendor },
      reason: scanRan
        ? 'generate the drop / mute config after dependency review'
        : 'generate the drop / mute config (NOTE: dependency scan did NOT run, verify dashboards / alerts manually first)',
    },
    {
      tool: 'log10x_pattern_trend',
      args: { pattern },
      reason: 'see the pattern volume trend before deciding to mute',
    },
  ];
  const block = renderNextActions(nextActions);
  // Populate the typed summary the agent reads.
  if (sumOut) {
    const dependencies: DependencyCheckSummary['dependencies'] = scanRan && !scan.error
      ? (scan.matches ?? []).map(m => ({
          kind: m.type,
          name: m.name,
          url: m.url,
        }))
      : [];
    const recommendation: DependencyCheckSummary['safe_to_drop_recommendation'] = scanRan
      ? (dependencies.length === 0 ? 'safe' : 'blocked')
      : 'unverifiable';
    sumOut.data = {
      pattern,
      vendor,
      execution_mode: scanRan ? 'in_process' : 'paste_ready',
      scan_ran: scanRan,
      dependencies,
      safe_to_drop_recommendation: recommendation,
      human_summary: '',
      note: resolution.note,
      pattern_validation: defaultPatternValidation,
    };
  }
  return block ? `${result}\n\n${block}` : result;
}

function renderBashFallback(
  vendor: SiemId,
  whyFallback: string,
  pattern: string,
  tokens: string[],
  args: DependencyCheckArgs,
  wasExplicit: boolean,
  detectedNote: string | undefined
): string {
  const sev = (args.severity || '').toLowerCase();
  const svc = args.service || '';
  const vc = VENDOR_CONFIG[vendor];

  if (!vc) {
    return `Unknown vendor: ${vendor}. Supported: ${Object.keys(VENDOR_CONFIG).join(', ')}`;
  }

  const scriptArgs: string[] = [];
  if (svc) scriptArgs.push(`--service "${svc}"`);
  if (sev && sev !== 'uncl' && sev !== 'unclassified') scriptArgs.push(`--severity "${sev}"`);
  const kwTokens = tokens.filter((t) => t.length > 3).slice(0, 5);
  if (kwTokens.length > 0) scriptArgs.push(`--keywords "${kwTokens.join(',')}"`);

  const cmd = [
    `# 1. Set credentials`,
    vc.envSetup,
    ``,
    `# 2. Download and run`,
    `curl -sO https://dl.log10x.com/siem-check/${vc.script}`,
    `python3 ${vc.script} ${scriptArgs.join(' ')}`,
  ].join('\n');

  const lines: string[] = [];
  lines.push(`Dependency Check — ${vc.label} (paste-ready)`);
  lines.push('');
  if (!wasExplicit && detectedNote) lines.push(`_${detectedNote}_`);
  lines.push(
    `In-process scan unavailable (${whyFallback}). Falling back to a paste-ready bash command — runs locally, read-only, against your own credentials.`
  );
  lines.push('');
  // User-facing fact: the tool didn't run yet. Critical to surface so the
  // user understands the next step (run the command locally).
  lines.push(
    `> **No scan has been run yet.** This tool did not query your SIEM. The command below is what to run locally in your own terminal against your own ${vc.label} credentials.`
  );
  // Agent-only constraint: don't fabricate "zero dependencies" before the
  // user pastes results back.
  lines.push(agentOnly(
    `Constraint: do not report "zero dependencies" or "safe to drop" based on this output — wait for the user to paste the script's results back.` // verdict-lint-ok: anti-verdict constraint, instructs the agent AGAINST asserting safe-to-drop (the audit credited dependency_check for already modeling this)
  ));
  lines.push('');
  lines.push(
    `Check if any dashboards, alerts, or saved searches in your ${vc.label} depend on this pattern before dropping it.`
  );
  lines.push('');
  lines.push(`Note: ${vc.envNote}`);
  lines.push('');
  lines.push(cmd);
  lines.push('');
  lines.push('Runs locally — reads your SIEM config (read-only). No data sent to Log10x.');
  lines.push('Source: https://github.com/log-10x/siem-check');

  return lines.join('\n');
}
