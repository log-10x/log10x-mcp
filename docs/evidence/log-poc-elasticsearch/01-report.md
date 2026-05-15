## POC — done. Elasticsearch, 1h window.

Projected annual cost: **$876K** · Potential savings: **$849K (97%)** at 100 GB/day (user-supplied).

### Top 5 wins

| # | Pattern | Service | Sev | % | Annual savings |
|---|---|---|---|---|---|
| 1 | Internal Base Exporter Go ⚠ | opentelemetry-collector | — | 2% | $86K |
| 2 | Batchprocessor V0 Batch Processor ⚠ | opentelemetry-collector | — | 2% | $80K |
| 3 | Internal Retry Sender Go ⚠ | opentelemetry-collector | — | 2% | $67K |
| 4 | Opensearchexporter V0 Logger Go ⚠ | opentelemetry-collector | — | 2% | $56K |
| 5 | Go Opentelemetry Io Collector ⚠ | opentelemetry-collector | — | 7% | $44K |

⚠ 5 patterns flagged (WARN/ERROR severity or low sample confidence). Run `log10x_dependency_check` before muting — they may feed live alerts or dashboards.

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-40-40.454Z.md_