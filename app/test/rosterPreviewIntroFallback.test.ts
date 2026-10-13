// primary-contact-integrity spec 5.2 (plan S3.3): RosterPreview.introFallback
// is set by the tour and placement OPEN preview (buildOpenPreview) ONLY -
// never by the standalone preview or the add-member preview.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAddPreview,
  buildOpenPreview,
  buildStandaloneOpenPreview,
} from '../src/services/rosterEdits.js';
import { createLogger } from '../src/lib/logger.js';
import type { QuietHoursWindow } from '../src/lib/quietHours.js';
import type { RosterOwner, RosterResolutionDeps } from '../src/lib/rosterResolution.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const WINDOW: QuietHoursWindow = {
  enabled: true,
  start: '21:00',
  end: '08:00',
  timezone: 'America/New_York',
};
/** 14:00 New York on 2026-09-07: outside quiet hours, the day before the tour. */
const QUIET_OFF = { nowIso: '2026-09-07T18:00:00.000Z', window: WINDOW };
/** 15:00 New York on 2026-09-08. */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
const TENANT_PHONE = '+15550100071';
const LANDLORD_PHONE = '+15550100072';
const THREAD_ID = 'conv-preview-fallback';
const STAMP = '2026-07-01T00:00:00.000Z';
const MEMBERS: ConversationParticipant[] = [
  { contactId: 'c-tenant', phone: TENANT_PHONE, name: 'Tina Tenant' },
  { contactId: 'c-land', phone: LANDLORD_PHONE, name: 'Larry Land' },
];

describe('RosterPreview.introFallback (primary-contact-integrity spec 5.2)', () => {
  let world: FakeWorld;

  beforeEach(async () => {
    world = createFakeWorld();
    world.contacts.push(
      {
        contactId: 'c-tenant',
        type: 'tenant',
        phone: TENANT_PHONE,
        firstName: 'Tina',
        lastName: 'Tenant',
        sms_opt_out: false,
      },
      {
        contactId: 'c-land',
        type: 'landlord',
        phone: LANDLORD_PHONE,
        firstName: 'Larry',
        lastName: 'Land',
        sms_opt_out: false,
      },
    );
    // 470 Bolton's shape: a street, no landlord of record, nobody on the roster.
    world.units.set('unit-zero', {
      unitId: 'unit-zero',
      status: 'available',
      address: { line1: '470 Bolton Rd', city: 'Atlanta', state: 'GA', zip: '30318' },
      contacts: [],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    world.units.set('unit-ok', {
      unitId: 'unit-ok',
      landlordId: 'c-land',
      status: 'available',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30314' },
      contacts: [{ contactId: 'c-land', role: 'landlord', primaryContact: true }],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    for (const [tourId, unitId] of [
      ['tour-zero', 'unit-zero'],
      ['tour-ok', 'unit-ok'],
    ] as const) {
      world.toursMap.set(tourId, {
        tourId,
        tenantId: 'c-tenant',
        unitId,
        scheduledAt: TOUR_AT,
        status: 'scheduled',
        tourType: 'landlord_led',
        created_at: STAMP,
        updated_at: STAMP,
      } as never);
    }
    // The participants source: resolveRoster reads this thread's members, so no
    // default roster is needed. buildOpenPreview is called DIRECTLY (the route
    // refuses once a thread exists), exactly as rosterEdits.test.ts does.
    world.conversations.set(THREAD_ID, {
      conversationId: THREAD_ID,
      status: 'open',
      last_activity_at: STAMP,
      type: 'relay_group',
      ai_mode: 'auto',
      created_at: STAMP,
      participants: MEMBERS,
    });
    await world.settingsRepo.putOrgSettings({ timezone: 'America/New_York' });
  });

  function deps(): RosterResolutionDeps {
    return {
      conversations: world.conversationsRepo,
      units: world.unitsRepo,
      contacts: world.contactsRepo,
      tours: world.toursRepo,
      placements: world.placementsRepo,
      settings: world.settingsRepo,
      log: createLogger({ destination: createLogCapture().stream }),
    };
  }

  function tourOwner(tourId: string, unitId: string): RosterOwner {
    return { type: 'tour', id: tourId, tenantId: 'c-tenant', unitId, groupThreadId: THREAD_ID };
  }

  it('the OPEN preview carries the resolver introFallback when the owner falls back to the general intro', async () => {
    const outcome = await buildOpenPreview(deps(), tourOwner('tour-zero', 'unit-zero'), QUIET_OFF);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview.body).toContain("You're now connected with");
    expect(outcome.preview.introFallback).toEqual({
      reasons: ['no_property_contact'],
      unitId: 'unit-zero',
      street: '470 Bolton Rd',
    });
  });

  it('the OPEN preview carries NO introFallback when the tour intro composes', async () => {
    const outcome = await buildOpenPreview(deps(), tourOwner('tour-ok', 'unit-ok'), QUIET_OFF);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview.body).toContain('Putting you in a group text with Larry');
    expect(outcome.preview.introFallback).toBeUndefined();
  });

  it('the STANDALONE preview never carries introFallback', async () => {
    const preview = await buildStandaloneOpenPreview(
      { contacts: world.contactsRepo, conversations: world.conversationsRepo },
      MEMBERS,
      QUIET_OFF,
    );
    expect(preview.introFallback).toBeUndefined();
  });

  it('the ADD-MEMBER preview never carries introFallback, even on an owner whose intro falls back', async () => {
    const outcome = await buildAddPreview(
      deps(),
      tourOwner('tour-zero', 'unit-zero'),
      { contactId: 'c-new', phone: '+15550100073', name: 'Nia New', optedOut: false },
      QUIET_OFF,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview.introFallback).toBeUndefined();
  });
});
