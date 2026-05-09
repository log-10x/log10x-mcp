/**
 * Log sampler — fetches real log lines from the OTel demo's public S3
 * sample, the same data the demo's log-simulator replays at 1000 eps.
 *
 * Why this exists: cross-validation of the templater + pattern matcher
 * needs REAL log lines as input. Without them we can only test "the
 * tool ran without crashing"; with them we can ask "did
 * resolve_batch's templateHash for line X actually appear in the
 * Prometheus metrics for the live env?" — which is the most direct
 * test of the whole pipeline (forwarder + reporter + Prometheus +
 * MCP) end-to-end.
 *
 * The sample is 215 MB total. We fetch a small range (default ~2 MB)
 * via HTTP Range and parse JSON-per-line, yielding the inner `log`
 * string (the actual log message) and namespace/container metadata.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PUBLIC_SAMPLE_URL =
  'https://log10x-public-assets.s3.amazonaws.com/samples/otel-k8s/large/input/otel-sample.log';

export interface SampledLine {
  /** Inner log message — what the templater templatizes. */
  log: string;
  /** Source namespace (k8s). */
  namespace: string;
  /** Source container. */
  container: string;
  /** Source pod. */
  pod: string;
  /** Stream (stdout / stderr). */
  stream: string;
}

/**
 * Fetch a sample slice from the public OTel demo log. Default offset
 * skews toward the middle of the file to avoid the deterministic
 * startup-burst patterns that dominate the first MB.
 *
 * The S3 object's Last-Modified is fixed (2026-02-08) so the same
 * offset+length always returns the same bytes — sampling is
 * reproducible across runs.
 */
export async function sampleLogs(
  opts: {
    /** Byte offset to start from (default 50 MB into the file). */
    offset?: number;
    /** Bytes to fetch (default 2 MB). */
    length?: number;
    /** Max parsed lines to return. */
    maxLines?: number;
    /** Filter to a specific k8s namespace (default: any). */
    namespace?: string;
    /** Filter to a specific container (default: any). */
    container?: string;
  } = {}
): Promise<SampledLine[]> {
  const offset = opts.offset ?? 50_000_000;
  const length = opts.length ?? 2_000_000;
  const maxLines = opts.maxLines ?? 200;

  const res = await fetch(PUBLIC_SAMPLE_URL, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`S3 sample fetch HTTP ${res.status}`);
  }
  const body = await res.text();

  const lines = body.split('\n');
  // Drop the first and last lines — they are likely partial.
  const usable = lines.slice(1, -1);

  const out: SampledLine[] = [];
  for (const raw of usable) {
    if (out.length >= maxLines) break;
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (typeof obj.log !== 'string') continue;
      const ns = obj.kubernetes?.namespace_name ?? '';
      const co = obj.kubernetes?.container_name ?? '';
      const pod = obj.kubernetes?.pod_name ?? '';
      const stream = obj.stream ?? 'stdout';
      if (opts.namespace && ns !== opts.namespace) continue;
      if (opts.container && co !== opts.container) continue;
      out.push({ log: obj.log, namespace: ns, container: co, pod, stream });
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Write a sampled batch to a local file as `events`-format input for
 * `log10x_resolve_batch` or the local tenx CLI. Returns the path.
 */
export function writeSampleFile(
  path: string,
  samples: SampledLine[]
): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, samples.map((s) => s.log).join('\n'));
  return path;
}
