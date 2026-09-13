import { describe, expect, it } from 'vitest';

import {
  QUEUE_NAMES,
  autoSyncScheduleKey,
  deliveryJobId,
  manualSyncDedupeKey,
} from '../queueing';

/**
 * Queue naming and durable-queue identity rules. Queue names are stable
 * identifiers shared by the web producer and the worker consumer; the
 * dedupe/schedule key builders are what keep the durable queue free of
 * duplicate work.
 */
describe('queueing', () => {
  it('uses stable, colon-free queue names', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).not.toMatch(/:/);
    }
    expect(Object.keys(QUEUE_NAMES)).toEqual([
      'calendarSync',
      'calendarRefresh',
      'maintenance',
      'planning',
      'notifications',
      'autonomyReview',
    ]);
  });

  describe('deliveryJobId', () => {
    it('produces the deterministic per-email-log dedupe key', () => {
      expect(deliveryJobId('clx_email_log_1')).toBe('delivery-clx_email_log_1');
    });

    it('is deterministic per email log', () => {
      expect(deliveryJobId('clx_email_log_1')).toBe(deliveryJobId('clx_email_log_1'));
      expect(deliveryJobId('clx_email_log_1')).not.toBe(deliveryJobId('clx_email_log_2'));
    });
  });

  describe('postgres queue identities', () => {
    it('builds the canonical auto-sync schedule key', () => {
      expect(autoSyncScheduleKey('clx_conn_1')).toBe('auto-sync-clx_conn_1');
    });

    it('builds the manual sync dedupe key with an all-calendars fallback', () => {
      expect(manualSyncDedupeKey('clx_conn_1')).toBe('manual:clx_conn_1:all');
      expect(manualSyncDedupeKey('clx_conn_1', 'clx_cal_9')).toBe('manual:clx_conn_1:clx_cal_9');
    });

    it('is deterministic per connection and target', () => {
      expect(manualSyncDedupeKey('c1', 'k1')).toBe(manualSyncDedupeKey('c1', 'k1'));
      expect(manualSyncDedupeKey('c1', 'k1')).not.toBe(manualSyncDedupeKey('c1', 'k2'));
      expect(manualSyncDedupeKey('c1', 'k1')).not.toBe(manualSyncDedupeKey('c2', 'k1'));
      expect(autoSyncScheduleKey('c1')).not.toBe(autoSyncScheduleKey('c2'));
    });
  });
});
