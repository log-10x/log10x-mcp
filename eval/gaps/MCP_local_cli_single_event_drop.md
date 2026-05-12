# Product gap — privacy_mode local-CLI path: silent system-cache dedup on macOS

**Severity (when open)**: high (100% data loss in default privacy_mode for cache-hit inputs)
**Surfaced by**: 2026-05-12 verification probe of the resolve_batch bridge
**Status**: **FIXED 2026-05-12** by rewriting `dev-cli.ts` to invoke `tenx @apps/mcp` with stdin/stdout demux instead of the tempdir + shadow-config + file-output pattern. The misdiagnosed "engine drops single-event input" was actually three compounded issues, all eliminated by the rewrite.

## The misdiagnosis chain

The original symptom: `log10x_resolve_batch` with `privacy_mode: true` returned "No patterns resolved from 1 line(s). The templater may have rejected the input" for g11.log and many other inputs.

What I thought initially: "engine silently drops single-event input on small batches." Wrong.

What was actually happening (after grounding traces on 2026-05-12):

1. **System-cache pollution**: prior MCP runs wrote new templates into `/usr/local/etc/tenx/config/data/sample/output/templates.json` (the system-shipped sample-output cache). Once a template was in that cache, future MCP runs found it via the install's `template.files: [data/templates/*.json, data/sample/output/*.json]` glob, marked it as "not new," and never emitted it to the per-invocation tempdir's `templates.json`. `encoded.log` was populated correctly against the cached hash.
2. **Shadow-config ignored under `/var/folders` on macOS**: dev-cli.ts created a per-invocation tempdir under `os.tmpdir()` (= `/var/folders/.../T/` on macOS) and wrote a shadow `run/template/config.yaml` with `files: []` to suppress the cache load. The engine's `$=path()` resolver does **not** pick up config files under `/var/folders/...`, so the shadow was silently ignored. The same shadow under `/tmp/...` worked.
3. **Misleading error message**: the MCP returned "templater may have rejected the input" when `templates.size === 0 && encoded.length > 0` — but this condition is actually the system-cache-dedup signature, not an input-format problem.

Independent of those bugs, the dev-cli.ts setup had two other portability defects:
- Hardcoded `/usr/local/Cellar/log10x/1.0.4/lib/tenx/modules` in TENX_INCLUDE_PATHS (Intel-Homebrew-only, breaks on Apple Silicon, Linux, Windows)
- Engine-version-coupled: any engine release that drops or renames a module silently broke the path

## The fix (shipped 2026-05-12)

Engine release 1.0.21 + the new `apps/mcp` engine app (see PRs in
`log-10x/config` and `log-10x/modules`) eliminated all of these
together. `dev-cli.ts` was rewritten:

- **No tempdir**: no `mkdtemp`, no shadow config, no `LOG10X_MCP_OUTPUT_DIR`.
- **No file outputs**: no `templates.json`/`encoded.log`/`aggregated.csv` files; the engine emits everything to stdout under `@apps/mcp`.
- **No system cache touched**: `@apps/mcp` does not include any template-file load module path AND does not write to disk, so the cache stops growing from MCP usage entirely.
- **No `TENX_INCLUDE_PATHS` injection**: the MCP relies on the user's `TENX_HOME` / `TENX_MODULES` / `TENX_CONFIG` env vars (or OS defaults) to resolve `apps/mcp`. No hardcoded paths.
- **Stdout demux**: lines starting with `~` → encoded event, `{` → template JSON, `summary=,` → aggregated summary. Engine info lines (emoji-prefixed) are skipped.

## Verification

Re-tested both the originally-broken g11.log single-event case and the multi-event probe end-to-end via `node eval/bin/mcp-call.mjs --tool log10x_resolve_batch ... privacy_mode: true`:

| Test | Before fix | After fix |
|---|---|---|
| g11.log single event | "No patterns resolved" | Pattern resolved: `opentelemetry_javaagent_tooling_VersionLogger_opentelemetry_javaagent_version`, severity INFO, hash `4yR0svSmgt` |
| 10-event multi-pattern batch | 0 summaries / hash-only output for some patterns | 10 templates + 10 encoded + 10 per-pattern summaries with severity (ERROR: 4, WARN: 2, INFO: 4) |

## Engine release requirement

The fix requires:
- `log10x` brew formula ≥ 1.0.21 (for the `TenXReceiver`-based config compatibility)
- `apps/mcp` shipped in the engine release tarball (forthcoming PR cycle in `log-10x/config` + `log-10x/modules`)

Until those land, dev environments need `TENX_CONFIG` and `TENX_MODULES` pointing at local clones of the config + modules repos with the unmerged apps/mcp changes.

## Related code paths

- [`src/lib/dev-cli.ts`](../../src/lib/dev-cli.ts) — rewritten `runDevCliStdin`, new `runAppsMcpViaLocalBinary` / `runAppsMcpViaDocker` helpers, demux logic inline
- [`src/lib/cli-output-parser.ts`](../../src/lib/cli-output-parser.ts) — unchanged; parses the demuxed buffers the same way it parsed the file blobs
- [`src/tools/resolve-batch.ts`](../../src/tools/resolve-batch.ts) — unchanged; consumes `runDevCli`'s return value
- `assets/tenx-mcp-stdin.config.yaml` — now unused; can be removed in a follow-up

## Files no longer needed (post-fix)

- `assets/tenx-mcp-stdin.config.yaml` — replaced by `@apps/mcp` invocation
- The "tempdir + shadow config" code path in `runDevCliCore` — still present for the file-mode `log10x_extract_templates` tool, which hasn't been migrated yet

## Why the harness missed this

Documented in `eval/COUNTERFACTUAL.md` (the deferred counterfactual harness plan): no hero scenario across 14 phases invoked `log10x_resolve_batch` with `privacy_mode: true`. The full operational envelope of the local CLI path was never exercised. 0/199 surface fabrications validated *agent reasoning over trusted outputs* — not *tool correctness in untested paths*.
