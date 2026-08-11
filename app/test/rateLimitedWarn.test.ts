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
