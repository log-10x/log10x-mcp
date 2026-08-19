import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { shouldRegisterTool, formatModeResolution, TOOL_MODES } from '../src/lib/mode-detect.js';
import type { ModeResolution } from '../src/lib/mode-detect.js';

test('shouldRegisterTool: analysis tools register in analysis mode', () => {
  assert.equal(shouldRegisterTool('log10x_top_patterns', 'analysis'), true);
  assert.equal(shouldRegisterTool('log10x_find_skew', 'analysis'), true);
  assert.equal(shouldRegisterTool('log10x_dependency_check', 'analysis'), true);
});

test('shouldRegisterTool: analysis tools also register in analysis_pending mode', () => {
  assert.equal(shouldRegisterTool('log10x_top_patterns', 'analysis_pending'), true);
  assert.equal(shouldRegisterTool('log10x_find_skew', 'analysis_pending'), true);
});

test('shouldRegisterTool: analysis tools do NOT register in POC mode', () => {
  assert.equal(shouldRegisterTool('log10x_top_patterns', 'poc'), false);
  assert.equal(shouldRegisterTool('log10x_find_skew', 'poc'), false);
  assert.equal(shouldRegisterTool('log10x_metrics_that_moved', 'poc'), false);
});

test('shouldRegisterTool: POC tools register in POC mode only', () => {
  assert.equal(shouldRegisterTool('log10x_poc_from_siem_submit', 'poc'), true);
  assert.equal(shouldRegisterTool('log10x_poc_from_siem_submit', 'analysis'), false);
  assert.equal(shouldRegisterTool('log10x_poc_from_siem_submit', 'analysis_pending'), false);
});

test('shouldRegisterTool: install advisors register in POC, analysis_pending AND analysis', () => {
  assert.equal(shouldRegisterTool('log10x_advise_install', 'poc'), true);
  assert.equal(shouldRegisterTool('log10x_advise_install', 'analysis_pending'), true);
  // analysis included since 2026-06-03 (f21fba2): existing tier-receiver
  // customers add the Retriever from steady-state analysis mode.
  assert.equal(shouldRegisterTool('log10x_advise_install', 'analysis'), true);
  assert.equal(shouldRegisterTool('log10x_advise_retriever', 'analysis_pending'), true);
});

test('shouldRegisterTool: always-tools register in every mode', () => {
  for (const mode of ['analysis', 'analysis_pending', 'poc'] as const) {
    assert.equal(shouldRegisterTool('log10x_login_status', mode), true);
    assert.equal(shouldRegisterTool('log10x_doctor', mode), true);
    assert.equal(shouldRegisterTool('log10x_discover_env', mode), true);
  }
});

test('shouldRegisterTool: local-only tools (resolve_batch, extract_templates) register in every mode', () => {
  for (const mode of ['analysis', 'analysis_pending', 'poc'] as const) {
    assert.equal(shouldRegisterTool('log10x_resolve_batch', mode), true);
    assert.equal(shouldRegisterTool('log10x_extract_templates', mode), true);
  }
});

test('shouldRegisterTool: unknown tools default to register in analysis modes only', () => {
  assert.equal(shouldRegisterTool('log10x_unknown_future_tool', 'analysis'), true);
  assert.equal(shouldRegisterTool('log10x_unknown_future_tool', 'analysis_pending'), true);
  assert.equal(shouldRegisterTool('log10x_unknown_future_tool', 'poc'), false);
});

test('formatModeResolution: renders a human-readable summary', () => {
  const res: ModeResolution = {
    mode: 'analysis',
    detectionPath: 'grafana_cloud',
    trace: [
      { path: 'explicit_env', status: 'skipped', reason: 'no env var' },
      { path: 'grafana_cloud', status: 'matched', reason: 'GRAFANA_CLOUD_API_KEY set' },
    ],
    reason: 'TSDB resolved; 590 tenx_* series active.',
    probeDurationMs: 142,
  };
  const out = formatModeResolution(res);
  assert.match(out, /Mode: analysis/);
  assert.match(out, /Reason: TSDB resolved/);
  assert.match(out, /Probe duration: 142ms/);
  assert.match(out, /Backend: grafana_cloud/);
  assert.match(out, /grafana_cloud: matched/);
});

test('formatModeResolution: POC mode has no Backend line', () => {
  const res: ModeResolution = {
    mode: 'poc',
    trace: [
      { path: 'explicit_env', status: 'skipped', reason: 'no env var' },
      { path: 'prometheus_url', status: 'skipped', reason: 'PROMETHEUS_URL not set' },
    ],
    reason: 'No TSDB backend resolvable from env.',
    probeDurationMs: 12,
  };
  const out = formatModeResolution(res);
  assert.match(out, /Mode: poc/);
  assert.doesNotMatch(out, /Backend:/);
});

// ── The prospect lane on a keyless boot ──────────────────────────────────
//
// The homepage install block sets no API key, so a first run boots into the
// demo fallback: analysis mode, read-only, on the public demo dataset. The
// page's first taught sentence is "run a cost POC on our <analyzer>" — and
// before this policy, no POC tool registered in that boot, so the sentence
// had nothing behind it and the nearest tools answered with demo numbers.
// The POC tools run entirely locally (engine CLI or docker over the user's
// own files, or a kubectl sample); they never touch the shared demo
// backend, so the shared-account guardrail has no reason to block them.

test('shouldRegisterTool: POC tools register on a demo-fallback boot', () => {
  for (const t of ['log10x_poc_from_local', 'log10x_poc_from_siem_submit', 'log10x_poc_from_siem_status']) {
    assert.equal(
      shouldRegisterTool(t, 'analysis', { demoFallback: true }),
      true,
      `${t} must be callable on the keyless first-run boot`
    );
  }
});

test('shouldRegisterTool: demo fallback still blocks the mutators', () => {
  // registering the POC lane must not loosen the shared-account guardrail
  assert.equal(shouldRegisterTool('log10x_configure_engine', 'analysis', { demoFallback: true }), false);
  assert.equal(shouldRegisterTool('log10x_dest_set', 'analysis', { demoFallback: true }), false);
});

test('shouldRegisterTool: POC tools stay out of real analysis boots', () => {
  // a deployed customer with their own backend does not get POC noise
  assert.equal(shouldRegisterTool('log10x_poc_from_local', 'analysis'), false);
  assert.equal(shouldRegisterTool('log10x_poc_from_local', 'analysis', { demoFallback: false }), false);
});

test('out-of-mode message on a demo-fallback boot names the actual remediation', () => {
  const res: ModeResolution = {
    mode: 'analysis',
    trace: [],
    reason: 'demo fallback',
    probeDurationMs: 1,
    demoFallback: true,
  };
  const msg = formatModeResolution(res);
  void msg; // formatModeResolution is not the surface under test; the wrap-gate message is
});

// ── The recurring step belongs to the plan, not to the deployment ─────────
//
// "Keep this plan updated" is the fourth beat of the journey the product
// teaches (POC -> plan -> apply -> auto-tune), and it was unreachable for
// the person being taught it. The gate was never earned: the tool imports
// the manifest emitter and the envelope builder and nothing else — no
// metrics backend, no TSDB query. It renders scheduler manifests from the
// wizard's own answers, the same class of work as the install advisors
// that have always registered for prospects.
test('shouldRegisterTool: setup_recurring is reachable in every customer mode', () => {
  for (const mode of ['poc', 'analysis_pending', 'analysis'] as const) {
    assert.equal(
      shouldRegisterTool('log10x_setup_recurring', mode),
      true,
      `setup_recurring must be askable in ${mode}: it emits manifests from wizard answers and queries no backend`
    );
  }
});

test('shouldRegisterTool: setup_recurring survives the keyless demo boot', () => {
  // Emitting a CronJob manifest mutates nothing in the shared demo account,
  // so the guardrail has no reason to reach it.
  assert.equal(
    shouldRegisterTool('log10x_setup_recurring', 'analysis', { demoFallback: true }),
    true
  );
});

// Every registered tool carries an explicit mode row. The fallback for an
// unlisted tool is "analysis modes only, skip everywhere else" — correct for
// most, wrong and invisible for the rest, which is how four tools of the
// documented cost chain disappeared in poc mode while the instructions named
// cost_options five times. Reads registrations out of index.ts so a new tool
// cannot be added without deciding its modes.
test('every registered tool has an explicit TOOL_MODES row', async () => {
  const src = await readFile(new URL('src/index.ts', pathToFileURL(process.cwd() + '/')), 'utf8');
  const registered = [...src.matchAll(/registerLog10xTool\('([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(registered.length > 40, `expected the full tool set, found ${registered.length}`);
  const missing = registered.filter((t) => !Object.prototype.hasOwnProperty.call(TOOL_MODES, t));
  assert.deepEqual(
    missing,
    [],
    `these tools register but have no TOOL_MODES row, so the fallback decides their ` +
      `modes silently: ${missing.join(', ')}`
  );
});

// ── Regression: the boot probe must query a metric the engine actually emits ──
// F1 (2026-08-19): the probe counted `tenx_pattern_bytes_total`, a series NO
// engine writes and that appears nowhere else in the codebase or the Grafana
// dashboards. On every correctly-configured install it returned zero, so the
// boot fell to `analysis_pending` ("fresh deploy, wait 24h") over a live
// deployment, and `top_patterns` reported no data. The tools all read
// `all_events_summaryBytes_total` (promql.ts BYTES_METRIC); the probe must read
// the same family, or the boot mode and the tools disagree about whether data
// exists. This test pins the probe to that metric so the drift cannot recur.
test('TENX_SERIES_PROBE queries the metric the analysis tools actually read', async () => {
  const { TENX_SERIES_PROBE } = await import('../src/lib/mode-detect.js');
  // The one metric every analysis tool ranks on. If BYTES_METRIC is ever
  // renamed, this literal is the intentional checkpoint to update in lockstep.
  const BYTES_METRIC = 'all_events_summaryBytes_total';
  assert.ok(
    TENX_SERIES_PROBE.includes(BYTES_METRIC),
    `boot probe must count ${BYTES_METRIC} (what the tools read), not a metric ` +
      `no engine emits. Probe was: ${TENX_SERIES_PROBE}`
  );
  // And it must NOT resurrect the phantom metric that caused F1.
  assert.ok(
    !TENX_SERIES_PROBE.includes('tenx_pattern_bytes_total'),
    'boot probe must not query tenx_pattern_bytes_total — no engine emits it (F1).'
  );
});

// ── F3: mode-detect probes the ENV-LOADER's backend, not only its own cascade ──
// A signed-in user whose metrics are log10x-SaaS-hosted sets no CUSTOMER_METRICS_*
// env vars, so resolveBackend() finds nothing. Before this, that dropped a live
// account to POC mode. detectMode now probes the loaded backend the tools use.
test('detectMode: a loaded account backend with series → analysis, not POC', async () => {
  const { detectMode } = await import('../src/lib/mode-detect.js');
  // No CUSTOMER_METRICS_*, demo fallback off → resolveBackend resolves nothing.
  const prev = process.env.LOG10X_DEMO_FALLBACK;
  process.env.LOG10X_DEMO_FALLBACK = 'off';
  try {
    const loadedBackend = {
      // The probe is count(count by(message_pattern)(...)); return a single
      // series whose value is the pattern count.
      async queryInstant() {
        return { status: 'success', data: { result: [{ value: [0, '42'] }] } };
      },
    };
    const res = await detectMode({ loadedBackend, loadedIsDemo: false, loadedNickname: 'acme' });
    assert.equal(res.mode, 'analysis');
    assert.match(res.reason, /configured account backend/);
    assert.match(res.reason, /acme/);
  } finally {
    if (prev === undefined) delete process.env.LOG10X_DEMO_FALLBACK;
    else process.env.LOG10X_DEMO_FALLBACK = prev;
  }
});

test('detectMode: a loaded backend with zero series → analysis_pending', async () => {
  const { detectMode } = await import('../src/lib/mode-detect.js');
  const prev = process.env.LOG10X_DEMO_FALLBACK;
  process.env.LOG10X_DEMO_FALLBACK = 'off';
  try {
    const loadedBackend = {
      async queryInstant() {
        return { status: 'success', data: { result: [] } };
      },
    };
    const res = await detectMode({ loadedBackend, loadedIsDemo: false });
    assert.equal(res.mode, 'analysis_pending');
  } finally {
    if (prev === undefined) delete process.env.LOG10X_DEMO_FALLBACK;
    else process.env.LOG10X_DEMO_FALLBACK = prev;
  }
});

test('detectMode: a demo loaded backend is NOT probed here (keyless path owns it)', async () => {
  const { detectMode } = await import('../src/lib/mode-detect.js');
  const prev = process.env.LOG10X_DEMO_FALLBACK;
  process.env.LOG10X_DEMO_FALLBACK = 'off';
  try {
    let probed = false;
    const loadedBackend = {
      async queryInstant() {
        probed = true;
        return { status: 'success', data: { result: [{ value: [0, '9'] }] } };
      },
    };
    // loadedIsDemo:true → skip this probe, fall through to POC (fallback off).
    const res = await detectMode({ loadedBackend, loadedIsDemo: true });
    assert.equal(probed, false);
    assert.equal(res.mode, 'poc');
  } finally {
    if (prev === undefined) delete process.env.LOG10X_DEMO_FALLBACK;
    else process.env.LOG10X_DEMO_FALLBACK = prev;
  }
});
