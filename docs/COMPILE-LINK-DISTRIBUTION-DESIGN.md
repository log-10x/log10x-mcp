# Compile → Symbol Placement — design

Status: **draft / for review**
Owner: (you)
Baseline: **re-baselined against `main` @ `14b344a` (2026-06-16)** — after the
`feat/compile-tool` merge landed the full compile *producer*.
Scope: symbol **delivery** — getting a compiled `.10x.tar` to where a deployed
receiver/reporter retrieves it. The compile *producer* itself is now built (see §2).

> This replaces the earlier "Compile: Link & Distribution" draft. The producer-side
> proposals in that draft (output pinning; a link-only verb) shipped on main, so this
> revision re-baselines the current state and makes **placement** the subject.

---

## TL;DR

1. **The compile producer is DONE on main.** `log10x_compile` is now an async /
   bounded-sync subsystem: `log10x_compile` (waits inline ≤ `max_wait_ms`, else a
   pollable job), `log10x_compile_status` (job status + scan/link **diagnostics**),
   and `log10x_compile_link` (re-link an existing `.10x.json` units folder into a
   `.10x.tar`, no source scan). Output is **pinned** per source-set for reuse. Pull
   sources: local / GitHub / docker-image / Helm / Artifactory.
2. **The engine still does the link.** Every path runs `@apps/compiler`; nothing
   reimplements the binary `.10x.pb` index. `log10x_compile_link` just invokes the
   engine in link-only mode (`mergeExistingUnits true`). Our original "never
   reimplement link" principle held.
3. **What this doc previously proposed and is now DONE:** P0 *first-class persistable
   artifact* = **output pinning**; the *"no link-only verb"* open question =
   **`log10x_compile_link`**.
4. **What is still UNBUILT and is the point of this doc:** **placement** — delivering
   the `.10x.tar` to where a deployed receiver retrieves symbols. Verified on main:
   no `place_symbols` / `githubPush` / `symbolSource` / `symbols.git` code exists. A
   compiled library lands in a pinned local folder; the only follow-up is a local
   `log10x_validate`.
5. **Plan:** a new `log10x_place_symbols` tool, **git backend first**, reusing the
   **gitops-PR + kubectl-ConfigMap writers** that the recent *single-file control
   plane* work already unified in `configure_engine`.
6. **Verified 2026-06-16:** shipped reporter/receiver do **not** live-reload symbols
   (the reload unit is wired, but `@github` is off by default and delivery is one-time),
   so Phase 1 **defaults to commit → rollout-restart**; hot-reload is opt-in and needs a
   chart/config fix (§4 callout, §10 Q2).

---

## 1. Background: what "link" is (condensed)

Compile is **Pull → Scan → Link → Push**. Scan emits per-file *symbol units*
(`.10x.json`); **Link** merges them into a single distributable *symbol library*,
`<name>.10x.tar`, containing three entries: the merged `.10x.json`, a `.10x.pb`
Protocol-Buffer **reverse index** (symbol-hash → byte offsets, + an xxhash checksum),
and `manifest.10x.json`. The run pipeline's `symbolLoader` extracts the tar entries
**by name**, validates the checksum, and memory-loads the index.

**Link is engine-only and must never be reimplemented in TS** — the `.pb` is hand-
rolled protobuf with custom bit-packing whose correctness is checksum-enforced at
runtime, and the stage needs the cloud-flavor engine. The MCP delegates to
`@apps/compiler`. (Full mechanics: git history of the prior draft, or
`pipeline-extensions/.../FsSymbolUnitsIndex.proto`.)

---

## 2. Current state on main (re-baselined)

### The compile producer — built

| Tool | What it does |
|------|--------------|
| `log10x_compile` | Bounded-sync: waits inline up to `max_wait_ms` (45s default; `0` = fire-and-forget), else returns a pollable `job_id`. Sources combine freely: `source_path`, `github_repos`, `docker_images`, `helm_charts`, `artifactory_*`. Emits `.10x.json` units + a linked `.10x.tar`. |
| `log10x_compile_status` | Polls a `job_id`; returns job status, the units + linked tar, and **engine scan/link diagnostics** (per-language scan-failure counts, link merge/exclude counts, symbol-type histogram). |
| `log10x_compile_link` | Re-links an existing folder of `.10x.json` units into a fresh `.10x.tar` with **no source scan** — `@apps/compiler` invoked link-only with `mergeExistingUnits true`. |

Code: [compile.ts](../src/tools/compile.ts), [compile-status.ts](../src/tools/compile-status.ts),
[compile-link.ts](../src/tools/compile-link.ts), [compile-run.ts](../src/tools/compile-run.ts),
[compile-launch.ts](../src/tools/compile-launch.ts), [compile-jobs.ts](../src/lib/compile-jobs.ts),
[compile-runner.ts](../src/lib/compile-runner.ts). Tools registered in
[index.ts](../src/index.ts) (`log10x_compile` / `_status` / `_link`).

- **Output pinning** (commit `e586198`, `stableOutputKey`): the default output folder
  is pinned per source-set, so re-runs reuse prior units and the engine's checksum
  reuse fires (the old `Date.now()`/pid temp dir defeated it). A finished run is
  collectable near-instantly on a re-call. *This is the old P0 — done.*
- **Async/restart-robust jobs** (`compile-jobs.ts`): docker spawn drops `--rm` so
  status reads a true exit code via `docker inspect`; disk-backed job records survive
  an MCP restart.

### Where it STOPS (the remaining gap)

- The `.10x.tar` is written to a **pinned local folder** on the MCP host. Nothing
  delivers it anywhere.
- The only post-compile action is a suggested local smoke-test:
  `compile_status` → `log10x_validate` with `symbolPaths` pointed at the output folder
  ([compile-status.ts:283](../src/tools/compile-status.ts#L283)).
- **No push / placement / `symbolSource`.** `CompileConfig` carries only
  `output {folder, libraryFile, runtimeName}` (+ `mergeExistingUnits`, creds); the
  runner's extension-seam comment **still lists "PUSH" as a future axis**
  ([compile-runner.ts:20](../src/lib/compile-runner.ts#L20)). `gomod` pull is
  deliberately not exposed (transitive-dep flood). Artifactory is a *pull/input*
  source, **not** a delivery target.

So: **producer complete, delivery absent.** The library is "linked but stranded."

---

## 3. The gap: placement (the last mile)

The engine loads symbols **only as files** matched by `symbol.paths`
(`config/pipelines/run/symbol/config.yaml:17` =
`[ path("data/shared/symbols"), path("<TENX_SYMBOLS_PATH>") ]`), and hot-reload
happens **only** when a watched file's `lastModified()` changes
(`SymbolIndexFileProvider.reset()`). The MCP **cannot** write a running pod's
`TENX_SYMBOLS_PATH` from outside. So the model is forced:

> **Detect the receiver's active symbol source, then place the `.10x.tar` into THAT
> source; the engine's own retrieval path carries the bytes the last mile.**

---

## 4. The five retrieval paths (one-time vs live)

| # | Source | Carrier | Liveness | Practical size |
|---|--------|---------|----------|----------------|
| (a) | `symbols.git` | `log10x/git-config-fetcher` **initContainer** (`git clone --depth 1`) → emptyDir → `/etc/tenx/git/config/data/shared/symbols` | **One-time** (pod start); new commit invisible until **rollout** | ~GB (ephemeral) |
| (b) | `symbols.volume` | **PVC** at `/etc/tenx/symbols` | One-time; hot-reloads only if the file mtime changes in place | PVC capacity |
| (c) | engine **@github** GitOps loop | engine re-pulls on `syncInterval`, overwrites temp copy on blob-SHA change → mtime → reload | **Live, no restart** | ~100 MB |
| (d) | engine **@kubernetes** ConfigMap loop | engine polls ConfigMap, writes `binaryData` keys via atomic move → mtime → reload | **Live, no restart** | **HARD 1 MiB** (etcd) |
| (e) | **baked image** default | `/etc/tenx/symbols` frozen at build | One-time; new image tag + rollout | image layer |

Families: **(a)(b)(e) are one-time** (need a rollout to refresh); **(c)(d) are the
only live-reload layers.** The init container is a one-shot clone (`git clone --depth 1`,
`docker-images/ext/git-config-fetcher/tenx-config.sh`) — **not** a re-syncing sidecar.
Common trap: *pushing to the git repo does not update a running pod unless engine
@github is also enabled.* Reporter (DaemonSet), receiver (sidecar injected into the
user's forwarder) and retriever all use these patterns; **retriever doesn't actually
need symbols** (reads pre-indexed S3 data; the plumbing is wired but off by default).

> **Verified 2026-06-16 — default deployments do NOT hot-reload symbols.** The
> `reload`/`configLoader` unit *is* wired into every shipped run app
> (`modules/apps/shared/config.yaml:15` includes `run/reload`), so the hot-reload
> *machinery* is present. **But** the `@github` loop ships **disabled**
> (`config/apps/reporter/config.yaml:30` includes `gitops`, whose
> `config/pipelines/gitops/config.yaml` defaults `GH_ENABLED=false` with the
> `test/*.csv` glob — no symbols), and the common k8s delivery (init-container clone /
> PVC / baked image) is **one-time**. The engine *can* route a pulled symbol folder in
> — it expands each `@github`-pulled path as an `@<folder>` launch macro
> (`PipelineLaunchGitHubParser.java:275-288`) — but whether a pulled `.10x.tar` reaches
> a `symbolPaths` glob depends on repo layout and was not confirmed end-to-end (needs a
> live test). **Conclusion: out of the box there is no live symbol hot-reload; Phase 1
> must default to commit → rollout-restart** (see §8), and a real hot-reload path is an
> opt-in that also needs the chart/config fix in §10 Q2.

---

## 5. Placement backends (how the MCP writes each)

**Place the `.10x.tar` AS-IS** — never pre-extract (the engine reads the embedded
`.10x.json`/`.pb` by byte offset; only `.zip` is unpacked) and never chunk/split (the
splitter is line-based and would corrupt the binary).

### Backend 1 — Git commit to the user's repo (PRIMARY)
- **MCP writes:** commit the tar to the user's repo under `symbols/<name>.10x.tar`,
  reusing the gitops-PR / commit machinery `configure_engine` already uses (§9).
- **Receiver retrieves:** **(1a)** `symbols.git` initContainer — *one-time*, so the
  MCP must also emit a `kubectl rollout restart`; **or (1b)** engine @github loop —
  *hot-reload*, no restart.
- **Native-fit: highest** — push exists (MCP already commits to this repo for caps)
  and pull exists (chart `symbols.git` + engine @github both ship). **Effort: low–med.**

### Backend 2 — Kubernetes ConfigMap (SMALL libs / air-gapped)
- **MCP writes:** the MCP already applies ConfigMaps
  ([kubectl-writer.ts](../src/lib/configure-engine/kubectl-writer.ts)), but **text-only
  today** — a binary tar needs `binaryData` (base64) support added.
- **Receiver retrieves:** engine @kubernetes loop (hot-reload). Needs the keys glob
  extended to `*.10x.tar` (defaults `*.csv,*.json`) and SA `get` on the ConfigMap.
- **Blocker:** **HARD 1 MiB** — the engine only *logs* 413, does not auto-shard. Real
  libraries usually exceed this → route to git. **Effort: medium** (binaryData).

### Backend 3 — PersistentVolume (large / air-gapped)
- **MCP writes:** can't write a PVC from outside → needs a transient **k8s Job** that
  mounts the PVC and writes the tar (or `kubectl cp`). **Effort: med–high.**
- **Receiver retrieves:** PVC mount; hot-reloads if the write bumps mtime (atomic
  replace) and the reload unit watches the dir. **Size: unbounded.**

### Backend 4 — Object store / OCI artifact (FUTURE)
- **No run-side fetch layer exists in the engine** for S3/GCS/OCI symbols. Needs a
  net-new engine GitOps source. **Out of MCP scope until the engine ships it** — the
  scale path.

---

## 6. "Can we just use Argo?" — wiring, not transport

**No — Argo CD (and Flux) is not a symbol-delivery file pipe.** It reconciles
Kubernetes **manifests** into the cluster; it cannot materialize a `.10x.tar` into a
pod's `symbol.paths`. For symbols it owns the **wiring, not the bytes**: it keeps the
receiver chart + its symbol-source config (`symbols.git.enabled`, or `GH_ENABLED` env,
or the PVC claim) applied. The tar still travels via one of the §5 backends.

**Clean layering for an Argo shop** (composes with what we have): the user's GitOps
repo *is* the Argo source repo (the one `set-gitops-repo` records as `gitops.repo`).
The MCP commits the `.10x.tar` under `symbols/*.10x.tar` and/or the chart-values
wiring into that repo → **Argo = deployment reconciler** (syncs the chart, can
auto-rollout on repo change) → **engine @github loop = live symbol delivery** (pulls
the tar, hot-reloads). Treat Argo as an *optional wiring layer the MCP commits into*,
never the transport. Flux is identical (an `OCIRepository`/`GitRepository` feeds Flux
controllers, not the pod's `symbolPaths`).

---

## 7. Critical gotchas (must be in the implementation + docs)

1. **Engine @github (live) ships disabled by default** (`GH_ENABLED=false`) **and its
   paths glob is hardcoded `test/*.csv`, NOT env-overridable**
   (`config/pipelines/gitops/config.yaml:37`; only repo/branch/enabled are env vars).
   A real symbol deployment must ship a **customized gitops config** adding
   `symbols/*.10x.tar`, plus the **reload (configLoader) unit**. When @github isn't
   enabled, the place tool must fall back to the init-container variant + a rollout.
2. **Propagation latency (hot-reload)** ≈ GitHub poll scheduler's **~60s** fixed-delay
   floor (sub-minute `syncInterval` is floored) + reload `pollInterval` (10s) +
   commit/merge time. Don't advertise instant freshness.
3. **Init-container & PVC are one-time** — after placing, emit a rollout-restart unless
   the live @github/@kubernetes loop is active.
4. **Place the tar verbatim** (no extract, no split) — §5.

---

## 8. Recommended phasing (re-anchored to main)

**Phase 0 — DONE on main:** the compile producer (3 tools, diagnostics, output
pinning, local/github/docker/helm/artifactory pull); the engine does link; the
gitops-PR + kubectl-ConfigMap writers exist (in `configure_engine`); chart
`symbols.git` + `symbols.volume`; engine @github + @kubernetes loops; mtime
hot-reload. **No engine change needed for Phase 1.**

**Phase 1 — Git placement (ship first):**
- New tool **`log10x_place_symbols`** — `{ environment, library_path, backend?
  (default detect), repo?/branch?/path? overrides, dry_run }`. Implements
  `backend='git'`: commit the tar verbatim via the existing gitops-PR / commit writer.
- **Default delivery = commit → rollout-restart** (verified §4): shipped deployments
  don't live-reload symbols, so after committing, emit a `kubectl rollout restart` of
  the target reporter/receiver (the one-time init-container re-clones on restart). Only
  skip the rollout when detection confirms the live `@github` loop is active
  (`GH_ENABLED=true` + a `symbols/*.10x.tar` glob). Treat hot-reload as opt-in, not the
  default.
- Keep `compile` a pure producer; add a **`compile → place_symbols`** action
  (library path pre-filled), mirroring the existing `compile → validate` handoff.
- New env field **`symbolSource { backend, repo, branch, path, syncMode:
  'init'|'github' }`** in [environments.ts](../src/lib/environments.ts) — the
  detect-step state that doesn't exist today.
- **Detect helper:** classify the deployed pod via kubeconfig (initContainer image →
  git; PVC mount → volume; `GH_ENABLED` → @github; `K8S_ENABLED` → @kubernetes; else
  baked), falling back to declared `symbolSource` / chart values. Returns
  backend + liveness so the tool knows whether to also emit a rollout-restart.
- **Deploy-prereq doc** (no code): the @github glob override + reload unit (§7.1).

**Phase 2 — ConfigMap (small/air-gapped):** add `binaryData` (base64) to
`kubectl-writer`; add the `*.10x.tar` keys-glob override; keep the 1 MiB pre-flight;
reject oversized libs with a "use git backend" hint.

**Phase 3 — PVC-via-Job.** **Phase 4 — OCI/object-store** (blocked on engine).

---

## 9. Compose with the single-file control plane (updated)

The recent **single-file control plane** work (`e8a0916`, `14b344a`) is a gift here:
it consolidated `configure_engine` onto **one `caps.csv`** delivered by exactly the two
transports placement needs — a **gitops PR** (`renderPrCommand`) and a **kubectl
ConfigMap merge** (`applyViaKubectlConfigMap`, which now *merges* rather than replaces).
`place_symbols` is the **binary-cargo sibling** of `configure_engine`:

- **Same two transports, different cargo:** git PR / ConfigMap; a binary `.10x.tar`
  vs. text policy. **Share the writers, not the schemas.**
- **`set-gitops-repo` stays the policy plane** (`gitops.repo`). `place_symbols` reads
  `symbolSource.repo` if set, **else falls back to `gitops.repo`** — teams keep symbols
  (`symbols/*.10x.tar`) and policy (caps) in one GitOps repo, different folders. An
  Argo shop points both at its Argo source repo.
- **Install/advise** still only emits helm/kubectl strings (the MCP never runs helm),
  but should now also record the recommended `symbolSource` at install time, so
  detection is a lookup, not a live probe, in the common case.
- The `place_symbols` envelope returns a **verification_hint** (kubectl logs of the
  receiver showing the symbol re-index) so the user can confirm the new library went
  live.

Lifecycle becomes **`compile → place_symbols → receiver reload`** (or
`→ rollout-restart` for the one-time init/PVC backends), with no engine change.

---

## 10. Open questions (confirm before building)

1. ~~Does any production reporter/receiver enable the live @github/@kubernetes loop?~~
   **RESOLVED 2026-06-16 (§4 callout):** No — `@github` ships disabled (`GH_ENABLED=false`,
   `test/*.csv` glob) and the common delivery is one-time (init-container / PVC / baked).
   **Live hot-reload does not exist by default → Phase 1 defaults to commit + rollout-restart.**
2. **Should the chart / gitops config ship a corrected default** that includes
   `symbols/*.10x.tar` in the paths glob (and `GH_ENABLED=true`), so the hot-reload path
   works without operators hand-editing it? *(Now the key follow-up: this is what makes
   the opt-in hot-reload path real. Chart/config-team item, not MCP.)*
3. ~~Is the reload (configLoader) unit wired into the shipped run config?~~
   **RESOLVED 2026-06-16:** Yes — `modules/apps/shared/config.yaml:15` includes
   `run/reload` for all run apps. Residual unknown: whether an `@github`-pulled
   `.10x.tar` actually lands on a `symbolPaths` glob (engine expands the pulled folder
   as an `@<folder>` macro, `PipelineLaunchGitHubParser.java:275-288`, but the
   repo-layout → `symbol.paths` bridge needs a **live test**).
4. **Detection precedence** when live kubeconfig introspection disagrees with the
   declared `symbolSource` (operator hand-edited the deployment) — pick one + warn.
5. **git-config-fetcher version skew** — reporter pins `1.0.0`, retriever `0.9.7`;
   confirm the `--symbols-repo/-branch/-path` arg contract matches the live tag.
6. Should `place_symbols` reuse `log10x_compile_link`/`compile_status` output (the
   `library_files` path) directly as its `library_path` input, to make the
   `compile → place` handoff a clean pipe?

---

## 11. Files this will touch (Phase 1)

- `src/tools/place-symbols.ts` (new), registered in `src/index.ts`.
- `src/lib/symbol-placement/git.ts` (new) — reuse `configure_engine`'s gitops-PR writer.
- `src/lib/symbol-placement/detect.ts` (new) — pod/chart/`symbolSource` classification.
- `src/lib/environments.ts` — add the `symbolSource` field to the env config.
- `src/tools/compile-status.ts` (and/or `compile.ts`) — add the `→ place_symbols` action.
- (Phase 2) `src/lib/configure-engine/kubectl-writer.ts` — `binaryData` support.

Reference (engine/config/chart, read-only): `config/pipelines/run/symbol/config.yaml`,
`config/pipelines/gitops/config.yaml`, `helm-charts/charts/reporter/` (`values.yaml`,
`templates/daemonset.yaml`, `examples/gitops.yaml`),
`docker-images/ext/git-config-fetcher/`, `mksite/docs/config/{github,k8s}.md`.
