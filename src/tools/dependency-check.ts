/**
 * log10x_dependency_check — generate a SIEM dependency scan command.
 *
 * Returns a bash command that downloads and runs a Python script to check
 * if dashboards, alerts, or saved searches in the user's SIEM reference
 * a given pattern. The command runs locally, read-only. No data sent to Log10x.
 *
 * Ported from GettingStarted.jsx depcheck section.
 */

import { z } from 'zod';
import { normalizePattern } from '../lib/format.js';

export const dependencyCheckSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  vendor: z.enum(['datadog', 'splunk', 'elasticsearch', 'cloudwatch']).describe('SIEM vendor to scan'),
  service: z.string().optional().describe('Service name to scope the scan'),
  severity: z.string().optional().describe('Severity level'),
};

const VENDOR_CONFIG: Record<string, {
  label: string;
  script: string;
  envSetup: string;
  envNote: string;
}> = {
  datadog: {
    label: 'Datadog',
    script: 'siem-check-datadog.py',
    envSetup: 'export DD_API_KEY="<YOUR_API_KEY>"\nexport DD_APP_KEY="<YOUR_APP_KEY>"',
    envNote: 'Create an Application Key at: Organization Settings > Application Keys',
  },
  splunk: {
    label: 'Splunk',
    script: 'siem-check-splunk.py',
    envSetup: 'export SPLUNK_URL="https://<YOUR_SPLUNK>:8089"\nexport SPLUNK_TOKEN="<YOUR_BEARER_TOKEN>"',
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
    envSetup: '# Uses standard AWS credentials (env vars, ~/.aws/credentials, or IAM role)\npip3 install boto3',
    envNote: 'Requires: logs:Describe*, cloudwatch:Describe*, cloudwatch:GetDashboard',
  },
};

export function executeDependencyCheck(args: {
  pattern: string;
  vendor: string;
  service?: string;
  severity?: string;
}): string {
  const pattern = normalizePattern(args.pattern);
  const tokens = pattern.split('_').filter(t => t.length > 0);
  const sev = (args.severity || '').toLowerCase();
  const svc = args.service || '';
  const vc = VENDOR_CONFIG[args.vendor];

  if (!vc) return `Unknown vendor: ${args.vendor}. Supported: ${Object.keys(VENDOR_CONFIG).join(', ')}`;

  // Build script arguments
  const scriptArgs: string[] = [];
  if (svc) scriptArgs.push(`--service "${svc}"`);
  if (sev && sev !== 'uncl' && sev !== 'unclassified') scriptArgs.push(`--severity "${sev}"`);
  const kwTokens = tokens.filter(t => t.length > 3).slice(0, 5);
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
  lines.push(`Dependency Check — ${vc.label}`);
  lines.push('');
  lines.push(`Check if any dashboards, alerts, or saved searches in your ${vc.label} depend on this pattern before dropping it.`);
  lines.push('');
  lines.push(`Note: ${vc.envNote}`);
  lines.push('');
  lines.push(cmd);
  lines.push('');
  lines.push('Runs locally — reads your SIEM config (read-only). No data sent to Log10x.');
  lines.push('Source: https://github.com/log-10x/siem-check');

  return lines.join('\n');
}
