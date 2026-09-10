import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { asCalendarDate, isCalendarDate } from '@space/time';

import { AppShell } from '@/components/app/app-shell';
import { DayWorkspace } from '@/components/day/day-workspace';
import { requireOnboardedUser } from '@/server/session';
import { getSpaceDayData } from '@/server/space';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Today',
};

interface SpaceDayPageProps {
  params: Promise<{ date: string }>;
}

/**
 * `/space/[date]` — the authoritative day workspace for one calendar date.
 *
 * Reads the persisted day through the planning service (lazily creating the
 * Space for the date, exactly as planning does), plus the space's autonomy
 * trail. Mutations on the page re-read this server state after every write.
 */
const SpaceDayPage = async ({ params }: SpaceDayPageProps) => {
  const { user } = await requireOnboardedUser();
  const { date } = await params;

  if (!isCalendarDate(date)) {
    notFound();
  }

  const data = await getSpaceDayData(user.id, asCalendarDate(date));

  return (
    <AppShell>
      <DayWorkspace data={data} />
    </AppShell>
  );
};

export default SpaceDayPage;
