## POC — done. ClickHouse, 30d window.

Projected annual cost: **$183** · Potential savings: **$166 (91%)** at 100 GB/day (user-supplied).

### Top 5 wins

| # | Pattern | Service | Sev | % | Annual savings |
|---|---|---|---|---|---|
| 1 | 7kh Pm Ldc | — | — | 18% | $34 |
| 2 | 6l | — | — | 11% | $20 |
| 3 | Cart Cartstore Valkeycartstore | — | — | 10% | $17 |
| 4 | Cowkd A5ym | — | — | 9% | $16 |
| 5 | G3 0qlk | — | — | 8% | $14 |

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-33-46.061Z.md_