/**
 * log10x_exclusion_filter — generate SIEM/forwarder config to drop a pattern.
 *
 * Supports 14 vendors (4 SIEMs + 10 forwarders), with config and API modes
 * where applicable. Ported from GettingStarted.jsx exclude section.
 *
 * Vendor selection: when `vendor` is omitted, auto-detect across the SIEM
 * subset (datadog, splunk, elasticsearch, cloudwatch). Forwarder-targeted
 * exclusion (fluentbit, fluentd, otel, etc.) requires explicit `vendor=`
 * — there's no ambient signal that distinguishes a fluentbit pipeline
 * from a vector one in the user's env.
 */

import { z } from 'zod';
import { normalizePattern } from '../lib/format.js';
import {
  resolveSiemSelection,
  formatAmbiguousError,
} from '../lib/siem/resolve.js';

const SIEM_VENDORS = ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'] as const;
type SiemVendor = (typeof SIEM_VENDORS)[number];

export const exclusionFilterSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  vendor: z.enum([
    'datadog', 'splunk', 'elasticsearch', 'cloudwatch',
    'datadog-agent', 'fluentbit', 'fluentd', 'otel', 'vector',
    'logstash', 'filebeat', 'rsyslog', 'syslog-ng', 'promtail',
  ]).optional().describe('Target vendor to generate the filter for. Omit to auto-detect from ambient SIEM credentials (works for the 4 SIEM vendors only — forwarder-targeted exclusions require explicit `vendor=`).'),
  mode: z.enum(['config', 'api']).default('config').describe('Config snippet or API command (API available for Datadog, Splunk, Elasticsearch)'),
  service: z.string().optional().describe('Service name for scoping the filter'),
  severity: z.string().optional().describe('Severity level (e.g., "error", "warn")'),
};

export async function executeExclusionFilter(args: {
  pattern: string;
  vendor?: string;
  mode: string;
  service?: string;
  severity?: string;
}): Promise<string> {
  let vendor: string | undefined = args.vendor;
  let detectedNote = '';

  if (!vendor) {
    const resolution = await resolveSiemSelection({ restrictTo: [...SIEM_VENDORS] as SiemVendor[] });
    if (resolution.kind === 'none') {
      return [
        'Exclusion Filter — vendor required',
        '',
        `No SIEM credentials detected and no \`vendor\` arg supplied. Pass \`vendor=<name>\`.`,
        '',
        `SIEM vendors (auto-detectable): ${SIEM_VENDORS.join(', ')}`,
        `Forwarder vendors (explicit only): datadog-agent, fluentbit, fluentd, otel, vector, logstash, filebeat, rsyslog, syslog-ng, promtail`,
      ].join('\n');
    }
    if (resolution.kind === 'ambiguous') {
      return formatAmbiguousError(resolution.candidates, 'vendor');
    }
    vendor = resolution.id;
    detectedNote = resolution.note ?? '';
  }

  const pattern = normalizePattern(args.pattern);
  const tokens = pattern.split('_').filter(t => t.length > 0);
  // Escape regex metacharacters in each token so dots, brackets, parens, etc.
  // don't get interpreted as regex syntax by the target vendor's engine.
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Two-form regex: the loose ordered token form (matches CamelCase and
  // separated variants alike) PLUS an alternative for the canonical
  // underscored Symbol Message when it appears as a discrete word.
  //
  // An earlier attempt added word boundaries around each token to reduce
  // false positives, but that regressed on CamelCase log lines: a real
  // event `PaymentGateway request Timeout` failed `\bPayment\b.*?\bGateway\b`
  // because there's no word boundary between adjacent CamelCase tokens.
  // PCRE engines without lookbehind (Splunk RE2) can't express
  // "boundary OR camel-case transition" in a single expression, so this
  // tool keeps the loose form (preserving recall) and adds the canonical
  // form only as an additional alternative. Result: no regression vs the
  // original behavior, plus a precise match path when the snake_case
  // identity literally appears in the haystack.
  //
  // Customers who want a precise drop should use the Receiver mute-file
  // entry the tool also documents — that path is templateHash-keyed and
  // doesn't have the regex matching limitation.
  const tokenRegex = tokens.map(escapeRegex).join('.*?');
  const canonicalRegex = `\\b${escapeRegex(pattern)}\\b`;
  const patRegex = `(?:${tokenRegex}|${canonicalRegex})`;
  const svc = args.service || '';
  const sev = (args.severity || '').toLowerCase();
  const vk = vendor;
  const mode = args.mode;

  const { label, text } = generateFilter(vk, mode, tokens, patRegex, svc, sev, pattern);

  const lines: string[] = [];
  const vendorLabel = VENDOR_LABELS[vk] || vk;
  lines.push(`Exclusion Filter — ${vendorLabel} (${mode})`);
  if (detectedNote) {
    lines.push('');
    lines.push(`_${detectedNote}_`);
  }
  lines.push('');
  lines.push(label);
  lines.push('');
  lines.push(text);

  return lines.join('\n');
}

const VENDOR_LABELS: Record<string, string> = {
  'datadog': 'Datadog',
  'splunk': 'Splunk',
  'elasticsearch': 'Elasticsearch',
  'cloudwatch': 'CloudWatch',
  'datadog-agent': 'Datadog Agent',
  'fluentbit': 'Fluent Bit',
  'fluentd': 'Fluentd',
  'otel': 'OTel Collector',
  'vector': 'Vector',
  'logstash': 'Logstash',
  'filebeat': 'Filebeat',
  'rsyslog': 'rsyslog',
  'syslog-ng': 'syslog-ng',
  'promtail': 'Promtail',
};

// Safe identifier tokens: strip everything that isn't alphanumeric or underscore.
// Used for stanza names / transform names that must not contain regex metacharacters.
function safeId(tokens: string[]): string {
  return tokens.slice(0, 3).map(t => t.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join('_');
}

function generateFilter(
  vk: string, mode: string,
  tokens: string[], patRegex: string,
  svc: string, sev: string, rawPattern: string
): { label: string; text: string } {
  // Datadog query for SIEM filters
  const ddQuery = (() => {
    const parts: string[] = [];
    if (svc) parts.push(`service:${svc}`);
    if (sev && sev !== 'uncl') parts.push(`status:${sev}`);
    parts.push(`@message:/${patRegex}/`);
    return parts.join(' ');
  })();

  // ── SIEMs ──
  if (vk === 'datadog' && mode === 'config') {
    return { label: 'Paste this query into an exclusion filter under Logs > Configuration > Indexes.', text: ddQuery };
  }
  if (vk === 'datadog' && mode === 'api') {
    const body = JSON.stringify({ name: `Drop ${rawPattern.slice(0, 40)}`, is_enabled: true, filter: { query: ddQuery } });
    return {
      label: 'Run this curl command to create an exclusion filter via the Datadog API.',
      text: `curl -X POST "https://api.datadoghq.com/api/v1/logs/config/indexes/<INDEX_NAME>/exclusion_filters" \\\n  -H "DD-API-KEY: <YOUR_API_KEY>" \\\n  -H "DD-APPLICATION-KEY: <YOUR_APP_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`
    };
  }
  if (vk === 'splunk' && mode === 'config') {
    const lines = [
      `# Add to transforms.conf on your Heavy Forwarder or Indexer`,
      `[drop_${safeId(tokens)}]`,
      `REGEX = ${patRegex}`,
      `DEST_KEY = queue`,
      `FORMAT = nullQueue`,
    ];
    if (svc) lines.push(`# Apply in props.conf under [source::${svc}]`);
    return { label: 'Add this stanza to transforms.conf to route matching events to nullQueue.', text: lines.join('\n') };
  }
  if (vk === 'splunk' && mode === 'api') {
    return {
      label: 'Run this curl command to create a transforms extraction via the Splunk REST API.',
      text: `curl -k -u <USERNAME>:<PASSWORD> \\\n  "https://<SPLUNK_HOST>:8089/servicesNS/nobody/search/data/transforms/extractions" \\\n  -d name=drop_${safeId(tokens)} \\\n  -d REGEX="${patRegex}" \\\n  -d DEST_KEY=queue \\\n  -d FORMAT=nullQueue`
    };
  }
  if (vk === 'elasticsearch' && mode === 'config') {
    const condition = `ctx.message != null && ctx.message =~ /${patRegex}/`
      + (svc ? ` && ctx['service.name'] == '${svc}'` : '')
      + (sev && sev !== 'uncl' ? ` && ctx.level == '${sev.toUpperCase()}'` : '');
    return {
      label: 'Add this drop processor to an ingest pipeline under Stack Management > Ingest Pipelines.',
      text: JSON.stringify({ drop: { if: condition } }, null, 2)
    };
  }
  if (vk === 'elasticsearch' && mode === 'api') {
    const condition = `ctx.message != null && ctx.message =~ /${patRegex}/`
      + (svc ? ` && ctx['service.name'] == '${svc}'` : '')
      + (sev && sev !== 'uncl' ? ` && ctx.level == '${sev.toUpperCase()}'` : '');
    const body = JSON.stringify({ description: `Drop ${rawPattern.slice(0, 40)}`, processors: [{ drop: { if: condition } }] }, null, 2);
    return {
      label: 'Run this curl command to create an ingest pipeline with a drop processor.',
      text: `curl -X PUT "https://<ES_HOST>:9200/_ingest/pipeline/<PIPELINE_ID>" \\\n  -H "Content-Type: application/json" \\\n  -u <USERNAME>:<PASSWORD> \\\n  -d '${body}'`
    };
  }
  if (vk === 'cloudwatch') {
    return { label: 'Use this regex in a Lambda subscription filter on the matching log group.', text: patRegex };
  }

  // ── Forwarders ──
  if (vk === 'datadog-agent') {
    const lines = [
      `# Add to your Datadog Agent log integration config`,
      `# (e.g. conf.d/<integration>.d/conf.yaml)`,
      `logs:`,
      `  - type: file`,
      `    path: /var/log/app.log`,
    ];
    if (svc) lines.push(`    service: ${svc}`);
    lines.push(
      `    log_processing_rules:`,
      `      - type: exclude_at_match`,
      `        name: drop_${safeId(tokens)}`,
      `        pattern: '${patRegex}'`
    );
    return { label: 'Add this log_processing_rules block to your Datadog Agent config to drop matching events before ingestion.', text: lines.join('\n') };
  }
  if (vk === 'fluentbit') {
    const lines = [
      `# Add to your Fluent Bit configuration`,
      `[FILTER]`,
      `    Name     grep`,
      `    Match    ${svc || '*'}`,
      `    Exclude  log ${patRegex}`,
    ];
    return { label: 'Add this filter section to your Fluent Bit configuration to drop matching events.', text: lines.join('\n') };
  }
  if (vk === 'fluentd') {
    const lines = [
      `# Add to your Fluentd configuration`,
      `<filter ${svc || '**'}>`,
      `  @type grep`,
      `  <exclude>`,
      `    key message`,
      `    pattern /${patRegex}/`,
      `  </exclude>`,
    ];
    if (sev && sev !== 'uncl') {
      lines.push(`  <exclude>`, `    key level`, `    pattern /^${sev}$/i`, `  </exclude>`);
    }
    lines.push(`</filter>`);
    return { label: 'Add this filter block to your Fluentd configuration to drop matching events.', text: lines.join('\n') };
  }
  if (vk === 'otel') {
    const cond = [`IsMatch(body, "${patRegex}")`];
    if (svc) cond.push(`resource.attributes["service.name"] == "${svc}"`);
    if (sev && sev !== 'uncl') cond.push(`severity_text == "${sev.toUpperCase()}"`);
    const lines = [
      `# Add to your OTel Collector config under processors:`,
      `processors:`,
      `  filter/drop_pattern:`,
      `    logs:`,
      `      log_record:`,
      `        - '${cond.join(' and ')}'`,
    ];
    return { label: 'Add this filter processor to your OTel Collector config to drop matching events.', text: lines.join('\n') };
  }
  if (vk === 'vector') {
    const conds = [`match(string!(.message), r'${patRegex}')`];
    if (svc) conds.push(`.service == "${svc}"`);
    if (sev && sev !== 'uncl') conds.push(`.level == "${sev}"`);
    const lines = [
      `# Add to your Vector configuration (vector.toml)`,
      `[transforms.drop_pattern]`,
      `type = "filter"`,
      `inputs = ["<YOUR_SOURCE>"]`,
      `condition = '!(${conds.join(' && ')})'`,
    ];
    return { label: 'Add this filter transform to your Vector config to drop matching events.', text: lines.join('\n') };
  }
  if (vk === 'logstash') {
    const conds = [`[message] =~ /${patRegex}/`];
    if (svc) conds.push(`[service] == "${svc}"`);
    if (sev && sev !== 'uncl') conds.push(`[level] == "${sev}"`);
    const lines = [
      `# Add to the filter section of your Logstash pipeline`,
      `filter {`,
      `  if ${conds.join(' and ')} {`,
      `    drop { }`,
      `  }`,
      `}`,
    ];
    return { label: 'Add this filter block to your Logstash pipeline to drop matching events.', text: lines.join('\n') };
  }
  if (vk === 'filebeat') {
    const lines = [`# Add to the processors section of your filebeat.yml`];
    const conditions: Record<string, unknown>[] = [{ regexp: { message: patRegex } }];
    if (svc) conditions.push({ equals: { 'service.name': svc } });
    if (sev && sev !== 'uncl') conditions.push({ equals: { 'log.level': sev } });

    lines.push(`processors:`, `  - drop_event:`);
    if (conditions.length > 1) {
      lines.push(`      when:`, `        and:`);
      for (const c of conditions) lines.push(`          - ${JSON.stringify(c)}`);
    } else {
      lines.push(`      when:`, `        regexp:`, `          message: '${patRegex}'`);
    }
    return { label: 'Add this processor to your filebeat.yml to drop matching events.', text: lines.join('\n') };
  }
  if (vk === 'rsyslog') {
    const lines = [`# Add to your rsyslog.conf or /etc/rsyslog.d/*.conf`];
    if (svc) lines.push(`# For messages from ${svc}:`);
    lines.push(`:msg, regex, "${patRegex}" stop`);
    return { label: 'Add this rule to your rsyslog config to drop matching messages.', text: lines.join('\n') };
  }
  if (vk === 'syslog-ng') {
    const lines = [
      `# Add to your syslog-ng.conf`,
      `filter f_drop_pattern {`,
      `  not match("${patRegex}" value("MESSAGE"))`,
      `};`,
    ];
    return { label: 'Add this filter to your syslog-ng config and apply it to your log path.', text: lines.join('\n') };
  }
  if (vk === 'promtail') {
    const lines = [
      `# Add to your Promtail config under scrape_configs > pipeline_stages`,
      `pipeline_stages:`,
      `  - drop:`,
      `      expression: '${patRegex}'`,
    ];
    return { label: 'Add this pipeline stage to your Promtail config to drop matching events before sending to Loki.', text: lines.join('\n') };
  }

  return { label: 'Regex pattern matching this log template.', text: patRegex };
}
