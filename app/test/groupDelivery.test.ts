// Live QA round 2 (L3/L4): the suppressed slot and the aggregate derivation.
//
// Both defects here were invisible to the whole suite because they only showed
// up against real Twilio: a member Twilio SKIPS never produces a receipt, so a
// `queued` slot for them is stuck forever (L3), and nothing anywhere ever wrote
// the message-level `delivery_status` for a group send (L4).
import { describe, expect, it } from 'vitest';
import type { RelayRecipientDelivery } from '../src/repos/messagesRepo.js';
import {
  deriveGroupDeliveryStatus,
  isSuppressedSlot,
  SUPPRESSED_ERROR_CODE,
  suppressedSlot,
} from '../src/services/groupDelivery.js';

const delivered: RelayRecipientDelivery = { status: 'delivered' };
const sent: RelayRecipientDelivery = { status: 'sent' };
const queued: RelayRecipientDelivery = { status: 'queued' };
const failed: RelayRecipientDelivery = { status: 'failed', errorCode: '30007' };
const undelivered: RelayRecipientDelivery = { status: 'undelivered', errorCode: '30003' };

describe('suppressedSlot (the L3 seed)', () => {
  it('is TERMINAL and carries the synthetic suppression code', () => {
    // Terminal is the whole point: Twilio never creates the leg, so no receipt
    // will ever move this slot and the staleness alarm must not wait on it.
    expect(suppressedSlot()).toEqual({ status: 'undelivered', errorCode: SUPPRESSED_ERROR_CODE });
    expect(isSuppressedSlot(suppressedSlot())).toBe(true);
  });

  it('is INDISTINGUISHABLE from what a real 21610 receipt writes', () => {
    // The receipts path writes Twilio's own `undelivered` plus the same
    // synthetic code, so every downstream reader (rollup chip, opted-out note,
    // this module) handles the seeded form with no new branch.
    expect(suppressedSlot().status).toBe('undelivered');
    expect(isSuppressedSlot({ errorCode: '30003' })).toBe(false);
  });
});

describe('deriveGroupDeliveryStatus (spec 4.3)', () => {
  it('stays queued while any leg is still queued - the caller then writes nothing', () => {
    expect(deriveGroupDeliveryStatus([queued, delivered])).toEqual({ status: 'queued' });
    expect(deriveGroupDeliveryStatus([queued, queued])).toEqual({ status: 'queued' });
  });

  it('reads `sent` once every leg has left Twilio but none has landed', () => {
    expect(deriveGroupDeliveryStatus([sent, sent])).toEqual({ status: 'sent' });
    expect(deriveGroupDeliveryStatus([sent, delivered])).toEqual({ status: 'sent' });
  });

  it('reads `delivered` when every leg arrived - the L4 case seen live', () => {
    // LIVE: both slots read `delivered` and the message still said `queued`.
    expect(deriveGroupDeliveryStatus([delivered, delivered])).toEqual({ status: 'delivered' });
  });

  it('EXCLUDES suppressed legs, so one opted-out member still finalizes', () => {
    // Counting the skipped leg would make the aggregate unreachable forever -
    // the same reason the dashboard rollup chip excludes it.
    expect(deriveGroupDeliveryStatus([delivered, suppressedSlot()])).toEqual({
      status: 'delivered',
    });
    expect(deriveGroupDeliveryStatus([queued, suppressedSlot()])).toEqual({ status: 'queued' });
  });

  it('is neither queued nor failed when all-terminal includes a suppressed leg', () => {
    const out = deriveGroupDeliveryStatus([delivered, delivered, suppressedSlot()]);
    expect(out.status).not.toBe('queued');
    expect(out.status).not.toBe('failed');
    expect(out.status).toBe('delivered');
  });

  it('surfaces the worst real outcome, failed outranking undelivered', () => {
    expect(deriveGroupDeliveryStatus([delivered, failed])).toEqual({
      status: 'failed',
      errorCode: '30007',
    });
    expect(deriveGroupDeliveryStatus([delivered, undelivered])).toEqual({
      status: 'undelivered',
      errorCode: '30003',
    });
    expect(deriveGroupDeliveryStatus([undelivered, failed]).status).toBe('failed');
  });

  it('reports EVERY member suppressed as undelivered, with the suppression code', () => {
    // Nothing was sent to anybody and no receipt will ever say so, so leaving
    // this `queued` would be a send that never finishes.
    expect(deriveGroupDeliveryStatus([suppressedSlot(), suppressedSlot()])).toEqual({
      status: 'undelivered',
      errorCode: SUPPRESSED_ERROR_CODE,
    });
  });

  it('treats NO map as no information rather than a failure', () => {
    expect(deriveGroupDeliveryStatus([])).toEqual({ status: 'queued' });
  });

  it('is MONOTONIC, which is what makes it safe against the forward-only writer', () => {
    // Walk one 2-member send through its real receipt order and check the
    // derived value never moves backwards.
    const order = ['queued', 'sent', 'delivered'] as const;
    const rank = (s: string): number => order.indexOf(s as (typeof order)[number]);
    const steps: RelayRecipientDelivery[][] = [
      [queued, queued],
      [sent, queued],
      [sent, sent],
      [delivered, sent],
      [delivered, delivered],
    ];
    let last = -1;
    for (const slots of steps) {
      const r = rank(deriveGroupDeliveryStatus(slots).status);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(last).toBe(rank('delivered'));
  });
});
