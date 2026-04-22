import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/lib/customer-metrics.js';
import {
  STRUCTURAL_ALIASES,
  runCrossPillarCorrelation,
  type ConfidenceTier,
} from '../src/lib/cross-pillar-correlate.js';
import type { EnvConfig } from '../src/lib/environments.js';

// The structural validation algorithm is the load-bearing correctness property
// of the v1.4 cross-pillar bridge. These tests exercise the alias map directly
// to verify the tier-assignment paths.

test('STRUCTURAL_ALIASES covers v1.4 label pairs without k8s_node', () => {
  // v1.4 ships 4 alias groups: service, namespace, pod, container.
  assert.equal(STRUCTURAL_ALIASES.length, 4);
  // Each alias group should include the expected Log10x-side label.
  const l10xLabels = STRUCTURAL_ALIASES.flatMap(([, l10x]) => l10x);
  assert.ok(l10xLabels.includes('tenx_user_service'));
  assert.ok(l10xLabels.includes('k8s_namespace'));
  assert.ok(l10xLabels.includes('k8s_pod'));
  assert.ok(l10xLabels.includes('k8s_container'));
  // k8s_node is deliberately absent.
  assert.ok(!l10xLabels.includes('k8s_node'), 'k8s_node must not be in v1.4 structural aliases — deferred to v1.4.1');
});

test('service alias group covers common customer-side service labels', () => {
  const serviceGroup = STRUCTURAL_ALIASES.find(([, l10x]) => l10x.includes('tenx_user_service'));
  assert.ok(serviceGroup);
  const [custAliases] = serviceGroup!;
  assert.ok(custAliases.includes('service'));
  assert.ok(custAliases.includes('service.name'));
  assert.ok(custAliases.includes('dd.service'));
});

test('pod alias group covers common customer-side pod labels', () => {
  const podGroup = STRUCTURAL_ALIASES.find(([, l10x]) => l10x.includes('k8s_pod'));
  assert.ok(podGroup);
  const [custAliases] = podGroup!;
  assert.ok(custAliases.includes('pod'));
  assert.ok(custAliases.includes('kubernetes_pod_name'));
});

// ── Gap 1: tier names must be the user-facing ones, not the old
//         data-engineering internals. These live in agent replies. ──

test('ConfidenceTier union matches the renamed tier names', () => {
  // A tiny type-level check — if any of these strings drift, compile fails.
  const confirmed: ConfidenceTier = 'confirmed';
  const serviceMatch: ConfidenceTier = 'service-match';
  const unconfirmed: ConfidenceTier = 'unconfirmed';
  const coincidence: ConfidenceTier = 'coincidence';
  assert.equal(confirmed, 'confirmed');
  assert.equal(serviceMatch, 'service-match');
  assert.equal(unconfirmed, 'unconfirmed');
  assert.equal(coincidence, 'coincidence');
});

test('runCrossPillarCorrelation returns a `confirmed` tier on full label match', async () => {
  // Set up a mock backend + fake Log10x gateway response. The anchor is a
  // customer metric scoped to service=payments-svc + pod=payments-7f9d;
  // the candidate pattern carries matching tenx_user_service + k8s_pod so
  // the pair has full structural overlap → `confirmed`.
  const backend = new MockBackend();
  backend.labels = ['service', 'pod'];
  backend.labelValues = { service: ['payments-svc'], pod: ['payments-7f9d'] };
  const anchor = 'apm_request_duration_p99{service="payments-svc",pod="payments-7f9d"}';
  backend.rangeResponses[anchor] = {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [
        {
          metric: { service: 'payments-svc', pod: 'payments-7f9d' },
          values: Array.from({ length: 60 }, (_, i) => [1_000_000 + i * 60, String(1 + i)] as [number, string]),
        },
      ],
    },
  };

  // Mock the Log10x /api/v1/query* gateway via a fetch shim. We override
  // global fetch just for this test so we don't need a running gateway.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/v1/query_range')) {
      return jsonResponse({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { message_pattern: 'payments_request_ok', tenx_user_service: 'payments-svc', k8s_pod: 'payments-7f9d' },
              values: Array.from({ length: 60 }, (_, i) => [1_000_000 + i * 60, String(1 + i)]),
            },
          ],
        },
      });
    }
    if (url.includes('/api/v1/query')) {
      return jsonResponse({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                message_pattern: 'payments_request_ok',
                tenx_user_service: 'payments-svc',
                k8s_pod: 'payments-7f9d',
                k8s_namespace: 'payments',
                k8s_container: 'payments-svc',
              },
              value: [1_000_000, '10'],
            },
          ],
        },
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const env: EnvConfig = { nickname: 'test', apiKey: 'k', envId: 'e' };
    const result = await runCrossPillarCorrelation({
      env,
      backend,
      anchor: { type: 'customer_metric', value: anchor },
      joinKey: { log10xSide: 'tenx_user_service', customerSide: 'service', jaccard: 1, sharedValues: 1, log10xOnlyValues: 0, customerOnlyValues: 0 },
      window: { from: 1_000_000, to: 1_003_600, step: 60 },
      minimumConfidence: 0.1,
    });
    // Results live in the new tier buckets, not the old ones.
    const allTiers = Object.keys(result.byTier);
    assert.ok(allTiers.includes('confirmed'));
    assert.ok(allTiers.includes('service-match'));
    assert.ok(allTiers.includes('unconfirmed'));
    assert.ok(allTiers.includes('coincidence'));
    // The candidate has tenx_user_service=payments-svc + k8s_pod match →
    // join-key match plus one extra label → confirmed.
    const top = result.candidates[0];
    assert.ok(top, 'expected at least one candidate');
    assert.equal(top.tier, 'confirmed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
