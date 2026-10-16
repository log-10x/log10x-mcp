/**
 * The round-trip proof against the engine itself: encode a sample, decode
 * the compact records, compare with the input. Gated on the engine image
 * being present locally, like file-output-severity.test.ts; the
 * packaged-engine-smoke job runs it after pulling the image.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { extractPatterns } from '../src/lib/pattern-extraction.js';
import { resolveRuntimeImage } from '../src/lib/runtime-image.js';

function engineImageAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', resolveRuntimeImage()], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function sample(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) {
    const ts = `2026-10-12 08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String((i * 37) % 1000).padStart(3, '0')}`;
    if (i % 5 === 0) {
      lines.push(`${ts} ERROR [worker-${i % 7}] Failed to process order ${10000 + i}: timeout after ${100 + (i * 13) % 900} ms`);
      lines.push(`java.util.concurrent.TimeoutException: order ${10000 + i}`);
      lines.push(`\tat com.shop.OrderService.process(OrderService.java:${10 + (i % 90)})`);
    } else {
      lines.push(`${ts} INFO [worker-${i % 7}] Processed order ${10000 + i} for user u${String((i * 7919) % 100000).padStart(5, '0')} in ${1 + (i * 17) % 900} ms`);
    }
  }
  return lines;
}

test('the compact form decodes back to the input, byte for byte', { timeout: 600_000 }, async (t) => {
  if (!engineImageAvailable()) {
    t.skip('engine image not present locally; the packaged-engine-smoke job runs this after pulling it');
    return;
  }
  process.env.LOG10X_TENX_MODE = 'docker';
  const lines = sample();
  const r = await extractPatterns(lines, { verifyRoundTrip: true });
  assert.ok(r.patterns.length > 0, 'patterns extracted');
  assert.ok(r.roundTrip, 'round trip ran');
  assert.equal(r.roundTrip!.status, 'identical', JSON.stringify(r.roundTrip));
  assert.equal(r.roundTrip!.inputLines, lines.length);
  assert.equal(r.roundTrip!.decodedLines, lines.length);
  assert.ok(r.roundTrip!.records > 0 && r.roundTrip!.records < lines.length, 'stack traces grouped into fewer records than lines');
});
