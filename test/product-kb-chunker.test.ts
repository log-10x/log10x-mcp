/**
 * Tests for the product-kb chunker's size-guarded sub-splitting.
 *
 * The chunker splits a page into H2/H3/admonition sections, then sub-splits
 * any section over MAX_CHUNK_CHARS (~4 KB) on its internal structure:
 * mkdocs content tabs, then bold sub-labels, then a hard fence-safe window.
 * These tests pin that behavior and guard the two regressions that matter:
 * small tabbed sections must NOT fragment, and FAQ admonition streams must
 * still chunk one-per-question.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/lib/product-kb/index.js';

// A code block of `n` lines (~40 chars each). n=80 → ~3.2 KB, which stays
// under the ~4 KB cap after a split, so a single tab/label is one chunk.
function yamlBlock(key: string, n: number): string {
  let out = '        ```yaml\n';
  for (let i = 0; i < n; i++) out += `        ${key}_key_${i}: some value here\n`;
  out += '        ```\n';
  return out;
}

describe('product-kb chunker — size-guarded sub-splitting', () => {
  it('splits an oversized tabbed section one chunk per forwarder, with composed headings', () => {
    const body =
      '??? tenx-config "Step 3: Configure Deployment Settings"\n\n' +
      '    Create a file my-receiver.yaml. Pick your forwarder below.\n\n' +
      '    === ":simple-fluentd: Fluentd"\n\n' + yamlBlock('fluentd', 80) + '\n' +
      '    === ":simple-vector: Vector"\n\n' + yamlBlock('vector', 80) + '\n' +
      '    === ":simple-splunk: Splunk"\n\n' + yamlBlock('splunk', 80) + '\n';

    const chunks = chunkMarkdown(body, 'apps/receiver/deploy');
    const headings = chunks.map((c) => c.heading);

    // The ~9 KB monolith is gone: every chunk is near the cap, not the whole.
    assert.ok(
      chunks.every((c) => c.text.length <= 4600),
      `no chunk should approach the unsplit size; got ${chunks.map((c) => c.text.length).join(', ')}`,
    );
    // Each forwarder is its own chunk, headed by parent + tab label.
    assert.ok(
      headings.some((h) => h.includes('Step 3: Configure Deployment Settings') && h.includes('Fluentd')),
      `expected a composed Fluentd heading; got: ${headings.join(' | ')}`,
    );
    assert.ok(headings.some((h) => h.includes('Vector')), 'Vector chunk present');
    assert.ok(headings.some((h) => h.includes('Splunk')), 'Splunk chunk present');
    // The Fluentd chunk carries the Fluentd body, not Vector's/Splunk's.
    const fluentd = chunks.find((c) => c.heading.includes('Fluentd'))!;
    assert.ok(fluentd.text.includes('fluentd_key_50'), 'Fluentd chunk carries the Fluentd body');
    // The ~200-char overlap tail may include the very start of the next chunk,
    // but a DEEP Vector line must not appear in the Fluentd chunk.
    assert.ok(!fluentd.text.includes('vector_key_50'), 'Fluentd chunk does not mix in the Vector body');
  });

  it('recurses tab -> bold sub-labels when one tab is still oversized', () => {
    // Two tabs so the section tab-splits first; the Fluentd tab (~7 KB, two
    // bold-labelled parts) must then split again into "… / Fluentd / a." and
    // "… / Fluentd / b." chunks, carrying BOTH the forwarder and the label.
    const body =
      '??? tenx-config "Step 3: Configure"\n\n' +
      '    === ":simple-fluentd: Fluentd"\n\n' +
      '        **a. Values file.** Standard options.\n\n' + yamlBlock('values', 80) + '\n' +
      '        **b. Kustomize overlay.** Patches the Deployment.\n\n' + yamlBlock('overlay', 80) + '\n' +
      '    === ":simple-vector: Vector"\n\n        a short vector note\n';

    const chunks = chunkMarkdown(body, 'apps/receiver/deploy');
    const headings = chunks.map((c) => c.heading);
    assert.ok(
      headings.some((h) => h.includes('Fluentd') && h.includes('Kustomize overlay')),
      `expected a Fluentd / Kustomize overlay heading; got: ${headings.join(' | ')}`,
    );
    assert.ok(chunks.every((c) => c.text.length <= 4600), 'all sub-chunks bounded');
  });

  it('does NOT fragment a small tabbed section', () => {
    const body =
      '??? tenx-config "Small Step"\n\n' +
      '    === "Fluentd"\n\n        a short fluentd note\n\n' +
      '    === "Vector"\n\n        a short vector note\n';
    const chunks = chunkMarkdown(body, 'apps/x/small');
    assert.equal(chunks.length, 1, `small tabbed section stays one chunk; got ${chunks.length}`);
    assert.equal(chunks[0]!.heading, 'Small Step');
    assert.ok(!chunks.some((c) => c.heading.includes(' / ')), 'no composed sub-headings for a small section');
  });

  it('preserves FAQ admonition splitting (one chunk per question)', () => {
    const body =
      '??? tenx-a "Question A"\n\n    Answer A body text.\n\n' +
      '??? tenx-b "Question B"\n\n    Answer B body text.\n';
    const chunks = chunkMarkdown(body, 'faq/apps/thing');
    const headings = chunks.map((c) => c.heading);
    assert.deepEqual(headings, ['Question A', 'Question B']);
  });

  it('window-splits an oversized section with no tabs or bold labels', () => {
    let body = '## Big Reference\n\n';
    for (let i = 0; i < 200; i++) body += `Paragraph ${i} has a handful of words to add some length here.\n\n`;
    const chunks = chunkMarkdown(body, 'engine/big');
    assert.ok(chunks.length >= 2, `oversized prose should window-split; got ${chunks.length}`);
    assert.ok(chunks.every((c) => c.heading.startsWith('Big Reference')), 'all parts keep the parent heading');
    assert.ok(chunks.every((c) => c.text.length <= 4800), 'window parts are size-bounded');
  });
});
