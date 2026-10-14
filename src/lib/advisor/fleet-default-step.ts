/**
 * The step after the POC on a Datadog install: the fleet default, the limit
 * and the route for every service the POC report gives no rule of its own.
 *
 * The plan states the rule in user units, the always-pass sample, what an
 * error monitor sees, and the destination side the route needs: the Flex
 * index that takes `@routeState:tier_down`, or the forwarder's S3 branch for
 * `offload`. Nothing here calls Datadog.
 */

import type { ForwarderKind } from '../discovery/types.js';
import {
  datadogFlexRecipe,
  offloadRecipe,
  type OffloadForwarderId,
} from '../offload-recipes.js';
import {
  alwaysPassSentence,
  defaultErrorFloor,
  errorMonitorVisibility,
  fleetDestination,
  type FleetDefaultAction,
} from '../fleet-default.js';
import { ALWAYS_PASS_LINES } from '../report/user-units.js';
import type { ReceiverFleetValues } from '../fleet-default-install.js';

export const FLEX_INDEX_FILTER = '@routeState:tier_down';

export interface FleetDefaultStepInput {
  /** Where lines above the limit go. Default `tier_down` (Flex); `offload` (S3) for an account without Flex. */
  action?: FleetDefaultAction;
  /** Share of ERROR and CRITICAL lines above the limit kept in Standard. Default 0.5 for offload, 0 for tier_down. */
  errorFloor?: number;
  forwarder?: ForwarderKind;
  /** The offload bucket, when discovery found one. */
  bucket?: string;
  region?: string;
  /** The Receiver values the plan writes, and why any are held back. */
  receiverValues?: ReceiverFleetValues;
  /** True when the caller passed the limit (`cap_bytes_per_window_per_node`). */
  capGiven?: boolean;
}

export type FleetDefaultDestinationSetup =
  | { kind: 'flex_index'; index_filter: string; language: 'hcl'; body: string }
  | {
      kind: 's3_offload';
      bucket: string;
      prefix: string;
      forwarder: OffloadForwarderId | null;
      language?: string;
      body?: string;
      placement?: string;
    };

export interface FleetDefaultStep {
  destination: 'datadog';
  action: FleetDefaultAction;
  error_floor: number;
  always_pass_lines: number;
  /** The rule in user units. */
  rule: string;
  always_pass: string;
  error_monitors: string;
  destination_setup: FleetDefaultDestinationSetup;
  /** The Receiver side, and what holds until the engine reads the default action. */
  receiver: string;
  /** True when the plan's Receiver values carry the fleet default. */
  receiver_values_written: boolean;
  /** The options after the app, in order, when written. */
  receiver_options?: Array<[string, string]>;
  /** Env vars on the Receiver container, when written. */
  receiver_env?: Array<[string, string]>;
  markdown: string;
}

const OFFLOAD_FORWARDER: Partial<Record<ForwarderKind, OffloadForwarderId>> = {
  fluentbit: 'fluent-bit',
  fluentd: 'fluentd',
  logstash: 'logstash',
  'otel-collector': 'otel-collector',
  vector: 'vector',
};

const OFFLOAD_PREFIX = 'app';

export function buildFleetDefaultStep(input: FleetDefaultStepInput = {}): FleetDefaultStep {
  const action: FleetDefaultAction = input.action ?? 'tier_down';
  const floorIn = input.errorFloor;
  const errorFloor =
    floorIn !== undefined && Number.isFinite(floorIn) ? Math.min(1, Math.max(0, floorIn)) : defaultErrorFloor(action);
  const dest = fleetDestination(action);

  const rule =
    `The POC report gives each service it measured a rule of its own. The fleet default covers every other service: ` +
    `a statement above the fleet limit goes to ${dest}. The limit is the fleet line of the POC report, in lines a day.`;
  const alwaysPass = alwaysPassSentence(ALWAYS_PASS_LINES);
  const errorMonitors =
    `The fleet default holds error statements too. ${errorMonitorVisibility(action, errorFloor, ALWAYS_PASS_LINES)}`;
  const rv = input.receiverValues;
  const written = !!rv?.fleetDefaultWritten;
  const receiver = written
    ? 'The plan writes these Receiver options after the app in the values above, where a later value wins over the ' +
      "app's config, and the env var `outputOffload=true`, which puts `routeState` on every line the Receiver returns. " +
      '`rateReceiverAbsoluteCap` is the limit in the engine\'s unit, bytes per node; the POC report states it in lines a day.'
    : !rv
      ? 'The limit, the action and the always-pass sample are Receiver settings. This plan writes them once the engine ' +
        'it installs reads the default action for a service with no rule; until then a service with no rule keeps every ' +
        'statement in Standard.'
      : !input.capGiven
        ? 'No limit was given. `log10x_poc_from_local` or `log10x_configure_engine` with `fleet_default` computes it from ' +
          'the POC capture and returns `fleet_default.cap_bytes_per_window_per_node`; passed back here as ' +
          '`fleet_default.cap_bytes_per_window_per_node`, it goes into the Receiver values. Until then the plan writes ' +
          'no fleet default, and a service with no rule keeps every statement in Standard.'
        : rv.notes.find((n) => n.includes('fleet default')) ?? 'The plan writes no fleet default.';

  const md: string[] = [];
  md.push('## After the POC: the fleet default (Datadog)');
  md.push('');
  md.push(`${rule} ${alwaysPass}`);
  md.push('');
  md.push(`**Error monitors.** ${errorMonitors}`);
  md.push('');
  md.push(
    '**Log monitors and log-based metrics.** Before a rule moves lines off Standard, `log10x_configure_engine` ' +
      'lists the log monitors and log-based metrics that read them (`check_dependencies`).',
  );
  md.push('');

  let setup: FleetDefaultDestinationSetup;
  if (action === 'tier_down') {
    const flex = datadogFlexRecipe();
    setup = { kind: 'flex_index', index_filter: FLEX_INDEX_FILTER, language: 'hcl', body: flex.body };
    md.push('### 1. The Flex index');
    md.push('');
    md.push(
      'The Receiver marks each line above the limit with `routeState` `tier_down`, and the forwarder sends it to Datadog ' +
        `with that attribute. This index takes those lines with the filter \`${FLEX_INDEX_FILTER}\`. Datadog indexes are ` +
        'first-match-wins, so the order resource puts it ahead of the catch-all index. Flex Logs must be enabled on the ' +
        'account before the apply.',
    );
    md.push('');
    md.push('```hcl');
    md.push(flex.body);
    md.push('```');
    md.push('');
  } else {
    const bucket = input.bucket?.trim() || '<offload-bucket>';
    const region = input.region?.trim() || '<region>';
    const fwd = input.forwarder ? OFFLOAD_FORWARDER[input.forwarder] ?? null : null;
    md.push('### 1. The S3 bucket');
    md.push('');
    md.push(
      'The Receiver marks each line above the limit with `routeState` `offload`, and the forwarder sends those lines to ' +
        `\`s3://${bucket}/${OFFLOAD_PREFIX}/\` instead of Datadog. The Retriever indexes that bucket and fetches lines back ` +
        'by `tenx_hash`; `log10x_advise_retriever` with `destination: "datadog"` installs it on the same bucket and prints ' +
        'the write grant the forwarder needs.',
    );
    md.push('');
    if (fwd) {
      const r = offloadRecipe(fwd, {
        bucket,
        region,
        prefix: OFFLOAD_PREFIX,
        keepMarkerAtDestination: true,
      });
      setup = { kind: 's3_offload', bucket, prefix: OFFLOAD_PREFIX, forwarder: fwd, language: r.language, body: r.body, placement: r.placementNote };
      md.push(`**${fwd} routing**`);
      md.push('');
      md.push('```' + r.language);
      md.push(r.body);
      md.push('```');
      md.push('');
      md.push(`Placement: ${r.placementNote}`);
      md.push('');
    } else {
      setup = { kind: 's3_offload', bucket, prefix: OFFLOAD_PREFIX, forwarder: null };
      md.push(
        input.forwarder
          ? `\`${input.forwarder}\` has no S3 output of its own, so the offload branch runs in a forwarder that has one; ` +
              '`log10x_advise_retriever` prints the recipes.'
          : 'No forwarder was named, so the routing recipe is not printed; `log10x_advise_retriever` prints it per forwarder.',
      );
      md.push('');
    }
  }

  md.push('### 2. The Receiver');
  md.push('');
  md.push(receiver);
  md.push('');
  if (written && rv) {
    const fleetKeys = new Set(['symbolMessageHashField', 'k8sTeamLabel']);
    md.push('```text');
    for (const [k, v] of rv.options.filter(([k]) => !fleetKeys.has(k))) md.push(`${k} ${v}`);
    for (const [k, v] of rv.env) md.push(`${k}=${v}   # env`);
    md.push('```');
    md.push('');
  }

  return {
    destination: 'datadog',
    action,
    error_floor: errorFloor,
    always_pass_lines: ALWAYS_PASS_LINES,
    rule,
    always_pass: alwaysPass,
    error_monitors: errorMonitors,
    destination_setup: setup,
    receiver,
    receiver_values_written: written,
    ...(written && rv ? { receiver_options: rv.options, receiver_env: rv.env } : {}),
    markdown: md.join('\n'),
  };
}
