import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AuthHeader } from '@/components/auth/auth-header';
import { OnboardingForm } from '@/components/auth/onboarding-form';
import { DASHBOARD_PATH, requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Onboarding',
};

const OnboardingPage = async () => {
  // The onboarding gate: only a signed-in, not-yet-onboarded account may be here.
  const { user } = await requireUser();
  if (user.onboardingCompleted) {
    redirect(DASHBOARD_PATH);
  }

  // The browser's own IANA list is the best suggestion a user can get; the
  // server re-validates whatever is submitted against its own copy.
  const timeZones = [...Intl.supportedValuesOf('timeZone')].sort();

  return (
    <>
      <AuthHeader />
      <main
        id="main"
        className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-16 pb-24"
      >
        <div className="w-full max-w-2xl">
          <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
            Stage 03 — One minute
          </p>
          <h1 className="mt-4 text-3xl font-medium tracking-[-0.03em] text-balance">
            Make Space yours
          </h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
            A handful of answers turn Space from an open room into a planner that knows when your
            day starts, when to plan it, and how much it may move before asking you. You can change
            all of it later.
          </p>

          <div className="mt-10 rounded-xl border border-border bg-surface p-6 sm:p-8">
            <OnboardingForm timeZones={timeZones} />
          </div>
        </div>
      </main>
    </>
  );
};

export default OnboardingPage;
