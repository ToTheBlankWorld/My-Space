'use client';

import { Button } from '@space/ui';
import { useActionState } from 'react';

import { signInWithGoogle, type SignInState } from '@/actions/auth';

/**
 * The sign-in form.
 *
 * A single Google button. The OAuth flow itself is started by a Server Action
 * (`signInWithGoogle`), so this component ships no provider configuration and
 * the failure text is the same safe message whether the provider rejected the
 * attempt or the library did — never a verbatim provider error.
 */

const GoogleMark = () => (
  // The official single-colour "G", inline because lucide carries no brand mark.
  <svg aria-hidden viewBox="0 0 24 24" className="size-4">
    <path
      fill="currentColor"
      d="M21.35 11.1h-9.17v2.73h6.5c-.33 3.15-3.5 4.87-6.5 4.87a7.23 7.23 0 0 1 0-14.46c1.83 0 3.5.67 4.75 1.76l2.08-2.08A10.36 10.36 0 0 0 12.18 1C6.48 1 2 5.48 2 11.2s4.48 10.2 10.18 10.2c5.88 0 9.82-4.13 9.82-9.9 0-.47-.05-.83-.13-1.47Z"
    />
  </svg>
);

const SIGN_IN_FAILED = 'Google sign-in could not be completed. Please try again.';

export const LoginForm = ({ providerError = false }: { providerError?: boolean }) => {
  const [state, formAction, isPending] = useActionState<SignInState, FormData>(signInWithGoogle, {
    error: null,
  });

  const failed = providerError || state.error !== null;

  return (
    <form action={formAction}>
      <fieldset disabled={isPending} className="flex flex-col gap-3">
        <Button type="submit" size="lg" className="w-full">
          <GoogleMark />
          {isPending ? 'Connecting to Google…' : 'Continue with Google'}
        </Button>
      </fieldset>

      {failed && (
        <p role="alert" className="mt-4 text-sm text-muted-foreground">
          {SIGN_IN_FAILED}
        </p>
      )}
    </form>
  );
};
