// app/src/jobs/sendReconcile.ts
// The `send.reconcile` job (SOR spec Sec 5, D11-D16a): it resolves a send
// whose provider outcome was left AMBIGUOUS (a timeout, a dropped socket, a
// 5xx, a stale attempt taken over, a send that landed but was not recorded)
// by looking the message up at the provider, and then ADOPTS it, RE-DRIVES the
// recipient once, or closes it UNRESOLVED. The send sites (broadcastFanOut,
// relayFanOut, relayRetryLeg, and the one-to-one 30003 retry job retrySend -
// the `retry_send` owner, retry-send-adoption) hand off to it through
// `enqueueSendReconcile` after moving the recipient's send-attempt record to
// `reconciling`.
//
// NO RUN-ONCE MARKER (spec D11, build finding T10-6). The job never calls
// `putJobExecutionMarker`, and that is deliberate: its enqueues are
// at-least-once and every write it makes is idempotent or conditional on the
// attempt record (state + attemptedAt), so a redelivery, a duplicate check or
// two chains for one recipient converge on one outcome. A throw inside the job
// is therefore a GENUINE retry on SQS (five failures reach the DLQ and page
// through jobs-dlq-depth). On the hermetic lane a delayed in-process dispatch
// is never redelivered (T10-11): nothing may depend on a retry there.
//
// The payload carries identifiers only (D12): the owner reference with the
// HASHED recipient key, the attempt start every condition keys on, the check
// number and, for a relay leg, the fan-out's continuation context (its sender
// key is carried verbatim - plan deviation 4). The raw recipient key is
// resolved from the owner by its hash; everything else - the recipient digest,
// the sender, the body hash, the media count, a known SID - is read from the
// record at run time. Never a body or a phone in a payload or a log line
// (D18): keys through safeRecipientKey, a provider error only under `err`.
//
// The flow of one check:
//   resolve the owner -> the record (consistent); a record that is no longer
//   this chain's (another state, another attempt) is superseded - and a `done`
//   one of THIS attempt re-applies the slot close its outcome implies and
//   runs afterClose (build ruling A7, extended by FW1-4) -> record the
//   check (from n or n+1: tolerant of its own duplicate) -> a KNOWN SID is
//   fetched and adopted (no digest check); otherwise the D13 lookup lists the
//   provider's messages to the recipient from the sender and adopts the first
//   match it can claim -> the verdict: `found` closes the record adopted;
//   `continue` schedules the next check; `never_sent` marks the record
//   redriven and enqueues ONE re-drive; `unresolved` closes the record done
//   and then, only if that close won, the slot send_unconfirmed. Every
//   enqueue is wrapped: a throw closes the recipient (enqueue_failed after
//   never_sent, else unresolved).
//
// IMPORT CYCLE (build finding T10-10): this module imports the send sites
// (the three fan-outs, and retrySend's producer for a retry's re-drive), and
// they import this module's enqueue helpers back. Nothing here or there reads
// an imported value at module-evaluation time - every use sits inside a
// function - so the ESM live bindings are settled before first use.
// `npm run smoke` proves the compiled imports resolve under plain node.
import {
  createMessagingAdapter,
  mapTwilioStatus,
  type ListMessagesPage,
  type MessagingAdapter,
  type ProviderMessageSummary,
} from '../adapters/messaging.js';
import type { AppConfig } from '../lib/config.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import {
  MAX_SEND_RETRY_ATTEMPTS,
  oneToOneRetryWindowOrigin,
  parseRetryWindowOrigin,
  RETRY_JOB_GRACE_MS,
  RETRY_PROMISE_GRACE_MS,
  RETRY_WINDOW_CLOSED_CODE,
  retryFitsSendWindow,
} from '../lib/retrySendWindow.js';
import { bodyFingerprint, hashRecipientKey, recipientDigest, safeRecipientKey } from '../lib/sendFingerprint.js';
import {
  ENQUEUE_FAILED_CODE,
  RECONCILE_CHECK_DELAYS_MS,
  RECONCILE_LIST_PAGE_SIZE,
  RECONCILE_MAX_PAGES,
  RECONCILE_SIBLING_SPAN_MS,
  RECONCILE_WINDOW_LEAD_MS,
  RECONCILE_WINDOW_TRAIL_MS,
  REDRIVE_REFUSED_CODE,
  SEND_UNCONFIRMED_CODE,
} from '../lib/sendOutcome.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createBroadcastsRepo, type BroadcastItem, type BroadcastsRepo } from '../repos/broadcastsRepo.js';
import {
  contactHoldsPhone,
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createListingSendsRepo, type ListingSendsRepo } from '../repos/listingSendsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type DeliveryStatus,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { automaticAncestry, retryRecipientKey } from '../services/retryChain.js';
import { refreshRetryPromise, withdrawRetryPromise } from '../services/retryPromiseWrites.js';
import {
  applyLaterAttemptBounded,
  type AttemptOutcome,
  type ShareAttemptOutcomeDeps,
} from '../services/shareAttemptOutcome.js';
import { attemptKeyTimestampMs, rowlessAttemptKey } from '../lib/shareAttemptOrder.js';
import {
  attemptKey,
  createSendAttemptsRepo,
  type SendAttemptFacts,
  type SendAttemptOutcome,
  type SendAttemptOwner,
  type SendAttemptRecord,
  type SendAttemptsRepo,
} from '../repos/sendAttemptsRepo.js';
import {
  adoptBroadcastRecipient,
  BROADCAST_SEND_JOB,
  emitBroadcastProgress,
  finalize,
  isBroadcastRowFor,
  resolveContact,
  type AdoptDeps,
  type BroadcastSendPayload,
} from './broadcastFanOut.js';
import { defineJobHandler, enqueue } from './jobs.js';
import { RELAY_FANOUT_JOB, type RelayFanOutPayload } from './relayFanOut.js';
import { RELAY_RETRY_LEG_JOB, type RelayRetryLegPayload } from './relayRetryLeg.js';
// Used ONLY inside enqueueRedrive (the import-cycle rule above): retrySend
// imports this module's hand-off helpers back once the job adopts the record.
import { enqueueSendRetry } from './retrySend.js';

export const SEND_RECONCILE_JOB = 'send.reconcile';

export type SendAttemptOwnerRef =
  | { kind: 'broadcast'; broadcastId: string; recipientKeyHash: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; recipientKeyHash: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; recipientKeyHash: string }
  /**
   * retry-send-adoption R1: the retried row and the attempt, the chain root as
   * a fact. The raw recipient key is never carried: the check re-derives it
   * from the retried row and the thread and compares its hash.
   */
  | {
      kind: 'retry_send';
      conversationId: string;
      retriedTsMsgId: string;
      attempt: number;
      retryRoot: string;
      recipientKeyHash: string;
    };

/** retry-send-adoption R1: the one-to-one 30003 retry attempt's owner - the retry job's claim and this job's fourth kind. */
export type RetrySendOwner = Extract<SendAttemptOwner, { kind: 'retry_send' }>;

/**
 * The exhaustiveness guard every owner switch here ends with (the
 * relayFanOut.ts idiom; retry-send-adoption R4): `never` accepts no owner, so
 * a kind with no arm is a TYPECHECK error at every site, and one that arrives
 * anyway throws - never a silent no-op, which five switches were before.
 */
function unhandledOwner(owner: never): never {
  throw new Error(`sendReconcile: unhandled owner kind ${String((owner as { kind?: unknown }).kind)}`);
}

export interface SendReconcilePayload {
  owner: SendAttemptOwnerRef;
  attemptedAt: string;
  checkNo: number;
  continuation?: { senderKey: string; senderNameOverride?: string };
}

/** The owner as the payload carries it: the recipient key HASHED (never a phone in a payload). */
export function toOwnerRef(owner: SendAttemptOwner): SendAttemptOwnerRef {
  switch (owner.kind) {
    case 'broadcast':
      return { kind: 'broadcast', broadcastId: owner.broadcastId, recipientKeyHash: hashRecipientKey(owner.contactKey) };
    case 'relay_leg':
      return {
        kind: 'relay_leg',
        relayConversationId: owner.relayConversationId,
        sourceTsMsgId: owner.sourceTsMsgId,
        recipientKeyHash: hashRecipientKey(owner.memberKey),
      };
    case 'relay_rung':
      return {
        kind: 'relay_rung',
        relayConversationId: owner.relayConversationId,
        retryTsMsgId: owner.retryTsMsgId,
        recipientKeyHash: hashRecipientKey(owner.memberKey),
      };
    case 'retry_send':
      return {
        kind: 'retry_send',
        conversationId: owner.conversationId,
        retriedTsMsgId: owner.retriedTsMsgId,
        attempt: owner.attempt,
        retryRoot: owner.retryRoot,
        recipientKeyHash: hashRecipientKey(owner.recipientKey),
      };
    default:
      return unhandledOwner(owner);
  }
}

/** Lane-overridable ONLY when no real queue is configured (the hermetic e2e lane). */
export function reconcileCheckDelaysMs(): readonly number[] {
  const raw = process.env['E2E_SEND_RECONCILE_DELAYS_MS'];
  if (raw === undefined || (process.env['JOBS_QUEUE_URL'] ?? '') !== '') return RECONCILE_CHECK_DELAYS_MS;
  const parsed = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  return parsed.length === 3 && parsed.every((n) => Number.isFinite(n) && n >= 0) ? parsed : RECONCILE_CHECK_DELAYS_MS;
}

/** Check k runs at attemptedAt + delays[k]; never negative. Reads the LANE delays. */
export function reconcileDelayMs(attemptedAt: string, checkNo: number, nowMs: number): number {
  return Math.max(0, Date.parse(attemptedAt) + reconcileCheckDelaysMs()[checkNo]! - nowMs);
}

/** EnqueueOptions is `{ runAt }` ONLY (jobs.ts): the delay becomes a runAt. */
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void> {
  await enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) });
}

// ---------------------------------------------------------------------------
// The payload, validated field by field (an unknown field never rides along)
// ---------------------------------------------------------------------------

function requiredText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`sendReconcile: ${what} is required`);
  return value;
}

function parseOwnerRef(value: unknown): SendAttemptOwnerRef {
  if (typeof value !== 'object' || value === null) throw new Error('sendReconcile: owner is required');
  const o = value as Record<string, unknown>;
  const recipientKeyHash = requiredText(o['recipientKeyHash'], 'owner.recipientKeyHash');
  switch (o['kind']) {
    case 'broadcast':
      return { kind: 'broadcast', broadcastId: requiredText(o['broadcastId'], 'owner.broadcastId'), recipientKeyHash };
    case 'relay_leg':
      return {
        kind: 'relay_leg',
        relayConversationId: requiredText(o['relayConversationId'], 'owner.relayConversationId'),
        sourceTsMsgId: requiredText(o['sourceTsMsgId'], 'owner.sourceTsMsgId'),
        recipientKeyHash,
      };
    case 'relay_rung':
      return {
        kind: 'relay_rung',
        relayConversationId: requiredText(o['relayConversationId'], 'owner.relayConversationId'),
        retryTsMsgId: requiredText(o['retryTsMsgId'], 'owner.retryTsMsgId'),
        recipientKeyHash,
      };
    case 'retry_send': {
      // The attempt rides as a NUMBER (requiredText is string-only): a whole
      // attempt the retry job could have run, 1..MAX_SEND_RETRY_ATTEMPTS.
      const attempt = o['attempt'];
      if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_SEND_RETRY_ATTEMPTS) {
        throw new Error('sendReconcile: owner.attempt must be an attempt number');
      }
      return {
        kind: 'retry_send',
        conversationId: requiredText(o['conversationId'], 'owner.conversationId'),
        retriedTsMsgId: requiredText(o['retriedTsMsgId'], 'owner.retriedTsMsgId'),
        attempt,
        retryRoot: requiredText(o['retryRoot'], 'owner.retryRoot'),
        recipientKeyHash,
      };
    }
    default:
      throw new Error('sendReconcile: owner.kind is not a send-attempt owner');
  }
}

function parseContinuation(value: unknown): SendReconcilePayload['continuation'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new Error('sendReconcile: continuation must be an object');
  const c = value as Record<string, unknown>;
  const senderKey = requiredText(c['senderKey'], 'continuation.senderKey');
  const override = c['senderNameOverride'];
  return { senderKey, ...(typeof override === 'string' && override.length > 0 && { senderNameOverride: override }) };
}

/** Throws on anything that is not one reconcile check: a malformed payload is a job failure. */
export function parseSendReconcilePayload(raw: unknown): SendReconcilePayload {
  if (typeof raw !== 'object' || raw === null) throw new Error('sendReconcile: payload is not an object');
  const p = raw as Record<string, unknown>;
  const attemptedAt = p['attemptedAt'];
  if (typeof attemptedAt !== 'string' || Number.isNaN(Date.parse(attemptedAt))) {
    throw new Error('sendReconcile: attemptedAt must be an ISO instant');
  }
  const checkNo = p['checkNo'];
  if (typeof checkNo !== 'number' || !Number.isInteger(checkNo) || checkNo < 0 || checkNo >= RECONCILE_CHECK_DELAYS_MS.length) {
    throw new Error('sendReconcile: checkNo must be a check index');
  }
  const owner = parseOwnerRef(p['owner']);
  const continuation = parseContinuation(p['continuation']);
  return { owner, attemptedAt, checkNo, ...(continuation !== undefined && { continuation }) };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface SendReconcileJobDeps {
  config?: AppConfig;
  adapter?: MessagingAdapter;
  messagesRepo?: MessagesRepo;
  broadcastsRepo?: BroadcastsRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  /** The per-recipient send-attempt records (spec D8a): the coordination state every write is fenced on. */
  sendAttemptsRepo?: SendAttemptsRepo;
  activityEventsRepo?: ActivityEventsRepo;
  listingSendsRepo?: ListingSendsRepo;
  auditRepo?: AuditRepo;
  events?: EventBus;
  logger?: Logger;
}

/** Everything one check reads and writes through. */
interface Ctx {
  log: Logger;
  events: EventBus;
  adapter: MessagingAdapter;
  messages: MessagesRepo;
  broadcasts: BroadcastsRepo;
  contacts: ContactsRepo;
  conversations: ConversationsRepo;
  attempts: SendAttemptsRepo;
  /** share-sent-outcome D7: the listing-send ledger a share retry's slot write updates (the adoption's own repo). */
  listingSends: ListingSendsRepo;
  adopt: AdoptDeps;
}

/** share-sent-outcome D2/D7: what a share retry's slot write (applyLaterAttemptBounded) runs through. */
function shareDeps(c: Ctx): ShareAttemptOutcomeDeps {
  return { broadcasts: c.broadcasts, ledger: { listingSends: c.listingSends, log: c.log }, events: c.events, log: c.log };
}

/** The owner as the job re-reads it: the RAW recipient key resolved from the payload's hash. */
interface Resolved {
  owner: SendAttemptOwner;
  /** The raw recipient key: it addresses the slot; logged only through safeRecipientKey. */
  key: string;
  /** broadcast: the consistent snapshot the key was resolved from. */
  broadcast?: BroadcastItem;
  /**
   * broadcast: the recipient's contact, read once per check (null = none).
   * retry_send: the RECORDED contact of a contact-keyed attempt, read the
   * same way, only when an adoption asks whether it still holds the number.
   */
  contact?: ContactItem | null;
  /**
   * relay: the SOURCE row (a leg) or the RETRY row (a rung), read consistently
   * (T10-7). retry_send: the RETRIED row (retry-send-adoption R4), read
   * consistently - always present for a resolved retry owner; its
   * retry_due_at is the value the promise writes are conditioned on.
   */
  row?: MessageItem;
  /**
   * relay: the group. The conversations repo has no consistent read, so the
   * roster phone behind the digest check and the re-drive pre-check are
   * eventually consistent (T10-7, accepted residue R3): the re-driven pass
   * re-reads and re-filters, and a lagged roster can only err to unresolved.
   * retry_send: the one-to-one thread, read the same eventual way - its
   * participant_phone derives a phone key and proves the digest.
   */
  conversation?: ConversationItem;
}

/** The two relay owner kinds: the only owners with a relay row, a relay slot and a relaysid# pointer. */
type RelayOwner = Extract<SendAttemptOwner, { kind: 'relay_leg' | 'relay_rung' }>;

/** The relay row a relay owner's slot and relaysid pointer are addressed by. */
function relayRowKey(owner: RelayOwner): string {
  return owner.kind === 'relay_leg' ? owner.sourceTsMsgId : owner.retryTsMsgId;
}

/** The relay member behind the recipient key, on the group's CURRENT roster. */
function rosterMember(r: Resolved): ConversationParticipant | undefined {
  const roster = (r.conversation?.participants ?? []) as ConversationParticipant[];
  return roster.find((member) => relayMemberKey(member) === r.key);
}

/** The causes an `unresolved` verdict names in its ONE ERROR (spec D16). */
type UnresolvedCause =
  | 'no_sender'
  | 'digest_mismatch'
  | 'provider_unreachable'
  | 'page_bound'
  | 'unidentified_candidate'
  | 'same_fingerprint_sibling'
  | 'sid_held_elsewhere'
  | 'second_unknown'
  | 'enqueue_failed';

/**
 * A found verdict. share-sent-outcome D2: a RETRY adoption (adoptRetry, and
 * ownRetryRow's own-row proof) also names the attempt it found - its row's
 * tsMsgId, the failure code, the carrier instant (the provider's date_sent;
 * for a stored row at `sent`, its own provider instant) and the row's
 * send-time recipient contact - so the found arm can move a share's ORIGINAL
 * slot before the record closes.
 */
type Found = {
  kind: 'found';
  sid: string;
  adoption: 'adopted' | 'skipped';
  status: DeliveryStatus;
  tsMsgId?: string;
  errorCode?: string;
  carrierSentAt?: string;
  recipientContactId?: string;
};

type Verdict =
  | (Found & { path: 'known_sid' | 'lookup' })
  | { kind: 'continue'; reason: 'provider_error' | 'nothing_adoptable' | 'page_bound'; err?: unknown }
  | { kind: 'never_sent' }
  | { kind: 'unresolved'; cause: UnresolvedCause; extra?: Record<string, unknown> };

/** Who holds a provider SID (D13): nobody, this owner, a system send, or another owner. */
type Held = { kind: 'free' } | { kind: 'mine' } | { kind: 'system' | 'other'; holder: string };

type LogBase = Record<string, unknown>;

/**
 * Register the `send.reconcile` handler. Called by registerAllJobHandlers, so
 * the app's in-process path and the worker both carry it. Lazy: config, the
 * adapter and the repos touch DynamoDB and the provider only on the first run.
 */
export function registerSendReconcileJobHandler(deps: SendReconcileJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  const events = deps.events ?? appEvents;
  let ctx: Ctx | undefined;

  function context(): Ctx {
    if (ctx !== undefined) return ctx;
    const repoDeps = { logger: deps.logger };
    const messages = deps.messagesRepo ?? createMessagesRepo(repoDeps);
    const broadcasts = deps.broadcastsRepo ?? createBroadcastsRepo(repoDeps);
    const contacts = deps.contactsRepo ?? createContactsRepo(repoDeps);
    const conversations = deps.conversationsRepo ?? createConversationsRepo(repoDeps);
    const listingSends = deps.listingSendsRepo ?? createListingSendsRepo(repoDeps);
    ctx = {
      log,
      events,
      adapter: deps.adapter ?? createMessagingAdapter({ ...(deps.config !== undefined && { config: deps.config }), logger: deps.logger }),
      messages,
      broadcasts,
      contacts,
      conversations,
      attempts: deps.sendAttemptsRepo ?? createSendAttemptsRepo(repoDeps),
      listingSends,
      adopt: {
        broadcasts,
        contacts,
        conversations,
        messages,
        activityEvents: deps.activityEventsRepo ?? createActivityEventsRepo(repoDeps),
        listingSends,
        audit: deps.auditRepo ?? createAuditRepo(repoDeps),
        events,
        log,
      },
    };
    return ctx;
  }

  defineJobHandler(SEND_RECONCILE_JOB, async (raw) => {
    const payload = parseSendReconcilePayload(raw);
    await runCheck(context(), payload);
  });
}

/** A payload's owner reference for a log line: the kind and its ids - never its recipient hash (FW1-10). */
function ownerRefLog(ref: SendAttemptOwnerRef): Record<string, string> {
  switch (ref.kind) {
    case 'broadcast':
      return { kind: ref.kind, broadcastId: ref.broadcastId };
    case 'relay_leg':
      return { kind: ref.kind, relayConversationId: ref.relayConversationId, sourceTsMsgId: ref.sourceTsMsgId };
    case 'relay_rung':
      return { kind: ref.kind, relayConversationId: ref.relayConversationId, retryTsMsgId: ref.retryTsMsgId };
    case 'retry_send':
      // retry-send-adoption R9: the thread, the retried row, the attempt and the root (strings, as the type says).
      return {
        kind: ref.kind,
        conversationId: ref.conversationId,
        retriedTsMsgId: ref.retriedTsMsgId,
        attempt: String(ref.attempt),
        retryRoot: ref.retryRoot,
      };
    default:
      return unhandledOwner(ref);
  }
}

/** The owner kind and its ids, for a log line - never the recipient key (logged beside it, redacted). */
function ownerLog(owner: SendAttemptOwner): Record<string, string> {
  switch (owner.kind) {
    case 'broadcast':
      return { kind: owner.kind, broadcastId: owner.broadcastId };
    case 'relay_leg':
      return { kind: owner.kind, relayConversationId: owner.relayConversationId, sourceTsMsgId: owner.sourceTsMsgId };
    case 'relay_rung':
      return { kind: owner.kind, relayConversationId: owner.relayConversationId, retryTsMsgId: owner.retryTsMsgId };
    case 'retry_send':
      return {
        kind: owner.kind,
        conversationId: owner.conversationId,
        retriedTsMsgId: owner.retriedTsMsgId,
        attempt: String(owner.attempt),
        retryRoot: owner.retryRoot,
      };
    default:
      return unhandledOwner(owner);
  }
}

async function runCheck(c: Ctx, payload: SendReconcilePayload): Promise<void> {
  const r = await resolve(c, payload.owner);
  if (r === undefined) {
    // A record, if any, is left for the sweeper (spec Sec 1 residue). The line
    // names the owner kind and its ids, never the recipient hash: an unkeyed
    // hash of a phone is effectively the phone (code review ADV-9, FW1-10).
    c.log.info(
      { event: 'send_reconcile', owner: ownerRefLog(payload.owner), checkNo: payload.checkNo },
      'send.reconcile: owner recipient not found - the attempt is left for the sweeper',
    );
    return;
  }
  const base: LogBase = {
    event: 'send_reconcile',
    owner: ownerLog(r.owner),
    recipientKey: safeRecipientKey(r.key),
    checkNo: payload.checkNo,
  };
  const record = await c.attempts.get(r.owner);
  if (record === undefined || record.state !== 'reconciling' || record.attemptedAt !== payload.attemptedAt) {
    c.log.info(
      { ...base, state: record?.state ?? 'absent', ...(record?.outcome !== undefined && { outcome: record.outcome }) },
      'send.reconcile: superseded - the attempt is no longer this chain\'s',
    );
    // Build ruling A7, extended by FW1-4: a close of THIS attempt that died
    // after its record close is finished here - the job's own closes write the
    // record FIRST, so the slot close its outcome implies is re-applied (from
    // queued / unsent only - idempotent), then afterClose (finalize is
    // conditional and the emits idempotent).
    if (record?.state === 'done' && record.attemptedAt === payload.attemptedAt) {
      const reapply = slotCloseOf(record.outcome);
      if (reapply !== undefined) await closeSlot(c, r, reapply.code, reapply.bucket);
      await afterClose(c, r);
    }
    return;
  }
  if (!(await c.attempts.recordCheck(r.owner, payload.attemptedAt, payload.checkNo + 1))) {
    c.log.info(base, 'send.reconcile: check already recorded - a later check owns the chain');
    return;
  }
  const verdict = record.sid !== undefined ? await adoptKnown(c, r, record, record.sid) : await lookup(c, r, record, payload.checkNo);
  switch (verdict.kind) {
    case 'found': {
      // share-sent-outcome D2 (site 5): a share retry's found attempt reaches
      // the share's ORIGINAL slot BEFORE the record closes - a crash between
      // the two leaves the record reconciling, and the redelivered check
      // re-finds the row through its own child pointer and re-runs this (a
      // replay the transition reads as applied). Bounded, never propagated
      // (plan deviation 11).
      if (r.owner.kind === 'retry_send' && typeof r.row?.broadcast_id === 'string' && verdict.tsMsgId !== undefined) {
        await adoptedShareRetry(c, r.owner, r.row.broadcast_id, verdict, verdict.tsMsgId, base);
      }
      const closed = await c.attempts.closeFromReconcile(r.owner, record.attemptedAt, { outcome: 'adopted', sid: verdict.sid });
      c.log.info(
        {
          ...base,
          verdict: 'found',
          path: verdict.path,
          sid: verdict.sid,
          adoption: verdict.adoption,
          deliveryStatus: verdict.status,
          ...(!closed && { recordClosed: false }),
        },
        'send.reconcile: found - the message the provider holds is adopted',
      );
      // A slot that did not move (a receipt raced ahead) is announced as it
      // IS, not with the provider's stale status.
      await afterClose(c, r, verdict.adoption === 'adopted' ? verdict.status : undefined);
      return;
    }
    case 'continue': {
      if (verdict.reason === 'provider_error') {
        c.log.warn({ ...base, err: verdict.err }, 'send.reconcile: the provider lookup failed at this check - the next check tries again');
      }
      const next = payload.checkNo + 1;
      const enqueued = await enqueueOrClose(c, r, record, base, 'reconciling', () =>
        enqueueSendReconcile({ ...payload, checkNo: next }, reconcileDelayMs(record.attemptedAt, next, Date.now())),
      );
      if (enqueued) {
        c.log.info(
          { ...base, verdict: 'continue', reason: verdict.reason, nextCheck: next },
          'send.reconcile: nothing adoptable yet - the next check is scheduled',
        );
      }
      return;
    }
    case 'never_sent':
      await redrive(c, r, record, payload.continuation, base);
      return;
    case 'unresolved':
      await closeUnresolved(c, r, record, verdict.cause, base, verdict.extra);
      return;
  }
}

/** Resolve the RAW recipient key from the payload's hash (spec D12). */
async function resolve(c: Ctx, ref: SendAttemptOwnerRef): Promise<Resolved | undefined> {
  switch (ref.kind) {
    case 'broadcast': {
      const broadcast = await c.broadcasts.getByIdConsistent(ref.broadcastId);
      const key = Object.keys(broadcast?.recipients ?? {}).find((k) => hashRecipientKey(k) === ref.recipientKeyHash);
      if (broadcast === undefined || key === undefined) return undefined;
      return { owner: { kind: 'broadcast', broadcastId: ref.broadcastId, contactKey: key }, key, broadcast };
    }
    case 'relay_leg':
    case 'relay_rung': {
      const rowTsMsgId = ref.kind === 'relay_leg' ? ref.sourceTsMsgId : ref.retryTsMsgId;
      const row = await c.messages.getByTsMsgIdConsistent(ref.relayConversationId, rowTsMsgId);
      const conversation = await c.conversations.getById(ref.relayConversationId);
      // The rung's member is the one its row names; a leg's is a slot on its
      // source, or - a legacy source seeds no slot before the claim - a roster member.
      const keys = [
        ...(ref.kind === 'relay_rung' && typeof row?.relay_retry_member_key === 'string' ? [row.relay_retry_member_key] : []),
        ...Object.keys(row?.delivery_recipients ?? {}),
        ...((conversation?.participants ?? []) as ConversationParticipant[]).map((member) => relayMemberKey(member)),
      ];
      const key = keys.find((k) => hashRecipientKey(k) === ref.recipientKeyHash);
      if (key === undefined) return undefined;
      const owner: SendAttemptOwner =
        ref.kind === 'relay_leg'
          ? { kind: 'relay_leg', relayConversationId: ref.relayConversationId, sourceTsMsgId: ref.sourceTsMsgId, memberKey: key }
          : { kind: 'relay_rung', relayConversationId: ref.relayConversationId, retryTsMsgId: ref.retryTsMsgId, memberKey: key };
      return {
        owner,
        key,
        ...(row !== undefined && { row }),
        ...(conversation !== undefined && { conversation }),
      };
    }
    case 'retry_send': {
      // retry-send-adoption R4: the RETRIED row, consistently (the owner names
      // it; the root is only a fact and is not read), and the thread
      // (eventual, as the relay owners accept). The raw recipient key is
      // RE-DERIVED from the same immutable data the job keyed on (R1) and must
      // hash to the reference's: a mismatch, or no key to derive, is
      // unaddressable - left for the sweeper, as any unresolvable owner is.
      const row = await c.messages.getByTsMsgIdConsistent(ref.conversationId, ref.retriedTsMsgId);
      if (row === undefined) return undefined;
      const conversation = await c.conversations.getById(ref.conversationId);
      const key = retryRecipientKey(row, conversation);
      if (key === undefined || hashRecipientKey(key) !== ref.recipientKeyHash) return undefined;
      const owner: RetrySendOwner = {
        kind: 'retry_send',
        conversationId: ref.conversationId,
        retriedTsMsgId: ref.retriedTsMsgId,
        attempt: ref.attempt,
        recipientKey: key,
        retryRoot: ref.retryRoot,
      };
      return { owner, key, row, ...(conversation !== undefined && { conversation }) };
    }
    default:
      return unhandledOwner(ref);
  }
}

/** A broadcast recipient's (or a contact-keyed retry attempt's) contact, read once per check (consistently where the repo can). */
async function contactOf(c: Ctx, r: Resolved): Promise<ContactItem | undefined> {
  if (r.contact === undefined) r.contact = (await resolveContact(c.contacts, r.key)) ?? null;
  return r.contact ?? undefined;
}

/** The number the recipient has NOW (spec D12): what the lookup lists by and the digest proves. */
async function currentPhone(c: Ctx, r: Resolved): Promise<string | undefined> {
  switch (r.owner.kind) {
    case 'broadcast': {
      // A phone-keyed recipient's number IS its key - no contact read, so no
      // byPhone GSI read decides it (D11; code review C-8, fix FW1-9), as the
      // relay branch does for a phone-only member.
      if (r.key.startsWith('phone#')) return r.key.slice('phone#'.length);
      const phone = (await contactOf(c, r))?.phone;
      return typeof phone === 'string' && phone.length > 0 ? phone : undefined;
    }
    case 'relay_leg':
    case 'relay_rung': {
      // The roster member's number (what the leg sent to); a phone-only
      // member's key IS its number. A contact member off the roster has none.
      const phone = rosterMember(r)?.phone;
      if (typeof phone === 'string' && phone.length > 0) return phone;
      return r.key.startsWith('phone#') ? r.key.slice('phone#'.length) : undefined;
    }
    case 'retry_send': {
      // The thread's number (what the retry went to): a one-to-one thread's
      // participant phone never changes (R1's stated assumption), so a changed
      // or missing one fails the digest - unresolved digest_mismatch.
      const phone = r.conversation?.participant_phone;
      return typeof phone === 'string' && phone.length > 0 ? phone : undefined;
    }
    default:
      return unhandledOwner(r.owner);
  }
}

// ---------------------------------------------------------------------------
// The lookup (spec D13)
// ---------------------------------------------------------------------------

/**
 * Is `m` this attempt's message? Its fingerprint must EQUAL this attempt's
 * (spec D13, lossy): the normalized body's hash AND the media count, for every
 * body. A short body (a media- or emoji-only text) no longer matches any short
 * candidate (S3b F-2, fix FW1-3 - a declared spec-text deviation extending
 * S3a deviation 1): two short-named members' photo legs would adopt each
 * other's photos. Safe in one direction only, which is the point: an own
 * orphan that does not match is an UNMATCHED candidate - unresolved at the
 * final check, never never_sent - so this rule cannot cause a re-send, and
 * the STOP auto-reply still never matches.
 */
function matches(record: SendAttemptFacts, m: ProviderMessageSummary): boolean {
  return m.mediaCount === record.mediaCount && bodyFingerprint(m.body).hash === record.bodyHash;
}

/**
 * Could an attempt with facts `a` have claimed the message an attempt with
 * facts `b` sent? Exactly `matches` seen from the other side (body hash AND
 * media count) - so the D13 same-fingerprint rule withholds never_sent from
 * every sibling whose own lookup might hold our message.
 */
function sameFingerprint(a: SendAttemptFacts, b: SendAttemptFacts): boolean {
  return a.mediaCount === b.mediaCount && a.bodyHash === b.bodyHash;
}

function holderOf(held: Held): string {
  return held.kind === 'other' || held.kind === 'system' ? held.holder : 'unknown';
}

/**
 * Who holds a provider SID, from strongly consistent reads (D11, D13): the
 * `syssid#` system-send marker, a `relaysid#` pointer (this relay owner's
 * exact source/retry row and member -> mine), or a `sid#` row (this
 * broadcast recipient's by isBroadcastRowFor -> mine). `holder` is a log-safe
 * description of the other owner (build finding T10-4: keys via safeRecipientKey).
 */
async function heldBy(c: Ctx, r: Resolved, sid: string): Promise<Held> {
  const system = await c.messages.getSystemSidMarkerConsistent(sid);
  if (system !== undefined) return { kind: 'system', holder: `syssid:${system.kind}` };
  const pointer = await c.messages.getRelaySidPointerConsistent(sid);
  if (pointer !== undefined) {
    const o = r.owner;
    if (
      (o.kind === 'relay_leg' || o.kind === 'relay_rung') &&
      pointer.conversationId === o.relayConversationId &&
      pointer.tsMsgId === relayRowKey(o) &&
      pointer.memberKey === r.key
    ) {
      return { kind: 'mine' };
    }
    return { kind: 'other', holder: `relay#${pointer.conversationId}#${pointer.tsMsgId}#${safeRecipientKey(pointer.memberKey)}` };
  }
  const row = await c.messages.getByProviderSidConsistent(sid);
  if (row === undefined) return { kind: 'free' };
  if (await rowIsMine(c, r, row)) return { kind: 'mine' };
  return { kind: 'other', holder: rowHolder(row) };
}

/**
 * Is this `sid#` row the owner's OWN message? A broadcast recipient's by
 * isBroadcastRowFor. A retry attempt's when the row is the retry that very
 * attempt appended - its lineage names the retried row and the attempt
 * (retry-send-adoption R4: the row sendMessage appended before a record-phase
 * failure, adopted as a repair). Any other row - the ORIGINAL message
 * included, whose row carries no such lineage (Review Focus 2) - is someone
 * else's. A relay owner's messages are addressed by their relaysid# pointer,
 * never by a sid# row.
 */
async function rowIsMine(c: Ctx, r: Resolved, row: MessageItem): Promise<boolean> {
  switch (r.owner.kind) {
    case 'broadcast': {
      const contact = await contactOf(c, r);
      return isBroadcastRowFor(row, {
        broadcastId: r.owner.broadcastId,
        contactId: contact?.contactId,
        slotTsMsgId: r.broadcast?.recipients?.[r.key]?.tsMsgId,
      });
    }
    case 'relay_leg':
    case 'relay_rung':
      return false;
    case 'retry_send':
      return isRetryRowOf(row, r.owner);
    default:
      return unhandledOwner(r.owner);
  }
}

/** retry-send-adoption R4: the retry row THIS attempt produced - its thread, its retried row and its attempt number. */
function isRetryRowOf(row: Pick<MessageItem, 'conversationId' | 'retry_of' | 'retry_attempt'>, o: RetrySendOwner): boolean {
  return row.conversationId === o.conversationId && row.retry_of === o.retriedTsMsgId && row.retry_attempt === o.attempt;
}

/**
 * A log-safe name for the row that holds a SID. A share's OWN row (a
 * broadcast_id and no retry_of) is named by the share and its contact; every
 * other row by its thread and key - a share-RETRY row carries the share's
 * broadcast_id too (retry-send-adoption R7) but is never the share slot's own
 * row (build worklist item 10).
 */
function rowHolder(row: MessageItem): string {
  return row.broadcast_id !== undefined && row.retry_of === undefined
    ? `broadcast#${row.broadcast_id}#${row.recipient_contact_id ?? '-'}`
    : `message#${row.conversationId}#${row.tsMsgId}`;
}

/**
 * Adopt `m` for this owner (spec D15): its own SID claim decides; `other` =
 * someone else's message. `facts` are THIS attempt's, as the check read its
 * record - the lookup matched `m` against them, and a retry adoption reads
 * what the attempt sent from them (plan deviation 9).
 */
async function adopt(c: Ctx, r: Resolved, facts: SendAttemptFacts, m: ProviderMessageSummary): Promise<Found | { kind: 'other' }> {
  switch (r.owner.kind) {
    case 'broadcast': {
      const result = await adoptBroadcastRecipient(c.adopt, {
        broadcastId: r.owner.broadcastId,
        contactKey: r.key,
        providerSid: m.providerSid,
        providerTs: m.createdAt,
        providerStatus: m.providerStatus,
        ...(m.errorCode !== undefined && { errorCode: m.errorCode }),
        body: m.body,
        mediaCount: m.mediaCount,
        ...(m.sentAt !== undefined && { sentAt: m.sentAt }),
      });
      if (result === 'other_owner') return { kind: 'other' };
      return { kind: 'found', sid: m.providerSid, adoption: result, status: mapTwilioStatus(m.providerStatus) };
    }
    case 'relay_leg':
    case 'relay_rung':
      return adoptRelay(c, r, r.owner, m);
    case 'retry_send':
      return adoptRetry(c, r, r.owner, facts, m);
    default:
      return unhandledOwner(r.owner);
  }
}

/**
 * retry-send-adoption R4: adopt the message the provider holds for a retry
 * attempt as the retry row `sendMessage` would have appended - through the
 * same `messagesRepo.append`, so the retrychild# pointer rides the
 * transaction - with the lineage AT append (retry_of, retry_attempt,
 * retry_window_start: RSW relay B1 #2), the chain root and the share
 * attribution (Branch B's fields), and the send's own flags: the retried
 * row's author (`ai` stays `ai`) and `automated` (a row without the flag is
 * automated, RSW relay B4). The body is the retried row's - what the job sent.
 * Media rides only when the ATTEMPT sent media, by its record's mediaCount
 * (plan deviation 9): the retried row's durable attachments when it has
 * them, else its raw mediaUrls seam; never a stored presigned URL.
 * `recipient_contact_id` only while the recorded contact, read once, exists
 * undeleted and holds the thread's number (sendMessage's rule).
 *
 * Idempotent: a dedupe onto THIS attempt's own row is `skipped` (a repair);
 * onto any other row it is someone else's message (`other`), and nothing
 * more is written. Then the audit row (a fresh append only), the
 * status-preserving inbox touch (never backwards) and the emits. No slot, no
 * finalize and NO promise write: the retried row's promise expires on RSW's
 * clock, as after a direct success. An adopted terminal failure is recorded
 * honestly and WARNed - the webhook's 30003 decision never ran for it, so the
 * ladder does not continue from it (stated, not worked around).
 */
async function adoptRetry(
  c: Ctx,
  r: Resolved,
  o: RetrySendOwner,
  facts: SendAttemptFacts,
  m: ProviderMessageSummary,
): Promise<Found | { kind: 'other' }> {
  const retried = r.row;
  if (retried === undefined) throw new Error('send.reconcile: a retry adoption has no resolved retried row');
  const line: LogBase = { event: 'send_reconcile', owner: ownerLog(o), recipientKey: safeRecipientKey(r.key), sid: m.providerSid };
  const mediaWent = facts.mediaCount > 0;
  const attachments = mediaWent ? mediaAttachmentsOf(retried) : [];
  const rawMediaUrls =
    mediaWent && attachments.length === 0 && retried.mediaUrls !== undefined && retried.mediaUrls.length > 0
      ? retried.mediaUrls
      : undefined;
  const status = mapTwilioStatus(m.providerStatus);
  const failed = status === 'failed' || status === 'undelivered';
  const errorCode = failed ? m.errorCode : undefined;
  const transport = m.mediaCount > 0 ? 'mms' : 'sms';
  const author = retried.author === 'ai' ? 'ai' : 'teammate';
  const automated = retried.automated ?? true;
  // A phone key names no contact; a contact key is read once per check (contactOf caches it).
  const participantPhone = r.conversation?.participant_phone;
  let recipientContactId: string | undefined;
  if (!r.key.startsWith('phone#') && typeof participantPhone === 'string' && participantPhone.length > 0) {
    const contact = await contactOf(c, r);
    if (contact !== undefined && !isDeleted(contact) && contactHoldsPhone(contact, participantPhone)) {
      recipientContactId = contact.contactId;
    }
  }
  const windowStart = oneToOneRetryWindowOrigin(retried);
  const appended = await c.messages.append({
    conversationId: o.conversationId,
    providerSid: m.providerSid,
    providerTs: m.createdAt,
    type: transport,
    direction: 'outbound',
    author,
    ...(retried.body !== undefined && { body: retried.body }),
    ...(attachments.length > 0 && { mediaAttachments: attachments }),
    ...(rawMediaUrls !== undefined && { mediaUrls: rawMediaUrls }),
    deliveryStatus: status,
    ...(errorCode !== undefined && { errorCode }),
    transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
    requestedTransport: transport,
    automated,
    ...(recipientContactId !== undefined && { recipientContactId }),
    retryOf: o.retriedTsMsgId,
    retryAttempt: o.attempt,
    ...(typeof windowStart === 'string' && { retryWindowStart: windowStart }),
    retryRoot: o.retryRoot,
    ...(retried.broadcast_id !== undefined && { broadcastId: retried.broadcast_id }),
  });
  // share-sent-outcome D2: the send-time contact the found row names (the
  // ledger's contact for a phone-keyed share slot) - this append's, or on a
  // repair the stored row's own.
  let foundRecipient = recipientContactId;
  if (appended.deduped) {
    // A dedupe is not by itself "lost": the stored row is read consistently, and only THIS attempt's own row is a repair.
    const existing = await c.messages.getByProviderSidConsistent(m.providerSid);
    if (existing === undefined) {
      throw new Error(`send.reconcile: the row for ${m.providerSid} deduped but cannot be read back`);
    }
    if (!isRetryRowOf(existing, o)) return { kind: 'other' };
    foundRecipient = existing.recipient_contact_id;
  } else {
    // The send wrapper's audit row, once per message: a repaired row was audited by the send that wrote it.
    try {
      await c.adopt.audit.append(`conversations#${appended.conversationId}`, 'message_sent', {
        providerSid: m.providerSid,
        automated,
        author,
      });
    } catch (err) {
      c.log.error({ err, ...line }, 'send.reconcile: the retry adoption audit row failed (best-effort) - the adoption stands');
    }
  }
  // The status-preserving touch with no preview (the broadcast adoption's shape): never moves the inbox backwards.
  let touched: ConversationItem | undefined;
  try {
    const current = r.conversation ?? (await c.conversations.getById(appended.conversationId));
    if (current !== undefined && (current.last_activity_at ?? '') < m.createdAt) {
      touched = await c.conversations.touchLastActivityPreservingStatus(appended.conversationId, undefined, m.createdAt);
    }
  } catch (err) {
    c.log.error({ err, ...line }, 'send.reconcile: the inbox touch after a retry adoption failed (best-effort) - the adoption stands');
  }
  c.events.emit('message.persisted', {
    conversationId: appended.conversationId,
    tsMsgId: appended.tsMsgId,
    direction: 'outbound',
    deliveryStatus: status,
  });
  if (touched !== undefined) c.events.emit('conversation.updated', toConversationUpdatedEvent(touched));
  if (failed) {
    c.log.warn(
      { ...line, deliveryStatus: status, errorCode },
      'send.reconcile: adopted terminal failure on a retry row - the 30003 ladder does not continue from it',
    );
  }
  return {
    kind: 'found',
    sid: m.providerSid,
    adoption: appended.deduped ? 'skipped' : 'adopted',
    status,
    // share-sent-outcome D2: the attempt the found arm writes onto a share's
    // original slot - the persisted row (on a dedupe, the first write's key),
    // its code, the provider's date_sent as the carrier instant (as the share
    // adoption maps it) and the row's send-time contact.
    tsMsgId: appended.tsMsgId,
    ...(errorCode !== undefined && { errorCode }),
    ...(m.sentAt !== undefined && { carrierSentAt: m.sentAt }),
    ...(foundRecipient !== undefined && { recipientContactId: foundRecipient }),
  };
}

/**
 * A relay owner's adoption (D15), each write idempotent. FIRST the SID claim:
 * the conditional `relaysid#` pointer put, which reports a lost claim (`other`
 * - someone else's message). THEN the slot, forward-only and first-write-wins
 * (the owner's own mapping: the provider's queued/accepted/sending stay
 * `queued`, `sent` is sent, `undelivered` is the relay machine's
 * `undelivered`; `sentAt` from the provider's date_sent, else its creation).
 * THEN, only when the slot moved: a leg tells its thread (build ruling A1); a
 * rung makes the status-preserving inbox touch its success path makes
 * (never backwards - T10-12). An adopted terminal failure records the code
 * only - an MMS leg's 30005 says nothing of SMS reachability - and WARNs: the
 * webhook's side effects for it never ran. A row or slot that is gone is a
 * job failure (a genuine retry).
 */
async function adoptRelay(
  c: Ctx,
  r: Resolved,
  owner: RelayOwner,
  m: ProviderMessageSummary,
): Promise<Found | { kind: 'other' }> {
  const conversationId = owner.relayConversationId;
  const tsMsgId = relayRowKey(owner);
  const claim = await c.messages.claimRelaySidPointer(m.providerSid, { conversationId, tsMsgId, memberKey: r.key });
  if (claim === 'other') return { kind: 'other' };
  const status = mapTwilioStatus(m.providerStatus);
  const failed = status === 'failed' || status === 'undelivered';
  const errorCode = failed ? m.errorCode : undefined;
  const result = await c.messages.adoptRelayRecipientIfUnsent(conversationId, tsMsgId, r.key, {
    status,
    sid: m.providerSid,
    sentAt: m.sentAt ?? m.createdAt,
    ...(errorCode !== undefined && { errorCode }),
  });
  if (result === 'missing') {
    throw new Error(`send.reconcile: the relay row or slot to adopt ${m.providerSid} onto is missing`);
  }
  if (result === 'adopted') {
    if (owner.kind === 'relay_leg') announceLeg(c, r, owner, status);
    else await touchInboxForward(c, r, m.createdAt);
    if (failed) {
      c.log.warn(
        {
          event: 'send_reconcile',
          owner: ownerLog(owner),
          recipientKey: safeRecipientKey(r.key),
          sid: m.providerSid,
          deliveryStatus: status,
          errorCode,
        },
        'send.reconcile: adopted terminal failure - webhook side effects skipped',
      );
    }
  }
  return { kind: 'found', sid: m.providerSid, adoption: result, status };
}

/**
 * Build ruling A1: every relay-LEG slot move the job makes tells the open
 * thread, in the status webhook's shape (routes/webhooks/twilio.ts, the relay
 * slot-move emit) and in the source row's direction - the relay thread
 * refetches only on this event.
 */
function announceLeg(
  c: Ctx,
  r: Resolved,
  owner: Extract<SendAttemptOwner, { kind: 'relay_leg' }>,
  deliveryStatus: DeliveryStatus,
): void {
  c.events.emit('message.persisted', {
    conversationId: owner.relayConversationId,
    tsMsgId: owner.sourceTsMsgId,
    direction: r.row?.direction ?? 'inbound',
    deliveryStatus,
  });
}

/**
 * A rung's inbox touch (D15, the relay retry job's shape): status-preserving,
 * no preview, and never backwards - a read-then-write guard (T10-12, accepted
 * residue R1). Best-effort: the adoption already stands.
 */
async function touchInboxForward(c: Ctx, r: Resolved, at: string): Promise<void> {
  if (r.conversation === undefined || (r.conversation.last_activity_at ?? '') >= at) return;
  try {
    await c.conversations.touchLastActivityPreservingStatus(r.conversation.conversationId, undefined, at);
  } catch (err) {
    c.log.error(
      { err, event: 'send_reconcile', owner: ownerLog(r.owner), recipientKey: safeRecipientKey(r.key) },
      'send.reconcile: the inbox touch after a rung adoption failed (best-effort) - the adoption stands',
    );
  }
}

/**
 * The KNOWN-SID path (D13): the send is known to have happened, so there is
 * no digest check and no list - fetch that message and adopt it, unless the
 * SID already belongs to another owner (`sid_held_elsewhere`: it exists, it is
 * never re-sent). A fetch that throws, or finds nothing, is a job failure - a
 * genuine retry, never a verdict.
 */
async function adoptKnown(c: Ctx, r: Resolved, facts: SendAttemptFacts, sid: string): Promise<Verdict> {
  const held = await heldBy(c, r, sid);
  if (held.kind === 'system' || held.kind === 'other') {
    return { kind: 'unresolved', cause: 'sid_held_elsewhere', extra: { sid, heldBy: held.holder } };
  }
  const m = await c.adapter.getMessage(sid);
  if (m === undefined) {
    throw new Error(`send.reconcile: the provider has no message for the known SID ${sid} - a retry decides`);
  }
  const adopted = await adopt(c, r, facts, m);
  if (adopted.kind === 'found') return { ...adopted, path: 'known_sid' };
  return { kind: 'unresolved', cause: 'sid_held_elsewhere', extra: { sid, heldBy: holderOf(await heldBy(c, r, sid)) } };
}

/**
 * retry-send-adoption R4 (the lineage exclusion in the sibling rule): a retry
 * attempt's PREDECESSORS can never hold its message - their outcome is what
 * scheduled it - so they are never its siblings; without this every
 * multi-rung chain would read same_fingerprint_sibling. They are, matched by
 * owner FIELDS (never attemptKey - the predecessor's recipient key is not
 * known here and can differ):
 * - the retry_send record that PRODUCED each automatic row on the retried
 *   row's retry_of path (automaticAncestry: the walk stops at the root, at a
 *   manual row and at a broken link) - its retried row is the walked row's
 *   retry_of and its attempt that row's retry_attempt;
 * - when the chain's root was a share text, that share's own record for this
 *   recipient (the retried row's broadcast_id, this recipient key).
 * The SAME ROOT is not lineage: a manual retry's chain and the original chain
 * keep SOR's protection against each other. Every other owner has none (no
 * reads). At most MAX_SEND_RETRY_ATTEMPTS consistent reads.
 */
async function predecessorMatchers(c: Ctx, r: Resolved): Promise<Array<(owner: SendAttemptOwner) => boolean>> {
  if (r.owner.kind !== 'retry_send' || r.row === undefined) return [];
  const o = r.owner;
  const matchers = (await automaticAncestry(c.messages, r.row)).map(
    (walked) => (owner: SendAttemptOwner) =>
      owner.kind === 'retry_send' &&
      owner.conversationId === o.conversationId &&
      owner.retriedTsMsgId === walked.retry_of &&
      owner.attempt === walked.retry_attempt,
  );
  const broadcastId = r.row.broadcast_id;
  if (broadcastId !== undefined) {
    matchers.push((owner) => owner.kind === 'broadcast' && owner.broadcastId === broadcastId && owner.contactKey === r.key);
  }
  return matchers;
}

/**
 * retry-send-adoption FW2 (planner review A1): the row THIS retry attempt
 * already appended, read through its retrychild# pointer. One retried row has
 * exactly one automatic attempt number, so a child carrying this attempt's
 * number can only be this attempt's own text (sendMessage's append, or an
 * adoption's). ONE consistent Query on the retried row's pointer partition;
 * the FIRST such child (tsMsgId order) is read consistently and answers
 * `found` from the row itself - its SID and its delivery status, adoption
 * `skipped` (the row exists: no provider call, no append, no second row),
 * path `lookup`. A pointer whose row cannot be read is an anomaly (the
 * pointer rides the row's own transaction): ONE WARN, and the lookup goes on
 * unchanged. Undefined when there is no such child.
 */
async function ownRetryRow(c: Ctx, r: Resolved, o: RetrySendOwner, checkNo: number): Promise<Verdict | undefined> {
  const children = await c.messages.listRetryChildrenConsistent(o.conversationId, o.retriedTsMsgId);
  const child = children.find((pointer) => pointer.retryAttempt === o.attempt);
  if (child === undefined) return undefined;
  const row = await c.messages.getByTsMsgIdConsistent(o.conversationId, child.tsMsgId);
  if (row === undefined) {
    c.log.warn(
      { event: 'send_reconcile', owner: ownerLog(o), recipientKey: safeRecipientKey(r.key), checkNo, childTsMsgId: child.tsMsgId },
      "send.reconcile: a retrychild# pointer names this attempt's retry row but the row cannot be read - the lookup goes on",
    );
    return undefined;
  }
  return {
    kind: 'found',
    sid: row.provider_sid,
    adoption: 'skipped',
    status: row.delivery_status,
    path: 'lookup',
    // share-sent-outcome D2: the row itself is the attempt. A stored row keeps
    // no carrier instant, but a row reaches `sent` only through the carrier's
    // sent callback: a `sent` row is carrier-confirmed at no earlier than its
    // own provider instant (code review ADV-5), so mapAdopted records a Sent
    // slot, never a Sending one.
    tsMsgId: row.tsMsgId,
    ...(row.error_code !== undefined && { errorCode: row.error_code }),
    ...(row.delivery_status === 'sent' && ownRowCarrierInstant(row.tsMsgId)),
    ...(row.recipient_contact_id !== undefined && { recipientContactId: row.recipient_contact_id }),
  };
}

/** The carrier instant a `sent` row's own key carries (the provider ISO before the first `#`), or nothing. */
function ownRowCarrierInstant(tsMsgId: string): { carrierSentAt?: string } {
  const at = attemptKeyTimestampMs(tsMsgId);
  return at === undefined ? {} : { carrierSentAt: new Date(at).toISOString() };
}

/**
 * The LOOKUP path (D12, D13). List the provider's messages to the recipient's
 * CURRENT number from the attempt's sender - proven to be the number the
 * attempt went to by the digest - walking at most RECONCILE_MAX_PAGES pages,
 * and keep those created inside the window [attemptedAt -
 * RECONCILE_WINDOW_LEAD_MS, attemptedAt + RECONCILE_WINDOW_TRAIL_MS].
 * Oldest first: a SID another owner holds (a sibling record, a pointer, a
 * row, the system marker) is skipped; one this owner holds is a repair; a
 * matching free candidate is claimed, and the first claim that wins is
 * `found`. A provider error ends the walk; what it read is still judged, and
 * a judging that returns no verdict of its own yields the error as this
 * check's result (continue; unresolved at the last check) - never
 * never_sent. Only the job's own reads and writes throw.
 */
async function lookup(c: Ctx, r: Resolved, record: SendAttemptRecord, checkNo: number): Promise<Verdict> {
  // FIRST, for a retry attempt: its OWN row (FW2, planner review A1). The
  // retrychild# pointer is local, strongly consistent proof that this
  // attempt's text exists, so it wins over every verdict below - the
  // no_sender and digest closes (which would WITHDRAW the promise beside an
  // existing retry row) and whatever the provider list answers (a message
  // created after the window, an unreachable provider). Other owner kinds pay
  // no read.
  if (r.owner.kind === 'retry_send') {
    const own = await ownRetryRow(c, r, r.owner, checkNo);
    if (own !== undefined) return own;
  }
  const last = checkNo >= RECONCILE_CHECK_DELAYS_MS.length - 1;
  const sender = record.sender;
  if (sender === undefined) return { kind: 'unresolved', cause: 'no_sender' };
  const phone = await currentPhone(c, r);
  if (phone === undefined || recipientDigest(sender, phone) !== record.recipientDigest) {
    return { kind: 'unresolved', cause: 'digest_mismatch' };
  }
  // THE WINDOW is two-sided (code review C-1, fix FW1-2): our message can only
  // have been created while our request was in flight, which starts at the
  // attempt's last re-arm - so a check that runs late (a redelivery, a
  // backlogged worker) never adopts a message a LATER attempt created.
  const attemptMs = Date.parse(record.attemptedAt);
  const windowStartMs = attemptMs - RECONCILE_WINDOW_LEAD_MS;
  const windowEndMs = attemptMs + RECONCILE_WINDOW_TRAIL_MS;
  // SIBLINGS: other attempts to the same number from the same sender whose
  // windows overlap this one (their starts within RECONCILE_SIBLING_SPAN_MS of
  // ours, either side) - any of them could have claimed a message in our
  // window, or we one in theirs (S3b F-1). Compared by RECORD identity
  // (attemptKey), never ownerKey: two contacts on one phone in one share are
  // two records (R3 #5). The index is sorted by attempt start; the records
  // are LIVE. Read once. This attempt's PREDECESSORS are never siblings
  // (retry-send-adoption R4, the lineage exclusion): that applies to both
  // uses below - the SID skip and the same-fingerprint rule.
  const self = attemptKey(r.owner);
  const predecessors = await predecessorMatchers(c, r);
  const siblingFromMs = attemptMs - RECONCILE_SIBLING_SPAN_MS;
  const siblingToMs = attemptMs + RECONCILE_SIBLING_SPAN_MS;
  const siblings = (await c.attempts.listByRecipient(sender, record.recipientDigest, new Date(siblingFromMs).toISOString())).filter(
    (s) => {
      const startMs = Date.parse(s.attemptedAt);
      return (
        attemptKey(s.owner) !== self &&
        !predecessors.some((isPredecessor) => isPredecessor(s.owner)) &&
        startMs >= siblingFromMs &&
        startMs <= siblingToMs
      );
    },
  );
  const siblingSids = new Set(siblings.flatMap((s) => (s.sid !== undefined ? [s.sid] : [])));

  const bySid = new Map<string, ProviderMessageSummary>();
  let pageToken: string | undefined;
  let pages = 0;
  // THE EARLY STOP (code review ADV-4, fix FW1-6; narrowed by round 2's
  // R2C-1 / F-1, fix FW4-1). The list is newest-first, but that order is
  // UNVERIFIED against real Twilio (spec Sec 10). The stop fires once a page's
  // oldest message is older than the window's start while every page READ so
  // far is non-increasing in createdAt - inside itself, and not newer than
  // the previous page's last message. What that MAY prove: the pages read are
  // in createdAt order and have walked behind the window, so IF the unread
  // pages keep that order none of them holds a candidate. What it may NOT
  // prove: that they do - a list sorted on ANOTHER key passes the check and
  // still holds a newer message on a later page (Twilio documents DateSent; a
  // still-queued orphan has none and may sort last). So the stop only DEFERS:
  // it runs on the checks BEFORE the last, where a miss is followed by
  // another check, and saves their cost (one page, not RECONCILE_MAX_PAGES,
  // for a recipient with heavy OLD history). The LAST check never stops
  // early: it walks on to the list's end or the page bound (unless a list
  // call fails first), and never_sent needs that COMPLETE walk. An
  // unordered list never stops early.
  let newestFirst = true;
  let previousLastMs: number | undefined;
  // A walk CUT at the bound (a page still pending after RECONCILE_MAX_PAGES
  // pages) still judges what it read, at every check: an adoptable candidate
  // is real whatever the unread pages hold. It never rules never_sent.
  let cut = false;
  // A walk ENDED by a failed list call - at any page, at any check - still
  // judges what it read, as a cut walk does (code review round 3, NEW-1; fix
  // FW5-1): a page the walk adds can only ADD evidence, never discard what
  // it read. A judging that returns no verdict of its own gives way to the
  // error (below). A failure on page 1 reads nothing: the error alone.
  let listFailure: { err: unknown } | undefined;
  do {
    let page: ListMessagesPage;
    try {
      page = await c.adapter.listMessages({
        to: phone,
        from: sender,
        pageSize: RECONCILE_LIST_PAGE_SIZE,
        ...(pageToken !== undefined && { pageToken }),
      });
    } catch (err) {
      listFailure = { err };
      break;
    }
    pages += 1;
    const times = page.messages.map((m) => Date.parse(m.createdAt));
    for (const [i, m] of page.messages.entries()) {
      const createdMs = times[i]!;
      if (createdMs >= windowStartMs && createdMs <= windowEndMs && !bySid.has(m.providerSid)) bySid.set(m.providerSid, m);
    }
    newestFirst &&= times.every((t, i) => t <= (i === 0 ? (previousLastMs ?? t) : times[i - 1]!));
    const oldestMs = times.length > 0 ? times[times.length - 1] : undefined;
    if (oldestMs !== undefined) previousLastMs = oldestMs;
    if (!last && newestFirst && oldestMs !== undefined && oldestMs < windowStartMs) break;
    pageToken = page.nextPageToken;
    if (pageToken !== undefined && pages >= RECONCILE_MAX_PAGES) {
      cut = true;
      break;
    }
  } while (pageToken !== undefined);

  const candidates = [...bySid.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let unmatched = 0;
  for (const m of candidates) {
    if (siblingSids.has(m.providerSid)) continue;
    const held = await heldBy(c, r, m.providerSid);
    if (held.kind === 'system' || held.kind === 'other') continue;
    if (held.kind === 'free' && !matches(record, m)) {
      unmatched += 1;
      continue;
    }
    const adopted = await adopt(c, r, record, m);
    if (adopted.kind === 'found') return { ...adopted, path: 'lookup' };
    if (held.kind === 'mine') {
      // Ours by its pointer or row, yet the claim says otherwise: a race to
      // another owner. The message exists - it is never re-sent.
      return {
        kind: 'unresolved',
        cause: 'sid_held_elsewhere',
        extra: { sid: m.providerSid, heldBy: holderOf(await heldBy(c, r, m.providerSid)) },
      };
    }
    // A free match whose claim another attempt won: someone else's. Next.
  }
  // Nothing adopted. A walk a list error ended returns that error, ahead of
  // every cause below (the error is why the walk is incomplete): before the
  // last check it continues provider_error and the next check lists again;
  // at the last check it is unresolved provider_unreachable - never
  // never_sent. Otherwise, before the last check a miss only defers (the
  // provider may list more, or a shorter list, later) - a cut walk names the
  // bound. At the last check a cut walk is the page_bound residue -
  // unresolved, never never_sent; only a COMPLETE walk goes on to the causes
  // below.
  if (listFailure !== undefined) {
    return last
      ? { kind: 'unresolved', cause: 'provider_unreachable', extra: { err: listFailure.err } }
      : { kind: 'continue', reason: 'provider_error', err: listFailure.err };
  }
  if (!last) return cut ? { kind: 'continue', reason: 'page_bound' } : { kind: 'continue', reason: 'nothing_adoptable' };
  if (cut) return { kind: 'unresolved', cause: 'page_bound', extra: { pages } };
  if (unmatched > 0) return { kind: 'unresolved', cause: 'unidentified_candidate', extra: { unmatched } };
  // D13: never_sent is withheld while a sibling that could have claimed our
  // message is still open or adopted one in the window - re-driving on that
  // ambiguity is how one photo goes twice and another never.
  if (siblings.some((s) => sameFingerprint(s, record) && (s.state !== 'done' || s.outcome === 'adopted'))) {
    return { kind: 'unresolved', cause: 'same_fingerprint_sibling' };
  }
  return { kind: 'never_sent' };
}

// ---------------------------------------------------------------------------
// The verdicts' writes (spec D16). The job's OWN closes are exempt from the
// D8 gate: they close the attempt they own. Each writes the RECORD first,
// fenced on this chain's state and attemptedAt, and touches the slot only
// when that close won (code review ADV-2, fix FW1-4 - a declared deviation
// from D8's "slot FIRST"): a duplicate check that loses its record close to a
// re-drive that is already sending can no longer mark that send's slot
// unconfirmed. Crash safety moves to the superseded exit: a redelivery that
// finds the record `done` for its own attempt re-applies the slot close the
// outcome implies (`slotCloseOf`), which is idempotent.
// ---------------------------------------------------------------------------

/** The slot close each job-owned record close implies - what a redelivery re-applies (FW1-4). */
function slotCloseOf(outcome: SendAttemptOutcome | undefined): { code: string; bucket: 'failed' | 'unconfirmed' } | undefined {
  switch (outcome) {
    case 'unresolved':
      return { code: SEND_UNCONFIRMED_CODE, bucket: 'unconfirmed' };
    case 'redrive_refused':
      return { code: REDRIVE_REFUSED_CODE, bucket: 'failed' };
    case 'enqueue_failed':
      return { code: ENQUEUE_FAILED_CODE, bucket: 'failed' };
    default:
      return undefined;
  }
}

/** Close the recipient's slot `failed` with `code` - only while it still holds no send. */
async function closeSlot(c: Ctx, r: Resolved, code: string, bucket: 'failed' | 'unconfirmed'): Promise<void> {
  switch (r.owner.kind) {
    case 'broadcast': {
      const closed = await c.broadcasts.closeRecipientIfQueued(r.owner.broadcastId, r.key, code, bucket);
      if (closed.moved && closed.item) emitBroadcastProgress(c.events, r.owner.broadcastId, closed.item);
      return;
    }
    case 'relay_leg':
    case 'relay_rung': {
      // An ABSENT slot (a legacy source starts empty) or a queued one with no sid - never a send that landed.
      const closed = await c.messages.closeRelayRecipientIfUnsent(r.owner.relayConversationId, relayRowKey(r.owner), r.key, {
        status: 'failed',
        errorCode: code,
      });
      // A1: a leg's slot move tells its thread; a rung's is announced at its root by afterClose.
      if (closed === 'closed' && r.owner.kind === 'relay_leg') announceLeg(c, r, r.owner, 'failed');
      return;
    }
    case 'retry_send':
      // retry-send-adoption R4 (Cameron's Q1 ruling): a retry has no slot - an
      // UNRESOLVED close WITHDRAWS the retried row's promise instead: the
      // sentinel AND retry_outcome 'unconfirmed' in ONE conditional write,
      // retried once from a fresh read. A row already withdrawn answers
      // 'already' with no write, so the superseded exit's re-apply is
      // idempotent. withdrawRetryPromise never throws; a WITHDRAW it answers
      // 'failed' or 'lost' (after its own ERROR) is THROWN here (code review
      // r1 C-2 - the FW1-4 shape every other owner's slot close has): this
      // check fails, and its redelivery finds the record done for this attempt
      // and re-applies the WITHDRAW through the superseded exit.
      // redrive_refused and enqueue_failed write NOTHING: nothing went out, and
      // the promise expires on its own - possibly REFRESHED - clock (the
      // unknown hand-off's, the re-drive's), so for up to a few minutes after
      // such a close the bubble keeps its promise and the route's time guard
      // answers 409 retry_pending until it expires: the accepted class
      // one-to-one-retry-promise-outlives-job-decline (spec sections 0 and 7).
      // Plan deviation 5: the map lives here, keyed on the code, because
      // slotCloseOf takes no owner.
      if (code === SEND_UNCONFIRMED_CODE && r.row !== undefined) {
        const withdrawn = await withdrawRetryPromise({ messages: c.messages, events: c.events, log: c.log }, r.row, { ...ownerLog(r.owner) });
        if (withdrawn === 'failed' || withdrawn === 'lost') {
          throw new Error(`send.reconcile: the retry promise withdrawal answered '${withdrawn}' - this check fails so its redelivery re-applies it`);
        }
        // share-sent-outcome D2 (sites 1 and 2 - this arm also runs from the
        // superseded exit's re-apply): the WITHDRAW above goes FIRST (the
        // fact the thread and the Retry route depend on), THEN a share
        // retry's ORIGINAL slot records the chain's row-less unresolved end.
        // Bounded, never propagated (plan deviation 11); a re-applied write
        // is a no-op.
        if (typeof r.row.broadcast_id === 'string') {
          await unresolvedShareRetry(c, r, r.owner, r.row, r.row.broadcast_id);
        }
      }
      return;
    default:
      return unhandledOwner(r.owner);
  }
}

/**
 * share-sent-outcome D2: the attempt outcome a retry adoption found, mapped as
 * the share adoption maps a provider status (adoptBroadcastRecipient):
 * delivered -> delivered, with the provider's carrier instant; failed /
 * undelivered -> failed with its code (no promise - an adoption decides no
 * retry); sent (carrier-confirmed) -> sent with the instant; anything else
 * (accepted, queued, sending) -> a bare acceptance.
 */
function mapAdopted(v: Found): AttemptOutcome {
  switch (v.status) {
    case 'delivered':
      return { kind: 'delivered', ...(v.carrierSentAt !== undefined && { carrierSentAt: v.carrierSentAt }) };
    case 'failed':
    case 'undelivered':
      return { kind: 'failed', errorCode: v.errorCode ?? 'unknown' };
    case 'sent':
      return { kind: 'sent', ...(v.carrierSentAt !== undefined && { carrierSentAt: v.carrierSentAt }) };
    default:
      return { kind: 'sent' };
  }
}

/** The WARN of a share-retry slot write that answered 'slot_unmatched' (planner fix wave, adversarial 2), both sites. */
const SLOT_UNMATCHED_MSG =
  "send.reconcile: retry row's conversation has a slot but no matching original pointer - the record phase may be pending or the chain unstamped (the repair re-checks)";

/**
 * share-sent-outcome D2, site 5: the found arm's write for a share retry - the
 * ORIGINAL slot (matched by the share id and the chain root) records the
 * found attempt. A missing share is the transition's own WARN; a root that
 * matches no slot is ONE line - WARN when the share holds a slot for the
 * recipient without the matching original pointer ('slot_unmatched': the
 * record phase pending or the chain unstamped, the repair re-checks), else
 * ERROR, a routing bug; a write that keeps throwing is
 * applyLaterAttemptBounded's ONE ERROR. Nothing propagates.
 */
async function adoptedShareRetry(
  c: Ctx,
  o: RetrySendOwner,
  broadcastId: string,
  v: Found,
  attemptKey: string,
  base: LogBase,
): Promise<void> {
  const applied = await applyLaterAttemptBounded(shareDeps(c), {
    broadcastId,
    conversationId: o.conversationId,
    retryRoot: o.retryRoot,
    attemptKey,
    outcome: mapAdopted(v),
    ...(v.recipientContactId !== undefined && { recipientContactId: v.recipientContactId }),
  });
  if (applied === 'no_slot') {
    // `base` names the owner and the recipient key (redacted).
    c.log.error(
      { ...base, broadcastId, retryRoot: o.retryRoot, attempt: attemptKey },
      'send.reconcile: no matching recipient slot for an adopted share retry - a routing bug',
    );
  } else if (applied === 'slot_unmatched') {
    c.log.warn({ ...base, broadcastId, retryRoot: o.retryRoot, attempt: attemptKey }, SLOT_UNMATCHED_MSG);
  }
}

/**
 * share-sent-outcome D2, sites 1 and 2: after the WITHDRAW of a share retry's
 * unresolved end, the ORIGINAL slot records it as the row-less attempt
 * ordered right after the one retried (send_unconfirmed). Same levels as the
 * adoption's write; nothing propagates.
 */
async function unresolvedShareRetry(c: Ctx, r: Resolved, o: RetrySendOwner, retried: MessageItem, broadcastId: string): Promise<void> {
  const attemptKey = rowlessAttemptKey(o.retriedTsMsgId);
  const applied = await applyLaterAttemptBounded(shareDeps(c), {
    broadcastId,
    conversationId: o.conversationId,
    retryRoot: o.retryRoot,
    attemptKey,
    outcome: { kind: 'unresolved' },
    ...(retried.recipient_contact_id !== undefined && { recipientContactId: retried.recipient_contact_id }),
  });
  if (applied === 'no_slot') {
    c.log.error(
      { event: 'send_reconcile', owner: ownerLog(o), recipientKey: safeRecipientKey(r.key), broadcastId, retryRoot: o.retryRoot, attempt: attemptKey },
      'send.reconcile: no matching recipient slot for an unresolved share retry - a routing bug',
    );
  } else if (applied === 'slot_unmatched') {
    c.log.warn(
      { event: 'send_reconcile', owner: ownerLog(o), recipientKey: safeRecipientKey(r.key), broadcastId, retryRoot: o.retryRoot, attempt: attemptKey },
      SLOT_UNMATCHED_MSG,
    );
  }
}

/**
 * After every close or adoption: the owner's own last word. A broadcast
 * FINALIZES (D16a - idempotent, it defers while any slot is queued). A relay
 * RUNG announces its ROOT (build finding T10-2: the rung job's own
 * announceRootClose is a closure, so it is rebuilt here from the retry row,
 * read consistently) with the status the job just wrote - `failed` on a close,
 * the adopted status on a found - or, when called with none (the superseded
 * exit, ruling A7), the slot's current status. A relay LEG told its thread at
 * the slot move itself (A1). A RETRY attempt announces its retried row
 * (retry-send-adoption R12).
 */
async function afterClose(c: Ctx, r: Resolved, deliveryStatus?: DeliveryStatus): Promise<void> {
  switch (r.owner.kind) {
    case 'broadcast':
      await finalize(c.broadcasts, c.events, r.owner.broadcastId, c.log, c.adopt.audit);
      return;
    case 'relay_leg':
      return;
    case 'relay_rung': {
      const row = await c.messages.getByTsMsgIdConsistent(r.owner.relayConversationId, r.owner.retryTsMsgId);
      const rootTsMsgId = row?.relay_retry_of;
      if (row === undefined || typeof rootTsMsgId !== 'string' || rootTsMsgId.length === 0) {
        c.log.warn(
          { event: 'send_reconcile', owner: ownerLog(r.owner), recipientKey: safeRecipientKey(r.key) },
          'send.reconcile: the retry row names no root - nothing to announce',
        );
        return;
      }
      c.events.emit('message.persisted', {
        conversationId: r.owner.relayConversationId,
        tsMsgId: rootTsMsgId,
        direction: row.direction,
        deliveryStatus: deliveryStatus ?? row.delivery_recipients?.[r.key]?.status ?? 'failed',
      });
      return;
    }
    case 'retry_send':
      // retry-send-adoption R4/R12: no finalize and no root close - the RETRIED
      // row re-renders (its promise, its outcome, the collapse over a new
      // retry row) in its own direction and status, whatever status the close
      // passed.
      if (r.row !== undefined) {
        c.events.emit('message.persisted', {
          conversationId: r.owner.conversationId,
          tsMsgId: r.owner.retriedTsMsgId,
          direction: r.row.direction,
          deliveryStatus: r.row.delivery_status,
        });
      }
      return;
    default:
      return unhandledOwner(r.owner);
  }
}

/**
 * `unresolved` (D16): the record done / unresolved FIRST (fenced on
 * reconciling + attemptedAt); only when that close won, ONE ERROR naming the
 * cause, then the slot failed / send_unconfirmed, then afterClose. The ERROR
 * precedes the slot write so a close that dies there has still logged its
 * verdict once; the redelivery completes the slot (FW1-4). A lost record
 * close is someone else's attempt now: nothing is written.
 */
async function closeUnresolved(
  c: Ctx,
  r: Resolved,
  record: SendAttemptRecord,
  cause: UnresolvedCause,
  base: LogBase,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!(await c.attempts.closeFromReconcile(r.owner, record.attemptedAt, { outcome: 'unresolved', cause }))) {
    c.log.info(
      { ...base, verdict: 'unresolved', cause },
      'send.reconcile: unresolved, but the attempt moved on before the close - nothing closed',
    );
    return;
  }
  c.log.error(
    { ...base, verdict: 'unresolved', cause, ...extra },
    'send.reconcile: unresolved - the platform cannot tell whether this text went out; closed send_unconfirmed, never re-sent',
  );
  await closeSlot(c, r, SEND_UNCONFIRMED_CODE, 'unconfirmed');
  await afterClose(c, r, 'failed');
}

/**
 * Every enqueue the job makes goes through here (D13a). A throw - the hop
 * limit or the queue - closes the recipient on the spot: after a never_sent
 * verdict (the record is `redriven`) it closes `enqueue_failed` - the record
 * FIRST, fenced on `redriven`, and the slot only when that close won, so a
 * pass that claimed the record meanwhile keeps its slot (build finding
 * T10-14); otherwise it closes `unresolved` / enqueue_failed. Returns whether
 * the enqueue went out.
 */
async function enqueueOrClose(
  c: Ctx,
  r: Resolved,
  record: SendAttemptRecord,
  base: LogBase,
  state: 'reconciling' | 'redriven',
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    if (state === 'reconciling') {
      await closeUnresolved(c, r, record, ENQUEUE_FAILED_CODE, base, { err });
      return false;
    }
    const closed = await c.attempts.closeRedriven(r.owner, { outcome: 'enqueue_failed', cause: ENQUEUE_FAILED_CODE });
    if (!closed) {
      c.log.warn(
        { ...base, verdict: 'never_sent', err },
        'send.reconcile: the re-drive enqueue failed after a pass took the record over - nothing closed',
      );
      return false;
    }
    // The ERROR before the slot write, as closeUnresolved (FW1-4): a death at
    // the slot write has logged once, and the redelivery re-applies the slot.
    c.log.error(
      { ...base, verdict: 'never_sent', cause: ENQUEUE_FAILED_CODE, err },
      'send.reconcile: the re-drive enqueue failed - recipient closed enqueue_failed (nothing was sent)',
    );
    await closeSlot(c, r, ENQUEUE_FAILED_CODE, 'failed');
    await afterClose(c, r, 'failed');
    return false;
  }
}

/**
 * The re-drive envelope of each owner: its own send job, for that one
 * recipient, marked `redrive` (the continuation payloads carry raw keys - plan
 * deviation 4). A rung is re-enqueued as ITSELF through plain `enqueue` -
 * never enqueueRelayRetryLeg, which applies the 60/120/240 s ladder - so the
 * rung job's own window check bounds the re-drive (RSW #1).
 */
async function enqueueRedrive(r: Resolved, continuation: SendReconcilePayload['continuation']): Promise<void> {
  switch (r.owner.kind) {
    case 'broadcast': {
      const redrive: BroadcastSendPayload = {
        broadcastId: r.owner.broadcastId,
        recipientKeys: [r.key],
        // Advisory (the durable pass count is fanout_attempt); a re-drive pass claims no rung up front.
        attempt: (r.broadcast?.fanout_attempt ?? 0) + 1,
        redrive: true,
      };
      await enqueue(BROADCAST_SEND_JOB, redrive);
      return;
    }
    case 'relay_leg': {
      if (continuation === undefined) throw new Error('sendReconcile: a relay-leg re-drive needs its continuation');
      const redrive: RelayFanOutPayload = {
        relayConversationId: r.owner.relayConversationId,
        sourceTsMsgId: r.owner.sourceTsMsgId,
        senderKey: continuation.senderKey,
        ...(continuation.senderNameOverride !== undefined && { senderNameOverride: continuation.senderNameOverride }),
        recipientKeys: [r.key],
        attempt: (r.row?.fanout_attempt ?? 0) + 1,
        redrive: true,
      };
      await enqueue(RELAY_FANOUT_JOB, redrive);
      return;
    }
    case 'relay_rung': {
      const redrive: RelayRetryLegPayload = {
        relayConversationId: r.owner.relayConversationId,
        retryTsMsgId: r.owner.retryTsMsgId,
        redrive: true,
      };
      await enqueue(RELAY_RETRY_LEG_JOB, redrive);
      return;
    }
    case 'retry_send': {
      // retry-send-adoption R4: the SAME attempt, re-enqueued NOW through the
      // job's own producer - built from the retried row (never a copied
      // payload) and never `deferred`, so the re-driven run keeps its single
      // deferral. It claims from `redriven` (SOR D8a) and runs R2 again, its
      // window check included. The chain's ONE re-drive: MAX_HOP_COUNT leaves
      // no headroom for another self-enqueue.
      if (r.row === undefined) throw new Error('sendReconcile: a retry re-drive has no resolved retried row');
      await enqueueSendRetry(
        { providerSid: r.row.provider_sid, conversationId: r.owner.conversationId, attempt: r.owner.attempt },
        new Date(),
      );
      return;
    }
    default:
      return unhandledOwner(r.owner);
  }
}

/**
 * D16: a relay re-drive is enqueued only while it could send - the group
 * open, the member on its roster, the source (leg) or retry (rung) row
 * present - and a leg only with the continuation it must repeat. Returns the
 * refusal cause, or undefined. A broadcast re-drive pass runs its own fences.
 * A one-to-one retry (retry-send-adoption R4) is re-driven only while the
 * RSW window still fits it; the re-driven job runs its own gates again.
 */
function redriveRefusal(r: Resolved, continuation: SendReconcilePayload['continuation']): string | undefined {
  switch (r.owner.kind) {
    case 'broadcast':
      return undefined;
    case 'relay_leg':
    case 'relay_rung':
      if (r.owner.kind === 'relay_leg' && continuation === undefined) return 'no_continuation';
      if (r.conversation?.status !== 'open') return 'group_not_open';
      if (rosterMember(r) === undefined) return 'member_removed';
      if (r.row === undefined) return r.owner.kind === 'relay_leg' ? 'source_not_found' : 'retry_row_not_found';
      return undefined;
    case 'retry_send': {
      // retry-send-adoption R4: the WINDOW first, with no backoff (the re-drive
      // goes out now) - RSW D3's scheduling rule, so the re-driven job keeps
      // its grace. An unusable origin fails open (RSW D5).
      if (r.row === undefined) return 'retried_row_not_found';
      const originMs = parseRetryWindowOrigin(oneToOneRetryWindowOrigin(r.row));
      if (originMs !== undefined && !retryFitsSendWindow({ originMs, nowMs: Date.now(), backoffMs: 0 })) {
        return RETRY_WINDOW_CLOSED_CODE;
      }
      return undefined;
    }
    default:
      return unhandledOwner(r.owner);
  }
}

/**
 * A relay never_sent whose re-drive could not send (D16): the record done /
 * redrive_refused FIRST - the job's own close, fenced on reconciling +
 * attemptedAt - and only when it won, one WARN naming the cause (a closed
 * group or a departed member is a human action, not a fault), the slot
 * failed / redrive_refused, then afterClose (FW1-4). A lost record close
 * (a twin chain re-drove the leg) writes nothing. A retry's closed WINDOW is
 * ONE ERROR instead (retry-send-adoption R9): the chain ended without the
 * retry going out.
 */
async function closeRedriveRefused(
  c: Ctx,
  r: Resolved,
  record: SendAttemptRecord,
  cause: string,
  base: LogBase,
): Promise<void> {
  if (!(await c.attempts.closeFromReconcile(r.owner, record.attemptedAt, { outcome: 'redrive_refused', cause }))) {
    c.log.info(
      { ...base, verdict: 'never_sent', cause },
      'send.reconcile: never_sent and the re-drive cannot send, but the attempt moved on before the close - nothing closed',
    );
    return;
  }
  const line = { ...base, verdict: 'never_sent', cause };
  const msg = 'send.reconcile: never_sent, but the re-drive cannot send - recipient closed redrive_refused';
  if (cause === RETRY_WINDOW_CLOSED_CODE) c.log.error(line, msg);
  else c.log.warn(line, msg);
  await closeSlot(c, r, REDRIVE_REFUSED_CODE, 'failed');
  await afterClose(c, r, 'failed');
}

/**
 * `never_sent` (D16): mark the record `redriven` (at most once per recipient:
 * fenced on redriveCount 0) and THEN enqueue the owner's re-drive - a pass
 * that claims the record like any send site (D8a). A record that was already
 * re-driven once cannot be re-driven again: it closes unresolved
 * second_unknown (D13a). A relay re-drive that could not send is refused
 * before the record is touched.
 */
async function redrive(
  c: Ctx,
  r: Resolved,
  record: SendAttemptRecord,
  continuation: SendReconcilePayload['continuation'],
  base: LogBase,
): Promise<void> {
  const refusal = redriveRefusal(r, continuation);
  if (refusal !== undefined) {
    await closeRedriveRefused(c, r, record, refusal, base);
    return;
  }
  if (!(await c.attempts.markRedriven(r.owner, record.attemptedAt))) {
    if (record.redriveCount >= 1) {
      await closeUnresolved(c, r, record, 'second_unknown', base);
      return;
    }
    c.log.info({ ...base, verdict: 'never_sent' }, 'send.reconcile: never_sent, but the attempt moved on before the re-drive was marked');
    return;
  }
  c.log.warn(
    { ...base, verdict: 'never_sent' },
    'send.reconcile: never_sent - the provider holds nothing for this attempt; the recipient is re-driven once',
  );
  const enqueued = await enqueueOrClose(c, r, record, base, 'redriven', () => enqueueRedrive(r, continuation));
  // retry-send-adoption R4: the retried row keeps promising "will retry" while
  // the re-driven job runs - REFRESHED only when the re-drive went out (a
  // failed enqueue closed enqueue_failed and writes no promise), covering the
  // job's grace and the promise's own.
  if (enqueued && r.owner.kind === 'retry_send' && r.row !== undefined) {
    await refreshRetryPromise(
      { messages: c.messages, events: c.events, log: c.log },
      r.row,
      new Date(Date.now() + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS).toISOString(),
      { ...ownerLog(r.owner) },
    );
  }
}
