/**
 * Stderr structured logging for the MCP server.
 *
 * The MCP runs over stdio — anything written to stdout corrupts the
 * protocol. All log output goes to stderr. Defaults to silent so default
 * installs don't spam Claude Desktop / Cursor users with noise.
 *
 * Set LOG10X_MCP_LOG_LEVEL to one of: silent, error, warn, info, debug.
 * Default: silent.
 *
 * No external dependency — implemented as a tiny module so the MCP keeps
 * a flat dep graph (only @modelcontextprotocol/sdk + zod).
 */

type Level = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<Level, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function readLevel(): number {
  const raw = (process.env.LOG10X_MCP_LOG_LEVEL || 'silent').toLowerCase().trim() as Level;
  return LEVELS[raw] ?? 0;
}

const currentLevel = readLevel();

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString();
  const line = fields
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${safeJson(fields)}`
    : `[${ts}] ${level.toUpperCase()} ${msg}`;
  // eslint-disable-next-line no-console
  console.error(line);
}

function safeJson(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return '<unserializable>';
  }
}

export const log = {
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
};

/** Time a tool call and log its duration at info level on completion. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    log.info(`tool.${name}.ok`, { ms: Date.now() - started });
    return result;
  } catch (e) {
    log.warn(`tool.${name}.err`, { ms: Date.now() - started, msg: (e as Error).message });
    throw e;
  }
}
