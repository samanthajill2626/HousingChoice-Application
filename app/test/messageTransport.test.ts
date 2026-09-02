import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TRANSPORTS,
  TRANSPORT_SCHEMA_VERSION,
  decideActualTransportWrite,
  decideTransportAggregationWrite,
  type MessageTransport,
  type TransportAggregationState,
  type TransportAggregationWriteDecision,
  type TransportWriteDecision,
} from '../src/lib/messageTransport.js';

describe('message transport domain', () => {
  it('pins the versioned closed transport vocabulary', () => {
    expect(TRANSPORT_SCHEMA_VERSION).toBe(1);
    expect(MESSAGE_TRANSPORTS).toEqual(['sms', 'mms', 'rcs']);
  });

  describe('actual transport writes', () => {
    const cases: Array<[
      MessageTransport | undefined,
      MessageTransport,
      MessageTransport | undefined,
      TransportWriteDecision,
    ]> = [
      [undefined, 'sms', 'sms', { kind: 'write', transport: 'sms' }],
      ['mms', 'mms', 'mms', { kind: 'idempotent' }],
      ['rcs', 'sms', 'rcs', { kind: 'write', transport: 'sms' }],
      ['rcs', 'mms', 'rcs', { kind: 'write', transport: 'mms' }],
      ['sms', 'rcs', 'rcs', { kind: 'stale-rcs-observation' }],
      ['mms', 'rcs', 'rcs', { kind: 'stale-rcs-observation' }],
      ['sms', 'mms', 'sms', { kind: 'conflict', current: 'sms', attempted: 'mms' }],
      ['mms', 'sms', 'mms', { kind: 'conflict', current: 'mms', attempted: 'sms' }],
      ['sms', 'rcs', 'sms', { kind: 'conflict', current: 'sms', attempted: 'rcs' }],
    ];

    it.each(cases)(
      'classifies current=%s attempted=%s requested=%s',
      (current, attempted, requested, expected) => {
        expect(decideActualTransportWrite(current, attempted, requested)).toEqual(expected);
      },
    );
  });

  describe('transport aggregation writes', () => {
    const allowedCases: Array<[
      TransportAggregationState | undefined,
      TransportAggregationState,
      TransportAggregationWriteDecision,
    ]> = [
      [undefined, 'planned', { kind: 'write', state: 'planned' }],
      [undefined, 'excluded', { kind: 'write', state: 'excluded' }],
      ['planned', 'attempted', { kind: 'write', state: 'attempted' }],
      ['planned', 'excluded', { kind: 'write', state: 'excluded' }],
      ['excluded', 'planned', { kind: 'write', state: 'planned' }],
      ['planned', 'planned', { kind: 'idempotent' }],
      ['attempted', 'attempted', { kind: 'idempotent' }],
      ['excluded', 'excluded', { kind: 'idempotent' }],
    ];

    it.each(allowedCases)('allows current=%s next=%s', (current, next, expected) => {
      expect(decideTransportAggregationWrite(current, next)).toEqual(expected);
    });

    const refusedCases: Array<[
      TransportAggregationState | undefined,
      TransportAggregationState,
      MessageTransport | undefined,
    ]> = [
      [undefined, 'attempted', undefined],
      ['attempted', 'planned', undefined],
      ['attempted', 'excluded', undefined],
      ['excluded', 'attempted', undefined],
      ['excluded', 'planned', 'mms'],
    ];

    it.each(refusedCases)(
      'refuses current=%s next=%s actual=%s',
      (current, next, actualTransport) => {
        expect(decideTransportAggregationWrite(current, next, actualTransport)).toEqual({
          kind: 'conflict',
          current,
          attempted: next,
        });
      },
    );

    it('keeps attempted terminal even when actual evidence is present', () => {
      expect(decideTransportAggregationWrite('attempted', 'attempted', 'sms')).toEqual({
        kind: 'idempotent',
      });
    });
  });
});
