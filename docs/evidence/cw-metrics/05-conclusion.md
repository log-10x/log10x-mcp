# CloudWatch Metrics — MCP adapter E2E result

## Ground truth

### What I planted (verbatim, via direct AWS SDK PutMetricData)

```
namespace: Log10x/E2E (account 351939435334, region us-east-1)
metric:    all_events_summaryBytes
data:
  (tenx_user_service=cart,     message_pattern=p_cart_ok)   → 1234 bytes
  (tenx_user_service=cart,     message_pattern=p_cart_err)  → 567  bytes
  (tenx_user_service=checkout, message_pattern=p_chk_ok)    → 2345 bytes
  (tenx_user_service=payment,  message_pattern=p_pay_warn)  → 89   bytes
```

### What the MCP `kind: 'cloudwatch_metrics'` adapter returned (verbatim from `04-mcp-adapter-output.txt`)

`listLabels()` → `[ 'tenx_user_service', 'message_pattern' ]` ✓

`listLabelValues('tenx_user_service')` → `[ 'payment', 'cart', 'checkout' ]` ✓

`queryInstant("count(all_events_summaryBytes)")` → `value: [_, "4"]` ✓
(matches the 4 distinct dim combinations planted)

`queryInstant("all_events_summaryBytes{tenx_user_service=\"cart\"}")` →
```
[
  { metric: {__name__: "all_events_summaryBytes", tenx_user_service: "cart", message_pattern: "p_cart_ok"},  value: [_, "1234"] },
  { metric: {__name__: "all_events_summaryBytes", tenx_user_service: "cart", message_pattern: "p_cart_err"}, value: [_, "567"]  }
]
```

`queryInstant("all_events_summaryBytes")` → all 4 series returned, every value matches what I planted byte-exact (89, 567, 1234, 2345).

## Self-audit (ground-truth gate)

1. **Verbatim quote test**: Yes. The MCP output line `"value": [1778805780, "1234"]` is from `04-mcp-adapter-output.txt`. It matches the planted `bytes: 1234` in `_e2e-cw-test.mjs` line `service: 'cart', pattern: 'p_cart_ok', bytes: 1234`.
2. **Could be cached/mocked?** No. The metrics didn't exist 30 minutes ago — `aws cloudwatch list-metrics` showed only the prior `mcp_adapter_setup_probe` then. After PutMetricData with these 4 specific dim combinations, CW surfaced them in `ListMetrics` within ~20s, and `GetMetricData` returned the planted values.
3. **Independent cross-check**: Yes. `aws cloudwatch get-metric-data` directly against the AWS API (not through the MCP adapter) returned `Values: [1234.0]` for `(cart, p_cart_ok)` — see `02-put-roundtrip.txt`. The MCP adapter independently arrived at the same value via its own code path.
4. **Adapter ran without error vs returned correct data?** Both. exit code 0 AND values match planted byte-exact.

## What this proves

- The MCP `kind: 'cloudwatch_metrics'` adapter authenticates to AWS, lists CW dimensions, retrieves datapoints, and reshapes them into Prometheus envelopes that downstream MCP tools can render.
- Closed PromQL subset supported by V1: `count(<metric>)` and `<metric>{<label>="<value>",...}` bare selector. The adapter throws a clear error for unsupported shapes (e.g., `topk`, `increase`, `rate`) rather than fabricating a result.

## What this does NOT prove (gap: engine→CW write)

The 10x engine's `run/output/metric/cloudwatch` Micrometer module did NOT load in the demo cluster's dev image `ghcr.io/log-10x/pipeline-10x-dev:fluentd-tmp-k8`. Verbatim quote from the captured engine log [06-engine-failure-prev.log:90](06-engine-failure-prev.log):

```
Caused by: java.lang.IllegalStateException: could not resolve config variable:
'cloudwatchNamespace', available: [aggregators, apiKey, backendEndpoint,
cloudwatchmetrics, compactReceiverDefault, ...]
```

(Same error repeated at lines 119 and 130 of the same file.)

The available list shows `cloudwatchmetrics` is the YAML key the engine recognized (from my `cloudwatch:` block), but the stream.yaml's `$cloudwatchNamespace` variable reference inside that grouping didn't bind. Three YAML variants tried (`cloudwatch: [{namespace: ...}]`, flat `cloudwatchNamespace: Log10x/E2E` top-level, mixed) all hit the same error. Engine was reverted to GC-only stable config; CW write side is a SEPARATE engine-side gap, tracked here for follow-up.

## Files

- `01-aws-identity.txt` — AWS account + identity probe
- `02-put-roundtrip.txt` — direct PutMetricData→ListMetrics→GetMetricStatistics roundtrip (sets the precedent that CW write+read works)
- `03-iam-user-scoped.txt` — IAM user `log10x-poc-cw-writer` with scoped policy (PutMetricData only on `Log10x/E2E`)
- `04-mcp-adapter-output.txt` — full verbatim MCP adapter output
- `05-conclusion.md` — this file
- `06-engine-failure-prev.log` — kubectl logs --previous from the crashed engine pod, captures the `cloudwatchNamespace` resolution failure (quoted above)
- `06-engine-failure-prev2.log` — second engine attempt with flat config, same failure mode
