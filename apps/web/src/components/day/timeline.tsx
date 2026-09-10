import { CalendarOff } from 'lucide-react';

import { EmptyState } from '@space/ui';
import type { DayState } from '@space/planning';

import { durationLabel, focusMinutes, minuteOf, timelineBounds, timeOf } from '@/lib/day-view';

import { TimelineBlock } from './timeline-block';

/**
 * The day's timeline, positioned against a local-hour gutter.
 *
 * Rendering is deterministic and server-computed: every position derives from
 * `@space/time` minute-of-day arithmetic in the space's own timezone, and the
 * "now" marker only exists for today (computed from the injected clock on the
 * server, never from the viewer's device clock).
 */

const PX_PER_HOUR = 60;
const VERTICAL_PAD = 12;

interface TimelineProps {
  day: DayState;
  nowMinute: number | null;
}

export const Timeline = ({ day, nowMinute }: TimelineProps) => {
  const bounds = timelineBounds(day.planned, day.timeZone);
  const rangeHours = bounds.endHour - bounds.startHour;
  const height = rangeHours * PX_PER_HOUR + VERTICAL_PAD * 2;

  const hours = Array.from({ length: rangeHours }, (_, index) => bounds.startHour + index);
  const focused = focusMinutes(day.planned);
  const anchors = day.planned.filter((item) => item.kind === 'CALENDAR_EVENT').length;

  const offsetAt = (minute: number): number =>
    VERTICAL_PAD + Math.max(0, minute - bounds.startHour * 60);

  const blockHeight = (start: Date | null, end: Date | null): number => {
    if (!start) return 32;
    if (!end || end.getTime() <= start.getTime()) return 32;
    return Math.max(28, Math.min(Math.round((end.getTime() - start.getTime()) / 60_000), 240));
  };

  const showNow =
    nowMinute !== null && nowMinute >= bounds.startHour * 60 && nowMinute <= bounds.endHour * 60;

  return (
    <section aria-labelledby="timeline-heading" className="mt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="timeline-heading"
          className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
        >
          Timeline
        </h2>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {day.planned.length} item{day.planned.length === 1 ? '' : 's'}
          {focused > 0 ? ` · ${durationLabel(focused)} of focus` : ''}
          {anchors > 0 ? ` · ${anchors} meeting${anchors === 1 ? '' : 's'}` : ''}
        </p>
      </div>

      {day.planned.length === 0 ? (
        <EmptyState
          className="mt-3 rounded-xl border border-border"
          icon={<CalendarOff aria-hidden className="size-5" />}
          title="Nothing scheduled yet"
          description="Use “Plan my day” to place your open tasks around anything already on your calendar."
        />
      ) : (
        <div className="mt-3 rounded-xl border border-border bg-surface">
          <div className="relative pl-14" style={{ height }}>
            {hours.map((hour) => (
              <div
                key={hour}
                className="absolute top-0 left-0 w-12 -translate-y-1/2 pr-2 text-right font-mono text-[0.6875rem] text-muted-foreground tabular-nums"
                style={{ top: offsetAt(hour * 60) }}
              >
                {timeOf(new Date(Date.UTC(2026, 0, 1, hour)), 'UTC')}
              </div>
            ))}

            <div
              aria-hidden="true"
              className="absolute top-0 bottom-0 w-px bg-border/80"
              style={{ left: '3.5rem' }}
            />

            {hours.map((hour) => (
              <div
                key={hour}
                aria-hidden="true"
                className="absolute right-0 border-t border-border/40"
                style={{ top: offsetAt(hour * 60) + 8, left: '3.5rem' }}
              />
            ))}

            {showNow && nowMinute !== null ? (
              <div
                className="absolute right-0 z-10 flex items-center"
                style={{ top: offsetAt(nowMinute), left: '3.5rem' }}
                aria-hidden="true"
              >
                <span className="-ml-1.5 size-1.5 rounded-full bg-accent" />
                <span className="h-px w-full bg-accent/70" />
              </div>
            ) : null}

            <ol
              aria-label="Scheduled items"
              className="absolute top-0 right-3 bottom-0"
              style={{ height, left: '3.75rem' }}
            >
              {day.planned.map((item) => {
                const startMinute = item.start ? minuteOf(item.start, day.timeZone) : null;
                const top = startMinute === null ? VERTICAL_PAD : offsetAt(startMinute);
                const itemHeight = item.start ? blockHeight(item.start, item.end) : 32;

                return (
                  <li
                    key={`${item.kind}:${item.itemId}`}
                    className="absolute right-0 left-0"
                    style={{ top, height: itemHeight }}
                  >
                    <TimelineBlock
                      kind={item.kind}
                      itemId={item.itemId}
                      title={item.title}
                      priority={item.priority}
                      start={item.start}
                      end={item.end}
                      timeZone={day.timeZone}
                      date={day.date}
                    />
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
};
