/**
 * Disk caching for POC pipeline phases.
 *
 * The local POC pulls live events from a SIEM, runs them through the
 * templater, builds a v2 envelope. Each phase is independently
 * expensive — a 1h CloudWatch pull is 10-30s, a templater run on
 * 100k events is 30-90s. Iterating on envelope shape or downstream
 * enrichment shouldn't re-trigger either.
 *
 * Cache key is the tuple of (siem, scope, window, target_event_count,
 * query). Two phases:
 *
 *   <cache-dir>/<key>/events.jsonl                    — pulled SIEM events
 *   <cache-dir>/<key>/templater/templates.json        — templater output
 *   <cache-dir>/<key>/templater/encoded.log
 *   <cache-dir>/<key>/templater/aggregated.csv
 *
 * Default cache root is /tmp/log10x-poc-cache; override with
 * LOG10X_POC_CACHE_DIR. Caches persist until manually cleared — the
 * caller invalidates by removing the directory or changing any
 * key-contributing arg.
 *
 * Never throws — every read/write degrades to "no cache" on error.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, writeSync, readSync, closeSync } from 'fs';
import { join } from 'path';

const CACHE_ROOT = process.env.LOG10X_POC_CACHE_DIR || '/tmp/log10x-poc-cache';

export interface CacheKeyArgs {
  siem: string;
  scope?: string;
  window: string;
  target_event_count: number;
  query?: string;
}

export interface CacheEntry {
  key: string;
  dir: string;
  /** True when the cache dir existed before this call. */
  preExisted: boolean;
  /** Seconds since the dir's mtime (only meaningful when preExisted). */
  ageSeconds: number;
}

/**
 * Stable 16-char hex key over the user-visible cache-contributing
 * args. Excludes auth-style fields (analyzer_cost_per_gb)
 * that don't affect the events or engine output.
 */
export function computeCacheKey(args: CacheKeyArgs): string {
  const canonical = {
    siem: args.siem,
    scope: args.scope ?? '',
    window: args.window,
    target_event_count: args.target_event_count,
    query: args.query ?? '',
  };
  const h = createHash('sha256');
  h.update(JSON.stringify(canonical));
  return h.digest('hex').slice(0, 16);
}

export function getOrCreateCacheDir(key: string): CacheEntry {
  const dir = join(CACHE_ROOT, key);
  if (existsSync(dir)) {
    let ageSeconds = 0;
    try {
      const stat = statSync(dir);
      ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    } catch {
      // ignore
    }
    return { key, dir, preExisted: true, ageSeconds };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — downstream read/writes will catch it
  }
  return { key, dir, preExisted: false, ageSeconds: 0 };
}

// ── Phase 1: SIEM pull cache ──

const EVENTS_FILENAME = 'events.jsonl';

export function hasCachedEvents(dir: string): boolean {
  return existsSync(join(dir, EVENTS_FILENAME));
}

export function writeCachedEvents(dir: string, events: unknown[]): void {
  // Stream-write per event instead of one giant join + writeFileSync.
  // V8 has a max string length around 512 MB on 64-bit; large pulls
  // (400k+ events) overflow when stringified into a single string.
  // Using openSync + writeSync per chunk avoids that ceiling and the
  // file remains valid line-delimited JSON.
  const fd = (() => {
    try {
      return openSync(join(dir, EVENTS_FILENAME), 'w');
    } catch {
      return -1;
    }
  })();
  if (fd === -1) return;
  try {
    const CHUNK = 1000;
    for (let i = 0; i < events.length; i += CHUNK) {
      const slice = events.slice(i, i + CHUNK);
      const text = slice.map((e) => JSON.stringify(e)).join('\n') + (i + CHUNK < events.length ? '\n' : '');
      writeSync(fd, text);
    }
  } catch {
    // ignore — partial write is still useful
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function readCachedEvents(dir: string): unknown[] {
  // Stream-read line by line. The single-buffer readFileSync hits V8's
  // ToLocalChecked limit at ~512 MB; cached 14d pulls of busy clusters
  // routinely exceed that. We read a chunk at a time, split on
  // newlines, and JSON-parse per line so the maximum live string is
  // bounded by buffer size, not file size.
  const path = join(dir, EVENTS_FILENAME);
  const out: unknown[] = [];
  let fd = -1;
  try {
    fd = openSync(path, 'r');
  } catch {
    return out;
  }
  try {
    const BUF = Buffer.alloc(1024 * 1024); // 1 MB chunks
    let leftover = '';
    while (true) {
      const n = readSync(fd, BUF, 0, BUF.length, null);
      if (n <= 0) break;
      const text = leftover + BUF.subarray(0, n).toString('utf8');
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
          const line = text.slice(start, i);
          if (line) {
            try { out.push(JSON.parse(line)); } catch { out.push(line); }
          }
          start = i + 1;
        }
      }
      leftover = text.slice(start);
    }
    // Flush any final line not terminated by a newline.
    if (leftover) {
      try { out.push(JSON.parse(leftover)); } catch { out.push(leftover); }
    }
  } catch {
    // partial-read result is still useful
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  return out;
}

// ── Phase 2: Templater output cache ──

const TEMPLATER_SUBDIR = 'templater';

export interface CachedTemplaterOutput {
  templatesJson: string;
  encodedLog: string;
  aggregatedCsv: string;
}

export function hasCachedTemplaterOutput(dir: string): boolean {
  const t = join(dir, TEMPLATER_SUBDIR);
  return (
    existsSync(join(t, 'templates.json')) &&
    existsSync(join(t, 'encoded.log')) &&
    existsSync(join(t, 'aggregated.csv'))
  );
}

export function readCachedTemplaterOutput(dir: string): CachedTemplaterOutput | null {
  const t = join(dir, TEMPLATER_SUBDIR);
  try {
    return {
      templatesJson: readFileSync(join(t, 'templates.json'), 'utf8'),
      encodedLog: readFileSync(join(t, 'encoded.log'), 'utf8'),
      aggregatedCsv: readFileSync(join(t, 'aggregated.csv'), 'utf8'),
    };
  } catch {
    return null;
  }
}

export function writeCachedTemplaterOutput(dir: string, out: CachedTemplaterOutput): void {
  const t = join(dir, TEMPLATER_SUBDIR);
  try {
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'templates.json'), out.templatesJson);
    writeFileSync(join(t, 'encoded.log'), out.encodedLog);
    writeFileSync(join(t, 'aggregated.csv'), out.aggregatedCsv);
  } catch {
    // ignore
  }
}

/**
 * Summarize what's cached at a given cache dir for telemetry in the
 * v2 envelope (so the report header can say "events: cache hit (47s
 * old) / templater: cache miss"). Never throws.
 */
export interface CacheStatus {
  key: string;
  dir: string;
  events_cached: boolean;
  events_age_seconds: number | null;
  templater_cached: boolean;
  templater_age_seconds: number | null;
}

export function inspectCache(key: string): CacheStatus {
  const dir = join(CACHE_ROOT, key);
  const status: CacheStatus = {
    key,
    dir,
    events_cached: false,
    events_age_seconds: null,
    templater_cached: false,
    templater_age_seconds: null,
  };
  try {
    const ePath = join(dir, EVENTS_FILENAME);
    if (existsSync(ePath)) {
      status.events_cached = true;
      status.events_age_seconds = Math.floor((Date.now() - statSync(ePath).mtimeMs) / 1000);
    }
    const tPath = join(dir, TEMPLATER_SUBDIR, 'templates.json');
    if (existsSync(tPath) && hasCachedTemplaterOutput(dir)) {
      status.templater_cached = true;
      status.templater_age_seconds = Math.floor((Date.now() - statSync(tPath).mtimeMs) / 1000);
    }
  } catch {
    // ignore
  }
  return status;
}
