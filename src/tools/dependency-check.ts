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

export const dependencyCheckSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
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

export async function executeDependencyCheck(args: DependencyCheckArgs): Promise<string> {
  const pattern = normalizePattern(args.pattern);
  const tokens = pattern.split('_').filter((t) => t.length > 0);

  const resolution = await resolveSiemSelection({
    explicit: args.vendor,
    restrictTo: DEP_CHECK_VENDORS,
  });

  if (resolution.kind === 'none') {
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
    return formatAmbiguousError(resolution.candidates, 'vendor');
  }

  const vendor = resolution.id;
  const wasExplicit = resolution.selectionMethod === 'explicit';

  // Try the in-process scan first. The vendor checker returns its own
  // `error` field when creds aren't actually present (which can happen
  // even after the resolver picked the vendor — e.g., Elasticsearch
  // creds satisfy the resolver but the dep-check needs Kibana too).
  const scan = await checkDeps(vendor, { pattern, tokens, service: args.service, severity: args.severity });
  if (!scan.error) {
    const detectedNote =
      !wasExplicit && resolution.note ? `\n_${resolution.note}_\n` : '';
    return detectedNote + renderDepCheckResult(scan);
  }

  // Fallback: emit the bash command. Surface why we fell back, so the
  // caller knows whether to set extra env vars (e.g., KIBANA_URL) or
  // accept that they'll run the script themselves.
  return renderBashFallback(vendor, scan.error, pattern, tokens, args, wasExplicit, resolution.note);
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
  lines.push(
    `⚠ NO SCAN HAS BEEN RUN. This tool did not query your SIEM. The command below is what the user must run locally in their own terminal against their own ${vc.label} credentials. Do not report "zero dependencies" or "safe to drop" based on this output — wait for the user to paste the script's results back.`
  );
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
