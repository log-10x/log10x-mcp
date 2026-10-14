// Counts what the Receiver returned per level and checks each floor.
//   node count.mjs <data dir> <N> <cap> <action> <ERROR floor>
// A level's lines pass while the statement stays under the cap (at least the
// first 5); above it a line passes with the level's floor and the rest take
// the action. FATAL is CRITICAL in the floor list.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [dir, nArg, capArg, action, floorArg] = process.argv.slice(2);
const N = Number(nArg);
const cap = Number(capArg);
const errorFloor = Number(floorArg);
const LEVELS = { ERROR: errorFloor, FATAL: errorFloor, WARN: 0, INFO: 0 };

function read(file) {
  const p = join(dir, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const levelOf = (rec) => /^(ERROR|FATAL|WARN|INFO) /.exec(String(rec.log ?? ''))?.[1];

const counts = Object.fromEntries(Object.keys(LEVELS).map((l) => [l, { pass: 0, moved: 0, other: {} }]));
for (const [file, key] of [['pass.jsonl', 'pass'], ['moved.jsonl', 'moved']]) {
  for (const rec of read(file)) {
    const lvl = levelOf(rec);
    if (!lvl) continue;
    if (key === 'moved' && rec.routeState !== action) counts[lvl].other[rec.routeState] = (counts[lvl].other[rec.routeState] ?? 0) + 1;
    else counts[lvl][key]++;
  }
}

// Lines under the cap: with a cap below one line (the default, 1 byte), only the
// first 5 of each statement pass before the floor applies, so every count is exact
// up to the floor's draw. A larger cap is estimated from the line text, which is
// smaller than the event the engine sizes, so its counts are reported, not asserted.
const exactUnder = cap < 40;
const sample = readFileSync(join(dir, 'in.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).log);
let failed = false;
const rows = [];
for (const [lvl, f] of Object.entries(LEVELS)) {
  const sizes = sample.filter((t) => t.startsWith(`${lvl} `)).map((t) => Buffer.byteLength(t));
  let under = 0;
  let sum = 0;
  for (const s of sizes) { if (sum + s > cap) break; sum += s; under++; }
  under = exactUnder ? 5 : Math.max(5, under);
  const excess = N - under;
  const expected = under + f * excess;
  const slack = 5 * Math.sqrt(excess * f * (1 - f)) + (exactUnder ? 0 : 3);
  const c = counts[lvl];
  const ok = Math.abs(c.pass - expected) <= slack && c.pass + c.moved === N && Object.keys(c.other).length === 0;
  if (!ok && exactUnder) failed = true;
  rows.push(
    `${lvl.padEnd(5)} floor ${String(f).padEnd(4)} in ${N}  pass ${String(c.pass).padStart(5)}  ${action} ${String(c.moved).padStart(5)}` +
      `  expected pass ${expected.toFixed(0)} +/- ${slack.toFixed(0)} (under the cap ${under})` +
      (Object.keys(c.other).length ? `  other routes ${JSON.stringify(c.other)}` : '') +
      `  ${exactUnder ? (ok ? 'OK' : 'FAIL') : 'not asserted (cap above one line)'}`,
  );
}
console.log(rows.join('\n'));
process.exit(failed ? 1 : 0);
