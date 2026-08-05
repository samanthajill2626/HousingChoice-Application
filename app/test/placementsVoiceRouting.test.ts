// Masked-call routing follows the THREAD ROSTER, verbatim (contact-rosters D10).
//
// The bridge resolves callers/callees from `relay.participants` and dials the
// number stored on each row. There is no per-property substitution any more:
// the `landlordVoiceOverride` block (M1.10d) - which swapped the leg carrying
// `unit.landlordId` for the unit's `primary_contact` - is RETIRED, because it
// re-pointed the leg of an owner the operator deliberately KEPT on the roster,
// and (post-D2) voice and text can no longer point at different people anyway.
//
// A roster edit therefore moves CALLS as well as texts: the participants the
// People card edits are the participants this bridge already reads.
//
// The callerId=pool / do-not-record / no-leak guardrails, the callee filter
// (the caller is never a dial target) and the refusal cases are unchanged.
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
const TENANT = '+15550100001'; // the placement tenant
const LANDLORD_SMS = '+15550100002'; // the owner of record, ON the roster
const VOICE_CONTACT = '+15550100099'; // the unit's primary_contact (a PM), OFF the roster

function seedPlacementRelay(
  world: FakeWorld,
  opts: {
    primaryContact?: string;
    linkPlacement?: boolean;
    voiceContactHasPhone?: boolean;
    voiceContactPhone?: string;
    participants?: { contactId: string; phone: string; name?: string }[];
  } = {},
): void {
  const {
    primaryContact,
    linkPlacement = true,
    voiceContactHasPhone = true,
    voiceContactPhone = VOICE_CONTACT,
    participants = [
      { contactId: 'c-tenant', phone: TENANT, name: 'Tenant' },
      { contactId: 'c-landlord', phone: LANDLORD_SMS, name: 'Landlord' },
    ],
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
    participants,
    created_at: now,
    ...(linkPlacement && { placementId: 'placement-vr' }),
  });
}

function inboundVoice(from: string, callSid = 'CAvr0001'): Record<string, string> {
  return {
    CallSid: callSid,
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: from,
    To: POOL,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
}

describe('masked calls dial the thread roster (D10 - the substitution is retired)', () => {
  it('an owner KEPT on the roster is dialed on THEIR OWN number, even when the property primary is the PM', async () => {
    const world = createFakeWorld();
    // The motivating harm case: the operator kept the owner of record on this
    // thread, and the property's primary contact is somebody else (a PM). The
    // retired override would have silently re-pointed the owner's leg at the
    // PM - dialing a person the operator did not put in that slot.
    seedPlacementRelay(world, { primaryContact: 'c-pm' });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.status).toBe(200);
    const xml = res.text;
    // Guardrails unchanged: callerId is the pool number, masked, do-not-record.
    expect(xml).toContain(`callerId="${POOL}"`);
    expect(xml).toContain('record="do-not-record"');
    // The owner's leg dials the OWNER's own participant number.
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT); // the PM is not on this thread
    expect(xml).not.toContain(TENANT); // never the caller's own number
  });

  it('a tenant REMOVED from the roster is refused as a non-member, never bridged', async () => {
    const world = createFakeWorld();
    // The caseworker-to-PM arrangement: the tenant was removed from the thread.
    // Their call to the pool number must be refused like any other non-member.
    seedPlacementRelay(world, {
      primaryContact: 'c-pm',
      participants: [
        { contactId: 'c-landlord', phone: LANDLORD_SMS, name: 'Landlord' },
        { contactId: 'c-pm', phone: VOICE_CONTACT, name: 'Manager' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice',
      inboundVoice(TENANT, 'CAvrRemoved'),
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    // No bridge, and no number leaks in the refusal copy.
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain(TENANT);
    expect(xml).not.toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
    // The timeline is honest: a metadata-only, masked, missed call entry.
    const call = world.messages.find((m) => m.provider_sid === 'CAvrRemoved');
    expect(call?.type).toBe('call');
    expect(call?.masked).toBe(true);
    expect(call?.call_outcome).toBe('missed');
  });

  it('a unit with no primary_contact dials the roster number (unchanged)', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {}); // no primary_contact set
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
  });

  it('landlord->tenant dials the tenant roster number (unchanged)', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm' });
    const { app } = makeWebhookHarness({ world });

    // The LANDLORD calls the pool -> the tenant is the callee.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(LANDLORD_SMS));
    const xml = res.text;
    expect(xml).toContain(TENANT); // dials the tenant (roster)
    expect(xml).not.toContain(VOICE_CONTACT);
  });

  it('a relay with NO placement link dials the roster number (unchanged)', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm', linkPlacement: false });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
  });

  it('a phone-less primary_contact changes nothing - the roster number is dialed', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm', voiceContactHasPhone: false });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.text).toContain(LANDLORD_SMS); // no empty <Number>, ever
  });

  it('the caller is never a dial target (the surviving self-bridge protection is the callee filter)', async () => {
    const world = createFakeWorld();
    // A property misconfig where the primary contact's phone IS the tenant's own
    // number can no longer reach the bridge at all - but the callee filter
    // (participants minus From) is what actually guarantees no self-dial.
    seedPlacementRelay(world, { primaryContact: 'c-pm', voiceContactPhone: TENANT });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(TENANT);
  });

  it('a placements/units repo outage cannot affect the bridge - it reads neither', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, { primaryContact: 'c-pm' });
    const { app } = makeWebhookHarness({ world });
    // Both reads existed ONLY for the retired substitution. Breaking them proves
    // the bridge no longer depends on anything outside the thread itself.
    world.placementsRepo.getById = async () => {
      throw new Error('dynamo blip');
    };
    world.unitsRepo.getById = async () => {
      throw new Error('dynamo blip');
    };

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).toContain(`callerId="${POOL}"`);
  });
});

// The BE3/C3 cross-cutting claim is now the OPPOSITE of what it was: making a
// contact the property's primary contact re-points the DEFAULT roster (who a
// NEW group is opened with, and every text/call that follows), but it does not
// reach into a thread that already exists. Membership is a fact once texted
// (D1), so a live call leg only moves when the ROSTER moves.
describe('BE3 property primaryContact vs. a LIVE thread roster', () => {
  it('making a roster contact the property primary does NOT re-point an existing thread leg', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {}); // no primary_contact seeded; thread = tenant + owner
    // The operator adds the PM to the property roster as the primary contact -
    // exactly what POST /api/units/:id/contacts does.
    await world.unitsRepo.addContact('unit-vr', {
      contactId: 'c-pm',
      role: 'pm',
      primaryContact: true,
    });
    expect(world.units.get('unit-vr')?.primary_contact).toBe('c-pm');

    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    expect(res.status).toBe(200);
    const xml = res.text;
    // The live thread still says the owner, so the owner is dialed. Adding the
    // PM to the CALL means adding them to this roster (the People card).
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
    expect(xml).toContain(`callerId="${POOL}"`);
  });

  it('a PM ON the roster is dialed - the roster is the whole story', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {
      primaryContact: 'c-pm',
      participants: [
        { contactId: 'c-tenant', phone: TENANT, name: 'Tenant' },
        { contactId: 'c-pm', phone: VOICE_CONTACT, name: 'Manager' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(VOICE_CONTACT);
    expect(xml).not.toContain(LANDLORD_SMS); // the owner is not on this thread
  });

  it('a roster-less unit dials the thread roster all the same', async () => {
    const world = createFakeWorld();
    seedPlacementRelay(world, {}); // no roster, no primary_contact
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoice(TENANT));
    const xml = res.text;
    expect(xml).toContain(LANDLORD_SMS);
    expect(xml).not.toContain(VOICE_CONTACT);
  });
});
