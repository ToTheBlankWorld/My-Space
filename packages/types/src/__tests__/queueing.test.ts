import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES, QUEUE_PREFIX, autoSyncJobId, deliveryJobId } from '../queueing';

/**
 * BullMQ 5.81+ rejects a custom job id that contains ':' unless it carries
 * exactly three colon-separated segments (the legacy repeatable form). An id
 * with no ':' at all is always accepted.
 */
const bullmqAcceptsCustomJobId = (jobId: string): boolean =>
  !jobId.includes(':') || jobId.split(':').length === 3;

describe('queueing', () => {
  it('namespaces queues by prefix, never by a colon in the queue name', () => {
    expect(QUEUE_PREFIX).toBe('space');
    expect(QUEUE_PREFIX).not.toMatch(/:/);
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).not.toMatch(/:/);
    }
  });

  describe('deliveryJobId', () => {
    it('produces the exact colon-free deterministic id', () => {
      expect(deliveryJobId('clx_email_log_1')).toBe('delivery-clx_email_log_1');
    });

    it('is deterministic per email log', () => {
      expect(deliveryJobId('clx_email_log_1')).toBe(deliveryJobId('clx_email_log_1'));
      expect(deliveryJobId('clx_email_log_1')).not.toBe(deliveryJobId('clx_email_log_2'));
    });

    it('satisfies the BullMQ 5.81 custom job id validation', () => {
      expect(bullmqAcceptsCustomJobId(deliveryJobId('clx_email_log_1'))).toBe(true);
    });
  });

  describe('autoSyncJobId', () => {
    it('produces the exact colon-free deterministic id', () => {
      expect(autoSyncJobId('conn_abc')).toBe('auto-sync-conn_abc');
    });

    it('is deterministic per connection', () => {
      expect(autoSyncJobId('conn_abc')).toBe(autoSyncJobId('conn_abc'));
      expect(autoSyncJobId('conn_abc')).not.toBe(autoSyncJobId('conn_def'));
    });

    it('satisfies the BullMQ 5.81 custom job id validation', () => {
      expect(bullmqAcceptsCustomJobId(autoSyncJobId('conn_abc'))).toBe(true);
    });
  });
});
