import { describe, expect, it } from 'vitest';

import {
  TASK_STATUSES,
  TASK_STATUS_TRANSITIONS,
  canTransitionTask,
  isTerminalTaskStatus,
  type TaskStatus,
} from '../domain';

describe('task status transitions', () => {
  it('defines a transition list for every status', () => {
    expect(Object.keys(TASK_STATUS_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('only ever targets a known status', () => {
    for (const targets of Object.values(TASK_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(TASK_STATUSES).toContain(target);
      }
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const [from, targets] of Object.entries(TASK_STATUS_TRANSITIONS)) {
      expect(targets).not.toContain(from as TaskStatus);
    }
  });

  it.each([
    ['INBOX', 'PLANNED'],
    ['PLANNED', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'COMPLETED'],
    ['MISSED', 'RESCHEDULED'],
    ['RESCHEDULED', 'PLANNED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
  });

  it.each([
    ['COMPLETED', 'IN_PROGRESS'],
    ['CANCELLED', 'PLANNED'],
    ['INBOX', 'MISSED'],
    ['INBOX', 'RESCHEDULED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(false);
  });

  it('treats completed and cancelled as terminal, and nothing else', () => {
    const terminal = TASK_STATUSES.filter(isTerminalTaskStatus);

    expect(terminal).toEqual(['COMPLETED', 'CANCELLED']);
  });

  it('keeps every non-terminal status reachable from some other status', () => {
    const reachable = new Set(Object.values(TASK_STATUS_TRANSITIONS).flat());

    for (const status of TASK_STATUSES) {
      if (status === 'INBOX') {
        // The entry point: tasks are created here rather than transitioned into it
        // from nowhere, though PLANNED can fall back to it.
        continue;
      }
      expect(reachable.has(status)).toBe(true);
    }
  });

  it('freezes the table so a caller cannot mutate the rules at runtime', () => {
    expect(Object.isFrozen(TASK_STATUS_TRANSITIONS)).toBe(true);
  });
});
