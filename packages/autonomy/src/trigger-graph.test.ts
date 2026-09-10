import { describe, expect, it } from 'vitest';

import {
  resolveTriggerNode,
  allTriggerNodes,
  REPLAN_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
} from './trigger-graph';

describe('resolveTriggerNode', () => {
  it('resolves TASK_CREATED to REPLAN_REQUIRED / TASK_CHANGED / EVENT_DATE', () => {
    const node = resolveTriggerNode('TASK_CREATED');
    expect(node.baseClassification).toBe('REPLAN_REQUIRED');
    expect(node.reasonCode).toBe('TASK_CHANGED');
    expect(node.resolutionStrategy).toBe('EVENT_DATE');
    expect(node.requiresReplan).toBe(true);
  });

  it('resolves TASK_COMPLETED to REPLAN_REQUIRED / TASK_COMPLETED', () => {
    const node = resolveTriggerNode('TASK_COMPLETED');
    expect(node.baseClassification).toBe('REPLAN_REQUIRED');
    expect(node.reasonCode).toBe('TASK_COMPLETED');
    expect(node.requiresReplan).toBe(true);
  });

  it('resolves CALENDAR_CHANGED to REPLAN_REQUIRED / CALENDAR_CHANGED / CALENDAR_SYNC', () => {
    const node = resolveTriggerNode('CALENDAR_CHANGED');
    expect(node.baseClassification).toBe('REPLAN_REQUIRED');
    expect(node.reasonCode).toBe('CALENDAR_CHANGED');
    expect(node.resolutionStrategy).toBe('CALENDAR_SYNC');
    expect(node.requiresReplan).toBe(true);
  });

  it('resolves TASK_MISSED to REVIEW_ONLY / TASK_MISSED_ELAPSED', () => {
    const node = resolveTriggerNode('TASK_MISSED');
    expect(node.baseClassification).toBe('REVIEW_ONLY');
    expect(node.reasonCode).toBe('TASK_MISSED_ELAPSED');
    expect(node.requiresReplan).toBe(false);
  });

  it('resolves PLANNING_COMPLETED to NO_REPLAN', () => {
    const node = resolveTriggerNode('PLANNING_COMPLETED');
    expect(node.baseClassification).toBe('NO_REPLAN');
    expect(node.requiresReplan).toBe(false);
  });

  it('returns a default node with NO_REPLAN for unknown event types', () => {
    const node = resolveTriggerNode('UNKNOWN_EVENT_TYPE');
    expect(node.baseClassification).toBe('NO_REPLAN');
    expect(node.requiresReplan).toBe(false);
    expect(node.requiresNotification).toBe(false);
    expect(node.eventType).toBe('UNKNOWN_EVENT_TYPE');
  });
});

describe('REPLAN_EVENT_TYPES', () => {
  it('contains TASK_CREATED', () => {
    expect(REPLAN_EVENT_TYPES.has('TASK_CREATED')).toBe(true);
  });

  it('contains TASK_COMPLETED', () => {
    expect(REPLAN_EVENT_TYPES.has('TASK_COMPLETED')).toBe(true);
  });

  it('contains CALENDAR_CHANGED', () => {
    expect(REPLAN_EVENT_TYPES.has('CALENDAR_CHANGED')).toBe(true);
  });

  it('contains TASK_UPDATED', () => {
    expect(REPLAN_EVENT_TYPES.has('TASK_UPDATED')).toBe(true);
  });

  it('does NOT contain PLANNING_COMPLETED', () => {
    expect(REPLAN_EVENT_TYPES.has('PLANNING_COMPLETED')).toBe(false);
  });

  it('does NOT contain GOAL_CREATED', () => {
    expect(REPLAN_EVENT_TYPES.has('GOAL_CREATED')).toBe(false);
  });

  it('does NOT contain NOTIFICATION_SENT', () => {
    expect(REPLAN_EVENT_TYPES.has('NOTIFICATION_SENT')).toBe(false);
  });
});

describe('NOTIFICATION_EVENT_TYPES', () => {
  it('contains TASK_MISSED', () => {
    expect(NOTIFICATION_EVENT_TYPES.has('TASK_MISSED')).toBe(true);
  });
});

describe('allTriggerNodes', () => {
  it('returns a Map with at least 20 entries', () => {
    const nodes = allTriggerNodes();
    expect(nodes.size).toBeGreaterThanOrEqual(20);
  });

  it('every registered node has non-empty reasonCode and resolutionStrategy', () => {
    const nodes = allTriggerNodes();
    for (const [eventType, node] of nodes) {
      expect(node.reasonCode, `reasonCode empty for ${eventType}`).not.toBe('');
      expect(node.resolutionStrategy, `resolutionStrategy empty for ${eventType}`).not.toBe('');
    }
  });
});
