## POC — done. Datadog, 1h window.

Projected annual cost: **$2.2M** · Potential savings: **$2.2M (100%)** at 100 GB/day (user-supplied).

### Top 5 wins

| # | Pattern | Service | Sev | % | Annual savings |
|---|---|---|---|---|---|
| 1 | Batchprocessor V0 Batch Processor ⚠ | opentelemetry-collector | INFO | 20% | $1.2M |
| 2 | 6l ⚠ | opentelemetry-collector | INFO | 20% | $584K |
| 3 | Github Com Opensearch Project ⚠ | opentelemetry-collector | INFO | 20% | $137K |
| 4 | Github Com Opensearch Project ⚠ | opentelemetry-collector | INFO | 20% | $133K |
| 5 | Github Com Opensearch Project ⚠ | opentelemetry-collector | INFO | 20% | $110K |

⚠ 5 patterns flagged (WARN/ERROR severity or low sample confidence). Run `log10x_dependency_check` before muting — they may feed live alerts or dashboards.

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-35-52.466Z.md_