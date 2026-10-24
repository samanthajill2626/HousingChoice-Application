// Unit tests for the one-time last_reached_out_at backfill (spec
// docs/superpowers/specs/2026-10-23-today-checklist-design.md, sections 7.2,
// 7.3 and 7.5; plan ruling PR38), in two halves. No database.
//
// 1. The PLANNER. planThreadPage classifies one page of a thread's window rows
//    into per-category counts and folds the latest instant per contact. Every
//    category spec 7.5 + PR38 names has a counted case and every skipped kind a
//    skipped case; each case pins EVERY non-zero counter (nonZero below), so a
//    row can only land where the case says it does.
// 2. The RUNNER, through a fake `doc` that models the window Query's key
//    condition (tsMsgId >= the floor), its outbound FilterExpression and
//    paging, plus the tourReminders Scan, and a fake contacts repo that models
//    the forward-only conditional touch.
import { describe, expect, it } from 'vitest';
import { QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  COUNTED_KINDS,
  KEY_FLOOR_MARGIN_MS,
  NUDGE_MESSAGE_IDS,
  REMINDER_TIME_MATCH_MS,
  SKIP_KINDS,
  WINDOW_MS,
  backfillLastReachedOut,
  indexReminderSends,
  newPlan,
  nudgeBodySet,
  planThreadPage,
  reportBackfillRun,
  windowBounds,
  type ReachedOutContext,
  type ReachedOutPlan,
  type ReachedOutThread,
} from '../scripts/backfill-last-reached-out.js';
import { TEAM_SENDER_KEY } from '../src/jobs/relayFanOut.js';
import type { HeardFromLookup } from '../src/lib/heardFrom.js';
import { createLogger } from '../src/lib/logger.js';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { relayMemberKey, type MessageItem, type RelayRecipientDelivery } from '../src/repos/messagesRepo.js';
import { groupMemberKey } from '../src/services/groupMembers.js';
import { SYSTEM_SENDER_KEY } from '../src/services/relayAnnouncements.js';
import { createLogCapture } from './helpers/logCapture.js';

// ---------------------------------------------------------------------------
// Half 1 - the planner
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-24T12:00:00.000Z');
/** windowBounds(NOW).windowStart - pinned by the first case. */
const WINDOW_START = '2026-10-10T12:00:00.000Z';
/** lib/import/apply.ts IMPORT_SOURCE (a literal: importing apply.ts pulls the whole importer). */
const QUO = 'quo-airtable-import';

const PHONES = new Map([
  ['+15550100004', 'c-d'],
  ['+15550100005', 'c-p'],
]);
const EMAILS = new Map([['e@x.test', 'c-e']]);

/** A SYNCHRONOUS fixture lookup (the rule accepts either kind). */
const lookup: HeardFromLookup = {
  byPhone: (e164) => {
    const contactId = PHONES.get(e164);
    return contactId === undefined ? undefined : { contactId };
  },
  byEmail: (address) => {
    const contactId = EMAILS.get(address);
    return contactId === undefined ? undefined : { contactId };
  },
};

function ctx(over: Partial<ReachedOutContext> = {}): ReachedOutContext {
  return { lookup, windowStart: WINDOW_START, nudgeBodies: nudgeBodySet(), reminderSends: new Map(), ...over };
}

/** A staff one-to-one text, the shape services/sendMessage.ts appends. */
const text = (tsMsgId: string, over: Partial<MessageItem> = {}) =>
  ({
    conversationId: 'one',
    tsMsgId,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    delivery_status: 'sent',
    automated: false,
    body: 'Checking in about the place on Elm.',
    ...over,
  }) as MessageItem;

/** A staff email, the shape services/sendEmailMessage.ts appends (no automated flag, no recipient_contact_id). */
const email = (tsMsgId: string, over: Partial<MessageItem> = {}) =>
  ({
    conversationId: 'one',
    tsMsgId,
    type: 'email',
    direction: 'outbound',
    author: 'teammate',
    delivery_status: 'queued',
    body: 'Email body.',
    ...over,
  }) as MessageItem;

/** An outbound call, the shape services/originateCall.ts appends ('ringing' until the press-1 gate). */
const call = (tsMsgId: string, over: Partial<MessageItem> = {}) =>
  ({
    conversationId: 'one',
    tsMsgId,
    type: 'call',
    direction: 'outbound',
    author: 'teammate',
    delivery_status: 'delivered',
    call_status: 'ringing',
    ...over,
  }) as MessageItem;

/** A multi-party post: ONE row, one delivery slot per member key (the relay team
 *  send in routes/api.ts, services/groupSend.ts, services/relayAnnouncements.ts). */
const post = (tsMsgId: string, slots: Record<string, RelayRecipientDelivery>, over: Partial<MessageItem> = {}) =>
  ({
    conversationId: 'grp',
    tsMsgId,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    delivery_status: 'queued',
    relay_sender_key: TEAM_SENDER_KEY,
    body: 'Team post.',
    delivery_recipients: slots,
    ...over,
  }) as MessageItem;

const slot = (over: Partial<RelayRecipientDelivery> = {}): RelayRecipientDelivery => ({ status: 'queued', ...over });

const ONE: ReachedOutThread = {
  conversationId: 'one',
  type: 'tenant_1to1',
  participants: [{ contactId: 'c-a', phone: '+15550100001' }],
};
const RELAY: ReachedOutThread = {
  conversationId: 'grp',
  type: 'relay_group',
  participants: [
    { contactId: 'c-b', phone: '+15550100002' },
    { contactId: 'c-c', phone: '+15550100003' },
    { contactId: '', phone: '+15550100004' },
  ],
};
const GROUP: ReachedOutThread = {
  conversationId: 'gt',
  type: 'group_text',
  participants: [
    { contactId: 'c-g', phone: '+15550100008' },
    { contactId: '', phone: '+15550100004' },
    { contactId: '', phone: '+15550100009' },
  ],
};

async function planRows(
  thread: ReachedOutThread,
  rows: readonly MessageItem[],
  c: ReachedOutContext = ctx(),
): Promise<ReachedOutPlan> {
  const plan = newPlan();
  await planThreadPage(plan, thread, rows, c);
  return plan;
}

/** Every counter that is not zero, counted and skipped together (their keys are disjoint). */
function nonZero(plan: ReachedOutPlan): Record<string, number> {
  return Object.fromEntries(
    [...Object.entries(plan.counted), ...Object.entries(plan.rowsSkipped)].filter(([, n]) => n > 0),
  );
}

describe('the window and the plan shape', () => {
  it('is the Follow up lookback (14 days) with a one-hour key floor margin', () => {
    expect(WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(KEY_FLOOR_MARGIN_MS).toBe(60 * 60 * 1000);
    expect(REMINDER_TIME_MATCH_MS).toBe(10 * 60 * 1000);
    expect(windowBounds(NOW)).toEqual({
      windowStart: WINDOW_START,
      keyFloor: '2026-10-10T11:00:00.000Z',
    });
  });

  it('newPlan zeroes every category, in the declared order', () => {
    const plan = newPlan();
    expect(Object.keys(plan.counted)).toEqual([...COUNTED_KINDS]);
    expect(Object.keys(plan.rowsSkipped)).toEqual([...SKIP_KINDS]);
    expect(nonZero(plan)).toEqual({});
    expect(plan.latest.size).toBe(0);
  });
});

describe('planThreadPage - one-to-one texts (spec 7.5)', () => {
  it('counts a staff sms and mms - automated false or absent - for the thread contact at the row providerTs', async () => {
    const legacy = text('2026-10-21T10:00:00Z#SM2', { type: 'mms' });
    delete legacy.automated;
    const plan = await planRows(ONE, [text('2026-10-20T10:00:00.000Z#SM1'), legacy]);
    expect(nonZero(plan)).toEqual({ text: 2 });
    // The un-normalized key prefix is folded in canonical form.
    expect([...plan.latest]).toEqual([['c-a', '2026-10-21T10:00:00.000Z']]);
    expect(plan.messagesRead).toBe(2);
  });

  it('skips automated sends, shares (and a Retry of one) and automatic retries; a staff Retry counts', async () => {
    const plan = await planRows(ONE, [
      text('2026-10-20T10:00:00.000Z#A', { automated: true }),
      text('2026-10-20T11:00:00.000Z#S', { broadcast_id: 'b-1' }),
      text('2026-10-20T12:00:00.000Z#SR', { broadcast_id: 'b-1', retry_of: '2026-10-20T11:00:00.000Z#S' }),
      text('2026-10-20T13:00:00.000Z#R1', {
        retry_of: '2026-10-20T12:30:00.000Z#F',
        retry_attempt: 1,
        retry_window_start: '2026-10-20T12:30:00.000Z',
      }),
      text('2026-10-20T14:00:00.000Z#R2', { retry_window_start: '2026-10-20T12:30:00.000Z' }),
      // The staff Retry button: retry_of (and retry_root) alone.
      text('2026-10-20T15:00:00.000Z#M', {
        retry_of: '2026-10-20T14:30:00.000Z#F2',
        retry_root: '2026-10-20T14:30:00.000Z#F2',
      }),
    ]);
    expect(nonZero(plan)).toEqual({ automated: 1, share: 2, machine_retry: 2, text: 1 });
    expect([...plan.latest]).toEqual([['c-a', '2026-10-20T15:00:00.000Z']]);
    // PR105: the staff Retry's retried row and root (both #F2) are not among
    // the window rows here, so it counts and is reported as residue.
    expect(plan.retryOriginOutsideWindow).toBe(1);
  });

  // PR105 (spec r8 7.5; the live W2 gate of PR104, mirrored for history): a
  // row marked system_copy (a Send now, or a Retry of automated or
  // system-copy copy) never counts. A staff Retry (retry_of) is excluded when
  // its retried row OR its chain root (retry_root) is among this thread's
  // window rows and is automated, system copy, or a Send-now body. A Retry
  // whose retried row and root are BOTH outside the window cannot be judged:
  // it counts, reported as residue.
  it('PR105: system_copy rows never count; a staff Retry is excluded when its retried row or chain root in the window is system copy; otherwise it counts', async () => {
    const nudge = MESSAGE_CATALOG['nudge.receipt_check'].default;
    const plan = await planRows(ONE, [
      // An automated text and its staff Retry.
      text('2026-10-20T10:00:00.000Z#AF', { automated: true, body: 'Sorry we missed your call.' }),
      text('2026-10-20T10:05:00.000Z#AR', { retry_of: '2026-10-20T10:00:00.000Z#AF', body: 'Sorry we missed your call.' }),
      // A Send-now row from before the marker (the body rule) and its Retry.
      text('2026-10-20T11:00:00.000Z#NF', { body: nudge }),
      text('2026-10-20T11:05:00.000Z#NR', { retry_of: '2026-10-20T11:00:00.000Z#NF', body: nudge }),
      // A marked Send-now row (PR104): skipped itself, and so is its Retry.
      text('2026-10-20T11:30:00.000Z#XF', { system_copy: true, body: 'Your tour is tomorrow at 10.' }),
      text('2026-10-20T11:35:00.000Z#XR', { retry_of: '2026-10-20T11:30:00.000Z#XF', body: 'Your tour is tomorrow at 10.' }),
      // A Retry of a Retry from before the marker: its retried row (AR2) is a
      // plain manual retry, but its chain ROOT (AF2) is automated - excluded.
      text('2026-10-20T11:40:00.000Z#AF2', { automated: true, body: 'Welcome!' }),
      text('2026-10-20T11:45:00.000Z#AR2', {
        retry_of: '2026-10-20T11:40:00.000Z#AF2',
        retry_root: '2026-10-20T11:40:00.000Z#AF2',
        body: 'Welcome!',
      }),
      text('2026-10-20T11:50:00.000Z#AR3', {
        retry_of: '2026-10-20T11:45:00.000Z#AR2',
        retry_root: '2026-10-20T11:40:00.000Z#AF2',
        body: 'Welcome!',
      }),
      // A staff text and its Retry count.
      text('2026-10-20T12:00:00.000Z#SF'),
      text('2026-10-20T12:05:00.000Z#SR', { retry_of: '2026-10-20T12:00:00.000Z#SF', retry_root: '2026-10-20T12:00:00.000Z#SF' }),
      // The retried row is in the window (a staff text) though the root is
      // not: judged by the retried row - counts, and it is NOT residue.
      text('2026-10-20T12:10:00.000Z#SR2', { retry_of: '2026-10-20T12:00:00.000Z#SF', retry_root: '2026-10-01T08:00:00.000Z#GONE' }),
      // Retried row and root both older than the window: counts, as residue.
      text('2026-10-20T13:05:00.000Z#OR', { retry_of: '2026-10-01T09:00:00.000Z#OLD', retry_root: '2026-09-30T09:00:00.000Z#OLDER' }),
    ]);
    expect(nonZero(plan)).toEqual({
      automated: 2,
      excluded_nudge_body: 1,
      system_copy: 1,
      retry_of_system_copy: 5,
      text: 4,
    });
    expect(plan.retryOriginOutsideWindow).toBe(1);
    expect([...plan.latest]).toEqual([['c-a', '2026-10-20T13:05:00.000Z']]);
  });

  it('PR91 / PR105: the retried row is judged whether it sits on an earlier page or later in the same page', async () => {
    const plan = newPlan();
    await planThreadPage(plan, ONE, [text('2026-10-20T10:00:00.000Z#AF', { automated: true })], ctx());
    await planThreadPage(
      plan,
      ONE,
      [
        text('2026-10-20T11:05:00.000Z#BR', { retry_of: '2026-10-20T11:00:00.000Z#BF' }),
        text('2026-10-20T11:00:00.000Z#BF', { automated: true }),
        text('2026-10-20T10:05:00.000Z#AR', { retry_of: '2026-10-20T10:00:00.000Z#AF' }),
      ],
      ctx(),
    );
    expect(nonZero(plan)).toEqual({ automated: 2, retry_of_system_copy: 2 });
    expect(plan.retryOriginOutsideWindow).toBe(0);
    expect(plan.latest.size).toBe(0);
  });

  it('names the row recipient_contact_id before the thread contact', async () => {
    const plan = await planRows(ONE, [text('2026-10-20T10:00:00.000Z#H', { recipient_contact_id: 'c-held' })]);
    expect(nonZero(plan)).toEqual({ text: 1 });
    expect([...plan.latest]).toEqual([['c-held', '2026-10-20T10:00:00.000Z']]);
  });

  it('without one, the thread contact: participants, then the participant phone, then the participant email', async () => {
    const rows = [text('2026-10-20T10:00:00.000Z#T')];
    const byPhone = await planRows(
      {
        conversationId: 'np1',
        type: 'unknown_1to1',
        participants: [{ contactId: '', phone: '' }],
        participant_phone: '+15550100005',
        participant_email: 'e@x.test',
      },
      rows,
    );
    expect([...byPhone.latest.keys()]).toEqual(['c-p']);
    const byEmail = await planRows(
      { conversationId: 'np2', type: 'partner_1to1', participant_phone: '+15550100999', participant_email: 'e@x.test' },
      rows,
    );
    expect([...byEmail.latest.keys()]).toEqual(['c-e']);
    const nobody = await planRows({ conversationId: 'np3', type: 'unknown_1to1', participant_phone: '+15550100999' }, rows);
    expect(nonZero(nobody)).toEqual({ no_recipient: 1 });
    expect(nobody.latest.size).toBe(0);
  });
});

describe('planThreadPage - emails and calls (spec 7.5, PR38)', () => {
  it('counts an email once it left for SES; failed, or still queued without an SES id, does not', async () => {
    const plan = await planRows(ONE, [
      email('2026-10-20T10:00:00.000Z#e1', { delivery_status: 'sent' }),
      email('2026-10-20T10:01:00.000Z#e2', { delivery_status: 'delivered', ses_message_id: 'ses-2' }),
      // A bounce: emailEvents.ts maps every Bounce to undelivered.
      email('2026-10-20T10:02:00.000Z#e3', { delivery_status: 'undelivered' }),
      // SES took it but the queued->sent write failed (sendEmailMessage.ts step b).
      email('2026-10-20T10:03:00.000Z#e4', { delivery_status: 'queued', ses_message_id: 'ses-4' }),
      // The adapter threw: it never reached SES.
      email('2026-10-20T10:04:00.000Z#e5', { delivery_status: 'failed' }),
      // failed is tested FIRST, whatever else the row carries.
      email('2026-10-20T10:05:00.000Z#e6', { delivery_status: 'failed', ses_message_id: 'ses-6' }),
      // Persisted queued, nothing after it.
      email('2026-10-20T10:06:00.000Z#e7', { delivery_status: 'queued' }),
    ]);
    expect(nonZero(plan)).toEqual({ email: 4, email_failed: 2, email_queued: 1 });
    expect(plan.latest.get('c-a')).toBe('2026-10-20T10:03:00.000Z');
  });

  it('counts a call once the contact leg was dialed - at answered_at, else the row providerTs - and skips a ringing-only one', async () => {
    const answered = await planRows(ONE, [
      call('2026-10-20T10:00:00.000Z#CA1', {
        call_status: 'completed',
        call_outcome: 'answered',
        answered_at: '2026-10-20T10:00:07Z',
      }),
    ]);
    expect(nonZero(answered)).toEqual({ call: 1 });
    expect(answered.latest.get('c-a')).toBe('2026-10-20T10:00:07.000Z');

    const outcomeOnly = await planRows(ONE, [
      call('2026-10-20T11:00:00.000Z#CA2', { call_status: 'no-answer', call_outcome: 'missed' }),
    ]);
    expect(nonZero(outcomeOnly)).toEqual({ call: 1 });
    expect(outcomeOnly.latest.get('c-a')).toBe('2026-10-20T11:00:00.000Z');

    // The staff cell never accepted: no answered_at, no call_outcome.
    const ringing = await planRows(ONE, [call('2026-10-20T12:00:00.000Z#CA3')]);
    expect(nonZero(ringing)).toEqual({ call_not_dialed: 1 });
    expect(ringing.latest.size).toBe(0);
  });
});

describe('planThreadPage - relay team posts (spec 7.5, PR38)', () => {
  it('counts each CONTACT member whose slot shows a sent leg, at slot.sentAt, whatever the slot status', async () => {
    const plan = await planRows(RELAY, [
      post('2026-10-21T08:00:00.000Z#team-1', {
        // Sent: a sid and a sent instant. The status can stay 'queued' after a successful send.
        [relayMemberKey({ contactId: 'c-b', phone: '+15550100002' })]: slot({ sid: 'SM-b', sentAt: '2026-10-21T08:00:05Z' }),
        // Never sent (suppressed): no sid.
        [relayMemberKey({ contactId: 'c-c', phone: '+15550100003' })]: slot({
          status: 'failed',
          errorCode: 'contact_opted_out',
        }),
        // A sid with no sent instant is not proof of a sent leg.
        'c-x': slot({ sid: 'SM-x' }),
        // A phone-only member: no contact to stamp.
        [relayMemberKey({ contactId: '', phone: '+15550100004' })]: slot({
          status: 'sent',
          sid: 'SM-p',
          sentAt: '2026-10-21T08:00:06.000Z',
        }),
      }),
    ]);
    expect(nonZero(plan)).toEqual({ relay_team_slot: 1, slot_not_sent: 2, relay_phone_slot: 1 });
    expect([...plan.latest]).toEqual([['c-b', '2026-10-21T08:00:05.000Z']]);
  });

  it('skips a relay 30003 retry row (relay_retry_of) and a staff row with no team sender key', async () => {
    const plan = await planRows(RELAY, [
      post(
        '2026-10-21T08:05:00.000Z#SM-r',
        { 'c-c': slot({ status: 'sent', sid: 'SM-r', sentAt: '2026-10-21T08:05:01.000Z' }) },
        { relay_retry_of: '2026-10-21T08:00:00.000Z#team-1', relay_retry_member_key: 'c-c' },
      ),
      call('2026-10-21T09:00:00.000Z#CA9', {
        conversationId: 'grp',
        call_outcome: 'answered',
        answered_at: '2026-10-21T09:00:05.000Z',
      }),
    ]);
    expect(nonZero(plan)).toEqual({ relay_retry: 1, group_other: 1 });
    expect(plan.latest.size).toBe(0);
  });
});

describe('planThreadPage - group-text posts (spec 7.5, PR38)', () => {
  it('counts every slot not excluded - roster first, then the phone lookup - at the row providerTs', async () => {
    const attempted = slot({ transportAggregationState: 'attempted' });
    const plan = await planRows(GROUP, [
      post(
        '2026-10-23T07:00:00.000Z#IM1',
        {
          [groupMemberKey('+15550100008')]: attempted, // roster contactId c-g
          [groupMemberKey('+15550100004')]: attempted, // roster contactId '' -> findByPhone c-d
          [groupMemberKey('+15550100009')]: attempted, // no contact anywhere
          // Suppressed at the seed (groupSend.ts 7a): never stamped, though it would resolve.
          [groupMemberKey('+15550100005')]: slot({
            status: 'failed',
            errorCode: 'contact_opted_out',
            transportAggregationState: 'excluded',
          }),
        },
        { conversationId: 'gt' },
      ),
      post('2026-10-23T08:00:00.000Z#IM2', { [groupMemberKey('+15550100008')]: attempted }, { conversationId: 'gt', author: 'ai' }),
    ]);
    expect(nonZero(plan)).toEqual({
      group_text_slot: 2,
      group_unresolved_slot: 1,
      group_excluded_slot: 1,
      not_teammate: 1,
    });
    expect([...plan.latest].sort()).toEqual([
      ['c-d', '2026-10-23T07:00:00.000Z'],
      ['c-g', '2026-10-23T07:00:00.000Z'],
    ]);
  });
});

describe('planThreadPage - staff-edited relay intros (PR38 body match)', () => {
  const INTRO = 'Hi all - this group is for the 12 Elm move.';
  const EDITED: ReachedOutThread = { ...RELAY, intro_body: INTRO };
  const system = (tsMsgId: string, body: string, slots: Record<string, RelayRecipientDelivery>) =>
    post(tsMsgId, slots, { author: 'system', relay_sender_key: SYSTEM_SENDER_KEY, body });

  it('counts the intro whose body IS the thread intro_body, per contact member with a sent leg, at slot.sentAt', async () => {
    const plan = await planRows(EDITED, [
      system('2026-10-19T09:00:00.000Z#system-1', INTRO, {
        'c-b': slot({
          status: 'sent',
          sid: 'SM-i1',
          sentAt: '2026-10-19T09:00:03.000Z',
          transportAggregationState: 'attempted',
        }),
        'c-c': slot({ status: 'failed', errorCode: 'contact_opted_out', transportAggregationState: 'excluded' }),
        'phone#+15550100004': slot({ status: 'sent', sid: 'SM-i3', sentAt: '2026-10-19T09:00:04.000Z' }),
      }),
    ]);
    expect(nonZero(plan)).toEqual({ edited_intro_slot: 1, slot_not_sent: 1, relay_phone_slot: 1 });
    expect([...plan.latest]).toEqual([['c-b', '2026-10-19T09:00:03.000Z']]);
  });

  it('every other system announcement is system_other: a member added on that thread, any intro on a thread with no intro_body', async () => {
    const sent = { 'c-b': slot({ status: 'sent', sid: 'SM-x', sentAt: '2026-10-19T10:00:01.000Z' }) };
    const added = await planRows(EDITED, [system('2026-10-19T10:00:00.000Z#system-2', 'Hey, adding Pat to the group.', sent)]);
    expect(nonZero(added)).toEqual({ system_other: 1 });
    // The default intro: composed from the catalog, the thread has no intro_body.
    const defaultIntro = await planRows(RELAY, [system('2026-10-19T11:00:00.000Z#system-3', INTRO, sent)]);
    expect(nonZero(defaultIntro)).toEqual({ system_other: 1 });
    expect(added.latest.size + defaultIntro.latest.size).toBe(0);
  });
});

describe('planThreadPage - tour reminder and nudge "Send now" rows (PR38 exclude by body)', () => {
  it('the nudge set is exactly the four nudge.* catalog defaults', () => {
    expect([...NUDGE_MESSAGE_IDS].sort()).toEqual(
      Object.keys(MESSAGE_CATALOG)
        .filter((id) => id.startsWith('nudge.'))
        .sort(),
    );
    expect(nudgeBodySet()).toEqual(new Set(NUDGE_MESSAGE_IDS.map((id) => MESSAGE_CATALOG[id].default)));
    expect(nudgeBodySet().size).toBe(4);
  });

  it('excludes a staff-path text whose body is a nudge default; the poll send stays automated', async () => {
    const bodies = NUDGE_MESSAGE_IDS.map((id) => MESSAGE_CATALOG[id].default);
    const plan = await planRows(ONE, [
      ...bodies.map((body, i) => text(`2026-10-20T1${i}:00:00.000Z#N${i}`, { body })),
      text('2026-10-20T15:00:00.000Z#NP', {
        body: MESSAGE_CATALOG['nudge.receipt_check'].default,
        automated: true,
      }),
    ]);
    expect(nonZero(plan)).toEqual({ excluded_nudge_body: 4, automated: 1 });
    expect(plan.latest.size).toBe(0);
  });

  it('excludes a text equal to an in-window reminder sentBody, and counts those within 10 minutes after its sentAt', async () => {
    const R1 = 'Reminder: your tour at 12 Elm is tomorrow at 10am.';
    const R2 = 'Reminder: your tour at 9 Oak is today at 2pm.';
    const reminderSends = indexReminderSends(
      [
        { sentAt: '2026-10-22T09:55:00.000Z', sentBody: R1 },
        { sentAt: '2026-10-15T09:00:00.000Z', sentBody: R2 },
      ],
      WINDOW_START,
    );
    const plan = await planRows(
      ONE,
      [
        text('2026-10-22T10:00:00.000Z#R1a', { body: R1 }), // 5 min after: time match
        text('2026-10-22T10:05:00.000Z#R1b', { body: R1 }), // exactly 10 min after: time match
        text('2026-10-22T10:05:00.001Z#R1c', { body: R1 }), // just over: body only
        text('2026-10-22T09:50:00.000Z#R1d', { body: R1 }), // before the reminder: body only
        text('2026-10-15T09:30:00.000Z#R2a', { body: R2 }), // 30 min after: body only
        text('2026-10-22T11:00:00.000Z#T', { body: 'Something else.' }),
      ],
      ctx({ reminderSends }),
    );
    expect(nonZero(plan)).toEqual({ excluded_reminder_body: 5, text: 1 });
    expect(plan.reminderBodyTimeMatched).toBe(2);
    expect([...plan.latest]).toEqual([['c-a', '2026-10-22T11:00:00.000Z']]);
  });

  it('indexReminderSends keeps in-window sends that carry a body, normalized, several per body', () => {
    const index = indexReminderSends(
      [
        { sentAt: '2026-10-22T09:55:00Z', sentBody: 'A' },
        { sentAt: '2026-10-23T09:55:00.000Z', sentBody: 'A' },
        { sentAt: '2026-10-01T09:55:00.000Z', sentBody: 'B' }, // before the window
        { sentAt: '2026-10-22T09:55:00.000Z' }, // claimed before sentBody existed
        { sentAt: 'garbage', sentBody: 'C' },
        { sentAt: WINDOW_START, sentBody: 'D' }, // the window start itself is inside
        { sentBody: 'E' }, // pending: never sent
      ],
      WINDOW_START,
    );
    expect([...index]).toEqual([
      ['A', ['2026-10-22T09:55:00.000Z', '2026-10-23T09:55:00.000Z']],
      ['D', [WINDOW_START]],
    ]);
  });
});

describe('planThreadPage - what never counts, and the window', () => {
  it('never counts a Quo import row, whatever its shape; imported_from alone is enough', async () => {
    const plan = await planRows(ONE, [
      // The importer's own shapes (lib/import/apply.ts ~468-517): author 'staff'.
      {
        conversationId: 'one',
        tsMsgId: '2026-10-20T10:00:00.000Z#q1',
        type: 'sms',
        direction: 'outbound',
        author: 'staff',
        delivery_status: 'sent',
        imported_from: QUO,
      } as unknown as MessageItem,
      {
        conversationId: 'one',
        tsMsgId: '2026-10-20T11:00:00.000Z#q2',
        type: 'call',
        direction: 'outbound',
        author: 'staff',
        delivery_status: 'sent',
        call_outcome: 'completed',
        imported_from: QUO,
      } as unknown as MessageItem,
      text('2026-10-20T12:00:00.000Z#q3', { imported_from: QUO }),
    ]);
    const relay = await planRows(RELAY, [
      {
        conversationId: 'grp',
        tsMsgId: '2026-10-20T13:00:00.000Z#q4',
        type: 'sms',
        direction: 'outbound',
        author: 'staff',
        delivery_status: 'sent',
        relay_sender_key: TEAM_SENDER_KEY,
        delivery_recipients: { 'c-b': { status: 'sent', sid: 'q', sentAt: '2026-10-20T13:00:00.000Z' } },
        imported_from: QUO,
      } as unknown as MessageItem,
    ]);
    expect(nonZero(plan)).toEqual({ imported: 3 });
    expect(nonZero(relay)).toEqual({ imported: 1 });
    expect(plan.latest.size + relay.latest.size).toBe(0);
  });

  it('an author that is not teammate never counts', async () => {
    const plan = await planRows(ONE, [
      { ...text('2026-10-20T10:00:00.000Z#s1'), author: 'staff' } as unknown as MessageItem,
      text('2026-10-20T11:00:00.000Z#s2', { author: 'ai' }),
    ]);
    expect(nonZero(plan)).toEqual({ not_teammate: 2 });
  });

  it('never counts an inbound row', async () => {
    const plan = await planRows(ONE, [text('2026-10-20T10:00:00.000Z#in', { direction: 'inbound', author: 'tenant' })]);
    const relay = await planRows(RELAY, [
      post('2026-10-20T11:00:00.000Z#in2', {}, { direction: 'inbound', author: 'tenant', relay_sender_key: 'c-b' }),
    ]);
    expect(nonZero(plan)).toEqual({ inbound: 1 });
    expect(nonZero(relay)).toEqual({ inbound: 1 });
  });

  it('a row of a type outside sms/mms/email/call is other_type', async () => {
    const plan = await planRows(ONE, [text('2026-10-20T10:00:00.000Z#f', { type: 'fax' as unknown as MessageItem['type'] })]);
    expect(nonZero(plan)).toEqual({ other_type: 1 });
  });

  it('the window: the window start counts; a row above the key floor but before the window does not; an unparseable key is counted apart', async () => {
    const plan = await planRows(ONE, [
      text(`${WINDOW_START}#W0`),
      text('2026-10-10T11:59:59.999Z#W1'),
      text('2026-10-10T11:30:00.000Z#W2'), // inside the key floor margin
      text('garbage#W3'),
    ]);
    expect(nonZero(plan)).toEqual({ text: 1, outside_window: 2 });
    expect(plan.unparseableInstants).toBe(1);
    expect([...plan.latest]).toEqual([['c-a', WINDOW_START]]);
  });

  it('keeps the latest instant per contact across threads, whichever is planned first, on NORMALIZED instants', async () => {
    const relayA: ReachedOutThread = {
      conversationId: 'ga',
      type: 'relay_group',
      participants: [{ contactId: 'c-a', phone: '+15550100001' }],
    };
    // Raw strings would pick '2026-10-20T10:00:00Z' ('Z' sorts after '.').
    const oneRows = [text('2026-10-20T10:00:00Z#a')];
    const relayRows = [
      post('2026-10-20T09:59:00.000Z#team-a', { 'c-a': slot({ sid: 'SM-a', sentAt: '2026-10-20T10:00:00.500Z' }) }, { conversationId: 'ga' }),
    ];

    const oneFirst = newPlan();
    await planThreadPage(oneFirst, ONE, oneRows, ctx());
    await planThreadPage(oneFirst, relayA, relayRows, ctx());
    expect(oneFirst.latest.get('c-a')).toBe('2026-10-20T10:00:00.500Z');

    const relayFirst = newPlan();
    await planThreadPage(relayFirst, relayA, relayRows, ctx());
    await planThreadPage(relayFirst, ONE, oneRows, ctx());
    expect(relayFirst.latest.get('c-a')).toBe('2026-10-20T10:00:00.500Z');
  });
});

// ---------------------------------------------------------------------------
// Half 2 - the runner
// ---------------------------------------------------------------------------

interface FakeTables {
  conversations: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  reminders: Record<string, unknown>[];
}

function fakeDoc(tables: FakeTables, pageSize = 1000) {
  const queries: Record<string, any>[] = [];
  const scans: Record<string, any>[] = [];
  const doc = {
    async send(command: unknown) {
      if (command instanceof ScanCommand) {
        const input = command.input as Record<string, any>;
        scans.push(input);
        if (input['TableName'] === 'hc-test-conversations') return { Items: tables.conversations };
        if (input['TableName'] === 'hc-test-tourReminders') {
          // Models the FilterExpression: attribute_exists(sentBody) AND sentAt >= :floor.
          const floor = String(input['ExpressionAttributeValues'][':floor']);
          return {
            Items: tables.reminders.filter(
              (r) => r['sentBody'] !== undefined && typeof r['sentAt'] === 'string' && r['sentAt'] >= floor,
            ),
          };
        }
        throw new Error(`unexpected Scan of ${String(input['TableName'])}`);
      }
      if (command instanceof QueryCommand) {
        const input = command.input as Record<string, any>;
        queries.push(input);
        const values = input['ExpressionAttributeValues'];
        // Models the KEY CONDITION (conversationId = :c AND tsMsgId >= :floor),
        // the FilterExpression (#dir = :outbound) and ascending key order.
        const rows = tables.messages
          .filter((m) => m['conversationId'] === values[':c'] && String(m['tsMsgId']) >= String(values[':floor']))
          .filter((m) => m['direction'] === values[':outbound'])
          .sort((a, b) => (String(a['tsMsgId']) < String(b['tsMsgId']) ? -1 : 1));
        const start = input['ExclusiveStartKey'] === undefined ? 0 : Number(input['ExclusiveStartKey'].idx);
        const next = start + pageSize < rows.length ? { idx: start + pageSize } : undefined;
        return { Items: rows.slice(start, start + pageSize), ...(next && { LastEvaluatedKey: next }) };
      }
      throw new Error('unexpected command');
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, queries, scans };
}

/** Forward-only, like the real conditional writer. */
function fakeContacts(failFor?: string) {
  const stored = new Map<string, string>();
  const touches: { contactId: string; at: string }[] = [];
  const contacts = {
    async findByPhone(phone: string): Promise<ContactItem | undefined> {
      return phone === '+15550100004' ? ({ contactId: 'c-d' } as ContactItem) : undefined;
    },
    async findByEmail(): Promise<ContactItem | undefined> {
      return undefined;
    },
    async touchLastReachedOut(contactId: string, at: string): Promise<'written' | 'skipped' | 'failed'> {
      touches.push({ contactId, at });
      if (contactId === failFor) return 'failed';
      const prior = stored.get(contactId);
      if (prior !== undefined && prior >= at) return 'skipped';
      stored.set(contactId, at);
      return 'written';
    },
  };
  return { contacts, stored, touches };
}

const RUN_NOW = new Date('2026-10-24T12:00:00.000Z');
const KEY_FLOOR = '2026-10-10T11:00:00.000Z';
const REMINDER_BODY = 'SECRET reminder copy: your tour is tomorrow at 10am.';
const OLD_REMINDER_BODY = 'SECRET old reminder copy.';
const ENV = { TABLE_PREFIX: 'hc-test-' } as NodeJS.ProcessEnv;

/** A stored staff text (the raw item the Query returns). */
const staff = (conversationId: string, tsMsgId: string, over: Record<string, unknown> = {}) => ({
  conversationId,
  tsMsgId,
  type: 'sms',
  direction: 'outbound',
  author: 'teammate',
  delivery_status: 'sent',
  automated: false,
  body: 'SECRET staff text',
  ...over,
});

const TABLES: FakeTables = {
  conversations: [
    { conversationId: 'phone#+15550100001', ref_conversationId: 'one' },
    {
      conversationId: 'one',
      type: 'tenant_1to1',
      participant_phone: '+15550100001',
      participants: [{ contactId: 'c-a', phone: '+15550100001', name: 'Pat Secret' }],
    },
    {
      conversationId: 'two',
      type: 'partner_1to1',
      participant_email: 'pat@x.test',
      participants: [{ contactId: 'c-a', phone: '+15550100001', name: 'Pat Secret' }],
    },
    {
      conversationId: 'three',
      type: 'tenant_1to1',
      participants: [{ contactId: 'c-e', phone: '+15550100006', name: 'Eve Secret' }],
    },
    {
      conversationId: 'grp',
      type: 'relay_group',
      participants: [
        { contactId: 'c-b', phone: '+15550100002', name: 'Bo Secret' },
        { contactId: 'c-c', phone: '+15550100003', name: 'Cy Secret' },
        { contactId: '', phone: '+15550100004' },
      ],
    },
    {
      conversationId: 'gt',
      type: 'group_text',
      participants: [
        { contactId: 'c-g', phone: '+15550100008', name: 'Gus Secret' },
        { contactId: '', phone: '+15550100004' },
        { contactId: '', phone: '+15550100009' },
      ],
    },
  ],
  messages: [
    staff('one', '2026-10-01T10:00:00.000Z#SM0'), // below the key floor: never read
    staff('one', '2026-10-10T11:30:00.000Z#SM-m'), // above the floor, before the window
    staff('one', '2026-10-20T10:00:00.000Z#SM1'),
    staff('one', '2026-10-22T09:00:00.000Z#SM2'),
    staff('one', '2026-10-22T10:00:00.000Z#SM3', { body: REMINDER_BODY }), // a reminder Send now
    staff('one', '2026-10-22T11:00:00.000Z#SM4', { direction: 'inbound', author: 'tenant' }), // the Query filters it
    {
      conversationId: 'two',
      tsMsgId: '2026-10-23T10:00:00.000Z#hc-1@mail.x.test',
      type: 'email',
      direction: 'outbound',
      author: 'teammate',
      delivery_status: 'sent',
      ses_message_id: 'ses-1',
      email_to: ['pat@x.test'],
      body: 'SECRET email',
    },
    staff('three', '2026-10-15T09:00:00.000Z#SM5', { body: OLD_REMINDER_BODY }), // that reminder is outside the window
    {
      conversationId: 'grp',
      tsMsgId: '2026-10-21T08:00:00.000Z#team-1',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      delivery_status: 'queued',
      relay_sender_key: TEAM_SENDER_KEY,
      body: 'SECRET team post',
      delivery_recipients: {
        'c-b': { status: 'sent', sid: 'SM-b', sentAt: '2026-10-21T08:00:05.000Z' },
        'c-c': { status: 'queued' },
        'phone#+15550100004': { status: 'sent', sid: 'SM-p', sentAt: '2026-10-21T08:00:06.000Z' },
      },
    },
    {
      conversationId: 'gt',
      tsMsgId: '2026-10-23T07:00:00.000Z#IM1',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      delivery_status: 'queued',
      relay_sender_key: TEAM_SENDER_KEY,
      body: 'SECRET group text',
      delivery_recipients: {
        [groupMemberKey('+15550100008')]: { status: 'queued', transportAggregationState: 'attempted' },
        [groupMemberKey('+15550100004')]: { status: 'queued', transportAggregationState: 'attempted' },
        [groupMemberKey('+15550100009')]: {
          status: 'failed',
          errorCode: 'contact_opted_out',
          transportAggregationState: 'excluded',
        },
      },
    },
  ],
  reminders: [
    { reminderId: 'r-1', tourId: 't-1', sentAt: '2026-10-22T09:55:00.000Z', sentBody: REMINDER_BODY },
    { reminderId: 'r-0', tourId: 't-0', sentAt: '2026-10-01T09:00:00.000Z', sentBody: OLD_REMINDER_BODY },
    { reminderId: 'r-2', tourId: 't-2', dueAt: '2026-10-30T09:00:00.000Z' },
  ],
};

/** contactId order (the runner sorts). c-a: the email in `two` is later than its texts in `one`. */
const EXPECTED_TOUCHES = [
  { contactId: 'c-a', at: '2026-10-23T10:00:00.000Z' },
  { contactId: 'c-b', at: '2026-10-21T08:00:05.000Z' },
  { contactId: 'c-d', at: '2026-10-23T07:00:00.000Z' },
  { contactId: 'c-e', at: '2026-10-15T09:00:00.000Z' },
  { contactId: 'c-g', at: '2026-10-23T07:00:00.000Z' },
];

function zeroSkips(): Record<string, number> {
  return Object.fromEntries(SKIP_KINDS.map((k) => [k, 0]));
}

function capturedLogger() {
  const capture = createLogCapture();
  return { capture, logger: createLogger({ level: 'info', destination: capture.stream }) };
}

describe('backfillLastReachedOut - the runner', () => {
  it('a dry run (the default) reads the window, reports every category and writes nothing', async () => {
    const { doc, queries, scans } = fakeDoc(TABLES);
    const { contacts, touches } = fakeContacts();
    const { logger } = capturedLogger();
    const result = await backfillLastReachedOut({ doc, env: ENV, contacts, logger, now: RUN_NOW });
    expect(touches).toEqual([]);
    expect(result).toMatchObject({
      windowStart: '2026-10-10T12:00:00.000Z',
      keyFloor: KEY_FLOOR,
      introRule: 'body_match',
      sendNowRule: 'exclude_by_body',
      conversationsWalked: 5,
      pointerRows: 1,
      messagesRead: 8,
      remindersInWindow: 1,
      reminderBodyTimeMatched: 1,
      // PR91: the fixture holds no staff Retry.
      retryOriginOutsideWindow: 0,
      unparseableInstants: 0,
      planned: 5,
      written: 0,
      skipped: 0,
      failed: 0,
    });
    expect(result.counted).toEqual({
      text: 3,
      email: 1,
      call: 0,
      relay_team_slot: 1,
      group_text_slot: 2,
      edited_intro_slot: 0,
    });
    expect(result.rowsSkipped).toEqual({
      ...zeroSkips(),
      outside_window: 1,
      excluded_reminder_body: 1,
      slot_not_sent: 1,
      relay_phone_slot: 1,
      group_excluded_slot: 1,
    });
    // ONE key-condition Query per thread over the window - never the full history.
    expect(queries.map((q) => q['ExpressionAttributeValues'][':c'])).toEqual(['one', 'two', 'three', 'grp', 'gt']);
    for (const q of queries) {
      expect(q['TableName']).toBe('hc-test-messages');
      expect(q['KeyConditionExpression']).toBe('conversationId = :c AND tsMsgId >= :floor');
      expect(q['ExpressionAttributeValues'][':floor']).toBe(KEY_FLOOR);
      expect(q['FilterExpression']).toBe('#dir = :outbound');
      expect(q['ExpressionAttributeNames']).toEqual({ '#dir': 'direction' });
    }
    const reminderScan = scans.find((s) => s['TableName'] === 'hc-test-tourReminders');
    expect(reminderScan?.['FilterExpression']).toBe('attribute_exists(#sentBody) AND #sentAt >= :floor');
    expect(reminderScan?.['ExpressionAttributeValues']).toEqual({ ':floor': KEY_FLOOR });
  });

  it('an apply makes ONE touch per contact with its latest instant across threads, and a second apply writes nothing', async () => {
    const { doc } = fakeDoc(TABLES);
    const { contacts, touches } = fakeContacts();
    const { logger } = capturedLogger();
    const first = await backfillLastReachedOut({ doc, env: ENV, contacts, logger, now: RUN_NOW, apply: true });
    expect(touches).toEqual(EXPECTED_TOUCHES);
    expect(first.written).toBe(5);
    expect(first.written).toBe(first.planned);

    const second = await backfillLastReachedOut({ doc, env: ENV, contacts, logger, now: RUN_NOW, apply: true });
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(second.planned);
    expect(second.skipped).toBe(5);
  });

  it('pages: every thread is read until LastEvaluatedKey is gone', async () => {
    const { doc, queries } = fakeDoc(TABLES, 1);
    const { contacts, touches } = fakeContacts();
    const { logger } = capturedLogger();
    await backfillLastReachedOut({ doc, env: ENV, contacts, logger, now: RUN_NOW, apply: true });
    const byThread = (id: string) => queries.filter((q) => q['ExpressionAttributeValues'][':c'] === id).length;
    // `one` returns four window rows (SM-m, SM1, SM2, SM3), one per page.
    expect(byThread('one')).toBe(4);
    expect(byThread('grp')).toBe(1);
    expect(queries.length).toBe(8);
    expect(touches).toEqual(EXPECTED_TOUCHES);
  });

  it('a FAILED touch aborts the run with a PARTIAL report and no later touch', async () => {
    const { doc } = fakeDoc(TABLES);
    const { contacts, touches } = fakeContacts('c-a');
    const { capture, logger } = capturedLogger();
    await expect(
      backfillLastReachedOut({ doc, env: ENV, contacts, logger, now: RUN_NOW, apply: true }),
    ).rejects.toThrow(/touchLastReachedOut failed for c-a/);
    expect(touches.map((t) => t.contactId)).toEqual(['c-a']);
    const partial = capture.atLevel(50).find((l) => String(l['msg']).includes('PARTIAL result'));
    expect(partial).toBeDefined();
    expect(partial?.['failed']).toBe(1);
    expect(partial?.['written']).toBe(0);
    expect(partial?.['planned']).toBe(5);
    expect(partial?.['apply']).toBe(true);
  });

  it('logs counts and ids only - never a body, a phone, an address or a name', async () => {
    const ok = capturedLogger();
    await backfillLastReachedOut({
      doc: fakeDoc(TABLES).doc,
      env: ENV,
      contacts: fakeContacts().contacts,
      logger: ok.logger,
      now: RUN_NOW,
      apply: true,
    });
    const failing = capturedLogger();
    await expect(
      backfillLastReachedOut({
        doc: fakeDoc(TABLES).doc,
        env: ENV,
        contacts: fakeContacts('c-a').contacts,
        logger: failing.logger,
        now: RUN_NOW,
        apply: true,
      }),
    ).rejects.toThrow();
    expect(ok.capture.lines.length).toBeGreaterThan(0);
    expect(failing.capture.lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify([...ok.capture.lines, ...failing.capture.lines]);
    for (const needle of ['SECRET', 'Secret', '+1555', 'x.test', 'ses-1']) {
      expect(logged).not.toContain(needle);
    }
  });

  it('reportBackfillRun returns 0, names a dry run in its done line, and carries the counts and the rules', async () => {
    const { doc } = fakeDoc(TABLES);
    const { contacts } = fakeContacts();
    const result = await backfillLastReachedOut({ doc, env: ENV, contacts, logger: capturedLogger().logger, now: RUN_NOW });

    const dry = capturedLogger();
    expect(reportBackfillRun(result, false, dry.logger)).toBe(0);
    const dryDone = dry.capture.atLevel(30).at(-1);
    expect(dryDone?.['msg']).toBe('backfill-last-reached-out - done (DRY RUN - nothing written)');
    expect(dryDone?.['planned']).toBe(5);
    expect(dryDone?.['apply']).toBe(false);
    expect(dryDone?.['introRule']).toBe('body_match');
    expect(dryDone?.['sendNowRule']).toBe('exclude_by_body');
    expect(dryDone?.['counted']).toEqual(result.counted);
    expect(dryDone?.['rowsSkipped']).toEqual(result.rowsSkipped);

    const live = capturedLogger();
    expect(reportBackfillRun(result, true, live.logger)).toBe(0);
    expect(live.capture.atLevel(30).at(-1)?.['msg']).toBe('backfill-last-reached-out - done');
  });
});
