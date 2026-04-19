/**
 * Drive the poc-from-siem tool from a plain Node script.
 *
 * Usage:
 *   node scripts/run-poc.mjs --siem cloudwatch --scope /log10x/poc-test-otel --window 24h --target 50000
 *   node scripts/run-poc.mjs --siem elasticsearch --scope "otel-logs" --window 24h --target 50000
 *
 * Polls the in-process snapshot map every 3s until complete/failed, then
 * writes the report markdown to the path specified by --out (or stdout).
 */
import { executePocSubmit, executePocStatus } from '../build/tools/poc-from-siem.js';
import { writeFile } from 'fs/promises';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = v;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const siem = args.siem;
const scope = args.scope;
const query = args.query;
const window = args.window || '24h';
const target = Number(args.target || 50_000);
const maxMin = Number(args['max-min'] || 8);
const privacy = args.privacy !== 'false';
const out = args.out;
const clickhouseTable = args['ch-table'];
const clickhouseMessageColumn = args['ch-msg'];
const clickhouseTimestampColumn = args['ch-ts'];

if (!siem) {
  console.error('--siem is required');
  process.exit(1);
}

console.log(`[driver] submit { siem=${siem}, scope=${scope}, window=${window}, target=${target}, privacy_mode=${privacy} }`);
const submitOut = await executePocSubmit({
  siem,
  scope,
  query,
  window,
  target_event_count: target,
  max_pull_minutes: maxMin,
  privacy_mode: privacy,
  clickhouse_table: clickhouseTable,
  clickhouse_message_column: clickhouseMessageColumn,
  clickhouse_timestamp_column: clickhouseTimestampColumn,
});
console.log(submitOut);

const match = submitOut.match(/snapshot_id.*?`([^`]+)`/);
if (!match) {
  console.error('[driver] could not parse snapshot_id from submit output');
  process.exit(2);
}
const snapshotId = match[1];

let prevStatus = '';
while (true) {
  const status = await executePocStatus({ snapshot_id: snapshotId });
  const firstLine = status.split('\n', 1)[0];
  if (status !== prevStatus) {
    console.log(`[driver] ${new Date().toISOString()} ${firstLine}`);
    const stepLine = status.match(/\*\*step_detail\*\*: (.+)/);
    const pctLine = status.match(/\*\*progress_pct\*\*: (.+)/);
    if (stepLine && pctLine) {
      console.log(`         progress=${pctLine[1]}% step=${stepLine[1]}`);
    }
    prevStatus = status;
  }
  if (/## POC — failed/.test(status)) {
    console.error('[driver] FAILED:\n' + status);
    process.exit(3);
  }
  if (/# Log10x POC Report/.test(status) || /_Report saved to:/.test(status)) {
    if (out) {
      await writeFile(out, status, 'utf8');
      console.log(`[driver] report written to ${out}`);
    } else {
      console.log(status);
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

process.exit(0);
