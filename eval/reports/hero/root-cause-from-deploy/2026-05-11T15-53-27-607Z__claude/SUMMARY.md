# Hero scenario: Root cause — attribute a top-mover pattern back to the deploy that introduced it

**Scenario:** `root-cause-from-deploy`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T15:53:27.613Z
**Duration:** 116.5s
**Bash calls:** 14

## User question

> Our 'checkout retry storm' alert just fired. A pattern matching that name is firing as ERROR in the otel-demo k8s namespace, emitted by the service synthetic-canary-app. I think the underlying deploy was triggered from a GitHub repo and the commit SHA is stamped on the Deployment object as the annotation canary.github.io/sha (and on the pod env as GITHUB_SHA). Find: (1) the SHA on the live Deployment via kubectl, (2) resolve which GitHub repo owns that SHA (try the talwgx/test repo as a starting point), and (3) name the commit message + author + parent PR if any. Cite tool outputs. You have kubectl configured for the log10x-otel-demo cluster and gh CLI available.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 0 inconclusive
- **Value delivered:** 0.95 — The agent fully answered all three requested items (SHA from kubectl, repo resolution, commit message/author/PR status) with tool-cited evidence and added actionable remediation steps an SRE could execute immediately.
- **Value received:** 0.20 — The MCP log10x tools returned almost nothing useful — event lookups failed, services listed synthetic-canary-app as unknown, top patterns showed no relevant data — so the real answers came entirely from kubectl and gh CLI, not from the MCP platform.
- **Flags:** low_value_received

## Sub-agent final synthesis

All three sources are confirmed. Here is the complete, tool-traced findings:

---

## 🔴 Checkout Retry Storm — Root-Cause Report

### (1) SHA on the Live Deployment — `kubectl` output

From `kubectl get deployment -n otel-demo synthetic-canary-app -o json`:

| Field | Value |
|---|---|
| `metadata.annotations["canary.github.io/sha"]` | **`f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3`** |
| `spec.template.spec.containers[0].env["GITHUB_SHA"]` | **`f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3`** ✅ (matches annotation) |
| `canary.github.io/run-id` | `25681133562` |
| `canary.github.io/mode` | `bug` |
| Deployment revision | `8` |
| Pod restart timestamp | `2026-05-11T15:53:01Z` |

Both the Deployment annotation and the pod environment variable carry the same SHA — no drift between control-plane metadata and runtime.

---

### (2) GitHub Repo that owns the SHA — `gh api` output

`gh api repos/talwgx/test/commits/f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3` resolved cleanly:

> **Repo:** `talwgx/test` ✅ — SHA was found on the first candidate.

---

### (3) Commit metadata — `gh api` output

| Field | Value |
|---|---|
| **Commit SHA** | `f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3` |
| **Author** | Tal Weiss `<talw.gx@gmail.com>` (GitHub login: `talwgx`) |
| **Committed at** | `2026-05-11T15:52:40Z` |
| **Commit message (subject)** | `feat(checkout): retry-storm canary for multi-model eval cross-validation` |
| **Commit message (body)** | *"Flips canary back to bug mode so Claude + Grok can both attempt the root-cause-from-deploy hero scenario against the same planted signal. Distinct from the prior bug commit (4756edc) so a new SHA flows through and we know the agents are not reading a stale state."* |
| **Co-author** | `Claude Opus 4.7 (1M context) <noreply@anthropic.com>` |
| **File changed** | `synthetic-canary/MODE`: `baseline` → `bug` (+1/-1) |
| **Parent SHA** | `dfd44875029efe1897b40526781db357589a68cd` |
| **Parent PR** | **None** — `gh api …/pulls` returned `[]` (no pull request associated) |

---

### Live log confirmation — `kubectl logs`

The pod is actively emitting at **~1 ERROR/sec** (per `BURST_RATE_PER_SEC=1.0`), stamping both the SHA and `mode: bug` in every line:
```
"checkout retry storm: payment-service returned 503 after N retries; abandoning cart cart_id=cart_XXXXXX deploy_sha=f8d6b30b ..."
```

---

### Recommendations

1. **Immediate**: The trigger is the `synthetic-canary/MODE` file flip from `baseline` → `bug` in commit `f8d6b30b`. Roll back the Deployment to the previous revision (`kubectl rollout undo deployment/synthetic-canary-app -n otel-demo`) or patch `canary.github.io/mode` back to `baseline` to silence the storm instantly.
2. **Short-term**: The commit was pushed **directly to the default branch** with no PR (the `/pulls` API returned empty). Enforce branch protection requiring a PR + review before any commit to the canary-controlling branch in `talwgx/test`.
3. **Observability**: The `synthetic-canary-app` service does not yet appear in log10x under its own service name (logs land under `(unknown)`). Fix the OTel `service.name` attribute in the emitter script so the canary's volume and error patterns are attributable and alertable independently.

## Oracle validation

- Claims found: 0 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)


## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 4633ms, stdout=703B, stderr=0B

### 2. kubectl get deployment -n otel-demo -l app=synthetic-canary-app -o json 2>/dev/null || kubectl get d...
exit=0, 991ms, stdout=8669B, stderr=0B

### 3. gh api repos/talwgx/test/commits/f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3 2>/dev/null
exit=0, 669ms, stdout=4137B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=1, 2900ms, stdout=306B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 21990ms, stdout=584B, stderr=0B

### 6. gh api repos/talwgx/test/commits/f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3/pulls 2>/dev/null
exit=0, 552ms, stdout=2B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 4756ms, stdout=1009B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 4078ms, stdout=123B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3642ms, stdout=83B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4351ms, stdout=1448B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 3994ms, stdout=111B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_event_lookup --args '...
exit=0, 3910ms, stdout=114B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3191ms, stdout=882B, stderr=0B

### 14. kubectl logs -n otel-demo -l app=synthetic-canary-app --tail=20 2>/dev/null
exit=0, 1404ms, stdout=9246B, stderr=0B
