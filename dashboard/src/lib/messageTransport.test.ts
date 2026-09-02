import { describe, expect, it } from 'vitest';
import type {
  MessageTransport,
  RelayRecipientDelivery,
} from '../api/index.js';
import {
  includedRecipientEntries,
  isRecipientExcludedFromPresentation,
  presentMessageTransport,
  presentRecipientTransport,
  type PresentMessageTransportInput,
} from './messageTransport.js';

const versionedOutbound = (
  overrides: Partial<PresentMessageTransportInput> = {},
): PresentMessageTransportInput => ({
  type: 'sms',
  direction: 'outbound',
  transportSchemaVersion: 1,
  requestedTransport: 'sms',
  ...overrides,
});

const attempted = (
  actualTransport?: MessageTransport,
  requestedTransport: MessageTransport = 'sms',
): RelayRecipientDelivery => ({
  status: 'sent',
  requestedTransport,
  ...(actualTransport !== undefined && { actualTransport }),
  transportAggregationState: 'attempted',
});

describe('presentMessageTransport', () => {
  it.each([
    ['sms', 'SMS'],
    ['mms', 'MMS'],
    ['call', 'CALL'],
    ['email', 'EMAIL'],
  ] as const)('keeps the legacy uppercase label for schema-absent %s', (type, expected) => {
    expect(presentMessageTransport({ type, direction: 'outbound' })).toBe(expected);
  });

  it.each(['sms', 'mms'] as const)('hides an optimistic %s carrier claim', (type) => {
    expect(
      presentMessageTransport({
        type,
        direction: 'outbound',
        optimistic: true,
        transportSchemaVersion: 1,
        requestedTransport: 'rcs',
        actualTransport: 'sms',
      }),
    ).toBeNull();
  });

  it.each([
    ['sms', 'SMS'],
    ['mms', 'MMS'],
    ['rcs', 'RCS'],
  ] as const)('shows inbound actual %s without a synthetic request', (actualTransport, expected) => {
    expect(
      presentMessageTransport({
        type: 'sms',
        direction: 'inbound',
        transportSchemaVersion: 1,
        actualTransport,
      }),
    ).toBe(expected);
  });

  it('shows Unknown for unresolved versioned inbound and ignores malformed requested data', () => {
    expect(
      presentMessageTransport({
        type: 'mms',
        direction: 'inbound',
        transportSchemaVersion: 1,
        requestedTransport: 'rcs',
      }),
    ).toBe('Unknown');
    expect(
      presentMessageTransport({
        type: 'mms',
        direction: 'inbound',
        transportSchemaVersion: 1,
        requestedTransport: 'rcs',
        actualTransport: 'sms',
      }),
    ).toBe('SMS');
  });

  it.each([
    ['sms', 'sms', 'SMS'],
    ['sms', 'mms', 'SMS -> MMS'],
    ['sms', 'rcs', 'SMS -> RCS'],
    ['mms', 'sms', 'MMS -> SMS'],
    ['mms', 'mms', 'MMS'],
    ['mms', 'rcs', 'MMS -> RCS'],
    ['rcs', 'sms', 'RCS -> SMS'],
    ['rcs', 'mms', 'RCS -> MMS'],
    ['rcs', 'rcs', 'RCS'],
  ] as const)(
    'formats every known outbound pair %s/%s',
    (requestedTransport, actualTransport, expected) => {
      expect(
        presentMessageTransport(
          versionedOutbound({ requestedTransport, actualTransport }),
        ),
      ).toBe(expected);
    },
  );

  it.each([
    ['sms', 'SMS'],
    ['mms', 'MMS'],
    ['rcs', 'RCS'],
  ] as const)('shows pending outbound request %s alone', (requestedTransport, expected) => {
    expect(presentMessageTransport(versionedOutbound({ requestedTransport }))).toBe(expected);
  });

  it('shows Unknown when a versioned outbound message has neither transport fact', () => {
    expect(
      presentMessageTransport(versionedOutbound({ requestedTransport: undefined })),
    ).toBe('Unknown');
  });

  it('shows a known actual transport when a versioned outbound message has no request', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({ requestedTransport: undefined, actualTransport: 'mms' }),
      ),
    ).toBe('MMS');
  });

  it('uses complete attempted recipient evidence instead of message-level actual', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          actualTransport: 'sms',
          recipients: {
            first: attempted('mms'),
            second: attempted('mms'),
          },
        }),
      ),
    ).toBe('SMS -> MMS');
  });

  it('shows a uniform completed recipient actual when the message request is absent', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: undefined,
          recipients: {
            first: {
              status: 'sent',
              actualTransport: 'mms',
              transportAggregationState: 'attempted',
            },
          },
        }),
      ),
    ).toBe('MMS');
  });

  it('shows Mixed only when every attempted leg has actual and the actuals diverge', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: 'rcs',
          recipients: {
            first: attempted('rcs', 'rcs'),
            second: attempted('sms', 'rcs'),
          },
        }),
      ),
    ).toBe('RCS -> Mixed');

    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: 'rcs',
          recipients: {
            first: attempted('rcs', 'rcs'),
            second: attempted(undefined, 'rcs'),
          },
        }),
      ),
    ).toBe('RCS');
  });

  it('treats planned slots as incomplete', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: 'rcs',
          recipients: {
            attempted: attempted('sms', 'rcs'),
            planned: {
              status: 'queued',
              requestedTransport: 'rcs',
              actualTransport: 'sms',
              transportAggregationState: 'planned',
            },
          },
        }),
      ),
    ).toBe('RCS');
  });

  it('ignores state-absent slots when aggregating complete attempted recipient evidence', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: 'rcs',
          recipients: {
            attempted: attempted('sms', 'rcs'),
            sourceTime: {
              status: 'queued',
              requestedTransport: 'rcs',
              actualTransport: 'sms',
            },
          },
        }),
      ),
    ).toBe('RCS -> SMS');
  });

  it('ignores excluded slots for completeness and actual aggregation', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: 'rcs',
          recipients: {
            first: attempted('rcs', 'rcs'),
            removed: {
              status: 'queued',
              requestedTransport: 'rcs',
              actualTransport: 'sms',
              transportAggregationState: 'excluded',
            },
            optedOut: {
              status: 'failed',
              errorCode: 'contact_opted_out',
              requestedTransport: 'rcs',
              transportAggregationState: 'excluded',
            },
          },
        }),
      ),
    ).toBe('RCS');
  });

  it('shows Mixed without an arrow when complete divergent evidence has no request', () => {
    expect(
      presentMessageTransport(
        versionedOutbound({
          requestedTransport: undefined,
          recipients: {
            first: attempted('rcs', 'rcs'),
            second: attempted('sms', 'rcs'),
          },
        }),
      ),
    ).toBe('Mixed');
  });

  it('does not let outbound relay legs replace an inbound source chip', () => {
    expect(
      presentMessageTransport({
        type: 'sms',
        direction: 'inbound',
        transportSchemaVersion: 1,
        actualTransport: 'mms',
        recipients: {
          first: attempted('rcs', 'rcs'),
          second: attempted('sms', 'rcs'),
        },
      }),
    ).toBe('MMS');
  });
});

describe('presentRecipientTransport', () => {
  it.each([
    [
      { status: 'queued', requestedTransport: 'sms' },
      'SMS',
    ],
    [
      { status: 'sent', requestedTransport: 'mms', actualTransport: 'mms' },
      'MMS',
    ],
    [
      { status: 'sent', requestedTransport: 'rcs', actualTransport: 'sms' },
      'RCS -> SMS',
    ],
    [
      { status: 'sent', actualTransport: 'mms' },
      'MMS',
    ],
    [
      { status: 'queued' },
      'Unknown',
    ],
  ] satisfies Array<[RelayRecipientDelivery, string]>)('presents recipient facts honestly', (slot, expected) => {
    expect(presentRecipientTransport(slot)).toBe(expected);
  });

  it('returns null for an excluded recipient transport without a suppression code', () => {
    const slot = { status: 'queued', transportAggregationState: 'excluded' } satisfies RelayRecipientDelivery;
    expect(presentRecipientTransport(slot)).toBeNull();
  });

  it('shows requested transport for an opted-out excluded recipient', () => {
    const slot = {
      status: 'failed',
      errorCode: 'contact_opted_out',
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
    } satisfies RelayRecipientDelivery;
    expect(presentRecipientTransport(slot)).toBe('SMS');
  });
});

describe('recipient presentation inclusion', () => {
  const recipients = {
    sourceTime: { status: 'queued' },
    planned: { status: 'queued', transportAggregationState: 'planned' },
    attempted: { status: 'sent', transportAggregationState: 'attempted' },
    removed: { status: 'queued', transportAggregationState: 'excluded' },
    optedOut: {
      status: 'failed',
      errorCode: 'contact_opted_out',
      transportAggregationState: 'excluded',
    },
    excludedWithCode: {
      status: 'failed',
      errorCode: 'other_suppression',
      transportAggregationState: 'excluded',
    },
  } satisfies Record<string, RelayRecipientDelivery>;

  it('hides only excluded recipients without a suppression code', () => {
    expect(includedRecipientEntries(recipients).map(([key]) => key)).toEqual([
      'sourceTime',
      'planned',
      'attempted',
      'optedOut',
      'excludedWithCode',
    ]);
    expect(isRecipientExcludedFromPresentation(recipients.removed)).toBe(true);
    expect(isRecipientExcludedFromPresentation(recipients.optedOut)).toBe(false);
  });
});
