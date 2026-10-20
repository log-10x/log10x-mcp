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
