import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeCompileLink } from '../src/tools/compile-link.js';

const linkArgs = (units_path: string) => ({
  units_path,
  library_name: 'linked',
  mode: 'auto' as const,
  timeout_ms: 600_000,
});

// All three reject BEFORE any spawn, so they need no docker — they guard the
// inputs to the shared async machinery.

test('compile_link rejects a non-existent units_path with input_invalid', async () => {
  const out = await executeCompileLink(linkArgs('/no/such/units/dir'));
  const s = JSON.stringify(out);
  assert.match(s, /input_invalid/);
  assert.match(s, /does not exist/);
});

test('compile_link rejects a units_path that is a file, not a directory', async () => {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'link-test-')), 'a.10x.json');
  await fs.writeFile(f, '{}', 'utf8');
  const out = await executeCompileLink(linkArgs(f));
  assert.match(JSON.stringify(out), /input_invalid/);
  assert.match(JSON.stringify(out), /must be a directory/);
});

test('compile_link rejects a folder with no .10x.json units (nothing to link)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-test-'));
  await fs.writeFile(path.join(dir, 'README.txt'), 'not a unit', 'utf8');
  const out = await executeCompileLink(linkArgs(dir));
  assert.match(JSON.stringify(out), /input_invalid/);
  assert.match(JSON.stringify(out), /[Nn]o \.10x\.json/);
});
