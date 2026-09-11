import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  // Internal workspace packages ship TypeScript sources and are compiled into
  // the bundle. Third-party dependencies stay external and are installed on the
  // deployment target (Railway) from the lockfile.
  noExternal: [/^@space\//],

  // Transitive dependencies of the bundled workspace packages are *not* covered
  // by tsup's default externalisation, which only reads this app's own
  // dependencies. `pg` and the Prisma runtime are CommonJS with native bindings:
  // inlining them into an ESM bundle produces
  // `Error: Dynamic require of "events" is not supported` at boot, and the same
  // shape of failure hits `googleapis`: google-auth-library performs a dynamic
  // `require('child_process')` that tsup's ESM require shim rejects with
  // `Dynamic require of "child_process" is not supported`, crashing the built
  // worker before its health server ever listens. These packages are declared as
  // runtime dependencies of this app so the deployment target installs them.
  external: [
    '@prisma/client',
    '@prisma/adapter-pg',
    'pg',
    'pg-native',
    'googleapis',
    'google-auth-library',
    'googleapis-common',
  ],
});
