import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'database',
    environment: 'node',
    // Unit tests only: no database, no network. Integration tests live in
    // `src/__tests__/integration` and run through `test:integration`.
    include: ['src/**/*.test.ts'],
    exclude: ['src/generated/**', 'src/**/integration/**'],
  },
});
