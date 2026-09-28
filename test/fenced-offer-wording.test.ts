import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fencedOffer } from '../src/lib/fenced.js';

// The local-file POC read "local files, but this server had network access
// throughout over the network" because the default template appends
// "over the network". A full disclosure sentence now overrides it, and the
// footer links the guide instead of naming a path inside the repo.
test('fencedOffer: a full disclosure replaces the template', () => {
  const o = fencedOffer({ read: 'local files', disclosure: 'This POC read local files on a machine with network access. The same POC runs with no network at all.', planArgs: {} });
  assert.equal(o.disclosure, 'This POC read local files on a machine with network access. The same POC runs with no network at all.');
  assert.ok(!/over the network\. The same/.test(o.markdown.replace(o.disclosure, '')));
});

test('fencedOffer: default wording, linked offline guide', () => {
  const o = fencedOffer({ read: 'Splunk', planArgs: {} });
  assert.equal(o.disclosure, 'This POC read Splunk over the network. The same POC runs with no network at all.');
  assert.ok(o.markdown.includes('https://github.com/log-10x/log10x-mcp/blob/main/docs/fenced-poc.md'));
  assert.ok(!o.markdown.includes('`docs/fenced-poc.md`'));
});
