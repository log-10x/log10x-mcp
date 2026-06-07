#!/usr/bin/env node
/**
 * Smoke test for the read-only demo guard.
 *
 * Spawns the MCP with LOG10X_MCP_READ_ONLY=true, performs the standard
 * JSON-RPC handshake, then calls log10x_env_register with deliberately
 * bogus minimum args. The guard fires at the TOP of the handler (before
 * any zod validation) so the bogus args never matter — the response
 * envelope MUST carry the canonical demo_read_only shape:
 *
 *   status                       = 'error'
 *   data.status                  = 'demo_read_only'
 *   data.error.error_type        = 'demo_read_only'
 *
 * Reports PASS / FAIL on stdout and exits 0 / 1.
 *
 * Usage:
 *   node scripts/smoke-read-only-guard.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpEntry = join(repoRoot, 'build', 'index.js');

function jrpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function startMcp() {
  const env = {
    ...process.env,
    LOG10X_MCP_READ_ONLY: 'true',
    // Demo credentials so initialize() does not stall on env loading.
    LOG10X_API_KEY:
      process.env.LOG10X_API_KEY || '4d985100-ee4a-4b6c-b784-a416b8684868',
    LOG10X_CUSTOMER_METRICS_URL:
      process.env.LOG10X_CUSTOMER_METRICS_URL || 'https://prometheus.log10x.com',
    LOG10X_CUSTOMER_METRICS_TYPE:
      process.env.LOG10X_CUSTOMER_METRICS_TYPE || 'log10x',
    LOG10X_CUSTOMER_METRICS_AUTH:
      process.env.LOG10X_CUSTOMER_METRICS_AUTH ||
      '4d985100-ee4a-4b6c-b784-a416b8684868/6aa99191-f827-4579-a96a-c0ebdfe73884',
  };
  return spawn('node', [mcpEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

function waitForId(mcp, id, timeoutMs = 60000) {
  return new Promise((resolveP, rejectP) => {
    let buf = '';
    const t = setTimeout(() => {
      mcp.stdout.off('data', onData);
      rejectP(new Error(`timeout waiting for id ${id}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === id) {
            clearTimeout(t);
            mcp.stdout.off('data', onData);
            if (m.error) return rejectP(new Error(`MCP error: ${m.error.message}`));
            return resolveP(m.result);
          }
        } catch {
          /* not JSON, skip */
        }
      }
    };
    mcp.stdout.on('data', onData);
  });
}

async function initialize(mcp) {
  const p = waitForId(mcp, 1);
  mcp.stdin.write(
    jrpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-read-only-guard', version: '1.0' },
    })
  );
  await p;
  mcp.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
  );
}

async function callTool(mcp, name, args) {
  const id = Math.floor(Math.random() * 1e9);
  const p = waitForId(mcp, id);
  mcp.stdin.write(jrpc(id, 'tools/call', { name, arguments: args }));
  return p;
}

function parseEnvelope(result) {
  // Result shape: { content: [{ type: 'text', text: '<json>' }], structuredContent? }
  if (result && result.structuredContent) return result.structuredContent;
  if (
    result &&
    Array.isArray(result.content) &&
    result.content[0] &&
    typeof result.content[0].text === 'string'
  ) {
    try {
      return JSON.parse(result.content[0].text);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function check(label, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${tag}] ${label}${detail ? ` (${detail})` : ''}\n`);
  return cond;
}

async function main() {
  process.stdout.write('smoke-read-only-guard: spawning MCP with LOG10X_MCP_READ_ONLY=true\n');
  const mcp = startMcp();
  let stderrBuf = '';
  mcp.stderr.on('data', (c) => {
    stderrBuf += c.toString('utf8');
  });

  let pass = true;
  try {
    await initialize(mcp);
    process.stdout.write('handshake complete; calling log10x_env_register with bogus args\n');

    // Minimum args that pass the MCP SDK's zod pre-validation. The
    // SDK validates BEFORE the handler runs, so a totally-empty payload
    // returns a -32602 input-validation error and the guard never gets
    // to fire. These args are syntactically valid but semantically
    // bogus (placeholder URLs / queue ARNs) — the guard short-circuits
    // before they would ever reach a real store.
    const bogusArgs = {
      env_id: 'smoke-readonly-bogus',
      nickname: 'smoke-readonly',
      cluster: { type: 'other' },
      destination: { siem_vendor: 'other' },
      streamer: { url: 'http://bogus.invalid' },
      retriever: {
        url: 'http://bogus.invalid',
        input_bucket: 'bogus-bucket',
        query_queues: {
          index: 'bogus-index',
          subquery: 'bogus-subquery',
          stream: 'bogus-stream',
          query: 'bogus-query',
        },
      },
    };
    const result = await callTool(mcp, 'log10x_env_register', bogusArgs);
    const envelope = parseEnvelope(result);

    if (!envelope) {
      check('envelope parseable', false, 'could not extract structured envelope from tool result');
      process.stdout.write(`  --- raw result ---\n${JSON.stringify(result, null, 2)}\n`);
      pass = false;
    } else {
      const outerStatus = envelope.status;
      const dataStatus = envelope.data && envelope.data.status;
      const errorType =
        envelope.data && envelope.data.error && envelope.data.error.error_type;

      pass = check('envelope.status == "error"', outerStatus === 'error', `got ${JSON.stringify(outerStatus)}`) && pass;
      pass = check('envelope.data.status == "demo_read_only"', dataStatus === 'demo_read_only', `got ${JSON.stringify(dataStatus)}`) && pass;
      pass = check('envelope.data.error.error_type == "demo_read_only"', errorType === 'demo_read_only', `got ${JSON.stringify(errorType)}`) && pass;
    }
  } catch (e) {
    process.stdout.write(`  [FAIL] smoke run errored: ${e.message}\n`);
    if (stderrBuf) process.stdout.write(`  --- mcp stderr ---\n${stderrBuf}\n`);
    pass = false;
  } finally {
    try {
      mcp.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  process.stdout.write(pass ? '\nRESULT: PASS\n' : '\nRESULT: FAIL\n');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
