import {
  MESSAGE_TRANSPORTS,
  TRANSPORT_SCHEMA_VERSION,
  type MessageTransport,
  type TransportAggregationState,
} from '../messageTransport.js';

export type SeedMessage = Record<string, unknown> & {
  direction?: 'inbound' | 'outbound';
  delivery_recipients?: Record<string, Record<string, unknown>>;
};

export type SeedCarrierTransport =
  | { kind: 'legacy' }
  | {
      kind: 'versioned';
      requested?: MessageTransport;
      actual?: MessageTransport;
      recipients?: Record<string, {
        requestedTransport?: MessageTransport;
        actualTransport?: MessageTransport;
        transportAggregationState?: TransportAggregationState;
      }>;
    };

function assertTransport(value: unknown, field: string): asserts value is MessageTransport {
  if (!MESSAGE_TRANSPORTS.includes(value as MessageTransport)) {
    throw new TypeError(`invalid seed ${field}`);
  }
}

export function withSeedTransport<T extends SeedMessage>(
  message: T,
  declaration: SeedCarrierTransport,
): T {
  if ('transport_schema_version' in message || 'requested_transport' in message || 'actual_transport' in message) {
    throw new TypeError('seed carrier transport must be declared exactly once');
  }
  if (declaration.kind === 'legacy') return { ...message };
  if (message.direction === 'inbound' && declaration.requested !== undefined) {
    throw new TypeError('inbound seed messages cannot request a transport');
  }
  if (message.direction === 'outbound' && declaration.requested === undefined) {
    throw new TypeError('versioned outbound seed messages must request a transport');
  }
  if (declaration.requested !== undefined) assertTransport(declaration.requested, 'requested transport');
  if (declaration.actual !== undefined) assertTransport(declaration.actual, 'actual transport');

  const deliveryRecipients = { ...(message.delivery_recipients ?? {}) };
  for (const [memberKey, facts] of Object.entries(declaration.recipients ?? {})) {
    if (facts.requestedTransport !== undefined) assertTransport(facts.requestedTransport, 'recipient requested transport');
    if (facts.actualTransport !== undefined) assertTransport(facts.actualTransport, 'recipient actual transport');
    deliveryRecipients[memberKey] = { ...(deliveryRecipients[memberKey] ?? {}), ...facts };
  }

  return {
    ...message,
    transport_schema_version: TRANSPORT_SCHEMA_VERSION,
    ...(declaration.requested !== undefined && { requested_transport: declaration.requested }),
    ...(declaration.actual !== undefined && { actual_transport: declaration.actual }),
    ...(declaration.recipients !== undefined && { delivery_recipients: deliveryRecipients }),
  };
}
