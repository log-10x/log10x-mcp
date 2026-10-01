/**
 * CloudWatch Infrequent Access discounts INGEST, and nothing else.
 *
 * AWS's log classes page, read 2026-09-30
 * (docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch_Logs_Log_Classes.html):
 * "For charges, the Standard and Infrequent Access log classes differ in
 * ingestion costs only. Storage charges and CloudWatch Logs Insights charges
 * are the same in each log class."
 *
 * The model once priced IA storage at $0.0075/GB-month as "75% off", and the
 * rendered strings still called tier_down "a cheaper storage tier" after the
 * rate was fixed. These pin both: a plan for a fixed volume saves the ingest
 * delta and not a cent more at any retention, and no rendered string sells a
 * storage discount.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { projectAction } from '../src/lib/cost.js';

const GB = 1_000_000_000;

// 1,000 GB a month is the fixed example volume. Standard: $0.50/GB ingest,
// $0.03/GB-month storage. IA: $0.25/GB ingest, $0.03/GB-month storage.
for (const months of [1, 12]) {
  test(`a 1,000 GB/mo CloudWatch tier_down saves the ingest delta only (${months} month retention)`, () => {
    const args = { bytes_in: 1000 * GB, destination: 'cloudwatch' as const, retention_months: months };
    const pass = projectAction({ ...args, action: 'pass' });
    const ia = projectAction({ ...args, action: 'tier_down' });
    assert.equal(ia.storage_dollars, pass.storage_dollars, 'IA storage bills the same as Standard');
    assert.equal(ia.storage_dollars, 1000 * 0.03 * months);
    // $500 Standard ingest against $250 IA ingest. The old $0.0075 storage rate
    // added $22.50 a month of storage "saving" per retained month on top.
    assert.equal((pass.total_dollars ?? 0) - (ia.total_dollars ?? 0), 250);
  });
}

/** Every .ts file under src, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('no rendered string sells tier_down as a cheaper storage tier or IA as cheaper overall', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        const storageTier = /cheaper storage (tier|class)|destination-side storage tier|ingest \+ storage rate/i.test(code);
        // An IA figure must say what it is cheaper on.
        const bareIaFigure = /Infrequent Access[^'"`]*~?\d+% cheaper than/i.test(code) && !/ingest/i.test(code);
        if (storageTier || bareIaFigure) offenders.push(`${file}:${i + 1}: ${code.slice(0, 140)}`);
      });
  }
  assert.deepEqual(offenders, []);
});
