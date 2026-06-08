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
