import 'server-only';

import { users } from '@space/database';
import type { AutonomyLevel, Weekday } from '@space/types';

import { getDatabase } from './database';

/**
 * The settings page's read surface.
 *
 * Everything below is derived from the single planning profile read in
 * `users.findPlanningProfile` — user, preferences, planning preferences and the
 * weekday-ordered working-hours blocks — then flattened into the plain views
 * the page renders.
 */

export interface WorkingHoursView {
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
}

export interface SettingsData {
  email: string;
  name: string | null;
  timeZone: string;
  autonomy: AutonomyLevel;
  inAppNotifications: boolean;
  emailNotifications: boolean;
  maxDailyFocusMinutes: number;
  minBreakMinutes: number;
  bufferMinutes: number;
  workingHours: WorkingHoursView[];
}

export const getSettings = async (userId: string): Promise<SettingsData> => {
  const profile = await users.findPlanningProfile(getDatabase(), userId);

  if (!profile) {
    throw new Error('Planning profile not found.');
  }

  return {
    email: profile.email,
    name: profile.name ?? null,
    // The timezone lives on user preferences: it is the single anchor for every
    // calendar date, and planning preferences carry no timezone of their own.
    timeZone: profile.preferences?.timeZone ?? 'UTC',
    autonomy: profile.planningPreferences?.autonomyLevel ?? 'ASK_BEFORE_CHANGING',
    inAppNotifications: profile.preferences?.notificationsEnabled ?? true,
    emailNotifications: profile.preferences?.emailNotificationsEnabled ?? true,
    maxDailyFocusMinutes: profile.planningPreferences?.maxDailyFocusMinutes ?? 360,
    minBreakMinutes: profile.planningPreferences?.minBreakMinutes ?? 10,
    bufferMinutes: profile.planningPreferences?.bufferMinutes ?? 5,
    workingHours: (profile.workingHours ?? []).map((block) => ({
      weekday: block.weekday,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
    })),
  };
};
