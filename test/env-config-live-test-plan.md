# Env-Config Live Test Plan

Live end-to-end test plan for the env-config / retriever-probe / offload-add / env_diff_vs_envvars chain after the P0 fix set (typo rejection F1+F2, corrupt-ConfigMap warning F8, cross-tool store-chain read-back, multi-active offload audit).

The target cluster is the otel-demo EKS cluster. The target env_id is `6aa99191-f827-4579-a96a-c0ebdfe73884` (otel-demo).

> NOTE: The base 12-step happy-path body referenced upstream (`/private/tmp/.../tasks/wbpxy7a6q.output`) was not present on disk at authoring time. The happy-path section below is a reconstructed sequence covering the same ground (preflight + 12 ordered steps end-to-end through the env-config chain). Replace verbatim with the upstream body when it is recovered; the Preflight / Negative Cases / Cleanup sections do not depend on it.

---

## Preflight

These checks must pass before the happy-path runs. Each is a fail-fast gate.

### P1. kubectl context points at the otel-demo cluster

```bash
kubectl config current-context
# expect: arn:aws:eks:us-east-1:<acct>:cluster/otel-demo  (or the named otel-demo context)

kubectl get ns log10x -o jsonpath='{.metadata.name}'
# expect: log10x
```

### P2. log10x namespace has the expected DaemonSets

```bash
kubectl -n log10x get ds tenx-fluentd -o jsonpath='{.metadata.name}'
# expect: tenx-fluentd
```

### P3. MCP server is reachable and authenticated

```bash
mcp__log10x__log10x_login_status
```

Expect: `signed_in: true`, account email surfaced.

### P4. Customer-metrics backend reachable

```bash
mcp__log10x__log10x_doctor
```

Expect: `customer_metrics: ok`, `cross_pillar: ok` floor for env `6aa99191-f827-4579-a96a-c0ebdfe73884`.

### P5. No pre-existing env-config ConfigMap collision

```bash
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o jsonpath='{.metadata.name}' 2>&1
# expect: NotFound  (clean slate)  OR  the CM name (record for restore in Cleanup)
```

If found, capture for restore:

```bash
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o yaml > /tmp/env-config-backup.yaml
```

### P6. Capture current env vars for diff comparison

```bash
env | grep -E '^(LOG10X_|TENX_)' | sort > /tmp/env-vars-before.txt
```

---

## Happy Path

Twelve ordered steps. Each step has an action, expected envelope fields, and a single-line success check. Failures abort the sequence.

### Step 1 — Register the env doc to the k8s store

```
mcp__log10x__log10x_env_register
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  nickname="otel-demo"
  store="k8s"
  customer_metrics_url="https://prometheus.log10x.com"
  customer_metrics_auth_header="X-10X-Auth"
  customer_metrics_auth_value="<DEMO_API_KEY>/6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: envelope `result.store="k8s"`, `result.configmap_name="log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884"`, `result.written=true`.

### Step 2 — Verify ConfigMap was created

```bash
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o jsonpath='{.data.env\.json}' | jq .nickname
# expect: "otel-demo"
```

### Step 3 — Probe the registered env

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: envelope `result.env.nickname="otel-demo"`, `result.env.source="k8s_configmap"`, `result.env.env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"`, no `warnings[]` entry mentioning fallback.

### Step 4 — Cross-tool read-back via env_diff_vs_envvars

```
mcp__log10x__log10x_env_diff_vs_envvars
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: envelope `result.found=true`, `result.source="k8s_configmap"`, `result.diff[]` is a structured list (may be empty if env vars match), NOT `result.error="env_not_found"`.

### Step 5 — List envs surfaces the registered doc

```
mcp__log10x__log10x_services
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: services list returns 200, includes at least one service from otel-demo (e.g., `frontend`, `checkoutservice`, `paymentservice`).

### Step 6 — Register an offload route (single, active)

```
mcp__log10x__log10x_offload_add
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  bucket="log10x-offload-otel-demo"
  region="us-east-1"
  status="active"
  nickname="primary-archive"
```

Expect: envelope `result.offload_id` populated, `result.status="active"`, `result.written=true`.

### Step 7 — Verify offload visible to retriever_probe

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: envelope `result.offloads[]` includes `{nickname:"primary-archive", status:"active"}`, `result.offload_count=1`, no multi-active warning.

### Step 8 — Discover env via label-based discovery

```
mcp__log10x__log10x_discover_env
```

Expect: envelope `result.envs[]` contains the otel-demo env with `env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"` and `source="k8s_configmap"`.

### Step 9 — Top patterns retrieves with the registered env

```
mcp__log10x__log10x_top_patterns
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  window="1h"
  limit=5
```

Expect: returns 5 patterns with `pattern_hash` populated, `gb_per_day` populated, no `error.code="env_not_found"`.

### Step 10 — Update the env doc (nickname rename)

```
mcp__log10x__log10x_update_env
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  nickname="otel-demo-prod"
```

Expect: envelope `result.updated=true`, `result.diff.nickname.before="otel-demo"`, `result.diff.nickname.after="otel-demo-prod"`.

### Step 11 — Re-probe confirms the rename

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: `result.env.nickname="otel-demo-prod"`.

### Step 12 — Re-run cross-tool read-back after update

```
mcp__log10x__log10x_env_diff_vs_envvars
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: `result.found=true`, `result.source="k8s_configmap"`, diff reflects the rename if env vars still carry the old nickname.

---

## Negative Cases

Five sequences that drive into the failure modes the P0 fixes now handle correctly. Each must be runnable independently of the happy path, but assumes the happy path has registered the otel-demo doc (Step 1) unless its precondition says otherwise.

### Negative case 1 — TYPO REJECTION (F1+F2 fix)

**Name:** typo-rejection

**Precondition:** The otel-demo env doc is registered with `env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"` and `nickname="otel-demo"` (happy-path Step 1 has run). No other env doc is registered with a near-miss id.

```bash
# Confirm the registered doc exists
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o jsonpath='{.metadata.name}'
# expect: log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884

# Confirm the typo id has NO doc
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73885 -o jsonpath='{.metadata.name}' 2>&1
# expect: NotFound
```

**Action:** Register, then probe with a single-character typo on the last digit (`...884` → `...885`).

```
mcp__log10x__log10x_env_register
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  nickname="otel-demo"
  store="k8s"
```

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73885"
```

**Assert success:**
- Response is a structured error envelope. Either `result.error.code="env_not_found"` with `result.error.env_id="6aa99191-f827-4579-a96a-c0ebdfe73885"` and `result.error.searched_stores=["k8s","env"]`, OR an MCP tool error with the same env_id echoed in the message.
- `result.env` is absent or null.
- `result.env.source` is NOT `"env_var"` and NOT `"default.json"`.
- The response does NOT include the registered otel-demo nickname.

**Assert failure signature (if fix did not land):**
- `result.env.nickname="otel-demo"` (silent fallback to the only-registered doc), OR
- `result.env.source="env_var"` with a partial/synthetic env (silent env-var fallback), OR
- `result.env.source="default.json"` with no warning.
- No structured `error.code` field.

### Negative case 2 — CORRUPT ConfigMap (F8 fix)

**Name:** corrupt-configmap-warning

**Precondition:** The otel-demo env doc is registered to the k8s store (happy-path Step 1 has run). Capture the current ConfigMap for restore:

```bash
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o yaml > /tmp/env-config-before-corrupt.yaml
```

**Action:** Hand-patch the ConfigMap with malformed JSON, then probe.

```bash
kubectl -n log10x patch configmap log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 \
  --type merge \
  -p '{"data":{"env.json":"NOT VALID JSON {"}}'
```

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

**Assert success:**
- Either: envelope `result.warnings[]` contains an entry where `code` includes `corrupt_config` (or `parse_error`) AND `configmap_name="log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884"` AND mentions the env_id `6aa99191-f827-4579-a96a-c0ebdfe73884`.
- OR: structured error `result.error.code="env_config_parse_error"` with the same configmap_name and env_id.
- If the response includes data from a fallback (env var or default), `result.env.source` is set AND `result.warnings[]` explicitly names the fallback ("falling back to env_var because k8s ConfigMap is corrupt").

**Assert failure signature (if fix did not land):**
- `result.env.source="env_var"` with NO `warnings[]` entry (silent fallback masking the corruption).
- `result.warnings[]` empty AND `result.env` populated from a non-k8s source.
- Response success with no mention of the corrupt configmap name.

**Restore (must run regardless of pass/fail):**

```bash
kubectl -n log10x replace -f /tmp/env-config-before-corrupt.yaml
# verify
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o jsonpath='{.data.env\.json}' | jq .nickname
# expect: "otel-demo"  (or the value Step 10 left)
```

### Negative case 3 — MULTI-ACTIVE offloads (P1 audit)

**Name:** multi-active-offload-audit

**Precondition:** The otel-demo env doc is registered. No offloads currently registered (or capture the current set for restore):

```bash
mcp__log10x__log10x_retriever_probe env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
# capture result.offloads[] for restore
```

**Action:** Register two offloads, both with `status="active"`, then probe.

```
mcp__log10x__log10x_offload_add
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  bucket="log10x-offload-otel-demo-A"
  region="us-east-1"
  status="active"
  nickname="archive-A"
```

```
mcp__log10x__log10x_offload_add
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  bucket="log10x-offload-otel-demo-B"
  region="us-east-1"
  status="active"
  nickname="archive-B"
```

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

**Assert success (fix landed):**
- Envelope `result.warnings[]` contains an entry where `code` includes `multi_active_offload` AND names both nicknames (`archive-A`, `archive-B`) OR both bucket names.
- The warning surfaces a pick rule (e.g., `pick_rule="first_registered"` or `pick_rule="most_recent"`) so the operator can see which one wins.
- OR: tool refuses to act, returning `result.error.code="multi_active_offload"` with both offloads enumerated.

**Assert success (fix NOT yet landed, document current behavior):**
- If the codebase has not yet been touched for multi-active, the test still asserts an explicit observation: `result.offloads[]` has length 2 with both `status="active"`, AND a TODO marker is recorded in the test log. The test must NOT silently pass with `offloads.length==1`.

**Assert failure signature (silent first-wins, bug present):**
- `result.offloads[]` has length 1 (silent dedup) with no warning surfaced.
- `result.warnings[]` empty AND a second `offload_add` call previously returned `written=true`.
- Downstream tools (e.g., `log10x_retriever_query`) pick one without naming which.

**Cleanup:**

```
mcp__log10x__log10x_offload_remove env_id="6aa99191-f827-4579-a96a-c0ebdfe73884" nickname="archive-A"
mcp__log10x__log10x_offload_remove env_id="6aa99191-f827-4579-a96a-c0ebdfe73884" nickname="archive-B"
```

### Negative case 4 — WRONG-CLUSTER kubectl

**Name:** wrong-cluster-context

**Precondition:** A second kubeconfig pointing at a non-otel-demo cluster (or a deliberately-empty kubeconfig). Capture the current context to restore.

```bash
# Capture current context
kubectl config current-context > /tmp/kubectl-context-before.txt

# Option A: switch to a different real context
kubectl config get-contexts -o name
kubectl config use-context <some-other-cluster>

# Option B: simulate by pointing at an empty kubeconfig
echo "apiVersion: v1
kind: Config
clusters: []
contexts: []
users: []
current-context: \"\"" > /tmp/empty-kubeconfig.yaml
export KUBECONFIG=/tmp/empty-kubeconfig.yaml
```

**Action:** Probe while kubectl is pointing at the wrong cluster.

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

**Assert success:**
- Envelope `result.warnings[]` contains an entry where `code` includes `wrong_cluster_context` OR `cluster_mismatch`, naming the actual context (`<some-other-cluster>` or empty), AND naming the expected cluster label or the configmap-lookup failure.
- OR: structured error `result.error.code="cluster_context_mismatch"` with the current-context value echoed.
- If the tool reads from a fallback, `result.env.source` reflects the fallback AND a `warnings[]` entry names the fallback.

**Assert failure signature (silent write/read against wrong cluster, bug present):**
- `result.env.source="k8s_configmap"` with `result.env.nickname` populated from the wrong cluster's namespace (silent cross-cluster read), OR
- Tool succeeds with no `warnings[]` entry naming the context switch.
- Subsequent `log10x_env_register` calls write a ConfigMap into the wrong cluster's `log10x` namespace.

**Restore:**

```bash
unset KUBECONFIG
kubectl config use-context "$(cat /tmp/kubectl-context-before.txt)"
kubectl config current-context
# expect: original otel-demo context
```

### Negative case 5 — CROSS-TOOL read-back (store-chain-split fix)

**Name:** cross-tool-readback

**Precondition:** No existing env doc for this env_id (clean slate). Confirm:

```bash
kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884 -o jsonpath='{.metadata.name}' 2>&1
# expect: NotFound  (delete if it exists)
```

If present, delete:

```bash
kubectl -n log10x delete cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884
```

**Action:** Write via `env_register` to the k8s store, then immediately read via `env_diff_vs_envvars` (which historically read from a separate store-chain path).

```
mcp__log10x__log10x_env_register
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
  nickname="otel-demo"
  store="k8s"
  customer_metrics_url="https://prometheus.log10x.com"
  customer_metrics_auth_header="X-10X-Auth"
  customer_metrics_auth_value="<DEMO_API_KEY>/6aa99191-f827-4579-a96a-c0ebdfe73884"
```

```
mcp__log10x__log10x_env_diff_vs_envvars
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

**Assert success (POST-FIX):**
- Envelope `result.found=true`.
- `result.source="k8s_configmap"`.
- `result.env.nickname="otel-demo"`.
- `result.diff[]` is a list (may be empty if env vars match the just-written doc).
- No `result.error.code="env_not_found"`.

**Assert failure signature (PRE-FIX, store-chain split):**
- `result.error.code="env_not_found"` immediately after a successful `env_register` to the same env_id, OR
- `result.found=false`, OR
- `result.source="env_var"` despite the doc being written to k8s (read-back hit the wrong chain).
- A follow-up `kubectl -n log10x get cm log10x-env-config-6aa99191-f827-4579-a96a-c0ebdfe73884` confirms the ConfigMap IS present — proving the write succeeded and only the read-back chain is broken.

---

## Cleanup

Run after all happy-path and negative-case sequences complete, regardless of pass/fail.

### C1. Restore env-config ConfigMap if Preflight P5 captured one

```bash
if [ -f /tmp/env-config-backup.yaml ]; then
  kubectl -n log10x replace -f /tmp/env-config-backup.yaml || kubectl -n log10x apply -f /tmp/env-config-backup.yaml
fi
```

### C2. Remove test offloads

```
mcp__log10x__log10x_offload_remove env_id="6aa99191-f827-4579-a96a-c0ebdfe73884" nickname="primary-archive"
mcp__log10x__log10x_offload_remove env_id="6aa99191-f827-4579-a96a-c0ebdfe73884" nickname="archive-A"
mcp__log10x__log10x_offload_remove env_id="6aa99191-f827-4579-a96a-c0ebdfe73884" nickname="archive-B"
```

### C3. Restore kubectl context if Negative case 4 ran

```bash
unset KUBECONFIG
if [ -f /tmp/kubectl-context-before.txt ]; then
  kubectl config use-context "$(cat /tmp/kubectl-context-before.txt)"
fi
kubectl config current-context
```

### C4. Capture post-run env vars for comparison

```bash
env | grep -E '^(LOG10X_|TENX_)' | sort > /tmp/env-vars-after.txt
diff /tmp/env-vars-before.txt /tmp/env-vars-after.txt
# expect: no diff (test sequences must not mutate the operator's shell env)
```

### C5. Drop temp files

```bash
rm -f /tmp/env-config-backup.yaml /tmp/env-config-before-corrupt.yaml /tmp/empty-kubeconfig.yaml /tmp/kubectl-context-before.txt /tmp/env-vars-before.txt /tmp/env-vars-after.txt
```

### C6. Final sanity probe

```
mcp__log10x__log10x_retriever_probe
  env_id="6aa99191-f827-4579-a96a-c0ebdfe73884"
```

Expect: returns a valid envelope (whatever the post-cleanup state is), proving the chain is still operational for the next test cycle.
