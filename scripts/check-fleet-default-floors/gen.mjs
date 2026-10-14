// Writes the replay input: one statement per level, N lines each, interleaved.
//   node gen.mjs <out file> [N]
import { writeFileSync } from 'node:fs';
const [out, nArg = '1000'] = process.argv.slice(2);
const n = Number(nArg);
export const STATEMENTS = [
  { level: 'ERROR', text: (i) => `ERROR orders duplicate key value violates unique constraint "orders_pkey" order_id=${100000 + i}` },
  { level: 'FATAL', text: (i) => `FATAL billing ledger write failed shard=${i % 97} attempt=${i}` },
  { level: 'WARN', text: (i) => `WARN inventory stock below threshold sku=${200000 + i}` },
  { level: 'INFO', text: (i) => `INFO cart item added cart_id=${300000 + i} quantity=${(i % 9) + 1}` },
];
const lines = [];
for (let i = 0; i < n; i++) for (const s of STATEMENTS) lines.push(JSON.stringify({ log: s.text(i) }));
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} lines to ${out}`);
