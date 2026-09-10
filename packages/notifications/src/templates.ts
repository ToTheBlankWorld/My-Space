import { z } from 'zod';

import type { TemplateName } from './types';

/**
 * Email templates rendered on the worker at delivery time.
 *
 * The worker is server-only and DOM-free: every template is a pure function of
 * its *validated* data, deterministic in UTC. Isolated timestamps are never
 * used. Bodies carry only rendered text of inputs already validated by policy —
 * user names and task titles are HTML-escaped, and the only links ever emitted
 * are same-origin `appUrl` deep links to a day's space. No credentials,
 * provider tokens or API details are ever rendered.
 */

// ---------------------------------------------------------------------------
// Data models — one schema per template, bounded to what the policy produces.
// ---------------------------------------------------------------------------

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const briefDataSchema = z.object({
  date: calendarDate,
  tomorrowDate: calendarDate,
  tomorrowPlanned: z.boolean(),
  openTaskCount: z.number().int().nonnegative(),
  scheduledTodayCount: z.number().int().nonnegative(),
  completedTodayCount: z.number().int().nonnegative(),
  deadlineCount: z.number().int().nonnegative(),
  planUrl: z.string().url().nullable(),
});

const taskReminderSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  date: calendarDate.nullable(),
  planUrl: z.string().url().nullable(),
});

const deadlineWarningSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  dueDate: calendarDate,
  dueAt: z.string().min(1),
  taskPriority: z.enum(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']),
});

const taskMissedSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  missedDate: calendarDate,
});

const planChangedSchema = z.object({
  spaceId: z.string().min(1),
  date: calendarDate,
  planVersion: z.number().int().nonnegative(),
  mode: z.enum(['applied', 'ask-before-changing', 'suggest-only']),
  applied: z.boolean(),
  scheduled: z.number().int().nonnegative(),
  unscheduled: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});

/** One schema per template; every draft's email `data` must parse against it. */
export const templateDataSchemas: Record<TemplateName, z.ZodType> = {
  'morning-brief': briefDataSchema,
  'midday-pulse': briefDataSchema,
  'evening-planning': briefDataSchema,
  'task-reminder': taskReminderSchema,
  'deadline-warning': deadlineWarningSchema,
  'task-missed': taskMissedSchema,
  'plan-changed': planChangedSchema,
};

export type TemplateData<T extends TemplateName> = z.infer<(typeof templateDataSchemas)[T]>;

// ---------------------------------------------------------------------------
// Rendering helpers — deterministic in UTC, HTML-safe, link-safe.
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `2026-09-10` → `Thu, Sep 10, 2026`. Never depends on the host timezone. */
export const formatDate = (date: string): string => {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  return dateFormatter.format(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
};

const formatDueAt = (iso: string): string => {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return iso;
  }
  return `${timeFormatter.format(instant)} UTC on ${formatDate(instant.toISOString().slice(0, 10))}`;
};

/**
 * An HTML paragraph. The passed markup is trusted: every *dynamic* value inside
 * it is escaped at its interpolation site (numbers, formatted dates and enum
 * values are safe by construction; user titles go through `escapeHtml`).
 */
const paragraph = (text: string): string => `<p style="margin:0 0 12px;">${text}</p>`;

// ---------------------------------------------------------------------------
// The email shell.
// ---------------------------------------------------------------------------

interface EmailAction {
  label: string;
  href: string;
}

interface RenderedTemplate {
  subject: string;
  body: string;
  actions: EmailAction[];
}

/** Only same-origin https deep links survive — anything else is dropped. */
const sameOriginHref = (href: string, appUrl: string): boolean => {
  try {
    const target = new URL(href);
    const origin = new URL(appUrl);
    return target.protocol === 'https:' && target.origin === origin.origin;
  } catch {
    return false;
  }
};

const shell = (
  subject: string,
  body: string,
  actions: EmailAction[],
  appUrl: string,
): { subject: string; html: string } => {
  const buttons = actions
    .filter((action) => sameOriginHref(action.href, appUrl))
    .map(
      (action) =>
        `<a href="${escapeHtml(action.href)}" style="display:inline-block;margin:0 8px 0 0;padding:12px 20px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;">${escapeHtml(
          action.label,
        )}</a>`,
    )
    .join('\n');

  return {
    subject,
    html: `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">Space</p>
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#18181b;">${escapeHtml(
          subject,
        )}</h1>
        <div style="font-size:15px;line-height:1.6;color:#3f3f46;">${body}</div>
        ${buttons.length > 0 ? `<p style="margin:24px 0 0;">${buttons}</p>` : ''}
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:28px 0 12px;" />
        <p style="margin:0;font-size:12px;color:#a1a1aa;">
          You're receiving this because email notifications are on in Space.
        </p>
      </div>
    </div>
  </body>
</html>`,
  };
};

// ---------------------------------------------------------------------------
// The templates themselves.
// ---------------------------------------------------------------------------

/**
 * Renders a template into a validated, HTML-safe email subject + body.
 *
 * Throws on unknown template names or data that fails its schema — a policy bug
 * must surface loudly in tests and CI, never as a mangled email.
 */
export const renderEmail = (
  template: TemplateName,
  data: Record<string, unknown>,
  appUrl: string,
): { subject: string; html: string } => {
  const schema = templateDataSchemas[template];
  if (schema === undefined) {
    throw new Error(`Unknown email template: ${template}`);
  }

  const validated = schema.parse(data);

  let rendered: RenderedTemplate;
  switch (template) {
    case 'morning-brief':
    case 'midday-pulse':
    case 'evening-planning':
      rendered = renderBrief(template, validated as z.infer<typeof briefDataSchema>);
      break;
    case 'task-reminder':
      rendered = renderTaskReminder(validated as z.infer<typeof taskReminderSchema>);
      break;
    case 'deadline-warning':
      rendered = renderDeadlineWarning(validated as z.infer<typeof deadlineWarningSchema>);
      break;
    case 'task-missed':
      rendered = renderTaskMissed(validated as z.infer<typeof taskMissedSchema>);
      break;
    case 'plan-changed':
      rendered = renderPlanChanged(validated as z.infer<typeof planChangedSchema>);
      break;
  }

  return shell(rendered.subject, rendered.body, rendered.actions, appUrl);
};

// ---------------------------------------------------------------------------
// Individual templates.
// ---------------------------------------------------------------------------

const planAction = (planUrl: string | null, label: string): EmailAction[] =>
  planUrl === null ? [] : [{ label, href: planUrl }];

const renderBrief = (
  template: 'morning-brief' | 'midday-pulse' | 'evening-planning',
  data: z.infer<typeof briefDataSchema>,
): RenderedTemplate => {
  if (template === 'evening-planning') {
    if (data.tomorrowPlanned) {
      return {
        subject: 'Evening — tomorrow is planned',
        body:
          paragraph(
            `${formatDate(data.tomorrowDate)} already has a plan, so tomorrow starts with a shape.`,
          ) + paragraph(`You're set. Nothing else needs doing tonight.`),
        actions: planAction(data.planUrl, "Open tomorrow's plan"),
      };
    }
    return {
      subject: 'Evening — nothing planned for tomorrow yet',
      body:
        paragraph(`Tomorrow (${formatDate(data.tomorrowDate)}) doesn't have a plan yet.`) +
        paragraph(`Five minutes tonight gives the morning brief a shape to work with.`),
      actions: planAction(data.planUrl, 'Plan tomorrow'),
    };
  }

  const remaining = data.scheduledTodayCount - data.completedTodayCount;
  const body =
    template === 'morning-brief'
      ? paragraph(`Here is today at a glance — ${formatDate(data.date)}.`) +
        paragraph(
          `<b>${data.openTaskCount}</b> task${data.openTaskCount === 1 ? ' is' : 's are'} open, <b>${data.scheduledTodayCount}</b> on today's plan, <b>${data.completedTodayCount}</b> already done, <b>${data.deadlineCount}</b> deadline${data.deadlineCount === 1 ? '' : 's'}.`,
        ) +
        (remaining > 0
          ? paragraph(`${remaining} item${remaining === 1 ? ' is' : 's are'} still ahead.`)
          : paragraph(`Today's plan is complete.`))
      : paragraph(`Halfway through ${formatDate(data.date)} — the pulse so far.`) +
        paragraph(
          `<b>${data.completedTodayCount}</b> of <b>${data.scheduledTodayCount}</b> planned items are done, with <b>${data.openTaskCount}</b> still open overall.`,
        ) +
        (data.deadlineCount > 0
          ? paragraph(
              `${data.deadlineCount} deadline${data.deadlineCount === 1 ? ' is' : 's are'} due today.`,
            )
          : '');

  return {
    subject:
      template === 'morning-brief'
        ? `Good morning — ${data.openTaskCount} task${data.openTaskCount === 1 ? '' : 's'} open`
        : `Midday — ${data.completedTodayCount} done today`,
    body,
    actions: planAction(data.planUrl, "Open today's plan"),
  };
};

const renderTaskReminder = (data: z.infer<typeof taskReminderSchema>): RenderedTemplate => ({
  subject: `Reminder — ${data.title}`,
  body:
    paragraph(`&ldquo;${escapeHtml(data.title)}&rdquo; is on your mind right now.`) +
    (data.date !== null ? paragraph(`It was planned for ${formatDate(data.date)}.`) : ''),
  actions: planAction(data.planUrl, 'Open the day'),
});

const renderDeadlineWarning = (data: z.infer<typeof deadlineWarningSchema>): RenderedTemplate => ({
  subject: `Deadline today — ${data.title}`,
  body:
    paragraph(`&ldquo;${escapeHtml(data.title)}&rdquo; is due ${formatDueAt(data.dueAt)}.`) +
    (data.taskPriority === 'CRITICAL'
      ? paragraph(`This is a CRITICAL priority, so it's the loudest thing in your queue.`)
      : paragraph(`It's an important deadline — worth placing early.`)),
  actions: [],
});

const renderTaskMissed = (data: z.infer<typeof taskMissedSchema>): RenderedTemplate => ({
  subject: `Missed — ${data.title}`,
  body:
    paragraph(
      `&ldquo;${escapeHtml(data.title)}&rdquo; was planned for ${formatDate(data.missedDate)} and didn't happen.`,
    ) + paragraph(`It'll be picked up again in your next-day review.`),
  actions: [],
});

const renderPlanChanged = (data: z.infer<typeof planChangedSchema>): RenderedTemplate => {
  if (data.unscheduled > 0 || data.conflicts > 0) {
    return {
      subject: `Plan for ${formatDate(data.date)} needs attention`,
      body:
        paragraph(`Your plan for ${formatDate(data.date)} came back with issues.`) +
        paragraph(
          `<b>${data.unscheduled}</b> task${data.unscheduled === 1 ? ' was' : 's were'} not placed and <b>${data.conflicts}</b> conflict${data.conflicts === 1 ? ' was' : 's were'} found.`,
        ) +
        paragraph(
          `Mode: ${data.mode}${data.applied ? '' : ' — nothing was changed automatically.'}`,
        ),
      actions: [],
    };
  }
  return {
    subject: `Plan for ${formatDate(data.date)} updated`,
    body: paragraph(
      `All <b>${data.scheduled}</b> item${data.scheduled === 1 ? ' was' : 's were'} placed cleanly for ${formatDate(data.date)}.`,
    ),
    actions: [],
  };
};
