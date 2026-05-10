#!/usr/bin/env node
/**
 * Spec-anchor lint.
 *
 * Every hero spec must have at least ONE anchor in its
 * expected_answer so the rubric has something to score against.
 * A spec with no anchor lets honest-empty fabrications pass
 * trivially (drift=0/0 + no must_mention check + no top_patterns
 * check). Caught by the adversarial run on critical-events as the
 * `honest-empty-no-anchors` shape (eval/shapes/honest-empty-no-anchors/).
 *
 * Anchors that count:
 *   - top_patterns: non-empty array
 *   - must_mention: non-empty array
 *   - must_not_mention: non-empty array
 *   - expected_severity_split: non-empty object
 *   - expected_namespaces: non-empty array
 *   - expected_freshness_seconds: non-empty object
 *   - refusal_required: true (refusal scenario; refusal_phrases is the anchor)
 *   - injection_must_not_emit: non-empty array
 *
 * Usage:
 *   node eval/bin/lint-specs.mjs
 *
 * Exits non-zero if any spec is missing all anchors.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = resolve(evalRoot, 'fixtures/hero');

function hasAnchor(ea) {
  if (!ea || typeof ea !== 'object') return false;
  if (Array.isArray(ea.top_patterns) && ea.top_patterns.length > 0) return true;
  if (Array.isArray(ea.must_mention) && ea.must_mention.length > 0) return true;
  if (Array.isArray(ea.must_not_mention) && ea.must_not_mention.length > 0) return true;
  if (ea.expected_severity_split && Object.keys(ea.expected_severity_split).length > 0) return true;
  if (Array.isArray(ea.expected_namespaces) && ea.expected_namespaces.length > 0) return true;
  if (ea.expected_freshness_seconds && Object.keys(ea.expected_freshness_seconds).length > 0) return true;
  if (ea.refusal_required === true) return true;
  if (Array.isArray(ea.injection_must_not_emit) && ea.injection_must_not_emit.length > 0) return true;
  return false;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.json')) acc.push(p);
  }
  return acc;
}

// Skip:
//   - fixtures/hero/generated/ — parametric generator output, needs
//     `bin/refresh-expected.mjs` against a live oracle to populate
//     anchors before being scored.
//   - fixtures/hero/hero-*.json — legacy M1-era hero specs, predate
//     the campaign expected_answer schema. Not part of the campaign
//     scoring path.
function isLintable(p) {
  const rel = p.replace(fixturesDir + '/', '');
  if (rel.startsWith('generated/')) return false;
  if (rel.startsWith('hero-')) return false;
  return true;
}

const all = walk(fixturesDir).filter(isLintable);
const violations = [];
for (const p of all) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    violations.push({ path: p, reason: `unparseable JSON: ${e.message}` });
    continue;
  }
  if (!hasAnchor(spec.expected_answer)) {
    violations.push({
      path: p,
      reason: 'no anchor in expected_answer — honest-empty answers would pass trivially',
    });
  }
}

if (violations.length > 0) {
  console.error(`[lint-specs] ${violations.length} of ${all.length} specs FAIL anchor lint:`);
  for (const v of violations) {
    console.error(`  ${v.path.replace(evalRoot + '/', '')}: ${v.reason}`);
  }
  process.exit(1);
}

console.error(`[lint-specs] all ${all.length} specs have at least one anchor`);
