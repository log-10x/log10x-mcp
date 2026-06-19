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
const ORIG_TENX_MODE = process.env.LOG10X_TENX_MODE;
const ORIG_STDIN_CONFIG = process.env.LOG10X_MCP_STDIN_CONFIG_PATH;
const ORIG_FILE_CONFIG = process.env.LOG10X_MCP_FILE_CONFIG_PATH;
beforeEach(() => {
  process.env.LOG10X_TENX_PATH = '/var/empty/nope-no-tenx-here';
  // resolveTenxMode() now prefers docker when LOG10X_TENX_MODE is unset and a
  // docker daemon is reachable; pin local so the bogus LOG10X_TENX_PATH forces
  // the "tenx not installed" path on dev boxes + CI runners that have docker.
  process.env.LOG10X_TENX_MODE = 'local';
  process.env.LOG10X_MCP_STDIN_CONFIG_PATH = STDIN_CONFIG;
  process.env.LOG10X_MCP_FILE_CONFIG_PATH = FILE_CONFIG;
});
afterEach(() => {
  if (ORIG_TENX_PATH === undefined) delete process.env.LOG10X_TENX_PATH;
  else process.env.LOG10X_TENX_PATH = ORIG_TENX_PATH;
  if (ORIG_TENX_MODE === undefined) delete process.env.LOG10X_TENX_MODE;
  else process.env.LOG10X_TENX_MODE = ORIG_TENX_MODE;
  if (ORIG_STDIN_CONFIG === undefined) delete process.env.LOG10X_MCP_STDIN_CONFIG_PATH;
  else process.env.LOG10X_MCP_STDIN_CONFIG_PATH = ORIG_STDIN_CONFIG;
  if (ORIG_FILE_CONFIG === undefined) delete process.env.LOG10X_MCP_FILE_CONFIG_PATH;
  else process.env.LOG10X_MCP_FILE_CONFIG_PATH = ORIG_FILE_CONFIG;
});

// The engine always runs locally; CI has no tenx binary, so the test
// focuses on coercion + error paths + empty-input handling that run
// entirely in-process.

test('extractPatterns returns empty result for empty input', async () => {
  const out = await extractPatterns([]);
  assert.equal(out.totalEvents, 0);
  assert.equal(out.patterns.length, 0);
  assert.equal(out.inputLineCount, 0);
});

test('extractPatterns returns empty result for only blank strings', async () => {
  const out = await extractPatterns(['', '   ', '\n']);
  assert.equal(out.totalEvents, 0);
  assert.equal(out.patterns.length, 0);
});

test('extractPatterns coerces object events by common fields', async () => {
  // The CLI is not installed in CI — we expect a clean error. That proves
  // the object-coercion reached the execution path.
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
      );
    },
    (e: Error) => /tenx.*not (installed|available)|CLI.*run failed/i.test(e.message)
  );
});

test('extractPatterns without a usable local CLI throws a precondition error', async () => {
  // Patterns always run through the local tenx CLI. Two preconditions
  // gate that path, and either is a valid "can't run locally" failure:
  //   1. runDevCliStdin's API-key guard (DevCliConfigMissingError) fires first
  //      when LOG10X_API_KEY/TENX_API_KEY are unset — as they are in CI. That
  //      error is wrapped by extractPatterns as "Local tenx CLI run failed: ...".
  //   2. If a key IS present, the bogus LOG10X_TENX_PATH forces the binary
  //      lookup to throw DevCliNotInstalledError.
  await assert.rejects(
    async () => {
      await extractPatterns(['ERROR something broke']);
    },
    (e: Error) =>
      e.name === 'DevCliNotInstalledError' ||
      /not installed/i.test(e.message) ||
      /CLI run failed|not configured/i.test(e.message)
  );
});
