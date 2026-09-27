// retry-send-window D3a + D14 (plan Task 10): decideOneToOneRetry, the
// one-to-one 30003 retry decision the status webhook makes BEFORE it writes
// the failure. Pure over injected reads and an injected clock (spec D13) - no
// harness, no DynamoDB. Every branch, and the order between them.
import { describe, expect, it } from 'vitest';
import { MAX_SEND_RETRY_ATTEMPTS, resolveSendRetryBackoffMs } from '../src/jobs/retrySend.js';
import { RETRY_JOB_GRACE_MS, RETRY_SEND_WINDOW_MS } from '../src/lib/retrySendWindow.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import {
  decideOneToOneRetry,
  type OneToOneRetryDecision,
  type OneToOneRetryDeclineReason,
} from '../src/services/oneToOneRetryDecision.js';
import { SEND_REFUSAL_CASES } from './helpers/sendRefusalCases.js';

const NOW = Date.parse('2026-09-25T15:00:00.000Z');
const MIN = 60_000;
const PHONE = '+15550100001';
const iso = (ms: number): string => new Date(ms).toISOString();

/** A one-to-one outbound that just failed: sent 30 seconds before NOW. */
function failed(over: Partial<MessageItem> = {}): MessageItem {
  const providerTs = over.provider_ts ?? iso(NOW - 30_000);
  return {
    conversationId: 'conv-1',
    tsMsgId: `${providerTs}#SMfail01`,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    provider_sid: 'SMfail01',
    provider_ts: providerTs,
    delivery_status: 'sent',
    created_at: providerTs,
    ...over,
  };
}

function thread(over: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: 'conv-1',
    participant_phone: PHONE,
    status: 'open',
    last_activity_at: iso(NOW),
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: iso(NOW - 60 * MIN),
    ...over,
  };
}

function contact(over: Partial<ContactItem> = {}): ContactItem {
  return {
    contactId: 'c-tenant',
    type: 'tenant',
    phone: PHONE,
    consent_method: 'verbal_in_person',
    ...over,
  };
}

interface Reads {
  /** The conversation read's answer; 'throw' makes it throw. Omitted: thread(). */
  conversation?: ConversationItem | undefined | 'throw';
  /** findByPhone's answer; 'throw' makes it throw. Omitted: no contact. */
  phoneContact?: ContactItem | 'throw';
  /** getById's answers, by contactId. */
  byId?: Record<string, ContactItem>;
  /** getById throws. */
  byIdThrows?: boolean;
  /** config.smsSendingEnabled. Omitted: true. */
  smsSendingEnabled?: boolean;
}

function decide(message: MessageItem, reads: Reads = {}): Promise<OneToOneRetryDecision> {
  const conversations: Pick<ConversationsRepo, 'getById'> = {
    async getById() {
      if (!('conversation' in reads)) return thread();
      const c = reads.conversation;
      if (c === 'throw') throw new Error('conversation read exploded');
      return c;
    },
  };
  const contacts: Pick<ContactsRepo, 'findByPhone' | 'getById'> = {
    async findByPhone() {
      const c = reads.phoneContact;
      if (c === 'throw') throw new Error('contact read exploded');
      return c;
    },
    async getById(contactId: string) {
      if (reads.byIdThrows === true) throw new Error('recipient read exploded');
      return reads.byId?.[contactId];
    },
  };
  return decideOneToOneRetry({
    message,
    conversations,
    contacts,
    smsSendingEnabled: reads.smsSendingEnabled ?? true,
    nowMs: NOW,
  });
}

const retryAt = (attempt: number): OneToOneRetryDecision => ({
  kind: 'retry',
  attempt,
  runAt: new Date(NOW + resolveSendRetryBackoffMs(attempt)),
});
const declined = (
  reason: OneToOneRetryDeclineReason,
  level: 'warn' | 'error',
): OneToOneRetryDecision => ({ kind: 'decline', reason, level });

// The send path's refusals, judged as the retry will be SENT (D14): with the
// ORIGINAL's automated flag (absent = automated) and its recorded recipient.
const REFUSALS: {
  name: string;
  message: MessageItem;
  reads: Reads;
  reason: OneToOneRetryDeclineReason;
}[] = [
  {
    name: 'the SMS kill switch is off',
    message: failed(),
    reads: { smsSendingEnabled: false },
    reason: 'sms_sending_disabled',
  },
  {
    name: 'the conversation is opted out',
    message: failed(),
    reads: { conversation: thread({ sms_opt_out: true }) },
    reason: 'contact_opted_out',
  },
  {
    name: 'the phone-matched contact is opted out',
    message: failed(),
    reads: { phoneContact: contact({ sms_opt_out: true }) },
    reason: 'contact_opted_out',
  },
  {
    name: 'the recorded recipient is opted out',
    message: failed({ automated: false, recipient_contact_id: 'c-real' }),
    reads: {
      phoneContact: contact(),
      byId: { 'c-real': contact({ contactId: 'c-real', sms_opt_out: true }) },
    },
    reason: 'contact_opted_out',
  },
  {
    name: 'the recorded recipient is soft-deleted',
    message: failed({ automated: false, recipient_contact_id: 'c-real' }),
    reads: {
      phoneContact: contact(),
      byId: { 'c-real': contact({ contactId: 'c-real', deleted_at: '2026-09-01T00:00:00.000Z' }) },
    },
    reason: 'contact_deleted',
  },
  {
    name: 'an AUTOMATED original sits on a manual-mode thread',
    message: failed({ automated: true }),
    reads: { conversation: thread({ ai_mode: 'manual' }) },
    reason: 'manual_mode',
  },
  {
    name: 'a row with NO automated flag (pre-deploy = automated) sits on a manual-mode thread',
    message: failed(),
    reads: { conversation: thread({ ai_mode: 'manual' }) },
    reason: 'manual_mode',
  },
  {
    name: "a PERSON'S original went to a contact with no recorded consent",
    message: failed({ automated: false }),
    reads: { phoneContact: contact({ consent_method: undefined }) },
    reason: 'contact_no_consent',
  },
];

describe('decideOneToOneRetry (retry-send-window D3a + D14)', () => {
  it('schedules attempt 1 at now + the resolved backoff when nothing refuses, with no fail-open flag', async () => {
    const d = await decide(failed());
    expect(d).toEqual(retryAt(1));
    expect(d).not.toHaveProperty('failOpen');
  });

  it('numbers the attempt from the row retry_attempt and backs off for THAT attempt', async () => {
    expect(await decide(failed({ retry_attempt: 2, retry_window_start: iso(NOW - 2 * MIN) }))).toEqual(
      retryAt(3),
    );
  });

  it('declines conversation_missing at WARN when the conversation row is gone (the level it logs at today)', async () => {
    expect(await decide(failed(), { conversation: undefined })).toEqual(
      declined('conversation_missing', 'warn'),
    );
  });

  it('declines a native group text at WARN (D11), ahead of the kill switch and the cap', async () => {
    const d = await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS }), {
      conversation: thread({ type: 'group_text', participant_phone: undefined, ai_mode: 'manual' }),
      smsSendingEnabled: false,
    });
    expect(d).toEqual(declined('group_text', 'warn'));
  });

  it('declines a relay_group or a phone-less thread as not_one_to_one at WARN', async () => {
    expect(await decide(failed(), { conversation: thread({ type: 'relay_group' }) })).toEqual(
      declined('not_one_to_one', 'warn'),
    );
    expect(await decide(failed(), { conversation: thread({ participant_phone: undefined }) })).toEqual(
      declined('not_one_to_one', 'warn'),
    );
  });

  it.each(REFUSALS)('declines at WARN when $name ($reason)', async ({ message, reads, reason }) => {
    expect(await decide(message, reads)).toEqual(declined(reason, 'warn'));
  });

  it("retries a PERSON'S original on a manual-mode (breaker-tripped) thread: manual mode refuses only automated sends (D14)", async () => {
    const d = await decide(failed({ automated: false }), {
      conversation: thread({ ai_mode: 'manual' }),
      phoneContact: contact(),
    });
    expect(d).toEqual(retryAt(1));
  });

  it("retries an AUTOMATED original to a no-consent contact: the consent gate judges a person's send only", async () => {
    const d = await decide(failed({ automated: true }), {
      phoneContact: contact({ consent_method: undefined }),
    });
    expect(d).toEqual(retryAt(1));
  });

  it('judges the RECORDED recipient: a soft-deleted duplicate on the same phone does not decline it (share-skip-fix I8)', async () => {
    const d = await decide(failed({ automated: false, recipient_contact_id: 'c-real' }), {
      phoneContact: contact({
        contactId: 'c-dup',
        deleted_at: '2026-09-01T00:00:00.000Z',
        consent_method: undefined,
      }),
      byId: { 'c-real': contact({ contactId: 'c-real' }) },
    });
    expect(d).toEqual(retryAt(1));
  });

  it('a recorded recipient id that resolves to nothing falls back to the phone-matched contact', async () => {
    const message = failed({ automated: false, recipient_contact_id: 'c-gone' });
    // Judged in the recipient's place, a no-consent phone contact declines it...
    expect(await decide(message, { phoneContact: contact({ consent_method: undefined }) })).toEqual(
      declined('contact_no_consent', 'warn'),
    );
    // ...and a consenting one lets it through.
    expect(await decide(message, { phoneContact: contact() })).toEqual(retryAt(1));
  });

  it('declines cap_exhausted at ERROR once retry_attempt reaches MAX_SEND_RETRY_ATTEMPTS', async () => {
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS, retry_window_start: iso(NOW - MIN) })),
    ).toEqual(declined('cap_exhausted', 'error'));
  });

  it('declines window_closed at ERROR once now + backoff + grace passes origin + 15 minutes, with THAT attempt backoff', async () => {
    // Attempt 3: the latest origin that still fits is now + backoff(3) + grace - window.
    const latestFit = NOW + resolveSendRetryBackoffMs(3) + RETRY_JOB_GRACE_MS - RETRY_SEND_WINDOW_MS;
    expect(await decide(failed({ retry_attempt: 2, retry_window_start: iso(latestFit) }))).toEqual(
      retryAt(3),
    );
    expect(await decide(failed({ retry_attempt: 2, retry_window_start: iso(latestFit - 1) }))).toEqual(
      declined('window_closed', 'error'),
    );
    // Attempt 1 of a text first sent 20 minutes ago.
    expect(await decide(failed({ provider_ts: iso(NOW - 20 * MIN) }))).toEqual(
      declined('window_closed', 'error'),
    );
  });

  it('measures from the CHAIN origin: retry_window_start wins over the row own provider_ts (D2)', async () => {
    // A retry row sent 30s ago whose chain began 14 minutes ago: attempt 2 no
    // longer fits, although it would from the row's own send time.
    expect(await decide(failed({ retry_attempt: 1, retry_window_start: iso(NOW - 14 * MIN) }))).toEqual(
      declined('window_closed', 'error'),
    );
  });

  it('ORDER: a send-path refusal outranks the cap, and the cap outranks the window', async () => {
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS }), {
        conversation: thread({ sms_opt_out: true }),
      }),
    ).toEqual(declined('contact_opted_out', 'warn'));
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS, provider_ts: iso(NOW - 20 * MIN) })),
    ).toEqual(declined('cap_exhausted', 'error'));
  });

  it('a THROWN conversation read fails OPEN (read_failed) - and the cap and the window still apply', async () => {
    expect(await decide(failed(), { conversation: 'throw' })).toEqual({
      ...retryAt(1),
      failOpen: 'read_failed',
      readError: expect.any(Error),
    });
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS }), { conversation: 'throw' }),
    ).toEqual(declined('cap_exhausted', 'error'));
    expect(
      await decide(failed({ provider_ts: iso(NOW - 20 * MIN) }), { conversation: 'throw' }),
    ).toEqual(declined('window_closed', 'error'));
  });

  it('a THROWN contact read (phone lookup or recorded recipient) fails OPEN after the conversation-level checks', async () => {
    expect(await decide(failed(), { phoneContact: 'throw' })).toEqual({
      ...retryAt(1),
      failOpen: 'read_failed',
      readError: expect.any(Error),
    });
    expect(
      await decide(failed({ automated: false, recipient_contact_id: 'c-real' }), {
        phoneContact: contact(),
        byIdThrows: true,
      }),
    ).toEqual({ ...retryAt(1), failOpen: 'read_failed', readError: expect.any(Error) });
    // The conversation read succeeded, so group_text still declines first.
    expect(
      await decide(failed(), {
        conversation: thread({ type: 'group_text', participant_phone: undefined }),
        phoneContact: 'throw',
      }),
    ).toEqual(declined('group_text', 'warn'));
  });

  it('a missing or unparseable origin fails OPEN (no_origin) and is never re-derived from provider_ts (D5)', async () => {
    const none = failed();
    delete (none as { provider_ts?: string }).provider_ts;
    expect(await decide(none)).toEqual({ ...retryAt(1), failOpen: 'no_origin' });
    // An unparseable retry_window_start is NOT replaced by the row's own (old)
    // provider_ts - that would restart the window.
    expect(
      await decide(failed({ retry_window_start: 'not-a-date', provider_ts: iso(NOW - 20 * MIN) })),
    ).toEqual({ ...retryAt(1), failOpen: 'no_origin' });
  });

  it('reports read_failed when a read throws AND the origin is missing', async () => {
    const none = failed();
    delete (none as { provider_ts?: string }).provider_ts;
    expect(await decide(none, { conversation: 'throw' })).toEqual({
      ...retryAt(1),
      failOpen: 'read_failed',
      readError: expect.any(Error),
    });
  });

  it("Review Focus 4: a text a staff member re-sent with the manual Retry is retried from a FRESH window, as a person's send, even on a manual-mode thread", async () => {
    // The manual Retry route's row: retry_of set, no retry_attempt and no
    // retry_window_start (spec D2: a human chose to send now), automated false.
    const manualRetry = failed({ retry_of: '2026-09-25T09:00:00.000Z#SMorig01', automated: false });
    expect(
      await decide(manualRetry, {
        conversation: thread({ ai_mode: 'manual' }),
        phoneContact: contact(),
      }),
    ).toEqual(retryAt(1));
  });

  // retry-send-window D3a: the SAME table the preview/send-path parity test runs
  // (test/sendMessage.test.ts), through the decision: every row the send path
  // refuses, the decision declines with the same code; every row it sends, the
  // decision retries.
  it.each(SEND_REFUSAL_CASES)('parity with the send path: $name', async (c) => {
    const message = failed({
      automated: c.automated,
      ...(c.recipient !== undefined && { recipient_contact_id: c.recipient.contactId }),
    });
    const verdict = await decide(message, {
      conversation: thread({
        ai_mode: c.conversation.ai_mode,
        ...(c.conversation.sms_opt_out !== undefined && { sms_opt_out: c.conversation.sms_opt_out }),
      }),
      ...(c.phoneContact !== undefined && { phoneContact: c.phoneContact }),
      ...(c.recipient !== undefined && { byId: { [c.recipient.contactId]: c.recipient } }),
      smsSendingEnabled: c.smsSendingEnabled,
    });
    if (c.expected === undefined) expect(verdict).toEqual(retryAt(1));
    else expect(verdict).toEqual(declined(c.expected, 'warn'));
  });
});
