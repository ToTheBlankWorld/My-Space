'use server';

import { work } from '@space/database';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { clock } from '@/server/clock';
import { getDatabase } from '@/server/database';
import { requireUser } from '@/server/session';

/**
 * Task mutations for the day workspace.
 *
 * Every action re-derives the actor from the session cookie, parses its inputs,
 * and writes through the repository transition table. Ownership lives in the
 * repository `where` clauses, never in the client. After a write the action
 * invalidates the day it mutated so the next request re-reads authoritative
 * state.
 */

export interface TaskActionResult {
  ok: boolean;
  error?: string;
}

const readString = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

const TASK_ID = z.string().min(1);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TITLE = z.string().trim().min(1).max(200);
const PRIORITY = z.enum(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

const parseIdDate = (form: FormData): { id: string; date: string } | null => {
  const id = TASK_ID.safeParse(readString(form, 'id'));
  const date = DATE.safeParse(readString(form, 'date'));
  if (!id.success || !date.success) {
    return null;
  }
  return { id: id.data, date: date.data };
};

const FAILED_GENERIC = 'That change could not be saved.';

export const completeTask = async (formData: FormData): Promise<TaskActionResult> => {
  const input = parseIdDate(formData);
  if (!input) {
    return { ok: false, error: FAILED_GENERIC };
  }

  const { user } = await requireUser();

  try {
    await work.transitionTaskStatus(getDatabase(), user.id, input.id, 'COMPLETED', clock.now(), {
      trigger: 'user',
      reason: 'user-completed-task',
    });
  } catch {
    return { ok: false, error: 'That task could not be marked complete.' };
  }

  revalidatePath(`/space/${input.date}`);
  return { ok: true };
};

export const cancelTask = async (formData: FormData): Promise<TaskActionResult> => {
  const input = parseIdDate(formData);
  if (!input) {
    return { ok: false, error: FAILED_GENERIC };
  }

  const { user } = await requireUser();

  try {
    await work.transitionTaskStatus(getDatabase(), user.id, input.id, 'CANCELLED', clock.now(), {
      trigger: 'user',
      reason: 'user-cancelled-task',
    });
  } catch {
    return { ok: false, error: 'That task could not be cancelled.' };
  }

  revalidatePath(`/space/${input.date}`);
  return { ok: true };
};

export const setTaskPriority = async (formData: FormData): Promise<TaskActionResult> => {
  const input = parseIdDate(formData);
  const parsedPriority = PRIORITY.safeParse(readString(formData, 'priority'));
  if (!input || !parsedPriority.success) {
    return { ok: false, error: FAILED_GENERIC };
  }

  const { user } = await requireUser();

  try {
    await work.updateTask(getDatabase(), user.id, input.id, { priority: parsedPriority.data });
  } catch {
    return { ok: false, error: 'That priority could not be saved.' };
  }

  revalidatePath(`/space/${input.date}`);
  return { ok: true };
};

export const updateTaskTitle = async (formData: FormData): Promise<TaskActionResult> => {
  const input = parseIdDate(formData);
  const parsedTitle = TITLE.safeParse(readString(formData, 'title'));
  if (!input || !parsedTitle.success) {
    return { ok: false, error: FAILED_GENERIC };
  }

  const { user } = await requireUser();

  try {
    await work.updateTask(getDatabase(), user.id, input.id, { title: parsedTitle.data });
  } catch {
    return { ok: false, error: 'That title could not be saved.' };
  }

  revalidatePath(`/space/${input.date}`);
  return { ok: true };
};

export const createTask = async (formData: FormData): Promise<TaskActionResult> => {
  const date = DATE.safeParse(readString(formData, 'date'));
  const spaceId = TASK_ID.safeParse(readString(formData, 'spaceId'));
  const title = TITLE.safeParse(readString(formData, 'title'));
  if (!date.success || !spaceId.success || !title.success) {
    return { ok: false, error: 'A short title is required.' };
  }

  const { user } = await requireUser();

  try {
    await work.createTask(getDatabase(), user.id, {
      spaceId: spaceId.data,
      title: title.data,
    });
  } catch {
    return { ok: false, error: 'The task could not be added.' };
  }

  revalidatePath(`/space/${date.data}`);
  return { ok: true };
};
