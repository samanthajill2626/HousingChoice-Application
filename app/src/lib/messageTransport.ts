export const TRANSPORT_SCHEMA_VERSION = 1 as const;

export const MESSAGE_TRANSPORTS = ['sms', 'mms', 'rcs'] as const;

export type MessageTransport = (typeof MESSAGE_TRANSPORTS)[number];

export type TransportAggregationState = 'planned' | 'attempted' | 'excluded';

export type TransportWriteDecision =
  | { kind: 'write'; transport: MessageTransport }
  | { kind: 'idempotent' }
  | { kind: 'stale-rcs-observation' }
  | { kind: 'conflict'; current: MessageTransport; attempted: MessageTransport };

export type TransportAggregationWriteDecision =
  | { kind: 'write'; state: TransportAggregationState }
  | { kind: 'idempotent' }
  | {
      kind: 'conflict';
      current: TransportAggregationState | undefined;
      attempted: TransportAggregationState;
    };

export function decideActualTransportWrite(
  current: MessageTransport | undefined,
  attempted: MessageTransport,
  requested: MessageTransport | undefined,
): TransportWriteDecision {
  if (current === undefined) {
    return { kind: 'write', transport: attempted };
  }
  if (current === attempted) {
    return { kind: 'idempotent' };
  }
  if (current === 'rcs' && (attempted === 'sms' || attempted === 'mms')) {
    return { kind: 'write', transport: attempted };
  }
  if (
    attempted === 'rcs' &&
    requested === 'rcs' &&
    (current === 'sms' || current === 'mms')
  ) {
    return { kind: 'stale-rcs-observation' };
  }
  return { kind: 'conflict', current, attempted };
}

export function decideTransportAggregationWrite(
  current: TransportAggregationState | undefined,
  attempted: TransportAggregationState,
  actualTransport?: MessageTransport,
): TransportAggregationWriteDecision {
  if (current === attempted) {
    return { kind: 'idempotent' };
  }
  if (current === undefined && (attempted === 'planned' || attempted === 'excluded')) {
    return { kind: 'write', state: attempted };
  }
  if (current === 'planned' && (attempted === 'attempted' || attempted === 'excluded')) {
    return { kind: 'write', state: attempted };
  }
  if (current === 'excluded' && attempted === 'planned' && actualTransport === undefined) {
    return { kind: 'write', state: attempted };
  }
  return { kind: 'conflict', current, attempted };
}
