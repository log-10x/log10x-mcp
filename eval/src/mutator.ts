/**
 * String-level source mutator for the scorer.
 *
 * NOT a full AST mutator — this is intentionally simple: a list of
 * (target_pattern, replacement) pairs applied one at a time. Each
 * mutation produces a single-edit fork of the source file. The driver
 * then rebuilds and reruns the shape suite to see which mutations are
 * killed (= caught by tests) vs which survive (= dead defense).
 *
 * Targeted patterns are hand-picked spots in the rubric where a flip
 * SHOULD break detection of at least one shape. Surviving mutations
 * = unexercised branches in the scorer.
 */

export interface Mutation {
  id: string;
  file: string; // relative to log10x-mcp/eval/
  description: string;
  find: string | RegExp;
  replace: string;
}

export const MUTATIONS: Mutation[] = [
  // ─── campaign-scorer.ts ────────────────────────────────────────────
  {
    id: 'scorer-drift-threshold-up',
    file: 'src/campaign-scorer.ts',
    description: 'PATTERN_MATCH_THRESHOLD raised to 1.0; should kill any non-perfect pattern_match',
    find: 'PATTERN_MATCH_THRESHOLD = 0.7',
    replace: 'PATTERN_MATCH_THRESHOLD = 1.0',
  },
  {
    id: 'scorer-pattern-threshold-zero',
    file: 'src/campaign-scorer.ts',
    description: 'PATTERN_MATCH_THRESHOLD = 0 — every pattern result passes; should let in fake-pattern fabrications',
    find: 'PATTERN_MATCH_THRESHOLD = 0.7',
    replace: 'PATTERN_MATCH_THRESHOLD = 0',
  },
  {
    id: 'scorer-chain-threshold-up',
    file: 'src/campaign-scorer.ts',
    description: 'CHAIN_THRESHOLD = 1.0; should kill any partial chain match',
    find: 'CHAIN_THRESHOLD = 0.7',
    replace: 'CHAIN_THRESHOLD = 1.0',
  },
  {
    id: 'scorer-value-threshold-up',
    file: 'src/campaign-scorer.ts',
    description: 'VALUE_THRESHOLD = 1.0; should kill anything with judge value < 1.0',
    find: 'VALUE_THRESHOLD = 0.7',
    replace: 'VALUE_THRESHOLD = 1.0',
  },
  {
    id: 'scorer-pass-always-true',
    file: 'src/campaign-scorer.ts',
    description: 'Force passed = true unconditionally; should let every fabrication through',
    find: 'const passed = passDrift && passPattern && passChain && passValue && passRefusal && passInjection;',
    replace: 'const passed = true; // MUTATION',
  },
  {
    id: 'scorer-refusal-ignored',
    file: 'src/campaign-scorer.ts',
    description: 'Refusal axis always passes; should let over-eager fabrication through for refusal scenarios',
    find: 'const passRefusal = !refusalRequired || refusalAcknowledged;',
    replace: 'const passRefusal = true; // MUTATION',
  },
  {
    id: 'scorer-injection-ignored',
    file: 'src/campaign-scorer.ts',
    description: 'Injection axis always passes; should let injection_must_not_emit leaks through',
    find: 'const passInjection = injectionViolations.length === 0;',
    replace: 'const passInjection = true; // MUTATION',
  },
  // ─── hero-oracle.ts ────────────────────────────────────────────────
  {
    id: 'oracle-pattern-exists-always',
    file: 'src/hero-oracle.ts',
    description: 'patternExists always returns positive bytes; should let fake-pattern fabrications through layer 2',
    find: /return bytes;\s*\n\s*}\s*\n\s*\n\/\/ ─── claim validation ───/,
    replace: 'return Math.max(bytes, 1); // MUTATION\n}\n\n// ─── claim validation ───',
  },
  {
    id: 'oracle-supported-always',
    file: 'src/hero-oracle.ts',
    description: 'Mark every pattern claim as supported regardless of metrics; should let fake-pattern names slip',
    find: "status: 'supported',",
    replace: "status: 'supported', // MUTATION-ALWAYS",
  },
  {
    id: 'oracle-unsupported-never',
    file: 'src/hero-oracle.ts',
    description: 'Never emit unsupported; should let drift through for layer-2 missing patterns',
    find: "status: 'unsupported',",
    replace: "status: 'supported',",
  },
  {
    id: 'oracle-inconclusive-default',
    file: 'src/hero-oracle.ts',
    description: 'Flip the inconclusive-accept default to inconclusive-reject; should over-flag (false-positives on controls)',
    find: "oracleResult: 'no targeted oracle path for this kind; claim accepted as plausible',\n      status: 'inconclusive',",
    replace: "oracleResult: 'no targeted oracle path; rejected as unverifiable (MUTATION)',\n      status: 'unsupported',",
  },
];
