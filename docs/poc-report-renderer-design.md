# POC report.html — fixed-UX renderer design

Status: DRAFT (2026-08-07). Owner: POC deliverable workstream.
Decisions recorded here were made by Tal on 2026-08-07 (handoff +
this session's Q&A). The visual contract is the "action-plan" mock
artifact (62031016-1c5b-4ed1-aa5f-d15de43b0377); its hand-authored
content is explicitly NOT the contract, only structure and tone.

## Decisions (locked)

1. Deliverable = self-contained `report.html` written to the user's
   working directory by the POC flow itself. Nothing leaves the
   machine. The HTML file is THE durable deliverable; the 9-section
   markdown report stays as-is for chat but is frozen (not grown).
2. Tool shape: no new tool. `poc_from_local` / `poc_from_siem` gain an
   HTML render step. The agent's influence is DECISIONS + bounded
   annotations only — never numbers, never commands, never pixels.
   `report.html = render(template_vN, data)`, deterministic,
   golden-file tested.
3. Evidence = masked `$` faces ONLY. No raw exemplar lines in the
   file (keeps it committable/forwardable). Raw lines remain a chat
   affordance (`pattern_examples`) when the user asks.
4. Engine gap is surfaced, not papered over: the per-pattern
   `head_only` CSV in the mock is a visual contract, not current
   engine behavior. The report renders THE CHANGE from what
   `configure_engine` truly emits today; any per-pattern delta is
   labeled as pending engine work and recorded as a handoff item in
   `~/git/l1x-co/HANDOFF_ENGINE_DEMO_POC.md`.

## The contract (from the handoff, normative)

```
VERDICT   one computed headline + window totals + errors-kept stat
ACTIONS   3-6, each: what / evidence (2-3 masked faces, counts,
          bytes-each, pattern hash) / expected MiB+% (window
          arithmetic, no extrapolation) / THE CHANGE (generated
          config) / APPLY (commands) / UNDO (commands)
VERIFY    doctor/validate checks incl. honest not-run states; the
          re-run promise (retention loop)
KEPT      what the plan does not touch (ERROR/WARN retained count;
          tiered data retrievable; query key = statement identifier)
```

Hard rendering rules (all pre-existing, all enforced by tests):
- NEVER ellipsis-truncate identities or lines. Line-COUNT elision is
  allowed ("+ 22 more lines in this statement"); cutting inside a
  line is not. Lines wrap/scroll.
- Lead with volume (MiB per window). Dollars appear only if the user
  supplied a rate, and then per the existing disclosed-dollar rules.
- Faces always show masked `$` values — the product visibly working.
- Scales O(actions), never O(statements): top-3 evidence + "and N
  more statements in this class".
- No extrapolation: all impact numbers are this window's arithmetic.
- pattern_hash never appears in headlines (evidence metadata only).

## Data schema (renderer input)

The renderer is a pure function `renderReportHtml(data: ReportData):
string`. Everything in `ReportData` is computed by tool code from the
existing envelopes; the ONLY agent-originated bytes are the
`annotation` slots, length-capped and sanitized.

```ts
interface ReportData {
  templateVersion: 'v1';            // baked into the golden files
  meta: {
    siemLabel: string;              // header chip, e.g. "CloudWatch"
    forwarderLabel: string;         // header chip, e.g. "Fluentd"
    runKind: 'first_run' | 'rerun'; // rerun adds before/after column
    generatedAtIso: string;         // footer only, not in goldens' diffed region
  };
  window: {
    label: string;                  // "one hour", "47 minutes" — computed
    events: number;
    statements: number;             // distinct patterns
    ingestedBytes: number;
  };
  totals: {
    removableBytes: number;         // sum of action impacts (window arithmetic)
    removablePct: number;           // removableBytes / ingestedBytes
    protectedKept: number;          // ERROR+WARN event count, all retained
  };
  verdict: Verdict;
  actions: ReportAction[];          // 3-6, enforced
  expected: {
    beforeBytes: number;
    afterBytes: number;             // before - sum(volume action impacts)
    deletedEvents: 0;               // literal; the invariant is the point
  };
  verify: VerifyCheck[];
  kept: KeptBlock;
}
```

### Verdict — computed, never authored

The mock's verdict paragraph is hand-written prose; the product
version is assembled from fixed sentence frames over computed values,
so the same data always yields the same verdict:

```ts
interface Verdict {
  // "NN% of this window is {clusterLabel}" — clusterLabel is the
  // incident cluster's representativeLabel (verbatim highest-volume
  // member descriptor, already the rule in detectors/incident-cluster).
  dominantSharePct: number;
  clusterLabel: string;
  clusterStatementCount: number;
  clusterServiceCount: number;
  // One fixed frame per action kind, in plan order:
  // head_only  -> "Action N keeps every event and stops re-sending the stack."
  // tier_down  -> "Action N moves {category} off the ingest path."
  // operational-> "Action N is the actual fix."
  actionFrames: Array<{ n: number; kind: ActionKind }>;
}
```

If no cluster dominates (no multi-member cluster ≥ threshold share),
the verdict falls back to a volume frame: "NN% of this window comes
from {k} statements" over the plan's targets. Threshold and frames
live beside the renderer, versioned with the template.

### Actions

```ts
type ActionKind = 'cap' | 'tier_down' | 'operational';
// NOTE: the mock's 'head_only' is NOT a real action (vocabulary is
// pass|sample|compact|tier_down|offload|drop, and disposition is
// container-keyed today). 'cap' = container byte cap, the thing
// configure_engine truly emits. See "THE CHANGE" in the mapping
// section and the Engine gap section.

interface ReportAction {
  kind: ActionKind;
  title: string;            // computed from per-kind title frames (below)
  annotation?: string;      // THE agent slot: <=140 chars, one sentence,
                            // plain text (escaped), collapsible to absent
  impactBytes?: number;     // absent for 'operational' -> renders "operational"
  evidence: EvidenceFace[]; // 1-3 faces
  moreStatements?: number;  // "+ N more statements in this class"
  change?: ChangeBlock;     // absent for 'operational'
  apply?: CommandBlock;     // from command matrix
  undo?: CommandBlock;      // from command matrix; 'operational' gets 'check'
  check?: CommandBlock;     // operational-only diagnostic command
}

interface EvidenceFace {
  hash: string;             // stable statement identifier (query key)
  count: number;            // events this window
  bytesEach: number;
  lines: FaceLine[];        // masked; first line + welded continuations
  elidedLineCount?: number; // "+ 22 more lines in this statement"
}

// A face line is segments so the renderer, not the data, owns markup:
type FaceSegment =
  | { t: 'text'; s: string }
  | { t: 'val' }             // renders the masked $ chip
  | { t: 'tab' };            // renders the ⇥ field separator
interface FaceLine { cont: boolean; segs: FaceSegment[] }

interface ChangeBlock {
  comment: string[];        // fixed frames, computed (what/why, honesty note)
  artifact: 'caps_csv' | 'tier_route_csv' | 'container_caps_csv';
  lines: string[];          // verbatim rows of what configure_engine emits
  engineGapNote?: string;   // present iff artifact granularity < plan
                            // granularity (see Engine gap section)
}

interface CommandBlock { commands: string[] }   // verbatim, from matrix
```

Title frames per kind (computed, versioned with the template — the
agent cannot write titles):

- `cap`: "Cap the repeating {stackNoun} in {containerLabel}" where
  stackNoun derives from variant analysis ("call stack" when the
  welded continuation is identical across occurrences; generic
  fallback "statement class").
- `tier_down`: "Route {categoryLabel} to the retrievable tier".
- `operational`: "Fix {targetLabel}" from the cluster's cause tokens.

Exact frame wording is part of template_v1 and locked by goldens;
frames take computed nouns only. If a needed noun cannot be computed
for some data, the frame has a generic fallback ("this statement
class") — never agent text.

### Verify

```ts
interface VerifyCheck {
  id: string;               // stable: 'engine_reachable', 'forwarder_path',
                            // 'weld_integrity', 'resolution', 'tier_delivery'
  state: 'ok' | 'not_run' | 'not_configured';
  detail?: string;          // computed: counts, path names
  enabledByAction?: number; // gray-state upsell arrow: "action 2 enables it"
}
```

`not_run` and `not_configured` are distinct honest states: not_run =
the check exists but this run didn't execute it; not_configured = the
feature the check verifies is off (deliberate gray + arrow to the
action that turns it on).

### Kept

```ts
interface KeptBlock {
  protectedEvents: number;      // ERROR+WARN kept, stated as a number
  trimmedFamilyEvents?: number; // "including the N-event failure family
                                // this plan trims" (first line still ships)
  tierDownRetrievable: boolean; // routed statements land in own bucket,
                                // query key = statement identifier
}
```

## Agent interface: DECISIONS in, nothing else

The POC flow computes a candidate action set itself (default plan).
The agent may pass a `plan` argument to override which candidates
ship and attach annotations:

```ts
interface PlanDecision {
  actions: Array<{
    kind: ActionKind;
    hashes: string[];         // must exist in the envelope; validated
    annotation?: string;      // <=140 chars; longer input REFUSED, not cut
  }>;
}
```

Validation is fail-closed: unknown hash → refuse; hash whose severity
is protected (ERROR/WARN) in a volume action → refuse; fewer than 1
or more than 6 actions → refuse; annotation over cap → refuse with
the limit stated (no silent truncation, per the no-ellipsis rule).
All numbers, faces, commands, and titles are recomputed by the tool
regardless of what the agent decided.

## Mapping from existing envelopes (audited 2026-08-07)

### The spine: PocEnvelopeV2, not the six tools directly

`src/lib/poc-envelope-v2.ts` is already the prose-free structured
projection built for exactly this ("the agent reads structured data";
no headline, no human_summary). Its `tool` union already admits
`'log10x_poc_from_local'` — but `poc-from-local.ts` never constructs
it today. AS BUILT: the report builder consumes the same upstream
computation the v2 envelope is a projection of — `_enrichForEnvelope`
(EnrichedPattern[] + IncidentCluster[]) over a RenderInput — directly,
rather than going through the v2 index-based envelope. Single
computation, reused; the raw tool envelopes are still not inputs:

| ReportData field | Source |
|---|---|
| `window.events/statements/ingestedBytes` | `input.scale.events_pulled`, `distinct_patterns_surfaced`, `bytes_pulled` (rawIngestBytes when present — vendor-billable bytes, per RenderInput doc) |
| `totals.removableBytes` | sum over plan actions of per-pattern `metrics.bytes_in_window` × action retention factor (window arithmetic; NOT `expected_savings_usd_per_month`, which is monthly + dollar) |
| `totals.protectedKept` | severity aggregates (`output.aggregates.by_severity`) filtered by `severity-policy.ts` protected set |
| `verdict.dominantSharePct/clusterLabel` | `output.incidents[]` (from `detectIncidents`): cluster members' `bytes_in_window` sum / window total; label = `representative_descriptor` (verbatim, per detector contract) |
| `actions[].evidence` faces | built fresh from `ExtractedPattern.template` — see Faces below |
| `actions[].impactBytes` | member patterns' `bytes_in_window` × retention factor |
| `actions[].change` | what configure_engine truly emits — see below |
| `verify[]` | `DoctorReport.globalChecks/perEnvChecks` (`{name, status: pass\|warn\|fail, message, fix?}`) mapped pass→ok, warn/fail→shown with message; POC-run facts (events resolved, weld integrity) computed in-flow; tier delivery from env registry → `not_configured` gray state |
| `kept` | severity aggregates + plan's trimmed-family counts |

`estimate_savings` / `savings` / `commitment_report` are NOT report
inputs in v1. They are dollar/monthly-centric (ForecastRow,
SavingsSummary, CommitmentReportEnvelope) and the report leads with
window volume. The rerun before/after column (v2 of the report) will
map from `estimate_savings` verify-mode
(`baseline_bytes/post_passed_bytes/attribution`) — noted for later,
not built now.

`validate` returns a plain markdown string (envelope outlier) — it
cannot feed a typed VERIFY panel; v1 uses doctor + in-flow facts only.

### Faces (new construction — no existing concept)

Audit confirms no face/bytes-each representation exists anywhere.
Build `src/lib/report/face-extraction.ts`:

- Input: `ExtractedPattern.template` (carries `$` and `$(...)` slot
  markers natively) + per-pattern `count`, `bytes/count` for
  bytes-each, `hash` (identity rule: `symbolMessage` else short
  templateHash — same rule the renderer uses; templateHash never as
  the headline identity).
- Split on `/\$\([^)]*\)|\$/` (same regex family as
  `extractLiteralPhrase`) into `FaceSegment[]`; tab separators from
  the engine's field structure; welded continuation lines become
  `cont: true` lines; lines beyond the cap become `elidedLineCount`
  ("+ N more lines in this statement" — count elision allowed,
  intra-line cutting never).

### THE CHANGE — what configure_engine truly emits (audited)

The ONLY artifact configure_engine emits today is the container-keyed
cap CSV `pipelines/run/receive/rate/caps.csv`, header `container,cap`,
rows `<container>,<capBytes>:<action>:<reason>` — one row per
container, per-pattern rows collapsed into container sums
(`renderCsvDiff`, configure-engine.ts:2935). Delivery = `csv_diff` +
`pr_command` (gitops), or `kubectl_configmap`. `mute-csv-writer`
(per-pattern `<hash>,<sample_rate>:...`) is orphaned from the MCP
surface: reachable only via the `tenx-recur` CLI; its other importer
is dead code. `head_only` does not exist in the action vocabulary
(`Action = pass|sample|compact|tier_down|offload|drop`).

Consequences for the report (per the do-not-paper-over rule):

- `ReportAction.kind` v1 = `'cap' | 'tier_down' | 'operational'` —
  NOT the mock's `head_only`. Real per-pattern disposition
  (`head_only` per hash) is an ENGINE work item, recorded in
  HANDOFF_ENGINE_DEMO_POC.md, not rendered as if it shipped.
- THE CHANGE block renders the container-keyed rows verbatim, with a
  fixed comment frame naming which evidence hashes live in which
  container ("these N statements run in container X; the engine caps
  the container; per-statement disposition is pending engine work" —
  the `engineGapNote`).
- Known drift, do not inherit silently: THREE cap-CSV grammars are
  live (configure-engine `<bytes>:<action>:<reason>` container-only;
  poc-envelope-v2 `buildCapCsv` `<bytes>::<reason>` with `pat:` rows;
  cap-csv-parser docs claiming a third). The report renders the
  configure-engine grammar ONLY (it is what the engine consumes).
  The v2 `cap_csv` field is not shown to users. Grammar unification
  is a separate MCP work item, out of scope here.

### poc_from_local unification (prerequisite wiring)

Audit: poc_from_local shares only `extractPatterns` + format with the
SIEM path — no RenderInput, no enrichment, no clustering, no v2
envelope, nothing written to disk. The HTML step therefore rides on
unifying it with the enriched path:

1. Build a `RenderInput` from `LocalSourceResult` (missing pieces and
   their fills: `snapshotId` = generated; `queryUsed` = the kubectl
   selector; `analyzerCostPerGb`/`rateSource` = from new optional
   `siem` arg via `DEFAULT_ANALYZER_COST_PER_GB`, else dollars stay
   off per the volume-led rule).
2. Run the SAME enrichment the SIEM path runs: `_enrichForEnvelope` +
   `detectIncidents` (+ redundancy pairs) → `buildPocEnvelopeV2` with
   `tool: 'log10x_poc_from_local'` (the union slot already exists).
3. Then `buildReportData(envelopeV2, doctor, envCtx)` →
   `renderReportHtml` → write `report.html` to the working directory;
   the tool's chat envelope gains `report_path` and shrinks — the
   markdown 9-section renderer is NOT invoked from poc_from_local
   (it stays the poc_from_siem chat surface, frozen).

New `siem?: SiemId` and forwarder context: forwarder + namespace +
workload come from discovery (`DetectedForwarder{kind, namespace,
workloadKind, workloadName}` in discovery/types.ts) when available;
absent values render as explicit `<fill-me>` placeholders in
commands, never guessed.

Forwarder vocabulary trap (audited): two incompatible enums exist —
`ForwarderId` (`'fluent-bit'`, includes splunk-uf/datadog-agent) in
forwarder-snippets.ts vs `SUPPORTED_FORWARDERS` (`'fluentbit'`,
includes vector) in advise-install.ts, plus discovery's
`ForwarderKind`. The command matrix keys on discovery's
`ForwarderKind` (it is what we actually detect); a small explicit
alias map converts, no fourth vocabulary. There is NO install_method
type anywhere; the de-facto axis is the k8s/host split in
`applyInstructions` (forwarder-snippets.ts:232). The matrix's
install_method key = `'k8s' | 'host'` v1, extensible.

## Incident clustering

Reuse `src/lib/detectors/incident-cluster.ts` unchanged (union-find
over descriptor-token overlap + volume correlation, hard same-service
gate, calibrated thresholds — do NOT retune). Audit note: clustering
runs over DESCRIPTOR tokens (lowercased, ≥3 chars, non-numeric), not
identities; it is invoked from poc-enrichers/top_patterns and is NOT
reachable from poc_from_local today — the unification step wires it
in. Report additions on top of it, not inside it:

- Verdict dominance: share = cluster members' window bytes /
  window total. The 1.1.47 cause-word naming means representative
  labels carry the cause ("no_such_host") without new code.
- Variant analysis for "identical stack on every occurrence": for a
  clustered statement, compare welded continuation lines across
  occurrences; if byte-identical, the head_only frame may say
  "identical call stack" and the change is provably lossless-ish
  (first line + diagnosis survive).

## Command matrix

Versioned data files keyed `(forwarder × install_method × siem)`.
Keys: forwarder = discovery's `ForwarderKind` (with an explicit alias
map from the other two enums — no fourth vocabulary); install_method
= `'k8s' | 'host'` (no InstallMethod type exists anywhere; this
mirrors the de-facto split in `applyInstructions`). Initial cells
(only these two ship in v1):

1. `fluentd × k8s × cloudwatch`
2. `hec × host × splunk` (HEC is a delivery path, not a detected
   forwarder; the cell key uses the literal `'hec'` extension slot)

Layout: `src/lib/report/command-matrix/<siem>/<forwarder>.<install>.ts`
exporting a typed cell:

```ts
interface CommandCell {
  applyCaps(ctx: CmdCtx): string[];     // THE CHANGE apply commands
  undoCaps(ctx: CmdCtx): string[];
  applyTierRoute?(ctx: CmdCtx): string[];
  undoTierRoute?(ctx: CmdCtx): string[];
  checkDns?(ctx: CmdCtx): string[];     // operational diagnostics
}
interface CmdCtx {                      // filled from env registry /
  namespace?: string;                   // discover-env — never guessed;
  workload?: string;                    // absent value => the command
  capsFileName: string;                 // block renders a placeholder
}                                       // with an explicit fill-me marker
```

Missing ctx values do NOT get invented defaults: the command renders
with a visibly-marked placeholder (`<namespace>`) and the VERIFY panel
notes it. Commands are exactly where hallucination is unaffordable —
so the cells are static data, tested per cell (nightly-mcp-audit
pattern), and the agent never composes them.

## Input normalization (analyze-file flow)

Measured requirement (engine handoff §20): fluentd/k8s-wrapped JSON
must be pre-extracted before templating — without it the templater
sees the wrapper (mangled names, no welds); with it, clean patterns
and welds intact.

Audit facts that shape the design:
- `poc_from_local` today accepts only `source: 'kubectl'`
  (docker/journald throw). The analyze-file flow = a new
  `source: 'file'` + `path` arg on poc_from_local. That is where the
  wrapped 205MB-sample case enters.
- `coerceToLine` (pattern-extraction.ts:608) already unwraps
  `log`/`message`/`_raw` with one level of JSON descent — but it
  DROPS the wrapper, losing container attribution, which the
  container-keyed cap CSV needs. `extractEnrichmentFromEnvelope`
  only fires on object events; file lines are strings.
- `sourcePattern` appears nowhere in this repo; the
  `<container_id>\t<log>` + sourcePattern contract belongs to direct
  engine invocations, not the MCP templater path.

Design: a ~20-line normalizer in the file-source path, BEFORE byte
accounting and extraction (audit "seam B", re-deriving composition
so totalBytes doesn't desync):

1. Sniff first N lines: JSON-object-per-line with `log` (docker/
   fluentd) or `message` field + k8s/docker wrapper keys.
2. If wrapped: decode each record; keep `(containerId, logLine)`
   pairs; recompute per-container composition and totalBytes from
   the UNWRAPPED payloads (billable-bytes note: rawIngestBytes keeps
   the wrapped size, mirroring RenderInput's rawIngestBytes
   contract).
3. Feed unwrapped lines to `extractPatterns`; container attribution
   travels alongside for the change-block container mapping.

The engine's per-value unescape gap is a SEPARATE engine work item
(already in HANDOFF); the MCP does not wait for it.

## Engine gap (do not paper over)

`configure_engine` today emits a CONTAINER-keyed cap CSV. Real
per-pattern disposition (`<hash>,head_only` / `<hash>,tier_down`)
needs the mute-csv-writer path (memory:
burned_configure_engine_per_pattern_action_never_ships). Therefore:

- THE CHANGE block renders the artifact configure_engine truly emits.
- When the plan's granularity exceeds the artifact's (per-pattern
  intent, container-keyed artifact), the block carries a fixed
  `engineGapNote` naming the delta honestly.
- The per-pattern CSV shown in the mock becomes real only when the
  engine work lands; that work is logged in
  HANDOFF_ENGINE_DEMO_POC.md, not started here.

Audited: `mute-csv-writer.ts` emits per-pattern
`<hash>,<sample_rate>:<untilEpoch>:<reason>` rows (header
`fieldSet,value`) targeting the SAME file as the container cap CSV
with a DIFFERENT header and key space — a real collision hazard its
own code acknowledges. No MCP tool calls it: it is reachable only
from the `tenx-recur` CLI binary; its other importer
(`l1-outcome-multiplexer.routeOutcome`) has zero callers. The
per-pattern path is therefore an engine+MCP work item, logged in
HANDOFF_ENGINE_DEMO_POC.md, and the report never claims it.

## Rendering & testing

- Template: a single TS module (`src/lib/report/html-template-v1.ts`)
  producing self-contained HTML — inline CSS from the mock (light +
  dark via prefers-color-scheme), no external assets, no JS required
  for v1 (details/summary for collapsibles).
- Determinism: same `ReportData` → byte-identical HTML. No Date.now()
  inside the renderer; `generatedAtIso` comes in via data.
- Golden files: `test/fixtures/report-golden/*.html` rendered from
  checked-in `ReportData` fixtures; test compares byte-for-byte and
  fails with a diff. One golden per: full plan (3 kinds), no-cluster
  fallback verdict, rerun with before/after, refusal cases covered as
  unit tests (not goldens).
- Rule tests independent of goldens: no `…` anywhere in output; no
  `$` amounts unless rate supplied; hash absent from h1/h3 text;
  annotation escaping (HTML injection from agent text).

## Traps (repo)

- merge to main = npm PUBLISH; PR must bump package.json
  (ci: version-bump-check). Verify `npm view log10x-mcp version`
  moved after merge.
- publish.yml can skip and exit SUCCESS — src-only PR ships nothing;
  this change touches src + assets-equivalent template code, keep an
  eye on `files` in package.json if any non-src asset is added.
- The long-lived checkout at ~/git/l1x-co/log10x-mcp holds unrelated
  in-flight work (feat/elastic-flavors, staged); this workstream
  lives in the `log10x-mcp-poc-report` worktree on
  `feat/poc-report-renderer`.
