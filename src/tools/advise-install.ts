/**
 * log10x_advise_install — the wizard front door.
 *
 * Progressive Q-and-A driver for a k8s install of the Log10x Reporter or
 * Receiver. Each call merges the user's latest answer into a wizard
 * session (held alongside the discovery snapshot) and either:
 *
 *   1. Asks the next missing question (returning markdown that the agent
 *      surfaces to the user), or
 *   2. Once all answers are in, emits a concrete install plan with the
 *      license JWT pre-filled (auto-fetched from the gateway if absent).
 *
 * The five decisions, by dependency order:
 *
 *   Q1. App — "deploy a dedicated DaemonSet forwarder" (Reporter) vs
 *       "plug into existing forwarder" (Receiver). The biggest fork.
 *   Q2. (Receiver only) Which forwarder — auto-uses the snapshot's
 *       detected forwarder when there's exactly one; asks if multiple.
 *   Q3. Backend — where TenXSummary metrics go. Default suggestion:
 *       log10x SaaS unless airgapped or a backend agent is already
 *       detected in the cluster.
 *   Q4. (Backend ≠ log10x only) Airgapped — opt-in for CISO-friction
 *       reduction. Skipped silently when backend=log10x (SaaS implies
 *       not-airgapped).
 *   Q5. License — auto-fetched from `/api/v1/license/demo` if the user
 *       hasn't signed in. When `airgapped=true` and the only available
 *       license is a demo, the wizard surfaces a soft warning that
 *       demo licenses can't run airgapped (engine downgrades silently
 *       to online mode), and offers sign-in or proceed-without-airgapped.
 *
 * State retention is via WizardSession on the snapshot store — the
 * MCP itself is stateless per call, but the snapshot store's 30-min TTL
 * gives the agent a coherent conversation thread.
 */

import { z } from 'zod';
import { getSnapshot, updateWizardSession } from '../lib/discovery/snapshot-store.js';
import { buildReporterPlan } from '../lib/advisor/reporter.js';
import { renderPlan } from '../lib/advisor/render.js';
import { acquireLicenseForWizard, LicenseFetchError } from '../lib/license-api.js';
import { resolveAdvisorDestination } from '../lib/advisor/dest-resolve.js';
import type {
  DiscoverySnapshot,
  ForwarderKind,
  MetricsBackendKind,
  WizardSession,
  DetectedForwarder,
  DetectedMetricsBackend,
} from '../lib/discovery/types.js';
import type { OutputDestination } from '../lib/advisor/reporter-forwarders.js';
import type { Environments } from '../lib/environments.js';

const SUPPORTED_FORWARDERS = [
  'fluentbit',
  'fluentd',
  'filebeat',
  'logstash',
  'otel-collector',
  'vector',
] as const;
const SUPPORTED_BACKENDS: MetricsBackendKind[] = [
  'log10x',
  'datadog',
  'elastic',
  'cloudwatch',
  'signalfx',
  'prometheus',
];

export const adviseInstallSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  app: z
    .enum(['reporter', 'receiver'])
    .optional()
    .describe(
      'Which Log10x app to install. **reporter** = a dedicated DaemonSet forwarder (zero-touch, runs alongside your existing forwarder); **receiver** = a sidecar plugged into your existing forwarder (filters/samples/compacts events in-flight). When omitted, the wizard asks the user.'
    ),
  forwarder: z
    .enum(SUPPORTED_FORWARDERS)
    .optional()
    .describe(
      'Receiver-only: which detected forwarder kind to sidecar into. Auto-uses the snapshot\'s detected forwarder when there\'s exactly one; the wizard asks when there are multiple.'
    ),
  backends: z
    .array(z.enum(SUPPORTED_BACKENDS as unknown as [string, ...string[]]))
    .optional()
    .describe(
      'Where the engine emits TenXSummary metrics. Multi-destination — a user can report to log10x SaaS AND their own backend simultaneously, e.g. `["log10x", "datadog"]`. Choices: **log10x** (SaaS Prometheus, free demo tier), **datadog**, **elastic**, **cloudwatch**, **signalfx**, **prometheus** (customer-owned). The wizard pre-fills detected backends from the snapshot. The only mutual exclusion is `airgapped: true` + `"log10x"` in this list.'
    ),
  airgapped: z
    .boolean()
    .optional()
    .describe(
      'When true, the Log10x agents send nothing to log10x.com — engine metrics, license re-validation, and update checks all go silent. Use to reduce CISO friction. Conflicts with `"log10x"` in `backends` (the wizard surfaces the conflict). **Demo licenses cannot actually run airgapped** — the engine downgrades to online mode with a warning. The wizard surfaces this softly when both are picked.'
    ),
  license_jwt: z
    .string()
    .optional()
    .describe(
      'Log10x license JWT — mints from `POST /api/v1/license/demo` (anonymous, 14-day) or `POST /api/v1/license` (Auth0-authed, user-scoped). Maps to the helm chart\'s `log10xLicenseJwt` value. When omitted and the user is not signed in, the wizard auto-fetches a demo JWT.'
    ),
  namespace: z.string().optional().describe('Target namespace. Default: snapshot.recommendations.suggestedNamespace.'),
  release_name: z
    .string()
    .optional()
    .describe('Helm release name. Default: `my-<app>` (e.g., `my-reporter`).'),
  destination: z
    .enum(['mock', 'elasticsearch', 'splunk', 'datadog', 'cloudwatch'])
    .optional()
    .describe(
      'Event destination for the Receiver path (where filtered events go AFTER the engine processes them). Distinct from `backend` (which is where METRICS go). When omitted: auto-detects from ambient SIEM credentials; falls back to `mock`.'
    ),
  output_host: z.string().optional().describe('Host for non-mock event destinations.'),
  splunk_hec_token: z.string().optional().describe('Required when destination=splunk.'),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Plan scope when the wizard is ready to emit. Default: `all`.'),
};

const schemaObj = z.object(adviseInstallSchema);
export type AdviseInstallArgs = z.infer<typeof schemaObj>;

export async function executeAdviseInstall(
  args: AdviseInstallArgs,
  envs: Environments
): Promise<string> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return [
      `# Install wizard — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
  }

  // Merge the latest answers into the wizard session. Each call accretes;
  // the agent only passes the answer it just collected from the user.
  const session = updateWizardSession(args.snapshot_id, {
    app: args.app,
    forwarder: args.forwarder as ForwarderKind | undefined,
    backends: args.backends as MetricsBackendKind[] | undefined,
    airgapped: args.airgapped,
    licenseJwt: args.license_jwt,
    releaseName: args.release_name,
    namespace: args.namespace,
  });
  if (!session) {
    // Should be unreachable — getSnapshot would've failed first.
    return 'Internal error: wizard session could not be created.';
  }

  // Identify the next missing answer, in dependency order.
  const next = nextQuestion(snapshot, session);
  if (next.kind === 'ask') {
    return next.markdown;
  }

  // Auto-acquire a license if the user hasn't supplied one. Routes
  // between user-scoped (signed-in, Auth0 token available) and demo
  // (not signed in, or pasted-API-key path where we have no Auth0 token).
  // Refreshes the Auth0 access token transparently if it's expired.
  if (!session.licenseJwt) {
    try {
      const lic = await acquireLicenseForWizard();
      updateWizardSession(args.snapshot_id, {
        licenseJwt: lic.jwt,
        isDemoLicense: lic.isDemoLicense,
      });
      session.licenseJwt = lic.jwt;
      session.isDemoLicense = lic.isDemoLicense;
    } catch (e) {
      const msg = e instanceof LicenseFetchError ? e.message : String(e);
      return [
        `# Install wizard — couldn't acquire a license JWT`,
        ``,
        `The wizard tried to mint a license via the gateway and failed:`,
        ``,
        `> ${msg}`,
        ``,
        `Options:`,
        `- Sign in via \`log10x_signin_start\` if you haven't already`,
        `- Pass an existing JWT via \`license_jwt\``,
        `- Retry — the gateway may have been transiently unavailable`,
      ].join('\n');
    }
  }

  // Soft-warn: airgapped + demo license can't actually work — the engine
  // refuses to run airgapped on demo / limited licenses and silently
  // downgrades to online mode. We give the user a clear choice before
  // emitting a plan they think is airgapped but won't be.
  // Catches BOTH paths: not-signed-in users (fetched anonymous demo) AND
  // signed-in-via-pasted-key users (fell back to demo because we lack
  // Auth0 tokens to mint a user license).
  if (session.airgapped === true && session.isDemoLicense === true) {
    return renderDemoAirgappedWarning(session, !envs.isDemoMode);
  }

  // Everything answered. Emit the plan.
  return await renderInstallPlan(snapshot, session, args);
}

// ── Question routing ──

type NextStep = { kind: 'ask'; markdown: string } | { kind: 'render' };

function nextQuestion(snapshot: DiscoverySnapshot, session: WizardSession): NextStep {
  // Q1: app
  if (!session.app) {
    return { kind: 'ask', markdown: askApp(snapshot) };
  }

  // Q2: Receiver-only forwarder choice (when ambiguous)
  if (session.app === 'receiver' && !session.forwarder) {
    const detected = snapshot.kubectl.forwarders.filter((f) => f.kind !== 'unknown');
    if (detected.length === 0) {
      return {
        kind: 'ask',
        markdown: noForwarderForReceiver(),
      };
    }
    if (detected.length === 1) {
      // Auto-pick the only detected forwarder.
      updateWizardSession(session.snapshotId, { forwarder: detected[0].kind });
      session.forwarder = detected[0].kind;
    } else {
      return { kind: 'ask', markdown: askForwarder(detected) };
    }
  }

  // Q3: backends — can be multiple, must be non-empty
  if (!session.backends || session.backends.length === 0) {
    return { kind: 'ask', markdown: askBackends(snapshot.kubectl.backendAgents) };
  }

  // Conflict check: airgapped + log10x in backends — surface, don't auto-resolve
  if (session.airgapped === true && session.backends.includes('log10x')) {
    return { kind: 'ask', markdown: airgappedLog10xConflict(session.backends) };
  }

  // Q4: airgapped — only relevant when backends doesn't already include log10x
  // (if it does, the user has implicitly opted IN to log10x egress and
  // airgapped is moot)
  const hasLog10x = session.backends.includes('log10x');
  if (!hasLog10x && session.airgapped === undefined) {
    return { kind: 'ask', markdown: askAirgapped(session.backends) };
  }
  // backends includes log10x → silently set airgapped=false so the
  // session is fully determined.
  if (hasLog10x && session.airgapped === undefined) {
    updateWizardSession(session.snapshotId, { airgapped: false });
    session.airgapped = false;
  }

  return { kind: 'render' };
}

// ── Question renderers ──

function askApp(snapshot: DiscoverySnapshot): string {
  const detected = snapshot.kubectl.forwarders.filter((f) => f.kind !== 'unknown');
  const fwSummary =
    detected.length === 0
      ? 'No existing forwarder detected in the cluster. Only the dedicated-DaemonSet path applies.'
      : detected.length === 1
      ? `Detected: \`${detected[0].kind}\` in \`${detected[0].namespace}\`.`
      : `Detected ${detected.length} forwarders: ${detected.map((d) => `\`${d.kind}\` (${d.namespace})`).join(', ')}.`;

  const onlyDedicated = detected.length === 0;

  return [
    '# Install wizard — pick a path',
    '',
    fwSummary,
    '',
    `Two ways to install:`,
    '',
    onlyDedicated
      ? `- **(A) Dedicated DaemonSet** — installs a separate fluent-bit DaemonSet (Reporter) that tails container logs and emits cost-attribution metrics. Zero touch to your existing setup.`
      : `- **(A) Dedicated DaemonSet** — installs a separate fluent-bit DaemonSet (Reporter) that tails container logs alongside your existing forwarder. Zero touch to your existing setup. Read-only (metrics + pattern fingerprinting).`,
    onlyDedicated
      ? `- **(B) Plug into existing forwarder** — not available (no forwarder detected).`
      : `- **(B) Plug into existing forwarder** — installs a sidecar (Receiver) inside your existing forwarder. Filters / samples / compacts events in-flight to cut volume.`,
    '',
    `Re-invoke \`log10x_advise_install\` with \`app: "reporter"\` for (A) or \`app: "receiver"\` for (B).`,
  ].join('\n');
}

function noForwarderForReceiver(): string {
  return [
    '# Install wizard — Receiver needs an existing forwarder',
    '',
    'You picked **plug into existing forwarder** (Receiver), but discovery found no forwarder in the cluster.',
    '',
    'Options:',
    '- Switch to the dedicated DaemonSet: re-invoke with `app: "reporter"`.',
    '- Install a forwarder first (fluent-bit / fluentd / filebeat / logstash / otel-collector / vector), then re-run `log10x_discover_env` and `log10x_advise_install`.',
  ].join('\n');
}

function askForwarder(detected: DetectedForwarder[]): string {
  return [
    '# Install wizard — pick which forwarder to plug into',
    '',
    `${detected.length} forwarders are running in the cluster. Receiver sidecars into one of them:`,
    '',
    ...detected.map(
      (d) =>
        `- **${d.kind}** — workload \`${d.workloadKind}/${d.workloadName}\` in \`${d.namespace}\` (image \`${d.image}\`, ready ${d.readyReplicas})`
    ),
    '',
    `Re-invoke with \`forwarder: "<kind>"\` to pick one.`,
  ].join('\n');
}

function askBackends(detectedAgents: DetectedMetricsBackend[]): string {
  const lines: string[] = [];
  lines.push('# Install wizard — where do metrics go?');
  lines.push('');
  lines.push(
    'TenXSummary metrics (cost attribution + pattern fingerprinting) can go to **one or more** destinations simultaneously — for example, to Log10x SaaS for the MCP queries AND to your existing Datadog for unified dashboards.'
  );
  lines.push('');
  lines.push('Options:');
  lines.push('');
  lines.push(
    '- **log10x** — Log10x SaaS Prometheus, free demo tier, sub-second queries via the MCP. Recommended unless you need airgapped. *(requires online egress)*'
  );

  if (detectedAgents.length > 0) {
    lines.push('');
    lines.push('Detected in your cluster — single pane with your existing observability stack:');
    for (const a of detectedAgents) {
      lines.push(`- **${a.kind}** — ${a.evidence}`);
    }
  }

  const otherOptions = SUPPORTED_BACKENDS.filter(
    (b) => b !== 'log10x' && !detectedAgents.some((a) => a.kind === b)
  );
  if (otherOptions.length > 0) {
    lines.push('');
    lines.push(`Other backends: ${otherOptions.map((b) => `\`${b}\``).join(', ')}.`);
  }

  lines.push('');
  lines.push('Re-invoke with `backends: ["<choice>", ...]` — pass one or more. Examples:');
  lines.push('- `backends: ["log10x"]` — just SaaS, default recommendation');
  lines.push('- `backends: ["datadog"]` — your own backend only');
  lines.push('- `backends: ["log10x", "datadog"]` — both, side-by-side');
  return lines.join('\n');
}

function askAirgapped(backends: MetricsBackendKind[]): string {
  const backendList = backends.map((b) => `\`${b}\``).join(' + ');
  return [
    '# Install wizard — airgapped mode?',
    '',
    `You picked ${backendList} for metrics — all user-owned. The Log10x agents can run **fully airgapped**: nothing sent to log10x.com (no engine telemetry, no online license check, no update probes). Agents emit only to your chosen backends and whatever event destinations you wire.`,
    '',
    'Common request from security teams — clean network-policy story, smoother CISO sign-off.',
    '',
    'Otherwise (default): the agents still emit only to your authorized destinations, but send anonymous engine telemetry to log10x for support diagnostics. Helm chart and docker images still pull from public log10x repos regardless of this choice.',
    '',
    'Re-invoke with `airgapped: true` to enable, or `airgapped: false` to skip and proceed with default.',
  ].join('\n');
}

function airgappedLog10xConflict(backends: MetricsBackendKind[]): string {
  return [
    '# Install wizard — airgapped + log10x is impossible',
    '',
    `You picked \`airgapped: true\` AND included \`"log10x"\` in \`backends\` (\`${backends.map((b) => `"${b}"`).join(', ')}\`). These conflict: airgapped means the engine sends NOTHING to log10x.com, but \`"log10x"\` is the SaaS Prometheus endpoint at log10x.com.`,
    '',
    'Pick one:',
    `- **Keep airgapped, drop log10x**: re-invoke with \`backends: [${backends.filter((b) => b !== 'log10x').map((b) => `"${b}"`).join(', ') || '"<your-backend>"'}]\` (engine emits only to your own backend(s))`,
    `- **Keep log10x, drop airgapped**: re-invoke with \`airgapped: false\` (engine reports to both log10x SaaS AND your own backend(s))`,
  ].join('\n');
}

function renderDemoAirgappedWarning(session: WizardSession, isSignedIn: boolean): string {
  const backendList =
    (session.backends ?? []).map((b) => `\`${b}\``).join(' + ') || 'your chosen backend';

  const intro = isSignedIn
    ? `You're signed in, but the wizard fell back to an anonymous demo license — usually because the sign-in was done via pasted API key, which doesn't give us the Auth0 access token needed to mint a user-scoped JWT.`
    : `You're not signed in, so the wizard minted a 14-day anonymous demo JWT.`;

  const signinSuggestion = isSignedIn
    ? `1. **Sign in via the device flow** to upgrade to a user-scoped license (\`log10x_signin_start\` — it'll go through a browser OAuth that gives us the Auth0 tokens we need). Re-invoke this tool afterward. Your \`airgapped: true\` choice is remembered.`
    : `1. **Sign in** for a real license. Call \`log10x_signin_start\`, then re-invoke this tool. Your \`airgapped: true\` choice is remembered.`;

  return [
    '# Install wizard — airgapped + demo license heads-up',
    '',
    `${intro} **The engine refuses to run airgapped on demo / limited licenses** — it logs a warning and downgrades to online mode silently. Manually editing the values file later won't override this; the gate is in the engine.`,
    '',
    '**Two paths forward**:',
    '',
    signinSuggestion,
    `2. **Proceed without airgapped** for now — the agents will still emit only to ${backendList}, just with anonymous engine telemetry going to log10x. Re-invoke with \`airgapped: false\` to confirm.`,
    '',
    "_Your other answers (app, forwarder, backends) are remembered — you don't need to re-pass them._",
  ].join('\n');
}

// ── Plan rendering ──

async function renderInstallPlan(
  snapshot: DiscoverySnapshot,
  session: WizardSession,
  args: AdviseInstallArgs
): Promise<string> {
  const action = args.action ?? 'all';
  const lines: string[] = [];

  // Header: summarize the answered choices.
  lines.push(`# Install plan — ${session.app === 'receiver' ? 'Receiver sidecar' : 'Standalone Reporter'}`);
  lines.push('');
  lines.push(renderChoiceSummary(session));
  lines.push('');

  // Demo + airgapped: at this point either the user opted out of
  // airgapped OR signed in. If we still see demo+airgapped together,
  // the engine will downgrade — emit a banner.
  if (session.airgapped && session.isDemoLicense) {
    lines.push(
      '> ⚠ Plan emitted with `airgapped: true` and a **demo license** — the engine will detect this combo and downgrade to online mode at startup. The plan below leaves `airgapped` set to true so you can sign in later and the chart will then enforce it for real.'
    );
    lines.push('');
  }

  // Route to the right plan builder.
  if (session.app === 'reporter' || session.app === 'receiver') {
    // Receiver path needs a destination for the event flow. Resolve it
    // from explicit arg → ambient SIEM credentials → mock.
    const destResolution =
      session.app === 'receiver'
        ? await resolveAdvisorDestination(args.destination)
        : { kind: 'resolved' as const, destination: 'mock' as const, note: undefined };
    if (destResolution.kind === 'ambiguous') return destResolution.markdown;
    const destination = destResolution.destination;
    const destNote = destResolution.note ? `_${destResolution.note}_\n\n` : '';

    const plan = await buildReporterPlan({
      snapshot,
      app: session.app,
      forwarder: session.forwarder,
      releaseName: session.releaseName,
      namespace: session.namespace,
      licenseJwt: session.licenseJwt,
      destination: destination as OutputDestination,
      outputHost: args.output_host,
      splunkHecToken: args.splunk_hec_token,
      backends: session.backends,
      airgapped: session.airgapped,
      skipInstall: action === 'verify' || action === 'teardown',
      skipVerify: action === 'install' || action === 'teardown',
      skipTeardown: action === 'install' || action === 'verify',
    });
    lines.push(destNote + renderPlan(plan, action));
  }

  return lines.join('\n');
}

function renderChoiceSummary(session: WizardSession): string {
  const rows: string[] = [];
  rows.push(`- **App**: ${session.app === 'receiver' ? 'Receiver (sidecar)' : 'Reporter (standalone DaemonSet)'}`);
  if (session.app === 'receiver' && session.forwarder) {
    rows.push(`- **Forwarder**: \`${session.forwarder}\``);
  }
  const backendList = (session.backends ?? ['log10x']).map((b) => `\`${b}\``).join(' + ');
  rows.push(`- **Metrics backends**: ${backendList}`);
  if (session.airgapped) rows.push(`- **Airgapped**: yes (engine emits only to user-owned backends)`);
  if (session.isDemoLicense) rows.push(`- **License**: anonymous 14-day demo (sign in for a user-scoped one)`);
  return rows.join('\n');
}

