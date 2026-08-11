// T5.3: POST /webhooks/twilio/conversations - ONE route, dispatched on EventType.
//
// Twilio permits exactly one PostWebhookUrl per Conversations service, and the
// S5-PRE addendum proved that configuring a SERVICE-scoped webhook silences the
// account-global scope entirely. So the receipts half (S5) and the guardrail
// cross-check half (S6) share this endpoint, and the split is a switch.
//
// The mount-order test is not ceremony: /webhooks/twilio is a PREFIX mount, so
// a conversations router registered after it would be swallowed and every group
// delivery receipt would 404 into the messaging router - silently, because
// Twilio's retries would be the only symptom.
import { describe, expect, it } from 'vitest';
import { makeWebhookHarness, signedTwilioPost } from './helpers/twilioWebhookHarness.js';
import type { GroupReceiptsService } from '../src/services/groupReceipts.js';
import type {
  ConversationsCrossCheck,
  ConversationsMessageAddedEvent,
} from '../src/routes/webhooks/twilioConversations.js';

const WARN = 40;
const PATH = '/webhooks/twilio/conversations';

/** The exact `onDeliveryUpdated` shape captured live (spike addendum). */
const DELIVERY_PARAMS = {
  AccountSid: 'AC29e1d905a2b90844f0fbe0bd92ef9845',
  ChannelMessageSid: 'SM55be061fd3cb45e285b50ce0a0aac963',
  ChatServiceSid: 'IS4375c839d35a4622993d0a6039b56cbe',
  ConversationSid: 'CH4f86e80e5052470997c9367239482569',
  DateCreated: '2026-08-11T13:06:45.433Z',
  DateUpdated: '2026-08-11T13:06:47.633Z',
  DeliveryReceiptSid: 'DYf9f8743b7e0c12440be0f41ad9a615e9',
  EventType: 'onDeliveryUpdated',
  MessageSid: 'IM7ec5ba85270d4cf498cd6edb3eddf2d2',
  ParticipantSid: 'MB4be6357a1f5c4acea29f2bc0665c9202',
  RetryCount: '0',
  Status: 'sent',
};

/** The exact carrier-sourced `onMessageAdded` shape captured live. */
const MESSAGE_ADDED_PARAMS = {
  AccountSid: 'AC29e1d905a2b90844f0fbe0bd92ef9845',
  Attributes: '{}',
  Author: '+16174707727',
  Body: 'Addendum inbound test TWO, from the 617 number.',
  ChatServiceSid: 'IS4375c839d35a4622993d0a6039b56cbe',
  ConversationSid: 'CH4f86e80e5052470997c9367239482569',
  DateCreated: '2026-08-11T13:03:28.879Z',
  EventType: 'onMessageAdded',
  Index: '1',
  MessageSid: 'IMcc4a2eb90c7243e6b954a6829c7f28fc',
  MessagingServiceSid: 'MG8715333e3713e4381d168dd3bddc8189',
  ParticipantSid: 'MB01436d2e7c2d4fe885551e823d81ebb9',
  RetryCount: '0',
  Source: 'SMS',
};

function recordingReceipts(): GroupReceiptsService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async applyReceipt(input) {
      calls.push(input);
      return { outcome: 'applied', memberKey: 'phone#+16175550111' };
    },
    async drainParked() {
      return 0;
    },
  };
}

function recordingCrossCheck(): ConversationsCrossCheck & {
  events: ConversationsMessageAddedEvent[];
} {
  const events: ConversationsMessageAddedEvent[] = [];
  return {
    events,
    async recordConversationEvent(event) {
      events.push(event);
    },
  };
}

describe('POST /webhooks/twilio/conversations - dispatch', () => {
  it('routes onDeliveryUpdated to the receipts pipeline with the live payload field names', async () => {
    const receipts = recordingReceipts();
    const { app } = makeWebhookHarness({ groupReceipts: receipts });

    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(receipts.calls).toEqual([
      {
        messageSid: 'IM7ec5ba85270d4cf498cd6edb3eddf2d2',
        participantSid: 'MB4be6357a1f5c4acea29f2bc0665c9202',
        status: 'sent',
        channelMessageSid: 'SM55be061fd3cb45e285b50ce0a0aac963',
        conversationSid: 'CH4f86e80e5052470997c9367239482569',
      },
    ]);
  });

  it('carries ErrorCode through when Twilio sends one (the 21610 path depends on it)', async () => {
    const receipts = recordingReceipts();
    const { app } = makeWebhookHarness({ groupReceipts: receipts });

    await signedTwilioPost(app, PATH, {
      ...DELIVERY_PARAMS,
      Status: 'failed',
      ErrorCode: '21610',
    });

    expect(receipts.calls[0]).toMatchObject({ status: 'failed', errorCode: '21610' });
  });

  it('forwards onMessageAdded to the cross-check seam VERBATIM - the Source filter is S6 logic', async () => {
    const crossCheck = recordingCrossCheck();
    const { app } = makeWebhookHarness({ groupCrossCheck: crossCheck });

    const res = await signedTwilioPost(app, PATH, MESSAGE_ADDED_PARAMS);

    expect(res.status).toBe(200);
    expect(crossCheck.events).toEqual([
      {
        messageSid: 'IMcc4a2eb90c7243e6b954a6829c7f28fc',
        conversationSid: 'CH4f86e80e5052470997c9367239482569',
        participantSid: 'MB01436d2e7c2d4fe885551e823d81ebb9',
        author: '+16174707727',
        source: 'SMS',
        dateCreated: '2026-08-11T13:03:28.879Z',
        body: 'Addendum inbound test TWO, from the 617 number.',
      },
    ]);
  });

  it('an API-sourced onMessageAdded still reaches the seam - counting it is the cross-check job', async () => {
    const crossCheck = recordingCrossCheck();
    const { app } = makeWebhookHarness({ groupCrossCheck: crossCheck });
    await signedTwilioPost(app, PATH, { ...MESSAGE_ADDED_PARAMS, Source: 'API' });
    expect(crossCheck.events[0]?.source).toBe('API');
  });

  it('says so, once, when onMessageAdded arrives with no cross-check wired (not a silent no-op)', async () => {
    const { app, capture } = makeWebhookHarness();
    const res = await signedTwilioPost(app, PATH, MESSAGE_ADDED_PARAMS);
    expect(res.status).toBe(200);
    expect(capture.lines.some((l) => l['event'] === 'group_crosscheck_not_wired')).toBe(true);
  });

  it('ACKS an unrecognized EventType with a WARN + counter, never a 500 that Twilio would retry forever', async () => {
    const { app, capture } = makeWebhookHarness();
    const res = await signedTwilioPost(app, PATH, {
      EventType: 'onConversationStateUpdated',
      ConversationSid: 'CHx',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ignored: true });
    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'conversations_event_unrecognized'),
    ).toBe(true);
  });

  it('ACKS 200 when the handler THROWS, and ERRORs so the alarm sees it', async () => {
    const { app, capture } = makeWebhookHarness({
      groupReceipts: {
        async applyReceipt() {
          throw new Error('dynamo is having a day');
        },
        async drainParked() {
          return 0;
        },
      },
    });
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(capture.atLevel(50).some((l) => l['event'] === 'conversations_webhook_failed')).toBe(true);
  });

  it('an unknown IMxx is a normal 200 outcome, never a 5xx', async () => {
    // No message seeded anywhere - the real pipeline parks it and acks.
    const { app } = makeWebhookHarness({ groupReceiptRetryDelayMs: 0 });
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: 'parked' });
  });
});

describe('POST /webhooks/twilio/conversations - signature validation', () => {
  it('rejects a request with NO X-Twilio-Signature', async () => {
    const receipts = recordingReceipts();
    const { app } = makeWebhookHarness({ groupReceipts: receipts });
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS, { omitSignature: true });
    expect(res.status).toBe(403);
    expect(receipts.calls).toEqual([]);
  });

  it('rejects a TAMPERED signature', async () => {
    const receipts = recordingReceipts();
    const { app } = makeWebhookHarness({ groupReceipts: receipts });
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS, { tamper: true });
    expect(res.status).toBe(403);
    expect(receipts.calls).toEqual([]);
  });

  it('rejects a signature computed for a DIFFERENT URL', async () => {
    const { app } = makeWebhookHarness();
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS, {
      signatureBaseUrl: 'https://attacker.example',
    });
    expect(res.status).toBe(403);
  });

  it('uses the STANDARD Twilio scheme, not the events sink shared secret', async () => {
    // The shared-secret scheme accepts an Authorization header and no signature.
    // If this route had inherited it, the request below would be accepted.
    const { app } = makeWebhookHarness();
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS, { omitSignature: true });
    expect(res.status).toBe(403);
  });
});

describe('mount order', () => {
  it('is owned by the conversations router, NOT swallowed by the /twilio messaging prefix', async () => {
    const receipts = recordingReceipts();
    const { app } = makeWebhookHarness({ groupReceipts: receipts });
    const res = await signedTwilioPost(app, PATH, DELIVERY_PARAMS);
    // A swallowed mount 404s here (the messaging router has no
    // /conversations path and its own 404 seam answers).
    expect(res.status).toBe(200);
    expect(receipts.calls).toHaveLength(1);
  });

  it('leaves the messaging webhook paths exactly where they were', async () => {
    const { app } = makeWebhookHarness();
    const res = await signedTwilioPost(app, '/webhooks/twilio/status', {
      MessageSid: 'SMunknown-status-probe',
      MessageStatus: 'delivered',
    });
    expect(res.status).toBe(200);
  });
});
