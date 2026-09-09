import { Reveal } from '@/components/reveal';

import { Section } from './section';

interface EngineSpec {
  readonly id: string;
  readonly name: string;
  readonly responsibility: string;
}

/**
 * The deterministic Space Engine, as designed.
 *
 * Each unit owns one decision so that behaviour stays explainable and testable.
 * None of them are implemented yet - this section documents the target model,
 * and the copy below says so plainly.
 */
const engines: readonly EngineSpec[] = [
  { id: '01', name: 'Planning', responsibility: 'Turns intent into candidate work for a horizon.' },
  { id: '02', name: 'Scheduling', responsibility: 'Places work into concrete time blocks.' },
  { id: '03', name: 'Priority', responsibility: 'Orders competing work under one ruleset.' },
  { id: '04', name: 'Conflict', responsibility: 'Detects and resolves overlapping commitments.' },
  { id: '05', name: 'Deadline', responsibility: 'Works backwards from dates that cannot move.' },
  { id: '06', name: 'Rescheduling', responsibility: 'Repairs the plan with the smallest edit.' },
  { id: '07', name: 'Workload', responsibility: 'Enforces capacity so days stay achievable.' },
  { id: '08', name: 'Calendar sync', responsibility: 'Reconciles Space with external calendars.' },
  { id: '09', name: 'Notification', responsibility: 'Decides what is worth interrupting you for.' },
  { id: '10', name: 'Monitoring', responsibility: 'Observes drift between plan and reality.' },
];

export const Engine = () => (
  <Section
    id="engine"
    eyebrow="Engine"
    title="Ten units. One deterministic result."
    description="Scheduling is a constraint problem, not a prediction problem. Space resolves it with explicit rules: no model, no inference, no generated output. The units below are in design; nothing here is shipped yet."
  >
    <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
      {engines.map((engine, index) => (
        <Reveal key={engine.id} delay={Math.min(index, 5) * 0.05} className="bg-surface">
          <li className="flex h-full items-baseline gap-5 px-6 py-5">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {engine.id}
            </span>
            <div>
              <h3 className="text-[0.9375rem] font-medium tracking-[-0.01em]">{engine.name}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {engine.responsibility}
              </p>
            </div>
          </li>
        </Reveal>
      ))}
    </ol>
  </Section>
);
