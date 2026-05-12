# Product gap — `log10x_pattern_examples` CloudWatch path: Insights syntax passed to FilterLogEvents API

**Severity**: high (CloudWatch SIEM path is fully broken end-to-end)
**Surfaced by**: Phase 13 CW connector investigation
**Symptom**: every `log10x_pattern_examples --vendor cloudwatch` invocation returns "no events" with stderr "Invalid character(s) in term '@'", even when the target CW Log Group contains events that match. Confirmed by direct `aws logs filter-log-events` call returning the same matches.

## Reproduction

```bash
# 1. Create log group, write 3 events with the phrase "checkout retry blast":
$ aws logs create-log-group --log-group-name /log10x-eval/synthetic-canary --region us-east-1
$ aws logs create-log-stream --log-group-name /log10x-eval/synthetic-canary --log-stream-name canary-events-001 --region us-east-1
$ aws logs put-log-events --log-group-name /log10x-eval/synthetic-canary --log-stream-name canary-events-001 --region us-east-1 --log-events file://events.json

# 2. Direct FilterLogEvents call with CORRECT FilterLogEvents pattern syntax:
$ aws logs filter-log-events --log-group-name /log10x-eval/synthetic-canary --region us-east-1 --filter-pattern '"checkout retry blast"' --start-time 0
{
    "events": [
        { ... 3 events returned, all matching ... }
    ]
}

# 3. MCP log10x_pattern_examples with vendor=cloudwatch:
$ AWS_REGION=us-east-1 LOG10X_EVAL_ENV=demo node eval/bin/mcp-call.mjs --tool log10x_pattern_examples --args '{"pattern":"checkout retry blast","scope":"/log10x-eval/synthetic-canary","vendor":"cloudwatch","time_range":"15m"}'
## Pattern Examples — no events in 1h window

No events matched the probe in the 1h window on cloudwatch.
Query used: `/log10x-eval/synthetic-canary | @message like /checkout/ and @message like /retry/ and @message like /blast/`

### Probe notes
- bucket_0_/log10x-eval/synthetic-canary_error: Invalid character(s) in term '@'
- bucket_1_/log10x-eval/synthetic-canary_error: Invalid character(s) in term '@'
- ... (24 more notes truncated)
```

## Root cause

Two files in the MCP source disagree on the CloudWatch query syntax:

**`src/tools/pattern-examples.ts` (line ~432)** generates **Logs Insights**
syntax for CloudWatch:

```typescript
case 'cloudwatch': {
  // Insights: filter @message like /escaped/ AND ...
  const escapedPhrases = tokens.map((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    return `@message like /${escaped}/`;
  });
  ...
}
```

This outputs e.g. `@message like /checkout/ and @message like /retry/`.

**`src/lib/siem/cloudwatch.ts`** uses **FilterLogEvents** (not Insights):

```typescript
new FilterLogEventsCommand({
  logGroupName: ...,
  filterPattern,  // <-- gets the Insights-syntax string above
  ...
})
```

`FilterLogEvents` expects [CloudWatch Logs filter pattern syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html), NOT Insights syntax. Filter patterns are e.g. `"phrase"`, `?error ?warn`, or `[$.field = "value"]`. The `@message like /.../` form is rejected with "Invalid character(s) in term '@'".

## Proposed fix

Option A (minimal): in `buildPatternSearch()` for `case 'cloudwatch'`, output FilterLogEvents-compatible syntax:

```typescript
case 'cloudwatch': {
  // FilterLogEvents pattern syntax: quoted phrases joined with implicit AND.
  // Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html
  const phrases = tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  if (severity) phrases.push(`"${severity}"`);
  return phrases.join(' ');
}
```

Verified: `aws logs filter-log-events --filter-pattern '"checkout retry blast"'` returns the expected events on the test log group.

Option B (richer): switch the cloudwatch connector to use `StartQueryCommand` (Insights API) instead of `FilterLogEvents`. The current Insights-syntax query would then work. Higher latency (Insights queries are async + paginated through a polling API), but more expressive.

Option C: emit BOTH a FilterLogEvents-compatible pattern AND a fallback Insights query, attempt FilterLogEvents first, fall back to Insights on empty result.

Of the three, A is the smallest fix and matches what the code claims to do (the file header says "Uses FilterLogEvents for scoped retrieval"). B is the architecturally cleaner long-term path if the Insights query expressivity is desired.

## Why this matters

The CloudWatch SIEM connector is mentioned throughout the MCP docs as one of the 8 supported SIEMs. log10x_pattern_examples explicitly accepts `vendor: 'cloudwatch'`. log10x_doctor reports CloudWatch as configurable. But for any user who points the MCP at a CloudWatch Log Group, **`log10x_pattern_examples` returns "no events" deterministically, even when the events exist.** The user has no way to know this is a syntax-mismatch bug rather than "the data isn't there."

This is the second MCP product gap surfaced by the Phase-11-and-on harness experiments (the first being the `log10x_event_lookup` ↔ engine-pattern-hash bridge documented in `eval/gaps/MCP_event_lookup_pattern_hash_bridge.md`). Both are on the SIEM-side path that the harness has been unable to fully test until now.

## Evidence

- Direct `aws logs filter-log-events` returns 3 of 3 expected events with FilterLogEvents-compatible pattern `'"checkout retry blast"'`.
- MCP `log10x_pattern_examples` with `vendor: cloudwatch` returns 0 events for the same data, with 25 buckets all reporting "Invalid character(s) in term '@'" diagnostic notes.
- Test log group: `arn:aws:logs:us-east-1:351939435334:log-group:/log10x-eval/synthetic-canary` (created during Phase 13; 7-day retention).
