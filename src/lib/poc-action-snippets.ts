/**
 * Vendor-specific exclusion config snippets per pattern. Used by the
 * v2 envelope's `actions.forwarder_exclusion` and `actions.siem_exclusion`
 * fields. Each helper takes the pattern's identity + template and
 * returns a paste-ready config string for the target vendor.
 *
 * The original renderer (poc-report-renderer.ts) has per-vendor full-
 * report renderers that produce a config FILE; these helpers produce
 * a per-pattern fragment suitable for embedding in a structured field
 * the agent can quote.
 */

/**
 * Datadog log exclusion filter — JSON-shaped, paste-ready into the
 * Logs Configuration → Exclusion Filters surface.
 */
export function datadogExclusionForPattern(identity: string, _template: string): string {
  return JSON.stringify(
    {
      name: `Drop ${identity}`.slice(0, 80),
      query: `@logger:${identity}`,
      sample_rate: 1.0,
      is_enabled: true,
    },
    null,
    2,
  );
}

/**
 * Splunk props.conf nullQueue routing — drops events matching the
 * pattern's literal phrase at index time.
 */
export function splunkExclusionForPattern(identity: string, template: string): string {
  const phrase = literalPhrase(template) || identity.replace(/_/g, ' ');
  return [
    `[host::your_host]`,
    `TRANSFORMS-drop-${identity.slice(0, 20)} = drop_${identity.slice(0, 20)}`,
    ``,
    `# In transforms.conf:`,
    `[drop_${identity.slice(0, 20)}]`,
    `REGEX = ${escapeRegex(phrase)}`,
    `DEST_KEY = queue`,
    `FORMAT = nullQueue`,
  ].join('\n');
}

/**
 * CloudWatch Logs subscription filter (negated): keep everything NOT
 * matching the pattern's literal phrase. Drop-at-source isn't
 * supported by CloudWatch natively; this requires a Lambda forwarder
 * with the filter pattern applied.
 */
export function cloudwatchExclusionForPattern(identity: string, template: string): string {
  const phrase = literalPhrase(template) || identity.replace(/_/g, ' ');
  return [
    `# CloudWatch Logs Insights — confirm volume before applying:`,
    `fields @timestamp, @message`,
    `| filter @message like /${escapeRegex(phrase)}/`,
    `| stats count() as event_count by bin(1h)`,
    ``,
    `# CloudWatch does not support drop-at-source. Apply filter via Lambda forwarder or`,
    `# fluent-bit/CloudWatch agent at log group ingest.`,
  ].join('\n');
}

/**
 * Fluent-bit Lua filter that drops events matching the pattern's
 * literal phrase. Paste into the forwarder config.
 */
export function fluentBitForPattern(identity: string, template: string): string {
  const phrase = literalPhrase(template) || identity.replace(/_/g, ' ');
  return [
    `[FILTER]`,
    `    Name    grep`,
    `    Match   *`,
    `    Exclude log ${escapeRegex(phrase)}`,
    ``,
    `# Drops any record whose 'log' field matches "${phrase}".`,
    `# Verify with: fluent-bit -c /etc/fluent-bit/fluent-bit.conf --dry-run`,
  ].join('\n');
}

function literalPhrase(template: string): string {
  // Longest literal run between $-marked slots, with hardening so we
  // don't bake user-data values into a forwarder rule.
  //
  // The engine's templater sometimes embeds a specific event's slot
  // value into the template body (e.g., the product ID
  // `'L9ECAV7KIM'` showing up inside a recommendation-server
  // pattern). Using such a phrase verbatim in `Exclude log` would
  // create a rule that only matches that ONE product, not the
  // pattern in general.
  //
  // Mitigation: truncate each run at the first occurrence of a
  // delimiter that typically opens a value (quote, bracket, colon
  // followed by space). The phrase that remains is structural log
  // text the agent can grep against without baking in a value.
  const runs = template.split(/\$\([^)]*\)|\$/);
  let best = '';
  for (const r of runs) {
    let trimmed = r.replace(/\s+/g, ' ').trim();
    // Stop at the first opening of a likely value: quote, bracket,
    // brace, or `: ` (a key-value separator). Everything after is
    // probably the variable part the templater failed to abstract.
    const cutAt = trimmed.search(/['"`\[\{]|:\s/);
    if (cutAt > 0) trimmed = trimmed.slice(0, cutAt).trim();
    if (trimmed.length > best.length && /[A-Za-z]{3,}/.test(trimmed)) best = trimmed;
  }
  return best;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
