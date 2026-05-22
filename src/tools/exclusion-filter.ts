/**
 * log10x_exclusion_filter — generate SIEM/forwarder config to drop a pattern.
 *
 * Supports 14 vendors (4 SIEMs + 10 forwarders), with config and API modes
 * where applicable. Ported from GettingStarted.jsx exclude section.
 *
 * Vendor selection: when `vendor` is omitted, auto-detect across the SIEM
 * subset (datadog, splunk, elasticsearch, cloudwatch). Forwarder-targeted
 * exclusion (fluentbit, fluentd, otel-collector, etc.) requires explicit
 * `vendor=` — there's no ambient signal that distinguishes a fluentbit
 * pipeline from a vector one in the user's env.
 *
 * Forwarder name canonical form matches the rest of the user-facing
 * surface area (helm chart values keys, mksite URL slugs, advise-* tool
 * schemas): `fluentbit` (no hyphen), `otel-collector` (full, hyphenated).
 */

import { z } from 'zod';
import { normalizePattern } from '../lib/format.js';
import { TENX_HASH_GLOSS } from '../lib/pattern-descriptor.js';
import {
  resolveSiemSelection,
  formatAmbiguousError,
} from '../lib/siem/resolve.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { tenxHash } from '../lib/pattern-hash.js';

const SIEM_VENDORS = ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'] as const;
type SiemVendor = (typeof SIEM_VENDORS)[number];

export const exclusionFilterSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  vendor: z.enum([
    'datadog', 'splunk', 'elasticsearch', 'cloudwatch',
    'datadog-agent', 'fluentbit', 'fluentd', 'otel-collector', 'vector',
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
        `Forwarder vendors (explicit only): datadog-agent, fluentbit, fluentd, otel-collector, vector, logstash, filebeat, rsyslog, syslog-ng, promtail`,
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
  const hashKey = tenxHash(pattern);
  const hashFilter = generateHashFilter(vk, mode, hashKey, svc, sev);

  const lines: string[] = [];
  const vendorLabel = VENDOR_LABELS[vk] || vk;
  lines.push(`Exclusion Filter — ${vendorLabel} (${mode})`);
  if (detectedNote) {
    lines.push('');
    lines.push(`_${detectedNote}_`);
  }
  if (hashFilter) {
    // Exact tenx_hash is strictly more precise; recommend it first. It is
    // only valid when events carry tenx_hash (engine symbolMessageHashField
    // enabled) — the regex form below is the fallback when they don't.
    lines.push('');
    lines.push(`**Recommended — exact \`tenx_hash\` (${hashKey})**`);
    lines.push(`_${TENX_HASH_GLOSS}_`);
    lines.push('');
    lines.push(hashFilter.label);
    lines.push('');
    lines.push(hashFilter.text);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Fallback — message regex** (use only if your pipeline does not carry the `tenx_hash` field):');
    lines.push('');
    lines.push(label);
    lines.push('');
    lines.push(text);
    lines.push('');
    lines.push(agentOnly(
      `Prefer the exact tenx_hash config. The regex fallback is recall-lossy ` +
      `(token-order coincidence + per-vendor regex-engine limits). Recommend ` +
      `the regex form ONLY if the env's pipeline does not emit tenx_hash — ` +
      `confirm via log10x_pattern_examples (its probe-path note) or log10x_doctor.`
    ));
  } else {
    lines.push('');
    lines.push(label);
    lines.push('');
    lines.push(text);
  }

  // Chain to verification + savings — without this, the user is dead-ended
  // after generating the config. After the drop is applied, the natural
  // questions are "did volume actually drop" (pattern_trend) and "what did
  // I save" (cost_drivers shows the delta).
  lines.push('');
  lines.push(agentOnly(
    `After the drop is applied, suggested next calls: ` +
    `Verify volume actually dropped — log10x_pattern_trend({ pattern: '${pattern}', timeRange: '1d', step: '1h' }) — look for the inflection where the rate goes to zero. ` +
    `See cost impact — log10x_cost_drivers({ timeRange: '7d' }) — the pattern will appear in the shrinking/removed list with the savings dollar amount.`
  ));

  const nextActions: NextAction[] = [
    {
      tool: 'log10x_pattern_trend',
      args: { pattern, timeRange: '1d', step: '1h' },
      reason: 'verify volume actually dropped after the exclusion is applied',
    },
    {
      tool: 'log10x_cost_drivers',
      args: { timeRange: '7d' },
      reason: 'see cost savings from the drop in week-over-week deltas',
    },
  ];
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

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
  'otel-collector': 'OTel Collector',
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
  if (vk === 'otel-collector') {
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

/**
 * Exact-match drop keyed on the engine's portable `tenx_hash` field.
 *
 * This is strictly more precise than the message-regex form: tenx_hash is
 * a stable per-pattern identity with no token coincidence and no per-vendor
 * regex-engine limitation. The fluentd block is the exact config proven on
 * the live otel-demo to drop one pattern with zero collateral.
 *
 * Only valid when the pipeline actually carries `tenx_hash` on events
 * (engine `symbolMessageHashField` enabled). Callers render this as the
 * primary recommendation with the regex form as an explicit fallback.
 */
function generateHashFilter(
  vk: string, mode: string, hash: string, svc: string, sev: string,
): { label: string; text: string } | null {
  const id = hash.replace(/[^A-Za-z0-9]/g, '');
  switch (vk) {
    case 'datadog': {
      const parts = [`@tenx_hash:"${hash}"`];
      if (svc) parts.push(`service:${svc}`);
      if (sev && sev !== 'uncl') parts.push(`status:${sev}`);
      const q = parts.join(' ');
      if (mode === 'api') {
        const body = JSON.stringify({ name: `Drop tenx_hash ${hash}`, is_enabled: true, filter: { query: q } });
        return {
          label: 'Run this curl to create an exact-tenx_hash exclusion filter via the Datadog API.',
          text: `curl -X POST "https://api.datadoghq.com/api/v1/logs/config/indexes/<INDEX_NAME>/exclusion_filters" \\\n  -H "DD-API-KEY: <YOUR_API_KEY>" \\\n  -H "DD-APPLICATION-KEY: <YOUR_APP_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`,
        };
      }
      return { label: 'Paste this query into an exclusion filter under Logs > Configuration > Indexes (exact tenx_hash).', text: q };
    }
    case 'splunk': {
      // _raw literal match on the unique hash string — collision-proof
      // (the hash is globally unique), so this is exact in effect even
      // though Splunk nullQueue routing is regex-on-_raw.
      const rex = `"tenx_hash"\\s*:\\s*"${hash}"`;
      if (mode === 'api') {
        return {
          label: 'Run this curl to create the exact-tenx_hash nullQueue transform via the Splunk REST API.',
          text: `curl -k -u <USERNAME>:<PASSWORD> \\\n  "https://<SPLUNK_HOST>:8089/servicesNS/nobody/search/data/transforms/extractions" \\\n  -d name=drop_tenx_${id} \\\n  -d REGEX='${rex}' \\\n  -d DEST_KEY=queue \\\n  -d FORMAT=nullQueue`,
        };
      }
      const lines = [
        `# transforms.conf — exact tenx_hash drop (collision-proof)`,
        `[drop_tenx_${id}]`,
        `REGEX = ${rex}`,
        `DEST_KEY = queue`,
        `FORMAT = nullQueue`,
        `# props.conf — wire it to your sourcetype:`,
        `# [<your_sourcetype>]`,
        `# TRANSFORMS-drop = drop_tenx_${id}`,
      ];
      return { label: 'Add this stanza to transforms.conf (exact tenx_hash → nullQueue) and wire it in props.conf.', text: lines.join('\n') };
    }
    case 'elasticsearch': {
      // null-guard first: a bare ctx.tenx_hash on documents lacking the
      // field throws a Painless error and fails the whole pipeline (the
      // 84 other patterns). Mirrors the baseline generateFilter guard.
      const cond = `ctx.tenx_hash != null && ctx.tenx_hash == '${hash}'`
        + (svc ? ` && ctx['service.name'] == '${svc}'` : '')
        + (sev && sev !== 'uncl' ? ` && ctx.level == '${sev.toUpperCase()}'` : '');
      const proc = { drop: { if: cond } };
      if (mode === 'api') {
        const b = JSON.stringify({ description: `Drop tenx_hash ${hash}`, processors: [proc] }, null, 2);
        return {
          label: 'Run this curl to create an ingest pipeline that drops by exact tenx_hash.',
          text: `curl -X PUT "https://<ES_HOST>:9200/_ingest/pipeline/<PIPELINE_ID>" \\\n  -H "Content-Type: application/json" \\\n  -u <USERNAME>:<PASSWORD> \\\n  -d '${b}'`,
        };
      }
      return { label: 'Add this drop processor to an ingest pipeline (exact tenx_hash equality).', text: JSON.stringify(proc, null, 2) };
    }
    case 'cloudwatch':
      return {
        label: 'Use this exact CloudWatch filter pattern in a subscription/metric filter on the log group.',
        text: `{ $.tenx_hash = "${hash}" }`,
      };
    case 'fluentd': {
      // Exact block proven on live otel-demo (Step 2) to drop one pattern
      // with zero collateral.
      const lines = [
        `# Fluentd — exact tenx_hash drop (proven on live otel-demo)`,
        `<filter ${svc || '**'}>`,
        `  @type grep`,
        `  <exclude>`,
        `    key tenx_hash`,
        `    pattern /^${hash}$/`,
        `  </exclude>`,
        `</filter>`,
      ];
      return { label: 'Add this filter block to Fluentd (exact tenx_hash drop).', text: lines.join('\n') };
    }
    case 'fluentbit':
      return {
        label: 'Add this filter to Fluent Bit (exact tenx_hash drop).',
        text: [`[FILTER]`, `    Name     grep`, `    Match    ${svc || '*'}`, `    Exclude  tenx_hash ^${hash}$`].join('\n'),
      };
    case 'otel-collector': {
      // Raw-line ingestion (the proven shape) carries tenx_hash in the log
      // body, NOT in OTLP attributes. Match the JSON fragment in body —
      // collision-proof (hash is globally unique). Mirrors the baseline's
      // IsMatch(body, ...) form.
      const lines = [
        `# OTel Collector — exact tenx_hash drop (body match; raw-line ingestion)`,
        `processors:`,
        `  filter/drop_tenx_hash:`,
        `    logs:`,
        `      log_record:`,
        `        - 'IsMatch(body, "\\"tenx_hash\\":\\"${hash}\\"")'`,
      ];
      return { label: 'Add this filter processor to your OTel Collector config (exact tenx_hash, body match).', text: lines.join('\n') };
    }
    case 'datadog-agent':
      return {
        label: 'Add this log_processing_rules block to your Datadog Agent config (exact tenx_hash).',
        text: [
          `logs:`, `  - type: file`, `    path: /var/log/app.log`,
          `    log_processing_rules:`, `      - type: exclude_at_match`,
          `        name: drop_tenx_${id}`, `        pattern: '"tenx_hash":"${hash}"'`,
        ].join('\n'),
      };
    case 'vector':
      return {
        label: 'Add this filter transform to your Vector config (exact tenx_hash).',
        text: [
          `[transforms.drop_tenx_hash]`, `type = "filter"`, `inputs = ["<YOUR_SOURCE>"]`,
          `condition = '!(.tenx_hash == "${hash}")'`,
        ].join('\n'),
      };
    case 'logstash':
      return {
        label: 'Add this filter block to your Logstash pipeline (exact tenx_hash).',
        text: [`filter {`, `  if [tenx_hash] == "${hash}" {`, `    drop { }`, `  }`, `}`].join('\n'),
      };
    case 'filebeat':
      return {
        label: 'Add this processor to your filebeat.yml (exact tenx_hash).',
        text: [`processors:`, `  - drop_event:`, `      when:`, `        equals:`, `          tenx_hash: "${hash}"`].join('\n'),
      };
    default:
      // rsyslog / syslog-ng / promtail operate on the raw line with no
      // structured field; the unique hash string as a literal is still
      // collision-proof. Returning null lets the caller keep the regex form.
      return null;
  }
}
