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
import { buildPlanSummary, type AdvisePlanSummary } from '../lib/advisor/envelope.js';
import type { AdvisePlan, AdviseAction } from '../lib/advisor/types.js';
import { acquireLicenseForWizard, LicenseFetchError, type AcquireLicenseResult } from '../lib/license-api.js';
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
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput, type ActionRole } from '../lib/output-types.js';

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
    .default('signin')
    .describe(
      'How the wizard should acquire the engine\'s license JWT. **Defaults to `"signin"`** when omitted — the wizard tries to mint a user-scoped license via the user\'s Auth0 session, and emits `signin_required` mode (chain through `log10x_signin_start` then re-invoke) when no session exists. Pass **`"demo"`** ONLY when the user explicitly asks for a quick 14-day anonymous demo (transient, can\'t run airgapped). Pass **`"paste"`** with `license_jwt_paste: "<jwt>"` when the user already has a JWT.'
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

/**
 * Discriminated union over every possible wizard outcome. The agent
 * reads `data.mode` and narrows to the per-mode shape — every field
 * is typed. Mirrors the typed-data pattern Tal established for
 * services / pattern_mitigate / dependency_check / etc.
 *
 * Every variant carries `markdown` so a host that wants the rendered
 * prompt can still read it; agents that want structured info read the
 * mode-specific fields instead.
 */
type WizardData =
  | { mode: 'missing_snapshot'; ok: false; snapshot_id: string; markdown: string }
  | { mode: 'session_error'; ok: false; snapshot_id: string; markdown: string }
  | { mode: 'cancelled'; ok: false; snapshot_id: string; markdown: string }
  | {
      mode: 'next_question';
      ok: false;
      snapshot_id: string;
      question_id: QuestionId;
      markdown: string;
      /**
       * Structured rendering of the question — variants by input shape.
       * The agent reads this instead of parsing the markdown to know
       * what to ask the user and what shape the answer takes.
       */
      shape: QuestionShape;
    }
  | { mode: 'license_error'; ok: false; snapshot_id: string; error_message: string; markdown: string }
  | { mode: 'signin_required'; ok: false; snapshot_id: string; markdown: string }
  | { mode: 'demo_airgapped_warning'; ok: true; snapshot_id: string; is_signed_in: boolean; markdown: string }
  | {
      mode: 'unknown_args';
      ok: false;
      snapshot_id?: string;
      unknown_keys: string[];
      suggestions: Array<{ unknown: string; did_you_mean: string | null }>;
      valid_keys: string[];
      markdown: string;
    }
  // `ok` on the plan variant comes from AdvisePlanSummary (blockers.length === 0).
  // A "plan" return is always a successful wizard run — even when the plan
  // itself has blockers, the wizard's job (turning answers into a typed
  // plan) succeeded. Agents read summary.blockers for plan-level issues.
  | ({ mode: 'plan'; markdown: string } & AdvisePlanSummary);

type WizardMode = WizardData['mode'];

const TOOL_NAME = 'log10x_advise_install';

/**
 * Per-question metadata. Each entry pairs a `QuestionId` with the
 * one-line headline that lands cold for the agent + the schema field
 * the agent fills in to answer it. The wizard surfaces these on the
 * `next_question` mode so the agent doesn't have to regex-grep the
 * markdown for the next valid arg.
 */
const QUESTION_META: Record<QuestionId, { headline: string; answer_field: string }> = {
  'app': {
    headline: 'Wizard Q1: pick the install path — `reporter` (parallel DaemonSet, zero-touch) or `receiver` (sidecar in your forwarder).',
    answer_field: 'app',
  },
  'forwarder': {
    headline: 'Wizard Q2: multiple supported forwarders detected — pick which one the Receiver should sidecar into.',
    answer_field: 'forwarder',
  },
  'no-forwarder': {
    headline: 'Wizard Q2 blocked: no supported forwarder detected in the cluster. Switch to `app: "reporter"` or install a forwarder first.',
    answer_field: 'app',
  },
  'backends': {
    headline: 'Wizard Q3: pick one or more metrics backends (TSDBs) — where the engine publishes event statistics and Log10x enrichments.',
    answer_field: 'backends',
  },
  'airgapped-log10x-conflict': {
    headline: 'Wizard conflict: `airgapped: true` + `"log10x"` in backends is impossible — drop one.',
    answer_field: 'backends',
  },
  'backend-credentials': {
    headline: 'Wizard Q4: each non-`log10x` backend needs a Kubernetes Secret name + plain-value overrides — the engine reads credentials from there at runtime.',
    answer_field: 'backend_credentials',
  },
  'airgapped': {
    headline: 'Wizard Q5: run the engine fully airgapped (zero outbound calls to log10x.com)?',
    answer_field: 'airgapped',
  },
  // 'license-source' is intentionally absent. The wizard no longer
  // elicits the license source — signin is the implicit default and the
  // wizard emits `signin_required` mode when no Auth0 session exists.
  // Demo and paste remain accessible via the explicit `license_source`
  // arg but never as a wizard-rendered question.
  'license-paste': {
    headline: 'Wizard Q6: paste the license JWT you already have.',
    answer_field: 'license_jwt_paste',
  },
};

/**
 * Canonical arg names the wizard accepts. Derived from the schema
 * itself so a new field added to `adviseInstallSchema` is automatically
 * accepted by the unknown-key check.
 *
 * `api_key` and `environment` aren't in the wizard's schema but are
 * routinely injected by MCP hosts (auth credentials, multi-env
 * selectors). Blocking them would break the install flow on those
 * hosts, so they're whitelisted here.
 */
const KNOWN_ARG_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(adviseInstallSchema),
  'api_key',
  'environment',
]);

/**
 * Common LLM hallucinations → canonical arg. Lexical distance (Levenshtein)
 * misses these because they're semantically near but characterwise far
 * (`targets` vs `backends` is edit-distance 7). Hand-curated from observed
 * agent behavior across model families. Add new entries when an eval run
 * surfaces a new wrong word.
 */
const ARG_SYNONYMS: ReadonlyMap<string, string> = new Map([
  // backends — TSDB destinations for engine metrics
  ['targets', 'backends'],
  ['target', 'backends'],
  ['destinations', 'backends'],
  ['destination', 'backends'],
  ['outputs', 'backends'],
  ['output', 'backends'],
  ['sinks', 'backends'],
  ['sink', 'backends'],
  ['tsdbs', 'backends'],
  ['tsdb', 'backends'],
  ['metrics_backends', 'backends'],
  ['metric_backends', 'backends'],
  // app — install variant (reporter vs receiver)
  ['mode', 'app'],
  ['kind', 'app'],
  ['variant', 'app'],
  ['install_type', 'app'],
  ['type', 'app'],
  // license — JWT / source
  ['license', 'license_jwt_paste'],
  ['license_jwt', 'license_jwt_paste'],
  ['jwt', 'license_jwt_paste'],
  ['license_mode', 'license_source'],
  // misc
  ['ns', 'namespace'],
  ['release', 'release_name'],
  ['name', 'release_name'],
  ['airgap', 'airgapped'],
  ['offline', 'airgapped'],
  ['snapshot', 'snapshot_id'],
  ['snapshotId', 'snapshot_id'],
]);

/**
 * Levenshtein edit distance — used to suggest the closest known arg
 * when an agent passes an unknown one. Tiny implementation; the inputs
 * are short identifier strings so O(n*m) is fine.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find the closest known arg name to an unknown one. Returns null if
 * nothing is close enough to be a confident suggestion. The threshold
 * scales with the unknown's length so short typos still match but
 * unrelated words don't.
 */
function findClosestKnownArg(unknown: string): string | null {
  // 1. Hand-curated semantic synonyms first — catches the cases where the
  //    wrong word is semantically close but lexically far ('targets' vs
  //    'backends'). Case-insensitive.
  const synonym = ARG_SYNONYMS.get(unknown.toLowerCase());
  if (synonym) return synonym;
  // 2. Levenshtein fall-through for actual typos ('snapshot_di' → 'snapshot_id').
  let best: { key: string; dist: number } | null = null;
  const lower = unknown.toLowerCase();
  for (const known of KNOWN_ARG_NAMES) {
    const d = levenshtein(lower, known.toLowerCase());
    if (!best || d < best.dist) best = { key: known, dist: d };
  }
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(unknown.length / 2));
  return best.dist <= threshold ? best.key : null;
}

/**
 * Build a wizard StructuredOutput. The mode determines the headline,
 * `actions[]` (next-tool hints the agent reads to route), and `warnings[]`
 * (plan-level issues surfaced out-of-band so the agent doesn't have to
 * parse markdown). Same shape every wizard call.
 */
function wizardReturn(view: 'summary' | 'markdown', data: WizardData): StructuredOutput {
  const { headline, actions, warnings } = wizardEnvelopeMeta(data);
  if (view === 'markdown') {
    return buildMarkdownEnvelope({ tool: TOOL_NAME, summary: { headline }, markdown: data.markdown });
  }
  return buildEnvelope({
    tool: TOOL_NAME,
    view: 'summary',
    summary: { headline },
    data,
    actions,
    warnings,
  });
}

/**
 * Per-mode crafted headline + next-tool actions + warnings. Headlines
 * are sentences the agent can quote cold to a user; actions[] tells the
 * agent what to call next with what args; warnings[] surface non-fatal
 * issues at the envelope level (plan blockers, demo-license caveats).
 */
function wizardEnvelopeMeta(data: WizardData): {
  headline: string;
  actions: Array<{ tool: string; args: Record<string, unknown>; reason: string; role: ActionRole }>;
  warnings: string[];
} {
  switch (data.mode) {
    case 'missing_snapshot':
      return {
        headline: `Snapshot \`${data.snapshot_id}\` expired or not found (30-min TTL). Re-discover the cluster first.`,
        actions: [
          { tool: 'log10x_discover_env', args: {}, reason: 'mint a fresh snapshot; then re-invoke log10x_advise_install with the new snapshot_id', role: 'required-next' },
        ],
        warnings: [],
      };
    case 'session_error':
      return {
        headline: `Wizard session failed to initialize for snapshot \`${data.snapshot_id}\` — re-discover and retry.`,
        actions: [
          { tool: 'log10x_discover_env', args: {}, reason: 'mint a fresh snapshot — internal session-store state is unexpected', role: 'required-next' },
        ],
        warnings: ['unexpected internal error — the snapshot store is in a bad state for this snapshot_id'],
      };
    case 'cancelled':
      return {
        headline: `Wizard cancelled mid-flow. Re-invoke log10x_advise_install with snapshot_id="${data.snapshot_id}" to resume — every prior answer is preserved.`,
        actions: [
          { tool: 'log10x_advise_install', args: { snapshot_id: data.snapshot_id }, reason: 'resume the wizard — the session remembers every prior answer for 30 min', role: 'recommended-next' },
        ],
        warnings: [],
      };
    case 'next_question': {
      const meta = QUESTION_META[data.question_id];
      return {
        headline: meta?.headline ?? `Wizard next question (${data.question_id}).`,
        actions: [
          {
            tool: 'log10x_advise_install',
            args: meta
              ? { snapshot_id: data.snapshot_id, [meta.answer_field]: '<user answer>' }
              : { snapshot_id: data.snapshot_id },
            reason: meta
              ? `answer "${data.question_id}" by setting \`${meta.answer_field}\` and re-invoke; the session keeps every prior answer`
              : `answer "${data.question_id}" and re-invoke the wizard`,
            role: 'required-next',
          },
        ],
        warnings: [],
      };
    }
    case 'license_error':
      // Two alternative recovery paths the user picks between (sign in
      // OR paste a JWT). Both labelled `alternative` so agents render
      // them as a choice rather than chain them.
      return {
        headline: `License acquisition failed: ${data.error_message}. Sign in or paste an existing JWT to retry.`,
        actions: [
          { tool: 'log10x_signin_start', args: {}, reason: 'sign in via the browser device flow to mint a user-scoped license', role: 'alternative' },
          {
            tool: 'log10x_advise_install',
            args: { snapshot_id: data.snapshot_id, license_source: 'paste', license_jwt_paste: '<your JWT>' },
            reason: 'retry with a license JWT you already have',
            role: 'alternative',
          },
        ],
        warnings: [`license fetch failed: ${data.error_message}`],
      };
    case 'signin_required':
      // The two actions form a strict ordered prerequisite chain:
      // signin_start MUST complete before the re-invoke. Both
      // `required-next` + array-order = chain. Agents that respect the
      // role enum will not parallelize or skip.
      return {
        headline: `Wizard cannot mint a real license without sign-in. CHAIN: call log10x_signin_start NEXT, then re-invoke log10x_advise_install — every prior answer is preserved.`,
        actions: [
          { tool: 'log10x_signin_start', args: {}, reason: 'opens the device-code browser flow to sign in to Log10x (gets Auth0 tokens needed to mint a user-scoped license). Must complete before the next action.', role: 'required-next' },
          { tool: 'log10x_advise_install', args: { snapshot_id: data.snapshot_id }, reason: 'after signin_start completes, re-invoke the wizard with the same snapshot_id; the wizard will auto-mint a real user-scoped license now that Auth0 tokens exist', role: 'required-next' },
        ],
        warnings: [
          'plan NOT emitted yet — the user picked sign-in, but the wizard cannot proceed until log10x_signin_start has been called and completed successfully. Do NOT proceed without it; do NOT silently fall back to demo.',
        ],
      };
    case 'unknown_args': {
      const suggestions = data.suggestions
        .filter((s) => s.did_you_mean)
        .map((s) => `'${s.unknown}' → '${s.did_you_mean}'`)
        .join(', ');
      return {
        headline:
          suggestions.length > 0
            ? `Wizard rejected unknown arg${data.unknown_keys.length === 1 ? '' : 's'} (${data.unknown_keys.join(', ')}). Did you mean: ${suggestions}? Re-invoke with the canonical name.`
            : `Wizard rejected unknown arg${data.unknown_keys.length === 1 ? '' : 's'} (${data.unknown_keys.join(', ')}). Valid args: ${data.valid_keys.join(', ')}. Re-invoke without the unknown key${data.unknown_keys.length === 1 ? '' : 's'}.`,
        actions: [],
        warnings: [
          `unknown_args rejected: ${data.unknown_keys.join(', ')} — wizard will not parse partial / typo'd input; re-invoke with the canonical names`,
        ],
      };
    }
    case 'demo_airgapped_warning':
      // Two alternatives: switch to real license (signin_start +
      // re-invoke) OR keep demo and drop airgapped. Labelled
      // `alternative` so agent surfaces both, user picks.
      return {
        headline: data.is_signed_in
          ? `Demo license + airgapped doesn't enforce — your pasted-API-key sign-in lacks Auth0 tokens to mint a user license. Switch to device-flow sign-in, or drop airgapped.`
          : `Demo license + airgapped doesn't enforce: engine downgrades to online mode silently. Sign in for a real license, or drop airgapped.`,
        actions: [
          { tool: 'log10x_signin_start', args: {}, reason: 'sign in to mint a real license that actually enforces airgapped (the engine refuses to run airgapped on demo licenses)', role: 'alternative' },
          { tool: 'log10x_advise_install', args: { snapshot_id: data.snapshot_id, airgapped: false }, reason: 'or keep the demo license and proceed without airgapped', role: 'alternative' },
        ],
        warnings: ['demo licenses cannot run airgapped — engine downgrades to online mode at startup with a warning log'],
      };
    case 'plan': {
      const warnings: string[] = [];
      if (data.blockers.length > 0) {
        warnings.push(`plan has ${data.blockers.length} blocker${data.blockers.length !== 1 ? 's' : ''} — see data.blockers`);
      }
      // Use the typed `license_kind` field instead of grepping notes
      // (back-compat: also fall back to the legacy notes-grep if
      // license_kind isn't populated, which shouldn't happen on this
      // branch but guards future renames).
      const isDemoLicense =
        data.license_kind === 'demo' ||
        (data.license_kind === undefined && data.notes.some((n) => /demo license/i.test(n)));
      if (isDemoLicense) {
        warnings.push('plan emitted with a demo license — re-run with `license_source: "signin"` before the 14-day window expires to get a user-scoped one');
      }
      const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string; role: ActionRole }> = [];
      // Post-install health check is universal — optional follow-up.
      actions.push({
        tool: 'log10x_doctor',
        args: {},
        reason: 'verify the install once the helm release rolls out — checks engine pods Ready, metrics flowing, license-Secret mounted',
        role: 'optional-followup',
      });
      // Receiver path: post-install pattern-mitigation is the natural follow-up.
      if (data.app === 'receiver') {
        actions.push({
          tool: 'log10x_top_patterns',
          args: {},
          reason: 'once events are flowing, see which patterns dominate cost and offer mitigation via log10x_pattern_mitigate',
          role: 'optional-followup',
        });
      }
      // Real-license-Secret path requires the user to create the Secret BEFORE
      // `helm upgrade`. The plan markdown explains it; surface as warning too.
      const needsSecret = data.notes.some((n) => /licenseSecret|log10x-license/i.test(n));
      if (needsSecret) {
        warnings.push('the plan references an out-of-band Kubernetes Secret (log10x-license) — create it with kubectl before running the helm upgrade step');
      }
      // Install-mode awareness: when upgrade-existing, reassure the
      // agent (and through it, the user) that this is NOT a second
      // forwarder deploy. When fresh-release on the Receiver path with
      // no existing release detected, surface a soft caveat so the
      // agent can ask the user whether they really want a brand-new
      // forwarder alongside whatever they have.
      if (data.install_mode === 'upgrade-existing' && data.existing_helm_release) {
        warnings.push(`this plan UPGRADES the existing Helm release \`${data.existing_helm_release.name}\` in \`${data.existing_helm_release.namespace}\` (sidecar goes INTO it) — no second ${data.forwarder ?? 'forwarder'} is deployed`);
      } else if (data.install_mode === 'fresh-release' && data.app === 'receiver') {
        warnings.push(`this plan deploys a FRESH ${data.forwarder ?? 'forwarder'} Helm release (no existing helm-managed forwarder was detected). If the user has a non-helm-managed forwarder running, this WILL create a second one alongside it. Confirm with the user before running the plan.`);
      }
      return {
        headline: planHeadlineForWizard(data),
        actions,
        warnings,
      };
    }
  }
}

/**
 * Plan-mode headline. Mirrors lib/advisor/envelope.ts's planHeadline
 * shape but tailored for the wizard's plan emit (the wizard always
 * emits app + forwarder).
 */
function planHeadlineForWizard(data: { app: string; forwarder?: string; action: string; install_step_count: number; verify_probe_count: number; teardown_step_count: number; blockers: string[]; release_name: string; namespace: string }): string {
  const fwd = data.forwarder ? ` on ${data.forwarder}` : '';
  if (data.blockers.length > 0) {
    return `${data.app} ${data.action} plan${fwd}: BLOCKED (${data.blockers.length} issue${data.blockers.length !== 1 ? 's' : ''}). Release "${data.release_name}" in "${data.namespace}".`;
  }
  return `${data.app} ${data.action} plan${fwd}: ${data.install_step_count} install / ${data.verify_probe_count} verify / ${data.teardown_step_count} teardown — release "${data.release_name}" in namespace "${data.namespace}".`;
}

export async function executeAdviseInstall(
  args: AdviseInstallArgs,
  envs: Environments,
  mcpServer?: McpServer
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';

  // Surface unknown args up-front rather than silently dropping them.
  // Agents reliably hallucinate field names ('targets' / 'destinations'
  // for `backends`, 'mode' for `app`, etc.). Detecting the typo and
  // returning a typed envelope with "did you mean" gets the next call
  // right; silently dropping wastes a wizard round-trip.
  const rawKeys = Object.keys(args as Record<string, unknown>);
  const unknownKeys = rawKeys.filter((k) => !KNOWN_ARG_NAMES.has(k));
  if (unknownKeys.length > 0) {
    const suggestions = unknownKeys.map((k) => ({
      unknown: k,
      did_you_mean: findClosestKnownArg(k),
    }));
    const validKeys = [...KNOWN_ARG_NAMES].sort();
    const lines: string[] = [`# Install wizard — unknown arg${unknownKeys.length === 1 ? '' : 's'}`, ''];
    for (const s of suggestions) {
      lines.push(
        s.did_you_mean
          ? `- \`${s.unknown}\` is not a valid arg. Did you mean \`${s.did_you_mean}\`?`
          : `- \`${s.unknown}\` is not a valid arg.`
      );
    }
    lines.push('');
    lines.push(`Valid args: ${validKeys.map((k) => `\`${k}\``).join(', ')}.`);
    lines.push('');
    lines.push('Re-invoke `log10x_advise_install` with the canonical names.');
    return wizardReturn(view, {
      mode: 'unknown_args',
      ok: false,
      snapshot_id: typeof args.snapshot_id === 'string' ? args.snapshot_id : undefined,
      unknown_keys: unknownKeys,
      suggestions,
      valid_keys: validKeys,
      markdown: lines.join('\n'),
    });
  }

  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    const md = [
      `# Install wizard — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
    return wizardReturn(view, {
      mode: 'missing_snapshot',
      ok: false,
      snapshot_id: args.snapshot_id,
      markdown: md,
    });
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
    return wizardReturn(view, {
      mode: 'session_error',
      ok: false,
      snapshot_id: args.snapshot_id,
      markdown: '# Install wizard — internal error\n\nWizard session could not be created.',
    });
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
      return wizardReturn(view, {
        mode: 'cancelled',
        ok: false,
        snapshot_id: args.snapshot_id,
        markdown: md,
      });
    }
    if (elicitOutcome.kind === 'failed') {
      // Elicitation errored mid-flow — fall back to markdown questions.
      // The session has accumulated whatever was answered before the error.
      const next = nextQuestion(snapshot, session);
      if (next.kind === 'ask') {
        return wizardReturn(view, {
          mode: 'next_question',
          ok: false,
          snapshot_id: args.snapshot_id,
          question_id: next.questionId,
          markdown: next.markdown,
          shape: next.shape,
        });
      }
    }
  } else {
    // Markdown-fallback path: ask one question, return markdown, wait
    // for re-invocation with the answer in tool args.
    const next = nextQuestion(snapshot, session);
    if (next.kind === 'ask') {
      return wizardReturn(view, {
        mode: 'next_question',
        ok: false,
        snapshot_id: args.snapshot_id,
        question_id: next.questionId,
        markdown: next.markdown,
        shape: next.shape,
      });
    }
  }

  // License acquisition. Three paths driven by session.licenseSource:
  //   - 'signin' — the user said "sign me in". We require a real
  //     user-scoped license; if acquireLicenseForWizard would return a
  //     demo (because the user isn't actually signed in via the device
  //     flow, or is signed in only via a pasted API key with no Auth0
  //     tokens), we surface signin_required INSTEAD of accepting the
  //     demo. The previous gate (`envs.isDemoMode`) missed the
  //     pasted-key case — that's why picking "sign in" still ended up
  //     with a demo JWT in the plan.
  //   - 'demo' — explicit demo. Skip the signed-in check, mint a demo.
  //   - 'paste' — the user supplied license_jwt_paste; session.licenseJwt
  //     is already populated from that arg. Nothing to do here.
  if (!session.licenseJwt && session.licenseSource !== 'paste') {
    try {
      const lic = await acquireLicenseForWizard();
      const isRealUserLicense =
        lic.reason === 'signed-in-user' || lic.reason === 'refreshed-then-user';
      if (session.licenseSource === 'signin' && !isRealUserLicense) {
        // Honest answer: the user picked "sign in" but acquireLicense
        // didn't get a user-scoped JWT. Don't silently fall back to the
        // demo JWT it returned — refuse, and tell the agent the right
        // recovery step for the SPECIFIC failure (sign in via device
        // flow vs retry vs etc.). The per-reason copy avoids the prior
        // bug where "you signed in via pasted API key" was shown for
        // expired-refresh / refresh-failed / fetch-failed cases too.
        const md = [
          `# Install wizard — sign in to Log10x first`,
          ``,
          signinRequiredReasonMessage(lic.reason),
          ``,
          `Once you're signed in, re-invoke \`log10x_advise_install\` with the same \`snapshot_id\`. Every answer you gave above is remembered — you won't have to redo any step.`,
        ].join('\n');
        // Persist the reason so the demo+airgapped warning (if reached
        // on a future turn through 'demo' or 'paste') can branch on the
        // same taxonomy. Not strictly needed for this path, but cheap.
        updateWizardSession(args.snapshot_id, { licenseReason: lic.reason });
        return wizardReturn(view, {
          mode: 'signin_required',
          ok: false,
          snapshot_id: args.snapshot_id,
          markdown: md,
        });
      }
      updateWizardSession(args.snapshot_id, {
        licenseJwt: lic.jwt,
        isDemoLicense: lic.isDemoLicense,
        licenseReason: lic.reason,
      });
      session.licenseJwt = lic.jwt;
      session.isDemoLicense = lic.isDemoLicense;
      session.licenseReason = lic.reason;
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
      return wizardReturn(view, {
        mode: 'license_error',
        ok: false,
        snapshot_id: args.snapshot_id,
        error_message: msg,
        markdown: md,
      });
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
    // `is_signed_in` here means "had Auth0 tokens" — i.e., the device
    // flow has been completed at least once. We derive it from the
    // license-acquire reason rather than `envs.isDemoMode` because the
    // latter is true for pasted-API-key users (who are technically
    // "signed in" by API key but lack the Auth0 tokens needed to mint
    // a user license — they still need to run the device flow). Falls
    // back to `!envs.isDemoMode` when the wizard reached this mode via
    // a path that didn't populate `licenseReason` (e.g., the user
    // pasted a JWT and marked it demo).
    const isSignedIn = session.licenseReason
      ? hasAuth0TokensForReason(session.licenseReason)
      : !envs.isDemoMode;
    const md = renderDemoAirgappedWarning(session, isSignedIn);
    return wizardReturn(view, {
      mode: 'demo_airgapped_warning',
      ok: true,
      snapshot_id: args.snapshot_id,
      is_signed_in: isSignedIn,
      markdown: md,
    });
  }

  // Everything answered. Emit the typed plan envelope — `data` mirrors
  // AdvisePlanSummary so an agent that already handles advise_retriever
  // consumes this identically.
  const planResult = await renderInstallPlan(snapshot, session, args);
  const summary = buildPlanSummary(planResult.plan, planResult.action);
  return wizardReturn(view, {
    ...summary,
    mode: 'plan',
    markdown: planResult.markdown,
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

    // Q6: license source — IMPLICIT 'signin'.
    //
    // We deliberately do NOT elicit this. Three attempts to get Claude
    // Desktop's UI to mark "sign in" as the recommended choice all
    // failed: regardless of enumNames text, `default:` field, or
    // "(Recommended)" suffix, the host's auto-rephraser keeps stripping
    // our labels and applying its own "(Recommended)" badge to demo
    // (the shortest-label / no-followup-required option). Letting the
    // host overrule our intent means users routinely pick demo without
    // realizing it's the wrong path for real installs.
    //
    // Resolution: signin is the IMPLICIT default. If acquireLicense
    // can't mint a real user-scoped license, the wizard emits
    // `signin_required` and stops — the agent chains through
    // log10x_signin_start, then re-invokes. Demo and paste remain
    // reachable via the schema's `license_source` arg, but as
    // explicit escape hatches (the agent passes them when the USER
    // says "I just want to play with demo" or "I have a JWT").
    if (!session.licenseSource) {
      session.licenseSource = 'signin';
      updateWizardSession(session.snapshotId, { licenseSource: 'signin' });
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

type QuestionId = 'app' | 'forwarder' | 'no-forwarder' | 'backends' | 'airgapped-log10x-conflict' | 'backend-credentials' | 'airgapped' | 'license-paste';

/**
 * Structured rendering of the wizard's next question. The agent uses
 * this instead of regex-grepping the markdown for valid answers — it
 * sees the choices, their human labels, which one is recommended, and
 * the schema field name to fill on the next call.
 *
 * Variants by user-input shape:
 *   - single-choice  — pick one (`app`, `forwarder`, `license-source`)
 *   - multi-choice   — pick one or more (`backends`)
 *   - boolean        — yes/no (`airgapped`)
 *   - string         — free-text input (`license-paste`)
 *   - form           — multi-field object (`backend-credentials`)
 *   - info           — no input expected; the agent presents
 *     `resolutions[]` (each with an example re-invocation) so the user
 *     can pick a path out of the situation (`no-forwarder`,
 *     `airgapped-log10x-conflict`)
 */
type QuestionChoice = {
  value: string;
  label: string;
  recommended?: boolean;
  details?: string;
};

type QuestionFormField = {
  name: string;
  type: 'string';
  description: string;
  required: boolean;
  default?: string;
  example?: string;
};

type QuestionShape =
  | { type: 'single-choice'; answer_field: string; choices: QuestionChoice[] }
  | { type: 'multi-choice'; answer_field: string; min_items: number; choices: QuestionChoice[] }
  | { type: 'boolean'; answer_field: string; default?: boolean }
  | { type: 'string'; answer_field: string; description: string; example?: string }
  | { type: 'form'; description: string; fields: QuestionFormField[] }
  | { type: 'info'; resolutions: Array<{ args: Record<string, unknown>; description: string }> };

type NextStep =
  | { kind: 'ask'; markdown: string; questionId: QuestionId; shape: QuestionShape }
  | { kind: 'render' };

function nextQuestion(snapshot: DiscoverySnapshot, session: WizardSession): NextStep {
  // Q1: app
  if (!session.app) {
    const supportedDetected = snapshot.kubectl.forwarders.filter(
      (f) => (SUPPORTED_FORWARDERS as readonly string[]).includes(f.kind)
    );
    const choices: QuestionChoice[] = [
      {
        value: 'reporter',
        label: 'Reporter (standalone DaemonSet, zero-touch)',
        recommended: supportedDetected.length === 0,
        details: 'A dedicated DaemonSet running alongside your existing forwarder. Tails container logs in parallel — does not touch your forwarder. Read-only.',
      },
    ];
    if (supportedDetected.length > 0) {
      choices.push({
        value: 'receiver',
        label: 'Receiver (sidecar inside your existing forwarder)',
        recommended: true,
        details: `A log10x/edge-10x sidecar injected into your existing forwarder pod (${supportedDetected.map((d) => d.kind).join(', ')} detected). Filters / samples / compacts events in-flight.`,
      });
    }
    return {
      kind: 'ask',
      markdown: askApp(snapshot),
      questionId: 'app',
      shape: { type: 'single-choice', answer_field: 'app', choices },
    };
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
      const baseResolutions: Array<{ args: Record<string, unknown>; description: string }> = [
        { args: { snapshot_id: session.snapshotId, app: 'reporter' }, description: 'Switch to the standalone Reporter DaemonSet — runs alongside whatever forwarder you have today, zero-touch.' },
      ];
      if (unsupported.length > 0) {
        return {
          kind: 'ask',
          markdown: unsupportedForwarderForReceiver(unsupported),
          questionId: 'no-forwarder',
          shape: {
            type: 'info',
            resolutions: [
              ...baseResolutions,
              { args: {}, description: `Add a wizard-supported forwarder to the cluster (${SUPPORTED_FORWARDERS.join(' / ')}), then re-run discover_env + advise_install.` },
            ],
          },
        };
      }
      return {
        kind: 'ask',
        markdown: noForwarderForReceiver(),
        questionId: 'no-forwarder',
        shape: {
          type: 'info',
          resolutions: [
            ...baseResolutions,
            { args: {}, description: `Install a forwarder first (${SUPPORTED_FORWARDERS.join(' / ')}), then re-run discover_env + advise_install.` },
          ],
        },
      };
    }
    if (supported.length === 1) {
      // Auto-pick the only supported detected forwarder.
      updateWizardSession(session.snapshotId, { forwarder: supported[0].kind });
      session.forwarder = supported[0].kind;
    } else {
      return {
        kind: 'ask',
        markdown: askForwarder(supported),
        questionId: 'forwarder',
        shape: {
          type: 'single-choice',
          answer_field: 'forwarder',
          choices: supported.map((d) => ({
            value: d.kind,
            label: `${d.kind} (${d.workloadKind}/${d.workloadName} in ${d.namespace})`,
            details: `image: ${d.image}, ready: ${d.readyReplicas}`,
          })),
        },
      };
    }
  }

  // Q3: backends — can be multiple, must be non-empty
  if (!session.backends || session.backends.length === 0) {
    const detectedSet = new Set(snapshot.kubectl.backendAgents.map((a) => a.kind));
    const backendDetails: Record<MetricsBackendKind, string> = {
      log10x: 'Log10x-managed Prometheus — no infra to run; the MCP queries metrics straight from here.',
      datadog: 'Datadog metric API (DD-API-KEY auth).',
      elastic: 'Elasticsearch metric ingest API.',
      cloudwatch: 'AWS CloudWatch metric streams.',
      signalfx: 'Splunk Observability (SignalFx) metric ingest API.',
      prometheus: 'Customer-owned Prometheus / Mimir / Thanos remote_write endpoint.',
    };
    return {
      kind: 'ask',
      markdown: askBackends(snapshot.kubectl.backendAgents),
      questionId: 'backends',
      shape: {
        type: 'multi-choice',
        answer_field: 'backends',
        min_items: 1,
        choices: SUPPORTED_BACKENDS.map((b) => {
          const detected = detectedSet.has(b as MetricsBackendKind);
          const detail = backendDetails[b as MetricsBackendKind] ?? '';
          return {
            value: b,
            label: detected ? `${BACKEND_LABEL[b as MetricsBackendKind]} (detected in your cluster)` : BACKEND_LABEL[b as MetricsBackendKind],
            recommended: b === 'log10x' || detected,
            details: detail,
          };
        }),
      },
    };
  }

  // Conflict check: airgapped + log10x in backends — surface, don't auto-resolve
  if (session.airgapped === true && session.backends.includes('log10x')) {
    return {
      kind: 'ask',
      markdown: airgappedLog10xConflict(session.backends),
      questionId: 'airgapped-log10x-conflict',
      shape: {
        type: 'info',
        resolutions: [
          {
            args: { snapshot_id: session.snapshotId, backends: session.backends.filter((b) => b !== 'log10x') },
            description: 'Keep airgapped, drop "log10x" from backends — engine emits only to your own backend(s).',
          },
          {
            args: { snapshot_id: session.snapshotId, airgapped: false },
            description: 'Keep "log10x" in backends, drop airgapped — engine reports to log10x SaaS + your own backend(s).',
          },
        ],
      },
    };
  }

  // Q4: per-backend credentials — ask for any non-`log10x` backend that
  // doesn't yet have a credential entry in the session. The agent can
  // bundle multiple backends into one answer via `backend_credentials`.
  const backendsNeedingCreds = session.backends.filter(
    (b) => b !== 'log10x' && !(session.backendCredentials?.[b])
  );
  if (backendsNeedingCreds.length > 0) {
    const fields: QuestionFormField[] = [];
    for (const backend of backendsNeedingCreds) {
      const spec = BACKEND_ENV_SPECS[backend];
      if (!spec) continue;
      fields.push({
        name: `backend_credentials.${backend}.secretName`,
        type: 'string',
        description: `Existing Kubernetes Secret holding ${BACKEND_LABEL[backend]} credentials. Expected keys inside: ${spec.secret.map((s) => `\`${s.secretKey}\` (→ ${s.envVar})`).join(', ')}.`,
        required: true,
        default: defaultSecretNameFor(backend),
      });
      for (const p of spec.plain) {
        fields.push({
          name: `backend_credentials.${backend}.plainValues.${p.envVar}`,
          type: 'string',
          description: `${p.envVar} for ${BACKEND_LABEL[backend]}.`,
          required: p.default === undefined,
          default: p.default,
          example: p.placeholder,
        });
      }
    }
    return {
      kind: 'ask',
      markdown: askBackendCredentials(backendsNeedingCreds),
      questionId: 'backend-credentials',
      shape: {
        type: 'form',
        description: `For each non-log10x backend (${backendsNeedingCreds.join(', ')}), provide a Kubernetes Secret name + optional plain-value overrides. The engine reads sensitive values from the Secret at runtime — they never enter values.yaml.`,
        fields,
      },
    };
  }

  // Q5: airgapped — only relevant when backends doesn't already include log10x
  // (if it does, the user has implicitly opted IN to log10x egress and
  // airgapped is moot)
  const hasLog10x = session.backends.includes('log10x');
  if (!hasLog10x && session.airgapped === undefined) {
    return {
      kind: 'ask',
      markdown: askAirgapped(session.backends),
      questionId: 'airgapped',
      shape: { type: 'boolean', answer_field: 'airgapped', default: false },
    };
  }
  // backends includes log10x → silently set airgapped=false so the
  // session is fully determined.
  if (hasLog10x && session.airgapped === undefined) {
    updateWizardSession(session.snapshotId, { airgapped: false });
    session.airgapped = false;
  }

  // Q6 (license source) — IMPLICIT 'signin'. Not elicited. See the
  // matching block in elicitMissingAnswers() above for the rationale.
  // Demo / paste remain accessible as explicit `license_source` args.
  if (!session.licenseSource) {
    session.licenseSource = 'signin';
    updateWizardSession(session.snapshotId, { licenseSource: 'signin' });
  }

  // Q7: when license_source=paste and the JWT hasn't been provided yet,
  // ask for it. (The agent passes it via `license_jwt_paste`, which the
  // session merge folds into `licenseJwt`.)
  if (session.licenseSource === 'paste' && !session.licenseJwt) {
    return {
      kind: 'ask',
      markdown: askLicensePaste(),
      questionId: 'license-paste',
      shape: {
        type: 'string',
        answer_field: 'license_jwt_paste',
        description: 'The JWT string the engine will use to authenticate. Mounted via a Kubernetes Secret at /etc/tenx/license/license.jwt — never written to values.yaml.',
        example: 'eyJhbGciOiJSUzI1NiIs...',
      },
    };
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

// askLicenseSource() removed — the wizard no longer surfaces the
// license-source choice as a question. Sign-in is the implicit default
// (see signin_required mode); demo / paste remain accessible via the
// explicit `license_source` arg on advise_install.

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

/**
 * Whether the user has at least one Auth0 token (access or refresh)
 * stored, given the reason `acquireLicenseForWizard` returned. Used to
 * derive `is_signed_in` for the demo+airgapped envelope: a pasted-API-key
 * user is technically "signed in" by API key but lacks the Auth0 tokens
 * needed to mint a user-scoped license, so we report them as "not signed
 * in" for the purposes of this surface (the actionable next step is the
 * device flow either way).
 */
function hasAuth0TokensForReason(
  reason: NonNullable<WizardSession['licenseReason']>
): boolean {
  switch (reason) {
    case 'signed-in-user':
    case 'refreshed-then-user':
    case 'access-token-expired-no-refresh':
    case 'refresh-failed':
    case 'user-license-fetch-failed':
      return true;
    case 'not-signed-in':
    case 'pasted-key-fallback':
      return false;
  }
}

/**
 * Per-reason markdown line for `signin_required` mode. Maps each demo-
 * fallback reason to a concrete next step the user can act on, instead
 * of the one-size-fits-all "you signed in via pasted API key" message
 * the wizard used to emit for every fallback.
 */
function signinRequiredReasonMessage(
  reason: AcquireLicenseResult['reason']
): string {
  switch (reason) {
    case 'pasted-key-fallback':
      return `You picked **Sign in** for the license. The wizard saw an existing Log10x API key but no Auth0 tokens (you signed in via pasted API key, which doesn't include the OAuth credentials needed to mint a user-scoped license). Run \`log10x_signin_start\` in your next turn — it opens the device-code browser flow and stores the Auth0 tokens.`;
    case 'not-signed-in':
      return `You picked **Sign in** for the license. The wizard found no Log10x account session — run \`log10x_signin_start\` in your next turn (it opens a browser to auth.log10x.com and exchanges the device-code for an API key + Auth0 tokens).`;
    case 'access-token-expired-no-refresh':
      return `You picked **Sign in** for the license. Your Auth0 access token has expired and there's no refresh token on file to recover with — most likely the prior sign-in was done a while ago and the refresh-token window has lapsed. Run \`log10x_signin_start\` to redo the device flow.`;
    case 'refresh-failed':
      return `You picked **Sign in** for the license. The wizard tried to refresh your Auth0 access token and the refresh call failed (network error, or Auth0 rejected the refresh token). Run \`log10x_signin_start\` to redo the device flow from scratch; if the refresh call keeps failing, that's a sign Auth0 has revoked the session.`;
    case 'user-license-fetch-failed':
      return `You picked **Sign in** for the license. Auth0 sign-in is fine, but the call to \`/api/v1/license\` (the endpoint that mints the user-scoped JWT) errored — typically a transient gateway problem. Re-invoke \`log10x_advise_install\` to retry; if it keeps failing, surface the error to the Log10x team. \`log10x_signin_start\` won't help in this case.`;
    case 'signed-in-user':
    case 'refreshed-then-user':
      // Unreachable: signin_required only fires when isRealUserLicense
      // is false. Conservative default so this never crashes on a
      // future taxonomy change.
      return `You picked **Sign in** for the license, but the wizard couldn't confirm a user-scoped JWT was minted. Run \`log10x_signin_start\` and retry.`;
  }
}

function renderDemoAirgappedWarning(session: WizardSession, isSignedIn: boolean): string {
  const backendList =
    (session.backends ?? []).map((b) => `\`${b}\``).join(' + ') || 'your chosen backend';

  // Pick the intro line by the recorded license-acquire reason when we
  // have one — that gives us "expired refresh", "refresh failed", etc.
  // distinct from the generic "you pasted your key" message. Falls back
  // to the boolean when the reason is absent (e.g. user pasted a JWT
  // they already had and marked it demo).
  const intro = introForReason(session.licenseReason, isSignedIn);

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

function introForReason(
  reason: WizardSession['licenseReason'],
  isSignedInFallback: boolean
): string {
  switch (reason) {
    case 'pasted-key-fallback':
      return `You're signed in via pasted API key, but the wizard fell back to an anonymous demo license — pasted-key sign-in doesn't give us the Auth0 access token needed to mint a user-scoped JWT.`;
    case 'not-signed-in':
      return `You're not signed in, so the wizard minted a 14-day anonymous demo JWT.`;
    case 'access-token-expired-no-refresh':
      return `Your Auth0 access token has expired and there's no refresh token on file to recover with, so the wizard fell back to an anonymous demo JWT.`;
    case 'refresh-failed':
      return `The wizard tried to refresh your Auth0 access token and the refresh call failed (network error, or Auth0 rejected the refresh token), so it fell back to an anonymous demo JWT.`;
    case 'user-license-fetch-failed':
      return `Auth0 sign-in succeeded, but the \`/api/v1/license\` call to mint a user-scoped JWT failed (typically a transient gateway error), so the wizard fell back to an anonymous demo JWT.`;
    case 'signed-in-user':
    case 'refreshed-then-user':
    case undefined:
      // Reason absent (or, defensively, a "user license minted" reason
      // that shouldn't appear in this branch). Use the boolean to pick
      // the previously-shipped phrasing.
      return isSignedInFallback
        ? `You're signed in, but the wizard fell back to an anonymous demo license — usually because the sign-in was done via pasted API key, which doesn't give us the Auth0 access token needed to mint a user-scoped JWT.`
        : `You're not signed in, so the wizard minted a 14-day anonymous demo JWT.`;
  }
}

// ── Plan rendering ──

interface RenderPlanResult {
  markdown: string;
  plan: AdvisePlan;
  action: AdviseAction;
}

async function renderInstallPlan(
  snapshot: DiscoverySnapshot,
  session: WizardSession,
  args: AdviseInstallArgs
): Promise<RenderPlanResult> {
  const action: AdviseAction = args.action ?? 'all';
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

  // Destination defaults to `mock` — the install wizard no longer asks
  // for a forwarder-event destination (the user's existing forwarder
  // still controls where events go; the overlay is additive with a
  // documented placeholder for them to wire their own destination).
  const destination: OutputDestination = 'mock';
  // session.app is constrained to 'reporter' | 'receiver' by the schema
  // — defaulting to 'reporter' below is just to satisfy the type-narrower
  // when session.app is undefined (unreachable after Q1 is answered).
  const app = session.app ?? 'reporter';

  const plan = await buildReporterPlan({
    snapshot,
    app,
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
  return { markdown: lines.join('\n'), plan, action };
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

