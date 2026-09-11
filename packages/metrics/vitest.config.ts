import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'metrics',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
