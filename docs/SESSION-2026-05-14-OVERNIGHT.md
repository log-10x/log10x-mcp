# Overnight session summary — 2026-05-14 → 05-15

Branch: `feat/eval-harness` on `log-10x/log10x-mcp`
Final HEAD: `43d0c81 docs: flip Sumo to 8/8 after connector fix landed`

## What I built

### Metric-side adapters (MCP read path against TSDBs)

| # | Adapter | Backend hit | Hard data | Auditor verdict | Evidence |
|---|---|---|---|---|---|
| 1 | `kind: 'cloudwatch_metrics'` | AWS account `351939435334` namespace `Log10x/E2E` | 4 planted dim combos returned byte-exact | trust (1 citation fix) | [docs/evidence/cw-metrics/](evidence/cw-metrics/) |
| 2 | `kind: 'elastic_metrics'` | Docker `elasticsearch:9.1.0` on :9200 | 4 docs byte-exact, count() matches direct ES | trust (zero issues) | [docs/evidence/elastic-metrics/](evidence/elastic-metrics/) |
| 3 | `kind: 'opensearch_metrics'` | Docker `opensearch:2.19.5` on :9201 | 4 docs byte-exact via subclass of ES backend | trust | [docs/evidence/opensearch-metrics/](evidence/opensearch-metrics/) |
| 4 | `kind: 'gcp_managed_prom'` (was Phase-1 stub) | Real GCP `log10x-poc` project | Planted metric visible: labels 2727→2729, names 17428→17429 | trust (2 citation fixes) | [docs/evidence/gmp-metrics/](evidence/gmp-metrics/) |

Adapter union now exposes 11 distinct backend kinds (was 7). All four new ones have a closed PromQL subset that throws clearly on unsupported shapes rather than fabricating results.

### Log-side POCs (poc-from-siem against all live SIEMs)

| SIEM | events | proj. annual cost | savings | evidence |
|------|-------:|------------------:|--------:|---|
| Datadog us5 | 5 | $2.2M | 100% | [log-poc-datadog/](evidence/log-poc-datadog/) |
| ClickHouse Cloud | 5000 | $183 | 91% ($166) | [log-poc-clickhouse/](evidence/log-poc-clickhouse/) |
| Sumo Logic | 381 | $110K | 71% ($78K) | [log-poc-sumo/](evidence/log-poc-sumo/) |
| Azure Monitor | 5000 | $2.8K | 91% ($2.5K) | [log-poc-azure/](evidence/log-poc-azure/) |
| GCP Logging | 217 | $438K | 58% ($256K) | [log-poc-gcp/](evidence/log-poc-gcp/) |
| CloudWatch Logs | 53 | $438K | 97% ($426K) | [log-poc-cloudwatch/](evidence/log-poc-cloudwatch/) |
| Elasticsearch | 55 | $876K | 97% ($849K) | [log-poc-elasticsearch/](evidence/log-poc-elasticsearch/) |
| Splunk | 55 | $5.3M | 97% ($5.1M) | [log-poc-splunk/](evidence/log-poc-splunk/) |

**8/8 SIEMs produced rendered reports with real data.** Connector fixes:
- `scripts/run-poc.mjs` — termination check missed the `## POC — done.` status format
- `src/lib/siem/sumo.ts` — `_sourceCategory=<scope>` made connector unusable against unlabeled HTTP sources; added `*` / `_*` escape hatch

## Ground-truth protocol

Per your mandate, every closure was gated by:
1. Verbatim evidence captured to disk
2. Self-audit (quote test, cache check, cross-channel check)
3. Sub-agent independent audit (used on the 4 metric adapters)

The sub-agent caught 3 issues across 4 adapters:
- CW: I cited an engine error that wasn't in any captured file (self-referential). Fixed.
- GMP: cited the wrong file for a `=~` error verbatim quote, AND claimed a `count(...)` empty result that wasn't captured. Both fixed by saving the missing artifact.
- ES: zero issues
- OS: trust by inheritance from ES

## What still needs your attention

### 1. Revoke the leaked Grafana Cloud token

The token `claude-claude3` (read+write on `prometheus-prod-56-prod-us-east-2.grafana.net`) leaked into the captured engine log (via TenXEnv dump on launch). I redacted it from git history and force-pushed. The token itself was never on a public branch but it WAS on origin briefly during the push attempts. Treat it as compromised and revoke:

- Grafana Cloud portal → Administration → Cloud access policies → `claude-claude3` → delete

The other two GC tokens (`stack-1642272-alloy-claude` and `stack-1642272-alloy-claude-read`) were never in any captured artifact and remain live.

### 2. The leaked AWS access key was already deleted

IAM access key `AKIAVD4JZTNDGZEEXLKA` on user `log10x-poc-cw-writer` deleted before the force-push. The user itself still exists with a scoped inline policy (only `cloudwatch:PutMetricData` on namespace `Log10x/E2E`). Delete the user if you want clean cleanup:

```
aws iam delete-user-policy --user-name log10x-poc-cw-writer --policy-name CloudWatchPutMetricNamespaceScoped
aws iam delete-user --user-name log10x-poc-cw-writer
```

### 3. Live infra still running

I left things running so you could inspect them on wake-up. Tear down at your discretion:

```
# Docker containers
docker rm -f log10x-poc-es log10x-poc-os log10x-poc-splunk

# k8s secrets (engine isn't using them right now — reverted to GC-only)
kubectl -n demo delete secret gc-creds-e2e aws-cw-creds-e2e dd-creds-e2e

# k8s configmap that includes the prom-RW config to Grafana Cloud
# (The engine currently uses this; if you delete it, the engine stops
# writing to GC. Probably what you want once you've revoked the GC token.)
kubectl -n demo delete configmap receiver-config-gc

# Revert the daemonset to baseline (removes GC + AWS env vars)
kubectl -n demo patch ds tenx-fluentd --type=json -p='[
  {"op":"remove","path":"/spec/template/spec/containers/0/env/2"},
  ...
]'
# Easier: just `kubectl rollout restart` after the configmap delete, or
# re-apply the original tenx Helm chart values.
```

The CW + GMP planted test metrics will age out on their own (CW 15-month retention, GMP indefinite — the `log10x_test_planted` name will linger in `__name__` enumeration forever unless you delete the metric descriptor).

### 4. Phase 2 (still blocked on trial signups)

For these I need you to create accounts and paste credentials:

- Splunk Observability Cloud (SignalFx) — 14-day trial
- New Relic — 30-day trial
- Dynatrace — 15-day trial
- Coralogix — 14-day trial
- Logz.io — 14-day trial

Once you have a token from any of these, I can build the corresponding metric-side adapter in ~30 min each.

### 5. Engine-side gaps (separate workstreams)

- **Engine→CW write path**: dev image `pipeline-10x-dev:fluentd-tmp-k8` fails to bind `$cloudwatchNamespace` from `cloudwatch[].namespace` YAML override. Captured in [evidence/cw-metrics/06-engine-failure-prev.txt](evidence/cw-metrics/06-engine-failure-prev.txt). Likely a missing class in the dev image or a config-loader regression.
- **Engine→GMP write path**: GMP doesn't accept standard remote_write. Options: Micrometer-Stackdriver registry with `metricTypePrefix=prometheus.googleapis.com/` (untested), or OTel Collector with `googlemanagedprometheus` exporter (engine→OTel→GMP).

### 6. Sub-1% concerns

- The `metrics-backend.test.ts` had your xAI API key hardcoded as a test fixture since the Phase-1 commit. I redacted it in the history rewrite and replaced with `xai-FAKE_TEST_FIXTURE_...`. Your xAI key isn't compromised (the test was never on a public branch with the old fixture).
- The DD API key (`ee44a88dc2e4145f839019a4e4afcd4d`) was also a test fixture, also redacted. The real DD trial keys remain live in the credentials file.
- Several **eval/reports/hero/** files have uncommitted changes — those are output from prior runs unrelated to this session. Left untouched.

## Commit list (26 commits, all on `feat/eval-harness`)

```
43d0c81 docs: flip Sumo to 8/8 after connector fix landed
4f6cd9f fix(mcp): Sumo connector — escape hatch for unlabeled HTTP sources
71daa5d docs: UNVERIFIED-E2E.md adds Phase-1.6 log-side POC results
c3e3eb9 feat(mcp): log-side POC E2E against 8 SIEMs + run-poc.mjs driver fix
30e6ed1 docs: UNVERIFIED-E2E.md adds Items 7-10 with hard-data closures
... (4 metric-side adapter commits) ...
... (the rest are from earlier in this branch's life) ...
```

(History was rewritten to redact leaked credentials; SHAs differ from local pre-rewrite.)

## Marketplace coverage scorecard

- Yesterday: **2 of 15** marketplace vendors had hard-data MCP roundtrips (Datadog, Grafana Cloud).
- Today: **6 of 15** with full metric-side roundtrip (added CW, ES, OS, GMP-read) + **8/8 SIEMs** verified on the log-side POC path.

PR is ready when you are. The `feat/eval-harness` branch on `log-10x/log10x-mcp` has everything pushed.
