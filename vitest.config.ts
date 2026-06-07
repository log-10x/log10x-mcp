import { defineConfig } from 'vitest/config';

// Most of the suite runs under node:test (see the `test` script in package.json).
// These three tests rely on vitest's ESM module mocking (`vi.mock`), which
// node:test cannot do on the Node 20 CI target (mock.module needs Node 22.3+),
// so they run under vitest instead. Keep this include list in sync with the
// `exclude` in tsconfig.test.json (those files must NOT be compiled into
// test-build/, or node --test would try to run them and fail).
export default defineConfig({
  test: {
    include: [
      'test/measure-compaction.test.ts',
      'test/sample-budget.test.ts',
      'test/template-expander.test.ts',
    ],
    environment: 'node',
  },
});
