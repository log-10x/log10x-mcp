## POC — done. Splunk, 1h window.

Projected annual cost: **$5.3M** · Potential savings: **$5.1M (97%)** at 100 GB/day (user-supplied).

### Top 5 wins

| # | Pattern | Service | Sev | % | Annual savings |
|---|---|---|---|---|---|
| 1 | Internal Retry Sender Go ⚠ | opentelemetry-collector | — | 4% | $712K |
| 2 | Internal Base Exporter Go ⚠ | opentelemetry-collector | — | 2% | $434K |
| 3 | Batchprocessor V0 Batch Processor ⚠ | opentelemetry-collector | — | 2% | $400K |
| 4 | Grpc V1 Clientconn Go ⚠ | opentelemetry-collector | — | 2% | $310K |
| 5 | Opensearchexporter V0 Logger Go ⚠ | opentelemetry-collector | — | 2% | $280K |

⚠ 5 patterns flagged (WARN/ERROR severity or low sample confidence). Run `log10x_dependency_check` before muting — they may feed live alerts or dashboards.

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-47-15.857Z.md_