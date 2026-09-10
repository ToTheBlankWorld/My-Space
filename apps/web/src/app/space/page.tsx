import { redirect } from 'next/navigation';

import { getPlanningService } from '@/server/planning';
import { requireOnboardedUser } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * `/space` — redirects to the Space for the user's current day, in their
 * timezone. The day is computed server-side from the session user, never from a
 * client-supplied date.
 */
const SpaceIndexPage = async () => {
  const { user } = await requireOnboardedUser();
  const today = await getPlanningService().getToday(user.id);
  redirect(`/space/${today.date}`);
};

export default SpaceIndexPage;
