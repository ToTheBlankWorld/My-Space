import { describe, expect, it } from 'vitest';

import { createPacer } from '../pacer';

/**
 * The in-process rate pacer: the first `max` takes in a window pass straight
 * through, further takes wait until the window slides. The mechanism is
 * process-local by design (single-worker deployment).
 */
describe('pacer', () => {
  it('admits takes under the budget immediately', async () => {
    const pacer = createPacer({ max: 3, windowMs: 60_000 });

    const start = Date.now();
    await Promise.all([pacer.take(), pacer.take(), pacer.take()]);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('delays takes beyond the budget until the window slides', async () => {
    // 20ms window: the third take must wait roughly one window.
    const pacer = createPacer({ max: 2, windowMs: 20 });

    const start = Date.now();
    await Promise.all([pacer.take(), pacer.take(), pacer.take(), pacer.take()]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it('recovers the full budget once the window has passed', async () => {
    let now = 0;
    const pacer = createPacer({ max: 2, windowMs: 100 }, () => now);

    await pacer.take();
    await pacer.take();

    now = 150; // window fully slid
    const start = Date.now();
    await pacer.take();
    expect(Date.now() - start).toBeLessThan(50);
  });
});
