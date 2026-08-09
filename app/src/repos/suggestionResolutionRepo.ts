// Durable suggestion-resolution journal in ai_extraction.
//
// One bounded hidden row exists per (contact, target):
//   resolve#<contactId>#<target>
//
// Active rows contain the immutable suggestion snapshot, original action and
// actor, replay plan, phase, lease and fence. Completed rows are PII-free. The
// rows deliberately omit ownerContactId and _pendingPartition, so neither
// suggestion GSI can expose protocol state.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { DECISION_TARGETS } from '../services/extraction/runTypes.js';
import type { ContactItem, ContactPhone } from './contactsRepo.js';
import { phoneRefId, seedPhonesForWrite } from './contactsRepo.js';
import type { RepoDeps } from './conversationsRepo.js';
import type { SuggestionItem } from './extractionRepo.js';

export type ResolutionAction = 'accept' | 'dismiss';
export type ResolutionPhase =
  | 'claimed'
  | 'domain_applied'
  | 'activity_recorded'
  | 'activity_skipped'
  | 'verdict_attempted';

export interface ResolutionAuditPlan {
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface ResolutionActivityPlan {
  type:
    | 'stage_changed'
    | 'contact_status_changed'
    | 'number_added';
  label: string;
  refType?: 'placement' | 'unit' | 'conversation' | 'broadcast' | 'tour';
  refId?: string;
}

export type ResolutionAttributeGuard = Record<string,
  | { exists: false }
  | { exists: true; value: unknown }
>;

export type ResolutionOutcome = 'superseded_by_human_edit';

/**
 * Why a journal ended, when that is not simply "the action was applied".
 * `released_unsafe`: a known pre-mutation refusal could NOT restore its
 * suggestion because a newer one already held the pending slot, so the journal
 * was finalized in place instead of being deleted. PII-free by construction.
 */
export type ResolutionDisposition = 'released_unsafe';

export type ResolutionReplayPlan =
  | {
      kind: 'contact' | 'status';
      patch: Record<string, unknown>;
      guard: ResolutionAttributeGuard;
      audit: ResolutionAuditPlan;
      activity?: ResolutionActivityPlan;
    }
  | {
      kind: 'phone';
      phone: string;
      label?: string;
      audit: ResolutionAuditPlan;
      activity?: ResolutionActivityPlan;
    }
  | {
      kind: 'dismiss';
      normalizedValue: string;
      audit: ResolutionAuditPlan;
    };

export interface ActiveSuggestionResolution {
  itemId: string;
  state: 'active';
  contactId: string;
  target: string;
  identityKey: string;
  action: ResolutionAction;
  actorId?: string;
  snapshot: SuggestionItem;
  plan: ResolutionReplayPlan;
  phase: ResolutionPhase;
  outcome?: ResolutionOutcome;
  leaseId: string;
  leaseExpiresAt: string;
  fence: number;
  claimedAt: string;
}

export interface CompletedSuggestionResolution {
  itemId: string;
  state: 'completed';
  contactId: string;
  target: string;
  identityKey: string;
  action: ResolutionAction;
  completedAt: string;
  disposition?: ResolutionDisposition;
}

export type SuggestionResolutionItem =
  | ActiveSuggestionResolution
  | CompletedSuggestionResolution;

export interface ResolutionToken {
  contactId: string;
  target: string;
  identityKey: string;
  action: ResolutionAction;
  leaseId: string;
  fence: number;
}

export type ResolutionClaimResult =
  | { status: 'claimed'; journal: ActiveSuggestionResolution }
  | { status: 'blocked'; journal: ActiveSuggestionResolution }
  | { status: 'completed'; journal: CompletedSuggestionResolution }
  | { status: 'suggestion_replaced' };

export type ResolutionTakeoverResult =
  | { status: 'taken_over'; journal: ActiveSuggestionResolution }
  | { status: 'blocked'; journal: ActiveSuggestionResolution }
  | { status: 'missing' };

export type ResolutionEffectResult =
  | 'committed'
  | 'already_committed'
  | 'stale'
  | 'phone_conflict'
  | 'superseded_by_human_edit';

export interface ClaimResolutionInput {
  suggestion: SuggestionItem;
  action: ResolutionAction;
  actorId?: string;
  plan: ResolutionReplayPlan;
  now: string;
  leaseId?: string;
  leaseMs?: number;
}

export interface PhaseInput {
  token: ResolutionToken;
  expectedPhase: ResolutionPhase;
  nextPhase: ResolutionPhase;
}

export interface SuggestionResolutionRepo {
  get(contactId: string, target: string): Promise<SuggestionResolutionItem | undefined>;
  /**
   * Every journal row this contact can have, in one BatchGet of the twelve
   * fixed `resolve#<contactId>#<target>` keys. The key set is closed: a journal
   * is only ever created from a stored `sugg#` row, and those rows only ever
   * carry a DECISION_TARGETS target. Best-effort: keys DynamoDB leaves
   * unprocessed after the short retry are reported as absent, because the next
   * ordinary read repeats the enumeration.
   */
  listJournals(contactId: string): Promise<SuggestionResolutionItem[]>;
  claim(input: ClaimResolutionInput): Promise<ResolutionClaimResult>;
  takeover(input: {
    contactId: string;
    target: string;
    now: string;
    leaseId?: string;
    leaseMs?: number;
  }): Promise<ResolutionTakeoverResult>;
  commitContactEffect(input: PhaseInput): Promise<ResolutionEffectResult>;
  commitPhoneEffect(input: PhaseInput): Promise<ResolutionEffectResult>;
  commitActivityEffect(input: PhaseInput): Promise<ResolutionEffectResult>;
  commitDismissalEffect(input: PhaseInput): Promise<ResolutionEffectResult>;
  advancePhase(input: PhaseInput): Promise<ResolutionEffectResult>;
  release(input: { token: ResolutionToken; expectedPhase: ResolutionPhase }): Promise<'released' | 'stale' | 'unsafe'>;
  complete(input: {
    token: ResolutionToken;
    expectedPhase: ResolutionPhase;
    completedAt: string;
    disposition?: ResolutionDisposition;
  }): Promise<'completed' | 'already_completed' | 'stale'>;
}

const DEFAULT_LEASE_MS = 30_000;
const MAX_CONTENTION_ATTEMPTS = 4;
const MAX_BATCH_ATTEMPTS = 4;
const BATCH_BACKOFF_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const resolutionItemId = (contactId: string, target: string): string =>
  `resolve#${contactId}#${target}`;

const suggestionItemId = (contactId: string, target: string): string =>
  `sugg#${contactId}#${target}`;

const dismissalItemId = (contactId: string, target: string, normalizedValue: string): string =>
  `dism#${contactId}#${target}#${normalizedValue}`;

export function suggestionIdentityKey(
  suggestion: Pick<SuggestionItem, 'ownerContactId' | 'target' | 'revision' | 'createdAt' | 'runId'>,
): string {
  if (suggestion.revision !== undefined) return `revision#${suggestion.revision}`;
  const exact = [
    suggestion.ownerContactId,
    suggestion.target,
    suggestion.createdAt,
    suggestion.runId ?? '<absent>',
  ].join('\u0000');
  return `legacy#${createHash('sha256').update(exact, 'utf8').digest('hex').slice(0, 32)}`;
}

export function tokenFor(journal: ActiveSuggestionResolution): ResolutionToken {
  return {
    contactId: journal.contactId,
    target: journal.target,
    identityKey: journal.identityKey,
    action: journal.action,
    leaseId: journal.leaseId,
    fence: journal.fence,
  };
}

export function makeCompletedResolution(
  active: ActiveSuggestionResolution,
  completedAt: string,
  disposition?: ResolutionDisposition,
): CompletedSuggestionResolution {
  return {
    itemId: active.itemId,
    state: 'completed',
    contactId: active.contactId,
    target: active.target,
    identityKey: active.identityKey,
    action: active.action,
    completedAt,
    ...(disposition !== undefined && { disposition }),
  };
}

function identityCondition(suggestion: SuggestionItem): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  if (suggestion.revision !== undefined) {
    return {
      expression: '#revision = :revision',
      names: { '#revision': 'revision' },
      values: { ':revision': suggestion.revision },
    };
  }
  return suggestion.runId === undefined
    ? {
        expression:
          'attribute_not_exists(#revision) AND #createdAt = :createdAt AND attribute_not_exists(#runId)',
        names: { '#revision': 'revision', '#createdAt': 'createdAt', '#runId': 'runId' },
        values: { ':createdAt': suggestion.createdAt },
      }
    : {
        expression:
          'attribute_not_exists(#revision) AND #createdAt = :createdAt AND #runId = :runId',
        names: { '#revision': 'revision', '#createdAt': 'createdAt', '#runId': 'runId' },
        values: { ':createdAt': suggestion.createdAt, ':runId': suggestion.runId },
      };
}

function exactGuard(
  token: ResolutionToken,
  expectedPhase: ResolutionPhase,
): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  return {
    expression:
      '#state = :active AND #identity = :identity AND #action = :action AND #phase = :phase AND #lease = :lease AND #fence = :fence',
    names: {
      '#state': 'state',
      '#identity': 'identityKey',
      '#action': 'action',
      '#phase': 'phase',
      '#lease': 'leaseId',
      '#fence': 'fence',
    },
    values: {
      ':active': 'active',
      ':identity': token.identityKey,
      ':action': token.action,
      ':phase': expectedPhase,
      ':lease': token.leaseId,
      ':fence': token.fence,
    },
  };
}

function journalAdvance(
  table: string,
  input: PhaseInput,
): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']> {
  const guard = exactGuard(input.token, input.expectedPhase);
  return {
    TableName: table,
    Key: { itemId: resolutionItemId(input.token.contactId, input.token.target) },
    UpdateExpression: 'SET #phase = :nextPhase',
    ConditionExpression: guard.expression,
    ExpressionAttributeNames: guard.names,
    ExpressionAttributeValues: { ...guard.values, ':nextPhase': input.nextPhase },
  };
}

function journalSuperseded(
  table: string,
  input: PhaseInput,
): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']> {
  const guard = exactGuard(input.token, input.expectedPhase);
  return {
    TableName: table,
    Key: { itemId: resolutionItemId(input.token.contactId, input.token.target) },
    UpdateExpression: 'SET #phase = :nextPhase, #outcome = :outcome',
    ConditionExpression: guard.expression,
    ExpressionAttributeNames: { ...guard.names, '#outcome': 'outcome' },
    ExpressionAttributeValues: {
      ...guard.values,
      ':nextPhase': input.nextPhase,
      ':outcome': 'superseded_by_human_edit',
    },
  };
}

function contactGuardCondition(
  guard: ResolutionAttributeGuard,
  expectedMatch: boolean,
): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const attributes = Object.entries(guard).map(([key, expected], index) => {
    const name = `#g${index}`;
    names[name] = key;
    if (!expected.exists) return `attribute_not_exists(${name})`;
    const value = `:g${index}`;
    values[value] = expected.value;
    return `${name} = ${value}`;
  });
  const exact = ['attribute_exists(contactId)', ...attributes].join(' AND ');
  return {
    expression: expectedMatch ? exact : `NOT (${exact})`,
    names,
    values,
  };
}

function contactMatchesGuard(
  contact: ContactItem | undefined,
  guard: ResolutionAttributeGuard,
): boolean {
  if (contact === undefined) return false;
  return Object.entries(guard).every(([key, expected]) => {
    const exists = Object.prototype.hasOwnProperty.call(contact, key) && contact[key] !== undefined;
    return expected.exists
      ? exists && isDeepStrictEqual(contact[key], expected.value)
      : !exists;
  });
}

function deterministicSuffix(journal: ActiveSuggestionResolution, purpose: string): string {
  return createHash('sha256')
    .update(`${journal.itemId}\u0000${journal.identityKey}\u0000${journal.action}\u0000${purpose}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
}

function auditItem(journal: ActiveSuggestionResolution): Record<string, unknown> {
  const actorId = journal.actorId;
  return {
    entityKey: `contacts#${journal.contactId}`,
    ts: `${journal.claimedAt}#resolve-${deterministicSuffix(journal, 'audit')}`,
    event_type: journal.plan.audit.eventType,
    ...(actorId !== undefined && { actorId }),
    payload: {
      ...(journal.plan.audit.payload ?? {}),
      ...(actorId !== undefined && { actor: actorId }),
    },
  };
}

function activityItem(
  journal: ActiveSuggestionResolution,
  activity: ResolutionActivityPlan,
): Record<string, unknown> {
  const eventId = `evt-resolve-${deterministicSuffix(journal, 'activity')}`;
  return {
    contactId: journal.contactId,
    tsEventId: `${journal.claimedAt}#${eventId}`,
    eventId,
    at: journal.claimedAt,
    type: activity.type,
    label: activity.label,
    created_at: journal.claimedAt,
    ...(activity.refType !== undefined && { refType: activity.refType }),
    ...(activity.refId !== undefined && { refId: activity.refId }),
  };
}

function isCancellation(err: unknown): boolean {
  return err instanceof TransactionCanceledException || err instanceof ConditionalCheckFailedException;
}

function isValidationFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ValidationException';
}

function sameToken(journal: SuggestionResolutionItem | undefined, token: ResolutionToken): journal is ActiveSuggestionResolution {
  return journal?.state === 'active' &&
    journal.identityKey === token.identityKey &&
    journal.action === token.action &&
    journal.leaseId === token.leaseId &&
    journal.fence === token.fence;
}

function phaseAdvanced(current: ResolutionPhase, expected: ResolutionPhase): boolean {
  const rank: Record<ResolutionPhase, number> = {
    claimed: 0,
    domain_applied: 1,
    activity_recorded: 2,
    activity_skipped: 2,
    verdict_attempted: 3,
  };
  return rank[current] > rank[expected];
}

export function createSuggestionResolutionRepo(deps: RepoDeps = {}): SuggestionResolutionRepo {
  const doc = deps.doc ?? getDocumentClient();
  const env = deps.env;
  const log = deps.logger ?? defaultLogger;
  const extractionTable = tableName('ai_extraction', env);
  const contactsTable = tableName('contacts', env);
  const auditTable = tableName('audit_events', env);
  const activityTable = tableName('activity_events', env);

  async function getJournal(contactId: string, target: string): Promise<SuggestionResolutionItem | undefined> {
    const { Item } = await doc.send(new GetCommand({
      TableName: extractionTable,
      Key: { itemId: resolutionItemId(contactId, target) },
      ConsistentRead: true,
    }));
    return Item as SuggestionResolutionItem | undefined;
  }

  async function getSuggestion(contactId: string, target: string): Promise<SuggestionItem | undefined> {
    const { Item } = await doc.send(new GetCommand({
      TableName: extractionTable,
      Key: { itemId: suggestionItemId(contactId, target) },
      ConsistentRead: true,
    }));
    return Item as SuggestionItem | undefined;
  }

  async function transactPhase(
    input: PhaseInput,
    effects: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<ResolutionEffectResult> {
    let lastUnknownError: unknown;
    for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt += 1) {
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [...effects, { Update: journalAdvance(extractionTable, input) }],
        }));
        return 'committed';
      } catch (err) {
        if (isValidationFailure(err)) throw err;
        const journal = await getJournal(input.token.contactId, input.token.target);
        if (sameToken(journal, input.token)) {
          if (journal.phase === input.nextPhase || phaseAdvanced(journal.phase, input.expectedPhase)) {
            return 'already_committed';
          }
          if (journal.phase === input.expectedPhase) {
            if (!isCancellation(err)) lastUnknownError = err;
            continue;
          }
        }
        return 'stale';
      }
    }
    const journal = await getJournal(input.token.contactId, input.token.target);
    if (
      lastUnknownError !== undefined &&
      sameToken(journal, input.token) &&
      journal.phase === input.expectedPhase
    ) {
      throw lastUnknownError;
    }
    return 'stale';
  }

  async function requireActive(token: ResolutionToken): Promise<ActiveSuggestionResolution | undefined> {
    const journal = await getJournal(token.contactId, token.target);
    return sameToken(journal, token) ? journal : undefined;
  }

  return {
    get: getJournal,

    async listJournals(contactId) {
      const found: SuggestionResolutionItem[] = [];
      let keys: Array<{ itemId: string }> = DECISION_TARGETS.map((target) => ({
        itemId: resolutionItemId(contactId, target),
      }));
      for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS && keys.length > 0; attempt += 1) {
        if (attempt > 0) await sleep(BATCH_BACKOFF_MS * 2 ** (attempt - 1));
        const res = await doc.send(new BatchGetCommand({
          RequestItems: { [extractionTable]: { Keys: keys, ConsistentRead: true } },
        }));
        for (const item of (res.Responses?.[extractionTable] ?? []) as SuggestionResolutionItem[]) {
          found.push(item);
        }
        keys = (res.UnprocessedKeys?.[extractionTable]?.Keys ?? []) as Array<{ itemId: string }>;
      }
      if (keys.length > 0) {
        log.warn(
          { contactId, unprocessed: keys.length },
          'suggestion resolution: BatchGet left journal keys unprocessed after retries',
        );
      }
      return found;
    },

    async claim(input) {
      const contactId = input.suggestion.ownerContactId;
      const target = input.suggestion.target;
      const itemId = resolutionItemId(contactId, target);
      const identityKey = suggestionIdentityKey(input.suggestion);
      const leaseId = input.leaseId ?? randomUUID();
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + (input.leaseMs ?? DEFAULT_LEASE_MS),
      ).toISOString();
      const journal: ActiveSuggestionResolution = {
        itemId,
        state: 'active',
        contactId,
        target,
        identityKey,
        action: input.action,
        ...(input.actorId !== undefined && { actorId: input.actorId }),
        snapshot: input.suggestion,
        plan: input.plan,
        phase: 'claimed',
        leaseId,
        leaseExpiresAt,
        fence: 1,
        claimedAt: input.now,
      };
      const identity = identityCondition(input.suggestion);

      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt += 1) {
        try {
          await doc.send(new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: extractionTable,
                  Item: journal,
                  ConditionExpression:
                    'attribute_not_exists(itemId) OR (#state = :completed AND #identity <> :identity)',
                  ExpressionAttributeNames: { '#state': 'state', '#identity': 'identityKey' },
                  ExpressionAttributeValues: { ':completed': 'completed', ':identity': identityKey },
                },
              },
              {
                Delete: {
                  TableName: extractionTable,
                  Key: { itemId: input.suggestion.itemId },
                  ConditionExpression: identity.expression,
                  ExpressionAttributeNames: identity.names,
                  ExpressionAttributeValues: identity.values,
                },
              },
            ],
          }));
          return { status: 'claimed', journal };
        } catch (err) {
          if (isValidationFailure(err)) throw err;
          lastError = err;
          const [currentJournal, currentSuggestion] = await Promise.all([
            getJournal(contactId, target),
            getSuggestion(contactId, target),
          ]);
          if (
            currentJournal?.state === 'active' &&
            currentJournal.identityKey === identityKey &&
            currentJournal.leaseId === leaseId
          ) {
            return { status: 'claimed', journal: currentJournal };
          }
          if (currentJournal?.state === 'active') {
            return { status: 'blocked', journal: currentJournal };
          }
          if (currentJournal?.state === 'completed' && currentJournal.identityKey === identityKey) {
            return { status: 'completed', journal: currentJournal };
          }
          if (
            currentSuggestion === undefined ||
            suggestionIdentityKey(currentSuggestion) !== identityKey
          ) {
            return { status: 'suggestion_replaced' };
          }
          if (!isCancellation(err)) continue;
        }
      }
      const current = await getJournal(contactId, target);
      if (current?.state === 'active') return { status: 'blocked', journal: current };
      const currentSuggestion = await getSuggestion(contactId, target);
      if (
        currentSuggestion !== undefined &&
        suggestionIdentityKey(currentSuggestion) === identityKey &&
        lastError !== undefined
      ) {
        throw lastError;
      }
      return { status: 'suggestion_replaced' };
    },

    async takeover(input) {
      const leaseId = input.leaseId ?? randomUUID();
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + (input.leaseMs ?? DEFAULT_LEASE_MS),
      ).toISOString();
      try {
        const { Attributes } = await doc.send(new UpdateCommand({
          TableName: extractionTable,
          Key: { itemId: resolutionItemId(input.contactId, input.target) },
          UpdateExpression: 'SET #lease = :lease, #leaseExpiry = :leaseExpiry ADD #fence :one',
          ConditionExpression: '#state = :active AND #leaseExpiry <= :now',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#lease': 'leaseId',
            '#leaseExpiry': 'leaseExpiresAt',
            '#fence': 'fence',
          },
          ExpressionAttributeValues: {
            ':active': 'active',
            ':lease': leaseId,
            ':leaseExpiry': leaseExpiresAt,
            ':now': input.now,
            ':one': 1,
          },
          ReturnValues: 'ALL_NEW',
        }));
        return { status: 'taken_over', journal: Attributes as ActiveSuggestionResolution };
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        const current = await getJournal(input.contactId, input.target);
        if (current?.state === 'active') return { status: 'blocked', journal: current };
        return { status: 'missing' };
      }
    },

    async commitContactEffect(input) {
      const journal = await requireActive(input.token);
      if (journal === undefined) return 'stale';
      if (journal.plan.kind !== 'contact' && journal.plan.kind !== 'status') return 'stale';
      const sets: string[] = [];
      const removes: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let index = 0;
      for (const [key, value] of Object.entries(journal.plan.patch)) {
        if (value === undefined) continue;
        const name = `#k${index}`;
        names[name] = key;
        if (value === null) {
          removes.push(name);
        } else {
          const val = `:v${index}`;
          values[val] = value;
          sets.push(`${name} = ${val}`);
        }
        index += 1;
      }
      if (sets.length === 0 && removes.length === 0) return 'stale';
      const clauses = [
        ...(sets.length > 0 ? [`SET ${sets.join(', ')}`] : []),
        ...(removes.length > 0 ? [`REMOVE ${removes.join(', ')}`] : []),
      ];
      const audit = auditItem(journal);
      const contactGuard = contactGuardCondition(journal.plan.guard, true);
      const result = await transactPhase(input, [
        {
          Update: {
            TableName: contactsTable,
            Key: { contactId: journal.contactId },
            UpdateExpression: clauses.join(' '),
            ConditionExpression: contactGuard.expression,
            ExpressionAttributeNames: { ...names, ...contactGuard.names },
            ExpressionAttributeValues: { ...values, ...contactGuard.values },
          },
        },
        {
          Put: {
            TableName: auditTable,
            Item: audit,
            ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(ts)',
          },
        },
      ]);
      if (result !== 'stale') return result;

      const current = await getJournal(input.token.contactId, input.token.target);
      if (!sameToken(current, input.token) || current.phase !== input.expectedPhase) return 'stale';
      const { Item } = await doc.send(new GetCommand({
        TableName: contactsTable,
        Key: { contactId: journal.contactId },
        ConsistentRead: true,
      }));
      if (contactMatchesGuard(Item as ContactItem | undefined, journal.plan.guard)) {
        return 'stale';
      }

      const mismatchGuard = contactGuardCondition(journal.plan.guard, false);
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: contactsTable,
                Key: { contactId: journal.contactId },
                ConditionExpression: mismatchGuard.expression,
                ...(Object.keys(mismatchGuard.names).length > 0 && {
                  ExpressionAttributeNames: mismatchGuard.names,
                }),
                ...(Object.keys(mismatchGuard.values).length > 0 && {
                  ExpressionAttributeValues: mismatchGuard.values,
                }),
              },
            },
            { Update: journalSuperseded(extractionTable, input) },
          ],
        }));
        return 'superseded_by_human_edit';
      } catch (error) {
        if (isValidationFailure(error)) throw error;
        const after = await getJournal(input.token.contactId, input.token.target);
        if (
          sameToken(after, input.token)
          && after.phase === input.nextPhase
          && after.outcome === 'superseded_by_human_edit'
        ) {
          return 'superseded_by_human_edit';
        }
        return 'stale';
      }
    },

    async commitPhoneEffect(input) {
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt += 1) {
        const journal = await requireActive(input.token);
        if (journal === undefined || journal.plan.kind !== 'phone') return 'stale';
        const plan = journal.plan;
        const [{ Item: contactRaw }, { Item: pointerRaw }] = await Promise.all([
          doc.send(new GetCommand({
            TableName: contactsTable,
            Key: { contactId: journal.contactId },
            ConsistentRead: true,
          })),
          doc.send(new GetCommand({
            TableName: contactsTable,
            Key: { contactId: phoneRefId(plan.phone) },
            ConsistentRead: true,
          })),
        ]);
        const contact = contactRaw as ContactItem | undefined;
        if (contact === undefined) return 'stale';
        const pointer = pointerRaw as ContactItem | undefined;
        if (
          pointer !== undefined &&
          (pointer.phone_ref !== true || pointer.phone_ref_owner !== journal.contactId)
        ) {
          return 'phone_conflict';
        }
        const beforePhones = Array.isArray(contact.phones)
          ? contact.phones.map((phone) => ({ ...phone }))
          : undefined;
        // F6: this is contactsRepo.addPhone, replayed under the journal's fence.
        // Materialize through the WRITER seeder (keeps the primary's firstSeenAt
        // from created_at and stamps lastSeenAt), attach the accepted number as
        // NON-primary, and never write the `phone` scalar - addPhone promotes
        // nothing. journal.claimedAt is the clock so every replay writes the
        // same bytes.
        const phones: ContactPhone[] = seedPhonesForWrite(contact, journal.claimedAt);
        let targetPhone = phones.find((entry) => entry.phone === plan.phone);
        if (targetPhone === undefined) {
          phones.push({
            phone: plan.phone,
            primary: false,
            firstSeenAt: journal.claimedAt,
            lastSeenAt: journal.claimedAt,
            ...(plan.label !== undefined && { label: plan.label }),
          });
          targetPhone = phones[phones.length - 1];
        }
        const audit = auditItem(journal);
        const contactNames: Record<string, string> = { '#phones': 'phones' };
        const contactValues: Record<string, unknown> = { ':phones': phones };
        const sets = ['#phones = :phones'];
        let contactCondition: string;
        if (beforePhones === undefined) {
          if (contact.phone === undefined) {
            contactNames['#phone'] = 'phone';
            contactCondition =
              'attribute_exists(contactId) AND attribute_not_exists(#phones) AND attribute_not_exists(#phone)';
          } else {
            contactNames['#phone'] = 'phone';
            contactCondition =
              'attribute_exists(contactId) AND attribute_not_exists(#phones) AND #phone = :beforePrimary';
            contactValues[':beforePrimary'] = contact.phone;
          }
        } else {
          contactCondition = 'attribute_exists(contactId) AND #phones = :beforePhones';
          contactValues[':beforePhones'] = beforePhones;
        }
        // Pointer, inside the SAME fenced transaction: a non-primary number is
        // established or verified (a retry with a missing pointer repairs it),
        // while an accepted number that is ALREADY this contact's primary keeps
        // the "primary has no pointer" invariant - the delete only ever removes
        // our own dangling row.
        const needsPointer = targetPhone?.primary !== true;
        const effects: NonNullable<TransactWriteCommandInput['TransactItems']> = [
          {
            Update: {
              TableName: contactsTable,
              Key: { contactId: journal.contactId },
              UpdateExpression: `SET ${sets.join(', ')}`,
              ConditionExpression: contactCondition,
              ExpressionAttributeNames: contactNames,
              ExpressionAttributeValues: contactValues,
            },
          },
          ...(needsPointer
            ? [{
                Put: {
                  TableName: contactsTable,
                  Item: {
                    contactId: phoneRefId(plan.phone),
                    phone: plan.phone,
                    phone_ref: true,
                    phone_ref_owner: journal.contactId,
                  },
                  ConditionExpression:
                    'attribute_not_exists(contactId) OR (#phoneRef = :phoneRef AND #owner = :owner)',
                  ExpressionAttributeNames: {
                    '#phoneRef': 'phone_ref',
                    '#owner': 'phone_ref_owner',
                  },
                  ExpressionAttributeValues: {
                    ':phoneRef': true,
                    ':owner': journal.contactId,
                  },
                },
              }]
            : [{
                Delete: {
                  TableName: contactsTable,
                  Key: { contactId: phoneRefId(plan.phone) },
                  ConditionExpression:
                    'attribute_not_exists(contactId) OR #owner = :owner',
                  ExpressionAttributeNames: { '#owner': 'phone_ref_owner' },
                  ExpressionAttributeValues: { ':owner': journal.contactId },
                },
              }]),
          {
            Put: {
              TableName: auditTable,
              Item: audit,
              ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(ts)',
            },
          },
        ];
        const result = await transactPhase(input, effects);
        if (result !== 'stale') return result;
        const current = await getJournal(input.token.contactId, input.token.target);
        if (!sameToken(current, input.token) || current.phase !== input.expectedPhase) return 'stale';
      }
      return 'stale';
    },

    async commitActivityEffect(input) {
      const journal = await requireActive(input.token);
      if (journal === undefined) return 'stale';
      const activity = 'activity' in journal.plan ? journal.plan.activity : undefined;
      if (activity === undefined) return 'stale';
      const item = activityItem(journal, activity);
      return transactPhase(input, [
        {
          Put: {
            TableName: activityTable,
            Item: item,
            ConditionExpression:
              'attribute_not_exists(contactId) AND attribute_not_exists(tsEventId)',
          },
        },
      ]);
    },

    async commitDismissalEffect(input) {
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt += 1) {
        const journal = await requireActive(input.token);
        if (journal === undefined || journal.plan.kind !== 'dismiss') return 'stale';
        const pending = await getSuggestion(journal.contactId, journal.target);
        const sameNormalized =
          pending?._normalizedValue === journal.plan.normalizedValue;
        const audit = auditItem(journal);
        const pendingGuard = pending === undefined
          ? {
              ConditionCheck: {
                TableName: extractionTable,
                Key: { itemId: suggestionItemId(journal.contactId, journal.target) },
                ConditionExpression: 'attribute_not_exists(itemId)',
              },
            }
          : (() => {
              const identity = identityCondition(pending);
              const normalizedName = '#pendingNormalized';
              const normalizedValue = ':pendingNormalized';
              return {
                ConditionCheck: {
                  TableName: extractionTable,
                  Key: { itemId: pending.itemId },
                  ConditionExpression: pending._normalizedValue === undefined
                    ? `${identity.expression} AND attribute_not_exists(${normalizedName})`
                    : `${identity.expression} AND ${normalizedName} = ${normalizedValue}`,
                  ExpressionAttributeNames: {
                    ...identity.names,
                    [normalizedName]: '_normalizedValue',
                  },
                  ExpressionAttributeValues: {
                    ...identity.values,
                    ...(pending._normalizedValue !== undefined && {
                      [normalizedValue]: pending._normalizedValue,
                    }),
                  },
                },
              };
            })();
        const effects: NonNullable<TransactWriteCommandInput['TransactItems']> = [
          {
            Put: {
              TableName: extractionTable,
              Item: {
                itemId: dismissalItemId(
                  journal.contactId,
                  journal.target,
                  journal.plan.normalizedValue,
                ),
                contactId: journal.contactId,
                target: journal.target,
                dismissedValue: journal.plan.normalizedValue,
                createdAt: journal.claimedAt,
              },
            },
          },
          {
            Put: {
              TableName: auditTable,
              Item: audit,
              ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(ts)',
            },
          },
          ...(sameNormalized
            ? [{
                Delete: {
                  TableName: extractionTable,
                  Key: { itemId: pending.itemId },
                  ConditionExpression: '#normalized = :normalized',
                  ExpressionAttributeNames: { '#normalized': '_normalizedValue' },
                  ExpressionAttributeValues: { ':normalized': journal.plan.normalizedValue },
                },
              }]
            : [pendingGuard]),
        ];
        const result = await transactPhase(input, effects);
        if (result !== 'stale') return result;
        const current = await getJournal(input.token.contactId, input.token.target);
        if (!sameToken(current, input.token) || current.phase !== input.expectedPhase) return 'stale';
      }
      return 'stale';
    },

    async advancePhase(input) {
      return transactPhase(input, []);
    },

    async release(input) {
      const journal = await requireActive(input.token);
      if (journal === undefined || journal.phase !== input.expectedPhase) return 'stale';
      const guard = exactGuard(input.token, input.expectedPhase);
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: extractionTable,
                Item: journal.snapshot,
                ConditionExpression: 'attribute_not_exists(itemId)',
              },
            },
            {
              Delete: {
                TableName: extractionTable,
                Key: { itemId: journal.itemId },
                ConditionExpression: guard.expression,
                ExpressionAttributeNames: guard.names,
                ExpressionAttributeValues: guard.values,
              },
            },
          ],
        }));
        return 'released';
      } catch (err) {
        const [currentJournal, pending] = await Promise.all([
          getJournal(input.token.contactId, input.token.target),
          getSuggestion(input.token.contactId, input.token.target),
        ]);
        if (
          currentJournal === undefined &&
          pending !== undefined &&
          suggestionIdentityKey(pending) === journal.identityKey
        ) {
          return 'released';
        }
        if (pending !== undefined) return 'unsafe';
        if (!sameToken(currentJournal, input.token)) return 'stale';
        throw err;
      }
    },

    async complete(input) {
      const journal = await getJournal(input.token.contactId, input.token.target);
      if (
        journal?.state === 'completed' &&
        journal.identityKey === input.token.identityKey &&
        journal.action === input.token.action
      ) {
        return 'already_completed';
      }
      if (!sameToken(journal, input.token) || journal.phase !== input.expectedPhase) return 'stale';
      const completed = makeCompletedResolution(journal, input.completedAt, input.disposition);
      const guard = exactGuard(input.token, input.expectedPhase);
      for (let attempt = 0; attempt < MAX_CONTENTION_ATTEMPTS; attempt += 1) {
        try {
          await doc.send(new PutCommand({
            TableName: extractionTable,
            Item: completed,
            ConditionExpression: guard.expression,
            ExpressionAttributeNames: guard.names,
            ExpressionAttributeValues: guard.values,
          }));
          return 'completed';
        } catch (err) {
          if (isValidationFailure(err)) throw err;
          const current = await getJournal(input.token.contactId, input.token.target);
          if (current?.state === 'completed' && current.identityKey === input.token.identityKey) {
            return 'already_completed';
          }
          if (sameToken(current, input.token) && current.phase === input.expectedPhase) {
            if (!(err instanceof ConditionalCheckFailedException)) continue;
          }
          return 'stale';
        }
      }
      return 'stale';
    },
  };
}

// Kept explicit for focused fakes and downstream composition tests.
export type SuggestionResolutionDocumentClient = DynamoDBDocumentClient;
