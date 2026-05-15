# Elasticsearch Metrics — MCP adapter E2E result

## Ground truth

### Stack

- Container: `log10x-poc-es` (`docker.elastic.co/elasticsearch/elasticsearch:9.1.0`), single-node, security disabled, port 9200
- Index: `micrometer-metrics-2026-05` (matches Micrometer-ES default rolling pattern `micrometer-metrics-YYYY-MM`)

### Planted (via direct ES bulk index)

Same shape Micrometer-ES produces (verified against [ElasticMeterRegistry.java:345-374](https://github.com/micrometer-metrics/micrometer/blob/main/implementations/micrometer-registry-elastic/src/main/java/io/micrometer/elastic/ElasticMeterRegistry.java#L345-L374)):

```json
{"@timestamp":"<ISO>","name":"all_events_summaryBytes","type":"counter",
 "tenx_user_service":"<v>","message_pattern":"<v>","count":<n>}
```

Four docs planted (twice — once via shell bulk, once via the seed-and-probe script for repro):

| service  | pattern      | count |
|----------|--------------|-------|
| cart     | p_cart_ok    | 1234  |
| cart     | p_cart_err   |  567  |
| checkout | p_chk_ok     | 2345  |
| payment  | p_pay_warn   |   89  |

### What the MCP `kind: 'elastic_metrics'` adapter returned (verbatim from `01-mcp-adapter-output.txt`)

- `listLabels()` → includes `tenx_user_service`, `message_pattern` (the non-reserved fields)
- `listLabelValues('tenx_user_service')` → 3 distinct values from the planted docs
- `count(all_events_summaryBytes)` → `value: [_, "8"]` (4 docs × 2 seedings; cross-check via `match_all` against `_search` returned `total.value: 4` originally, then 8 after the seed script ran — consistent)
- Cart selector → exact 2 series: `(cart, p_cart_ok)=1234` and `(cart, p_cart_err)=567` ✓
- Unfiltered selector → all 4 series byte-exact: 1234, 567, 2345, 89 ✓

## Self-audit (ground-truth gate)

1. **Verbatim quote test**: Yes. `01-mcp-adapter-output.txt` contains `"value": [1778806597, "1234"]` paired with `(tenx_user_service: cart, message_pattern: p_cart_ok)`. The seed script in `scripts/seed-and-probe.mjs` plants `{ service: 'cart', pattern: 'p_cart_ok', count: 1234 }`. Match.
2. **Could be cached/mocked?** No. The container was freshly started via `docker run`. The index was empty before the bulk seed. The MCP adapter retrieves over HTTP from a real ES instance — no in-memory mocks.
3. **Independent cross-check**: Direct `curl POST /micrometer-metrics-2026-05/_search` with `match_all` returns `total.value: 4` (first seed) → `total.value: 8` (after the script re-seeded). The adapter's `count(...)` returned `"8"` matching. Adapter and direct ES API agree on the same number.
4. **Adapter ran without error vs returned correct data?** Both. exit code 0 AND values are exact matches of planted.

## What this proves

- MCP `kind: 'elastic_metrics'` reads real ES data from Micrometer-ES-shaped documents
- Closed PromQL subset supported (V1): `count(metric)` and bare selectors with `=` label filters
- `queryRange` throws cleanly for the V1 — it doesn't yet support PromQL range expressions over ES aggregations

## What this does NOT prove

- **Engine→ES write path**: not attempted in this evidence pass. The engine has an `elastic` output module (verified earlier in `/Users/talweiss/eclipse-workspace/l1x-co/config/pipelines/run/output/metric/elastic/config.yaml`); whether it loads in the demo cluster's dev image was NOT tested. Same risk as the CW engine module — the dev image may not include the Micrometer-ES registry class. Tracked as a separate engine gap.
- **Auth paths**: this stack ran with `xpack.security.enabled=false`. The adapter implements both Basic auth and ApiKey auth based on config; neither was exercised in this E2E.

## Files

- `01-mcp-adapter-output.txt` — full verbatim MCP adapter output against real ES
- `02-conclusion.md` — this file
- `scripts/seed-and-probe.mjs` — reproducer (seed + probe in one script)
