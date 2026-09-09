import { assertE2EAuthAllowed, e2eSecretMatches, E2E_USER_EMAIL, E2E_USER_NAME } from '@space/auth';
import { loadAuthEnv } from '@space/config/auth';
import { NextResponse } from 'next/server';

import { getDatabase } from '@/server/database';
import { getAuthService } from '@/server/auth';

/**
 * The deterministic sign-in, for end-to-end tests only.
 *
 * Real OAuth has no headless path: Google's consent screen is a human shape a
 * test runner cannot walk through. Without this route, session-based behaviour
 * (login redirects, the onboarding gate, sign-out) would ship with zero coverage.
 *
 * It is off by default and cannot be enabled in production:
 *
 * - `loadAuthEnv` refuses `E2E_AUTH_ENABLED` when `NODE_ENV=production`, so a
 *   production process does not boot with the flag on;
 * - `assertE2EAuthAllowed` re-checks the flag, the environment name and the
 *   secret on every call, so the route is a 500 even if the process boots in a
 *   strange configuration;
 * - the request must present `E2E_AUTH_SECRET`, compared in constant time.
 *
 * On success the test client follows the redirect to `/onboarding` with a
 * session cookie set by `nextCookies` (the plugin flushes the provider's
 * `set-cookie` through the Next.js cookie store).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const env = loadAuthEnv();

  assertE2EAuthAllowed({
    enabled: env.E2E_AUTH_ENABLED,
    nodeEnv: env.NODE_ENV,
    secret: env.E2E_AUTH_SECRET,
  });

  const secret = (await request.formData()).get('secret');
  if (typeof secret !== 'string' || !e2eSecretMatches(secret, env.E2E_AUTH_SECRET as string)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const database = getDatabase();
  const password = env.E2E_AUTH_SECRET as string;

  // The test identity is created here and nowhere else. Creating it when a
  // previous run left it behind is a duplicate — check first so re-runs stay
  // idempotent instead of racing on better-auth's "already exists" error.
  if ((await database.user.findUnique({ where: { email: E2E_USER_EMAIL } })) === null) {
    await getAuthService().auth.api.signUpEmail({
      body: { email: E2E_USER_EMAIL, password, name: E2E_USER_NAME },
    });
  }

  // Re-running the flow must exercise login → onboarding → dashboard from
  // scratch, so every sign-in rewinds to the pre-onboarding state.
  await database.user.update({
    where: { email: E2E_USER_EMAIL },
    data: { onboardingCompletedAt: null },
  });

  await getAuthService().auth.api.signInEmail({
    body: { email: E2E_USER_EMAIL, password },
  });

  return NextResponse.redirect(new URL('/onboarding', request.url));
}
