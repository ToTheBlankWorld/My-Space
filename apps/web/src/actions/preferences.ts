'use server';

import { getDatabase } from '@/server/database';
import { requireUser } from '@/server/session';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * Planning and notification preferences.
 *
 * Values are parsed with the same domain rules the onboarding flow uses, then
 * written column-by-column (`updateMany`) so one control never resets the
 * settings it is not responsible for. Ownership is the session user — never a
 * form-supplied identity.
 */

export interface PreferenceActionResult {
  ok: boolean;
  error?: string;
}

const AUTONOMY_LEVEL = z.enum(['SUGGEST_ONLY', 'ASK_BEFORE_CHANGING', 'AUTOMATICALLY_MANAGE']);
const BOOLEAN = z.boolean();

const readString = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export const setAutonomyLevel = async (formData: FormData): Promise<PreferenceActionResult> => {
  const parsed = AUTONOMY_LEVEL.safeParse(readString(formData, 'autonomyLevel'));
  if (!parsed.success) {
    return { ok: false, error: 'Invalid autonomy level.' };
  }

  const { user } = await requireUser();

  try {
    await getDatabase().planningPreferences.updateMany({
      where: { userId: user.id },
      data: { autonomyLevel: parsed.data },
    });
  } catch {
    return { ok: false, error: 'That setting could not be saved.' };
  }

  revalidatePath('/space', 'layout');
  return { ok: true };
};

export const setInAppNotifications = async (
  formData: FormData,
): Promise<PreferenceActionResult> => {
  const value = formData.get('enabled');
  const parsed = BOOLEAN.safeParse(value === 'on' ? true : value === 'off' ? false : value);

  if (!parsed.success) {
    return { ok: false, error: 'Invalid notification setting.' };
  }

  const { user } = await requireUser();

  try {
    await getDatabase().userPreferences.updateMany({
      where: { userId: user.id },
      data: { notificationsEnabled: parsed.data },
    });
  } catch {
    return { ok: false, error: 'That setting could not be saved.' };
  }

  revalidatePath('/space', 'layout');
  return { ok: true };
};

export const setEmailNotifications = async (
  formData: FormData,
): Promise<PreferenceActionResult> => {
  const value = formData.get('enabled');
  const parsed = BOOLEAN.safeParse(value === 'on' ? true : value === 'off' ? false : value);

  if (!parsed.success) {
    return { ok: false, error: 'Invalid notification setting.' };
  }

  const { user } = await requireUser();

  try {
    await getDatabase().userPreferences.updateMany({
      where: { userId: user.id },
      data: { emailNotificationsEnabled: parsed.data },
    });
  } catch {
    return { ok: false, error: 'That setting could not be saved.' };
  }

  revalidatePath('/space', 'layout');
  return { ok: true };
};
