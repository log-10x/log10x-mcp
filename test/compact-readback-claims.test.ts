/**
 * Compact read-back is per destination, never a bare "losslessly" or "fully
 * searchable".
 *
 * On Splunk a compact event expands exactly only up to the TRUNCATE the 10x
 * app sets on tenx_encoded (262,144 bytes on splunk-app main, #33); a longer
 * event is cut with no marker and rebuilds shorter. The search page loads no
 * app JavaScript, so a search-bar query reaches the full text only through
 * the app's tenxsearch command. On Elasticsearch the l1es plugin rewrites
 * match, match_phrase and multi_match; other query types see the encoded
 * form. Every rendered sentence about compact read-back comes from
 * describeCompactReadback() in lib/cost.ts, and the scan below fails if an
 * unqualified claim comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describeCompactReadback } from '../src/lib/cost.js';

test('describeCompactReadback states each destination in its own terms', () => {
  const splunk = describeCompactReadback('splunk');
  assert.match(splunk, /exactly up to 256 KB/);
  assert.match(splunk, /a longer one comes back cut/);
  assert.match(splunk, /tenxsearch/);

  const es = describeCompactReadback('elasticsearch');
  assert.match(es, /match, match_phrase and multi_match/);
  assert.match(es, /other query types see the encoded form/);
  assert.equal(describeCompactReadback('elasticsearch', { esPruned: false }), es);

  assert.match(describeCompactReadback('datadog'), /no-op on datadog/);
  for (const unknown of [undefined, null, 'loki']) {
    assert.match(describeCompactReadback(unknown), /depends on the destination's expander/);
  }
});

/** Every .ts file under src, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('no rendered string claims compact is lossless or fully searchable without the destination', () => {
  // The one allowed line is the agent guidance that forbids the bare claim.
  const allowed = /Never call it lossless or fully searchable without the destination's terms/;
  const offenders: string[] = [];
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (/losslessly|fully searchable|queryable as-is|fields stay searchable/i.test(code) && !allowed.test(code)) {
          offenders.push(`${file}:${i + 1}: ${code.slice(0, 120)}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
});
