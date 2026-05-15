## POC — done. Sumo Logic, 2h window.

Projected annual cost: **$0** · Potential savings: **$0 (0.0%)** at 100 GB/day (user-supplied).

**Available views** — call `log10x_poc_from_siem_status` again with:
- `view: "full"` — complete 9-section report
- `view: "yaml"` — receiver mute YAML for top patterns, paste-ready
- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)
- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern
- `view: "top", top_n: 20` — expanded drivers table

_Full report on disk: /tmp/log10x-reports/poc_from_siem-2026-05-15T02-48-09.602Z.md_