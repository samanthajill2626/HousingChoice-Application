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
// present only while a suggestion is pending). Park (and backoff re-arm) do this
// CONDITIONALLY: a row re-armed since it was listed keeps its fresh schedule and
// only records the error (see fail).
//
// PII: never log message bodies or phone numbers. Log only ids/counts.
import { randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { ExtractionAddressParts } from '../adapters/extraction.js';
import { normalizeSuggestionValue } from '../services/extraction/schema.js';
import type { RepoDeps } from './conversationsRepo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-conversation debounce + cursor record. itemId = `due#<conversationId>`. */
export interface DueExtractionItem {
  /** PK - `due#<conversationId>`. */
  itemId: string;
  conversationId: string;
  /** What scheduled the run through an INBOUND path. OPTIONAL because a manual
   *  press can create a row that no inbound path ever scheduled - see
   *  requestManualExtraction, which deliberately does not write it. */
  channel?: 'sms' | 'voice' | 'triage' | 'email';
  /** Sticky manual marker (sparse). Set by requestManualExtraction, REMOVEd by
   *  claim and by fail's park branch. The single source of truth for the job's
   *  gate waivers and the recorded trigger - an inbound sliding dueAt forward
   *  cannot erase it. */
  manualRequested?: true;
  /** Correlates one press to the one run it produces (sparse). Cleared wherever
   *  manualRequested is, so a dead press's key can never ride a later run. */
  requestId?: string;
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
  /** Opaque ai_runs id of the extraction that created this suggestion. */
  runId?: string;
  /** Immutable identity stamped on production writes; absent only on legacy rows. */
  revision?: string;
  /** Hidden normalized value used only by the dismissal/writer transaction. */
  _normalizedValue?: string;
  /** byPending GSI hash key (fixed 'pending'); present while pending (sparse). */
  _pendingPartition?: 'pending';
  /** ISO - byPending GSI range key (newest-first). */
  createdAt: string;
}

/** What putSuggestion hands back: the row it wrote, plus the row it replaced. */
export interface PutSuggestionResult {
  item: SuggestionItem;
  displaced?: SuggestionItem;
}

/** The permanent dismissal tombstone won the atomic suggestion-writer fence. */
export class SuggestionDismissedError extends Error {
  constructor() {
    super('suggestion value was permanently dismissed');
    this.name = 'SuggestionDismissedError';
  }
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
    channel: 'sms' | 'voice' | 'triage' | 'email',
    dueAt: string,
  ): Promise<void>;
  /**
   * Arm a row for an IMMEDIATE manual run. Same sliding upsert as
   * scheduleExtraction, plus manualRequested and the caller's requestId, and
   * deliberately WITHOUT touching `channel`. The failure state (`attempts` /
   * `lastError`) deliberately rides along too - a press does NOT start from a
   * clean slate, so a press on a row already at attempts >= 4 gets one attempt
   * and parks on its first failure (design section 8; resetting would change
   * automatic backoff semantics for a manual reason) - `channel` has no clearing site,
   * so a 'manual' value stored there would outlive the flag and could later
   * label an automatic run as manual in the run log.
   */
  requestManualExtraction(conversationId: string, dueAt: string, requestId: string): Promise<void>;
  /** All scheduled due items with dueAt <= now (byDueAt GSI; paginated). */
  listDue(nowIso: string): Promise<DueExtractionItem[]>;
  /**
   * Atomically claim a due item BEFORE running: SET claimedAt, REMOVE
   * _duePartition + dueAt + manualRequested + requestId, conditional on the row
   * still being scheduled AND its dueAt still equal to `listedDueAt` (the value
   * listDue returned). Returns
   * false when the item slid forward or was already claimed - the sliding-
   * debounce correctness hinges on the `dueAt = listedDueAt` clause.
   */
  claim(conversationId: string, nowIso: string, listedDueAt: string): Promise<boolean>;
  /** Record a successful run: SET cursor + lastRanAt, clear claim/attempts/error. */
  complete(conversationId: string, cursor: string, ranAt: string): Promise<void>;
  /**
   * Record a failed run. `nextDueAt` non-null re-arms with backoff; null parks.
   *
   * Both branches are CONDITIONAL on nobody having re-armed the row since it
   * was listed. Unconditional writes destroyed a press or an inbound that
   * landed during the failing run - the park branch permanently, since the row
   * then leaves the due index with nothing left to re-arm it.
   *
   * ONE predicate serves both paths:
   *
   *   attribute_not_exists(_duePartition) OR dueAt = :listedDueAt
   *
   * The first arm covers the normal path, where the claim removed the index
   * keys. The second arm covers a claim that THREW without un-arming the row:
   * without it that path could never satisfy the condition, so it would never
   * back off and never park, and the poll would retry the row every interval
   * forever - an unbounded billed retry loop.
   *
   * Deliberately NOT a per-path conjunct keyed on whether the claim returned.
   * `claim` rethrows everything that is not a ConditionalCheckFailedException,
   * so a throw does NOT mean the write was not applied: a claim whose update
   * committed and whose response was then lost leaves the row un-armed while
   * the job believes the claim failed. A per-path `dueAt = :listedDueAt` is
   * false there, so the row would be stranded de-armed with nothing to re-arm
   * it and no reaper. The first arm of the disjunct self-heals exactly that.
   *
   * On a condition failure a second, scheduling-free update records only
   * lastError and attempts, leaving the fresh dueAt and marker alone.
   */
  fail(
    conversationId: string,
    error: string,
    nextDueAt: string | null,
    opts: { listedDueAt: string; manual: boolean },
  ): Promise<void>;
  getDue(conversationId: string): Promise<DueExtractionItem | undefined>;
  /**
   * Upsert a pending suggestion (latest wins - a re-put on the same
   * (contact, target) REPLACES). Stamps itemId + _pendingPartition + createdAt.
   */
  putSuggestion(
    s: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
  ): Promise<PutSuggestionResult>;
  getSuggestion(contactId: string, target: string): Promise<SuggestionItem | undefined>;
  /** All pending suggestions for one contact (byOwner GSI). */
  listSuggestionsByContact(contactId: string): Promise<SuggestionItem[]>;
  deleteSuggestion(contactId: string, target: string): Promise<void>;
  /** Delete only the exact version a resolver read; false means it was replaced. */
  deleteSuggestionIfCurrent(contactId: string, target: string, createdAt: string, runId?: string, revision?: string): Promise<boolean>;
  /** Restore a claimed suggestion only if a newer writer has not replaced it. */
  restoreSuggestionIfAbsent(suggestion: SuggestionItem): Promise<boolean>;
  /** All pending suggestions, newest-first (byPending GSI). Powers the Today count. */
  listPending(opts?: { limit?: number }): Promise<SuggestionItem[]>;
  /**
   * Record a dismissed (target, NORMALIZED value) pair - PERMANENT by ruling
   * (2026-07-21): a human edit never clears it; the same value is never
   * re-suggested. Tombstones carry NO GSI keys, so they can never surface as
   * pending suggestions or Today counts.
   */
  putDismissal(contactId: string, target: string, normValue: string): Promise<void>;
  /** True when this exact normalized value was previously dismissed for the target. */
  hasDismissal(contactId: string, target: string, normValue: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const dueId = (conversationId: string): string => `due#${conversationId}`;
const suggId = (contactId: string, target: string): string => `sugg#${contactId}#${target}`;
// Value-keyed (unlike sugg#, which is one slot per target): several rejected
// values can accumulate per target over a contact's life.
const dismId = (contactId: string, target: string, normValue: string): string =>
  `dism#${contactId}#${target}#${normValue}`;

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

    async requestManualExtraction(conversationId, dueAt, requestId) {
      const now = new Date().toISOString();
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { itemId: dueId(conversationId) },
          UpdateExpression:
            'SET #dueAt = :dueAt, #dp = :dp, #manual = :manual, #requestId = :requestId, #conversationId = :conversationId, #updatedAt = :updatedAt, #createdAt = if_not_exists(#createdAt, :now)',
          ExpressionAttributeNames: {
            '#dueAt': 'dueAt',
            '#dp': '_duePartition',
            '#manual': 'manualRequested',
            '#requestId': 'requestId',
            '#conversationId': 'conversationId',
            '#updatedAt': 'updatedAt',
            '#createdAt': 'createdAt',
          },
          ExpressionAttributeValues: {
            ':dueAt': dueAt,
            ':dp': 'due',
            ':manual': true,
            ':requestId': requestId,
            ':conversationId': conversationId,
            ':updatedAt': now,
            ':now': now,
          },
        }),
      );
      log.debug({ conversationId, requestId }, 'manual extraction requested');
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
            UpdateExpression: 'SET #claimedAt = :claimedAt REMOVE #dp, #dueAt, #manual, #requestId',
            ConditionExpression:
              'attribute_exists(#dp) AND #dueAt <= :now AND #dueAt = :listedDueAt',
            ExpressionAttributeNames: {
              '#dp': '_duePartition',
              '#dueAt': 'dueAt',
              '#claimedAt': 'claimedAt',
              '#manual': 'manualRequested',
              '#requestId': 'requestId',
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

    async fail(conversationId, error, nextDueAt, opts) {
      // Increment attempts; keep lastError. nextDueAt non-null re-arms the item
      // (back in the due index at nextDueAt); null parks it - REMOVE both byDueAt
      // key attrs so a parked item never re-lists until re-scheduled (D2).
      //
      // BOTH branches are conditional on nobody having re-armed the row since it
      // was listed, so a press (or an inbound) that landed during the failing
      // run survives. ONE disjunct serves both paths - see the interface doc for
      // why a per-path conjunct strands a row whose claim landed but whose
      // response was lost. A failed condition falls back to a scheduling-free
      // update that records the error only.
      const common = {
        TableName: table,
        Key: { itemId: dueId(conversationId) },
      };
      const condition = 'attribute_not_exists(#dp) OR #dueAt = :listedDueAt';

      const scheduling = async (): Promise<void> => {
        if (nextDueAt !== null) {
          await doc.send(
            new UpdateCommand({
              ...common,
              UpdateExpression: opts.manual
                ? 'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp, #manual = :manual ADD #attempts :one'
                : 'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp ADD #attempts :one',
              ConditionExpression: condition,
              ExpressionAttributeNames: {
                '#lastError': 'lastError',
                '#dueAt': 'dueAt',
                '#dp': '_duePartition',
                '#attempts': 'attempts',
                ...(opts.manual && { '#manual': 'manualRequested' }),
              },
              ExpressionAttributeValues: {
                ':error': error,
                ':dueAt': nextDueAt,
                ':dp': 'due',
                ':one': 1,
                ':listedDueAt': opts.listedDueAt,
                ...(opts.manual && { ':manual': true }),
              },
            }),
          );
          log.debug({ conversationId, nextDueAt }, 'extraction failed - re-armed');
          return;
        }
        // Park. REMOVE the correlation key with the flag: a dead press's
        // requestId riding a later automatic run would resolve a stale
        // indicator on someone's screen.
        await doc.send(
          new UpdateCommand({
            ...common,
            UpdateExpression:
              'SET #lastError = :error REMOVE #dp, #dueAt, #manual, #requestId ADD #attempts :one',
            ConditionExpression: condition,
            ExpressionAttributeNames: {
              '#lastError': 'lastError',
              '#dp': '_duePartition',
              '#dueAt': 'dueAt',
              '#manual': 'manualRequested',
              '#requestId': 'requestId',
              '#attempts': 'attempts',
            },
            ExpressionAttributeValues: {
              ':error': error,
              ':one': 1,
              ':listedDueAt': opts.listedDueAt,
            },
          }),
        );
        log.warn({ conversationId }, 'extraction failed - parked (max attempts)');
      };

      try {
        await scheduling();
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        await doc.send(
          new UpdateCommand({
            ...common,
            UpdateExpression: 'SET #lastError = :error ADD #attempts :one',
            ExpressionAttributeNames: { '#lastError': 'lastError', '#attempts': 'attempts' },
            ExpressionAttributeValues: { ':error': error, ':one': 1 },
          }),
        );
        log.debug(
          { conversationId },
          'extraction failed - row re-armed by someone else, schedule left alone',
        );
      }
    },

    async getDue(conversationId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { itemId: dueId(conversationId) } }),
      );
      return Item as DueExtractionItem | undefined;
    },

    async putSuggestion(s) {
      const normalizedValue = normalizeSuggestionValue(s.target, s.suggestedValue);
      const item: SuggestionItem = {
        itemId: suggId(s.ownerContactId, s.target),
        ownerContactId: s.ownerContactId,
        target: s.target,
        suggestedValue: s.suggestedValue,
        conversationId: s.conversationId,
        _pendingPartition: 'pending',
        createdAt: s.createdAt ?? new Date().toISOString(),
        revision: randomUUID(),
        _normalizedValue: normalizedValue,
        // Optional fields - undefined is dropped by the document client's
        // removeUndefinedValues, keeping the item clean.
        ...(s.currentValue !== undefined && { currentValue: s.currentValue }),
        ...(s.suggestedAddress !== undefined && { suggestedAddress: s.suggestedAddress }),
        ...(s.reason !== undefined && { reason: s.reason }),
        ...(s.tsMsgId !== undefined && { tsMsgId: s.tsMsgId }),
        ...(s.runId !== undefined && { runId: s.runId }),
      };
      // Atomic permanent-dismissal writer fence. The condition-check and the
      // CAS replacement share one transaction, so a dismissal can never cross
      // an unconditional Put and leave the rejected value visible. A conflict
      // is reread consistently and retried; `displaced` is therefore the exact
      // row this successful transaction replaced, not a stale preflight read.
      let displaced: SuggestionItem | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const [{ Item: currentRaw }, { Item: dismissalRaw }] = await Promise.all([
          doc.send(new GetCommand({
            TableName: table,
            Key: { itemId: suggId(s.ownerContactId, s.target) },
            ConsistentRead: true,
          })),
          doc.send(new GetCommand({
            TableName: table,
            Key: { itemId: dismId(s.ownerContactId, s.target, normalizedValue) },
            ConsistentRead: true,
          })),
        ]);
        if (dismissalRaw !== undefined) throw new SuggestionDismissedError();
        const current = currentRaw as SuggestionItem | undefined;
        displaced = current;

        let conditionExpression: string;
        let expressionAttributeNames: Record<string, string> | undefined;
        let expressionAttributeValues: Record<string, unknown> | undefined;
        if (current === undefined) {
          conditionExpression = 'attribute_not_exists(itemId)';
        } else if (current.revision !== undefined) {
          conditionExpression = '#revision = :revision';
          expressionAttributeNames = { '#revision': 'revision' };
          expressionAttributeValues = { ':revision': current.revision };
        } else if (current.runId === undefined) {
          conditionExpression =
            'attribute_not_exists(#revision) AND #createdAt = :createdAt AND attribute_not_exists(#runId)';
          expressionAttributeNames = {
            '#revision': 'revision',
            '#createdAt': 'createdAt',
            '#runId': 'runId',
          };
          expressionAttributeValues = { ':createdAt': current.createdAt };
        } else {
          conditionExpression =
            'attribute_not_exists(#revision) AND #createdAt = :createdAt AND #runId = :runId';
          expressionAttributeNames = {
            '#revision': 'revision',
            '#createdAt': 'createdAt',
            '#runId': 'runId',
          };
          expressionAttributeValues = {
            ':createdAt': current.createdAt,
            ':runId': current.runId,
          };
        }

        try {
          await doc.send(new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: table,
                  Key: { itemId: dismId(s.ownerContactId, s.target, normalizedValue) },
                  ConditionExpression: 'attribute_not_exists(itemId)',
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: item,
                  ConditionExpression: conditionExpression,
                  ...(expressionAttributeNames !== undefined && {
                    ExpressionAttributeNames: expressionAttributeNames,
                  }),
                  ...(expressionAttributeValues !== undefined && {
                    ExpressionAttributeValues: expressionAttributeValues,
                  }),
                },
              },
            ],
          }));
          log.debug({ contactId: s.ownerContactId, target: s.target }, 'suggestion upserted');
          return { item, ...(displaced !== undefined && { displaced }) };
        } catch (err) {
          const [{ Item: liveRaw }, { Item: liveDismissal }] = await Promise.all([
            doc.send(new GetCommand({
              TableName: table,
              Key: { itemId: suggId(s.ownerContactId, s.target) },
              ConsistentRead: true,
            })),
            doc.send(new GetCommand({
              TableName: table,
              Key: { itemId: dismId(s.ownerContactId, s.target, normalizedValue) },
              ConsistentRead: true,
            })),
          ]);
          if (liveDismissal !== undefined) throw new SuggestionDismissedError();
          const live = liveRaw as SuggestionItem | undefined;
          // Unknown outcome recovery: our immutable revision is live, so the
          // transaction committed even though the client did not observe it.
          if (live?.revision === item.revision) {
            return { item, ...(displaced !== undefined && { displaced }) };
          }
          if (!(err instanceof TransactionCanceledException)) throw err;
        }
      }
      throw new Error('suggestion write contention exceeded retry budget');
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

    async putDismissal(contactId, target, normValue) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            itemId: dismId(contactId, target, normValue),
            // Deliberately NOT ownerContactId / _pendingPartition - tombstones
            // must stay out of the byOwner and byPending GSIs.
            contactId,
            target,
            dismissedValue: normValue,
            createdAt: new Date().toISOString(),
          },
        }),
      );
    },

    async hasDismissal(contactId, target, normValue) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { itemId: dismId(contactId, target, normValue) } }),
      );
      return Item !== undefined;
    },

    async deleteSuggestion(contactId, target) {
      await doc.send(
        new DeleteCommand({ TableName: table, Key: { itemId: suggId(contactId, target) } }),
      );
      log.debug({ contactId, target }, 'suggestion deleted');
    },

    async deleteSuggestionIfCurrent(contactId, target, createdAt, runId, revision) {
      const conditionExpression = revision !== undefined
        ? '#revision = :revision'
        : runId === undefined
          ? 'attribute_not_exists(#revision) AND #createdAt = :createdAt AND attribute_not_exists(#runId)'
          : 'attribute_not_exists(#revision) AND #createdAt = :createdAt AND #runId = :runId';
      const expressionAttributeNames: Record<string, string> = revision !== undefined
        ? { '#revision': 'revision' }
        : { '#createdAt': 'createdAt', '#runId': 'runId', '#revision': 'revision' };
      const expressionAttributeValues: Record<string, unknown> = revision !== undefined
        ? { ':revision': revision }
        : { ':createdAt': createdAt, ...(runId !== undefined && { ':runId': runId }) };
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { itemId: suggId(contactId, target) },
            ConditionExpression: conditionExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
          }),
        );
        log.debug({ contactId, target }, 'suggestion conditionally deleted');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async restoreSuggestionIfAbsent(suggestion) {
      try {
        await doc.send(new PutCommand({
          TableName: table,
          Item: suggestion,
          ConditionExpression: 'attribute_not_exists(itemId)',
        }));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
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
