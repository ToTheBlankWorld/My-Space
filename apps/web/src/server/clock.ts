import 'server-only';

import { SystemClock, type Clock } from '@space/time';

/**
 * The web application's clock.
 *
 * This is a composition root: the one place in `apps/web` that decides what
 * "now" means. Everything that depends on time — onboarding completion, session
 * expiry, anything the planning engines will add — receives this instance as an
 * argument rather than reading the host clock itself.
 *
 * It is a constant, not a mutable global: nothing may reassign it at runtime, so
 * a test cannot accidentally leak a fake clock into another test, and production
 * code cannot be quietly redirected. Tests inject their own `FixedClock` into
 * the function under test instead.
 */
export const clock: Clock = new SystemClock();
