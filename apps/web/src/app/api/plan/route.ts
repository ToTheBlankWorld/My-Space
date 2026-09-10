import { planErrorHttpStatus } from '@space/planning';
import { asCalendarDate, isCalendarDate } from '@space/time';
import { NextResponse } from 'next/server';

import { getPlanningService } from '@/server/planning';
import { getOptionalUser } from '@/server/session';

/**
 * POST /api/plan
 *
 * Plans one day for the authenticated user.
 *
 * The request body is `{ date: "YYYY-MM-DD" }`. Every click is an explicit,
 * deterministic re-plan: the pass lazily ensures the Space exists, computes the
 * day against the current data, and persists under the user's autonomy level.
 * The response is a bounded summary; the authoritative day is re-read by the
 * page after the client calls `router.refresh()`.
 *
 * Error responses are shaped to the client and never leak internals; unknown
 * failures are a generic 500.
 */
export const POST = async (request: Request) => {
  const context = await getOptionalUser();
  if (!context) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  let date: unknown;
  try {
    const body = (await request.json()) as { date?: unknown };
    date = body.date;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body; provide a date.' }, { status: 400 });
  }

  if (typeof date !== 'string' || !isCalendarDate(date)) {
    return NextResponse.json(
      { error: 'date must be a real YYYY-MM-DD calendar date.' },
      { status: 400 },
    );
  }

  try {
    const result = await getPlanningService().planSpace({
      userId: context.user.id,
      date: asCalendarDate(date),
    });

    return NextResponse.json({
      planVersion: result.planVersion,
      mode: result.mode,
      applied: result.applied,
      scheduled: result.scheduledItems.length,
      unscheduled: result.unscheduledTasks.length,
    });
  } catch (error) {
    const status = planErrorHttpStatus(error);
    const messages: Record<number, string> = {
      400: 'The date is not a valid calendar date.',
      404: 'The day could not be found.',
      409: 'The day changed while it was being planned. Try again.',
      422: 'The day could not be planned with the current settings.',
      500: 'Planning failed. Try again.',
    };
    return NextResponse.json(
      { error: messages[status] ?? 'Planning failed. Try again.' },
      { status },
    );
  }
};
