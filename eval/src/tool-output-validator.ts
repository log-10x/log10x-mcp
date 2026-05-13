/**
 * Tool-output validator — detects agent claims that don't appear in
 * the agent's own bash command outputs. Complementary to the oracle
 * scorer (which checks against independent Prometheus ground truth)
 * and the judge (which is an LLM with a global view).
 *
 * The cross-pillar scenario exposed a gap: the oracle has no CW data,
 * so CW-related claims always fall into `driftSoft` regardless of
 * whether they're true. The judge catches CW-output fabrications but
 * is itself fallible (saw a judge false-positive on N=3 run #2 where
 * the agent's "4 events" claim WAS backed by a broadened-probe bash
 * call that the judge missed).
 *
 * This validator: for each specific identifier / numeric claim in the
 * final synthesis, scan all bash stdout. If the claim is "specific"
 * (templateHash-like string, count-with-unit, unusual identifier) and
 * appears in ZERO bash outputs, flag as a hard tool-output fab.
 */

export interface BashCommand {
  cmd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
}

export interface ToolOutputDrift {
  claim: string;
  context: string;
  /** Why this was flagged: */
  reason: 'identifier-not-in-tool-output' | 'count-contradicts-no-data';
}

export interface ToolOutputCheckReport {
  drifts: ToolOutputDrift[];
}

/**
 * Identifier patterns that should appear in tool output if the agent
 * is citing them. Common false positives (date stamps, generic words)
 * are excluded by length + character requirements.
 */
// templateHashes from the tenx engine encoder use a base94-style alphabet
// that includes shell-unsafe punctuation rarely found in English prose:
// `$ # @ ^ & * | ~ ? { } < > ;`. We require at least 1 such char in an
// 8-12 character token to filter out hyphenated English words like
// "Cross-Pillar", "PagerDuty", "Canonical".
const TEMPLATE_HASH_RE = /(?:^|[\s`('"])([A-Za-z0-9!#$%&*+\-_;<>?@\^{}|~]{8,12}(?=[\s`)'",.;:]|$))/g;
const TEMPLATE_HASH_DISCRIMINATOR = /[$#@^&*|~?{}<>;!]/;
const DEPLOY_SHA_RE = /\b(deploy_sha=\w{4,16}|sha[=:]\s*\w{6,40})\b/gi;
const SPECIFIC_INT_WITH_NOUN_RE = /\b(\d+)\s+(events?|matches?|patterns?)\b/gi;

/**
 * Skip these — they appear so often that flagging them as fabrications
 * would be noise: scenario-prompt artifacts, scoring vocabulary,
 * standard severity words.
 */
const SCENARIO_FIXED_STRINGS = new Set([
  'cart_8821', 'k9m2', 'alert-77',  // values from the cross-pillar scenario prompt
]);

/**
 * For each claim in the final synthesis, check whether it appears in
 * any bash stdout. The match is plain substring (case-insensitive) so
 * the agent quoting the tool's output verbatim never triggers a drift.
 */
export function checkToolOutputDrift(
  finalText: string,
  bashCommands: BashCommand[],
): ToolOutputCheckReport {
  const drifts: ToolOutputDrift[] = [];
  const allStdout = bashCommands.map((c) => c.stdout || '').join('\n').toLowerCase();

  // Strip markdown formatting from the synthesis before scanning. We
  // want the token "JR#aVP|+<+" but not the wrapped "**JR#aVP|+<+**"
  // — and especially not the markdown bold pattern itself like
  // "**locally**" being mis-read as a 10-char identifier.
  const cleanText = finalText
    .replace(/\*\*([^*]+?)\*\*/g, '$1')   // bold
    .replace(/\*([^*]+?)\*/g, '$1')        // italic
    .replace(/`([^`]+?)`/g, '$1')          // inline code
    .replace(/\|/g, ' ');                  // table cells — break into tokens

  // 1. templateHash-style identifiers: 8-12 chars with both letters AND
  // either ≥2 shell-punct chars (tenx-encoder signature) OR mixed-case
  // letters with digits and no trailing English punctuation. Pure-alpha
  // tokens and English-word-with-trailing-punct (e.g. "Present?",
  // "directly;") are skipped.
  for (const m of cleanText.matchAll(TEMPLATE_HASH_RE)) {
    const id = (m[1] || '').trim();
    if (!id || id.length < 8 || id.length > 12) continue;
    // Tenx encoder uses these shell-punct chars in its hash alphabet.
    // Hyphen `-` is excluded — it's too common in English compound
    // words ("S3-archive", "cross-pillar"). Underscore similarly is
    // excluded — appears in snake_case identifiers.
    const tenxPunctChars = id.match(/[$#@^&*|~?{}<>!;:+]/g) || [];
    const hasLetter = /[A-Za-z]/.test(id);
    const hasDigit = /\d/.test(id);
    const hasMixedCase = /[a-z]/.test(id) && /[A-Z]/.test(id);
    const endsWithEnglishPunct = /[?;.,!:]$/.test(id);
    // Compound-English-word signature: starts with letter+digit and has
    // exactly ONE hyphen splitting two alpha segments. Reject these
    // (e.g., "S3-archive", "T2-medium").
    const isCompoundEnglishWord = /^[A-Za-z]+\d*-[A-Za-z]+$/.test(id);
    if (!hasLetter) continue;
    if (isCompoundEnglishWord) continue;
    // Accept ONE of:
    //   (a) ≥2 tenx-punct chars (encoder's signature)
    //   (b) Mixed case AND digit AND ≥1 tenx-punct (mixed alpha+digit
    //       alone is too common: "Sonnet4", "Otel2026", "AWS3"...)
    if (!(tenxPunctChars.length >= 2 || (hasMixedCase && hasDigit && tenxPunctChars.length >= 1))) continue;
    // Reject English words with trailing punctuation
    if (endsWithEnglishPunct && tenxPunctChars.length < 2) continue;
    if (SCENARIO_FIXED_STRINGS.has(id)) continue;
    if (allStdout.includes(id.toLowerCase())) continue;
    drifts.push({
      claim: id,
      context: textWindow(cleanText, m.index ?? 0, 100),
      reason: 'identifier-not-in-tool-output',
    });
  }

  // 2. deploy_sha values
  for (const m of finalText.matchAll(DEPLOY_SHA_RE)) {
    const v = m[0];
    const valMatch = v.match(/=\s*(\w+)/);
    const val = valMatch ? valMatch[1] : v;
    if (SCENARIO_FIXED_STRINGS.has(val)) continue;
    if (allStdout.includes(val.toLowerCase())) continue;
    drifts.push({
      claim: v,
      context: textWindow(finalText, m.index ?? 0, 100),
      reason: 'identifier-not-in-tool-output',
    });
  }

  // 3. Specific event counts: "4 events", "12 matches"
  // Cross-check: if the agent claims N events but ALL relevant tool calls
  // returned "no events" / "zero events" / "no data" — fabrication.
  for (const m of finalText.matchAll(SPECIFIC_INT_WITH_NOUN_RE)) {
    const n = parseInt(m[1], 10);
    if (n === 0) continue;
    // Look for the context — find the nearest tool-name token in the
    // 120-char window before the claim. If that tool's bash calls
    // unanimously said "no events" / "no data" / "zero", we have a
    // contradiction.
    const before = finalText.slice(Math.max(0, (m.index ?? 0) - 120), m.index);
    const toolNames = ['log10x_pattern_examples', 'cloudwatch', 'CW', 'pattern_examples'];
    const relevantTool = toolNames.find((t) => before.toLowerCase().includes(t.toLowerCase()));
    if (!relevantTool) continue;

    const relevantCalls = bashCommands.filter((c) =>
      relevantTool === 'cloudwatch' || relevantTool === 'CW'
        ? (c.cmd || '').includes('pattern_examples') && (c.cmd || '').includes('cloudwatch')
        : (c.cmd || '').includes('pattern_examples')
    );
    if (relevantCalls.length === 0) continue;
    // Did any return non-empty data?
    const anyReturnedData = relevantCalls.some(
      (c) =>
        !/no events in|No events matched|no data available/i.test(c.stdout || '') &&
        (c.stdout || '').length > 50
    );
    if (anyReturnedData) continue;
    drifts.push({
      claim: m[0],
      context: textWindow(finalText, m.index ?? 0, 100),
      reason: 'count-contradicts-no-data',
    });
  }

  return { drifts };
}

function textWindow(text: string, idx: number, span: number): string {
  const start = Math.max(0, idx - Math.floor(span / 2));
  const end = Math.min(text.length, idx + Math.floor(span / 2));
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
