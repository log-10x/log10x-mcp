# E2E Test Progress — log10x_poc_from_siem

Persistent log of the end-to-end validation runs. Updated as work proceeds.

## Config

- **Sample file**: `/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log`
- **Size**: 205 MB, 197,430 newline-JSON lines (fluent-bit shape, otel-demo)
- **AWS**: account 351939435334, region us-east-1, user tal.weiss@l1x.co
- **Templating**: `privacy_mode: true` (local `tenx` v1.0.4 already installed)
- **Smoke target_event_count**: 50,000 (first run), then full 197K if time permits
- **Branch**: `feat/poc-from-siem` (PR #41)

## Steps

### 1. CloudWatch E2E

- [ ] create log group `/log10x/poc-test-otel` in us-east-1
- [ ] ship 197K lines via PutLogEvents (batched)
- [ ] run `log10x_poc_from_siem_submit` (siem=cloudwatch, scope=/log10x/poc-test-otel)
- [ ] poll status → complete
- [ ] save report to `docs/poc-sample-report-cloudwatch-real.md`
- [ ] delete log group (cleanup)

### 2. Elasticsearch E2E

- [ ] `docker run` ES 8.15 with security off on :9200
- [ ] wait for green
- [ ] bulk-load 197K events into index `otel-logs`
- [ ] run `log10x_poc_from_siem_submit` (siem=elasticsearch, scope=otel-logs)
- [ ] poll status → complete
- [ ] save report to `docs/poc-sample-report-elasticsearch-real.md`
- [ ] stop + rm container (cleanup)

### 3. Splunk E2E

- [ ] download Splunk (tarball, non-sudo)
- [ ] start splunkd, set admin password, accept license
- [ ] load sample file via `splunk add oneshot`
- [ ] create REST token (or use admin basic auth)
- [ ] run `log10x_poc_from_siem_submit` (siem=splunk, scope=main)
- [ ] poll status → complete
- [ ] save report to `docs/poc-sample-report-splunk-real.md`
- [ ] stop splunkd (cleanup)

## Issues encountered

### Issue 1: ES 9-client vs 8-server accept-header mismatch
- Our `@elastic/elasticsearch` v9.3.4 sends `Accept: application/vnd.elasticsearch+json; compatible-with=9`
- ES 8.15 container returned HTTP 400 `Accept version must be either version 8 or 7, but found 9`
- **Resolution**: pulled `docker.elastic.co/elasticsearch/elasticsearch:9.1.0` instead. Real user impact: connector requires ES 8+ and the client pins `compatible-with=9`, so ES <9 customers should use the ES 8 connector version — document in README as a caveat.

### Issue 2: macOS 12.7.6 blocks native Splunk 10.2
- Splunk 10.2.2 macOS installer refuses on macOS <13: "Your macOS version is not supported."
- **Resolution**: pivoted to `docker run splunk/splunk:latest`. Confirms the connector's REST-wrapper approach works regardless of install shape.

### Issue 4: Connector rejected auth-less Elasticsearch
- `xpack.security.enabled=false` dev clusters don't require auth, but our connector required `ELASTIC_API_KEY` or `ELASTIC_USERNAME+ELASTIC_PASSWORD` or returned "not configured"
- **Fix (committed)**: URL-only is now valid; the SDK just sends requests without auth headers. Updated `src/lib/siem/elasticsearch.ts` + error messages.

### Issue 5: ES 9 disallows `_id` as sort tiebreaker
- Our `search_after` pagination used `sort: [{'@timestamp': 'asc'}, {_id: 'asc'}]`
- ES 9 returns `illegal_argument_exception: Fielddata access on the _id field is disallowed` (`indices.id_field_data.enabled=false` by default)
- `_shard_doc` tiebreaker requires an open point-in-time (PIT) context; that adds non-trivial complexity
- **Fix (committed)**: sort by `@timestamp` only. Documented in-code that strict dedup requires PIT — deferred to a future iteration.

### Issue 3: Local `tenx` Homebrew install is broken
- `privacy_mode: true` failed with: `could not resolve include: 'run/bootstrap'`, `error reading /usr/local/Cellar/log10x/1.0.4/lib/tenx/modules/apps/shared/config.yaml`
- The bundled module layout in Homebrew 1.0.4 is missing `apps/shared` resources needed by `@apps/dev`
- **Resolution**: falling back to `privacy_mode: false` (paste Lambda). Reduces batch size via `autoBatch: true` in extraction. Will note in final summary that privacy_mode is gated by a working local tenx install.

## Reports

(links will be populated as each E2E completes)
