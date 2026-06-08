# Grafana MCP gap analysis vs log10x-mcp (2026-05-26)

## TL;DR

- **Grafana ships zero envelope / typed-output infrastructure.** Every Grafana tool returns either a bare struct (auto-JSON-marshaled by their `ConvertTool` wrapper at `tools.go:341-373`) or `*mcp.CallToolResult` directly. There is no `summary.headline`, no `actions[]`, no `schema_version`, no `view` dispatch. log10x-mcp's `StructuredOutput` envelope (`src/lib/output-types.ts`) is an unambiguous lead in agent-readable response shape.
- **Grafana out-leads us on schema generation and input ergonomics.** They use Go-struct + `jsonschema:"..."` reflection (`tools.go:441-476`) plus an LLM-tolerant unmarshaler that coerces `"42"`→`42` and `"x"`→`["x"]` (`tools.go:81-128`). Our Zod-shape-on-registration approach loses default values and produces zero coercion. This is a real ergonomics gap that bites Claude, Cursor, and gpt-4o callers.
- **Grafana ships MCP image content, W3C trace context propagation, OTel-instrumented handlers, session-scoped proxied tools, and a streamable-http transport.** We ship none of these. `tools.go:230-243` and `tools.go:417-438` are the relevant patterns.
- **Neither side uses MCP `outputSchema` / `structuredContent`** (the 2025-03-26 spec revision). Grafana uses mcp-go v0.46.0 which exposes it but they have not adopted it. We use `@modelcontextprotocol/sdk` and also have not. This is a parity item we can lead on.
- **Grafana publishes 90 tools across 28 categories** with hard category gates and operator-side `--enabled-tools` / `--disable-write` flags. log10x-mcp has 44 registered, mode-gated to 41/23 by `mode-detect.ts`. Their toolset philosophy is "one tool per Grafana subsystem entry-point"; ours is "one tool per user verb". Both are defensible; the gap is in the **operator surface** (Grafana lets the operator hide tools without code changes).

## Method

Cloned `https://github.com/grafana/mcp-grafana` to `/tmp/mcp-grafana-analysis/` (HEAD as of 2026-05-26). Read first-hand:

- `tools.go` (the `ConvertTool` / `MustTool` framework) — full
- `tools/prometheus.go`, `tools/sift.go`, `tools/hints.go`, `tools/rendering.go`, `tools/dashboard.go`, `tools/navigation.go`, `tools/examples.go` — full or relevant sections
- `cmd/mcp-grafana/main.go` (toolset gating, transports) — full
- `docs/sources/reference/mcp-tools-table.md` (canonical docs convention) — full
- `README.md` (sections 275-360 — the tool table) — full
- `tests/README.md`, `tests/conftest.py` (eval harness) — full

Cross-referenced against log10x-mcp at `feat/json-default-overnight-2026-05-25` (HEAD b598427):

- `src/lib/output-types.ts`, `src/tools/top-patterns.ts`, `src/tools/pattern-mitigate.ts`, `src/tools/correlate-cross-pillar.ts`, `src/index.ts`, `default-manifest.json` — full

What couldn't be confirmed:

- Whether Grafana exercises the **mcp-go v0.46.0** `OutputSchema` / `structuredContent` codepaths anywhere in non-tools code. (Searched the whole tree; zero references. Treating as "not adopted.")
- Whether their `tests/` directory implements judge-based regression scoring or only pass/fail (saw `deepeval` import in README but did not read all eight `*_test.py` files line-by-line — flagged as "needs verification" below).
- Whether `grafana.com/docs/grafana/latest/developers/mcp/` differs materially from the repo's `docs/sources/`. (The repo docs are the source-of-truth shipped into the docs site, so I read those.)

## Tool catalog

### Grafana (90 tools, 28 categories)

Pulled by parsing every `mcpgrafana.MustTool("name", ...)` site under `tools/*.go` (excluding `_test.go`). Categories from `cmd/mcp-grafana/main.go:47-76`.

| Category | Tools | Examples |
|---|---|---|
| Admin | 9 | `list_teams`, `list_all_roles`, `get_resource_permissions` |
| Alerting | 2 | `alerting_manage_rules`, `alerting_manage_routing` |
| Annotations | 4 | `get_annotations`, `create_annotation`, `update_annotation`, `get_annotation_tags` |
| API | 1 | `grafana_api_request` (generic Grafana HTTP passthrough) |
| Asserts | 1 | `get_assertions` |
| Athena | 5 | `list_athena_catalogs`, `query_athena`, … |
| ClickHouse | 3 | `query_clickhouse`, `list_clickhouse_tables`, `describe_clickhouse_table` |
| CloudWatch | 4 | `query_cloudwatch`, `list_cloudwatch_namespaces`, … |
| Config | 1 | `suggest_loki_alloy_label_config` (operator-facing config generator) |
| Dashboard | 5 | `get_dashboard_by_uid`, `update_dashboard`, `get_dashboard_summary`, … |
| Datasources | 2 | `list_datasources`, `get_datasource` |
| Elasticsearch | 1 | `query_elasticsearch` |
| Examples | 1 | `get_query_examples` (returns canned PromQL/LogQL examples) |
| Folder | 1 | `create_folder` |
| Graphite | 4 | `query_graphite`, `query_graphite_density`, … |
| Incident | 4 | Grafana Incident product CRUD |
| InfluxDB | 1 | `query_influxdb` |
| Loki | 6 | `query_loki_logs`, `query_loki_stats`, `query_loki_patterns`, `analyze_loki_labels`, … |
| Navigation | 1 | `generate_deeplink` (URL composer, no I/O) |
| OnCall | 7 | Grafana OnCall (PagerDuty-like) read tools |
| Plugins | 3 | `get_plugin`, `install_plugin`, `search_plugin_information` |
| Prometheus | 6 | `query_prometheus`, `query_prometheus_histogram`, `list_prometheus_metric_names`, … |
| Pyroscope | 4 | `list_pyroscope_*`, `query_pyroscope` |
| Rendering | 1 | `get_panel_image` (returns MCP image content) |
| RunPanelQuery | 1 | `run_panel_query` |
| Search | 2 | `search_dashboards`, `search_folders` |
| Sift | 5 | `find_error_pattern_logs`, `find_slow_requests`, … (Grafana Sift = Grafana's "anomaly investigation" product) |
| Snowflake | 3 | `query_snowflake`, `list_snowflake_tables`, `describe_snowflake_table` |

**Domain coverage shape:** ~80 % of Grafana's surface is **read-only datasource access** (Prometheus, Loki, Pyroscope, ClickHouse, Athena, Snowflake, InfluxDB, Graphite, Elasticsearch, CloudWatch, navigation, search, datasource listing). The remaining ~20 % is **Grafana-product CRUD** (dashboards, folders, annotations, alerting rules, incidents, OnCall, plugins, admin). Two analyst-style tools (`find_error_pattern_logs`, `find_slow_requests`) sit in the Sift category and are the closest cousins to `log10x_investigate`.

### log10x-mcp (44 registered, mode-gated to 41/23)

From `ls src/tools/` and `default-manifest.json`:

| Category | Tools | Examples |
|---|---|---|
| Analysis (live engine) | 14 | `log10x_top_volume`, `log10x_investigate`, `log10x_event_lookup`, `log10x_savings`, `log10x_pattern_trend`, `log10x_pattern_examples`, `log10x_services`, `log10x_discover_labels`, `log10x_dependency_check`, `log10x_pattern_mitigate`, `log10x_advise_compact`, `log10x_configure_compact`, `log10x_configure_regulator` |
| Cross-pillar | 4 | `log10x_correlate_cross_pillar`, `log10x_translate_metric_to_patterns`, `log10x_discover_join`, `log10x_customer_metrics_query` |
| Retriever | 3 | `log10x_retriever_query`, `log10x_retriever_series`, `log10x_backfill_metric` |
| Local templater (paste-mode) | 6 | `log10x_resolve_batch`, `log10x_extract_templates`, `log10x_find_skew`, `log10x_find_constant_slots`, `log10x_find_uuid_in_body`, `log10x_find_incident_cluster` |
| POC | 3 | `log10x_poc_from_siem_submit`, `log10x_poc_from_siem_status`, `log10x_poc_from_local` |
| Discovery / advisors | 5 | `log10x_discover_env`, `log10x_advise_install`, `log10x_advise_reporter`, `log10x_advise_receiver`, `log10x_advise_retriever` |
| Account / env CRUD | 6 | `log10x_login_status`, `log10x_signin_start`, `log10x_signin_complete`, `log10x_signout`, `log10x_create_env`, `log10x_update_env`, `log10x_delete_env`, `log10x_update_settings`, `log10x_rotate_api_key` |
| Diagnostics | 2 | `log10x_doctor`, `log10x_configure_env` |

**Domain coverage shape:** the inverse of Grafana. Our 44 tools are **mostly analyst-verb tools** ("what is expensive", "investigate", "mitigate") with **typed envelopes** on every one of them. Grafana's 90 tools are mostly **datasource leaves** with bare struct returns.

### Side-by-side delta

| Dimension | Grafana | log10x-mcp |
|---|---|---|
| Tool count | 90 | 44 |
| Categories | 28 | 8-ish (informal) |
| Operator-gateable categories | Yes (`--enabled-tools`, `--disable-<cat>`, `--disable-write`) | No (mode-detect-only; `--mode-detect-only=poc/analysis` exists but it's binary) |
| Per-tool envelope | None (auto-JSON of return struct) | `StructuredOutput` on every analysis tool |
| Per-tool input schema | Go struct + `jsonschema` reflection | Zod shape registered with `server.registerTool` |
| LLM-tolerant input coercion | Yes — `unmarshalWithIntConversion` (`tools.go:81-128`) coerces `"42"` → `42`, `"x"` → `["x"]` | None — Zod rejects malformed input outright |
| Default values in schema | Yes, via `jsonschema:"default=10,..."` tags surfaced in the published JSON Schema | No — Zod `.default()` is applied at parse time but is NOT surfaced into the schema the agent sees |
| Image content | `get_panel_image` returns `mcp.ImageContent` base64 PNG | Not implemented |
| W3C trace context | Extracted from `_meta.traceparent` (`tools.go:417-438`); spans become children of caller's trace | Not implemented |
| OTel instrumentation per tool call | `tools.go:230-243` (gen_ai.tool.name, mcp.session_id, mcp.method.name) | Telemetry counter only (`withTelemetry` in `src/index.ts:707`) |
| Transports | stdio / SSE / streamable-http (with TLS) | stdio only |
| Multi-tenant via header forwarding | Yes (`X-Grafana-URL`, custom headers) | No |

## Tool definition style

**Grafana** — single file, single block per tool. From `tools/prometheus.go:65-176`, the pattern is:

```go
type QueryPrometheusParams struct {
    DatasourceUID string `json:"datasourceUid" jsonschema:"required,description=..."`
    Expr          string `json:"expr"          jsonschema:"required,description=..."`
    StartTime     string `json:"startTime,omitempty" jsonschema:"description=..."`
    // ...
}

func queryPrometheusWithHints(ctx context.Context, args QueryPrometheusParams) (*QueryPrometheusResult, error) {
    // ...
}

var QueryPrometheus = mcpgrafana.MustTool(
    "query_prometheus",
    "WORKFLOW: list_prometheus_metric_names -> list_prometheus_label_values -> query_prometheus. ...",
    queryPrometheusWithHints,
    mcp.WithTitleAnnotation("Query Prometheus metrics"),
    mcp.WithIdempotentHintAnnotation(true),
    mcp.WithReadOnlyHintAnnotation(true),
)
```

`MustTool` (defined at `tools.go:58-68`) reflects the handler's argument struct via `github.com/invopop/jsonschema` (`tools.go:441-476`) and wraps the handler with OTel tracing + an LLM-tolerant unmarshaler. Three notable convention diffs:

1. **Tool-output type is the handler's return type.** Grafana returns concrete Go structs (e.g. `*QueryPrometheusResult` with `Data model.Value` + `Hints *EmptyResultHints`) and lets `ConvertTool` JSON-marshal them at `tools.go:368-373`. No envelope.
2. **Description carries a WORKFLOW hint at the front.** They literally write `"WORKFLOW: list_prometheus_metric_names -> list_prometheus_label_values -> query_prometheus. ..."` at the start of the description. That's their chaining mechanism — prose only, no machine-readable `actions[]`.
3. **Annotations are positional MustTool options, not a separate manifest.** Every tool repeats `mcp.WithReadOnlyHintAnnotation(true)` / `mcp.WithIdempotentHintAnnotation(true)`. The annotation flow is end-to-end Go.

**log10x-mcp** — split per tool:

- Schema definition in `src/tools/<tool>.ts` as a Zod object (e.g. `topPatternsSchema` at `src/tools/top-patterns.ts:40-62`).
- Implementation in the same file as `executeTopPatterns(...)`.
- Registration in `src/index.ts` via `registerLog10xTool(name, schema, handler)` which queues into `pendingTools[]` (`src/index.ts:737-783`) and finally applies via `server.registerTool` only AFTER `bootMode` resolves.
- **Description, title, annotations** all live in `default-manifest.json`, pulled at registration time (`src/index.ts:769`). Two places, deliberately decoupled.

The decoupling is a real advantage: it lets us hot-swap a tool's user-facing copy without touching code or rebuilding. The disadvantage is that the description is **far** longer than Grafana's (we average ~1500 characters; Grafana averages ~150). On hosts that count tools/list response tokens against context, this is a measurable cost.

## Return shape

**This is the section that matters most.** Grafana does not have an envelope. log10x-mcp does. Every other gap derives from this asymmetry.

### Grafana — bare struct, no envelope

The handler returns `(R, error)` where `R` is any Go type. `ConvertTool` at `tools.go:341-373` dispatches:

- `*mcp.CallToolResult` → returned verbatim (used by `get_panel_image` for image content)
- `mcp.CallToolResult` → wrapped to pointer
- `string` → `mcp.NewToolResultText(str)`
- everything else → `json.Marshal` then `mcp.NewToolResultText(string(returnBytes))`

There is **no** consistent top-level shape. `query_prometheus` returns `{"data": <model.Value>, "hints": {...}?}`. `list_prometheus_metric_names` returns `[]string`. `find_error_pattern_logs` returns `*analysis` which is a deeply nested Go struct. `get_dashboard_by_uid` returns `*DashboardWithMeta`. The agent has to know each tool's shape ahead of time.

### Grafana — empty-result hints (the one consistency they DO have)

`tools/hints.go` is a useful pattern. When a datasource query returns empty, Grafana attaches a typed `EmptyResultHints` block:

```go
type EmptyResultHints struct {
    Summary          string     `json:"summary"`
    PossibleCauses   []string   `json:"possibleCauses"`
    SuggestedActions []string   `json:"suggestedActions"`
    Debug            *DebugInfo `json:"debug,omitempty"`
}
```

This is the **only** structural convention they share across tools (and only for empty results). It's effectively a per-tool, per-failure-mode envelope — they didn't generalize it.

### log10x-mcp — `StructuredOutput` envelope on every tool

From `src/lib/output-types.ts:94-107`:

```ts
StructuredOutputSchema = z.object({
  schema_version: z.literal('1.0'),
  schema_epoch: z.string(),         // ISO date — bumped per-deploy
  tool: z.string(),
  generated_at: z.string(),
  view: z.enum(['summary', 'markdown']).default('summary'),
  summary: z.object({
    headline: z.string().min(1),
    bullets: z.array(z.string()).max(5).optional(),
    callout: z.string().optional(),
  }),
  data: z.unknown(),                // per-tool typed shape
  actions: z.array(ActionSchema).default([]),
  render_hint: RenderHintSchema,
  truncated: z.boolean().default(false),
  next_cursor: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});
```

Plus `view: 'summary' | 'markdown'` dispatch (`src/index.ts:279-309`): markdown view extracts `data.markdown` to text; summary view ships the whole envelope as JSON. Every tool either calls `buildEnvelope(...)` or `buildMarkdownEnvelope(...)`; legacy string returns get auto-wrapped at `src/index.ts:246-253`.

### MCP `structuredContent` / `outputSchema` — neither side uses

The 2025-03-26 protocol revision introduced `tools/call` result `structuredContent` (typed JSON alongside the text channel) and tool definition `outputSchema` (JSON Schema of the typed result). **Neither Grafana nor log10x-mcp has adopted these.** Both still ship the response as a `text` content block.

- Grafana could trivially do it (mcp-go v0.46.0 supports it; they'd need to populate `result.StructuredContent` in `ConvertTool` at `tools.go:367-373`).
- We could do it (the @modelcontextprotocol/sdk TypeScript SDK supports it as of late 2025); our envelope is already the right shape.

We have a credible parity lead path here: **emit our envelope into `structuredContent` AND continue to emit the markdown view into the text channel** for non-structuredContent clients. The double-emission is cheap and lets the modern hosts skip the JSON.parse step.

### Headline / summary line convention

- **Grafana**: none. Description has `WORKFLOW:` prefix prose. The result has no `headline`.
- **log10x-mcp**: every envelope has `summary.headline` (1-200 chars). `src/index.ts:247` auto-fills it for legacy string tools by extracting the first non-blank line. `top-patterns.ts:484-487` builds it deliberately.

### Image content

- **Grafana**: `get_panel_image` returns `mcp.ImageContent` with base64 PNG and `MIMEType: "image/png"` (`tools/rendering.go:146-154`). No gating on client capability.
- **log10x-mcp**: none. `render_hint: {chart: 'sparkline'|'timeseries'|...}` is declared in the envelope but not consumed. We render ASCII sparklines in markdown view.

## Chaining / actions

**Grafana**: prose-only. The convention is to write `WORKFLOW: tool_a -> tool_b -> tool_c.` at the front of the description (`tools/prometheus.go:171` for `query_prometheus`, `tools/prometheus.go:240` for `list_prometheus_metric_names`). Same convention for `DISCOVERY:` (`list_prometheus_metric_names:240`) and `DISCOVER FIRST:` (`query_prometheus_histogram:556`). The agent has to parse the description; nothing in the result tells it which tool to call next.

**log10x-mcp**: structured. Every envelope carries `actions: ActionSchema[]` where each action is `{tool, args, reason}`. Example from `top-patterns.ts:383-440`: the result returns up to 6 next-actions with pre-filled args, ordered by differentiated value:

```ts
nextActions.push({
  tool: 'log10x_investigate',
  args: { starting_point: topErrorLoop.pattern, window: rcaWindow },
  reason: 'root-cause the top error loop before suppressing it (surfaces log-only signals: ...)',
});
```

This is a real lead. Grafana's prose hints work for prompted agents but break down for autonomous chains.

## Pagination / truncation / cursor

**Grafana**: ad-hoc `Limit`/`Page` params per tool. `list_prometheus_metric_names` has both (`tools/prometheus.go:181-184` with `default=10`). No `nextCursor` in returns; once limited, the result is just truncated silently.

**log10x-mcp**: envelope-level `truncated: boolean` and `next_cursor?: string`. Declared at `src/lib/output-types.ts:104-105`. **Not yet wired through any list-returning tool — the fields are reserved.** This is a real gap on our side too: top-patterns / services / resolve-batch all return capped lists without setting `truncated: true`. Closing this is cheap and an immediate quality win.

## Error envelope

**Grafana**: mcp-go's two-channel error model. If the handler returns an `error`:

- Wrapped in `HardError` (`tools.go:35-45`) → propagates as a JSON-RPC protocol error (rare, used for missing auth).
- Anything else → result with `IsError: true` and text content `err.Error()` (`tools.go:312-321`). Span gets `semconv.ErrorType(err)`.

The result body is always a flat string. No structured error code, no typed union.

**log10x-mcp**: similar pattern at `src/index.ts:310-318` — catch, return text content with `isError: true`. Plus a softer "wrong mode" / "not configured" path at `src/index.ts:211-233` that returns a structured guidance message **without** `isError: true` (so agents don't backtrack on a self-recoverable error). This is a thoughtful distinction Grafana doesn't make.

Neither side ships a typed error envelope (`error_code: enum`, `retryable: boolean`, `next_actions: ...`). Both rely on prose.

## Annotations + safety

Both sides use the MCP standard hint annotations. Per-side breakdown:

### Grafana

Counted from `grep -E "WithReadOnlyHint|WithDestructiveHint|WithIdempotentHint|WithTitleAnnotation" tools/*.go`:

- `WithTitleAnnotation`: 90 (every tool)
- `WithReadOnlyHintAnnotation(true)`: ~77 tools
- `WithIdempotentHintAnnotation(true)`: ~78 tools
- `WithIdempotentHintAnnotation(false)`: 4 tools (`create_annotation`, `install_plugin`, `create_folder`, `find_error_pattern_logs` via creates-investigation)
- `WithDestructiveHintAnnotation(true)`: 3 tools (`update_dashboard`, `install_plugin`, `alerting_manage_rules`)
- `WithReadOnlyHintAnnotation(false)`: 2 tools (write tools)
- `WithOpenWorldHintAnnotation`: **never used** (every tool defaults; this is a Grafana miss)

**Confirmation pattern for destructive tools**: none in code. They rely on the host (Claude Desktop, Cursor) to prompt the user before invoking a `destructiveHint: true` tool. No `confirm: "rotate-now"`-style literal-string gate.

### log10x-mcp

Counted from `default-manifest.json`:

- `readOnlyHint: true`: 33 tools
- `readOnlyHint: false`: 12 tools
- `idempotentHint: true`: 39 tools
- `idempotentHint: false`: 6 tools
- `destructiveHint: true`: 2 tools (`log10x_delete_env`, `log10x_rotate_api_key`)
- `openWorldHint: true`: 30 tools
- `openWorldHint: false`: 15 tools

**Confirmation pattern for destructive tools**: yes. `log10x_delete_env` requires `confirm_name: "<exact env name>"`; `log10x_rotate_api_key` requires `confirm: "rotate-now"` literal. The tool refuses without contacting the backend if the literal mismatches. This is a genuine safety lead over Grafana's `update_dashboard` (which can silently overwrite a 500-panel dashboard with no in-tool confirmation gate).

**Net: we are clearly ahead on safety annotations. We are using more annotations, more consistently, and we ship in-tool confirmation gates that Grafana doesn't.**

## Discovery + descriptions

### Description length

- **Grafana**: 90-300 chars typical. Longest is `update_dashboard` at ~1400 chars (it covers JSON-vs-patch modes + 12 caveats). Median is ~150.
- **log10x-mcp**: 800-3000 chars typical (manifest). `log10x_event_lookup` is ~900, `log10x_top_volume` is ~1700, `log10x_login_status` is ~1500. Median is ~1200.

We carry **8-10x** the per-tool description payload. The reason is fair (we ship tier prerequisites, when-to-call routing, anti-call rules, example args) but the cost is real on tools/list. Two mitigations:

1. **Move the routing rules to a single shared instruction string** (we already have `instructions:` at `src/index.ts:496-688` — extend it instead of per-tool repetition).
2. **Adopt a `_meta` field per tool** (MCP spec allows arbitrary `_meta` on tools and on results) for our `tier_prerequisites`, `costs`, `differentiated_against`. The agent can read those when ranking but they don't compete for the description's prose budget.

### Tool intent / categorization

- **Grafana**: explicit, code-level category groupings (`cmd/mcp-grafana/main.go:47-76`). The operator can `--disable-prometheus` or `--enabled-tools=prometheus,loki`. This is a real **operator-side discovery** advantage we don't have.
- **log10x-mcp**: mode-detect picks one of `analysis` or `poc` and gates accordingly. Inside a mode, all tools are exposed. No `--disable-write`, no category filter.

### `_meta` / cursor pagination on tools/list

- Grafana: no `_meta` on tools, no `tools/list` cursor.
- log10x-mcp: no `_meta` on tools, no `tools/list` cursor.

## Versioning / schema stability

**Grafana**: no per-tool schema version. The Go server version (`mcpgrafana.Version()`) is in the server identity, but a tool's output struct can change without any signal. Their CHANGELOG.md tracks it manually.

**log10x-mcp**: `schema_version: '1.0'` (envelope shape) and `schema_epoch: '2026-05-25'` (engine-derived ID encoding boundary) on every envelope. The epoch is a deliberate signal that `tenx_hash`, `template_hash`, and similar engine-derived IDs may not be stable across a deploy — agents that cache an action's args across an epoch boundary will see the mismatch and re-fetch.

**This is a clear lead.** No other MCP server I've seen ships an explicit epoch signal for engine-derived ID stability. We should keep it and document it.

## Eval / quality

**Grafana**: `tests/` directory has a `deepeval`-based test suite that runs the MCP against two models (`gpt-4o`, `anthropic/claude-sonnet-4-5-20250929`) and uses **GEval custom LLM-as-judge** for scoring. From `tests/README.md`:

> The test suite evaluates the LLM's ability to use Grafana MCP tools effectively [...] Evaluating the LLM responses using `deepeval` (GEval), using custom LLM-as-a-Judge approach.

Eight test files (`admin_test.py`, `alerting_test.py`, `clickhouse_test.py`, `cloudwatch_test.py`, `dashboards_test.py`, `disable_write_test.py`, `elasticsearch_test.py`, `loki_test.py`, `navigation_test.py`, `rendering_test.py`, `tempo_test.py`). Needs verification: whether these are golden-output regression or judge-score-with-threshold.

**log10x-mcp**: the `top_volume` grading sprint (per memory) hardened the hero tool to ~41/50 vs raw-SRE ~30/50 across 4 graders. That work is real but not a continuously-running harness in CI. **This is a clear gap.** Grafana has a public, reproducible eval setup with model parity (gpt-4o + Claude Sonnet 4.5) per CI run. We should at minimum write a `tests/eval/` mirror that runs against the demo env on every release.

## Documentation rendering

**Grafana's convention is a single table**, not per-tool pages. From `docs/sources/reference/mcp-tools-table.md`:

> | Tool | Category | Description | Required RBAC Permissions | Required Scopes |

90 rows, one per tool. Below the table: a few prose sections on RBAC patterns, scope examples, dashboard-context-window caveats. No per-tool reference page. No input/output schema rendered for any tool. Every detail beyond name + category + description + RBAC requires reading the source.

**log10x-mcp's docs convention** (per the mksite plan): per-tool 4-admonition pages with input schema, return shape, example arg pasted, example output pasted, gotchas. This is **far** more verbose than Grafana's. The right call depends on the reader:

- For an operator just trying to scope RBAC: Grafana's table wins by miles.
- For a developer building autonomous chains: our per-tool pages win, because the input/output shape is contractual and the chain hints require concrete examples.

**Concrete things to adopt from Grafana**:

1. **One canonical table** at the top of our docs, mirroring Grafana's: tool name | category | description (one line) | tier prerequisite | annotation flags. Becomes the link target for every per-tool page.
2. **Category-level prose summaries** in the table preamble — like Grafana's `categoryDescription` map at `cmd/mcp-grafana/main.go:47-76`. We don't have these; every tool's prerequisites are repeated per-tool.
3. **Workflow examples by datasource type** like Grafana's `get_query_examples` tool (`tools/examples.go`). We could ship `log10x_workflow_examples` returning a canned table of "for X intent, the chain is A → B → C." Free differentiator.

**Concrete things NOT to adopt**:

1. Grafana's 1400-char `update_dashboard` description. They violate their own convention because dashboards are too complex for the table. We do not need to.
2. WORKFLOW: prose hint at the front of descriptions. We have `actions[]`; prose is redundant and burns tokens.

## Gap list (prioritized, with concrete close-the-gap actions)

### G1. (HIGH) Adopt MCP `structuredContent` + `outputSchema` per tool

- **What Grafana does**: nothing. mcp-go v0.46.0 supports it; they don't use it.
- **What we do**: ship the envelope inside a text content block as `JSON.stringify(envelope, null, 2)` (`src/index.ts:309`).
- **What to change**: in `src/index.ts:wrap()`, populate `result.structuredContent = validated` AND continue to populate `result.content[0].text` with the markdown view (or the envelope as JSON for clients that don't honor `structuredContent`). Then declare `outputSchema` at registration via `(server.registerTool as any)(..., {outputSchema: zodToJsonSchema(StructuredOutputSchema), ...})`.
- **Files**: `src/index.ts:203-319` (`wrap`), `src/index.ts:769-779` (registration block).
- **Effort**: half a day. Carries a measurable agent-readability win on Cursor / Claude Desktop where `structuredContent` is honored.

### G2. (HIGH) Wire `truncated` + `next_cursor` through list-returning tools

- **What Grafana does**: silently truncates at the `Limit` parameter, no `nextCursor`.
- **What we do**: declared but unwired. `top-patterns.ts`, `services.ts`, `resolve-batch.ts`, `discover-labels.ts`, `pattern-examples.ts` all cap results and never set `truncated: true`.
- **What to change**: in each of those tools, after the `limit` cut, set `truncated: rawRows.length > args.limit` and emit a `next_cursor` that's a structured-marker (e.g., `b64(JSON.stringify({offset: limit, ...}))`). Then in the same tool, accept `cursor?: string` in the schema and continue from it.
- **Files**: every tool returning a capped list. Start with `top-patterns.ts:288` (the `rawRows.sort` site), `services.ts`, `resolve-batch.ts`.
- **Effort**: 1 day, mostly mechanical.

### G3. (HIGH) LLM-tolerant input coercion

- **What Grafana does**: `unmarshalWithIntConversion` (`tools.go:81-128`) coerces `"42"` → `42` (any int field) and `"x"` → `["x"]` (any `[]string` field). Tested by `tools_string_to_int_test.go` — 18 KB of test cases.
- **What we do**: Zod rejects type-mismatched input. Cursor and gpt-4o frequently send `"5"` for an int field and we 400 it.
- **What to change**: write a pre-Zod coercer at the registration level. In `registerLog10xTool` (`src/index.ts:739`), wrap the handler so that before invoking it, we walk the Zod shape, identify number-typed fields, and coerce string-quoted numerics. Same for `array` with `string` items. Keep Zod strict at the inner boundary — only coerce at the outer.
- **Files**: `src/index.ts:739-751`, plus a new `src/lib/input-coerce.ts`.
- **Effort**: 1 day. Big agent-experience win.

### G4. (HIGH) Surface defaults into the published JSON Schema

- **What Grafana does**: `jsonschema:"default=10,..."` lands in the schema the agent sees, so the LLM omits the field knowing the server will use 10.
- **What we do**: Zod `.default(10)` only applies at parse time. The schema we publish (via `server.registerTool`'s `inputSchema`) does not include defaults. Agents over-fill arguments because they don't know defaults exist.
- **What to change**: shim our Zod-to-JSON-Schema conversion so `.default()` materializes into `"default": <value>` in the published schema. The `zodToJsonSchema` library supports it but our registration path might be stripping it.
- **Files**: `src/index.ts:770-779` (where `inputSchema: t.inputSchema` is passed to `server.registerTool`). Audit what the SDK does with Zod shapes — it may need an explicit `zod-to-json-schema` round-trip.
- **Effort**: half a day. Pairs naturally with G3.

### G5. (MED) Operator-side category gates and `--disable-write`

- **What Grafana does**: `--enabled-tools=prometheus,loki`, `--disable-write`, `--disable-<cat>` per category. Operator hides tools without code changes.
- **What we do**: mode-detect is binary (`analysis | poc`). No operator filter.
- **What to change**: add `LOG10X_MCP_ENABLED_CATEGORIES=` and `LOG10X_MCP_DISABLE_WRITE=true` env vars. Map every tool to a category in `default-manifest.json` (add a `category` field per tool). Honor those in `applyToolRegistrations` (`src/index.ts:759-783`).
- **Files**: `default-manifest.json` (add `category`), `src/index.ts:759-783`, new env-var reader.
- **Effort**: 1 day. Mostly enabler — not a hot ask from agents, more a real-world enterprise ask.

### G6. (MED) MCP image content for chart-bearing tools

- **What Grafana does**: `tools/rendering.go` returns `mcp.ImageContent` PNG. They don't gate on client capability.
- **What we do**: render ASCII sparklines in markdown. `render_hint: {chart: 'sparkline'|'timeseries'|...}` is declared but unused.
- **What to change**: in `top-patterns.ts` (and `trend.ts`), render a PNG sparkline via something like `chart.js-node-canvas` or a server-side QuickChart call, base64-encode, and emit a second content block of type `image` alongside the JSON envelope. Gate it on the client's declared capabilities if the SDK exposes them (Grafana doesn't bother; matching them is fine).
- **Files**: `top-patterns.ts:332-348` (the renderTopPatterns site), `trend.ts`.
- **Effort**: 2 days. Big visual win on hosts that render image content (Claude Desktop yes, Cursor no, ChatGPT desktop yes).

### G7. (MED) W3C trace context propagation

- **What Grafana does**: extracts `traceparent` from `_meta` at `tools.go:417-438` so its tool spans become children of the caller's trace. The Grafana MCP run shows up as a child span inside the agent's trace.
- **What we do**: nothing. Our `withTelemetry` counter is local-only.
- **What to change**: in the request handler, before calling the tool, read `request.params._meta.traceparent` if present and start an OTel span as a child. Emit `gen_ai.tool.name`, `mcp.session.id`, `mcp.method.name` per Grafana's `tools.go:230-243`.
- **Files**: `src/index.ts` somewhere near `withTelemetry` (~line 707), and an OTel SDK init somewhere we don't have yet.
- **Effort**: 2 days. Real differentiator for enterprise SRE customers who want unified MCP-side traces.

### G8. (MED) Per-tool eval harness in CI

- **What Grafana does**: `tests/*.py` driven by `deepeval` GEval running against gpt-4o + Claude Sonnet 4.5.
- **What we do**: ad-hoc grading sprints. No CI gate.
- **What to change**: add `tests/eval/` with one Python module per hero tool (top_patterns, investigate, correlate_cross_pillar, pattern_mitigate, event_lookup). Use the demo env. Use `deepeval` (or our own grader if we want to dogfood Claude). Run on every PR to `main` (`.github/workflows/eval.yaml`). Threshold: don't merge if a tool drops > 5 points on its established baseline.
- **Files**: new `tests/eval/*.py`, new `.github/workflows/eval.yaml`.
- **Effort**: 3-5 days for the framework + 5 hero tools. Highest leverage for catching regressions before customers see them.

### G9. (LOW) Single canonical tools table in docs

- **What Grafana does**: one table, 90 rows, in `docs/sources/reference/mcp-tools-table.md`. Becomes the link hub.
- **What we do**: per-tool pages, no top-level table.
- **What to change**: add `mksite/docs/reference/tools-table.md` with columns: tool | category | description (one line) | tier prerequisite | safety annotations. Auto-generate from `default-manifest.json` at docgen time.
- **Files**: `default-manifest.json`, new `mksite/docs/reference/tools-table.md`.
- **Effort**: half a day if we add a docgen step; less if we hand-author it.

### G10. (LOW) Cut description bloat by ~50 % via shared instructions

- **What Grafana does**: short descriptions (median ~150 chars). Routing prose lives in their server `instructions:` string.
- **What we do**: per-tool descriptions repeat routing rules (when to call, when not to call, tier prerequisites, anti-call rules). Median ~1200 chars.
- **What to change**: audit `default-manifest.json` descriptions. Pull the "Tier prerequisites" boilerplate into a shared `instructions:` string (we already have one at `src/index.ts:496-688`). Keep the per-tool description focused on "what this tool returns and when the agent should call it."
- **Files**: `default-manifest.json` (every entry), maybe `src/index.ts:496-688`.
- **Effort**: 1-2 days, mostly editing. Pays back on every tools/list call.

### G11. (LOW) `_meta` on tools and on results for tier/cost metadata

- **What Grafana does**: nothing.
- **What we do**: nothing. But our descriptions carry tier prerequisites in prose because we have no other channel.
- **What to change**: add per-tool `_meta` at registration with `{tier: 'cloud_reporter' | 'edge_reporter' | 'retriever' | 'none', differentiated_against: ['datadog_logs', 'splunk_apm'], avg_latency_ms: 800, ...}`. Agents that read `_meta` (some do for ranking) can use it; agents that don't, ignore it. Same `_meta` on tool results to carry the engine epoch, the env id used, the auth identity — fields that are operational metadata, not data.
- **Files**: `default-manifest.json` (add `_meta`), `src/index.ts:769-779`.
- **Effort**: 1 day.

### G12. (LOW) Streamable-HTTP transport + multi-tenant headers

- **What Grafana does**: stdio / SSE / streamable-http with TLS, client-cache for HTTP, X-Grafana-URL forwarding for multi-tenant SaaS-side deployment.
- **What we do**: stdio only. Every customer runs their own MCP locally.
- **What to change**: add streamable-http transport so we can run a multi-tenant log10x-mcp.log10x.com endpoint that fans out per-tenant via headers. This is product-level work, not a tool-level fix; tracking it here so we have it on the radar.
- **Effort**: 2 weeks. Out of scope for the immediate doc-rewrite, but flagged.

## Open questions for the user

1. **Where do you want to land on `structuredContent`?** It's the biggest single agent-readability win and we already have the envelope. Half-day implementation. Want me to spike it before the doc rewrite, or after?

2. **Are we keeping the per-tool 4-admonition doc pages, or moving toward Grafana's single-table model?** Some questions (RBAC scope hints, link-hub navigation) are clearly better in a table. Others (orchestration chain examples, typed output samples) are clearly better in per-tool pages. The current plan has both, with no anchor between them.

3. **The eval harness gap (G8) is the single largest "industry-best-practice" gap.** Are we OK delaying the doc rewrite until the eval harness lands? Or are docs the immediate fire? My read: docs first, eval second, but it depends on what's driving the rewrite.

4. **Description length cut (G10) — do you want to be aggressive or conservative?** Aggressive: cut median from 1200 → 300, move all routing prose to the shared instructions string. Conservative: cut to 800, keep tier-prerequisite prose per-tool. Aggressive is closer to Grafana; conservative is closer to current. Cursor cost is real either way.

5. **For the docs format choice — should we adopt Grafana's "WORKFLOW: a -> b -> c." pattern at the front of descriptions in addition to our `actions[]`?** It's redundant for autonomous agents but it helps prompted agents (Claude Desktop, ChatGPT) discover chains before they call. Cheap. Probably yes.

6. **One thing Grafana does that we don't, and I don't have a strong opinion on: per-datasource WORKFLOW examples (`get_query_examples`)**. Should `log10x_workflow_examples` exist as a discovery tool? Or do we trust the agent to discover chains from `actions[]`? My read: skip; we have `actions[]` and a system instruction string.
