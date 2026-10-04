// tours repo — first-class Tour entity (Tours feature).
//
// A Tour is a scheduled visit by a tenant to a unit. Tours are INDEPENDENT of
// placements: a tenant stays `searching` during the touring process; no touring
// stage. Tour status starts as 'scheduled' (if scheduledAt is provided) or
// 'requested' (if scheduledAt is absent — a time-less tour request). The exit
// gate captures `outcome`, `moveForward`, and `convertible` and leaves
// placement creation to the operator.
//
// GSIs:
//   byTenant      — all tours for a tenant (contact-file tours card)
//   byUnit        — all tours for a unit (property-file tours card)
//   byScheduledAt — time-windowed queries (today's tours, reminder/no-show clock).
//                   Hash key is the constant '_schedPartition = "tours"' so a
//                   datetime-range BETWEEN Query works without scatter-gather.
//                   Sparse: items without scheduledAt never appear here.
//   byStatus      — list all tours by status (e.g. all 'requested' tours for the
//                   dashboard queue). Hash key is 'status', range key is
//                   'createdAt' (ISO 8601, newest-last for BETWEEN pagination).
//
// Mirror of unitsRepo.ts conventions: RepoDeps DI, tableName(), PutCommand with
// existence guard, UpdateCommand SET/REMOVE loop, QueryCommand helpers.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { queryAll } from '../lib/dynamoPaging.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';
import { RosterPlanConflictError, type RosterEntry } from '../lib/rosterResolution.js';
import { isAutoCloseStatus, type AutoCloseStatus, type TourOutcome, type TourType } from '../lib/toursModel.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three ways a tour can be conducted (TourType) and the tour outcome
 *  (TourOutcome: exit gate + auto-close). Canonical home of both is
 *  lib/toursModel.ts; re-exported here so existing importers keep resolving
 *  from this repo, and so the outcome union can never drift from the model's
 *  TOUR_OUTCOMES (it was a hand-copied union until auto-close). */
export type { TourOutcome, TourType };

/** Tour status — mirrors TOUR_STATUSES in lib/toursModel.ts. */
export type TourStatus = string;

/**
 * One scheduled (or completed) tour: a tenant visiting a unit.
 *
 * Key/GSI attributes (contractual — changing these is a schema change):
 *   tourId           — table PK
 *   tenantId         — byTenant GSI hash
 *   unitId           — byUnit GSI hash
 *   _schedPartition  — byScheduledAt GSI hash (constant 'tours')
 *   scheduledAt      — byScheduledAt GSI range (sparse: absent → not indexed)
 *   status           — byStatus GSI hash
 *   createdAt        — byStatus GSI range
 */
export interface TourItem {
  tourId: string;
  /** byTenant GSI hash: the tenant's contactId. */
  tenantId: string;
  /** byUnit GSI hash: the unit being toured. */
  unitId: string;
  /**
   * ISO 8601 datetime of the scheduled visit. byScheduledAt GSI range.
   * Absent on a `requested` (timeless) tour — the attribute is OMITTED, never
   * written as undefined/null, so the sparse GSI does not index it.
   */
  scheduledAt?: string;
  /** Fixed constant 'tours' — byScheduledAt GSI hash partition key. */
  _schedPartition: 'tours';
  tourType: TourType;
  /** Lifecycle status. */
  status: TourStatus;
  /** Optional: the relay group conversationId for the tour thread. */
  groupThreadId?: string;
  /**
   * contact-rosters (spec D1): the roster PLAN - who this tour's relay group
   * will open with. ABSENT is the normal state and means "resolve from the
   * property" (tenant + the unit's primaryContact). It materializes on the
   * first human edit and is CONSUMED (deleted) when the group is provisioned:
   * once `groupThreadId` exists, the conversation's participants are the roster
   * and this attribute is inert (lib/rosterResolution.ts reads participants
   * first whenever the pointer is set).
   */
  roster?: RosterEntry[];
  /** Optimistic-concurrency guard for `roster` (see setRoster). */
  rosterVersion?: number;
  /** Post-tour outcome. Absent until the tour resolves. */
  outcome?: TourOutcome;
  /** Navigator decision: move forward toward placement? Absent until exit gate. */
  moveForward?: boolean;
  /** Navigator note: convertible to a placement? Absent until exit gate. */
  convertible?: boolean;
  /** Auto-close (spec 5.2): wall-clock ISO instant the sweep closed this tour.
   *  Present only while the tour is closed with outcome `no_outcome`; reopen
   *  removes it. */
  autoClosedAt?: string;
  /** Auto-close: the status the sweep closed the tour FROM (`scheduled`,
   *  `toured` or `no_show`) - reopen returns it there. Removed by reopen. */
  autoClosedFrom?: AutoCloseStatus;
  /** The latest instant a PERSON changed this tour's status or time (PATCH),
   *  or reopened it. The auto-close clock never starts before it. Never
   *  removed. */
  lastMarkedAt?: string;
  /**
   * GENERATION POINTER (supersession, 2026-09-01): the id of the reminder
   * ladder that is CURRENT for this tour. Reminder rows carry a matching
   * `ladderId`; a row that does not match has been superseded and every send
   * path refuses it.
   *
   * NEVER REMOVED. "This tour has no live ladder" is expressed by ROTATING this
   * to a fresh value that no row carries - not by clearing it, because `patch`
   * maps an explicit null to REMOVE and a cleared pointer would be
   * byte-identical to a never-migrated one. ABSENT means pre-migration,
   * permanently and only.
   *
   * DECLARATION ONLY. `[key: string]: unknown` below means PatchTourInput
   * collapses to an index-signature type, so `patch({ currentLadderId })` and a
   * misspelling of it both compile. Assert on the STORED row, never on the
   * typechecker.
   */
  currentLadderId?: string;
  /**
   * ISO 8601 - when `claimConversion` wrote the `pending:` sentinel that
   * `convertedPlacementId` is currently carrying. `releaseConversionClaim`
   * REMOVES it with the sentinel. A FINALIZE does not: it replaces the sentinel
   * through the ordinary patch and leaves this behind, INERT - every reader
   * gates on the `pending:` prefix first, so a stamp with no claim beside it is
   * never consulted.
   *
   * It exists because the poll's conversion-claim grace has to be measured from
   * something that means "the claim started", and `updatedAt` is
   * last-touched-by-ANYTHING: every patch, setRoster, claimGroupThread and
   * pointer rotation moves it, so on a tour edited more than once an hour a
   * STALLED claim never expired and the deferral was unbounded again (review
   * round NEW-2). This says what it means.
   */
  conversionClaimedAt?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/**
 * Input for creating a tour. tourId/createdAt/updatedAt/_schedPartition are
 * repo-generated. tenantId, unitId, and tourType are required; scheduledAt is
 * optional (absent → status 'requested'; present → status 'scheduled'); a
 * caller-supplied status always wins.
 */
export type CreateTourInput = Partial<TourItem> & {
  tenantId: string;
  unitId: string;
  /** Optional: absent → status defaults to 'requested'; present → 'scheduled'. */
  scheduledAt?: string;
  tourType: TourType;
};

/** Patch input: all fields optional except tourId (supplied as the first arg). */
export type PatchTourInput = Partial<
  Omit<TourItem, 'tourId' | '_schedPartition' | 'createdAt' | 'updatedAt'>
>;

/** Options for `patch`. Omitted, the patch is unconditional (beyond existence). */
export interface PatchTourOptions {
  /**
   * Write ONLY while the stored status still equals this - the status the
   * caller read and ran its guards on. A mismatch throws
   * ConditionalCheckFailedException, exactly like a missing tour; a caller
   * that must tell the two apart re-reads (PATCH /api/tours/:id does).
   */
  expectedStatus?: string;
}

export interface ToursRepo {
  /** Create a tour (generates tourId); returns the stored item. */
  create(input: CreateTourInput): Promise<TourItem>;
  /**
   * Get a tour by id; undefined when not found.
   *
   * EVENTUALLY CONSISTENT by default, like every other GetItem in this repo.
   * Pass `{ consistentRead: true }` when the caller must observe a write it
   * itself just issued - DynamoDB's default read is documented as possibly not
   * reflecting a recently completed write, and a handler that reads its own
   * patch back one line later is not guaranteed to see it (review round NEW-1,
   * reproduced with no concurrency at all). Opt-IN rather than always-on, the
   * `contactsRepo` idiom, so only the caller that needs it pays for it.
   */
  get(tourId: string, opts?: { consistentRead?: boolean }): Promise<TourItem | undefined>;
  /** All tours for a tenant via the byTenant GSI. */
  listByTenant(tenantId: string): Promise<TourItem[]>;
  /** All tours for a unit via the byUnit GSI. */
  listByUnit(unitId: string): Promise<TourItem[]>;
  /**
   * Tours whose scheduledAt is in [from, to] (inclusive ISO 8601 range) via
   * the byScheduledAt GSI. Powers "tours today", reminder sweeps, no-show checks.
   */
  listByScheduledRange(from: string, to: string): Promise<TourItem[]>;
  /**
   * All tours with the given status via the byStatus GSI (hash=status,
   * range=createdAt). Returns all pages concatenated (no cursor — dashboard
   * use; volumes are expected to remain low in Phase 1).
   */
  listByStatus(status: string): Promise<TourItem[]>;
  /**
   * SET-merge patch: only supplied fields are written; omitted fields are LEFT as
   * stored (no-overwrite contract). updatedAt is always bumped. Throws
   * ConditionalCheckFailedException when the tourId does not exist - and, with
   * `opts.expectedStatus`, when the stored status no longer equals it (tour
   * auto-close: a staff PATCH must not overwrite a close that landed after its
   * read). Returns the post-patch item (ALL_NEW).
   */
  patch(tourId: string, updates: PatchTourInput, opts?: PatchTourOptions): Promise<TourItem>;
  /**
   * Atomically CLAIM the tour's group-thread slot (relay provisioning): sets
   * groupThreadId to `value` ONLY when none exists yet. Throws
   * ConditionalCheckFailedException when the slot is already taken (or the
   * tour is missing) — the atomic half of the one-thread-per-tour guard, so
   * two concurrent provisions can never both buy a pool number.
   */
  claimGroupThread(tourId: string, value: string): Promise<void>;
  /**
   * Release a claim made by claimGroupThread when provisioning FAILS: removes
   * groupThreadId ONLY while it still equals `value` (never clobbers a real
   * conversation id written since). Best-effort — a lost condition is a no-op.
   */
  releaseGroupThreadClaim(tourId: string, value: string): Promise<void>;
  /**
   * Atomically CLAIM the tour's conversion slot (Post-Tour → placement): sets
   * convertedPlacementId to `value` ONLY when none exists yet. Throws
   * ConditionalCheckFailedException when the slot is already taken (or the tour
   * is missing) — the atomic half of the one-placement-per-tour guard, so two
   * concurrent POST /from-tour requests can never both create a placement
   * (mirror of claimGroupThread).
   */
  claimConversion(tourId: string, value: string): Promise<void>;
  /**
   * Release a conversion claim made by claimConversion when the conversion
   * FAILS before finalize: removes convertedPlacementId ONLY while it still
   * equals `value` (never clobbers the finalized placementId, or a newer claim,
   * written since). Best-effort — a lost condition is a no-op.
   */
  releaseConversionClaim(tourId: string, value: string): Promise<void>;
  /**
   * COMPARE-AND-SET the generation pointer: writes `currentLadderId = next`
   * ONLY while the stored value still equals `expected` (and the tour exists).
   *
   * This is the last step of a reschedule - rotate the pointer, sweep, arm,
   * then point at what was armed. Without the compare, two concurrent
   * reschedules interleave so that the pointer names a ladder the other request
   * already swept: two 200s, a silently disarmed tour, no error.
   *
   * Returns `false` on a lost compare (the other reschedule's rotation stands
   * and must NOT be clobbered) - never throws for it; the caller logs at error
   * and leaves its own rows unpointed, where the refusal rules will decline
   * them. Anything else propagates.
   */
  setLadderIdIf(tourId: string, expected: string, next: string): Promise<boolean>;
  /**
   * Write the roster PLAN under a conditional guard (contact-rosters section 7).
   * `expectedVersion === undefined` MATERIALIZES it - the write only lands when
   * no plan exists yet (`attribute_not_exists(roster)`); otherwise the stored
   * `rosterVersion` must equal `expectedVersion`. Either failure throws
   * RosterPlanConflictError so the caller re-reads and continues onto the
   * EXISTING override rather than clobbering a concurrent operator's edit.
   * Returns the post-write item (ALL_NEW) with the bumped version.
   */
  setRoster(
    tourId: string,
    roster: RosterEntry[],
    expectedVersion: number | undefined,
  ): Promise<TourItem>;
  /**
   * REMOVE the plan (roster + rosterVersion) - "the plan is consumed" at
   * provision, and "reset to property default" on the edit path. Unconditional
   * and idempotent: a tour with no plan is a no-op.
   */
  clearRoster(tourId: string): Promise<void>;
  /**
   * The auto-close sweep's ONE write (jobs/tourAutoClose.ts, spec 6.3): closes
   * `tour` with outcome `no_outcome` ONLY while the stored tour still has the
   * status read, no outcome, no conversion claim, is not convertible, and has
   * the same scheduledAt and the same lastMarkedAt as read (each ABSENT when
   * the read had none) - and, ONLY for a never-marked tour (the read carries
   * no lastMarkedAt), the same updatedAt, because that tour's clock counts
   * from it (ruling A-1, code-review/adjudications-r1.md). Once a mark exists
   * the clock ignores updatedAt, so it is not conditioned: a roster edit or a
   * group open does not block a due close. Residual: updatedAt is a
   * millisecond stamp, so a racing write stamped in the SAME millisecond as
   * the write the read saw leaves it unchanged and the close still lands - a
   * false negative of the guard. Rotates the reminder-ladder pointer to
   * `rotation` in the same write. Stamps autoClosedAt / updatedAt with the
   * WALL clock. Returns the post-write item, or undefined when the condition
   * failed (or the tour is missing) - never throws for that.
   */
  autoCloseIf(tour: TourItem, rotation: string): Promise<TourItem | undefined>;
  /**
   * Reopen a closed tour (POST /api/tours/:id/reopen, spec 7.3): status ->
   * `target`, lastMarkedAt -> `lastMarkedAt` (the route's clock), and REMOVE
   * outcome / moveForward / convertible / autoClosedAt / autoClosedFrom - ONLY
   * while it is still closed, unconverted, and carries the outcome and
   * autoClosedFrom the caller read (field equality). currentLadderId is left
   * alone (it names no live rows); nothing is armed. Returns the post-write
   * item, or undefined when the condition failed - never throws for that.
   */
  reopenIf(tour: TourItem, target: AutoCloseStatus, lastMarkedAt: string): Promise<TourItem | undefined>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToursRepo(deps: RepoDeps = {}): ToursRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('tours', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Shared single-partition GSI query (no range). */
  async function queryGsi(
    indexName: string,
    hashKeyName: string,
    hashKeyValue: string,
  ): Promise<TourItem[]> {
    // Paged to exhaustion: a single Query answers with at most 1 MB, and
    // dropping LastEvaluatedKey here silently hid a tenant's or a unit's later
    // tours. (listByStatus below already walked; this shared helper did not.)
    return queryAll<TourItem>(doc, {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#hk = :hv',
      ExpressionAttributeNames: { '#hk': hashKeyName },
      ExpressionAttributeValues: { ':hv': hashKeyValue },
    });
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const createdAt = typeof input.createdAt === 'string' ? input.createdAt : now;
      // Default status: 'requested' when no scheduledAt is provided (time-less
      // tour request); 'scheduled' when scheduledAt is supplied. A caller-supplied
      // status always wins (repo tests may pass an explicit status for seeding).
      const defaultStatus = typeof input.scheduledAt === 'string' ? 'scheduled' : 'requested';
      // Build the item WITHOUT scheduledAt when it is absent so the sparse
      // byScheduledAt GSI never indexes a 'requested' tour.
      const { scheduledAt: rawScheduledAt, ...restInput } = input;
      const item: TourItem = {
        ...restInput,
        tourId: input.tourId ?? `tour-${randomUUID()}`,
        _schedPartition: 'tours',
        status: input.status ?? defaultStatus,
        createdAt,
        updatedAt: now,
        // Only include scheduledAt when it is a non-empty string.
        ...(typeof rawScheduledAt === 'string' ? { scheduledAt: rawScheduledAt } : {}),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          // Defensive: never silently overwrite an existing tour on create.
          ConditionExpression: 'attribute_not_exists(tourId)',
        }),
      );
      log.info({ tourId: item.tourId, tenantId: item.tenantId, unitId: item.unitId }, 'tour created');
      return item;
    },

    async get(tourId, opts) {
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { tourId },
          // OMITTED unless asked for (never written as `false`), the
          // contactsRepo spread idiom - so the default request is byte-for-byte
          // what it has always been.
          ...(opts?.consistentRead === true && { ConsistentRead: true }),
        }),
      );
      return Item as TourItem | undefined;
    },

    async listByTenant(tenantId) {
      return queryGsi('byTenant', 'tenantId', tenantId);
    },

    async listByUnit(unitId) {
      return queryGsi('byUnit', 'unitId', unitId);
    },

    async listByScheduledRange(from, to) {
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byScheduledAt',
        KeyConditionExpression: '#sp = :sp AND #sat BETWEEN :from AND :to',
        ExpressionAttributeNames: {
          '#sp': '_schedPartition',
          '#sat': 'scheduledAt',
        },
        ExpressionAttributeValues: {
          ':sp': 'tours',
          ':from': from,
          ':to': to,
        },
      };
      const { Items } = await doc.send(new QueryCommand(input));
      return (Items ?? []) as TourItem[];
    },

    async listByStatus(status) {
      // Paginate the byStatus GSI (hash=status, range=createdAt). DynamoDB
      // returns at most 1 MB per page; follow ExclusiveStartKey until exhausted.
      const all: TourItem[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const input: QueryCommandInput = {
          TableName: table,
          IndexName: 'byStatus',
          KeyConditionExpression: '#st = :st',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':st': status },
          ...(lastKey !== undefined && { ExclusiveStartKey: lastKey }),
        };
        const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
        all.push(...((Items ?? []) as TourItem[]));
        lastKey = LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
      return all;
    },

    async patch(tourId, updates, opts) {
      // SET each supplied non-null field; REMOVE each explicit-null field
      // (the only way to truly clear an attribute). Omitted (undefined) fields
      // are LEFT untouched. Names are expression-aliased so reserved words are
      // always legal. updatedAt is always bumped.
      const sets: string[] = [];
      const removes: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) continue; // omitted → untouched
        const nameKey = `#k${i}`;
        names[nameKey] = key;
        if (value === null) {
          removes.push(nameKey);
        } else {
          const valueKey = `:v${i}`;
          values[valueKey] = value;
          sets.push(`${nameKey} = ${valueKey}`);
        }
        i += 1;
      }
      names['#updatedAt'] = 'updatedAt';
      values[':updatedAt'] = new Date().toISOString();
      sets.push('#updatedAt = :updatedAt');

      // Existence always; the caller's status precondition when it gave one. A
      // second placeholder for `status` is legal beside a `#k<i>` that SETs it
      // (only overlapping UPDATE paths are refused).
      const conditions = ['attribute_exists(tourId)'];
      if (opts?.expectedStatus !== undefined) {
        names['#expectedStatus'] = 'status';
        values[':expectedStatus'] = opts.expectedStatus;
        conditions.push('#expectedStatus = :expectedStatus');
      }

      const clauses = [`SET ${sets.join(', ')}`];
      if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          UpdateExpression: clauses.join(' '),
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ tourId, fields: sets.length - 1 + removes.length }, 'tour patched');
      return Attributes as TourItem;
    },

    async claimGroupThread(tourId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          UpdateExpression: 'SET #gt = :v, #updatedAt = :now',
          // Atomic one-thread-per-tour: only the FIRST claimant wins; a
          // concurrent provision loses here BEFORE any pool number is bought.
          ConditionExpression: 'attribute_exists(tourId) AND attribute_not_exists(#gt)',
          ExpressionAttributeNames: { '#gt': 'groupThreadId', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
        }),
      );
      log.info({ tourId }, 'tour group-thread slot claimed');
    },

    async releaseGroupThreadClaim(tourId, value) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId },
            UpdateExpression: 'REMOVE #gt SET #updatedAt = :now',
            // Only release OUR claim — never clobber a real conversation id
            // (or another claimant) written since.
            ConditionExpression: '#gt = :v',
            ExpressionAttributeNames: { '#gt': 'groupThreadId', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId }, 'group-thread claim release lost (superseded) — no-op');
          return;
        }
        throw err;
      }
      log.info({ tourId }, 'tour group-thread claim released (provisioning failed)');
    },

    async claimConversion(tourId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          // The claim STAMP rides the same write as the sentinel (review round
          // NEW-2): the poll's grace window has to measure from when the claim
          // started, and updatedAt is last-touched-by-anything.
          UpdateExpression: 'SET #cp = :v, #cca = :now, #updatedAt = :now',
          // Atomic one-placement-per-tour: only the FIRST claimant wins; a
          // concurrent /from-tour POST loses here BEFORE any placement row is
          // created (mirrors claimGroupThread).
          ConditionExpression: 'attribute_exists(tourId) AND attribute_not_exists(#cp)',
          ExpressionAttributeNames: {
            '#cp': 'convertedPlacementId',
            '#cca': 'conversionClaimedAt',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
        }),
      );
      log.info({ tourId }, 'tour conversion slot claimed');
    },

    async releaseConversionClaim(tourId, value) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId },
            // BOTH halves of the claim go, or the stamp outlives the sentinel it
            // describes and the next claim on this tour starts its grace window
            // from a stranger's clock.
            UpdateExpression: 'REMOVE #cp, #cca SET #updatedAt = :now',
            // Only release OUR sentinel — never clobber the finalized
            // placementId (or a newer claim) written since.
            ConditionExpression: '#cp = :v',
            ExpressionAttributeNames: {
              '#cp': 'convertedPlacementId',
              '#cca': 'conversionClaimedAt',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId }, 'conversion claim release lost (superseded) — no-op');
          return;
        }
        throw err;
      }
      log.info({ tourId }, 'tour conversion claim released (conversion failed)');
    },

    async setLadderIdIf(tourId, expected, next) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId },
            UpdateExpression: 'SET #cl = :next, #updatedAt = :now',
            // Value-guarded, like releaseConversionClaim: only advance the
            // pointer we ourselves rotated. attribute_exists(tourId) keeps
            // UpdateItem from conjuring an attribute-only stub for a missing
            // tour (an equality on an absent attribute is false anyway, but the
            // guard is the one this repo states everywhere else).
            ConditionExpression: 'attribute_exists(tourId) AND #cl = :expected',
            ExpressionAttributeNames: { '#cl': 'currentLadderId', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: {
              ':expected': expected,
              ':next': next,
              ':now': new Date().toISOString(),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // A lost compare is a REAL outcome, not an error: a concurrent
          // reschedule rotated the pointer and owns the tour's ladder now. The
          // caller decides how loud that is.
          log.debug({ tourId }, 'tour ladder pointer write lost the compare - no-op');
          return false;
        }
        throw err;
      }
      log.info({ tourId }, 'tour ladder pointer advanced');
      return true;
    },

    async setRoster(tourId, roster, expectedVersion) {
      const nextVersion = (expectedVersion ?? 0) + 1;
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId },
            UpdateExpression: 'SET #r = :r, #rv = :nv, #updatedAt = :now',
            // MATERIALIZE (no expectedVersion) vs OPTIMISTIC UPDATE: the first
            // may only create the plan, the second may only advance the exact
            // version the caller read.
            //
            // The materialize is ALSO guarded by the thread pointer (D1): once a
            // thread exists the roster is a FACT, and provision CLEARS the plan -
            // so attribute_not_exists(roster) goes true again and a plan edit
            // racing a concurrent open would otherwise write a fresh plan onto a
            // thread-bearing tour. That plan is INERT (the resolver reads
            // participants whenever the pointer is set), so the request would
            // answer "saved" for an edit that changes nothing. Refuse instead;
            // services/rosterEdits re-reads and answers 409 thread_exists.
            ConditionExpression:
              expectedVersion === undefined
                ? 'attribute_exists(tourId) AND attribute_not_exists(#r) AND attribute_not_exists(#gt)'
                : 'attribute_exists(tourId) AND #rv = :ev',
            ExpressionAttributeNames: {
              '#r': 'roster',
              '#rv': 'rosterVersion',
              '#updatedAt': 'updatedAt',
              ...(expectedVersion === undefined && { '#gt': 'groupThreadId' }),
            },
            ExpressionAttributeValues: {
              ':r': roster,
              ':nv': nextVersion,
              ':now': new Date().toISOString(),
              ...(expectedVersion !== undefined && { ':ev': expectedVersion }),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ tourId, memberCount: roster.length, rosterVersion: nextVersion }, 'tour roster plan written');
        return Attributes as TourItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) throw new RosterPlanConflictError();
        throw err;
      }
    },

    async clearRoster(tourId) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          UpdateExpression: 'REMOVE #r, #rv SET #updatedAt = :now',
          ConditionExpression: 'attribute_exists(tourId)',
          ExpressionAttributeNames: { '#r': 'roster', '#rv': 'rosterVersion', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        }),
      );
      log.info({ tourId }, 'tour roster plan cleared');
    },

    async autoCloseIf(tour, rotation) {
      // Defense in depth (spec 6.3): only a candidate status may ever be
      // closed as no_outcome, whatever the caller's due filter did.
      if (!isAutoCloseStatus(tour.status)) return undefined;
      const now = new Date().toISOString();
      const names: Record<string, string> = {
        '#st': 'status',
        '#oc': 'outcome',
        '#acf': 'autoClosedFrom',
        '#aca': 'autoClosedAt',
        '#cl': 'currentLadderId',
        '#ua': 'updatedAt',
        '#cp': 'convertedPlacementId',
        '#cv': 'convertible',
        '#sa': 'scheduledAt',
        '#lm': 'lastMarkedAt',
      };
      const values: Record<string, unknown> = {
        ':closed': 'closed',
        ':noOutcome': 'no_outcome',
        ':from': tour.status,
        ':now': now,
        ':rot': rotation,
        ':true': true,
      };
      const conditions = [
        'attribute_exists(tourId)',
        '#st = :from',
        'attribute_not_exists(#oc)',
        'attribute_not_exists(#cp)',
        '(attribute_not_exists(#cv) OR #cv <> :true)',
      ];
      if (typeof tour.scheduledAt === 'string') {
        values[':sa'] = tour.scheduledAt;
        conditions.push('#sa = :sa');
      } else {
        conditions.push('attribute_not_exists(#sa)');
      }
      if (typeof tour.lastMarkedAt === 'string') {
        values[':lm'] = tour.lastMarkedAt;
        conditions.push('#lm = :lm');
      } else {
        conditions.push('attribute_not_exists(#lm)');
        // Never marked: updatedAt IS the clock's mark (toursModel
        // autoCloseDueAtMs), so a write that moved it since our read - a
        // roster edit, a group open - restarted the clock and wins (ruling A-1,
        // code-review/adjudications-r1.md). Not conditioned once a mark exists:
        // the clock ignores updatedAt then, and such writes must not block a
        // due close. A row without updatedAt is written by nothing, but the
        // branch stays total.
        if (typeof tour.updatedAt === 'string') {
          values[':ua'] = tour.updatedAt;
          conditions.push('#ua = :ua');
        } else {
          conditions.push('attribute_not_exists(#ua)');
        }
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId: tour.tourId },
            UpdateExpression:
              'SET #st = :closed, #oc = :noOutcome, #acf = :from, #aca = :now, #cl = :rot, #ua = :now',
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        // debug, not info: the job owns the ONE info line per closed tour.
        log.debug({ tourId: tour.tourId, from: tour.status }, 'tour auto-close write landed');
        return Attributes as TourItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId: tour.tourId }, 'tour auto-close lost its condition - skipped');
          return undefined;
        }
        throw err;
      }
    },

    async reopenIf(tour, target, lastMarkedAt) {
      const names: Record<string, string> = {
        '#st': 'status',
        '#lm': 'lastMarkedAt',
        '#ua': 'updatedAt',
        '#oc': 'outcome',
        '#mf': 'moveForward',
        '#cv': 'convertible',
        '#aca': 'autoClosedAt',
        '#acf': 'autoClosedFrom',
        '#cp': 'convertedPlacementId',
      };
      const values: Record<string, unknown> = {
        ':closed': 'closed',
        ':target': target,
        ':lm': lastMarkedAt,
        ':now': new Date().toISOString(),
      };
      const conditions = ['attribute_exists(tourId)', '#st = :closed', 'attribute_not_exists(#cp)'];
      if (typeof tour.outcome === 'string') {
        values[':oc'] = tour.outcome;
        conditions.push('#oc = :oc');
      } else {
        conditions.push('attribute_not_exists(#oc)');
      }
      if (typeof tour.autoClosedFrom === 'string') {
        values[':acf'] = tour.autoClosedFrom;
        conditions.push('#acf = :acf');
      } else {
        conditions.push('attribute_not_exists(#acf)');
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId: tour.tourId },
            UpdateExpression: 'SET #st = :target, #lm = :lm, #ua = :now REMOVE #oc, #mf, #cv, #aca, #acf',
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        // debug, not info: the route owns the ONE info line per reopen.
        log.debug({ tourId: tour.tourId, to: target }, 'tour reopen write landed');
        return Attributes as TourItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId: tour.tourId }, 'tour reopen lost its condition');
          return undefined;
        }
        throw err;
      }
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
