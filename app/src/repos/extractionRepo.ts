// Extraction repo - the ai_extraction table (conversation-fact-extraction T1).
//
// ONE single-key table holds two kinds of item, disjoint by itemId prefix:
//
//   due#<conversationId>       a per-conversation DEBOUNCE + CURSOR record.
//   sugg#<contactId>#<target>  a per-(contact, target) PENDING SUGGESTION.
//
// Sliding debounce (spec 4.2): each inbound message UPSERTS the conversation's
// due item forward (scheduleExtraction). A poll lists due items (listDue), then
// CLAIMs each one conditional on `dueAt = the value it listed` - so a message
// that slid the due item forward between the list and the claim makes the claim
// lose (false), collapsing a burst of texts into a single run at the latest time.
//
// D2 (truly-sparse byDueAt): a DynamoDB GSI indexes a row only while ALL its key
// attributes are present, so claim/complete/park REMOVE BOTH _duePartition AND
// dueAt together - the row then leaves the byDueAt index and persists only as the
// conversation's cursor record. Same for byPending (_pendingPartition + createdAt
// present only while a suggestion is pending).
//
// PII: never log message bodies or phone numbers. Log only ids/counts.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { ExtractionAddressParts } from '../adapters/extraction.js';
import type { RepoDeps } from './conversationsRepo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-conversation debounce + cursor record. itemId = `due#<conversationId>`. */
export interface DueExtractionItem {
  /** PK - `due#<conversationId>`. */
  itemId: string;
  conversationId: string;
  /** What scheduled the run: an inbound text (sms), a fresh call transcript
   *  (voice), or a human triage flip to tenant (triage). voice/triage runs
   *  bypass the job's client-freshness gate - their signal is content the
   *  cursor logic can't see (a late transcript / newly-applicable tenant facts). */
  channel: 'sms' | 'voice' | 'triage';
  /** ISO - byDueAt GSI range key; present ONLY while a run is scheduled. */
  dueAt?: string;
  /** byDueAt GSI hash key (fixed 'due'); present ONLY while scheduled (sparse). */
  _duePartition?: 'due';
  /** Last tsMsgId covered by a completed run. */
  cursor?: string;
  /** ISO - set while a poll holds the claim. */
  claimedAt?: string;
  /** Consecutive failures (re-armed with backoff each fail; cleared on success). */
  attempts?: number;
  lastError?: string;
  lastRanAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Per-(contact, target) pending suggestion. itemId = `sugg#<contactId>#<target>`. */
export interface SuggestionItem {
  /** PK - `sugg#<contactId>#<target>`. */
  itemId: string;
  /** byOwner GSI hash key (sparse - only suggestion rows carry it). */
  ownerContactId: string;
  /** Field/channel being suggested (firstName, voucherSize, status, phone, type, ...). */
  target: string;
  currentValue?: string;
  suggestedValue: string;
  /** Parts payload for the compound 'address' target - what accept writes
   *  (suggestedValue stays the human-readable joined string the chip shows). */
  suggestedAddress?: ExtractionAddressParts;
  reason?: string;
  conversationId: string;
  tsMsgId?: string;
  /** byPending GSI hash key (fixed 'pending'); present while pending (sparse). */
  _pendingPartition?: 'pending';
  /** ISO - byPending GSI range key (newest-first). */
  createdAt: string;
}

export interface ExtractionRepo {
  /**
   * Sliding upsert of the conversation's due item: SET dueAt/_duePartition/
   * channel/conversationId/updatedAt (createdAt via if_not_exists). Called on
   * every fresh inbound message with dueAt = now + debounce, so a burst slides
   * the single item forward to the latest time.
   */
  scheduleExtraction(
    conversationId: string,
    channel: 'sms' | 'voice' | 'triage',
    dueAt: string,
  ): Promise<void>;
  /** All scheduled due items with dueAt <= now (byDueAt GSI; paginated). */
  listDue(nowIso: string): Promise<DueExtractionItem[]>;
  /**
   * Atomically claim a due item BEFORE running: SET claimedAt, REMOVE
   * _duePartition + dueAt, conditional on the row still being scheduled AND its
   * dueAt still equal to `listedDueAt` (the value listDue returned). Returns
   * false when the item slid forward or was already claimed - the sliding-
   * debounce correctness hinges on the `dueAt = listedDueAt` clause.
   */
  claim(conversationId: string, nowIso: string, listedDueAt: string): Promise<boolean>;
  /** Record a successful run: SET cursor + lastRanAt, clear claim/attempts/error. */
  complete(conversationId: string, cursor: string, ranAt: string): Promise<void>;
  /**
   * Record a failed run: increment attempts, keep lastError. nextDueAt non-null
   * re-arms the item (back in the due index at nextDueAt); null parks it
   * (removed from the index, no further retries until re-scheduled).
   */
  fail(conversationId: string, error: string, nextDueAt: string | null): Promise<void>;
  getDue(conversationId: string): Promise<DueExtractionItem | undefined>;
  /**
   * Upsert a pending suggestion (latest wins - a re-put on the same
   * (contact, target) REPLACES). Stamps itemId + _pendingPartition + createdAt.
   */
  putSuggestion(
    s: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
  ): Promise<SuggestionItem>;
  getSuggestion(contactId: string, target: string): Promise<SuggestionItem | undefined>;
  /** All pending suggestions for one contact (byOwner GSI). */
  listSuggestionsByContact(contactId: string): Promise<SuggestionItem[]>;
  deleteSuggestion(contactId: string, target: string): Promise<void>;
  /** All pending suggestions, newest-first (byPending GSI). Powers the Today count. */
  listPending(opts?: { limit?: number }): Promise<SuggestionItem[]>;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const dueId = (conversationId: string): string => `due#${conversationId}`;
const suggId = (contactId: string, target: string): string => `sugg#${contactId}#${target}`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtractionRepo(deps: RepoDeps = {}): ExtractionRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('ai_extraction', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async scheduleExtraction(conversationId, channel, dueAt) {
      const now = new Date().toISOString();
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { itemId: dueId(conversationId) },
          UpdateExpression:
            'SET #dueAt = :dueAt, #dp = :dp, #channel = :channel, #conversationId = :conversationId, #updatedAt = :updatedAt, #createdAt = if_not_exists(#createdAt, :now)',
          ExpressionAttributeNames: {
            '#dueAt': 'dueAt',
            '#dp': '_duePartition',
            '#channel': 'channel',
            '#conversationId': 'conversationId',
            '#updatedAt': 'updatedAt',
            '#createdAt': 'createdAt',
          },
          ExpressionAttributeValues: {
            ':dueAt': dueAt,
            ':dp': 'due',
            ':channel': channel,
            ':conversationId': conversationId,
            ':updatedAt': now,
            ':now': now,
          },
        }),
      );
      log.debug({ conversationId, dueAt }, 'extraction scheduled (sliding upsert)');
    },

    async listDue(nowIso) {
      // Query the byDueAt GSI: all scheduled rows (fixed 'due' partition) with
      // dueAt <= now. Paginate with LastEvaluatedKey so rows beyond the 1 MB
      // page limit are not dropped (mirrors placementNudgesRepo.listDue).
      const baseInput: QueryCommandInput = {
        TableName: table,
        IndexName: 'byDueAt',
        KeyConditionExpression: '#dp = :dp AND #dueAt <= :now',
        ExpressionAttributeNames: { '#dp': '_duePartition', '#dueAt': 'dueAt' },
        ExpressionAttributeValues: { ':dp': 'due', ':now': nowIso },
      };
      const items: DueExtractionItem[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            ...baseInput,
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...((page.Items as DueExtractionItem[] | undefined) ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return items;
    },

    async claim(conversationId, nowIso, listedDueAt) {
      // Claim conditional on the item still being scheduled (_duePartition
      // present), past-due (dueAt <= now), and NOT slid since listDue read it
      // (dueAt = listedDueAt). On success REMOVE both byDueAt key attrs (D2) so
      // the row leaves the index; SET claimedAt. A lost claim (slid or already
      // claimed) is a benign false.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { itemId: dueId(conversationId) },
            UpdateExpression: 'SET #claimedAt = :claimedAt REMOVE #dp, #dueAt',
            ConditionExpression:
              'attribute_exists(#dp) AND #dueAt <= :now AND #dueAt = :listedDueAt',
            ExpressionAttributeNames: {
              '#dp': '_duePartition',
              '#dueAt': 'dueAt',
              '#claimedAt': 'claimedAt',
            },
            ExpressionAttributeValues: {
              ':claimedAt': nowIso,
              ':now': nowIso,
              ':listedDueAt': listedDueAt,
            },
          }),
        );
        log.debug({ conversationId }, 'extraction claimed');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ conversationId }, 'extraction claim lost (slid or already claimed) - skipping');
          return false;
        }
        throw err;
      }
    },

    async complete(conversationId, cursor, ranAt) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { itemId: dueId(conversationId) },
          UpdateExpression:
            'SET #cursor = :cursor, #lastRanAt = :ranAt REMOVE #claimedAt, #attempts, #lastError',
          ExpressionAttributeNames: {
            '#cursor': 'cursor',
            '#lastRanAt': 'lastRanAt',
            '#claimedAt': 'claimedAt',
            '#attempts': 'attempts',
            '#lastError': 'lastError',
          },
          ExpressionAttributeValues: { ':cursor': cursor, ':ranAt': ranAt },
        }),
      );
      log.debug({ conversationId, cursor }, 'extraction completed (cursor advanced)');
    },

    async fail(conversationId, error, nextDueAt) {
      // Increment attempts; keep lastError. nextDueAt non-null re-arms the item
      // (back in the due index at nextDueAt); null parks it - REMOVE both byDueAt
      // key attrs so a parked item never re-lists until re-scheduled (D2).
      const common = {
        TableName: table,
        Key: { itemId: dueId(conversationId) },
      };
      if (nextDueAt !== null) {
        await doc.send(
          new UpdateCommand({
            ...common,
            UpdateExpression:
              'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp ADD #attempts :one',
            ExpressionAttributeNames: {
              '#lastError': 'lastError',
              '#dueAt': 'dueAt',
              '#dp': '_duePartition',
              '#attempts': 'attempts',
            },
            ExpressionAttributeValues: {
              ':error': error,
              ':dueAt': nextDueAt,
              ':dp': 'due',
              ':one': 1,
            },
          }),
        );
        log.debug({ conversationId, nextDueAt }, 'extraction failed - re-armed');
      } else {
        await doc.send(
          new UpdateCommand({
            ...common,
            UpdateExpression: 'SET #lastError = :error REMOVE #dp, #dueAt ADD #attempts :one',
            ExpressionAttributeNames: {
              '#lastError': 'lastError',
              '#dp': '_duePartition',
              '#dueAt': 'dueAt',
              '#attempts': 'attempts',
            },
            ExpressionAttributeValues: { ':error': error, ':one': 1 },
          }),
        );
        log.warn({ conversationId }, 'extraction failed - parked (max attempts)');
      }
    },

    async getDue(conversationId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { itemId: dueId(conversationId) } }),
      );
      return Item as DueExtractionItem | undefined;
    },

    async putSuggestion(s) {
      const item: SuggestionItem = {
        itemId: suggId(s.ownerContactId, s.target),
        ownerContactId: s.ownerContactId,
        target: s.target,
        suggestedValue: s.suggestedValue,
        conversationId: s.conversationId,
        _pendingPartition: 'pending',
        createdAt: s.createdAt ?? new Date().toISOString(),
        // Optional fields - undefined is dropped by the document client's
        // removeUndefinedValues, keeping the item clean.
        ...(s.currentValue !== undefined && { currentValue: s.currentValue }),
        ...(s.suggestedAddress !== undefined && { suggestedAddress: s.suggestedAddress }),
        ...(s.reason !== undefined && { reason: s.reason }),
        ...(s.tsMsgId !== undefined && { tsMsgId: s.tsMsgId }),
      };
      // No ConditionExpression: a re-put on the same (contact, target) REPLACES
      // (latest wins).
      await doc.send(new PutCommand({ TableName: table, Item: item }));
      log.debug({ contactId: s.ownerContactId, target: s.target }, 'suggestion upserted');
      return item;
    },

    async getSuggestion(contactId, target) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { itemId: suggId(contactId, target) } }),
      );
      return Item as SuggestionItem | undefined;
    },

    async listSuggestionsByContact(contactId) {
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byOwner',
        KeyConditionExpression: '#owner = :owner',
        ExpressionAttributeNames: { '#owner': 'ownerContactId' },
        ExpressionAttributeValues: { ':owner': contactId },
      };
      const { Items } = await doc.send(new QueryCommand(input));
      return (Items ?? []) as SuggestionItem[];
    },

    async deleteSuggestion(contactId, target) {
      await doc.send(
        new DeleteCommand({ TableName: table, Key: { itemId: suggId(contactId, target) } }),
      );
      log.debug({ contactId, target }, 'suggestion deleted');
    },

    async listPending(opts) {
      // Query byPending (fixed 'pending' partition, range createdAt), newest
      // first (ScanIndexForward false). Paginate unless an explicit limit caps it.
      const baseInput: QueryCommandInput = {
        TableName: table,
        IndexName: 'byPending',
        KeyConditionExpression: '#pp = :pp',
        ExpressionAttributeNames: { '#pp': '_pendingPartition' },
        ExpressionAttributeValues: { ':pp': 'pending' },
        ScanIndexForward: false,
        ...(opts?.limit !== undefined && { Limit: opts.limit }),
      };
      const items: SuggestionItem[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            ...baseInput,
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...((page.Items as SuggestionItem[] | undefined) ?? []));
        if (opts?.limit !== undefined && items.length >= opts.limit) {
          return items.slice(0, opts.limit);
        }
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return items;
    },
  };
}
