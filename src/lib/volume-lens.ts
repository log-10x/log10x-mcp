/**
 * Volume projection lens — "what would this look like at <N> GB/month?"
 *
 * Complement to the SIEM lens (lib/siem/lens.ts). The SIEM lens reprices the
 * SAME real volumes at a different destination and NEVER touches volume. The
 * volume lens does the opposite: it scales the real per-pattern volume basis
 * to a caller-stated monthly volume, holding every per-pattern SHARE, trend,
 * and pattern identity fixed. Only absolute magnitudes (bytes, dollars,
 * savings) move, by one uniform factor, so coverage_pct and shares are
 * unchanged by construction.
 *
 * This is a PROJECTION, not a measurement. It answers "model my environment at
 * 5 TB/mo" for a prospect on the small demo env, and "what happens to my bill
 * if I grow 3x" for a user on a real env. It is general, not a demo hack.
 *
 * Honesty contract (enforced by callers): a lensed run ALWAYS stamps
 * volume_actual_gb / volume_projected_gb / volume_scale_factor and surfaces the
 * projection note, so a receipt reader can see the numbers were scaled from
 * real ones. The pattern MIX is still the environment's own measured mix; the
 * note says so and points at the POC for the caller's real patterns.
 */

const GB = 1_000_000_000; // decimal GB — matches estimate-savings + vendor billing

export interface VolumeLensResolution {
  /** The environment's real monthly bytes (the measured basis). null when unknown/zero. */
  actual_monthly_bytes: number | null;
  /** The caller's stated monthly bytes (actual × factor). null when not lensed. */
  projected_monthly_bytes: number | null;
  /** Uniform multiplier applied to every absolute magnitude. 1 when not lensed. */
  factor: number;
  /** True iff a positive monthly_volume_gb was supplied AND a real basis existed. */
  lensed: boolean;
  /** Why the lens is / isn't active. */
  basis: 'requested' | 'none' | 'no_basis';
  /** One-line, render-ready provenance note when lensed (or when a request had no basis); null otherwise. */
  disclosure: string | null;
}

/** Compact GB/TB/MB label for disclosure prose. */
function fmtVol(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(gb >= 10000 ? 0 : 1)} TB`;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(gb * 1000)} MB`;
}

/**
 * Resolve the volume projection for a tool run.
 *
 * @param requestedMonthlyGb  the tool's `monthly_volume_gb` arg (decimal GB/month)
 * @param actualMonthlyBytes  the environment's measured monthly bytes (the basis to scale)
 */
export function resolveVolumeLens(
  requestedMonthlyGb: number | undefined | null,
  actualMonthlyBytes: number,
): VolumeLensResolution {
  const hasReq =
    typeof requestedMonthlyGb === 'number' && Number.isFinite(requestedMonthlyGb) && requestedMonthlyGb > 0;
  const hasBasis = Number.isFinite(actualMonthlyBytes) && actualMonthlyBytes > 0;

  if (!hasReq) {
    return {
      actual_monthly_bytes: hasBasis ? actualMonthlyBytes : null,
      projected_monthly_bytes: null,
      factor: 1,
      lensed: false,
      basis: 'none',
      disclosure: null,
    };
  }
  if (!hasBasis) {
    // Caller asked to project but the env reported no volume to scale from.
    return {
      actual_monthly_bytes: null,
      projected_monthly_bytes: null,
      factor: 1,
      lensed: false,
      basis: 'no_basis',
      disclosure:
        'Volume projection requested, but the environment reported no measured volume to scale from. Showing unscaled numbers.',
    };
  }

  const projected = (requestedMonthlyGb as number) * GB;
  const factor = projected / actualMonthlyBytes;
  const actualGb = actualMonthlyBytes / GB;
  const disclosure =
    `Projection: scaled from the environment's measured ${fmtVol(actualGb)}/mo to your stated ` +
    `${fmtVol(requestedMonthlyGb as number)}/mo (x${factor >= 10 ? factor.toFixed(0) : factor.toFixed(1)}). ` +
    `Per-pattern shares and the pattern mix are the environment's real measurements; only absolute volume ` +
    `and dollars are modeled at your stated scale. Run the POC on your own stack for your actual patterns.`;

  return {
    actual_monthly_bytes: actualMonthlyBytes,
    projected_monthly_bytes: projected,
    factor,
    lensed: true,
    basis: 'requested',
    disclosure,
  };
}

/** source_disclosure stamp for a lensed run (empty object when not lensed). */
export function volumeLensDisclosure(res: VolumeLensResolution): Record<string, unknown> {
  if (!res.lensed) return {};
  return {
    volume_actual_gb: res.actual_monthly_bytes != null ? +(res.actual_monthly_bytes / GB).toFixed(3) : null,
    volume_projected_gb: res.projected_monthly_bytes != null ? +(res.projected_monthly_bytes / GB).toFixed(3) : null,
    volume_scale_factor: +res.factor.toFixed(4),
    volume_projection_note: res.disclosure,
  };
}
