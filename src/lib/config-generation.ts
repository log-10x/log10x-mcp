/**
 * Config-generation closed loop — verify the running engine is executing the
 * exact cap policy the MCP wrote, not just that a PR merged or a ConfigMap was
 * applied.
 *
 * The MCP writes `caps.csv` into the cap ConfigMap. This module derives a short
 * deterministic GENERATION id from that policy and writes it as a sibling
 * `config-generation.csv` key. The engine's custom initializer reads it and
 * stamps every event with `tenx_config_version=<generation>`, which rides the
 * summary metrics as a Prometheus label (proven live on the demo). So the
 * running engine advertises which policy generation it loaded.
 *
 * Verification is STATELESS: the generation is a hash of the policy, so the
 * verifier recomputes the expected generation from the CURRENT cap ConfigMap and
 * compares it to the label the engine advertises. Match => the engine is running
 * the current policy. Mismatch => the write happened but the engine hasn't picked
 * it up (still polling, not reloaded, or crash-looping) — changes written, not
 * live. This is the control-plane twin of the offload delivery verifier: it
 * confirms the OUTCOME (policy is live), not just the intent (policy was written).
 */

import { createHash } from 'node:crypto';

/**
 * Deterministic short generation id for a cap policy. Hash of the policy text so
 * it changes iff the policy changes; identical policies map to the same id (a
 * re-apply of the same caps is genuinely the same generation).
 */
export function computeGeneration(capsCsv: string): string {
  return createHash('sha256').update(capsCsv, 'utf8').digest('hex').slice(0, 12);
}

/**
 * The `config-generation.csv` body the engine's custom initializer reads
 * (`TenXLookup.get("config-generation", "generation", "key", "value")`). Two
 * columns with a header, mirroring caps.csv's shape.
 */
export function renderGenerationCsv(generation: string): string {
  return `key,value\ngeneration,${generation}\n`;
}

export type ConfigLiveVerdict =
  | 'live'           // a running engine advertises the current policy generation
  | 'stale'          // engine advertises a generation, but not the current policy's
  | 'unverified'     // no generation label observed (not deployed w/ stamp, or no metrics)
  | 'not_configured'; // no cap policy to verify

export interface ConfigLiveResult {
  verdict: ConfigLiveVerdict;
  /** Hash of the current cap policy — what SHOULD be live. */
  expected_generation: string | null;
  /** Generation(s) the running engine(s) advertise on the wire. */
  running_generations: string[];
  message: string;
}

export interface ConfigLiveDeps {
  /** Current caps.csv from the cap ConfigMap (what the MCP last wrote). null if absent. */
  readCapsCsv(): Promise<string | null>;
  /**
   * The set of `tenx_config_version` label values active in the recent window.
   * A set (not one value) so a rollover with old+new pods lingering is handled:
   * `live` as soon as the expected generation appears, even before old pods cycle.
   */
  readRunningGenerations(): Promise<string[]>;
}

export async function verifyConfigGeneration(deps: ConfigLiveDeps): Promise<ConfigLiveResult> {
  let caps: string | null;
  try {
    caps = await deps.readCapsCsv();
  } catch {
    caps = null;
  }
  if (!caps || !caps.trim()) {
    return {
      verdict: 'not_configured',
      expected_generation: null,
      running_generations: [],
      message: 'No cap policy in the cap ConfigMap; nothing to verify.',
    };
  }

  const expected = computeGeneration(caps);

  let running: string[];
  try {
    running = (await deps.readRunningGenerations()).filter((g) => typeof g === 'string' && g.length > 0);
  } catch {
    running = [];
  }

  // Ignore the bootstrap placeholder + the no-lookup fallback so they read as
  // "not stamped with a real generation" rather than a spurious stale.
  const real = running.filter((g) => g !== 'unset' && g !== 'bootstrap');

  if (real.length === 0) {
    return {
      verdict: 'unverified',
      expected_generation: expected,
      running_generations: running,
      message:
        `Cap policy generation is ${expected}, but no engine advertises a tenx_config_version generation ` +
        `(the version-stamp config is not deployed, the metric backend is unavailable, or the engine has not ` +
        `published since the last write). Policy is written; liveness unconfirmed.`,
    };
  }

  if (real.includes(expected)) {
    const others = real.filter((g) => g !== expected);
    return {
      verdict: 'live',
      expected_generation: expected,
      running_generations: real,
      message:
        `The running engine is executing the current cap policy — generation ${expected} is live on the wire` +
        `${others.length ? ` (a rollover is still draining ${others.join(', ')})` : ''}.`,
    };
  }

  return {
    verdict: 'stale',
    expected_generation: expected,
    running_generations: real,
    message:
      `The running engine advertises generation ${real.join(', ')}, but the current cap policy hashes to ` +
      `${expected}. The engine has NOT picked up the latest policy (still polling, not reloaded, or crash-looping). ` +
      `Changes are written but not live — do not report them as realized yet.`,
  };
}
