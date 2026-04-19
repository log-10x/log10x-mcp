# E2E Test Progress — log10x_poc_from_siem

Persistent log of the end-to-end validation runs. Updated as work proceeds.

## Config

- **Sample file**: `/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log`
- **Size**: 205 MB, 197,430 newline-JSON lines (fluent-bit shape, otel-demo)
- **AWS**: account 351939435334, region us-east-1, user tal.weiss@l1x.co
- **Templating**: `privacy_mode: false` (paste Lambda — local `tenx` was broken, see Issue 3)
- **Smoke target_event_count**: 5,000 per run (full 197K templating would take ~20 min through the paste Lambda)
- **Branch**: `feat/poc-from-siem` (PR #41)

## Steps

### 1. CloudWatch E2E
- [x] create log group `/log10x/poc-test-otel` in us-east-1
- [x] ship 60K lines via PutLogEvents (batched)
- [x] run `log10x_poc_from_siem_submit` (siem=cloudwatch)
- [x] status → complete
- [x] report at `docs/poc-sample-report-cloudwatch-real.md`
- [ ] delete log group (cleanup) — deferred until final cleanup

### 2. Elasticsearch E2E
- [x] `docker run` ES 9.1 with security off on :9200
- [x] bulk-load 60K events into index `otel-logs`
- [x] run POC (elasticsearch, otel-logs)
- [x] status → complete
- [x] report at `docs/poc-sample-report-elasticsearch-real.md`
- [ ] stop + rm container (deferred until final cleanup)

### 3. Splunk E2E
- [x] download Splunk 10.2.2 macOS tarball (could not native-install; macOS 12)
- [x] pivot to `docker run splunk/splunk:latest` (6.97 GB image)
- [x] ship 60K events via HEC
- [ ] run POC (in flight)
- [ ] status → complete
- [ ] report at `docs/poc-sample-report-splunk-real.md`
- [ ] stop splunk container (deferred until final cleanup)

## Issues encountered (5 total — all fixed or documented)

### Issue 1: ES 9-client vs 8-server accept-header mismatch
- `@elastic/elasticsearch@9.3.4` sends `Accept: application/vnd.elasticsearch+json; compatible-with=9`
- ES 8.15 container returned HTTP 400: `Accept version must be either version 8 or 7, but found 9`
- **Resolution**: pulled `elasticsearch:9.1.0` instead
- **User impact**: connector works with ES 9+ only. If customers need ES 7/8, they should pin `@elastic/elasticsearch@8.x`. Documented in PR body.

### Issue 2: macOS 12.7.6 blocks native Splunk 10.2
- Splunk 10.2.2 macOS installer refuses on macOS <13: "Your macOS version is not supported."
- **Resolution**: pivoted to `splunk/splunk:latest` Docker container
- Confirms the connector is install-shape-agnostic (hits REST API regardless)

### Issue 3: Local `tenx` Homebrew install is broken on this box
- `privacy_mode: true` failed: `could not resolve include: 'run/bootstrap'`
- Homebrew 1.0.4 bundle is missing `apps/shared` resources
- **Resolution**: fell back to `privacy_mode: false` (paste Lambda path)
- **Affects**: any user whose tenx install is older/corrupt — they must use paste-Lambda mode until they reinstall. The `privacy_mode: true` path works fine when tenx is healthy; this box's tenx is just broken.

### Issue 4: Connector rejected auth-less Elasticsearch (REAL BUG — fixed)
- `xpack.security.enabled=false` dev clusters don't require auth, but the connector required `ELASTIC_API_KEY` or `ELASTIC_USERNAME+ELASTIC_PASSWORD` or returned "not configured"
- **Fix (committed 41ecd5e)**: URL-only is now valid; the SDK just omits auth headers. Updated error messages. Self-hosted dev clusters now supported.

### Issue 5: ES 9 disallows `_id` as sort tiebreaker (REAL BUG — fixed)
- `search_after` pagination sorted by `[@timestamp, _id]`. ES 9 returns `illegal_argument_exception: Fielddata access on the _id field is disallowed`
- `_shard_doc` tiebreaker requires an open point-in-time (PIT) context; adds complexity
- **Fix (committed 41ecd5e)**: sort by `@timestamp` only. Strict dedup at identical timestamps is documented as deferred; future iteration can open a PIT.

### Issue 6: Envelope enrichment (CW/ES reports showed service="unknown") — improvement, fixed
- First run of CW + ES POCs produced reports where every pattern was `service: unknown`
- Root cause: fluent-bit/k8s envelopes carry `kubernetes.container_name` and app labels, but the pattern extractor stripped those out before inferring service from the log text
- **Fix (committed 92abf80)**: extract envelope enrichment BEFORE stripping; aggregate per-pattern via majority voting. Services now show up correctly: `grafana`, `kafka`, `frontend`, `ad`, etc. Also handles CloudWatch (message-is-nested-JSON) + Splunk (`sourcetype`) + Azure KQL (`AppRoleName`).

### Issue 7: Splunk connector required token/rc-file only (gap, fixed)
- SPLUNK_TOKEN or `~/.splunkrc` were the only supported auth paths; SPLUNK_USERNAME/PASSWORD env vars were not read
- **Fix (committed 92abf80)**: added env-var basic auth path

## Reports

- CloudWatch: [docs/poc-sample-report-cloudwatch-real.md](docs/poc-sample-report-cloudwatch-real.md) — 5K events pulled from 60K-event log group, real AWS call
- Elasticsearch: [docs/poc-sample-report-elasticsearch-real.md](docs/poc-sample-report-elasticsearch-real.md) — 5K events pulled from 60K-doc `otel-logs` index
- Splunk: [docs/poc-sample-report-splunk-real.md](docs/poc-sample-report-splunk-real.md) — in flight as of last progress update
