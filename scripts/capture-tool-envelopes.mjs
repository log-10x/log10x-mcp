#!/usr/bin/env node
/**
 * Doc-side capture script.
 *
 * For each tool, invoke it via the live MCP (stdio) against the public
 * demo env, capture the result envelope, and write:
 *
 *   docs/_includes/tool-envelopes/<tool>.input.json    — the args we sent
 *   docs/_includes/tool-envelopes/<tool>.output.json   — the typed envelope
 *
 * Those files become the source of truth for the doc rewrite's "Input
 * example" / "Output example" admonitions. The script is idempotent;
 * re-running refreshes the snapshots.
 *
 * Skips destructive / mutating tools (delete_env, signout, signin_*,
 * rotate_api_key, update_settings, create_env, update_env, backfill_metric,
 * poc_from_siem_submit/status, poc_from_local). For those, we keep
 * hand-authored synthetic captures in the docs and mark them as such.
 *
 * Usage:
 *   node scripts/capture-tool-envelopes.mjs              # capture all safe tools
 *   node scripts/capture-tool-envelopes.mjs services     # one tool by name (without log10x_ prefix)
 *
 * Env (demo creds — public):
 *   LOG10X_API_KEY=4d985100-ee4a-4b6c-b784-a416b8684868
 *   LOG10X_CUSTOMER_METRICS_URL=https://prometheus.log10x.com
 *   LOG10X_CUSTOMER_METRICS_TYPE=log10x
 *   LOG10X_CUSTOMER_METRICS_AUTH=4d985100-ee4a-4b6c-b784-a416b8684868/6aa99191-f827-4579-a96a-c0ebdfe73884
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = process.env.LOG10X_DOCS_ROOT
  ? resolve(process.env.LOG10X_DOCS_ROOT)
  : resolve(repoRoot, '..', 'mksite-tmp', 'docs');
const outputDir = join(docsRoot, '_includes', 'tool-envelopes');

const DEMO_PATTERN = 'open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project';

// Per-tool capture plan. `args` = the JSON object passed in the tool/call.
// `live` = whether to hit the live MCP (false = skip, ship a synthetic).
// `synthetic` = the hand-authored envelope if `live=false`. For
// mutating/destructive tools, only the SHAPE is shipped (no real action
// against the demo account).
const PLAN = {
  // ── COST ──────────────────────────────────────────────────
  top_patterns: { live: true, args: { limit: 5, timeRange: '1h', view: 'summary' } },
  services:     { live: true, args: { limit: 5, timeRange: '7d', view: 'summary' } },
  savings:      { live: true, args: { timeRange: '7d', view: 'summary' } },
  discover_labels: { live: true, args: { view: 'summary' } },

  // ── IDENTIFY ──────────────────────────────────────────────
  pattern_examples: { live: true, args: { pattern: DEMO_PATTERN, limit: 3, timeRange: '1h', view: 'summary' } },
  pattern_trend:    { live: true, args: { pattern: DEMO_PATTERN, timeRange: '24h', view: 'summary' } },
  event_lookup:     { live: true, args: { pattern: DEMO_PATTERN, timeRange: '1h', view: 'summary' } },
  resolve_batch:    { live: true, args: { source: 'events', events: [
    '2026-05-26 10:00:00 ERROR payments-svc Connection timeout to db-replica-2',
    '2026-05-26 10:00:01 ERROR payments-svc Connection timeout to db-replica-2',
    '2026-05-26 10:00:02 INFO payments-svc Retry attempt 1/3 succeeded',
  ], top_n_patterns: 5, view: 'summary' } },
  extract_templates: { live: true, args: { source: 'events', events: [
    '2026-05-26 10:00:00 INFO payments-svc Transaction completed for user_42',
    '2026-05-26 10:00:01 INFO payments-svc Transaction completed for user_99',
  ], top_n: 5, view: 'summary' } },

  // ── INVESTIGATE ───────────────────────────────────────────
  investigate:           { live: true, args: { starting_point: 'otel-collector', window: '1h', depth: 'shallow', view: 'summary' } },
  correlate_cross_pillar: { live: true, args: { anchor_type: 'log10x_pattern', anchor: DEMO_PATTERN, window: '1h', view: 'summary' } },
  translate_metric_to_patterns: { live: true, args: { customer_metric: 'all_events_summaryBytes_total{k8s_namespace="otel-demo"}', window: '1h', view: 'summary' } },
  customer_metrics_query: { live: true, args: { promql: 'sum(rate(all_events_summaryBytes_total[5m]))', mode: 'instant', view: 'summary' } },
  discover_join:         { live: true, args: { view: 'summary' } },

  // ── DETECT (paste-mode; locally evaluable) ────────────────
  find_skew: { live: true, args: { events: makeSkewedEvents(), min_concentration: 0.6, top_n: 5, view: 'summary' } },
  find_constant_slots: { live: true, args: { events: makeConstantSlotEvents(), top_n: 5, view: 'summary' } },
  find_uuid_in_body: { live: true, args: { events: makeUuidEvents(), top_n: 5, view: 'summary' } },
  find_incident_cluster: { live: true, args: { events: makeClusterEvents(), view: 'summary' } },

  // ── DROP ──────────────────────────────────────────────────
  pattern_mitigate:   { live: true, args: { pattern: 'cart_cartstore_ValkeyCartStore', view: 'summary' } },
  dependency_check:   { live: true, args: { pattern: 'Payment_Gateway_Timeout', vendor: 'datadog', view: 'summary' } },

  // ── RETRIEVE (requires Retriever; the demo env may not have one — captures will show the not-configured response which IS the typed envelope) ──
  retriever_query:    { live: true, args: { pattern: DEMO_PATTERN, from: 'now-15m', to: 'now', limit: 3, view: 'summary' } },
  retriever_series:   { live: true, args: { pattern: DEMO_PATTERN, from: 'now-1h', to: 'now', bucket_size: '5m', view: 'summary' } },

  // ── INSTALL ───────────────────────────────────────────────
  discover_env: { live: true, args: { skip_aws: true, skip_kubectl: true, view: 'summary' } },
  doctor:       { live: true, args: { view: 'summary' } },
  // The advisors and configure_* require a snapshot_id; we run discover_env
  // first to get one, then call them — see runAdvisors() below.

  // ── ACCOUNT ───────────────────────────────────────────────
  login_status: { live: true, args: { view: 'summary' } },
  // configure_env in validateOnly mode is safe — no write.
  configure_env: { live: true, args: { nickname: 'doc-capture-dry-run', metricsBackend: { kind: 'log10x', apiKey: '4d985100-ee4a-4b6c-b784-a416b8684868', envId: '6aa99191-f827-4579-a96a-c0ebdfe73884' }, validateOnly: true, view: 'summary' } },

  // ── DESTRUCTIVE / MUTATING — synthetic only ─────────────
  signin_start:    { live: false, synthetic: 'signin_start' },
  signin_complete: { live: false, synthetic: 'signin_complete' },
  signout:         { live: false, synthetic: 'signout' },
  rotate_api_key:  { live: false, synthetic: 'rotate_api_key' },
  update_settings: { live: false, synthetic: 'update_settings' },
  create_env:      { live: false, synthetic: 'create_env' },
  update_env:      { live: false, synthetic: 'update_env' },
  delete_env:      { live: false, synthetic: 'delete_env' },
  backfill_metric: { live: false, synthetic: 'backfill_metric' },
  poc_from_siem_submit: { live: false, synthetic: 'poc_from_siem_submit' },
  poc_from_siem_status: { live: false, synthetic: 'poc_from_siem_status' },
  poc_from_local:  { live: false, synthetic: 'poc_from_local' },
};

function makeSkewedEvents() {
  const events = [];
  // 8 "get" verbs vs 2 others — 80% skew on verb slot.
  for (let i = 0; i < 8; i++) events.push(`audit verb=get user=u${i} status=200`);
  events.push('audit verb=post user=u9 status=201');
  events.push('audit verb=delete user=u10 status=204');
  return events;
}
function makeConstantSlotEvents() {
  // apiVersion is constant across all events → constant-slot detector should flag it.
  return Array.from({ length: 12 }, (_, i) => `apiVersion=audit.k8s.io/v1 kind=Event user=u${i} action=op${i % 3}`);
}
function makeUuidEvents() {
  // auditID is a per-event UUID → uuid-in-body detector should flag it.
  const events = [];
  for (let i = 0; i < 12; i++) {
    const u = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    events.push(`audit auditID=${u} verb=GET status=200`);
  }
  return events;
}
function makeClusterEvents() {
  const events = [];
  for (let i = 0; i < 4; i++) events.push(`k8s_audit endpoints kube_dns lookup failed for namespace=ns${i}`);
  for (let i = 0; i < 4; i++) events.push(`k8s_audit services kube_dns timeout in namespace=ns${i}`);
  return events;
}

const SYNTHETICS = {
  signin_start: {
    args: {},
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_signin_start',
      view: 'summary',
      summary: { headline: 'Sign-in started — confirm code ABCD-EFGH in browser, then call signin_complete with the device_code below.' },
      data: {
        ok: true,
        user_code: 'ABCD-EFGH',
        verification_url: 'https://auth.log10x.com/activate?user_code=ABCD-EFGH',
        device_code: 'dvc_01HZ...',
        expires_in_seconds: 900,
        browser_launched: true,
        auth0_domain: 'auth.log10x.com',
      },
      actions: [{ tool: 'log10x_signin_complete', args: { device_code: 'dvc_01HZ...' }, reason: 'finish the device flow once the user confirms in their browser' }],
    },
  },
  signin_complete: {
    args: { device_code: 'dvc_01HZ...' },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_signin_complete',
      view: 'summary',
      summary: { headline: 'Signed in as alice@acme.example; credentials saved to ~/.log10x/credentials.' },
      data: { ok: true, signed_in_as: 'alice@acme.example', credentials_path: '~/.log10x/credentials', path_used: 'browser_device_flow' },
      actions: [{ tool: 'log10x_login_status', args: {}, reason: 'verify env list and identity now that sign-in completed' }],
    },
  },
  signout: {
    args: {},
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_signout',
      view: 'summary',
      summary: { headline: 'Signed out: credentials file removed, env var cleared; now in demo mode.' },
      data: { credentials_file_removed: true, credentials_path: '~/.log10x/credentials', env_var_cleared: true, now_in_demo_mode: true, host_config_edit_needed: true },
      actions: [{ tool: 'log10x_signin_start', args: {}, reason: 'sign back in via Auth0 device flow' }],
    },
  },
  rotate_api_key: {
    args: { confirm: 'rotate-now' },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_rotate_api_key',
      view: 'summary',
      summary: { headline: 'API key rotated for alice@acme.example — previous key invalidated, new key persisted to ~/.log10x/credentials.' },
      data: { ok: true, username: 'alice@acme.example', new_api_key: '<new-uuid>', credentials_path: '~/.log10x/credentials', env_var_cleared: true, host_config_edit_needed: true },
      warnings: ['rotation invalidates the previous key on every machine; update other MCP hosts, scripts, and CI secrets'],
    },
  },
  update_settings: {
    args: { metadata: { analyzer_cost: 3.0 } },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_update_settings',
      view: 'summary',
      summary: { headline: 'Updated 1 setting for alice@acme.example.' },
      data: { ok: true, username: 'alice@acme.example', fields_updated: 1, redacted_keys: [] },
    },
  },
  create_env: {
    args: { name: 'staging', is_default: false },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_create_env',
      view: 'summary',
      summary: { headline: 'Created env "staging" (env_id 9e6f...c2, not new default).' },
      data: { ok: true, name: 'staging', env_id: '9e6f0a2b-...-c2', permissions: 'OWNER', is_default: false, total_envs: 2 },
      actions: [{ tool: 'log10x_advise_install', args: { environment: 'staging' }, reason: 'pick the right Reporter / Receiver / Retriever install path for the new env' }],
    },
  },
  update_env: {
    args: { env_id: '9e6f0a2b-...-c2', name: 'staging-east' },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_update_env',
      view: 'summary',
      summary: { headline: 'Updated env 9e6f0a2b-...-c2: renamed "staging" → "staging-east".' },
      data: { ok: true, env_id: '9e6f0a2b-...-c2', before: { name: 'staging', is_default: false }, after: { name: 'staging-east', is_default: false }, changes: ['renamed "staging" → "staging-east"'] },
    },
  },
  delete_env: {
    args: { env_id: '9e6f0a2b-...-c2', confirm_name: 'staging-east' },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_delete_env',
      view: 'summary',
      summary: { headline: 'Deleted env "staging-east" (9e6f0a2b-...-c2), 1 envs remain.' },
      data: { ok: true, deleted_env_id: '9e6f0a2b-...-c2', deleted_name: 'staging-east', remaining_envs: 1 },
      warnings: ['env deletion is irrecoverable; metric history scoped to this env is also lost'],
    },
  },
  backfill_metric: {
    args: { pattern: 'db_query_timeout', metric_name: 'log10x.db_query_timeout_count', destination: 'datadog', from: 'now-90d', to: 'now', bucket_size: '5m', aggregation: 'count' },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_backfill_metric',
      view: 'summary',
      summary: { headline: 'Backfill log10x.db_query_timeout_count to datadog: 21,418 events → 2,160 points (1 series, 300s buckets), view at https://app.datadoghq.com/metric/...' },
      data: { ok: true, pattern: 'db_query_timeout', metric_name: 'log10x.db_query_timeout_count', destination: 'datadog', window_from: 'now-90d', window_to: 'now', bucket_size: '5m', bucket_seconds: 300, aggregation: 'count', group_by: [], filters: [], events_retrieved: 21418, retriever_wall_ms: 7842, points_emitted: 2160, series_count: 1, emission_wall_ms: 4421, bytes_posted: 184220, view_url: 'https://app.datadoghq.com/metric/...', warnings: [], forward_emission_note: 'Forward emission not requested. Historical backfill only.' },
      actions: [
        { tool: 'log10x_pattern_trend', args: { pattern: 'db_query_timeout', timeRange: '30d' }, reason: 'verify the backfilled series — pattern_trend now extends full 90d' },
        { tool: 'log10x_retriever_series', args: { pattern: 'db_query_timeout', from: 'now-90d', to: 'now' }, reason: 'sanity-check the backfilled buckets at finer granularity' },
      ],
    },
  },
  poc_from_siem_submit: {
    args: { siem: 'cloudwatch', window: '7d', target_event_count: 250000, max_pull_minutes: 5, ai_prettify: true, privacy_mode: true },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_poc_from_siem_submit',
      view: 'summary',
      summary: { headline: 'POC submit accepted for cloudwatch (snapshot_id b27c9a4f); estimated 4 min. Poll log10x_poc_from_siem_status.' },
      data: { ok: true, snapshot_id: 'b27c9a4f-...', siem_detected: 'cloudwatch', estimated_duration_minutes: 4, window: '7d', target_event_count: 250000, max_pull_minutes: 5 },
      actions: [{ tool: 'log10x_poc_from_siem_status', args: { snapshot_id: 'b27c9a4f-...' }, reason: 'poll POC progress; phases: pulling -> templatizing -> rendering -> complete' }],
    },
  },
  poc_from_siem_status: {
    args: { snapshot_id: 'b27c9a4f-...', view: 'summary' },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_poc_from_siem_status',
      view: 'summary',
      summary: { headline: 'POC complete for snapshot_id b27c9a4f (summary view).' },
      data: { snapshot_id: 'b27c9a4f-...', status: 'complete', progress_pct: 100, step_detail: 'rendering complete', elapsed_seconds: 224, view_rendered: 'summary', report_file_path: '/tmp/log10x-reports/poc_from_siem-2026-05-26.md', report_markdown: '# Log10x POC — CloudWatch sample\n\n...' },
    },
  },
  poc_from_local: {
    args: { source: 'kubectl', namespace: '*', window: '1h', per_pod_limit: 5000, max_pods: 20, privacy_mode: true },
    out: {
      schema_version: '1.0', schema_epoch: '2026-05-25', tool: 'log10x_poc_from_local',
      view: 'summary',
      summary: { headline: 'POC from kubectl: 84,210 lines from 18 pods → 142 distinct patterns, projected $86-$1,025/day across vendors.' },
      data: { ok: true, source: 'kubectl', namespace: '*', window: '1h', pods_sampled: 18, pods_failed: 2, events_pulled: 84210, total_bytes: 32814220, distinct_patterns: 142, daily_gb_projection: 0.732, daily_dollar_projection_low: 86, daily_dollar_projection_high: 1025, notes: ['18 pods read; 2 pods failed (access denied)'] },
      actions: [{ tool: 'log10x_resolve_batch', args: { source: 'text', text: '...' }, reason: 'run the same sample through resolve_batch for per-pattern variable concentration + next actions' }],
    },
  },
};

// ── Stdio MCP client ────────────────────────────────────────────────

function startMcp() {
  const env = {
    ...process.env,
    LOG10X_API_KEY: process.env.LOG10X_API_KEY || '4d985100-ee4a-4b6c-b784-a416b8684868',
    LOG10X_CUSTOMER_METRICS_URL: process.env.LOG10X_CUSTOMER_METRICS_URL || 'https://prometheus.log10x.com',
    LOG10X_CUSTOMER_METRICS_TYPE: process.env.LOG10X_CUSTOMER_METRICS_TYPE || 'log10x',
    LOG10X_CUSTOMER_METRICS_AUTH: process.env.LOG10X_CUSTOMER_METRICS_AUTH || '4d985100-ee4a-4b6c-b784-a416b8684868/6aa99191-f827-4579-a96a-c0ebdfe73884',
  };
  const mcp = spawn('node', [join(repoRoot, 'build', 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  return mcp;
}

function jrpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

async function callTool(mcp, toolName, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000;
  return new Promise((resolveP, rejectP) => {
    const id = Math.floor(Math.random() * 1e9);
    const buf = [];
    const timeout = setTimeout(() => {
      mcp.stdout.off('data', onData);
      rejectP(new Error(`timeout waiting for ${toolName} response`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf.push(chunk.toString('utf8'));
      const lines = buf.join('').split('\n');
      buf.length = 0;
      buf.push(lines.pop());
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timeout);
            mcp.stdout.off('data', onData);
            if (msg.error) return rejectP(new Error(`MCP error: ${msg.error.message}`));
            return resolveP(msg.result);
          }
        } catch { /* not JSON */ }
      }
    };
    mcp.stdout.on('data', onData);
    mcp.stdin.write(jrpc(id, 'tools/call', { name: `log10x_${toolName}`, arguments: args }));
  });
}

async function initialize(mcp) {
  return new Promise((resolveP, rejectP) => {
    const timeout = setTimeout(() => rejectP(new Error('initialize timeout')), 60000);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 1 && m.result) {
            clearTimeout(timeout);
            mcp.stdout.off('data', onData);
            // Send initialized notification per the MCP handshake.
            mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            resolveP(m.result);
            return;
          }
        } catch { /* skip non-JSON line */ }
      }
    };
    mcp.stdout.on('data', onData);
    mcp.stdin.write(jrpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capture-tool-envelopes', version: '1.0' },
    }));
  });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const filter = process.argv[2] ?? '';
  mkdirSync(outputDir, { recursive: true });
  process.stderr.write(`output: ${outputDir}\n`);

  // Start MCP once; reuse for all live captures.
  const liveTools = Object.entries(PLAN).filter(([t, p]) => p.live && (filter === '' || t.includes(filter)));
  const syntheticTools = Object.entries(PLAN).filter(([t, p]) => !p.live && (filter === '' || t.includes(filter)));

  if (liveTools.length > 0) {
    process.stderr.write(`booting MCP for ${liveTools.length} live captures...\n`);
    const mcp = startMcp();
    mcp.stderr.on('data', (c) => process.stderr.write(`[mcp] ${c.toString('utf8')}`));
    try {
      await initialize(mcp);
      process.stderr.write('MCP initialized; capturing...\n');
      for (const [tool, plan] of liveTools) {
        process.stderr.write(`  -> ${tool} `);
        try {
          const result = await callTool(mcp, tool, plan.args);
          const envelope = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
          // Drop the rendered base64 PNG from images[] to keep the doc snapshots
          // readable; keep a placeholder so the schema is still visible.
          if (Array.isArray(envelope.images)) {
            envelope.images = envelope.images.map((img) => ({
              ...img,
              data: '<base64 PNG omitted from doc capture; render at runtime>',
            }));
          }
          writeFileSync(join(outputDir, `${tool}.input.json`), JSON.stringify(plan.args, null, 2) + '\n');
          writeFileSync(join(outputDir, `${tool}.output.json`), JSON.stringify(envelope, null, 2) + '\n');
          process.stderr.write(`OK\n`);
        } catch (e) {
          process.stderr.write(`FAIL: ${e.message}\n`);
        }
      }
    } finally {
      mcp.kill();
    }
  }

  for (const [tool] of syntheticTools) {
    const syn = SYNTHETICS[PLAN[tool].synthetic];
    if (!syn) continue;
    writeFileSync(join(outputDir, `${tool}.input.json`), JSON.stringify(syn.args, null, 2) + '\n');
    const out = { ...syn.out, generated_at: '2026-05-26T00:00:00.000Z' };
    writeFileSync(join(outputDir, `${tool}.output.json`), JSON.stringify(out, null, 2) + '\n');
    writeFileSync(join(outputDir, `${tool}.synthetic`), 'true\n');
    process.stderr.write(`  -> ${tool} (synthetic)\n`);
  }
  process.stderr.write(`\nDone. ${liveTools.length + syntheticTools.length} envelopes in ${outputDir}\n`);
}

main().catch((e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1); });
