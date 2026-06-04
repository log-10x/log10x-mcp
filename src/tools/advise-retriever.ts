/**
 * log10x_advise_retriever — wizard front door (v2, wizard pattern).
 *
 * Progressive Q-and-A driver for a k8s install of the Log10x Retriever.
 * Mirrors the advise_install wizard pattern: each call merges the user's
 * latest answer into a RetrieverWizardSession (held alongside the discovery
 * snapshot) and either:
 *
 *   1. Asks the next missing question, or
 *   2. Once all answers are in, emits a concrete install plan.
 *
 * Six wizard steps (in dependency order):
 *
 *   Step 1 — Cluster prerequisites (EKS OIDC provider)
 *   Step 2 — AWS resource detection (S3 + SQS + IRSA from snapshot)
 *   Step 3 — infra_mode: 'terraform' | 'cli' | 'existing'
 *   Step 4 — S3 + SQS URLs (auto-filled from snapshot when present)
 *   Step 5 — IRSA role ARN (auto-filled from snapshot when present)
 *   Step 6 — License JWT (same path as advise_install)
 *
 * AUTO-SKIP LOGIC: when the snapshot already has all four SQS URLs, an IRSA
 * role, and the input bucket, the wizard skips straight to license
 * acquisition (happy path for returning users who ran Terraform first).
 *
 * LEGACY ONE-SHOT PRESERVED: when all infra args are supplied explicitly on
 * the first call (no wizard state), the tool still emits a plan immediately
 * (backward-compat with callers that supply everything at once).
 *
 * ARCHIVED ORIGINAL (109 lines, one-shot flat emitter):
 *   The original executeAdviseRetriever called buildRetrieverPlan() + buildAdvisePlanEnvelope()
 *   directly with no question loop. It is preserved in git history
 *   (commit before this file was replaced). The buildRetrieverPlan() and
 *   buildAdvisePlanEnvelope() call-sites below are unchanged — the wizard
 *   is a session-accumulation shell around the existing plan builder.
 */

import { z } from 'zod';
import {
  getSnapshot,
  getWizardSession,
  updateWizardSession,
} from '../lib/discovery/snapshot-store.js';
import { buildRetrieverPlan } from '../lib/advisor/retriever.js';
import { buildAdvisePlanEnvelope, buildPlanSummary } from '../lib/advisor/envelope.js';
import { acquireLicenseForWizard, LicenseFetchError } from '../lib/license-api.js';
import { buildEnvelope, type StructuredOutput, type ActionRole } from '../lib/output-types.js';
import type { WizardSession } from '../lib/discovery/types.js';
import type { AdvisePlanSummary } from '../lib/advisor/envelope.js';

// ── Schema ──────────────────────────────────────────────────────────────────

export const adviseRetrieverSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  // Wizard answer fields — supplied one-at-a-time on each re-invoke.
  infra_mode: z
    .enum(['terraform', 'cli', 'existing'])
    .optional()
    .describe(
      'How the customer provisions AWS infra. **terraform** = emit .tf module block. **cli** = emit aws-cli commands. **existing** = infra already provisioned, wizard skips infra steps and jumps to helm values. Auto-detected as "existing" when the snapshot already has all four SQS URLs + IRSA.'
    ),
  index_source_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket for source logs (module output: index_source_bucket_name). Auto-filled from snapshot.recommendations.retrieverS3Bucket when present.'
    ),
  index_bucket: z
    .string()
    .optional()
    .describe(
      'S3 path for indexed results (include prefix). Default: `<index_source_bucket>/indexing-results/`.'
    ),
  iam_role_arn: z
    .string()
    .optional()
    .describe('IAM role ARN for the Retriever ServiceAccount (IRSA) (module output: iam_role_arn). Auto-detected from snapshot.'),
  index_queue_url: z
    .string()
    .optional()
    .describe('SQS URL for index operations (module output: index_queue_url). Auto-detected from snapshot.'),
  query_queue_url: z
    .string()
    .optional()
    .describe('SQS URL for query operations (module output: query_queue_url). Auto-detected from snapshot.'),
  subquery_queue_url: z
    .string()
    .optional()
    .describe('SQS URL for sub-query operations (module output: subquery_queue_url). Auto-detected from snapshot.'),
  stream_queue_url: z
    .string()
    .optional()
    .describe('SQS URL for stream operations (module output: stream_queue_url). Auto-detected from snapshot.'),
  // License fields — same pattern as advise_install.
  license_source: z
    .enum(['signin', 'demo', 'paste'])
    .default('signin')
    .describe(
      'How the wizard acquires the engine license JWT. Defaults to `"signin"` — emits `signin_required` mode when no Auth0 session exists. Pass `"demo"` for a 14-day anonymous JWT. Pass `"paste"` with `license_jwt_paste` to supply an existing JWT.'
    ),
  license_jwt_paste: z
    .string()
    .optional()
    .describe('License JWT supplied by the user when `license_source: "paste"`.'),
  // Passthrough overrides (bypass wizard questions when known).
  release_name: z.string().optional().describe('Helm release name. Default: `my-retriever`.'),
  namespace: z
    .string()
    .optional()
    .describe('Target namespace. Default: snapshot.recommendations.suggestedNamespace.'),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Plan scope. Default: `all`.'),
  destination: z
    .string()
    .optional()
    .describe(
      'Destination SIEM for the kept slice (e.g. `datadog`, `cloudwatch`, `splunk`). Gates SIEM down-tier sub-sections in the offload markdown.'
    ),
};

const schemaObj = z.object(adviseRetrieverSchema);
export type AdviseRetrieverArgs = z.infer<typeof schemaObj>;

// ── Retriever wizard session ─────────────────────────────────────────────────

/**
 * Wizard session for the Retriever. Stored separately from the install
 * wizard's WizardSession (different field set), keyed by
 * `<snapshotId>.retriever-session.json` on disk.
 */
export interface RetrieverWizardSession {
  snapshotId: string;
  /** 'terraform' | 'cli' | 'existing'. Auto-set to 'existing' when all infra detected. */
  infraMode?: 'terraform' | 'cli' | 'existing';
  /** Resolved S3 input bucket. */
  inputBucket?: string;
  /** Resolved S3 index prefix. */
  indexBucket?: string;
  /** Resolved IRSA role ARN. */
  irsaRoleArn?: string;
  /** Resolved SQS URLs. */
  sqsIndexUrl?: string;
  sqsQueryUrl?: string;
  sqsSubqueryUrl?: string;
  sqsStreamUrl?: string;
  /** License fields — same as WizardSession. */
  licenseJwt?: string;
  isDemoLicense?: boolean;
  licenseSource?: 'signin' | 'demo' | 'paste';
  licenseReason?: WizardSession['licenseReason'];
  /** Release/namespace overrides. */
  releaseName?: string;
  namespace?: string;
  updatedAt: string;
}

// ── Persisted retriever session helpers ─────────────────────────────────────

import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const TTL_MS = 30 * 60 * 1000;

function diskDir(): string {
  const dir =
    process.env.LOG10X_ADVISOR_STATE_DIR ?? join(tmpdir(), 'log10x-advisor-snapshots');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function retrieverSessionPath(snapshotId: string): string {
  return join(diskDir(), `${snapshotId}.retriever-session.json`);
}

/** In-memory store for the current process (CLI shims get disk fallback). */
const retrieverSessionStore = new Map<string, RetrieverWizardSession>();

function getRetrieverSession(snapshotId: string): RetrieverWizardSession | undefined {
  const mem = retrieverSessionStore.get(snapshotId);
  if (mem) return mem;
  try {
    const p = retrieverSessionPath(snapshotId);
    const mtime = statSync(p).mtimeMs;
    if (Date.now() - mtime > TTL_MS) {
      try { unlinkSync(p); } catch { /* ignore */ }
      return undefined;
    }
    const raw = readFileSync(p, 'utf8');
    const s = JSON.parse(raw) as RetrieverWizardSession;
    retrieverSessionStore.set(snapshotId, s);
    return s;
  } catch {
    return undefined;
  }
}

function updateRetrieverSession(
  snapshotId: string,
  partial: Partial<Omit<RetrieverWizardSession, 'snapshotId' | 'updatedAt'>>
): RetrieverWizardSession {
  const existing = getRetrieverSession(snapshotId);
  const definedPartial: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) definedPartial[k] = v;
  }
  const merged: RetrieverWizardSession = {
    ...(existing ?? { snapshotId, updatedAt: new Date().toISOString() }),
    ...(definedPartial as Partial<RetrieverWizardSession>),
    snapshotId,
    updatedAt: new Date().toISOString(),
  };
  retrieverSessionStore.set(snapshotId, merged);
  try {
    writeFileSync(retrieverSessionPath(snapshotId), JSON.stringify(merged));
  } catch {
    // disk write failure is non-fatal
  }
  return merged;
}

// ── WizardData discriminated union ────────────────────────────────────────────

type RetrieverWizardData =
  | { mode: 'missing_snapshot'; ok: false; snapshot_id: string; markdown: string }
  | { mode: 'session_error'; ok: false; snapshot_id: string; markdown: string }
  | { mode: 'cancelled'; ok: false; snapshot_id: string; markdown: string }
  | {
      mode: 'next_question';
      ok: false;
      snapshot_id: string;
      question_id: RetrieverQuestionId;
      markdown: string;
      shape: RetrieverQuestionShape;
    }
  | { mode: 'license_error'; ok: false; snapshot_id: string; error_message: string; markdown: string }
  | { mode: 'signin_required'; ok: false; snapshot_id: string; markdown: string }
  | {
      mode: 'unknown_args';
      ok: false;
      snapshot_id?: string;
      unknown_keys: string[];
      suggestions: Array<{ unknown: string; did_you_mean: string | null }>;
      valid_keys: string[];
      markdown: string;
    }
  | ({ mode: 'plan'; markdown: string } & AdvisePlanSummary);

const TOOL_NAME = 'log10x_advise_retriever';

// ── Question catalog ─────────────────────────────────────────────────────────

type RetrieverQuestionId =
  | 'oidc-check'
  | 'infra-review'
  | 'infra-mode'
  | 'input-bucket'
  | 'sqs-urls'
  | 'irsa-role'
  | 'license-paste';

type RetrieverQuestionChoice = { value: string; label: string; recommended?: boolean; details?: string };

type RetrieverQuestionShape =
  | { type: 'single-choice'; answer_field: string; choices: RetrieverQuestionChoice[] }
  | { type: 'string'; answer_field: string; description: string; example?: string }
  | {
      type: 'form';
      description: string;
      fields: Array<{
        name: string;
        type: 'string';
        description: string;
        required: boolean;
        default?: string;
        example?: string;
      }>;
    }
  | { type: 'info'; headline: string; resolutions: Array<{ args: Record<string, unknown>; description: string }> };

type RetrieverNextStep =
  | { kind: 'ask'; markdown: string; questionId: RetrieverQuestionId; shape: RetrieverQuestionShape }
  | { kind: 'render' };

const QUESTION_META: Record<RetrieverQuestionId, { headline: string; answer_field: string }> = {
  'oidc-check': {
    headline: 'Step 1 — Verify EKS OIDC provider is enabled for your cluster.',
    answer_field: 'infra_mode',
  },
  'infra-review': {
    headline: 'Step 2 — Review detected AWS resources (S3 / SQS / IRSA) vs what needs creating.',
    answer_field: 'infra_mode',
  },
  'infra-mode': {
    headline: 'Step 3 — Pick how to provision the Retriever AWS infra: Terraform, aws-cli, or it already exists.',
    answer_field: 'infra_mode',
  },
  'input-bucket': {
    headline: 'Step 4a — Confirm the S3 source bucket for Retriever input.',
    answer_field: 'index_source_bucket',
  },
  'sqs-urls': {
    headline: 'Step 4b — Provide the four SQS queue URLs (index / query / subquery / stream).',
    answer_field: 'index_queue_url',
  },
  'irsa-role': {
    headline: 'Step 5 — Provide the IRSA role ARN for the Retriever ServiceAccount.',
    answer_field: 'iam_role_arn',
  },
  'license-paste': {
    headline: 'Step 6 — Paste the license JWT you already have.',
    answer_field: 'license_jwt_paste',
  },
};

// ── ARG synonym / unknown-arg detection ────────────────────────────────────────

const KNOWN_ARG_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(adviseRetrieverSchema),
  'api_key',
  'environment',
]);

const ARG_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['bucket', 'index_source_bucket'],
  ['source_bucket', 'index_source_bucket'],
  ['s3_bucket', 'index_source_bucket'],
  ['input_bucket', 'index_source_bucket'],
  ['role', 'iam_role_arn'],
  ['irsa_role_arn', 'iam_role_arn'],
  ['iam_role', 'iam_role_arn'],
  ['role_arn', 'iam_role_arn'],
  ['queues', 'index_queue_url'],
  ['sqs_urls', 'index_queue_url'],
  ['sqs_index_url', 'index_queue_url'],
  ['sqs_query_url', 'query_queue_url'],
  ['sqs_subquery_url', 'subquery_queue_url'],
  ['sqs_stream_url', 'stream_queue_url'],
  ['terraform', 'infra_mode'],
  ['provision_mode', 'infra_mode'],
  ['mode', 'infra_mode'],
  ['license', 'license_jwt_paste'],
  ['license_jwt', 'license_jwt_paste'],
  ['jwt', 'license_jwt_paste'],
  ['license_mode', 'license_source'],
  ['ns', 'namespace'],
  ['release', 'release_name'],
  ['name', 'release_name'],
  ['snapshot', 'snapshot_id'],
  ['snapshotId', 'snapshot_id'],
]);

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

function findClosestKnownArg(unknown: string): string | null {
  const synonym = ARG_SYNONYMS.get(unknown.toLowerCase());
  if (synonym) return synonym;
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

// ── wizardReturn ─────────────────────────────────────────────────────────────

function wizardReturn(data: RetrieverWizardData): StructuredOutput {
  const { headline, actions, warnings } = wizardEnvelopeMeta(data);
  const human_summary = buildRetrieverWizardHumanSummary(data, headline);
  return buildEnvelope({
    tool: TOOL_NAME,
    view: 'summary',
    summary: { headline },
    data: { ...data, human_summary },
    actions,
    warnings,
  });
}

function buildRetrieverWizardHumanSummary(data: RetrieverWizardData, headline: string): string {
  switch (data.mode) {
    case 'plan': {
      if (data.blockers.length > 0) {
        return `Retriever wizard produced a ${data.action} plan for release "${data.release_name}" in namespace "${data.namespace}". Blocked by ${data.blockers.length} item${data.blockers.length !== 1 ? 's' : ''}: ${data.blockers.slice(0, 3).join('; ')}. Resolve blockers and re-run.`;
      }
      return `Retriever wizard produced a ${data.action} plan for release "${data.release_name}" in namespace "${data.namespace}". ${data.install_step_count} install step${data.install_step_count !== 1 ? 's' : ''} across ${data.install_file_count} file${data.install_file_count !== 1 ? 's' : ''}, ${data.verify_probe_count} verify probe${data.verify_probe_count !== 1 ? 's' : ''}. Preflight: ${data.preflight_summary.ok} ok, ${data.preflight_summary.warn} warn, ${data.preflight_summary.fail} fail.`;
    }
    case 'next_question':
      return `Retriever wizard needs an answer to "${data.question_id}" before it can emit a plan. Re-invoke ${TOOL_NAME} with the answer in tool args and the same snapshot_id. Prior answers are remembered.`;
    case 'missing_snapshot':
      return `Retriever wizard refused: snapshot ${data.snapshot_id} is missing or expired (30-min TTL). Run log10x_discover_env again and pass the new snapshot_id.`;
    case 'session_error':
      return `Retriever wizard could not initialize the session for snapshot ${data.snapshot_id}. Re-run log10x_discover_env and retry.`;
    case 'cancelled':
      return `Retriever wizard was cancelled. Re-invoke with the same snapshot_id to resume — prior answers are remembered.`;
    case 'license_error':
      return `Retriever wizard could not acquire a license JWT: ${data.error_message.slice(0, 200)}. Sign in via log10x_signin_start, paste a JWT, or retry.`;
    case 'signin_required':
      return `Retriever wizard requires a signed-in Log10x license. Run the device flow via log10x_signin_start, then re-invoke with the same snapshot_id.`;
    case 'unknown_args': {
      const list = data.unknown_keys.slice(0, 3).join(', ');
      return `Retriever wizard received unknown arg${data.unknown_keys.length === 1 ? '' : 's'}: ${list}. Re-invoke with the canonical names (see data.valid_keys).`;
    }
    default:
      return headline;
  }
}

function wizardEnvelopeMeta(data: RetrieverWizardData): {
  headline: string;
  actions: Array<{ tool: string; args: Record<string, unknown>; reason: string; role: ActionRole }>;
  warnings: string[];
} {
  switch (data.mode) {
    case 'missing_snapshot':
      return {
        headline: `Snapshot \`${data.snapshot_id}\` expired or not found. Re-discover the cluster first.`,
        actions: [
          { tool: 'log10x_discover_env', args: {}, reason: 'mint a fresh snapshot; then re-invoke log10x_advise_retriever with the new snapshot_id', role: 'required-next' },
        ],
        warnings: [],
      };
    case 'session_error':
      return {
        headline: `Wizard session failed to initialize for snapshot \`${data.snapshot_id}\`. Re-discover and retry.`,
        actions: [
          { tool: 'log10x_discover_env', args: {}, reason: 'mint a fresh snapshot', role: 'required-next' },
        ],
        warnings: ['unexpected internal error — session-store state is unexpected'],
      };
    case 'cancelled':
      return {
        headline: `Retriever wizard cancelled. Re-invoke with snapshot_id="${data.snapshot_id}" to resume.`,
        actions: [
          { tool: TOOL_NAME, args: { snapshot_id: data.snapshot_id }, reason: 'resume the wizard — every prior answer is preserved for 30 min', role: 'recommended-next' },
        ],
        warnings: [],
      };
    case 'next_question': {
      const meta = QUESTION_META[data.question_id];
      return {
        headline: meta?.headline ?? `Retriever wizard next question (${data.question_id}).`,
        actions: [
          {
            tool: TOOL_NAME,
            args: meta
              ? { snapshot_id: data.snapshot_id, [meta.answer_field]: '<user answer>' }
              : { snapshot_id: data.snapshot_id },
            reason: meta
              ? `answer "${data.question_id}" by setting \`${meta.answer_field}\` and re-invoke`
              : `answer "${data.question_id}" and re-invoke the wizard`,
            role: 'required-next',
          },
        ],
        warnings: [],
      };
    }
    case 'license_error':
      return {
        headline: `License acquisition failed: ${data.error_message}. Sign in or paste an existing JWT to retry.`,
        actions: [
          { tool: 'log10x_signin_start', args: {}, reason: 'sign in via the browser device flow', role: 'alternative' },
          {
            tool: TOOL_NAME,
            args: { snapshot_id: data.snapshot_id, license_source: 'paste', license_jwt_paste: '<your JWT>' },
            reason: 'retry with a license JWT you already have',
            role: 'alternative',
          },
        ],
        warnings: [`license fetch failed: ${data.error_message}`],
      };
    case 'signin_required':
      return {
        headline: `Retriever wizard cannot mint a real license without sign-in. CHAIN: log10x_signin_start THEN re-invoke.`,
        actions: [
          { tool: 'log10x_signin_start', args: {}, reason: 'opens the device-code browser flow to sign in to Log10x', role: 'required-next' },
          { tool: TOOL_NAME, args: { snapshot_id: data.snapshot_id }, reason: 'after signin_start completes, re-invoke the wizard — every prior answer is preserved', role: 'required-next' },
        ],
        warnings: ['plan NOT emitted yet — complete log10x_signin_start before re-invoking'],
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
            : `Wizard rejected unknown arg${data.unknown_keys.length === 1 ? '' : 's'} (${data.unknown_keys.join(', ')}). Valid args: ${data.valid_keys.join(', ')}.`,
        actions: [],
        warnings: [`unknown_args rejected: ${data.unknown_keys.join(', ')}`],
      };
    }
    case 'plan': {
      const warnings: string[] = [];
      if (data.blockers.length > 0) {
        warnings.push(`plan has ${data.blockers.length} blocker${data.blockers.length !== 1 ? 's' : ''} — see data.blockers`);
      }
      const isDemoLicense = data.license_kind === 'demo';
      if (isDemoLicense) {
        warnings.push('plan emitted with a demo license — re-run with `license_source: "signin"` before the 14-day window expires');
      }
      const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string; role: ActionRole }> = [];
      actions.push({
        tool: 'log10x_doctor',
        args: {},
        reason: 'verify the install once the helm release rolls out',
        role: 'optional-followup',
      });
      actions.push({
        tool: 'log10x_top_patterns',
        args: {},
        reason: 'once events are flowing, see which patterns are offloaded to the Retriever bucket',
        role: 'optional-followup',
      });
      return {
        headline: planHeadlineForWizard(data),
        actions,
        warnings,
      };
    }
  }
}

function planHeadlineForWizard(data: {
  action: string;
  install_step_count: number;
  verify_probe_count: number;
  teardown_step_count: number;
  blockers: string[];
  release_name: string;
  namespace: string;
}): string {
  if (data.blockers.length > 0) {
    return `retriever ${data.action} plan: BLOCKED (${data.blockers.length} issue${data.blockers.length !== 1 ? 's' : ''}). Release "${data.release_name}" in "${data.namespace}".`;
  }
  return `retriever ${data.action} plan: ${data.install_step_count} install / ${data.verify_probe_count} verify / ${data.teardown_step_count} teardown — release "${data.release_name}" in namespace "${data.namespace}".`;
}

// ── nextQuestion routing ─────────────────────────────────────────────────────

import type { DiscoverySnapshot } from '../lib/discovery/types.js';
import { runJson } from '../lib/discovery/shell.js';

// ── Fix 80: detect IAM role from ~/.kube/config ──────────────────────────────

/**
 * Detect the IAM role ARN that kubectl uses to authenticate to the cluster.
 *
 * Runs `kubectl config view --minify -o json` and parses the active user's
 * exec block. If `--role <arn>` or `--role-arn=<arn>` appears in the args
 * array, that ARN is returned so it can be injected into the emitted
 * Terraform `exec` block.
 *
 * Returns `null` when:
 *   - kubectl is not available
 *   - the active user does not use exec authentication
 *   - no --role / --role-arn argument is present (standard IRSA w/o cross-account)
 */
async function detectKubectlRole(_clusterName: string): Promise<string | null> {
  type KubeConfigMinified = {
    users?: Array<{
      name?: string;
      user?: {
        exec?: {
          args?: string[];
        };
      };
    }>;
  };
  const { result, parsed } = await runJson<KubeConfigMinified>(
    'kubectl',
    ['config', 'view', '--minify', '-o', 'json'],
    { timeoutMs: 8_000 },
  );
  if (result.exitCode !== 0 || !parsed) return null;
  const users = parsed.users ?? [];
  for (const u of users) {
    const execArgs: string[] = u.user?.exec?.args ?? [];
    for (let i = 0; i < execArgs.length; i++) {
      const arg = execArgs[i];
      // Handle --role-arn=<value> single-token form.
      if (arg.startsWith('--role-arn=')) {
        const arn = arg.slice('--role-arn='.length);
        if (arn.startsWith('arn:')) return arn;
      }
      // Handle --role <value> two-token form (aws eks get-token style).
      if ((arg === '--role' || arg === '--role-arn') && i + 1 < execArgs.length) {
        const arn = execArgs[i + 1];
        if (arn.startsWith('arn:')) return arn;
      }
    }
  }
  return null;
}

/**
 * Pure routing function: (snapshot, session) → next question or 'render'.
 * Every mandatory field is checked in dependency order; the first gap halts.
 */
async function nextQuestion(
  snapshot: DiscoverySnapshot,
  session: RetrieverWizardSession
): Promise<RetrieverNextStep> {

  // Step 1 — OIDC provider check.
  // We surface this once (when infraMode is unknown and we haven't yet
  // reviewed infra). If infraMode is already set, the user acknowledged it.
  if (!session.infraMode) {
    const oidcEnabled = detectOidcEnabled(snapshot);
    if (!oidcEnabled) {
      const clusterName = snapshot.aws?.eks?.name ?? '<your-cluster>';
      return {
        kind: 'ask',
        markdown: renderOidcCheck(clusterName, snapshot.aws?.region),
        questionId: 'oidc-check',
        shape: {
          type: 'info',
          headline: 'EKS OIDC provider not detected — required for IRSA.',
          resolutions: [
            {
              args: { snapshot_id: session.snapshotId, infra_mode: 'terraform' },
              description: 'Use Terraform (the module enables OIDC automatically)',
            },
            {
              args: { snapshot_id: session.snapshotId, infra_mode: 'cli' },
              description: 'I\'ll enable it via aws CLI / eksctl (commands shown above)',
            },
            {
              args: { snapshot_id: session.snapshotId, infra_mode: 'existing' },
              description: 'OIDC is already enabled — I\'ll supply ARNs / URLs manually',
            },
          ],
        },
      };
    }

    // Step 2 — AWS resource review (show found vs needed table).
    // We show this once before asking infra_mode so the user knows what
    // already exists. Produce the review inline; answer_field is infra_mode.
    const allDetected = allInfraDetected(snapshot);
    return {
      kind: 'ask',
      markdown: renderInfraReview(snapshot, session),
      questionId: 'infra-review',
      shape: {
        type: 'single-choice',
        answer_field: 'infra_mode',
        choices: [
          {
            value: 'terraform',
            label: 'Terraform module (emit .tf block)',
            recommended: !allDetected,
            details: 'Generates the terraform-aws-tenx-retriever-lambda module block with pinned version.',
          },
          {
            value: 'cli',
            label: 'aws CLI commands',
            details: 'Emit aws-cli commands to create the IAM role, S3 buckets, and SQS queues.',
          },
          {
            value: 'existing',
            label: 'Already provisioned — I\'ll supply ARNs / URLs',
            recommended: allDetected,
            details: allDetected
              ? 'All infra detected in snapshot — this is the recommended path.'
              : 'Skip infra creation and jump to helm values (requires supplying all ARNs + URLs).',
          },
        ],
      },
    };
  }

  // Step 3 — For terraform / cli modes, emit infra instructions and ask
  // user to confirm by supplying the resolved ARNs/URLs.
  // We detect this state by: infraMode is 'terraform' or 'cli', but we
  // don't have the actual URLs yet. Treat this as a special 'info' step.
  if ((session.infraMode === 'terraform' || session.infraMode === 'cli') &&
      !allSessionInfraResolved(session)) {
    // Show the instructions markdown. The user performs the provisioning
    // out-of-band, then re-invokes supplying index_source_bucket + *_queue_url +
    // iam_role_arn. We surface that as the next question.
    const notYetSupplied = missingInfraFields(snapshot, session);
    if (notYetSupplied.length > 0) {
      return {
        kind: 'ask',
        markdown: await renderInfraInstructions(snapshot, session),
        questionId: notYetSupplied.includes('index_source_bucket') ? 'input-bucket' : 'sqs-urls',
        shape: buildInfraMissingShape(session, notYetSupplied),
      };
    }
  }

  // Step 4a — input bucket.
  const resolvedInputBucket = session.inputBucket ?? snapshot.recommendations.retrieverS3Bucket;
  if (!resolvedInputBucket) {
    return {
      kind: 'ask',
      markdown: renderInputBucketQuestion(snapshot),
      questionId: 'input-bucket',
      shape: {
        type: 'string',
        answer_field: 'index_source_bucket',
        description: 'The S3 bucket name where the forwarder offloads the dropped log slice. The Retriever reads source logs from here.',
        example: 'my-logs-bucket',
      },
    };
  }

  // Step 4b — SQS URLs.
  const detectedQueues = snapshot.recommendations.retrieverSqsUrls ?? {};
  const resolvedSqs = {
    index: session.sqsIndexUrl ?? detectedQueues.index,
    query: session.sqsQueryUrl ?? detectedQueues.query,
    subquery: session.sqsSubqueryUrl ?? detectedQueues.subquery,
    stream: session.sqsStreamUrl ?? detectedQueues.stream,
  };
  const missingSqs = (['index', 'query', 'subquery', 'stream'] as const).filter((k) => !resolvedSqs[k]);
  if (missingSqs.length > 0) {
    const formFields: RetrieverQuestionShape & { type: 'form' } = {
      type: 'form',
      description: `All four SQS queue URLs are required. Missing: ${missingSqs.join(', ')}. Provide the full SQS URL (https://sqs.<region>.amazonaws.com/<account>/<queue-name>).`,
      fields: [
        {
          name: 'index_queue_url',
          type: 'string',
          description: 'SQS URL for index operations (receives new S3 object notifications).',
          required: !resolvedSqs.index,
          default: resolvedSqs.index,
          example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-index',
        },
        {
          name: 'query_queue_url',
          type: 'string',
          description: 'SQS URL for query operations.',
          required: !resolvedSqs.query,
          default: resolvedSqs.query,
          example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-query',
        },
        {
          name: 'subquery_queue_url',
          type: 'string',
          description: 'SQS URL for sub-query fan-out operations.',
          required: !resolvedSqs.subquery,
          default: resolvedSqs.subquery,
          example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-subquery',
        },
        {
          name: 'stream_queue_url',
          type: 'string',
          description: 'SQS URL for stream operations.',
          required: !resolvedSqs.stream,
          default: resolvedSqs.stream,
          example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-stream',
        },
      ],
    };
    return {
      kind: 'ask',
      markdown: renderSqsQuestion(snapshot, resolvedSqs, missingSqs),
      questionId: 'sqs-urls',
      shape: formFields,
    };
  }

  // Step 5 — IRSA role ARN.
  const detectedIrsa = snapshot.kubectl.serviceAccountIrsa.find(
    (sa) =>
      sa.name.toLowerCase().includes('retriever') ||
      sa.name.toLowerCase().includes('tenx-retriever')
  )?.roleArn;
  const resolvedIrsa = session.irsaRoleArn ?? detectedIrsa;
  if (!resolvedIrsa) {
    return {
      kind: 'ask',
      markdown: renderIrsaQuestion(snapshot, session),
      questionId: 'irsa-role',
      shape: {
        type: 'string',
        answer_field: 'iam_role_arn',
        description: 'The IAM role ARN the Retriever ServiceAccount will assume (OIDC IRSA binding). Must have s3:GetObject on the input bucket, s3:PutObject on the index prefix, and sqs:* on all four queues.',
        example: 'arn:aws:iam::123456789012:role/tenx-retriever-role',
      },
    };
  }

  // Step 6 — license paste path.
  if (session.licenseSource === 'paste' && !session.licenseJwt) {
    return {
      kind: 'ask',
      markdown: [
        '# Retriever wizard — paste your license JWT',
        '',
        'Pass `license_jwt_paste: "<jwt>"` on the next invocation. The JWT is mounted in the Retriever pods via a Kubernetes Secret — it never enters `values.yaml` in plain text.',
      ].join('\n'),
      questionId: 'license-paste',
      shape: {
        type: 'string',
        answer_field: 'license_jwt_paste',
        description: 'The Log10x license JWT string.',
        example: 'eyJhbGciOiJFUzI1NiIs...',
      },
    };
  }

  return { kind: 'render' };
}

// ── Infra detection helpers ──────────────────────────────────────────────────

function detectOidcEnabled(snapshot: DiscoverySnapshot): boolean {
  // Heuristic: if the snapshot has any serviceAccountIrsa entries,
  // OIDC must be enabled (IRSA annotations only work with OIDC).
  if (snapshot.kubectl.serviceAccountIrsa.length > 0) return true;
  // If AWS isn't available we can't be sure — assume it may be enabled
  // to avoid blocking the wizard when AWS detection fails.
  if (!snapshot.aws.available) return true;
  // No IRSA entries + AWS available = OIDC probably not set up yet.
  return false;
}

function allInfraDetected(snapshot: DiscoverySnapshot): boolean {
  const q = snapshot.recommendations.retrieverSqsUrls ?? {};
  return !!(
    snapshot.recommendations.retrieverS3Bucket &&
    q.index && q.query && q.subquery && q.stream &&
    snapshot.kubectl.serviceAccountIrsa.some(
      (sa) =>
        sa.name.toLowerCase().includes('retriever') ||
        sa.name.toLowerCase().includes('tenx-retriever')
    )
  );
}

function allSessionInfraResolved(session: RetrieverWizardSession): boolean {
  return !!(
    session.inputBucket &&
    session.sqsIndexUrl && session.sqsQueryUrl &&
    session.sqsSubqueryUrl && session.sqsStreamUrl &&
    session.irsaRoleArn
  );
}

function missingInfraFields(
  snapshot: DiscoverySnapshot,
  session: RetrieverWizardSession
): string[] {
  const q = snapshot.recommendations.retrieverSqsUrls ?? {};
  const missing: string[] = [];
  if (!session.inputBucket && !snapshot.recommendations.retrieverS3Bucket) missing.push('index_source_bucket');
  if (!session.sqsIndexUrl && !q.index) missing.push('index_queue_url');
  if (!session.sqsQueryUrl && !q.query) missing.push('query_queue_url');
  if (!session.sqsSubqueryUrl && !q.subquery) missing.push('subquery_queue_url');
  if (!session.sqsStreamUrl && !q.stream) missing.push('stream_queue_url');
  if (!session.irsaRoleArn && !snapshot.kubectl.serviceAccountIrsa.some(
    (sa) => sa.name.toLowerCase().includes('retriever') || sa.name.toLowerCase().includes('tenx-retriever')
  )) missing.push('iam_role_arn');
  return missing;
}

function buildInfraMissingShape(
  session: RetrieverWizardSession,
  missingFields: string[]
): RetrieverQuestionShape {
  const fields: Array<{
    name: string;
    type: 'string';
    description: string;
    required: boolean;
    example?: string;
  }> = [];
  for (const f of missingFields) {
    switch (f) {
      case 'index_source_bucket':
        fields.push({ name: 'index_source_bucket', type: 'string', description: 'S3 bucket name for source logs (module output: index_source_bucket_name).', required: true, example: 'tenx-retriever-input-123456789012' });
        break;
      case 'index_queue_url':
        fields.push({ name: 'index_queue_url', type: 'string', description: 'SQS URL for index queue (module output: index_queue_url).', required: true, example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-index' });
        break;
      case 'query_queue_url':
        fields.push({ name: 'query_queue_url', type: 'string', description: 'SQS URL for query queue (module output: query_queue_url).', required: true, example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-query' });
        break;
      case 'subquery_queue_url':
        fields.push({ name: 'subquery_queue_url', type: 'string', description: 'SQS URL for subquery queue (module output: subquery_queue_url).', required: true, example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-subquery' });
        break;
      case 'stream_queue_url':
        fields.push({ name: 'stream_queue_url', type: 'string', description: 'SQS URL for stream queue (module output: stream_queue_url).', required: true, example: 'https://sqs.us-east-1.amazonaws.com/123456789012/tenx-retriever-stream' });
        break;
      case 'iam_role_arn':
        fields.push({ name: 'iam_role_arn', type: 'string', description: 'IAM role ARN for the Retriever ServiceAccount (module output: iam_role_arn).', required: true, example: 'arn:aws:iam::123456789012:role/tenx-retriever-role' });
        break;
    }
  }
  return {
    type: 'form',
    description: `Provision the Retriever infra, then supply the ARNs/URLs to continue. Missing: ${missingFields.join(', ')}.`,
    fields,
  };
}

// ── Question renderers ────────────────────────────────────────────────────────

function renderOidcCheck(clusterName: string, region?: string): string {
  const regionStr = region ? ` --region ${region}` : '';
  return [
    '# Retriever wizard — Step 1: EKS OIDC provider',
    '',
    `The OIDC provider is required for IRSA (IAM Roles for Service Accounts). It enables the Retriever pod to assume an IAM role without static credentials.`,
    '',
    '## Verify',
    '```bash',
    `aws eks describe-cluster --name ${clusterName}${regionStr} --query "cluster.identity.oidc.issuer" --output text`,
    '```',
    '',
    '## Enable (if not present)',
    '',
    '**Option A — eksctl (recommended):**',
    '```bash',
    `eksctl utils associate-iam-oidc-provider --cluster ${clusterName}${regionStr} --approve`,
    '```',
    '',
    '**Option B — aws CLI:**',
    '```bash',
    `# Get the OIDC issuer URL`,
    `OIDC_URL=$(aws eks describe-cluster --name ${clusterName}${regionStr} --query "cluster.identity.oidc.issuer" --output text)`,
    `# Create the provider`,
    `aws iam create-open-id-connect-provider \\`,
    `  --url $OIDC_URL \\`,
    `  --client-id-list sts.amazonaws.com \\`,
    `  --thumbprint-list $(openssl s_client -connect ${clusterName}.gr7.${region ?? 'us-east-1'}.eks.amazonaws.com:443 2>/dev/null | openssl x509 -fingerprint -noout | sed 's/://g' | awk -F= '{print tolower($2)}')`,
    '```',
    '',
    'Re-invoke with `infra_mode: "terraform"`, `"cli"`, or `"existing"` to continue.',
  ].join('\n');
}

function renderInfraReview(
  snapshot: DiscoverySnapshot,
  session: RetrieverWizardSession
): string {
  const q = snapshot.recommendations.retrieverSqsUrls ?? {};
  const detectedIrsa = snapshot.kubectl.serviceAccountIrsa.find(
    (sa) =>
      sa.name.toLowerCase().includes('retriever') ||
      sa.name.toLowerCase().includes('tenx-retriever')
  );

  const rows: string[] = [];
  rows.push('| Resource | Status | Detected value |');
  rows.push('|---|---|---|');
  rows.push(`| S3 input bucket | ${snapshot.recommendations.retrieverS3Bucket ? '✓ found' : '✗ missing'} | ${snapshot.recommendations.retrieverS3Bucket ?? '—'} |`);
  rows.push(`| SQS index queue | ${q.index ? '✓ found' : '✗ missing'} | ${q.index ?? '—'} |`);
  rows.push(`| SQS query queue | ${q.query ? '✓ found' : '✗ missing'} | ${q.query ?? '—'} |`);
  rows.push(`| SQS subquery queue | ${q.subquery ? '✓ found' : '✗ missing'} | ${q.subquery ?? '—'} |`);
  rows.push(`| SQS stream queue | ${q.stream ? '✓ found' : '✗ missing'} | ${q.stream ?? '—'} |`);
  rows.push(`| IRSA role | ${detectedIrsa ? '✓ found' : '✗ missing'} | ${detectedIrsa?.roleArn ?? '—'} |`);

  const allFound = allInfraDetected(snapshot);
  return [
    '# Retriever wizard — Step 2: AWS resource review',
    '',
    '## Detected resources',
    '',
    ...rows,
    '',
    allFound
      ? '**All infra detected.** The recommended path is `existing` — the wizard will skip provisioning and jump directly to Helm values.'
      : '**Some resources are missing.** Choose how to provision them.',
    '',
    '## How to provision',
    '',
    'Re-invoke with `infra_mode: "terraform"`, `"cli"`, or `"existing"`:',
    '- **`terraform`** — wizard emits a `log-10x/tenx-retriever/aws` module block with pinned version.',
    '- **`cli`** — wizard emits `aws iam`, `aws s3api`, `aws sqs` commands.',
    '- **`existing`** — all infra already exists; wizard jumps to helm values (supply ARNs/URLs in next step).',
  ].join('\n');
}

async function renderInfraInstructions(
  snapshot: DiscoverySnapshot,
  session: RetrieverWizardSession
): Promise<string> {
  const region = snapshot.aws?.region ?? 'us-east-1';
  const detectedAccount = snapshot.aws?.callerIdentity?.account;
  const account = detectedAccount ?? '<ACCOUNT_ID>';
  const accountAutoDetected = !!detectedAccount;
  const clusterName = snapshot.aws?.eks?.name ?? '<your-cluster>';
  // Use the OIDC issuer extracted from describe-cluster (no https:// prefix).
  // Falls back to the placeholder pattern if discovery didn't capture it yet.
  const oidcProvider = snapshot.aws?.eks?.oidcIssuer
    ?? `oidc.eks.${region}.amazonaws.com/id/<OIDC_ID>`;

  if (session.infraMode === 'terraform') {
    // Fix 80: detect cross-account role from active kubeconfig exec block.
    const detectedRole = await detectKubectlRole(clusterName);
    return renderTerraformInstructions(clusterName, region, account, oidcProvider, accountAutoDetected, detectedRole);
  }
  return renderCliInstructions(clusterName, region, account, oidcProvider);
}

function renderTerraformInstructions(
  clusterName: string,
  region: string,
  account: string,
  oidcProvider: string,
  accountAutoDetected: boolean = false,
  detectedRole: string | null = null
): string {
  const envId = account === '<ACCOUNT_ID>' ? 'xxxxxx' : account.slice(-6);
  // Compute the full OIDC provider ARN required by oidc_provider_arn.
  // Format: arn:aws:iam::<ACCOUNT_ID>:oidc-provider/<oidcProvider>
  const oidcProviderArn = `arn:aws:iam::${account}:oidc-provider/${oidcProvider}`;

  const accountWarning = !accountAutoDetected
    ? [
        '',
        '> **Note:** The AWS account ID could not be auto-detected (sts:GetCallerIdentity failed during discovery).',
        '> Replace `<ACCOUNT_ID>` in `oidc_provider_arn` with your 12-digit AWS account ID before running `terraform init`.',
        '> You can get it by running: `aws sts get-caller-identity --query Account --output text`',
      ]
    : [];

  // Fix 80: build eks_exec_args with optional --role for cross-account clusters.
  const eksExecArgsBase = [
    `    "--region", "${region}",`,
    `    "eks", "get-token",`,
    `    "--cluster-name", "${clusterName}",`,
  ];
  const roleArgLines = detectedRole
    ? [`    "--role", "${detectedRole}",`]
    : [];
  const eksExecArgLines = [...eksExecArgsBase, ...roleArgLines];
  const roleNote = detectedRole
    ? [``, `> **Note:** Cross-account role \`${detectedRole}\` detected from \`~/.kube/config\` exec block and injected into the \`eks_exec_args\` local.`]
    : [];

  // Fix 79: emit kubernetes + helm provider blocks so the TF module can create
  // the Kubernetes namespace, ServiceAccount, and Helm release without the
  // "dial tcp [::1]:80: connect: connection refused" error on `terraform apply`.
  const k8sProviderBlock = [
    `data "aws_eks_cluster" "log10x_cluster" {`,
    `  name = "${clusterName}"`,
    `}`,
    ``,
    `locals {`,
    `  eks_exec_args = [`,
    ...eksExecArgLines,
    `  ]`,
    `}`,
    ``,
    `provider "kubernetes" {`,
    `  host                   = data.aws_eks_cluster.log10x_cluster.endpoint`,
    `  cluster_ca_certificate = base64decode(data.aws_eks_cluster.log10x_cluster.certificate_authority[0].data)`,
    `  exec {`,
    `    api_version = "client.authentication.k8s.io/v1beta1"`,
    `    command     = "aws"`,
    `    args        = local.eks_exec_args`,
    `  }`,
    `}`,
    ``,
    `provider "helm" {`,
    `  kubernetes = {`,
    `    host                   = data.aws_eks_cluster.log10x_cluster.endpoint`,
    `    cluster_ca_certificate = base64decode(data.aws_eks_cluster.log10x_cluster.certificate_authority[0].data)`,
    `    exec = {`,
    `      api_version = "client.authentication.k8s.io/v1beta1"`,
    `      command     = "aws"`,
    `      args        = local.eks_exec_args`,
    `    }`,
    `  }`,
    `}`,
  ];

  return [
    '# Retriever wizard — Step 3: Terraform provisioning',
    '',
    'Add the following to your Terraform workspace. The module creates the S3 bucket, four SQS queues, IAM role with IRSA binding, and CloudWatch log groups.',
    ...accountWarning,
    ...roleNote,
    '',
    '```hcl',
    `terraform {`,
    `  required_version = ">= 1.5.0"`,
    `  required_providers {`,
    `    aws        = { source = "hashicorp/aws",       version = ">= 6.3.0" }`,
    `    kubernetes = { source = "hashicorp/kubernetes", version = ">= 2.23.0" }`,
    `    helm       = { source = "hashicorp/helm",      version = ">= 2.12.0" }`,
    `  }`,
    `}`,
    ``,
    `provider "aws" { region = "${region}" }`,
    ``,
    ...k8sProviderBlock,
    ``,
    `variable "tenx_api_key" {`,
    `  type        = string`,
    `  description = "Log10x engine API key."`,
    `  sensitive   = true`,
    `}`,
    ``,
    `module "tenx_retriever_aws" {`,
    `  source  = "log-10x/tenx-retriever/aws"`,
    `  version = "~> 1.0"`,
    ``,
    `  oidc_provider     = "${oidcProvider}"`,
    `  oidc_provider_arn = "${oidcProviderArn}"`,
    `  tenx_api_key      = var.tenx_api_key`,
    `  namespace         = "log10x"`,
    `  create_namespace  = true`,
    `  create_s3_buckets = true`,
    ``,
    `  iam_role_name                              = "tenx-retriever-role"`,
    `  helm_release_name                          = "my-retriever"`,
    `  tenx_retriever_index_queue_name            = "tenx-retriever-index-${envId}"`,
    `  tenx_retriever_query_queue_name            = "tenx-retriever-query-${envId}"`,
    `  tenx_retriever_subquery_queue_name         = "tenx-retriever-subquery-${envId}"`,
    `  tenx_retriever_stream_queue_name           = "tenx-retriever-stream-${envId}"`,
    `  tenx_retriever_index_results_bucket_name   = "tenx-retriever-input-${account}"`,
    `}`,
    ``,
    `output "retriever_index_queue_url"     { value = module.tenx_retriever_aws.index_queue_url }`,
    `output "retriever_query_queue_url"     { value = module.tenx_retriever_aws.query_queue_url }`,
    `output "retriever_subquery_queue_url"  { value = module.tenx_retriever_aws.subquery_queue_url }`,
    `output "retriever_stream_queue_url"    { value = module.tenx_retriever_aws.stream_queue_url }`,
    `output "retriever_iam_role_arn"        { value = module.tenx_retriever_aws.iam_role_arn }`,
    `output "retriever_index_source_bucket" { value = module.tenx_retriever_aws.index_source_bucket_name }`,
    `output "retriever_helm_release_status" { value = module.tenx_retriever_aws.helm_release_status }`,
    '```',
    '',
    '```bash',
    '# Set your Log10x API key (do not inline in HCL — use -var or a .tfvars file):',
    'export TENX_API_KEY="<your-log10x-api-key>"',
    '',
    'terraform init',
    'terraform apply -var="tenx_api_key=$TENX_API_KEY"',
    '',
    '# Capture outputs:',
    'terraform output -json | jq .',
    '```',
    '',
    'Once applied, re-invoke `log10x_advise_retriever` with the output values:',
    '```',
    `log10x_advise_retriever({`,
    `  snapshot_id:         "<id>",`,
    `  index_source_bucket: "<terraform output: retriever_index_source_bucket>",`,
    `  iam_role_arn:        "<terraform output: retriever_iam_role_arn>",`,
    `  index_queue_url:     "<terraform output: retriever_index_queue_url>",`,
    `  query_queue_url:     "<terraform output: retriever_query_queue_url>",`,
    `  subquery_queue_url:  "<terraform output: retriever_subquery_queue_url>",`,
    `  stream_queue_url:    "<terraform output: retriever_stream_queue_url>"`,
    `})`,
    '```',
  ].join('\n');
}

function renderCliInstructions(
  clusterName: string,
  region: string,
  account: string,
  oidcIssuer: string
): string {
  const bucketName = `tenx-logs-${account}`;
  const roleName = 'tenx-retriever-role';
  const sqsPrefix = 'tenx';

  return [
    '# Retriever wizard — Step 3: aws CLI provisioning',
    '',
    '## 1. Create S3 bucket',
    '```bash',
    `aws s3api create-bucket --bucket ${bucketName} --region ${region} \\`,
    `  ${region === 'us-east-1' ? '' : `--create-bucket-configuration LocationConstraint=${region}`}`,
    `# Enable versioning (recommended for index integrity):`,
    `aws s3api put-bucket-versioning --bucket ${bucketName} \\`,
    `  --versioning-configuration Status=Enabled`,
    '```',
    '',
    '## 2. Create four SQS queues',
    '```bash',
    `for QUEUE in index query subquery stream; do`,
    `  aws sqs create-queue --queue-name ${sqsPrefix}-$QUEUE --region ${region}`,
    `done`,
    `# Capture URLs:`,
    `INDEX_URL=$(aws sqs get-queue-url --queue-name ${sqsPrefix}-index --region ${region} --query QueueUrl --output text)`,
    `QUERY_URL=$(aws sqs get-queue-url --queue-name ${sqsPrefix}-query --region ${region} --query QueueUrl --output text)`,
    `SUBQUERY_URL=$(aws sqs get-queue-url --queue-name ${sqsPrefix}-subquery --region ${region} --query QueueUrl --output text)`,
    `STREAM_URL=$(aws sqs get-queue-url --queue-name ${sqsPrefix}-stream --region ${region} --query QueueUrl --output text)`,
    '```',
    '',
    '## 3. Create IRSA IAM role',
    '```bash',
    `# Get the OIDC issuer for the cluster:`,
    `OIDC_URL=$(aws eks describe-cluster --name ${clusterName} --region ${region} \\`,
    `  --query "cluster.identity.oidc.issuer" --output text | sed 's|https://||')`,
    ``,
    `# Create trust policy:`,
    `cat > /tmp/retriever-trust-policy.json << EOF`,
    `{`,
    `  "Version": "2012-10-17",`,
    `  "Statement": [{`,
    `    "Effect": "Allow",`,
    `    "Principal": { "Federated": "arn:aws:iam::${account}:oidc-provider/$OIDC_URL" },`,
    `    "Action": "sts:AssumeRoleWithWebIdentity",`,
    `    "Condition": {`,
    `      "StringEquals": {`,
    `        "$OIDC_URL:sub": "system:serviceaccount:logging:tenx-retriever",`,
    `        "$OIDC_URL:aud": "sts.amazonaws.com"`,
    `      }`,
    `    }`,
    `  }]`,
    `}`,
    `EOF`,
    `aws iam create-role --role-name ${roleName} \\`,
    `  --assume-role-policy-document file:///tmp/retriever-trust-policy.json`,
    ``,
    `# Attach S3 + SQS permissions:`,
    `aws iam put-role-policy --role-name ${roleName} \\`,
    `  --policy-name tenx-retriever-policy \\`,
    `  --policy-document '{`,
    `    "Version":"2012-10-17",`,
    `    "Statement":[`,
    `      {"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],"Resource":["arn:aws:s3:::${bucketName}","arn:aws:s3:::${bucketName}/*"]},`,
    `      {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:ListBucket"],"Resource":["arn:aws:s3:::${bucketName}/indexing-results/*"]},`,
    `      {"Effect":"Allow","Action":["sqs:SendMessage","sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":"arn:aws:sqs:${region}:${account}:${sqsPrefix}-*"}`,
    `    ]`,
    `  }'`,
    ``,
    `ROLE_ARN=$(aws iam get-role --role-name ${roleName} --query Role.Arn --output text)`,
    '```',
    '',
    '## 4. Verify STS AssumeRole (optional)',
    '```bash',
    `kubectl run --rm -it aws-sts-test --image=amazon/aws-cli --restart=Never \\`,
    `  --serviceaccount=tenx-retriever --namespace=logging \\`,
    `  -- sts get-caller-identity`,
    '# Expected: RoleId contains tenx-retriever-role',
    '```',
    '',
    'Once provisioned, re-invoke `log10x_advise_retriever` with the captured values.',
  ].join('\n');
}

function renderInputBucketQuestion(snapshot: DiscoverySnapshot): string {
  const suggestions = snapshot.aws.s3Buckets
    .filter((b) => b.matchReason !== 'listed')
    .slice(0, 3)
    .map((b) => `- \`${b.name}\` (${b.matchReason})`);
  const lines = [
    '# Retriever wizard — Step 4a: S3 input bucket',
    '',
    'The Retriever reads source logs from an S3 bucket. This is the same bucket where your forwarder offloads the `isDropped` slice.',
  ];
  if (suggestions.length > 0) {
    lines.push('', 'Possible buckets detected in the account:', ...suggestions);
  }
  lines.push('', 'Re-invoke with `index_source_bucket: "<bucket-name>"` to continue.');
  return lines.join('\n');
}

function renderSqsQuestion(
  snapshot: DiscoverySnapshot,
  resolved: Record<string, string | undefined>,
  missing: readonly string[]
): string {
  const lines = [
    '# Retriever wizard — Step 4b: SQS queue URLs',
    '',
    `The Retriever uses four SQS queues. Missing: **${missing.join(', ')}**.`,
    '',
    '| Queue | Status | URL |',
    '|---|---|---|',
    `| index | ${resolved.index ? '✓' : '✗'} | ${resolved.index ?? '—'} |`,
    `| query | ${resolved.query ? '✓' : '✗'} | ${resolved.query ?? '—'} |`,
    `| subquery | ${resolved.subquery ? '✓' : '✗'} | ${resolved.subquery ?? '—'} |`,
    `| stream | ${resolved.stream ? '✓' : '✗'} | ${resolved.stream ?? '—'} |`,
    '',
  ];
  const suggestedQueues = snapshot.aws.sqsQueues.filter((q) => q.role !== 'unknown' && q.role !== 'dlq');
  if (suggestedQueues.length > 0) {
    lines.push('SQS queues detected that might be Retriever queues:');
    for (const q of suggestedQueues.slice(0, 8)) {
      lines.push(`- **${q.role}**: \`${q.url}\``);
    }
    lines.push('');
  }
  lines.push('Re-invoke with `index_queue_url`, `query_queue_url`, `subquery_queue_url`, `stream_queue_url` to continue.');
  return lines.join('\n');
}

function renderIrsaQuestion(
  snapshot: DiscoverySnapshot,
  session: RetrieverWizardSession
): string {
  const clusterName = snapshot.aws?.eks?.name ?? '<your-cluster>';
  const region = snapshot.aws?.region ?? 'us-east-1';
  const inputBucket = session.inputBucket ?? snapshot.recommendations.retrieverS3Bucket ?? '<input-bucket>';

  const allIrsa = snapshot.kubectl.serviceAccountIrsa;
  const lines = [
    '# Retriever wizard — Step 5: IRSA role ARN',
    '',
    'The Retriever ServiceAccount needs an IAM role with:',
    `- \`s3:GetObject\`, \`s3:ListBucket\` on \`${inputBucket}\``,
    `- \`s3:PutObject\` on \`${inputBucket}/indexing-results/*\``,
    `- \`sqs:SendMessage\`, \`sqs:ReceiveMessage\`, \`sqs:DeleteMessage\`, \`sqs:GetQueueAttributes\` on all four queues`,
  ];
  if (allIrsa.length > 0) {
    lines.push('', 'ServiceAccount IRSA annotations detected in the cluster:');
    for (const sa of allIrsa.slice(0, 5)) {
      lines.push(`- \`${sa.namespace}/${sa.name}\` → \`${sa.roleArn}\``);
    }
  }
  lines.push('', 'Re-invoke with `iam_role_arn: "arn:aws:iam::<account>:role/<name>"` to continue.');
  return lines.join('\n');
}

// ── Main executor ────────────────────────────────────────────────────────────

export async function executeAdviseRetriever(args: AdviseRetrieverArgs): Promise<StructuredOutput> {
  // Unknown-arg guard.
  const rawKeys = Object.keys(args as Record<string, unknown>);
  const unknownKeys = rawKeys.filter((k) => !KNOWN_ARG_NAMES.has(k));
  if (unknownKeys.length > 0) {
    const suggestions = unknownKeys.map((k) => ({
      unknown: k,
      did_you_mean: findClosestKnownArg(k),
    }));
    const validKeys = [...KNOWN_ARG_NAMES].sort();
    const lines: string[] = [`# Retriever wizard — unknown arg${unknownKeys.length === 1 ? '' : 's'}`, ''];
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
    lines.push(`Re-invoke \`${TOOL_NAME}\` with the canonical names.`);
    return wizardReturn({
      mode: 'unknown_args',
      ok: false,
      snapshot_id: typeof args.snapshot_id === 'string' ? args.snapshot_id : undefined,
      unknown_keys: unknownKeys,
      suggestions,
      valid_keys: validKeys,
      markdown: lines.join('\n'),
    });
  }

  // Snapshot check.
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    const md = [
      `# Retriever wizard — snapshot not found`,
      '',
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      '',
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
    return wizardReturn({ mode: 'missing_snapshot', ok: false, snapshot_id: args.snapshot_id, markdown: md });
  }

  // Merge answers into the Retriever wizard session.
  const session = updateRetrieverSession(args.snapshot_id, {
    infraMode: args.infra_mode,
    inputBucket: args.index_source_bucket,
    indexBucket: args.index_bucket,
    irsaRoleArn: args.iam_role_arn,
    sqsIndexUrl: args.index_queue_url,
    sqsQueryUrl: args.query_queue_url,
    sqsSubqueryUrl: args.subquery_queue_url,
    sqsStreamUrl: args.stream_queue_url,
    licenseSource: args.license_source,
    licenseJwt: args.license_jwt_paste,
    releaseName: args.release_name,
    namespace: args.namespace,
  });

  // Auto-detect 'existing' when all infra is in the snapshot and none
  // was explicitly overridden. This is the happy path for returning users.
  if (!session.infraMode && allInfraDetected(snapshot)) {
    session.infraMode = 'existing';
    updateRetrieverSession(args.snapshot_id, { infraMode: 'existing' });
  }

  // Question routing.
  const next = await nextQuestion(snapshot, session);
  if (next.kind === 'ask') {
    return wizardReturn({
      mode: 'next_question',
      ok: false,
      snapshot_id: args.snapshot_id,
      question_id: next.questionId,
      markdown: next.markdown,
      shape: next.shape,
    });
  }

  // All questions answered — license acquisition.
  if (!session.licenseJwt && session.licenseSource !== 'paste') {
    try {
      const lic = await acquireLicenseForWizard();
      const isRealUserLicense =
        lic.reason === 'signed-in-user' || lic.reason === 'refreshed-then-user';
      if (session.licenseSource === 'signin' && !isRealUserLicense) {
        const md = [
          '# Retriever wizard — sign in to Log10x first',
          '',
          signinRequiredReasonMessage(lic.reason),
          '',
          `Once signed in, re-invoke \`${TOOL_NAME}\` with the same \`snapshot_id\`. Every answer you gave is remembered.`,
        ].join('\n');
        updateRetrieverSession(args.snapshot_id, { licenseReason: lic.reason });
        return wizardReturn({ mode: 'signin_required', ok: false, snapshot_id: args.snapshot_id, markdown: md });
      }
      updateRetrieverSession(args.snapshot_id, {
        licenseJwt: lic.jwt,
        isDemoLicense: lic.isDemoLicense,
        licenseReason: lic.reason,
      });
      session.licenseJwt = lic.jwt;
      session.isDemoLicense = lic.isDemoLicense;
    } catch (e) {
      const msg = e instanceof LicenseFetchError ? e.message : String(e);
      const md = [
        `# Retriever wizard — couldn't acquire a license JWT`,
        '',
        `The wizard tried to mint a license via the gateway and failed:`,
        '',
        `> ${msg}`,
        '',
        `Options:`,
        `- Sign in via \`log10x_signin_start\``,
        `- Re-invoke with \`license_source: "paste"\` and \`license_jwt_paste: "<your-jwt>"\``,
        `- Retry — the gateway may have been transiently unavailable`,
      ].join('\n');
      return wizardReturn({ mode: 'license_error', ok: false, snapshot_id: args.snapshot_id, error_message: msg, markdown: md });
    }
  }

  // Resolve final infra values from session + snapshot fallbacks.
  const detectedQueues = snapshot.recommendations.retrieverSqsUrls ?? {};
  const resolvedInputBucket = session.inputBucket ?? snapshot.recommendations.retrieverS3Bucket;
  const resolvedIrsaRoleArn =
    session.irsaRoleArn ??
    snapshot.kubectl.serviceAccountIrsa.find(
      (sa) =>
        sa.name.toLowerCase().includes('retriever') ||
        sa.name.toLowerCase().includes('tenx-retriever')
    )?.roleArn;
  const resolvedSqsUrls = {
    index: session.sqsIndexUrl ?? detectedQueues.index,
    query: session.sqsQueryUrl ?? detectedQueues.query,
    subquery: session.sqsSubqueryUrl ?? detectedQueues.subquery,
    stream: session.sqsStreamUrl ?? detectedQueues.stream,
  };

  const action = args.action ?? 'all';
  const plan = await buildRetrieverPlan({
    snapshot,
    releaseName: session.releaseName ?? args.release_name,
    namespace: session.namespace ?? args.namespace,
    licenseJwt: session.licenseJwt,
    inputBucket: resolvedInputBucket,
    indexBucket: session.indexBucket ?? args.index_bucket,
    irsaRoleArn: resolvedIrsaRoleArn,
    sqsUrls: {
      index: resolvedSqsUrls.index,
      query: resolvedSqsUrls.query,
      subquery: resolvedSqsUrls.subquery,
      stream: resolvedSqsUrls.stream,
    },
    skipInstall: action === 'verify' || action === 'teardown',
    skipVerify: action === 'install' || action === 'teardown',
    skipTeardown: action === 'install' || action === 'verify',
    destination: args.destination,
  });

  // Emit infra-provision context as notes when terraform/cli mode was used.
  if (session.infraMode && session.infraMode !== 'existing') {
    plan.notes.unshift(
      `Infra provisioned via ${session.infraMode === 'terraform' ? 'Terraform module (terraform-aws-tenx-retriever-lambda)' : 'aws CLI commands'}. AWS infra lifecycle is Terraform-owned — the wizard does not manage it.`
    );
  }

  const summary = buildPlanSummary(plan, action);
  const planEnvelope = buildAdvisePlanEnvelope({ tool: TOOL_NAME, plan, action });
  // Re-wrap via wizardReturn so plan mode gets the wizard's action routing.
  return wizardReturn({ ...summary, mode: 'plan', markdown: (planEnvelope.data as { markdown?: string })?.markdown ?? '' });
}

// ── License reason copy ───────────────────────────────────────────────────────

function signinRequiredReasonMessage(reason: string): string {
  switch (reason) {
    case 'not-signed-in':
      return 'No Log10x session found on this machine. Sign in via `log10x_signin_start` to mint a user-scoped license.';
    case 'pasted-key-fallback':
      return 'You signed in via a pasted API key, but the license gateway requires Auth0 tokens. Run the browser device flow via `log10x_signin_start` to get them.';
    case 'access-token-expired-no-refresh':
      return 'Your Auth0 session expired and there\'s no refresh token. Sign in again via `log10x_signin_start`.';
    case 'refresh-failed':
      return 'The Auth0 token refresh failed (network or Auth0 rejection). Sign in again via `log10x_signin_start` and retry.';
    case 'user-license-fetch-failed':
      return 'Auth0 succeeded but the license gateway returned an error. Retry — if it persists, contact support or use `license_source: "paste"` with an existing JWT.';
    default:
      return 'Sign in via `log10x_signin_start` to mint a user-scoped license, then re-invoke.';
  }
}
