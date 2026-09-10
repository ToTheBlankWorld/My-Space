import 'server-only';

import { createLogger, type Logger } from '@space/logger';
import { createPlanSpaceService, type PlanSpaceService } from '@space/planning';

import { clock } from './clock';
import { getDatabase } from './database';

/**
 * The web application's planning composition root.
 *
 * Resolves the shared database handle, the injected clock and a planning logger
 * once, and caches the service on `globalThis` so a hot reload does not rebuild
 * it. The service itself is stateless apart from an in-flight dedup map, so a
 * single instance is safe and correct to share across requests.
 *
 * The identity of the requesting user never comes from here — callers pass the
 * session's `user.id` that `server/session.ts` resolved from the cookie.
 */

const cache = globalThis as typeof globalThis & {
  __spacePlanningService?: PlanSpaceService;
  __spacePlanningLogger?: Logger;
};

export const getPlanningLogger = (): Logger => {
  cache.__spacePlanningLogger ??= createLogger({
    name: 'space-planning',
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });
  return cache.__spacePlanningLogger;
};

export const getPlanningService = (): PlanSpaceService => {
  cache.__spacePlanningService ??= createPlanSpaceService({
    db: getDatabase(),
    clock,
    logger: getPlanningLogger(),
  });
  return cache.__spacePlanningService;
};
