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
 *
 * **Credential note.** The wizard mints a LICENSE JWT (not an api_key)
 * for the install plan. The license JWT is the credential the deployed
 * engine pods consume — it goes into the helm chart's `log10xLicenseJwt`
 * value. The wizard never touches the user's api_key; the api_key stays
 * with the MCP for user-action calls (queries, env management, etc.).
 * See `../lib/auth-model.ts` for the full split.
 */

import { z } from 'zod';
import {
  getSnapshot,
  getWizardSession,
  updateWizardSession,
} from '../lib/discovery/snapshot-store.js';
import { buildReporterPlan } from '../lib/advisor/reporter.js';
import { renderPlan } from '../lib/advisor/render.js';
import { acquireLicenseForWizard, LicenseFetchError } from '../lib/license-api.js';
import '../lib/auth-model.js';
import type {
  DiscoverySnapshot,
  ForwarderKind,
  MetricsBackendKind,
  WizardSession,
  DetectedForwarder,
  DetectedMetricsBackend,
  BackendCredentialConfig,
} from '../lib/discovery/types.js';
import {
  type OutputDestination,
  BACKEND_ENV_SPECS,
  defaultSecretNameFor,
} from '../lib/advisor/reporter-forwarders.js';
import type { Environments } from '../lib/environments.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

// Forwarders the Receiver wizard knows how to install a sidecar into.
// Filebeat is intentionally NOT here: the Receiver pattern is a values
// overlay on the upstream chart with extraContainers + extraVolumes, and
// the upstream elastic/filebeat chart doesn't expose those hooks. The
// supported-via-fork path (log10x-elastic/filebeat) is deferred — the
// wizard refuses Filebeat with a clear "not yet" message rather than
// pretending it works.
const SUPPORTED_FORWARDERS = [
  'fluentbit',
  'fluentd',
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
      'Where the engine emits TenXSummary metrics. Multi-destination — a user can report to log10x SaaS AND their own backend simultaneously, e.g. `["log10x", "datadog"]`. Choices: **log10x** (Log10x-managed Prometheus — recommended; no infra to run), **datadog**, **elastic**, **cloudwatch**, **signalfx**, **prometheus** (customer-owned). The wizard pre-fills detected backends from the snapshot. The only mutual exclusion is `airgapped: true` + `"log10x"` in this list.'
    ),
  airgapped: z
    .boolean()
    .optional()
    .describe(
      'When true, the Log10x agents send nothing to log10x.com — engine metrics, license re-validation, and update checks all go silent. Use to reduce CISO friction. Conflicts with `"log10x"` in `backends` (the wizard surfaces the conflict). **Demo licenses cannot actually run airgapped** — the engine downgrades to online mode with a warning. The wizard surfaces this softly when both are picked.'
    ),
  backend_credentials: z
    .record(
      z.string(),
      z.object({
        secretName: z.string().describe('Name of the Kubernetes Secret holding sensitive env vars for this backend.'),
        plainValues: z
          .record(z.string(), z.string())
          .optional()
          .describe('Non-sensitive env var overrides keyed by env var name (e.g., `{ DD_SITE: "us5.datadoghq.com" }`).'),
      })
    )
    .optional()
    .describe(
      'Per-backend credential configuration, keyed by backend kind. **Only set for non-`log10x` backends** — `log10x` SaaS uses the license JWT and needs no extra credentials. Each entry has a `secretName` (the Kubernetes Secret the user creates out-of-band holding sensitive env vars like `DD_API_KEY`; default per backend is `<backend>-credentials`) and optional `plainValues` (overrides for non-sensitive env vars like `DD_SITE`). Example: `{ "datadog": { "secretName": "datadog-secret", "plainValues": { "DD_SITE": "us5.datadoghq.com" } } }`.'
    ),
  license_source: z
    .enum(['signin', 'demo', 'paste'])
    .optional()
    .describe(
      'How the wizard should acquire the engine\'s license JWT. **signin** (recommended) returns a sign-in step the user runs in a separate `log10x_signin_start` call — re-invoking the wizard after sign-in auto-mints a user-scoped license. **demo** mints a 14-day anonymous demo JWT (transient, can\'t run airgapped). **paste** asks the user for an existing JWT via `license_jwt_paste`. When omitted, the wizard surfaces this as a question.'
    ),
  license_jwt_paste: z
    .string()
    .optional()
    .describe('License JWT supplied by the user when `license_source: "paste"`. Mints from `POST /api/v1/license` (signed-in) or `POST /api/v1/license/demo` (anonymous). Maps to the chart\'s license Secret.'),
  namespace: z.string().optional().describe('Target namespace. Default: snapshot.recommendations.suggestedNamespace.'),
  release_name: z
    .string()
    .optional()
    .describe('Helm release name. Default: `my-<app>` (e.g., `my-reporter`).'),
  // `destination` / `output_host` / `splunk_hec_token` were deliberately
  // removed from the install-wizard schema. The Receiver is a sidecar
  // that processes events in-flight and emits METRICS — `backends` already
  // captures where those metrics go. The user's existing forwarder still
  // controls where the actual events go; we don't replace that. (The
  // generated overlay falls back to a documented placeholder for the
  // event-out config when the chart's `config:` is replaced wholesale —
  // see the per-forwarder renderer in reporter-forwarders.ts.)
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Plan scope when the wizard is ready to emit. Default: `all`.'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope (data.next_question / data.plan). markdown wraps the rendered prompt or plan as markdown.'),
};

const schemaObj = z.object(adviseInstallSchema);
export type AdviseInstallArgs = z.infer<typeof schemaObj>;

type WizardMode =
  | 'missing_snapshot'
  | 'session_error'
  | 'cancelled'
  | 'next_question'
  | 'license_error'
  | 'signin_required'
  | 'demo_airgapped_warning'
  | 'ambiguous_destination'
  | 'plan';

const TOOL_NAME = 'log10x_advise_install';

function headlineFromMarkdown(md: string, fallback: string): string {
  const firstLine = md.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return fallback;
  return firstLine.replace(/^#+\s*/, '').slice(0, 200);
}

function wizardReturn(
  view: 'summary' | 'markdown',
  mode: WizardMode,
  md: string,
  extraData: Record<string, unknown> = {}
): StructuredOutput {
  const headline = headlineFromMarkdown(md, `${TOOL_NAME} (${mode})`);
  if (view === 'markdown') {
    return buildMarkdownEnvelope({ tool: TOOL_NAME, summary: { headline }, markdown: md });
  }
  const okModes: WizardMode[] = ['next_question', 'plan', 'demo_airgapped_warning'];
  const ok = okModes.includes(mode);
  return buildEnvelope({
    tool: TOOL_NAME,
    view: 'summary',
    summary: { headline },
    data: { ok, mode, markdown: md, ...extraData },
  });
}

export async function executeAdviseInstall(
  args: AdviseInstallArgs,
  envs: Environments,
  mcpServer?: McpServer
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    const md = [
      `# Install wizard — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
    return wizardReturn(view, 'missing_snapshot', md, { snapshot_id: args.snapshot_id });
  }

  // Merge the latest answers into the wizard session. Each call accretes;
  // the agent only passes the answer it just collected from the user.
  // For `backendCredentials`, merge per-backend entries with whatever's
  // already there rather than replacing the whole map — the user might
  // answer credentials for one backend at a time across multiple turns.
  const prior = getWizardSession(args.snapshot_id);
  const mergedBackendCredentials = args.backend_credentials
    ? {
        ...(prior?.backendCredentials ?? {}),
        ...(args.backend_credentials as Partial<Record<MetricsBackendKind, BackendCredentialConfig>>),
      }
    : undefined;
  const session = updateWizardSession(args.snapshot_id, {
    app: args.app,
    forwarder: args.forwarder as ForwarderKind | undefined,
    backends: args.backends as MetricsBackendKind[] | undefined,
    backendCredentials: mergedBackendCredentials,
    airgapped: args.airgapped,
    licenseSource: args.license_source,
    // license_jwt_paste fills licenseJwt directly — it's the actual JWT
    // the user supplied. The session's licenseJwt is overwritten below
    // by acquireLicenseForWizard() for the signin/demo paths.
    licenseJwt: args.license_jwt_paste,
    releaseName: args.release_name,
    namespace: args.namespace,
  });
  if (!session) {
    // Should be unreachable — getSnapshot would've failed first.
    return wizardReturn(view, 'session_error', '# Install wizard — internal error\n\nWizard session could not be created.', { snapshot_id: args.snapshot_id });
  }

  // Elicitation path: if the client supports it, drive every missing
  // answer via `server.elicitInput` in a single tool call. The user
  // sees one form per question with proper enum/multi-select/form UI;
  // we never return a "re-invoke with X" markdown prompt.
  //
  // Falls back to the markdown-question path on:
  //   - hosts without elicitation capability (older Claude Desktop, etc.)
  //   - missing `mcpServer` reference (defensive)
  //   - elicitation request rejected/cancelled by the user
  if (mcpServer && clientSupportsElicitation(mcpServer)) {
    const elicitOutcome = await elicitMissingAnswers(mcpServer, snapshot, session);
    if (elicitOutcome.kind === 'cancelled') {
      const md = [
        '# Install wizard — cancelled',
        '',
        'You closed the form before answering. Re-invoke `log10x_advise_install` with the same `snapshot_id` to pick up where you left off — answers you already gave are remembered.',
      ].join('\n');
      return wizardReturn(view, 'cancelled', md, { snapshot_id: args.snapshot_id });
    }
    if (elicitOutcome.kind === 'failed') {
      // Elicitation errored mid-flow — fall back to markdown questions.
      // The session has accumulated whatever was answered before the error.
      const next = nextQuestion(snapshot, session);
      if (next.kind === 'ask') {
        return wizardReturn(view, 'next_question', next.markdown, { snapshot_id: args.snapshot_id, question_id: next.questionId });
      }
    }
  } else {
    // Markdown-fallback path: ask one question, return markdown, wait
    // for re-invocation with the answer in tool args.
    const next = nextQuestion(snapshot, session);
    if (next.kind === 'ask') {
      return wizardReturn(view, 'next_question', next.markdown, { snapshot_id: args.snapshot_id, question_id: next.questionId });
    }
  }

  // License acquisition. Three paths driven by session.licenseSource:
  //   - 'signin' — the user said "sign me in". acquireLicenseForWizard
  //     mints a user-scoped JWT IF they're already signed in; otherwise
  //     it falls back to demo. We surface a clear "go sign in first"
  //     message when the fallback to demo would happen, so the user
  //     gets the real license they asked for rather than a silent demo.
  //   - 'demo' — explicit demo. Skip the signed-in check, mint a demo.
  //   - 'paste' — the user supplied license_jwt_paste; session.licenseJwt
  //     is already populated from that arg. Nothing to do here.
  if (!session.licenseJwt && session.licenseSource !== 'paste') {
    if (session.licenseSource === 'signin' && envs.isDemoMode) {
      const md = [
        `# Install wizard — sign in to Log10x first`,
        ``,
        `You picked **Sign in** for the license. The wizard needs a Log10x account session to mint a user-scoped license — run \`log10x_signin_start\` in your next turn (it opens a browser to auth.log10x.com and exchanges the device-code for an API key).`,
        ``,
        `Once you're signed in, re-invoke \`log10x_advise_install\` with the same \`snapshot_id\`. Every answer you gave above is remembered — you won't have to redo any step.`,
      ].join('\n');
      return wizardReturn(view, 'signin_required', md, { snapshot_id: args.snapshot_id });
    }
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
      const md = [
        `# Install wizard — couldn't acquire a license JWT`,
        ``,
        `The wizard tried to mint a license via the gateway and failed:`,
        ``,
        `> ${msg}`,
        ``,
        `Options:`,
        `- Sign in via \`log10x_signin_start\` if you haven't already`,
        `- Re-invoke with \`license_source: "paste"\` and \`license_jwt_paste: "<your-jwt>"\` if you have one`,
        `- Retry — the gateway may have been transiently unavailable`,
      ].join('\n');
      return wizardReturn(view, 'license_error', md, { snapshot_id: args.snapshot_id, error_message: msg });
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
    const md = renderDemoAirgappedWarning(session, !envs.isDemoMode);
    return wizardReturn(view, 'demo_airgapped_warning', md, { snapshot_id: args.snapshot_id, is_signed_in: !envs.isDemoMode });
  }

  // Everything answered. Emit the plan (or surface ambiguous-destination).
  const planResult = await renderInstallPlan(snapshot, session, args);
  if (planResult.kind === 'ambiguous_destination') {
    return wizardReturn(view, 'ambiguous_destination', planResult.markdown, {
      snapshot_id: args.snapshot_id,
      app: session.app,
      forwarder: session.forwarder,
      detected_destinations: planResult.candidates,
    });
  }
  return wizardReturn(view, 'plan', planResult.markdown, {
    snapshot_id: args.snapshot_id,
    app: session.app,
    forwarder: session.forwarder,
    backends: session.backends,
    airgapped: session.airgapped ?? false,
    is_demo_license: session.isDemoLicense ?? false,
    release_name: session.releaseName,
    namespace: session.namespace,
    destination: planResult.destination,
    action: args.action ?? 'all',
  });
}

// ── Elicitation path (MCP-native interactive forms) ──

/**
 * Detect whether the connected MCP client supports `elicitation/create`.
 * Claude Code 2.1.76+ and recent VS Code / Cursor builds declare the
 * `elicitation` capability at handshake; older Claude Desktop builds
 * don't, and the SDK throws if we try `elicitInput` without the
 * capability declared.
 */
function clientSupportsElicitation(server: McpServer): boolean {
  // McpServer is a thin wrapper; the underlying low-level server holds
  // the client capabilities. The `server.server` accessor reaches it.
  try {
    const caps = (server as any).server?.getClientCapabilities?.();
    return Boolean(caps?.elicitation);
  } catch {
    return false;
  }
}

type ElicitOutcome = { kind: 'all-answered' } | { kind: 'cancelled' } | { kind: 'failed' };

/**
 * Drive every still-missing wizard answer via `server.elicitInput`.
 * Each question is a discrete form; the function persists answers to
 * the wizard session between forms so a mid-flow cancellation can be
 * resumed via the markdown-fallback path on the next tool call.
 */
async function elicitMissingAnswers(
  server: McpServer,
  snapshot: DiscoverySnapshot,
  session: WizardSession
): Promise<ElicitOutcome> {
  try {
    // Q1: app
    if (!session.app) {
      // "Supported" here means the Receiver wizard can install a sidecar
      // into it — see SUPPORTED_FORWARDERS at the top of this file.
      // Filebeat is detected but not yet wizard-supported.
      const supportedDetected = snapshot.kubectl.forwarders.filter(
        (f) => (SUPPORTED_FORWARDERS as readonly string[]).includes(f.kind)
      );
      const result = await (server as any).server.elicitInput({
        message: supportedDetected.length === 0
          ? 'No supported forwarder detected for the Receiver path. Install a dedicated DaemonSet Reporter?'
          : 'Pick an install path:',
        requestedSchema: {
          type: 'object',
          properties: {
            app: {
              type: 'string',
              title: 'Install path',
              enum: supportedDetected.length === 0 ? ['reporter'] : ['reporter', 'receiver'],
              enumNames: supportedDetected.length === 0
                ? ['Dedicated DaemonSet (Reporter)']
                : ['Dedicated DaemonSet (Reporter) — zero touch', 'Plug into existing forwarder (Receiver) — sidecar in your forwarder'],
            },
          },
          required: ['app'],
        },
      });
      if (result.action !== 'accept') return { kind: 'cancelled' };
      session.app = result.content?.app as 'reporter' | 'receiver';
      updateWizardSession(session.snapshotId, { app: session.app });
    }

    // Q2: forwarder (Receiver only, when ambiguous)
    if (session.app === 'receiver' && !session.forwarder) {
      const supportedDetected = snapshot.kubectl.forwarders.filter(
        (f) => (SUPPORTED_FORWARDERS as readonly string[]).includes(f.kind)
      );
      if (supportedDetected.length === 0) {
        // Need to bail back to the markdown path which emits the helpful
        // "no supported forwarder" / "filebeat-not-yet" message;
        // elicitation can't render that.
        return { kind: 'failed' };
      }
      if (supportedDetected.length === 1) {
        session.forwarder = supportedDetected[0].kind;
        updateWizardSession(session.snapshotId, { forwarder: session.forwarder });
      } else {
        const result = await (server as any).server.elicitInput({
          message: `Multiple supported forwarders detected. Which one should the Receiver sidecar into?`,
          requestedSchema: {
            type: 'object',
            properties: {
              forwarder: {
                type: 'string',
                title: 'Forwarder',
                enum: supportedDetected.map((d) => d.kind),
                enumNames: supportedDetected.map((d) => `${d.kind} (${d.workloadKind}/${d.workloadName} in ${d.namespace})`),
              },
            },
            required: ['forwarder'],
          },
        });
        if (result.action !== 'accept') return { kind: 'cancelled' };
        session.forwarder = result.content?.forwarder as ForwarderKind;
        updateWizardSession(session.snapshotId, { forwarder: session.forwarder });
      }
    }

    // Q3: backends (multi-select)
    if (!session.backends || session.backends.length === 0) {
      const detectedSet = new Set(snapshot.kubectl.backendAgents.map((a) => a.kind));
      const result = await (server as any).server.elicitInput({
        message: 'The engine emits event statistics, cost attribution, and per-pattern enrichments as time-series metrics — and we need to know where to publish them. Pick the TSDB(s) where you want to read these metrics from (the MCP and your dashboards query them back from here). You can publish to multiple backends at the same time.',
        requestedSchema: {
          type: 'object',
          properties: {
            backends: {
              type: 'array',
              title: 'Metrics backends',
              minItems: 1,
              items: {
                anyOf: SUPPORTED_BACKENDS.map((b) => ({
                  const: b,
                  title:
                    BACKEND_LABEL[b] +
                    (b === 'log10x'
                      ? ' (recommended for first install)'
                      : detectedSet.has(b)
                        ? ' (detected in your cluster)'
                        : ''),
                })),
              },
            },
          },
          required: ['backends'],
        },
      });
      if (result.action !== 'accept') return { kind: 'cancelled' };
      session.backends = result.content?.backends as MetricsBackendKind[];
      updateWizardSession(session.snapshotId, { backends: session.backends });
    }

    // Conflict check: airgapped+log10x — surface in markdown if hit
    if (session.airgapped === true && session.backends.includes('log10x')) {
      return { kind: 'failed' };
    }

    // Q4: per-backend credentials
    const backendsNeedingCreds = session.backends.filter(
      (b) => b !== 'log10x' && !(session.backendCredentials?.[b])
    );
    for (const backend of backendsNeedingCreds) {
      const spec = BACKEND_ENV_SPECS[backend];
      if (!spec) continue;
      const properties: Record<string, unknown> = {
        secretName: {
          type: 'string',
          title: `Secret the engine reads ${BACKEND_LABEL[backend]} credentials from`,
          description: `The engine needs to authenticate to ${BACKEND_LABEL[backend]} when it pushes metrics, and we won't put credentials in your values.yaml — instead, the engine reads them from a Kubernetes Secret at runtime via secretKeyRef. Tell us which Secret to read (use whatever your team already manages — Sealed Secrets, External Secrets, Vault, kubectl). Sensitive env vars the engine mounts from this Secret: ${spec.secret.map((s) => s.envVar).join(', ')}. Keys the engine reads inside the Secret: ${spec.secret.map((s) => `\`${s.secretKey}\``).join(', ')}.`,
          default: defaultSecretNameFor(backend),
        },
      };
      const required = ['secretName'];
      for (const p of spec.plain) {
        properties[p.envVar] = {
          type: 'string',
          title: p.envVar,
          ...(p.default !== undefined ? { default: p.default } : {}),
          description:
            p.default !== undefined
              ? `Optional override; defaults to \`${p.default}\`.`
              : `Required; no default. Example: \`${p.placeholder ?? ''}\`.`,
        };
        if (p.default === undefined) required.push(p.envVar);
      }
      const result = await (server as any).server.elicitInput({
        message: `The engine pushes metrics to ${BACKEND_LABEL[backend]} and needs to authenticate. To avoid putting credentials in values.yaml, it reads them from a Kubernetes Secret at runtime — point us at the Secret to read (and any non-sensitive env overrides if you need them).`,
        requestedSchema: {
          type: 'object',
          properties,
          required,
        },
      });
      if (result.action !== 'accept') return { kind: 'cancelled' };
      const content = (result.content ?? {}) as Record<string, string>;
      const cred: BackendCredentialConfig = {
        secretName: content.secretName ?? defaultSecretNameFor(backend),
        plainValues: Object.fromEntries(
          spec.plain
            .filter((p) => content[p.envVar] !== undefined && content[p.envVar] !== '')
            .map((p) => [p.envVar, content[p.envVar]!])
        ),
      };
      if (!cred.plainValues || Object.keys(cred.plainValues).length === 0) {
        delete cred.plainValues;
      }
      session.backendCredentials = { ...(session.backendCredentials ?? {}), [backend]: cred };
      updateWizardSession(session.snapshotId, { backendCredentials: session.backendCredentials });
    }

    // Q5: airgapped — only when backends doesn't include log10x
    if (!session.backends.includes('log10x') && session.airgapped === undefined) {
      const result = await (server as any).server.elicitInput({
        message: `Run the engine airgapped? (Engine sends NOTHING to log10x.com — only emits to ${session.backends.map((b) => BACKEND_LABEL[b]).join(' + ')}.)`,
        requestedSchema: {
          type: 'object',
          properties: {
            airgapped: {
              type: 'boolean',
              title: 'Airgapped mode',
              description: 'Common request from security teams. No telemetry, no online license check, no update probes.',
              default: false,
            },
          },
        },
      });
      if (result.action !== 'accept') return { kind: 'cancelled' };
      session.airgapped = Boolean(result.content?.airgapped);
      updateWizardSession(session.snapshotId, { airgapped: session.airgapped });
    } else if (session.backends.includes('log10x') && session.airgapped === undefined) {
      // log10x in backends implicitly means not airgapped — don't ask.
      updateWizardSession(session.snapshotId, { airgapped: false });
      session.airgapped = false;
    }

    // Q6: license source — sign in, demo, or paste.
    if (!session.licenseSource) {
      const result = await (server as any).server.elicitInput({
        message: 'How do you want to license the engine? The engine needs a Log10x license JWT to start — sign in to log10x for a real user-scoped license (recommended), mint an anonymous 14-day demo, or paste a JWT you already have.',
        requestedSchema: {
          type: 'object',
          properties: {
            licenseSource: {
              type: 'string',
              title: 'License source',
              enum: ['signin', 'demo', 'paste'],
              enumNames: [
                'Sign in to Log10x — real license, recommended',
                'Mint an anonymous 14-day demo license — transient, no airgapped',
                "I'll paste a license JWT I already have",
              ],
            },
          },
          required: ['licenseSource'],
        },
      });
      if (result.action !== 'accept') return { kind: 'cancelled' };
      session.licenseSource = result.content?.licenseSource as 'signin' | 'demo' | 'paste';
      updateWizardSession(session.snapshotId, { licenseSource: session.licenseSource });
    }

    // Q7: paste path — ask for the JWT itself.
    if (session.licenseSource === 'paste' && !session.licenseJwt) {
      const result = await (server as any).server.elicitInput({
        message: 'Paste the Log10x license JWT. The chart mounts this via a Kubernetes Secret at /etc/tenx/license/license.jwt — it never lives in values.yaml.',
        requestedSchema: {
          type: 'object',
          properties: {
            licenseJwt: {
              type: 'string',
              title: 'License JWT',
              description: 'The JWT string. Starts with "eyJ".',
            },
          },
          required: ['licenseJwt'],
        },
      });
      if (result.action !== 'accept') return { kind: 'cancelled' };
      session.licenseJwt = result.content?.licenseJwt as string;
      updateWizardSession(session.snapshotId, { licenseJwt: session.licenseJwt });
    }

    return { kind: 'all-answered' };
  } catch (e) {
    // The SDK throws if the client doesn't actually support elicitation
    // (capability negotiation lied), or on transport errors. Surface the
    // failure so the caller can fall back to the markdown question path.
    return { kind: 'failed' };
  }
}

// ── Question routing ──

type QuestionId = 'app' | 'forwarder' | 'no-forwarder' | 'backends' | 'airgapped-log10x-conflict' | 'backend-credentials' | 'airgapped' | 'license-source' | 'license-paste';
type NextStep = { kind: 'ask'; markdown: string; questionId: QuestionId } | { kind: 'render' };

function nextQuestion(snapshot: DiscoverySnapshot, session: WizardSession): NextStep {
  // Q1: app
  if (!session.app) {
    return { kind: 'ask', markdown: askApp(snapshot), questionId: 'app' };
  }

  // Q2: Receiver-only forwarder choice (when ambiguous)
  if (session.app === 'receiver' && !session.forwarder) {
    const detected = snapshot.kubectl.forwarders.filter((f) => f.kind !== 'unknown');
    // Filebeat detection is real (we want the cluster picture to include it)
    // but the Receiver wizard can't install into it yet — the supported set
    // is the SUPPORTED_FORWARDERS list above. Partition detection accordingly.
    const supported = detected.filter((f) => (SUPPORTED_FORWARDERS as readonly string[]).includes(f.kind));
    const unsupported = detected.filter((f) => !(SUPPORTED_FORWARDERS as readonly string[]).includes(f.kind));
    if (supported.length === 0) {
      // No supported forwarder. Differentiate "nothing detected" from
      // "only unsupported (filebeat) detected" so the user gets the
      // right next-step guidance.
      if (unsupported.length > 0) {
        return {
          kind: 'ask',
          markdown: unsupportedForwarderForReceiver(unsupported),
          questionId: 'no-forwarder',
        };
      }
      return {
        kind: 'ask',
        markdown: noForwarderForReceiver(),
        questionId: 'no-forwarder',
      };
    }
    if (supported.length === 1) {
      // Auto-pick the only supported detected forwarder.
      updateWizardSession(session.snapshotId, { forwarder: supported[0].kind });
      session.forwarder = supported[0].kind;
    } else {
      return { kind: 'ask', markdown: askForwarder(supported), questionId: 'forwarder' };
    }
  }

  // Q3: backends — can be multiple, must be non-empty
  if (!session.backends || session.backends.length === 0) {
    return { kind: 'ask', markdown: askBackends(snapshot.kubectl.backendAgents), questionId: 'backends' };
  }

  // Conflict check: airgapped + log10x in backends — surface, don't auto-resolve
  if (session.airgapped === true && session.backends.includes('log10x')) {
    return { kind: 'ask', markdown: airgappedLog10xConflict(session.backends), questionId: 'airgapped-log10x-conflict' };
  }

  // Q4: per-backend credentials — ask for any non-`log10x` backend that
  // doesn't yet have a credential entry in the session. The agent can
  // bundle multiple backends into one answer via `backend_credentials`.
  const backendsNeedingCreds = session.backends.filter(
    (b) => b !== 'log10x' && !(session.backendCredentials?.[b])
  );
  if (backendsNeedingCreds.length > 0) {
    return { kind: 'ask', markdown: askBackendCredentials(backendsNeedingCreds), questionId: 'backend-credentials' };
  }

  // Q5: airgapped — only relevant when backends doesn't already include log10x
  // (if it does, the user has implicitly opted IN to log10x egress and
  // airgapped is moot)
  const hasLog10x = session.backends.includes('log10x');
  if (!hasLog10x && session.airgapped === undefined) {
    return { kind: 'ask', markdown: askAirgapped(session.backends), questionId: 'airgapped' };
  }
  // backends includes log10x → silently set airgapped=false so the
  // session is fully determined.
  if (hasLog10x && session.airgapped === undefined) {
    updateWizardSession(session.snapshotId, { airgapped: false });
    session.airgapped = false;
  }

  // Q6: license source — sign in (recommended), demo, or paste.
  if (!session.licenseSource) {
    return { kind: 'ask', markdown: askLicenseSource(), questionId: 'license-source' };
  }

  // Q7: when license_source=paste and the JWT hasn't been provided yet,
  // ask for it. (The agent passes it via `license_jwt_paste`, which the
  // session merge folds into `licenseJwt`.)
  if (session.licenseSource === 'paste' && !session.licenseJwt) {
    return { kind: 'ask', markdown: askLicensePaste(), questionId: 'license-paste' };
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
    `- Install a forwarder first (${SUPPORTED_FORWARDERS.join(' / ')}), then re-run \`log10x_discover_env\` and \`log10x_advise_install\`.`,
  ].join('\n');
}

function unsupportedForwarderForReceiver(unsupported: DetectedForwarder[]): string {
  const kinds = Array.from(new Set(unsupported.map((d) => d.kind))).join(', ');
  return [
    '# Install wizard — Receiver path not supported for your forwarder yet',
    '',
    `Discovery found these forwarders in the cluster: **${kinds}**. The Receiver wizard can install a sidecar into ${SUPPORTED_FORWARDERS.join(' / ')}, but not into ${kinds}.`,
    '',
    'Filebeat specifically needs a forked helm chart (`log10x-elastic/filebeat`) because the upstream chart has no extraContainers/extraVolumes hooks — that path isn\'t wired into the wizard yet.',
    '',
    'Options:',
    '- Switch to the dedicated DaemonSet: re-invoke with `app: "reporter"`. The Reporter runs alongside whatever forwarder you have today, zero-touch.',
    `- Add a supported forwarder to the cluster (${SUPPORTED_FORWARDERS.join(' / ')}), then re-run \`log10x_discover_env\` and \`log10x_advise_install\`.`,
    '- Ask the Log10x team to prioritise the Filebeat receiver path.',
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

/**
 * Human-readable labels for each supported metrics backend. Keep stable —
 * the picklist UI in MCP hosts (Claude Desktop) renders these verbatim
 * as the option text.
 */
const BACKEND_LABEL: Record<MetricsBackendKind, string> = {
  log10x: 'Log10x SaaS',
  datadog: 'Datadog',
  elastic: 'Elasticsearch',
  cloudwatch: 'AWS CloudWatch',
  signalfx: 'Splunk Observability (SignalFx)',
  prometheus: 'Prometheus (self-hosted)',
};

function askBackends(detectedAgents: DetectedMetricsBackend[]): string {
  const lines: string[] = [];
  lines.push('# Install wizard — where do metrics go?');
  lines.push('');
  lines.push(
    'The Log10x engine publishes event statistics (volumes, cost attribution, pattern fingerprints) and per-pattern enrichments as time-series metrics. We need to know **which TSDB(s) to push them to** — that\'s where the MCP and your dashboards will read them back from.'
  );
  lines.push('');
  lines.push(
    'You can ship the same metrics to **multiple backends in parallel** — for example, to Log10x SaaS for MCP queries AND your existing Datadog for unified dashboards.'
  );
  lines.push('');
  lines.push('Options (pick one or more):');
  lines.push('');

  // Emit every supported backend as its own bullet so MCP-host UIs that
  // auto-render bullet lists as picklists (Claude Desktop, etc.) produce
  // one selectable item per backend. Bundling backends into a prose
  // "Other backends:" line causes those UIs to collapse them into a
  // single "Something else" option, hiding choices.
  const detectedSet = new Set(detectedAgents.map((a) => a.kind));
  for (const kind of SUPPORTED_BACKENDS) {
    const label = BACKEND_LABEL[kind];
    const annotations: string[] = [];
    if (kind === 'log10x') annotations.push('Log10x-managed Prometheus — recommended, no infra to run');
    if (detectedSet.has(kind)) annotations.push('detected in your cluster');
    const suffix = annotations.length > 0 ? ` — ${annotations.join(', ')}` : '';
    lines.push(`- **${label}** (\`${kind}\`)${suffix}`);
  }

  lines.push('');
  lines.push('Re-invoke `log10x_advise_install` with `backends: ["<choice>", ...]` — one or more. Examples:');
  lines.push('- `backends: ["log10x"]` — just SaaS, default for first install');
  lines.push('- `backends: ["datadog"]` — your own backend only');
  lines.push('- `backends: ["log10x", "datadog"]` — both, side-by-side');
  return lines.join('\n');
}

function askBackendCredentials(backends: MetricsBackendKind[]): string {
  const lines: string[] = [];
  lines.push('# Install wizard — credentials for your metrics backends');
  lines.push('');
  lines.push(
    'For each backend, the engine needs credentials to authenticate when it pushes metrics. To do that securely **without putting secrets in `values.yaml`**, we wire sensitive env vars via Kubernetes Secrets (`valueFrom.secretKeyRef`) — you point us at a Secret name and we mount the keys at runtime.'
  );
  lines.push('');
  lines.push('That way you keep using **whatever Secret-management you already have** (Sealed Secrets, External Secrets, Vault, manual `kubectl create secret`, etc.) — we just consume the result. Create or reuse the Secret out-of-band before `helm upgrade`. Per backend, tell the wizard:');
  lines.push('');
  lines.push('- **Secret name** — what to look up in the cluster. Default if you skip: `<backend>-credentials`.');
  lines.push('- **Plain-value overrides** — non-sensitive config like region/URL/namespace. Each has a sensible default; override when needed.');
  lines.push('');

  for (const b of backends) {
    const spec = BACKEND_ENV_SPECS[b];
    if (!spec) continue;
    lines.push(`### ${b}`);
    lines.push('');
    lines.push(`Default secret name: \`${defaultSecretNameFor(b)}\`. Expected keys inside the Secret:`);
    for (const s of spec.secret) {
      lines.push(`  - \`${s.secretKey}\` → mounted as env var \`${s.envVar}\``);
    }
    if (spec.plain.length > 0) {
      lines.push('');
      lines.push('Plain-value env vars (override or accept the default):');
      for (const p of spec.plain) {
        if (p.default !== undefined) {
          lines.push(`  - \`${p.envVar}\` (default: \`${p.default}\`)`);
        } else {
          lines.push(`  - \`${p.envVar}\` (no default — must supply; placeholder: \`${p.placeholder ?? ''}\`)`);
        }
      }
    }
    lines.push('');
  }

  // Show a worked example so the agent has a template for the
  // `backend_credentials` arg shape.
  lines.push('## Re-invoke shape');
  lines.push('');
  lines.push('Pass a `backend_credentials` map keyed by backend, with `secretName` and optional `plainValues`. Example covering the backends asked:');
  lines.push('');
  lines.push('```json');
  const example: Record<string, { secretName: string; plainValues?: Record<string, string> }> = {};
  for (const b of backends) {
    const spec = BACKEND_ENV_SPECS[b];
    if (!spec) continue;
    const plainExample: Record<string, string> = {};
    for (const p of spec.plain) {
      plainExample[p.envVar] = p.default ?? p.placeholder ?? '';
    }
    example[b] = {
      secretName: defaultSecretNameFor(b),
      ...(Object.keys(plainExample).length > 0 ? { plainValues: plainExample } : {}),
    };
  }
  lines.push(JSON.stringify({ backend_credentials: example }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('You can answer all backends in one call, or one at a time — the wizard remembers what\'s been answered.');
  return lines.join('\n');
}

function askLicenseSource(): string {
  return [
    '# Install wizard — how do you want to license the engine?',
    '',
    'The Log10x engine needs a license JWT to start. We need to know how you want to get one — there\'s a real Log10x license tied to your account (recommended), a transient demo, and a paste-an-existing-JWT path.',
    '',
    'Re-invoke `log10x_advise_install` with one of:',
    '',
    '- **`license_source: "signin"`** — recommended. The wizard will tell you to call `log10x_signin_start` to authenticate to Log10x; after sign-in, re-invoke and the wizard mints a user-scoped license automatically. Your other answers are remembered. Required for airgapped installs.',
    '- **`license_source: "demo"`** — anonymous 14-day demo JWT. Quick and zero-setup, but transient, can\'t run airgapped, and the demo license tier has reduced limits.',
    '- **`license_source: "paste"`** — you already have a JWT and want to use it. Re-invoke with `license_jwt_paste: "<the jwt>"`.',
  ].join('\n');
}

function askLicensePaste(): string {
  return [
    '# Install wizard — paste the license JWT',
    '',
    'You picked `license_source: "paste"`. Re-invoke `log10x_advise_install` with `license_jwt_paste: "<your JWT>"` to supply the license JWT. The JWT is what authorizes the engine and what the chart mounts via the license Secret — keep it out of shell history (the wizard\'s pre-install step uses `--from-literal` but you can switch to `--from-file=<path>` after the fact if needed).',
  ].join('\n');
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

type RenderPlanResult =
  | { kind: 'plan'; markdown: string; destination: string }
  | { kind: 'ambiguous_destination'; markdown: string; candidates: string[] };

async function renderInstallPlan(
  snapshot: DiscoverySnapshot,
  session: WizardSession,
  args: AdviseInstallArgs
): Promise<RenderPlanResult> {
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

  // Route to the right plan builder. Destination defaults to `mock` —
  // the install wizard no longer asks for a forwarder-event destination
  // (the user's existing forwarder still controls where events go;
  // the wizard's overlay is additive for the sidecar pattern, with a
  // documented placeholder in the values for the user to wire their own
  // destination output).
  if (session.app === 'reporter' || session.app === 'receiver') {
    const destination: OutputDestination = 'mock';

    const plan = await buildReporterPlan({
      snapshot,
      app: session.app,
      forwarder: session.forwarder,
      releaseName: session.releaseName,
      namespace: session.namespace,
      licenseJwt: session.licenseJwt,
      isDemoLicense: session.isDemoLicense,
      destination,
      backends: session.backends,
      backendCredentials: session.backendCredentials,
      airgapped: session.airgapped,
      skipInstall: action === 'verify' || action === 'teardown',
      skipVerify: action === 'install' || action === 'teardown',
      skipTeardown: action === 'install' || action === 'verify',
    });
    lines.push(renderPlan(plan, action));
    return { kind: 'plan', markdown: lines.join('\n'), destination };
  }

  // Unreachable — session.app is constrained to 'reporter' | 'receiver' by
  // the schema, but the type system can't see that here. Defensive return.
  return { kind: 'plan', markdown: lines.join('\n'), destination: 'mock' };
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

