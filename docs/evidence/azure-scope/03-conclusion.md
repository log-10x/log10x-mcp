# Azure SP scope verification — conclusion

**Verbatim probe results** (see `02-probes.txt`):

| # | API call | HTTP | Evidence |
|---|---|---|---|
| 1 | `GET management.azure.com/.../workspaces` | **200** | Returned workspace metadata including `customerId: 38093120-…`, `retentionInDays: 30`, `createdDate: 2026-04-20T03:58:18Z` |
| 2 | `POST api.loganalytics.io/v1/workspaces/.../query` body `log10xPoc_CL \| take 1` | **200** | Returned `tables[].columns` schema — table exists and is queryable |
| 3 | `GET management.azure.com/.../Microsoft.Insights/metrics` | **200** | Returned `BytesExported` metric series with `errorCode: Success`, region `eastus` |
| 4 | `GET .../Microsoft.Insights/metricDefinitions` | **200** | Returned `BytesExported` metric definition with namespace `Microsoft.OperationalInsights/workspaces` |

## What this proves (ground truth)

The SP `log10x-poc-reader` has scope on BOTH:
- Log Analytics workspace query (KQL against the `log10xPoc_CL` table)
- Azure Monitor metrics read (Microsoft.Insights/metrics REST API)

So the "Log Analytics Reader" label in `siem-poc-credentials.md` understates the actual permissions on the subscription. Empirically, both surfaces are reachable with the current SP token.

## What this does NOT prove

- Azure Monitor metrics scope works, but **no log10x engine metrics exist there** because the engine has no Azure output module. Any "Azure Monitor metrics roundtrip" adapter could verify against backend-emitted metrics (e.g., `BytesExported`), NOT against engine-written `all_events_summaryBytes`.
- Log Analytics query works, but the schema returned only shows the table EXISTS — the actual row count + content of the planted 30K events from session 1 is not yet verified. A separate `count()` probe is needed before claiming "data is queryable."

## Implications for the plan

Azure has two paths:

1. **Log-side adapter** (Phase 1.5, step 5a): build MCP adapter wrapping `@azure/monitor-query` `LogsQueryClient`; verify against the existing `log10xPoc_CL` table; this is a real engine→Azure→MCP roundtrip *as a log-side path*.
2. **Metric-side adapter** (Phase 2, step 5b — DEFERRED): would need engine-side Azure output module first. Without engine write to Azure Monitor, the metric-side adapter has nothing to read of engine origin. Defer until engine work is in scope.

**5-day clock applies to BOTH paths** (SP secret expires 2026-05-19). Log-side is the only one closable this week.
