/**
 * Per-vendor exact-match query on the `tenx_hash` field.
 *
 * When the input is a Symbol Message, tenxHash(symbolSequence) is
 * byte-identical to the engine's emitted tenx_hash (cross-language
 * contract, conformance-proven), so a 10x-powered forwarder ships this
 * exact value on every matching event. An exact field match beats
 * content-token phrase search: no escaping, no per-vendor query-syntax
 * gaps (notably the CloudWatch FilterLogEvents `@`-syntax issue), and
 * no false positives from token coincidence.
 *
 * Shared by pattern_examples (probe) and event_lookup (one-line live
 * sample on the reverse cross-pillar lookup).
 */
import type { SiemId } from './pricing.js';

export function buildHashQuery(
  vendor: SiemId,
  hash: string,
  service?: string,
  severity?: string,
): string {
  switch (vendor) {
    case 'splunk': {
      const parts = [`tenx_hash="${hash}"`];
      if (service) parts.push(`tenx_user_service="${service}"`);
      if (severity) parts.push(`severity_level="${severity}"`);
      return parts.join(' ');
    }
    case 'datadog': {
      const parts = [`@tenx_hash:${hash}`];
      if (service) parts.push(`service:${service}`);
      if (severity) parts.push(`status:${severity.toLowerCase()}`);
      return parts.join(' ');
    }
    case 'elasticsearch': {
      const parts = [`tenx_hash:"${hash}"`];
      if (service) parts.push(`service: "${service}"`);
      if (severity) parts.push(`severity: "${severity}"`);
      return parts.join(' AND ');
    }
    case 'cloudwatch': {
      // CloudWatch FilterLogEvents JSON selector — exact, no @message
      // term escaping. && for optional structural narrowing.
      const sel = [`$.tenx_hash = "${hash}"`];
      if (service) sel.push(`$.tenx_user_service = "${service}"`);
      if (severity) sel.push(`$.severity_level = "${severity}"`);
      return `{ ${sel.join(' && ')} }`;
    }
    default:
      return `tenx_hash="${hash}"`;
  }
}
