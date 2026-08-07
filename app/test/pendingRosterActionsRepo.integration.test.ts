// pendingRosterActions repo integration tests against DynamoDB Local
// (contact-rosters Task 12, spec 5.3).
//
// Covers:
//   1. upsertPending round-trip: DETERMINISTIC actionId, ownerKey, the fixed
//      _actionPartition, status 'pending' (both shapes: open_group + add_member)
//   2. listDue: dueAt <= now INCLUSIVE, due-first ordering, future rows excluded
//   3. claim transitions are TERMINAL: claimApply wins exactly once, and a
//      terminal row refuses every other claim (apply/skip/cancel)
//   4. deterministic-id dedupe: a second upsert of the same add SUPERSEDES
//      (new dueAt, still exactly one row) - never a duplicate
//   5. supersede over a TERMINAL row: an upsert onto a SKIPPED row resurrects
//      it to pending and retires the old notice
//   6. dismiss stamps dismissedAt on a terminal row (still listable, so the
//      card layer can exclude it from skipped[]) and refuses a pending row
//   7. migrate: rows move to the new ownerKey AND the new deterministic PK
//
// Mirrors placementNudgesRepo.integration.test.ts harness idioms (throwaway-
// prefix table, self-skipping when no DynamoDB Local answers at
// DYNAMODB_ENDPOINT). Every timestamp is pinned - no wall-clock assertions.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import {
  createPendingRosterActionsRepo,
  rosterActionIdFor,
  rosterActionOwnerKey,
} from '../src/repos/pendingRosterActionsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[pendingRosterActionsRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/** A fresh tour id per test - the byDueAt partition is shared by every row. */
function tourId(label: string): string {
  return `tour-${label}-${randomUUID().slice(0, 8)}`;
}

describe.skipIf(!reachable)(
  'pendingRosterActionsRepo against DynamoDB Local (throwaway prefix)',
  () => {
    const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    const client = createDynamoClient({ endpoint });
    const doc = createDocumentClient({ endpoint });
    const logger = createLogger({ destination: createLogCapture().stream });
    const actions = createPendingRosterActionsRepo({ doc, env: testEnv, logger });

    beforeAll(async () => {
      await ensureTable(
        client,
        getTableSpec('pendingRosterActions'),
        tableName('pendingRosterActions', testEnv),
      );
    }, 120_000);

    afterAll(async () => {
      await deleteTableIfExists(client, tableName('pendingRosterActions', testEnv));
      doc.destroy();
      client.destroy();
    }, 120_000);

    it('upsertPending stamps the deterministic id, ownerKey, fixed partition and pending status', async () => {
      const ownerId = tourId('create');

      const open = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T13:00:00.000Z',
        createdAt: '2026-08-05T04:30:00.000Z',
      });

      expect(open.actionId).toBe(`tour#${ownerId}#open`);
      expect(open.ownerKey).toBe(`tour#${ownerId}`);
      expect(open.ownerType).toBe('tour');
      expect(open.ownerId).toBe(ownerId);
      expect(open.action).toBe('open_group');
      expect(open.contactId).toBeUndefined();
      expect(open.dueAt).toBe('2026-08-05T13:00:00.000Z');
      expect(open._actionPartition).toBe('roster_actions');
      expect(open.reason).toBe('quiet_hours');
      expect(open.status).toBe('pending');
      expect(open.createdAt).toBe('2026-08-05T04:30:00.000Z');
      expect(open.resolvedAt).toBeUndefined();
      expect(open.dismissedAt).toBeUndefined();

      const add = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-05T13:00:00.000Z',
        createdAt: '2026-08-05T04:31:00.000Z',
      });

      expect(add.actionId).toBe(`tour#${ownerId}#add#contact-alicia`);
      expect(add.contactId).toBe('contact-alicia');

      // Both rows read back by key and by owner.
      expect((await actions.getById(open.actionId))?.dueAt).toBe('2026-08-05T13:00:00.000Z');
      const owned = await actions.listByOwner({ ownerType: 'tour', ownerId });
      expect(owned.map((r) => r.actionId).sort()).toEqual([add.actionId, open.actionId].sort());

      // The exported id/key helpers agree with what the repo stored.
      expect(rosterActionOwnerKey({ ownerType: 'tour', ownerId })).toBe(`tour#${ownerId}`);
      expect(
        rosterActionIdFor({
          ownerType: 'tour',
          ownerId,
          action: 'add_member',
          contactId: 'contact-alicia',
        }),
      ).toBe(add.actionId);
    });

    it('listDue returns rows with dueAt <= now (inclusive), due-first, and excludes future rows', async () => {
      const ownerId = tourId('due');
      const ownerKey = `tour#${ownerId}`;

      // Written out of order on purpose - the byDueAt range key does the sorting.
      const boundary = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-boundary',
        dueAt: '2026-08-05T13:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      const future = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-future',
        dueAt: '2026-08-06T13:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      const earliest = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });

      const due = await actions.listDue('2026-08-05T13:00:00.000Z');
      const mine = due.filter((r) => r.ownerKey === ownerKey);

      // Due-first: the byDueAt GSI is queried ascending, so the earliest leads.
      expect(mine.map((r) => r.actionId)).toEqual([earliest.actionId, boundary.actionId]);
      expect(due.map((r) => r.actionId)).not.toContain(future.actionId);
    });

    it('claimApply wins exactly once and the applied row refuses every later claim', async () => {
      const ownerId = tourId('apply');
      const row = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });

      const [a, b] = await Promise.all([
        actions.claimApply(row.actionId, '2026-08-05T13:00:00.000Z'),
        actions.claimApply(row.actionId, '2026-08-05T13:00:00.000Z'),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect([a, b].filter((x) => !x)).toHaveLength(1);

      // Terminal: no other transition can move it, and it leaves listDue.
      expect(await actions.claimSkip(row.actionId, '2026-08-05T14:00:00.000Z', 'group_closed')).toBe(
        false,
      );
      expect(await actions.cancel(row.actionId, '2026-08-05T14:00:00.000Z')).toBe(false);

      const stored = await actions.getById(row.actionId);
      expect(stored?.status).toBe('applied');
      expect(stored?.resolvedAt).toBe('2026-08-05T13:00:00.000Z');
      const due = await actions.listDue('2026-08-05T15:00:00.000Z');
      expect(due.map((r) => r.actionId)).not.toContain(row.actionId);
    });

    it('a claim-skipped row is terminal (refuses apply/cancel) and leaves listDue exactly once', async () => {
      const ownerId = tourId('skip');
      const row = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-gone',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });

      expect(
        await actions.claimSkip(row.actionId, '2026-08-05T13:00:00.000Z', 'contact_deleted'),
      ).toBe(true);
      expect(
        await actions.claimSkip(row.actionId, '2026-08-05T13:30:00.000Z', 'group_closed'),
      ).toBe(false);
      expect(await actions.claimApply(row.actionId, '2026-08-05T13:30:00.000Z')).toBe(false);
      expect(await actions.cancel(row.actionId, '2026-08-05T13:30:00.000Z')).toBe(false);

      const stored = await actions.getById(row.actionId);
      expect(stored?.status).toBe('skipped');
      expect(stored?.skippedReason).toBe('contact_deleted');
      expect(stored?.resolvedAt).toBe('2026-08-05T13:00:00.000Z');

      const due = await actions.listDue('2026-08-05T15:00:00.000Z');
      expect(due.map((r) => r.actionId)).not.toContain(row.actionId);
    });

    it('cancel retires a pending row and the canceled row refuses both claims', async () => {
      const ownerId = tourId('cancel');
      const row = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });

      expect(await actions.cancel(row.actionId, '2026-08-05T12:30:00.000Z')).toBe(true);
      expect(await actions.cancel(row.actionId, '2026-08-05T12:40:00.000Z')).toBe(false);
      expect(await actions.claimApply(row.actionId, '2026-08-05T13:00:00.000Z')).toBe(false);
      expect(
        await actions.claimSkip(row.actionId, '2026-08-05T13:00:00.000Z', 'owner_canceled'),
      ).toBe(false);

      const stored = await actions.getById(row.actionId);
      expect(stored?.status).toBe('canceled');
      expect(stored?.resolvedAt).toBe('2026-08-05T12:30:00.000Z');
      const due = await actions.listDue('2026-08-05T15:00:00.000Z');
      expect(due.map((r) => r.actionId)).not.toContain(row.actionId);
    });

    it('a second upsert of the same add SUPERSEDES the pending row (new dueAt, never a duplicate)', async () => {
      const ownerId = tourId('dedupe');
      const first = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      const second = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-06T13:00:00.000Z',
        createdAt: '2026-08-05T22:00:00.000Z',
      });

      // Same deterministic key - the PK itself is the dedupe.
      expect(second.actionId).toBe(first.actionId);
      const owned = await actions.listByOwner({ ownerType: 'tour', ownerId });
      expect(owned).toHaveLength(1);
      expect(owned[0]?.dueAt).toBe('2026-08-06T13:00:00.000Z');
      expect(owned[0]?.status).toBe('pending');
      expect(owned[0]?.createdAt).toBe('2026-08-05T22:00:00.000Z');

      // The superseded dueAt is gone: the row is NOT due at the old instant.
      const dueEarly = await actions.listDue('2026-08-05T12:00:00.000Z');
      expect(dueEarly.map((r) => r.actionId)).not.toContain(first.actionId);
      const dueLate = await actions.listDue('2026-08-06T13:00:00.000Z');
      expect(dueLate.map((r) => r.actionId)).toContain(first.actionId);
    });

    it('upsertPending onto a SKIPPED row resurrects it to pending and retires the old notice', async () => {
      const ownerId = tourId('resurrect');
      const row = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      expect(
        await actions.claimSkip(row.actionId, '2026-08-05T13:00:00.000Z', 'member_no_longer_on_roster'),
      ).toBe(true);

      const again = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-06T13:00:00.000Z',
        createdAt: '2026-08-05T22:00:00.000Z',
      });

      expect(again.actionId).toBe(row.actionId);
      expect(again.status).toBe('pending');
      // The old notice is retired, not carried alongside the live intent.
      expect(again.skippedReason).toBeUndefined();
      expect(again.resolvedAt).toBeUndefined();

      const owned = await actions.listByOwner({ ownerType: 'tour', ownerId });
      expect(owned).toHaveLength(1);
      expect(owned[0]?.status).toBe('pending');
      expect(owned[0]?.skippedReason).toBeUndefined();

      // Pending again means claimable again.
      expect(await actions.claimApply(row.actionId, '2026-08-06T13:00:00.000Z')).toBe(true);
    });

    it('dismiss stamps dismissedAt on a terminal row, keeps it listable, and refuses a pending row', async () => {
      const ownerId = tourId('dismiss');
      const pending = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      const skipped = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-05T12:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      expect(
        await actions.claimSkip(skipped.actionId, '2026-08-05T13:00:00.000Z', 'already_member'),
      ).toBe(true);

      // A pending row has no notice to dismiss.
      expect(await actions.dismiss(pending.actionId, '2026-08-05T14:00:00.000Z')).toBe(false);
      expect((await actions.getById(pending.actionId))?.dismissedAt).toBeUndefined();

      expect(await actions.dismiss(skipped.actionId, '2026-08-05T14:00:00.000Z')).toBe(true);
      // Dismissing twice is a benign false.
      expect(await actions.dismiss(skipped.actionId, '2026-08-05T15:00:00.000Z')).toBe(false);

      // The row stays readable - the CARD layer excludes dismissed rows from
      // skipped[]; the repo only records the stamp.
      const owned = await actions.listByOwner({ ownerType: 'tour', ownerId });
      const stored = owned.find((r) => r.actionId === skipped.actionId);
      expect(stored?.status).toBe('skipped');
      expect(stored?.skippedReason).toBe('already_member');
      expect(stored?.dismissedAt).toBe('2026-08-05T14:00:00.000Z');
    });

    it('migrate moves pending rows to the new ownerKey AND the new deterministic PK', async () => {
      const ownerId = tourId('migrate');
      const placementId = `placement-migrate-${randomUUID().slice(0, 8)}`;
      const open = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T13:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      const add = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-alicia',
        dueAt: '2026-08-05T14:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });

      const moved = await actions.migrate(
        { ownerType: 'tour', ownerId },
        { ownerType: 'placement', ownerId: placementId },
      );

      expect(moved.map((r) => r.actionId).sort()).toEqual(
        [`placement#${placementId}#open`, `placement#${placementId}#add#contact-alicia`].sort(),
      );

      // Old owner keeps nothing - neither by owner nor by key.
      expect(await actions.listByOwner({ ownerType: 'tour', ownerId })).toEqual([]);
      expect(await actions.getById(open.actionId)).toBeUndefined();
      expect(await actions.getById(add.actionId)).toBeUndefined();

      // New owner holds both, re-keyed, with dueAt and payload preserved.
      const owned = await actions.listByOwner({ ownerType: 'placement', ownerId: placementId });
      expect(owned).toHaveLength(2);
      const movedOpen = owned.find((r) => r.action === 'open_group');
      const movedAdd = owned.find((r) => r.action === 'add_member');
      expect(movedOpen?.actionId).toBe(`placement#${placementId}#open`);
      expect(movedOpen?.ownerKey).toBe(`placement#${placementId}`);
      expect(movedOpen?.ownerType).toBe('placement');
      expect(movedOpen?.ownerId).toBe(placementId);
      expect(movedOpen?.dueAt).toBe('2026-08-05T13:00:00.000Z');
      expect(movedOpen?.status).toBe('pending');
      expect(movedAdd?.actionId).toBe(`placement#${placementId}#add#contact-alicia`);
      expect(movedAdd?.contactId).toBe('contact-alicia');
      expect(movedAdd?.dueAt).toBe('2026-08-05T14:00:00.000Z');

      // The re-keyed rows are due under the new key, and only once.
      const due = await actions.listDue('2026-08-05T14:00:00.000Z');
      const dueIds = due.map((r) => r.actionId);
      expect(dueIds).toContain(`placement#${placementId}#open`);
      expect(dueIds).not.toContain(open.actionId);
    });

    it('migrate leaves TERMINAL rows with the old owner (their notice belongs to that history)', async () => {
      const ownerId = tourId('migrate-terminal');
      const placementId = `placement-terminal-${randomUUID().slice(0, 8)}`;
      const skipped = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'add_member',
        contactId: 'contact-old',
        dueAt: '2026-08-05T13:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });
      expect(
        await actions.claimSkip(skipped.actionId, '2026-08-05T13:30:00.000Z', 'roster_too_thin'),
      ).toBe(true);
      const pending = await actions.upsertPending({
        ownerType: 'tour',
        ownerId,
        action: 'open_group',
        dueAt: '2026-08-05T13:00:00.000Z',
        createdAt: '2026-08-05T04:00:00.000Z',
      });

      const moved = await actions.migrate(
        { ownerType: 'tour', ownerId },
        { ownerType: 'placement', ownerId: placementId },
      );

      expect(moved.map((r) => r.actionId)).toEqual([`placement#${placementId}#open`]);
      expect(await actions.getById(pending.actionId)).toBeUndefined();
      const left = await actions.listByOwner({ ownerType: 'tour', ownerId });
      expect(left.map((r) => r.actionId)).toEqual([skipped.actionId]);
      expect(left[0]?.status).toBe('skipped');
    });
  },
);
