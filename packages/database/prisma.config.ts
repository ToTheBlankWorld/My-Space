import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed connection URLs from the schema file and no longer loads
 * `.env` implicitly, so both are handled here — explicitly, and only for CLI
 * commands. The application itself never reads this file: it passes a connection
 * through a driver adapter (see `src/client.ts`).
 *
 * Migrations run against the *direct* connection. Supabase's pooled endpoint
 * uses transaction pooling, which cannot hold the advisory lock or the session
 * state that `prisma migrate` needs.
 */
const loadEnvFile = (path: string): void => {
  try {
    process.loadEnvFile(path);
  } catch {
    // Absent or unreadable env file: the process environment is the source of
    // truth in CI and in production, where no file exists.
  }
};

loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
