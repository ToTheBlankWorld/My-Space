import type { Metadata } from 'next';

import { AuthHeader } from '@/components/auth/auth-header';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { site } from '@/lib/site';
import { requireOnboardedUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard',
};

const DashboardPage = async () => {
  // The application shell: any route under the authenticated app calls this, so
  // an account that has not finished onboarding cannot reach this screen.
  const { user } = await requireOnboardedUser();

  const firstName = user.name?.trim().split(' ')[0] ?? 'there';

  return (
    <>
      <AuthHeader />
      <main id="main" className="mx-auto w-full max-w-6xl px-6 pt-16 pb-24">
        <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
          Stage 03 — Identity
        </p>
        <h1 className="mt-4 text-3xl font-medium tracking-[-0.03em] text-balance">
          Welcome{firstName === 'there' ? '' : `, ${firstName}`}
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
          Your account is set up and your session is live. This is the application shell: the
          timeline, scheduling engine and settings land in the stages after this one.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          <div className="bg-surface px-6 py-5">
            <h2 className="font-mono text-[0.6875rem] tracking-[0.16em] text-muted-foreground uppercase">
              Identity
            </h2>
            <p className="mt-2 text-sm font-medium">{user.email}</p>
          </div>
          <div className="bg-surface px-6 py-5">
            <h2 className="font-mono text-[0.6875rem] tracking-[0.16em] text-muted-foreground uppercase">
              Onboarding
            </h2>
            <p className="mt-2 text-sm font-medium">Complete</p>
          </div>
          <div className="flex items-end justify-between gap-4 bg-surface px-6 py-5">
            <div>
              <h2 className="font-mono text-[0.6875rem] tracking-[0.16em] text-muted-foreground uppercase">
                Session
              </h2>
              <p className="mt-2 text-sm font-medium">Live</p>
            </div>
            <SignOutButton />
          </div>
        </div>

        <p className="mt-8 text-sm text-muted-foreground tabular-nums">
          &copy; {site.copyrightYear} {site.name}
        </p>
      </main>
    </>
  );
};

export default DashboardPage;
