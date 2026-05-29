#!/usr/bin/env node
/**
 * Direct smoke test for the StdioMcpHarness elicitation handler.
 *
 * Why this exists: in autonomous mode, the LLM tends to front-load every
 * wizard arg into a single advise_install call — so the server never
 * needs to elicit and the new handler never gets exercised. To prove
 * the elicitation path actually runs, this script bypasses the LLM
 * entirely: spawn the harness, call advise_install with ONLY
 * snapshot_id, and read what comes back.
 *
 * Expected (with elicitation working): a plan envelope (mode='plan').
 * The server asked for each missing answer via elicitation/create, the
 * handler answered from wizard_answers, the wizard reached the plan
 * inline. NO `next_question` round trip happens.
 *
 * Negative (markdown fallback path): a `next_question` envelope. Means
 * the server's `clientSupportsElicitation()` returned false, the
 * markdown-question path ran, and elicitation is still dead code.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildUrl = (rel) => pathToFileURL(resolve(evalRoot, rel)).href;

const { loadEvalEnv } = await import(buildUrl('build-eval/env.js'));
const { buildToolHarness } = await import(buildUrl('build-eval/tool-harness.js'));

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

  // Step 2: advise_install with ONLY snapshot_id — force the server
  // into elicitation territory.
  const adviseResult = await harness.invoke('log10x_advise_install', {
    snapshot_id: snapshotId,
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
