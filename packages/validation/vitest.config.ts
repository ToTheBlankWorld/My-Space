import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'validation',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
