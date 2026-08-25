import { describe, expect, it } from 'vitest';
import { degradedNotice } from './degradedNotice.js';

describe('degradedNotice', () => {
  it('keeps the not-deployed sentence for the ONE reason it is true of', () => {
    expect(degradedNotice('unavailable_local')).toBe('Available in deployed environments.');
  });

  it('does NOT claim a deployed environment is undeployed when the query failed', () => {
    // The live confusion this fixes: on dev the alarms block was reading fine
    // from the same account while the errors block printed the not-deployed
    // sentence, sending the reader to look at environment detection instead of
    // at a query that had timed out.
    const notice = degradedNotice('cloudwatch_error');
    expect(notice).not.toBe('Available in deployed environments.');
    expect(notice).toMatch(/IS deployed/);
    expect(notice).toMatch(/timed out|failed/);
  });

  it('names the refusal for a record from another environment', () => {
    expect(degradedNotice('out_of_scope')).toMatch(/different environment/);
  });

  it('distinguishes an invalid pointer from an invalid correlation id', () => {
    expect(degradedNotice('invalid_ref')).toMatch(/pointer/);
    expect(degradedNotice('invalid_id')).toMatch(/correlation id/);
  });

  it('does not guess the local case for an unrecognised or missing reason', () => {
    expect(degradedNotice('something_new')).toBe('Unavailable right now.');
    expect(degradedNotice(undefined)).toBe('Unavailable right now.');
  });
});
