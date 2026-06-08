/**
 * Unit tests for log10x_investigate's GA envelope helpers.
 *
 * Covers the agent-facing fields added to the structured envelope:
 *   - parseReport: regex extraction of lead pattern, confidence, lag,
 *     chain length, co-mover count, no-signal markers
 *   - detectThresholdBasis: env-var-based calibration provenance
 *   - buildHumanSummary: paste-to-user prose for each status
 *
 * The full executeInvestigate path is not exercised here — it talks
 * to the customer TSDB and needs live data. The envelope-shape tests
 * pin the agent-facing contract without that dependency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReport,
  detectThresholdBasis,
  buildHumanSummary,
} from '../src/tools/investigate.js';

// ── parseReport: lead extraction ─────────────────────────────────────

test('parseReport: extracts lead pattern, service, confidence, lag from acute-spike markdown', () => {
  const md = `## Investigation: payments-svc, last 1h

**Investigation id**: 12345678-aaaa-bbbb-cccc-1234567890ab
**Shape**: \`acute\`
**Mode**: \`service\`

### Strongest temporal evidence (lead by lag time, not proven cause)

**Pattern**: \`dns_lookup_failures\` in \`opensearch-client\`
**Confidence**: 85% (stat:0.92 lag:1.00 chain:0.95)
**Why**: peaked 90s before the anchor, magnitude 4.2× baseline.

### Temporal chain (lead-time order, not proven cause)

1. \`dns_lookup_failures\` (\`opensearch-client\`) — peaked T-90s, magnitude 4.2× — confidence 85%
2. \`retry_storm\` (\`payments-svc\`) — peaked T-30s, magnitude 2.8× — confidence 70%

### Co-movers (lower confidence)

- \`gc_pause\` (\`payments-svc\`) — +15% vs baseline
- \`heap_pressure\` (\`payments-svc\`) — +12% vs baseline
`;
  const p = parseReport(md);
  assert.equal(p.shape, 'acute');
  assert.equal(p.mode, 'service');
  assert.equal(p.investigationId, '12345678-aaaa-bbbb-cccc-1234567890ab');
  assert.equal(p.leadPattern, 'dns_lookup_failures');
  assert.equal(p.leadService, 'opensearch-client');
  assert.ok(p.leadConfidence !== null);
  assert.ok((p.leadConfidence ?? 0) > 0.8);
  assert.equal(p.leadLagSeconds, -90, 'negative lag = candidate leads anchor');
  assert.equal(p.chainLength, 2);
  assert.equal(p.coMoverCount, 2);
  assert.equal(p.hasNoSignalMarker, false);
});

test('parseReport: returns nulls + zero counts when the report has no lead and no chain', () => {
  const md = `## Investigation: cart-svc, last 6h

**Shape**: \`acute\`
**Mode**: \`service\`

### Strongest temporal evidence (lead by lag time, not proven cause)

_No co-movers crossed the noise floor. The anchor moved but the correlation engine found no above-threshold candidates in the window and depth scope you specified._
`;
  const p = parseReport(md);
  assert.equal(p.leadPattern, null);
  assert.equal(p.leadConfidence, null);
  assert.equal(p.leadLagSeconds, null);
  assert.equal(p.chainLength, 0);
  assert.equal(p.coMoverCount, 0);
  assert.equal(p.hasNoSignalMarker, true);
});

test('parseReport: detects no-signal marker even when chain length is zero', () => {
  const md = `## Investigation: foo, last 1h

### Strongest temporal evidence (lead by lag time, not proven cause)

_No co-movers exceeded the primary confidence threshold._
`;
  const p = parseReport(md);
  assert.equal(p.hasNoSignalMarker, true);
});

test('parseReport: empty input is safe', () => {
  const p = parseReport('');
  assert.equal(p.shape, null);
  assert.equal(p.leadPattern, null);
  assert.equal(p.chainLength, 0);
  assert.equal(p.coMoverCount, 0);
  assert.equal(p.hasNoSignalMarker, false);
});

// ── detectThresholdBasis ──────────────────────────────────────────────

test('detectThresholdBasis: env var unset → unvalidated_default', () => {
  const before = process.env.LOG10X_THRESHOLDS_FILE;
  delete process.env.LOG10X_THRESHOLDS_FILE;
  try {
    assert.equal(detectThresholdBasis(), 'unvalidated_default');
  } finally {
    if (before !== undefined) process.env.LOG10X_THRESHOLDS_FILE = before;
  }
});

test('detectThresholdBasis: env var set → config_file', () => {
  const before = process.env.LOG10X_THRESHOLDS_FILE;
  process.env.LOG10X_THRESHOLDS_FILE = '/tmp/test-thresholds.json';
  try {
    assert.equal(detectThresholdBasis(), 'config_file');
  } finally {
    if (before === undefined) delete process.env.LOG10X_THRESHOLDS_FILE;
    else process.env.LOG10X_THRESHOLDS_FILE = before;
  }
});

// ── buildHumanSummary ────────────────────────────────────────────────

const emptyParsed = {
  shape: null,
  mode: null,
  investigationId: null,
  anchorPattern: null,
  leadPattern: null,
  leadService: null,
  leadConfidence: null,
  leadLagSeconds: null,
  chainLength: 0,
  coMoverCount: 0,
  hasNoSignalMarker: false,
};

test('buildHumanSummary: success with lead → strongest-evidence framing, not verdict', () => {
  const summary = buildHumanSummary(
    'payments-svc',
    '1h',
    'success',
    {
      ...emptyParsed,
      shape: 'acute',
      leadPattern: 'dns_lookup_failures',
      leadService: 'opensearch-client',
      leadConfidence: 0.85,
      leadLagSeconds: -90,
      chainLength: 2,
      coMoverCount: 3,
    },
    'unvalidated_default',
  );
  assert.match(summary, /strongest evidence/i);
  assert.match(summary, /dns lookup failures/);
  assert.match(summary, /90s earlier/);
  assert.match(summary, /correlation, not proven cause/i);
  assert.match(summary, /not yet tuned for your data/i);
});

test('buildHumanSummary: success with caller_override → no unvalidated tag', () => {
  const summary = buildHumanSummary(
    'foo',
    '1h',
    'success',
    {
      ...emptyParsed,
      shape: 'acute',
      leadPattern: 'x',
      leadConfidence: 0.9,
      leadLagSeconds: -60,
      chainLength: 1,
    },
    'config_file',
  );
  assert.doesNotMatch(summary, /unvalidated/i);
});

test('buildHumanSummary: no_signal → "nothing crossed our default match-strength floor", suggests widening', () => {
  const summary = buildHumanSummary('foo', '1h', 'no_signal', emptyParsed, 'unvalidated_default');
  assert.match(summary, /match-strength floor/i);
  assert.match(summary, /widening to 24h/i);
  assert.match(summary, /not yet tuned for your data/i);
});

test('buildHumanSummary: insufficient_data → "couldn\'t produce a usable analysis"', () => {
  const summary = buildHumanSummary('foo', '1h', 'insufficient_data', emptyParsed, 'unvalidated_default');
  assert.match(summary, /couldn't produce a usable analysis|widening the window/i);
});

test('buildHumanSummary: error → references data.error', () => {
  const summary = buildHumanSummary('foo', '1h', 'error', emptyParsed, 'unvalidated_default');
  assert.match(summary, /failed structurally|data\.error/i);
});

test('buildHumanSummary: NEVER uses "most likely root cause" verdict phrasing', () => {
  const summary = buildHumanSummary(
    'foo',
    '1h',
    'success',
    {
      ...emptyParsed,
      leadPattern: 'x',
      leadConfidence: 0.95,
      leadLagSeconds: -10,
      chainLength: 1,
    },
    'caller_override',
  );
  assert.doesNotMatch(summary, /most likely root cause/i);
  assert.doesNotMatch(summary, /\bthe cause\b/i);
});
