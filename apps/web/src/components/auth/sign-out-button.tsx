'use client';

import { Button } from '@space/ui';

import { signOut } from '@/actions/auth';

/**
 * The single sign-out control.
 *
 * A plain form posting a Server Action, so signing out needs no client state and
 * cannot be triggered by a stray link.
 */
export const SignOutButton = () => (
  <form action={signOut}>
    <Button type="submit" variant="secondary" size="sm">
      Sign out
    </Button>
  </form>
);
