import { CalendarClock, Layers, Repeat } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Reveal } from '@/components/reveal';

import { Section } from './section';

interface Principle {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

const principles: readonly Principle[] = [
  {
    icon: Layers,
    title: 'One canonical timeline',
    body: 'Tasks, deadlines, reminders and meetings are the same kind of object: something that occupies your time. They are planned together, against the same constraints, instead of living in four apps that disagree.',
  },
  {
    icon: Repeat,
    title: 'Rules, not guesses',
    body: 'Your plan is produced by an explicit engine — priorities, dependencies, workload limits and deadlines. The same inputs always produce the same schedule, and every decision can be traced back to the rule that made it.',
  },
  {
    icon: CalendarClock,
    title: 'Continuously reconciled',
    body: 'A meeting moves, a task overruns, a deadline lands early. Space reschedules what is affected and leaves the rest of your day alone, rather than asking you to rebuild the plan by hand.',
  },
];

export const Overview = () => (
  <Section
    id="overview"
    eyebrow="Overview"
    title="A planner that owns the plan."
    description="Most tools store what you intend to do. Space is responsible for when it happens — and for keeping that answer correct as the day changes."
  >
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
      {principles.map((principle, index) => (
        <Reveal key={principle.title} delay={index * 0.08} className="bg-surface">
          <article className="flex h-full flex-col gap-4 p-7">
            <principle.icon aria-hidden className="size-5 text-accent" strokeWidth={1.75} />
            <h3 className="text-base font-medium tracking-[-0.01em]">{principle.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{principle.body}</p>
          </article>
        </Reveal>
      ))}
    </div>
  </Section>
);
