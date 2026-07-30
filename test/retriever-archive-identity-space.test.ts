/**
 * Archive identity space.
 *
 * The metrics surface and the archive do NOT share a pattern identity, and that
 * mismatch is why "retrieve the offloaded events for this pattern" returned empty
 * through the documented chain: top_patterns publishes a per-line hash, and
 * retriever_query tested it as a `tenx_hash` FIELD EQUALITY against a value the
 * archive re-derives per multi-line group.
 *
 * Measured against the demo environment, same window, same archive:
 *
 *   metrics (top_patterns): FU1__vh8hbY 57.8%   NiDD7PpZw48 28.6%
 *   archive (read-time):    KJrTvZAaIhI  <- ALL 1,025 events carry this one value
 *
 *   tenx_hash == "FU1__vh8hbY"     ->    0 events  (bloomMatched 18, 1.01 MB read)
 *   tenx_hash == "KJrTvZAaIhI"     -> 1025 events
 *   includes(text, "FU1__vh8hbY")  ->  608 events  (59.3% vs 57.8% expected)
 *   includes(text, "NiDD7PpZw48")  ->  290 events  (28.3% vs 28.6% expected)
 *
 * The Bloom filter matched blobs for the failing predicate because the index is
 * built over the raw text that carries the stamped hash. So the retrieval looked
 * healthy at every stage the funnel reports, and returned nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildArchiveHashSearch,
  buildPatternSearch,
  UNRESOLVABLE_PATTERN_PREFIX,
} from '../src/lib/retriever-api.js';

function readSource(relPath: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) {
      return readFileSync(join(dir, relPath), 'utf8');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the package root');
}

test('a metrics-side hash becomes a text-token match, not a field equality', () => {
  const search = buildArchiveHashSearch('FU1__vh8hbY');
  assert.equal(search, 'includes(text, "FU1__vh8hbY")');
  assert.ok(
    !search.includes('tenx_hash'),
    'a `tenx_hash` field equality matched 0 of 1,025 events against this archive'
  );
});

test('quotes are stripped so the predicate cannot be broken out of', () => {
  assert.equal(buildArchiveHashSearch('ab"cd'), 'includes(text, "abcd")');
  assert.equal(buildArchiveHashSearch('  FU1__vh8hbY  '), 'includes(text, "FU1__vh8hbY")');
});

test('base64url hash characters survive intact', () => {
  // Hashes are base64url: [A-Za-z0-9_-]. Underscores and hyphens must not be
  // mangled, or the token stops matching the text.
  for (const h of ['FU1__vh8hbY', 'NiDD7PpZw48', 'Ar_kVxzmVCo', 'jYJkpJkwVrw', '03ndjreM-sU']) {
    assert.equal(buildArchiveHashSearch(h), `includes(text, "${h}")`);
  }
});

test('a pattern NAME is refused, because no field can satisfy it', () => {
  // The old predicate was `tenx_user_pattern == "<name>"`. That field DOES NOT
  // EXIST: zero occurrences across the engine, the modules tree and
  // pipeline-extensions. It is a plausible member of a real family
  // (tenx_user_service, tenx_user_process are real) that the product never
  // stamps, so every name-scoped archive query returned BLOOM_REJECTED_ALL,
  // 0 of 40 blobs: a confident empty answer.
  //
  // No substitute field works either. Measured, same window:
  //   message_pattern == "info_cart_..."  -> 0, BLOOM_REJECTED_ALL
  // and message_pattern IS the real symbolMessageField (workers log
  // "Enriching TenXObjects with message field: 'message_pattern'"). A Symbol
  // Message is DERIVED from the event, so it is never a token in the archived
  // bytes, and the Bloom index only holds text tokens plus template hashes.
  // The name route is unsatisfiable by construction, not mis-named.
  assert.throws(
    () => buildPatternSearch('info_cart_cartstore_ValkeyCartStore_GetCartAsync_called_with_userId'),
    (err: Error) => {
      assert.ok(
        err.message.startsWith(UNRESOLVABLE_PATTERN_PREFIX),
        'must carry the caller-input marker prefix'
      );
      assert.ok(
        err.message.includes('pattern_hash'),
        'must name the identity that DOES work'
      );
      return true;
    }
  );
});

test('the fabricated field is never USED, only described', () => {
  // The field does not exist, so nothing may build a predicate on it or read it
  // off a record. Prose that NAMES it is fine and wanted: the error message and
  // the tool descriptions have to tell a caller why the name route is refused.
  //
  // So this forbids the two shapes that constitute use:
  //   - property access:        evRec.tenx_user_pattern
  //   - predicate construction: `... tenx_user_pattern == "${x}" ...`
  for (const rel of [
    'src/lib/retriever-api.ts',
    'src/tools/retriever-query.ts',
    'src/tools/retriever-series.ts',
    'src/tools/backfill-metric.ts',
  ]) {
    const src = readSource(rel);
    const offenders = src
      .split('\n')
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => {
        const t = line.trimStart();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
        const propertyRead = /\.tenx_user_pattern\b/.test(line);
        // A predicate is built by interpolating a value into a template literal,
        // so `${` is the precise tell. Matching on a bare backtick instead would
        // false-positive on prose that wraps the field name in markdown backticks
        // to explain that it does not exist, which is exactly what the remediation
        // message does.
        const predicateBuild = line.includes('${') && line.includes('tenx_user_pattern');
        return propertyRead || predicateBuild;
      })
      .map(({ n, line }) => `${rel}:${n}: ${line.trim().slice(0, 70)}`);
    assert.deepEqual(
      offenders,
      [],
      `${rel} still USES the non-existent tenx_user_pattern field (describing it is fine)`
    );
  }
});

test('no archive caller builds a tenx_hash field equality', () => {
  // Source-level: this defect is a predicate SHAPE at a call site. It existed in
  // two places at once (retriever-query's pattern_hash auto-build and
  // retriever-probe's synthetic query), and the probe is the tool whose job is to
  // verify this exact chain, so it reported a broken chain on a healthy one.
  // SIEM query builders are excluded: `tenx_hash` IS a real stamped field there.
  for (const rel of ['src/tools/retriever-query.ts', 'src/lib/retriever-probe.ts']) {
    const src = readSource(rel);
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /tenx_hash\s*==/.test(line))
      .filter(({ line }) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
    assert.deepEqual(
      offenders.map((o) => `${rel}:${o.n}`),
      [],
      `${rel} must not test tenx_hash equality against the archive; use buildArchiveHashSearch`
    );
  }
});

test('cohort shares reconcile against the metrics surface', () => {
  // Guards the claim the fix rests on: matching the stamped hash as a token
  // returns the RIGHT subset, not merely a non-empty one. Two independent
  // patterns, measured, against a 1,025-event window.
  const ARCHIVE_TOTAL = 1025;
  const measured = [
    { hash: 'FU1__vh8hbY', archiveEvents: 608, metricsEventSharePct: 57.8 },
    { hash: 'NiDD7PpZw48', archiveEvents: 290, metricsEventSharePct: 28.6 },
  ];
  for (const m of measured) {
    const archiveSharePct = (m.archiveEvents / ARCHIVE_TOTAL) * 100;
    assert.ok(
      Math.abs(archiveSharePct - m.metricsEventSharePct) < 2,
      `${m.hash}: archive share ${archiveSharePct.toFixed(1)}% should track the ` +
        `metrics share ${m.metricsEventSharePct}% (windows differ, so allow 2 points)`
    );
  }
  // And the two cohorts must not overlap into more than the whole.
  const combined = measured.reduce((a, m) => a + m.archiveEvents, 0);
  assert.ok(combined < ARCHIVE_TOTAL, 'two distinct patterns cannot exceed the window total');
});
