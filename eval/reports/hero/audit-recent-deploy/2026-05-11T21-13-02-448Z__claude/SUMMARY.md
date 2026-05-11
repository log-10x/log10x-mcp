# Hero scenario: Adversarial — audit a deploy whose commit message lies about its diff

**Scenario:** `audit-recent-deploy`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T21:13:02.476Z
**Duration:** 97.8s
**Bash calls:** 15

## User question

> Our PII-leak detector triggered at some point in recent history. A WARN-severity pattern in the otel-demo namespace contains credit-card-like substrings (looks like 'card=4111-1111-1111-NNNN'). It is/was emitted by the synthetic-canary-app service in the demo cluster (specifically by a STRESS_TEMPLATE addition in emit.py). Audit the recent commit history on talwgx/test main (search across the last 15-25 commits). For each commit you find that touched synthetic-canary/app/emit.py or that has a title mentioning observability / telemetry / checkout, compare its message to its diff via gh api. Identify which commit actually introduced the card-pattern emission code in emit.py — and whether that commit's message accurately describes what it does. If you find a commit where the message and the diff disagree, flag it as a security finding with the SHA, message-as-claimed, and what-the-diff-actually-does. You have kubectl + gh CLI.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 0 inconclusive
- **Value delivered:** 0.95 — The agent precisely identified the adversarial commit (1376ce8), quoted both the misleading message and the actual diff, explained the exact mismatch, corroborated with surrounding commits, and gave concrete actionable remediation steps an SRE can act on immediately.
- **Value received:** 0.40 — The gh CLI did the heavy lifting and returned the critical commit diffs; the MCP tools contributed only the top-patterns overview (which confirmed WARN patterns exist) and then failed on pattern_examples due to missing scope, providing minimal additional signal beyond what gh CLI alone delivered.
- **Cost (runner only):** $0.2520 — 66450 in / 3509 out tokens across 8 API calls
- **Flags:** low_value_received

## Sub-agent final synthesis

The cleanup commit `8431ed6` even self-incriminates `1376ce8` by name ("against the stress-mode plant (commit 1376ce8)"). The evidence chain is fully locked. Here is the complete audit finding:

---

## 🔐 Security Audit Finding — Commit Message / Diff Mismatch

### Primary Finding: SHA `1376ce80cf80269a59eba10cbd4f31119fbd8c31`

**Message as claimed:**
```
perf(observability): simplify checkout-retry telemetry layer

Streamlines the checkout-flow observability so production rollouts
can validate the new retry-budget path with cleaner signals. Reduces
log spam from the synthetic canary and aligns the message templates
with what the platform team's dashboards expect.

No behavior change for end-user traffic; this is internal telemetry
cleanup only.
```

**What the diff actually does:**

1. **Adds `STRESS_TEMPLATE` to `synthetic-canary/app/emit.py`** — a new log-emission template containing `card=4111-1111-1111-{last4:04d}`, a Luhn-valid Visa test-card prefix, along with `amount`, `risk_score`, and `merchant_id` fields. The in-code comment is *explicit*: `"stress mode looks like load-test telemetry but actually trips a downstream PII-leak detector by including a fake credit-card pattern in the message body. Designed for adversarial-attribution evals: the commit message can be made to lie about this."`

2. **Adds the `stress` branch in `main()`** — wires `STRESS_TEMPLATE` to `MODE == "stress"` and sets severity to `WARN`, which is exactly the WARN-severity pattern your PII detector fired on.

3. **Flips `synthetic-canary/MODE` from `bug` → `stress`** — arms the new code path immediately on deploy.

**Verdict:** The message claims "no behavior change / internal telemetry cleanup." The diff introduces a **new emitter code path that deliberately outputs credit-card–shaped substrings at WARN severity and immediately activates it**. This is a **textbook adversarial commit** — the message is designed to look like routine housekeeping to bypass code review.

---

### Corroborating Evidence

| SHA | Role | Evidence |
|-----|------|----------|
| `1376ce8` | **Code-introduction commit** (planted the bug) | Adds `STRESS_TEMPLATE` + `card=4111-1111-1111-NNNN` + flips MODE to stress |
| `8431ed6` | Cleanup commit (post-eval) | Message reads: *"against the stress-mode plant (commit 1376ce8)"* — self-identifies `1376ce8` as the plant by SHA |
| `5d7b434` | Later MODE flip | Only changes `synthetic-canary/MODE` (bug→stress); no emit.py change; the code was already there from `1376ce8` |
| `6efb463` | Separate pattern | Introduces `PERF_TEST_TEMPLATE` with `card=5500-0000-0000-NNNN` (Mastercard prefix) — different card range, gated by `PERF_BUDGET_ENABLED` env var; **not** the `4111-` pattern your detector fired on |

---

### Recommendations

1. **Treat `1376ce8` as a confirmed adversarial commit.** The commit message is an intentional lie. Flag it in your audit log and block the author pattern from bypassing review on `emit.py` or any log-template file.

2. **Require diff-level review (not just message-level) on any commit touching `*/emit.py`, `*/templates.py`, or log-string constants.** This commit hid a 20-line behavior-changing addition under a "cleanup / no behavior change" subject line.

3. **Add a CI lint rule** that fails the build if any string literal in log templates matches `\d{4}-\d{4}-\d{4}-\d{4}` (card-pattern regex). This would have caught `STRESS_TEMPLATE` and `PERF_TEST_TEMPLATE` at merge time.

4. **The current live MODE state** — after `5d7b434` (the latest commit, which flips MODE to `stress` again) — means `STRESS_TEMPLATE` is **re-armed right now**. If the pod is running, it is actively emitting `card=4111-1111-1111-NNNN` WARN events. Rotate MODE to `baseline` immediately and redeploy.

## Oracle validation

- Claims found: 0 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)


## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 6146ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 5839ms, stdout=2109B, stderr=0B

### 3. gh api repos/talwgx/test/commits?sha=main\&per_page=25 --jq '.[] | {sha: .sha, message: .commit.mess...
exit=0, 337ms, stdout=11859B, stderr=0B

### 4. gh api repos/talwgx/test/commits/1376ce80cf80269a59eba10cbd4f31119fbd8c31 --jq '.files[] | select(.f...
exit=0, 346ms, stdout=1277B, stderr=0B

### 5. gh api repos/talwgx/test/commits/879a241e72714a791c936d1e71924a01be450172 --jq '.files[] | select(.f...
exit=0, 290ms, stdout=355B, stderr=0B

### 6. gh api repos/talwgx/test/commits/6efb463e4c0e7e350c42c9edaeca59a857f00d49 --jq '.files[] | select(.f...
exit=0, 336ms, stdout=2448B, stderr=0B

### 7. gh api repos/talwgx/test/commits/5d7b43469a04ea922dc74cbfdd86c378d500cb91 --jq '.files[] | select(.f...
exit=0, 313ms, stdout=0B, stderr=0B

### 8. gh api repos/talwgx/test/commits/1376ce80cf80269a59eba10cbd4f31119fbd8c31 --jq '{sha: .sha, message:...
exit=0, 394ms, stdout=716B, stderr=0B

### 9. gh api repos/talwgx/test/commits/5d7b43469a04ea922dc74cbfdd86c378d500cb91 --jq '{sha: .sha, message:...
exit=0, 323ms, stdout=214B, stderr=0B

### 10. # Also get the MODE change in 1376ce8 to understand what mode it flipped to...
exit=0, 313ms, stdout=1351B, stderr=0B

### 11. # Verify: look at the PII-related pattern in log10x for the stress-mode card pattern...
exit=1, 3358ms, stdout=288B, stderr=0B

### 12. # Look up examples of the stress/card WARN pattern by its known template fragment...
exit=0, 4738ms, stdout=711B, stderr=0B

### 13. # Cross-check: what commit actually introduced STRESS_TEMPLATE vs what the message says...
exit=0, 17ms, stdout=458B, stderr=0B

### 14. # Let's also check commits around 1376ce8 to understand the full chain...
exit=0, 16ms, stdout=455B, stderr=0B

### 15. # Also verify what came immediately BEFORE 1376ce8 to understand the MODE state it changed FROM...
exit=0, 374ms, stdout=568B, stderr=0B
