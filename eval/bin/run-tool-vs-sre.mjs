#!/usr/bin/env node
/**
 * Run one A/B/grader cross-pillar comparison (validation gate #5).
 *
 *   A = log10x tool (one invokeTool call)
 *   B = no-log10x SRE sub-agent (Bash, by hand, same window)
 *   G = fresh no-stake grader, 6-axis rubric, 0-10 per axis
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... PROMETHEUS_URL=http://localhost:9090 \
 *     node eval/bin/run-tool-vs-sre.mjs --anchor cart-getcart \
 *       --incident-start 2026-05-21T16:34:02Z
 *
 * Flags:
 *   --anchor <name>          Built-in anchor preset (see --list-anchors).
 *   --spec <file.json>       A ToolVsSreSpec JSON (overrides --anchor).
 *   --incident-start <ISO>   Incident T; window spans [T, now]. Default: env
 *                            TVS_INCIDENT_START or the documented cart T.
 *   --sre-model <id>         Model for arm B + (always Sonnet) grader. Default sonnet.
 *   --list-anchors           Print preset anchor ids and exit.
 *
 * Artifacts → eval/reports/tool-vs-sre/<id>/<ts>/{A-log10x.md,B-sre.md,
 * verdict.json,SUMMARY.md}. Compare A's per-axis MOVEMENT across runs.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { runToolVsSre } = await import(resolve(evalRoot, 'build-eval/tool-vs-sre.js'));

// The documented live incident (eval/cross-pillar-demo/CROSS-PILLAR-DEEP-TEST.md).
const DEFAULT_INCIDENT_START = process.env.TVS_INCIDENT_START || '2026-05-21T16:34:02Z';

// Built-in anchor presets. The cart GetCart request-log pattern is the
// canonical cross-pillar anchor: cart is a Deployment (joinable), high
// request volume from the frontend, and it's the load-incident anchor.
const ANCHOR_PRESETS = {
  'cart-getcart': {
    id: 'xpillar-cart-getcart',
    tool: 'log10x_correlate_cross_pillar',
    toolArgs: {
      anchor_type: 'log10x_pattern',
      anchor: 'cart_cartstore_ValkeyCartStore_GetCartAsync_called_userId',
      step: '60s',
    },
    question:
      'The otel-demo cart service hit a sustained load ramp: its GetCart ' +
      'request-log volume jumped ~4x at the incident start and has stayed ' +
      'elevated. Which customer (infrastructure/app) metrics co-move with ' +
      'that cart load, in what temporal direction (leads/trails/concurrent), ' +
      'and how confident are you that each is causally linked versus a ' +
      'coincidental flat metric that merely shares labels? Rank them.',
  },
};

function parseArgv(argv) {
  const out = {
    anchor: null,
    spec: null,
    incidentStart: DEFAULT_INCIDENT_START,
    sreModel: undefined,
    listAnchors: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--anchor') out.anchor = argv[++i];
    else if (a === '--spec') out.spec = argv[++i];
    else if (a === '--incident-start') out.incidentStart = argv[++i];
    else if (a === '--sre-model') out.sreModel = argv[++i];
    else if (a === '--list-anchors') out.listAnchors = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgv(process.argv);

if (opts.listAnchors) {
  for (const k of Object.keys(ANCHOR_PRESETS)) console.log(k);
  process.exit(0);
}

let spec;
if (opts.spec) {
  spec = JSON.parse(readFileSync(resolve(opts.spec), 'utf8'));
} else if (opts.anchor) {
  const preset = ANCHOR_PRESETS[opts.anchor];
  if (!preset) {
    console.error(`Unknown anchor preset: ${opts.anchor}. Use --list-anchors.`);
    process.exit(2);
  }
  spec = { ...preset };
} else {
  console.error('Provide --anchor <name> or --spec <file.json>. Use --list-anchors.');
  process.exit(2);
}
spec.incidentStartIso = spec.incidentStartIso || opts.incidentStart;

if (!process.env.PROMETHEUS_URL && !process.env.LOG10X_CUSTOMER_METRICS_URL) {
  process.env.PROMETHEUS_URL = 'http://localhost:9090';
  console.error('[tool-vs-sre] PROMETHEUS_URL unset — defaulting to http://localhost:9090');
}

const env = loadEvalEnv();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(evalRoot, 'reports', 'tool-vs-sre', spec.id, ts);

console.error(
  `[tool-vs-sre] id=${spec.id} env=${env.mode} incident=${spec.incidentStartIso} ` +
    `sre-model=${opts.sreModel ?? 'sonnet (default)'}\n[tool-vs-sre] outDir=${outDir}`
);

const v = await runToolVsSre(spec, env, outDir, { sreModel: opts.sreModel });

console.error('');
console.error(`[tool-vs-sre] window=${v.window}`);
console.error(`[tool-vs-sre] A (log10x): ${(v.a.durationMs / 1000).toFixed(1)}s, 1 call`);
console.error(
  `[tool-vs-sre] B (SRE): ${(v.b.durationMs / 1000).toFixed(1)}s, ${v.b.bashCalls ?? 0} queries` +
    (v.b.cost ? `, $${v.b.cost.usd.toFixed(4)}` : '')
);
console.error('');
const pad = (s, n) => String(s).padEnd(n);
console.error(`  ${pad('axis', 26)} ${pad('A', 4)} ${pad('B', 4)} Δ`);
for (const k of Object.keys(v.perAxis)) {
  const ax = v.perAxis[k];
  const sign = ax.delta > 0 ? '+' : '';
  console.error(`  ${pad(k, 26)} ${pad(ax.a, 4)} ${pad(ax.b, 4)} ${sign}${ax.delta}`);
}
console.error(`  ${pad('TOTAL', 26)} ${pad(v.totals.A + '/60', 4)} ${pad(v.totals.B + '/60', 4)} ${v.totals.A - v.totals.B >= 0 ? '+' : ''}${v.totals.A - v.totals.B}`);
console.error('');
console.error(`[tool-vs-sre] winner=${v.winner}  ${v.graderSummary}`);
console.error(`[tool-vs-sre] artifacts: ${outDir}`);

process.exit(0);
