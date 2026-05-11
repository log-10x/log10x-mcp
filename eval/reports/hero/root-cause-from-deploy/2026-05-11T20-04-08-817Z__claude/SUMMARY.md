# Hero scenario: Root cause — attribute a top-mover pattern back to the deploy that introduced it

**Scenario:** `root-cause-from-deploy`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T20:04:08.822Z
**Duration:** 120.6s
**Bash calls:** 11

## User question

> Our 'checkout retry storm' alert just fired. A pattern matching that name is firing as ERROR in the otel-demo k8s namespace, emitted by the service synthetic-canary-app. I think the underlying deploy was triggered from a GitHub repo and the commit SHA is stamped on the Deployment object as the annotation canary.github.io/sha (and on the pod env as GITHUB_SHA). Find: (1) the SHA on the live Deployment via kubectl, (2) resolve which GitHub repo owns that SHA (try the talwgx/test repo as a starting point), and (3) name the commit message + author + parent PR if any. Cite tool outputs. You have kubectl configured for the log10x-otel-demo cluster and gh CLI available.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 1 supported · 0 inconclusive
- **Value delivered:** 0.98 — All three requested items are answered with exact tool citations: the SHA from kubectl, the repo confirmed via gh api, and the full commit message/author/PR status, plus actionable next steps for an SRE.
- **Value received:** 0.65 — kubectl and gh CLI returned the critical data needed, but the MCP tools (log10x_pattern_examples, log10x_top_patterns for the specific service) returned stubs or errors, providing only indirect confirmation of the alert pattern rather than live log examples.
- **Cost (runner only):** $0.1289 — 30648 in / 2462 out tokens across 6 API calls

## Sub-agent final synthesis

All data is in hand. Here is the complete, tool-traced synthesis:

---

## 🔍 Checkout Retry Storm — Root Cause Investigation

### (1) SHA on the Live Deployment — `kubectl` confirmed

From `kubectl get deployment synthetic-canary-app -n otel-demo`:

| Annotation / Env Var | Value |
|---|---|
| `canary.github.io/sha` (Deployment annotation) | `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad` |
| `GITHUB_SHA` (pod env) | `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad` |
| `canary.github.io/run-id` | `25694150853` |
| `canary.github.io/mode` | **`bug`** ← 🚨 this is the smoking gun |
| `BURST_MODE` (pod env) | **`bug`** |

---

### (2) GitHub Repo — `gh api` confirmed

SHA `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad` resolves to:
**`talwgx/test`** — https://github.com/talwgx/test/commit/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad

---

### (3) Commit Message, Author & Parent PR

**Commit message** (verbatim from `gh api`):
```
feat(canary): bug mode for variance batch

Restaging canary in bug mode (retry-blast pattern) so the
variance backfill batch can run root-cause-from-deploy,
temporal-misattribution, adversarial-commit-sequence, and
concurrent-signals against a live symptom.

Co-Authored-By: Tal Weiss <talw.gx@gmail.com>
```

**Author:** `Tal Weiss <talw.gx@gmail.com>` (GitHub login: `talwgx`), committed `2026-05-11T20:03:11Z`

**Parent PR:** `gh api .../pulls` returned `[]` — **no associated pull request**. This was a direct push to the branch, not merged via PR.

**Parent commit** (`9582444ae9161d93713db62efbad047dbcfc464b`) was `chore(canary): roll synthetic canary back to baseline mode` — confirming the baseline→bug flip is deliberate and recent (38 minutes before this commit).

---

### What this means & what to do

1. **The alert is intentional** — the commit message states this is a deliberate "retry-blast pattern" staging for a variance backfill batch. The Deployment mode was explicitly flipped from `baseline` → `bug` at `2026-05-11T20:03:11Z`.
2. **The firing log pattern** (`run id idx synthetic canary mode bug run id github sha github run id idx`, rank #7, `$0.01/wk`) in the `otel-demo` namespace traces directly to this deploy — `BURST_MODE=bug` is driving the ERROR emission.
3. **No PR guard** — this `bug` mode was pushed directly without a PR, bypassing any review gate. Recommend adding a branch protection rule on `talwgx/test` requiring PRs for changes to `synthetic-canary/MODE`.
4. **Immediate action**: If the variance batch is complete, redeploy with `canary.github.io/mode: baseline` / `BURST_MODE=baseline` to silence the alert. If the batch is still running, acknowledge the alert in your alerting system with a link to commit `67b16e04`.
5. **Longer term**: The `synthetic-canary/MODE` file should be gated by CI with an explicit allowlist of valid modes and a mandatory expiry annotation so `bug` mode cannot persist past a TTL.

## Oracle validation

- Claims found: 1 numeric, 0 pattern names
- Supported by oracle: 1 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$0.01** — env ~5.44GB/day; claim within plausible cost band
    > d idx synthetic canary mode bug run id github sha github run id idx`, rank #7, `$0.01/wk`) in the `otel-demo` namespace traces directly to this deploy — `BURST_

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 6455ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 5350ms, stdout=1893B, stderr=0B

### 3. kubectl get deployment -n otel-demo -o json 2>/dev/null | python3 -c "...
exit=0, 1783ms, stdout=1305B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 5617ms, stdout=1009B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=1, 15323ms, stdout=288B, stderr=0B

### 6. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad 2>&1
exit=0, 371ms, stdout=4034B, stderr=0B

### 7. kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations}' 2>/de...
exit=0, 11136ms, stdout=1912B, stderr=0B

### 8. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad/pulls 2>&1
exit=0, 1269ms, stdout=2B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 14434ms, stdout=626B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 9528ms, stdout=83B, stderr=0B

### 11. # Check parent commit to understand what changed before the bug deploy...
exit=0, 430ms, stdout=345B, stderr=0B
