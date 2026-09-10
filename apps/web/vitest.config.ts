import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Workspace packages ship TypeScript sources; point Vitest at them so it
      // transforms them like first-party code instead of treating them as
      // pre-built `node_modules` entry points.
      '@space/time': fileURLToPath(new URL('../../packages/time/src/index.ts', import.meta.url)),
      '@space/types': fileURLToPath(new URL('../../packages/types/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
