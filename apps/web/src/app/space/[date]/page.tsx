import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { asCalendarDate, isCalendarDate } from '@space/time';

import { AuthHeader } from '@/components/auth/auth-header';
import { DayView } from '@/components/plan/day-view';
import { getPlanningService } from '@/server/planning';
import { requireOnboardedUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plan My Day',
};

interface SpaceDayPageProps {
  params: Promise<{ date: string }>;
}

/**
 * `/space/[date]` — the authoritative day view for one calendar date.
 *
 * Reads the persisted day through the planning service (lazily creating the
 * Space for the date, exactly as planning does). The plan button on the page
 * POSTs to `/api/plan`, then refreshes this read.
 */
const SpaceDayPage = async ({ params }: SpaceDayPageProps) => {
  const { user } = await requireOnboardedUser();
  const { date } = await params;

  if (!isCalendarDate(date)) {
    notFound();
  }

  const day = await getPlanningService().getDayState({
    userId: user.id,
    date: asCalendarDate(date),
  });

  return (
    <>
      <AuthHeader />
      <DayView day={day} />
    </>
  );
};

export default SpaceDayPage;
