// Pending roster actions repo - the durable rows behind contact-rosters spec
// 5.3: a roster change the operator confirmed DURING QUIET HOURS, held until
// dueAt (quiet-end) and then applied by the roster-actions poller.
//
// Each row: { actionId, ownerKey, ownerType, ownerId, action, contactId?,
//             dueAt (ISO), reason, status, skippedReason?, resolvedAt?,
//             dismissedAt?, createdAt }
//
// GSI byDueAt: hash='roster_actions' (fixed partition key _actionPartition),
// range=dueAt (ISO) - the poll queries "due now" with dueAt <= now, ascending
// (due-first). The partition attribute is stamped on EVERY row: this index is
// NOT sparse, so a row can never quietly fall out of the poller's view.
//
// GSI byOwner: hash=ownerKey (`${ownerType}#${ownerId}`) - the People card's
// pending/skipped rows, and the row set conversion migrates.
//
// THE PK IS THE DEDUPE. actionId is DETERMINISTIC:
//   open_group  -> `${ownerType}#${ownerId}#open`
//   add_member  -> `${ownerType}#${ownerId}#add#${contactId}`
// so spec 5.3's "at most one PENDING open per owner, at most one PENDING add
// per (owner, contact)" is a property of the key space, not of a conditional
// write that could race. Same idea as placementDeadlinesRepo's
// `${placementId}#${type}`.
//
// The claim-before-act discipline (claimApply/claimSkip/cancel, each conditional
// on status still being 'pending') is the tourRemindersRepo/placementNudgesRepo
// pattern with the spec's explicit `status` field in place of their
// sentAt/canceledAt/skippedAt attribute-existence probes.
//
// PII (doc section 9): log ids, kinds and counts only - never names or phones.
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
import type { RepoDeps } from './conversationsRepo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors RosterOwner['type'] in lib/rosterResolution.ts (no import: repos are
 *  the lower layer, and the resolver imports repos). */
export type RosterActionOwnerType = 'tour' | 'placement';

/** What was deferred: opening the relay group, or adding one member to it. */
export type RosterActionKind = 'open_group' | 'add_member';

/** Why the action was deferred. Quiet hours is the only deferral today (5.3). */
export type RosterActionReason = 'quiet_hours';

/** pending is the only NON-terminal state; the other three are all terminal. */
export type RosterActionStatus = 'pending' | 'applied' | 'skipped' | 'canceled';

/** Why the poller retired an action WITHOUT applying it (spec 5.3). The world
 *  moved under the action between confirm and quiet-end; the row stays VISIBLE
 *  with its reason (6.5) instead of vanishing. */
export type RosterActionSkipReason =
  | 'group_closed'
  /** Tour canceled / placement closed. */
  | 'owner_canceled'
  | 'already_member'
  | 'contact_deleted'
  /** The member was removed from the roster while the add was pending. */
  | 'member_no_longer_on_roster'
  /** The roster lost its second reachable member, so no group can be opened. */
  | 'roster_too_thin'
  /** Live relay-number provisioning is OFF in this environment
   *  (RELAY_LIVE_PROVISIONING, the pre-A2P posture), so no relay group can be
   *  opened. Checked BEFORE the claim: the refusal is otherwise raised inside
   *  provisioning, i.e. after the row is already terminal, where the operator
   *  would see neither a group nor a notice. */
  | 'provisioning_unavailable'
  /** Only when migration to the converted placement failed. */
  | 'converted';

/** The owner a set of actions belongs to (a tour or the placement it became). */
export interface RosterActionOwnerRef {
  ownerType: RosterActionOwnerType;
  ownerId: string;
}

/**
 * The identity of one action. The union enforces the spec's shape at compile
 * time: an add_member always names its contact, an open_group never does.
 */
export type RosterActionKey =
  | (RosterActionOwnerRef & { action: 'open_group'; contactId?: undefined })
  | (RosterActionOwnerRef & { action: 'add_member'; contactId: string });

export interface PendingRosterActionItem {
  /** PK - DETERMINISTIC, see the module header. */
  actionId: string;
  /** byOwner GSI hash key - `${ownerType}#${ownerId}`. */
  ownerKey: string;
  ownerType: RosterActionOwnerType;
  ownerId: string;
  action: RosterActionKind;
  /** add_member only. */
  contactId?: string;
  /** ISO 8601 - byDueAt GSI range key (quiet-end, when the poller acts). */
  dueAt: string;
  /** byDueAt GSI hash key (fixed value 'roster_actions'), on EVERY row. */
  _actionPartition: 'roster_actions';
  reason: RosterActionReason;
  status: RosterActionStatus;
  /** Set with status 'skipped'. */
  skippedReason?: RosterActionSkipReason;
  /** ISO - WHEN the terminal status landed (applied/skipped/canceled). */
  resolvedAt?: string;
  /** ISO - the operator dismissed this TERMINAL row's notice from the card
   *  (spec 6.5 "visible until dismissed"). The row stays readable; the card
   *  layer is what excludes dismissed rows from its skipped[] list. */
  dismissedAt?: string;
  /** ISO - when this pending row was born. A supersede REPLACES the row, so
   *  this is the latest confirm's instant, not the first one's. */
  createdAt: string;
  [key: string]: unknown;
}

export interface UpsertPendingInput {
  ownerType: RosterActionOwnerType;
  ownerId: string;
  action: RosterActionKind;
  /** Required for add_member (the deterministic key embeds it). */
  contactId?: string;
  /** ISO 8601 - quiet-end. */
  dueAt: string;
  /** Defaults to 'quiet_hours', the only deferral reason today. */
  reason?: RosterActionReason;
  /** ISO - the birth stamp. Explicit so callers pin the instant they are
   *  already reasoning with (the poller's nowIso, the route's now). */
  createdAt?: string;
}

export interface PendingRosterActionsRepo {
  /**
   * SUPERSEDE SEMANTICS - deliberately an UNCONDITIONAL Put. This is NOT the
   * `create` of the reminder/nudge repos and the missing
   * `attribute_not_exists(...)` is not an oversight:
   *
   * The key is deterministic, so this Put REPLACES whatever row already holds
   * it. Two cases, both intended:
   *   - a PENDING row is rewritten with the NEW dueAt. Spec 5.3: "a duplicate
   *     confirm SUPERSEDES the earlier pending action (new dueAt), never queues
   *     a second" - otherwise the second apply would resolve to a spurious
   *     `already_member` skipped row.
   *   - a TERMINAL row (applied/skipped/canceled) is overwritten back to
   *     PENDING, deliberately RETIRING its old notice. A live pending action
   *     about a contact beats a stale skip notice about the same contact: the
   *     card must not show "could not add Alicia" next to "adds Alicia at 8 AM".
   *
   * Only this method may resurrect a key. The claim transitions
   * (claimApply/claimSkip/cancel) all refuse a terminal row, so the poller can
   * never revive one by accident.
   */
  upsertPending(input: UpsertPendingInput): Promise<PendingRosterActionItem>;
  getById(actionId: string): Promise<PendingRosterActionItem | undefined>;
  /** Every action row for one owner (byOwner GSI), any status. Paginated. */
  listByOwner(owner: RosterActionOwnerRef): Promise<PendingRosterActionItem[]>;
  /** Pending actions due at or before `nowIso`, DUE-FIRST (byDueAt). Paginated. */
  listDue(nowIso: string): Promise<PendingRosterActionItem[]>;
  /**
   * Atomically claim a row BEFORE applying it (claim-before-act). Conditional
   * on status still being 'pending', so two poll ticks over the same row - or a
   * poll racing an operator cancel - resolve to exactly one outcome. Returns
   * true when this call won the claim, false (benign) when the row was already
   * terminal.
   */
  claimApply(actionId: string, appliedAt: string): Promise<boolean>;
  /**
   * Atomically retire a row WITHOUT applying it (claim-skip): stamps
   * skippedReason under the same pending-only condition, so a skipped row leaves
   * listDue exactly once and can never be applied later. The row stays VISIBLE
   * on the card with its reason until dismissed (spec 6.5).
   */
  claimSkip(actionId: string, skippedAt: string, reason: RosterActionSkipReason): Promise<boolean>;
  /** Operator cancel of a pending action. Same pending-only condition. */
  cancel(actionId: string, canceledAt: string): Promise<boolean>;
  /**
   * Dismiss a TERMINAL row's notice (spec 6.5). Conditional on the row existing,
   * being terminal and not already dismissed - dismissing a live pending action
   * would hide work that is still going to happen, so it is refused.
   */
  dismiss(actionId: string, dismissedAt: string): Promise<boolean>;
  /**
   * Move an owner's PENDING actions to a new owner (tour -> the placement it
   * converted into, spec D4/7). The deterministic id EMBEDS the owner, so this
   * cannot be an in-place update: each row is re-Put under its NEW key and the
   * old row deleted. Terminal rows stay with the old owner - their notice
   * belongs to that history, not to the new owner's card. Returns the rows as
   * they now exist under the new owner.
   */
  migrate(from: RosterActionOwnerRef, to: RosterActionOwnerRef): Promise<PendingRosterActionItem[]>;
}

// ---------------------------------------------------------------------------
// Deterministic keys
// ---------------------------------------------------------------------------

/** The byOwner GSI hash key for a tour/placement. */
export function rosterActionOwnerKey(owner: RosterActionOwnerRef): string {
  return `${owner.ownerType}#${owner.ownerId}`;
}

/** The deterministic PK for one action (see the module header). */
export function rosterActionIdFor(key: RosterActionKey): string {
  return key.action === 'add_member'
    ? `${key.ownerType}#${key.ownerId}#add#${key.contactId}`
    : `${key.ownerType}#${key.ownerId}#open`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPendingRosterActionsRepo(deps: RepoDeps = {}): PendingRosterActionsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('pendingRosterActions', deps.env);
  const log = deps.logger ?? defaultLogger;

  /**
   * Narrow an input to its identity - the one place add_member's contactId
   * requirement is enforced at runtime (the exported RosterActionKey union
   * enforces it at compile time for direct callers of rosterActionIdFor).
   */
  function keyOf(input: UpsertPendingInput): RosterActionKey {
    const { ownerType, ownerId } = input;
    if (input.action === 'open_group') return { ownerType, ownerId, action: 'open_group' };
    const contactId = input.contactId;
    if (contactId === undefined || contactId === '') {
      throw new Error('pendingRosterActions: add_member requires a contactId');
    }
    return { ownerType, ownerId, action: 'add_member', contactId };
  }

  /** Build the stored item for a (re)birth as PENDING. */
  function pendingItem(input: UpsertPendingInput, createdAt: string): PendingRosterActionItem {
    const key = keyOf(input);
    return {
      actionId: rosterActionIdFor(key),
      ownerKey: rosterActionOwnerKey(key),
      ownerType: key.ownerType,
      ownerId: key.ownerId,
      action: key.action,
      ...(key.action === 'add_member' && { contactId: key.contactId }),
      dueAt: input.dueAt,
      _actionPartition: 'roster_actions',
      reason: input.reason ?? 'quiet_hours',
      status: 'pending',
      createdAt,
    };
  }

  /**
   * The three terminal transitions differ only in the status they set and the
   * extra attribute they stamp - the CONDITION (status is still 'pending') is
   * identical, which is what makes every terminal state a one-way door.
   */
  async function claimTerminal(
    actionId: string,
    status: Exclude<RosterActionStatus, 'pending'>,
    resolvedAt: string,
    skippedReason?: RosterActionSkipReason,
  ): Promise<boolean> {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { actionId },
          UpdateExpression:
            skippedReason === undefined
              ? 'SET #status = :status, #resolvedAt = :resolvedAt'
              : 'SET #status = :status, #resolvedAt = :resolvedAt, #skippedReason = :skippedReason',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#resolvedAt': 'resolvedAt',
            ...(skippedReason !== undefined && { '#skippedReason': 'skippedReason' }),
          },
          ExpressionAttributeValues: {
            ':status': status,
            ':resolvedAt': resolvedAt,
            ':pending': 'pending',
            ...(skippedReason !== undefined && { ':skippedReason': skippedReason }),
          },
        }),
      );
      log.info({ actionId, status, resolvedAt, ...(skippedReason !== undefined && { skippedReason }) }, 'pending roster action claimed');
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Benign: another poll tick, a cancel, or an operator apply-now won the
        // race and the row is already terminal.
        log.debug({ actionId, status }, 'pending roster action claim lost (already terminal) - skipping');
        return false;
      }
      throw err;
    }
  }

  async function listByOwner(owner: RosterActionOwnerRef): Promise<PendingRosterActionItem[]> {
    const baseInput: QueryCommandInput = {
      TableName: table,
      IndexName: 'byOwner',
      KeyConditionExpression: '#ownerKey = :ownerKey',
      ExpressionAttributeNames: { '#ownerKey': 'ownerKey' },
      ExpressionAttributeValues: { ':ownerKey': rosterActionOwnerKey(owner) },
    };
    return queryAll(baseInput);
  }

  /** Walk every page so rows past the 1 MB limit are never silently dropped. */
  async function queryAll(baseInput: QueryCommandInput): Promise<PendingRosterActionItem[]> {
    const items: PendingRosterActionItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await doc.send(
        new QueryCommand({
          ...baseInput,
          ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      items.push(...((page.Items as PendingRosterActionItem[] | undefined) ?? []));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  return {
    async upsertPending(input) {
      const item = pendingItem(input, input.createdAt ?? new Date().toISOString());
      // UNCONDITIONAL by design - see the interface docblock (supersede).
      await doc.send(new PutCommand({ TableName: table, Item: item }));
      log.info(
        { actionId: item.actionId, ownerKey: item.ownerKey, action: item.action, dueAt: item.dueAt },
        'pending roster action upserted (pending)',
      );
      return item;
    },

    async getById(actionId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { actionId } }));
      return Item === undefined ? undefined : (Item as PendingRosterActionItem);
    },

    listByOwner,

    async listDue(nowIso) {
      // byDueAt: every row in the fixed 'roster_actions' partition with
      // dueAt <= now, ascending (due-first). The filter drops rows that already
      // reached a terminal status - the poller must never see them again.
      const baseInput: QueryCommandInput = {
        TableName: table,
        IndexName: 'byDueAt',
        KeyConditionExpression: '#ap = :ap AND #dueAt <= :now',
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: {
          '#ap': '_actionPartition',
          '#dueAt': 'dueAt',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':ap': 'roster_actions',
          ':now': nowIso,
          ':pending': 'pending',
        },
        ScanIndexForward: true,
      };
      return queryAll(baseInput);
    },

    async claimApply(actionId, appliedAt) {
      return claimTerminal(actionId, 'applied', appliedAt);
    },

    async claimSkip(actionId, skippedAt, reason) {
      return claimTerminal(actionId, 'skipped', skippedAt, reason);
    },

    async cancel(actionId, canceledAt) {
      return claimTerminal(actionId, 'canceled', canceledAt);
    },

    async dismiss(actionId, dismissedAt) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { actionId },
            UpdateExpression: 'SET #dismissedAt = :dismissedAt',
            ConditionExpression:
              'attribute_exists(#actionId) AND #status <> :pending AND attribute_not_exists(#dismissedAt)',
            ExpressionAttributeNames: {
              '#actionId': 'actionId',
              '#status': 'status',
              '#dismissedAt': 'dismissedAt',
            },
            ExpressionAttributeValues: { ':pending': 'pending', ':dismissedAt': dismissedAt },
          }),
        );
        log.info({ actionId, dismissedAt }, 'pending roster action notice dismissed');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug(
            { actionId },
            'pending roster action dismiss refused (missing, still pending, or already dismissed)',
          );
          return false;
        }
        throw err;
      }
    },

    async migrate(from, to) {
      const rows = (await listByOwner(from)).filter((r) => r.status === 'pending');
      // Put the new row BEFORE deleting the old one: a failure mid-row leaves a
      // duplicate the next migrate cleans up, never a lost deferred action.
      const results = await Promise.allSettled(
        rows.map(async (row) => {
          const moved = pendingItem(
            {
              ownerType: to.ownerType,
              ownerId: to.ownerId,
              action: row.action,
              ...(row.contactId !== undefined && { contactId: row.contactId }),
              dueAt: row.dueAt,
              reason: row.reason,
            },
            row.createdAt,
          );
          await doc.send(new PutCommand({ TableName: table, Item: moved }));
          await doc.send(new DeleteCommand({ TableName: table, Key: { actionId: row.actionId } }));
          return moved;
        }),
      );
      const moved: PendingRosterActionItem[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          moved.push(result.value);
        } else {
          log.error(
            { err: result.reason, fromOwnerKey: rosterActionOwnerKey(from), toOwnerKey: rosterActionOwnerKey(to) },
            'pending roster action migrate: row failed',
          );
        }
      }
      log.info(
        {
          fromOwnerKey: rosterActionOwnerKey(from),
          toOwnerKey: rosterActionOwnerKey(to),
          migrated: moved.length,
          attempted: rows.length,
        },
        'pending roster actions migrated to new owner',
      );
      return moved;
    },
  };
}
