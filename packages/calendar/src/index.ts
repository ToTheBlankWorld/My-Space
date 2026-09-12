export {
  CalendarError,
  CalendarAuthError,
  CalendarPermissionError,
  CalendarRateLimitError,
  CalendarTransientError,
  CalendarSyncTokenExpiredError,
  CalendarValidationError,
} from './errors';
export { GoogleCalendarProvider } from './google-provider';
export {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  getGoogleSubject,
  CALENDAR_SCOPE,
  IDENTITY_SCOPES,
} from './oauth';
export type {
  GoogleOAuthConfig,
  GoogleClientCredentials,
  AuthorizationUrlInput,
  CalendarTokenGrant,
  RefreshedAccessToken,
} from './oauth';
export { encryptCalendarTokens, decryptCalendarTokens } from './token-store';
export type { EncryptedCalendarTokens, DecryptedCalendarTokens } from './token-store';
export { syncCalendar, syncAllCalendars, discoverCalendarsForConnection } from './sync';
export { recordCalendarConnectionEvent } from './audit-events';
export { resolveConnectionAccessToken } from './resolve-access-token';
export type { ResolveAccessTokenDeps, ResolveAccessTokenResult } from './resolve-access-token';
export type {
  CalendarProviderAdapter,
  NormalizedCalendarEvent,
  ProviderCalendar,
  SyncResult,
} from './types';
export type { SyncContext, SyncCalendarInput, SyncConnectionInput } from './sync';
