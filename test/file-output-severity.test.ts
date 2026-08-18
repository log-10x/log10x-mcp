/**
 * The file-output engine lane must carry severity, end to end.
 *
 * The defect this pins: the file config's encoded-output entry emits the
 * `pattern=` / `patternHash=` anchor fields through two env indirections
 * (`symbolMessageField`, `symbolMessageHashField`) — and no runner ever set
 * them. The engine then writes encoded rows with no anchors, the join from
 * encoded rows to aggregated.csv (keyed on tenx_hash) misses for every
 * pattern, and severityCoverage collapses to 0. The report's severity floor
 * fail-closes, correctly, and every SIEM POC ships "No recommendations."
 * Nothing errors anywhere — which is exactly why this needs a test that
 * runs the real engine and fails on the known-broken wiring.
 *
 * Skips when docker is unavailable (CI's packaged-engine-smoke lane has it;
 * unit-only environments do not).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { extractPatterns } from '../src/lib/pattern-extraction.js';
import { resolveRuntimeImage } from '../src/lib/runtime-image.js';

/**
 * Gate on the IMAGE being present, not merely on docker: the unit-test CI
 * runners have docker but not the 926MB engine image, and a test that
 * triggers a pull inside a unit job is a test of the network. The
 * packaged-engine-smoke job runs this file explicitly after its own script
 * has already pulled the image, so the assertion keeps CI teeth exactly
 * where the engine actually runs.
 */
function engineImageAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', resolveRuntimeImage()], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// Synthetic lines with unmistakable severity tokens, enough repetition per
// shape that the templater groups them, in the fluentd/docker wrapper the
// production path actually carries.
function wrapped(level: string, msg: string, i: number): string {
  return JSON.stringify({
    stream: 'stdout',
    log: `2026-08-18 10:00:${String(i % 60).padStart(2, '0')} +0000 [${level}]: ${msg} id=${i}`,
    kubernetes: { container_name: 'svc-a', namespace_name: 'default' },
  });
}

test('file-output lane resolves severity like the stdin lane does', { timeout: 300_000 }, async (t) => {
  if (!engineImageAvailable()) {
    t.skip('engine image not present locally; the packaged-engine-smoke job runs this after pulling it');
    return;
  }
  process.env.LOG10X_TENX_MODE = 'docker';
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) lines.push(wrapped('info', 'order shipped to warehouse', i));
  for (let i = 0; i < 60; i++) lines.push(wrapped('error', 'payment declined by gateway', i));
  const r = await extractPatterns(lines, { useFileOutput: true });
  assert.ok(r.patterns.length > 0, 'patterns extracted');
  assert.ok(
    r.severityCoverage >= 0.5,
    `file-output severityCoverage is ${r.severityCoverage.toFixed(3)} — below the report's ` +
      `fail-closed floor (0.5). The anchor env vars are not reaching the engine, so the ` +
      `aggregated join misses and every SIEM POC ships "No recommendations."`
  );
  const anchored = r.patterns.filter((p) => p.tenxHash).length;
  assert.ok(
    anchored > 0,
    'no pattern carries tenxHash: the encoded rows have no anchors, so per-pattern identity is lost'
  );
});
