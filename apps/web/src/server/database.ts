import 'server-only';

import { getDatabaseClient, type DatabaseClient } from '@space/database';

/**
 * The web application's database handle.
 *
 * The `server-only` import is the enforcement mechanism, exactly as it is for
 * `env.server.ts`: if this module is ever pulled into a client bundle the build
 * fails, so a connection string cannot reach a browser.
 *
 * Data must be read in Server Components, Route Handlers or Server Actions and
 * passed down as props. Client Components never import this file — an ESLint
 * rule in `eslint.config.mjs` rejects the attempt before the build does.
 *
 * The client is a lazily created singleton: Next.js re-evaluates modules on
 * every hot reload, and a fresh pool per edit would exhaust the database's
 * connection limit within minutes.
 */
// The return type is annotated rather than inferred: Prisma's client type
// references generated internals that a consuming package cannot name.
export const getDatabase = (): DatabaseClient => getDatabaseClient();
