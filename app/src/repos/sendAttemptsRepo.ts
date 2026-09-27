// app/src/repos/sendAttemptsRepo.ts
// The per-recipient SEND-ATTEMPT RECORD (spec D8a) and its recipient-keyed
// index (spec D8a, second family). Coordination state for a send lives HERE,
// never in the recipient slot: six writers share the slot and two rewrite it
// wholesale. Every transition is a conditional write fenced on the attempt
// (attemptNo + attemptedAt), so a stale writer cannot overwrite a newer
// attempt and a redelivered job converges (D11). EVERY expression below lists
// exactly the aliases and values it uses - DynamoDB rejects an unused one.
//
// Both item families live in the messages table under their own partitions
// and carry the 30-day `expires_at` cleanup horizon (cleanup only, never a
// semantic). A phone-bearing recipient key is hashed before it lands in a KEY
// (hashRecipientKey); the record's `owner` map keeps the raw recipient key,
// which is how a reconcile addresses the recipient's slot.
//
// Every read here is strongly consistent and on the base table (D11): no GSI
// is involved anywhere in the coordination path.
//
// The in-memory twin is the harness fake (`world.sendAttemptsRepo` in
// app/test/helpers/twilioWebhookHarness.ts); the two are held to the same
// answers by app/test/twilioWebhookHarnessSendAttempts.integration.test.ts.
import { TransactionCanceledException, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { hashRecipientKey } from '../lib/sendFingerprint.js';
import { SEND_CLAIM_TTL_MS } from '../lib/sendOutcome.js';
import type { RepoDeps } from './conversationsRepo.js';

/** The record's partition prefix: `sendattempt#<ownerKey>`, sort key = the hashed recipient key. */
export const SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#';
/** The index's partition prefix: `sendattemptix#<sender or ->#<recipientDigest>`. */
export const SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#';
/** The cleanup horizon both families carry in `expires_at` (30 days; TTL is their only reaper). */
export const SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

export type SendAttemptOwner =
  | { kind: 'broadcast'; broadcastId: string; contactKey: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; memberKey: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; memberKey: string };
export type SendAttemptState = 'attempting' | 'reconciling' | 'redriven' | 'done';
export type SendAttemptOutcome =
  | 'sent'
  | 'rejected'
  | 'retryable'
  | 'refused'
  | 'adopted'
  | 'never_sent'
  | 'unresolved'
  | 'enqueue_failed'
  | 'redrive_refused';
/** The facts of THIS attempt a reconcile matches on (D12, D13). `sender` is absent when unset. */
export interface SendAttemptFacts {
  recipientDigest: string;
  sender?: string;
  bodyHash: string;
  bodyShort: boolean;
  mediaCount: number;
}
export interface SendAttemptRecord extends SendAttemptFacts {
  owner: SendAttemptOwner;
  state: SendAttemptState;
  attemptNo: number;
  attemptedAt: string;
  redriveCount: number;
  checkNo: number;
  sid?: string;
  outcome?: SendAttemptOutcome;
  cause?: string;
}
/** The attempt a send site's later writes are fenced on. */
export interface AttemptRef {
  attemptNo: number;
  attemptedAt: string;
}
/**
 * What a claim found (D8a):
 * - `claimed`: this caller owns a NEW attempt (the record is `attempting`
 *   with this claim's attemptNo / attemptedAt); it may call the provider.
 * - `takeover`: the record is `attempting` and OLDER than the claim TTL; the
 *   returned record is that stale attempt, untouched - the caller runs
 *   `takeOver` with it and hands off to a reconcile. Never a send.
 * - `refused`, `fresh: true`: a live attempt owns the recipient (a fresh
 *   `attempting`, or a concurrent claim won the conditional write) - defer.
 * - `refused`, `fresh: false`: `reconciling` (the reconcile owns it) or `done`
 *   with any outcome but `retryable` (terminal) - skip.
 */
export type ClaimResult =
  | { outcome: 'claimed'; record: SendAttemptRecord }
  | { outcome: 'takeover'; record: SendAttemptRecord }
  | { outcome: 'refused'; record: SendAttemptRecord; fresh: boolean };

export interface SendAttemptsRepo {
  claim(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string): Promise<ClaimResult>;
  finishAttempt(
    owner: SendAttemptOwner,
    ref: AttemptRef,
    result: { outcome: SendAttemptOutcome; sid?: string; cause?: string },
  ): Promise<boolean>;
  handToReconcile(owner: SendAttemptOwner, ref: AttemptRef, sid?: string): Promise<boolean>;
  takeOver(owner: SendAttemptOwner, record: SendAttemptRecord): Promise<boolean>;
  recordCheck(owner: SendAttemptOwner, attemptedAt: string, checkNo: number): Promise<boolean>;
  markRedriven(owner: SendAttemptOwner, attemptedAt: string): Promise<boolean>;
  closeFromReconcile(
    owner: SendAttemptOwner,
    attemptedAt: string,
    result: { outcome: 'adopted' | 'unresolved' | 'enqueue_failed' | 'redrive_refused'; sid?: string; cause?: string },
  ): Promise<boolean>;
  closeRedriven(
    owner: SendAttemptOwner,
    result: { outcome: 'refused' | 'redrive_refused' | 'enqueue_failed' | 'unresolved'; cause?: string },
  ): Promise<boolean>;
  get(owner: SendAttemptOwner): Promise<SendAttemptRecord | undefined>;
  /** `sender` is the literal '-' for a sender-less partition (callers pass `record.sender ?? '-'`). */
  listByRecipient(sender: string, recipientDigest: string, sinceIso: string): Promise<SendAttemptRecord[]>;
}

/** The owner WITHOUT the recipient. */
export function ownerKey(owner: SendAttemptOwner): string {
  switch (owner.kind) {
    case 'broadcast':
      return `broadcast#${owner.broadcastId}`;
    case 'relay_leg':
      return `relay#${owner.relayConversationId}#${owner.sourceTsMsgId}`;
    case 'relay_rung':
      return `rung#${owner.relayConversationId}#${owner.retryTsMsgId}`;
  }
}

function recipientKeyOf(owner: SendAttemptOwner): string {
  return owner.kind === 'broadcast' ? owner.contactKey : owner.memberKey;
}

/**
 * The RECORD's identity (owner AND recipient). Sibling comparisons use this,
 * never ownerKey alone: two contacts on one phone in one broadcast are two
 * records.
 */
export function attemptKey(owner: SendAttemptOwner): string {
  return `${ownerKey(owner)}|${hashRecipientKey(recipientKeyOf(owner))}`;
}

function recordKey(owner: SendAttemptOwner): { conversationId: string; tsMsgId: string } {
  return {
    conversationId: `${SEND_ATTEMPT_PARTITION_PREFIX}${ownerKey(owner)}`,
    tsMsgId: hashRecipientKey(recipientKeyOf(owner)),
  };
}

function indexPartition(sender: string | undefined, recipientDigest: string): string {
  return `${SEND_ATTEMPT_INDEX_PREFIX}${sender ?? '-'}#${recipientDigest}`;
}

function expiresAt(nowMs: number): number {
  return Math.floor((nowMs + SEND_ATTEMPT_CLEANUP_MS) / 1000);
}

function toRecord(item: Record<string, unknown>): SendAttemptRecord {
  return {
    owner: item['owner'] as SendAttemptOwner,
    state: item['attempt_state'] as SendAttemptState,
    attemptNo: Number(item['attempt_no']),
    attemptedAt: String(item['attempted_at']),
    redriveCount: Number(item['redrive_count'] ?? 0),
    checkNo: Number(item['check_no'] ?? 0),
    ...(typeof item['sid'] === 'string' && { sid: item['sid'] }),
    ...(typeof item['outcome'] === 'string' && { outcome: item['outcome'] as SendAttemptOutcome }),
    ...(typeof item['cause'] === 'string' && { cause: item['cause'] }),
    recipientDigest: String(item['recipient_digest']),
    // Stored as null when unset (the attribute exists); read back as absent.
    ...(typeof item['sender'] === 'string' && { sender: item['sender'] }),
    bodyHash: String(item['body_hash']),
    bodyShort: item['body_short'] === true,
    mediaCount: Number(item['media_count'] ?? 0),
  };
}

interface Expr {
  update: string;
  condition: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

type ClaimFrom = 'absent' | 'retryable' | 'redriven';

// The claim's record Update. Every branch uses the same SET/REMOVE (which
// names all fifteen aliases, so each branch's condition adds no alias of its
// own); each branch adds ONLY the values its condition names.
const CLAIM_UPDATE =
  'SET #st = :attempting, #no = :no, #at = :at, #exp = :exp, #owner = :owner, #rd = :rd, #sender = :sender, ' +
  '#bh = :bh, #bs = :bs, #mc = :mc, #rc = if_not_exists(#rc, :zero), #ck = :zero REMOVE #sid, #oc, #ca';
const CLAIM_NAMES: Record<string, string> = {
  '#st': 'attempt_state',
  '#no': 'attempt_no',
  '#at': 'attempted_at',
  '#exp': 'expires_at',
  '#owner': 'owner',
  '#rd': 'recipient_digest',
  '#sender': 'sender',
  '#bh': 'body_hash',
  '#bs': 'body_short',
  '#mc': 'media_count',
  '#rc': 'redrive_count',
  '#ck': 'check_no',
  '#sid': 'sid',
  '#oc': 'outcome',
  '#ca': 'cause',
};

/** `prevAttemptNo` is the attemptNo the record holds now (0 when absent). */
function claimExpr(
  from: ClaimFrom,
  owner: SendAttemptOwner,
  facts: SendAttemptFacts,
  nowIso: string,
  prevAttemptNo: number,
): Expr {
  const base: Record<string, unknown> = {
    ':attempting': 'attempting',
    ':no': prevAttemptNo + 1,
    ':at': nowIso,
    ':exp': expiresAt(Date.parse(nowIso)),
    ':owner': owner,
    ':rd': facts.recipientDigest,
    ':sender': facts.sender ?? null,
    ':bh': facts.bodyHash,
    ':bs': facts.bodyShort,
    ':mc': facts.mediaCount,
    ':zero': 0,
  };
  switch (from) {
    case 'absent':
      return { update: CLAIM_UPDATE, condition: 'attribute_not_exists(tsMsgId)', names: CLAIM_NAMES, values: base };
    case 'retryable':
      return {
        update: CLAIM_UPDATE,
        condition: '#st = :done AND #oc = :retryable AND #no = :prevNo',
        names: CLAIM_NAMES,
        values: { ...base, ':done': 'done', ':retryable': 'retryable', ':prevNo': prevAttemptNo },
      };
    case 'redriven':
      return {
        update: CLAIM_UPDATE,
        condition: '#st = :redriven AND #no = :prevNo',
        names: CLAIM_NAMES,
        values: { ...base, ':redriven': 'redriven', ':prevNo': prevAttemptNo },
      };
  }
}

export function createSendAttemptsRepo(deps: RepoDeps = {}): SendAttemptsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('messages', deps.env);

  async function get(owner: SendAttemptOwner): Promise<SendAttemptRecord | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: recordKey(owner), ConsistentRead: true }));
    return Item === undefined ? undefined : toRecord(Item);
  }

  /** A claim never hands back an undefined record (build finding T5-4). */
  async function mustGet(owner: SendAttemptOwner, why: string): Promise<SendAttemptRecord> {
    const record = await get(owner);
    if (record === undefined) {
      throw new Error(`sendAttempts.claim: ${why}, but a consistent read found no record`);
    }
    return record;
  }

  /** true = the claim was written; false = the RECORD's condition failed; anything else throws. */
  async function writeClaim(
    owner: SendAttemptOwner,
    facts: SendAttemptFacts,
    nowIso: string,
    from: ClaimFrom,
    prevAttemptNo: number,
  ): Promise<boolean> {
    const key = recordKey(owner);
    const expr = claimExpr(from, owner, facts, nowIso, prevAttemptNo);
    try {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: key,
                UpdateExpression: expr.update,
                ConditionExpression: expr.condition,
                ExpressionAttributeNames: expr.names,
                ExpressionAttributeValues: expr.values,
              },
            },
            {
              // The recipient index item (D8a): written with the claim, never
              // updated - a reader resolves the record for the live state.
              Put: {
                TableName: table,
                Item: {
                  conversationId: indexPartition(facts.sender, facts.recipientDigest),
                  tsMsgId: `${nowIso}#${ownerKey(owner)}#${key.tsMsgId}`,
                  owner,
                  attempted_at: nowIso,
                  body_hash: facts.bodyHash,
                  body_short: facts.bodyShort,
                  media_count: facts.mediaCount,
                  expires_at: expiresAt(Date.parse(nowIso)),
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      // PRECISE ATTRIBUTION (the messagesRepo append idiom): CancellationReasons
      // is index-aligned with TransactItems, and index 0 is the RECORD update -
      // the only item whose condition failing means "the record is not in the
      // state this claim expected". Anything else - a TransactionConflict with
      // a concurrent claim, a throttle, a validation error - says nothing
      // about the record and is rethrown (a prepare-phase throw for the site).
      if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        return false;
      }
      throw err;
    }
  }

  async function claim(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string): Promise<ClaimResult> {
    if (await writeClaim(owner, facts, nowIso, 'absent', 0)) {
      return { outcome: 'claimed', record: await mustGet(owner, 'the claim was written') };
    }
    // The create's condition failed, so the record exists: decide from its live state.
    const record = await mustGet(owner, 'the create claim lost its condition');
    if (record.state === 'done' && record.outcome === 'retryable') {
      if (await writeClaim(owner, facts, nowIso, 'retryable', record.attemptNo)) {
        return { outcome: 'claimed', record: await mustGet(owner, 'the claim was written') };
      }
      return { outcome: 'refused', record: await mustGet(owner, 'a concurrent claim won'), fresh: true };
    }
    if (record.state === 'redriven') {
      if (await writeClaim(owner, facts, nowIso, 'redriven', record.attemptNo)) {
        return { outcome: 'claimed', record: await mustGet(owner, 'the claim was written') };
      }
      return { outcome: 'refused', record: await mustGet(owner, 'a concurrent claim won'), fresh: true };
    }
    if (record.state === 'attempting') {
      const ageMs = Date.parse(nowIso) - Date.parse(record.attemptedAt);
      return ageMs > SEND_CLAIM_TTL_MS ? { outcome: 'takeover', record } : { outcome: 'refused', record, fresh: true };
    }
    return { outcome: 'refused', record, fresh: false };   // reconciling, or done with a terminal outcome
  }

  async function transition(owner: SendAttemptOwner, expr: Expr): Promise<boolean> {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: recordKey(owner),
          UpdateExpression: expr.update,
          ConditionExpression: expr.condition,
          ExpressionAttributeNames: expr.names,
          ExpressionAttributeValues: expr.values,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  return {
    claim,
    get,
    // The site's own outcome: only the attempt that claimed may close it.
    finishAttempt: (owner, ref, result) =>
      transition(owner, {
        update: `SET #st = :done, #oc = :oc${result.sid !== undefined ? ', #sid = :sid' : ''}${result.cause !== undefined ? ', #ca = :ca' : ''}`,
        condition: '#st = :attempting AND #no = :no AND #at = :at',
        names: {
          '#st': 'attempt_state',
          '#oc': 'outcome',
          '#no': 'attempt_no',
          '#at': 'attempted_at',
          ...(result.sid !== undefined && { '#sid': 'sid' }),
          ...(result.cause !== undefined && { '#ca': 'cause' }),
        },
        values: {
          ':done': 'done',
          ':oc': result.outcome,
          ':attempting': 'attempting',
          ':no': ref.attemptNo,
          ':at': ref.attemptedAt,
          ...(result.sid !== undefined && { ':sid': result.sid }),
          ...(result.cause !== undefined && { ':ca': result.cause }),
        },
      }),
    // An unknown outcome (or a known SID the site could not record): the attempt goes to the reconcile.
    handToReconcile: (owner, ref, sid) =>
      transition(owner, {
        update: `SET #st = :reconciling, #ck = :zero${sid !== undefined ? ', #sid = :sid' : ''}`,
        condition: '#st = :attempting AND #no = :no AND #at = :at',
        names: {
          '#st': 'attempt_state',
          '#ck': 'check_no',
          '#no': 'attempt_no',
          '#at': 'attempted_at',
          ...(sid !== undefined && { '#sid': 'sid' }),
        },
        values: {
          ':reconciling': 'reconciling',
          ':zero': 0,
          ':attempting': 'attempting',
          ':no': ref.attemptNo,
          ':at': ref.attemptedAt,
          ...(sid !== undefined && { ':sid': sid }),
        },
      }),
    // A stale attempt (older than the claim TTL - the caller decided) goes to the reconcile, keeping its attemptedAt.
    takeOver: (owner, record) =>
      transition(owner, {
        update: 'SET #st = :reconciling, #ck = :zero',
        condition: '#st = :attempting AND #no = :no AND #at = :at',
        names: { '#st': 'attempt_state', '#ck': 'check_no', '#no': 'attempt_no', '#at': 'attempted_at' },
        values: { ':reconciling': 'reconciling', ':zero': 0, ':attempting': 'attempting', ':no': record.attemptNo, ':at': record.attemptedAt },
      }),
    // Check n is allowed from n-1 or n (tolerant of its own duplicate), never a skip or a step back.
    recordCheck: (owner, attemptedAt, checkNo) =>
      transition(owner, {
        update: 'SET #ck = :ck',
        condition: '#st = :reconciling AND #at = :at AND (#ck = :prev OR #ck = :ck)',
        names: { '#st': 'attempt_state', '#ck': 'check_no', '#at': 'attempted_at' },
        values: { ':ck': checkNo, ':prev': checkNo - 1, ':reconciling': 'reconciling', ':at': attemptedAt },
      }),
    // A never_sent verdict: at most ONE re-drive per recipient (redriveCount 0 -> 1; a claim never touches it).
    markRedriven: (owner, attemptedAt) =>
      transition(owner, {
        update: 'SET #st = :redriven, #rc = :one',
        condition: '#st = :reconciling AND #at = :at AND #rc = :zero',
        names: { '#st': 'attempt_state', '#rc': 'redrive_count', '#at': 'attempted_at' },
        values: { ':redriven': 'redriven', ':one': 1, ':zero': 0, ':reconciling': 'reconciling', ':at': attemptedAt },
      }),
    closeFromReconcile: (owner, attemptedAt, result) =>
      transition(owner, {
        update: `SET #st = :done, #oc = :oc${result.sid !== undefined ? ', #sid = :sid' : ''}${result.cause !== undefined ? ', #ca = :ca' : ''}`,
        condition: '#st = :reconciling AND #at = :at',
        names: {
          '#st': 'attempt_state',
          '#oc': 'outcome',
          '#at': 'attempted_at',
          ...(result.sid !== undefined && { '#sid': 'sid' }),
          ...(result.cause !== undefined && { '#ca': 'cause' }),
        },
        values: {
          ':done': 'done',
          ':oc': result.outcome,
          ':reconciling': 'reconciling',
          ':at': attemptedAt,
          ...(result.sid !== undefined && { ':sid': result.sid }),
          ...(result.cause !== undefined && { ':ca': result.cause }),
        },
      }),
    // A redriven record belongs to whichever pass reaches it: any pass may close it.
    closeRedriven: (owner, result) =>
      transition(owner, {
        update: `SET #st = :done, #oc = :oc${result.cause !== undefined ? ', #ca = :ca' : ''}`,
        condition: '#st = :redriven',
        names: { '#st': 'attempt_state', '#oc': 'outcome', ...(result.cause !== undefined && { '#ca': 'cause' }) },
        values: { ':done': 'done', ':oc': result.outcome, ':redriven': 'redriven', ...(result.cause !== undefined && { ':ca': result.cause }) },
      }),
    async listByRecipient(sender, recipientDigest, sinceIso) {
      const out: SendAttemptRecord[] = [];
      const seen = new Set<string>();
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'conversationId = :p AND tsMsgId >= :since',
            ExpressionAttributeValues: { ':p': indexPartition(sender, recipientDigest), ':since': sinceIso },
            ScanIndexForward: false,
            ConsistentRead: true,
            Limit: 100,
            ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
          }),
        );
        for (const item of page.Items ?? []) {
          const rec = await get(item['owner'] as SendAttemptOwner);   // the record holds the live state
          if (rec === undefined) continue;
          // One row per RECORD (build finding T5-5): every claim writes its own
          // index item, so an owner claimed twice in the window has two. The
          // first hit is the newest.
          const identity = attemptKey(rec.owner);
          if (seen.has(identity)) continue;
          seen.add(identity);
          out.push(rec);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey !== undefined);
      return out;
    },
  };
}
