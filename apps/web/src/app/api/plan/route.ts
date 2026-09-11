import { planErrorHttpStatus } from '@space/planning';
import { asCalendarDate, isCalendarDate } from '@space/time';
import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/http';
import { requireApiUser, requireSameOrigin, spendRateLimit, withApi } from '@/server/api';
import { getPlanningService } from '@/server/planning';

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
 * failures are a generic 500. The route is a state-changing JSON API, so it is
 * same-origin-gated and rate-limited per user.
 */
export const POST = withApi(async (request: Request) => {
  const context = await requireApiUser();
  requireSameOrigin(request);
  spendRateLimit('plan', context.user.id);

  const result = await readJsonBody(request);
  if (!result.ok) {
    return NextResponse.json({ error: 'Invalid JSON body; provide a date.' }, { status: 400 });
  }

  const body = result.body as { date?: unknown };
  const date = body.date;

  if (typeof date !== 'string' || !isCalendarDate(date)) {
    return NextResponse.json(
      { error: 'date must be a real YYYY-MM-DD calendar date.' },
      { status: 400 },
    );
  }

  try {
    const planResult = await getPlanningService().planSpace({
      userId: context.user.id,
      date: asCalendarDate(date),
    });

    return NextResponse.json({
      planVersion: planResult.planVersion,
      mode: planResult.mode,
      applied: planResult.applied,
      scheduled: planResult.scheduledItems.length,
      unscheduled: planResult.unscheduledTasks.length,
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
});
