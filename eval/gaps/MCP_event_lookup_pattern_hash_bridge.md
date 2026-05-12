# Product gap — `log10x_event_lookup` ↔ engine-side pattern hash bridge

**Severity**: medium (degrades the #1 daily-habit user flow)
**Surfaced by**: Phase 11 paste-event-resolves-to-pattern hero scenario
**Symptom**: agents correctly report "no match found" instead of fabricating, but the documented primary path for the paste-to-pattern user flow does not actually find the match even when the pattern is live.

## The user flow

Per the MCP catalog's "TOOL ROUTING BY USER INTENT" section, the canonical
flow when a user pastes a raw log line is:

> user pastes a raw log line, asks "what is this" → `log10x_event_lookup`

This is the #1 listed daily-habit operational entry point. It is the
flow that most production users will hit first.

## Reproduction

State: synthetic-canary-app in `otel-demo` namespace is firing in bug mode.
Pod logs emit the literal line:

```
checkout retry blast: payment-service returned 503 after 5 retries; abandoning cart cart_id=cart_000028 deploy_sha=ba8f2854 run_id=95527c8e idx=28
```

The corresponding pattern is firing in 10x Prometheus at rank #5 ERROR
under `log10x_top_patterns({ time_range: "1h", severity: "ERROR" })`.

### Attempted resolutions

```bash
# 1. Raw line via 'line' arg
$ node eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '{"line":"checkout retry blast: payment-service returned 503 after 5 retries; ..."}'
Tool 'log10x_event_lookup' threw: Wrong type for `pattern`: Required.

# 2. Substring of message body
$ node eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '{"pattern":"checkout retry blast"}'
No data found for pattern "checkout_retry_blast".

# 3. Shorter substring
$ node eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '{"pattern":"retry blast"}'
No data found for pattern "retry_blast".

# 4. resolve_batch with same line — this WORKS (local templater extracts)
$ node eval/bin/mcp-call.mjs --tool log10x_resolve_batch --args '{"source":"events","events":["checkout retry blast: payment-service returned 503 after 5 retries; ..."]}'
## Batch Triage
1 events, resolved into 1 distinct pattern.
**#1  checkout retry blast: payment-service returned $ after $ re…**
`OY?US|0X}_` — checkout retry blast: payment-service returned $ after $ retries; abandoning cart cart_id=cart_$
```

Verifying that the pattern IS visible elsewhere in MCP:

```bash
$ node eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '{"time_range":"1h","limit":20,"severity":"ERROR"}'
... [pattern appears at rank #5 under a tokenized name] ...
```

## The gap

`log10x_event_lookup` accepts:
- `pattern`: a pattern NAME (e.g., `"Payment_Gateway_Timeout"`)
- (does NOT accept a raw line)

`log10x_resolve_batch` accepts:
- `source`: `"events"` | `"text"` | `"file"`
- raw line input → returns LOCAL TEMPLATER hash (e.g., `OY?US|0X}_`)

The two outputs do not bridge. The local templater's hash is computed
client-side via the bundled CLI; the engine-side pattern hashes (which
feed the `top_patterns` / `event_lookup` lookups) are computed
server-side and differ.

There is no documented MCP path that takes a raw line and returns the
engine-side pattern hash / canonical pattern name. The agent has to
do one of:

- Read the resolve_batch output, then keyword-search via
  `log10x_top_patterns` (multi-call workaround).
- Skip MCP and use kubectl/SIEM to find the pod producing the line.
- Report "no match" honestly (the path Phase 11 agents took).

## Why this matters

The catalog's own routing table puts `log10x_event_lookup` at the top of
the daily-habit list. Users will hit this path first; new users will
form their first impression of the MCP based on whether it works.
Currently it does not — even for patterns the platform is actively
tracking in `top_patterns`.

drift=0 across all 7 Phase 11 paste-with-match runs proves agents do
NOT fabricate around this gap. They correctly report the gap and fall
back to keyword search or external context. But the agents' synthesis
quality (vd) collapses to 0.20-0.60 because the user's actual question
("identify the pattern this log line came from") cannot be answered
through the documented path.

## Proposed fix (sketch — needs product owner input)

Option A — extend `log10x_event_lookup`:
- Accept a `raw_line: string` arg
- Internally: call the templater to get the local hash + extracted
  template
- Substring-search the extracted template against engine-tracked
  pattern names
- Return the engine pattern name + hash + trend if a fuzzy match exists,
  with a confidence score

Option B — bridge in `log10x_resolve_batch`:
- After local templater extraction, also issue an engine-side lookup
  using the extracted template substring
- Annotate each row with `engine_pattern_match: <name> (confidence: 0.X)`
  when a likely live match exists

Option C — accept this as a documented limitation:
- Update the tool routing table to say "paste a raw line → `log10x_resolve_batch`
  followed by `log10x_top_patterns` keyword search"
- Document the multi-call workaround as canonical

Of the three, A or B is preferred for production user experience.

## Evidence

7 hero-scenario transcripts under
`eval/reports/hero/paste-event-resolves-to-pattern/` show the failure
mode consistently across 2 Claude + 5 Grok runs.
