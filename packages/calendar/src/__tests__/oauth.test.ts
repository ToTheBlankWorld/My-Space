import { describe, expect, it } from 'vitest';

import {
  buildAuthorizationUrl,
  CALENDAR_SCOPE,
  IDENTITY_SCOPES,
  type GoogleOAuthConfig,
} from '../oauth';

const cfg: GoogleOAuthConfig = {
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/api/calendar/callback',
};

describe('oauth scopes', () => {
  it('requests read-only calendar access', () => {
    expect(CALENDAR_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('pairs identity scopes with calendar access', () => {
    expect([...IDENTITY_SCOPES, CALENDAR_SCOPE]).toEqual([
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
  });
});

describe('buildAuthorizationUrl', () => {
  const url = (href: string): URLSearchParams => new URL(href).searchParams;

  it('points at the Google consent endpoint', () => {
    const href = buildAuthorizationUrl({ cfg, state: 'anti-csrf-token' });
    const parsed = new URL(href);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('echoes the anti-CSRF state back to Google', () => {
    expect(url(buildAuthorizationUrl({ cfg, state: 'state-123' })).get('state')).toBe('state-123');
  });

  it('asks for offline access so a refresh token is issued', () => {
    const params = url(buildAuthorizationUrl({ cfg, state: 's' }));
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
  });

  it('bundles identity and calendar scopes', () => {
    const scope = url(buildAuthorizationUrl({ cfg, state: 's' })).get('scope') ?? '';
    expect(scope.split(' ')).toEqual([...IDENTITY_SCOPES, CALENDAR_SCOPE]);
  });

  it('uses the callback redirect URI', () => {
    expect(url(buildAuthorizationUrl({ cfg, state: 's' })).get('redirect_uri')).toBe(
      cfg.redirectUri,
    );
  });
});
