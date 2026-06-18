#!/usr/bin/env node
/**
 * Close-the-loop install e2e — the "full thing".
 *
 * A not-signed-in user installs the Log10x engine on a real cluster with an
 * anonymous DEMO LICENSE, the engine writes metrics to the SaaS Prometheus, and
 * the MCP reads those metrics back via the demo-license query path
 * (/api/v1/demo/*). This script drives that physical loop end to end:
 *
 *   1. mint + persist a demo license (the SAME credential the engine installs
 *      with and the MCP later queries with — one demo tenant for both)
 *   2. provision a throwaway cluster (minikube by default; pluggable)
 *   3. helm install the published log10x/reporter-10x chart with that license
 *      + a tiny log generator so the engine has input
 *   4. switch the MCP into LOG10X_EVAL_ENV=demo-license and poll the demo-query
 *      path until the freshly-installed engine's metrics appear
 *   5. assert + tear down
 *
 * Exercises the feature this branch adds (the `log10x_demo` backend + Path 4.5
 * env resolution) against a real engine, not the shared replay demo env.
 *
 * GATED — real cluster ops only run with LOG10X_E2E=1. Without it (or with
 * --dry-run) the script preflights binaries and prints the plan, so it is safe
 * to run anywhere / in CI as a smoke check.
 *
 * Env knobs:
 *   LOG10X_E2E=1               actually provision + install (else dry-run)
 *   LOG10X_E2E_PROVIDER        minikube (default) | existing  (existing = use current kube-context)
 *   LOG10X_E2E_PROFILE         minikube profile / runtimeName  (default: log10x-e2e)
 *   LOG10X_E2E_NAMESPACE       install namespace               (default: log10x-e2e)
 *   LOG10X_E2E_KEEP=1          skip teardown (debug the cluster)
 *   LOG10X_E2E_TIMEOUT_SEC     metric-appearance poll budget   (default: 600)
 *   LOG10X_API_BASE            gateway base                    (default: https://prometheus.log10x.com)
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', '..', 'build', 'lib'); // log10x-mcp/build/lib

const DRY = process.argv.includes('--dry-run') || process.env.LOG10X_E2E !== '1';
const PROVIDER = process.env.LOG10X_E2E_PROVIDER || 'minikube';
const PROFILE = process.env.LOG10X_E2E_PROFILE || 'log10x-e2e';
const NAMESPACE = process.env.LOG10X_E2E_NAMESPACE || 'log10x-e2e';
const RELEASE = 'reporter-e2e';
const KEEP = process.env.LOG10X_E2E_KEEP === '1';
const TIMEOUT_SEC = parseInt(process.env.LOG10X_E2E_TIMEOUT_SEC || '600', 10);
const API_BASE = process.env.LOG10X_API_BASE || 'https://prometheus.log10x.com';
const HELM_REPO = 'https://log-10x.github.io/helm-charts';
const CHART = 'log10x/reporter-10x';

function log(phase, msg) {
  console.log(`\n\x1b[1m[${phase}]\x1b[0m ${msg}`);
}
function sh(cmd, args, { capture = false, allowFail = false } = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr || ''}`);
  }
  return r;
}
function have(bin) {
  return spawnSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }).status === 0;
}
function decodeTenant(jwt) {
  try {
    const p = jwt.split('.')[1];
    const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((p.length + 3) % 4), 'base64').toString('utf8');
    return JSON.parse(json).tenant_id || '(unknown)';
  } catch {
    return '(undecodable)';
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal JSON-log spewer so the engine fingerprints real patterns.
const LOG_GEN = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: e2e-log-gen
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector: { matchLabels: { app: e2e-log-gen } }
  template:
    metadata: { labels: { app: e2e-log-gen } }
    spec:
      containers:
        - name: spew
          image: busybox:1.36
          command: ["/bin/sh","-c"]
          args:
            - >
              i=0; while true; do
              i=$((i+1));
              echo "{\\"level\\":\\"info\\",\\"svc\\":\\"checkout\\",\\"msg\\":\\"order processed\\",\\"order_id\\":$i}";
              echo "{\\"level\\":\\"warn\\",\\"svc\\":\\"payments\\",\\"msg\\":\\"retry scheduled\\",\\"attempt\\":$((i%3))}";
              echo "{\\"level\\":\\"error\\",\\"svc\\":\\"inventory\\",\\"msg\\":\\"stock check failed\\",\\"sku\\":\\"sku-$((i%50))\\"}";
              sleep 1;
              done
`;

async function main() {
  log('plan', `${DRY ? 'DRY-RUN (set LOG10X_E2E=1 for the real loop)' : 'LIVE'} — provider=${PROVIDER} profile=${PROFILE} ns=${NAMESPACE} base=${API_BASE}`);

  // ── Phase 0: preflight ────────────────────────────────────────────────
  log('preflight', 'checking tooling');
  const needed = ['helm', 'kubectl'];
  if (PROVIDER === 'minikube') needed.push('minikube');
  const missing = needed.filter((b) => !have(b));
  for (const b of needed) console.log(`  ${missing.includes(b) ? '✗' : '✓'} ${b}`);
  if (missing.length) throw new Error(`missing required tools: ${missing.join(', ')}`);

  // ── Phase 1: mint + persist the demo license ──────────────────────────
  log('license', 'minting + persisting a demo license (engine + MCP share it)');
  const { getOrMintDemoLicense } = await import(pathToFileURL(join(BUILD, 'license-api.js')).href);
  const lic = await getOrMintDemoLicense();
  const tenant = decodeTenant(lic.jwt);
  console.log(`  license_id=${lic.licenseId} tenant=${tenant} jwt_len=${lic.jwt.length}`);
  process.env.LOG10X_LICENSE_JWT = lic.jwt;
  process.env.LOG10X_EVAL_ENV = 'demo-license';

  if (DRY) {
    log('plan', 'would now: provision cluster → helm install + log-gen → poll demo-query → assert → teardown');
    console.log(`  helm install ${RELEASE} ${CHART} -n ${NAMESPACE} --create-namespace \\`);
    console.log(`    --set log10xLicenseJwt='<jwt>' --set runtimeName=${PROFILE} --set airgapped=false`);
    console.log(`  then poll: GET ${API_BASE}/api/v1/demo/query?query=tenx_pipeline_up  (Bearer the same jwt)`);
    log('done', 'dry-run OK — preflight + license mint succeeded; no cluster mutated');
    return;
  }

  let provisioned = false;
  try {
    // ── Phase 2: provision ──────────────────────────────────────────────
    if (PROVIDER === 'minikube') {
      log('cluster', `minikube start -p ${PROFILE}`);
      sh('minikube', ['start', '-p', PROFILE, '--wait=all']);
      provisioned = true;
      sh('kubectl', ['config', 'use-context', PROFILE]);
    } else {
      log('cluster', `using existing kube-context: ${sh('kubectl', ['config', 'current-context'], { capture: true }).stdout.trim()}`);
    }

    // ── Phase 3: install engine + log generator ─────────────────────────
    log('install', `helm install ${CHART} with the demo license`);
    sh('helm', ['repo', 'add', 'log10x', HELM_REPO], { allowFail: true });
    sh('helm', ['repo', 'update', 'log10x']);
    sh('kubectl', ['create', 'namespace', NAMESPACE], { allowFail: true });
    const gen = spawnSync('kubectl', ['apply', '-f', '-'], { input: LOG_GEN, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
    if (gen.status !== 0) throw new Error('log-gen apply failed');
    sh('helm', [
      'upgrade', '--install', RELEASE, CHART,
      '-n', NAMESPACE, '--create-namespace',
      '--set', `log10xLicenseJwt=${lic.jwt}`,
      '--set', `runtimeName=${PROFILE}`,
      '--set', 'airgapped=false',
      '--wait', '--timeout', '4m',
    ], { allowFail: true });
    sh('kubectl', ['get', 'pods', '-n', NAMESPACE], { allowFail: true });

    // ── Phase 4: validate via the demo-license query path ───────────────
    log('validate', `polling demo-query path for the engine's metrics (LOG10X_EVAL_ENV=demo-license, up to ${TIMEOUT_SEC}s)`);
    const { loadEnvironments } = await import(pathToFileURL(join(BUILD, 'environments.js')).href);
    const { queryInstant } = await import(pathToFileURL(join(BUILD, 'api.js')).href);
    const envs = await loadEnvironments();
    const env = envs.default;
    console.log(`  resolved MCP env: backend.kind=${env.metricsBackend.kind} endpoint=${env.metricsBackend.endpoint} isDemoMode=${envs.isDemoMode}`);
    if (env.metricsBackend.kind !== 'log10x_demo') {
      throw new Error(`expected a log10x_demo backend from the demo license; got '${env.metricsBackend.kind}'. Path 4.5 did not engage.`);
    }

    const deadline = Date.now() + TIMEOUT_SEC * 1000;
    let found = null;
    while (Date.now() < deadline) {
      try {
        const res = await queryInstant(env, 'tenx_pipeline_up');
        const n = res?.data?.result?.length || 0;
        console.log(`  [${new Date().toISOString().slice(11, 19)}] tenx_pipeline_up series: ${n}`);
        if (n > 0) { found = res; break; }
      } catch (e) {
        console.log(`  query error (will retry): ${(e?.message || e).toString().slice(0, 160)}`);
      }
      await sleep(15000);
    }

    // ── Phase 5: verdict ────────────────────────────────────────────────
    if (found) {
      const labels = found.data.result[0]?.metric || {};
      log('PASS', `the engine installed with a demo license is writing, and the MCP read it back via /api/v1/demo/*`);
      console.log(`  tenx_pipeline_up labels: ${JSON.stringify(labels)}`);
      // bonus: pattern metrics from the log generator
      try {
        const pat = await queryInstant(env, 'count(all_events_summaryVolume_total)');
        console.log(`  pattern series count: ${pat?.data?.result?.[0]?.value?.[1] ?? '0'}`);
      } catch { /* best effort */ }
    } else {
      log('FAIL', `no tenx_pipeline_up appeared in ${TIMEOUT_SEC}s under tenant ${tenant}.`);
      console.log('  Inspect: kubectl logs -n ' + NAMESPACE + ' -l app.kubernetes.io/name=reporter-10x');
      process.exitCode = 1;
    }
  } finally {
    // ── Phase 6: teardown ─────────────────────────────────────────────
    if (provisioned && !KEEP && PROVIDER === 'minikube') {
      log('teardown', `minikube delete -p ${PROFILE}`);
      sh('minikube', ['delete', '-p', PROFILE], { allowFail: true });
    } else if (KEEP) {
      log('teardown', `skipped (LOG10X_E2E_KEEP=1). Clean up with: minikube delete -p ${PROFILE}`);
    }
  }
}

main().catch((e) => {
  console.error(`\n\x1b[31m[error]\x1b[0m ${e?.message || e}`);
  process.exitCode = 1;
});
