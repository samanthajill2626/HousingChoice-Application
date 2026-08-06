// Unit tests for lib/rosterResolution.ts - the ONE shared plan/fact roster
// resolver (spec D1/D3/5.2). Everything that reads "who is on this tour or
// placement" - provision, the People card, the 1:1 tabs, previews, the reminder
// suppression - funnels through resolveRoster, so the precedence rules are
// pinned here once rather than re-asserted per surface.
//
// The load-bearing rule, and the reason this file leads with it: WHEN THE
// THREAD POINTER IS SET BUT THE CONVERSATION CANNOT BE READ, resolution is
// 'unavailable' with NO members - never a fall-through to the plan or the
// property default. By then the plan was consumed, so the fallback would be
// exactly the roster the operator edited away from.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  describeRoster,
  isOnRoster,
  resolveRoster,
  rosterEquals,
  type ResolvedMember,
  type RosterOwner,
  type RosterResolutionDeps,
} from '../src/lib/rosterResolution.js';
import type { PendingRosterActionItem } from '../src/repos/pendingRosterActionsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

const log = createLogger({ destination: createLogCapture().stream });

interface WorldOpts {
  conversations?: Record<string, ConversationItem>;
  units?: Record<string, UnitItem>;
  contacts?: Record<string, ContactItem>;
  conversationsThrow?: boolean;
  unitsThrow?: boolean;
  contactsThrow?: boolean;
}

/** Fake repos = plain objects with getById maps (no DynamoDB, no harness). */
function makeDeps(opts: WorldOpts = {}): RosterResolutionDeps & {
  conversationReads: string[];
  contactReads: string[];
} {
  const conversationReads: string[] = [];
  const contactReads: string[] = [];
  return {
    conversationReads,
    contactReads,
    conversations: {
      getById: vi.fn(async (conversationId: string) => {
        conversationReads.push(conversationId);
        if (opts.conversationsThrow) throw new Error('dynamodb: ProvisionedThroughputExceededException');
        return opts.conversations?.[conversationId];
      }),
    },
    units: {
      getById: vi.fn(async (unitId: string) => {
        if (opts.unitsThrow) throw new Error('dynamodb: ProvisionedThroughputExceededException');
        return opts.units?.[unitId];
      }),
    },
    contacts: {
      getById: vi.fn(async (contactId: string) => {
        contactReads.push(contactId);
        if (opts.contactsThrow) throw new Error('dynamodb: ProvisionedThroughputExceededException');
        return opts.contacts?.[contactId];
      }),
    },
    log,
  };
}

const TOUR: RosterOwner = {
  type: 'tour',
  id: 'tour-1',
  tenantId: 'c-tenant',
  unitId: 'unit-1',
};

function contact(contactId: string, phone: string | undefined, firstName: string): ContactItem {
  return {
    contactId,
    type: 'tenant',
    ...(phone !== undefined && { phone }),
    firstName,
    lastName: 'Person',
  } as ContactItem;
}

function relayGroup(
  conversationId: string,
  participants: { contactId: string; phone: string; name?: string }[],
  status = 'open',
): ConversationItem {
  return {
    conversationId,
    type: 'relay_group',
    status,
    participants,
    created_at: '2026-07-01T00:00:00.000Z',
  } as ConversationItem;
}

// ---------------------------------------------------------------------------
// FACT: a thread exists -> its participants ARE the roster
// ---------------------------------------------------------------------------

describe('resolveRoster - the thread pointer wins (FACT mode)', () => {
  it("returns the conversation's participants VERBATIM, bare-phone row included", async () => {
    const deps = makeDeps({
      conversations: {
        'conv-1': relayGroup('conv-1', [
          { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Tenant' },
          { contactId: 'c-pm', phone: '+15550100002', name: 'Pat PM' },
          { contactId: '', phone: '+15550100003' },
        ]),
      },
      // A plan AND a property default both exist - neither may be consulted.
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: { 'c-tenant': contact('c-tenant', '+15559999999', 'Tina') },
    });

    const resolved = await resolveRoster(deps, {
      ...TOUR,
      groupThreadId: 'conv-1',
      roster: [{ contactId: 'c-someone-else' }],
    });

    expect(resolved.source).toBe('participants');
    expect(resolved.members).toEqual([
      { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Tenant' },
      { contactId: 'c-pm', phone: '+15550100002', name: 'Pat PM' },
      { phone: '+15550100003' },
    ]);
  });

  it('a CLOSED thread still wins (reopen is a pure status flip; edits land on participants)', async () => {
    const deps = makeDeps({
      conversations: {
        'conv-1': relayGroup('conv-1', [{ contactId: 'c-pm', phone: '+15550100002' }], 'closed'),
      },
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
    });

    const resolved = await resolveRoster(deps, { ...TOUR, groupThreadId: 'conv-1' });

    expect(resolved.source).toBe('participants');
    expect(resolved.members).toEqual([{ contactId: 'c-pm', phone: '+15550100002' }]);
  });

  it('placements read the same way through group_thread (owner.groupThreadId)', async () => {
    const deps = makeDeps({
      conversations: {
        'conv-9': relayGroup('conv-9', [{ contactId: 'c-pm', phone: '+15550100002' }]),
      },
    });

    const resolved = await resolveRoster(deps, {
      type: 'placement',
      id: 'placement-1',
      tenantId: 'c-tenant',
      unitId: 'unit-1',
      groupThreadId: 'conv-9',
    });

    expect(resolved.source).toBe('participants');
    expect(resolved.members).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE CARDINAL RULE: pointer set + unreadable conversation -> 'unavailable'
// ---------------------------------------------------------------------------

describe("resolveRoster - pointer set but the conversation is unreadable -> 'unavailable'", () => {
  it('a THROWING conversation read yields source unavailable and NO members - never plan/default', async () => {
    const deps = makeDeps({
      conversationsThrow: true,
      units: {
        'unit-1': {
          unitId: 'unit-1',
          landlordId: 'c-owner',
          status: 'available',
          contacts: [{ contactId: 'c-owner', role: 'landlord', primaryContact: true }],
        },
      },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, {
      ...TOUR,
      groupThreadId: 'conv-1',
      roster: [{ contactId: 'c-plan-member' }],
    });

    expect(resolved).toEqual({ source: 'unavailable', members: [] });
  });

  it('a MISSING conversation yields the same (a dangling pointer is not a plan)', async () => {
    const deps = makeDeps({
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: { 'c-tenant': contact('c-tenant', '+15550100001', 'Tina') },
    });

    const resolved = await resolveRoster(deps, { ...TOUR, groupThreadId: 'conv-gone' });

    expect(resolved).toEqual({ source: 'unavailable', members: [] });
  });

  it("the tours PROVISIONING sentinel window reads as unavailable, never as the property default", async () => {
    // tours.ts claims the slot by writing groupThreadId = `provisioning:<tourId>`
    // before it buys a number. Nothing loads under that id, so a read during the
    // claim window is exactly the pointer-set-conversation-unloadable case -
    // correct and safe: a concurrent surface shows "unavailable", never a roster
    // the operator may have edited away from.
    const deps = makeDeps({
      units: {
        'unit-1': {
          unitId: 'unit-1',
          landlordId: 'c-owner',
          status: 'available',
          contacts: [{ contactId: 'c-owner', role: 'landlord', primaryContact: true }],
        },
      },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, { ...TOUR, groupThreadId: 'provisioning:tour-1' });

    expect(resolved).toEqual({ source: 'unavailable', members: [] });
    expect(deps.conversationReads).toEqual(['provisioning:tour-1']);
  });
});

// ---------------------------------------------------------------------------
// PLAN: no thread + a roster override
// ---------------------------------------------------------------------------

describe('resolveRoster - the plan override (no thread yet)', () => {
  it('returns the override in STORED ORDER with phones/names resolved at use time', async () => {
    const deps = makeDeps({
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: {
        'c-caseworker': contact('c-caseworker', '+15550100005', 'Casey'),
        'c-pm': contact('c-pm', '+15550100002', 'Pat'),
      },
    });

    const resolved = await resolveRoster(deps, {
      ...TOUR,
      roster: [{ contactId: 'c-caseworker' }, { contactId: 'c-pm' }],
    });

    expect(resolved.source).toBe('plan');
    expect(resolved.members).toEqual([
      { contactId: 'c-caseworker', phone: '+15550100005', name: 'Casey Person' },
      { contactId: 'c-pm', phone: '+15550100002', name: 'Pat Person' },
    ]);
  });

  it('normalizes a plan phone to E.164 and keeps a bare-phone entry contact-less', async () => {
    const deps = makeDeps({ contacts: { 'c-pm': contact('c-pm', '+15550100002', 'Pat') } });

    const resolved = await resolveRoster(deps, {
      ...TOUR,
      roster: [{ contactId: 'c-pm' }, { phone: '(555) 010-0007' }],
    });

    expect(resolved.source).toBe('plan');
    expect(resolved.members[1]).toEqual({ phone: '+15550100007' });
  });

  it('normalizes a CONTACT phone stored in a loose format (E.164 is the convention)', async () => {
    const deps = makeDeps({ contacts: { 'c-pm': contact('c-pm', '(555) 010-0002', 'Pat') } });

    const resolved = await resolveRoster(deps, { ...TOUR, roster: [{ contactId: 'c-pm' }] });

    expect(resolved.members[0]).toEqual({
      contactId: 'c-pm',
      phone: '+15550100002',
      name: 'Pat Person',
    });
  });

  it('a DANGLING contactId keeps its row (phone-less, so every send excludes it)', async () => {
    const deps = makeDeps({ contacts: { 'c-pm': contact('c-pm', '+15550100002', 'Pat') } });

    const resolved = await resolveRoster(deps, {
      ...TOUR,
      roster: [{ contactId: 'c-pm' }, { contactId: 'c-deleted' }],
    });

    expect(resolved.source).toBe('plan');
    expect(resolved.members).toEqual([
      { contactId: 'c-pm', phone: '+15550100002', name: 'Pat Person' },
      { contactId: 'c-deleted' },
    ]);
  });

  it('a THROWING contact read degrades to the bare row - resolution never 500s a page', async () => {
    const deps = makeDeps({ contactsThrow: true });

    const resolved = await resolveRoster(deps, { ...TOUR, roster: [{ contactId: 'c-pm' }] });

    expect(resolved).toEqual({ source: 'plan', members: [{ contactId: 'c-pm' }] });
  });
});

// ---------------------------------------------------------------------------
// DEFAULT: no thread, no plan -> tenant + the property's primary contact
// ---------------------------------------------------------------------------

describe('resolveRoster - the property default (no thread, no plan)', () => {
  const pmProperty: UnitItem = {
    unitId: 'unit-1',
    landlordId: 'c-owner',
    status: 'available',
    contacts: [
      { contactId: 'c-owner', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ],
    primary_contact: 'c-pm',
  };

  it('resolves [tenant, the PRIMARY CONTACT] - the PM, not the landlord of record', async () => {
    const deps = makeDeps({
      units: { 'unit-1': pmProperty },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
        'c-pm': contact('c-pm', '+15550100002', 'Pat'),
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.source).toBe('default');
    expect(resolved.members).toEqual([
      { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Person' },
      { contactId: 'c-pm', phone: '+15550100002', name: 'Pat Person' },
    ]);
  });

  it('ZERO-PRIMARY falls back to the LANDLORD OF RECORD (no working property regresses)', async () => {
    const deps = makeDeps({
      units: {
        'unit-1': {
          unitId: 'unit-1',
          landlordId: 'c-owner',
          status: 'available',
          // Legal + reachable: removeContact clears the flag when the primary is
          // removed and there is no landlordId to promote (spec 5.1).
          contacts: [
            { contactId: 'c-owner', role: 'landlord', primaryContact: false },
            { contactId: 'c-pm', role: 'pm', primaryContact: false },
          ],
        },
      },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.source).toBe('default');
    expect(resolved.members.map((m) => m.contactId)).toEqual(['c-tenant', 'c-owner']);
  });

  it('a legacy unit with NO contacts[] resolves its landlordId (unitContacts synthesizes the row)', async () => {
    const deps = makeDeps({
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members.map((m) => m.contactId)).toEqual(['c-tenant', 'c-owner']);
  });

  it('the tenant who IS the property contact gets ONE slot (de-duped)', async () => {
    const deps = makeDeps({
      units: {
        'unit-1': {
          unitId: 'unit-1',
          landlordId: 'c-tenant',
          status: 'available',
          contacts: [{ contactId: 'c-tenant', role: 'landlord', primaryContact: true }],
        },
      },
      contacts: { 'c-tenant': contact('c-tenant', '+15550100001', 'Tina') },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members).toEqual([
      { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Person' },
    ]);
  });

  it('a MISSING unit resolves the tenant alone (never a throw)', async () => {
    const deps = makeDeps({ contacts: { 'c-tenant': contact('c-tenant', '+15550100001', 'Tina') } });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.source).toBe('default');
    expect(resolved.members).toEqual([
      { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Person' },
    ]);
  });

  it('a THROWING unit read resolves the tenant alone (never 500s a page)', async () => {
    const deps = makeDeps({
      unitsThrow: true,
      contacts: { 'c-tenant': contact('c-tenant', '+15550100001', 'Tina') },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members.map((m) => m.contactId)).toEqual(['c-tenant']);
  });

  it('a landlord-less unit resolves the tenant alone', async () => {
    const deps = makeDeps({
      units: { 'unit-1': { unitId: 'unit-1', landlordId: '', status: 'available' } },
      contacts: { 'c-tenant': contact('c-tenant', '+15550100001', 'Tina') },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members.map((m) => m.contactId)).toEqual(['c-tenant']);
  });

  it('a phone-less tenant keeps its row (the caller decides what unreachable means)', async () => {
    const deps = makeDeps({
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: {
        'c-tenant': contact('c-tenant', undefined, 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members[0]).toEqual({ contactId: 'c-tenant', name: 'Tina Person' });
  });
});

// ---------------------------------------------------------------------------
// isOnRoster / rosterEquals
// ---------------------------------------------------------------------------

describe('isOnRoster', () => {
  it('is true only for a member carrying that contactId', () => {
    const roster = {
      source: 'plan' as const,
      members: [{ contactId: 'c-pm', phone: '+15550100002' }, { phone: '+15550100003' }],
    };

    expect(isOnRoster(roster, 'c-pm')).toBe(true);
    expect(isOnRoster(roster, 'c-tenant')).toBe(false);
    // A bare-phone row has no contactId to match, and a blank query never hits.
    expect(isOnRoster(roster, '')).toBe(false);
  });

  it("is false on an 'unavailable' roster (callers handle that source explicitly)", () => {
    expect(isOnRoster({ source: 'unavailable', members: [] }, 'c-tenant')).toBe(false);
  });
});

describe('rosterEquals - order-insensitive, contactId first, else E.164 phone', () => {
  const a: ResolvedMember[] = [
    { contactId: 'c-tenant', phone: '+15550100001' },
    { contactId: 'c-pm', phone: '+15550100002' },
  ];

  it('ignores order', () => {
    expect(rosterEquals(a, [a[1]!, a[0]!])).toBe(true);
  });

  it('ignores a phone difference when both sides are contact-backed', () => {
    // The contact's number was corrected after they joined: same person.
    expect(rosterEquals(a, [{ contactId: 'c-tenant', phone: '+15559999999' }, a[1]!])).toBe(true);
  });

  it('is false when the membership differs', () => {
    expect(rosterEquals(a, [a[0]!])).toBe(false);
    expect(rosterEquals(a, [a[0]!, { contactId: 'c-owner' }])).toBe(false);
  });

  it('compares bare-phone entries by E.164 phone, normalizing loose input', () => {
    expect(rosterEquals([{ phone: '+15550100003' }], [{ phone: '(555) 010-0003' }])).toBe(true);
    expect(rosterEquals([{ phone: '+15550100003' }], [{ phone: '+15550100004' }])).toBe(false);
  });

  it('never matches a bare phone against a contact-backed row (spec 5.2: reads Customized)', () => {
    expect(rosterEquals([{ contactId: 'c-pm', phone: '+15550100002' }], [{ phone: '+15550100002' }])).toBe(
      false,
    );
  });

  it('two empty rosters are equal', () => {
    expect(rosterEquals([], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describeRoster - the card payload's pending[]/skipped[] half (spec 6.5)
// ---------------------------------------------------------------------------

describe('describeRosterActions - historical rows cost NOTHING to serve', () => {
  const actionRow = (
    over: Partial<PendingRosterActionItem> & { actionId: string },
  ): PendingRosterActionItem => ({
    ownerKey: 'tour#tour-1',
    ownerType: 'tour',
    ownerId: 'tour-1',
    action: 'add_member',
    dueAt: '2026-08-05T12:00:00.000Z',
    _actionPartition: 'roster_actions',
    reason: 'quiet_hours',
    status: 'pending',
    createdAt: '2026-08-05T03:00:00.000Z',
    ...over,
  });

  it('reads a contact for a LIVE row only - applied and dismissed rows are skipped first', async () => {
    // Action rows are never deleted, so every roster GET re-walks the whole
    // history. Paying a serial contact read per row that is then discarded made
    // the card degrade monotonically for the life of the owner.
    const deps = makeDeps({
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100002', 'Ollie'),
        'c-pending': contact('c-pending', '+15550100003', 'Percy'),
        'c-applied': contact('c-applied', '+15550100004', 'Aggie'),
        'c-dismissed': contact('c-dismissed', '+15550100005', 'Dee'),
        'c-skipped': contact('c-skipped', '+15550100006', 'Skye'),
      },
    });
    const rows: PendingRosterActionItem[] = [
      actionRow({ actionId: 'tour#tour-1#add#c-pending', contactId: 'c-pending' }),
      actionRow({
        actionId: 'tour#tour-1#add#c-applied',
        contactId: 'c-applied',
        status: 'applied',
        resolvedAt: '2026-08-05T12:00:01.000Z',
      }),
      actionRow({
        actionId: 'tour#tour-1#add#c-dismissed',
        contactId: 'c-dismissed',
        status: 'skipped',
        skippedReason: 'contact_deleted',
        resolvedAt: '2026-08-05T12:00:02.000Z',
        dismissedAt: '2026-08-05T13:00:00.000Z',
      }),
      actionRow({
        actionId: 'tour#tour-1#add#c-skipped',
        contactId: 'c-skipped',
        status: 'skipped',
        skippedReason: 'already_member',
        resolvedAt: '2026-08-05T12:00:03.000Z',
      }),
    ];

    const view = await describeRoster(
      { ...deps, actions: { listByOwner: async () => rows } },
      TOUR,
    );

    // The rows that SHOW carry their name...
    expect(view.pending.map((p) => p.name)).toEqual(['Percy Person']);
    expect(view.skipped.map((s) => s.name)).toEqual(['Skye Person']);
    // ...and the discarded ones cost no read at all.
    expect(deps.contactReads).toContain('c-pending');
    expect(deps.contactReads).toContain('c-skipped');
    expect(deps.contactReads, 'an applied row is never rendered').not.toContain('c-applied');
    expect(deps.contactReads, 'a dismissed row is never rendered').not.toContain('c-dismissed');
  });
});
