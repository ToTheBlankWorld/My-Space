import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS } from '@/lib/calendar-oauth';
import {
  buildAuthorizationUrl,
  createOAuthState,
  getCalendarDatabase,
  getGoogleOAuthConfig,
} from '@/server/calendar';
import { requireUser } from '@/server/session';

/**
 * GET /api/calendar/connection
 *
 * Returns the calendar connections for the authenticated user, each with its
 * calendar count. Nothing token-shaped is ever returned.
 */
export const GET = async (): Promise<NextResponse> => {
  const user = await requireUser();
  const db = getCalendarDatabase();

  const connections = await db.calendarConnection.findMany({
    where: { userId: user.user.id },
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      status: true,
      grantedScopes: true,
      lastSyncedAt: true,
      lastErrorAt: true,
      _count: { select: { calendars: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ connections });
};

/**
 * POST /api/calendar/connection
 *
 * Initiates the Google Calendar OAuth flow and returns the URL the client
 * should redirect the user to for consent.
 *
 * This is separate from the sign-in OAuth flow. The user is already
 * authenticated; this adds the calendar read scope to their Google account.
 * The `state` value is stored in a short-lived HttpOnly cookie and must come
 * back unchanged on the callback, or the authorization code is discarded.
 */
export const POST = async () => {
  await requireUser();
  const cfg = getGoogleOAuthConfig();

  const state = createOAuthState();

  const url = buildAuthorizationUrl({ cfg, state });

  // Read-before-write is the CSRF defence: the callback compares the `state`
  // query parameter against this cookie, so a forged callback cannot replay a
  // code the attacker never saw in a consent screen.
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });

  return NextResponse.json({ url });
};
