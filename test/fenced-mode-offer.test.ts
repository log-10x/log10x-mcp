/**
 * The runtime offers the mode.
 *
 * A profile nobody is told about is not a choice the product offers, and a
 * fenced run that does not hand back its own proof leaves the proof in a doc
 * the reader may never open. These tests pin the three surfaces that make the
 * high-level description true rather than aspirational:
 *
 *   1. both POC tool descriptions name the other mode;
 *   2. a networked POC discloses that it used the network and carries the
 *      fenced alternative in `actions[]`;
 *   3. a fenced POC ends with the `docker inspect` line and the Wi-Fi check.
 *
 * Plus the one that keeps surface 3 honest over time: the proof printed in
 * code and the proof printed in the docs must be the same string. A drifted
 * proof is worse than none — the reader checks it, sees a mismatch, and
 * cannot tell which half is wrong.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  fencedOffer,
  fencedVerification,
  FENCED_INSPECT_COMMAND,
  FENCED_INSPECT_EXPECTED,
  FENCED_WIFI_SENTENCE,
} from '../src/lib/fenced.js';
import { executePocFromLocal } from '../src/tools/poc-from-local.js';
import { executePocStatus, _internals as pocSiemInternals } from '../src/tools/poc-from-siem.js';

/**
 * Captured at module load. The end-to-end tests below `chdir` into a temp
 * directory (the POC writes its report relative to cwd), so anything that
 * reads a repo file has to remember where the repo was.
 */
const REPO_ROOT = process.cwd();

const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, 'default-manifest.json'), 'utf8'),
) as { tools: Record<string, { description: string }> };

// ── Surface 1: the descriptions name both modes ──

for (const tool of ['log10x_poc_from_siem_submit', 'log10x_poc_from_siem_status', 'log10x_poc_from_local']) {
  test(`${tool}: the description names the fenced mode and the tool that reaches it`, () => {
    const d = MANIFEST.tools[tool]?.description;
    assert.ok(d, `${tool} has no manifest entry`);
    assert.match(d, /FENCED/, `${tool} never names the fenced mode`);
    assert.match(d, /--network none/, `${tool} does not say what fenced means`);
    assert.match(d, /log10x_emit_sample_plan/, `${tool} does not name the tool that reaches it`);
    // An offer, not an interrogation: the description must not tell the agent
    // to ask which mode first. That turns a disclosure into a pre-flight
    // question and takes the choice out of the agent's own dialogue.
    assert.match(d, /do not ask which one first/, `${tool} does not forbid the pre-flight question`);
  });
}

test('log10x_emit_sample_plan is reachable from the POC descriptions and registered in every mode', async () => {
  const { TOOL_MODES } = await import('../src/lib/mode-detect.js');
  assert.deepEqual(TOOL_MODES.log10x_emit_sample_plan, ['always']);
});

// ── Surface 2: the networked POC discloses and offers ──

test('fencedOffer: one disclosure sentence, one alternative, no lecture', () => {
  const offer = fencedOffer({ read: 'Splunk', planArgs: { siem: 'splunk', window: '14d' } });
  assert.equal(
    offer.disclosure,
    'This POC read Splunk over the network. The same POC runs with no network at all.',
  );
  assert.equal(offer.action.tool, 'log10x_emit_sample_plan');
  assert.deepEqual(offer.action.args, { siem: 'splunk', window: '14d' });
  // `alternative`, not `recommended-next`: the POC has finished, and an agent
  // told this is the recommended next step would go and redo the work.
  assert.equal(offer.action.role, 'alternative');
});

test('the offer carries the arguments the POC actually ran with, not an empty form', () => {
  const offer = fencedOffer({
    read: 'Amazon CloudWatch Logs',
    planArgs: { siem: 'cloudwatch', window: '14d', scope: '/aws/ecs/*', target_event_count: 1_000_000 },
  });
  assert.equal(offer.action.args.scope, '/aws/ecs/*');
  assert.equal(offer.action.args.window, '14d');
});

// ── Surface 2, through the real networked tool ──

/**
 * Seed a completed snapshot rather than hold analyzer credentials in CI. The
 * offer is built from `snapshot.pull`, which the submit path fills in with
 * exactly the arguments the POC ran on — so this pins the shape of what a
 * finished networked run hands back.
 */
function seedCompleteSnapshot(id: string, pull: Record<string, unknown>): void {
  pocSiemInternals.SNAPSHOTS.set(id, {
    id,
    status: 'complete',
    progressPct: 100,
    stepDetail: 'done',
    startedAt: new Date(0).toISOString(),
    startedAtMs: Date.now() - 1000,
    reportMarkdown: '# report',
    pull,
  } as never);
}

test('a completed networked POC discloses the network and carries the fenced action with matching args', async () => {
  seedCompleteSnapshot('seed-complete', {
    siem: 'cloudwatch',
    window: '14d',
    scope: '/aws/ecs/*',
    targetEventCount: 1_000_000,
  });
  const res = (await executePocStatus({ snapshot_id: 'seed-complete' })) as unknown as {
    data: Record<string, unknown>;
    actions?: Array<{ tool: string; args: Record<string, unknown>; role?: string }>;
  };
  assert.equal(res.data.fenced_profile, false);
  const disclosed = (res.data.fenced_offer as { disclosure: string }).disclosure;
  assert.match(disclosed, /read Amazon CloudWatch Logs over the network/);
  const action = (res.actions ?? []).find((a) => a.tool === 'log10x_emit_sample_plan');
  assert.ok(action, 'a completed networked POC carries no fenced alternative');
  assert.equal(action.role, 'alternative');
  // Matching args, not an empty form.
  assert.equal(action.args.siem, 'cloudwatch');
  assert.equal(action.args.window, '14d');
  assert.equal(action.args.scope, '/aws/ecs/*');
  assert.equal(action.args.target_event_count, 1_000_000);
});

test('an analyzer with no export emitter is not offered a mode it cannot reach', async () => {
  // Sumo Logic is a listed follow-up. Offering "the same POC runs with no
  // network" and then refusing the export sells the same thing twice.
  seedCompleteSnapshot('seed-sumo', { siem: 'sumo', window: '7d', targetEventCount: 1_000 });
  const res = (await executePocStatus({ snapshot_id: 'seed-sumo' })) as unknown as {
    data: Record<string, unknown>;
    actions?: Array<{ tool: string }>;
  };
  assert.equal(res.data.fenced_offer, undefined);
  assert.ok(!(res.actions ?? []).some((a) => a.tool === 'log10x_emit_sample_plan'));
});

test('an in-flight POC discloses nothing — there is no result to disclose about', async () => {
  pocSiemInternals.SNAPSHOTS.set('seed-pulling', {
    id: 'seed-pulling',
    status: 'pulling',
    progressPct: 20,
    stepDetail: 'pulling',
    startedAt: new Date(0).toISOString(),
    startedAtMs: Date.now() - 1000,
    pull: { siem: 'cloudwatch', window: '14d', targetEventCount: 1_000 },
  } as never);
  const res = (await executePocStatus({ snapshot_id: 'seed-pulling' })) as unknown as {
    data: Record<string, unknown>;
    actions?: Array<{ tool: string }>;
  };
  assert.equal(res.data.fenced_offer, undefined);
  assert.ok(!(res.actions ?? []).some((a) => a.tool === 'log10x_emit_sample_plan'));
});

// ── Surface 3: the fenced run hands back its own proof ──

test('fencedVerification: the inspect line, its expected output, and the Wi-Fi check', () => {
  const v = fencedVerification();
  assert.equal(v.inspect_command, FENCED_INSPECT_COMMAND);
  assert.equal(v.inspect_expected, FENCED_INSPECT_EXPECTED);
  assert.equal(v.wifi_check, FENCED_WIFI_SENTENCE);
  assert.match(v.markdown, /docker inspect --format/);
  assert.match(v.markdown, /network=none/);
  assert.match(v.markdown, /Turn Wi-Fi off/);
});

test('the expected inspect output names both mounts and their modes', () => {
  assert.match(FENCED_INSPECT_EXPECTED, /network=none/);
  assert.match(FENCED_INSPECT_EXPECTED, /cap_drop=\[ALL\]/);
  assert.match(FENCED_INSPECT_EXPECTED, /\/data:ro/);
  assert.match(FENCED_INSPECT_EXPECTED, /\/out:rw/);
});

// ── The proof in code and the proof in the docs are the same string ──

test('docs/fenced-poc.md prints exactly the inspect command and output the code prints', () => {
  const docs = readFileSync(join(REPO_ROOT, 'docs', 'fenced-poc.md'), 'utf8');
  assert.ok(
    docs.includes(FENCED_INSPECT_COMMAND),
    'the docs no longer print the inspect command the fenced run hands back — a proof that differs ' +
      'from the documented proof is worse than none, because the reader cannot tell which half is wrong',
  );
  assert.ok(docs.includes(FENCED_INSPECT_EXPECTED), 'the docs no longer print the expected output');
});

// ── End to end through the real tool, both modes ──

const FIXTURE_LINES = Array.from(
  { length: 400 },
  (_, i) => `2026-08-27T12:00:00Z INFO checkout order=${i} amount=${i % 97} latency=${i % 31}ms`,
).join('\n');

let tmpDir: string;
let cwd: string;

beforeEach(async () => {
  const { promises: fs } = await import('fs');
  const os = await import('os');
  const path = await import('path');
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fenced-offer-'));
  await fs.writeFile(path.join(tmpDir, 'app.log'), FIXTURE_LINES);
  cwd = process.cwd();
  process.chdir(tmpDir);
  delete process.env.TENX_AIRGAPPED;
  delete process.env.LOG10X_FENCED;
});

afterEach(async () => {
  process.chdir(cwd);
  delete process.env.TENX_AIRGAPPED;
  delete process.env.LOG10X_FENCED;
  const { promises: fs } = await import('fs');
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * These two need a local engine, which CI does not have. Skip rather than
 * fail: the assertions above already pin the copy and the wiring, and this
 * pair exists to catch the case where the block is built but never reaches
 * the envelope.
 */
const engineAvailable =
  Boolean(process.env.LOG10X_TENX_PATH) || process.env.LOG10X_INTEGRATION_TESTS === '1';

test(
  'unfenced: the local POC envelope carries the disclosure and the fenced action',
  { skip: engineAvailable ? false : 'no local engine (set LOG10X_TENX_PATH or LOG10X_INTEGRATION_TESTS=1)' },
  async () => {
    const out = await executePocFromLocal({ source: 'file', paths: [tmpDir], window: '1h' });
    const env = out as { data: Record<string, unknown>; actions?: Array<{ tool: string; role?: string }> };
    assert.equal(env.data.fenced_profile, false);
    const offer = env.data.fenced_offer as { disclosure: string } | undefined;
    assert.ok(offer, 'no fenced_offer on an unfenced run');
    assert.match(offer.disclosure, /The same POC runs with no network at all\./);
    const action = (env.actions ?? []).find((a) => a.tool === 'log10x_emit_sample_plan');
    assert.ok(action, 'no log10x_emit_sample_plan action on an unfenced run');
    assert.equal(action.role, 'alternative');
    assert.match(String(env.data.markdown), /runs with no network at all/);
  },
);

test(
  'fenced: the local POC output ends with its own verification, and makes no offer',
  { skip: engineAvailable ? false : 'no local engine (set LOG10X_TENX_PATH or LOG10X_INTEGRATION_TESTS=1)' },
  async () => {
    process.env.TENX_AIRGAPPED = 'true';
    const out = await executePocFromLocal({ source: 'file', paths: [tmpDir], window: '1h' });
    const env = out as { data: Record<string, unknown>; actions?: Array<{ tool: string }> };
    assert.equal(env.data.fenced_profile, true);
    assert.equal(env.data.fenced_offer, undefined, 'a fenced run must not offer the mode it is in');
    const v = env.data.fenced_verification as { inspect_command: string } | undefined;
    assert.ok(v, 'no fenced_verification on a fenced run');
    assert.equal(v.inspect_command, FENCED_INSPECT_COMMAND);
    assert.match(String(env.data.markdown), /docker inspect --format/);
    assert.match(String(env.data.markdown), /Turn Wi-Fi off/);
    assert.ok(
      !(env.actions ?? []).some((a) => a.tool === 'log10x_emit_sample_plan'),
      'a fenced run must not carry the fenced alternative',
    );
  },
);
