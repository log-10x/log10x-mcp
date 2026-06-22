/**
 * pattern-df.ts — document-frequency discriminator-first naming (Layer 2).
 *
 * Property-based: exact output depends on df counts over the corpus, so we
 * assert structural properties (tail discriminator surfaces, envelope run
 * dropped, short names verbatim, guards fire, identity untouched) rather
 * than brittle exact strings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizePattern,
  buildDfContext,
  buildDisplayName,
  dedupeVisibleNames,
  MIN_CORPUS,
  type DfContext,
  type NameableRow,
} from '../src/lib/pattern-df.js';

const OTEL_ENVELOPE =
  't_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id';

// OTel-collector-shaped names: long shared envelope, distinct TAIL token.
const OTEL_TAILS = [
  'opensearch', 'kafkaexporter', 'prometheusremotewrite', 'loadbalancing',
  'batchexporter', 'jaegerexporter', 'zipkinexporter', 'fileexporter',
  'otlphttp', 'awsxray', 'datadogexporter', 'splunkhec',
  'elasticsearchexporter', 'kineticaexporter', 'clickhouseexporter',
  'cassandraexporter', 'influxdbexporter', 'sapmexporter',
];
function otelName(tail: string): string {
  return `terror_v_logger_go_failed_${OTEL_ENVELOPE}_${tail}`;
}

const SHORT_CLEAN = ['Charge_request_received', 'Transaction_complete'];

// Non-OTel: Java/MDC + k8s, with camelCase that must be preserved verbatim.
const JAVA_K8S = [
  'com_acme_payment_PaymentServiceImpl_processPayment_failed_NullPointerException',
  'com_acme_order_OrderServiceImpl_placeOrder_failed_TimeoutException',
  'com_acme_payment_PaymentServiceImpl_refund_failed_IllegalStateException',
  'io_k8s_kubelet_pod_Failed_to_pull_image_ImagePullBackOff_nginx',
  'io_k8s_kubelet_pod_Failed_to_pull_image_ImagePullBackOff_redis',
];

// Full corpus >= MIN_CORPUS so df engages.
const CORPUS = [
  ...OTEL_TAILS.map(otelName),
  ...SHORT_CLEAN,
  ...JAVA_K8S,
];
function freshDf(): DfContext {
  const df = buildDfContext(CORPUS);
  assert.ok(df.patternCount >= MIN_CORPUS, `corpus must exceed floor: ${df.patternCount}`);
  return df;
}

const W = 44;

test('buildDfContext counts DISTINCT patterns (repeat within a name counts once)', () => {
  const df = buildDfContext([
    'a_a_a_b', // a appears 3x in one pattern -> df(a) counts this pattern ONCE
    'a_c',
    'd_e',
  ]);
  assert.equal(df.patternCount, 3);
  assert.equal(df.dfMap.get('a'), 2); // patterns 1 and 2
  assert.equal(df.dfMap.get('b'), 1);
  assert.equal(df.dfMap.get('d'), 1);
});

test('Layer 2: tail discriminator surfaces, envelope run is dropped', () => {
  const df = freshDf();
  const { display_name } = buildDisplayName(otelName('opensearch'), { df, width: W });
  assert.ok(display_name.includes('opensearch'), `tail kept: ${display_name}`);
  // The high-df envelope run must NOT appear as a contiguous block.
  assert.ok(!display_name.includes('resource service instance id'), `envelope dropped: ${display_name}`);
  assert.ok([...display_name].length <= W, `within budget: ${display_name}`);
});

test('Layer 2: the 18 OTel names render pairwise-distinct', () => {
  const df = freshDf();
  const names = OTEL_TAILS.map((t) => buildDisplayName(otelName(t), { df, width: W }).display_name);
  const set = new Set(names.map((n) => n.toLowerCase()));
  assert.equal(set.size, OTEL_TAILS.length, `collisions:\n${names.join('\n')}`);
});

test('guard (b) length-gate: short clean names returned verbatim even with df', () => {
  const df = freshDf();
  const a = buildDisplayName('Charge_request_received', { df, width: W });
  assert.equal(a.display_name, 'Charge request received');
  const b = buildDisplayName('Transaction_complete', { df, width: W });
  assert.equal(b.display_name, 'Transaction complete');
});

test('guard (c) min-corpus floor: thin corpus degrades to Layer 1 (full-name mid-ellipsis)', () => {
  const tiny = buildDfContext(CORPUS.slice(0, 5)); // < MIN_CORPUS
  const { display_name, display_tokens } = buildDisplayName(otelName('opensearch'), {
    df: tiny,
    width: W,
  });
  // Layer 1 keeps the original head -> starts with the envelope lead, NOT a discriminator.
  assert.ok(display_name.startsWith('terror'), `layer1 head: ${display_name}`);
  assert.ok(display_name.includes('…'));
  // Without a usable corpus nothing is classified distinctive.
  assert.ok(display_tokens.every((t) => t.distinctive === false));
});

test('guard (c) no df at all: Layer 1', () => {
  const { display_name } = buildDisplayName(otelName('batchexporter'), { width: W });
  assert.ok(display_name.startsWith('terror'));
  assert.ok(display_name.includes('…'));
});

test('guard (a) never blank: an all-boilerplate name falls back, never empty', () => {
  // A name made only of high-df envelope tokens -> zero survivors.
  const df = freshDf();
  const allBoiler = `terror_v_logger_go_failed_${OTEL_ENVELOPE}`;
  const { display_name } = buildDisplayName(allBoiler, { df, width: W });
  assert.ok(display_name.length > 0, 'never blank');
});

test('camelCase preserved verbatim (no Title-casing)', () => {
  const df = freshDf();
  const sm = 'com_acme_payment_PaymentServiceImpl_processPayment_failed_NullPointerException';
  const { display_name, display_tokens } = buildDisplayName(sm, { df, width: 60 });
  assert.ok(display_tokens.some((t) => t.text === 'PaymentServiceImpl'));
  assert.ok(display_tokens.some((t) => t.text === 'processPayment'));
  // Whatever survives keeps its case.
  assert.ok(!display_name.includes('Paymentserviceimpl'));
  assert.ok(!display_name.includes('Processpayment'));
});

test('non-OTel sanity (Java/k8s): discriminators surface, not OTel-specific', () => {
  const df = freshDf();
  const pay = buildDisplayName(JAVA_K8S[0], { df, width: 60 }).display_name;
  // The distinguishing exception / method must surface.
  assert.ok(/NullPointerException|processPayment|PaymentServiceImpl/.test(pay), pay);
  const nginx = buildDisplayName(JAVA_K8S[3], { df, width: W }).display_name;
  const redis = buildDisplayName(JAVA_K8S[4], { df, width: W }).display_name;
  assert.notEqual(nginx.toLowerCase(), redis.toLowerCase());
  assert.ok(nginx.includes('nginx') && redis.includes('redis'));
});

test('output contract: display_tokens is the full token list, identity untouched', () => {
  const df = freshDf();
  const sm = otelName('opensearch');
  const { display_tokens } = buildDisplayName(sm, { df, width: W });
  assert.equal(display_tokens.length, tokenizePattern(sm).length);
  for (const t of display_tokens) {
    assert.equal(typeof t.text, 'string');
    assert.equal(typeof t.distinctive, 'boolean');
  }
  // The tail token is classified distinctive; the envelope 'service' is not.
  assert.equal(display_tokens.find((t) => t.text === 'opensearch')?.distinctive, true);
  assert.equal(display_tokens.find((t) => t.text === 'service')?.distinctive, false);
});

test('determinism = same df -> same display_name (cross-surface guarantee)', () => {
  const df = freshDf();
  const sm = otelName('kafkaexporter');
  const a = buildDisplayName(sm, { df, width: W }).display_name;
  const b = buildDisplayName(sm, { df, width: W }).display_name;
  assert.equal(a, b);
});

test('guard (d) dedupeVisibleNames: appends differing token, then hash4 last resort', () => {
  // Two rows that collapsed to the same display_name but differ in a token.
  const rows: NameableRow[] = [
    {
      display_name: 'failed export',
      display_tokens: [
        { text: 'failed', distinctive: false },
        { text: 'export', distinctive: true },
        { text: 'kafka', distinctive: true },
      ],
      pattern_hash: 'AAAA1111',
    },
    {
      display_name: 'failed export',
      display_tokens: [
        { text: 'failed', distinctive: false },
        { text: 'export', distinctive: true },
        { text: 'redis', distinctive: true },
      ],
      pattern_hash: 'BBBB2222',
    },
  ];
  dedupeVisibleNames(rows, null);
  assert.notEqual(rows[0].display_name.toLowerCase(), rows[1].display_name.toLowerCase());
  assert.ok(rows[0].display_name.includes('kafka'));
  assert.ok(rows[1].display_name.includes('redis'));

  // No differing token available -> hash4 suffix guarantees divergence.
  const twins: NameableRow[] = [
    { display_name: 'same', display_tokens: [{ text: 'same', distinctive: false }], pattern_hash: 'CcCcDdDd' },
    { display_name: 'same', display_tokens: [{ text: 'same', distinctive: false }], pattern_hash: 'EeEeFfFf' },
  ];
  dedupeVisibleNames(twins, null);
  assert.notEqual(twins[0].display_name, twins[1].display_name);
  assert.ok(twins[0].display_name.includes('#CcCc'));
  assert.ok(twins[1].display_name.includes('#EeEe'));
});
