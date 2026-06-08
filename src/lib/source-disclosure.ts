/**
 * source-disclosure.ts — helper for building the `source_label` field on
 * ChassisEnvelope `source_disclosure` blocks.
 *
 * WHY THIS EXISTS
 *
 * `siem_vendor` alone is ambiguous: a customer with two Datadog orgs and a
 * legacy CloudWatch account has three different "Datadogs" the tool could
 * be talking about. `source_label` carries the cheap disambiguators every
 * tool already has in scope — env nickname, region, account, endpoint URL
 * — so an agent or reader can tell "which Datadog" without re-running the
 * envelope.
 *
 * USAGE — direct construction (when the tool only has loose context):
 *
 *   import { buildSourceLabel } from '../lib/source-disclosure.js';
 *
 *   source_disclosure: {
 *     siem_vendor: 'datadog',
 *     source_label: buildSourceLabel('datadog', {
 *       nickname: env?.nickname,
 *       endpoint: env?.metricsBackend?.endpoint,
 *     }),
 *   }
 *
 * USAGE — env-driven construction (when the tool wants to populate both
 * siem_vendor and source_label from a single EnvConfig + env-config doc):
 *
 *   import { buildSourceDisclosureFromEnv } from '../lib/source-disclosure.js';
 *
 *   const disclosure = await buildSourceDisclosureFromEnv(env, 'datadog');
 *   // → { siem_vendor: 'datadog', source_label: 'datadog [prod-us | us-east-1 | api.datadoghq.com]' }
 *
 *   source_disclosure: { ...disclosure, bytes_source: 'tsdb' }
 *
 * The label format is deliberately stable so renderers can split on the
 * vendor prefix and inspect the bracketed hints without parsing prose.
 */

import type { EnvConfig } from './environments.js';
import { resolveClusterConfig } from './env-config/resolve-cluster-config.js';
import type { SourceDisclosure } from './chassis-envelope.js';

/**
 * Optional disambiguation hints. All fields are optional because tools
 * surface different subsets of the cluster identity. Empty / whitespace
 * values are dropped before assembly.
 */
export interface SourceLabelHints {
  /** Human-readable env nickname (e.g. "prod-us", "staging"). */
  nickname?: string | null;
  /** Cloud region (e.g. "us-east-1", "eu-west-2"). */
  region?: string | null;
  /** Cloud account / project / subscription identifier. */
  account?: string | null;
  /** Backend endpoint URL — `metricsBackend.endpoint`, SIEM ingest URL, etc. */
  endpoint?: string | null;
}

/**
 * Format a single-line `source_label` from a vendor name and hint set.
 *
 * Returns just the vendor name when no hints are populated (so the caller
 * doesn't have to branch on "do I have anything to disambiguate with").
 * When at least one hint is present, format is `vendor [hint1 | hint2 |
 * hint3]` with hints appearing in declaration order (nickname, region,
 * account, endpoint).
 *
 * Endpoint URLs are passed through verbatim — callers that want to strip
 * a path or trim a scheme should do so before passing in.
 */
export function buildSourceLabel(
  vendor: string,
  hints: SourceLabelHints = {},
): string {
  const parts: string[] = [];
  const push = (v: string | null | undefined) => {
    if (typeof v !== 'string') return;
    const trimmed = v.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  };
  push(hints.nickname);
  push(hints.region);
  push(hints.account);
  push(hints.endpoint);
  if (parts.length === 0) return vendor;
  return `${vendor} [${parts.join(' | ')}]`;
}

/**
 * One-stop helper for tools that have an `EnvConfig` in scope and want a
 * fully-populated `source_disclosure` slice with `siem_vendor` + `source_label`.
 *
 * Resolves the env-config document via the standard cluster-config chain
 * (k8s ConfigMap → AWS SSM → GCP SM → Azure AC → local file → env-var
 * fallback). Cluster identity (region, account) and SIEM destination
 * (ingest_url) come from the resolved doc; nickname falls back to the
 * EnvConfig's own nickname when the cluster-config resolution fails (which
 * is fine for dev / local-paste flows where the tool has no on-prem store
 * to read from).
 *
 * When `siemVendor` is omitted, falls back to the resolved env-config's
 * `destination.siem_vendor` field — the same vendor configure_engine
 * persisted to disk. Both surfaces remain optional on the returned
 * disclosure so a caller can spread the result into a wider object that
 * sets `bytes_source` / `rate_source` / etc. without conflict.
 */
export async function buildSourceDisclosureFromEnv(
  env: EnvConfig | undefined,
  siemVendor?: string | null,
  opts: { envIdOrNickname?: string } = {},
): Promise<Pick<SourceDisclosure, 'siem_vendor' | 'source_label'>> {
  const hints: SourceLabelHints = {
    nickname: env?.nickname,
    endpoint: env?.metricsBackend?.endpoint,
  };

  let resolvedVendor: string | undefined = siemVendor ?? undefined;

  try {
    const resolved = await resolveClusterConfig({
      envIdOrNickname: opts.envIdOrNickname ?? env?.nickname,
    });
    if (resolved.ok) {
      // Cluster identity wins over EnvConfig.nickname; if the resolved
      // doc names itself differently from the laptop's loose label, the
      // on-prem doc is authoritative.
      hints.nickname = resolved.config.nickname || hints.nickname;
      hints.region = resolved.config.cluster.region ?? null;
      hints.account =
        resolved.config.cluster.account ??
        resolved.config.cluster.project_id ??
        resolved.config.cluster.subscription ??
        null;
      // Prefer the SIEM-side ingest URL (where the customer actually
      // routes logs) over the metrics-backend URL (where the MCP reads
      // counters). Falls back to metricsBackend when ingest_url is unset.
      hints.endpoint =
        resolved.config.destination.ingest_url ?? hints.endpoint;
      if (!resolvedVendor) {
        resolvedVendor = resolved.config.destination.siem_vendor;
      }
    }
  } catch {
    // Resolution is best-effort — when the on-prem store is unreachable
    // we still emit `source_label` from the EnvConfig hints above.
  }

  const out: Pick<SourceDisclosure, 'siem_vendor' | 'source_label'> = {};
  if (resolvedVendor) {
    out.siem_vendor = resolvedVendor;
    out.source_label = buildSourceLabel(resolvedVendor, hints);
  } else if (hints.nickname || hints.region || hints.account || hints.endpoint) {
    // No vendor but still useful disambiguation — emit `log10x` as a
    // neutral label so the bracketed hints make it through. Matches
    // the cost-options "siemDetected ?? 'log10x'" pattern in the survey.
    out.source_label = buildSourceLabel('log10x', hints);
  }
  return out;
}
