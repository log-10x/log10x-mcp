import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importOptionalPeer, OptionalPeerMissingError } from '../src/lib/optional-peer.js';

test('a missing optional peer names the packages and the npx line that adds them', async () => {
  await assert.rejects(
    () => importOptionalPeer('@log10x/definitely-not-installed', 'Azure Monitor', ['@azure/monitor-query', '@azure/identity']),
    (e: unknown) =>
      e instanceof OptionalPeerMissingError &&
      /Azure Monitor needs @azure\/monitor-query and @azure\/identity/.test(e.message) &&
      /npx -y -p log10x-mcp -p @azure\/monitor-query -p @azure\/identity log10x-mcp/.test(e.message),
  );
});

test('an installed package loads', async () => {
  const mod = await importOptionalPeer<typeof import('node:path')>('node:path', 'x', ['x']);
  assert.equal(typeof mod.join, 'function');
});

test('an installed but broken package is not reported as missing', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'brokenpeer-'));
  const pkg = join(dir, 'node_modules', 'broken-peer');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'broken-peer', type: 'module', main: 'index.js' }));
  writeFileSync(join(pkg, 'index.js'), "export * from './dist/missing.js';\n");
  const { pathToFileURL } = await import('node:url');
  await assert.rejects(
    () => importOptionalPeer(pathToFileURL(join(pkg, 'index.js')).href, 'Azure Monitor', ['@azure/monitor-query']),
    (e: unknown) => !(e instanceof OptionalPeerMissingError) && /installed but failed to load/.test((e as Error).message) && /_npx/.test((e as Error).message),
  );
});
