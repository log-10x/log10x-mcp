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

// First engine release whose receiver declares rateReceiverKeepCounts,
// rateReceiverUnit and rateReceiverTotalLookupFile.
export const CEILING_MIN_ENGINE = '1.1.146';

/** Error lines over a limit that still pass, per statement per node per window. */
export const KEEP_COUNT_DEFAULT = 50;
/**
 * Keep-count lines a service with a total passes past it, per node per window
 * (receiver config `keepMaxOverTotal`); within the total they count like any
 * line. 0 removes the bound. A service with no total keeps the per-statement
 * count alone.
 */
export const KEEP_MAX_OVER_TOTAL_DEFAULT = 500;

/**
 * Keep-count lines per node per window for each error statement of one
 * service with a total. Each asks for up to `keepCount` of its lines past the
 * always-pass sample (`want`); the service passes at most `keepMax` of them,
 * shared evenly, no statement given more than it asks. The sum is
 * min(sum of asks, keepMax): min(50 x error statements, 500) when each sends
 * 55 lines a window or more.
 */
export function keepLinesPerStatement(want: number[], keepCount: number, keepMax: number = KEEP_MAX_OVER_TOTAL_DEFAULT): number[] {
  const asks = want.map((w) => Math.max(0, Math.min(keepCount, Number.isFinite(w) ? w : 0)));
  if (!(keepMax > 0) || asks.reduce((a, x) => a + x, 0) <= keepMax) return asks;
  const out = asks.map(() => 0);
  let left = keepMax;
  let n = asks.length;
  for (const i of asks.map((_, j) => j).sort((a, b) => asks[a] - asks[b])) {
    out[i] = Math.min(asks[i], left / n);
    left -= out[i];
    n--;
  }
  return out;
}
/** The returned record's fields for the hot-tier run: identity, route, name, level and the counted size. */
export const ELASTIC_HOT_TIER_FIELDS = 'fullText("tenx_hash","routeState","message_pattern","severity_level","utf8Size")';

/** Levels the receiver config's floor list names; each is written so none falls back to the config's value. */
export const SEVERITY_FLOOR_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL', 'FATAL'] as const;
export const ERROR_CLASS_LEVELS = ['ERROR', 'CRITICAL', 'FATAL'] as const;
const ERROR_CLASS: ReadonlySet<string> = new Set(ERROR_CLASS_LEVELS);

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

export function engineReadsCeiling(version: string | undefined): boolean {
  return !!version && /^\d+(\.\d+){1,3}$/.test(version) && versionAtLeast(version, CEILING_MIN_ENGINE);
}

export interface FleetDefaultInstall {
  /** Bytes per reset window per node, from `fleetDefaultNumber`. */
  capBytesPerWindowPerNode: number;
  /** The same limit in lines per reset window per node, for a Receiver that counts events. */
  capEventsPerWindowPerNode?: number;
  action: FleetDefaultAction;
  /** Share of ERROR and CRITICAL lines above the limit kept in Standard. Default by action. */
  errorFloor?: number;
}

function num(v: number): string {
  return String(Number(v.toFixed(6)));
}

/**
 * The regulator values every Datadog Receiver install writes, in launch
 * order: no warm-up, no share guard, the always-pass sample, and a 0 floor
 * on every non-error level. The floor list repeats its option once per level
 * (doc.log10x.com/config/cli, "List Arguments"). Every level is named, so the
 * outcome is the same whether the command line adds to the config's list or
 * replaces it: the engine builds the floor map with a put per entry
 * (`EventMapFunctionFactory.map`), so the last value of a level wins.
 * `rateReceiverMinRetentionThreshold 0` makes a 0 floor hold even where the
 * receiver script reads a 0 floor as unset.
 *
 * With `keepCount` (engines that declare `rateReceiverKeepCounts`), the error
 * levels pass that many lines over the limit per statement per node per
 * window, and their share floor is 0; without it they keep `errorFloor`.
 */
export function regulatorEngineOptions(opts: { errorFloor: number; keepCount?: number }): Array<[string, string]> {
  const f = Math.min(1, Math.max(0, Number.isFinite(opts.errorFloor) ? opts.errorFloor : 0));
  const k = opts.keepCount !== undefined ? Math.max(0, Math.round(opts.keepCount)) : undefined;
  const errorFloor = k !== undefined ? 0 : f;
  return [
    ['rateReceiverMinSharePercent', '0'],
    ['rateReceiverWarmupMs', '0'],
    ['rateReceiverBaselineCount', String(ALWAYS_PASS_LINES)],
    ['rateReceiverMinRetentionThreshold', '0'],
    ...SEVERITY_FLOOR_LEVELS.map((l): [string, string] => ['rateReceiverSeverityFloors', `${l}=${ERROR_CLASS.has(l) ? num(errorFloor) : '0'}`]),
    ...(k !== undefined ? ERROR_CLASS_LEVELS.map((l): [string, string] => ['rateReceiverKeepCounts', `${l}=${k}`]) : []),
  ];
}

/** The fleet default's options, in launch order: its limit and action, then the regulator values. */
export function fleetDefaultEngineOptions(fd: FleetDefaultInstall, keepCount?: number): Array<[string, string]> {
  return [
    ['rateReceiverAbsoluteCap', String(Math.max(1, Math.round(fd.capBytesPerWindowPerNode)))],
    ['rateReceiverDefaultAction', fd.action],
    ...regulatorEngineOptions({ errorFloor: fd.errorFloor ?? defaultErrorFloor(fd.action), keepCount }),
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
  /** True when the regulator values (no warm-up, no share guard, 0 non-error floors) are in `options`. */
  regulatorValuesWritten: boolean;
  /** True when `rateReceiverKeepCounts` is in `options`. */
  keepCountsWritten: boolean;
  /** True when `rateReceiverUnit events` is in `options`. */
  eventsUnitWritten: boolean;
  /** The count written in `rateReceiverKeepCounts`, when written. */
  keepCount?: number;
  /** The share floor written on the error levels. */
  errorFloor?: number;
  /** The engine release the gate read. */
  engineVersion?: string;
  /** One sentence per value held back, and why. */
  notes: string[];
}

/**
 * Everything a Receiver install adds for Datadog: `symbolMessageHashField
 * tenx_hash` (index filters and monitors select a statement by `@tenx_hash`),
 * the regulator values, the error keep count, the fleet default and the team
 * label. Each ships only on an engine that declares its options: an
 * undeclared option fails the launch.
 */
export function receiverFleetValues(input: {
  datadog: boolean;
  fleetDefault?: FleetDefaultInstall;
  teamLabel?: string;
  engineVersion?: string;
  /** Error lines over a limit that pass per statement per node per window. Default 50. */
  keepCount?: number;
  /** True when any service sends its excess to S3, which sets the error floor on engines without keep counts. */
  anyOffload?: boolean;
  /**
   * `events`: limits and totals count lines, not bytes (Datadog bills
   * Standard per event). Default `events` for a Datadog Receiver on engine
   * 1.1.146 or later, `bytes` otherwise.
   */
  unit?: 'bytes' | 'events';
  /**
   * A ClickHouse Receiver the rows run holds: limits and totals count lines
   * (rateReceiverUnit events), and each returned record carries tenx_hash.
   */
  clickhouseRows?: boolean;
  /**
   * An Elasticsearch Receiver the hot-tier run holds: each returned record
   * carries `tenx_hash`, `routeState`, `message_pattern`, `severity_level`
   * and `utf8Size` (the size the byte limits count), which the run sums from
   * the Receiver's indices. Not with compact: it replaces the output field
   * list compact encodes with.
   */
  elasticHotTier?: boolean;
}): ReceiverFleetValues {
  const engineVersion = input.engineVersion ?? manifestEngineVersion();
  const ready = engineReadsFleetDefault(engineVersion);
  const ceiling = engineReadsCeiling(engineVersion);
  const installs = engineVersion ? `this plan installs ${engineVersion}` : 'this plan installs an engine whose version is not pinned';
  const options: Array<[string, string]> = [];
  const env: Array<[string, string]> = [];
  const notes: string[] = [];
  if (input.datadog || input.clickhouseRows || input.elasticHotTier) options.push(['symbolMessageHashField', 'tenx_hash']);
  if (input.elasticHotTier) options.push(['outputEncodeField', ELASTIC_HOT_TIER_FIELDS]);
  const keepCount = input.datadog && ceiling ? Math.max(0, Math.round(input.keepCount ?? KEEP_COUNT_DEFAULT)) : undefined;

  // Datadog bills Standard per event, so a Datadog Receiver on an engine that
  // reads rateReceiverUnit counts events unless the caller asks for bytes.
  const unit = input.unit ?? ((input.datadog || input.clickhouseRows) && ceiling ? 'events' : 'bytes');
  let eventsUnitWritten = false;
  if ((input.datadog || input.clickhouseRows) && unit === 'events') {
    if (ceiling) {
      options.push(['rateReceiverUnit', 'events']);
      eventsUnitWritten = true;
    } else {
      notes.push(
        `Counting limits in lines (rateReceiverUnit events) needs engine ${CEILING_MIN_ENGINE} or later; ${installs}, so limits stay in bytes and the budget run must not hold this install.`,
      );
    }
  }

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
      const fd = fleetDefaultEngineOptions(
        {
          ...input.fleetDefault,
          errorFloor:
            input.fleetDefault.errorFloor ??
            defaultErrorFloor(input.anyOffload || input.fleetDefault.action === 'offload' ? 'offload' : 'tier_down'),
        },
        keepCount,
      );
      // With limits in lines the fleet limit is written in lines when the
      // caller has that number; a byte number is never written as lines.
      const events = input.fleetDefault.capEventsPerWindowPerNode;
      if (!eventsUnitWritten) {
        options.push(...fd);
      } else if (events !== undefined && events > 0) {
        options.push(...fd.map(([k, v]): [string, string] => (k === 'rateReceiverAbsoluteCap' ? [k, String(Math.max(1, Math.round(events)))] : [k, v])));
      } else {
        options.push(...fd.filter(([k]) => k !== 'rateReceiverAbsoluteCap'));
        notes.push(
          'Limits count lines and the fleet default came in bytes only, so no fleet limit is written: pass `fleet_default.cap_events_per_window_per_node` (log10x_configure_engine returns it), or let the budget run\'s `*` row set it.',
        );
      }
      env.push(...FLEET_DEFAULT_ENGINE_ENV);
      fleetDefaultWritten = true;
    }
  }

  let regulatorValuesWritten = fleetDefaultWritten;
  if (input.datadog && !fleetDefaultWritten) {
    if (!ready) {
      notes.push(
        `The regulator values (no warm-up, no share guard, a 0 floor below ERROR) need engine ${FLEET_DEFAULT_MIN_ENGINE} or later; ${installs}, so the receiver config's values apply.`,
      );
    } else {
      options.push(...regulatorEngineOptions({ errorFloor: input.anyOffload ? defaultErrorFloor('offload') : defaultErrorFloor('tier_down'), keepCount }));
      regulatorValuesWritten = true;
    }
  }
  const keepCountsWritten = regulatorValuesWritten && keepCount !== undefined;
  const floorEntry = options.find(([k, v]) => k === 'rateReceiverSeverityFloors' && v.startsWith('ERROR='));
  const errorFloor = floorEntry ? Number(floorEntry[1].slice('ERROR='.length)) : undefined;
  if (input.datadog && regulatorValuesWritten && keepCount === undefined) {
    notes.push(
      `Error lines over a limit pass at a fixed count (rateReceiverKeepCounts) from engine ${CEILING_MIN_ENGINE}; ${installs}, so they pass at the error floor's share instead.`,
    );
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
  return {
    options,
    env,
    fleetDefaultWritten,
    teamLabelWritten,
    regulatorValuesWritten,
    keepCountsWritten,
    eventsUnitWritten,
    ...(keepCountsWritten ? { keepCount } : {}),
    ...(errorFloor !== undefined ? { errorFloor } : {}),
    ...(engineVersion ? { engineVersion } : {}),
    notes,
  };
}
