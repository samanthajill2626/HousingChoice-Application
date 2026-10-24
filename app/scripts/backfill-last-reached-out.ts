// backfill-last-reached-out - the ONE-TIME backfill of
// contacts.last_reached_out_at from the last 14 days of outbound history (spec
// docs/superpowers/specs/2026-10-23-today-checklist-design.md, sections 7.2,
// 7.3 and 7.5; plan docs/superpowers/plans/2026-10-24-today-checklist.md,
// ruling PR38). Twin of backfill-last-heard-from.ts.
//
// WHAT: Scans every conversation (phone#/email#/token# claim rows skipped),
// reads each one's OUTBOUND rows of the window with a KEY-CONDITION Query
// (tsMsgId >= the key floor - never the full history; no GSI exists on
// messages), classifies every row with planThreadPage, keeps the latest
// instant per contact ACROSS threads, then makes ONE
// contactsRepo.touchLastReachedOut per contact. The writer is conditional and
// forward-only: a value a live staff send wrote after the scan is never moved
// back, and a second run writes nothing. It emits no live event.
//
// WINDOW: FOLLOW_UP_LOOKBACK_MS (14 days). A stamp matters only when it is
// later than a share's sentAt, and no older share is a Follow up candidate.
// The key floor is the window start minus KEY_FLOOR_MARGIN_MS; every row is
// then re-checked on its NORMALIZED providerTs. No pre-filter on
// last_activity_at: calls and queued relay posts do not move it.
//
// WHICH ROWS COUNT (spec 7.2, read through the fields each writer leaves; no
// row says who started it). Outbound, no imported_from (a Quo row never
// counts), author 'teammate' (except the edited intro below), and:
//   - one-to-one sms/mms/email/call: automated not true; no broadcast_id (a
//     share, or a Retry of one); no retry_attempt / retry_window_start (the
//     automatic 30003 retry - a staff Retry carries retry_of alone and
//     counts, EXCEPT a Retry whose retried row OR chain root (retry_root) is
//     among this thread's window rows and is automated, system copy or a
//     Send-now body (plan PR105, the live W2 gate of PR104); a Retry whose
//     retried row and root are both older than the window counts and is
//     reported as retryOriginOutsideWindow); never a row marked system_copy
//     (a Send now, or a Retry of system copy - PR104); an email once it left for SES
//     (not failed; queued only with an SES id); a call once the contact's
//     leg was dialed (answered_at or
//     call_outcome), at answered_at when present. Recipient:
//     recipient_contact_id, else the thread's contact (the attributeInbound
//     one-to-one order).
//   - relay team posts (relay_sender_key 'team', no relay_retry_of): each
//     CONTACT-keyed slot with a sid and a sentAt, at slot.sentAt (a phone#
//     slot has no contact to stamp).
//   - group-text posts (relay_sender_key 'team' on a group_text thread): each
//     slot not 'excluded'; phone -> contact by the roster, then findByPhone;
//     at the row's providerTs.
//   - staff-edited relay intros (author 'system'): BODY MATCH (INTRO_RULE) - a
//     system row on a relay_group whose body IS the thread's intro_body; its
//     sent contact slots, at slot.sentAt.
//   - tour reminder / placement nudge "Send now" (automated false, no
//     marker): EXCLUDED BY BODY (SEND_NOW_RULE) - a text equal to one of the
//     four nudge.* catalog defaults, or to the sentBody of a tour reminder sent
//     in the window. The report counts both, and how many reminder matches
//     also fell within REMINDER_TIME_MATCH_MS after that reminder's sentAt.
//
// KNOWN GAP (accepted; RUNBOOK): a relay team post QUEUED on a connecting
// group more than 14 days ago whose legs went out inside the window sits below
// the key floor and is not read.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts. DRY RUN IS
// THE DEFAULT; --apply writes. An agent runs this ONLY with --env local
// --lane <L> against a hermetic e2e lane it started (a bare --env local is the
// human's live stack). NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; Cameron
// does, after the deploy, dry run first, per the RUNBOOK. No package.json
// script, like its twin.
//
//   npx tsx app/scripts/backfill-last-reached-out.ts --env dev
//   npx tsx app/scripts/backfill-last-reached-out.ts --env dev --apply
//
// ABORT: a touch answering 'failed' (any error but a lost condition) stops the
// run with a PARTIAL report and exit 1. Re-running after the fix is safe.
//
// PII: logs counts and contactIds only - never a name, phone, address or body.
import { attributeInbound, normalizeInstant, type HeardFromLookup } from '../src/lib/heardFrom.js';
import { FOLLOW_UP_LOOKBACK_MS } from '../src/lib/listingSendOutcome.js';
import type { MessageId } from '../src/messages/catalog.js';
import { resolveMessage } from '../src/messages/resolve.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { splitTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';

export const SCRIPT_NAME = 'backfill-last-reached-out';

/** The window (spec 7.5): the Follow up candidate horizon. */
export const WINDOW_MS = FOLLOW_UP_LOOKBACK_MS;
/** The key-condition floor sits this far below the window start (spec 7.5 "a small margin"). */
export const KEY_FLOOR_MARGIN_MS = 60 * 60 * 1000;
/** A reminder-body row "also matched in time" when its providerTs is within this long AFTER that reminder's sentAt (PR38). */
export const REMINDER_TIME_MATCH_MS = 10 * 60 * 1000;
/** PR38: the rules the dry run reports it applied. */
export const INTRO_RULE = 'body_match' as const;
export const SEND_NOW_RULE = 'exclude_by_body' as const;

/** The placement-nudge catalog ids. The Send now path sends
 *  resolveMessage(`nudge.${kind}`) with no override (jobs/placementNudges.ts). */
export const NUDGE_MESSAGE_IDS = [
  'nudge.receipt_check',
  'nudge.completion_check',
  'nudge.approval_check',
  'nudge.rta_window_closing',
] as const satisfies readonly MessageId[];

/** Local literals, as lib/heardFrom.ts keeps them: importing jobs/relayFanOut.ts
 *  or services/relayAnnouncements.ts would pull the adapters into the script.
 *  The tests build rows with the REAL constants, so a drift fails them. */
const TEAM_SENDER_KEY = 'team';
const SYSTEM_SENDER_KEY = 'system';
const PHONE_KEY_PREFIX = 'phone#';
const GROUP_THREAD_TYPES: ReadonlySet<string> = new Set(['relay_group', 'group_text']);
/** An email row in one of these left for SES (a bounce is 'undelivered'). */
const EMAIL_LEFT_STATUSES: ReadonlySet<string> = new Set(['sent', 'delivered', 'undelivered']);

/** Counted per ROW (text, email, call) or per member SLOT (the rest). */
export const COUNTED_KINDS = [
  'text',
  'email',
  'call',
  'relay_team_slot',
  'group_text_slot',
  'edited_intro_slot',
] as const;
export type CountedKind = (typeof COUNTED_KINDS)[number];

/** Why a row (or a member slot) produced no instant. */
export const SKIP_KINDS = [
  'inbound',
  'imported',
  'outside_window',
  'relay_retry',
  'system_other',
  'not_teammate',
  'group_other',
  'automated',
  'share',
  'machine_retry',
  // PR105: a staff Retry whose retried row or chain root in the window is
  // automated, system copy or a Send-now body.
  'retry_of_system_copy',
  // PR105: a row marked system_copy (Send now; a Retry of system copy, PR104).
  'system_copy',
  'call_not_dialed',
  'email_failed',
  'email_queued',
  'excluded_nudge_body',
  'excluded_reminder_body',
  'other_type',
  'no_recipient',
  'relay_phone_slot',
  'slot_not_sent',
  'group_excluded_slot',
  'group_unresolved_slot',
] as const;
export type SkipKind = (typeof SKIP_KINDS)[number];

const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export interface ReachedOutPlan {
  conversationsWalked: number;
  pointerRows: number;
  /** Rows the window Query returned (outbound, at or above the key floor). */
  messagesRead: number;
  counted: Record<CountedKind, number>;
  rowsSkipped: Record<SkipKind, number>;
  /** Of rowsSkipped.excluded_reminder_body: rows also within REMINDER_TIME_MATCH_MS after that reminder's sentAt. */
  reminderBodyTimeMatched: number;
  /**
   * PR105: of the COUNTED one-to-one rows, the staff Retries (retry_of set)
   * whose retried row AND chain root were both absent from the thread's
   * window rows, so they could not be judged - counted, reported as residue.
   */
  retryOriginOutsideWindow: number;
  unparseableInstants: number;
  /** contactId -> the latest normalized instant, across every thread. */
  latest: Map<string, string>;
  /**
   * PR91: every in-window one-to-one outbound row seen so far, keyed
   * `<conversationId>|<tsMsgId>`, -> whether its copy is the system's
   * (automated, system_copy, or a Send-now body - PR105). A later staff Retry
   * is judged by its retried row and its chain root here.
   */
  windowOneToOne: Map<string, boolean>;
}

export function newPlan(): ReachedOutPlan {
  return {
    conversationsWalked: 0,
    pointerRows: 0,
    messagesRead: 0,
    counted: zeroed(COUNTED_KINDS),
    rowsSkipped: zeroed(SKIP_KINDS),
    reminderBodyTimeMatched: 0,
    retryOriginOutsideWindow: 0,
    unparseableInstants: 0,
    latest: new Map(),
    windowOneToOne: new Map(),
  };
}

/** The thread fields the planner reads - the PERSISTED conversation. */
export type ReachedOutThread = Pick<
  ConversationItem,
  'conversationId' | 'type' | 'participants' | 'participant_phone' | 'participant_email' | 'intro_body'
>;

export interface ReachedOutContext {
  lookup: HeardFromLookup;
  /** ISO: a row whose normalized providerTs is earlier is outside the window. */
  windowStart: string;
  /** nudgeBodySet(). */
  nudgeBodies: ReadonlySet<string>;
  /** indexReminderSends(): sentBody -> the normalized sentAt of each in-window reminder that sent it. */
  reminderSends: ReadonlyMap<string, readonly string[]>;
}

/** The window start and the key-condition floor for a run at `now`. */
export function windowBounds(now: Date): { windowStart: string; keyFloor: string } {
  const windowStartMs = now.getTime() - WINDOW_MS;
  return {
    windowStart: new Date(windowStartMs).toISOString(),
    keyFloor: new Date(windowStartMs - KEY_FLOOR_MARGIN_MS).toISOString(),
  };
}

/** The four nudge bodies, resolved through the message catalog at run start. */
export function nudgeBodySet(): Set<string> {
  return new Set(NUDGE_MESSAGE_IDS.map((id) => resolveMessage(id)));
}

/** The tour reminder row fields the exclusion reads (repos/tourRemindersRepo.ts). */
export interface ReminderSendRow {
  sentAt?: unknown;
  sentBody?: unknown;
}

/** Index the in-window tour reminder sends by body. A row with no sentBody
 *  (pending, or claimed before the field existed) or an unparseable sentAt is
 *  left out. */
export function indexReminderSends(items: readonly ReminderSendRow[], windowStart: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of items) {
    if (!nonEmpty(item.sentBody)) continue;
    const sentAt = normalizeInstant(typeof item.sentAt === 'string' ? item.sentAt : undefined);
    if (sentAt === undefined || sentAt < windowStart) continue;
    const list = out.get(item.sentBody);
    if (list === undefined) out.set(item.sentBody, [sentAt]);
    else list.push(sentAt);
  }
  return out;
}

/**
 * Plan ONE page of a thread's window rows into `plan`: each row (or member
 * slot) lands in exactly one counted or skipped category, and every counted
 * one folds its instant into `plan.latest`. The Query filters inbound rows
 * out; the planner re-checks so it is right on any input. The page is
 * INDEXED first (PR91, PR105), so a staff Retry can be judged against a
 * retried row (or chain root) later in the same page; the window Query reads
 * a thread in key order, so a retried row or root (an earlier key) on
 * another page was indexed before.
 */
export async function planThreadPage(
  plan: ReachedOutPlan,
  thread: ReachedOutThread,
  rows: readonly MessageItem[],
  ctx: ReachedOutContext,
): Promise<void> {
  plan.messagesRead += rows.length;
  for (const row of rows) indexOneToOneRow(plan, thread, row, ctx);
  for (const row of rows) await planRow(plan, thread, row, ctx);
}

const windowRowKey = (conversationId: string, tsMsgId: string): string => `${conversationId}|${tsMsgId}`;

/** PR105: the copy is the system's - automated, marked system_copy (PR104),
 *  or one of the Send-now bodies. */
function isSystemCopy(row: MessageItem, ctx: ReachedOutContext): boolean {
  if (row.automated === true || row.system_copy === true) return true;
  const body = row.body;
  return typeof body === 'string' && (ctx.nudgeBodies.has(body) || ctx.reminderSends.has(body));
}

/** PR91: remember each in-window one-to-one outbound row for the manual-retry rule. */
function indexOneToOneRow(plan: ReachedOutPlan, thread: ReachedOutThread, row: MessageItem, ctx: ReachedOutContext): void {
  if (GROUP_THREAD_TYPES.has(thread.type) || row.direction !== 'outbound') return;
  const at = normalizeInstant(splitTsMsgId(row.tsMsgId).providerTs);
  if (at === undefined || at < ctx.windowStart) return;
  plan.windowOneToOne.set(windowRowKey(thread.conversationId, row.tsMsgId), isSystemCopy(row, ctx));
}

function skip(plan: ReachedOutPlan, kind: SkipKind): void {
  plan.rowsSkipped[kind] += 1;
}

function fold(plan: ReachedOutPlan, contactId: string, at: string): void {
  const prior = plan.latest.get(contactId);
  if (prior === undefined || at > prior) plan.latest.set(contactId, at);
}

async function planRow(plan: ReachedOutPlan, thread: ReachedOutThread, row: MessageItem, ctx: ReachedOutContext): Promise<void> {
  if (row.direction !== 'outbound') return skip(plan, 'inbound');
  if (nonEmpty(row['imported_from'])) return skip(plan, 'imported');
  const at = normalizeInstant(splitTsMsgId(row.tsMsgId).providerTs);
  if (at === undefined) {
    plan.unparseableInstants += 1;
    return;
  }
  if (at < ctx.windowStart) return skip(plan, 'outside_window');
  if (nonEmpty(row.relay_retry_of)) return skip(plan, 'relay_retry');
  if (row.author === 'system') return planSystemRow(plan, thread, row);
  if (row.author !== 'teammate') return skip(plan, 'not_teammate');
  if (GROUP_THREAD_TYPES.has(thread.type)) {
    if (row.relay_sender_key !== TEAM_SENDER_KEY) return skip(plan, 'group_other');
    if (thread.type === 'relay_group') return planSentSlots(plan, row, 'relay_team_slot');
    return planGroupTextSlots(plan, thread, row, at, ctx);
  }
  return planOneToOneRow(plan, thread, row, at, ctx);
}

/** PR38 BODY MATCH: only the intro whose body IS the staff-edited intro_body. */
function planSystemRow(plan: ReachedOutPlan, thread: ReachedOutThread, row: MessageItem): void {
  if (
    row.relay_sender_key === SYSTEM_SENDER_KEY &&
    thread.type === 'relay_group' &&
    nonEmpty(thread.intro_body) &&
    row.body === thread.intro_body
  ) {
    planSentSlots(plan, row, 'edited_intro_slot');
    return;
  }
  skip(plan, 'system_other');
}

/** Relay legs: a CONTACT-keyed slot (relayMemberKey) whose leg was SENT - a
 *  sid and a sent instant, never its status (it can stay 'queued' after a
 *  successful send) - at slot.sentAt. */
function planSentSlots(plan: ReachedOutPlan, row: MessageItem, kind: 'relay_team_slot' | 'edited_intro_slot'): void {
  for (const [key, slot] of Object.entries(row.delivery_recipients ?? {})) {
    if (key.startsWith(PHONE_KEY_PREFIX)) {
      skip(plan, 'relay_phone_slot');
      continue;
    }
    const sentAt = nonEmpty(slot.sid) ? normalizeInstant(slot.sentAt) : undefined;
    if (sentAt === undefined) {
      skip(plan, 'slot_not_sent');
      continue;
    }
    plan.counted[kind] += 1;
    fold(plan, key, sentAt);
  }
}

/** Group-text members: every slot not 'excluded' (suppressed at the seed),
 *  phone-keyed (groupMemberKey), at the row's providerTs. */
async function planGroupTextSlots(
  plan: ReachedOutPlan,
  thread: ReachedOutThread,
  row: MessageItem,
  at: string,
  ctx: ReachedOutContext,
): Promise<void> {
  for (const [key, slot] of Object.entries(row.delivery_recipients ?? {})) {
    if (slot.transportAggregationState === 'excluded') {
      skip(plan, 'group_excluded_slot');
      continue;
    }
    const contactId = key.startsWith(PHONE_KEY_PREFIX)
      ? await groupMemberContactId(thread, key.slice(PHONE_KEY_PREFIX.length), ctx.lookup)
      : undefined;
    if (contactId === undefined) {
      skip(plan, 'group_unresolved_slot');
      continue;
    }
    plan.counted.group_text_slot += 1;
    fold(plan, contactId, at);
  }
}

/** The roster first (an entry with an EMPTY contactId counts as absent), then the phone lookup. */
async function groupMemberContactId(
  thread: ReachedOutThread,
  e164: string,
  lookup: HeardFromLookup,
): Promise<string | undefined> {
  const member = (thread.participants ?? []).find((p) => p.phone === e164 && nonEmpty(p.contactId));
  if (member !== undefined) return member.contactId;
  return (await lookup.byPhone(e164))?.contactId;
}

async function planOneToOneRow(
  plan: ReachedOutPlan,
  thread: ReachedOutThread,
  row: MessageItem,
  at: string,
  ctx: ReachedOutContext,
): Promise<void> {
  if (row.automated === true) return skip(plan, 'automated');
  if (nonEmpty(row.broadcast_id)) return skip(plan, 'share');
  if (row.retry_attempt !== undefined || nonEmpty(row.retry_window_start)) return skip(plan, 'machine_retry');
  // PR105 (spec r8 7.5): a row marked system copy - a Send now, or a staff
  // Retry of automated or system-copy copy (PR104) - never counts.
  if (row.system_copy === true) return skip(plan, 'system_copy');
  // PR105 (the live W2 gate, mirrored for rows written before the marker): a
  // staff Retry (retry_of) is not staff outreach when its retried row OR its
  // chain root (retry_root) is among the thread's window rows and its copy is
  // the system's. When NEITHER is among them the Retry cannot be judged: it
  // counts, as reported residue.
  let retryOriginUnseen = false;
  if (nonEmpty(row.retry_of)) {
    const origin = plan.windowOneToOne.get(windowRowKey(thread.conversationId, row.retry_of));
    const root = nonEmpty(row.retry_root)
      ? plan.windowOneToOne.get(windowRowKey(thread.conversationId, row.retry_root))
      : undefined;
    if (origin === true || root === true) return skip(plan, 'retry_of_system_copy');
    if (origin === undefined && root === undefined) retryOriginUnseen = true;
  }
  let kind: 'text' | 'email' | 'call';
  let instant = at;
  if (row.type === 'call') {
    if (!nonEmpty(row.answered_at) && !nonEmpty(row.call_outcome)) return skip(plan, 'call_not_dialed');
    kind = 'call';
    instant = normalizeInstant(row.answered_at) ?? at;
  } else if (row.type === 'email') {
    if (row.delivery_status === 'failed') return skip(plan, 'email_failed');
    if (!nonEmpty(row.ses_message_id) && !EMAIL_LEFT_STATUSES.has(row.delivery_status)) {
      return skip(plan, 'email_queued');
    }
    kind = 'email';
  } else if (row.type === 'sms' || row.type === 'mms') {
    const body = row.body;
    if (typeof body === 'string' && ctx.nudgeBodies.has(body)) return skip(plan, 'excluded_nudge_body');
    const reminderSentAts = typeof body === 'string' ? ctx.reminderSends.get(body) : undefined;
    if (reminderSentAts !== undefined) {
      skip(plan, 'excluded_reminder_body');
      const atMs = Date.parse(at);
      const inTime = reminderSentAts.some((sentAt) => {
        const gap = atMs - Date.parse(sentAt);
        return gap >= 0 && gap <= REMINDER_TIME_MATCH_MS;
      });
      if (inTime) plan.reminderBodyTimeMatched += 1;
      return;
    }
    kind = 'text';
  } else {
    return skip(plan, 'other_type');
  }
  const contactId = nonEmpty(row.recipient_contact_id)
    ? row.recipient_contact_id
    : await oneToOneContactOf(thread, ctx.lookup);
  if (contactId === undefined) return skip(plan, 'no_recipient');
  plan.counted[kind] += 1;
  if (retryOriginUnseen) plan.retryOriginOutsideWindow += 1;
  fold(plan, contactId, instant);
}

/**
 * The one-to-one thread's own contact, in the attributeInbound order:
 * participants contactId, then the participant phone, then the participant
 * email (spec 7.5 "Recipient"). Asks THE rule about an inbound text on this
 * thread - an outbound row has no sender to attribute, but the thread's
 * contact is the same answer - so the order can never drift from it. Called
 * only for non-group threads.
 */
function oneToOneContactOf(thread: ReachedOutThread, lookup: HeardFromLookup): Promise<string | undefined> {
  return attributeInbound({ direction: 'inbound', type: 'sms' }, thread, lookup);
}
