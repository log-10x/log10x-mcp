/**
 * The Receiver values that install the fleet default, as CLI options after
 * the app: a later value wins over the app's, and an environment variable
 * never overrides a config value, so options are the only way to change what
 * the receiver config sets (`pipelines/run/receive/rate/config.yaml`).
 *
 * The number itself comes from the rule in `fleet-default.ts`; this file only
 * writes it.
 */

import { EDGE_MANIFEST_IMAGE } from './runtime-image.js';
import { ALWAYS_PASS_LINES } from './report/user-units.js';
import { defaultErrorFloor, type FleetDefaultAction } from './fleet-default.js';

// First engine release whose receiver declares rateReceiverDefaultAction and k8sTeamLabel.
export const FLEET_DEFAULT_MIN_ENGINE = '1.1.141';

/** Levels the receiver config's floor list names; each is written so none falls back to the config's value. */
export const SEVERITY_FLOOR_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL', 'FATAL'] as const;
const ERROR_CLASS: ReadonlySet<string> = new Set(['ERROR', 'CRITICAL', 'FATAL']);

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The engine version an image ref pins (`log10x/edge-10x:1.1.136`), or undefined for a moving tag. */
export function imageEngineVersion(image: string): string | undefined {
  const tag = image.split('@')[0].split(':')[1];
  return tag && /^\d+(\.\d+){1,3}$/.test(tag) ? tag : undefined;
}

/** The engine release an install plan pins for the Receiver. */
export function manifestEngineVersion(): string | undefined {
  return imageEngineVersion(EDGE_MANIFEST_IMAGE);
}

export function engineReadsFleetDefault(version: string | undefined): boolean {
  return !!version && /^\d+(\.\d+){1,3}$/.test(version) && versionAtLeast(version, FLEET_DEFAULT_MIN_ENGINE);
}

export interface FleetDefaultInstall {
  /** Bytes per reset window per node, from `fleetDefaultNumber`. */
  capBytesPerWindowPerNode: number;
  action: FleetDefaultAction;
  /** Share of ERROR and CRITICAL lines above the limit kept in Standard. Default by action. */
  errorFloor?: number;
}

function num(v: number): string {
  return String(Number(v.toFixed(6)));
}

/**
 * The fleet default's options, in launch order. The floor list repeats its
 * option once per level (doc.log10x.com/config/cli, "List Arguments"). Every
 * level is named, so the outcome is the same whether the command line adds to
 * the config's list or replaces it: the engine builds the floor map with a
 * put per entry (`EventMapFunctionFactory.map`), so the last value of a
 * level wins. `rateReceiverMinRetentionThreshold 0` makes a 0 floor hold even
 * where the receiver script reads a 0 floor as unset.
 */
export function fleetDefaultEngineOptions(fd: FleetDefaultInstall): Array<[string, string]> {
  const f = Math.min(1, Math.max(0, fd.errorFloor ?? defaultErrorFloor(fd.action)));
  return [
    ['rateReceiverAbsoluteCap', String(Math.max(1, Math.round(fd.capBytesPerWindowPerNode)))],
    ['rateReceiverDefaultAction', fd.action],
    ['rateReceiverMinSharePercent', '0'],
    ['rateReceiverWarmupMs', '0'],
    ['rateReceiverBaselineCount', String(ALWAYS_PASS_LINES)],
    ['rateReceiverMinRetentionThreshold', '0'],
    ...SEVERITY_FLOOR_LEVELS.map((l): [string, string] => ['rateReceiverSeverityFloors', `${l}=${ERROR_CLASS.has(l) ? num(f) : '0'}`]),
  ];
}

/**
 * Environment the fleet default needs. `outputOffload` puts `routeState` on
 * every line the Receiver returns (config `pipelines/run/input/forwarder/
 * config.yaml`), which the Flex index filter and the forwarder's S3 branch
 * read. The config reads it through TenXEnv, which falls back to the
 * environment, and no module declares it as an option, so it is an env var.
 */
export const FLEET_DEFAULT_ENGINE_ENV: ReadonlyArray<[string, string]> = [['outputOffload', 'true']];

const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

/** A Kubernetes label key, or undefined. */
export function validTeamLabel(label: string | undefined): string | undefined {
  const l = label?.trim();
  return l && l.length <= 316 && LABEL_KEY.test(l) ? l : undefined;
}

export interface ReceiverFleetValues {
  /** Options after the app, in order. */
  options: Array<[string, string]>;
  /** Env vars on the Receiver container. */
  env: Array<[string, string]>;
  /** True when the fleet default's options are in `options`. */
  fleetDefaultWritten: boolean;
  /** True when `k8sTeamLabel` is in `options`. */
  teamLabelWritten: boolean;
  /** The engine release the gate read. */
  engineVersion?: string;
  /** One sentence per value held back, and why. */
  notes: string[];
}

/**
 * Everything a Receiver install adds for a Datadog fleet default and a team
 * label. `symbolMessageHashField tenx_hash` ships on every Datadog Receiver,
 * since index filters and monitors select a statement by `@tenx_hash`.
 * The fleet default and the team label ship only on an engine that declares
 * their options: an undeclared option fails the launch.
 */
export function receiverFleetValues(input: {
  datadog: boolean;
  fleetDefault?: FleetDefaultInstall;
  teamLabel?: string;
  engineVersion?: string;
}): ReceiverFleetValues {
  const engineVersion = input.engineVersion ?? manifestEngineVersion();
  const ready = engineReadsFleetDefault(engineVersion);
  const installs = engineVersion ? `this plan installs ${engineVersion}` : 'this plan installs an engine whose version is not pinned';
  const options: Array<[string, string]> = [];
  const env: Array<[string, string]> = [];
  const notes: string[] = [];
  if (input.datadog) options.push(['symbolMessageHashField', 'tenx_hash']);

  let fleetDefaultWritten = false;
  if (input.fleetDefault) {
    if (!(input.fleetDefault.capBytesPerWindowPerNode > 0)) {
      notes.push('No limit was given, so the plan writes no fleet default.');
    } else if (!ready) {
      notes.push(
        `The fleet default needs engine ${FLEET_DEFAULT_MIN_ENGINE} or later, the first that reads rateReceiverDefaultAction; ` +
          `${installs}, so it writes none of the fleet default's values, and a service with no rule keeps every statement in Standard.`,
      );
    } else {
      options.push(...fleetDefaultEngineOptions(input.fleetDefault));
      env.push(...FLEET_DEFAULT_ENGINE_ENV);
      fleetDefaultWritten = true;
    }
  }

  let teamLabelWritten = false;
  if (input.teamLabel !== undefined) {
    const label = validTeamLabel(input.teamLabel);
    if (!label) {
      notes.push(`"${input.teamLabel}" is not a Kubernetes label key, so the plan writes no team label.`);
    } else if (!ready) {
      notes.push(`The team label needs engine ${FLEET_DEFAULT_MIN_ENGINE} or later, the first that reads k8sTeamLabel; ${installs}, so it writes no team label.`);
    } else {
      options.push(['k8sTeamLabel', label]);
      teamLabelWritten = true;
    }
  }
  return { options, env, fleetDefaultWritten, teamLabelWritten, ...(engineVersion ? { engineVersion } : {}), notes };
}
