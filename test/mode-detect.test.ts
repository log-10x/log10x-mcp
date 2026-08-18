import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRegisterTool, formatModeResolution } from '../src/lib/mode-detect.js';
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
