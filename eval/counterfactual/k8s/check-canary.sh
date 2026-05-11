#!/usr/bin/env bash
## Quick visibility check on the synthetic canary planted in the
## demo cluster's otel-demo namespace.
##
## Usage: bash eval/counterfactual/k8s/check-canary.sh
##
## Reports: pod status, recent emitter output, and what the demo
## env's Prometheus tenant currently shows for canary patterns.
set -euo pipefail

DEMO_API_KEY="${DEMO_API_KEY:-d02ad247-1e32-49ee-918d-93467ba8b134}"
DEMO_ENV_ID="${DEMO_ENV_ID:-6aa99191-f827-4579-a96a-c0ebdfe73884}"

echo "=== pod ==="
kubectl get pods -n otel-demo -l app=synthetic-canary 2>&1 | head -3

echo ""
echo "=== last 3 emitter log lines ==="
kubectl logs -n otel-demo -l app=synthetic-canary --tail=3 2>&1

echo ""
echo "=== canary patterns in demo Prometheus (last 15m) ==="
curl -s -G "https://prometheus.log10x.com/api/v1/query" \
  --data-urlencode 'query=topk(10, all_events_summaryBytes_total{message_pattern=~".*canary.*|.*OOMKilled.*|.*synthetic.*|.*CrashLoopBackOff.*"})' \
  -H "X-10X-Auth: ${DEMO_API_KEY}/${DEMO_ENV_ID}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('data', {}).get('result', [])
if not results:
    print('  (no canary patterns visible yet — wait ~90s after first deploy)')
else:
    for r in results:
        m = r.get('metric', {})
        v = r.get('value', ['', '?'])[1]
        pat = m.get('message_pattern', '?')[:60]
        sev = m.get('severity_level', '(no-sev)')
        print(f'  {sev:8} {v:>10} bytes  {pat}')
"
