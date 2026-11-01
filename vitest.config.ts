import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    // Every review creates its own databases on one shared server; run files one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
