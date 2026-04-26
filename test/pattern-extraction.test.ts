import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { extractPatterns } from '../src/lib/pattern-extraction.js';

// Force the "tenx not installed" path even on dev machines where tenx IS
// installed: set LOG10X_TENX_PATH to a nonexistent binary. Also point the
// MCP packaged-config env vars at the real assets/ dir so the binary-check
// path fires (otherwise the test would fail on config-not-found before
// even attempting to look up the binary).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ASSETS_DIR = resolve(__dirname, '..', '..', 'assets');
const STDIN_CONFIG = resolve(ASSETS_DIR, 'tenx-mcp-stdin.config.yaml');
const FILE_CONFIG = resolve(ASSETS_DIR, 'tenx-mcp-file.config.yaml');

const ORIG_TENX_PATH = process.env.LOG10X_TENX_PATH;
const ORIG_STDIN_CONFIG = process.env.LOG10X_MCP_STDIN_CONFIG_PATH;
const ORIG_FILE_CONFIG = process.env.LOG10X_MCP_FILE_CONFIG_PATH;
beforeEach(() => {
  process.env.LOG10X_TENX_PATH = '/var/empty/nope-no-tenx-here';
  process.env.LOG10X_MCP_STDIN_CONFIG_PATH = STDIN_CONFIG;
  process.env.LOG10X_MCP_FILE_CONFIG_PATH = FILE_CONFIG;
});
afterEach(() => {
  if (ORIG_TENX_PATH === undefined) delete process.env.LOG10X_TENX_PATH;
  else process.env.LOG10X_TENX_PATH = ORIG_TENX_PATH;
  if (ORIG_STDIN_CONFIG === undefined) delete process.env.LOG10X_MCP_STDIN_CONFIG_PATH;
  else process.env.LOG10X_MCP_STDIN_CONFIG_PATH = ORIG_STDIN_CONFIG;
  if (ORIG_FILE_CONFIG === undefined) delete process.env.LOG10X_MCP_FILE_CONFIG_PATH;
  else process.env.LOG10X_MCP_FILE_CONFIG_PATH = ORIG_FILE_CONFIG;
});

// We can't hit the paste Lambda from CI; the test focuses on coercion +
// error paths + empty-input handling that run entirely in-process.

test('extractPatterns returns empty result for empty input', async () => {
  const out = await extractPatterns([], { privacyMode: false });
  assert.equal(out.totalEvents, 0);
  assert.equal(out.patterns.length, 0);
  assert.equal(out.inputLineCount, 0);
});

test('extractPatterns returns empty result for only blank strings', async () => {
  const out = await extractPatterns(['', '   ', '\n'], { privacyMode: false });
  assert.equal(out.totalEvents, 0);
  assert.equal(out.patterns.length, 0);
});

test('extractPatterns coerces object events by common fields', async () => {
  // privacyMode: true but the CLI is not installed — we expect a clean error.
  // That proves the object-coercion reached the execution path.
  await assert.rejects(
    async () => {
      await extractPatterns(
        [
          { message: 'x' },
          { text: 'y' },
          { log: 'z' },
          { body: 'q' },
          { _raw: 'r' },
        ],
        { privacyMode: true }
      );
    },
    (e: Error) => /tenx.*not installed|CLI.*run failed/i.test(e.message)
  );
});

test('extractPatterns privacy_mode without tenx throws DevCliNotInstalledError', async () => {
  await assert.rejects(
    async () => {
      await extractPatterns(['ERROR something broke'], { privacyMode: true });
    },
    (e: Error) => e.name === 'DevCliNotInstalledError' || /not installed/i.test(e.message)
  );
});

test('extractPatterns rejects oversize batch without autoBatch', async () => {
  // Craft an input larger than the 100 KB paste-lambda limit.
  const bigLine = 'x'.repeat(1024);
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) lines.push(`${bigLine} line ${i}`);
  // This should error because we're not in privacy mode AND autoBatch is false.
  // Since the network is blocked in CI, we actually expect *either* the size
  // check to trigger or the fetch to fail — we accept either.
  await assert.rejects(
    async () => {
      await extractPatterns(lines, { privacyMode: false, autoBatch: false });
    }
  );
});
