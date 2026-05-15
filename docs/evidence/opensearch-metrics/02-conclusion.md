# OpenSearch Metrics — MCP adapter E2E result

## Ground truth

### Stack

- Container: `log10x-poc-os` (`opensearchproject/opensearch:2.19.5`), single-node, security plugin disabled via `plugins.security.disabled=true`, port 9201 (so it doesn't conflict with the ES container on 9200)
- Distribution / version: `opensearch / 2.19.5 / lucene 9.12.3` (captured from `GET /`)
- Index: `micrometer-metrics-2026-05` (same Micrometer-ES rolling pattern; OpenSearch is `_bulk` + `_search` API-compatible with ES)

### Planted (via direct OS bulk index)

Same 4 docs as the ES test, identical schema:

| service  | pattern      | count |
|----------|--------------|-------|
| cart     | p_cart_ok    | 1234  |
| cart     | p_cart_err   |  567  |
| checkout | p_chk_ok     | 2345  |
| payment  | p_pay_warn   |   89  |

### What the MCP `kind: 'opensearch_metrics'` adapter returned (verbatim from `01-mcp-adapter-output.txt`)

- `backend.kind = opensearch_metrics` (correctly reports kind, not the underlying `elastic_metrics`)
- `backend.endpoint = http://localhost:9201/micrometer-metrics-2026-05`
- `listLabels()` → `tenx_user_service`, `message_pattern`
- `listLabelValues('tenx_user_service')` → 3 distinct values (cart, checkout, payment)
- `count(all_events_summaryBytes)` → `value: [_, "4"]` (matches 4 planted)
- Cart filter → exactly 2 series with `count: 1234` and `count: 567` ✓
- Unfiltered → all 4 series byte-exact ✓

## Self-audit (ground-truth gate)

1. **Verbatim quote test**: Yes. Output contains `"value": [1778807109, "1234"]` paired with `tenx_user_service: cart, message_pattern: p_cart_ok`. Planted value in `seed-and-probe.mjs:8` is `{ service: 'cart', pattern: 'p_cart_ok', count: 1234 }`.
2. **Could be cached/mocked?** No. Container is fresh, index is fresh (no shell pre-seed this time), adapter retrieves via HTTP from a real OS instance.
3. **Independent cross-check**: Adapter `count(...)` returned `"4"` ↔ `seed.items.length` from the bulk response was 4 (logged at top of output). Two independent code paths arrive at the same number.
4. **Adapter ran without error vs returned correct data?** Both. exit 0 + byte-exact match.

## Code design

`OpenSearchMetricsBackend` subclasses `ElasticMetricsBackend` (the OS `_search` + `_bulk` wire protocol is identical to ES on the doc fetch level). The override only changes the `kind` discriminator so config + logs read "opensearch" instead of "elastic" — useful when a customer has both deployed. All actual query logic is reused verbatim from the ES backend, so this proof doubles as evidence the ES backend works against an independent OS distribution (no ES-specific quirks were relied on).

## What this does NOT prove

- **Engine→OS write path**: not exercised. Engine has `run/output/metric/elastic` (Micrometer-ES); OS speaks the same protocol, so the engine could in principle write to OS without code changes (point the URL at the OS endpoint). Untested here.
- **Security-enabled OS**: this E2E ran with the security plugin DISABLED. The adapter implements Basic + ApiKey auth; OS's default `admin/admin` setup wasn't exercised.

## Files

- `01-mcp-adapter-output.txt` — full verbatim MCP adapter output
- `02-conclusion.md` — this file
- `scripts/seed-and-probe.mjs` — reproducer
