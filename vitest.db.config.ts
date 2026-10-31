import { defineConfig } from 'vitest/config';

// Database and server tests. Needs PostgreSQL 16 binaries (PG_BIN) locally.
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    globalSetup: ['tests/db/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
