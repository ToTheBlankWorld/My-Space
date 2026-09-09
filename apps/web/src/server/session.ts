import 'server-only';

import type { SessionContext } from '@space/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuthService } from './auth';

/**
 * Session access for Server Components, Route Handlers and Server Actions.
 *
 * These are the only sanctioned ways to learn who is making a request. Each one
 * reads the session cookie through `next/headers`; none of them accepts a user
 * identifier from a caller, because a value the browser supplied is input rather
 * than proof.
 */

export const LOGIN_PATH = '/login';
export const ONBOARDING_PATH = '/onboarding';
export const DASHBOARD_PATH = '/dashboard';

/**
 * Resolves the session, or `null` for an anonymous visitor.
 *
 * The try/catch handles the case where the auth stack cannot be constructed —
 * for example a clean checkout with no `DATABASE_URL`. No database means no
 * sessions, so the visitor is anonymous. This keeps the public landing page
 * prerenderable without a running backend.
 */
export const getOptionalUser = async (): Promise<SessionContext | null> => {
  try {
    return await getAuthService().getOptionalUser(await headers());
  } catch {
    return null;
  }
};

/**
 * Resolves the session or redirects to sign in.
 *
 * Redirecting rather than throwing is deliberate for page rendering: an expired
 * session should return the visitor to the login screen, not an error page.
 */
export const requireUser = async (): Promise<SessionContext> => {
  const context = await getOptionalUser();

  if (!context) {
    redirect(LOGIN_PATH);
  }

  return context;
};

/**
 * Resolves an onboarded session, sending the user to onboarding if they are not.
 *
 * The application shell calls this so that no protected page has to remember the
 * check, and so an unfinished account cannot reach a screen that assumes a
 * timezone and working hours exist.
 */
export const requireOnboardedUser = async (): Promise<SessionContext> => {
  const context = await requireUser();

  if (!context.user.onboardingCompleted) {
    redirect(ONBOARDING_PATH);
  }

  return context;
};
