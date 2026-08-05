// Masked-call landlord-leg routing (M1.10d) — a tenant->landlord masked call on
// a CASE-linked relay dials the unit's primary_contact (resolved at call
// time), with the roster SMS number as the fallback. The landlord->tenant
// direction and non-placement relays never substitute; texts are unaffected. The
// callerId=pool / do-not-record / no-leak guardrails stay intact throughout.
import { describe, expect, it } from 'vitest';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  signedTwilioPost,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

void ORIGIN_SECRET; // signedTwilioPost sets the origin header itself

const POOL = '+15550109000';
const TENANT = '+15550100001'; // caller (the placement tenant)
const LANDLORD_SMS = '+15550100002'; // the landlord's roster SMS number
const VOICE_CONTACT = '+15550100099'; // the unit's primary_contact (e.g. a PM)

function seedPlacementRelay(
  world: FakeWorld,
  opts: {
    primaryContact?: string;
    linkPlacement?: boolean;
    voiceContactHasPhone?: boolean;
    voiceContactPhone?: string;
  } = {},
): void {
  const {
    primaryContact,
    linkPlacement = true,
    voiceContactHasPhone = true,
    voiceContactPhone = VOICE_CONTACT,
  } = opts;
  world.contacts.push({ contactId: 'c-tenant', type: 'tenant', phone: TENANT });
  world.contacts.push({ contactId: 'c-landlord', type: 'landlord', phone: LANDLORD_SMS });
  world.contacts.push({ contactId: 'c-pm', type: 'landlord', ...(voiceContactHasPhone && { phone: voiceContactPhone }) });
  world.units.set('unit-vr', {
    unitId: 'unit-vr',
    landlordId: 'c-landlord',
    status: 'available',
    ...(primaryContact !== undefined && { primary_contact: primaryContact }),
  });
  if (linkPlacement) {
    world.placements.set('placement-vr', {
      placementId: 'placement-vr',
      tenantId: 'c-tenant',
      unitId: 'unit-vr',
      stage: 'awaiting_approval',
    });
  }
  const now = new Date().toISOString();
  world.conversations.set('conv-vr', {
    conversationId: 'conv-vr',
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: now,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-tenant', phone: TENANT, name: 'Tenant' },
      { contactId: 'c-landlord', phone: LANDLORD_SMS, name: 'Landlord' },
    ],
    created_at: now,
    ...(linkPlacement && { placementId: 'placement-vr' }),
  });
}

function inboundVoice(from: string): Record<string, string> {
  return {
    CallSid: 'CAvr0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: from,
    To: POOL,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
}

describe('masked-call landlord-leg routing (M1.10d)', () => {
  it('tenant->landlord on a placement-linked relay dials unit.primary_contact, not the roster SMS number', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm' });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.status).toBe(200);
    const xml = res.text;
    // Guardrails unchanged: callerId is the pool number, masked, do-not-record.
    expect(xml).toContain(`callerId="${POOL}"`);
    expect(xml).toContain('record="do-not-record"');
    // The landlord leg dials the primary_contact (the PM), NOT the roster #.
    expect(xml).toContain(VOICE_CONTACT);
    expect(xml).not.toContain(LANDLORD_SMS);
    expect(xml).not.toContain(TENANT); // never the caller's own number
  });

  it('falls back to the roster SMS number when the unit has no primary_contact', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {}); // no primary_contact set
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS); // roster fallback
    expect(xml).not.toContain(VOICE_CONTACT);
  });

  it('landlord->tenant never substitutes (the tenant leg dials the roster number)', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm' });
    const { app } = makeWebhookHarness({ world });

    // The LANDLORD calls the pool → destination is the tenant → no override.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(LANDLORD_SMS));
    const xml = res.text;
    expect(xml).toContain(TENANT); // dials the tenant (roster)
    expect(xml).not.toContain(VOICE_CONTACT);
  });

  it('a relay with NO placement link never substitutes (roster number)', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm', linkPlacement: false });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
  });

  it('falls back to the roster number when primary_contact has no phone on file', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm', voiceContactHasPhone: false });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.text).toContain(LANDLORD_SMS); // roster fallback, no empty <Number>
  });

  it('never bridges the tenant to themselves if primary_contact resolves to the caller', async () => {
    const world = createFakeWorld();
    // Misconfig: the unit's primary contact's phone IS the tenant's own number.
    seedPlacementRelay(world, { primaryContact: 'c-pm', voiceContactPhone: TENANT });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    // The self-bridge guard skips the override → dials the roster landlord, and
    // the caller's own number is never a <Number> destination.
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(TENANT);
  });

  it('is best-effort: a placement/unit lookup failure falls back to the roster number (never 5xxs)', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm' });
    const { app } = makeWebhookHarness({ world });
    // A DynamoDB blip during routing resolution must degrade to the roster dial,
    // never crash the bridge.
    world.placementsRepo.getById = async () => {
      throw new Error('dynamo blip');
    };

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS); // roster fallback
    expect(xml).not.toContain(VOICE_CONTACT);
    expect(xml).toContain(`callerId="${POOL}"`); // guardrail intact on the fallback
  });
});

// BE3/C3 cross-cutting: the roster's ☎ primaryContact drives the SAME scalar
// (primary_contact) the masked-call bridge reads. Setting a roster contact
// as primaryContact must therefore route the landlord leg to that contact; a
// roster-less unit (no primaryContact ever set) must still route to landlordId.
describe('BE3 roster primaryContact ↔ masked-call routing consistency', () => {
  it('setting a roster contact as primaryContact routes the landlord leg to that contact', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {}); // no primary_contact seeded
    // The operator adds the PM to the roster as the ☎ primary — this is what
    // the route does on POST /api/units/:id/contacts.
    await world.unitsRepo.addContact('unit-vr', {
      contactId: 'c-pm',
      role: 'pm',
      primaryContact: true,
    });
    // The primary_contact scalar is now the PM (the roster ☎ primary).
    expect(world.units.get('unit-vr')?.primary_contact).toBe('c-pm');

    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain(VOICE_CONTACT); // dials the PM (the roster ☎ primary)
    expect(xml).not.toContain(LANDLORD_SMS);
    expect(xml).toContain(`callerId="${POOL}"`);
  });

  it('a roster-less unit still routes the landlord leg to the legacy landlordId', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {}); // no roster, no primary_contact
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
  });
});
