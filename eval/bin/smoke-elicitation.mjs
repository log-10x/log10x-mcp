#!/usr/bin/env node
/**
 * Direct smoke test for the StdioMcpHarness elicitation handler.
 *
 * Why this exists: in autonomous mode, the LLM tends to front-load every
 * wizard arg into a single advise_install call — so the server never
 * needs to elicit and the new handler never gets exercised. To prove
 * the elicitation path actually runs, this script bypasses the LLM
 * entirely: spawn the harness, call advise_install with only the
 * snapshot_id (plus a pasted trial license), and read what comes back.
 *
 * License source — why we pass `license_source: 'paste'` upfront:
 *   Without it, the wizard's license-acquisition step hits
 *   prometheus.log10x.com/api/v1/license/demo and depends on whether
 *   ~/.log10x/credentials has Auth0 tokens on the host. The smoke
 *   test was passing only on developer machines that happened to be
 *   signed in, and was making a real prod call every run. Pasting a
 *   pre-existing trial JWT skips the entire signin / acquire path and
 *   makes the smoke test reproducible on any machine, offline.
 *
 *   JWT resolution order (first wins):
 *     1. LOG10X_SMOKE_LICENSE_JWT env var (the JWT content directly)
 *     2. LOG10X_SMOKE_LICENSE_PATH env var (file path with the JWT)
 *     3. <repos>/docker-images/license.jwt   (default dev convenience)
 *   If none resolves, the script aborts with a clear setup hint
 *   rather than falling back to the signin path that depends on
 *   machine state.
 *
 * Expected (with elicitation working): a plan envelope (mode='plan').
 * The server asked for each missing answer via elicitation/create, the
 * handler answered from wizard_answers, the wizard accepted the pasted
 * JWT, and reached the plan inline. NO `next_question` round trip
 * happens.
 *
 * Negative (markdown fallback path): a `next_question` envelope. Means
 * the server's `clientSupportsElicitation()` returned false, the
 * markdown-question path ran, and elicitation is still dead code.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildUrl = (rel) => pathToFileURL(resolve(evalRoot, rel)).href;

const { loadEvalEnv } = await import(buildUrl('build-eval/env.js'));
const { buildToolHarness } = await import(buildUrl('build-eval/tool-harness.js'));

// ─── Resolve the trial license JWT ─────────────────────────────────────

function resolveTrialLicense() {
  if (process.env.LOG10X_SMOKE_LICENSE_JWT) {
    return { jwt: process.env.LOG10X_SMOKE_LICENSE_JWT.trim(), source: 'LOG10X_SMOKE_LICENSE_JWT env var' };
  }
  const explicitPath = process.env.LOG10X_SMOKE_LICENSE_PATH;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      console.error(`FAIL: LOG10X_SMOKE_LICENSE_PATH points to a missing file: ${explicitPath}`);
      process.exit(1);
    }
    return { jwt: readFileSync(explicitPath, 'utf8').trim(), source: `LOG10X_SMOKE_LICENSE_PATH=${explicitPath}` };
  }
  // Default dev convenience: the trial JWT distributed alongside the
  // docker-images repo (sibling checkout of log10x-mcp).
  const defaultPath = resolve(evalRoot, '..', '..', 'docker-images', 'license.jwt');
  if (existsSync(defaultPath)) {
    return { jwt: readFileSync(defaultPath, 'utf8').trim(), source: defaultPath };
  }
  console.error(
    'FAIL: no trial license JWT resolvable. Set LOG10X_SMOKE_LICENSE_JWT (the JWT itself), or\n' +
      '  LOG10X_SMOKE_LICENSE_PATH (path to a file containing the JWT), or\n' +
      `  ensure ${defaultPath} exists (clone the docker-images repo as a sibling checkout).`
  );
  process.exit(1);
}

const { jwt: licenseJwt, source: jwtSource } = resolveTrialLicense();
console.log(`trial license JWT resolved from: ${jwtSource} (${licenseJwt.length} chars)`);

// ─── Run the smoke test ────────────────────────────────────────────────

const env = loadEvalEnv();
const wizardAnswers = {
  app: 'reporter',
  backends: ['log10x'],
  airgapped: false,
};

const harness = buildToolHarness(env, 'stdio', { wizardAnswers });

try {
  // Step 1: discover_env to get a snapshot_id
  const discoverResult = await harness.invoke('log10x_discover_env', { skip_aws: true });
  const snapshotMatch = discoverResult.text.match(/disc-[a-f0-9-]+/);
  if (!snapshotMatch) {
    console.error('FAIL: discover_env did not return a snapshot_id');
    console.error(discoverResult.text.slice(0, 500));
    process.exit(1);
  }
  const snapshotId = snapshotMatch[0];
  console.log(`discover_env returned snapshot=${snapshotId}`);

  // Step 2: advise_install with snapshot_id + license_source='paste' +
  // license_jwt_paste=<trial>. The 'paste' path skips
  // acquireLicenseForWizard entirely, so the wizard never hits the
  // license/demo endpoint and isn't sensitive to ~/.log10x/credentials.
  const adviseResult = await harness.invoke('log10x_advise_install', {
    snapshot_id: snapshotId,
    license_source: 'paste',
    license_jwt_paste: licenseJwt,
  });
  console.log(`advise_install result (${adviseResult.text.length} bytes):`);

  // Detect which path ran: plan envelope = elicitation succeeded,
  // next_question = markdown fallback (elicitation skipped or declined).
  const isPlan = /"mode":\s*"plan"|## Install plan|helm upgrade/i.test(adviseResult.text);
  const isNextQuestion = /"mode":\s*"next_question"|Wizard Q\d/i.test(adviseResult.text);

  if (isPlan) {
    console.log('\nPASS: wizard reached PLAN mode in one call.');
    console.log('-> Elicitation handler fired and answered every wizard question.');
    process.exit(0);
  } else if (isNextQuestion) {
    console.log('\nFAIL: wizard returned NEXT_QUESTION (markdown fallback).');
    console.log('-> Elicitation handler did NOT fire. Capability or wiring is broken.');
    console.log('\nFirst 500 chars of response:');
    console.log(adviseResult.text.slice(0, 500));
    process.exit(2);
  } else {
    console.log('\nUNCLEAR: response is neither plan nor next_question.');
    console.log('\nFirst 800 chars of response:');
    console.log(adviseResult.text.slice(0, 800));
    process.exit(3);
  }
} finally {
  await harness.shutdown();
}
