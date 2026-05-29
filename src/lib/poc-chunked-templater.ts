/**
 * Chunked parallel templater for GB-scale POC pulls.
 *
 * Splits the input events into N chunks, runs N concurrent tenx
 * processes via @apps/mcp-file (each with its own LOG10X_MCP_RUNTIME_NAME
 * so output directories don't clash), then merges the three artifacts
 * (templates.json, encoded.log, aggregated.csv) by their stable keys.
 *
 * Merge semantics:
 *
 *   templates.json — dedupe by templateHash. The engine's templateHash
 *   is deterministic over template content, so the same template
 *   surfaced in chunks A and B produces the same hash in both
 *   templates.json files. Keep one entry per hash.
 *
 *   encoded.log — concat. Each encoded line is self-contained
 *   (~hash + slot values + pattern= + patternHash=) and references
 *   its templateHash by string; merging is line-wise.
 *
 *   aggregated.csv — sum by (severity, message_pattern, tenx_hash).
 *   The aggregator emits one row per unique enrichment tuple per
 *   chunk; we sum summaryVolume + summaryBytes and concat
 *   summaryTotals across rows with the same key. Header copied from
 *   the first chunk's file.
 *
 * Returns the same {templatesJson, encodedLog, aggregatedCsv,
 * wallTimeMs, cliVersion, configPath, tempDir} shape that
 * runDevCliFileOutput returns for a single chunk — drop-in for
 * extractPatterns' merged-parsing step.
 */

import { runDevCliFileOutput } from './dev-cli.js';

export interface ChunkedTemplaterOptions {
  /** Parallelism level. Default: min(cpus - 1, 8). */
  parallelism?: number;
  /**
   * Target chunk size in bytes of input text. When the input total
   * exceeds this, the chunker splits to keep each tenx process
   * working on roughly this much input. Default: 32 MB per chunk.
   */
  chunkTargetBytes?: number;
}

export interface ChunkedTemplaterResult {
  templatesJson: string;
  encodedLog: string;
  aggregatedCsv: string;
  wallTimeMs: number;
  /** Per-chunk timings + sizes for telemetry. */
  chunkStats: Array<{
    chunkIndex: number;
    eventCount: number;
    bytes: number;
    wallTimeMs: number;
    templatesCount: number;
    encodedEventCount: number;
    aggregatedRowCount: number;
  }>;
}

/**
 * Run the templater on a single string of newline-joined events,
 * possibly split across multiple parallel tenx invocations.
 *
 * For inputs below 2 × chunkTargetBytes, runs single-process (no
 * chunking) — the parallelism overhead isn't worth it for small
 * inputs. Above that threshold, splits into chunks of approximately
 * chunkTargetBytes each and runs up to `parallelism` in parallel.
 */
export async function runChunkedTemplater(
  rawLogText: string,
  opts: ChunkedTemplaterOptions = {},
): Promise<ChunkedTemplaterResult> {
  const totalBytes = Buffer.byteLength(rawLogText, 'utf8');
  const chunkTargetBytes = opts.chunkTargetBytes ?? 32 * 1024 * 1024;

  // Single-process path when input is small enough.
  if (totalBytes < 2 * chunkTargetBytes) {
    const t0 = Date.now();
    const result = await runDevCliFileOutput(rawLogText);
    const wallMs = Date.now() - t0;
    return {
      templatesJson: result.templatesJson,
      encodedLog: result.encodedLog,
      aggregatedCsv: result.aggregatedCsv,
      wallTimeMs: wallMs,
      chunkStats: [
        {
          chunkIndex: 0,
          eventCount: rawLogText.split('\n').filter(Boolean).length,
          bytes: totalBytes,
          wallTimeMs: wallMs,
          templatesCount: result.templatesJson.split('\n').filter(Boolean).length,
          encodedEventCount: result.encodedLog.split('\n').filter(Boolean).length,
          aggregatedRowCount: Math.max(0, result.aggregatedCsv.split('\n').filter(Boolean).length - 1),
        },
      ],
    };
  }

  // Chunked parallel path.
  const lines = rawLogText.split('\n');
  const chunks: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
    if (curBytes + lineBytes > chunkTargetBytes && cur.length > 0) {
      chunks.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
    }
    cur.push(line);
    curBytes += lineBytes;
  }
  if (cur.length > 0) chunks.push(cur.join('\n'));

  const parallelism = Math.min(opts.parallelism ?? Math.max(1, (await getCpuCount()) - 1), 8);
  const t0 = Date.now();
  const chunkStats: ChunkedTemplaterResult['chunkStats'] = [];

  // Run chunks with bounded parallelism via a sliding window of
  // active promises. Avoids the burst-then-drain pattern of a single
  // Promise.all over all chunks at once.
  const active = new Set<Promise<void>>();
  const templatesByHash = new Map<string, string>();
  const encodedParts: string[] = [];
  const aggByKey = new Map<string, { vol: number; bytes: number; totals: string[]; header: string; nonKeyCols: string }>();
  let aggHeader = '';

  const runId = `chunked-${Date.now()}-${process.pid}`;
  for (let i = 0; i < chunks.length; i++) {
    const chunkIndex = i;
    const chunkText = chunks[i];
    const task = (async () => {
      const chunkStart = Date.now();
      // Unique runtime name per chunk so the engine's output dirs
      // (/tmp/log10x-mcp-pull/<name>/) never collide across the
      // parallel processes. The default in runDevCliFileOutput is
      // `mcp-${Date.now()}-${pid}` — when N chunks fire in the same
      // millisecond from the same Node PID they all land in the same
      // dir and clobber each other.
      const result = await runDevCliFileOutput(chunkText, `${runId}-${chunkIndex}`);
      const chunkMs = Date.now() - chunkStart;

      // Merge templates: dedupe by templateHash.
      let templatesCount = 0;
      for (const line of result.templatesJson.split('\n')) {
        if (!line.trim()) continue;
        templatesCount++;
        const match = line.match(/^\{"templateHash":"([^"]+)"/);
        if (match) {
          if (!templatesByHash.has(match[1])) templatesByHash.set(match[1], line);
        }
      }

      // Concat encoded.log lines (order doesn't matter for downstream parsing).
      const encodedLines = result.encodedLog.split('\n').filter(Boolean);
      encodedParts.push(...encodedLines);

      // Sum aggregated rows by tenx_hash (primary key).
      const aggLines = result.aggregatedCsv.split('\n').filter(Boolean);
      let aggRowCount = 0;
      for (let j = 0; j < aggLines.length; j++) {
        const line = aggLines[j];
        if (j === 0) {
          if (!aggHeader) aggHeader = line;
          continue; // header
        }
        aggRowCount++;
        // Header format: severity_level,message_pattern,tenx_hash,
        //                summaryVolume,summaryBytes,summaryTotals
        // tenx_hash is column 2 (0-indexed); vol col 3; bytes col 4; totals col 5+
        const cols = line.split(',');
        if (cols.length < 5) continue;
        const tenxHash = cols[2];
        const key = tenxHash || `__unkeyed_${j}`;
        const vol = Number(cols[3]) || 0;
        const bytes = Number(cols[4]) || 0;
        const totals = cols.slice(5).filter(Boolean);
        const existing = aggByKey.get(key);
        if (existing) {
          existing.vol += vol;
          existing.bytes += bytes;
          existing.totals.push(...totals);
        } else {
          // Keep severity, message_pattern, tenx_hash from this row
          // (columns 0..2) as the "non-key columns" for the merged row.
          aggByKey.set(key, {
            vol,
            bytes,
            totals,
            header: aggHeader,
            nonKeyCols: cols.slice(0, 3).join(','),
          });
        }
      }

      chunkStats.push({
        chunkIndex,
        eventCount: chunkText.split('\n').filter(Boolean).length,
        bytes: Buffer.byteLength(chunkText, 'utf8'),
        wallTimeMs: chunkMs,
        templatesCount,
        encodedEventCount: encodedLines.length,
        aggregatedRowCount: aggRowCount,
      });
    })();
    active.add(task);
    task.finally(() => active.delete(task));
    if (active.size >= parallelism) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);

  // Stitch merged outputs.
  const templatesJsonMerged = Array.from(templatesByHash.values()).join('\n') + (templatesByHash.size > 0 ? '\n' : '');
  const encodedLogMerged = encodedParts.join('\n') + (encodedParts.length > 0 ? '\n' : '');
  const aggregatedCsvLines: string[] = [];
  if (aggHeader) aggregatedCsvLines.push(aggHeader);
  for (const { nonKeyCols, vol, bytes, totals } of aggByKey.values()) {
    aggregatedCsvLines.push(`${nonKeyCols},${vol},${bytes},${totals.join('|')}`);
  }
  const aggregatedCsvMerged = aggregatedCsvLines.join('\n') + (aggregatedCsvLines.length > 0 ? '\n' : '');

  chunkStats.sort((a, b) => a.chunkIndex - b.chunkIndex);

  return {
    templatesJson: templatesJsonMerged,
    encodedLog: encodedLogMerged,
    aggregatedCsv: aggregatedCsvMerged,
    wallTimeMs: Date.now() - t0,
    chunkStats,
  };
}

async function getCpuCount(): Promise<number> {
  const os = await import('os');
  return os.cpus().length;
}
