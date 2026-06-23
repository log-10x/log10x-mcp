/**
 * Tests for the product-kb search ranking + topic lookup.
 *
 * Pins the two fixes that let a focused section on a large reference page
 * win over an incidental slug match:
 *   1. length-normalization by the MATCHED chunks' size, not the whole page;
 *   2. per-slug-token boost scaled by query coverage (a 1-of-5 slug hit is
 *      weak), and
 *   3. a `topic` lookup that, when given a `query`, returns the asked-about
 *      section rather than the page intro.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, searchIndex, lookupTopic } from '../src/lib/product-kb/search.js';
import type { Page, Chunk } from '../src/lib/product-kb/types.js';

function mkChunk(heading: string, text: string, i: number): Chunk {
  return { heading, text, chunk_id: `c#${i}`, section_index: i };
}
function mkPage(topic: string, chunks: Chunk[]): Page {
  return {
    topic,
    category: topic.split('/')[0] ?? 'misc',
    canonical_url: `https://doc.log10x.com/${topic}/`,
    summary: chunks[0]?.text.slice(0, 80) ?? '',
    last_reviewed: '2026-01-01',
    chunks,
  };
}

// A small tool page whose SLUG contains "overlay" — the false-positive that
// ranked #1 before the fix purely on the flat per-slug-token boost.
const metricOverlay = mkPage('apps/mcp/tools/metric-overlay', [
  mkChunk('Input schema', 'The metric_overlay tool draws an overlay band on a chart. overlay overlay.', 0),
]);

// A large reference page: 20 filler sections plus ONE focused section that
// actually answers the query. Before the fix the page's total length buried
// the focused chunk; after, it is normalized by its own size.
const deployChunks: Chunk[] = [
  mkChunk('', 'Deploy the Receiver to Kubernetes via Helm. Pick your forwarder below.', 0),
];
for (let i = 1; i <= 20; i++) {
  deployChunks.push(
    mkChunk(`Filler ${i}`, `Section ${i} covers helm values service account rbac probes and ports. `.repeat(6), i),
  );
}
deployChunks.push(
  mkChunk(
    'Step 3: Configure / Fluentd / b. Kustomize overlay.',
    'The kustomize overlay patches the Deployment: it adds the log10x sidecar container to ' +
      'spec.template.spec.containers and a tenx-license volume. overlay patch containers volumes.',
    21,
  ),
);
const deploy = mkPage('apps/receiver/deploy', deployChunks);

const index = buildIndex([metricOverlay, deploy]);

describe('product-kb search — ranking + topic+query', () => {
  it('ranks a focused chunk on a large page above a tiny slug-matching tool page', () => {
    const results = searchIndex(index, { query: 'kustomize overlay patch containers volumes' });
    assert.ok(results.length >= 1, 'has results');
    assert.equal(
      results[0]!.topic,
      'apps/receiver/deploy',
      `deploy should win; got: ${results.map((r) => `${r.topic}(${r.score.toFixed(1)})`).join(', ')}`,
    );
    assert.ok(
      results[0]!.matched_chunks.some((c) => c.heading.includes('Kustomize overlay')),
      'the overlay section is the matched chunk',
    );
  });

  it('still gives a single-token query that fully covers the slug its boost', () => {
    // "overlay" wholly covers the metric-overlay slug tail → it should win
    // for the bare term (coverage = 1, full weight retained).
    const results = searchIndex(index, { query: 'overlay' });
    assert.equal(results[0]!.topic, 'apps/mcp/tools/metric-overlay');
  });

  it('topic + query returns the asked-about section, not the page intro', () => {
    const hit = lookupTopic(index, 'apps/receiver/deploy', 'kustomize overlay patch containers volumes');
    assert.ok(hit, 'page found');
    assert.equal(
      hit!.matched_chunks[0]!.heading,
      'Step 3: Configure / Fluentd / b. Kustomize overlay.',
      'top chunk is the overlay section',
    );
  });

  it('topic without query returns the page intro (first chunk)', () => {
    const hit = lookupTopic(index, 'apps/receiver/deploy');
    assert.ok(hit, 'page found');
    assert.equal(hit!.matched_chunks[0]!.section_index, 0, 'first chunk is the prologue');
  });
});
