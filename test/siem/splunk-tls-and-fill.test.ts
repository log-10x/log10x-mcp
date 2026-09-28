import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomTimeBuckets } from '../../src/lib/siem/_sampling.js';
import { describeSplunkError, splunkInsecure } from '../../src/lib/siem/splunk.js';

test('one bucket is the whole window (the POC fill pass relies on it)', () => {
  assert.deepEqual(randomTimeBuckets(1000, 5000, 1), [{ fromMs: 1000, toMs: 5000, index: 0 }]);
});

test('a self-signed search head names the cause and the fix', () => {
  const e = Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed certificate in certificate chain' } });
  const m = describeSplunkError(e);
  assert.match(m, /SELF_SIGNED_CERT_IN_CHAIN/);
  assert.match(m, /SPLUNK_INSECURE=1/);
});

test('a refused connection points at host and port', () => {
  const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8089' } });
  assert.match(describeSplunkError(e), /management port/);
});

test('SPLUNK_INSECURE is opt-in', () => {
  const prev = process.env.SPLUNK_INSECURE;
  delete process.env.SPLUNK_INSECURE; assert.equal(splunkInsecure(), false);
  process.env.SPLUNK_INSECURE = '1'; assert.equal(splunkInsecure(), true);
  if (prev === undefined) delete process.env.SPLUNK_INSECURE; else process.env.SPLUNK_INSECURE = prev;
});
