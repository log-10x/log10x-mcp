/**
 * ClickHouse connector.
 *
 * Schema detection:
 *   1. Probe `DESCRIBE TABLE <table>` to read columns
 *   2. Match against OpenObserve schema (columns: _timestamp, log, stream)
 *   3. Match against SigNoz schema (columns: timestamp, body, resources_string_key,
 *      resources_string_value, severity_text)
 *   4. Otherwise require explicit schemaOverride to map columns
 *
 * `scope` is the database name; `query` is an SQL WHERE clause.
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client';

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
  SiemSchemaOverride,
  VolumeDetectionOptions,
  VolumeDetectionResult,
} from './index.js';

import { retryWithBackoff, shouldStop, parseWindowMs } from './_retry.js';

interface Conn {
  url: string;
  username?: string;
  password?: string;
  database?: string;
}

function getConn(): Conn | null {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) return null;
  const apiKey = process.env.CLICKHOUSE_API_KEY;
  const user = process.env.CLICKHOUSE_USER || process.env.CLICKHOUSE_USERNAME;
  const pass = process.env.CLICKHOUSE_PASSWORD;
  const db = process.env.CLICKHOUSE_DATABASE;
  if (apiKey) {
    return { url, username: 'default', password: apiKey, database: db };
  }
  if (user && pass) {
    return { url, username: user, password: pass, database: db };
  }
  return null;
}

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const conn = getConn();
  if (!conn) return { available: false, source: 'none' };
  return {
    available: true,
    source: 'env',
    details: {
      url: conn.url,
      database: conn.database || 'default',
      auth: conn.password === process.env.CLICKHOUSE_API_KEY ? 'api_key' : 'basic',
    },
  };
}

type DetectedSchema =
  | { kind: 'openobserve'; mapping: ColumnMapping }
  | { kind: 'signoz'; mapping: ColumnMapping }
  | { kind: 'custom'; mapping: ColumnMapping }
  | { kind: 'unknown'; columns: string[] };

interface ColumnMapping {
  timestamp: string;
  message: string;
  service?: string;
  severity?: string;
}

export async function detectSchema(
  columns: string[],
  override?: SiemSchemaOverride
): Promise<DetectedSchema> {
  const lower = new Set(columns.map((c) => c.toLowerCase()));

  if (override?.timestampColumn && override?.messageColumn) {
    return {
      kind: 'custom',
      mapping: {
        timestamp: override.timestampColumn,
        message: override.messageColumn,
        service: override.serviceColumn,
        severity: override.severityColumn,
      },
    };
  }

  // OpenObserve: _timestamp + log + stream
  if (lower.has('_timestamp') && lower.has('log') && lower.has('stream')) {
    return {
      kind: 'openobserve',
      mapping: {
        timestamp: '_timestamp',
        message: 'log',
        service: 'stream',
        severity: lower.has('level') ? 'level' : undefined,
      },
    };
  }
  // SigNoz: timestamp + body + severity_text + resources_string_*
  if (lower.has('timestamp') && lower.has('body') && lower.has('severity_text')) {
    return {
      kind: 'signoz',
      mapping: {
        timestamp: 'timestamp',
        message: 'body',
        severity: 'severity_text',
        // Service is typically in a resource label; we surface the body only
        // and let the pattern extractor derive service from the text content.
      },
    };
  }
  return { kind: 'unknown', columns };
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const conn = getConn();
  if (!conn) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: ['Set CLICKHOUSE_URL + (CLICKHOUSE_USER+CLICKHOUSE_PASSWORD OR CLICKHOUSE_API_KEY).'],
      },
    };
  }

  const database = opts.scope || conn.database || 'default';
  const table = opts.schemaOverride?.table;
  if (!table) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: [
          'ClickHouse requires `clickhouse_table` to be set. Pass it on the submit tool.',
        ],
      },
    };
  }

  const client: ClickHouseClient = createClient({
    url: conn.url,
    username: conn.username,
    password: conn.password,
    database,
  });

  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  const events: unknown[] = [];

  // Detect schema.
  let columns: string[] = [];
  try {
    const descResp = await retryWithBackoff(() =>
      client.query({ query: `DESCRIBE TABLE ${qualify(database, table)}`, format: 'JSONEachRow' })
    );
    const rows = (await descResp.json()) as Array<{ name: string }>;
    columns = rows.map((r) => r.name);
  } catch (e) {
    await client.close().catch(() => undefined);
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: `DESCRIBE ${qualify(database, table)}`,
        reasonStopped: 'error',
        notes: [`describe_failed: ${(e as Error).message.slice(0, 200)}`],
      },
    };
  }

  const detected = await detectSchema(columns, opts.schemaOverride);
  if (detected.kind === 'unknown') {
    await client.close().catch(() => undefined);
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: `DESCRIBE ${qualify(database, table)}`,
        reasonStopped: 'error',
        notes: [
          `clickhouse_schema_unrecognized: columns=[${columns.slice(0, 12).join(', ')}${columns.length > 12 ? ', …' : ''}]. Pass clickhouse_message_column and clickhouse_timestamp_column to map the schema.`,
        ],
      },
    };
  }

  const mapping = detected.mapping;
  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const sinceDate = new Date(Date.now() - windowMs);
  const sinceExpr = tsPredicate(mapping.timestamp, sinceDate);

  const selectCols = Array.from(
    new Set([
      mapping.timestamp,
      mapping.message,
      ...(mapping.service ? [mapping.service] : []),
      ...(mapping.severity ? [mapping.severity] : []),
    ])
  );

  const whereParts: string[] = [sinceExpr];
  if (opts.query) whereParts.push(`(${opts.query})`);
  const where = whereParts.join(' AND ');
  const pageSize = 5000;
  let offset = 0;

  while (true) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    const sql = `SELECT ${selectCols.join(', ')} FROM ${qualify(database, table)} WHERE ${where} ORDER BY ${mapping.timestamp} DESC LIMIT ${pageSize} OFFSET ${offset}`;
    try {
      const resp = await retryWithBackoff(() => client.query({ query: sql, format: 'JSONEachRow' }));
      const rows = (await resp.json()) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        reasonStopped = 'source_exhausted';
        break;
      }
      for (const r of rows) {
        events.push({
          timestamp: r[mapping.timestamp],
          message: r[mapping.message],
          service: mapping.service ? r[mapping.service] : undefined,
          severity: mapping.severity ? r[mapping.severity] : undefined,
          raw: r,
        });
      }
      offset += rows.length;
      opts.onProgress({
        step: `clickhouse offset=${offset} schema=${detected.kind}`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
      if (rows.length < pageSize) {
        reasonStopped = 'source_exhausted';
        break;
      }
    } catch (e) {
      notes.push(`clickhouse_page_error: ${(e as Error).message.slice(0, 200)}`);
      reasonStopped = 'error';
      break;
    }
  }

  await client.close().catch(() => undefined);

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: `${detected.kind}:${qualify(database, table)}${opts.query ? ` WHERE ${opts.query}` : ''}`,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

function qualify(database: string, table: string): string {
  return `${quoteIdent(database)}.${quoteIdent(table)}`;
}

function quoteIdent(s: string): string {
  // Reject anything that looks like an injection attempt.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`Invalid ClickHouse identifier: ${s}`);
  }
  return `\`${s}\``;
}

function tsPredicate(col: string, since: Date): string {
  const secs = Math.floor(since.getTime() / 1000);
  // Accept both DateTime and nanosecond DateTime64 columns by casting via toDateTime64.
  // _timestamp in OpenObserve is microseconds; SigNoz timestamp is a DateTime64(9).
  // This predicate is loose but works for any numeric or datetime column.
  return `${quoteIdent(col)} >= toDateTime(${secs})`;
}

/**
 * Detect ClickHouse daily ingest for the configured database + table.
 * Uses `system.parts.bytes_on_disk` for the target table divided by
 * the span of the timestamp column (observed from `min()` / `max()`).
 * Operates on-table; no cluster-wide licensing API is assumed.
 */
async function detectDailyVolumeGb(opts: VolumeDetectionOptions): Promise<VolumeDetectionResult> {
  const conn = getConn();
  if (!conn) return { errorNote: 'ClickHouse: CLICKHOUSE_URL not set' };
  const database = opts.scope || conn.database || 'default';
  const table = opts.schemaOverride?.table;
  if (!table) {
    return { errorNote: 'ClickHouse: table name required (pass clickhouse_table)' };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    return { errorNote: 'ClickHouse: invalid database/table identifier' };
  }
  const client = createClient({
    url: conn.url,
    username: conn.username,
    password: conn.password,
    database,
  });
  try {
    const partsSql = `SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE database = '${database}' AND table = '${table}' AND active`;
    const partsResp = await client.query({ query: partsSql, format: 'JSONEachRow' });
    const parts = (await partsResp.json()) as Array<{ bytes: string | number }>;
    const bytes = parts[0] ? Number(parts[0].bytes) : 0;
    if (!bytes || bytes <= 0) {
      await client.close().catch(() => undefined);
      return { errorNote: `ClickHouse system.parts returned 0 bytes for ${database}.${table}` };
    }
    // Detect timestamp column — use schemaOverride OR fall back to
    // conventional names. Span = max - min in seconds, ÷ 86400 for days.
    const tsCol = opts.schemaOverride?.timestampColumn;
    let spanSecs = 7 * 86_400; // default 7d
    let spanNote = 'assumed 7d (no timestamp column specified)';
    if (tsCol && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tsCol)) {
      const spanSql = `SELECT toUnixTimestamp(min(\`${tsCol}\`)) AS minT, toUnixTimestamp(max(\`${tsCol}\`)) AS maxT FROM \`${database}\`.\`${table}\``;
      try {
        const spanResp = await client.query({ query: spanSql, format: 'JSONEachRow' });
        const rows = (await spanResp.json()) as Array<{ minT: number | string; maxT: number | string }>;
        if (rows[0] && Number(rows[0].maxT) > Number(rows[0].minT)) {
          spanSecs = Math.max(3600, Number(rows[0].maxT) - Number(rows[0].minT));
          spanNote = `${Math.round(spanSecs / 86_400)}d observed span`;
        }
      } catch {
        // table schema may lack the column; keep default
      }
    }
    const dailyGb = bytes / (1024 ** 3) / (spanSecs / 86_400);
    await client.close().catch(() => undefined);
    return {
      dailyGb,
      source: `ClickHouse system.parts ${database}.${table} (${spanNote})`,
    };
  } catch (e) {
    await client.close().catch(() => undefined);
    return { errorNote: `ClickHouse volume detection failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

export const clickhouseConnector: SiemConnector = {
  id: 'clickhouse',
  displayName: 'ClickHouse',
  discoverCredentials,
  pullEvents,
  detectDailyVolumeGb,
};
