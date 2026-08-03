#!/usr/bin/env node
/**
 * Release gate: drive the engine through the PACKAGED artifact.
 *
 * The boot smoke starts build/index.js from the repo, where assets/ exists on
 * disk whether or not it ships. That is how `assets` missing from
 * package.json "files" reached 1.25.0, 1.26.0 and 1.27.0: the server booted,
 * every test passed, and docker mode failed for customers with
 * "no app config specified" because the engine config was never in the tarball.
 *
 * This asserts on ENGINE OUTPUT from an installed package: a non-empty
 * tenxHash. That covers both the packaging omission and the class of defect
 * where the engine runs but emits no identity, which is what made severity
 * coverage 0% and marked every ERROR pattern reducible.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) { console.error('usage: packaged-engine-smoke.mjs <installed-package-dir>'); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), 'tenx-smoke-'));
const sample = join(work, 'sample.log');
writeFileSync(sample, Array.from({ length: 40 }, (_, i) =>
  `2026-08-03 10:${String(i % 60).padStart(2, '0')}:00 INFO  [worker${i % 4}] OrderService - processed order ${1000 + i} in ${12 + i}ms`
).join('\n') + '\n');

const server = spawn(process.execPath, [join(pkgDir, 'build', 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, LOG10X_TENX_MODE: 'docker' },
});

let buf = '';
const pending = new Map();
server.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (method, params, id) => new Promise((res, rej) => {
  pending.set(id, res);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => rej(new Error(`timeout on ${method}`)), 240000);
});

const fail = (m) => { console.error(`FAIL: ${m}`); server.kill('SIGKILL'); process.exit(1); };

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }, 1);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const r = await rpc('tools/call', {
    name: 'log10x_extract_templates',
    arguments: { source: 'file', path: sample },
  }, 2);
  const text = JSON.stringify(r);

  if (/no app config specified/i.test(text) || /tenx config not found/i.test(text)) {
    fail('the engine config is missing from the INSTALLED package. package.json "files" must include "assets", or the config never ships and docker mode dies for every customer. This is what shipped in 1.25.0, 1.26.0 and 1.27.0.');
  }
  // template_hash is the engine-derived identity for each template. Empty or
  // absent means the engine ran but produced no identity, which is the state
  // that made severity coverage 0% and marked every ERROR pattern reducible.
  const hashes = [...text.matchAll(/\\?"template_hash\\?"\s*:\s*\\?"([^"\\]+)/g)]
    .map((m) => m[1]).filter((h) => h && h.trim());
  if (hashes.length === 0) {
    console.error(JSON.stringify(r).slice(0, 1200));
    fail('no non-empty template_hash in extract_templates output - the engine ran but emitted no identity');
  }
  console.log(`PASS: engine reachable from the packaged artifact, ${hashes.length} template(s), first template_hash=${hashes[0]}`);
  server.kill('SIGKILL');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
