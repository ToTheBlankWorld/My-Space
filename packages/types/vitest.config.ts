import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'types',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
