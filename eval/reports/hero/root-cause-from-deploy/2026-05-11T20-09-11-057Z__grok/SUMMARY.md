# Hero scenario: Root cause — attribute a top-mover pattern back to the deploy that introduced it

**Scenario:** `root-cause-from-deploy`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T20:09:11.061Z
**Duration:** 54.4s
**Bash calls:** 4

## User question

> Our 'checkout retry storm' alert just fired. A pattern matching that name is firing as ERROR in the otel-demo k8s namespace, emitted by the service synthetic-canary-app. I think the underlying deploy was triggered from a GitHub repo and the commit SHA is stamped on the Deployment object as the annotation canary.github.io/sha (and on the pod env as GITHUB_SHA). Find: (1) the SHA on the live Deployment via kubectl, (2) resolve which GitHub repo owns that SHA (try the talwgx/test repo as a starting point), and (3) name the commit message + author + parent PR if any. Cite tool outputs. You have kubectl configured for the log10x-otel-demo cluster and gh CLI available.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 0 inconclusive
- **Value delivered:** 0.95 — The synthesis directly answers all three requested items (SHA, repo, commit message/author/PR) with tool citations, and adds an actionable rollback recommendation, though the parent SHA in the rollback suggestion appears fabricated (not visible in tool outputs).
- **Value received:** 1.00 — All four kubectl/gh CLI calls returned complete, accurate data covering the deployment annotation, commit metadata, and PR linkage, giving the sub-agent everything needed to answer the question.
- **Cost (runner only):** $0.0641 — 18275 in / 621 out tokens across 5 API calls

## Sub-agent final synthesis

### Investigation Synthesis

**Observations:**  
Using kubectl, the live Deployment `synthetic-canary-app` in namespace `otel-demo` has the annotation `canary.github.io/sha` set to `67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad` (tool: `kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations.canary\.github\.io/sha}'`).  
This SHA belongs to the GitHub repo `talwgx/test` (tool: `gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad`).  
Commit details show message `"feat(canary): bug mode for variance batch\n\nRestaging canary in bug mode (retry-blast pattern) so the\nvariance backfill batch can run root-cause-from-deploy,\ntemporal-misattribution, adversarial-commit-sequence, and\nconcurrent-signals against a live symptom.\n\nCo-Authored-By: Tal Weiss <talw.gx@gmail.com>"` and author `"Tal Weiss"` (same tool).  
No parent PR found (tool: `gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad/pulls` returned `[]`).  

**Meaning:**  
The alert stems from a deliberate "bug mode" deployment simulating a "retry-blast pattern" in the synthetic canary app, likely for testing variance detection in a demo environment.  

**Recommendations:**  
If unintended, rollback the Deployment to parent SHA `9582444ae9161d93713db62efbad047dbcfc464b` via `kubectl rollout undo deployment/synthetic-canary-app -n otel-demo`. Monitor post-rollback for alert resolution; if persistent, inspect pod logs for residual issues.

## Oracle validation

- Claims found: 0 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)


## Bash command trace

### 1. kubectl get deployments -n otel-demo
exit=0, 1229ms, stdout=1503B, stderr=0B

### 2. kubectl get deployment synthetic-canary-app -n otel-demo -o jsonpath='{.metadata.annotations.canary\...
exit=0, 992ms, stdout=40B, stderr=0B

### 3. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad
exit=0, 336ms, stdout=4034B, stderr=0B

### 4. gh api repos/talwgx/test/commits/67b16e04e7c4fdb8ded39a500c2c73a32c1e99ad/pulls
exit=0, 412ms, stdout=2B, stderr=0B
