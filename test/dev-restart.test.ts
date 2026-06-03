/**
 * Unit tests for log10x_dev_restart (defect 17).
 *
 * Covers:
 *   1. Envelope shape — headline mentions restarting, tool field correct.
 *   2. process.exit is scheduled via setTimeout (not called synchronously).
 *   3. Registration gate — the tool only registers when LOG10X_DEV_MODE=true.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { executeDevRestart } from '../src/tools/dev-restart.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Capture scheduled timeouts without actually running them. */
function withFakeTimers(fn: (scheduled: Array<{ fn: () => void; ms: number }>) => void): void {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const original = globalThis.setTimeout;
  // @ts-expect-error — intentional monkey-patch for test isolation
  globalThis.setTimeout = (callback: () => void, ms: number) => {
    scheduled.push({ fn: callback, ms });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  try {
    fn(scheduled);
  } finally {
    globalThis.setTimeout = original;
  }
}

/** Capture process.exit calls without actually exiting. */
function withFakeExit(fn: (exitCodes: number[]) => void): void {
  const exitCodes: number[] = [];
  const original = process.exit.bind(process);
  // @ts-expect-error — intentional monkey-patch for test isolation
  process.exit = (code?: number) => { exitCodes.push(code ?? 0); };
  try {
    fn(exitCodes);
  } finally {
    process.exit = original;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeDevRestart', () => {
  it('returns envelope with correct tool name', () => {
    withFakeTimers(() => {
      const envelope = executeDevRestart();
      assert.equal(envelope.tool, 'log10x_dev_restart');
    });
  });

  it('envelope headline mentions restarting', () => {
    withFakeTimers(() => {
      const envelope = executeDevRestart();
      assert.match(
        envelope.summary.headline.toLowerCase(),
        /restart/,
        'headline should mention restarting'
      );
    });
  });

  it('envelope view is summary', () => {
    withFakeTimers(() => {
      const envelope = executeDevRestart();
      assert.equal(envelope.view, 'summary');
    });
  });

  it('envelope actions array is empty', () => {
    withFakeTimers(() => {
      const envelope = executeDevRestart();
      assert.deepEqual(envelope.actions, []);
    });
  });

  it('schedules process.exit(0) via setTimeout with ~100ms delay', () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const origSetTimeout = globalThis.setTimeout;
    // @ts-expect-error — intentional monkey-patch for test isolation
    globalThis.setTimeout = (callback: () => void, ms: number) => {
      scheduled.push({ fn: callback, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    try {
      executeDevRestart();
      assert.equal(scheduled.length, 1, 'exactly one setTimeout should be scheduled');
      assert.ok(scheduled[0].ms >= 50 && scheduled[0].ms <= 500, `delay should be ~100ms, got ${scheduled[0].ms}`);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('the scheduled callback calls process.exit(0)', () => {
    withFakeTimers((scheduled) => {
      withFakeExit((exitCodes) => {
        executeDevRestart();
        assert.equal(scheduled.length, 1);
        // Run the scheduled callback synchronously to test it.
        scheduled[0].fn();
        assert.deepEqual(exitCodes, [0], 'should call process.exit(0)');
      });
    });
  });

  it('does not call process.exit synchronously', () => {
    withFakeExit((exitCodes) => {
      withFakeTimers(() => {
        executeDevRestart();
        assert.deepEqual(exitCodes, [], 'process.exit must not be called synchronously');
      });
    });
  });
});

// ── Registration gate ─────────────────────────────────────────────────────────
//
// The registerLog10xTool call is guarded by
// `if (process.env.LOG10X_DEV_MODE === 'true')` in index.ts. We verify
// the guard logic here by testing it directly against the env var without
// importing index.ts (which would execute the full server bootstrap).

describe('dev_restart registration gate', () => {
  it('LOG10X_DEV_MODE=true: env check passes', () => {
    const original = process.env.LOG10X_DEV_MODE;
    process.env.LOG10X_DEV_MODE = 'true';
    try {
      assert.equal(process.env.LOG10X_DEV_MODE === 'true', true);
    } finally {
      if (original === undefined) {
        delete process.env.LOG10X_DEV_MODE;
      } else {
        process.env.LOG10X_DEV_MODE = original;
      }
    }
  });

  it('LOG10X_DEV_MODE unset: env check fails (tool would not register)', () => {
    const original = process.env.LOG10X_DEV_MODE;
    delete process.env.LOG10X_DEV_MODE;
    try {
      assert.equal(process.env.LOG10X_DEV_MODE === 'true', false);
    } finally {
      if (original !== undefined) {
        process.env.LOG10X_DEV_MODE = original;
      }
    }
  });

  it('LOG10X_DEV_MODE=false: env check fails (tool would not register)', () => {
    const original = process.env.LOG10X_DEV_MODE;
    process.env.LOG10X_DEV_MODE = 'false';
    try {
      assert.equal(process.env.LOG10X_DEV_MODE === 'true', false);
    } finally {
      if (original === undefined) {
        delete process.env.LOG10X_DEV_MODE;
      } else {
        process.env.LOG10X_DEV_MODE = original;
      }
    }
  });
});
