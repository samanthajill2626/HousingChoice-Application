import { describe, expect, it } from 'vitest';

import { createRateLimitedWarn } from '../src/lib/rateLimitedWarn.js';

function fakeLogger(): {
  warns: { fields: Record<string, unknown>; message: string }[];
  logger: { warn(fields: Record<string, unknown>, message: string): void };
} {
  const warns: { fields: Record<string, unknown>; message: string }[] = [];
  return {
    warns,
    logger: {
      warn(fields, message) {
        warns.push({ fields, message });
      },
    },
  };
}

describe('createRateLimitedWarn (group-texting T3.7)', () => {
  it('emits the FIRST warn immediately', () => {
    const { warns, logger } = fakeLogger();
    const warn = createRateLimitedWarn({ logger, intervalMs: 60_000, now: () => 0 });
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields['suppressedCount']).toBe(0);
  });

  it('SUPPRESSES repeats inside the window instead of flooding the log', () => {
    const { warns, logger } = fakeLogger();
    let clock = 0;
    const warn = createRateLimitedWarn({ logger, intervalMs: 60_000, now: () => clock });
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    clock = 1_000;
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    clock = 59_999;
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    expect(warns).toHaveLength(1);
  });

  it('emits again once the window elapses and REPORTS how many it swallowed', () => {
    const { warns, logger } = fakeLogger();
    let clock = 0;
    const warn = createRateLimitedWarn({ logger, intervalMs: 60_000, now: () => clock });
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    clock = 10;
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    clock = 20;
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    clock = 60_000;
    warn({ event: 'group_envelope_missing' }, 'tripwire');
    expect(warns).toHaveLength(2);
    expect(warns[1]?.fields['suppressedCount']).toBe(2);
  });

  it('resets the suppressed tally after each emission', () => {
    const { warns, logger } = fakeLogger();
    let clock = 0;
    const warn = createRateLimitedWarn({ logger, intervalMs: 100, now: () => clock });
    warn({}, 'x');
    clock = 10;
    warn({}, 'x');
    clock = 100;
    warn({}, 'x');
    clock = 200;
    warn({}, 'x');
    expect(warns).toHaveLength(3);
    expect(warns[2]?.fields['suppressedCount']).toBe(0);
  });

  it('carries the CALLER fields of the emitted line, not of a suppressed one', () => {
    const { warns, logger } = fakeLogger();
    let clock = 0;
    const warn = createRateLimitedWarn({ logger, intervalMs: 100, now: () => clock });
    warn({ providerSid: 'MM1' }, 'x');
    clock = 10;
    warn({ providerSid: 'MM2' }, 'x');
    clock = 100;
    warn({ providerSid: 'MM3' }, 'x');
    expect(warns[1]?.fields['providerSid']).toBe('MM3');
  });
});

// THE TWO DEFECTS THESE PIN (fix wave 5, adversarial 21).
describe('the throttle cannot be blinded, and cannot hide a burst', () => {
  it('a BACKWARDS clock step restarts the window instead of suppressing forever', () => {
    const { warns, logger } = fakeLogger();
    let clock = 3_600_000;
    const warn = createRateLimitedWarn({ logger, intervalMs: 100, now: () => clock });
    warn({}, 'x');
    expect(warns).toHaveLength(1);

    // NTP correction / VM snapshot restore: 30 minutes backwards. `at - last`
    // is now hugely negative, which is `< intervalMs` - so the old code
    // suppressed EVERY call until wall-clock time caught back up.
    clock = 3_600_000 - 30 * 60_000;
    warn({ providerSid: 'MM2' }, 'x');

    const emitted = warns.filter((w) => w.message === 'x');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.fields['providerSid']).toBe('MM2');
    // ...and the step itself is reported, not swallowed.
    expect(
      warns.some((w) => w.fields['event'] === 'rate_limited_warn_clock_stepped_back'),
    ).toBe(true);
  });

  it('a burst followed by SILENCE still reports its tally when the window closes', () => {
    const { warns, logger } = fakeLogger();
    let clock = 0;
    const due: { fn: () => void; at: number }[] = [];
    const warn = createRateLimitedWarn({
      logger,
      intervalMs: 100,
      now: () => clock,
      schedule: (fn, ms) => due.push({ fn, at: clock + ms }),
    });

    warn({ providerSid: 'MM1' }, 'x'); // emitted
    for (let i = 0; i < 40; i += 1) {
      clock = 10 + i;
      warn({ providerSid: `MM${i + 2}` }, 'x'); // all suppressed
    }
    expect(warns).toHaveLength(1);

    // The flood stops. Nothing else will ever call this damper.
    clock = 200;
    for (const d of due) d.fn();

    expect(warns).toHaveLength(2);
    expect(warns[1]?.fields['suppressedCount']).toBe(40);
    expect(warns[1]?.fields['trailingFlush']).toBe(true);
  });

  it('the trailing flush is a no-op when the tally was already drained by an emission', () => {
    const { warns, logger } = fakeLogger();
    let clock = 0;
    const due: { fn: () => void; at: number }[] = [];
    const warn = createRateLimitedWarn({
      logger,
      intervalMs: 100,
      now: () => clock,
      schedule: (fn, ms) => due.push({ fn, at: clock + ms }),
    });

    warn({}, 'x');
    clock = 10;
    warn({}, 'x'); // suppressed -> schedules a flush
    clock = 150;
    warn({}, 'x'); // emits, draining the tally

    for (const d of due) d.fn();

    expect(warns).toHaveLength(2);
    expect(warns[1]?.fields['suppressedCount']).toBe(1);
  });
});
