// Cross-workspace SEND-OUTCOME CODE MIRROR DRIFT GUARD (send-outcome-reconcile
// D20-D23; the plan's declared deviation 2).
//
// app/src/lib/sendOutcome.ts owns the slot codes the send sites and the
// send.reconcile job write: `send_unconfirmed` (a closed slot the platform
// could not confirm), `redrive_refused` (a re-drive the pre-check declined),
// `send_retryable` (a DEFERRAL - the slot is still queued) and
// `sms_sending_disabled` (the adapter kill switch). The dashboard never imports
// app VALUES at runtime, so deliveryStatus.ts HAND-COPIES them: the presenters
// key "Not confirmed" on SEND_UNCONFIRMED_CODE by code alone, and
// INTERNAL_CODE_REASONS keys the prose on the others. If an app value moved and
// a copy did not, the dashboard would print the new token as "Delivery failed
// (error <token>)" - a failure, with a carrier-style tail, on a text that may
// have gone out: the resend D20 exists to prevent - and no other test would
// see it.
//
// MECHANISM and DIRECTION: the same as relayWindowCloseMirror.test.ts - import
// both sides and compare RESOLVED values, from the dashboard side. This file
// is the ONLY place the dashboard imports these app values.
import { describe, expect, it } from 'vitest';
import {
  ENQUEUE_FAILED_CODE as APP_ENQUEUE_FAILED_CODE,
  REDRIVE_REFUSED_CODE as APP_REDRIVE_REFUSED_CODE,
  SEND_RETRYABLE_CODE as APP_SEND_RETRYABLE_CODE,
  SEND_UNCONFIRMED_CODE as APP_SEND_UNCONFIRMED_CODE,
  SMS_SENDING_DISABLED_CODE as APP_SMS_SENDING_DISABLED_CODE,
  TRANSIENT_CAP_CODE as APP_TRANSIENT_CAP_CODE,
} from '../../../../app/src/lib/sendOutcome.js';
import {
  deliveryReason,
  presentLegDelivery,
  REDRIVE_REFUSED_CODE,
  SEND_RETRYABLE_CODE,
  SEND_UNCONFIRMED_CODE,
  SMS_SENDING_DISABLED_CODE,
} from './deliveryStatus.js';

const APP_CODES = [
  APP_SEND_UNCONFIRMED_CODE,
  APP_REDRIVE_REFUSED_CODE,
  APP_SEND_RETRYABLE_CODE,
  APP_SMS_SENDING_DISABLED_CODE,
];

describe('dashboard send-outcome codes mirror app/src/lib/sendOutcome.ts', () => {
  it.each([
    ['SEND_UNCONFIRMED_CODE', SEND_UNCONFIRMED_CODE, APP_SEND_UNCONFIRMED_CODE],
    ['REDRIVE_REFUSED_CODE', REDRIVE_REFUSED_CODE, APP_REDRIVE_REFUSED_CODE],
    ['SEND_RETRYABLE_CODE', SEND_RETRYABLE_CODE, APP_SEND_RETRYABLE_CODE],
    ['SMS_SENDING_DISABLED_CODE', SMS_SENDING_DISABLED_CODE, APP_SMS_SENDING_DISABLED_CODE],
  ])('%s is the value the app writes', (_name, dashboardValue, appValue) => {
    expect(dashboardValue).toBe(appValue);
  });

  it('every CLOSED code has prose keyed on the APP value, and the deferral renders as queued', () => {
    for (const code of [
      APP_SEND_UNCONFIRMED_CODE,
      APP_REDRIVE_REFUSED_CODE,
      APP_SMS_SENDING_DISABLED_CODE,
    ]) {
      const reason = deliveryReason(code);
      expect(reason).toBeDefined();
      expect(reason).not.toContain('(error ');
      expect(reason).not.toContain(code);
    }
    expect(deliveryReason(APP_SEND_RETRYABLE_CODE)).toBeUndefined();
  });

  it('the row presenter keys Not confirmed on the APP value', () => {
    expect(
      presentLegDelivery({ status: 'failed', errorCode: APP_SEND_UNCONFIRMED_CODE }, 'relay')?.label,
    ).toBe('Not confirmed');
  });

  // The two pre-existing fan-out closes, keyed in INTERNAL_CODE_REASONS by
  // literal: pinned to the app values here too, since D23 re-words one of them.
  it('the transient_cap and enqueue_failed prose is keyed on the APP values', () => {
    expect(deliveryReason(APP_TRANSIENT_CAP_CODE)).toBe(
      'Sending gave up after repeated temporary errors',
    );
    expect(deliveryReason(APP_ENQUEUE_FAILED_CODE)).toBe('Sending could not be scheduled');
  });

  it('does not compare vacuous values', () => {
    // The floor that stops the assertions above passing if an import ever
    // resolves to nothing, or the maps answer every code alike.
    for (const code of APP_CODES) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
    expect(new Set(APP_CODES).size).toBe(APP_CODES.length);
    const other = `${APP_SEND_UNCONFIRMED_CODE}_other`;
    expect(deliveryReason(other)).not.toBe(deliveryReason(APP_SEND_UNCONFIRMED_CODE));
    expect(presentLegDelivery({ status: 'failed', errorCode: other }, 'relay')?.label).not.toBe(
      'Not confirmed',
    );
  });
});
