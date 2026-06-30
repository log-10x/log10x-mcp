// Adversarial cross-tool rate-consistency harness.
//
// Scenario (demo-shaped):
//   env.analyzer    = 'cloudwatch'   (the ACTUAL pipeline destination)
//   env.analyzerCost= 1.50           (customer's CloudWatch ACCOUNT rate, from envs.json)
//   siem_lens       = 'splunk'       (prospect evaluates against THEIR stack)
//
// Splunk list = $6/GB, CloudWatch list = $0.50/GB (DEFAULT_ANALYZER_COST_PER_GB).
//
// The fix under test: under the lens, every cost tool must SKIP the $1.50
// envs.json account rate (rungs 2/3) and land on the splunk list price ($6).
// Unlensed, every tool must land on the same $1.50 account rate.
//
// We import the REAL compiled resolveRate / resolveSiemLens / destinationFromEnvAnalyzer
// from build/ and replicate each tool's EXACT call signature at its rate-resolution
// site (verbatim destination + lensed combination), so this exercises the production
// path, not a paraphrase of it.

import { resolveRate, destinationFromEnvAnalyzer } from '../build/lib/rate-resolution.js';
import { resolveSiemLens } from '../build/lib/siem/lens.js';

// ---- Scenario fixtures ----------------------------------------------------
const env = {
  name: 'demo',
  analyzer: 'cloudwatch',   // actual destination
  analyzerCost: 1.50,       // envs.json customer account rate (CloudWatch)
};

// No explicit caller rate arg (effective_ingest_per_gb / analyzerCost) in any
// of these runs — the whole point is to test the envs.json-skip-under-lens path.
const noRateArgs = { effective_ingest_per_gb: undefined, analyzerCost: undefined };

// Guard: LOG10X_ANALYZER_COST env var must be clear, else rung 3 would mask the test.
if (process.env.LOG10X_ANALYZER_COST) {
  console.error(`REFUSING: LOG10X_ANALYZER_COST=${process.env.LOG10X_ANALYZER_COST} is set; would contaminate the test.`);
  process.exit(2);
}

// ---- Per-tool drivers -----------------------------------------------------
// Each driver replicates how that tool computes (a) its lens and (b) the
// destination + lensed args it feeds resolveRate. Verbatim from the call sites.

function driveTopPatterns(siemLensArg) {
  // src/tools/top-patterns.ts:183-189
  const lens = resolveSiemLens(siemLensArg, env.analyzer);
  const r = resolveRate(
    noRateArgs,
    env,
    lens.effective ?? destinationFromEnvAnalyzer(env),
    { lensed: lens.lensed },
  );
  return { lens, rate: r };
}

function driveSavings(siemLensArg) {
  // src/tools/savings.ts:134 + 245-250
  const lens = resolveSiemLens(siemLensArg, env.analyzer);
  const r = resolveRate(
    noRateArgs,
    env,
    lens?.effective ?? destinationFromEnvAnalyzer(env),
    { lensed: lens?.lensed === true },
  );
  return { lens, rate: r };
}

function driveEstimateSavings(siemLensArg) {
  // src/tools/estimate-savings.ts:1833-1837 then 1030-1035 (forecast path).
  // The executor copies siem_lens into args.destination when destination is
  // absent, resolves the lens from (siem_lens, env.analyzer, destination),
  // and threads `destination = lensRes.effective` + `lensed = lensRes.lensed`
  // into runEstimateForecast, which calls resolveRate(args, env, args.destination, {lensed}).
  const args = { siem_lens: siemLensArg, destination: undefined };
  // estimate-savings.ts:1833 — siem_lens copied into args.destination when absent.
  if (args.siem_lens && !args.destination) args.destination = args.siem_lens;
  // estimate-savings.ts:1837 — lens resolved from (siem_lens, env.analyzer, destination).
  const lensRes = resolveSiemLens(args.siem_lens, env.analyzer, args.destination);
  // estimate-savings.ts:1960-1962 — when args.destination is set, the `destination`
  // var fed to runEstimateForecast IS args.destination (the lens arg), NOT
  // lensRes.effective. When unlensed (no siem_lens), args.destination is undefined
  // and the executor auto-detects via resolveSiemSelection; here we model that
  // auto-detect as the env's actual destination (cloudwatch), matching the demo.
  const forecastDestination = args.destination ?? destinationFromEnvAnalyzer(env);
  // estimate-savings.ts:1030-1035 (inside runEstimateForecast) — resolveRate(args, env, args.destination, {lensed}).
  const r = resolveRate(
    { effective_ingest_per_gb: undefined },
    env,
    forecastDestination,
    { lensed: lensRes.lensed === true },
  );
  return { lens: lensRes, rate: r };
}

function driveServices(siemLensArg) {
  // src/tools/services.ts:300-304. NOTE: services has NO siem_lens in its schema
  // and passes NO lensed option — it always prices the env's actual destination.
  // We still pass the requested lens to expose whether it is honored.
  const lensSupported = false; // services schema has no siem_lens
  const r = resolveRate(
    noRateArgs,
    env,
    destinationFromEnvAnalyzer(env), // always actual destination
    // no {lensed} option -> undefined -> rungs 2/3 NOT skipped
  );
  return { lens: { lensed: false, effective: 'cloudwatch', note: 'services: siem_lens unsupported' }, rate: r, lensSupported };
}

// ---- Run both modes -------------------------------------------------------
function row(tool, siemLensArg) {
  const driver = { top_patterns: driveTopPatterns, savings: driveSavings, estimate_savings: driveEstimateSavings, services: driveServices }[tool];
  const { lens, rate } = driver(siemLensArg);
  return {
    tool,
    requested_lens: siemLensArg ?? '(none)',
    lens_lensed: lens.lensed,
    lens_effective: lens.effective,
    resolved_rate: rate.rate_per_gb,
    rate_source: rate.source,
    origin: rate.origin,
  };
}

const tools = ['estimate_savings', 'top_patterns', 'services', 'savings'];

console.log('\n=== UNLENSED (no siem_lens; actual destination = cloudwatch, account rate = $1.50) ===');
const unlensed = tools.map((t) => row(t, undefined));
console.table(unlensed);

console.log('\n=== LENSED to splunk (siem_lens = "splunk"; expect $6 splunk list, skipping $1.50) ===');
const lensed = tools.map((t) => row(t, 'splunk'));
console.table(lensed);

// ---- Assertions -----------------------------------------------------------
let pass = true;
const fails = [];

// Unlensed: every tool agrees on the $1.50 customer_supplied account rate.
const unlensedRates = new Set(unlensed.map((r) => r.resolved_rate));
const unlensedSources = new Set(unlensed.map((r) => r.rate_source));
if (!(unlensedRates.size === 1 && unlensedRates.has(1.5))) {
  pass = false; fails.push(`UNLENSED rates disagree or != 1.5: ${[...unlensedRates].join(', ')}`);
}
if (!(unlensedSources.size === 1 && unlensedSources.has('customer_supplied'))) {
  pass = false; fails.push(`UNLENSED rate_source disagree or != customer_supplied: ${[...unlensedSources].join(', ')}`);
}

// Lensed: every cost tool agrees on the $6 splunk list, skipping $1.50.
const lensedRates = new Set(lensed.map((r) => r.resolved_rate));
const lensedSources = new Set(lensed.map((r) => r.rate_source));
const lensAware = lensed.filter((r) => r.tool !== 'services');
const lensAwareRates = new Set(lensAware.map((r) => r.resolved_rate));
const lensAwareSources = new Set(lensAware.map((r) => r.rate_source));

if (!(lensAwareRates.size === 1 && lensAwareRates.has(6))) {
  pass = false; fails.push(`LENSED (lens-aware) rates disagree or != 6: ${[...lensAwareRates].join(', ')}`);
}
if (!(lensAwareSources.size === 1 && lensAwareSources.has('list_price'))) {
  pass = false; fails.push(`LENSED (lens-aware) rate_source disagree or != list_price: ${[...lensAwareSources].join(', ')}`);
}
// None of the lens-aware tools may leak the $1.50 account rate under the lens.
for (const r of lensAware) {
  if (r.resolved_rate === 1.5) { pass = false; fails.push(`LENSED ${r.tool} leaked the $1.50 account rate under the lens`); }
}

// services: report whether it honors the lens (informational + strict check).
const svcLensed = lensed.find((r) => r.tool === 'services');
const servicesHonorsLens = svcLensed.resolved_rate === 6;

console.log('\n=== VERDICT ===');
console.log('Lens-aware tools (estimate_savings, top_patterns, savings) all agree under lens:', lensAwareRates.size === 1 && lensAwareRates.has(6));
console.log('services honors siem_lens (resolves $6):', servicesHonorsLens, '(services schema has NO siem_lens arg)');
console.log('ALL four cost tools agree under lens:', lensedRates.size === 1 && lensedRates.has(6) && lensedSources.size === 1);

if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log('  -', f); }

// Emit machine-readable summary for the report.
console.log('\nJSON_SUMMARY_BEGIN');
console.log(JSON.stringify({ unlensed, lensed, all_four_agree_lensed: lensedRates.size === 1 && lensedRates.has(6) && lensedSources.size === 1, lens_aware_agree: lensAwareRates.size === 1 && lensAwareRates.has(6), services_honors_lens: servicesHonorsLens, fails }, null, 2));
console.log('JSON_SUMMARY_END');

process.exit(pass && servicesHonorsLens ? 0 : 1);
