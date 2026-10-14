/**
 * The Receiver's unit for a cap: the bytes its rate regulator counts.
 *
 * The regulator charges each event `utf8Size()` of the record as it arrives
 * from the forwarder: the compact JSON with its metadata (the `kubernetes`
 * map, the stream, the forwarder's own fields), not the log payload alone.
 * A multi-line event is one record, its continuation lines joined into the
 * head record's payload. Measured on the containment demo's quiet capture:
 * the grouped record of otel-collector's `Error scraping metrics` peaked at
 * 7,811 bytes in a window where its payload came to about 5,900, and
 * astronomy-db's one-line `FATAL: role "root" does not exist` is 250 bytes a
 * record against a 69-byte payload.
 *
 * Measured when the capture carries the forwarder's records (file mode on
 * forwarder JSON lines). Otherwise, for a kubectl sample or events read back
 * from a SIEM's API, each record is the payload plus an assumed metadata
 * size, stated in the plan.
 */

/** The regulator's reset window (`rateReceiverResetIntervalMs` 240000). */
export const RECEIVER_WINDOW_SECONDS = 240;

/**
 * Forwarder metadata assumed per record when the capture does not carry the
 * forwarder's records: the median of a 41,694-record EKS capture through
 * Fluent Bit's kubernetes filter (p10 693, p90 775 bytes).
 */
export const ASSUMED_RECORD_OVERHEAD_BYTES = 760;

/** Bytes of a string as a JSON string body: escaped, UTF-8, no quotes. */
export function jsonStringBodyBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
}

/** Bytes of a record as compact JSON, the form the regulator sizes. */
export function compactRecordBytes(rec: unknown): number {
  return Buffer.byteLength(JSON.stringify(rec), 'utf8');
}

export type ReceiverBytesBasis = 'records' | 'assumed_overhead';

/**
 * How the caps' unit was reached, in one sentence for the plan. `overhead` is
 * the assumed metadata per record on the assumed path.
 */
export function receiverBytesStatement(basis: ReceiverBytesBasis | undefined, overhead?: number): string {
  if (basis === 'records') {
    return 'Limits are in the Receiver\'s unit, measured on the forwarder\'s records in this capture: each record as it arrives, metadata included, continuation lines joined.';
  }
  const o = (overhead ?? ASSUMED_RECORD_OVERHEAD_BYTES).toLocaleString('en-US');
  return (
    `Limits are in the Receiver's unit, each record as it arrives with its metadata. This capture carries the log text ` +
    `only, so each record is counted as its text plus ${o} bytes of forwarder metadata, the median a Fluent Bit ` +
    `kubernetes record carried on an EKS capture. A file of the forwarder's own records gives the measured figure.`
  );
}
