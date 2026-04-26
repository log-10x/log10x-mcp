/**
 * Auto-detect the `destination` argument for advise_install / advise_reducer /
 * advise_reporter from ambient SIEM credentials.
 *
 * The advisor `destination` enum (`mock | elasticsearch | splunk | datadog |
 * cloudwatch`) maps 1:1 onto the SIEM ids in the registry minus `mock` —
 * if the user has DD_API_KEY set we can reasonably default destination to
 * `datadog`. When multiple SIEMs are configured the caller gets an
 * ambiguous error so they pick explicitly. When nothing is configured we
 * preserve the legacy default of `mock` so users running advise_* against
 * a fresh discovery snapshot don't hit a hard error.
 */

import { resolveSiemSelection, formatAmbiguousError } from '../siem/resolve.js';
import type { SiemId } from '../siem/pricing.js';

export type AdvisorDestination = 'mock' | 'elasticsearch' | 'splunk' | 'datadog' | 'cloudwatch';

const ADVISOR_DEST_SIEMS: SiemId[] = ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'];

export type DestResolution =
  | { kind: 'resolved'; destination: AdvisorDestination; note?: string }
  | { kind: 'ambiguous'; markdown: string };

export async function resolveAdvisorDestination(
  explicit: AdvisorDestination | string | undefined
): Promise<DestResolution> {
  if (explicit) {
    return { kind: 'resolved', destination: explicit as AdvisorDestination };
  }
  const r = await resolveSiemSelection({ restrictTo: ADVISOR_DEST_SIEMS });
  if (r.kind === 'none') {
    // Preserve legacy default — `mock` keeps advise_* working out of the box.
    return { kind: 'resolved', destination: 'mock' };
  }
  if (r.kind === 'ambiguous') {
    return { kind: 'ambiguous', markdown: formatAmbiguousError(r.candidates, 'destination') };
  }
  // The 4 supported SIEM ids ARE the destination enum values for those vendors.
  return {
    kind: 'resolved',
    destination: r.id as AdvisorDestination,
    note: r.note,
  };
}
