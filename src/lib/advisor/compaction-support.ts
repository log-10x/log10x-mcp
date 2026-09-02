/**
 * Can the install's destination read compacted events back?
 *
 * Compaction is a reversible in-place shrink: the Receiver rewrites each
 * event into an encoded form, and something on the DESTINATION side expands
 * it again at search or query time. That expander is a separate artifact
 * installed on the SIEM, not part of the helm release this advisor emits:
 * the 10x Splunk app, the l1es Elasticsearch/OpenSearch plugin, the 10x
 * ClickHouse view. Without it, compaction is lossless on disk and lossy to
 * the person running the search — which is the one failure the product's
 * headline claim cannot afford.
 *
 * So `optimize=true` carries a prerequisite the plan MUST state, and on
 * destinations that have no expander at all it is not a lever, it is damage.
 * The facts live in `lib/cost.ts` (`compact_mode`, `compact_requires`), which
 * the pricing path already renders per-lever; this module reads the same
 * models so the install path cannot drift from what the plan quoted.
 */

import { getDestinationCostModel } from '../cost.js';
import { SIEM_DISPLAY_NAMES } from '../siem/pricing.js';
import type { SiemId } from '../siem/pricing.js';
import type { OutputDestination } from './reporter-forwarders.js';

/**
 * Where the customer gets the expander. The MCP cannot resolve the artifact
 * itself: the plugin is built against an exact platform version
 * (`l1es-plugin-0.3.0.es.8.17.0.zip` and its OpenSearch twin), and we do not
 * know the version of a SIEM we never connected to. Point at the page that
 * carries the matrix rather than emit a download URL that may not match.
 */
const EXPANDER_DOCS: Partial<Record<OutputDestination, string>> = {
  splunk: 'https://doc.log10x.com/apps/receiver/compact/splunk/',
  elasticsearch: 'https://doc.log10x.com/apps/receiver/compact/elasticsearch/',
};

export type CompactionSupport =
  /** Destination expands compacted events, once its expander is installed. */
  | { kind: 'expander-required'; requires: string; docsUrl?: string }
  /** Destination cannot expand them at all — compaction here is unreadable. */
  | { kind: 'unsupported'; displayName: string }
  /** No real destination configured yet (the `mock` bench sink). */
  | { kind: 'no-destination' };

/**
 * What compaction means at this destination. `mock` is the advisor's default
 * when no destination is passed, so it gets its own answer rather than
 * falling into either real branch.
 */
export function compactionSupport(destination: OutputDestination): CompactionSupport {
  if (destination === 'mock') return { kind: 'no-destination' };

  const model = getDestinationCostModel(destination as SiemId);
  if (model.compact_mode === 'no-op') {
    return { kind: 'unsupported', displayName: SIEM_DISPLAY_NAMES[destination as SiemId] };
  }
  // Every non-no-op model in cost.ts carries compact_requires. Fall back to a
  // truthful generic rather than silently dropping the prerequisite if a new
  // destination lands there without one.
  return {
    kind: 'expander-required',
    requires: model.compact_requires ?? 'the matching 10x expander installed on the destination',
    docsUrl: EXPANDER_DOCS[destination],
  };
}

/**
 * The dependency stated without naming a destination.
 *
 * The install wizard does not ask where events go: the Receiver is a sidecar
 * that rides the customer's existing forwarder, and that forwarder still owns
 * the destination. So the plan it emits genuinely does not know which expander
 * applies, and saying "install the Splunk app" would be a guess. Name all
 * three and let the customer pick the row that matches their stack.
 */
export const EXPANDER_PREREQUISITE_GENERAL =
  'Compaction is only lossless end to end when the destination can expand the encoded events again at read time, ' +
  'and that expander is a separate install on the destination, not part of this release: ' +
  'the [10x Splunk app](https://doc.log10x.com/apps/receiver/compact/splunk/), ' +
  'the [l1es plugin](https://doc.log10x.com/apps/receiver/compact/elasticsearch/) for self-managed Elasticsearch 8.17.0 / OpenSearch 2.19.0, ' +
  'or the [10x ClickHouse view](https://doc.log10x.com/apps/receiver/compact/clickhouse/). ' +
  'Install it before you compact anything the destination is searched on, or those searches return compacted lines. ' +
  'Managed and serverless platforms (Datadog, CloudWatch, Elastic Cloud Serverless) have nowhere to install one — ' +
  'use tier_down or offload there instead of compaction.';
