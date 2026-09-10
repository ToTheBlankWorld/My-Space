import { describe, expect, it } from 'vitest';

import { classifyChange, atLeast, classificationRank, IMPACT_HORIZON_DAYS } from './change';

describe('classifyChange', () => {
  it('classifies CALENDAR_CHANGED as REPLAN_REQUIRED', () => {
    const result = classifyChange('CALENDAR_CHANGED');
    expect(result.classification).toBe('REPLAN_REQUIRED');
    expect(result.reasonCode).toBe('CALENDAR_CHANGED');
  });

  it('classifies CALENDAR_SYNCED as REPLAN_REQUIRED', () => {
    const result = classifyChange('CALENDAR_SYNCED');
    expect(result.classification).toBe('REPLAN_REQUIRED');
    expect(result.reasonCode).toBe('CALENDAR_CHANGED');
  });

  it('classifies TASK_CREATED as REPLAN_REQUIRED', () => {
    const result = classifyChange('TASK_CREATED');
    expect(result.classification).toBe('REPLAN_REQUIRED');
    expect(result.reasonCode).toBe('TASK_CHANGED');
  });

  it('classifies TASK_COMPLETED as REPLAN_REQUIRED', () => {
    const result = classifyChange('TASK_COMPLETED');
    expect(result.classification).toBe('REPLAN_REQUIRED');
    expect(result.reasonCode).toBe('TASK_COMPLETED');
  });

  it('classifies CALENDAR_CONNECTED as REVIEW_ONLY', () => {
    const result = classifyChange('CALENDAR_CONNECTED');
    expect(result.classification).toBe('REVIEW_ONLY');
    expect(result.reasonCode).toBe('REVIEW_ONLY');
  });

  it('classifies CALENDAR_SYNC_FAILED as REVIEW_ONLY', () => {
    const result = classifyChange('CALENDAR_SYNC_FAILED');
    expect(result.classification).toBe('REVIEW_ONLY');
    expect(result.reasonCode).toBe('REVIEW_ONLY');
  });

  it('classifies PLANNING_COMPLETED as NO_REPLAN', () => {
    const result = classifyChange('PLANNING_COMPLETED');
    expect(result.classification).toBe('NO_REPLAN');
    expect(result.reasonCode).toBe('NO_CHANGE');
  });

  it('classifies DEADLINE_APPROACHING as NO_REPLAN', () => {
    const result = classifyChange('DEADLINE_APPROACHING');
    expect(result.classification).toBe('NO_REPLAN');
    expect(result.reasonCode).toBe('NO_CHANGE');
  });

  it('classifies unknown event types as NO_REPLAN', () => {
    const result = classifyChange('SOME_NEW_EVENT');
    expect(result.classification).toBe('NO_REPLAN');
    expect(result.reasonCode).toBe('NO_CHANGE');
  });

  it('classifies TASK_MISSED as REVIEW_ONLY', () => {
    const result = classifyChange('TASK_MISSED');
    expect(result.classification).toBe('REVIEW_ONLY');
    expect(result.reasonCode).toBe('REVIEW_ONLY');
  });

  it('classifies REMINDER_CREATED as REVIEW_ONLY', () => {
    const result = classifyChange('REMINDER_CREATED');
    expect(result.classification).toBe('REVIEW_ONLY');
    expect(result.reasonCode).toBe('REVIEW_ONLY');
  });
});

describe('atLeast', () => {
  it('returns true when a is at least as loud as b', () => {
    expect(atLeast('REPLAN_REQUIRED', 'REVIEW_ONLY')).toBe(true);
    expect(atLeast('URGENT_REPLAN', 'REPLAN_REQUIRED')).toBe(true);
    expect(atLeast('NO_REPLAN', 'NO_REPLAN')).toBe(true);
  });

  it('returns false when a is quieter than b', () => {
    expect(atLeast('REVIEW_ONLY', 'REPLAN_REQUIRED')).toBe(false);
    expect(atLeast('NO_REPLAN', 'REVIEW_ONLY')).toBe(false);
  });
});

describe('classificationRank', () => {
  it('orders classifications monotonically', () => {
    expect(classificationRank.NO_REPLAN).toBeLessThan(classificationRank.REVIEW_ONLY);
    expect(classificationRank.REVIEW_ONLY).toBeLessThan(classificationRank.REPLAN_REQUIRED);
    expect(classificationRank.REPLAN_REQUIRED).toBeLessThan(classificationRank.URGENT_REPLAN);
  });
});

describe('IMPACT_HORIZON_DAYS', () => {
  it('is a positive number', () => {
    expect(IMPACT_HORIZON_DAYS).toBeGreaterThan(0);
  });
});
