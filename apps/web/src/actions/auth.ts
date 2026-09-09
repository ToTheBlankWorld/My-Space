'use server';

import { APIError } from 'better-auth/api';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuthService } from '@/server/auth';
import { DASHBOARD_PATH, LOGIN_PATH } from '@/server/session';

/**
 * Sign-in and sign-out, as Server Actions.
 *
 * Starting the OAuth flow server-side keeps the authentication client out of the
 * browser bundle entirely: the page is a plain form, so it works before
 * JavaScript loads and ships no provider configuration to the client.
 *
 * Next.js Server Actions carry their own origin check and a per-action
 * identifier, which is what protects these two endpoints from cross-site
 * submission.
 */

export interface SignInState {
  error: string | null;
}

/** Messages that are safe to show. A provider error is never echoed verbatim. */
const SIGN_IN_FAILED = 'Google sign-in could not be completed. Please try again.';

export const signInWithGoogle = async (
  _previous: SignInState,
  _formData: FormData,
): Promise<SignInState> => {
  let destination: string;

  try {
    const response = await getAuthService().auth.api.signInSocial({
      body: {
        provider: 'google',
        /**
         * A fixed, relative path.
         *
         * The post-sign-in destination is never read from the request: an
         * attacker-supplied `callbackURL` is the classic open redirect, and the
         * safest way to refuse it is to never accept one.
         */
        callbackURL: DASHBOARD_PATH,
        errorCallbackURL: `${LOGIN_PATH}?error=provider`,
      },
      headers: await headers(),
    });

    if (!response.url) {
      return { error: SIGN_IN_FAILED };
    }

    destination = response.url;
  } catch (error) {
    if (error instanceof APIError) {
      return { error: SIGN_IN_FAILED };
    }
    throw error;
  }

  // Outside the try: `redirect` signals by throwing, and catching it here would
  // turn a successful sign-in into an error message.
  redirect(destination);
};

export const signOut = async (): Promise<void> => {
  await getAuthService().auth.api.signOut({ headers: await headers() });

  redirect(LOGIN_PATH);
};
