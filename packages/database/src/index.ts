/**
 * `@space/database` — the server-side persistence layer.
 *
 * ## Boundary
 *
 * This package is **server-only**. It must never appear in a browser bundle:
 *
 * - `apps/web` imports it through `src/server/database.ts`, which is marked with
 *   `server-only`, so a bad import fails the build.
 * - An ESLint rule forbids components from importing it at all.
 * - `createDatabaseClient` calls the Stage 1 `assertServerRuntime` guard as a
 *   last line of defence.
 *
 * ## Shape
 *
 * Prisma is used directly for reads that are already safe and obvious; the
 * repository functions exist where a rule has to hold — ownership scoping,
 * pagination caps, status transitions, idempotent upserts. There is no
 * repository-per-table ceremony, and no attempt to hide Prisma's types.
 *
 * Every repository function takes the database handle as its first argument, so
 * the same code runs inside `$transaction` or outside it.
 */

export {
  createDatabaseClient,
  getDatabaseClient,
  disconnectDatabase,
  type Database,
  type DatabaseClient,
  type DatabaseClientOptions,
  type PrismaClient,
} from './client';

export {
  checkDatabaseHealth,
  type DatabaseHealth,
  type DatabaseHealthStatus,
  type DatabaseHealthOptions,
} from './health';

export {
  DatabaseError,
  UniqueConstraintError,
  RecordNotFoundError,
  InvalidTransitionError,
  toDomainError,
  withDomainErrors,
} from './errors';

export { cursorQuery, resolveLimit, toPage } from './pagination';

export * as users from './repositories/users';
export * as spaces from './repositories/spaces';
export * as work from './repositories/work';
export * as calendar from './repositories/calendar';
export * as delivery from './repositories/delivery';
export * as audit from './repositories/audit';

// Prisma's generated namespace, for callers that need a filter type or an enum
// value. Re-exported from one place so no consumer reaches into `src/generated`.
export { Prisma } from './generated/prisma/client';
export type {
  User,
  UserPreferences,
  PlanningPreferences,
  WorkingHoursBlock,
  Space,
  SpaceItem,
  Task,
  Reminder,
  Goal,
  CalendarConnection,
  Calendar,
  CalendarEvent,
  Notification,
  EmailLog,
  AgentAction,
  EventLog,
  ProductivitySnapshot,
} from './generated/prisma/client';
