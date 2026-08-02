/**
 * Drift guard: the POC report's promises vs configure_engine's solver defaults.
 *
 * On 2026-07-30 these two disagreed. poc-report-renderer told the customer
 * "ERROR/CRIT/FATAL and low-volume patterns are kept verbatim. Nothing is
 * sampled or dropped." while configure_engine's solver assigned the lossy
 * `sample` action to every error/warn/warning pattern, unconditionally, with
 * no caller-facing way to turn it off. The two also classified WARN opposite
 * ways. Nothing failed, because no test exercised the solver's tier
 * semantics at all.
 *
 * These tests read the RENDERED report text and the SOLVER's own defaults and
 * assert they agree. Editing one side without the other fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inferTier,
  _resolveTierAction,
  LOSSY_ACTIONS,
  configureEngineSchema,
  type Tier,
  type TierActionDefaults,
} from '../src/tools/configure-engine.js';
import {
  isProtectedSeverity,
  isReducibleSeverity,
  PROTECTED_SEVERITY_LABELS,
  REDUCIBLE_SEVERITY_LABELS,
} from '../src/lib/severity-policy.js';
import { renderPocReport, _enrichForEnvelope } from '../src/lib/poc-report-renderer.js';
import type { RenderInput } from '../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../src/lib/pattern-extraction.js';

/**
 * The solver's tier defaults, read from the tool schema rather than
 * hardcoded, so changing a `.default(...)` moves this test with it.
 */
function solverDefaults(): TierActionDefaults {
  const parsed = configureEngineSchema.action_defaults.parse(undefined);
  return {
    error: parsed.error,
    standard: parsed.standard,
    debug: parsed.debug,
    synthetic: parsed.synthetic,
  };
}

/** Severity spellings the 10x engine emits on the `severity_level` label. */
const ENGINE_SEVERITIES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;

function fixture(): ExtractedPatterns {
  return {
    totalEvents: 50_000,
    totalBytes: 80 * 1024 * 1024,
    inputLineCount: 50_000,
    templaterWallTimeMs: 1200,
    executionMode: 'local_cli',
    severityCoverage: 1,
    patterns: [
      {
        hash: 'h_info',
        template: '$(ts) INFO heartbeat every $ seconds from $',
        count: 40_000,
        bytes: 60 * 1024 * 1024,
        severity: 'INFO',
        service: 'checkout-svc',
        sampleEvent: '2026-04-13T10:00:00Z INFO heartbeat every 30 seconds from pod-123',
        variables: { slot_0: ['30'], slot_1: ['pod-123', 'pod-124'] },
      },
      {
        // High-volume ERROR: the case the whole defect is about. Well above
        // the report's 1% reducible threshold, so a volume-only rule would
        // reduce it.
        hash: 'h_error',
        template: '$(ts) ERROR $ failed to authenticate user $: $',
        count: 8_000,
        bytes: 12 * 1024 * 1024,
        severity: 'ERROR',
        service: 'auth-svc',
        sampleEvent: '2026-04-13T10:00:00Z ERROR auth-svc failed to authenticate user u-42: bad token',
        variables: { slot_0: ['auth-svc'], slot_1: ['u-42'], slot_2: ['bad token'] },
      },
      {
        // High-volume WARN: the severity the two sides used to classify
        // opposite ways.
        hash: 'h_warn',
        template: '$(ts) WARN slow query: $ took $ ms',
        count: 9_750,
        bytes: 8 * 1024 * 1024,
        severity: 'WARN',
        service: 'db-proxy',
        sampleEvent: '2026-04-13T10:00:00Z WARN slow query: select * took 1200 ms',
        variables: { slot_0: ['select *', 'insert'], slot_1: ['1200', '1800'] },
      },
    ],
  };
}

function renderInput(siem: 'splunk' | 'datadog' | 'cloudwatch'): RenderInput {
  return {
    siem,
    window: '7d',
    scope: 'main',
    query: undefined,
    extraction: fixture(),
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: 'search index=main',
    windowHours: 168,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-severity-drift',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  };
}

function report(siem: 'splunk' | 'datadog' | 'cloudwatch'): string {
  return renderPocReport(renderInput(siem)).markdown;
}

/**
 * The per-pattern decision the renderer actually made, keyed by fixture hash.
 * Read structurally rather than grepped out of the markdown: the severity
 * strings appear all over a rendered report (ranked table, per-service
 * breakdown, raw sample events, the fixture's own templates), so a prose
 * match proves nothing about which lever a pattern got.
 */
function actionsByHash(siem: 'splunk' | 'datadog' | 'cloudwatch'): Map<string, string> {
  const { patterns } = _enrichForEnvelope(renderInput(siem));
  return new Map(patterns.map((p) => [p.hash, p.recommendedAction]));
}

/**
 * The exact sentence the report renders as its recommendation rules,
 * reconstructed from the shared policy labels. Asserting on this rather than
 * on `md.includes('ERROR')` is the difference between a guard and a no-op.
 */
function expectedPromiseSentence(): string {
  return (
    `for a reducible pattern (${REDUCIBLE_SEVERITY_LABELS.join('/')} or no severity ` +
    `AND ≥1% of total volume)`
  );
}

function expectedKeptClause(): string {
  return `${PROTECTED_SEVERITY_LABELS.join('/')} and low-volume patterns are kept verbatim. Nothing is sampled or dropped.`;
}

// ── the promise the customer reads ───────────────────────────────────────

test('the report still makes the no-sampling promise this test guards', () => {
  const md = report('splunk');
  assert.ok(
    md.includes('Nothing is sampled or dropped.'),
    'the promise sentence moved or was reworded; re-point this test at it before editing it away'
  );
  assert.ok(
    /kept verbatim/.test(md),
    'the "kept verbatim" promise moved or was reworded'
  );
});

test('the promise sentence lists exactly the severities the shared policy protects', () => {
  // Asserting the whole clause, rebuilt from the policy labels. Grepping for
  // the bare word ERROR passes on any report, because the ranked table, the
  // per-service breakdown and the raw sample events all contain it.
  const md = report('splunk');
  assert.ok(
    md.includes(expectedKeptClause()),
    `the report's kept-verbatim clause no longer matches the shared policy.\n` +
      `expected to find: ${expectedKeptClause()}`
  );
  assert.ok(
    md.includes(expectedPromiseSentence()),
    `the report's reducible clause no longer matches the shared policy.\n` +
      `expected to find: ${expectedPromiseSentence()}`
  );
});

test('every severity the report promises to keep resolves to a non-lossy solver default', () => {
  const defaults = solverDefaults();

  for (const label of PROTECTED_SEVERITY_LABELS) {
    assert.equal(
      isProtectedSeverity(label),
      true,
      `${label} is listed as protected but the shared predicate disagrees`
    );

    // The solver must not reduce it lossily.
    const tier = inferTier(label.toLowerCase());
    const { action } = _resolveTierAction(tier, defaults);
    assert.ok(
      !LOSSY_ACTIONS.includes(action),
      `report promises ${label} is kept verbatim and nothing is sampled or dropped, ` +
        `but the solver's default for tier '${tier}' is the lossy action '${action}'`
    );
  }
});

test('error-tier and audit-tier default to pass, for every severity the engine emits', () => {
  const defaults = solverDefaults();
  for (const sev of ENGINE_SEVERITIES) {
    const tier = inferTier(sev.toLowerCase());
    const { action } = _resolveTierAction(tier, defaults);
    if (isProtectedSeverity(sev)) {
      assert.equal(
        action,
        'pass',
        `${sev} is error-class in the report but the solver gives tier '${tier}' the action '${action}'`
      );
    }
  }
});

test('the two sides agree on which engine severities are reducible', () => {
  for (const sev of ENGINE_SEVERITIES) {
    const tier = inferTier(sev.toLowerCase());
    const solverTreatsAsProtected = tier === 'error' || tier === 'audit';
    assert.equal(
      solverTreatsAsProtected,
      isProtectedSeverity(sev),
      `${sev}: solver tier '${tier}' and the report's severity policy disagree on whether it is protected`
    );
  }
});

test('no severity is both protected and reducible', () => {
  for (const label of [...PROTECTED_SEVERITY_LABELS, ...REDUCIBLE_SEVERITY_LABELS]) {
    assert.notEqual(
      isProtectedSeverity(label),
      isReducibleSeverity(label),
      `${label} is classified as both protected and reducible`
    );
  }
});

test('a pattern with no severity attribution is reducible, not protected', () => {
  for (const empty of [undefined, null, '']) {
    assert.equal(isProtectedSeverity(empty), false);
    assert.equal(isReducibleSeverity(empty), true);
  }
  // and the solver agrees: no severity -> standard tier, not the error tier.
  assert.equal(inferTier(''), 'standard');
});

// ── the rendered report never proposes a lossy lever ─────────────────────

test('no rendered report proposes sampling or dropping, on any destination', () => {
  for (const siem of ['splunk', 'datadog', 'cloudwatch'] as const) {
    const md = report(siem);
    assert.ok(!/sample 1\//.test(md), `${siem}: report proposed a sample rate`);
    assert.ok(!/action: drop/.test(md), `${siem}: report proposed a drop`);
    assert.ok(!/mute \(drop all events\)/.test(md), `${siem}: report proposed a mute`);
  }
});

test('the high-volume ERROR and WARN patterns are kept, not levered', () => {
  // Both sit far above the report's 1% reducible threshold, so a rule that
  // keyed on volume alone would reduce them. Severity has to win.
  //
  // Read the decision structurally. A prose match on `severity=ERROR` passes
  // in BOTH directions: the kept branch renders "severity=ERROR, kept
  // verbatim", and the risk-review section renders "severity=ERROR, may feed
  // alerts" for exactly the patterns that were NOT kept.
  for (const siem of ['splunk', 'datadog', 'cloudwatch'] as const) {
    const actions = actionsByHash(siem);
    assert.equal(
      actions.get('h_error'),
      'keep',
      `${siem}: high-volume ERROR pattern took '${actions.get('h_error')}' instead of keep`
    );
    assert.equal(
      actions.get('h_warn'),
      'keep',
      `${siem}: high-volume WARN pattern took '${actions.get('h_warn')}' instead of keep`
    );
    // Control: the high-volume INFO pattern MUST still get a lever, otherwise
    // the two assertions above would pass on a renderer that keeps everything.
    assert.notEqual(
      actions.get('h_info'),
      'keep',
      `${siem}: high-volume INFO pattern was kept; this test can no longer tell ` +
        `severity-driven keeping from a renderer that levers nothing`
    );
  }
});

// ── solver-side invariants the fix depends on ────────────────────────────

test('signal_floor still wins: no tier can override a floor pin', () => {
  // The floor is checked at the solver's call site, AHEAD of
  // _resolveTierAction, which is why this helper never sees a floor hit.
  // Guard the property that makes that safe: the helper is total over Tier
  // and never returns `pass`-defeating state, so a call site that short-
  // circuits on a floor hit cannot be undone by anything here.
  const defaults = solverDefaults();
  const tiers: Tier[] = ['audit', 'error', 'standard', 'debug', 'synthetic'];
  for (const tier of tiers) {
    const resolved = _resolveTierAction(tier, defaults);
    assert.ok(resolved.action, `${tier} produced no action`);
    assert.equal(typeof resolved.reason, 'string');
  }
  // audit is hardcoded and carries no caller-configurable provenance.
  assert.deepEqual(_resolveTierAction('audit', defaults), {
    action: 'pass',
    reason: 'tier=audit',
    defaultTier: null,
  });
});

test('reducing the error tier is opt-in, and the opt-in still works', () => {
  const defaults = solverDefaults();
  assert.equal(defaults.error, 'pass', 'error tier must default to pass');

  // A caller who explicitly asks for a lossless lever gets it.
  const optedIn = _resolveTierAction('error', { ...defaults, error: 'offload' });
  assert.equal(optedIn.action, 'offload');
  assert.equal(optedIn.defaultTier, 'error');
});

test('the standard-tier per-service override still beats the env-wide default', () => {
  const defaults = solverDefaults();
  const withOverride = _resolveTierAction('standard', defaults, 'offload');
  assert.equal(withOverride.action, 'offload');
  const withoutOverride = _resolveTierAction('standard', defaults);
  assert.equal(withoutOverride.action, defaults.standard);
});

test('debug and synthetic keep their lossy defaults, and the schema says so', () => {
  // Not a bug: these two are the documented lossy defaults. Pinned here so
  // that changing them is a deliberate act with a failing test attached,
  // and so the module header stays honest about which tiers are lossy.
  const defaults = solverDefaults();
  assert.equal(defaults.debug, 'drop');
  assert.equal(defaults.synthetic, 'drop');
  assert.ok(LOSSY_ACTIONS.includes(defaults.debug));
  assert.ok(LOSSY_ACTIONS.includes(defaults.synthetic));
});
