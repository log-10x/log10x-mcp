## POC — done. Sumo Logic, 2h window.

Projected annual cost: **$110K** · Potential savings: **$78K (71%)** at 100 GB/day (user-supplied).

### Top 5 wins

| # | Pattern | Service | Sev | % | Annual savings |
|---|---|---|---|---|---|
| 1 | Internal Retry Sender Go ⚠ | Http Input | — | 2% | $12K |
| 2 | Opensearchexporter V0 Logger Go ⚠ | Http Input | — | 1% | $5.1K |
| 3 | Go Opentelemetry Io Collector | Http Input | — | 6% | $4.8K |
| 4 | Go Opentelemetry Io Collector | Http Input | — | 6% | $3.8K |
| 5 | Internal Base Exporter Go ⚠ | Http Input | — | 0.5% | $0 |

⚠ 3 patterns flagged (WARN/ERROR severity or low sample confidence). Run `log10x_dependency_check` before muting — they may feed live alerts or dashboards.

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-51-48.239Z.md_