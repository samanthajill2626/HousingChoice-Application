import type {
  MessageTransport,
  MessageType,
  RelayRecipientDelivery,
} from '../api/index.js';

export interface PresentMessageTransportInput {
  type: MessageType;
  direction: 'inbound' | 'outbound';
  optimistic?: boolean;
  transportSchemaVersion?: 1;
  requestedTransport?: MessageTransport;
  actualTransport?: MessageTransport;
  recipients?: Record<string, RelayRecipientDelivery>;
}

type RecipientPresentationFields = Pick<
  RelayRecipientDelivery,
  'status' | 'errorCode' | 'transportAggregationState'
>;

type RecipientCollection<T extends RecipientPresentationFields> =
  | Readonly<Record<string, T>>
  | readonly T[];

function transportLabel(transport: MessageTransport): string {
  return transport.toUpperCase();
}

function presentKnownPair(
  requested: MessageTransport,
  actual: MessageTransport,
): string {
  const requestedLabel = transportLabel(requested);
  const actualLabel = transportLabel(actual);
  return requested === actual ? requestedLabel : `${requestedLabel} -> ${actualLabel}`;
}

function presentRequestedOnly(requested: MessageTransport | undefined): string {
  return requested === undefined ? 'Unknown' : transportLabel(requested);
}

export function isRecipientExcludedFromPresentation(
  slot: RecipientPresentationFields,
): boolean {
  return slot.transportAggregationState === 'excluded' && !slot.errorCode;
}

export function includedRecipientEntries<T extends RecipientPresentationFields>(
  recipients: RecipientCollection<T> | undefined,
): Array<[string, T]> {
  if (recipients === undefined) return [];
  const entries: Array<[string, T]> = Array.isArray(recipients)
    ? recipients.map((slot, index) => [String(index), slot])
    : (Object.entries(recipients) as Array<[string, T]>);
  return entries.filter(([, slot]) => !isRecipientExcludedFromPresentation(slot));
}

export function presentRecipientTransport(
  slot: RelayRecipientDelivery,
): string | null {
  if (slot.transportAggregationState === 'excluded') {
    return slot.errorCode === 'contact_opted_out'
      ? presentRequestedOnly(slot.requestedTransport)
      : null;
  }
  if (slot.requestedTransport !== undefined && slot.actualTransport !== undefined) {
    return presentKnownPair(slot.requestedTransport, slot.actualTransport);
  }
  if (slot.requestedTransport !== undefined) {
    return transportLabel(slot.requestedTransport);
  }
  if (slot.actualTransport !== undefined) {
    return transportLabel(slot.actualTransport);
  }
  return 'Unknown';
}

function presentOutboundRecipientAggregate(
  input: PresentMessageTransportInput,
): string {
  const slots = includedRecipientEntries(input.recipients).map(([, slot]) => slot);
  const expected = slots.filter(
    (slot) =>
      slot.transportAggregationState === 'planned' ||
      slot.transportAggregationState === 'attempted',
  );
  const complete =
    expected.length > 0 &&
    expected.every(
      (slot) =>
        slot.transportAggregationState === 'attempted' &&
        slot.actualTransport !== undefined,
    );

  if (!complete) return presentRequestedOnly(input.requestedTransport);

  const actuals = new Set(expected.map((slot) => slot.actualTransport));
  if (actuals.size > 1) {
    return input.requestedTransport === undefined
      ? 'Mixed'
      : `${transportLabel(input.requestedTransport)} -> Mixed`;
  }

  const actual = expected[0]?.actualTransport;
  if (actual === undefined) return 'Unknown';
  if (input.requestedTransport === undefined) return transportLabel(actual);
  return presentKnownPair(input.requestedTransport, actual);
}

export function presentMessageTransport(
  input: PresentMessageTransportInput,
): string | null {
  const carrier = input.type === 'sms' || input.type === 'mms';
  if (carrier && input.optimistic === true) return null;
  if (input.type === 'call' || input.type === 'email') return input.type.toUpperCase();
  if (input.transportSchemaVersion !== 1) return input.type.toUpperCase();

  if (input.direction === 'inbound') {
    return input.actualTransport === undefined
      ? 'Unknown'
      : transportLabel(input.actualTransport);
  }

  if (input.recipients !== undefined && Object.keys(input.recipients).length > 0) {
    return presentOutboundRecipientAggregate(input);
  }

  if (input.actualTransport === undefined) return presentRequestedOnly(input.requestedTransport);
  if (input.requestedTransport === undefined) return transportLabel(input.actualTransport);
  return presentKnownPair(input.requestedTransport, input.actualTransport);
}
