import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
          exclude: ['**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/*/test/integration/**/*.test.ts'],
          environment: 'node',
          // Integration suites share one Postgres database and bucket; run files serially.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          setupFiles: ['tests/setup/integration-env.ts'],
          globalSetup: ['tests/setup/integration-global.ts'],
        },
      },
    ],
  },
});
