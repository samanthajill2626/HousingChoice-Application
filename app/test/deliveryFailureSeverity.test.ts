// Delivery-failure severity taxonomy (routes/webhooks/twilio.ts). The rule: a
// message that ends UNDELIVERED and won't be retried is a TERMINAL failure →
// ERROR. Two carve-outs stay WARN: a transient code we auto-retry (30003), and a
// provider-side opt-out (21610 = correctly honoring STOP, not a failure).
import { describe, expect, it } from 'vitest';
import { isTerminalDeliveryFailure } from '../src/routes/webhooks/twilio.js';

describe('isTerminalDeliveryFailure', () => {
  it('treats terminal, operator-actionable delivery failures as errors', () => {
    // 30034 unregistered A2P (systemic), 30005 invalid, 30006 landline,
    // 30007 carrier-filtered, 30008 unknown — all terminal, none retried.
    for (const code of ['30034', '30005', '30006', '30007', '30008']) {
      expect(isTerminalDeliveryFailure(code), `code ${code}`).toBe(true);
    }
  });

  it('treats an unknown code, or a failed callback with NO code, as terminal (fail loud, not silent)', () => {
    expect(isTerminalDeliveryFailure('99999')).toBe(true);
    expect(isTerminalDeliveryFailure(undefined)).toBe(true);
    expect(isTerminalDeliveryFailure('')).toBe(true);
  });

  it('does NOT treat a transient, auto-retried code (30003 handset unreachable) as terminal — it stays a warn while retrying', () => {
    expect(isTerminalDeliveryFailure('30003')).toBe(false);
  });

  it('does NOT treat a provider-side opt-out (21610) as a failure — honoring STOP is correct behavior', () => {
    expect(isTerminalDeliveryFailure('21610')).toBe(false);
  });
});
