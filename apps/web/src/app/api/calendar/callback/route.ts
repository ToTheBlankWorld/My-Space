import { calendar } from '@space/database';
import {
  encryptCalendarTokens,
  exchangeAuthorizationCode,
  getGoogleSubject,
  GoogleCalendarProvider,
  recordCalendarConnectionEvent,
} from '@space/calendar';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import {
  getCalendarDatabase,
  getCalendarKeyring,
  getCalendarLogger,
  getGoogleOAuthConfig,
} from '@/server/calendar';
import {
  calendarQueueAvailable,
  enqueueCalendarSync,
  scheduleCalendarAutoSync,
} from '@/server/calendar-queue';
import { OAUTH_STATE_COOKIE } from '@/lib/calendar-oauth';
import { requireUser } from '@/server/session';

/**
 * GET /api/calendar/callback
 *
 * Google bounce-back for the calendar consent flow.
 *
 * Security invariants:
 *   - The callback is unauthenticated (Google does not know our cookie). The
 *     anti-CSRF `state` is the only thing that ties a `code` to the session
 *     that started the flow; a missing or mismatched value discards the code.
 *   - The `code` is a one-time credential. It is exchanged immediately, and
 *     never logged, mirrored into analytics, or returned to a client.
 *   - Tokens are encrypted at rest before being stored. The database never
 *     sees plaintext.
 *   - The Google account that consented is the one identified by the `sub` in
 *     the verified id token — not whatever the caller claims.
 */

/** Builds the dashboard URL a completed or failed flow lands on. */
const dashboardRedirect = (calendar: string): NextResponse<unknown> => {
  const url = new URL('/dashboard', process.env.APP_URL ?? 'http://localhost:3000');
  url.searchParams.set('calendar', calendar);
  return NextResponse.redirect(url);
};

export const GET = async (request: NextRequest) => {
  const logger = getCalendarLogger();
  const cfg = getGoogleOAuthConfig();
  const keyring = getCalendarKeyring();
  const db = getCalendarDatabase();

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const errorParam = searchParams.get('error');

  const clearStateCookie = (response: NextResponse<unknown>): NextResponse<unknown> => {
    response.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  };

  if (errorParam) {
    logger.warn({ error: errorParam }, 'google calendar consent failed');
    return clearStateCookie(dashboardRedirect('denied'));
  }

  if (!code || !state) {
    logger.warn('calendar oauth callback missing code or state');
    return clearStateCookie(dashboardRedirect('invalid'));
  }

  // CSRF: the state must match the cookie written when the flow started.
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!expectedState || expectedState !== state) {
    logger.warn('calendar oauth state mismatch; discarding authorization code');
    return clearStateCookie(dashboardRedirect('state'));
  }

  // Resolve the session that owns the state cookie (it is HttpOnly and only
  // ever set by an authenticated POST /api/calendar/connection).
  const user = await requireUser();

  let grant;
  try {
    grant = await exchangeAuthorizationCode(cfg, code);
  } catch (error) {
    logger.warn({ err: error }, 'calendar oauth code exchange failed');
    return clearStateCookie(dashboardRedirect('exchange'));
  }

  if (!grant.refreshToken) {
    // Google issues a refresh token only on the first consent for offline
    // access. Without one the connection could never sync while the user is
    // away, so treat it as a failed connect rather than silently degrading.
    logger.warn('google consent returned no refresh token');
    return clearStateCookie(dashboardRedirect('norefresh'));
  }

  // Identify the Google account that consented.
  let providerAccountId: string;
  if (grant.idToken) {
    try {
      providerAccountId = await getGoogleSubject(cfg, grant.idToken);
    } catch (error) {
      logger.warn({ err: error }, 'could not verify google id token');
      return clearStateCookie(dashboardRedirect('identity'));
    }
  } else {
    // Fall back to the identity account bound to this user's session.
    const linked = await db.account.findFirst({
      where: { userId: user.user.id, providerId: 'google' },
      select: { accountId: true },
    });
    if (!linked) {
      logger.warn({ userId: user.user.id }, 'no google identity linked to user');
      return clearStateCookie(dashboardRedirect('identity'));
    }
    providerAccountId = linked.accountId;
  }

  // Encrypt at the storage boundary. The plaintext access token is dropped when
  // this function returns and never reaches disk, the database or a log.
  const encrypted = encryptCalendarTokens(keyring, {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    accessTokenExpiresAt: grant.expiresAt,
  });

  const connected = await calendar.upsertCalendarConnection(db, user.user.id, {
    provider: 'GOOGLE',
    providerAccountId,
    grantedScopes: grant.grantedScopes,
    accessToken: encrypted.accessToken,
    refreshToken: encrypted.refreshToken,
    accessTokenExpiresAt: encrypted.accessTokenExpiresAt,
  });

  await recordCalendarConnectionEvent(db, user.user.id, {
    eventType: 'CALENDAR_CONNECTED',
    connectionId: connected.id,
    payload: { provider: 'GOOGLE', providerAccountId },
  });

  // Discover and mirror the user's calendars now, so the dashboard can show
  // them without waiting for the first sync. Best-effort: a transient Google
  // failure must not undo a successful connection.
  try {
    const provider = new GoogleCalendarProvider();
    const providerCalendars = await provider.listCalendars(grant.accessToken);
    const connection = await db.calendarConnection.findUnique({
      where: {
        userId_provider_providerAccountId: {
          userId: user.user.id,
          provider: 'GOOGLE',
          providerAccountId,
        },
      },
      select: { id: true },
    });

    if (connection) {
      for (const providerCalendar of providerCalendars) {
        await calendar.upsertCalendar(db, user.user.id, {
          connectionId: connection.id,
          externalId: providerCalendar.externalId,
          name: providerCalendar.name,
          timeZone: providerCalendar.timeZone,
          description: providerCalendar.description ?? null,
          isPrimary: providerCalendar.isPrimary,
          color: providerCalendar.color ?? null,
        });
      }
    }
  } catch (error) {
    logger.warn({ err: error }, 'calendar mirror discovery failed');
  }

  // Kick off the first sync now, so events are visible without waiting for the
  // periodic job. Both enqueue and the repeatable registration are best-effort:
  // they need Redis, which many local environments do not run.
  if (calendarQueueAvailable()) {
    await enqueueCalendarSync({ userId: user.user.id, connectionId: connected.id, fullSync: true });
    await scheduleCalendarAutoSync({ userId: user.user.id, connectionId: connected.id });
  }

  logger.info({ userId: user.user.id, providerAccountId }, 'google calendar connected');

  return clearStateCookie(dashboardRedirect('connected'));
};
