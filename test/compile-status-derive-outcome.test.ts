/**
 * deriveOutcome: the status truth-table for compile/link jobs, including the
 * two field-measured traps:
 *  - a LINK over a huge units tree times out its scan-traversal phase
 *    (engine success:false, exit 1) while Link completes and writes a
 *    perfect tar — must be `success`, not `partial`;
 *  - a github pull against a nonexistent ref scans zero files with engine
 *    success:true — must be `no_signal`, never `success`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deriveOutcome } from '../src/tools/compile-status.js';

const base = {
  terminal: true,
  timedOut: false,
  kind: 'compile' as const,
  mode: 'docker' as const,
  exitCode: 0,
  engineSuccess: undefined as boolean | undefined,
  phases: undefined,
  producedSymbols: true,
  hasLibrary: true,
};

test('running job is partial', () => {
  const r = deriveOutcome({ ...base, terminal: false });
  assert.equal(r.jobStatus, 'running');
  assert.equal(r.chassisStatus, 'partial');
});

test('timed-out job is error', () => {
  const r = deriveOutcome({ ...base, timedOut: true });
  assert.equal(r.jobStatus, 'timed_out');
  assert.equal(r.chassisStatus, 'error');
});

test('clean docker compile is success', () => {
  const r = deriveOutcome(base);
  assert.equal(r.chassisStatus, 'success');
});

test('tag-pull no-op: clean exit, zero symbols -> no_signal, never success', () => {
  const r = deriveOutcome({ ...base, producedSymbols: false, hasLibrary: false });
  assert.equal(r.jobStatus, 'completed');
  assert.equal(r.chassisStatus, 'no_signal');
});

test('LINK with scan-phase timeout but Link Completed + library -> success', () => {
  const r = deriveOutcome({
    ...base,
    kind: 'link',
    exitCode: 1,
    engineSuccess: false,
    phases: [
      { operation: 'Scan', status: 'Failed', errors: 0 },
      { operation: 'Link', status: 'Completed', errors: 0 },
    ],
  });
  assert.equal(r.jobStatus, 'completed');
  assert.equal(r.chassisStatus, 'success');
});

test('LINK with Link phase errors stays failed/partial', () => {
  const r = deriveOutcome({
    ...base,
    kind: 'link',
    exitCode: 1,
    engineSuccess: false,
    phases: [{ operation: 'Link', status: 'Completed', errors: 3 }],
  });
  assert.equal(r.jobStatus, 'failed');
  assert.equal(r.chassisStatus, 'partial');
});

test('LINK phase override requires a non-empty library', () => {
  const r = deriveOutcome({
    ...base,
    kind: 'link',
    exitCode: 1,
    engineSuccess: false,
    producedSymbols: true,
    hasLibrary: false,
    phases: [{ operation: 'Link', status: 'Completed', errors: 0 }],
  });
  assert.equal(r.chassisStatus, 'partial');
});

test('COMPILE job does not get the link-phase override', () => {
  const r = deriveOutcome({
    ...base,
    kind: 'compile',
    exitCode: 1,
    phases: [{ operation: 'Link', status: 'Completed', errors: 0 }],
  });
  assert.equal(r.jobStatus, 'failed');
  assert.equal(r.chassisStatus, 'partial');
});

test('local mode falls back to engine success flag', () => {
  const r = deriveOutcome({ ...base, mode: 'local', exitCode: null, engineSuccess: true });
  assert.equal(r.chassisStatus, 'success');
  const r2 = deriveOutcome({ ...base, mode: 'local', exitCode: null, engineSuccess: false });
  assert.equal(r2.chassisStatus, 'partial');
});
