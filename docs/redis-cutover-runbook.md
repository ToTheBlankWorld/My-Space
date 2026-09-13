# Redis/BullMQ → PostgreSQL — Production Cutover Runbook

> **Status: historical migration artifact.** The application code is already
> Redis-free: background work runs entirely on the PostgreSQL durable job
> queue (`background_jobs` + `job_schedules`). This runbook exists for the one
> thing code cannot do — draining and decommissioning the live Upstash Redis
> instance during deployment.

## Why this document exists

Until the production Redis instance is drained and deleted, two things remain
true:

1. Pre-migration BullMQ repeatable schedules (auto-syncs, sweeps, reviews,
   maintenance) may still be registered inside Redis. With the Redis-free
   worker deployed, nothing consumes them — but they must be removed so the
   namespace is provably dead before the instance is destroyed.
2. Any in-flight BullMQ jobs at the moment of cutover are lost. Every job
   family's *work state* already lives in PostgreSQL (`Notification`,
   `EmailLog`, `CalendarConnection`, `EventLog`, `BackgroundJob`), so nothing
   needs to be re-driven from Redis — stale QUEUED notifications are recovered
   by the sweep, and auto-syncs re-fire from `job_schedules`.

## Cutover sequence (production)

Run these in order. Do not skip to step 10.

1. **Confirm current production is healthy.** Worker `/healthz` 200, `/readyz`
   200 with `database: true`, web deploys green.
2. **Deploy the Redis-free worker** (this codebase). On boot it:
   - registers/upserts every `job_schedules` row (auto-sync per CONNECTED
     connection, sweep, review, maintenance) — idempotent, re-anchors cadence;
   - starts the claim loop, reaper and ticker;
   - logs `pg queue runtime started` and **no** Redis startup logs.
   At this moment the worker no longer consumes BullMQ queues; Redis is idle.
3. **Confirm PostgreSQL schedules exist** and are recent:

   ```sql
   SELECT "scheduleKey", "everySeconds", "nextRunAt", "lastRunAt"
   FROM job_schedules ORDER BY "scheduleKey";
   -- Expect: one auto-sync-{connectionId} row per CONNECTED calendar
   -- connection, plus space:autonomy-review, space:maintenance,
   -- space:notification-sweep.
   ```

4. **Confirm the PG worker is processing jobs.** `/metrics` shows
   `worker_pg_jobs_claimed_total`/`completed_total` increasing and
   `worker_pg_schedule_lag_seconds` near 0.
5. **Verify no BullMQ consumer is running.** The Redis-free worker never
   creates BullMQ queues; confirm no `bullmq:` log lines and no BullMQ metric
   families in `/metrics`.
6. **Drain / reconcile meaningful pending Redis jobs** (script below). Review
   its output: any pending calendar-sync jobs are redundant — the sweep and
   the `job_schedules` auto-syncs re-cover them; pending `delivery` jobs are
   already represented by QUEUED `Notification` rows, which the next sweep
   re-dispatches under the same idempotency key. Do not migrate completed or
   failed history — PostgreSQL already holds the domain truth.
7. **Remove the legacy BullMQ repeatables** (script below). It targets only
   the `space:` queue namespace of this application.
8. **Verify the Redis namespace is empty** (script below prints what remains).
   Only unrelated keys, if any, may survive; none are expected.
9. **Remove the `REDIS_URL` environment variables** from Railway (worker) and
   Vercel (web, if set), and delete the Upstash credential from the team vault.
10. **Verify the worker boot** end-to-end (checklist below).
11. **Only now delete/disable the Upstash Redis database.**

## Legacy Redis cleanup script

Run from a machine with network access and the production `REDIS_URL`
(TLS `rediss://`). The script is self-contained: `npx` fetches `ioredis`
temporarily — it is no longer a project dependency.

Save as `redis-cleanup.mjs` (never commit credentials):

```js
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const PREFIX = 'space'; // BullMQ queue prefix for this application
const QUEUES = [
  'space:calendar-sync',
  'space:calendar-refresh',
  'space:planning',
  'space:notifications',
  'space:autonomy-review',
  'space:maintenance',
];

const scan = async (pattern) => {
  const keys = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');
  return keys;
};

const main = async () => {
  // 1. Report what exists (dry run).
  for (const queue of QUEUES) {
    const counts = await redis.hgetall(`${queue}:meta`).catch(() => ({}));
    const pending = await redis.zcard(`${queue}:wait`).catch(() => 0);
    const delayed = await redis.zcard(`${queue}:delayed`).catch(() => 0);
    const active = await redis.zcard(`${queue}:active`).catch(() => 0);
    const failed = await redis.zcard(`${queue}:failed`).catch(() => 0);
    console.log(queue, { pending, delayed, active, failed, ...counts });
  }

  // 2. Report repeatable schedules.
  const repeatKeys = await scan(`${PREFIX}:*:repeat`);
  for (const key of repeatKeys) {
    console.log('repeatable set', key, await redis.zcard(key));
  }
  const jobs = await scan(`${PREFIX}:*:*:repeat`); // legacy repeatable job hashes
  console.log('repeatable job hashes:', jobs.length);

  if (!process.env.APPLY) {
    console.log('DRY RUN — set APPLY=1 to delete.');
    return;
  }

  // 3. Delete repeatable schedules for this namespace only.
  for (const queue of QUEUES) {
    await redis.del(`${queue}:repeat`);
  }
  for (const key of repeatKeys) await redis.del(key);
  for (const key of jobs) await redis.del(key);
  for (const job of await scan(`${PREFIX}:*:repeat:*`)) await redis.del(job);

  // 4. Delete every key in this application's queue namespace.
  for (const queue of QUEUES) {
    for (const key of await scan(`${queue}*`)) await redis.del(key);
  }
  for (const key of await scan(`${PREFIX}:*`)) await redis.del(key);

  console.log('done');
  await redis.quit();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Usage:

```bash
REDIS_URL="rediss://..." node redis-cleanup.mjs          # dry run: prints inventory
REDIS_URL="rediss://..." APPLY=1 node redis-cleanup.mjs  # deletes space:* keys only
```

The `MATCH space:*` scans and the explicit queue list bound the deletion to
this application's namespace — shared Redis instances holding other
applications' data are not touched.

## Post-cutover verification checklist

**Web:** login · Today · task creation · Plan my day · Calendar page ·
Settings · Notifications.

**Calendar:** connect Google Calendar · discovery mirrors appear · manual
"Sync now" → 202 → events arrive · automatic sync fires within the configured
interval · concurrent sync attempts are lease-serialized · upstream changes
propagate.

**Planning:** foreground plan works · autonomous replans apply · a foreground
edit during a replan wins the planVersion CAS · no duplicate replans within
the coalescing window.

**Notifications:** daily briefs at configured minutes · reminders fire ·
plan-change notifications from outbox · AgentMail delivery (SENT in EmailLog)
· transient failures retry with backoff · exhausted deliveries dead-letter.

**Worker:** boot shows `pg queue runtime started` and `worker ready` · no
Redis/BullMQ startup logs · all five handler classes registered.

**Infrastructure:** no `REDIS_URL` anywhere · `/readyz` →
`{ database: true, 'pg-queue': true }` · `/metrics` shows
`worker_pg_*` families, healthy `queue_depth`, low `schedule_lag_seconds`,
no DEAD-job explosion.

## Redis removal status at time of writing

- Code removal: **complete** (this repository has no Redis/BullMQ runtime code).
- Live Upstash decommission: **pending** — requires the production sequence
  above; it was not executed in the development environment.
