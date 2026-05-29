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
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
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
 * args. Excludes auth-style fields (analyzer_cost_per_gb,
 * privacy_mode) that don't affect the events or templater output.
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
  try {
    const lines = events.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(join(dir, EVENTS_FILENAME), lines);
  } catch {
    // ignore — cache write failures don't break the pipeline
  }
}

export function readCachedEvents(dir: string): unknown[] {
  try {
    const text = readFileSync(join(dir, EVENTS_FILENAME), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return l; // fall back to raw text for non-JSON lines
      }
    });
  } catch {
    return [];
  }
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
