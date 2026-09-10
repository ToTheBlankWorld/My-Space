import { google } from 'googleapis';

import { CalendarAuthError, CalendarTransientError } from './errors';

/**
 * Google OAuth consent flow for calendar access.
 *
 * This is the second, incremental authorization: sign-in already holds identity
 * scopes (`openid email profile`), and this flow adds calendar read access on an
 * already-authenticated user, through its own redirect URI
 * (`/api/calendar/callback`). The two flows share a client id/secret but are
 * otherwise independent — consent here cannot create or disturb the user's
 * Space session.
 *
 * Only `calendar.readonly` is requested: this stage *imports* the user's
 * calendars for scheduling. A write scope is the smallest increment later and
 * the largest consent surprise now.
 */

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * Identity scopes re-requested on the connect flow.
 *
 * They are not strictly required for calendar reads, but they make Google issue
 * an `id_token`, whose `sub` identifies the exact Google account that granted
 * consent. That lets the callback key the connection by account rather than
 * trusting which account the browser claims it is.
 */
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Absolute redirect URI; must match a verified Google Console redirect URI. */
  redirectUri: string;
}

/** Client credentials only; enough for token refresh, where no redirect occurs. */
export type GoogleClientCredentials = Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>;

export interface AuthorizationUrlInput {
  cfg: GoogleOAuthConfig;
  /**
   * Opaque anti-CSRF token. It is echoed back by Google on the callback and
   * must equal the value stored when the flow started.
   */
  state: string;
  /**
   * Marked `true` when the previous token set lacked the calendar scope, forcing
   * Google to show the consent screen again rather than silently reusing the
   * first consent.
   */
  promptConsent?: boolean;
}

/**
 * Builds the URL a user is redirected to for calendar consent.
 */
export const buildAuthorizationUrl = ({
  cfg,
  state,
  promptConsent = true,
}: AuthorizationUrlInput): string => {
  const client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: promptConsent ? 'consent' : undefined,
    scope: [...IDENTITY_SCOPES, CALENDAR_SCOPE],
    state,
    include_granted_scopes: true,
  });
};

/**
 * The result of exchanging an authorization code.
 */
export interface CalendarTokenGrant {
  /** Short-lived bearer credential for API calls. */
  accessToken: string;
  /** Long-lived credential for obtaining new access tokens; absent on reuse. */
  refreshToken: string | null;
  /** When `accessToken` stops working. Null when the provider did not say. */
  expiresAt: Date | null;
  /** Space-separated scopes actually granted on this consent. */
  grantedScopes: string;
  /** JWT identifying the granting Google account; present when `openid` scope. */
  idToken: string | null;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * Raises {@link CalendarAuthError} when Google rejects the code (expired,
 * already used, wrong client) and {@link CalendarTransientError} on a transport
 * failure, matching the classification the retry layer expects.
 */
export const exchangeAuthorizationCode = async (
  cfg: GoogleOAuthConfig,
  code: string,
): Promise<CalendarTokenGrant> => {
  const client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);

  let tokenResponse;
  try {
    ({ tokens: tokenResponse } = await client.getToken(code));
  } catch (error) {
    const apiError = error as { response?: { data?: unknown }; message?: string };

    if (apiError.response) {
      throw new CalendarAuthError('Google rejected the authorization code.', { cause: error });
    }

    throw new CalendarTransientError(
      `Token exchange failed: ${apiError.message ?? 'unknown error'}`,
      {
        cause: error,
      },
    );
  }

  if (!tokenResponse.access_token) {
    throw new CalendarAuthError('Google token exchange returned no access token.');
  }

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt: tokenResponse.expiry_date ? new Date(tokenResponse.expiry_date) : null,
    grantedScopes: tokenResponse.scope ?? '',
    idToken: tokenResponse.id_token ?? null,
  };
};

/**
 * Extracts the Google account subject from an `id_token` JWT.
 *
 * Verifies the signature against the client and returns `sub`. Raises
 * {@link CalendarAuthError} on an unverifiable token.
 */
export const getGoogleSubject = async (
  cfg: Pick<GoogleOAuthConfig, 'clientId'>,
  idToken: string,
): Promise<string> => {
  const client = new google.auth.OAuth2(cfg.clientId);
  const ticket = await client.verifyIdToken({ idToken, audience: cfg.clientId });
  const payload = ticket.getPayload();

  if (!payload?.sub) {
    throw new CalendarAuthError('Google id token carries no subject.');
  }

  return payload.sub;
};

export interface RefreshedAccessToken {
  accessToken: string;
  expiresAt: Date | null;
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * Used by the sync worker when a stored access token has expired. A rejected
 * refresh means the user revoked access or the token was rotated away; callers
 * surface it as {@link CalendarAuthError} so the connection can be marked
 * needing re-consent instead of being retried forever.
 */
export const refreshAccessToken = async (
  cfg: GoogleClientCredentials,
  refreshToken: string,
): Promise<RefreshedAccessToken> => {
  const client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  client.setCredentials({ refresh_token: refreshToken });

  let refreshed;
  try {
    refreshed = await client.refreshAccessToken();
  } catch (error) {
    const apiError = error as { response?: { data?: unknown }; message?: string };

    if (apiError.response) {
      throw new CalendarAuthError('Google rejected the refresh token.', { cause: error });
    }

    throw new CalendarTransientError(`Refresh failed: ${apiError.message ?? 'unknown error'}`, {
      cause: error,
    });
  }

  const tokenResponse = refreshed.credentials;

  if (!tokenResponse.access_token) {
    throw new CalendarAuthError('Google refresh returned no access token.');
  }

  return {
    accessToken: tokenResponse.access_token,
    expiresAt: tokenResponse.expiry_date ? new Date(tokenResponse.expiry_date) : null,
  };
};
