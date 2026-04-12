/**
 * Cost calculation helpers.
 *
 * Converts bytes to dollars using the analyzer cost per GB.
 * Matches the formula in SlackPatternService.java.
 */

const GB = 1024 * 1024 * 1024;

/** Convert bytes to cost in dollars at the given $/GB rate. */
export function bytesToCost(bytes: number, costPerGb: number): number {
  return (bytes / GB) * costPerGb;
}

/** Convert bytes to GB. */
export function bytesToGb(bytes: number): number {
  return bytes / GB;
}

/** Parse a Prometheus value (always a string) to a number. */
export function parsePrometheusValue(result: { value?: [number, string] }): number {
  if (!result.value || result.value.length < 2) return 0;
  const val = parseFloat(result.value[1]);
  return isNaN(val) ? 0 : val;
}
