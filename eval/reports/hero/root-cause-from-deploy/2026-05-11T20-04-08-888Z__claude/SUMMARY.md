# Hero scenario: Root cause — attribute a top-mover pattern back to the deploy that introduced it

**Scenario:** `root-cause-from-deploy`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T20:04:08.902Z
**Duration:** 178.8s
**Bash calls:** 15

## User question

> Our 'checkout retry storm' alert just fired. A pattern matching that name is firing as ERROR in the otel-demo k8s namespace, emitted by the service synthetic-canary-app. I think the underlying deploy was triggered from a GitHub repo and the commit SHA is stamped on the Deployment object as the annotation canary.github.io/sha (and on the pod env as GITHUB_SHA). Find: (1) the SHA on the live Deployment via kubectl, (2) resolve which GitHub repo owns that SHA (try the talwgx/test repo as a starting point), and (3) name the commit message + author + parent PR if any. Cite tool outputs. You have kubectl configured for the log10x-otel-demo cluster and gh CLI available.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 0 inconclusive
- **Value delivered:** 0.95 — All three requested items were answered precisely: SHA (67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad from kubectl annotation), repo (talwgx/test confirmed via gh API), and commit details (message, author Tal Weiss, no parent PR), plus actionable remediation steps and context about intentional fault injection.
- **Value received:** 0.20 — kubectl and gh CLI (not MCP tools) provided all the meaningful data; the MCP tools returned mostly errors, unresolved patterns, and no data relevant to the checkout retry storm alert or synthetic-canary-app service.
- **Cost (runner only):** $0.2317 — 64268 in / 2595 out tokens across 9 API calls
- **Flags:** low_value_received

## Sub-agent final synthesis

The log10x observability backend does not have an indexed pattern for "checkout retry storm" — the alert fired from the Kubernetes/canary layer. All three primary questions are now fully answered from kubectl + gh CLI tool outputs. Let me compile the final synthesis.

---

## 🔍 Incident Summary: "checkout retry storm" Alert

### (1) SHA on the Live Deployment — from `kubectl`

**`canary.github.io/sha` annotation on `synthetic-canary-app` Deployment (namespace `otel-demo`):**
```
67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad
```
This SHA is stamped identically in **two places**, exactly as expected:
- `metadata.annotations["canary.github.io/sha"]` → `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`
- `spec.template.spec.containers[0].env["GITHUB_SHA"]` → `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`

Additional context from kubectl: `BURST_MODE=bug`, `BURST_RATE_PER_SEC=1.0`, `GITHUB_RUN_ID=25694150853`, Deployment revision 36, last progressed at `2026-05-11T20:03:33Z`.

---

### (2) GitHub Repo — from `gh api`

The SHA resolves to **`talwgx/test`** ✅ (the starting-point repo was correct):
- Full URL: `https://github.com/talwgx/test/commit/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`
- The only file changed: `synthetic-canary/MODE` — a 1-line diff, `baseline` → `bug` (+1/-1).

---

### (3) Commit Message, Author & Parent PR — from `gh api`

| Field | Value |
|---|---|
| **Commit message (subject)** | `feat(canary): bug mode for variance batch` |
| **Commit message (body)** | *"Restaging canary in bug mode (retry-blast pattern) so the variance backfill batch can run root-cause-from-deploy, temporal-misattribution, adversarial-commit-sequence, and concurrent-signals against a live symptom."* |
| **Author** | `Tal Weiss <talw.gx@gmail.com>` (GitHub: `@talwgx`) |
| **Committed at** | `2026-05-11T20:03:11Z` |
| **Parent SHA** | `9582444ae9161d93713db62efbad047dbcfc464b` |
| **Parent PR** | **None** — `gh api …/commits/{sha}/pulls` returned `[]` (empty array; commit was pushed directly to the branch, no pull request) |

---

### What This Means & Recommendations

1. **This is an intentional synthetic fault injection**, not a real regression. The commit explicitly states it is "Restaging canary in bug mode (retry-blast pattern)" for a variance backfill batch exercise. The `BURST_MODE=bug` env var and the `canary.github.io/mode: bug` annotation confirm the canary was deliberately switched from `baseline` → `bug`.

2. **The alert is expected and correct** — it is firing as designed to create a live symptom for observability tooling to detect. No customer-facing service is implicated; `synthetic-canary-app` is the sole emitter.

3. **To silence the alert**, roll the Deployment back to the previous revision (`kubectl rollout undo deployment/synthetic-canary-app -n otel-demo`) or flip `synthetic-canary/MODE` back to `baseline` in `talwgx/test` and re-trigger the GitHub Actions workflow (`run-id: 25694150853` is the triggering run). No hotfix or incident escalation is warranted.

4. **Log10x observability note**: The pattern "checkout retry storm" is **not indexed** in the log10x backend under any known service — `log10x_event_lookup` returned no data. The alert source is the Kubernetes canary layer, not an organic application log stream.

## Oracle validation

- Claims found: 0 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)


## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 5464ms, stdout=703B, stderr=0B

### 2. kubectl get deployment -n otel-demo -l app=synthetic-canary-app -o json 2>/dev/null || kubectl get d...
exit=0, 1311ms, stdout=8672B, stderr=0B

### 3. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad 2>&1
exit=0, 899ms, stdout=4034B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=1, 5736ms, stdout=306B, stderr=0B

### 5. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad/pulls 2>&1
exit=0, 455ms, stdout=2B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 21074ms, stdout=584B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 23562ms, stdout=123B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 8482ms, stdout=584B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 9750ms, stdout=1009B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 9405ms, stdout=2341B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 8912ms, stdout=83B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 7073ms, stdout=117B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 4257ms, stdout=114B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 9101ms, stdout=111B, stderr=0B

### 15. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=1, 5240ms, stdout=288B, stderr=0B
