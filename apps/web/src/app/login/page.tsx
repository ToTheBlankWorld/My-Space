import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AuthHeader } from '@/components/auth/auth-header';
import { LoginForm } from '@/components/auth/login-form';
import { DASHBOARD_PATH, getOptionalUser } from '@/server/session';

export const metadata: Metadata = {
  title: 'Sign in',
};

const LoginPage = async ({ searchParams }: { searchParams: Promise<{ error?: string }> }) => {
  // An authenticated visitor has no business on the sign-in screen.
  const session = await getOptionalUser();
  if (session) {
    redirect(DASHBOARD_PATH);
  }

  const { error } = await searchParams;

  return (
    <>
      <AuthHeader />
      <main
        id="main"
        className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-24 pb-16 sm:pt-32"
      >
        <div className="w-full max-w-sm">
          <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
            Stage 03 — Identity
          </p>
          <h1 className="mt-4 text-3xl font-medium tracking-[-0.03em] text-balance">
            Sign in to Space
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Spaces live on your Google account. No extra passwords, no extra profiles — your
            identity is what your sign-in says it is.
          </p>

          <div className="mt-8">
            <LoginForm providerError={error === 'provider'} />
          </div>
        </div>
      </main>
    </>
  );
};

export default LoginPage;
