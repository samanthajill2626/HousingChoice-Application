// Tour reminders integration tests against DynamoDB Local (Tours feature, Task 4).
//
// Covers:
//   1. armTourReminders — correct ladder dueAts, past rows skipped
//   2. runDueTourReminders — sends due reminders, stamps sentAt (idempotency)
//   3. reschedule — cancel + re-arm, new dueAts
//   4. cancelTourReminders — pending rows canceled
//   5. same-day tour — day_before skipped (past), future rows armed
//   6. listDue excludes sentAt/canceledAt rows
//   7. [concurrency] two racing runDueTourReminders calls → exactly ONE send
//   8. [concurrency] row canceled after listDue but before claim → zero sends
//
// Uses DynamoDB Local for tourRemindersRepo + toursRepo.
// Uses the in-memory fakeWorld for contacts/conversations/sendMessage adapter.
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT the suite skips.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type {
  MessagingAdapter,
  SendMessageParams,
} from '../src/adapters/messaging.js';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createEventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import { isQuietTime, quietHoursWindowOf } from '../src/lib/quietHours.js';
import { ROSTER_UNAVAILABLE_GRACE_MS } from '../src/lib/rosterResolution.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';
import {
  createTourRemindersRepo,
  type ReminderKind,
  type TourReminderItem,
  type TourRemindersRepo,
} from '../src/repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem } from '../src/repos/toursRepo.js';
import { DEFAULT_ORG_SETTINGS } from '../src/repos/settingsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageInput,
  type SendMessageOutcome,
  type SendMessageService,
} from '../src/services/sendMessage.js';
import {
  armTourReminders,
  cancelTourReminders,
  DISCONTINUED_REMINDER_KINDS,
  forceSendReminder,
  MANUAL_ONLY_REMINDER_KINDS,
  retiredByTourStart,
  runDueTourReminders,
} from '../src/jobs/tourReminders.js';
import {
  composeTourReminderBody,
  type TourContactNames,
} from '../src/messages/tourCopy.js';
import type { TourType } from '../src/lib/toursModel.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  failingSettingsRepo,
  quietOffSettingsRepo,
  stubSettingsRepo,
  type SettingsReadRepo,
} from './helpers/settingsStub.js';

// The hold-back wrapper this file used to route every tick through is GONE
// (Phase B, 2026-08-31): MANUAL_ONLY_REMINDER_KINDS is empty again, so the
// production default sends the live rungs and injecting an empty set would say
// nothing. Every tick below therefore calls the REAL runDueTourReminders with
// no override; the few cases that still need pause-mode behaviour pass their
// own explicit manualOnlyKinds, and the kind that must NEVER send is covered by
// DISCONTINUED_REMINDER_KINDS instead (not injectable, see its own describe).

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
    `[tourReminders.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/**
 * The body the send paths compose for a rung of a tour booked at `scheduledAt`.
 *
 * Every tour.* default now carries at least one required token, so a bare
 * resolveMessage of one THROWS - the expectation has to be composed from the
 * same context the job composes from. Both settings stubs this suite uses
 * (quietOffSettingsRepo and stubSettingsRepo) inherit
 * DEFAULT_ORG_SETTINGS.timezone, and NO fixture here seeds a unit, so every
 * body composes with no address clause.
 *
 * BOTH DEFAULTS ARE VALUE-SAFE HERE, and neither is laziness:
 *   - `names: {}` - NO fixture contact in this file carries a firstName
 *     (verified by grep), so the poll really does compose "Hey there," bodies
 *     and an empty names object is what the job passes.
 *   - `tourType: 'self_guided'` - with no property-contact name in play, the
 *     en_route rung DEGRADES to the self-guided entry for every tour type
 *     (tourCopy.ts idFor), so the default cannot disagree with what the job
 *     composed. Pass an explicit pair the moment a fixture here gains a name.
 */
function rungBody(
  kind: ReminderKind,
  scheduledAt: string,
  tourType: TourType = 'self_guided',
  names: TourContactNames = {},
): string {
  return composeTourReminderBody({
    kind,
    scheduledAt,
    timezone: DEFAULT_ORG_SETTINGS.timezone,
    tourType,
    names,
  });
}

/** Immediate-send vehicle (Phase B spec 10): repo.create does NOT drop a
 *  past-due row (only armTourReminders does), so this yields a due row of any
 *  kind with zero production code. PRECONDITION (6.1a): dueAt must be BEFORE
 *  the tour's scheduledAt or the past-tour gate retires it - callers pass the
 *  tour's own times, never hardcoded dates. */
async function createDueReminder(
  repo: TourRemindersRepo,
  tourId: string,
  kind: ReminderKind,
  dueAt: string,
): Promise<TourReminderItem> {
  return repo.create({ tourId, kind, dueAt });
}

// ---------------------------------------------------------------------------
// The past-tour predicate (Phase B 6.1a). PURE, so it sits OUTSIDE the
// DynamoDB-gated describe below: it needs no table and must run even on a
// machine with no DynamoDB Local. The same function backs the poll gate, the
// force-send refusal, and scripts/retire-paused-tour-reminders.ts - if those
// three could ever disagree about a row, one of them would be wrong.
// ---------------------------------------------------------------------------
describe('retiredByTourStart - the ONE past-tour predicate (poll gate, force-send, sweep)', () => {
  const T = '2026-08-01T15:00:00.000Z'; // tour start

  it('true: a pre-tour rung after the tour started', () => {
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, '2026-08-01T15:00:01.000Z'),
    ).toBe(true);
  });

  it('true: exactly AT the tour start - the copy is already stale', () => {
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, '2026-08-01T15:00:00.000Z'),
    ).toBe(true);
  });

  it('false: the tour has not started yet', () => {
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, '2026-08-01T14:59:59.000Z'),
    ).toBe(false);
  });

  it('false: no_show_checkin shape - dueAt AFTER the tour is exempt by construction', () => {
    // The exemption is DERIVED from the ladder's own data (dueAt vs start), never
    // from a name in a list - the rung an operator needs after a no-show survives.
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T15:30:00.000Z' }, T, '2026-08-01T16:00:00.000Z'),
    ).toBe(false);
  });

  it('false: absent or unparseable scheduledAt (invalid_schedule owns those)', () => {
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, undefined, '2026-08-02T00:00:00.000Z'),
    ).toBe(false);
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, 'not-a-date', '2026-08-02T00:00:00.000Z'),
    ).toBe(false);
  });

  it('normalizes a non-canonical ISO scheduledAt before comparing', () => {
    // A stored scheduledAt without milliseconds must not decide the gate by
    // lexicographic accident - '...15:00:00Z' sorts BEFORE '...14:00:00.000Z'.
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, '2026-08-01T15:00:00Z', '2026-08-01T15:00:01.000Z'),
    ).toBe(true);
  });

  // Review round 1, A-S5: the ROW's dueAt got no such treatment, and the sweep
  // scans EVERY row in the table - including hand-seeded and imported ones that
  // computeDueAt never wrote.
  it('normalizes the ROW dueAt too: an offset-bearing dueAt is not judged by string order', () => {
    // '2026-08-01T11:00:00-05:00' IS 16:00Z - an hour AFTER the tour, i.e. a
    // no_show_checkin shape the predicate must exempt. Compared as raw text it
    // sorts before '2026-08-01T15:00:00.000Z' ('11' < '15'), and the gate would
    // retire the one rung an operator needs after a no-show.
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T11:00:00-05:00' }, T, '2026-08-01T17:00:00.000Z'),
    ).toBe(false);
  });

  it('false: an unparseable dueAt - no honest gate decision can be derived from it', () => {
    expect(retiredByTourStart({ dueAt: 'not-a-date' }, T, '2026-08-01T16:00:00.000Z')).toBe(false);
  });

  // Round 2, B NOTE-4: `now` was the last operand still compared as TEXT, which
  // left this exported predicate following two different rules across its three
  // arguments - exactly the half-normalized shape A-S5 was raised about.
  it('normalizes `now` too: an offset-bearing now is not judged by string order', () => {
    // '2026-08-01T11:00:00-05:00' IS 16:00Z, an hour AFTER the tour - so the
    // gate must fire. As raw text it sorts BELOW '2026-08-01T15:00:00.000Z'
    // ('11' < '15') and the gate would silently decline to retire the rung.
    expect(
      retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, '2026-08-01T11:00:00-05:00'),
    ).toBe(true);
  });

  it('false: an unparseable `now` - the same rule as the other two operands', () => {
    expect(retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, 'not-a-date')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Supersession S1 (T1.6) - the in-memory fakes must MIRROR the contracts the
// DynamoDB describe below proves for the real repos. No database here.
//
// This file already carries the scar of a fake that dropped `input.skipped` on
// the floor: TourReminderItem has NO index signature, so an optional field is
// not enforced on the fake's hand-built literal and the omission typechecks
// green. The route suites that lean on these three behaviours do not arrive
// until S3/S8, which is far too late to find out.
// ---------------------------------------------------------------------------
describe('fake world repos mirror the S1 repo contracts', () => {
  const newTour = async (world: ReturnType<typeof createFakeWorld>, seq: string) =>
    world.toursRepo.create({
      tenantId: `contact-fake-${seq}`,
      unitId: `unit-fake-${seq}`,
      scheduledAt: '2026-12-01T15:00:00.000Z',
      tourType: 'self_guided',
    });

  it('create copies ladderId, and omits the field entirely when none is supplied', async () => {
    const world = createFakeWorld();
    const tour = await newTour(world, 'create');

    const stamped = await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2026-11-30T23:30:00.000Z',
      ladderId: 'ladder-fake',
    });
    const bare = await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-12-01T11:00:00.000Z',
    });

    expect(stamped.ladderId).toBe('ladder-fake');
    expect(bare.ladderId).toBeUndefined();
    expect(bare).not.toHaveProperty('ladderId');
    // And the STORED row, not just the return value.
    const stored = await world.tourRemindersRepo.listByTour(tour.tourId);
    expect(stored.find((r) => r.kind === 'day_before')?.ladderId).toBe('ladder-fake');
    expect(stored.find((r) => r.kind === 'morning_of')).not.toHaveProperty('ladderId');
  });

  it('setLadderIdIf has REAL compare semantics - a mismatch writes nothing', async () => {
    const world = createFakeWorld();
    const tour = await world.toursRepo.create({
      tenantId: 'contact-fake-cas',
      unitId: 'unit-fake-cas',
      scheduledAt: '2026-12-02T15:00:00.000Z',
      tourType: 'self_guided',
      currentLadderId: 'ladder-rotation',
    });

    // Mismatch loses and leaves the winner's rotation intact.
    expect(
      await world.toursRepo.setLadderIdIf(tour.tourId, 'ladder-someone-else', 'ladder-armed'),
    ).toBe(false);
    expect((await world.toursRepo.get(tour.tourId))!.currentLadderId).toBe('ladder-rotation');

    // The matching compare wins.
    expect(
      await world.toursRepo.setLadderIdIf(tour.tourId, 'ladder-rotation', 'ladder-armed'),
    ).toBe(true);
    expect((await world.toursRepo.get(tour.tourId))!.currentLadderId).toBe('ladder-armed');
  });

  it('setLadderIdIf returns false for an ABSENT pointer and for a missing tour', async () => {
    const world = createFakeWorld();
    const bare = await newTour(world, 'cas-absent');

    expect(await world.toursRepo.setLadderIdIf(bare.tourId, 'ladder-x', 'ladder-y')).toBe(false);
    expect((await world.toursRepo.get(bare.tourId))!.currentLadderId).toBeUndefined();
    expect(await world.toursRepo.setLadderIdIf('tour-ghost', 'ladder-x', 'ladder-y')).toBe(false);
  });

  it('deleteSupersededForTour drops every unsent row (canceled and skipped included) and keeps sent', async () => {
    const world = createFakeWorld();
    const mine = await newTour(world, 'sweep-mine');
    const theirs = await newTour(world, 'sweep-theirs');
    const mk = (tourId: string, kind: ReminderKind) =>
      world.tourRemindersRepo.create({ tourId, kind, dueAt: '2026-11-30T23:30:00.000Z' });

    const pending = await mk(mine.tourId, 'day_before');
    const canceled = await mk(mine.tourId, 'morning_of');
    const skipped = await mk(mine.tourId, 'en_route');
    const sent = await mk(mine.tourId, 'confirmation');
    const other = await mk(theirs.tourId, 'day_before');
    await world.tourRemindersRepo.cancel(canceled.reminderId, '2026-11-20T12:00:00.000Z');
    await world.tourRemindersRepo.claimSkip(
      skipped.reminderId,
      '2026-11-20T12:00:00.000Z',
      'tour_missing',
    );
    await world.tourRemindersRepo.claimSend(sent.reminderId, '2026-11-20T12:00:00.000Z');

    await world.tourRemindersRepo.deleteSupersededForTour(mine.tourId);

    const left = await world.tourRemindersRepo.listByTour(mine.tourId);
    expect(left.map((r) => r.reminderId)).toEqual([sent.reminderId]);
    expect(left.map((r) => r.reminderId)).not.toContain(pending.reminderId);
    // Another tour's ladder is untouched.
    expect((await world.tourRemindersRepo.listByTour(theirs.tourId)).map((r) => r.reminderId)).toEqual(
      [other.reminderId],
    );
  });

  it('the claim methods still refuse a row that is not there (the post-guard behaviour)', async () => {
    const world = createFakeWorld();
    const now = '2026-11-20T12:00:00.000Z';

    expect(await world.tourRemindersRepo.claimSend('reminder-missing', now)).toBe(false);
    expect(await world.tourRemindersRepo.claimSkip('reminder-missing', now, 'tour_missing')).toBe(
      false,
    );
    expect(await world.tourRemindersRepo.cancel('reminder-missing', now)).toBe(false);
    expect(await world.tourRemindersRepo.uncancel('reminder-missing')).toBe(false);
  });
});

describe.skipIf(!reachable)('tourReminders against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logCapture = createLogCapture();
  const logger = createLogger({ destination: logCapture.stream });

  // Real DynamoDB Local repos for persistence.
  const tourReminders = createTourRemindersRepo({ doc, env: testEnv, logger });
  const tours = createToursRepo({ doc, env: testEnv, logger });

  // In-memory fakeWorld for contacts/conversations/sendMessage adapter.
  const world = createFakeWorld();

  // Quiet hours OFF for every test that is NOT about quiet hours: clamping is
  // identity, so these suites keep their original dueAt fixtures (and never
  // depend on where a fixture instant happens to fall in the 21:00-08:00
  // window). The clamp/supersession cases below stub the window explicitly.
  const quietOff = quietOffSettingsRepo();

  // Build a real sendMessageService wired to the fake adapter.
  const sendMessageService = createSendMessageService({
    logger,
    adapter: world.adapter,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
  });

  // Shared deps for runDueTourReminders. The adapter (group route) is a spy
  // that must stay untouched here — these tours have no group thread (and so
  // is messagesRepo: group rungs persist announcement rows through it).
  const runDeps = {
    tourRemindersRepo: tourReminders,
    toursRepo: tours,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    // ONE unit read, TWO consumers: D11 roster resolution (contact-rosters -
    // the property default rung) AND the address source for the composed body
    // (empty here - these tours' units are never seeded, which is exactly the
    // no-address variant).
    unitsRepo: world.unitsRepo,
    messagesRepo: world.messagesRepo,
    sendMessageService,
    adapter: createAdapterSpy().adapter,
    // Quiet hours OFF: the fire-time backstop is a no-op, so these poller cases
    // keep their original fixture instants. The backstop cases below override
    // this with the default (enabled) window.
    settingsRepo: quietOff,
    logger,
  };

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
    await ensureTable(client, getTableSpec('tourReminders'), tableName('tourReminders', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('tours', testEnv));
    await deleteTableIfExists(client, tableName('tourReminders', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  // Raw row read - there is no getById on TourRemindersRepo, and listByTour is a
  // vacuous substitute for absence: a resurrected attribute-only stub carries no
  // tourId and so cannot appear in a byTour query whether the bug is there or not.
  const rawReminder = async (reminderId: string) => {
    const { Item } = await doc.send(
      new GetCommand({
        TableName: tableName('tourReminders', testEnv),
        Key: { reminderId },
      }),
    );
    return Item as TourReminderItem | undefined;
  };

  const deleteReminderRaw = async (reminderId: string) => {
    await doc.send(
      new DeleteCommand({
        TableName: tableName('tourReminders', testEnv),
        Key: { reminderId },
      }),
    );
  };

  // ---------------------------------------------------------------------------
  // Supersession S1 - ladderId stamp on the row (T1.1)
  // ---------------------------------------------------------------------------
  describe('create carries the generation pointer (ladderId)', () => {
    it('stores the supplied ladderId on the row and returns it', async () => {
      const tour = await tours.create({
        tenantId: 'contact-ladder-create-1',
        unitId: 'unit-ladder-create-1',
        scheduledAt: '2026-10-01T15:00:00.000Z',
        tourType: 'self_guided',
      });

      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'day_before',
        dueAt: '2026-09-30T23:30:00.000Z',
        ladderId: 'ladder-s1-create',
      });

      expect(row.ladderId).toBe('ladder-s1-create');
      expect((await rawReminder(row.reminderId))?.ladderId).toBe('ladder-s1-create');
    });

    it('omits the attribute entirely when no ladderId is supplied (pre-migration shape)', async () => {
      const tour = await tours.create({
        tenantId: 'contact-ladder-create-2',
        unitId: 'unit-ladder-create-2',
        scheduledAt: '2026-10-02T15:00:00.000Z',
        tourType: 'self_guided',
      });

      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'day_before',
        dueAt: '2026-10-01T23:30:00.000Z',
      });

      expect(row.ladderId).toBeUndefined();
      const stored = await rawReminder(row.reminderId);
      expect(stored).toBeDefined();
      expect(stored).not.toHaveProperty('ladderId');
    });

    it('stamps a born-skipped row too (the arm-time visible trace)', async () => {
      const tour = await tours.create({
        tenantId: 'contact-ladder-create-3',
        unitId: 'unit-ladder-create-3',
        scheduledAt: '2026-10-03T15:00:00.000Z',
        tourType: 'self_guided',
      });

      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'morning_of',
        dueAt: '2026-10-03T11:00:00.000Z',
        ladderId: 'ladder-s1-born-skipped',
        skipped: { at: '2026-09-01T00:00:00.000Z', reason: 'past_event' },
      });

      expect(row.ladderId).toBe('ladder-s1-born-skipped');
      const stored = await rawReminder(row.reminderId);
      expect(stored?.ladderId).toBe('ladder-s1-born-skipped');
      expect(stored?.skipReason).toBe('past_event');
    });
  });

  // ---------------------------------------------------------------------------
  // Supersession S1 - the claim guards (T1.4)
  //
  // claimSend/claimSkip/cancel are UpdateCommands conditioned only on
  // attribute_not_exists(...). DynamoDB's UpdateItem CREATES a missing item, so
  // against a DELETED row every one of those conditions HOLDS: the claim
  // succeeds and an attribute-only stub springs into existence with no tourId,
  // kind or dueAt - and the poll sends. Supersession makes deleted rows routine
  // (D1 hard-deletes the superseded ladder), so each write gains
  // attribute_exists(reminderId). uncancel already requires
  // attribute_exists(canceledAt) and is deliberately untouched.
  // ---------------------------------------------------------------------------
  describe('a write against a DELETED row must lose, not resurrect it', () => {
    const NOW_GUARD = '2026-09-15T12:00:00.000Z';

    const deletedRow = async (label: string) => {
      const tour = await tours.create({
        tenantId: `contact-guard-${label}`,
        unitId: `unit-guard-${label}`,
        scheduledAt: '2026-09-20T15:00:00.000Z',
        tourType: 'self_guided',
      });
      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'day_before',
        dueAt: '2026-09-19T23:30:00.000Z',
      });
      await deleteReminderRaw(row.reminderId);
      expect(await rawReminder(row.reminderId)).toBeUndefined();
      return row;
    };

    it('claimSend returns false and leaves NOTHING behind', async () => {
      const row = await deletedRow('send');

      expect(await tourReminders.claimSend(row.reminderId, NOW_GUARD)).toBe(false);
      expect(await rawReminder(row.reminderId)).toBeUndefined();
    });

    it('claimSend with a sentBody returns false and leaves NOTHING behind', async () => {
      const row = await deletedRow('send-body');

      expect(await tourReminders.claimSend(row.reminderId, NOW_GUARD, 'a body')).toBe(false);
      expect(await rawReminder(row.reminderId)).toBeUndefined();
    });

    it('claimSkip returns false and leaves NOTHING behind', async () => {
      const row = await deletedRow('skip');

      expect(await tourReminders.claimSkip(row.reminderId, NOW_GUARD, 'tour_missing')).toBe(false);
      expect(await rawReminder(row.reminderId)).toBeUndefined();
    });

    it('cancel returns false and leaves NOTHING behind', async () => {
      const row = await deletedRow('cancel');

      expect(await tourReminders.cancel(row.reminderId, NOW_GUARD)).toBe(false);
      expect(await rawReminder(row.reminderId)).toBeUndefined();
    });

    it('the guard does not break the LIVE path: a real pending row still claims', async () => {
      const tour = await tours.create({
        tenantId: 'contact-guard-live',
        unitId: 'unit-guard-live',
        scheduledAt: '2026-09-21T15:00:00.000Z',
        tourType: 'self_guided',
      });
      const send = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'day_before',
        dueAt: '2026-09-20T23:30:00.000Z',
      });
      const skip = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'morning_of',
        dueAt: '2026-09-21T11:00:00.000Z',
      });
      const kill = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'en_route',
        dueAt: '2026-09-21T14:00:00.000Z',
      });

      expect(await tourReminders.claimSend(send.reminderId, NOW_GUARD, 'body')).toBe(true);
      expect(await tourReminders.claimSkip(skip.reminderId, NOW_GUARD, 'tour_missing')).toBe(true);
      expect(await tourReminders.cancel(kill.reminderId, NOW_GUARD)).toBe(true);

      expect((await rawReminder(send.reminderId))?.sentAt).toBe(NOW_GUARD);
      expect((await rawReminder(skip.reminderId))?.skippedAt).toBe(NOW_GUARD);
      expect((await rawReminder(kill.reminderId))?.canceledAt).toBe(NOW_GUARD);
    });
  });

  // ---------------------------------------------------------------------------
  // Supersession S1 - deleteSupersededForTour (T1.5)
  //
  // D1: a superseded ladder's never-sent rungs are HARD-DELETED - pending,
  // operator-canceled and skipped alike. Only sentAt survives. That is NOT
  // cancelForTour's `pending` filter, which excludes canceled and skipped rows -
  // exactly the rows this deletes. The only filter here is "no sentAt", and the
  // ConditionExpression on the delete is what makes the race safe.
  // ---------------------------------------------------------------------------
  describe('deleteSupersededForTour', () => {
    const SWEEP_NOW = '2026-09-25T12:00:00.000Z';

    /** A tour carrying one row of every terminal shape, plus a pending one. */
    const sweepWorld = async (label: string) => {
      const tour = await tours.create({
        tenantId: `contact-sweep-${label}`,
        unitId: `unit-sweep-${label}`,
        scheduledAt: '2026-09-30T15:00:00.000Z',
        tourType: 'self_guided',
      });
      const mk = (kind: ReminderKind, dueAt: string) =>
        tourReminders.create({ tourId: tour.tourId, kind, dueAt, ladderId: 'ladder-old' });

      const pending = await mk('day_before', '2026-09-29T23:30:00.000Z');
      const canceled = await mk('morning_of', '2026-09-30T11:00:00.000Z');
      const skipped = await mk('en_route', '2026-09-30T14:00:00.000Z');
      const sent = await mk('confirmation', '2026-09-20T13:00:00.000Z');

      await tourReminders.cancel(canceled.reminderId, SWEEP_NOW);
      await tourReminders.claimSkip(skipped.reminderId, SWEEP_NOW, 'tour_missing');
      await tourReminders.claimSend(sent.reminderId, SWEEP_NOW, 'the body that went out');

      return { tour, pending, canceled, skipped, sent };
    };

    it('deletes pending, operator-canceled AND skipped rows; keeps every SENT row', async () => {
      const w = await sweepWorld('mixed');

      await tourReminders.deleteSupersededForTour(w.tour.tourId);

      expect(await rawReminder(w.pending.reminderId)).toBeUndefined();
      expect(await rawReminder(w.canceled.reminderId)).toBeUndefined();
      expect(await rawReminder(w.skipped.reminderId)).toBeUndefined();
      // The history survives, body and all - a sent rung is a fact.
      const kept = await rawReminder(w.sent.reminderId);
      expect(kept?.sentAt).toBe(SWEEP_NOW);
      expect(kept?.sentBody).toBe('the body that went out');

      // And the tour's live view holds exactly the sent row.
      expect(await tourReminders.listByTour(w.tour.tourId)).toHaveLength(1);
    });

    it('touches no OTHER tour and is idempotent on a second call', async () => {
      const mine = await sweepWorld('mine');
      const theirs = await sweepWorld('theirs');

      await tourReminders.deleteSupersededForTour(mine.tour.tourId);
      await tourReminders.deleteSupersededForTour(mine.tour.tourId);

      expect(await tourReminders.listByTour(mine.tour.tourId)).toHaveLength(1);
      expect(await tourReminders.listByTour(theirs.tour.tourId)).toHaveLength(4);
    });

    it('a row that gains sentAt BETWEEN the list and the delete SURVIVES', async () => {
      const w = await sweepWorld('race');

      // The real race, driven through the injectable client rather than a
      // production seam: listByTour returns the plan, and the poll claims one of
      // the listed rows before the sweep's delete reaches it. The delete's
      // attribute_not_exists(sentAt) is what saves the send from being erased.
      let raced = false;
      const racingDoc = {
        send: async (command: unknown) => {
          const out = await (doc as DynamoDBDocumentClient).send(command as never);
          if (command instanceof QueryCommand && !raced) {
            raced = true;
            await tourReminders.claimSend(w.pending.reminderId, SWEEP_NOW, 'raced body');
          }
          return out;
        },
      } as unknown as DynamoDBDocumentClient;
      const racingRepo = createTourRemindersRepo({ doc: racingDoc, env: testEnv, logger });

      await racingRepo.deleteSupersededForTour(w.tour.tourId);

      expect(raced).toBe(true);
      const survivor = await rawReminder(w.pending.reminderId);
      expect(survivor?.sentAt).toBe(SWEEP_NOW);
      expect(survivor?.sentBody).toBe('raced body');
      // One lost condition does not abort the batch - the other unsent rows went.
      expect(await rawReminder(w.canceled.reminderId)).toBeUndefined();
      expect(await rawReminder(w.skipped.reminderId)).toBeUndefined();
    });

    it('an UNEXPECTED error on one row logs at error and does not abort the rest', async () => {
      const w = await sweepWorld('boom');

      const failingDoc = {
        send: async (command: unknown) => {
          if (
            command instanceof DeleteCommand &&
            (command.input.Key as { reminderId?: string } | undefined)?.reminderId ===
              w.canceled.reminderId
          ) {
            throw new Error('throttled');
          }
          return (doc as DynamoDBDocumentClient).send(command as never);
        },
      } as unknown as DynamoDBDocumentClient;
      const failingRepo = createTourRemindersRepo({ doc: failingDoc, env: testEnv, logger });

      const before = logCapture.lines.length;
      await expect(
        failingRepo.deleteSupersededForTour(w.tour.tourId),
      ).resolves.toBeUndefined();

      // The failure is LOUD (never silently vanished) but not fatal.
      const errors = logCapture.lines
        .slice(before)
        .filter((l) => l['level'] === 50 && l['tourId'] === w.tour.tourId);
      expect(errors).toHaveLength(1);

      expect(await rawReminder(w.canceled.reminderId)).toBeDefined();
      expect(await rawReminder(w.pending.reminderId)).toBeUndefined();
      expect(await rawReminder(w.skipped.reminderId)).toBeUndefined();
      expect((await rawReminder(w.sent.reminderId))?.sentAt).toBe(SWEEP_NOW);
    });

    it('a tour with no rows at all is a no-op', async () => {
      const tour = await tours.create({
        tenantId: 'contact-sweep-empty',
        unitId: 'unit-sweep-empty',
        scheduledAt: '2026-10-05T15:00:00.000Z',
        tourType: 'self_guided',
      });

      await expect(
        tourReminders.deleteSupersededForTour(tour.tourId),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Supersession S2 - the armer mints ONE ladderId per CALL (T2.1)
  //
  // A UUID, not a timestamp: routes/tours.ts takes an injectable `deps.now` and
  // the app suite injects a CONSTANT, so two arms of the same tour inside one
  // test share an instant (spec 3.1). Every case below therefore pins the same
  // `now` across both calls - a timestamp-derived id would pass case 1 and fail
  // case 2 and only case 2.
  // ---------------------------------------------------------------------------
  describe('armTourReminders stamps one generation ladderId per call', () => {
    // Jan 20 10:00 EST, tour the same afternoon at 15:00 EST. Quiet hours OFF,
    // so the clamp is identity. This mix is deliberate: day_before and
    // morning_of are both born SKIPPED (booked_too_late - the same-day booking
    // rule, spec section 8) while en_route arms live, so one call covers both
    // the create sites that write a skipped row and the one that writes a live
    // rung.
    const NOW_LADDER = '2026-01-20T15:00:00.000Z';
    const SCHEDULED_LADDER = '2026-01-20T20:00:00.000Z';

    const armFor = async (tour: TourItem, now = NOW_LADDER) =>
      armTourReminders(tour, now, {
        tourRemindersRepo: tourReminders,
        settingsRepo: quietOff,
        logger,
      });

    it('stamps every row of one call - born-skipped rows included - with the SAME id', async () => {
      const tour = await tours.create({
        tenantId: 'contact-ladder-arm-1',
        unitId: 'unit-ladder-arm-1',
        scheduledAt: SCHEDULED_LADDER,
        tourType: 'self_guided',
      });

      const { ladderId, rows } = await armFor(tour);

      expect(ladderId).toEqual(expect.any(String));
      expect(rows).toHaveLength(3);
      // The mix this fixture exists to produce.
      const skipped = rows.filter((r) => r.skippedAt !== undefined);
      expect(skipped.map((r) => r.skipReason)).toEqual(['booked_too_late', 'booked_too_late']);
      expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(1);

      for (const row of rows) {
        expect(row.ladderId).toBe(ladderId);
      }

      // ...and the STORED rows agree. The returned objects are the repo's own
      // return values, so asserting only on them would pass on a create that
      // dropped the attribute on the way to DynamoDB.
      const stored = await tourReminders.listByTour(tour.tourId);
      expect(stored).toHaveLength(3);
      for (const row of stored) {
        expect(row.ladderId).toBe(ladderId);
      }
    });

    it('mints a DIFFERENT id for a second arm of the same tour at the same `now`', async () => {
      const tour = await tours.create({
        tenantId: 'contact-ladder-arm-2',
        unitId: 'unit-ladder-arm-2',
        scheduledAt: SCHEDULED_LADDER,
        tourType: 'self_guided',
      });

      const first = await armFor(tour);
      const second = await armFor(tour);

      expect(first.ladderId).not.toBe(second.ladderId);
      // Generation, not identity: the two calls' rows are disjoint sets, each
      // internally consistent. (Nothing sweeps here - S2 writes no deletes.)
      const firstIds = new Set(first.rows.map((r) => r.reminderId));
      expect(second.rows.some((r) => firstIds.has(r.reminderId))).toBe(false);
      for (const row of second.rows) {
        expect(row.ladderId).toBe(second.ladderId);
      }

      const stored = await tourReminders.listByTour(tour.tourId);
      expect(stored).toHaveLength(6);
      expect(new Set(stored.map((r) => r.ladderId))).toEqual(
        new Set([first.ladderId, second.ladderId]),
      );
    });

    it('returns ladderId null when the arm writes NO rows (a time-less tour)', async () => {
      // The no-scheduledAt early return is the ONLY zero-row exit. The silent
      // `dueAt < now` skip cannot produce one on its own: it sits BELOW the
      // booked-too-late branch, and for day_before those two are exhaustive -
      // if booked-too-late is false then now <= raw - 4h, and the clamp only
      // ever moves a dueAt FORWARD (quietHours.ts:153-163), so the clamped
      // dueAt is still future and the rung falls through to a live or a
      // past_event/superseded ROW. A day_before row is written on every tour
      // that has a scheduledAt.
      const tour = await tours.create({
        tenantId: 'contact-ladder-arm-3',
        unitId: 'unit-ladder-arm-3',
        tourType: 'self_guided',
      });
      expect(tour.scheduledAt).toBeUndefined();

      const { ladderId, rows } = await armFor(tour);

      expect(ladderId).toBeNull();
      expect(rows).toEqual([]);
      expect(await tourReminders.listByTour(tour.tourId)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 1 — arm: correct ladder dueAts for a future tour
  // ---------------------------------------------------------------------------
  it('armTourReminders creates all 3 reminder rows with correct dueAts', async () => {
    // Quiet hours ON (the product default: 21:00-08:00 America/New_York, EST =
    // UTC-5 in January). Every rung below lands outside the window, so the
    // clamp is identity throughout - including day_before, which is now
    // 19:30 ORG-LOCAL the evening before the tour's local day (retiming,
    // Cameron 2026-08-26) and 19:30 is an hour and a half short of the 21:00
    // default start.
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-20T20:00:00.000Z'; // Jan 20 15:00 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-1',
      unitId: 'unit-arm-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });

    // All 3 auto-armed kinds: day_before, morning_of, en_route. Two kinds are
    // deliberately absent - no_show_checkin (manual-send only) and confirmation
    // (retired by the founder 2026-08-24; arming stopped 2026-08-31, Phase B).
    // All dueAts are future relative to now.
    expect(rows).toHaveLength(3);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // confirmation is no longer auto-armed: the kind stays valid everywhere
    // else (union, computeDueAt, catalog) but no NEW row is born for it.
    expect(byKind['confirmation']).toBeUndefined();

    // day_before: 19:30 ORG-LOCAL on the day before the tour's local date =
    // 19:30 EST Jan 19 = Jan 20 00:30Z (outside the window, unclamped).
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');

    // morning_of: scheduledAt - 4h = Jan 20 11:00 EST (daytime, unclamped).
    // The persisted KIND keeps its name; only the timing moved.
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T16:00:00.000Z');

    // en_route: scheduledAt - 1h = Jan 20 14:00 EST (daytime, unclamped).
    // One hour since the founder decision of 2026-08-18 (was two).
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T19:00:00.000Z');

    // no_show_checkin is manual-send only, so it is NOT auto-armed (absent here).
    expect(byKind['no_show_checkin']).toBeUndefined();

    // All rows should have no sentAt/canceledAt
    for (const r of rows) {
      expect(r.sentAt).toBeUndefined();
      expect(r.canceledAt).toBeUndefined();
      expect(r.reminderId).toMatch(/^reminder-/);
      expect(r.tourId).toBe(tour.tourId);
      expect(r._reminderPartition).toBe('reminders');
    }

    // listByTour round-trip
    const listed = await tourReminders.listByTour(tour.tourId);
    expect(listed).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Test 1b - guard: no_show_checkin is manual-send only, never auto-armed
  // ---------------------------------------------------------------------------
  it('does not auto-arm the no_show_checkin rung (manual send only)', async () => {
    const now = '2026-07-13T10:00:00.000Z';
    // T+2d, full future ladder. The tour is at 14:00 EDT (not 06:00 EDT as it
    // once was): a tour that early would have its 08:00-local morning_of land
    // AFTER the tour start, which the past-event rule now legitimately drops -
    // this case is about the no_show_checkin guard, not about that rule.
    const scheduledAt = '2026-07-15T18:00:00.000Z';

    const tour = await tours.create({
      tenantId: 'contact-noarm-1',
      unitId: 'unit-noarm-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    const kinds = rows.map((r) => r.kind);

    expect(kinds).not.toContain('no_show_checkin');
    // Three auto-armed rungs since 2026-08-31 (confirmation is retired too, but
    // for its own reason - see the DISCONTINUED_REMINDER_KINDS describe).
    expect(kinds).toHaveLength(3);
  });

  // ===========================================================================
  // Arm-time quiet-hours clamping + supersession (quiet-hours spec section 5).
  // Every case pins CONCRETE instants against the default window
  // (21:00-08:00 America/New_York; January = EST = UTC-5), so nothing here
  // depends on the wall clock or on the machine's timezone.
  //
  // Skip rules under test:
  //   (a) past-dueAt        - pre-existing: a clamped dueAt still < now
  //   (b) past-event        - a clamp landing at/after the tour start
  //   (c) same-slot         - an earlier rung clamped onto a later rung's slot
  //   (d) stale day_before  - "tour is tomorrow" landing on the tour's local day
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Test 1c - a LATE-EVENING tour arms its whole ladder, en_route included
  //
  // This case USED to show a clamped day_before losing its slot to morning_of.
  // The 19:30-local retiming ended that: 19:30 is outside the DEFAULT window, so
  // day_before never clamps at all here. The day_before-clamp scenario now
  // requires an org with quietHoursStart <= 19:30, which Task 7's warn test
  // pins.
  //
  // RE-DERIVED 2026-08-31 (Phase B spec 6). It then became the past-event pin
  // for a 10pm tour's en_route: at a one-hour lead that rung fell at 21:00 local
  // EXACTLY, clamped forward to the next 08:00 and landed after the tour. The
  // quiet-hours exemption removes that clamp, so the rung now arms at its raw
  // 21:00 and the tenant of a 10pm tour gets the message they should always have
  // had. Nothing here is skipped any more - which is the point of the fixture
  // now, and why the past-event branch is pinned on morning_of in Tests 1f/1g
  // instead.
  // ---------------------------------------------------------------------------
  it('a late-evening tour arms its whole ladder - the exempt en_route keeps its raw 21:00 slot', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-21T03:00:00.000Z'; // Jan 20 22:00 EST - a 10pm tour

    const tour = await tours.create({
      tenantId: 'contact-arm-supersede-1',
      unitId: 'unit-arm-supersede-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // day_before = 19:30 EST Jan 19 (the tour's LOCAL date is Jan 20) = Jan 20
    // 00:30Z. 19:30 local is before the 21:00 window start, so no clamp, and it
    // is still ahead of `now` -> armed.
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');
    expect(byKind['day_before']!.skippedAt).toBeUndefined();
    // morning_of = scheduledAt - 4h = Jan 20 18:00 EST, also outside the window.
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T23:00:00.000Z');
    expect(byKind['morning_of']!.skippedAt).toBeUndefined();

    // THE EXEMPTION (spec 6). At a one-hour lead this rung falls at Jan 20
    // 21:00 EST exactly - the first minute of the window - and it USED to clamp
    // forward to the next 08:00, landing after the 10pm tour and being retired
    // past_event. Sam's decision is that this rung never waits, so it is stored
    // RAW and the 10pm tour gets its 9pm "on the way" text. No supersession
    // either: morning_of is at 18:00 EST, hours EARLIER, so the widened
    // predicate (a LATER rung firing at or before an earlier one) is false.
    expect(byKind['en_route']!.dueAt).toBe('2026-01-21T02:00:00.000Z'); // Jan 20 21:00 EST
    expect(byKind['en_route']!.skippedAt).toBeUndefined();

    // Three VISIBLE rows and all three live: with the exemption there is nothing
    // left in this fixture for any skip rule to retire.
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Test 1d - (c) a morning_of clamped PAST the exempt en_route loses its slot
  // ---------------------------------------------------------------------------
  it('a morning_of clamped past the exempt en_route is superseded by it', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-20T13:30:00.000Z'; // Jan 20 08:30 EST - an early tour

    const tour = await tours.create({
      tenantId: 'contact-arm-supersede-2',
      unitId: 'unit-arm-supersede-2',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // en_route raw = Jan 20 06:30 EST, inside the window and EXEMPT (spec 6), so
    // it stays there. morning_of raw = scheduledAt - 4h = Jan 20 04:30 EST, also
    // inside the window and NOT exempt, so it clamps forward to 08:00 EST -
    // which is 90 minutes AFTER en_route. The ladder is inverted, and the
    // WIDENED predicate (spec 6.2, `otherDue <= dueAt`) is what still retires
    // morning_of: a later rung firing before it makes its copy stale. Under the
    // old equality both would have armed and the tenant would get two texts.
    // (Before the exemption both clamped onto the same 08:00 instant and plain
    // equality did this job; that coincidence is gone.)
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T12:30:00.000Z');
    expect(byKind['en_route']!.skippedAt).toBeUndefined();
    expect(byKind['morning_of']!.skippedAt).toBe(now);
    expect(byKind['morning_of']!.skipReason).toBe('quiet_hours_superseded');

    // day_before = 19:30 EST Jan 19 = Jan 20 00:30Z: outside the window, so no
    // clamp, and now in the FUTURE of `now` (Jan 19 10:00 EST) -> armed. Before
    // the retiming this rung was scheduledAt - 24h = Jan 19 08:30 EST, already
    // past, and the silent past-dueAt rule dropped it.
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');
    expect(byKind['day_before']!.skippedAt).toBeUndefined();

    // Pin the counts: three VISIBLE rows, two live (day_before, en_route).
    // This case's PREMISE moved most of all under the retiming - day_before
    // flips from silently dropped to armed - so the shape is pinned here rather
    // than left implicit.
    expect(rows).toHaveLength(3);
    expect(
      rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind).sort(),
    ).toEqual(['day_before', 'en_route']);
  });

  // ---------------------------------------------------------------------------
  // Test 1e - a rung whose RAW dueAt lands inside quiet hours clamps forward
  //
  // REDESIGNED 2026-08-31 (Phase B). This case used to ride `confirmation`,
  // whose raw dueAt was the ARM INSTANT: arm at 22:00 local and the rung clamps
  // to the next 08:00. Confirmation no longer arms, and with it went the only
  // rung whose raw time could be chosen freely by moving `now`. Re-derived onto
  // `morning_of`, whose raw time is scheduledAt - 4h: an EARLY-MORNING tour puts
  // that inside the window, so the same clamp runs on a live rung.
  //
  // This is the CLEAN clamp - the one that lands clear of both the tour start
  // and every other rung's slot, so the row simply arms at the clamped instant.
  // Its two neighbours pin the other outcomes: Test 1d a clamp that collides
  // with a later rung (superseded), Test 1f a clamp landing past the start
  // (past_event). Without this case a clamp that silently did nothing would
  // still pass all three.
  // ---------------------------------------------------------------------------
  it('a rung whose raw dueAt falls inside quiet hours is clamped to quiet-end, not left at its raw time', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-25T15:00:00.000Z'; // Jan 25 10:00 EST - an early tour

    const tour = await tours.create({
      tenantId: 'contact-arm-lateclamp-1',
      unitId: 'unit-arm-lateclamp-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // morning_of raw = scheduledAt - 4h = Jan 25 06:00 EST, the morning side of
    // the wrapping 21:00-08:00 window -> clamps forward to Jan 25 08:00 EST.
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-25T13:00:00.000Z');
    expect(byKind['morning_of']!.dueAt).not.toBe('2026-01-25T11:00:00.000Z');
    // It landed clear of the 10:00 EST start and of en_route's 09:00 EST slot,
    // so it is ARMED, not one of the two retirement traces.
    expect(byKind['morning_of']!.skippedAt).toBeUndefined();
    expect(byKind['en_route']!.dueAt).toBe('2026-01-25T14:00:00.000Z');
    expect(byKind['en_route']!.skippedAt).toBeUndefined();
    expect(rows).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Test 1f - (b) rungs whose clamp lands at/past the tour start are skipped
  // ---------------------------------------------------------------------------
  it('rungs clamped at or past the tour start are skipped (early-morning tour)', async () => {
    // `now` is TWO days out (not one). Under the old scheduledAt - 24h anchor
    // that mattered: a Jan 19 arm time left day_before already past. After the
    // 19:30-local retiming day_before is Jan 20 00:30Z and would be future from
    // either arm instant, so the two-day distance is now only historical - it
    // keeps this fixture distinct from Test 1g, which arms one day out.
    const now = '2026-01-18T15:00:00.000Z'; // Jan 18 10:00 EST
    const scheduledAt = '2026-01-20T12:30:00.000Z'; // Jan 20 07:30 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-pastevent-1',
      unitId: 'unit-arm-pastevent-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // morning_of raw = scheduledAt - 4h = Jan 20 03:30 EST (quiet) -> clamps to
    // Jan 20 08:00 EST, at/after the 07:30 EST start -> retired as a VISIBLE
    // skipped row (past_event). This is the rung the case is named for: it is
    // the CLAMP that puts a rung past the start, so an exempt rung can never
    // reach this branch by that route.
    expect(byKind['morning_of']!.skippedAt).toBe(now);
    expect(byKind['morning_of']!.skipReason).toBe('past_event');

    // en_route raw = Jan 20 06:30 EST, inside the window and EXEMPT (spec 6):
    // it stays at its raw instant, an hour before the tour, and arms. Before the
    // exemption it clamped onto the same 08:00 EST as morning_of and was
    // past_event too - the behaviour change this fixture records.
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T11:30:00.000Z');
    expect(byKind['en_route']!.skippedAt).toBeUndefined();

    // day_before = 19:30 EST Jan 19 = Jan 20 00:30Z: outside the window, no
    // clamp. Its LOCAL date (Jan 19) is not the tour's local date (Jan 20), so
    // the "tour is tomorrow" copy is still true -> armed.
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');
    expect(byKind['day_before']!.skippedAt).toBeUndefined();
    expect(
      rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind).sort(),
    ).toEqual(['day_before', 'en_route']);
  });

  // ---------------------------------------------------------------------------
  // Test 1g - the retimed day_before ARMS where the -24h anchor fell past due
  //
  // COVERAGE NOTE. This case used to be the pin for rule (a), the SILENT
  // past-dueAt drop: day_before's clamped dueAt landed before `now` and no row
  // was written. After the 19:30-local retiming that rung is Jan 20 00:30Z,
  // comfortably ahead of a Jan 19 arm, so it arms - and the silent drop loses
  // its last day_before-based coverage here. The other two rungs in this
  // fixture are past_event, a DIFFERENT branch, so they do not stand in for it.
  // The replacement pin is Task 7's case 9 - an en_route booked inside its own
  // one-hour lead time, the rung no booked-too-late rule guards. Do NOT leave
  // the silent-drop branch trusting this comment; Task 7 owns that test.
  // ---------------------------------------------------------------------------
  it('the retimed day_before arms where the old -24h anchor fell past due (morning_of stays past_event)', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-20T12:30:00.000Z'; // Jan 20 07:30 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-pastdue-1',
      unitId: 'unit-arm-pastdue-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });

    // day_before = 19:30 EST Jan 19 = Jan 20 00:30Z, outside the window and
    // still ahead of `now` (10:00 EST) -> ARMED. morning_of clamps at/past the
    // 07:30 start -> past-event, retired as a VISIBLE skipped row. en_route is
    // EXEMPT from the clamp (spec 6), so it arms at its raw 06:30 EST instead of
    // joining morning_of on the past-event branch as it used to.
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');
    expect(byKind['day_before']!.skippedAt).toBeUndefined();
    expect(byKind['morning_of']!.skipReason).toBe('past_event');
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T11:30:00.000Z');
    expect(byKind['en_route']!.skippedAt).toBeUndefined();
    // Creation order (REMINDER_KINDS), not sorted.
    expect(rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind)).toEqual([
      'day_before',
      'en_route',
    ]);
  });

  // ---------------------------------------------------------------------------
  // Test 1h - quiet hours OFF: no clamping, but day_before stays org-local
  //
  // The org-local-anchored rung moved with the retiming: day_before is now the
  // one built from the settings timezone (19:30 local the evening before), and
  // morning_of became a plain scheduledAt - 4h offset. The property under test
  // is unchanged - a DISABLED window must not disable the timezone anchor.
  // ---------------------------------------------------------------------------
  it('with quiet hours disabled nothing is clamped, and day_before is still 19:30 org-local', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-21T03:00:00.000Z'; // Jan 20 22:00 EST - Test 1c's tour

    const tour = await tours.create({
      tenantId: 'contact-arm-quietoff-1',
      unitId: 'unit-arm-quietoff-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // Test 1c's tour, all 3 auto-armed rungs live here too.
    expect(rows).toHaveLength(3);
    // day_before is 19:30 ORG-LOCAL on the day before the tour's local date
    // (Jan 19), regardless of the window's enabled flag - the timezone comes
    // from the same settings row.
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');
    // morning_of = scheduledAt - 4h, a pure UTC offset, unclamped.
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T23:00:00.000Z');
  });

  // ---------------------------------------------------------------------------
  // Test 1i - a settings-read failure falls back to the DEFAULT window
  // ---------------------------------------------------------------------------
  it('a settings read failure still clamps, using the default window', async () => {
    // RE-POINTED 2026-08-31 (Phase B spec 6) from Test 1c's 10pm tour to Test
    // 1g's 07:30 tour. This case has to FAIL if the fallback ever became "no
    // quiet hours", so it needs a rung the window actually MOVES. On the 10pm
    // tour the only clamped rung was en_route - now exempt - which would have
    // left every assertion here identical with the window on or off: a vacuous
    // pass. morning_of on a 07:30 tour is the surviving clamp.
    const now = '2026-01-19T15:00:00.000Z';
    const scheduledAt = '2026-01-20T12:30:00.000Z'; // Jan 20 07:30 EST - Test 1g's tour

    const tour = await tours.create({
      tenantId: 'contact-arm-settingsfail-1',
      unitId: 'unit-arm-settingsfail-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const { rows } = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: failingSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // Identical to Test 1g: the failure falls back to DEFAULT_ORG_SETTINGS
    // (enabled, 21:00-08:00, America/New_York) - never to "no quiet hours".
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T00:30:00.000Z');
    // THE DISCRIMINATING ASSERTION: morning_of's raw Jan 20 03:30 EST is inside
    // the fallback window, so it clamps to 08:00 EST - past the 07:30 start -
    // and is retired. With no window it would have armed at its raw time.
    expect(byKind['morning_of']!.skipReason).toBe('past_event');
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T13:00:00.000Z');
    // en_route is exempt from the clamp either way, so it arms raw. Two live
    // rows, same as Test 1g.
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T11:30:00.000Z');
    expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Test 2 — run: sends due reminders and stamps sentAt; second run is no-op
  // ---------------------------------------------------------------------------
  it('runDueTourReminders sends due rows and is idempotent', async () => {
    // Clear world.sent from prior tests.
    world.sent.length = 0;

    const phone = '+15550200001';
    const contactId = 'contact-run-1';
    const convId = 'conv-run-1';
    const now0 = '2026-07-13T10:00:00.000Z'; // arm time
    const scheduledAt = '2026-07-15T10:00:00.000Z'; // T+2d

    // Seed contact + conversation in the fake world.
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-run-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    // Two due rungs on the IMMEDIATE-SEND VEHICLE (spec 10). What this case is
    // about is the poll's claim/send/idempotence behaviour, not the arm-time
    // ladder (Test 1 owns that), so the rows are written straight to the repo:
    // repo.create honours any dueAt, and both of these sit BEFORE scheduledAt,
    // so the past-tour gate (6.1a) is a no-op for them.
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);
    await createDueReminder(
      tourReminders,
      tour.tourId,
      'morning_of',
      '2026-07-14T23:30:00.000Z',
    );

    // Tick 1 - just after the day_before dueAt: that rung alone is due.
    await runDueTourReminders('2026-07-13T10:01:00.000Z', runDeps);

    // Tick 2 - just after the morning_of dueAt.
    // (The two rungs are released by SEPARATE ticks on purpose: one catch-up
    // tick releasing both would hit release supersession - a later rung of the
    // same tour retires the earlier one. That rule has its own case below.)
    const pollAt = '2026-07-14T23:31:00.000Z';
    await runDueTourReminders(pollAt, runDeps);

    // day_before + morning_of fired, one per tick.
    expect(world.sent).toHaveLength(2);
    const sentBodies = world.sent.map((s) => s.body);
    expect(sentBodies).toContain(rungBody('day_before', scheduledAt));
    expect(sentBodies).toContain(rungBody('morning_of', scheduledAt));

    // All sent rows should have sentAt stamped.
    const rows = await tourReminders.listByTour(tour.tourId);
    const dayBefore = rows.find((r) => r.kind === 'day_before');
    const morningOf = rows.find((r) => r.kind === 'morning_of');
    expect(dayBefore?.sentAt).toBeDefined();
    expect(morningOf?.sentAt).toBeDefined();

    // Second run — idempotent: no new sends.
    await runDueTourReminders(pollAt, runDeps);
    expect(world.sent).toHaveLength(2); // unchanged
  });

  // ---------------------------------------------------------------------------
  // Test 2b — a fired rung emits scheduled.updated (the live Reminders panel /
  // Upcoming bucket refetch on it; reaches SSE clients when the poll runs in
  // the app process — the dev tick / e2e seam)
  // ---------------------------------------------------------------------------
  it('runDueTourReminders emits scheduled.updated per claimed rung (advisory tenant contactId)', async () => {
    world.sent.length = 0;
    const phone = '+15550200002';
    const contactId = 'contact-emit-1';
    const convId = 'conv-emit-1';
    const now0 = '2026-07-13T10:00:00.000Z';
    const scheduledAt = '2026-07-15T10:00:00.000Z';

    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });
    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-emit-1',
      scheduledAt,
      tourType: 'self_guided',
    });
    // Same immediate-send vehicle as Test 2: two due rungs, both before the
    // tour, each released by its own tick.
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);
    await createDueReminder(
      tourReminders,
      tour.tourId,
      'morning_of',
      '2026-07-14T23:30:00.000Z',
    );

    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    // Same two ticks as Test 2 (separate releases - see the supersession note
    // there): day_before fires on the first, morning_of on the second.
    await runDueTourReminders('2026-07-13T10:01:00.000Z', { ...runDeps, events });
    await runDueTourReminders('2026-07-14T23:31:00.000Z', { ...runDeps, events });
    expect(emitted).toHaveLength(2);
    for (const p of emitted) expect(p.contactId).toBe(contactId);

    // Idempotent second run: nothing claims → nothing emits.
    await runDueTourReminders('2026-07-14T23:31:00.000Z', { ...runDeps, events });
    expect(emitted).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Test 2c — a due rung the poll cannot deliver is CLAIM-SKIPPED (retired
  // unsent): stamped skippedAt + skipReason, gone from listDue (no perpetual
  // re-list/re-skip every 60s), never claimable for a send afterwards, and the
  // skip emits scheduled.updated so an open Reminders panel flips its chip.
  // ---------------------------------------------------------------------------
  it('claim-skips a due rung whose tenant has no 1:1 conversation (terminal, emits, leaves listDue)', async () => {
    world.sent.length = 0;

    const contactId = 'contact-skip-1';
    const now0 = '2026-07-13T10:00:00.000Z';
    const scheduledAt = '2026-07-15T10:00:00.000Z';

    // Contact exists WITH a phone — but NO conversation in the world.
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone: '+15550200099',
      created_at: now0,
    } as Parameters<typeof world.contacts.push>[0]);

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-skip-1',
      scheduledAt,
      tourType: 'self_guided',
    });
    // Immediate-send vehicle (spec 10): one due rung, dueAt before the tour.
    const rung = await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    // Only that one rung (dueAt = now0) is due for this tour in this window.
    const pollAt = '2026-07-13T10:01:00.000Z';
    await runDueTourReminders(pollAt, { ...runDeps, events });

    // Nothing sent; the rung is retired with the stamp + reason.
    expect(world.sent).toHaveLength(0);
    const rows = await tourReminders.listByTour(tour.tourId);
    const retired = rows.find((r) => r.reminderId === rung.reminderId);
    expect(retired?.sentAt).toBeUndefined();
    expect(retired?.skippedAt).toBe(pollAt);
    expect(retired?.skipReason).toBe('no_conversation');

    // The skip told live surfaces to refetch (advisory tenant contactId).
    expect(emitted.filter((p) => p.contactId === contactId)).toHaveLength(1);

    // Retired = gone from listDue: the next poll has nothing to re-skip …
    const due = await tourReminders.listDue(pollAt);
    expect(due.find((r) => r.reminderId === retired!.reminderId)).toBeUndefined();

    // … and the row can never be claimed for a send later (terminal).
    await expect(tourReminders.claimSend(retired!.reminderId, pollAt)).resolves.toBe(false);
  });

  // ---------------------------------------------------------------------------
  // sentBody - the body composed for the send that CLAIMED the row, snapshotted
  // so a later reschedule or address edit cannot rewrite what was already sent.
  // The third parameter is OPTIONAL: a two-arg claim is the legacy shape (and
  // the shape every pre-existing caller in this repo still uses), and it must
  // leave the attribute absent rather than writing an empty string.
  // ---------------------------------------------------------------------------
  it('claimSend stores the composed body on the row (and stays optional)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-sentbody-1',
      unitId: 'unit-sentbody-1',
      scheduledAt: '2026-09-10T18:00:00.000Z',
      tourType: 'self_guided',
    });
    const withBody = await tourReminders.create({
      tourId: tour.tourId, kind: 'confirmation', dueAt: '2026-09-01T15:00:00.000Z',
    });
    const withoutBody = await tourReminders.create({
      tourId: tour.tourId, kind: 'day_before', dueAt: '2026-09-09T18:00:00.000Z',
    });

    expect(await tourReminders.claimSend(withBody.reminderId, '2026-09-01T15:00:01.000Z', 'Body text'))
      .toBe(true);
    // Two-arg call: the legacy shape every existing caller uses.
    expect(await tourReminders.claimSend(withoutBody.reminderId, '2026-09-09T18:00:01.000Z'))
      .toBe(true);

    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.reminderId === withBody.reminderId)?.sentBody).toBe('Body text');
    expect(rows.find((r) => r.reminderId === withoutBody.reminderId)?.sentBody).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // COMPOSE-ABOVE-THE-CLAIM containment. The body is composed from the tour's
  // scheduledAt, and a tour can lose a usable one (a bad write, a legacy row);
  // the composer THROWS on that. claimSend IS the sentAt stamp, so the compose
  // must happen ABOVE it - and its failure must be a claim-SKIP, not an escape
  // into the per-row catch, which would leave the row unclaimed and re-listed
  // by every 60s tick forever (the perpetual "sending shortly" bug).
  //
  // Its own January-05 timeline: every other fixture in this file is due on
  // 2026-01-14 or later, so this poll's batch is exactly this one row.
  // ---------------------------------------------------------------------------
  it('a rung whose scheduledAt is unusable is claim-skipped, NOT retried forever', async () => {
    world.sent.length = 0;
    const contactId = 'contact-badsched-1';
    const phone = '+15550200077';
    const convId = 'conv-badsched-1';
    const seededAt = '2026-01-05T00:00:00.000Z';
    // A RESOLVABLE 1:1 target: the failure under test is the COMPOSE, not the
    // target resolution (which claim-skips with its own reasons well before it).
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: seededAt,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: seededAt,
      created_at: seededAt,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-badsched-1',
      scheduledAt: '2026-01-06T18:00:00.000Z',
      tourType: 'self_guided',
    });
    // A LIVE ladder kind: the failure under test is the compose, and the rung's
    // kind is incidental to it. The tour's scheduledAt is corrupted below, which
    // makes the past-tour gate a no-op (an unparseable start is invalid_schedule's
    // business, not the gate's), so this row reaches the composer either way.
    const row = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2026-01-05T15:00:00.000Z',
    });
    // Corrupt the tour's time AFTER arming - the only way to reach this state.
    // The method is patch(), NOT update() - toursRepo has no update.
    await tours.patch(tour.tourId, { scheduledAt: 'not-an-instant' });

    const pollAt = '2026-01-05T15:00:01.000Z';
    await runDueTourReminders(pollAt, runDeps);

    const after = (await tourReminders.listByTour(tour.tourId))
      .find((r) => r.reminderId === row.reminderId);
    expect(after?.skippedAt).toBe(pollAt);
    expect(after?.skipReason).toBe('invalid_schedule');
    expect(after?.sentAt).toBeUndefined();
    expect(world.sent).toHaveLength(0);

    // The point of the claim-skip: it leaves listDue permanently.
    expect((await tourReminders.listDue('2026-01-05T15:10:00.000Z'))
      .some((r) => r.reminderId === row.reminderId)).toBe(false);
  });

  // ===========================================================================
  // FIRE-TIME BACKSTOP (quiet-hours spec 2026-08-03, section 6)
  //
  // These cases live on their OWN January timeline (2026-01-15), so no row from
  // any other test in this file is ever due at their polls, and each uses a
  // FRESH world (createGroupTestRig) so send counts are isolated. Rows are
  // written straight to the repo with in-window dueAts - exactly the LEGACY
  // shape the backstop exists for (rows armed before clamping shipped, plus
  // worker-downtime catch-up). America/New_York is UTC-5 (EST) in January.
  // ===========================================================================

  /** The product default window: enabled, 21:00-08:00 America/New_York. */
  const quietOnDeps = <T extends object>(deps: T) => ({ ...deps, settingsRepo: stubSettingsRepo() });

  // ---------------------------------------------------------------------------
  // Test 2d - a due rung inside the window is DEFERRED, never claimed
  // ---------------------------------------------------------------------------
  it('defers a due rung while `now` is inside quiet hours WITHOUT claiming it, then sends it after the window', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const tenantPhone = '+15550210001';
    const armedAt = '2026-01-14T15:00:00.000Z';
    seedTenant(rig.world, 'contact-quiet-1', tenantPhone, 'conv-quiet-1', armedAt);

    const tour = await tours.create({
      tenantId: 'contact-quiet-1',
      unitId: 'unit-quiet-1',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // The pre-feature 08:00-UTC morning_of dueAt = 03:00 EST: arm-time clamping
    // would never produce it, so only the backstop can stop it.
    const legacy = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T08:00:00.000Z',
    });

    const inWindow = '2026-01-15T09:00:00.000Z'; // Jan 15 04:00 EST
    await runDueTourReminders(inWindow, deps);

    // Nothing sent on either route.
    expect(rig.world.sent).toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    // NOT claimed: claimSend IS the sentAt stamp, so a post-claim refusal would
    // destroy the message. The defer leaves every terminal marker unset.
    const deferred = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === legacy.reminderId,
    );
    expect(deferred?.sentAt).toBeUndefined();
    expect(deferred?.skippedAt).toBeUndefined();
    expect(deferred?.canceledAt).toBeUndefined();
    // Still live in listDue - it re-fires on the next tick.
    expect((await tourReminders.listDue(inWindow)).map((r) => r.reminderId)).toContain(
      legacy.reminderId,
    );

    // One tick past quiet-end (08:05 EST) - the deferred rung goes out.
    const afterWindow = '2026-01-15T13:05:00.000Z';
    await runDueTourReminders(afterWindow, deps);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.body).toBe(rungBody('morning_of', '2026-01-15T20:00:00.000Z'));
    expect(
      (await tourReminders.listByTour(tour.tourId)).find((r) => r.reminderId === legacy.reminderId)
        ?.sentAt,
    ).toBe(afterWindow);
  });

  // ---------------------------------------------------------------------------
  // Test 2e - the backstop sits ABOVE the group branch, so GROUP-routed rungs
  // (landlord_led / pm_team) are covered too
  // ---------------------------------------------------------------------------
  it('defers a GROUP-routed rung as well (the check runs before the tourType branch)', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const now0 = '2026-01-14T15:00:00.000Z';
    const tenantPhone = '+15550210002';
    const landlordPhone = '+15550210012';
    const poolNumber = '+15550190021';
    const groupConvId = 'conv-group-quiet-1';

    seedTenant(rig.world, 'contact-quiet-2', tenantPhone, 'conv-1to1-quiet-2', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-quiet-2', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-quiet-2b', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-quiet-2',
      unitId: 'unit-quiet-2',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    const legacy = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2026-01-15T08:00:00.000Z',
    });

    const inWindow = '2026-01-15T09:00:00.000Z';
    await runDueTourReminders(inWindow, deps);

    // No member text at 4am, and the rung is untouched.
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(0);
    const deferred = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === legacy.reminderId,
    );
    expect(deferred?.sentAt).toBeUndefined();
    expect(deferred?.skippedAt).toBeUndefined();

    // After quiet-end the whole group is texted from the pool number.
    await runDueTourReminders('2026-01-15T13:05:00.000Z', deps);
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
  });

  // ---------------------------------------------------------------------------
  // Test 2f - RELEASE SUPERSESSION: legacy rungs released together at quiet-end
  // must not double-fire; the earlier rung retires unsent
  // ---------------------------------------------------------------------------
  it('release supersession: an earlier rung due beside a LATER rung of the SAME tour is claim-skipped quiet_hours_superseded', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const tenantPhone = '+15550210003';
    seedTenant(rig.world, 'contact-quiet-3', tenantPhone, 'conv-quiet-3', '2026-01-14T15:00:00.000Z');

    const tour = await tours.create({
      tenantId: 'contact-quiet-3',
      unitId: 'unit-quiet-3',
      scheduledAt: '2026-01-16T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // Both sat inside the window and are released by the SAME tick.
    const dayBefore = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2026-01-15T08:00:00.000Z',
    });
    const morningOf = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T12:00:00.000Z',
    });

    const afterWindow = '2026-01-15T13:05:00.000Z';
    await runDueTourReminders(afterWindow, deps);

    const rows = await tourReminders.listByTour(tour.tourId);
    const earlier = rows.find((r) => r.reminderId === dayBefore.reminderId);
    const later = rows.find((r) => r.reminderId === morningOf.reminderId);
    // The stale rung is RETIRED (skip stamp, never a sent stamp).
    expect(earlier?.sentAt).toBeUndefined();
    expect(earlier?.skippedAt).toBe(afterWindow);
    expect(earlier?.skipReason).toBe('quiet_hours_superseded');
    // The current rung sends.
    expect(later?.sentAt).toBe(afterWindow);
    // EXACTLY one text about this tour.
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.body).toBe(rungBody('morning_of', '2026-01-16T20:00:00.000Z'));
  });

  // ---------------------------------------------------------------------------
  // Test 2f-off - release supersession is DELIBERATELY unconditional: it applies
  // with quiet hours switched OFF too. Its job is "never text stale copy on a
  // catch-up tick", and worker downtime stacks same-tour rungs regardless of the
  // window. Pinned here so nobody "fixes" it into a quiet-hours-only rule.
  // ---------------------------------------------------------------------------
  it('release supersession applies with quiet hours DISABLED too (catch-up staleness, not a window rule)', async () => {
    const rig = createGroupTestRig();
    const deps = { ...rig.deps, settingsRepo: quietOffSettingsRepo() };
    const tenantPhone = '+15550210009';
    seedTenant(rig.world, 'contact-quiet-off-1', tenantPhone, 'conv-quiet-off-1', '2026-01-14T15:00:00.000Z');

    const tour = await tours.create({
      tenantId: 'contact-quiet-off-1',
      unitId: 'unit-quiet-off-1',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // Midday dueAts (nowhere near 21:00-08:00) that a stalled worker lists in ONE
    // catch-up batch.
    const morningOf = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T16:00:00.000Z',
    });
    const enRoute = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'en_route',
      dueAt: '2026-01-15T16:05:00.000Z',
    });

    const catchUp = '2026-01-15T16:06:00.000Z';
    await runDueTourReminders(catchUp, deps);

    const rows = await tourReminders.listByTour(tour.tourId);
    const earlier = rows.find((r) => r.reminderId === morningOf.reminderId);
    const later = rows.find((r) => r.reminderId === enRoute.reminderId);
    expect(earlier?.sentAt).toBeUndefined();
    expect(earlier?.skippedAt).toBe(catchUp);
    // The token is NOT renamed for the off case: the panel reads it as
    // "superseded by a later reminder", which is accurate either way.
    expect(earlier?.skipReason).toBe('quiet_hours_superseded');
    expect(later?.sentAt).toBe(catchUp);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.body).toBe(rungBody('en_route', '2026-01-15T20:00:00.000Z'));
  });

  // ---------------------------------------------------------------------------
  // Test 2g - supersession is per-TOUR: two tenants' rungs never cancel each other
  // ---------------------------------------------------------------------------
  it('rungs of DIFFERENT tours never supersede each other (both send)', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const phoneA = '+15550210004';
    const phoneB = '+15550210005';
    seedTenant(rig.world, 'contact-quiet-4a', phoneA, 'conv-quiet-4a', '2026-01-14T15:00:00.000Z');
    seedTenant(rig.world, 'contact-quiet-4b', phoneB, 'conv-quiet-4b', '2026-01-14T15:00:00.000Z');

    const tourA = await tours.create({
      tenantId: 'contact-quiet-4a',
      unitId: 'unit-quiet-4a',
      scheduledAt: '2026-01-16T20:00:00.000Z',
      tourType: 'self_guided',
    });
    const tourB = await tours.create({
      tenantId: 'contact-quiet-4b',
      unitId: 'unit-quiet-4b',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // A's EARLIER rung + B's LATER rung, both released by the same tick.
    const rowA = await tourReminders.create({
      tourId: tourA.tourId,
      kind: 'day_before',
      dueAt: '2026-01-15T08:00:00.000Z',
    });
    const rowB = await tourReminders.create({
      tourId: tourB.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T12:00:00.000Z',
    });

    const afterWindow = '2026-01-15T13:05:00.000Z';
    await runDueTourReminders(afterWindow, deps);

    const a = (await tourReminders.listByTour(tourA.tourId)).find((r) => r.reminderId === rowA.reminderId);
    const b = (await tourReminders.listByTour(tourB.tourId)).find((r) => r.reminderId === rowB.reminderId);
    expect(a?.sentAt).toBe(afterWindow);
    expect(a?.skipReason).toBeUndefined();
    expect(b?.sentAt).toBe(afterWindow);
    expect(b?.skipReason).toBeUndefined();
    expect(rig.world.sent).toHaveLength(2);
    // A's day_before is composed from A's tour time, B's morning_of from B's -
    // the two rungs no longer share a body once the copy carries the instant.
    expect(rig.world.sent.map((s) => s.body).sort()).toEqual(
      [
        rungBody('day_before', '2026-01-16T20:00:00.000Z'),
        rungBody('morning_of', '2026-01-15T20:00:00.000Z'),
      ].sort(),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3 — reschedule: cancel old reminders, re-arm with new scheduledAt
  // ---------------------------------------------------------------------------
  it('cancel + re-arm on reschedule produces new rows with updated dueAts', async () => {
    const now0 = '2026-07-13T11:00:00.000Z';
    // Both tours sit at 15:00 / 14:00 EDT (they used to be 07:00 / 10:00 EDT):
    // an early-morning tour drops rungs for reasons this case is not about -
    // morning_of lands after a 07:00 start (past-event), and a 10:00 start puts
    // en_route exactly on the 08:00-local morning_of slot (supersession).
    const origScheduledAt = '2026-07-15T19:00:00.000Z';
    const newScheduledAt = '2026-07-20T18:00:00.000Z'; // rescheduled to T+7d

    const tour = await tours.create({
      tenantId: 'contact-reschedule-1',
      unitId: 'unit-reschedule-1',
      scheduledAt: origScheduledAt,
      tourType: 'self_guided',
    });

    // Arm original reminders.
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    const origRows = await tourReminders.listByTour(tour.tourId);
    expect(origRows).toHaveLength(3);

    // Cancel and re-arm with the new scheduledAt.
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    // All original rows should be canceled.
    const afterCancel = await tourReminders.listByTour(tour.tourId);
    expect(afterCancel.every((r) => r.canceledAt !== undefined)).toBe(true);

    // Patch the tour with the new scheduledAt.
    const patchedTour = await tours.patch(tour.tourId, { scheduledAt: newScheduledAt });
    await armTourReminders(patchedTour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // New rows should exist in addition to the canceled ones.
    const allRows = await tourReminders.listByTour(tour.tourId);
    const newRows = allRows.filter((r) => r.canceledAt === undefined);
    expect(newRows).toHaveLength(3);

    // New day_before should reflect the new scheduledAt: 19:30 org-local the
    // evening before its local date (Jul 20 EDT) = 19:30 EDT Jul 19.
    const dayBefore = newRows.find((r) => r.kind === 'day_before');
    expect(dayBefore?.dueAt).toBe('2026-07-19T23:30:00.000Z');

    // no_show_checkin is manual-send only now, so re-arm does NOT create it.
    const noShow = newRows.find((r) => r.kind === 'no_show_checkin');
    expect(noShow).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4 — cancel tour: all pending rows marked canceled
  // ---------------------------------------------------------------------------
  it('cancelTourReminders marks all pending rows canceled', async () => {
    const now0 = '2026-07-13T12:00:00.000Z';
    const scheduledAt = '2026-07-16T10:00:00.000Z';

    const tour = await tours.create({
      tenantId: 'contact-cancel-1',
      unitId: 'unit-cancel-1',
      scheduledAt,
      tourType: 'landlord_led',
    });

    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // Manually mark the day_before row as sent (simulates one already fired).
    // It rode `confirmation` until 2026-08-31; any armed kind does, and
    // day_before is the earliest live rung.
    const rows = await tourReminders.listByTour(tour.tourId);
    const sentRow = rows.find((r) => r.kind === 'day_before');
    await tourReminders.claimSend(sentRow!.reminderId, now0);

    // Now cancel.
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    const afterCancel = await tourReminders.listByTour(tour.tourId);
    // Pending = the same definition cancelForTour uses: no terminal stamp at
    // all. (This 06:00 EDT tour births morning_of as a past_event skipped row -
    // a visible trace, not a pending rung, so cancel rightly leaves it alone.)
    const stillPending = afterCancel.filter(
      (r) => r.sentAt === undefined && r.canceledAt === undefined && r.skippedAt === undefined,
    );
    expect(stillPending).toHaveLength(0);

    // The already-sent row should still be sent (not double-canceled).
    const sentAfter = afterCancel.find((r) => r.kind === 'day_before');
    expect(sentAfter?.sentAt).toBeDefined();
    // canceledAt should NOT be set on the sent row (the condition guard).
    // Note: the cancelForTour implementation only cancels rows with no sentAt AND no canceledAt.
    // The sent row has sentAt set, so it should be excluded from cancelation.
    // (If the conditional update races, it should fail silently — but in our test it's deterministic.)
    // The sent row may or may not have canceledAt — depends on timing. But we verified stillPending=0.
  });

  // ---------------------------------------------------------------------------
  // Test 5 - same-day tour: BOTH near rungs are retired booked_too_late
  // ---------------------------------------------------------------------------
  it('armTourReminders retires BOTH day_before and morning_of as booked_too_late on a same-day tour', async () => {
    // A same-day booking, five hours out. Both booked-too-late rules fire, and
    // both write a VISIBLE row: day_before because its RAW time (19:30 the
    // evening before) is a day behind us, morning_of because the tour is
    // same-day and we are inside its six-hour lead. This used to be a silent
    // drop plus a live rung - the founder saw a gap where the explanation
    // should have been (spec 8.1).
    const now0 = '2026-07-13T09:00:00.000Z';
    const scheduledAt = '2026-07-13T14:00:00.000Z'; // only 5 hours from now

    const tour = await tours.create({
      tenantId: 'contact-sameday-1',
      unitId: 'unit-sameday-1',
      scheduledAt,
      tourType: 'pm_team',
    });

    const { rows } = await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    const armedKinds = rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind);

    // day_before RAW = 19:30 EDT Jul 12 = '2026-07-12T23:30:00.000Z'; rule-1
    // cutoff = RAW - 4h = '2026-07-12T19:30:00.000Z', which now0 is half a day
    // past. Rule 1 runs AHEAD of the past-dueAt branch, so instead of the old
    // silent drop there is a visible row carrying the reason - stamped with the
    // CLAMPED dueAt (identity here: quiet hours are off).
    const dayBefore = rows.find((r) => r.kind === 'day_before');
    expect(dayBefore).toBeDefined();
    expect(dayBefore?.skipReason).toBe('booked_too_late');
    expect(dayBefore?.dueAt).toBe('2026-07-12T23:30:00.000Z');

    // confirmation no longer arms at all (Phase B, 2026-08-31), so the ladder
    // this case leaves behind is en_route alone - see the en_route pin below.
    expect(rows.map((r) => r.kind)).not.toContain('confirmation');

    // morning_of RAW = scheduledAt - 4h = '2026-07-13T10:00:00.000Z' and is
    // still ahead of now0 - but rule 2 does not care about the RAW time being
    // future, only about the LEAD: the tour is same-day (both local dates are
    // Jul 13) and now0 09:00Z is past scheduledAt - 6h = 08:00Z. Four hours
    // notice is not enough for a "your tour is in four hours" text to be worth
    // sending, so the rung is retired with the same visible reason.
    const morningOf = rows.find((r) => r.kind === 'morning_of');
    expect(morningOf?.dueAt).toBe('2026-07-13T10:00:00.000Z');
    expect(morningOf?.skipReason).toBe('booked_too_late');
    expect(armedKinds).not.toContain('morning_of');

    // en_route = scheduledAt - 1h = '2026-07-13T13:00:00.000Z' > now0 → armed
    expect(rows.find((r) => r.kind === 'en_route')?.dueAt).toBe('2026-07-13T13:00:00.000Z');
    expect(armedKinds).toContain('en_route');

    // no_show_checkin is manual-send only now, so it is never auto-armed.
    expect(rows.map((r) => r.kind)).not.toContain('no_show_checkin');
  });

  // ===========================================================================
  // THE BOOKED-TOO-LATE ARM RULES (spec section 8, founder retiming 2026-08-26)
  //
  //   rule 1: day_before  is skipped when now > rawDueAt - 4h
  //   rule 2: morning_of  is skipped when sameDay && now > scheduledAt - 6h
  //
  // Both compare RAW (pre-clamp) offsets, both boundaries are strictly '>', and
  // both run BEFORE the silent past-dueAt drop - so the MOST-late booking, the
  // one a founder most needs explained, gets a VISIBLE skipped row instead of
  // vanishing. Precedence per rung: booked-too-late > past-dueAt > past-event >
  // supersession/staleDayBefore. The row stores the CLAMPED dueAt, exactly like
  // every neighbouring arm-time skip row (spec 8.2); the RAW value is only what
  // the RULE compares against.
  //
  // Shared fixture TOUR: Thu Jul 23 2026, 15:00 EDT.
  //   day_before RAW = 19:30 EDT Jul 22 = '2026-07-22T23:30:00.000Z'
  //     rule-1 cutoff  = RAW - 4h       = '2026-07-22T19:30:00.000Z'
  //   morning_of RAW = sched - 4h       = '2026-07-23T15:00:00.000Z'
  //     rule-2 cutoff  = sched - 6h     = '2026-07-23T13:00:00.000Z'
  //   en_route   RAW = sched - 1h       = '2026-07-23T18:00:00.000Z'
  // ===========================================================================
  describe('booked-too-late arm rules (spec section 8)', () => {
    const TOUR = '2026-07-23T19:00:00.000Z';
    /** The spec-7.1 arm-time warn, byte-exact (jobs/tourReminders.ts). */
    const QUIET_1930_WARN =
      'tour reminders: the 19:30 day_before anchor is inside the org quiet window - ' +
      'every day_before will clamp to the tour morning and be retired as superseded';
    let seq = 0;

    async function armAt(
      now: string,
      opts: { scheduledAt?: string; settingsRepo?: SettingsReadRepo } = {},
    ) {
      seq += 1;
      const tour = await tours.create({
        tenantId: `contact-btl-${seq}`,
        unitId: `unit-btl-${seq}`,
        scheduledAt: opts.scheduledAt ?? TOUR,
        tourType: 'self_guided',
      });
      const { rows } = await armTourReminders(tour, now, {
        tourRemindersRepo: tourReminders,
        settingsRepo: opts.settingsRepo ?? quietOff,
        logger,
      });
      return {
        tour,
        rows,
        byKind: Object.fromEntries(rows.map((r) => [r.kind, r])),
      };
    }

    // -- case 1 ---------------------------------------------------------------
    it('case 1: rule 1 just past the cutoff writes a VISIBLE booked_too_late day_before', async () => {
      const now = '2026-07-22T19:30:00.001Z'; // one ms past the cutoff
      const { byKind } = await armAt(now);

      const dayBefore = byKind['day_before'];
      expect(dayBefore).toBeDefined();
      expect(dayBefore!.skipReason).toBe('booked_too_late');
      expect(dayBefore!.skippedAt).toBe(now);
      // The CLAMPED value - identity here because quiet hours are off. Storing
      // the raw value would break the shape every other arm-time skip row has.
      expect(dayBefore!.dueAt).toBe('2026-07-22T23:30:00.000Z');

      // Rule 2 does not reach across the midnight boundary: `now` is 15:30 EDT
      // Jul 22, whose LOCAL date is Jul 22, not the tour's Jul 23.
      expect(byKind['morning_of']!.dueAt).toBe('2026-07-23T15:00:00.000Z');
      expect(byKind['morning_of']!.skippedAt).toBeUndefined();
      expect(byKind['en_route']!.dueAt).toBe('2026-07-23T18:00:00.000Z');
      expect(byKind['en_route']!.skippedAt).toBeUndefined();
    });

    // -- case 2 ---------------------------------------------------------------
    it('case 2: rule 1 EXACTLY on the cutoff still arms (the boundary is strictly >)', async () => {
      const now = '2026-07-22T19:30:00.000Z';
      const { byKind } = await armAt(now);

      expect(byKind['day_before']!.dueAt).toBe('2026-07-22T23:30:00.000Z');
      expect(byKind['day_before']!.skippedAt).toBeUndefined();
      expect(byKind['day_before']!.skipReason).toBeUndefined();
    });

    // -- case 3 ---------------------------------------------------------------
    it('case 3: rule 1 BEATS the silent past-dueAt drop (same-day booking, day_before raw already past)', async () => {
      // 10:00 EDT on the tour's own day. day_before's RAW (Jul 22 23:30Z) is
      // already behind us, so before this change the past-dueAt branch wrote
      // NOTHING and the founder saw a gap. This case is the ORDERING
      // discriminator - without it, both placements of the branch pass.
      const now = '2026-07-23T14:00:00.000Z';
      const { byKind } = await armAt(now);

      const dayBefore = byKind['day_before'];
      expect(dayBefore).toBeDefined();
      expect(dayBefore!.skipReason).toBe('booked_too_late');
      expect(dayBefore!.dueAt).toBe('2026-07-22T23:30:00.000Z');

      // Rule 2 fires on the same booking: sameDay, and 14:00Z > 13:00Z.
      const morningOf = byKind['morning_of'];
      expect(morningOf).toBeDefined();
      expect(morningOf!.skipReason).toBe('booked_too_late');
      expect(morningOf!.dueAt).toBe('2026-07-23T15:00:00.000Z');

      expect(byKind['en_route']!.skippedAt).toBeUndefined();
      // en_route is the only survivor: confirmation no longer arms (Phase B).
      expect(byKind['confirmation']).toBeUndefined();
    });

    // -- case 4 ---------------------------------------------------------------
    it('case 4: rule 2 BEATS the silent past-dueAt drop (booked three hours out)', async () => {
      // morning_of's RAW (15:00Z) is already past at 16:00Z, so the past-dueAt
      // branch would have dropped it silently.
      const now = '2026-07-23T16:00:00.000Z';
      const { byKind } = await armAt(now);

      const morningOf = byKind['morning_of'];
      expect(morningOf).toBeDefined();
      expect(morningOf!.skipReason).toBe('booked_too_late');
      expect(morningOf!.skippedAt).toBe(now);
      expect(morningOf!.dueAt).toBe('2026-07-23T15:00:00.000Z');

      // en_route has NO rule of its own and is still ahead of `now`.
      expect(byKind['en_route']!.dueAt).toBe('2026-07-23T18:00:00.000Z');
      expect(byKind['en_route']!.skippedAt).toBeUndefined();
    });

    // -- case 5 ---------------------------------------------------------------
    it('case 5: rule 2 EXACTLY on the cutoff still arms (the boundary is strictly >)', async () => {
      const now = '2026-07-23T13:00:00.000Z'; // scheduledAt - 6h to the ms
      const { byKind } = await armAt(now);

      expect(byKind['morning_of']!.dueAt).toBe('2026-07-23T15:00:00.000Z');
      expect(byKind['morning_of']!.skippedAt).toBeUndefined();
      // CAVEAT (research-6, D-4 case 5): day_before IS booked_too_late in this
      // fixture - the tour is same-day, so rule 1 fired hours ago. Not what
      // this case is about; noted so nobody reads it as a rule-2 leak.
      expect(byKind['day_before']!.skipReason).toBe('booked_too_late');
    });

    // -- case 6 ---------------------------------------------------------------
    it('case 6: rule 2 is SAME-DAY only - a 4h gap across the local midnight still arms morning_of', async () => {
      // Tour Jul 24 01:00 EDT (local date Jul 24); armed at Jul 23 21:00 EDT
      // (local date Jul 23). The gap is 4h, inside the 6h lead - but the local
      // dates differ, so rule 2 must not fire.
      const now = '2026-07-24T01:00:00.000Z';
      const { byKind } = await armAt(now, { scheduledAt: '2026-07-24T05:00:00.000Z' });

      const morningOf = byKind['morning_of'];
      expect(morningOf).toBeDefined();
      expect(morningOf!.skippedAt).toBeUndefined();
      // BOUNDARY, DELIBERATE (A7-3): morning_of's RAW is 05:00Z - 4h = 01:00Z,
      // which is EXACTLY `now`. The past-dueAt branch is `if (dueAt < now)`, so
      // the row survives - armed already-due. A builder who "tidies" that
      // comparison to `<=` breaks this case.
      expect(morningOf!.dueAt).toBe(now);
      // day_before still trips rule 1 (its cutoff was 19:30 EDT Jul 23).
      expect(byKind['day_before']!.skipReason).toBe('booked_too_late');
    });

    // -- case 8 ---------------------------------------------------------------
    // Case 7 (reschedule + revival) lives in toursApi.test.ts - it needs the
    // real PATCH route, not a direct armTourReminders call.
    //
    // LOAD-BEARING TWICE OVER (A7-4). After the 19:30 retiming, `staleDayBefore`
    // can NEVER fire under the DEFAULT window - 19:30 is outside 21:00-08:00, so
    // day_before never clamps onto the tour's own local date. This case, with
    // quietHoursStart 19:00, is that rule's ONLY remaining coverage as well as
    // the 7.1 warn's. Do not delete it as "an unusual org config".
    it('case 8: quietHoursStart 19:00 clamps day_before onto the tour morning - staleDayBefore retires it AND the 7.1 warn names the cause', async () => {
      const now = '2026-07-20T12:00:00.000Z'; // 08:00 EDT, three days out
      const from = logCapture.lines.length;
      const { byKind } = await armAt(now, {
        settingsRepo: stubSettingsRepo({ quietHoursStart: '19:00' }),
      });

      // RAW 19:30 EDT Jul 22 is inside [19:00, 08:00), so it clamps forward to
      // the next 08:00 local = 08:00 EDT Jul 23 = the TOUR's own local date,
      // which is exactly what staleDayBefore retires ("your tour is tomorrow"
      // arriving on tour day). Rule 1 does NOT pre-empt: its cutoff is Jul 22
      // 19:30Z, two days after `now`.
      const dayBefore = byKind['day_before'];
      expect(dayBefore!.dueAt).toBe('2026-07-23T12:00:00.000Z');
      expect(dayBefore!.skipReason).toBe('quiet_hours_superseded');

      expect(logCapture.lines.slice(from).map((l) => l['msg'])).toContain(QUIET_1930_WARN);
    });

    it('case 8 (negative): the SAME 19:00 start with quiet hours DISABLED warns nothing', async () => {
      // quietOffSettingsRepo() would be a VACUOUS control here: it keeps the
      // DEFAULT 21:00 start, and 19:30 is outside [21:00, 08:00) whether or not
      // isQuietTime gates on `enabled`. Only a disabled-but-19:00 window
      // separates "gated on enabled" from "outside the window anyway".
      const now = '2026-07-20T12:00:00.000Z';
      const from = logCapture.lines.length;
      const { byKind } = await armAt(now, {
        settingsRepo: stubSettingsRepo({ quietHoursEnabled: false, quietHoursStart: '19:00' }),
      });

      expect(logCapture.lines.slice(from).map((l) => l['msg'])).not.toContain(QUIET_1930_WARN);
      // and with no clamp the rung simply arms at 19:30 local.
      expect(byKind['day_before']!.dueAt).toBe('2026-07-22T23:30:00.000Z');
      expect(byKind['day_before']!.skippedAt).toBeUndefined();
    });

    // -- case 9 ---------------------------------------------------------------
    it('case 9: the silent past-dueAt drop survives for en_route, which no booked-too-late rule guards', async () => {
      // THE PAST-DUEAT REPLACEMENT PIN. Every pre-change assertion of the silent
      // drop rode day_before, and every one of them inverts once rule 1 lands -
      // but the branch is NOT dead: en_route has no rule, so a booking inside
      // its own one-hour lead time still reaches it and still writes NO row.
      // Deleting this case leaves a live production branch with zero coverage.
      const now = '2026-07-23T18:30:00.000Z'; // 14:30 EDT, 30 min before the tour
      const from = logCapture.lines.length;
      const { rows, byKind } = await armAt(now);

      expect(rows.map((r) => r.kind)).not.toContain('en_route');
      expect(logCapture.lines.slice(from).map((l) => l['msg'])).toContain(
        'tour reminder skipped (dueAt in the past)',
      );

      expect(byKind['day_before']!.skipReason).toBe('booked_too_late');
      expect(byKind['morning_of']!.skipReason).toBe('booked_too_late');
      // confirmation used to arm at `now` and make a third row here. It no
      // longer arms at all (Phase B, 2026-08-31), so the two booked_too_late
      // traces are the WHOLE ladder this booking leaves - which is the point of
      // the case: en_route's silent drop is the only rung with no visible row.
      expect(byKind['confirmation']).toBeUndefined();

      expect(rows).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6 — listDue returns only pending rows with dueAt <= now
  // ---------------------------------------------------------------------------
  it('listDue excludes sentAt and canceledAt rows', async () => {
    // REDESIGNED 2026-08-31 (Phase B). This case used to arm the ladder and
    // lean on "the confirmation row is the ONLY row due at now0" - a fact that
    // died with arming, and one that made the case depend on the ARMER's
    // dueAt arithmetic to say anything about the REPO's due-row query. It now
    // builds its rows directly (the spec-10 immediate-send vehicle), which
    // states the three inputs the query actually discriminates on - dueAt <=
    // now, sentAt absent, canceledAt absent - with nothing else in the way.
    const now0 = '2026-07-13T15:00:00.000Z';
    const scheduledAt = '2026-07-15T15:00:00.000Z';

    const tour = await tours.create({
      tenantId: 'contact-listdue-1',
      unitId: 'unit-listdue-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    // Two rows due AT now0 and one a day out. Every dueAt is before the tour
    // start (6.1a), so none of them is a row the past-tour gate would retire.
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);
    await createDueReminder(tourReminders, tour.tourId, 'morning_of', now0);
    await createDueReminder(
      tourReminders,
      tour.tourId,
      'en_route',
      '2026-07-14T15:00:00.000Z',
    );

    // The future row is excluded by dueAt alone; the two at now0 come back
    // (the boundary is <=, not <).
    const dueRows1 = await tourReminders.listDue(now0);
    const forThisTour1 = dueRows1.filter((r) => r.tourId === tour.tourId);
    expect(forThisTour1.map((r) => r.kind).sort()).toEqual(['day_before', 'morning_of']);

    // Now retire both, one per terminal stamp: claimSend for sentAt (the
    // production send path) and cancelTourReminders for canceledAt. Both
    // exclusions are in this test's NAME, so both are exercised.
    const dayBefore = forThisTour1.find((r) => r.kind === 'day_before')!;
    await tourReminders.claimSend(dayBefore.reminderId, now0);
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    // Second listDue at the SAME instant - so nothing but the two terminal
    // stamps can explain the rows disappearing.
    const dueRows2 = await tourReminders.listDue(now0);
    const forThisTour2 = dueRows2.filter((r) => r.tourId === tour.tourId);
    expect(forThisTour2).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7 — [concurrency] two racing runDueTourReminders → exactly ONE send
  // (RED until claim-before-send fix lands)
  // ---------------------------------------------------------------------------
  it('two concurrent runDueTourReminders calls over the same due row send exactly once', async () => {
    // Fresh world so send counts are isolated.
    const racingWorld = createFakeWorld();
    const racingSend = createSendMessageService({
      logger,
      adapter: racingWorld.adapter,
      conversationsRepo: racingWorld.conversationsRepo,
      messagesRepo: racingWorld.messagesRepo,
      contactsRepo: racingWorld.contactsRepo,
      auditRepo: racingWorld.auditRepo,
      events: racingWorld.events,
    });

    const phone = '+15550300001';
    const contactId = 'contact-race-1';
    const convId = 'conv-race-1';
    const now0 = '2026-07-13T16:00:00.000Z';
    const scheduledAt = '2026-07-15T16:00:00.000Z';

    racingWorld.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof racingWorld.contacts.push>[0]);
    racingWorld.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-race-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    // ONE due row (immediate-send vehicle, spec 10) - the race is about a single
    // row claimed twice, so the rest of a ladder would only add noise.
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    const racingDeps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: racingWorld.contactsRepo,
      conversationsRepo: racingWorld.conversationsRepo,
      unitsRepo: racingWorld.unitsRepo,
      messagesRepo: racingWorld.messagesRepo,
      sendMessageService: racingSend,
      adapter: createAdapterSpy().adapter,
      settingsRepo: quietOff,
      logger,
    };

    // Run two polls concurrently — they both see the same due row.
    await Promise.all([
      runDueTourReminders(now0, racingDeps),
      runDueTourReminders(now0, racingDeps),
    ]);

    // Claim-before-send: exactly ONE send must have happened.
    expect(racingWorld.sent).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Test 8 — [concurrency] row canceled after listDue but before claim → 0 sends
  // (RED until claim-before-send fix lands; the claim condition includes canceledAt)
  // ---------------------------------------------------------------------------
  it('a row canceled between listDue and the claim step fires zero sends', async () => {
    const cancelWorld = createFakeWorld();
    const cancelSend = createSendMessageService({
      logger,
      adapter: cancelWorld.adapter,
      conversationsRepo: cancelWorld.conversationsRepo,
      messagesRepo: cancelWorld.messagesRepo,
      contactsRepo: cancelWorld.contactsRepo,
      auditRepo: cancelWorld.auditRepo,
      events: cancelWorld.events,
    });

    const phone = '+15550400001';
    const contactId = 'contact-cancel-race-1';
    const convId = 'conv-cancel-race-1';
    const now0 = '2026-07-13T17:00:00.000Z';
    const scheduledAt = '2026-07-15T17:00:00.000Z';

    cancelWorld.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof cancelWorld.contacts.push>[0]);
    cancelWorld.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-cancel-race-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    // ONE due row (immediate-send vehicle, spec 10).
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    // List due rows (simulating what runDueTourReminders does internally) —
    // then cancel the tour BEFORE the claim fires.
    const dueRows = await tourReminders.listDue(now0);
    const pendingRow = dueRows.find((r) => r.tourId === tour.tourId && r.kind === 'day_before');
    expect(pendingRow).toBeDefined();

    // Cancel the tour's reminders (simulates PATCH /tours/:id { status: 'canceled' }).
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    // Now attempt to run — the claim should fail for the canceled row → zero sends.
    const cancelDeps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: cancelWorld.contactsRepo,
      conversationsRepo: cancelWorld.conversationsRepo,
      unitsRepo: cancelWorld.unitsRepo,
      messagesRepo: cancelWorld.messagesRepo,
      sendMessageService: cancelSend,
      adapter: createAdapterSpy().adapter,
      settingsRepo: quietOff,
      logger,
    };
    await runDueTourReminders(now0, cancelDeps);

    expect(cancelWorld.sent).toHaveLength(0);
  });

  // ===========================================================================
  // Group-thread reminder routing (Task 2 — founder decision 2026-07-02):
  // landlord_led / pm_team reminders go to the tour's masked GROUP thread via
  // DIRECT per-member adapter sends FROM the pool number (the relay.intro
  // precedent — sendMessageService refuses relay_group threads and the worker
  // cannot enqueue jobs); self_guided stays tenant-1:1 even when a group
  // exists; any unusable group (no groupThreadId / missing conversation /
  // wrong type / closed) falls back to the tenant-1:1 path — a reminder must
  // never be lost.
  //
  // These tests use their OWN August timeline (the earlier tests live on
  // 2026-07-13..15) so leftover pending rows from other tests are never due
  // at these polls, and fresh per-test worlds so send counts are isolated.
  // ===========================================================================

  // No shared CONFIRMATION_BODY constant: the copy now carries the tour's own
  // time, so each case composes from ITS fixture's scheduledAt via rungBody().

  /** Adapter spy for the GROUP route: records direct sends; never a network. */
  function createAdapterSpy(opts: { failFor?: string[] } = {}): {
    adapter: MessagingAdapter;
    sends: SendMessageParams[];
  } {
    const sends: SendMessageParams[] = [];
    let sidCounter = 0;
    const adapter: MessagingAdapter = {
      async sendMessage(params) {
        if (opts.failFor?.includes(params.to)) {
          throw new Error('adapter spy: injected send failure');
        }
        sends.push(params);
        sidCounter += 1;
        return {
          providerSid: `SMspy-${sidCounter}`,
          status: 'queued',
          providerTs: new Date().toISOString(),
        };
      },
      async getMediaStream() {
        throw new Error('adapter spy: getMediaStream not expected');
      },
      async getMediaContentType() {
        return undefined;
      },
      async getRecordingStream() {
        throw new Error('adapter spy: getRecordingStream not expected');
      },
      async provisionPhoneNumber() {
        throw new Error('adapter spy: provisionPhoneNumber not expected');
      },
      async setVoiceWebhook() {
        throw new Error('adapter spy: setVoiceWebhook not expected');
      },
      async releasePhoneNumber() {
        throw new Error('adapter spy: releasePhoneNumber not expected');
      },
      async attachToMessagingService() {
        throw new Error('adapter spy: attachToMessagingService not expected');
      },
      async detachFromMessagingService() {
        throw new Error('adapter spy: detachFromMessagingService not expected');
      },
      async initiateCall() {
        throw new Error('adapter spy: initiateCall not expected');
      },
      async createViTranscript() {
        throw new Error('adapter spy: createViTranscript not expected');
      },
      async fetchViTranscript() {
        throw new Error('adapter spy: fetchViTranscript not expected');
      },
      async listViSentences() {
        throw new Error('adapter spy: listViSentences not expected');
      },
    };
    return { adapter, sends };
  }

  /**
   * Fresh world + full runDueTourReminders deps with a group-adapter spy.
   * The 1:1 path sends via the world's own adapter (world.sent); the group
   * path sends via the spy (groupSends) — so the two routes are separable.
   */
  function createGroupTestRig(opts: { failFor?: string[] } = {}) {
    const world = createFakeWorld();
    const spy = createAdapterSpy(opts);
    const send = createSendMessageService({
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
    });
    const deps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      // D11 roster resolution (contact-rosters): the property default rung.
      unitsRepo: world.unitsRepo,
      // Group rungs persist a system announcement row in the relay thread
      // (sendRelayAnnouncement) — the world's message store backs it.
      messagesRepo: world.messagesRepo,
      sendMessageService: send,
      adapter: spy.adapter,
      settingsRepo: quietOff,
      logger,
    };
    return { world, deps, groupSends: spy.sends };
  }

  function seedTenant(
    world: ReturnType<typeof createFakeWorld>,
    contactId: string,
    phone: string,
    convId: string,
    now: string,
  ): void {
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now,
      created_at: now,
    });
  }

  function seedRelayGroup(
    world: ReturnType<typeof createFakeWorld>,
    opts: {
      convId: string;
      poolNumber: string;
      status?: 'open' | 'closed';
      participants: ConversationParticipant[];
      now: string;
    },
  ): void {
    world.conversations.set(opts.convId, {
      conversationId: opts.convId,
      // relay_group threads carry the pool number as the synthetic placeholder.
      participant_phone: opts.poolNumber,
      status: opts.status ?? 'open',
      type: 'relay_group',
      ai_mode: 'manual',
      last_activity_at: opts.now,
      created_at: opts.now,
      pool_number: opts.poolNumber,
      participants: opts.participants,
    });
  }

  // ---------------------------------------------------------------------------
  // Test 9 — landlord_led + open group: every member texted FROM the pool number
  // ---------------------------------------------------------------------------
  it('landlord_led tour with an open group: reminder goes to EVERY member from the pool number, not the 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T10:00:00.000Z';
    const scheduledAt = '2026-08-03T18:00:00.000Z';
    const tenantPhone = '+15550500001';
    const landlordPhone = '+15550500002';
    const poolNumber = '+15550190001';
    const groupConvId = 'conv-group-ll-1';

    seedTenant(rig.world, 'contact-group-ll-1', tenantPhone, 'conv-1to1-ll-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-group-ll-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-group-ll-2', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-group-ll-1',
      unitId: 'unit-group-ll-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    // IMMEDIATE-SEND VEHICLE (spec 10), used by every case in this group-routing
    // section: what is under test is where a due rung GOES, so each tour gets one
    // directly-created due row instead of a whole armed ladder. repo.create
    // honours any dueAt, and now0 is well before scheduledAt, so the past-tour
    // gate (6.1a) is a no-op.
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    // That one rung is the only row due at now0.
    await runDueTourReminders(now0, rig.deps);

    // Group route: one direct adapter send PER member, FROM the pool number,
    // carrying the same rung body.
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
    for (const s of rig.groupSends) {
      expect(s.from).toBe(poolNumber);
      expect(s.body).toBe(rungBody('day_before', scheduledAt));
    }

    // Founder decision 2026-07-14: the rung is VISIBLE in the group thread —
    // persisted ONCE as a system announcement with per-member delivery slots.
    const announcementRows = rig.world.messages.filter(
      (m) => m.conversationId === groupConvId,
    );
    expect(announcementRows).toHaveLength(1);
    const announcement = announcementRows[0]!;
    expect(announcement.direction).toBe('outbound');
    expect(announcement.author).toBe('system');
    expect(announcement.relay_sender_key).toBe('system');
    expect(announcement.body).toBe(rungBody('day_before', scheduledAt));
    expect(Object.keys(announcement.delivery_recipients ?? {})).toHaveLength(2);
    // Nothing through the 1:1 send service.
    expect(rig.world.sent).toHaveLength(0);

    // Claim stamped — a second tick sends nothing more (exactly once per member).
    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.kind === 'day_before')?.sentAt).toBeDefined();
    // The GROUP path's sentBody snapshot, pinned to the composed body (not just
    // defined). All three claimSend call sites pass the body; only the 1:1 poll
    // path had a regression pin, so a refactor of THIS path could drop the
    // argument with every test green and the dashboard would silently lose
    // "what was actually sent" for group-routed rungs.
    // See docs/issues/reminder-sentbody-group-and-forcesend-untested.md.
    expect(rows.find((r) => r.kind === 'day_before')?.sentBody).toBe(
      rungBody('day_before', scheduledAt),
    );
    await runDueTourReminders(now0, rig.deps);
    expect(rig.groupSends).toHaveLength(2);
  });

  it('group sends draw one token per member from the shared A2P bucket when provided', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T10:00:00.000Z';
    const scheduledAt = '2026-08-03T18:00:00.000Z';
    seedTenant(rig.world, 'contact-bucket-1', '+15550500011', 'conv-1to1-bucket-1', now0);
    seedRelayGroup(rig.world, {
      convId: 'conv-group-bucket-1',
      poolNumber: '+15550190009',
      participants: [
        { contactId: 'contact-bucket-1', phone: '+15550500011', name: 'Tina Tenant' },
        { contactId: 'contact-bucket-2', phone: '+15550500012', name: 'Larry Landlord' },
      ],
      now: now0,
    });
    const tour = await tours.create({
      tenantId: 'contact-bucket-1',
      unitId: 'unit-bucket-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: 'conv-group-bucket-1' });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    // Counting bucket: every adapter send must be preceded by one acquire(1) —
    // the same combined A2P rate metering the relay fan-out/intro loops use.
    let acquired = 0;
    const bucket = {
      acquire: async (n: number) => {
        acquired += n;
      },
    };
    await runDueTourReminders(now0, { ...rig.deps, tokenBucket: bucket });

    expect(rig.groupSends).toHaveLength(2);
    expect(acquired).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 10 — pm_team + open group: same group routing
  // ---------------------------------------------------------------------------
  it('pm_team tour with an open group routes reminders to the group', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T11:00:00.000Z';
    const scheduledAt = '2026-08-03T19:00:00.000Z';
    const tenantPhone = '+15550510001';
    const pmPhone = '+15550510002';
    const poolNumber = '+15550190002';
    const groupConvId = 'conv-group-pm-1';

    seedTenant(rig.world, 'contact-group-pm-1', tenantPhone, 'conv-1to1-pm-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-group-pm-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-group-pm-2', phone: pmPhone, name: 'Pat PM' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-group-pm-1',
      unitId: 'unit-group-pm-1',
      scheduledAt,
      tourType: 'pm_team',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.every((s) => s.from === poolNumber)).toBe(true);
    expect(rig.world.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 11 — self_guided stays 1:1 EVEN IF a group thread exists (founder rule)
  // ---------------------------------------------------------------------------
  it('self_guided tour with a group thread set still sends the reminder to the tenant 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T12:00:00.000Z';
    const scheduledAt = '2026-08-03T20:00:00.000Z';
    const tenantPhone = '+15550520001';
    const poolNumber = '+15550190003';
    const groupConvId = 'conv-group-sg-1';

    seedTenant(rig.world, 'contact-group-sg-1', tenantPhone, 'conv-1to1-sg-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-group-sg-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-group-sg-2', phone: '+15550520002', name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-group-sg-1',
      unitId: 'unit-group-sg-1',
      scheduledAt,
      tourType: 'self_guided',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    // 1:1 route: sent via sendMessageService (world adapter), NOT the group spy.
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
    expect(rig.world.sent[0]!.body).toContain(rungBody('day_before', scheduledAt));
  });

  // ---------------------------------------------------------------------------
  // Test 12 — landlord_led with NO groupThreadId: 1:1 fallback
  // ---------------------------------------------------------------------------
  it('landlord_led tour with no groupThreadId falls back to the tenant 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T13:00:00.000Z';
    const scheduledAt = '2026-08-03T21:00:00.000Z';
    const tenantPhone = '+15550530001';

    seedTenant(rig.world, 'contact-nogroup-1', tenantPhone, 'conv-1to1-ng-1', now0);

    const tour = await tours.create({
      tenantId: 'contact-nogroup-1',
      unitId: 'unit-nogroup-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 13 - groupThreadId -> missing conversation: routing falls back to 1:1,
  // but D11 holds the rung (the roster is UNREADABLE, not "tenant removed")
  // ---------------------------------------------------------------------------
  it('landlord_led tour whose groupThreadId points at a missing conversation falls back to 1:1 - and D11 holds the rung UNCLAIMED', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T14:00:00.000Z';
    const scheduledAt = '2026-08-03T22:00:00.000Z';
    const tenantPhone = '+15550540001';

    seedTenant(rig.world, 'contact-missingconv-1', tenantPhone, 'conv-1to1-mc-1', now0);

    const tour = await tours.create({
      tenantId: 'contact-missingconv-1',
      unitId: 'unit-missingconv-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: 'conv-does-not-exist' });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    // Routing still falls back (no group send) - but the SAME dangling pointer
    // makes the roster 'unavailable', and D11's rule is that an unreadable
    // roster is not an answer: neither text a possibly-removed tenant nor burn
    // the rung. The rung stays pending and the next tick retries it, so this is
    // a DEFERRAL, not a loss (contact-rosters, spec D1's cardinal rule).
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(0);
    const held = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.kind === 'day_before',
    );
    expect(held?.sentAt).toBeUndefined();
    expect(held?.skippedAt).toBeUndefined();

    // Repair the pointer and the very next tick delivers 1:1 as before.
    await tours.patch(tour.tourId, { groupThreadId: '' });
    await runDueTourReminders(now0, rig.deps);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 14 - groupThreadId -> a NON-relay_group conversation: routing falls
  // back to 1:1, and that thread's (absent) participants are the roster FACT
  // ---------------------------------------------------------------------------
  it('landlord_led tour whose groupThreadId points at a non-relay_group conversation falls back to 1:1 - and D11 skips it visibly', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T14:30:00.000Z';
    const scheduledAt = '2026-08-03T22:30:00.000Z';
    const tenantPhone = '+15550545001';

    seedTenant(rig.world, 'contact-wrongtype-1', tenantPhone, 'conv-1to1-wt-1', now0);

    const tour = await tours.create({
      tenantId: 'contact-wrongtype-1',
      unitId: 'unit-wrongtype-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    // Points at the tenant's own 1:1 thread — exists but is NOT a relay_group.
    await tours.patch(tour.tourId, { groupThreadId: 'conv-1to1-wt-1' });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    // Routing falls back (no group send). The pointer LOADS, so the roster is a
    // FACT - and that thread carries no participants at all, so the tenant is
    // not on it. Under D11 that is a visible skipped row, not a send: whether
    // the pointer is corrupt or the group was emptied, the poll will not text a
    // tenant it cannot show on any roster, and the row says why.
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(0);
    const skipped = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.kind === 'day_before',
    );
    expect(skipped?.sentAt).toBeUndefined();
    expect(skipped?.skipReason).toBe('tenant_not_on_roster');
  });

  // ---------------------------------------------------------------------------
  // Test 15 — CLOSED group: 1:1 fallback
  // ---------------------------------------------------------------------------
  it('landlord_led tour with a CLOSED group thread falls back to 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T15:00:00.000Z';
    const scheduledAt = '2026-08-03T23:00:00.000Z';
    const tenantPhone = '+15550550001';
    const poolNumber = '+15550190004';
    const groupConvId = 'conv-group-closed-1';

    seedTenant(rig.world, 'contact-closed-1', tenantPhone, 'conv-1to1-cl-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      status: 'closed',
      participants: [
        { contactId: 'contact-closed-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-closed-2', phone: '+15550550002', name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-closed-1',
      unitId: 'unit-closed-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 16 — suppressed (sms_opt_out) member skipped; others still receive
  // ---------------------------------------------------------------------------
  it('an sms_opt_out group member is skipped while the other members receive the reminder', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T16:00:00.000Z';
    const scheduledAt = '2026-08-04T18:00:00.000Z';
    const tenantPhone = '+15550560001';
    const landlordPhone = '+15550560002';
    const poolNumber = '+15550190005';
    const groupConvId = 'conv-group-sup-1';

    seedTenant(rig.world, 'contact-sup-tenant', tenantPhone, 'conv-1to1-sup-1', now0);
    // The landlord member's contact carries sms_opt_out (STOP'd) — suppressed.
    rig.world.contacts.push({
      contactId: 'contact-sup-landlord',
      type: 'landlord',
      phone: landlordPhone,
      sms_opt_out: true,
      created_at: now0,
    } as Parameters<typeof rig.world.contacts.push>[0]);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-sup-tenant', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-sup-landlord', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-sup-tenant',
      unitId: 'unit-sup-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    // Only the non-suppressed member receives; the STOP'd member is never texted.
    expect(rig.groupSends).toHaveLength(1);
    expect(rig.groupSends[0]!.to).toBe(tenantPhone);
    expect(rig.groupSends[0]!.from).toBe(poolNumber);
    expect(rig.world.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 17 — [concurrency] two racing ticks over a group reminder: once per member
  // ---------------------------------------------------------------------------
  it('two concurrent ticks over the same group reminder send exactly once per member', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T17:00:00.000Z';
    const scheduledAt = '2026-08-04T19:00:00.000Z';
    const tenantPhone = '+15550570001';
    const landlordPhone = '+15550570002';
    const poolNumber = '+15550190006';
    const groupConvId = 'conv-group-race-1';

    seedTenant(rig.world, 'contact-grouprace-1', tenantPhone, 'conv-1to1-gr-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-grouprace-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-grouprace-2', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-grouprace-1',
      unitId: 'unit-grouprace-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await Promise.all([
      runDueTourReminders(now0, rig.deps),
      runDueTourReminders(now0, rig.deps),
    ]);

    // Claim-before-send: each member texted exactly ONCE despite two ticks.
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
  });

  // ---------------------------------------------------------------------------
  // Test 18 — per-member send failure: other members still receive; claim stays stamped
  // ---------------------------------------------------------------------------
  it('a per-member adapter failure does not block other members and the claim stays stamped', async () => {
    const now0 = '2026-08-01T18:00:00.000Z';
    const scheduledAt = '2026-08-04T20:00:00.000Z';
    const tenantPhone = '+15550580001';
    const landlordPhone = '+15550580002';
    const poolNumber = '+15550190007';
    const groupConvId = 'conv-group-fail-1';

    // The FIRST member's send blows up; the second must still receive.
    const rig = createGroupTestRig({ failFor: [tenantPhone] });

    seedTenant(rig.world, 'contact-groupfail-1', tenantPhone, 'conv-1to1-gf-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-groupfail-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-groupfail-2', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-groupfail-1',
      unitId: 'unit-groupfail-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await createDueReminder(tourReminders, tour.tourId, 'day_before', now0);

    await runDueTourReminders(now0, rig.deps);

    // The surviving member got the reminder.
    expect(rig.groupSends).toHaveLength(1);
    expect(rig.groupSends[0]!.to).toBe(landlordPhone);
    // The claim is stamped (accepted tradeoff — same post-claim semantics as
    // the 1:1 path): a second tick does NOT retry the failed member.
    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.kind === 'day_before')?.sentAt).toBeDefined();
    await runDueTourReminders(now0, rig.deps);
    expect(rig.groupSends).toHaveLength(1);
    // Never through the 1:1 service either.
    expect(rig.world.sent).toHaveLength(0);
  });

  // ===========================================================================
  // SEND NOW - forceSendReminder (quiet-hours spec section 7)
  //
  // Human-triggered, so it BYPASSES quiet hours, manual mode and the
  // per-conversation breaker (the 1:1 send goes out with automated: false) but
  // still RESPECTS the absolute gates - kill switch, opt-out, JIT consent - and
  // every gate runs BEFORE the claim, so a refusal never leaves a row
  // claimed-but-unsent. Own February timeline + a fresh world per case.
  // ===========================================================================

  /** Records every sendMessageService input (the real service hides `automated`). */
  function makeForceSendSpy(opts: { throwErr?: Error } = {}): {
    service: SendMessageService;
    sent: SendMessageInput[];
  } {
    const sent: SendMessageInput[] = [];
    const service: SendMessageService = async (input) => {
      sent.push(input);
      if (opts.throwErr) throw opts.throwErr;
      return {
        conversationId: input.conversationId,
        providerSid: 'SM-force-fake',
        tsMsgId: 'ts-force-fake',
        status: 'queued',
      } as SendMessageOutcome;
    };
    return { service, sent };
  }

  /**
   * A tenant whose contact carries RECORDED CONSENT (consent_method). The force
   * path sends with automated: false, which IS subject to the JIT consent gate -
   * so a consent-less contact refuses. seedTenant above deliberately records no
   * consent (the poller's automated sends were never gated on it).
   */
  function seedForceTenant(
    world: ReturnType<typeof createFakeWorld>,
    opts: {
      contactId: string;
      phone: string;
      convId?: string;
      now: string;
      consent?: boolean;
      contactOptOut?: boolean;
      convOptOut?: boolean;
      /** Soft-delete stamp (contactsRepo isDeleted reads a non-empty deleted_at). */
      deletedAt?: string;
    },
  ): void {
    world.contacts.push({
      contactId: opts.contactId,
      type: 'tenant',
      phone: opts.phone,
      created_at: opts.now,
      ...(opts.consent !== false && { consent_method: 'inbound_text' }),
      ...(opts.contactOptOut === true && { sms_opt_out: true }),
      ...(opts.deletedAt !== undefined && { deleted_at: opts.deletedAt }),
    } as Parameters<typeof world.contacts.push>[0]);
    if (opts.convId === undefined) return;
    world.conversations.set(opts.convId, {
      conversationId: opts.convId,
      participant_phone: opts.phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: opts.now,
      created_at: opts.now,
      ...(opts.convOptOut === true && { sms_opt_out: true }),
    });
  }

  /** A pending self_guided rung on the February timeline. */
  async function seedForceTour(opts: {
    tenantId: string;
    unitId: string;
    kind: 'confirmation' | 'day_before' | 'morning_of' | 'en_route';
    tourType?: 'self_guided' | 'landlord_led' | 'pm_team';
  }) {
    const tour = await tours.create({
      tenantId: opts.tenantId,
      unitId: opts.unitId,
      scheduledAt: '2026-02-11T20:00:00.000Z',
      tourType: opts.tourType ?? 'self_guided',
    });
    const row = await tourReminders.create({
      tourId: tour.tourId,
      kind: opts.kind,
      dueAt: '2026-02-11T13:00:00.000Z',
    });
    return { tour, row };
  }

  /** Deep inside the DEFAULT window: Feb 10 04:00 EST (America/New_York). */
  const FORCE_NOW = '2026-02-10T09:00:00.000Z';
  const SEEDED_AT = '2026-02-09T15:00:00.000Z';

  // ---------------------------------------------------------------------------
  // Send now 1 - the headline case: it goes out NOW, mid-quiet-hours
  // ---------------------------------------------------------------------------
  it('force-sends a pending rung DURING quiet hours with automated: false and stamps sentAt', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));
    const deps = {
      ...rig.deps,
      sendMessageService: spy.service,
      settingsRepo: stubSettingsRepo(), // quiet hours ON - the force path ignores them
      events,
    };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-1',
      phone: '+15550220001',
      convId: 'conv-force-1',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-1',
      unitId: 'unit-force-1',
      kind: 'day_before',
    });

    // Sanity: at this same instant the POLLER defers (backstop) - so a send
    // here can only come from the human path.
    await runDueTourReminders(FORCE_NOW, deps);
    expect(spy.sent).toHaveLength(0);

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'sent' });
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]!.conversationId).toBe('conv-force-1');
    expect(spy.sent[0]!.body).toBe(rungBody('day_before', '2026-02-11T20:00:00.000Z'));
    expect(spy.sent[0]!.author).toBe('teammate');
    // automated: false - a human send bypasses manual mode + the breaker.
    expect(spy.sent[0]!.automated).toBe(false);

    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBe(FORCE_NOW);
    // The FORCE-SEND path's sentBody snapshot, pinned to the composed body -
    // the third claimSend call site, previously covered only by a one-time
    // human read during the 2026-08-06 roster merge.
    // See docs/issues/reminder-sentbody-group-and-forcesend-untested.md.
    expect(after?.sentBody).toBe(rungBody('day_before', '2026-02-11T20:00:00.000Z'));
    // The claim told the live surfaces to refetch (advisory tenant contactId).
    expect(emitted.filter((p) => p.contactId === 'contact-force-1')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Send now 2 - the row is already terminal: report honestly, send nothing
  // ---------------------------------------------------------------------------
  it('force-send returns not_pending for an already-sent rung and sends nothing', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-2',
      phone: '+15550220002',
      convId: 'conv-force-2',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-2',
      unitId: 'unit-force-2',
      kind: 'day_before',
    });
    await tourReminders.claimSend(row.reminderId, '2026-02-10T08:00:00.000Z');

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'not_pending' });
    expect(spy.sent).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 3 - the poll wins the claim race: exactly one send ever happens
  // ---------------------------------------------------------------------------
  it('force-send returns not_pending when the claim is LOST, and sends nothing', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    // The row is pending when we read it, but the poll claims it first.
    const lostClaimRepo = { ...tourReminders, claimSend: async () => false };
    const deps = {
      ...rig.deps,
      tourRemindersRepo: lostClaimRepo,
      sendMessageService: spy.service,
      settingsRepo: stubSettingsRepo(),
    };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-3',
      phone: '+15550220003',
      convId: 'conv-force-3',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-3',
      unitId: 'unit-force-3',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'not_pending' });
    expect(spy.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 4 - kill switch: refuse BEFORE the claim (the row stays pending)
  // ---------------------------------------------------------------------------
  it('force-send refuses sms_sending_disabled WITHOUT claiming (row stays pending)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-4',
      phone: '+15550220004',
      convId: 'conv-force-4',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-4',
      unitId: 'unit-force-4',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, false, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'sms_sending_disabled' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
    expect(after?.canceledAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Send now 5 - opt-out is absolute, even for a human send
  // ---------------------------------------------------------------------------
  it('force-send refuses contact_opted_out WITHOUT claiming', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-5',
      phone: '+15550220005',
      convId: 'conv-force-5',
      now: SEEDED_AT,
      contactOptOut: true,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-5',
      unitId: 'unit-force-5',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'contact_opted_out' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
  });

  // group-texting A8, consumer 2 of 6 (tourReminders.ts). A silent group member
  // carries group_participation_at and no consent_method - still no_consent.
  it('force-send refuses a SILENT GROUP MEMBER (group_participation_at is not consent)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-group',
      phone: '+15550220016',
      convId: 'conv-force-group',
      now: SEEDED_AT,
      consent: false,
    });
    const member = rig.world.contacts.find((c) => c.contactId === 'contact-force-group')!;
    member.group_participation_at = '2026-08-10T12:00:00.000Z';
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-group',
      unitId: 'unit-force-group',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'no_consent' });
    expect(spy.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 6 - JIT consent: automated: false makes the consent gate apply
  // ---------------------------------------------------------------------------
  it('force-send refuses no_consent WITHOUT claiming', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-6',
      phone: '+15550220006',
      convId: 'conv-force-6',
      now: SEEDED_AT,
      consent: false,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-6',
      unitId: 'unit-force-6',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'no_consent' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Send now 6b - a SOFT-DELETED contact refuses PRE-claim. sendMessage refuses
  // any 1:1 to a deleted contact (ContactDeletedError), so without this gate the
  // click would claim the row (the claim IS the sentAt stamp) and only then
  // throw - burning the rung for a state we can check up front.
  // ---------------------------------------------------------------------------
  it('force-send refuses contact_deleted WITHOUT claiming (the rung stays pending)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-6b',
      phone: '+15550220016',
      convId: 'conv-force-6b',
      now: SEEDED_AT,
      deletedAt: '2026-02-09T18:00:00.000Z',
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-6b',
      unitId: 'unit-force-6b',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'contact_deleted' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    // The row is UNTOUCHED: restoring the contact must still leave it deliverable.
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
    expect(after?.canceledAt).toBeUndefined();
    expect((await tourReminders.listDue('2026-02-11T13:01:00.000Z')).map((r) => r.reminderId)).toContain(
      row.reminderId,
    );
  });

  // ---------------------------------------------------------------------------
  // Send now 7 - an unresolvable target REFUSES; it must NOT claim-skip the rung
  // (the poller still gets its chance at dueAt)
  // ---------------------------------------------------------------------------
  it('force-send refuses no_conversation WITHOUT claim-skipping (the rung survives for the poller)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    // Contact + phone, but NO conversation anywhere in this world.
    seedForceTenant(rig.world, {
      contactId: 'contact-force-7',
      phone: '+15550220007',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-7',
      unitId: 'unit-force-7',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'no_conversation' });
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.skippedAt).toBeUndefined();
    expect(after?.skipReason).toBeUndefined();
    expect(after?.sentAt).toBeUndefined();
    // Still live for the poll at its own dueAt.
    expect((await tourReminders.listDue('2026-02-11T13:01:00.000Z')).map((r) => r.reminderId)).toContain(
      row.reminderId,
    );
  });

  // ---------------------------------------------------------------------------
  // Send now 8 - an unknown rung id refuses (never a 500)
  // ---------------------------------------------------------------------------
  it('force-send refuses tour_missing for a reminderId that is not on the tour', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    const { tour } = await seedForceTour({
      tenantId: 'contact-force-8',
      unitId: 'unit-force-8',
      kind: 'day_before',
    });

    const result = await forceSendReminder('reminder-does-not-exist', tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'tour_missing' });
    expect(spy.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 9 - a GROUP-routed tour force-sends through the SAME relay
  // announcement chain the poll uses (never the 1:1 service)
  // ---------------------------------------------------------------------------
  it('force-sends a GROUP-routed rung through the relay announcement path', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    const tenantPhone = '+15550220009';
    const landlordPhone = '+15550220019';
    const poolNumber = '+15550190029';
    const groupConvId = 'conv-group-force-9';

    seedForceTenant(rig.world, {
      contactId: 'contact-force-9',
      phone: tenantPhone,
      convId: 'conv-1to1-force-9',
      now: SEEDED_AT,
    });
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-force-9', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-force-9b', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: SEEDED_AT,
    });

    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-9',
      unitId: 'unit-force-9',
      kind: 'day_before',
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'sent' });
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
    // Never the 1:1 service.
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBe(FORCE_NOW);
  });

  // ---------------------------------------------------------------------------
  // Send now 10 - the narrow post-claim race (an opt-out landing between the
  // pre-check and the provider send): the claim is KEPT (poller parity) but the
  // outcome is reported honestly so the UI can show a real error.
  // ---------------------------------------------------------------------------
  it('a post-claim SendRefusedError returns refused_post_claim, keeps the claim, and sends nothing', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy({
      throwErr: new SendRefusedError('opted out mid-flight', 'contact_opted_out'),
    });
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-10',
      phone: '+15550220010',
      convId: 'conv-force-10',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-10',
      unitId: 'unit-force-10',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused_post_claim', reason: 'contact_opted_out' });
    // The claim IS the sentAt stamp - the row is consumed (poller parity).
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBe(FORCE_NOW);
    // ZERO provider sends on either route.
    expect(rig.world.sent).toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    // A warn line records the refusal (ids + code only, never PII).
    const warns = logCapture.atLevel(40).filter((l) => l['reminderId'] === row.reminderId);
    expect(warns).toHaveLength(1);
    expect(warns[0]!['refusal']).toBe('contact_opted_out');
  });

  // ===========================================================================
  // D11 (contact-rosters) - a tenant OFF the roster is never texted 1:1
  // ===========================================================================
  //
  // The check binds to the ROUTING OUTCOME at claim time, not the rung kind: a
  // self_guided rung and a group-routed rung that FALLS BACK to the tenant 1:1
  // are suppressed by the same rule, with a VISIBLE skipped row. Group sends
  // that actually reach the group are untouched. Re-adding the tenant lifts the
  // suppression for unclaimed rungs with no re-arm step.
  //
  // Clocks are PINNED (injected `now`), never wall-clock.

  /** now/scheduled pair used by this section: the ladder is ARMED at NOW_D11 and
   *  ridden at TICK_D11 below, one second past the EARLIEST live rung's dueAt. */
  const NOW_D11 = '2026-08-05T10:00:00.000Z';
  const SCHEDULED_D11 = '2026-08-07T18:00:00.000Z';
  /** day_before = 19:30 org-local (EDT) on Aug 6, the day before the tour's
   *  local date, with quiet hours off (no clamping). */
  const DAY_BEFORE_D11 = '2026-08-06T23:30:00.000Z';
  /** THE TICK EVERY CASE BELOW DRIVES: one second past day_before's dueAt.
   *  day_before is the EARLIEST rung of the live ladder, so a tick here releases
   *  it and nothing later, and it is still well before SCHEDULED_D11, so the
   *  past-tour gate (6.1a) is a no-op. Derived, not re-typed: the "+1s" is the
   *  whole point and a hand-written twin could drift off the rung it names. */
  const TICK_D11 = new Date(Date.parse(DAY_BEFORE_D11) + 1_000).toISOString();
  /** The NEXT rung after day_before: scheduledAt - 4h, unclamped (quiet OFF). */
  const MORNING_OF_D11 = '2026-08-07T14:00:00.000Z';

  async function armD11Tour(opts: {
    tourId?: string;
    tenantId: string;
    unitId: string;
    tourType?: 'self_guided' | 'landlord_led' | 'pm_team';
    groupThreadId?: string;
  }) {
    const tour = await tours.create({
      tenantId: opts.tenantId,
      unitId: opts.unitId,
      scheduledAt: SCHEDULED_D11,
      tourType: opts.tourType ?? 'self_guided',
    });
    if (opts.groupThreadId !== undefined) {
      await tours.patch(tour.tourId, { groupThreadId: opts.groupThreadId });
    }
    await armTourReminders(tour, NOW_D11, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    return tour;
  }

  const rungOf = async (tourId: string, kind: string) =>
    (await tourReminders.listByTour(tourId)).find((r) => r.kind === kind);

  it('self_guided: a tenant absent from the roster plan is claim-SKIPPED as tenant_not_on_roster', async () => {
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d11-a', '+15550800001', 'conv-d11-a', NOW_D11);
    const tour = await armD11Tour({ tenantId: 'contact-d11-a', unitId: 'unit-d11-a' });
    // The caseworker-to-PM arrangement: the operator removed the tenant.
    await tours.setRoster(
      tour.tourId,
      [{ contactId: 'c-caseworker-d11' }, { contactId: 'c-pm-d11' }],
      undefined,
    );

    await runDueTourReminders(TICK_D11, rig.deps);

    expect(rig.world.sent).toHaveLength(0);
    const dayBefore = await rungOf(tour.tourId, 'day_before');
    expect(dayBefore?.sentAt).toBeUndefined();
    expect(dayBefore?.skippedAt).toBe(TICK_D11);
    expect(dayBefore?.skipReason).toBe('tenant_not_on_roster');
  });

  it('THE FALLBACK DOOR: a landlord_led rung with NO usable group is suppressed too', async () => {
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d11-b', '+15550800002', 'conv-d11-b', NOW_D11);
    // landlord_led with no group thread at all - routing falls back to the
    // tenant 1:1, which is exactly the door D11 has to close.
    const tour = await armD11Tour({
      tenantId: 'contact-d11-b',
      unitId: 'unit-d11-b',
      tourType: 'landlord_led',
    });
    await tours.setRoster(tour.tourId, [{ contactId: 'c-pm-d11' }], undefined);

    await runDueTourReminders(TICK_D11, rig.deps);

    expect(rig.world.sent).toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    const dayBefore = await rungOf(tour.tourId, 'day_before');
    expect(dayBefore?.skipReason).toBe('tenant_not_on_roster');
  });

  it('a landlord_led rung that REACHES its group still sends, tenant on the roster or not', async () => {
    const rig = createGroupTestRig();
    const poolNumber = '+15550190211';
    seedTenant(rig.world, 'contact-d11-c', '+15550800003', 'conv-d11-c', NOW_D11);
    // The live thread does NOT carry the tenant (they were removed from it),
    // but the group route is unaffected: the group is who it texts.
    seedRelayGroup(rig.world, {
      convId: 'conv-d11-group-c',
      poolNumber,
      participants: [
        { contactId: 'c-caseworker-d11', phone: '+15550800013', name: 'Casey Worker' },
        { contactId: 'c-pm-d11', phone: '+15550800014', name: 'Pat Manager' },
      ],
      now: NOW_D11,
    });
    const tour = await armD11Tour({
      tenantId: 'contact-d11-c',
      unitId: 'unit-d11-c',
      tourType: 'landlord_led',
      groupThreadId: 'conv-d11-group-c',
    });

    await runDueTourReminders(TICK_D11, rig.deps);

    expect(rig.groupSends).toHaveLength(2);
    expect(rig.world.sent).toHaveLength(0); // nothing 1:1
    const dayBefore = await rungOf(tour.tourId, 'day_before');
    expect(dayBefore?.sentAt).toBe(TICK_D11);
    expect(dayBefore?.skippedAt).toBeUndefined();
  });

  it('re-adding the tenant lifts the suppression for the NEXT rung - no re-arm step', async () => {
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d11-d', '+15550800004', 'conv-d11-d', NOW_D11);
    const tour = await armD11Tour({ tenantId: 'contact-d11-d', unitId: 'unit-d11-d' });
    const first = await tours.setRoster(tour.tourId, [{ contactId: 'c-pm-d11' }], undefined);

    await runDueTourReminders(TICK_D11, rig.deps);
    expect((await rungOf(tour.tourId, 'day_before'))?.skipReason).toBe('tenant_not_on_roster');

    // The operator puts the tenant back (optimistic-concurrency write).
    await tours.setRoster(
      tour.tourId,
      [{ contactId: 'contact-d11-d' }, { contactId: 'c-pm-d11' }],
      first.rosterVersion,
    );

    // The very next due rung goes out - the check runs at CLAIM time, so
    // nothing had to be re-armed.
    await runDueTourReminders(MORNING_OF_D11, rig.deps);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe('+15550800004');
    const morningOf = await rungOf(tour.tourId, 'morning_of');
    expect(morningOf?.sentAt).toBe(MORNING_OF_D11);
  });

  it("an UNREADABLE roster leaves the rung UNCLAIMED - neither sent nor skipped", async () => {
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d11-e', '+15550800005', 'conv-d11-e', NOW_D11);
    // A thread pointer that does not load: the roster is 'unavailable', which is
    // NOT "the tenant was removed". Texting a possibly-removed tenant on a
    // Dynamo blip - or burning the rung with a false skip - are both wrong.
    const tour = await armD11Tour({
      tenantId: 'contact-d11-e',
      unitId: 'unit-d11-e',
      groupThreadId: 'conv-d11-vanished',
    });

    await runDueTourReminders(TICK_D11, rig.deps);

    expect(rig.world.sent).toHaveLength(0);
    const before = await rungOf(tour.tourId, 'day_before');
    expect(before?.sentAt).toBeUndefined();
    expect(before?.skippedAt).toBeUndefined();

    // The thread comes back; the very next tick delivers it.
    seedRelayGroup(rig.world, {
      convId: 'conv-d11-vanished',
      poolNumber: '+15550190212',
      participants: [
        { contactId: 'contact-d11-e', phone: '+15550800005', name: 'Tina Tenant' },
        { contactId: 'c-pm-d11', phone: '+15550800014', name: 'Pat Manager' },
      ],
      now: NOW_D11,
    });
    await runDueTourReminders(TICK_D11, rig.deps);
    expect(rig.world.sent).toHaveLength(1);
    expect((await rungOf(tour.tourId, 'day_before'))?.sentAt).toBe(TICK_D11);
  });

  it('an UNREADABLE roster is BOUNDED by time-past-due: unclaimed inside the grace, claim-skipped past it', async () => {
    // The unclaimed wait above is right for a BLIP. A permanent sentinel (a
    // pointer at a conversation that will never load) used to re-list the rung
    // every tick forever: never sent, never visibly skipped.
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d11-f', '+15550800006', 'conv-d11-f', NOW_D11);
    const tour = await armD11Tour({
      tenantId: 'contact-d11-f',
      unitId: 'unit-d11-f',
      groupThreadId: 'conv-d11-never-loads',
    });
    const dueAt = (await rungOf(tour.tourId, 'day_before'))!.dueAt;

    // One minute SHORT of the grace window - still a blip, still unclaimed.
    // Both clocks below stay inside the tour's own day (dueAt + 1h at most),
    // so the past-tour gate never pre-empts the wait this case is about.
    const withinGrace = new Date(
      Date.parse(dueAt) + ROSTER_UNAVAILABLE_GRACE_MS - 60_000,
    ).toISOString();
    await runDueTourReminders(withinGrace, rig.deps);
    const waiting = await rungOf(tour.tourId, 'day_before');
    expect(waiting?.sentAt).toBeUndefined();
    expect(waiting?.skippedAt, 'inside the grace it re-lists next tick').toBeUndefined();
    expect(
      (await tourReminders.listDue(withinGrace)).some((r) => r.reminderId === waiting?.reminderId),
      'still due - the wait is a wait, not a retirement',
    ).toBe(true);

    // One minute PAST it - retire it VISIBLY rather than wait forever.
    const pastGrace = new Date(
      Date.parse(dueAt) + ROSTER_UNAVAILABLE_GRACE_MS + 60_000,
    ).toISOString();
    await runDueTourReminders(pastGrace, rig.deps);
    const retired = await rungOf(tour.tourId, 'day_before');
    expect(retired?.sentAt, 'a skip is never a send').toBeUndefined();
    expect(retired?.skippedAt).toBe(pastGrace);
    expect(retired?.skipReason).toBe('roster_unavailable');
    expect(rig.world.sent).toHaveLength(0);

    // Terminal: it leaves listDue exactly once.
    expect(
      (await tourReminders.listDue(pastGrace)).some((r) => r.reminderId === retired?.reminderId),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // D7 (contact-rosters Task 13): a group-eligible rung WAITS for a deferred open
  // -------------------------------------------------------------------------

  /** A pendingRosterActions stub carrying exactly one row, keyed by actionId. */
  function pendingOpenFor(tourId: string, status: 'pending' | 'applied' = 'pending') {
    const actionId = `tour#${tourId}#open`;
    return {
      async getById(id: string) {
        return id === actionId
          ? ({
              actionId,
              ownerKey: `tour#${tourId}`,
              ownerType: 'tour' as const,
              ownerId: tourId,
              action: 'open_group' as const,
              dueAt: '2026-08-05T12:00:00.000Z',
              _actionPartition: 'roster_actions' as const,
              reason: 'quiet_hours' as const,
              status,
              createdAt: '2026-08-05T03:00:00.000Z',
            })
          : undefined;
      },
    };
  }

  it('a group-eligible rung whose tour has a PENDING open WAITS: unclaimed, not 1:1-sent', async () => {
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d7-a', '+15550800011', 'conv-d7-a', NOW_D11);
    // landlord_led with NO group thread yet - today that falls back to the
    // tenant 1:1, which is exactly what the deferred open makes premature.
    const tour = await armD11Tour({
      tenantId: 'contact-d7-a',
      unitId: 'unit-d7-a',
      tourType: 'landlord_led',
    });

    await runDueTourReminders(TICK_D11, {
      ...rig.deps,
      pendingRosterActionsRepo: pendingOpenFor(tour.tourId),
    });

    expect(rig.world.sent).toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    const dayBefore = await rungOf(tour.tourId, 'day_before');
    expect(dayBefore?.sentAt, 'unclaimed - it re-lists next tick').toBeUndefined();
    expect(dayBefore?.skippedAt).toBeUndefined();
  });

  it('AT/AFTER tour start the wait is MOOT: the past-tour gate retires the rung first', async () => {
    // WAS "the wait ENDS: the rung proceeds through the usual fallback" - it
    // asserted the 1:1 fallback FIRES at the tour's own start instant. Phase B
    // 6.1a inverts that deliberately (this is the gate working, not a
    // regression): every rung that can reach the D7 wait has a dueAt BEFORE the
    // tour, so at/after the start its copy is stale and it must not go out.
    // The `beforeStart` disjunct is kept as defence-in-depth; what changed is
    // that nothing pre-tour can reach it any more.
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d7-b', '+15550800012', 'conv-d7-b', NOW_D11);
    const tour = await armD11Tour({
      tenantId: 'contact-d7-b',
      unitId: 'unit-d7-b',
      tourType: 'landlord_led',
    });

    // now == the tour's own start instant.
    await runDueTourReminders(SCHEDULED_D11, {
      ...rig.deps,
      pendingRosterActionsRepo: pendingOpenFor(tour.tourId),
    });

    expect(rig.world.sent, 'a rung whose copy assumes the tour has not happened').toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    const enRoute = await rungOf(tour.tourId, 'en_route');
    expect(enRoute?.sentAt).toBeUndefined();
    expect(enRoute?.skippedAt).toBe(SCHEDULED_D11);
    expect(enRoute?.skipReason).toBe('tour_already_passed');
  });

  it('a RESOLVED open imposes no wait at all', async () => {
    const rig = createGroupTestRig();
    seedTenant(rig.world, 'contact-d7-c', '+15550800013', 'conv-d7-c', NOW_D11);
    const tour = await armD11Tour({
      tenantId: 'contact-d7-c',
      unitId: 'unit-d7-c',
      tourType: 'landlord_led',
    });

    await runDueTourReminders(TICK_D11, {
      ...rig.deps,
      pendingRosterActionsRepo: pendingOpenFor(tour.tourId, 'applied'),
    });

    expect(rig.world.sent.length).toBeGreaterThan(0);
  });

  it('force-send REFUSES a rung targeting an off-roster tenant and leaves the row pending', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-d11-f',
      phone: '+15550800006',
      convId: 'conv-d11-f',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-d11-f',
      unitId: 'unit-d11-f',
      kind: 'day_before',
    });
    await tours.setRoster(tour.tourId, [{ contactId: 'c-pm-d11' }], undefined);

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    // A human failure must never RETIRE a rung: refuse pre-claim, row untouched.
    expect(result).toEqual({ outcome: 'refused', reason: 'tenant_not_on_roster' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
  });

  // ===========================================================================
  // Phase B 6.1a - THE FIRE-TIME PAST-TOUR GATE
  // ===========================================================================
  //
  // Arm time has `past_event`; until Phase B fire time had no equivalent, and
  // quiet hours was only accidentally capping the damage (an overnight backlog
  // deferred to 08:00). These cases pin the gate's PLACEMENT as much as its
  // behaviour: position is the behaviour here. Above supersededInBatch, or a
  // post-tour catch-up batch puts "superseded by a later reminder" on the panel
  // beside the very rung it names reading "the tour had already happened".
  // Above the quiet-hours backstop, or a past-tour rung due inside the window
  // re-lists unclaimed every tick until quiet-end instead of retiring once.
  //
  // Clocks are PINNED (injected `now`), never wall-clock.
  describe('past-tour gate (spec 6.1a)', () => {
    /** The tour happened; every clock below is relative to it. */
    const PAST_TOUR_START = '2026-09-10T18:00:00.000Z';
    /** When the ladder was armed - two days AHEAD of the tour, as normal. */
    const PAST_ARMED_AT = '2026-09-08T10:00:00.000Z';
    /** One hour after the tour started: the worker is back from an outage. */
    const PAST_TOUR_NOW = '2026-09-10T19:00:00.000Z';
    /** The two pre-tour dueAts armTourReminders would have written. */
    const MORNING_OF_DUE = '2026-09-10T14:00:00.000Z';
    const EN_ROUTE_DUE = '2026-09-10T17:00:00.000Z';

    async function pastTour(tenantId: string, unitId: string) {
      return tours.create({
        tenantId,
        unitId,
        scheduledAt: PAST_TOUR_START,
        tourType: 'self_guided',
      });
    }

    it('a pre-tour rung due after the tour started is claim-skipped tour_already_passed on the FIRST tick', async () => {
      const rig = createGroupTestRig();
      seedTenant(rig.world, 'contact-past-a', '+15550900001', 'conv-past-a', PAST_ARMED_AT);
      const tour = await pastTour('contact-past-a', 'unit-past-a');
      // A NORMAL ladder, armed ahead of the tour the ordinary way - the rows
      // this gate exists for are not exotic, they are last week's backlog.
      await armTourReminders(tour, PAST_ARMED_AT, {
        tourRemindersRepo: tourReminders,
        settingsRepo: quietOff,
        logger,
      });

      await runDueTourReminders(PAST_TOUR_NOW, rig.deps);

      const enRoute = await rungOf(tour.tourId, 'en_route');
      expect(enRoute?.sentAt).toBeUndefined();
      expect(enRoute?.skippedAt).toBe(PAST_TOUR_NOW);
      expect(enRoute?.skipReason).toBe('tour_already_passed');
      expect(rig.world.sent).toHaveLength(0);

      // Retired ONCE: the claim-skip took the row out of listDue, so a second
      // tick neither sends nor re-stamps (the perpetual-re-skip bug the
      // claim-skip idiom exists to prevent).
      await runDueTourReminders('2026-09-10T20:00:00.000Z', rig.deps);
      expect((await rungOf(tour.tourId, 'en_route'))?.skippedAt).toBe(PAST_TOUR_NOW);
      expect(rig.world.sent).toHaveLength(0);
    });

    it('outranks supersededInBatch: a post-tour catch-up batch gives BOTH rungs tour_already_passed', async () => {
      const rig = createGroupTestRig();
      seedTenant(rig.world, 'contact-past-b', '+15550900002', 'conv-past-b', PAST_ARMED_AT);
      const tour = await pastTour('contact-past-b', 'unit-past-b');
      // Both rungs pending and due in ONE listDue snapshot - the worker-downtime
      // shape. Created directly so the case does not depend on arm-time timing.
      await tourReminders.create({
        tourId: tour.tourId,
        kind: 'morning_of',
        dueAt: MORNING_OF_DUE,
      });
      await tourReminders.create({ tourId: tour.tourId, kind: 'en_route', dueAt: EN_ROUTE_DUE });

      await runDueTourReminders(PAST_TOUR_NOW, rig.deps);

      const rows = await tourReminders.listByTour(tour.tourId);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.skipReason, `${r.kind} takes the per-tour reason`).toBe('tour_already_passed');
      }
      // The ledger-item-8 chip shape must not appear: "superseded by a later
      // reminder" beside a rung that reads "the tour had already happened".
      expect(rows.map((r) => r.skipReason)).not.toContain('quiet_hours_superseded');
      expect(rig.world.sent).toHaveLength(0);
    });

    it('outranks the quiet-hours backstop: a past-tour rung due inside the window retires instead of re-listing', async () => {
      const rig = createGroupTestRig();
      // Quiet hours ON (21:00-08:00 America/New_York). Without the gate above
      // it, this tick returns UNCLAIMED and the row re-lists every tick until
      // quiet-end - then fires stale.
      const deps = { ...rig.deps, settingsRepo: stubSettingsRepo() };
      seedTenant(rig.world, 'contact-past-c', '+15550900003', 'conv-past-c', PAST_ARMED_AT);
      const tour = await pastTour('contact-past-c', 'unit-past-c');
      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'morning_of',
        dueAt: MORNING_OF_DUE,
      });
      /** 01:00 EDT the night after the tour - deep inside the default window. */
      const QUIET_NOW = '2026-09-11T05:00:00.000Z';

      await runDueTourReminders(QUIET_NOW, deps);

      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.skippedAt).toBe(QUIET_NOW);
      expect(after?.skipReason).toBe('tour_already_passed');
      expect(rig.world.sent).toHaveLength(0);
    });

    it('the hoisted tour read is deliberate: superseded-in-batch AND tour-missing now reads tour_missing', async () => {
      const rig = createGroupTestRig();
      // No tours row at all for this id.
      const tourId = `tour-gone-${randomUUID().slice(0, 8)}`;
      const earlier = await tourReminders.create({
        tourId,
        kind: 'morning_of',
        dueAt: MORNING_OF_DUE,
      });
      await tourReminders.create({ tourId, kind: 'en_route', dueAt: EN_ROUTE_DUE });

      await runDueTourReminders(PAST_TOUR_NOW, rig.deps);

      // ACCEPTED CONSEQUENCE of hoisting the tour read above supersededInBatch:
      // before Phase B the earlier rung read 'quiet_hours_superseded' (it never
      // reached the tour read at all). 'tour_missing' is the truer answer for
      // both rows - a rung whose tour no longer exists was not superseded.
      const rows = await tourReminders.listByTour(tourId);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.skipReason, `${r.kind} reports the tour read, not supersession`).toBe(
          'tour_missing',
        );
      }
      expect(rows.find((r) => r.reminderId === earlier.reminderId)?.skippedAt).toBe(PAST_TOUR_NOW);
      expect(rig.world.sent).toHaveLength(0);
    });

    it('no_show_checkin survives the gate: force-send AFTER the tour still sends', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
      seedForceTenant(rig.world, {
        contactId: 'contact-past-d',
        phone: '+15550900004',
        convId: 'conv-past-d',
        now: PAST_ARMED_AT,
      });
      const tour = await pastTour('contact-past-d', 'unit-past-d');
      // dueAt = scheduledAt + 30m. This is the ONE rung whose copy assumes the
      // tour HAS happened, and the predicate exempts it BY CONSTRUCTION rather
      // than by a name in a list - the exception a later reader would delete.
      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'no_show_checkin',
        dueAt: '2026-09-10T18:30:00.000Z',
      });

      const result = await forceSendReminder(row.reminderId, tour.tourId, PAST_TOUR_NOW, true, deps);

      expect(result).toEqual({ outcome: 'sent' });
      expect(spy.sent).toHaveLength(1);
      expect(spy.sent[0]!.body).toBe(rungBody('no_show_checkin', PAST_TOUR_START));
    });

    it('force-send on a past-tour pre-tour rung refuses tour_already_passed and leaves the row pending', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
      seedForceTenant(rig.world, {
        contactId: 'contact-past-e',
        phone: '+15550900005',
        convId: 'conv-past-e',
        now: PAST_ARMED_AT,
      });
      const tour = await pastTour('contact-past-e', 'unit-past-e');
      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: 'morning_of',
        dueAt: MORNING_OF_DUE,
      });

      const result = await forceSendReminder(row.reminderId, tour.tourId, PAST_TOUR_NOW, true, deps);

      // A REFUSAL, never a claim-skip: a human action must not retire a rung.
      expect(result).toEqual({ outcome: 'refused', reason: 'tour_already_passed' });
      expect(spy.sent).toHaveLength(0);
      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.sentAt).toBeUndefined();
      expect(after?.skippedAt).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Manual-only hold-back - the MECHANISM, exercised through the injection seam
  //
  // MANUAL_ONLY_REMINDER_KINDS is EMPTY again since 2026-08-31 (Phase B), so
  // production exhibits none of this by default. The mechanism itself is not
  // gone: it is the way a kind gets paused again ("TO PAUSE AGAIN: add kinds
  // here"), so these cases inject an explicit non-empty set and keep it pinned.
  // The load-bearing assertion is that a held-back rung is left PENDING rather
  // than claim-skipped: "Send now" (forceSendReminder) refuses any row that is
  // already sent/skipped/canceled, so retiring them here would silently disable
  // the button the pause exists to keep.
  //
  // Every rung below is a LIVE kind. Riding `confirmation` would prove nothing
  // now - the discontinued guard would stop it first, for a different reason.
  // ---------------------------------------------------------------------------
  describe('manual-only hold-back (the pause mechanism, injected)', () => {
    // seedForceTour arms its row at 2026-02-11T13:00Z, which is AFTER FORCE_NOW
    // (the force-send suite polls at an instant the row is deliberately NOT due,
    // so only the human path can move it). These cases need the opposite: the
    // rung must be genuinely DUE, or "nothing was sent" would prove nothing.
    // Paired with quietOff so the quiet-hours backstop cannot be the reason
    // either - the hold-back has to be the only thing standing in the way.
    const POLL_AFTER_DUE = '2026-02-11T13:01:00.000Z';
    /** What a re-pause would look like: one live kind, held back by hand. */
    const PAUSE_DAY_BEFORE: ReadonlySet<ReminderKind> = new Set<ReminderKind>(['day_before']);

    it('the production default holds nothing back, and the retired kind is elsewhere', () => {
      // The unpause, asserted on the set itself: nothing is paused today.
      expect(MANUAL_ONLY_REMINDER_KINDS.size, 'the ladder is fully automatic again').toBe(0);
      // `confirmation` did not stay here under a new name - it moved to the
      // permanent set, which is what makes "Send now" refuse it too.
      expect([...DISCONTINUED_REMINDER_KINDS]).toEqual(['confirmation']);
    });

    it('a due manual-only rung is NOT sent and is LEFT PENDING (still force-sendable)', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-hold-1',
        phone: '+15550230001',
        convId: 'conv-hold-1',
        now: SEEDED_AT,
      });
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-hold-1',
        unitId: 'unit-hold-1',
        kind: 'day_before',
      });

      await runDueTourReminders(POLL_AFTER_DUE, { ...deps, manualOnlyKinds: PAUSE_DAY_BEFORE });

      expect(spy.sent).toHaveLength(0);
      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.sentAt, 'must not report a send that never happened').toBeUndefined();
      expect(after?.skippedAt, 'claim-skipping would break Send now').toBeUndefined();
      expect(after?.canceledAt).toBeUndefined();
    });

    it('a held-back rung is still reachable by a human force-send', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-hold-2',
        phone: '+15550230002',
        convId: 'conv-hold-2',
        now: SEEDED_AT,
      });
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-hold-2',
        unitId: 'unit-hold-2',
        kind: 'day_before',
      });

      await runDueTourReminders(POLL_AFTER_DUE, { ...deps, manualOnlyKinds: PAUSE_DAY_BEFORE });
      expect(spy.sent).toHaveLength(0);

      // forceSendReminder never consults manualOnlyKinds at all - the pause is a
      // POLL-side hold only, which is exactly why it could never have been the
      // guard for a kind that must never send (spec 3.1).
      const result = await forceSendReminder(
        row.reminderId,
        tour.tourId,
        POLL_AFTER_DUE,
        true,
        deps,
      );

      expect(result).toEqual({ outcome: 'sent' });
      expect(spy.sent).toHaveLength(1);
      // automated: false - the pause moved the decision to a human, it did not
      // turn the rung into an automated send by another name.
      expect(spy.sent[0]!.automated).toBe(false);
    });

    it('with nothing paused, the same rung sends automatically (the unpause)', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-hold-3',
        phone: '+15550230003',
        convId: 'conv-hold-3',
        now: SEEDED_AT,
      });
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-hold-3',
        unitId: 'unit-hold-3',
        kind: 'day_before',
      });

      // The real production default - NO manualOnlyKinds override anywhere.
      await runDueTourReminders(POLL_AFTER_DUE, deps);

      expect(spy.sent).toHaveLength(1);
      expect(spy.sent[0]!.automated, 'the poll path is still an AUTOMATED send').toBe(true);
      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.sentAt).toBe(POLL_AFTER_DUE);
    });
  });

  // ---------------------------------------------------------------------------
  // DISCONTINUED_REMINDER_KINDS (Phase B spec 3.1) - the PERMANENT guard.
  //
  // Distinct from the pause above in both directions: no path may send a
  // discontinued kind (the poll skips it AND the human force-send refuses it),
  // and no deps object can switch it off - the set is deliberately not
  // injectable, so e2e can never grow a send path production lacks.
  // ---------------------------------------------------------------------------
  describe('DISCONTINUED_REMINDER_KINDS', () => {
    const POLL_AFTER_DUE = '2026-02-11T13:01:00.000Z';

    it('the poll EXCLUDES a due discontinued row - not sent, not claim-skipped, left pending', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-disc-1',
        phone: '+15550240001',
        convId: 'conv-disc-1',
        now: SEEDED_AT,
      });
      // A FUTURE tour (seedForceTour's start is 20:00, the rung is due 13:00), so
      // the past-tour gate cannot be what stops this - only the kind can.
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-disc-1',
        unitId: 'unit-disc-1',
        kind: 'confirmation',
      });

      await runDueTourReminders(POLL_AFTER_DUE, deps);
      // TWICE: an excluded row must not be a row that merely lost a race.
      await runDueTourReminders(POLL_AFTER_DUE, deps);

      expect(spy.sent).toHaveLength(0);
      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.sentAt).toBeUndefined();
      // LEFT PENDING, not claim-skipped: the poll has no in-app writer for
      // `kind_retired` at all (spec 3.1) - only the sweep script stamps it.
      expect(after?.skippedAt).toBeUndefined();
      expect(after?.skipReason).toBeUndefined();
      expect(after?.canceledAt).toBeUndefined();
    });

    it('the held-back LOG counts a kind in BOTH sets once, not twice', async () => {
      // Review round 1, B-N4. MANUAL_ONLY_REMINDER_KINDS is empty today so the
      // two counters cannot overlap in production - but the whole point of
      // keeping the mechanism alive is that a kind CAN be re-paused, and
      // `confirmation` is the kind its docblock names. The counters exist to
      // tell two opposite actions apart (a queue a human must work through vs
      // rows the sweep has not reached), so a row in both sets must be reported
      // under the one that is true of it.
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-disc-n4',
        phone: '+15550240009',
        convId: 'conv-disc-n4',
        now: SEEDED_AT,
      });
      await seedForceTour({
        tenantId: 'contact-disc-n4',
        unitId: 'unit-disc-n4',
        kind: 'confirmation',
      });

      const before = logCapture.lines.length;
      await runDueTourReminders(POLL_AFTER_DUE, {
        ...deps,
        manualOnlyKinds: new Set<ReminderKind>(['confirmation']),
      });

      const held = logCapture.lines
        .slice(before)
        .find((l) => l['msg'] === 'tour reminder poll: rungs left pending (no automatic send)');
      expect(held).toBeDefined();
      // At least this suite's own row (earlier cases in this file leave their
      // discontinued rows pending too, deliberately - so this is >=, and the
      // RECONCILIATION below is the real assertion).
      expect(held?.['heldBackDiscontinued'] as number).toBeGreaterThanOrEqual(1);
      expect(held?.['heldBackManualOnly']).toBe(0);
      expect(
        (held?.['heldBackManualOnly'] as number) + (held?.['heldBackDiscontinued'] as number),
      ).toBe(held?.['heldBack']);
    });

    it('forceSendReminder REFUSES kind_retired for a discontinued kind, and the row is untouched', async () => {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-disc-2',
        phone: '+15550240002',
        convId: 'conv-disc-2',
        now: SEEDED_AT,
      });
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-disc-2',
        unitId: 'unit-disc-2',
        kind: 'confirmation',
      });

      const result = await forceSendReminder(
        row.reminderId,
        tour.tourId,
        POLL_AFTER_DUE,
        true,
        deps,
      );

      expect(result).toEqual({ outcome: 'refused', reason: 'kind_retired' });
      expect(spy.sent).toHaveLength(0);
      // PRE-CLAIM: a refusal never retires a rung (the sweep does that).
      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.sentAt).toBeUndefined();
      expect(after?.skippedAt).toBeUndefined();
    });

    it('refusal precedence: a discontinued rung on a PAST tour refuses kind_retired, not tour_already_passed', async () => {
      // Both gates are true here. The kind check sits at the row lookup, above
      // target resolution and above the past-tour gate, so the permanent reason
      // is the one the operator sees - "we no longer send this", not "you are
      // too late", which would invite a retry on the next tour.
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-disc-3',
        phone: '+15550240003',
        convId: 'conv-disc-3',
        now: SEEDED_AT,
      });
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-disc-3',
        unitId: 'unit-disc-3',
        kind: 'confirmation',
      });
      // An hour AFTER the seeded tour started (20:00), with the rung due 13:00:
      // retiredByTourStart is true, so tour_already_passed is genuinely live.
      const AFTER_TOUR = '2026-02-11T21:00:00.000Z';
      expect(retiredByTourStart(row, tour.scheduledAt, AFTER_TOUR)).toBe(true);

      const result = await forceSendReminder(row.reminderId, tour.tourId, AFTER_TOUR, true, deps);

      expect(result).toEqual({ outcome: 'refused', reason: 'kind_retired' });
      expect(spy.sent).toHaveLength(0);
    });

    it('the dev tick shape does NOT bypass it: an empty manualOnlyKinds still sends nothing', async () => {
      // The old dev/e2e override (`manualOnlyKinds: new Set()`) switched the
      // PAUSE off. It never reached this set, and must not: a seam that could
      // would give e2e a send path production does not have.
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-disc-4',
        phone: '+15550240004',
        convId: 'conv-disc-4',
        now: SEEDED_AT,
      });
      const { tour, row } = await seedForceTour({
        tenantId: 'contact-disc-4',
        unitId: 'unit-disc-4',
        kind: 'confirmation',
      });

      await runDueTourReminders(POLL_AFTER_DUE, { ...deps, manualOnlyKinds: new Set() });

      expect(spy.sent).toHaveLength(0);
      const after = (await tourReminders.listByTour(tour.tourId)).find(
        (r) => r.reminderId === row.reminderId,
      );
      expect(after?.sentAt).toBeUndefined();
      expect(after?.skippedAt).toBeUndefined();
    });

    it('a LIVE rung due in the same batch still sends - the exclusion is per KIND', async () => {
      // Anti-vacuity for the whole describe: without this, "nothing was sent"
      // would also pass if the poll had stopped working altogether.
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: quietOff };
      seedForceTenant(rig.world, {
        contactId: 'contact-disc-5',
        phone: '+15550240005',
        convId: 'conv-disc-5',
        now: SEEDED_AT,
      });
      const { tour } = await seedForceTour({
        tenantId: 'contact-disc-5',
        unitId: 'unit-disc-5',
        kind: 'confirmation',
      });
      // The SAME tour, one live rung, due a minute earlier so supersession has
      // nothing later to prefer (the discontinued row is not in the batch).
      const live = await createDueReminder(
        tourReminders,
        tour.tourId,
        'day_before',
        '2026-02-11T12:59:00.000Z',
      );

      await runDueTourReminders(POLL_AFTER_DUE, deps);

      expect(spy.sent).toHaveLength(1);
      const rows = await tourReminders.listByTour(tour.tourId);
      expect(rows.find((r) => r.reminderId === live.reminderId)?.sentAt).toBe(POLL_AFTER_DUE);
      expect(rows.find((r) => r.kind === 'confirmation')?.sentAt).toBeUndefined();
    });
  });

  // ===========================================================================
  // FAILURE IS NOT ABSENCE - the SEND paths (tour-reminder-ladder, spec 6.3b).
  //
  // A repo read that THREW is not the same as a contact that has no name. Where
  // the failed read blanks or corrupts something the composed copy RENDERS, a
  // send would be a wrong-but-valid message: the poll leaves the rung UNCLAIMED
  // and force-send REFUSES with 'names_unavailable'. EVERYWHERE ELSE a failure
  // degrades exactly like absence and the message still goes out - the guards
  // below (g1-g3) pin that half, and they are green before AND after this task.
  //
  // The severity is never read off a bare flag: assessNamesReadFailure derives
  // it from the CATALOG templates, so a copy edit cannot silently desync it.
  // ===========================================================================
  describe('name-read FAILURE on the send paths (spec 6.3b)', () => {
    const NF_SEEDED = '2026-03-09T15:00:00.000Z';
    const NF_SCHEDULED = '2026-03-12T18:00:00.000Z';
    const NF_DUE = '2026-03-11T15:00:00.000Z';
    const NF_POLL = '2026-03-11T15:01:00.000Z';

    /**
     * THE SHARED FIXTURE. A `landlord_led` tour with NO groupThreadId, so the
     * group is unusable and delivery falls back to the tenant 1:1 (whose
     * contact, phone and conversation all exist), whose unit names a property
     * contact that CANNOT BE READ.
     *
     * TWO NON-OBVIOUS PRECONDITIONS keep it on the COMPOSE path, both verified
     * against the live tree - know them before calling any red here "red for
     * the wrong reason":
     *  (a) the D7 pending-open wait cannot fire, because `createGroupTestRig`
     *      omits `pendingRosterActionsRepo` and the wait is gated on its
     *      presence (jobs/tourReminders.ts:1037).
     *  (b) the throwing property read cannot make the ROSTER unreadable:
     *      memberFromContact catches its own contact-read throw
     *      (lib/rosterResolution.ts:162-171), so tenantRosterGate still answers
     *      'on' and neither the roster_unavailable wait nor its refusal token
     *      can produce a false pass. That is why these cases assert the EXACT
     *      warn string and the EXACT refusal reason, never just "nothing sent".
     */
    async function nameFailRig(opts: {
      suffix: string;
      phone: string;
      kind: ReminderKind;
      /**
       * Which read blows up. 'property' throws the read of the unit's landlord
       * contact; 'unit' throws the unit read itself; 'tenant' throws the tenant
       * contact read - which on the 1:1 route fails inside resolveReminderTarget
       * BEFORE compose, so it exercises the target-resolution containment, not
       * the compose gate.
       */
      throwing: 'property' | 'unit' | 'tenant';
      tourType?: TourType;
    }) {
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      const tenantId = `contact-nf-${opts.suffix}`;
      const unitId = `unit-nf-${opts.suffix}`;
      const landlordId = `c-boom-${opts.suffix}`;
      seedForceTenant(rig.world, {
        contactId: tenantId,
        phone: opts.phone,
        convId: `conv-nf-${opts.suffix}`,
        now: NF_SEEDED,
      });
      // No address on purpose: none of the rungs these cases drive renders one,
      // so leaving it out keeps every expected body a bare rungBody(...).
      rig.world.units.set(unitId, {
        unitId,
        landlordId,
        status: 'available',
        created_at: NF_SEEDED,
        updated_at: NF_SEEDED,
      });
      if (opts.throwing === 'unit') {
        rig.world.unitsRepo.getById = async () => {
          throw new Error('units unavailable');
        };
      } else {
        const boom = opts.throwing === 'tenant' ? tenantId : landlordId;
        const realGetById = rig.world.contactsRepo.getById.bind(rig.world.contactsRepo);
        rig.world.contactsRepo.getById = async (contactId: string) => {
          if (contactId === boom) throw new Error('contacts unavailable');
          return realGetById(contactId);
        };
      }
      const tour = await tours.create({
        tenantId,
        unitId,
        scheduledAt: NF_SCHEDULED,
        tourType: opts.tourType ?? 'landlord_led',
      });
      const row = await tourReminders.create({
        tourId: tour.tourId,
        kind: opts.kind,
        dueAt: NF_DUE,
      });
      const deps = { ...rig.deps, sendMessageService: spy.service };
      return { rig, spy, deps, tour, row, tenantId, landlordId };
    }

    async function rowOf(tourId: string, reminderId: string) {
      return (await tourReminders.listByTour(tourId)).find((r) => r.reminderId === reminderId);
    }

    /** Log messages emitted since `from` (logCapture is shared by the file). */
    function msgsSince(from: number): unknown[] {
      return logCapture.lines.slice(from).map((l) => l['msg']);
    }

    // The full Step-3 warn. The plan's Step 1 quotes a PREFIX of this string;
    // the implemented message is the one asserted here.
    const DEFER_WARN =
      'tour reminder: name resolution read failed - leaving the rung unclaimed for the next tick';

    it('case 1: the POLL DEFERS an en_route rung whose property-contact read threw - unclaimed, not sent', async () => {
      const f = await nameFailRig({
        suffix: 'poll1',
        phone: '+15550240001',
        kind: 'en_route',
        throwing: 'property',
      });
      const from = logCapture.lines.length;

      await runDueTourReminders(NF_POLL, f.deps);

      expect(f.spy.sent).toHaveLength(0);
      const after = await rowOf(f.tour.tourId, f.row.reminderId);
      // No claim, no skip stamp - it re-lists next tick (the quiet-backstop
      // idiom). A wrong-but-valid self-guided body must never go out instead.
      expect(after?.sentAt).toBeUndefined();
      expect(after?.skippedAt).toBeUndefined();
      expect(msgsSince(from)).toContain(DEFER_WARN);
    });

    it('case 2: FORCE-SEND refuses representably with names_unavailable and leaves the row pending', async () => {
      const f = await nameFailRig({
        suffix: 'force1',
        phone: '+15550240002',
        kind: 'en_route',
        throwing: 'property',
      });

      const result = await forceSendReminder(
        f.row.reminderId,
        f.tour.tourId,
        NF_POLL,
        true,
        f.deps,
      );

      // A human pressing Send now needs an ANSWER, not the poll's silence
      // (spec 6.3b) - and never a claim-skip: a human failure must not retire
      // a rung.
      expect(result).toEqual({ outcome: 'refused', reason: 'names_unavailable' });
      expect(f.spy.sent).toHaveLength(0);
      const after = await rowOf(f.tour.tourId, f.row.reminderId);
      expect(after?.sentAt).toBeUndefined();
      expect(after?.skippedAt).toBeUndefined();
    });

    it('case 3: a NAMELESS landlord on a zero-primary unit degrades to the self-guided wording (the end-to-end join)', async () => {
      // Spec 13's join: zero-primary (no roster row carries primaryContact, so
      // the landlord-of-record rule supplies the property contact) PLUS a
      // landlord who exists with no first name. Absence, not failure: the rung
      // still SENDS, and the composer degrades the ENTRY rather than rendering
      // a blank name mid-sentence.
      const rig = createGroupTestRig();
      const spy = makeForceSendSpy();
      seedForceTenant(rig.world, {
        contactId: 'contact-nf-join',
        phone: '+15550240003',
        convId: 'conv-nf-join',
        now: NF_SEEDED,
      });
      rig.world.contacts.push({
        contactId: 'c-ll',
        type: 'landlord',
        phone: '+15550240103',
        created_at: NF_SEEDED,
      } as Parameters<typeof rig.world.contacts.push>[0]);
      Object.assign(
        rig.world.contacts.find((c) => c.contactId === 'contact-nf-join')!,
        { firstName: 'Tam' },
      );
      rig.world.units.set('unit-nf-join', {
        unitId: 'unit-nf-join',
        landlordId: 'c-ll',
        // primaryContact FALSE on the only row - the zero-primary shape, which
        // makes unitContacts' landlord-of-record fallback the live path.
        contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
        status: 'available',
        created_at: NF_SEEDED,
        updated_at: NF_SEEDED,
      });
      const tour = await tours.create({
        tenantId: 'contact-nf-join',
        unitId: 'unit-nf-join',
        scheduledAt: NF_SCHEDULED,
        tourType: 'landlord_led',
      });
      await tourReminders.create({ tourId: tour.tourId, kind: 'en_route', dueAt: NF_DUE });

      await runDueTourReminders(NF_POLL, { ...rig.deps, sendMessageService: spy.service });

      expect(spy.sent).toHaveLength(1);
      // Exactly the self-guided wording, with the TENANT's name intact.
      expect(spy.sent[0]!.body).toBe(
        "Hey Tam, can you please text me when you're on the way?",
      );
    });

    it('case 13: FORCE-SEND refuses when TARGET RESOLUTION throws - the dominant failure cell', async () => {
      // A throwing TENANT read on a self_guided tour fails inside
      // resolveReminderTarget, ABOVE the compose gate. Uncontained it escapes
      // the route unwrapped as a 500, where spec 6.3b demands "a REFUSAL the
      // route can render, not silence". The containment is deliberately a
      // BLANKET catch: narrowing it to the tenant read alone would re-open the
      // 500 escape for the tour, group-conversation and conversation lookups.
      const f = await nameFailRig({
        suffix: 'force2',
        phone: '+15550240004',
        kind: 'day_before',
        throwing: 'tenant',
        tourType: 'self_guided',
      });
      const from = logCapture.lines.length;

      const result = await forceSendReminder(
        f.row.reminderId,
        f.tour.tourId,
        NF_POLL,
        true,
        f.deps,
      );

      expect(result).toEqual({ outcome: 'refused', reason: 'names_unavailable' });
      const after = await rowOf(f.tour.tourId, f.row.reminderId);
      expect(after?.sentAt).toBeUndefined();
      expect(after?.skippedAt).toBeUndefined();
      expect(msgsSince(from)).toContain(
        'tour reminder force-send: target resolution read failed - row left pending',
      );
    });

    it('guard g1: a landlord-row outage does NOT block a day_before - the poll still sends it', async () => {
      // The carve-out's whole point. day_before's copy never names the property
      // contact, so a failed property read degrades exactly like absence.
      const f = await nameFailRig({
        suffix: 'g1',
        phone: '+15550240005',
        kind: 'day_before',
        throwing: 'property',
      });
      const from = logCapture.lines.length;

      await runDueTourReminders(NF_POLL, f.deps);

      expect(f.spy.sent).toHaveLength(1);
      expect(f.spy.sent[0]!.body).toBe(rungBody('day_before', NF_SCHEDULED));
      expect(msgsSince(from)).not.toContain(DEFER_WARN);
    });

    it('guard g2: a throwing UNIT read still sends a day_before, without an address', async () => {
      // "A reminder must never be lost over a missing street" survives for
      // every rung that does not need the property contact.
      const f = await nameFailRig({
        suffix: 'g2',
        phone: '+15550240006',
        kind: 'day_before',
        throwing: 'unit',
      });
      const from = logCapture.lines.length;

      await runDueTourReminders(NF_POLL, f.deps);

      expect(f.spy.sent).toHaveLength(1);
      expect(f.spy.sent[0]!.body).toBe(rungBody('day_before', NF_SCHEDULED));
      expect(msgsSince(from)).not.toContain(DEFER_WARN);
    });

    // g3 / g3b are the FORCE-SEND twins of g1 / g2: the carve-out has to hold on
    // the human path too, or an operator would be told to try again over a read
    // the copy never needed.
    //
    // THEY USED TO RIDE `confirmation` (Phase A), for its own reason: that copy
    // renders NO name, so no failed name read can corrupt it. Both halves of
    // that survive, in the right places. The "renders no name" half is a CATALOG
    // fact and is pinned directly on the assessor in tourCopy.test.ts
    // ("confirmation is never blocked - its untouched copy renders no name",
    // with all three reads thrown at once) - a stronger pin than an integration
    // test could give it. What could NOT survive on confirmation is the half
    // below: since Phase B the kind is discontinued, so a force-send refuses
    // `kind_retired` above the compose gate and would never reach the carve-out.
    // Derived, not assumed: reminderNamesUsed says `confirmation` is the ONLY
    // kind rendering no name, so there was no live kind to retarget the FIRST
    // half to. `day_before` names the tenant and nothing else, which is exactly
    // what these two failing reads are NOT.
    it('guard g3: a day_before force-send SENDS with the unit read throwing', async () => {
      // FIXTURE FACT, not a gap: with the unit read throwing, `unit` is
      // undefined and resolveTourContactNames never ATTEMPTS the property read,
      // so propertyReadFailed is structurally false here. Do NOT "fix" the
      // resolver to report a failure for a read it never made - the second
      // variant below is the property-read coverage.
      const f = await nameFailRig({
        suffix: 'g3',
        phone: '+15550240007',
        kind: 'day_before',
        throwing: 'unit',
      });

      const result = await forceSendReminder(
        f.row.reminderId,
        f.tour.tourId,
        NF_POLL,
        true,
        f.deps,
      );

      expect(result).toEqual({ outcome: 'sent' });
      expect(f.spy.sent).toHaveLength(1);
      // The address degraded away; the tenant greeting did not (the tenant read
      // is deliberately NOT thrown in either g3 variant: that one fails inside
      // target resolution, which is case 13's behaviour, not the compose gate's).
      expect(f.spy.sent[0]!.body).toBe(rungBody('day_before', NF_SCHEDULED));
    });

    it('guard g3b: a day_before force-send SENDS with only the property-contact read throwing', async () => {
      // day_before's copy never names the property contact, so a failed property
      // read degrades exactly like absence - on the human path as on the poll's.
      const f = await nameFailRig({
        suffix: 'g3b',
        phone: '+15550240008',
        kind: 'day_before',
        throwing: 'property',
      });

      const result = await forceSendReminder(
        f.row.reminderId,
        f.tour.tourId,
        NF_POLL,
        true,
        f.deps,
      );

      expect(result).toEqual({ outcome: 'sent' });
      expect(f.spy.sent).toHaveLength(1);
      expect(f.spy.sent[0]!.body).toBe(rungBody('day_before', NF_SCHEDULED));
    });

    // =========================================================================
    // THE ONE-HOUR BOUND on the names re-list (Phase B spec 7, ledger item 7).
    //
    // Phase A accepted an UNBOUNDED defer here because the poll sat behind the
    // manual-only hold-back; that acceptance expired with the pause. A read
    // that throws forever re-lists the rung every tick with nothing on the
    // panel to say why, and when the table recovers the whole backlog fires
    // carrying copy whose moment has passed. The bound mirrors the roster twin
    // exactly (ROSTER_UNAVAILABLE_GRACE_MS, one hour past the rung's dueAt):
    // inside the hour a blip still costs nothing, past it the rung is retired
    // VISIBLY. One hour and not longer because an "on the way" text landing
    // ninety minutes late is worse than a chip saying it did not send.
    //
    // BOTH send routes need it. The GROUP route matters most: a landlord_led
    // en_route rung is the only rung in the whole ladder whose copy FORKS on
    // the property-contact name, so it is the single rung-differential names
    // failure there is - bounding the 1:1 alone would close the smaller half.
    //
    // FORCE-SEND is deliberately unbounded on both routes: a human action never
    // retires a rung, so it keeps refusing `names_unavailable` for as long as
    // the rung stays pending.
    // =========================================================================
    describe('the one-hour names bound (spec 7)', () => {
      /** dueAt + 1 minute: past due, well inside the grace window. */
      const NF_EARLY_POLL = '2026-03-11T15:01:00.000Z';
      /** dueAt + 61 minutes: past the one-hour grace (rosterWaitExpired is `>`). */
      const NF_LATE_POLL = '2026-03-11T16:01:00.000Z';
      const RETIRE_ERROR =
        'tour reminder: name resolution STILL failing past the grace window - retiring (claim-skipped)';

      /**
       * The GROUP twin of nameFailRig: a landlord_led tour WITH a usable open
       * relay group, so delivery routes to sendGroupReminder rather than
       * falling back to the tenant 1:1. The unit's property contact is the read
       * that throws - the fork en_route's group copy depends on.
       *
       * The throwing read cannot make the group unusable: memberFromContact
       * catches its own contact-read throw, so the roster still resolves and a
       * red here can only be the compose gate.
       *
       * THE TENANT'S 1:1 CONVERSATION IS DELETED after seeding, deliberately.
       * Without that these cases would pass identically if the group were
       * unusable and routing quietly fell back to the 1:1 - i.e. they would
       * prove the 1:1 bound twice and the group bound never. With no 1:1 thread
       * to fall back TO, a routing failure claim-skips `no_conversation`
       * instead, which every assertion below would catch.
       */
      async function groupNameFailRig(opts: {
        suffix: string;
        phone: string;
        landlordPhone: string;
        kind: ReminderKind;
      }) {
        const rig = createGroupTestRig();
        const spy = makeForceSendSpy();
        const tenantId = `contact-gnf-${opts.suffix}`;
        const unitId = `unit-gnf-${opts.suffix}`;
        const landlordId = `c-gboom-${opts.suffix}`;
        const groupConvId = `conv-gnf-group-${opts.suffix}`;
        seedForceTenant(rig.world, {
          contactId: tenantId,
          phone: opts.phone,
          convId: `conv-gnf-${opts.suffix}`,
          now: NF_SEEDED,
        });
        // See the docblock: no 1:1 thread, so nothing can silently fall back.
        rig.world.conversations.delete(`conv-gnf-${opts.suffix}`);
        rig.world.units.set(unitId, {
          unitId,
          landlordId,
          status: 'available',
          created_at: NF_SEEDED,
          updated_at: NF_SEEDED,
        });
        const realGetById = rig.world.contactsRepo.getById.bind(rig.world.contactsRepo);
        rig.world.contactsRepo.getById = async (contactId: string) => {
          if (contactId === landlordId) throw new Error('contacts unavailable');
          return realGetById(contactId);
        };
        seedRelayGroup(rig.world, {
          convId: groupConvId,
          poolNumber: '+15550190901',
          participants: [
            { contactId: tenantId, phone: opts.phone, name: 'Tina Tenant' },
            { contactId: landlordId, phone: opts.landlordPhone, name: 'Larry Landlord' },
          ],
          now: NF_SEEDED,
        });
        const tour = await tours.create({
          tenantId,
          unitId,
          scheduledAt: NF_SCHEDULED,
          tourType: 'landlord_led',
        });
        await tours.patch(tour.tourId, { groupThreadId: groupConvId });
        const row = await tourReminders.create({
          tourId: tour.tourId,
          kind: opts.kind,
          dueAt: NF_DUE,
        });
        const deps = { ...rig.deps, sendMessageService: spy.service };
        return { rig, spy, deps, tour, row };
      }

      it('1:1 route (a): INSIDE the hour the rung is still left unclaimed and re-lists', async () => {
        const f = await nameFailRig({
          suffix: 'bound1a',
          phone: '+15550240011',
          kind: 'en_route',
          throwing: 'property',
        });
        const from = logCapture.lines.length;

        await runDueTourReminders(NF_EARLY_POLL, f.deps);

        const after = await rowOf(f.tour.tourId, f.row.reminderId);
        expect(after?.sentAt).toBeUndefined();
        expect(after?.skippedAt).toBeUndefined();
        expect(f.spy.sent).toHaveLength(0);
        // The warn string is unchanged and asserted verbatim: the inside-the-hour
        // branch is exactly the Phase A behaviour, and only its bound is new.
        expect(msgsSince(from)).toContain(DEFER_WARN);
        expect(msgsSince(from)).not.toContain(RETIRE_ERROR);
        // Still live: the next tick retries it.
        expect((await tourReminders.listDue(NF_EARLY_POLL)).map((r) => r.reminderId)).toContain(
          f.row.reminderId,
        );
      });

      it('1:1 route (b): PAST the hour it is claim-skipped names_unavailable, exactly once', async () => {
        const f = await nameFailRig({
          suffix: 'bound1b',
          phone: '+15550240012',
          kind: 'en_route',
          throwing: 'property',
        });
        const from = logCapture.lines.length;

        await runDueTourReminders(NF_LATE_POLL, f.deps);

        const after = await rowOf(f.tour.tourId, f.row.reminderId);
        expect(after?.skippedAt).toBe(NF_LATE_POLL);
        expect(after?.skipReason).toBe('names_unavailable');
        expect(after?.sentAt).toBeUndefined();
        expect(f.spy.sent).toHaveLength(0);
        expect(msgsSince(from)).toContain(RETIRE_ERROR);
        // EXACTLY ONCE is the whole point of a claim-skip over a bare return:
        // the row leaves listDue, so a second tick has nothing to re-retire.
        expect((await tourReminders.listDue(NF_LATE_POLL)).map((r) => r.reminderId)).not.toContain(
          f.row.reminderId,
        );
      });

      it('1:1 route (c): FORCE-SEND past the hour still refuses names_unavailable and never retires', async () => {
        const f = await nameFailRig({
          suffix: 'bound1c',
          phone: '+15550240013',
          kind: 'en_route',
          throwing: 'property',
        });

        const result = await forceSendReminder(
          f.row.reminderId,
          f.tour.tourId,
          NF_LATE_POLL,
          true,
          f.deps,
        );

        // The bound is a POLL rule. A human pressing Send now gets an answer and
        // keeps the rung, so they can push it through the moment the table
        // recovers - however long past due that is.
        expect(result).toEqual({ outcome: 'refused', reason: 'names_unavailable' });
        const after = await rowOf(f.tour.tourId, f.row.reminderId);
        expect(after?.sentAt).toBeUndefined();
        expect(after?.skippedAt).toBeUndefined();
      });

      it('GROUP route (a): INSIDE the hour the rung is still left unclaimed and re-lists', async () => {
        const f = await groupNameFailRig({
          suffix: 'bound2a',
          phone: '+15550240021',
          landlordPhone: '+15550240121',
          kind: 'en_route',
        });
        const from = logCapture.lines.length;

        await runDueTourReminders(NF_EARLY_POLL, f.deps);

        const after = await rowOf(f.tour.tourId, f.row.reminderId);
        expect(after?.sentAt).toBeUndefined();
        expect(after?.skippedAt).toBeUndefined();
        // Nothing announced into the group thread either.
        expect(f.rig.groupSends).toHaveLength(0);
        expect(msgsSince(from)).toContain(DEFER_WARN);
        expect(msgsSince(from)).not.toContain(RETIRE_ERROR);
        expect((await tourReminders.listDue(NF_EARLY_POLL)).map((r) => r.reminderId)).toContain(
          f.row.reminderId,
        );
      });

      it('GROUP route (b): PAST the hour it is claim-skipped names_unavailable, exactly once', async () => {
        const f = await groupNameFailRig({
          suffix: 'bound2b',
          phone: '+15550240022',
          landlordPhone: '+15550240122',
          kind: 'en_route',
        });
        const from = logCapture.lines.length;

        await runDueTourReminders(NF_LATE_POLL, f.deps);

        const after = await rowOf(f.tour.tourId, f.row.reminderId);
        expect(after?.skippedAt).toBe(NF_LATE_POLL);
        expect(after?.skipReason).toBe('names_unavailable');
        expect(f.rig.groupSends).toHaveLength(0);
        expect(msgsSince(from)).toContain(RETIRE_ERROR);
        expect((await tourReminders.listDue(NF_LATE_POLL)).map((r) => r.reminderId)).not.toContain(
          f.row.reminderId,
        );
      });

      it('GROUP route (c): FORCE-SEND past the hour still refuses names_unavailable and never retires', async () => {
        const f = await groupNameFailRig({
          suffix: 'bound2c',
          phone: '+15550240023',
          landlordPhone: '+15550240123',
          kind: 'en_route',
        });

        const result = await forceSendReminder(
          f.row.reminderId,
          f.tour.tourId,
          NF_LATE_POLL,
          true,
          f.deps,
        );

        expect(result).toEqual({ outcome: 'refused', reason: 'names_unavailable' });
        expect(f.rig.groupSends).toHaveLength(0);
        const after = await rowOf(f.tour.tourId, f.row.reminderId);
        expect(after?.sentAt).toBeUndefined();
        expect(after?.skippedAt).toBeUndefined();
      });
    });
  });

  // ===========================================================================
  // en_route QUIET-HOURS EXEMPTION (Phase B spec 6) + the WIDENED supersession
  // predicate (spec 6.2).
  //
  // These cases live on their OWN November 2026 timeline, so no row from any
  // other test in this file is ever due at their polls and none of their armed
  // rows is ever swept by another test's tick. America/New_York is EST (UTC-5)
  // from Nov 1 2026, and the default window is 21:00-08:00 local.
  //
  // The exemption is the founder's decision (Sam, 2026-08-31): the "on the way"
  // rung is the one message whose whole value is that it lands an hour before
  // the tour, so it is stored and fired at its RAW time even inside the window.
  // Every other rung clamps exactly as before - clampOutOfQuietHours itself is
  // untouched, because the placement ladder and the timeline share it.
  // ===========================================================================
  describe('en_route quiet-hours exemption (spec 6) + widened supersession (6.2)', () => {
    const QUIET_WINDOW = quietHoursWindowOf({
      quietHoursEnabled: true,
      quietHoursStart: '21:00',
      quietHoursEnd: '08:00',
      timezone: DEFAULT_ORG_SETTINGS.timezone,
    });

    it('arm-time: en_route stores its RAW dueAt inside the quiet window; other rungs clamp', async () => {
      // A 04:00-local tour - the unbounded consequence spec 6.1 names. en_route
      // is due at 03:00 local, deep inside the window, and is stored THERE.
      const now = '2026-11-17T15:00:00.000Z'; // Nov 17 10:00 EST
      const scheduledAt = '2026-11-19T09:00:00.000Z'; // Nov 19 04:00 EST

      const tour = await tours.create({
        tenantId: 'contact-arm-enroute-1',
        unitId: 'unit-arm-enroute-1',
        scheduledAt,
        tourType: 'self_guided',
      });

      const { rows } = await armTourReminders(tour, now, {
        tourRemindersRepo: tourReminders,
        settingsRepo: stubSettingsRepo(),
        logger,
      });
      const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

      // THE EXEMPTION: raw = scheduledAt - 1h = Nov 19 03:00 EST. Unclamped, and
      // still armed (it is before the tour and no later rung shares its slot).
      expect(byKind['en_route']!.dueAt).toBe('2026-11-19T08:00:00.000Z');
      expect(byKind['en_route']!.skippedAt).toBeUndefined();
      // ...and it really is inside the window - the assertion that would still
      // pass if the exemption were reverted for a tour that happened to clamp
      // to the same instant.
      expect(isQuietTime(byKind['en_route']!.dueAt, QUIET_WINDOW)).toBe(true);

      // EVERY OTHER RUNG CLAMPS. morning_of raw = Nov 19 00:00 EST (inside the
      // window) -> 08:00 EST = 13:00Z, which is AFTER this 04:00 tour, so the
      // pre-existing past-event rule retires it with a visible row.
      expect(byKind['morning_of']!.dueAt).toBe('2026-11-19T13:00:00.000Z');
      expect(byKind['morning_of']!.skipReason).toBe('past_event');

      // day_before = 19:30 EST Nov 18, outside the window either way - the
      // control that shows the exemption did not disable clamping wholesale.
      expect(byKind['day_before']!.dueAt).toBe('2026-11-19T00:30:00.000Z');
      expect(byKind['day_before']!.skippedAt).toBeUndefined();
    });

    it('fire-time: a due en_route sends during the quiet window; day_before defers', async () => {
      // TWO TOURS on purpose: two rungs of the SAME tour due in one batch hit
      // supersededInBatch (which retires the earlier one), and that would hide
      // the deferral this case exists to pin.
      const rig = createGroupTestRig();
      const deps = quietOnDeps(rig.deps);
      const seededAt = '2026-11-16T15:00:00.000Z';
      const inWindow = '2026-11-18T03:00:00.000Z'; // Nov 17 22:00 EST
      seedTenant(rig.world, 'contact-enroute-fire', '+15550260001', 'conv-enroute-fire', seededAt);
      seedTenant(rig.world, 'contact-daybefore-fire', '+15550260002', 'conv-daybefore-fire', seededAt);

      const enRouteTour = await tours.create({
        tenantId: 'contact-enroute-fire',
        unitId: 'unit-enroute-fire',
        scheduledAt: '2026-11-18T04:00:00.000Z', // Nov 17 23:00 EST - the tour is still ahead
        tourType: 'self_guided',
      });
      const dayBeforeTour = await tours.create({
        tenantId: 'contact-daybefore-fire',
        unitId: 'unit-daybefore-fire',
        scheduledAt: '2026-11-20T20:00:00.000Z',
        tourType: 'self_guided',
      });
      const enRoute = await createDueReminder(tourReminders, enRouteTour.tourId, 'en_route', inWindow);
      const dayBefore = await createDueReminder(
        tourReminders,
        dayBeforeTour.tourId,
        'day_before',
        inWindow,
      );

      await runDueTourReminders(inWindow, deps);

      // The exempt rung went out mid-window.
      const enRouteAfter = (await tourReminders.listByTour(enRouteTour.tourId)).find(
        (r) => r.reminderId === enRoute.reminderId,
      );
      expect(enRouteAfter?.sentAt).toBe(inWindow);
      expect(rig.world.sent.map((s) => s.to)).toContain('+15550260001');

      // The unexempt sibling is DEFERRED, not skipped: no claim, no stamp, and
      // still in listDue so the tick after quiet-end picks it up.
      const dayBeforeAfter = (await tourReminders.listByTour(dayBeforeTour.tourId)).find(
        (r) => r.reminderId === dayBefore.reminderId,
      );
      expect(dayBeforeAfter?.sentAt).toBeUndefined();
      expect(dayBeforeAfter?.skippedAt).toBeUndefined();
      expect((await tourReminders.listDue(inWindow)).map((r) => r.reminderId)).toContain(
        dayBefore.reminderId,
      );
      expect(rig.world.sent.map((s) => s.to)).not.toContain('+15550260002');
    });

    it('REGRESSION (the 08:30 double-send): morning_of clamped ONTO or PAST en_route is superseded at arm', async () => {
      // Spec 6.2's counter-example, and the reason the predicate had to widen
      // from equality to `<=`. Before the exemption both rungs clamped to 08:00
      // and equality retired morning_of. With en_route unclamped at 07:30 the
      // two slots SEPARATE and the ladder INVERTS - equality would arm both, and
      // the tenant would get "she is headed that way shortly" at 07:30 followed
      // by "looking forward to having you tour at 8:30 today" at 08:00.
      const now = '2026-11-19T01:00:00.000Z'; // Nov 18 20:00 EST - the evening before
      const scheduledAt = '2026-11-19T13:30:00.000Z'; // Nov 19 08:30 EST

      const tour = await tours.create({
        tenantId: 'contact-arm-0830',
        unitId: 'unit-arm-0830',
        scheduledAt,
        tourType: 'self_guided',
      });

      const { rows } = await armTourReminders(tour, now, {
        tourRemindersRepo: tourReminders,
        settingsRepo: stubSettingsRepo(),
        logger,
      });
      const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

      // en_route raw = Nov 19 07:30 EST, inside the window, EXEMPT -> stored raw.
      expect(byKind['en_route']!.dueAt).toBe('2026-11-19T12:30:00.000Z');
      expect(byKind['en_route']!.skippedAt).toBeUndefined();
      // morning_of raw = Nov 19 04:30 EST -> clamps to 08:00 EST = 13:00Z, which
      // is now AFTER en_route. The widened predicate sees a later rung firing
      // BEFORE this one and retires this one, visibly.
      expect(byKind['morning_of']!.dueAt).toBe('2026-11-19T13:00:00.000Z');
      expect(byKind['morning_of']!.skipReason).toBe('quiet_hours_superseded');
      // day_before is booked-too-late at this arm instant (its 19:30 anchor was
      // 30 minutes ago), so it is a visible skipped row too - which leaves
      // en_route as the ONLY pending rung. ONE text goes out.
      expect(byKind['day_before']!.skipReason).toBe('booked_too_late');
      expect(rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind)).toEqual(['en_route']);
    });

    it('widened predicate is a NO-OP on an unclamped ladder', async () => {
      // Spec 6.2's own regression test: with nothing clamping, the rungs are
      // strictly increasing in time, so `otherDue <= dueAt` is false for every
      // pair and the arm result is byte-for-byte the pre-change one.
      const now = '2026-11-17T15:00:00.000Z'; // Nov 17 10:00 EST
      const scheduledAt = '2026-11-19T20:00:00.000Z'; // Nov 19 15:00 EST - an ordinary afternoon

      const tour = await tours.create({
        tenantId: 'contact-arm-noop',
        unitId: 'unit-arm-noop',
        scheduledAt,
        tourType: 'self_guided',
      });

      const { rows } = await armTourReminders(tour, now, {
        tourRemindersRepo: tourReminders,
        settingsRepo: quietOff,
        logger,
      });
      const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

      expect(byKind['day_before']!.dueAt).toBe('2026-11-19T00:30:00.000Z');
      expect(byKind['morning_of']!.dueAt).toBe('2026-11-19T16:00:00.000Z');
      expect(byKind['en_route']!.dueAt).toBe('2026-11-19T19:00:00.000Z');
      // Zero supersession rows, zero skips of any kind.
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(3);
    });
  });
});
