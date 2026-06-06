/**
 * Tests for log10x_product_qa and the underlying product-kb library.
 *
 * Strategy: write a tiny synthetic docs corpus to a tmp dir, point
 * LOG10X_PRODUCT_KB_PATH at it, reset the cached knowledge base, then
 * exercise the tool end-to-end. This keeps the tests hermetic and
 * fast — no dependence on the real config/mksite/docs tree.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetKnowledgeBaseCache,
  getKnowledgeBase,
} from '../src/lib/product-kb/index.js';
import { executeProductQa, type ProductQaPayload } from '../src/tools/product-qa.js';
import type { ChassisEnvelope } from '../src/lib/chassis-envelope.js';

// ── Fixture corpus ───────────────────────────────────────────────────────────

let CORPUS_ROOT: string;

const RECEIVER_FAQ_MD = `---
icon: material/pipe-valve
title: "Receiver"
last_reviewed: "2026-01-15"
---

The Receiver runs as a sidecar to your forwarder and filters noisy events before they ship to the SIEM.

### Overview

??? tenx-overview "What is the Receiver"

    The Receiver inspects events in-stream and applies per-pattern
    drop, sample, compact, or tier_down actions.

### Capabilities

??? tenx-capabilities "What can the Receiver do"

    The Receiver supports five enforcement modes: drop, sample, compact,
    tier_down, and offload. Each mode is per-pattern and is configured
    by the cap CSV that the Console writes.
`;

const SECURITY_FAQ_MD = `---
icon: material/shield-lock-outline
title: "Data Protection"
last_reviewed: "2026-02-01"
---

Where log processing happens, what data leaves your network, and how AI is configured.

### Where does processing happen

??? tenx-dataprotection "Where does log processing happen"

    All processing happens in YOUR infrastructure. The Reporter, Receiver,
    and Retriever all deploy in your cluster or AWS account. Log10x never
    receives raw log content.

### What data leaves your environment

??? tenx-dataprotection "What data does Log10x see"

    Zero log content. When you opt in to send metrics to the Log10x SaaS,
    only aggregated counts and byte volumes leave your network — never raw
    log lines, never PII.
`;

const PRICING_API_MD = `---
icon: material/api
title: "Pricing API"
---

The pricing API returns dollar-per-GB rates for each supported SIEM destination.

### Endpoint

GET /v1/pricing returns a JSON document with vendor name, list_price_per_gb,
and effective_date for every supported destination.
`;

const EXCLUDED_MD = `---
icon: material/eye-off
title: "Internal Only"
mcp_qa: false
---

This page should be excluded from the corpus because mcp_qa is false.
It mentions the special token QUUXZAP9 which should never appear in search results.

### Secret section

Body containing QUUXZAP9 which should never be searchable.
`;

before(() => {
  // Build a tiny corpus on disk.
  CORPUS_ROOT = mkdtempSync(join(tmpdir(), 'log10x-product-qa-'));
  mkdirSync(join(CORPUS_ROOT, 'faq', 'apps'), { recursive: true });
  mkdirSync(join(CORPUS_ROOT, 'faq', 'security'), { recursive: true });
  mkdirSync(join(CORPUS_ROOT, 'api'), { recursive: true });
  mkdirSync(join(CORPUS_ROOT, 'internal'), { recursive: true });

  writeFileSync(join(CORPUS_ROOT, 'faq', 'apps', 'receiver.md'), RECEIVER_FAQ_MD);
  writeFileSync(join(CORPUS_ROOT, 'faq', 'security', 'data-protection.md'), SECURITY_FAQ_MD);
  writeFileSync(join(CORPUS_ROOT, 'api', 'pricing.md'), PRICING_API_MD);
  writeFileSync(join(CORPUS_ROOT, 'internal', 'internal-only.md'), EXCLUDED_MD);

  process.env.LOG10X_PRODUCT_KB_PATH = CORPUS_ROOT;
  _resetKnowledgeBaseCache();
});

after(() => {
  try {
    rmSync(CORPUS_ROOT, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup on Windows.
  }
  delete process.env.LOG10X_PRODUCT_KB_PATH;
  _resetKnowledgeBaseCache();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function payload(envelope: unknown): ProductQaPayload {
  const e = envelope as ChassisEnvelope;
  return e.data.payload as ProductQaPayload;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('log10x_product_qa', () => {
  it('exact-topic hit returns that page', () => {
    const env = executeProductQa({ topic: 'faq/apps/receiver' });
    const p = payload(env);
    assert.equal(p.found, true, 'should be a hit');
    assert.equal(p.results.length, 1);
    assert.equal(p.results[0]!.topic, 'faq/apps/receiver');
    assert.equal(p.resolved_mode, 'topic');
    assert.ok(
      p.results[0]!.canonical_url.startsWith('https://docs.log10x.com/'),
      'canonical_url present',
    );
    assert.ok(p.results[0]!.matched_chunks.length > 0, 'has chunks');
  });

  it('semantic query hits the right page via keyword match', () => {
    // "data leaves network" should map to data-protection.md
    const env = executeProductQa({ query: 'what data leaves my network' });
    const p = payload(env);
    assert.equal(p.found, true);
    assert.ok(p.results.length >= 1, 'at least one result');
    assert.equal(
      p.results[0]!.topic,
      'faq/security/data-protection',
      'top hit should be data-protection page',
    );
    // The matched chunk should be the one talking about "what data leaves".
    const topChunk = p.results[0]!.matched_chunks[0]!;
    assert.ok(
      topChunk.text.toLowerCase().includes('leave') ||
        topChunk.text.toLowerCase().includes('data'),
      'matched chunk should contain relevant text',
    );
  });

  it('no-match returns found=false and populates similar_topics', () => {
    const env = executeProductQa({ query: 'xylophone unicorn quantum supremacy' });
    const p = payload(env);
    assert.equal(p.found, false, 'no match expected');
    assert.equal(p.results.length, 0);
    assert.ok(Array.isArray(p.similar_topics), 'similar_topics is array');
  });

  it('category scope narrows correctly', () => {
    // "receiver" matches the FAQ page; restricting to "api" should
    // exclude it (and there is no receiver content in /api/), so we
    // expect zero results.
    const env = executeProductQa({ query: 'receiver', category: 'api' });
    const p = payload(env);
    assert.equal(p.found, false, 'category=api should exclude faq pages');

    // Sanity check: without the category, the same query DOES hit.
    const envOpen = executeProductQa({ query: 'receiver' });
    const pOpen = payload(envOpen);
    assert.equal(pOpen.found, true, 'unscoped query should still hit');
    assert.equal(pOpen.results[0]!.topic, 'faq/apps/receiver');
  });

  it('mcp_qa:false excludes a page that would otherwise be included', () => {
    // Exact-topic lookup for the excluded page should miss.
    const envTopic = executeProductQa({ topic: 'internal/internal-only' });
    assert.equal(payload(envTopic).found, false, 'excluded page not reachable by topic');

    // Free-text search for the unique token in the excluded page
    // should also miss — the page is gone from the corpus entirely.
    const envQuery = executeProductQa({ query: 'QUUXZAP9' });
    assert.equal(payload(envQuery).found, false, 'excluded page not reachable by query');

    // And the loaded corpus should NOT contain the page at all.
    const kb = getKnowledgeBase();
    const topics = kb.pages.map((p) => p.topic);
    assert.ok(
      !topics.includes('internal/internal-only'),
      `excluded page should not be loaded; got topics: ${topics.join(', ')}`,
    );
  });
});
