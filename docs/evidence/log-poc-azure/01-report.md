## POC — done. Azure Monitor / Log Analytics, 30d window.

Projected annual cost: **$2.8K** · Potential savings: **$2.5K (91%)** at 100 GB/day (user-supplied).

### Top 5 wins

| # | Pattern | Service | Sev | % | Annual savings |
|---|---|---|---|---|---|
| 1 | 7kh Pm Ldc | opentelemetry-collector | — | 18% | $522 |
| 2 | 6l | opentelemetry-collector | — | 11% | $306 |
| 3 | Cart Cartstore Valkeycartstore | opentelemetry-collector | — | 10% | $265 |
| 4 | Cowkd A5ym | opentelemetry-collector | — | 9% | $250 |
| 5 | G3 0qlk | opentelemetry-collector | — | 8% | $216 |

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-39-07.719Z.md_