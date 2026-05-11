# Hero scenario: Root cause — attribute a top-mover pattern back to the deploy that introduced it

**Scenario:** `root-cause-from-deploy`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-11T15:23:00.910Z
**Duration:** 102.6s
**Bash calls:** 14

## User question

> Our 'checkout retry storm' alert just fired. A pattern matching that name is firing as ERROR in the otel-demo k8s namespace, emitted by the service synthetic-canary-app. I think the underlying deploy was triggered from a GitHub repo and the commit SHA is stamped on the Deployment object as the annotation canary.github.io/sha (and on the pod env as GITHUB_SHA). Find: (1) the SHA on the live Deployment via kubectl, (2) resolve which GitHub repo owns that SHA (try the talwgx/test repo as a starting point), and (3) name the commit message + author + parent PR if any. Cite tool outputs. You have kubectl configured for the log10x-otel-demo cluster and gh CLI available.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 2 inconclusive
- **Value delivered:** 0.95 — All three requested items were answered with exact tool-cited evidence: SHA confirmed via kubectl annotation, repo confirmed as talwgx/test via gh API, and full commit message/author retrieved; the only minor gap is no parent PR exists (correctly reported as none).
- **Value received:** 0.35 — kubectl and gh CLI provided all the critical data needed, but the log10x MCP tools returned no useful signal—top_patterns had no data, investigate couldn't resolve the service or pattern, and services showed synthetic-canary-app was not yet indexed—so the MCP layer contributed nothing to the actual answers.
- **Flags:** low_value_received

## Sub-agent final synthesis

All three data points confirmed. The log10x pattern index is still warming up for the newly-deployed `synthetic-canary-app` (< 24h old, deployed ~10 minutes ago per the `kubectl get deployment` AGE), which is expected. All other facts are fully sourced from tool output. Here is the complete synthesis:

---

## 🔴 Checkout Retry Storm — Root Cause Synthesis

### (1) SHA on the Live Deployment — `kubectl`

**Source:** `kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations}'`

The annotation `canary.github.io/sha` on the `synthetic-canary-app` Deployment is:
```
4756edc3345dc9b9a42ef0279db843813234cefb
```
This SHA is stamped identically on both the **Deployment-level annotation** and the **pod's `GITHUB_SHA` env var** (confirmed via `kubectl get pods … -o jsonpath='{.items[0].spec.containers[0].env}'`). The companion annotation `canary.github.io/mode: bug` explicitly signals the canary is running in **bug/fault-injection mode**, and `BURST_MODE=bug` / `BURST_RATE_PER_SEC=1.0` confirms it is emitting synthetic ERROR traffic at 1 event/sec.

---

### (2) GitHub Repo That Owns the SHA — `gh api`

**Source:** `gh api repos/talwgx/test/commits/4756edc3345dc9b9a42ef0279db843813234cefb`

The SHA resolves cleanly in **`talwgx/test`**:
- URL: `https://github.com/talwgx/test/commit/4756edc3345dc9b9a42ef0279db843813234cefb`
- Committed: `2026-05-11T15:13:26Z`
- GitHub Actions Run ID: `25678940824`

---

### (3) Commit Message, Author & Parent PR — `gh api`

**Commit message (full, verbatim from tool):**
> `perf(checkout): bump payment-service retry budget to 5 attempts`
>
> *"The current 1-retry budget on the payment-service 503 path was causing legitimate transient timeouts to surface as cart-abandon events for end users. Bumping retry budget improves checkout conversion. Telemetry confirms most 503s clear within 2 retries. This commit flips synthetic-canary into a state where the pod's emit.py exercises the new retry path against a deliberately broken upstream, so we can validate the retry behavior end-to-end before shipping to real checkout traffic."*
>
> `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

**Author:** `Tal Weiss <talw.gx@gmail.com>` (GitHub login: `talwgx`)

**Parent commit SHA:** `fc580f73d12ba63230906ca25749c9c54685b34b`

**Parent PR:** `gh api repos/talwgx/test/commits/{sha}/pulls` returned `[]` — **no pull request is associated with this commit.** It was pushed directly to the branch without a PR.

**File changed:** `synthetic-canary/MODE` — patched from `baseline` → `bug` (1 addition, 1 deletion).

---

### Recommendations

1. **Immediate:** The `BURST_MODE=bug` canary is intentionally emitting ERROR-level checkout retry logs at 1 event/sec — the alert firing is **expected and by design** for this validation run. Suppress or route the `synthetic-canary-app` alert to a canary-only channel, not the primary oncall queue.
2. **Process gap:** This change was committed **directly** — no PR, no review. Enforce branch protection on `talwgx/test` to require PRs before any commit that touches `synthetic-canary/MODE` reaches the cluster.
3. **Canary hygiene:** The Deployment `canary.github.io/run-id: 25678940824` ties back to a specific GitHub Actions run — verify that run completed successfully and the canary is scheduled to flip back to `baseline` mode on completion, or add a TTL/cleanup job to avoid orphaned bug-mode canaries.
4. **Log10x pattern index:** `synthetic-canary-app` logs are not yet indexed (service is ~10 min old at investigation time; patterns appear after 24 h). Re-run `log10x_top_patterns` after the canary has been running for 24 h to validate the retry error pattern volume.

## Oracle validation

- Claims found: 2 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 2
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **1 event** — no targeted oracle path for this kind; claim accepted as plausible
    > ` / `BURST_RATE_PER_SEC=1.0` confirms it is emitting synthetic ERROR traffic at 1 event/sec. --- ### (2) GitHub Repo That Owns the SHA — `gh api` **Source:**
- [WARN] **1 event** — no targeted oracle path for this kind; claim accepted as plausible
    > T_MODE=bug` canary is intentionally emitting ERROR-level checkout retry logs at 1 event/sec — the alert firing is **expected and by design** for this validation

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 3117ms, stdout=703B, stderr=0B

### 2. kubectl get deployment -n otel-demo 2>/dev/null || kubectl get deployment -n otel-demo --context=log...
exit=0, 1134ms, stdout=1500B, stderr=0B

### 3. kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations}' 2>/de...
exit=0, 2124ms, stdout=2340B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=1, 3209ms, stdout=306B, stderr=0B

### 5. gh api repos/talwgx/test/commits/4756edc3345dc9b9a42ef0279db843813234cefb 2>/dev/null || echo "NOT F...
exit=0, 461ms, stdout=4356B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 4797ms, stdout=584B, stderr=0B

### 7. gh api repos/talwgx/test/commits/4756edc3345dc9b9a42ef0279db843813234cefb/pulls 2>/dev/null || echo ...
exit=0, 382ms, stdout=2B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 4730ms, stdout=123B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 5091ms, stdout=584B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4039ms, stdout=83B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 4385ms, stdout=1009B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3741ms, stdout=83B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3668ms, stdout=83B, stderr=0B

### 14. # Check the pod env to confirm GITHUB_SHA...
exit=0, 1354ms, stdout=257B, stderr=0B
