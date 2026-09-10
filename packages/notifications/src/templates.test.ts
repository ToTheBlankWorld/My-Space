import { describe, expect, it } from 'vitest';

import { formatDate, renderEmail } from './templates';
import { TEMPLATE_NAMES } from './types';

const APP_URL = 'https://space.example.com';

describe('renderEmail', () => {
  it('renders the morning brief with counts and an escaped heading', () => {
    const email = renderEmail(
      'morning-brief',
      {
        date: '2026-09-10',
        tomorrowDate: '2026-09-11',
        tomorrowPlanned: true,
        openTaskCount: 3,
        scheduledTodayCount: 5,
        completedTodayCount: 2,
        deadlineCount: 1,
        planUrl: `${APP_URL}/space/2026-09-10`,
      },
      APP_URL,
    );

    expect(email.subject).toContain('3 tasks open');
    expect(email.html).toContain('<b>3</b> task');
    expect(email.html).toContain(`href="${APP_URL}/space/2026-09-10"`);
  });

  it('drops any link that is not same-origin https', () => {
    const email = renderEmail(
      'morning-brief',
      {
        date: '2026-09-10',
        tomorrowDate: '2026-09-11',
        tomorrowPlanned: true,
        openTaskCount: 1,
        scheduledTodayCount: 1,
        completedTodayCount: 0,
        deadlineCount: 0,
        planUrl: 'https://evil.example.com/phish',
      },
      APP_URL,
    );

    expect(email.html).not.toContain('evil.example.com');
    expect(email.html).not.toContain('<a href=');
  });

  it('deep-link buttons are only emitted for same-origin urls', () => {
    const email = renderEmail(
      'morning-brief',
      {
        date: '2026-09-10',
        tomorrowDate: '2026-09-11',
        tomorrowPlanned: false,
        openTaskCount: 0,
        scheduledTodayCount: 0,
        completedTodayCount: 0,
        deadlineCount: 0,
        planUrl: `http://${APP_URL.split('://')[1]}/space/2026-09-10`,
      },
      APP_URL,
    );

    expect(email.html).not.toContain('<a href=');
  });

  it('escapes user content in task templates', () => {
    const email = renderEmail(
      'task-reminder',
      { taskId: 'tsk-1', title: '<script>alert(1)</script>', date: '2026-09-10', planUrl: null },
      APP_URL,
    );

    // Subjects are plain MIME headers; the HTML h1 (escaped) must never carry
    // raw markup.
    expect(email.subject).toBe('Reminder — <script>alert(1)</script>');
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('renders an without-plan evening in the unplanned variant', () => {
    const email = renderEmail(
      'evening-planning',
      {
        date: '2026-09-10',
        tomorrowDate: '2026-09-11',
        tomorrowPlanned: false,
        openTaskCount: 2,
        scheduledTodayCount: 2,
        completedTodayCount: 2,
        deadlineCount: 0,
        planUrl: null,
      },
      APP_URL,
    );

    expect(email.subject).toBe('Evening — nothing planned for tomorrow yet');
  });

  it('throws on data that fails its schema', () => {
    expect(() =>
      renderEmail(
        'plan-changed',
        {
          spaceId: 'spc-1',
          date: 'not-a-date',
          planVersion: 1,
          mode: 'applied',
          applied: true,
          scheduled: 0,
          unscheduled: 0,
          conflicts: 0,
        },
        APP_URL,
      ),
    ).toThrow(/date/);
  });

  it('throws on unknown templates', () => {
    expect(() => renderEmail('does-not-exist' as never, {}, APP_URL)).toThrow(
      /Unknown email template/,
    );
  });
});

describe('template catalogue', () => {
  it('exposes the seven Stage 7 templates', () => {
    expect(TEMPLATE_NAMES).toEqual([
      'morning-brief',
      'midday-pulse',
      'evening-planning',
      'task-reminder',
      'deadline-warning',
      'task-missed',
      'plan-changed',
    ]);
  });
});

describe('formatDate', () => {
  it('is deterministic and timezone-independent', () => {
    expect(formatDate('2026-09-10')).toBe('Thu, Sep 10, 2026');
    expect(formatDate('2026-01-02')).toBe('Fri, Jan 2, 2026');
  });
});
