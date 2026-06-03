/**
 * log10x_setup_recurring — conversational wizard that configures a recurring
 * cost-reduction agent.
 *
 * The wizard mirrors advise_install's progressive Q-and-A pattern: each call
 * merges the user's latest answer into a wizard session (keyed on snapshot_id)
 * and either asks the next missing question or, once all answers are in, emits
 * the concrete artifacts (policy.yaml + scheduler manifest) and apply-instructions.
 *
 * Steps (in dependency order):
 *   Q1. target_services  — multi-select from log10x_services or user-supplied list
 *   Q2. target_percent   — integer 1-95, default 30
 *   Q3. schedule         — preset or custom cron
 *   Q4. scheduler        — k8s_cron | github_actions | crontab
 *   Q5. config_plane     — gitops repo URL or direct kubectl path
 *   Q6. exceptions       — services to never touch (optional, default [])
 *   Q7. confirm          — final confirmation before emit
 *   emit                 — writes artifacts, returns paths + apply-instructions
 *
 * State: wizard session stored in a simple in-process Map keyed on snapshot_id.
 * Each call updates the session with the newly supplied fields; unset fields
 * retain their prior values.
 */

import { z } from 'zod';
import {
  emitPolicyYaml,
  emitK8sCronJob,
  emitGitHubActions,
  emitCrontab,
  resolveCronExpression,
  type PolicyOptions,
  type SchedulePreset,
  type SchedulerKind,
} from '../lib/scheduler-manifest-emitter.js';
import { buildEnvelope, type StructuredOutput, type ActionRole } from '../lib/output-types.js';

// ─── constants ────────────────────────────────────────────────────────────────

const TOOL_NAME = 'log10x_setup_recurring';

const SCHEDULE_PRESETS = [
  'daily-03utc',
  'every-6h',
  'every-12h',
  'every-24h-localtz',
] as const;

const SCHEDULER_KINDS = ['k8s_cron', 'github_actions', 'crontab'] as const;

// ─── schema ───────────────────────────────────────────────────────────────────

export const setupRecurringSchema = {
  /**
   * Opaque session handle returned on the first call (when omitted, a new
   * session is minted). Pass it back on every subsequent call so the wizard
   * can accumulate answers without requiring all fields in a single turn.
   */
  session_id: z
    .string()
    .optional()
    .describe(
      'Wizard session handle. Omit on the first call — a new session is minted and returned. Pass it back unchanged on every subsequent call.'
    ),

  /**
   * Target services. An empty array means "all services". Supply the list
   * from `log10x_services` or let the user name them explicitly. The wizard
   * asks if omitted.
   */
  target_services: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Services the policy targets. Empty array = all services. Use service names from `log10x_services`. The wizard asks if omitted.'
    ),

  /**
   * Desired savings percentage. Must be 1-95. Default 30.
   * The wizard asks if omitted.
   */
  target_percent: z
    .number()
    .int()
    .min(1)
    .max(95)
    .optional()
    .describe(
      'Desired savings target, as a percentage of current log volume (1-95). Default: 30. The CLI\'s per-pattern planner works backward from this target.'
    ),

  /**
   * Tick schedule. Either a preset name or a raw 5-field cron expression.
   * The wizard asks if omitted.
   */
  schedule: z
    .union([z.enum(SCHEDULE_PRESETS), z.string().regex(/^[\d*,\-\/\s]+$/, 'cron expression')])
    .optional()
    .describe(
      'Tick schedule. Presets: daily-03utc (default), every-6h, every-12h, every-24h-localtz. Or pass a raw 5-field cron expression (e.g. "0 5 * * 1").'
    ),

  /**
   * Scheduler runtime. Default: k8s_cron when kubectl is reachable, otherwise
   * github_actions. The wizard asks if omitted.
   */
  scheduler: z
    .enum(SCHEDULER_KINDS)
    .optional()
    .describe(
      'Where the recurring tick runs. k8s_cron = Kubernetes CronJob (default when kubectl reachable), github_actions = GHA workflow, crontab = crontab + wrapper script.'
    ),

  /**
   * Gitops repo URL or local path where the CLI writes cap CSVs.
   * The wizard asks if omitted.
   */
  config_plane: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Gitops repo URL (e.g. https://github.com/acme/log10x-config) or local path where the recurring CLI reads policy.yaml and writes updated cap CSVs.'
    ),

  /**
   * Services that must never be touched regardless of savings opportunity.
   * Optional — defaults to empty.
   */
  exceptions: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Service names the policy must never touch (audit / regulatory / executive). Optional — defaults to empty. Pass [] to explicitly clear all exceptions.'
    ),

  /**
   * Minimum savings delta (percentage points) before a new CSV is committed.
   * Prevents noisy week-to-week churn. Default 2.
   */
  min_delta_pp: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe(
      'Minimum change in savings percentage points required before the tick commits a new CSV. Default: 2. Set to 0 to commit on every tick.'
    ),

  /**
   * Log10x env ID — scopes the metric queries. Auto-detected from
   * LOG10X_ENV_ID when not supplied.
   */
  env_id: z
    .string()
    .optional()
    .describe('Log10x environment ID. Auto-detected from LOG10X_ENV_ID when absent.'),

  /**
   * Kubernetes namespace for the CronJob (k8s_cron only). Default: log10x.
   */
  namespace: z
    .string()
    .optional()
    .describe('Kubernetes namespace for the CronJob. Default: log10x. Only used when scheduler=k8s_cron.'),

  /**
   * Name of the k8s Secret that holds LOG10X_API_KEY (k8s_cron only).
   * Default: log10x-secret.
   */
  secret_name: z
    .string()
    .optional()
    .describe('Name of the Kubernetes Secret holding LOG10X_API_KEY. Default: log10x-secret. Only used when scheduler=k8s_cron.'),

  /**
   * Skip all remaining questions and emit whatever is configured so far.
   * Useful for automated flows that supply all args in a single call.
   */
  confirm: z
    .boolean()
    .optional()
    .describe(
      'Set to true to confirm the configuration and emit the artifacts. The wizard asks for confirmation interactively when omitted.'
    ),
};

const schemaObj = z.object(setupRecurringSchema);
export type SetupRecurringArgs = z.infer<typeof schemaObj>;

// ─── wizard session ────────────────────────────────────────────────────────────

interface RecurringWizardSession {
  session_id: string;
  target_services?: string[];
  target_percent?: number;
  schedule?: SchedulePreset;
  scheduler?: SchedulerKind;
  config_plane?: string;
  exceptions?: string[];
  min_delta_pp?: number;
  env_id?: string;
  namespace?: string;
  secret_name?: string;
  confirmed?: boolean;
  created_at: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, RecurringWizardSession>();

function mintSession(): RecurringWizardSession {
  const id = `recurring-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const session: RecurringWizardSession = { session_id: id, created_at: Date.now() };
  sessions.set(id, session);
  return session;
}

function getOrCreateSession(id: string | undefined): RecurringWizardSession {
  if (id) {
    const existing = sessions.get(id);
    if (existing && Date.now() - existing.created_at < SESSION_TTL_MS) return existing;
  }
  return mintSession();
}

function mergeIntoSession(session: RecurringWizardSession, args: SetupRecurringArgs): void {
  if (args.target_services !== undefined) session.target_services = args.target_services;
  if (args.target_percent !== undefined) session.target_percent = args.target_percent;
  if (args.schedule !== undefined) session.schedule = args.schedule as SchedulePreset;
  if (args.scheduler !== undefined) session.scheduler = args.scheduler as SchedulerKind;
  if (args.config_plane !== undefined) session.config_plane = args.config_plane;
  if (args.exceptions !== undefined) session.exceptions = args.exceptions;
  if (args.min_delta_pp !== undefined) session.min_delta_pp = args.min_delta_pp;
  if (args.env_id !== undefined) session.env_id = args.env_id;
  if (args.namespace !== undefined) session.namespace = args.namespace;
  if (args.secret_name !== undefined) session.secret_name = args.secret_name;
  if (args.confirm === true) session.confirmed = true;
  session.created_at = Date.now(); // refresh TTL on each answer
}

// ─── question IDs ─────────────────────────────────────────────────────────────

type QuestionId =
  | 'target_services'
  | 'target_percent'
  | 'schedule'
  | 'scheduler'
  | 'config_plane'
  | 'exceptions'
  | 'confirm';

interface NextQuestion {
  kind: 'ask';
  question_id: QuestionId;
  markdown: string;
}

interface AllAnswered {
  kind: 'done';
}

function nextQuestion(session: RecurringWizardSession): NextQuestion | AllAnswered {
  if (session.target_services === undefined) {
    return {
      kind: 'ask',
      question_id: 'target_services',
      markdown: buildQuestion(
        'Q1',
        'Which services should the recurring policy target?',
        [
          'Run `log10x_services` to see all monitored services, then pass the names you want.',
          'Pass `target_services: []` (empty array) to target **all** services.',
          'Example: `target_services: ["frontend", "checkout", "payments"]`',
        ],
        'target_services',
        session
      ),
    };
  }
  if (session.target_percent === undefined) {
    return {
      kind: 'ask',
      question_id: 'target_percent',
      markdown: buildQuestion(
        'Q2',
        'What savings target (% of current log volume)?',
        [
          'Integer 1-95. Default: **30** (a conservative starting point).',
          'The per-pattern planner works backward from this target using current byte volumes.',
          'Example: `target_percent: 30`',
        ],
        'target_percent',
        session
      ),
    };
  }
  if (session.schedule === undefined) {
    return {
      kind: 'ask',
      question_id: 'schedule',
      markdown: buildQuestion(
        'Q3',
        'How often should the tick run?',
        [
          '**daily-03utc** (default) — once a day at 03:00 UTC',
          '**every-6h** — four times a day',
          '**every-12h** — twice a day',
          '**every-24h-localtz** — daily (UTC proxy; note: scheduler runtime is UTC)',
          'Or pass any 5-field cron expression, e.g. `"0 5 * * 1"` for every Monday at 05:00 UTC.',
          'Example: `schedule: "daily-03utc"`',
        ],
        'schedule',
        session
      ),
    };
  }
  if (session.scheduler === undefined) {
    return {
      kind: 'ask',
      question_id: 'scheduler',
      markdown: buildQuestion(
        'Q4',
        'Where should the tick run?',
        [
          '**k8s_cron** — Kubernetes CronJob (recommended when `kubectl` is available)',
          '**github_actions** — GitHub Actions scheduled workflow',
          '**crontab** — crontab entry + wrapper script (simple, any Linux host)',
          'Example: `scheduler: "k8s_cron"`',
        ],
        'scheduler',
        session
      ),
    };
  }
  if (session.config_plane === undefined) {
    return {
      kind: 'ask',
      question_id: 'config_plane',
      markdown: buildQuestion(
        'Q5',
        'Where is the gitops config repo?',
        [
          'The recurring CLI reads `policy.yaml` from here and commits updated cap CSVs.',
          'Pass a GitHub URL or a local path.',
          'Example: `config_plane: "https://github.com/acme/log10x-config"`',
        ],
        'config_plane',
        session
      ),
    };
  }
  if (!session.confirmed) {
    const summary = buildConfigSummary(session);
    return {
      kind: 'ask',
      question_id: 'confirm',
      markdown: [
        `## Recurring policy — ready to emit`,
        ``,
        summary,
        ``,
        `Re-invoke with \`confirm: true\` (and optionally \`exceptions: ["svc1", "svc2"]\` or`,
        `\`min_delta_pp: 5\`) to emit the artifacts.`,
        `Or pass any corrected field to override before confirming.`,
      ].join('\n'),
    };
  }
  return { kind: 'done' };
}

function buildQuestion(
  step: string,
  headline: string,
  bullets: string[],
  answer_field: string,
  session: RecurringWizardSession
): string {
  const progress = buildProgressLine(session);
  return [
    `## Recurring wizard ${step}: ${headline}`,
    ``,
    ...bullets.map((b) => `- ${b}`),
    ``,
    progress,
    ``,
    `Re-invoke \`${TOOL_NAME}\` with \`session_id: "${session.session_id}"\` and \`${answer_field}: <your answer>\`.`,
  ].join('\n');
}

function buildProgressLine(session: RecurringWizardSession): string {
  const parts: string[] = [];
  if (session.target_services !== undefined)
    parts.push(`services=${session.target_services.length === 0 ? 'all' : session.target_services.join(',')}`);
  if (session.target_percent !== undefined) parts.push(`target=${session.target_percent}%`);
  if (session.schedule !== undefined) parts.push(`schedule=${session.schedule}`);
  if (session.scheduler !== undefined) parts.push(`scheduler=${session.scheduler}`);
  if (session.config_plane !== undefined) parts.push(`repo=${session.config_plane}`);
  return parts.length > 0 ? `_Answers so far: ${parts.join(' | ')}_` : `_No answers yet._`;
}

function buildConfigSummary(session: RecurringWizardSession): string {
  const svc =
    !session.target_services || session.target_services.length === 0
      ? 'all services'
      : session.target_services.join(', ');
  const exc =
    !session.exceptions || session.exceptions.length === 0
      ? 'none'
      : session.exceptions.join(', ');
  return [
    `| Field            | Value |`,
    `|------------------|-------|`,
    `| Services         | ${svc} |`,
    `| Target savings   | ${session.target_percent ?? 30}% |`,
    `| Exceptions       | ${exc} |`,
    `| Min delta        | ${session.min_delta_pp ?? 2}pp |`,
    `| Schedule         | ${session.schedule ?? 'daily-03utc'} (${resolveCronExpression(session.schedule ?? 'daily-03utc')}) |`,
    `| Scheduler        | ${session.scheduler ?? 'k8s_cron'} |`,
    `| Config repo      | ${session.config_plane ?? '(not set)'} |`,
  ].join('\n');
}

// ─── artifact emission ────────────────────────────────────────────────────────

interface EmitResult {
  policy_yaml: string;
  scheduler_manifest: string;
  scheduler_manifest_filename: string;
  apply_instructions: string;
  /** For crontab scheduler: the wrapper script content. */
  crontab_wrapper_script?: string;
}

function buildPolicyOptions(session: RecurringWizardSession): PolicyOptions {
  return {
    target_services: session.target_services ?? [],
    target_percent: session.target_percent ?? 30,
    schedule: session.schedule ?? 'daily-03utc',
    scheduler: (session.scheduler ?? 'k8s_cron') as SchedulerKind,
    config_plane: session.config_plane ?? '',
    exceptions: session.exceptions ?? [],
    min_delta_pp: session.min_delta_pp ?? 2,
    env_id: session.env_id,
    namespace: session.namespace,
    secret_name: session.secret_name,
  };
}

function buildApplyInstructions(session: RecurringWizardSession, opts: PolicyOptions): string {
  const scheduler = session.scheduler ?? 'k8s_cron';
  const cronExpr = resolveCronExpression(opts.schedule);

  switch (scheduler) {
    case 'k8s_cron':
      return [
        `### Apply instructions — Kubernetes CronJob`,
        ``,
        `1. **Commit \`policy.yaml\`** to the root of your gitops repo (\`${opts.config_plane}\`).`,
        `2. **Apply the CronJob manifest:**`,
        `   \`\`\`bash`,
        `   kubectl apply -f log10x-cronjob.yaml`,
        `   \`\`\``,
        `3. The CronJob runs on schedule \`${cronExpr}\` (UTC).`,
        `4. Verify it registered: \`kubectl get cronjob -n ${opts.namespace ?? 'log10x'} log10x-recurring\``,
        `5. Trigger a manual test run:`,
        `   \`\`\`bash`,
        `   kubectl create job --from=cronjob/log10x-recurring log10x-test-tick -n ${opts.namespace ?? 'log10x'}`,
        `   kubectl logs -n ${opts.namespace ?? 'log10x'} -l job-name=log10x-test-tick`,
        `   \`\`\``,
      ].join('\n');

    case 'github_actions':
      return [
        `### Apply instructions — GitHub Actions`,
        ``,
        `1. **Commit \`policy.yaml\`** to the root of your gitops repo.`,
        `2. **Commit \`log10x-recurring.yml\`** to \`.github/workflows/\` in the same repo.`,
        `3. **Add the secret** \`LOG10X_API_KEY\` to your repository secrets (Settings → Secrets and variables → Actions).`,
        `4. The workflow triggers on schedule \`${cronExpr}\` (UTC) and on \`workflow_dispatch\` for manual runs.`,
        `5. Check the Actions tab for the first scheduled run.`,
      ].join('\n');

    case 'crontab':
      return [
        `### Apply instructions — crontab`,
        ``,
        `1. **Commit \`policy.yaml\`** to \`${opts.config_plane}\`.`,
        `2. **Install the wrapper script:**`,
        `   \`\`\`bash`,
        `   sudo cp log10x-tick.sh /usr/local/bin/log10x-tick.sh`,
        `   sudo chmod +x /usr/local/bin/log10x-tick.sh`,
        `   \`\`\``,
        `3. **Add to crontab** (\`crontab -e\`):`,
        `   \`\`\``,
        `   ${cronExpr} /usr/local/bin/log10x-tick.sh >> /var/log/log10x-tick.log 2>&1`,
        `   \`\`\``,
        `4. Set \`LOG10X_API_KEY\` in the system environment or hard-code it in the wrapper script.`,
        `5. Test: \`/usr/local/bin/log10x-tick.sh\``,
      ].join('\n');
  }
}

function emitArtifacts(session: RecurringWizardSession): EmitResult {
  const opts = buildPolicyOptions(session);
  const policy_yaml = emitPolicyYaml(opts);
  const scheduler = session.scheduler ?? 'k8s_cron';

  let scheduler_manifest: string;
  let scheduler_manifest_filename: string;
  let crontab_wrapper_script: string | undefined;

  switch (scheduler) {
    case 'k8s_cron':
      scheduler_manifest = emitK8sCronJob(opts);
      scheduler_manifest_filename = 'log10x-cronjob.yaml';
      break;
    case 'github_actions':
      scheduler_manifest = emitGitHubActions(opts);
      scheduler_manifest_filename = '.github/workflows/log10x-recurring.yml';
      break;
    case 'crontab': {
      const { crontab_line, wrapper_script } = emitCrontab(opts);
      scheduler_manifest = crontab_line;
      scheduler_manifest_filename = 'log10x-tick.sh';
      crontab_wrapper_script = wrapper_script;
      break;
    }
  }

  const apply_instructions = buildApplyInstructions(session, opts);

  return {
    policy_yaml,
    scheduler_manifest,
    scheduler_manifest_filename,
    apply_instructions,
    ...(crontab_wrapper_script !== undefined ? { crontab_wrapper_script } : {}),
  };
}

// ─── wizard output types ──────────────────────────────────────────────────────

type WizardMode = 'next_question' | 'emit';

type WizardData =
  | {
      mode: 'next_question';
      ok: false;
      session_id: string;
      question_id: QuestionId;
      markdown: string;
      human_summary: string;
    }
  | {
      mode: 'emit';
      ok: true;
      session_id: string;
      /** Content of policy.yaml — write to the gitops repo root. */
      policy_yaml: string;
      /** Content of the scheduler manifest (CronJob YAML / GHA workflow / crontab line). */
      scheduler_manifest: string;
      /** Filename for the scheduler manifest (relative to repo root). */
      scheduler_manifest_filename: string;
      /** Step-by-step apply instructions for the chosen scheduler. */
      apply_instructions: string;
      /** Wrapper script content — only set when scheduler=crontab. */
      crontab_wrapper_script?: string;
      markdown: string;
      human_summary: string;
    };

// ─── envelope builder ─────────────────────────────────────────────────────────

function wizardReturn(data: WizardData): StructuredOutput {
  const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string; role: ActionRole }> = [];

  if (data.mode === 'next_question') {
    actions.push({
      tool: TOOL_NAME,
      args: {
        session_id: data.session_id,
        [data.question_id]: '<user answer>',
      },
      reason: `answer "${data.question_id}" and re-invoke to advance the wizard`,
      role: 'required-next',
    });
  } else {
    actions.push({
      tool: 'log10x_doctor',
      args: {},
      reason: 'confirm the environment is healthy before the first tick runs',
      role: 'optional-followup',
    });
  }

  const headline =
    data.mode === 'next_question'
      ? `Recurring wizard — question "${data.question_id}" (session ${data.session_id})`
      : `Recurring policy emitted — ${data.scheduler_manifest_filename} + policy.yaml ready`;

  return buildEnvelope({
    tool: TOOL_NAME,
    view: 'summary',
    summary: { headline },
    data,
    actions,
    warnings: [],
  });
}

// ─── execute ──────────────────────────────────────────────────────────────────

export async function executeSetupRecurring(args: SetupRecurringArgs): Promise<StructuredOutput> {
  const session = getOrCreateSession(args.session_id);
  mergeIntoSession(session, args);

  const next = nextQuestion(session);
  if (next.kind === 'ask') {
    const humanSummary =
      `Recurring wizard needs answer to "${next.question_id}" before it can emit. ` +
      `Re-invoke ${TOOL_NAME} with session_id="${session.session_id}" and ${next.question_id}=<value>. ` +
      `Answers accumulated so far are remembered for 30 min.`;
    return wizardReturn({
      mode: 'next_question',
      ok: false,
      session_id: session.session_id,
      question_id: next.question_id,
      markdown: next.markdown,
      human_summary: humanSummary,
    });
  }

  // All questions answered — emit.
  const result = emitArtifacts(session);
  const md = buildEmitMarkdown(session, result);

  return wizardReturn({
    mode: 'emit',
    ok: true,
    session_id: session.session_id,
    policy_yaml: result.policy_yaml,
    scheduler_manifest: result.scheduler_manifest,
    scheduler_manifest_filename: result.scheduler_manifest_filename,
    apply_instructions: result.apply_instructions,
    ...(result.crontab_wrapper_script !== undefined
      ? { crontab_wrapper_script: result.crontab_wrapper_script }
      : {}),
    markdown: md,
    human_summary: buildEmitHumanSummary(session, result),
  });
}

function buildEmitMarkdown(session: RecurringWizardSession, result: EmitResult): string {
  const opts = buildPolicyOptions(session);
  const cronExpr = resolveCronExpression(opts.schedule);
  return [
    `## Recurring cost-reduction policy — artifacts ready`,
    ``,
    buildConfigSummary(session),
    ``,
    `---`,
    ``,
    `### \`policy.yaml\``,
    ``,
    `\`\`\`yaml`,
    result.policy_yaml.trimEnd(),
    `\`\`\``,
    ``,
    `---`,
    ``,
    `### \`${result.scheduler_manifest_filename}\``,
    ``,
    `\`\`\`yaml`,
    result.scheduler_manifest.trimEnd(),
    `\`\`\``,
    ``,
    ...(result.crontab_wrapper_script
      ? [
          `---`,
          ``,
          `### Wrapper script (\`log10x-tick.sh\`)`,
          ``,
          `\`\`\`bash`,
          result.crontab_wrapper_script.trimEnd(),
          `\`\`\``,
          ``,
        ]
      : []),
    `---`,
    ``,
    result.apply_instructions,
    ``,
    `---`,
    ``,
    `_Schedule: \`${cronExpr}\` (UTC). Tip: run \`log10x_commitment_report\` after the first week to see realized savings._`,
  ].join('\n');
}

function buildEmitHumanSummary(session: RecurringWizardSession, result: EmitResult): string {
  const scheduler = session.scheduler ?? 'k8s_cron';
  const target = session.target_percent ?? 30;
  const svcDesc =
    !session.target_services || session.target_services.length === 0
      ? 'all services'
      : `${session.target_services.length} service${session.target_services.length !== 1 ? 's' : ''}`;
  return (
    `Recurring policy emitted for ${svcDesc} targeting ${target}% savings via ${scheduler}. ` +
    `Artifacts: policy.yaml + ${result.scheduler_manifest_filename}. ` +
    `Apply instructions are in data.apply_instructions. ` +
    `Run log10x_commitment_report after the first week to verify realized savings.`
  );
}
