import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    // Each file gets its own database cloned from a migrated template, so files run in parallel.
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
