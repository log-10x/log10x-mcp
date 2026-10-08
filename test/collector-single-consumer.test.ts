import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine groups multi-line events from consecutive records, so every
// generated Collector exporter that hands records to the engine must send them
// with one consumer: the Collector's default of ten sends batches concurrently
// and the engine receives them out of order.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sources = ['src/lib/advisor/reporter-forwarders.ts', 'src/lib/offload-recipes.ts'];

test('every generated exporter to the engine sends with one consumer', () => {
  let blocks = 0;
  for (const rel of sources) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const name = line.trim();
      if (name !== 'otlp/tenx:' && name !== 'otlp/engine:') return;
      if (!/endpoint: (127\.0\.0\.1:4317|\$\{engine\})/.test(lines[i + 1] ?? '')) return;
      const indent = line.length - line.trimStart().length;
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
        block.push(l.trim());
      }
      blocks++;
      assert.ok(block.includes('num_consumers: 1'), `${rel}:${i + 1} ${name} has no num_consumers: 1`);
    });
  }
  assert.equal(blocks, 4);
});
