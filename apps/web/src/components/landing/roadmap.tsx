import { cn } from '@space/ui';

import { Reveal } from '@/components/reveal';

import { Section } from './section';

type StageStatus = 'completed' | 'current' | 'planned';

interface Stage {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: StageStatus;
}

const stages: readonly Stage[] = [
  {
    id: '01',
    title: 'Foundation',
    body: 'Monorepo, strict TypeScript, shared contracts, an independently deployable worker, CI.',
    status: 'completed',
  },
  {
    id: '02',
    title: 'Schema and data',
    body: 'The canonical schema for work and time, timezone-safe persistence, and domain validation.',
    status: 'completed',
  },
  {
    id: '03',
    title: 'Identity',
    body: 'Accounts, Google sign-in, deterministic test-only sessions, and onboarding that feeds the engine.',
    status: 'current',
  },
  {
    id: '04',
    title: 'Space Engine',
    body: 'The deterministic planning, scheduling, priority and conflict units, with a replayable test suite.',
    status: 'planned',
  },
];

export const Roadmap = () => (
  <Section
    id="roadmap"
    eyebrow="Roadmap"
    title="Built in order, in public."
    description="Space is early. This is what exists today and what comes next, stated precisely, so nothing on this page overstates what is running."
  >
    <ol className="space-y-px overflow-hidden rounded-xl border border-border bg-border">
      {stages.map((stage, index) => (
        <Reveal key={stage.id} delay={index * 0.06} className="bg-surface">
          <li className="grid grid-cols-[auto_1fr] items-start gap-x-5 gap-y-2 px-6 py-6 sm:grid-cols-[auto_18rem_1fr] sm:items-baseline">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{stage.id}</span>
            <div className="flex items-center gap-3">
              <h3 className="text-[0.9375rem] font-medium tracking-[-0.01em]">{stage.title}</h3>
              <span
                className={cn(
                  'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.625rem] tracking-[0.12em] whitespace-nowrap uppercase',
                  stage.status === 'current'
                    ? 'border-accent/40 text-accent'
                    : 'border-border text-muted-foreground',
                )}
              >
                {stage.status === 'current' ? 'In progress' : 'Planned'}
              </span>
            </div>
            <p className="col-span-full text-sm leading-relaxed text-muted-foreground sm:col-span-1 sm:col-start-3">
              {stage.body}
            </p>
          </li>
        </Reveal>
      ))}
    </ol>
  </Section>
);
