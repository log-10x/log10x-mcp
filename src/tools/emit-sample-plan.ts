/**
 * log10x_emit_sample_plan — step 2 of the fenced POC.
 *
 * Renders a shell script that reads a log sample out of the user's own SIEM,
 * with the user's own credentials, on the user's own machine, and writes it
 * to plain text files. This server does not run it and could not: in the
 * fenced profile the process it lives in has no network at all.
 *
 * The split is the whole design. Code that sees log data (this server, the
 * engine it spawns) has no network; code that has network (the user's `aws`,
 * the user's `curl`) is not ours. An egress allowlist would have been the
 * obvious alternative and does not hold: an allowlist constrains hosts, but
 * tenancy is chosen by the credential inside TLS, so vendor code carrying an
 * attacker's own key could write a user's logs to the attacker's tenant
 * through an allowed host. `--network none` is checkable; an allowlist is a
 * promise. See `lib/fenced.ts`.
 *
 * What makes the script trustworthy is that it is short, stereotyped and
 * read-only, and that the reviewer only has to read it once: one API per
 * script, every argument single-quoted, every sub-window listed as a literal
 * timestamp in the header, and no vendor hostname anywhere in it (enforced at
 * render time by `assertNoVendorHost`, and by a regression test per SIEM).
 *
 * The sampling matches `log10x_poc_from_siem` bucket for bucket — same
 * `randomTimeBuckets`, same `perBucketCap`, same connector bucket counts —
 * so a fenced POC and a credentialed POC over the same window differ because
 * the logs differ, not because two samplers disagreed.
 */

import { promises as fs } from 'fs';
import * as nodePath from 'path';

import { z } from 'zod';

import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import {
  emitSamplePlan,
  hasExportPlan,
  DEFAULT_TARGET_EVENT_COUNT,
  EXPORT_PLAN_FOLLOW_UPS,
  EXPORT_PLAN_SIEMS,
  UnsupportedExportSiemError,
  type SamplePlan,
} from '../lib/siem/export-plan/index.js';
import { parseWindowMs } from '../lib/siem/index.js';
import { isFenced } from '../lib/fenced.js';

/** Filename the emitted script lands under, and the name the docs use. */
export const SAMPLE_SCRIPT_FILE_NAME = 'export-sample.sh';

export const emitSamplePlanSchema = {
  siem: z
    .enum(EXPORT_PLAN_SIEMS)
    .describe(
      'Which log analyzer to export the sample from. One script per analyzer: ' +
        '`cloudwatch` (aws CLI: DescribeLogGroups + FilterLogEvents), `splunk` (search/jobs/export), ' +
        '`elasticsearch` and `opensearch` (_cat/indices + _search), `datadog` (v2 logs search). ' +
        'ClickHouse, Azure Monitor, Coralogix, GCP Logging and Sumo Logic are follow-up work — ' +
        'for those, export plain text yourself, one log message per line, and run the POC over it.',
    ),
  window: z
    .string()
    .default('14d')
    .describe(
      'How far back to sample. Accepts `1h`, `24h`, `7d`, `14d`, `30d`. Default `14d`, matching ' +
        '`log10x_poc_from_siem` — a wide window is what makes first-seen, growth and ' +
        'stable-versus-new readable at all.',
    ),
  target_event_count: z
    .number()
    .min(1_000)
    .max(5_000_000)
    .default(DEFAULT_TARGET_EVENT_COUNT)
    .describe(
      'Target event count for the export. Default 1,000,000 (~500 MB at 500 B average) — the same ' +
        'default `log10x_poc_from_siem` uses, so a fenced POC and a credentialed one see samples of ' +
        'the same size. Lower it when the export has to fit a laptop or a coffee break.',
    ),
  scope: z
    .string()
    .optional()
    .describe(
      'Analyzer-native scope. CloudWatch: log group name or prefix (`/aws/ecs/*` — the asterisks are ' +
        'stripped, CloudWatch matches on prefix). Splunk: index name. Elasticsearch / OpenSearch: index ' +
        'pattern (default `logs-*`). Datadog: index name. Omitted means everything the credentials can read.',
    ),
  query: z
    .string()
    .optional()
    .describe(
      'Analyzer-native filter layered on top of `scope`: a CloudWatch filter pattern, an SPL fragment, ' +
        'a Lucene query_string for Elasticsearch, a Datadog query. Narrowing here narrows what the ' +
        'savings projection covers, so say so in the report if you use it.',
    ),
  output_dir: z
    .string()
    .optional()
    .describe(
      'Where the script writes the exported sample, relative to wherever the user runs it. ' +
        'Default `./poc/logs`, which is the directory the documented `docker run` line mounts ' +
        'read-only at /data.',
    ),
  write_script: z
    .boolean()
    .default(true)
    .describe(
      'Default true: also write the script next to the working directory as `export-sample.sh` ' +
        '(mode 0755) so the user can read it in an editor rather than out of a chat transcript. ' +
        'Set false to get the text back and nothing on disk.',
    ),
};

export interface EmitSamplePlanArgs {
  siem: string;
  window?: string;
  target_event_count?: number;
  scope?: string;
  query?: string;
  output_dir?: string;
  write_script?: boolean;
}

/**
 * The review guidance the user needs to read the script ONCE and be done.
 *
 * Deliberately phrased as things to check rather than assurances to accept:
 * the script is vendor-suggested text, and the reason it is safe is that it
 * is short enough to verify, not that we said so.
 */
function reviewChecklist(plan: SamplePlan): string[] {
  const tools = plan.requires.map((r) => `\`${r}\``).join(', ');
  // The credential handling differs by transport, and saying the wrong one is
  // worse than saying less: the CloudWatch script hands credential resolution
  // to the `aws` CLI and never touches a key, while the HTTP scripts write
  // theirs to a scratch file to keep them out of argv.
  const credentialHandling = plan.requires.includes('curl')
    ? 'It sends them to your own analyzer and writes them nowhere lasting — they go into a file ' +
      'inside a 0700 scratch directory rather than onto a command line, because `ps` shows argv to ' +
      'every user on the machine, and the EXIT trap removes the directory.'
    : 'The `aws` CLI resolves them the way it always does; this script neither reads nor copies them.';
  return [
    `Every call it makes goes to ${plan.apiCalls.join(' and ')}. Grep for ${tools} and confirm ` +
      `there is nothing else in the file.`,
    `The only environment variables it reads are ${plan.credentials.join(', ')}. ${credentialHandling}`,
    `Everything it writes lands under ${plan.outputDir}, plus the scratch directory under $TMPDIR ` +
      `that the EXIT trap removes. Nothing outside those two places is created or modified.`,
    'The only host it names is your own: `grep -oE \'https?://[^"]+\' export-sample.sh` should list ' +
      'your analyzer and nothing else. The server refuses to emit a script carrying a log10x address, ' +
      'and a test enforces that per analyzer.',
    'The sub-windows it reads are listed as literal timestamps in the header, so the whole time ' +
      'footprint is visible without running anything.',
  ];
}

function humanSummary(plan: SamplePlan, fenced: boolean, scriptPath?: string): string {
  const lines: string[] = [];
  lines.push(`## Export a sample from ${plan.displayName}`);
  lines.push('');
  lines.push(
    `Run this on a machine that can reach ${plan.displayName}, with your own credentials. ` +
      `It reads ${plan.targetEventCount.toLocaleString('en-US')} events at most, drawn from ` +
      `${plan.bucketCount} random sub-windows across the last ${plan.window}, and writes them as ` +
      `plain text under \`${plan.outputDir}\`.`,
  );
  lines.push('');
  if (scriptPath) {
    lines.push(`Written to \`${scriptPath}\` (mode 0755).`);
    lines.push('');
  }
  lines.push('### Read it first');
  lines.push('');
  for (const item of reviewChecklist(plan)) lines.push(`- ${item}`);
  lines.push('');
  lines.push('### Then');
  lines.push('');
  lines.push(`1. \`chmod +x ${plan.filename} && ./${plan.filename}\``);
  lines.push(
    `2. Start the fenced container over \`${plan.outputDir}\` and call ` +
      '`log10x_poc_from_local` with the arguments in `data.next_call`.',
  );
  lines.push('');
  lines.push('### Requires');
  lines.push('');
  lines.push(`\`${plan.requires.join('`, `')}\` on PATH.`);
  if (plan.notes.length > 0) {
    lines.push('');
    lines.push('### Worth knowing');
    lines.push('');
    for (const n of plan.notes) lines.push(`- ${n}`);
  }
  if (!fenced) {
    lines.push('');
    lines.push(
      '_This server is not running in the fenced profile, so it could have pulled the sample ' +
        'itself via `log10x_poc_from_siem`. The script is still the right answer when the ' +
        'credentials live somewhere this process does not._',
    );
  }
  return lines.join('\n');
}

export async function executeEmitSamplePlan(
  args: EmitSamplePlanArgs,
): Promise<string | StructuredOutput> {
  if (!hasExportPlan(args.siem)) {
    throw new UnsupportedExportSiemError(args.siem);
  }
  const window = args.window ?? '14d';
  // Fail on the window here rather than inside the renderer, so a typo comes
  // back as "invalid window" and not as a stack trace from the sampler.
  parseWindowMs(window);

  const plan = emitSamplePlan({
    siem: args.siem,
    window,
    targetEventCount: args.target_event_count ?? DEFAULT_TARGET_EVENT_COUNT,
    scope: args.scope,
    query: args.query,
    outputDir: args.output_dir,
  });

  let script_path: string | undefined;
  let script_note: string | undefined;
  if (args.write_script !== false) {
    try {
      script_path = nodePath.resolve(process.cwd(), plan.filename);
      await fs.writeFile(script_path, plan.script, { mode: 0o755 });
      // writeFile honours the mode only when it CREATES the file; a rerun over
      // an existing script would keep whatever mode was there before.
      await fs.chmod(script_path, 0o755);
    } catch (e) {
      script_path = undefined;
      script_note =
        `could not write ${plan.filename} to ${process.cwd()}: ` +
        `${e instanceof Error ? e.message : String(e)}. The script text is in data.script.`;
    }
  }

  const fenced = isFenced();
  return buildEnvelope({
    tool: 'log10x_emit_sample_plan',
    view: 'summary',
    summary: {
      headline:
        `${plan.displayName}: export script for up to ${plan.targetEventCount.toLocaleString('en-US')} ` +
        `events across ${plan.bucketCount} random sub-windows of the last ${plan.window}, ` +
        `written to ${plan.outputDir} as plain text. Read it, then run it — this server does not.`,
    },
    data: {
      siem: plan.siem,
      display_name: plan.displayName,
      filename: plan.filename,
      script_path,
      script_note,
      script: plan.script,
      window: plan.window,
      target_event_count: plan.targetEventCount,
      bucket_count: plan.bucketCount,
      per_bucket_cap: plan.perBucketCap,
      output_dir: plan.outputDir,
      requires: plan.requires,
      credentials: plan.credentials,
      api_calls: plan.apiCalls,
      review_checklist: reviewChecklist(plan),
      next_call: { tool: 'log10x_poc_from_local', args: plan.pocFromLocalArgs },
      fenced_profile: fenced,
      follow_up_analyzers: EXPORT_PLAN_FOLLOW_UPS,
      notes: plan.notes,
      human_summary: humanSummary(plan, fenced, script_path),
    },
  });
}
