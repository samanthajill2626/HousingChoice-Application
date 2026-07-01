// conversations repo — thread headers + inbox index (doc §5).
//
// One ACTIVE 1:1 conversation per external phone: createOrGetByParticipantPhone
// queries the byParticipantPhone GSI as the fast path, with a phone-keyed
// CLAIM item (PK `phone#<E164>`, the same pointer pattern as the messages
// repo's SID items) as the correctness backstop — the GSI is eventually
// consistent, so two near-concurrent first messages can both miss it. Item
// shape is a flexible document; only keys/GSI attributes (conversationId,
// participant_phone, status, last_activity_at) are contractual
// (lib/tables.ts).
//
// Circuit-breaker state (doc §7.1) lives ON the conversation item as a
// minute-bucketed counter pair (outbound_minute_bucket + outbound_minute_count)
// maintained by conditional updates — see incrementAutomatedSendCount().
//
// PII: message bodies/previews must NEVER be logged (doc §9) — log lines here
// carry IDs and lengths only; correlation context is attached by the pino mixin.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/**
 * Conversation thread types (doc §5). `unknown_1to1` (2026-06-12 deviation)
 * mirrors the contact-side honesty rule: a thread with no resolved
 * tenant/landlord identity is typed `unknown_1to1`, never guessed.
 * `relay_group` (M1.7) is a multi-party masked thread fronted by a pool
 * number — inbound on the pool number fans out to the other members.
 */
export type ConversationType =
  | 'tenant_1to1'
  | 'landlord_1to1'
  | 'unknown_1to1'
  | 'relay_group';

/** Phase 2 hands `auto` to the AI; `manual` means humans only (breaker trips here). */
export type ConversationMode = 'auto' | 'manual';

/**
 * A linked external participant (M1.2 auto-capture): contact + phone pair.
 * For relay groups (M1.7) the array is the MUTABLE member roster — the
 * "relay-group seam" the 1:1 comment names — and each member may carry an
 * optional `name`, the sender-prefix display name resolved from the contact
 * at member-add time (absent when no name is known; the fan-out then uses a
 * neutral label and NEVER leaks the sender's phone).
 */
export interface ConversationParticipant {
  contactId: string;
  phone: string;
  /** Sender-prefix display name (relay groups); resolved from the contact, may be absent. */
  name?: string;
}

/** The contractual + commonly read attributes; items stay flexible documents. */
export interface ConversationItem {
  conversationId: string;
  /**
   * External participant's phone, E.164 (byParticipantPhone GSI). 1:1 threads
   * carry a real phone; relay_group threads have no single counterparty, so
   * this is a synthetic placeholder (the pool number) — relay routing goes
   * through pool_number / byPoolNumber, never this field.
   */
  participant_phone: string;
  /**
   * byLastActivity GSI HASH. 1:1 threads only ever write `open`. relay_group
   * threads use `open` | `closed` (close releases the pool number to
   * quarantine; reopen re-provisions one).
   */
  status: string;
  /** byLastActivity GSI RANGE (ISO 8601). */
  last_activity_at: string;
  type: ConversationType;
  ai_mode: ConversationMode;
  /**
   * Pool number fronting a relay_group thread (E.164; byPoolNumber GSI HASH).
   * Set ONLY for relay_group conversations — absent on 1:1 threads, which is
   * what keeps the byPoolNumber GSI sparse. Cleared on close (the number is
   * released to quarantine); re-set on reopen.
   */
  pool_number?: string;
  /**
   * Conversation-level STOP suppression (doc §7.1): set even when the phone
   * has no contact record yet (auto-capture is M1.2), so a STOP from an
   * unknown phone still refuses every later send. The send wrapper gates on
   * EITHER this OR the contact's sms_opt_out flag.
   */
  sms_opt_out?: boolean;
  /** Denormalized preview of the latest message (truncated; never logged). */
  last_message_preview?: string;
  /**
   * Participants → contactIds (doc §5; M1.2 auto-capture). 1:1 threads carry
   * exactly one entry; the array shape is the relay-group seam. Written once
   * via setParticipantsIfAbsent — the auto-capture race anchor.
   */
  participants?: ConversationParticipant[];
  /**
   * Optimistic-concurrency version for the relay roster (FIX 3): bumped on
   * every real add/remove so concurrent roster mutations can't silently
   * clobber each other. Absent until the first mutation (treated as 0).
   */
  participants_version?: number;
  /**
   * Denormalized resolved display name of the 1:1 participant (M1.4 triage):
   * the inbox is ONE Query and the conversation record carries no name, so the
   * resolved "First Last" is copied here when triage names the contact. Absent
   * when no name is known — the inbox falls back to the phone, never a guess.
   */
  participant_display_name?: string;
  /** Inbound messages since the last POST /:id/read (M1.2 unread tracking). */
  unread_count?: number;
  /** Assigned team member's userId (M1.2; users-table validation is M1.3). */
  assignment?: string;
  /**
   * The placement this relay_group is the thread for (M1.10): the
   * conversation→placement BACK-REFERENCE. It lets the voice masked-call seam resolve
   * the landlord-leg target (placement→unit.primary_voice_contact) and the
   * failed-send escalation flag the right placement. Set when a relay is provisioned
   * FROM a placement; absent on 1:1 threads and standalone (test-scaffold) relays.
   */
  placementId?: string;
  created_at: string;
  /** Circuit-breaker minute bucket (`YYYY-MM-DDTHH:mm`, UTC). */
  outbound_minute_bucket?: string;
  /** Automated sends observed within outbound_minute_bucket. */
  outbound_minute_count?: number;
  /**
   * Relay opt-out signal (A2P): members of THIS relay_group who were skipped by
   * the fan-out because they carry contact-level `sms_opt_out` — so staff can be
   * alerted (Today attention item) and investigate/remove them. Keyed by the
   * relayMemberKey (contactId, else `phone#<E164>`); the entry records the member
   * for display + the instant it was observed. The Today endpoint LIVE-CONFIRMS
   * each entry is still opted out, so an opt-back-in / removal auto-resolves the
   * item even before the entry is cleared. Storing phone/name here is DATA (for
   * display) — never logged. Absent on 1:1 threads.
   */
  relay_opted_out_members?: Record<
    string,
    { contactId?: string; phone?: string; name?: string; at: string }
  >;
  [key: string]: unknown;
}

/**
 * Roster mutation lost the optimistic-concurrency race past the retry bound
 * (FIX 3). Routes map this to HTTP 409 — the caller should re-read and retry.
 */
export class RosterConflictError extends Error {
  constructor(conversationId: string) {
    super(`roster update for ${conversationId} conflicted after retries`);
    this.name = new.target.name;
  }
}

/** Bounded retries for the roster optimistic-concurrency loop (FIX 3). */
const ROSTER_MAX_RETRIES = 3;

/** Previews are denormalized inbox furniture, not transcripts — keep them short. */
const PREVIEW_MAX_CHARS = 120;

/** Default inbox page size (GET /api/conversations passes its own limit). */
const DEFAULT_INBOX_PAGE_LIMIT = 50;

export function toPreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  // Truncate by CODE POINTS (Array.from), not UTF-16 units — a string slice
  // could split a surrogate pair (emoji) at the boundary into a lone
  // surrogate that breaks downstream JSON/display.
  const points = Array.from(text);
  return points.length > PREVIEW_MAX_CHARS
    ? `${points.slice(0, PREVIEW_MAX_CHARS - 1).join('')}…`
    : text;
}

/** UTC minute bucket (`2026-06-12T15:04`) for the breaker counter. */
export function minuteBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 16);
}

/**
 * Claim-item partition key for a phone (the per-phone create lock). Claim
 * partitions (`phone#…`) never collide with real `conv-…` partitions.
 */
function phoneClaimPk(phone: string): string {
  return `phone#${phone}`;
}

export interface RepoDeps {
  /** Injectable for tests (throwaway prefixes against DynamoDB Local). */
  doc?: DynamoDBDocumentClient;
  /** Env for tableName() resolution — tests pass a throwaway TABLE_PREFIX. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface ConversationsRepo {
  /**
   * The one active 1:1 conversation for an external phone — found via the
   * byParticipantPhone GSI (fast path), created (status `open`, ai_mode
   * `auto`) when none exists. The GSI is eventually consistent, so creation
   * is arbitrated by a conditional put on a phone-keyed claim item
   * (`phone#<E164>` → ref_conversationId): the winner creates the real row,
   * losers adopt the claimed id — two concurrent firsts can never create two
   * conversations. A crash between claim and row create self-heals on the
   * next call (the claimed id is recreated).
   */
  createOrGetByParticipantPhone(phone: string, type: ConversationType): Promise<ConversationItem>;
  getById(conversationId: string): Promise<ConversationItem | undefined>;
  /**
   * All conversations for an external phone via the byParticipantPhone GSI
   * (M1.4 contact triage: when a contact's type is resolved, the linked
   * conversation's type is propagated). Filters out the phone-claim items
   * (they don't project participant_phone, so they never appear in the GSI —
   * but the filter is defensive). Returns [] when none.
   */
  findByParticipantPhone(phone: string): Promise<ConversationItem[]>;
  /**
   * Set a conversation's type (M1.4 contact triage: unknown_1to1 →
   * tenant_1to1/landlord_1to1 once a human resolves the contact's identity).
   * Returns the post-update item (ALL_NEW) — the fresh inbox row the
   * conversation.updated SSE event is built from. Throws
   * ConditionalCheckFailedException for unknown conversations.
   */
  setType(conversationId: string, type: ConversationType): Promise<ConversationItem>;
  /**
   * M1.4 triage write: set the resolved type (when it changes) and/or the
   * denormalized participant_display_name (when a name is known) in ONE
   * update, returning the post-update item (ALL_NEW) for the
   * conversation.updated SSE event. Pass `displayName: null` to leave the
   * name untouched (only known names are ever written — auto-capture never
   * guesses a name). Throws ConditionalCheckFailedException for unknown
   * conversations.
   */
  applyTriage(
    conversationId: string,
    fields: { type?: ConversationType; displayName?: string | null },
  ): Promise<ConversationItem>;
  /**
   * Stamp the byLastActivity GSI attrs (status + last_activity_at) + preview.
   * Returns the post-update item (ALL_NEW) — the fresh inbox row the M1.2
   * SSE conversation.updated event is built from.
   */
  touchLastActivity(
    conversationId: string,
    previewText: string | undefined,
    ts: string,
  ): Promise<ConversationItem>;
  /**
   * Atomically claim the participants link IFF none exists yet — the M1.2
   * auto-capture race anchor (the conversation row is unique per phone; the
   * contacts byPhone GSI is NOT trustworthy mid-race). True when THIS call
   * set the link; false when a link already existed (read it via getById).
   * Throws when the conversation does not exist.
   */
  setParticipantsIfAbsent(
    conversationId: string,
    participants: ConversationParticipant[],
  ): Promise<boolean>;
  /** Atomic unread bump on a FRESH inbound persist; returns the new count. */
  incrementUnread(conversationId: string): Promise<number>;
  /**
   * Zero the unread counter (POST /:id/read); returns the updated item.
   * Throws ConditionalCheckFailedException for unknown conversations.
   */
  resetUnread(conversationId: string): Promise<ConversationItem>;
  /**
   * Set (string) or clear (null) the assignee. Returns the updated item plus
   * the previous assignee — captured atomically (ALL_OLD) for the
   * assignment_changed audit event. Throws ConditionalCheckFailedException
   * for unknown conversations.
   */
  setAssignment(
    conversationId: string,
    assigneeUserId: string | null,
  ): Promise<{ conversation: ConversationItem; previousAssigneeUserId: string | null }>;
  /**
   * THE inbox read (M1.2): ONE DynamoDB Query on the byLastActivity GSI
   * (status partition, last_activity_at descending) — never a Scan.
   * Pagination via the raw LastEvaluatedKey; routes base64 it into an
   * opaque cursor.
   */
  listByLastActivity(opts: {
    status: string;
    limit?: number;
    exclusiveStartKey?: Record<string, unknown>;
  }): Promise<{ items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> }>;
  setMode(conversationId: string, mode: ConversationMode): Promise<void>;
  /** Set/clear the conversation-level STOP suppression flag (doc §7.1). */
  setSmsOptOut(conversationId: string, value: boolean): Promise<void>;
  /**
   * Circuit-breaker support (doc §7.1): atomically count an automated send
   * against the conversation's CURRENT minute bucket and return the new
   * count. Bucket rollover resets the counter via a conditional-update
   * retry pair (ADD within the bucket; SET on bucket change).
   */
  incrementAutomatedSendCount(conversationId: string, bucket: string): Promise<number>;

  // --- Relay groups (M1.7) -------------------------------------------------

  /**
   * Create a relay_group conversation fronted by `poolNumber` with the given
   * member roster. status `open`, ai_mode `manual` (relay threads are never
   * AI-driven). The pool number doubles as participant_phone (synthetic — see
   * the field comment) so the inbox row renders, and is written to
   * pool_number for the byPoolNumber GSI. `tag` is an optional placement
   * label stored for operators. Returns the created item.
   */
  createRelayGroup(input: {
    poolNumber: string;
    members: ConversationParticipant[];
    tag?: string;
    /** The placement this relay is the thread for (M1.10 back-reference). */
    placementId?: string;
  }): Promise<ConversationItem>;
  /**
   * Resolve a pool number to its active relay_group via the byPoolNumber GSI
   * (the inbound-webhook routing key). Expect 0 or 1 — one ACTIVE relay per
   * pool number is the invariant (a closed relay clears pool_number). Returns
   * the open relay when present, else undefined.
   */
  getByPoolNumber(poolNumber: string): Promise<ConversationItem | undefined>;
  /**
   * Idempotent member add (relay groups): appends the member unless an entry
   * with the same phone already exists. OPTIMISTIC CONCURRENCY: the write is
   * conditioned on the roster's `participants_version` being unchanged since
   * the read, and bumps it — concurrent add/remove never silently clobber each
   * other (a lost-version write retries on the fresh roster; exhausting the
   * bounded retries surfaces RosterConflictError). Adding an existing member is
   * a success no-op (no version bump). Returns the post-update item (ALL_NEW).
   * Throws ConditionalCheckFailedException for unknown conversations.
   */
  addMember(conversationId: string, member: ConversationParticipant): Promise<ConversationItem>;
  /**
   * Idempotent member remove (relay groups): drops the entry whose phone
   * matches. A no-op when no such member exists (no version bump). Same
   * optimistic-concurrency version guard + bounded retry as addMember. Returns
   * the post-update item. Throws ConditionalCheckFailedException for unknown
   * conversations.
   */
  removeMember(conversationId: string, phone: string): Promise<ConversationItem>;
  /**
   * Flip a relay_group's status (open/closed) AND set/clear its pool_number
   * in one write: closing clears pool_number (the number is released to
   * quarantine by the caller); reopening writes the supplied (fresh) pool
   * number back. Returns the post-update item (ALL_NEW). Throws
   * ConditionalCheckFailedException for unknown conversations.
   *
   * `expectedStatus` (optional) makes the flip CONDITIONAL on the current
   * status — close from `open`, reopen from `closed` — so concurrent
   * close/reopen are idempotent: a flip whose precondition no longer holds
   * throws ConditionalCheckFailedException and the caller no-ops (FIX 1 — the
   * close/reopen race). When omitted, the flip is unconditional (existence
   * only), preserving the original callers.
   */
  setRelayStatus(
    conversationId: string,
    status: 'open' | 'closed',
    poolNumber: string | null,
    expectedStatus?: 'open' | 'closed',
  ): Promise<ConversationItem>;
  /**
   * Record ONE relay member as opted-out on the conversation's
   * `relay_opted_out_members` map (A2P — the fan-out detected `sms_opt_out` and
   * skipped them). MERGES a single map slot (a targeted `SET
   * relay_opted_out_members.#mk` — the map is auto-seeded if absent), so it never
   * clobbers OTHER members' entries. Best-effort caller: a failure must never
   * break the fan-out. `memberKey` is the relayMemberKey (may contain `#`), bound
   * via an aliased name.
   */
  setRelayMemberOptedOut(
    conversationId: string,
    memberKey: string,
    entry: { contactId?: string; phone?: string; name?: string; at: string },
  ): Promise<void>;
  /**
   * Clear ONE relay member's `relay_opted_out_members` entry (they opted back in
   * or were removed from the group). A targeted `REMOVE` of the single map slot —
   * leaves the others intact. Idempotent (removing an absent slot is a no-op).
   */
  clearRelayMemberOptedOut(conversationId: string, memberKey: string): Promise<void>;
}

export function createConversationsRepo(deps: RepoDeps = {}): ConversationsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('conversations', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(conversationId: string): Promise<ConversationItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId } }));
    return Item as ConversationItem | undefined;
  }

  /**
   * Create the real conversation row under an agreed (claimed) id. Losing
   * the conditional put just means another caller created it first — read
   * it back and return it (both callers end up with the same row).
   */
  async function createConversationRow(item: ConversationItem): Promise<ConversationItem> {
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const existing = await getById(item.conversationId);
      if (!existing) {
        throw new Error(
          `createOrGetByParticipantPhone: conversation ${item.conversationId} exists per the conditional put but is unreadable`,
        );
      }
      return existing;
    }
    log.info({ conversationId: item.conversationId, type: item.type }, 'conversation created');
    return item;
  }

  /**
   * FIX 3 — roster read-modify-write under optimistic concurrency. `mutate`
   * returns the NEW roster, or undefined for an idempotent no-op (member
   * already present / already absent). On a real change the write is
   * conditioned on `participants_version` matching the value read (or absent on
   * the very first mutation) and increments it; a concurrent mutation fails
   * that condition, so we re-read and retry up to ROSTER_MAX_RETRIES before
   * surfacing RosterConflictError. A missing conversation throws
   * ConditionalCheckFailedException (the routes map it to 404).
   */
  async function rosterMutate(
    conversationId: string,
    op: string,
    mutate: (roster: ConversationParticipant[]) => ConversationParticipant[] | undefined,
  ): Promise<ConversationItem> {
    for (let attempt = 0; attempt < ROSTER_MAX_RETRIES; attempt++) {
      const existing = await getById(conversationId);
      if (!existing) {
        throw new ConditionalCheckFailedException({
          message: `${op}: conversation ${conversationId} not found`,
          $metadata: {},
        });
      }
      const roster = existing.participants ?? [];
      const next = mutate(roster);
      if (next === undefined) {
        log.info({ conversationId, op }, 'relay roster mutation is a no-op (idempotent)');
        return existing; // nothing changed — no version bump, no write
      }
      const currentVersion =
        typeof existing.participants_version === 'number' ? existing.participants_version : 0;
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET participants = :p, participants_version = :nextV',
            // Existence guard + the optimistic-concurrency check: the roster's
            // version must be exactly what we read (or absent on first mutation).
            ConditionExpression:
              'attribute_exists(conversationId) AND (attribute_not_exists(participants_version) OR participants_version = :curV)',
            ExpressionAttributeValues: {
              ':p': next,
              ':curV': currentVersion,
              ':nextV': currentVersion + 1,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ conversationId, op, memberCount: next.length }, 'relay roster mutated');
        return Attributes as ConversationItem;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Lost the version race: a concurrent add/remove committed first.
        // Re-read and retry on the fresh roster (the loop re-reads at the top).
        log.info({ conversationId, op, attempt }, 'relay roster mutation lost a version race — retrying');
      }
    }
    throw new RosterConflictError(conversationId);
  }

  return {
    getById,

    async createOrGetByParticipantPhone(phone, type) {
      // Fast path: the byParticipantPhone GSI. Eventually consistent — a
      // miss here is NOT proof the conversation doesn't exist.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      const active = (Items as ConversationItem[] | undefined)?.find((c) => c.status === 'open');
      if (active) return active;

      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${randomUUID()}`,
        participant_phone: phone,
        status: 'open',
        last_activity_at: now,
        type,
        ai_mode: 'auto',
        created_at: now,
      };
      // Correctness backstop (the SID-pointer pattern from messagesRepo):
      // conditionally claim the phone before creating. The claim item
      // carries ONLY the key + ref_conversationId — no participant_phone,
      // status, or last_activity_at on purpose, so the sparse GSIs
      // (byParticipantPhone, byLastActivity) never index it.
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { conversationId: phoneClaimPk(phone), ref_conversationId: item.conversationId },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Claim taken: another caller won (now or in the past). Adopt the
        // claimed id; if the winner crashed before creating the row, the
        // conditional create below self-heals it under the SAME id.
        const claim = await doc.send(
          new GetCommand({ TableName: table, Key: { conversationId: phoneClaimPk(phone) } }),
        );
        const ref = (claim.Item as { ref_conversationId?: unknown } | undefined)
          ?.ref_conversationId;
        if (typeof ref !== 'string' || ref.length === 0) {
          throw new Error(
            'createOrGetByParticipantPhone: phone claim exists but carries no ref_conversationId',
          );
        }
        const existing = await getById(ref);
        if (existing) return existing;
        return createConversationRow({ ...item, conversationId: ref });
      }
      return createConversationRow(item);
    },

    async findByParticipantPhone(phone) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      return (Items as ConversationItem[] | undefined) ?? [];
    },

    async setType(conversationId, type) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET #t = :type',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: { '#t': 'type' },
          ExpressionAttributeValues: { ':type': type },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId, type }, 'conversation type set');
      return Attributes as ConversationItem;
    },

    async applyTriage(conversationId, fields) {
      // SET only the fields supplied: type (when triage resolves identity) and
      // participant_display_name (when a name is known). At least one is
      // present by the caller's contract; if neither were, this would be an
      // empty SET — guarded against by returning the current item.
      const sets: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      if (fields.type !== undefined) {
        names['#t'] = 'type';
        values[':type'] = fields.type;
        sets.push('#t = :type');
      }
      if (fields.displayName !== undefined && fields.displayName !== null) {
        names['#dn'] = 'participant_display_name';
        values[':dn'] = fields.displayName;
        sets.push('#dn = :dn');
      }
      if (sets.length === 0) {
        const existing = await getById(conversationId);
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `applyTriage: conversation ${conversationId} not found`,
            $metadata: {},
          });
        }
        return existing;
      }
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      // PII (doc §9): log the FACT of a name write, never the name itself.
      log.info(
        { conversationId, typeSet: fields.type ?? null, nameSet: ':dn' in values },
        'conversation triage applied',
      );
      return Attributes as ConversationItem;
    },

    async touchLastActivity(conversationId, previewText, ts) {
      const preview = toPreview(previewText);
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          // Activity (re)opens the thread; preview only set when one exists.
          UpdateExpression:
            preview !== undefined
              ? 'SET #s = :open, last_activity_at = :ts, last_message_preview = :preview'
              : 'SET #s = :open, last_activity_at = :ts',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':open': 'open',
            ':ts': ts,
            ...(preview !== undefined && { ':preview': preview }),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes as ConversationItem;
    },

    async setParticipantsIfAbsent(conversationId, participants) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET participants = :p',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_not_exists(participants)',
            ExpressionAttributeValues: { ':p': participants },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Either a link already exists (the normal race-loser case) or the
          // conversation is missing — disambiguate with a read.
          const existing = await getById(conversationId);
          if (!existing) {
            throw new Error(`setParticipantsIfAbsent: conversation not found: ${conversationId}`);
          }
          return false;
        }
        throw err;
      }
      log.info(
        { conversationId, contactId: participants[0]?.contactId },
        'conversation participants linked',
      );
      return true;
    },

    async incrementUnread(conversationId) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'ADD unread_count :one',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':one': 1 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (Attributes as ConversationItem).unread_count ?? 1;
    },

    async resetUnread(conversationId) {
      // Accepted risk (M1.2): SET-to-zero is last-write-wins vs in-flight
      // inbound increments — a read racing an inbound can drop that bump
      // (a watermark design fixes it if this ever bites).
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET unread_count = :zero',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':zero': 0 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId }, 'conversation unread reset');
      return Attributes as ConversationItem;
    },

    async setAssignment(conversationId, assigneeUserId) {
      // ALL_OLD captures the previous assignee atomically with the write —
      // the assignment_changed audit event needs an honest old → new pair
      // even under concurrent PATCHes.
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: assigneeUserId === null ? 'REMOVE assignment' : 'SET assignment = :a',
          ConditionExpression: 'attribute_exists(conversationId)',
          ...(assigneeUserId !== null && {
            ExpressionAttributeValues: { ':a': assigneeUserId },
          }),
          ReturnValues: 'ALL_OLD',
        }),
      );
      const previous = Attributes as ConversationItem;
      const previousAssigneeUserId =
        typeof previous.assignment === 'string' ? previous.assignment : null;
      const conversation: ConversationItem = { ...previous };
      if (assigneeUserId === null) delete conversation.assignment;
      else conversation.assignment = assigneeUserId;
      log.info(
        { conversationId, assigneeUserId, previousAssigneeUserId },
        'conversation assignment set',
      );
      return { conversation, previousAssigneeUserId };
    },

    async listByLastActivity({ status, limit, exclusiveStartKey }) {
      // M1.2 mandate: the inbox is ONE Query on byLastActivity (status
      // partition, last_activity_at DESC) — NEVER a Scan, at any size.
      const { Items, LastEvaluatedKey } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byLastActivity',
          KeyConditionExpression: '#s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': status },
          ScanIndexForward: false, // newest activity first
          Limit: limit ?? DEFAULT_INBOX_PAGE_LIMIT,
          ...(exclusiveStartKey !== undefined && {
            ExclusiveStartKey: exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
          }),
        }),
      );
      return {
        items: (Items ?? []) as ConversationItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async setMode(conversationId, mode) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET ai_mode = :mode',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':mode': mode },
        }),
      );
      log.info({ conversationId, mode }, 'conversation mode set');
    },

    async setSmsOptOut(conversationId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET sms_opt_out = :v',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':v': value },
        }),
      );
      log.info({ conversationId, smsOptOut: value }, 'conversation sms_opt_out set');
    },

    async incrementAutomatedSendCount(conversationId, bucket) {
      // Accepted risk (M1.1): this is a FIXED minute window — a burst
      // straddling a bucket boundary can reach ~2x the cap before tripping.
      // Two conditional shapes, retried: (a) ADD when the item is already on
      // this bucket; (b) SET/reset when the bucket changed (or never existed).
      // A loser of either race re-enters the loop; two passes settle it in
      // practice, the bound is just a stuck-loop guard.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const { Attributes } = await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { conversationId },
              UpdateExpression: 'ADD outbound_minute_count :one',
              ConditionExpression: 'outbound_minute_bucket = :bucket',
              ExpressionAttributeValues: { ':one': 1, ':bucket': bucket },
              ReturnValues: 'ALL_NEW',
            }),
          );
          return (Attributes as ConversationItem).outbound_minute_count ?? 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
        try {
          await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { conversationId },
              UpdateExpression: 'SET outbound_minute_bucket = :bucket, outbound_minute_count = :one',
              ConditionExpression:
                'attribute_exists(conversationId) AND (attribute_not_exists(outbound_minute_bucket) OR outbound_minute_bucket <> :bucket)',
              ExpressionAttributeValues: { ':bucket': bucket, ':one': 1 },
            }),
          );
          return 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
      }
      throw new Error(
        `incrementAutomatedSendCount: conditional updates kept failing for ${conversationId} — does the conversation exist?`,
      );
    },

    // --- Relay groups (M1.7) -----------------------------------------------

    async createRelayGroup({ poolNumber, members, tag, placementId }) {
      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${randomUUID()}`,
        // Synthetic participant_phone: relay threads route on pool_number, but
        // the inbox row + byParticipantPhone GSI still want a value. The pool
        // number is the natural one (it is "the thread's number").
        participant_phone: poolNumber,
        pool_number: poolNumber,
        status: 'open',
        last_activity_at: now,
        type: 'relay_group',
        // Relay threads are operator-run, never AI-driven; manual keeps the
        // automated-send breaker's manual-mode refusal off the relay path
        // (fan-out sends are not breaker-metered — see relayFanOut).
        ai_mode: 'manual',
        participants: members,
        created_at: now,
        ...(tag !== undefined && { placement_tag: tag }),
        ...(placementId !== undefined && { placementId }),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
      log.info(
        { conversationId: item.conversationId, memberCount: members.length },
        'relay group created',
      );
      return item;
    },

    async getByPoolNumber(poolNumber) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byPoolNumber',
          KeyConditionExpression: 'pool_number = :p',
          ExpressionAttributeValues: { ':p': poolNumber },
        }),
      );
      // One ACTIVE relay per pool number; a closed relay clears pool_number so
      // it leaves the sparse GSI. Prefer an open match defensively.
      const items = (Items as ConversationItem[] | undefined) ?? [];
      return items.find((c) => c.status === 'open') ?? items[0];
    },

    async addMember(conversationId, member) {
      // FIX 3 — optimistic concurrency. Read-modify-write the roster, but
      // condition the write on `participants_version` being unchanged since the
      // read and bump it. A concurrent add/remove invalidates the version, so
      // this write loses its conditional and re-reads + retries (bounded) — no
      // silent clobber. Idempotent on phone: re-adding an existing phone is a
      // success no-op that never bumps the version (so it can't spuriously
      // conflict with a concurrent change).
      return rosterMutate(conversationId, 'addMember', (roster) => {
        if (roster.some((p) => p.phone === member.phone)) return undefined; // no-op
        return [...roster, member];
      });
    },

    async removeMember(conversationId, phone) {
      // FIX 3 — same optimistic-concurrency version guard as addMember.
      // Idempotent: removing an absent phone is a success no-op (no bump).
      return rosterMutate(conversationId, 'removeMember', (roster) => {
        const next = roster.filter((p) => p.phone !== phone);
        return next.length === roster.length ? undefined : next; // undefined = no-op
      });
    },

    async setRelayStatus(conversationId, status, poolNumber, expectedStatus) {
      // Closing clears pool_number (the number leaves the byPoolNumber GSI so
      // a re-provision elsewhere can never resolve to this dead thread);
      // reopening writes the supplied fresh number back. FIX 1: an optional
      // `expectedStatus` makes the flip conditional on the current status so
      // concurrent close/reopen are idempotent (the loser's precondition fails
      // and it throws ConditionalCheckFailedException for the route to no-op).
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression:
            poolNumber === null
              ? 'SET #s = :status REMOVE pool_number'
              : 'SET #s = :status, pool_number = :pn',
          ConditionExpression:
            expectedStatus === undefined
              ? 'attribute_exists(conversationId)'
              : 'attribute_exists(conversationId) AND #s = :expected',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ...(poolNumber !== null && { ':pn': poolNumber }),
            ...(expectedStatus !== undefined && { ':expected': expectedStatus }),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId, status }, 'relay status set');
      return Attributes as ConversationItem;
    },

    async setRelayMemberOptedOut(conversationId, memberKey, entry) {
      // MERGE one slot without clobbering the others. DynamoDB rejects a single
      // SET that both seeds the parent map AND writes a child of it (overlapping
      // document paths — the same constraint messagesRepo.setRecipientDelivery
      // documents), and the parent map is NOT pre-seeded here (unlike
      // delivery_recipients). So: try the child-only SET first (the common path
      // once the map exists); if the map is absent the path SET fails its
      // implicit parent-exists precondition, so we seed the whole (merged) map in
      // a second write. Best-effort caller — a failure never breaks the fan-out.
      // memberKey may carry `#` (phone keys) → aliased name. PII: log keys only.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET relay_opted_out_members.#mk = :entry',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_exists(relay_opted_out_members)',
            ExpressionAttributeNames: { '#mk': memberKey },
            ExpressionAttributeValues: { ':entry': entry },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // The map didn't exist yet — seed it with THIS one entry (existence of
        // the conversation still guarded so an unknown id doesn't create a row).
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET relay_opted_out_members = :map',
            ConditionExpression: 'attribute_exists(conversationId)',
            ExpressionAttributeValues: { ':map': { [memberKey]: entry } },
          }),
        );
      }
      log.info({ conversationId, memberKey }, 'relay member opt-out recorded on conversation');
    },

    async clearRelayMemberOptedOut(conversationId, memberKey) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'REMOVE relay_opted_out_members.#mk',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: { '#mk': memberKey },
        }),
      );
      log.info({ conversationId, memberKey }, 'relay member opt-out cleared on conversation');
    },
  };
}
