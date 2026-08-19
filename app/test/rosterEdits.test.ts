// The SHARED preview core (spec 6.1). These tests pin the rules the tour,
// placement, and standalone open previews must all obey - above all the count
// rule, whose de-dupe-then-filter order is easy to invert silently.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAddPreview,
  buildOpenPreview,
  buildOpenPreviewFromParts,
  buildStandaloneOpenPreview,
  type OpenPreviewParts,
} from '../src/services/rosterEdits.js';
import type { QuietHoursWindow } from '../src/lib/quietHours.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterOwner, RosterResolutionDeps } from '../src/lib/rosterResolution.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

/** 21:00 -> 08:00 America/New_York, the org default shape. */
const WINDOW: QuietHoursWindow = {
  enabled: true,
  start: '21:00',
  end: '08:00',
  timezone: 'America/New_York',
};

/** 18:00Z = 14:00 New York - comfortably outside the window. */
const QUIET_OFF = { nowIso: '2026-08-17T18:00:00.000Z', window: WINDOW };

describe('buildOpenPreviewFromParts', () => {
  it('counts a de-duplicated phone ONCE and by the FIRST member on it', () => {
    // Ada and Bo share a number; Ada is first and opted out. The phone is NOT
    // reachable just because Bo (later, same number) is - the de-dupe happens
    // BEFORE the reachable filter (spec 2.6). Guarding a silent behavior change
    // to the tour and placement previews.
    const parts: OpenPreviewParts = {
      bodyMembers: [{ name: 'Ada', memberKey: 'c-ada' }],
      recipients: [
        { name: 'Ada', memberKey: 'c-ada', reachability: 'opted_out' },
        { name: 'Bo', memberKey: 'c-bo', reachability: 'reachable' },
      ],
    };
    const preview = buildOpenPreviewFromParts(parts, QUIET_OFF);
    expect(preview.recipientCount).toBe(0);
    expect(preview.recipients).toHaveLength(2);
    expect(preview.deferred).toBe(false);
  });

  it('names only the body members in the intro, and lists every recipient', () => {
    const parts: OpenPreviewParts = {
      bodyMembers: [
        { name: 'Ada', memberKey: 'c-ada' },
        { name: 'Cy', memberKey: 'c-cy' },
      ],
      recipients: [
        { name: 'Ada Backfilled', memberKey: 'c-ada', reachability: 'reachable' },
        { name: 'Cy Backfilled', memberKey: 'c-cy', reachability: 'reachable' },
        { memberKey: 'phone:+15550100009', reachability: 'no_phone' },
      ],
    };
    const preview = buildOpenPreviewFromParts(parts, QUIET_OFF);
    expect(preview.body).toContain('Ada');
    expect(preview.body).toContain('Cy');
    expect(preview.body).not.toContain('Backfilled');
    expect(preview.recipients).toHaveLength(3);
    expect(preview.recipientCount).toBe(2);
  });

  it('never leaks a member key (or the phone inside one) into the recipients', () => {
    // toRecipient copies name + reachability ONLY. memberKey is an internal
    // join key and for a bare-phone member it IS the full E.164, so letting it
    // through would put a phone number in the confirm dialog.
    const preview = buildOpenPreviewFromParts(
      {
        bodyMembers: [{ memberKey: 'phone:+15550100009' }],
        recipients: [{ memberKey: 'phone:+15550100009', reachability: 'reachable' }],
      },
      QUIET_OFF,
    );
    expect(preview.recipients).toEqual([{ reachability: 'reachable' }]);
    expect(JSON.stringify(preview)).not.toContain('+15550100009');
  });

  it('reports quiet hours with the clamped end instant', () => {
    const preview = buildOpenPreviewFromParts(
      {
        bodyMembers: [{ name: 'Ada', memberKey: 'c-ada' }],
        recipients: [{ name: 'Ada', memberKey: 'c-ada', reachability: 'reachable' }],
      },
      // 03:00Z = 23:00 the previous evening in New York - inside the window.
      { nowIso: '2026-08-17T03:00:00.000Z', window: WINDOW },
    );
    expect(preview.deferred).toBe(true);
    expect(preview.quietEndsAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Owner vs standalone parity (spec section 7)
// ---------------------------------------------------------------------------

const ALICE = '+15550100001';
const BOB = '+15550100002';
const THREAD_ID = 'conv-parity';

/**
 * Drive buildOpenPreview through the `participants` resolver source: give the
 * owner a groupThreadId and let conversations.getById return a relay_group
 * whose participants ARE the fixture. resolveRoster then reads that array
 * straight through and describeRoster derives its view from it - no unit, plan,
 * or default roster needed. The unit is deliberately absent, so roles degrade
 * to 'added', which the preview ignores.
 *
 * Call buildOpenPreview DIRECTLY: GET /roster/preview-open refuses with
 * relay_already_provisioned once groupThreadId is set.
 */
function ownerFixture(world: FakeWorld, participants: ConversationParticipant[]): {
  deps: RosterResolutionDeps;
  owner: RosterOwner;
} {
  world.conversations.set(THREAD_ID, {
    conversationId: THREAD_ID,
    status: 'open',
    last_activity_at: '2026-08-17T18:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'auto',
    created_at: '2026-08-17T18:00:00.000Z',
    participants,
  });
  return {
    deps: {
      conversations: world.conversationsRepo,
      units: world.unitsRepo,
      contacts: world.contactsRepo,
      // REQUIRED on RosterResolutionDeps - describeRoster warns through it when
      // the unit or a contact read fails.
      log: createLogger({ destination: createLogCapture().stream }),
    },
    owner: {
      type: 'tour',
      id: 'tour-parity',
      // Both REQUIRED, even though the participants source ignores them.
      tenantId: 'c-alice',
      unitId: 'unit-absent',
      groupThreadId: THREAD_ID,
    },
  };
}

describe('owner vs standalone parity', () => {
  let world: FakeWorld;

  beforeEach(() => {
    world = createFakeWorld();
    world.contacts.push(
      {
        contactId: 'c-alice',
        type: 'tenant',
        phone: ALICE,
        firstName: 'Alice',
        lastName: 'Adams',
        sms_opt_out: false,
      },
      {
        contactId: 'c-bob',
        type: 'landlord',
        phone: BOB,
        firstName: 'Bob',
        lastName: 'Brown',
        sms_opt_out: false,
      },
    );
  });

  it('produces an IDENTICAL preview for the same member set', async () => {
    // FIXTURE CONSTRAINTS, both load-bearing and for DIFFERENT reasons:
    //   no suppressed members - the two paths use different reachability rules
    //     by design, and recipientCount is DERIVED from reachability, so a
    //     suppressed member makes the count comparison incoherent;
    //   no shared phones - only the standalone side de-duplicates by phone, so
    //     a shared phone breaks `recipients` on a difference the design wants.
    // Each excluded case gets its own test below.
    const members: ConversationParticipant[] = [
      { phone: ALICE, contactId: 'c-alice', name: 'Alice Adams' },
      { phone: BOB, contactId: 'c-bob', name: 'Bob Brown' },
    ];
    const { deps, owner } = ownerFixture(world, members);

    const ownerOutcome = await buildOpenPreview(deps, owner, QUIET_OFF);
    const standalone = await buildStandaloneOpenPreview(
      { contacts: world.contactsRepo, conversations: world.conversationsRepo },
      members,
      QUIET_OFF,
    );

    expect(ownerOutcome.ok).toBe(true);
    if (!ownerOutcome.ok) return;
    expect(standalone).toEqual(ownerOutcome.preview);
    // Spelled out too, so a future failure names the field that drifted.
    expect(standalone.body).toBe(ownerOutcome.preview.body);
    expect(standalone.recipients).toEqual(ownerOutcome.preview.recipients);
    expect(standalone.recipientCount).toBe(ownerOutcome.preview.recipientCount);
    expect(standalone.recipientCount).toBe(2);
    expect(standalone.deferred).toBe(ownerOutcome.preview.deferred);
    expect(standalone.quietEndsAt).toBe(ownerOutcome.preview.quietEndsAt);
  });

  it('carries the SAME quiet-hours verdict through both paths', async () => {
    const members: ConversationParticipant[] = [
      { phone: ALICE, contactId: 'c-alice', name: 'Alice Adams' },
      { phone: BOB, contactId: 'c-bob', name: 'Bob Brown' },
    ];
    const { deps, owner } = ownerFixture(world, members);
    // 03:00Z = 23:00 the previous evening in New York - inside the window.
    const quiet = { nowIso: '2026-08-17T03:00:00.000Z', window: WINDOW };

    const ownerOutcome = await buildOpenPreview(deps, owner, quiet);
    const standalone = await buildStandaloneOpenPreview(
      { contacts: world.contactsRepo, conversations: world.conversationsRepo },
      members,
      quiet,
    );

    expect(ownerOutcome.ok).toBe(true);
    if (!ownerOutcome.ok) return;
    expect(standalone.deferred).toBe(true);
    expect(standalone.quietEndsAt).toBe(ownerOutcome.preview.quietEndsAt);
    expect(standalone).toEqual(ownerOutcome.preview);
  });

  it('DIVERGES on a per-phone STOP record: standalone opted_out, owner reachable', async () => {
    // isMemberSuppressed reads the 1:1 thread's STOP flag off the byParticipantPhone
    // index; describeRoster only reads the contact flag plus the relay thread's
    // own opt-out annotations. Filed at
    // docs/issues/relay-member-suppression-diverges-from-number-seam.md - the
    // standalone path uses the true gate because matching the SEND is the point
    // of a preview.
    world.conversations.set('conv-bob-1to1', {
      conversationId: 'conv-bob-1to1',
      participant_phone: BOB,
      status: 'open',
      last_activity_at: '2026-08-17T18:00:00.000Z',
      type: 'landlord_1to1',
      ai_mode: 'auto',
      created_at: '2026-08-17T18:00:00.000Z',
      sms_opt_out: true,
    });
    const members: ConversationParticipant[] = [
      { phone: ALICE, contactId: 'c-alice', name: 'Alice Adams' },
      { phone: BOB, contactId: 'c-bob', name: 'Bob Brown' },
    ];
    const { deps, owner } = ownerFixture(world, members);

    const ownerOutcome = await buildOpenPreview(deps, owner, QUIET_OFF);
    const standalone = await buildStandaloneOpenPreview(
      { contacts: world.contactsRepo, conversations: world.conversationsRepo },
      members,
      QUIET_OFF,
    );

    expect(ownerOutcome.ok).toBe(true);
    if (!ownerOutcome.ok) return;
    expect(ownerOutcome.preview.recipients[1]).toEqual({
      name: 'Bob Brown',
      reachability: 'reachable',
    });
    expect(ownerOutcome.preview.recipientCount).toBe(2);
    expect(standalone.recipients[1]).toEqual({ name: 'Bob Brown', reachability: 'opted_out' });
    expect(standalone.recipientCount).toBe(1);
    // The BODY still names everyone on both paths - a suppressed member is a
    // participant whose leg is dropped at send, not someone left out of the text.
    expect(standalone.body).toBe(ownerOutcome.preview.body);
  });

  it('DIVERGES on a shared phone: owner lists both members, standalone lists one', async () => {
    // provisionMembersOf keeps ONE slot per number on BOTH paths, so the people
    // on the thread are the same. Only the PREVIEW differs: the owner path
    // builds recipients from describeRoster's full roster view and so names
    // someone provisioning will drop (pre-existing, filed at
    // docs/issues/relay-preview-lists-members-provisioning-drops.md). The
    // standalone path declines to reproduce it.
    world.contacts.push({
      contactId: 'c-sharer',
      type: 'tenant',
      phone: ALICE,
      firstName: 'Sam',
      lastName: 'Sharer',
      sms_opt_out: false,
    });
    const members: ConversationParticipant[] = [
      { phone: ALICE, contactId: 'c-alice', name: 'Alice Adams' },
      { phone: ALICE, contactId: 'c-sharer', name: 'Sam Sharer' },
      { phone: BOB, contactId: 'c-bob', name: 'Bob Brown' },
    ];
    const { deps, owner } = ownerFixture(world, members);

    const ownerOutcome = await buildOpenPreview(deps, owner, QUIET_OFF);
    const standalone = await buildStandaloneOpenPreview(
      { contacts: world.contactsRepo, conversations: world.conversationsRepo },
      members,
      QUIET_OFF,
    );

    expect(ownerOutcome.ok).toBe(true);
    if (!ownerOutcome.ok) return;
    expect(ownerOutcome.preview.recipients.map((r) => r.name)).toEqual([
      'Alice Adams',
      'Sam Sharer',
      'Bob Brown',
    ]);
    expect(standalone.recipients.map((r) => r.name)).toEqual(['Alice Adams', 'Bob Brown']);
    // The de-duped set is what gets texted, so the count and the intro body
    // agree across both paths even though the listed rows do not.
    expect(standalone.recipientCount).toBe(ownerOutcome.preview.recipientCount);
    expect(standalone.recipientCount).toBe(2);
    expect(standalone.body).toBe(ownerOutcome.preview.body);
  });

  describe('duplicate warning (spec 5)', () => {
    const DUP = {
      conversationId: 'conv-existing',
      partition: 'open' as const,
      memberNames: ['Dana Reed', 'Marcus Bell'],
    };
    const members: ConversationParticipant[] = [
      { contactId: 'c-alice', phone: ALICE },
      { contactId: 'c-bob', phone: BOB },
    ];

    it('standalone: sets duplicateOf when the callback resolves a group', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
        async () => DUP,
      );
      expect(preview.duplicateOf).toEqual(DUP);
    });

    it('standalone: omits duplicateOf when the callback resolves undefined', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
        async () => undefined,
      );
      expect(preview.duplicateOf).toBeUndefined();
    });

    it('standalone: omitting the callback yields no duplicateOf and does not throw', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
      );
      expect(preview.duplicateOf).toBeUndefined();
    });

    it('standalone: passes the callback the DEDUPED phone set it previews', async () => {
      const seen: Set<string>[] = [];
      await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        // ALICE twice - the second slot is dropped by the de-dupe, so the callback
        // must see two phones, not three. Nothing else pins WHAT is compared.
        [...members, { contactId: 'c-alice', phone: ALICE }],
        QUIET_OFF,
        async (phones) => {
          seen.push(phones);
          return undefined;
        },
      );
      expect(seen).toHaveLength(1);
      expect([...seen[0]!].sort()).toEqual([ALICE, BOB].sort());
    });

    it('owner: sets duplicateOf and receives the same deduped set', async () => {
      const { deps, owner } = ownerFixture(world, members);
      const seen: Set<string>[] = [];
      const outcome = await buildOpenPreview(deps, owner, QUIET_OFF, async (phones) => {
        seen.push(phones);
        return DUP;
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.preview.duplicateOf).toEqual(DUP);
      expect([...seen[0]!].sort()).toEqual([ALICE, BOB].sort());
    });

    it('owner: omitting the callback yields no duplicateOf', async () => {
      const { deps, owner } = ownerFixture(world, members);
      const outcome = await buildOpenPreview(deps, owner, QUIET_OFF);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.preview.duplicateOf).toBeUndefined();
    });

    it('the serialized preview contains NO phone numbers', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
        async () => DUP,
      );
      const wire = JSON.stringify(preview);
      expect(wire).not.toContain(ALICE);
      expect(wire).not.toContain(BOB);
    });

    it('buildAddPreview NEVER sets duplicateOf', async () => {
      const { deps, owner } = ownerFixture(world, members);
      // The candidate must NOT already be on the roster, or the add preview takes its
      // idempotent branch and the assertion proves nothing about a real add.
      const outcome = await buildAddPreview(
        deps,
        owner,
        { contactId: 'c-carla', phone: '+15550100003', name: 'Carla Cole', optedOut: false },
        QUIET_OFF,
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.preview.duplicateOf).toBeUndefined();
    });
  });
});
