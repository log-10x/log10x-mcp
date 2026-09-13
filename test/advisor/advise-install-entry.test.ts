/**
 * The front door of `log10x_advise_install`.
 *
 * The tool list calls this tool "the SINGLE entry point for installs — call it
 * first". An agent that took that literally and called it with `{}` got a bare
 * Zod validation error naming `snapshot_id`, with no tool to call and no order
 * to call it in. Every other refusal in the wizard answers with a headline, an
 * actions list and markdown; this one now does too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeAdviseInstall, adviseInstallSchema } from '../../src/tools/advise-install.js';
import type { Environments } from '../../src/lib/environments.js';

function data(out: object): Record<string, unknown> {
  return (out as { data: Record<string, unknown> }).data;
}

function envelope(out: object): Record<string, unknown> {
  return out as unknown as Record<string, unknown>;
}

test('the schema lets an empty first call reach the tool', () => {
  // Required in the Zod parse, the empty call never reaches the handler and
  // the guidance below can never be returned.
  const parsed = adviseInstallSchema.snapshot_id.safeParse(undefined);
  assert.equal(parsed.success, true, 'snapshot_id still fails the parse when omitted');
  const description = adviseInstallSchema.snapshot_id.description ?? '';
  assert.ok(
    description.includes('log10x_discover_env'),
    `the field never says where a snapshot comes from: ${description}`,
  );
});

test('a call with no snapshot_id answers with the discover_env next step', async () => {
  const out = await executeAdviseInstall({} as Parameters<typeof executeAdviseInstall>[0], {} as Environments);
  const d = data(out);
  assert.equal(d.mode, 'missing_snapshot_id');
  assert.equal(d.ok, false);

  const md = String(d.markdown);
  assert.ok(md.includes('log10x_discover_env'), `no tool to call next:\n${md}`);
  assert.ok(md.includes('snapshot_id'), `the missing field is never named:\n${md}`);

  const env = envelope(out);
  const headline = String((env.summary as { headline?: string })?.headline ?? '');
  assert.ok(
    headline.includes('log10x_discover_env'),
    `the headline an agent quotes cold names no next tool: ${headline}`,
  );

  const actions = (env.actions ?? []) as Array<{ tool: string; role: string }>;
  assert.ok(
    actions.some((a) => a.tool === 'log10x_discover_env' && a.role === 'required-next'),
    `no required-next action pointing at discover_env: ${JSON.stringify(actions)}`,
  );

  const human = String(d.human_summary ?? '');
  assert.ok(human.includes('log10x_discover_env'), `human_summary gives no next step: ${human}`);
});

test('an empty-string snapshot_id takes the same path as an omitted one', async () => {
  const out = await executeAdviseInstall(
    { snapshot_id: '   ' } as Parameters<typeof executeAdviseInstall>[0],
    {} as Environments,
  );
  assert.equal(data(out).mode, 'missing_snapshot_id');
});

test('an unknown snapshot_id still reports as expired, not as missing', async () => {
  // The two failures stay distinct: nothing discovered yet vs discovered and
  // aged out of the 30-minute store.
  const out = await executeAdviseInstall(
    { snapshot_id: 'snap-never-minted' } as Parameters<typeof executeAdviseInstall>[0],
    {} as Environments,
  );
  assert.equal(data(out).mode, 'missing_snapshot');
});
