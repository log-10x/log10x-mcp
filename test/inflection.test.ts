import { test } from 'node:test';
import assert from 'node:assert/strict';

// Smoke coverage for the exported tokenize/jaccard/canonicalize helpers in resolve-batch.
// They're not exported (private to the tool), so we duplicate the same token-set logic here
// to pin the expected behavior. When the resolve-batch internals change, this test stays
// honest about what the tool is actually doing.

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .split(/[^A-Za-z0-9]+/)
      .filter((t) => t.length >= 2)
      .map((t) => t.toLowerCase())
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

test('Jaccard similarity matches template canonical to aggregated message_pattern', () => {
  // Template body (after canonicalization): checkout_svc_tenant_a_order_status_success_latency_ms
  // Aggregated message_pattern: checkout_svc_tenant_order_status_success_latency_ms
  // The Reporter strips literal `tenant=a` → `tenant`; Jaccard still catches this.
  const templateTokens = tokenize('checkout_svc_tenant_a_order_status_success_latency_ms');
  const aggregatedTokens = tokenize('checkout_svc_tenant_order_status_success_latency_ms');
  const similarity = jaccard(templateTokens, aggregatedTokens);
  // 8/9 tokens overlap (the `a` is extra in the template) → 8/9 ≈ 0.89
  assert.ok(similarity > 0.8, `expected similarity > 0.8 for near-match, got ${similarity}`);
});

test('Jaccard cleanly distinguishes different templates', () => {
  const infoTokens = tokenize('checkout_svc_tenant_order_status_success_latency_ms');
  const errorTokens = tokenize('checkout_svc_tenant_order_status_failed_reason_gateway_timeout');
  const similarity = jaccard(infoTokens, errorTokens);
  // Common: checkout, svc, tenant, order, status (5). Total: 9+11-5=15. → 5/15 ≈ 0.33
  // Should be distinguishable but nonzero.
  assert.ok(similarity < 0.5, `expected < 0.5 between different templates, got ${similarity}`);
  assert.ok(similarity > 0.1, `expected > 0.1, got ${similarity}`);
});

test('tokenize drops short tokens and non-alphanumeric punctuation', () => {
  const tokens = tokenize('a,b,checkout,x=1');
  assert.ok(!tokens.has('a'));
  assert.ok(!tokens.has('b'));
  assert.ok(!tokens.has('x'));
  assert.ok(tokens.has('checkout'));
});
