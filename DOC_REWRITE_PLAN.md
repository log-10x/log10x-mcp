# log10x-mcp doc rewrite plan

Survives compaction. After the Grafana MCP gap analysis, every gap that touches docs gets added here.

## What we agreed (2026-05-26)

User picked: keep the friendly `tenx-ask` / `tenx-answer` chat Example block at the top of each tool page (CSS already in `mksite-tmp/docs/stylesheets/extra.css`). Below it, add a single H2 **Schema and samples** section with **4 collapsed admonitions** in this order:

1. **Input example** — a real JSON call as the agent would author it
2. **Input schema** — args table (field, type, required, default, description)
3. **Output example** — a real captured envelope from the demo, syntax-highlighted
4. **Output schema** — TypeScript-style shape of the typed `data` block

Section heading uses a Material Design code-json icon: `## :material-code-json: Schema and samples`.

Tabs were rejected (the user pushed back on the JS weight + the hidden-content-until-click pattern). Flat 4 admonitions, default-collapsed, scannable in the page outline.

## CSS to add to mksite-tmp/docs/stylesheets/extra.css

Pattern: same as the existing `tenx-config` / `tenx-ask` / `tenx-answer` admonition styles (icon var + class block). Add four:

| Class | Icon (material/...) | Color hue | Purpose |
|---|---|---|---|
| `tenx-input-example` | `play-box-outline` | blue (matches tenx-ask, e.g. `#1e88e5` family) | Real call invocation |
| `tenx-input-schema` | `form-textbox` | blue (slightly darker than -example title bar) | Args table (field/type/required/default/desc) |
| `tenx-output-example` | `code-json` | teal (`#26a69a` family) | Real captured envelope from the demo |
| `tenx-output-schema` | `file-tree-outline` | teal (slightly darker title bar) | TS-style shape of the typed data block |

Symmetry: input-side blue, output-side teal so the reader's eye registers "left=request, right=response" at a glance. Example vs schema differentiated by title-bar shade (not hue) within each side.

Icons come from `/Library/Frameworks/Python.framework/Versions/3.9/lib/python3.9/site-packages/material/templates/.icons/material/` (mkdocs-material). Use the same `<svg>` inline-data-url pattern the existing tenx-* admonitions use.

## Page structure (per tool)

```markdown
---
title: "Top patterns"
description: "..."
icon: material/chart-bar
---

Opening 1-2 sentence value lead — already exists.

## :material-code-braces: Example

!!! tenx-ask "You"

    top 20 patterns in checkout-svc, last hour

!!! tenx-answer "Log10x"

    1. `Cart_Validation_Failed` $890/h ...
    [existing chat example stays as-is]

## :material-chat-question-outline: More to ask

[existing list stays]

## :material-check-decagram-outline: Prerequisites

[existing block stays]

## :material-code-json: Schema and samples

??? tenx-input-example "Input example"

    ```json
    {
      "service": "checkout-svc",
      "timeRange": "1h",
      "limit": 20,
      "view": "summary"
    }
    ```

??? tenx-input-schema "Input schema"

    | Field | Type | Required | Default | Description |
    |---|---|:-:|---|---|
    | timeRange | string | no | 7d | Time range (15m/1h/6h/1d/7d/30d). |
    | service | string | no | — | Scope to a single service. |
    | limit | number | no | 10 | Max patterns to return. 1-50. |
    | view | string | no | summary | summary returns typed envelope; markdown wraps the rendered table. |
    [...]

??? tenx-output-example "Output example"

    ```json
    {
      "schema_version": "1.0",
      "schema_epoch": "2026-05-25",
      "tool": "log10x_top_volume",
      "view": "summary",
      "summary": { "headline": "Top 5 patterns by current cost ..." },
      "data": {
        "patterns": [ {"rank": 1, "identity": "...", "cost_per_month_usd": 1620, ...} ],
        "incidents": [...],
        "totals": {...}
      },
      "actions": [...]
    }
    ```

??? tenx-output-schema "Output schema"

    ```typescript
    interface TopPatternsData {
      patterns: Array<{
        rank: number;
        identity: string;
        template_hash: string;
        tenx_hash?: string;
        cost_per_month_usd: number;
        // ...
      }>;
      incidents: Array<{...}>;
      totals: { monthly_usd: number; bytes_per_sec: number };
    }
    ```
```

The existing single `??? tenx-config "Tool schema (advanced)"` block gets DELETED on each page — replaced by the four blocks above.

## Live-demo capture script

Tools must show REAL output, not hand-written JSON. Write a capture script `mksite-tmp/scripts/capture-tool-envelopes.mjs`:

```javascript
// For each of 44 tools:
//   - boot the MCP with demo creds
//   - call the tool with a representative args fixture
//   - save the typed envelope to docs/_includes/tool-envelopes/<tool>.json
// Skip mutating tools (delete_env, signout, rotate_api_key, signin_complete with browser flow,
//   create_env duplicate-name path, etc.) — use a synthetic example for those.
```

Demo creds (PUBLIC — already in memory):
- LOG10X_API_KEY=4d985100-ee4a-4b6c-b784-a416b8684868
- LOG10X_CUSTOMER_METRICS_URL=https://prometheus.log10x.com
- LOG10X_CUSTOMER_METRICS_TYPE=log10x
- LOG10X_CUSTOMER_METRICS_AUTH=4d985100-ee4a-4b6c-b784-a416b8684868/6aa99191-f827-4579-a96a-c0ebdfe73884

For each tool, pick representative args. e.g.:
- `top_volume`: `{ limit: 5, timeRange: '1h', view: 'summary' }`
- `services`: `{ limit: 5, timeRange: '7d', view: 'summary' }`
- `pattern_examples`: `{ pattern: 'open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project', limit: 5, view: 'summary' }`
- `discover_labels`: `{ view: 'summary' }` (no specific label)
- `discover_join`: `{ view: 'summary' }`
- `correlate_cross_pillar`: anchor a real pattern
- etc.

Synthetic captures for mutating tools (delete_env, etc.): hand-craft a representative envelope showing the typed shape; mark with a comment that it's synthetic.

## Tool catalog to document (44 pages)

Current state of mksite-tmp/docs/apps/mcp/tools/ after chk-15 doc scrub:

**costs/** (5): top-patterns, services, savings, discover-labels, index
**resolution/** (4): event-lookup, resolve-batch, pattern-trend, extract-templates, index (= 5 files)
**investigation/** (7): correlate-cross-pillar, customer-metrics-query, discover-join, investigate, pattern-examples, translate-metric-to-patterns, index (= 7 files)
**detect/** (4 + index): find-skew, find-constant-slots, find-uuid-in-body, find-incident-cluster
**drop/** (2 + index): dependency-check, pattern-mitigate
**retrieve/** (3 + index): retriever-query, retriever-series, backfill-metric
**install/** (still has: advise-install, advise-reporter, advise-receiver, advise-retriever, configure-compact, configure-regulator, discover-env, doctor, index)
**account/** (login-status, signin-start, signin-complete, signout, update-settings, create-env, update-env, delete-env, rotate-api-key, configure-env, index)
**poc/** (poc-from-siem-submit, poc-from-siem-status, poc-from-local, index)

Audit needed: verify the actual directory state matches the 41 (analysis-mode) tools registered after chk-26. Run `ls -R mksite-tmp/docs/apps/mcp/tools/` and compare against `default-manifest.json` keys.

## Tool envelope captures (input fixtures)

Drafted fixture table — REVIEW BEFORE running the capture script. These need to be tools that produce non-trivial envelopes on the live demo:

| Tool | Args | Notes |
|---|---|---|
| top_patterns | `{ limit: 5, timeRange: '1h' }` | works on demo |
| pattern_examples | `{ pattern: 'open_telemetry_opensearchexporter_...', limit: 3, timeRange: '1h' }` | works on demo |
| pattern_trend | `{ pattern: '<same>', timeRange: '1h' }` | works on demo |
| event_lookup | `{ query: 'OpenSearch Request failed', limit: 3 }` | works on demo |
| pattern_mitigate | `{ pattern: 'cart_cartstore_ValkeyCartStore' }` | works on demo |
| dependency_check | `{ pattern: 'Payment_Gateway_Timeout', vendor: 'datadog' }` | paste-ready path (no creds) |
| correlate_cross_pillar | `{ anchor_type: 'log10x_pattern', anchor: '<pattern>', window: '1h' }` | works on demo |
| translate_metric_to_patterns | `{ customer_metric: '<metric>', window: '1h' }` | works on demo |
| find_skew | `{ events: [<paste array>], min_concentration: 0.6 }` | needs paste batch |
| find_constant_slots | `{ events: [<paste>] }` | needs paste batch |
| find_uuid_in_body | `{ events: [<paste>] }` | needs paste batch |
| find_incident_cluster | `{ events: [<paste>] }` | needs paste batch |
| services | `{ limit: 5 }` | works on demo |
| discover_labels | `{}` | works on demo |
| customer_metrics_query | `{ promql: 'up' }` | works on demo |
| discover_join | `{}` | works on demo |
| retriever_query | `{ pattern: '<pattern>', from: 'now-15m', to: 'now', limit: 5 }` | may need retriever deployed — fallback synthetic |
| retriever_series | `{ pattern: '<pattern>', from: 'now-1h', to: 'now', bucket_size: '5m' }` | same |
| extract_templates | `{ source: 'events', events: ['<sample>'] }` | local CLI; works without backend |
| resolve_batch | `{ source: 'events', events: ['<sample>'] }` | local CLI |
| discover_env | `{}` | k8s + AWS probes (skip-aws to avoid creds) |
| savings | `{ timeRange: '7d' }` | works on demo |
| doctor | `{}` | works on demo |
| login_status | `{}` | works on demo (returns demo-mode banner) |
| signin_start | (skip — has side effects) | synthetic |
| signin_complete | (skip — has side effects) | synthetic |
| signout | (skip — has side effects) | synthetic |
| update_settings | (skip — mutates account) | synthetic |
| create_env | (skip) | synthetic |
| update_env | (skip) | synthetic |
| delete_env | (skip) | synthetic |
| rotate_api_key | (skip) | synthetic |
| configure_env | (validateOnly: true) | safe path |
| advise_install | requires snapshot_id | run discover_env first |
| advise_reporter | requires snapshot_id | run discover_env first |
| advise_receiver | requires snapshot_id | run discover_env first |
| advise_retriever | requires snapshot_id | run discover_env first |
| configure_compact | requires snapshot_id + service | run discover_env first |
| configure_regulator | requires snapshot_id + service + budget | run discover_env first |
| investigate | `{ starting_point: 'opentelemetry-collector', window: '1h' }` | works on demo |
| backfill_metric | (skip — mutates TSDB) | synthetic |
| poc_from_siem_submit | (skip — long-running + ambient SIEM creds) | synthetic |
| poc_from_siem_status | (after a real submit) | synthetic |
| poc_from_local | needs kubectl creds | synthetic if not available |

Mix is: ~25 live captures + ~15 synthetic. All "synthetic" ones must be marked as such in the doc.

## Build order (after the Grafana gap analysis lands)

1. Decide if any Grafana-derived design changes invalidate the 4-admonition shape — adjust this plan if so.
2. Add the 4 CSS admonition styles to `mksite-tmp/docs/stylesheets/extra.css`.
3. Write `mksite-tmp/scripts/capture-tool-envelopes.mjs` and run it; commit captures under `mksite-tmp/docs/_includes/tool-envelopes/`.
4. For each of the 44 tool pages: delete the old `tenx-config` admonition; add the new H2 `Schema and samples` section with the 4 new admonitions; reference the captured JSON.
5. Verify each rendered page via `mksite` locally.
6. Commit the lot on `feat/mcp-tools-json-by-default-docs` and push to origin.

## Open after Grafana gap analysis

The gap-analysis section below is filled in by the Grafana MCP research agent. Anything that touches the doc shape (envelope-level fields, header naming, additional schema sections, etc.) gets reconciled into the plan above.

## Grafana MCP gap analysis (placeholder — to be filled in)

[Agent will populate. Anchor topics:
- Tool definition format (input schema description style, output schema declaration if any)
- Return shape (JSON vs markdown, structured vs unstructured)
- Headline / summary line convention
- Action / chaining hints
- Pagination / truncation
- Error envelope
- Discovery (tools/list, descriptions, metadata)
- Multi-vendor versioning / schema epoch
- Sampling / image content / chart hints
- Auth / multi-tenancy
- Eval / quality story
- Docs format on grafana.com/docs/mcp/]
