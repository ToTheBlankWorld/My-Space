import { audit, type Database } from '@space/database';

/**
 * Emits calendar lifecycle events into the append-only event log.
 *
 * The payload never contains credentials; connection state belongs in the log,
 * tokens never do. `occurredAt` is left to the repository default (the database
 * clock is the single time source for the audit trail).
 */

type CalendarConnectionEventType =
  'CALENDAR_CONNECTED' | 'CALENDAR_DISCONNECTED' | 'CALENDAR_SYNCED' | 'CALENDAR_SYNC_FAILED';

export const recordCalendarConnectionEvent = async (
  db: Database,
  userId: string,
  input: {
    eventType: CalendarConnectionEventType;
    connectionId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> => {
  await audit.appendEvent(db, userId, {
    eventType: input.eventType,
    aggregateType: 'CALENDAR_CONNECTION',
    aggregateId: input.connectionId,
    payload: input.payload,
  });
};
