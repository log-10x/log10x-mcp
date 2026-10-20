import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDevCliStdin, DevCliNotInstalledError } from '../src/lib/dev-cli.js';

test('with no engine, the run fails as not installed and calls nothing (no demo-licence mint)', async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('network must not be used');
  }) as typeof fetch;
  try {
    const home = mkdtempSync(join(tmpdir(), 'nomint-'));
    process.env.HOME = home;
    process.env.LOG10X_DEMO_LICENSE_PATH = join(home, 'demo-license.json');
    process.env.LOG10X_TENX_MODE = 'local';
    process.env.LOG10X_TENX_PATH = join(home, 'no-such-tenx');
    delete process.env.TENX_LICENSE_KEY;
    delete process.env.LOG10X_API_KEY;
    await assert.rejects(() => runDevCliStdin('one line\n'), (e: unknown) => e instanceof DevCliNotInstalledError);
    assert.equal(calls, 0, 'no request may leave the machine before an engine is found');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});
