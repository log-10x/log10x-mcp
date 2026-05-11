# Hero scenario: Root cause — attribute a top-mover pattern back to the deploy that introduced it

**Scenario:** `root-cause-from-deploy`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T20:04:08.854Z
**Duration:** 170.7s
**Bash calls:** 15

## User question

> Our 'checkout retry storm' alert just fired. A pattern matching that name is firing as ERROR in the otel-demo k8s namespace, emitted by the service synthetic-canary-app. I think the underlying deploy was triggered from a GitHub repo and the commit SHA is stamped on the Deployment object as the annotation canary.github.io/sha (and on the pod env as GITHUB_SHA). Find: (1) the SHA on the live Deployment via kubectl, (2) resolve which GitHub repo owns that SHA (try the talwgx/test repo as a starting point), and (3) name the commit message + author + parent PR if any. Cite tool outputs. You have kubectl configured for the log10x-otel-demo cluster and gh CLI available.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 1 inconclusive
- **Value delivered:** 0.95 — All three requested items were answered with cited tool outputs: the SHA from kubectl, the owning repo confirmed as talwgx/test, and the commit message/author with a note that no parent PR exists, plus actionable next steps for the SRE.
- **Value received:** 0.30 — kubectl and gh CLI provided all the critical data, but the MCP tools (log10x_top_patterns, log10x_investigate, log10x_services) returned stubs or errors for the alert pattern investigation, meaning the MCP added little value beyond what native CLI tools provided.
- **Cost (runner only):** $0.2343 — 64981 in / 2626 out tokens across 11 API calls
- **Flags:** low_value_received

## Sub-agent final synthesis

I now have all the facts needed from the tools. Here is the full synthesis:

---

## ✅ Checkout Retry Storm — Root-Cause Correlation Report

### (1) SHA on the live Deployment — `kubectl` output

From `kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations}'`:

| Annotation | Value |
|---|---|
| `canary.github.io/sha` | **`67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`** |
| `canary.github.io/run-id` | `25694150853` |
| `canary.github.io/mode` | `bug` |

The pod's env var `GITHUB_SHA` is stamped with the identical value: `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`. This is Deployment revision **36**, deployed ~4h51m ago.

---

### (2) GitHub repo that owns the SHA

`gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad` resolved successfully. The SHA belongs to **`talwgx/test`** — the starting-point repo was correct.

URL: `https://github.com/talwgx/test/commit/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`

---

### (3) Commit message, author, and parent PR

| Field | Value (verbatim from `gh api`) |
|---|---|
| **Commit message** | `feat(canary): bug mode for variance batch` — *"Restaging canary in bug mode (retry-blast pattern) so the variance backfill batch can run root-cause-from-deploy, temporal-misattribution, adversarial-commit-sequence, and concurrent-signals against a live symptom."* |
| **Author / Committer** | `Tal Weiss <talw.gx@gmail.com>` (GitHub login: `talwgx`), committed `2026-05-11T20:03:11Z` |
| **Parent SHA** | `9582444ae9161d93713db62efbad047dbcfc464b` — parent commit message: `chore(canary): roll synthetic canary back to baseline mode` (perf-test mode validation complete) |
| **Associated PR** | **None** — `gh api repos/talwgx/test/commits/.../pulls` returned `[]` (no PR linked to this commit) |
| **File changed** | `synthetic-canary/MODE`: changed from `baseline` → `bug` (+1/-1 lines) |

---

### What this means & what to do

The `checkout retry storm` alert is **intentional by design** — commit `67b16e04` explicitly flipped `synthetic-canary/MODE` from `baseline` to `bug` to drive the `retry-blast pattern` for a variance backfill batch. The Deployment's `canary.github.io/mode: bug` annotation confirms the canary is running in deliberate fault-injection mode. **This is not an organic production regression.**

**Recommended actions:**
1. **Suppress or label the alert** — add an annotation to the alert rule (or a silence in your alertmanager) for deployments where `canary.github.io/mode=bug` to avoid false-on-call pages during planned canary runs.
2. **Confirm batch completion** — check GitHub Actions run ID `25694150853` in `talwgx/test` to see if the variance backfill batch has finished; once done, the canary should roll back to `baseline` (as the parent commit `9582444` pattern shows).
3. **Wire the SHA→PR flow** — the commit was pushed directly without a PR. Enforce a branch-protection policy so canary mode changes require a PR, giving you a traceable signal alongside the alert.

## Oracle validation

- Claims found: 1 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 1
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **1 lines** — no targeted oracle path for this kind; claim accepted as plausible
    > *File changed** | `synthetic-canary/MODE`: changed from `baseline` → `bug` (+1/-1 lines) | --- ### What this means & what to do The `checkout retry storm` al

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 5610ms, stdout=703B, stderr=0B

### 2. kubectl get deployment -n otel-demo 2>/dev/null || kubectl get deployment -n otel-demo --context=log...
exit=0, 1916ms, stdout=1503B, stderr=0B

### 3. kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations}' 2>/de...
exit=0, 3279ms, stdout=2088B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 6590ms, stdout=83B, stderr=0B

### 5. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad 2>/dev/null
exit=0, 556ms, stdout=4034B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_extract_templates --a...
exit=1, 19574ms, stdout=232B, stderr=0B

### 7. gh api "repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad/pulls" --header "Accept: ...
exit=0, 658ms, stdout=2B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=1, 21983ms, stdout=306B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 4871ms, stdout=584B, stderr=0B

### 10. gh api repos/talwgx/test/commits/9582444ae9161d93713db62efbad047dbcfc464b --jq '{sha:.sha, message:....
exit=0, 382ms, stdout=296B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 10144ms, stdout=1009B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 6038ms, stdout=83B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 9207ms, stdout=117B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 11113ms, stdout=582B, stderr=0B

### 15. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 9168ms, stdout=52B, stderr=0B
