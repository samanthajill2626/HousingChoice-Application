// Cast seed items — hand-authored story personas covering the full sequence-
// diagram states per the clean-slate design spec §4 and task-3-brief.md.
//
// Each persona freezes a realistic mid-flow snapshot with a real thread.
// Phones from the +1555010010X block (0101..0109).
// Fixed IDs: contact-cast-<slug>, conv-cast-<slug>, etc.
// All dates are fixed past ISO strings (NO now-relative — that is Task 4/live.ts).
//
// Tri-alignment requirement: phones here ↔ SEEDED_PERSONAS in fake-twilio ↔
// conversation participant_phone. The drift-alarm test (app/test/seedPersonaDrift.test.ts)
// enforces the alignment.

import { CAST_RECORDING_KEY, CAST_PHOTO_KEY } from './media.js';

// ---------------------------------------------------------------------------
// Fixed past timestamps (byte-stable across reseeds)
// ---------------------------------------------------------------------------
const C0 = '2026-05-01T09:00:00.000Z';
const C1 = '2026-05-01T09:05:00.000Z';
const C2 = '2026-05-01T09:10:00.000Z';
const C3 = '2026-05-01T09:15:00.000Z';
const C4 = '2026-05-01T09:20:00.000Z';
const C5 = '2026-05-01T09:25:00.000Z';
const C6 = '2026-05-01T09:30:00.000Z';
const C7 = '2026-05-01T09:35:00.000Z';
const C8 = '2026-05-02T10:00:00.000Z';
const C9 = '2026-05-02T10:05:00.000Z';
const CA = '2026-05-02T10:10:00.000Z';
const CB = '2026-05-02T10:15:00.000Z';
const CC = '2026-05-02T10:20:00.000Z';
const CD = '2026-05-03T11:00:00.000Z';
const CE = '2026-05-03T11:05:00.000Z';
const CF = '2026-05-03T11:10:00.000Z';
const CG = '2026-05-03T11:15:00.000Z';
const CH = '2026-05-04T13:00:00.000Z';
const CI = '2026-05-04T13:05:00.000Z';
const CJ = '2026-05-04T13:10:00.000Z';
const CK = '2026-05-05T14:00:00.000Z';
const CL = '2026-05-05T14:05:00.000Z';
const CM = '2026-05-05T14:10:00.000Z';
const CN = '2026-05-06T08:00:00.000Z';
const CO = '2026-05-06T08:05:00.000Z';
const CP = '2026-05-06T08:10:00.000Z';
const CQ = '2026-05-07T09:00:00.000Z';
const CR = '2026-05-07T09:05:00.000Z';
const CS = '2026-05-07T09:10:00.000Z';
const CT = '2026-05-07T09:15:00.000Z';
const CU = '2026-05-07T09:20:00.000Z';
const CV = '2026-05-08T10:00:00.000Z';
const CW = '2026-05-08T10:05:00.000Z';
const CX = '2026-05-08T10:10:00.000Z';
const CY = '2026-05-08T10:15:00.000Z';
const CZ = '2026-05-09T11:00:00.000Z';

// ---------------------------------------------------------------------------
// Contact / Conversation / Message ID helpers
// ---------------------------------------------------------------------------
// Cast contact IDs must use the pattern contact-cast-<slug> to avoid
// collisions with lean (contact-*-0001) and matrix (contact-mx-*-NN).

const contactId = (slug: string) => `contact-cast-${slug}`;
const convId = (slug: string) => `conv-cast-${slug}`;
const unitId = (slug: string) => `unit-cast-${slug}`;
const tourId = (slug: string) => `tour-cast-${slug}`;
const reminderId = (slug: string, kind: string) => `reminder-cast-${slug}-${kind}`;
const poolNum = (slug: string) => `pool-cast-${slug}`;
const listingSendId = (unit: string, tenant: string) => `${unitId(unit)}#${contactId(tenant)}`;

// ---------------------------------------------------------------------------
// Phone numbers — +1555010010X block (0101..0109)
// Never collides with lean (+15550100001–3) or matrix (+15550200XXX).
// ---------------------------------------------------------------------------
const PHONES = {
  unknownTexter:     '+15550100101',
  midIntakeTenant:   '+15550100102',
  parkedNoRta:       '+15550100103',
  searchingTenant:   '+15550100104',
  searchingSecond:   '+15550100105', // second number for multi-phone searching tenant
  touredYes:         '+15550100106',
  coldCallLandlord:  '+15550100107',
  neverSigned:       '+15550100108',
  parkedLandlord:    '+15550100109',
  // mid-intake unit landlord reuses the parked landlord unit for the pool, and
  // has its own phone in the +1555010011X sub-block (no persona, not drivable)
  midIntakeLandlord: '+15550100110',
} as const;

// ---------------------------------------------------------------------------
// Pool number phone for the searching tenant's relay group.
// Must be distinct from all contact phones. Use a +1555015xxxx sub-range.
// ---------------------------------------------------------------------------
const RELAY_POOL_PHONE = '+15550150101';

// ---------------------------------------------------------------------------
// CAST PERSONA 1: Unknown Texter
// Triage front door: type=unknown, status=needs_review
// One inbound SMS in an unknown_1to1 conversation → inbound_text auto-consent
// (the inbound text confers it; triage state is independent of consent).
// sms_opt_out: true (one of the required flag demo targets)
// ---------------------------------------------------------------------------
const SLUG_UNKNOWN = 'unknown-texter';
const C_UNKNOWN = contactId(SLUG_UNKNOWN);
const CONV_UNKNOWN = convId(SLUG_UNKNOWN);

const unknownTexter = {
  contact: {
    contactId: C_UNKNOWN,
    type: 'unknown',
    status: 'needs_review',
    phone: PHONES.unknownTexter,
    firstName: 'Alexis',
    lastName: 'Monroe',
    sms_opt_out: true, // flag demo: blocked proactive-send
    capture_source: 'inbound_sms',
    captured_at: C0,
    // Auto-consent: their inbound text (msg-cast-unk-001 at C0) confers inbound_text
    // per the app's rule. The unknown/needs_review triage state is independent of it.
    consent_method: 'inbound_text',
    consent_at: C0,
    created_at: C0,
  },
  conversation: {
    conversationId: CONV_UNKNOWN,
    participant_phone: PHONES.unknownTexter,
    status: 'open',
    last_activity_at: C0,
    type: 'unknown_1to1',
    participants: [C_UNKNOWN],
    participant_display_name: 'Alexis Monroe',
    last_message_preview: 'Is this property still available?',
    created_at: C0,
  },
  // phone-claim item so the conversation is findable by phone
  phoneClaimRow: {
    conversationId: `phone#${PHONES.unknownTexter}`,
    ref_conversationId: CONV_UNKNOWN,
  },
  messages: [
    {
      conversationId: CONV_UNKNOWN,
      tsMsgId: `${C0}#msg-cast-unk-001`,
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      body: 'Is this property still available?',
      delivery_status: 'delivered',
      ts: C0,
    },
  ],
};

// ---------------------------------------------------------------------------
// CAST PERSONA 2: Mid-Intake Tenant
// Flow: onboarding; pets answered; evictions/tenure pending in-thread
// consent: inbound_text (auto-stamped on first reply)
// ---------------------------------------------------------------------------
const SLUG_INTAKE = 'mid-intake-tenant';
const C_INTAKE = contactId(SLUG_INTAKE);
const CONV_INTAKE = convId(SLUG_INTAKE);

const midIntakeTenant = {
  contact: {
    contactId: C_INTAKE,
    type: 'tenant',
    status: 'onboarding',
    status_source: 'manual',
    phone: PHONES.midIntakeTenant,
    firstName: 'Destiny',
    lastName: 'Holloway',
    housingAuthority: 'dekalb_housing',
    voucherSize: 3,
    voucher_program: 'HCV',
    porting: false,
    consent_method: 'inbound_text',
    consent_at: C8,
    created_at: C8,
    // pets answered; evictions/tenure still pending → partial intake
    pets: 'No pets',
  },
  conversation: {
    conversationId: CONV_INTAKE,
    participant_phone: PHONES.midIntakeTenant,
    status: 'open',
    last_activity_at: CB,
    type: 'tenant_1to1',
    participants: [C_INTAKE],
    participant_display_name: 'Destiny Holloway',
    last_message_preview: 'No, I do not have pets.',
    created_at: C8,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.midIntakeTenant}`,
    ref_conversationId: CONV_INTAKE,
  },
  messages: [
    {
      conversationId: CONV_INTAKE,
      tsMsgId: `${C8}#msg-cast-intake-001`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Hi, I saw your number from a friend. I have a Section 8 voucher for 3 bedrooms.',
      delivery_status: 'delivered',
      ts: C8,
    },
    {
      conversationId: CONV_INTAKE,
      tsMsgId: `${C9}#msg-cast-intake-002`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Destiny! Great to hear from you. Can you share your full name, voucher size, and housing authority?',
      delivery_status: 'delivered',
      ts: C9,
    },
    {
      conversationId: CONV_INTAKE,
      tsMsgId: `${CA}#msg-cast-intake-003`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Destiny Holloway, 3 bedroom, DeKalb Housing Authority.',
      delivery_status: 'delivered',
      ts: CA,
    },
    {
      conversationId: CONV_INTAKE,
      tsMsgId: `${CB}#msg-cast-intake-004`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Thanks! Do you have any pets?',
      delivery_status: 'delivered',
      ts: CB,
    },
    {
      conversationId: CONV_INTAKE,
      tsMsgId: `${CC}#msg-cast-intake-005`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'No, I do not have pets.',
      delivery_status: 'delivered',
      ts: CC,
    },
    // Evictions question outbound — answer pending (thread ends here)
    {
      conversationId: CONV_INTAKE,
      tsMsgId: `${CD}#msg-cast-intake-006`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Any past evictions in the last 5 years?',
      delivery_status: 'delivered',
      ts: CD,
    },
  ],
};

// ---------------------------------------------------------------------------
// CAST PERSONA 3: Parked No-RTA Tenant
// RTA gate = no; porting: true; intake complete in-thread
// consent: web_form + consent_version
// ---------------------------------------------------------------------------
const SLUG_PARKED_NORTA = 'parked-norta-tenant';
const C_PARKED_NORTA = contactId(SLUG_PARKED_NORTA);
const CONV_PARKED_NORTA = convId(SLUG_PARKED_NORTA);

const parkedNoRtaTenant = {
  contact: {
    contactId: C_PARKED_NORTA,
    type: 'tenant',
    status: 'on_hold',
    status_source: 'manual',
    phone: PHONES.parkedNoRta,
    firstName: 'Jamal',
    lastName: 'Okonkwo',
    housingAuthority: 'fulton_housing',
    voucherSize: 2,
    voucher_program: 'HCV',
    porting: true,
    pets: 'No pets',
    evictions: 'None in last 5 years',
    tenure: 'Renting month-to-month',
    consent_method: 'web_form',
    consent_at: CE,
    consent_version: 'ctia-2026-06',
    created_at: CE,
  },
  conversation: {
    conversationId: CONV_PARKED_NORTA,
    participant_phone: PHONES.parkedNoRta,
    status: 'open',
    last_activity_at: CJ,
    type: 'tenant_1to1',
    participants: [C_PARKED_NORTA],
    participant_display_name: 'Jamal Okonkwo',
    last_message_preview: 'OK, we will reach out as soon as your RTA comes in.',
    created_at: CE,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.parkedNoRta}`,
    ref_conversationId: CONV_PARKED_NORTA,
  },
  messages: [
    {
      conversationId: CONV_PARKED_NORTA,
      tsMsgId: `${CE}#msg-cast-norta-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Jamal! Thanks for signing up. Do you have your RTA voucher in hand?',
      delivery_status: 'delivered',
      ts: CE,
    },
    {
      conversationId: CONV_PARKED_NORTA,
      tsMsgId: `${CF}#msg-cast-norta-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Not yet, still waiting on Fulton to issue it. Should be a few weeks.',
      delivery_status: 'delivered',
      ts: CF,
    },
    {
      conversationId: CONV_PARKED_NORTA,
      tsMsgId: `${CG}#msg-cast-norta-003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'No worries! Any evictions in the last 5 years?',
      delivery_status: 'delivered',
      ts: CG,
    },
    {
      conversationId: CONV_PARKED_NORTA,
      tsMsgId: `${CH}#msg-cast-norta-004`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'No evictions. Currently month-to-month.',
      delivery_status: 'delivered',
      ts: CH,
    },
    {
      conversationId: CONV_PARKED_NORTA,
      tsMsgId: `${CI}#msg-cast-norta-005`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Perfect. We will hold your spot and reach out as soon as your RTA arrives.',
      delivery_status: 'delivered',
      ts: CI,
    },
    {
      conversationId: CONV_PARKED_NORTA,
      tsMsgId: `${CJ}#msg-cast-norta-006`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Thank you!',
      delivery_status: 'delivered',
      ts: CJ,
    },
  ],
};

// ---------------------------------------------------------------------------
// CAST PERSONA 4: Searching Tenant (multi-phone + relay group + requested tour)
// - Rich preferences_notes from feedback
// - 2 listing_sends (one "too many stairs" reply)
// - requested landlord_led tour with tour-owned relay_group conversation
// - Pool number row bound to the relay conversation
// - consent: inbound_call
// - sms_unreachable: true (flag demo)
// - Second phone number → pointer row (phoneref#<E164>)
// ---------------------------------------------------------------------------
const SLUG_SEARCHING = 'searching-tenant';
const C_SEARCHING = contactId(SLUG_SEARCHING);
const CONV_SEARCHING_1TO1 = convId('searching-tenant-1to1');
const CONV_SEARCHING_RELAY = convId('searching-tenant-relay');
const TOUR_SEARCHING = tourId(SLUG_SEARCHING);
const UNIT_SEARCHING_A = 'unit-mx-available-01'; // available unit in matrix (reuse its ID)
// We create our own unit for this tenant so we don't couple to matrix ordering
const UNIT_CAST_SEARCHING = unitId('searching-a');

const searchingTenant = {
  contact: {
    contactId: C_SEARCHING,
    type: 'tenant',
    status: 'searching',
    status_source: 'manual',
    phone: PHONES.searchingTenant, // primary
    phones: [
      { phone: PHONES.searchingTenant, primary: true, label: 'Mobile', firstSeenAt: CK },
      { phone: PHONES.searchingSecond, primary: false, label: 'Home', firstSeenAt: CM },
    ],
    firstName: 'Monique',
    lastName: 'Everett',
    housingAuthority: 'atlanta_housing',
    voucherSize: 2,
    voucher_program: 'HCV',
    rta_expiration_date: '2026-09-30',
    porting: false,
    preferences_notes: 'No stairs (uses a walker); near MARTA; must fit a king-size bed; close to Grady Hospital.',
    consent_method: 'inbound_call',
    consent_at: CK,
    sms_unreachable: true, // flag demo
    created_at: CK,
  },
  // Pointer row for the second (non-primary) phone
  phonePointerRow: {
    contactId: `phoneref#${PHONES.searchingSecond}`,
    phone_ref: true,
    phone_ref_owner: C_SEARCHING,
  },
  unit: {
    unitId: UNIT_CAST_SEARCHING,
    landlordId: 'contact-landlord-0001', // seeded Marcus Bell
    status: 'available',
    status_source: 'manual',
    jurisdiction: 'atlanta_housing',
    address: '350 Boulevard SE, Atlanta, GA 30312',
    beds: 2,
    rent_min: 1500,
    rent_max: 1550,
    deposit: 1500,
    pets: 'No pets',
    tour_process: 'Landlord-led; text to schedule an appointment.',
    listing_link: 'https://example.com/listing/350-boulevard',
    created_at: CK,
  },
  // 1-to-1 conversation with the tenant
  conversation1to1: {
    conversationId: CONV_SEARCHING_1TO1,
    participant_phone: PHONES.searchingTenant,
    status: 'open',
    last_activity_at: CO,
    type: 'tenant_1to1',
    participants: [C_SEARCHING],
    participant_display_name: 'Monique Everett',
    last_message_preview: 'Too many stairs for me, but thank you for sending!',
    created_at: CK,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.searchingTenant}`,
    ref_conversationId: CONV_SEARCHING_1TO1,
  },
  // Relay group conversation for the requested landlord-led tour
  conversationRelay: {
    conversationId: CONV_SEARCHING_RELAY,
    participant_phone: RELAY_POOL_PHONE, // the pool number (synthetic)
    status: 'open',
    last_activity_at: CQ,
    type: 'relay_group',
    participants: [C_SEARCHING, 'contact-landlord-0001'],
    participant_display_name: 'Tour Group – Monique Everett',
    last_message_preview: "Hello! I'm Monique Everett. Looking forward to seeing the place.",
    pool_number: RELAY_POOL_PHONE,
    ai_mode: 'manual',
    owner: { type: 'tour', id: TOUR_SEARCHING },
    created_at: CQ,
  },
  // Pool number row bound to the relay conversation
  poolNumber: {
    poolNumber: RELAY_POOL_PHONE,
    lifecycle_state: 'assigned',
    quarantine_until: '0000-00-00T00:00:00.000Z', // sentinel for non-quarantined
    provisioned_via: 'console',
    voice_capable: true,
    sms_capable: true,
    assigned_conversation_id: CONV_SEARCHING_RELAY,
    provisioned_at: CQ,
    assigned_at: CQ,
  },
  // Requested tour (landlord_led; NO scheduledAt; ZERO reminder rows — invariant)
  tour: {
    tourId: TOUR_SEARCHING,
    tenantId: C_SEARCHING,
    unitId: UNIT_CAST_SEARCHING,
    status: 'requested',
    tourType: 'landlord_led',
    groupThreadId: CONV_SEARCHING_RELAY,
    createdAt: CQ,
    updatedAt: CQ,
    // scheduledAt MUST be ABSENT on 'requested' tours
  },
  messages1to1: [
    {
      conversationId: CONV_SEARCHING_1TO1,
      tsMsgId: `${CK}#msg-cast-srch-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Monique! We have a 2BR near MARTA in Vine City. Ground floor, washer/dryer hookups. $1,500/mo. Interested?',
      delivery_status: 'delivered',
      ts: CK,
    },
    {
      conversationId: CONV_SEARCHING_1TO1,
      tsMsgId: `${CL}#msg-cast-srch-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Too many stairs for me, but thank you for sending!',
      delivery_status: 'delivered',
      ts: CL,
    },
    {
      conversationId: CONV_SEARCHING_1TO1,
      tsMsgId: `${CM}#msg-cast-srch-003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Got it — no stairs. We will flag ground floor only for you. Added note: near Grady Hospital.',
      delivery_status: 'delivered',
      ts: CM,
    },
    {
      conversationId: CONV_SEARCHING_1TO1,
      tsMsgId: `${CN}#msg-cast-srch-004`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'New option: 350 Boulevard SE, Atlanta — 2BR ground floor, $1,500/mo, 0.4 mi from MARTA. Want to tour it?',
      delivery_status: 'delivered',
      ts: CN,
    },
    {
      conversationId: CONV_SEARCHING_1TO1,
      tsMsgId: `${CO}#msg-cast-srch-005`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Yes! That sounds great, I would love to see it.',
      delivery_status: 'delivered',
      ts: CO,
    },
  ],
  // Relay group messages (tour intro + scheduling negotiation)
  messagesRelay: [
    {
      conversationId: CONV_SEARCHING_RELAY,
      tsMsgId: `${CQ}#msg-cast-srch-relay-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: "Hello! I'm connecting you both for a tour of 350 Boulevard SE. Monique Everett (tenant) and Marcus Bell (landlord) — go ahead and find a time that works.",
      delivery_status: 'delivered',
      ts: CQ,
    },
    {
      conversationId: CONV_SEARCHING_RELAY,
      tsMsgId: `${CR}#msg-cast-srch-relay-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: "Hello! I'm Monique Everett. Looking forward to seeing the place.",
      delivery_status: 'delivered',
      relay_sender_key: C_SEARCHING,
      ts: CR,
    },
    {
      conversationId: CONV_SEARCHING_RELAY,
      tsMsgId: `${CS}#msg-cast-srch-relay-003`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: 'Hi Monique! Happy to show you the unit. Are you free this Saturday morning?',
      delivery_status: 'delivered',
      relay_sender_key: 'contact-landlord-0001',
      ts: CS,
    },
    {
      conversationId: CONV_SEARCHING_RELAY,
      tsMsgId: `${CT}#msg-cast-srch-relay-004`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Saturday works! What time?',
      delivery_status: 'delivered',
      relay_sender_key: C_SEARCHING,
      ts: CT,
    },
    {
      conversationId: CONV_SEARCHING_RELAY,
      tsMsgId: `${CU}#msg-cast-srch-relay-005`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: '10am work for you?',
      delivery_status: 'delivered',
      relay_sender_key: 'contact-landlord-0001',
      ts: CU,
    },
  ],
  // Listing sends (2: one not-a-fit reply, one pending)
  listingSend1: {
    unitId: unitId('searching-b'), // first unit sent (too-many-stairs one)
    contactId: C_SEARCHING,
    sentAt: CK,
    response: 'not_a_fit',
    via: 'individual',
    created_at: CK,
    updated_at: CL,
  },
  listingSendUnit1: {
    unitId: unitId('searching-b'),
    landlordId: 'contact-landlord-0001',
    status: 'available',
    status_source: 'manual',
    jurisdiction: 'atlanta_housing',
    address: '820 Angier Ave NE, Atlanta, GA 30308',
    beds: 2,
    rent_min: 1450,
    rent_max: 1450,
    deposit: 1450,
    pets: 'No pets',
    tour_process: 'Self-guided lockbox. Text to request code.',
    created_at: CK,
  },
  listingSend2: {
    unitId: UNIT_CAST_SEARCHING,
    contactId: C_SEARCHING,
    sentAt: CN,
    response: 'interested',
    via: 'individual',
    created_at: CN,
    updated_at: CO,
  },
};

// ---------------------------------------------------------------------------
// CAST PERSONA 5: Toured-Exit-YES Tenant
// tours exit gate: outcome move_forward, convertible; group-thread history
// consent: verbal_phone
// ---------------------------------------------------------------------------
const SLUG_TOURED_YES = 'toured-yes-tenant';
const C_TOURED_YES = contactId(SLUG_TOURED_YES);
const CONV_TOURED_1TO1 = convId('toured-yes-1to1');
const CONV_TOURED_RELAY = convId('toured-yes-relay');
const TOUR_TOURED = tourId(SLUG_TOURED_YES);
const UNIT_TOURED = unitId('toured-unit');
const RELAY_POOL_TOURED = '+15550150102';

const touredYesTenant = {
  contact: {
    contactId: C_TOURED_YES,
    type: 'tenant',
    status: 'searching', // stays searching even after convertible tour
    status_source: 'manual',
    phone: PHONES.touredYes,
    firstName: 'Brianna',
    lastName: 'Whitfield',
    housingAuthority: 'ga_dca',
    voucherSize: 3,
    voucher_program: 'HCV',
    porting: false,
    preferences_notes: 'Needs laundry in-unit; quiet neighborhood; near good schools.',
    consent_method: 'verbal_phone',
    consent_at: CV,
    created_at: CV,
  },
  unit: {
    unitId: UNIT_TOURED,
    landlordId: 'contact-landlord-0001',
    status: 'available',
    status_source: 'manual',
    jurisdiction: 'ga_dca',
    address: '44 Clifton Rd NE, Atlanta, GA 30329',
    beds: 3,
    rent_min: 1800,
    rent_max: 1850,
    deposit: 1800,
    pets: 'No dogs',
    tour_process: 'Landlord-led; call to schedule.',
    created_at: CV,
  },
  conversation1to1: {
    conversationId: CONV_TOURED_1TO1,
    participant_phone: PHONES.touredYes,
    status: 'open',
    last_activity_at: CZ,
    type: 'tenant_1to1',
    participants: [C_TOURED_YES],
    participant_display_name: 'Brianna Whitfield',
    last_message_preview: "I really liked it! Let's move forward.",
    created_at: CV,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.touredYes}`,
    ref_conversationId: CONV_TOURED_1TO1,
  },
  conversationRelay: {
    conversationId: CONV_TOURED_RELAY,
    participant_phone: RELAY_POOL_TOURED,
    status: 'open',
    last_activity_at: CY,
    type: 'relay_group',
    participants: [C_TOURED_YES, 'contact-landlord-0001'],
    participant_display_name: 'Tour Group – Brianna Whitfield',
    last_message_preview: 'See you at 2pm Saturday!',
    pool_number: RELAY_POOL_TOURED,
    ai_mode: 'manual',
    owner: { type: 'tour', id: TOUR_TOURED },
    created_at: CW,
  },
  poolNumber: {
    poolNumber: RELAY_POOL_TOURED,
    lifecycle_state: 'assigned',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    provisioned_via: 'console',
    voice_capable: true,
    sms_capable: true,
    assigned_conversation_id: CONV_TOURED_RELAY,
    provisioned_at: CW,
    assigned_at: CW,
  },
  // Tour: toured, outcome move_forward, convertible (no reminder rows — all sent already)
  tour: {
    tourId: TOUR_TOURED,
    tenantId: C_TOURED_YES,
    unitId: UNIT_TOURED,
    status: 'toured',
    tourType: 'landlord_led',
    scheduledAt: '2026-05-10T18:00:00.000Z',
    groupThreadId: CONV_TOURED_RELAY,
    outcome: 'move_forward',
    moveForward: true,
    convertible: true,
    createdAt: CW,
    updatedAt: CZ,
  },
  // Reminder rows: confirmation sent, day_before sent, morning_of sent (all history)
  reminders: [
    {
      reminderId: reminderId(SLUG_TOURED_YES, 'confirmation'),
      tourId: TOUR_TOURED,
      kind: 'confirmation',
      dueAt: CW,
      _reminderPartition: 'reminders',
      sentAt: CW,
      createdAt: CW,
    },
    {
      reminderId: reminderId(SLUG_TOURED_YES, 'day-before'),
      tourId: TOUR_TOURED,
      kind: 'day_before',
      dueAt: '2026-05-09T18:00:00.000Z',
      _reminderPartition: 'reminders',
      sentAt: '2026-05-09T18:00:00.000Z',
      createdAt: CW,
    },
    {
      reminderId: reminderId(SLUG_TOURED_YES, 'morning-of'),
      tourId: TOUR_TOURED,
      kind: 'morning_of',
      dueAt: '2026-05-10T08:00:00.000Z',
      _reminderPartition: 'reminders',
      sentAt: '2026-05-10T08:00:00.000Z',
      createdAt: CW,
    },
  ],
  messages1to1: [
    {
      conversationId: CONV_TOURED_1TO1,
      tsMsgId: `${CV}#msg-cast-toury-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Brianna! We have a 3BR near Emory that could be a great fit. Ground floor, laundry in-unit, $1,800/mo. Sound good?',
      delivery_status: 'delivered',
      ts: CV,
    },
    {
      conversationId: CONV_TOURED_1TO1,
      tsMsgId: `${CW}#msg-cast-toury-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Yes! Can I tour it this weekend?',
      delivery_status: 'delivered',
      ts: CW,
    },
    {
      conversationId: CONV_TOURED_1TO1,
      tsMsgId: `${CX}#msg-cast-toury-003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: "I've set up a group text with the landlord to coordinate the time.",
      delivery_status: 'delivered',
      ts: CX,
    },
    {
      conversationId: CONV_TOURED_1TO1,
      tsMsgId: `${CZ}#msg-cast-toury-004`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: "I really liked it! Let's move forward.",
      delivery_status: 'delivered',
      ts: CZ,
    },
  ],
  messagesRelay: [
    {
      conversationId: CONV_TOURED_RELAY,
      tsMsgId: `${CW}#msg-cast-toury-relay-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: "Hi all! I'm connecting Brianna Whitfield and Marcus Bell to set a tour time for 44 Clifton Rd NE.",
      delivery_status: 'delivered',
      ts: CW,
    },
    {
      conversationId: CONV_TOURED_RELAY,
      tsMsgId: `${CX}#msg-cast-toury-relay-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: 'Hi Brianna! How about Saturday at 2pm?',
      delivery_status: 'delivered',
      relay_sender_key: 'contact-landlord-0001',
      ts: CX,
    },
    {
      conversationId: CONV_TOURED_RELAY,
      tsMsgId: `${CY}#msg-cast-toury-relay-003`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'See you at 2pm Saturday!',
      delivery_status: 'delivered',
      relay_sender_key: C_TOURED_YES,
      ts: CY,
    },
  ],
};

// ---------------------------------------------------------------------------
// CAST PERSONA 6: Cold-Call Landlord Lead
// First touch pre-call: needs_review, phone only, NO thread (masked-call demo)
// voice_opt_out: false (this is the target — not opted out, so call is allowed)
// ---------------------------------------------------------------------------
const SLUG_COLD_CALL = 'cold-call-landlord';
const C_COLD_CALL = contactId(SLUG_COLD_CALL);

const coldCallLandlord = {
  contact: {
    contactId: C_COLD_CALL,
    type: 'landlord',
    status: 'needs_review',
    phone: PHONES.coldCallLandlord,
    firstName: 'Theodore',
    lastName: 'Vinson',
    voice_opt_out: false, // explicitly false — do-not-call flag demo target
    created_at: C0,
  },
  // No conversation — this is the pre-call state (masked-call demo target)
};

// ---------------------------------------------------------------------------
// CAST PERSONA 7: Never-Signed Landlord
// Contract limbo: interested, contract_status=unsigned, scheduling thread
// ---------------------------------------------------------------------------
const SLUG_NEVER_SIGNED = 'never-signed-landlord';
const C_NEVER_SIGNED = contactId(SLUG_NEVER_SIGNED);
const CONV_NEVER_SIGNED = convId(SLUG_NEVER_SIGNED);

const neverSignedLandlord = {
  contact: {
    contactId: C_NEVER_SIGNED,
    type: 'landlord',
    status: 'interested',
    phone: PHONES.neverSigned,
    firstName: 'Patricia',
    lastName: 'Shelton',
    contract_status: 'unsigned',
    expected_rent: 1700,
    registered_landlord: true,
    // Auto-consent: her inbound reply (msg-cast-nsign-002 at C2) confers inbound_text.
    consent_method: 'inbound_text',
    consent_at: C2,
    created_at: C1,
  },
  conversation: {
    conversationId: CONV_NEVER_SIGNED,
    participant_phone: PHONES.neverSigned,
    status: 'open',
    last_activity_at: C6,
    type: 'landlord_1to1',
    participants: [C_NEVER_SIGNED],
    participant_display_name: 'Patricia Shelton',
    last_message_preview: "I'll review the contract this week, I promise.",
    created_at: C1,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.neverSigned}`,
    ref_conversationId: CONV_NEVER_SIGNED,
  },
  messages: [
    {
      conversationId: CONV_NEVER_SIGNED,
      tsMsgId: `${C1}#msg-cast-nsign-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: "Hi Patricia! Great talking with you. I've sent the participation contract — can you sign this week so we can get started?",
      delivery_status: 'delivered',
      ts: C1,
    },
    {
      conversationId: CONV_NEVER_SIGNED,
      tsMsgId: `${C2}#msg-cast-nsign-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: "Got it, I'll take a look tonight.",
      delivery_status: 'delivered',
      ts: C2,
    },
    {
      conversationId: CONV_NEVER_SIGNED,
      tsMsgId: `${C3}#msg-cast-nsign-003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'No problem! Let me know if you have any questions.',
      delivery_status: 'delivered',
      ts: C3,
    },
    {
      conversationId: CONV_NEVER_SIGNED,
      tsMsgId: `${C4}#msg-cast-nsign-004`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Patricia — following up on the contract. Any chance to sign this week?',
      delivery_status: 'delivered',
      ts: C4,
    },
    {
      conversationId: CONV_NEVER_SIGNED,
      tsMsgId: `${C5}#msg-cast-nsign-005`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: "Sorry, been busy. I'll review the contract this week, I promise.",
      delivery_status: 'delivered',
      ts: C5,
    },
    {
      conversationId: CONV_NEVER_SIGNED,
      tsMsgId: `${C6}#msg-cast-nsign-006`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: 'Actually, I need more time to think about it.',
      delivery_status: 'delivered',
      ts: C6,
    },
  ],
};

// ---------------------------------------------------------------------------
// CAST PERSONA 8: Parked Landlord
// parked; park_reason: 'A property manager, not the owner'
// timeline: a completed recorded outbound masked call (type='call', recording_s3_key set)
// voice_opt_out: true (one required flag demo target)
// ---------------------------------------------------------------------------
const SLUG_PARKED_LL = 'parked-landlord';
const C_PARKED_LL = contactId(SLUG_PARKED_LL);
const CONV_PARKED_LL = convId(SLUG_PARKED_LL);

// The recording S3 key is referenced here; the actual object is seeded in Task 5.

const parkedLandlord = {
  contact: {
    contactId: C_PARKED_LL,
    type: 'landlord',
    status: 'parked',
    phone: PHONES.parkedLandlord,
    firstName: 'Raymond',
    lastName: 'Cordova',
    park_reason: 'A property manager, not the owner',
    voice_opt_out: true, // flag demo: do-not-call set after parking
    // Auto-consent: his inbound reply (msg-cast-park-003 at CB) confers inbound_text.
    // (The C7 masked call is OUTBOUND — confers nothing; voice_opt_out is independent
    // of SMS consent.)
    consent_method: 'inbound_text',
    consent_at: CB,
    created_at: C7,
  },
  conversation: {
    conversationId: CONV_PARKED_LL,
    participant_phone: PHONES.parkedLandlord,
    status: 'open',
    last_activity_at: CB,
    type: 'landlord_1to1',
    participants: [C_PARKED_LL],
    participant_display_name: 'Raymond Cordova',
    last_message_preview: 'Thanks for the call.',
    created_at: C7,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.parkedLandlord}`,
    ref_conversationId: CONV_PARKED_LL,
  },
  messages: [
    // Outbound masked call entry — completed, recorded (founder-bridge call)
    // masked: false because this is a founder-bridge (recorded) call, NOT a relay-pool masked call
    {
      conversationId: CONV_PARKED_LL,
      tsMsgId: `${C7}#msg-cast-park-001`,
      type: 'call',
      direction: 'outbound',
      author: 'teammate',
      body: '',
      call_status: 'completed',
      call_outcome: 'answered',
      started_at: C7,
      answered_at: C8,
      ended_at: C9,
      call_duration: 183,
      masked: false,
      call_party_label: 'Landlord Lead',
      recording_s3_key: CAST_RECORDING_KEY,
      recording_duration: 183,
      ts: C7,
    },
    {
      conversationId: CONV_PARKED_LL,
      tsMsgId: `${CA}#msg-cast-park-002`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Raymond, thanks for taking our call. We are looking for property owners in Atlanta willing to work with Section 8 vouchers.',
      delivery_status: 'delivered',
      ts: CA,
    },
    {
      conversationId: CONV_PARKED_LL,
      tsMsgId: `${CB}#msg-cast-park-003`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: 'Thanks for the call. I actually manage this property for the owner. You would need to talk to him directly.',
      delivery_status: 'delivered',
      ts: CB,
    },
  ],
};

// ---------------------------------------------------------------------------
// CAST PERSONA 9: Mid-Intake Unit Landlord
// landlord active/signed; unit setup (missing voucher_size_accepted)
// inbound MMS photo referencing a media key (seeded Task 5)
// Team follow-up outstanding
// ---------------------------------------------------------------------------
const SLUG_MID_INTAKE_LL = 'mid-intake-unit-landlord';
const C_MID_INTAKE_LL = contactId(SLUG_MID_INTAKE_LL);
const CONV_MID_INTAKE_LL = convId(SLUG_MID_INTAKE_LL);
const UNIT_MID_INTAKE = unitId(SLUG_MID_INTAKE_LL);

// MMS photo media key — the actual object is seeded in Task 5.
const midIntakeUnitLandlord = {
  contact: {
    contactId: C_MID_INTAKE_LL,
    type: 'landlord',
    status: 'active',
    phone: PHONES.midIntakeLandlord,
    firstName: 'Constance',
    lastName: 'Merritt',
    lead_status: 'registered',
    contract_status: 'signed',
    expected_rent: 1600,
    registered_landlord: true,
    rta_within_48h: true,
    pass_inspection_first_try: true,
    income_includes_voucher: true,
    authorities_served: ['atlanta_housing'],
    // Auto-consent: her inbound reply (msg-cast-milu-002 at CD) confers inbound_text.
    consent_method: 'inbound_text',
    consent_at: CD,
    created_at: CC,
  },
  unit: {
    unitId: UNIT_MID_INTAKE,
    landlordId: C_MID_INTAKE_LL,
    // status=setup: listing is incomplete — missing voucher_size_accepted
    status: 'setup',
    status_source: 'manual',
    jurisdiction: 'atlanta_housing',
    address: '2240 Donald Lee Hollowell Pkwy NW, Atlanta, GA 30318',
    beds: 2,
    rent_min: 1600,
    rent_max: 1600,
    deposit: 1600,
    pets: 'No pets',
    tour_process: 'Text landlord to arrange viewing.',
    // voucher_size_accepted is intentionally ABSENT (incomplete intake)
    created_at: CD,
  },
  conversation: {
    conversationId: CONV_MID_INTAKE_LL,
    participant_phone: PHONES.midIntakeLandlord,
    status: 'open',
    last_activity_at: CG,
    type: 'landlord_1to1',
    participants: [C_MID_INTAKE_LL],
    participant_display_name: 'Constance Merritt',
    last_message_preview: 'What voucher size does the property accept?',
    created_at: CC,
  },
  phoneClaimRow: {
    conversationId: `phone#${PHONES.midIntakeLandlord}`,
    ref_conversationId: CONV_MID_INTAKE_LL,
  },
  messages: [
    {
      conversationId: CONV_MID_INTAKE_LL,
      tsMsgId: `${CC}#msg-cast-milu-001`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: "Hi Constance! Can you send us the address and some photos of the unit so we can get it listed?",
      delivery_status: 'delivered',
      ts: CC,
    },
    {
      conversationId: CONV_MID_INTAKE_LL,
      tsMsgId: `${CD}#msg-cast-milu-002`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: '2240 Donald Lee Hollowell Pkwy NW, Atlanta, GA 30318. 2 bed, 1 bath. $1,600/mo.',
      delivery_status: 'delivered',
      ts: CD,
    },
    // MMS photo with media attachment (key references Task 5 seeded object)
    {
      conversationId: CONV_MID_INTAKE_LL,
      tsMsgId: `${CE}#msg-cast-milu-003`,
      type: 'mms',
      direction: 'inbound',
      author: 'landlord',
      body: 'Here is the exterior.',
      delivery_status: 'delivered',
      media_attachments: [{ s3Key: CAST_PHOTO_KEY, contentType: 'image/jpeg' }],
      ts: CE,
    },
    {
      conversationId: CONV_MID_INTAKE_LL,
      tsMsgId: `${CF}#msg-cast-milu-004`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Great photo! What voucher size does the property accept?',
      delivery_status: 'delivered',
      ts: CF,
    },
    // Thread ends here — follow-up outstanding (landlord has not replied yet)
    {
      conversationId: CONV_MID_INTAKE_LL,
      tsMsgId: `${CG}#msg-cast-milu-005`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'What voucher size does the property accept?',
      delivery_status: 'delivered',
      ts: CG,
    },
  ],
};

// ---------------------------------------------------------------------------
// Public export: merge all cast items into the table-base keyed record
// ---------------------------------------------------------------------------

/** Additional contacts/units/etc. that fill out the narrative cast beyond the
 *  lean base fixtures. Merged on top of SEED by seedAll('full'). */
export function castItems(): Record<string, Record<string, unknown>[]> {
  const contacts: Record<string, unknown>[] = [
    unknownTexter.contact,
    midIntakeTenant.contact,
    parkedNoRtaTenant.contact,
    searchingTenant.contact,
    searchingTenant.phonePointerRow,   // phoneref# pointer row (multi-phone)
    touredYesTenant.contact,
    coldCallLandlord.contact,
    neverSignedLandlord.contact,
    parkedLandlord.contact,
    midIntakeUnitLandlord.contact,
  ];

  const units: Record<string, unknown>[] = [
    searchingTenant.unit,
    searchingTenant.listingSendUnit1,
    touredYesTenant.unit,
    midIntakeUnitLandlord.unit,
  ];

  const conversations: Record<string, unknown>[] = [
    unknownTexter.conversation,
    unknownTexter.phoneClaimRow,
    midIntakeTenant.conversation,
    midIntakeTenant.phoneClaimRow,
    parkedNoRtaTenant.conversation,
    parkedNoRtaTenant.phoneClaimRow,
    searchingTenant.conversation1to1,
    searchingTenant.phoneClaimRow,
    searchingTenant.conversationRelay,
    touredYesTenant.conversation1to1,
    touredYesTenant.phoneClaimRow,
    touredYesTenant.conversationRelay,
    neverSignedLandlord.conversation,
    neverSignedLandlord.phoneClaimRow,
    parkedLandlord.conversation,
    parkedLandlord.phoneClaimRow,
    midIntakeUnitLandlord.conversation,
    midIntakeUnitLandlord.phoneClaimRow,
  ];

  const messages: Record<string, unknown>[] = [
    ...unknownTexter.messages,
    ...midIntakeTenant.messages,
    ...parkedNoRtaTenant.messages,
    ...searchingTenant.messages1to1,
    ...searchingTenant.messagesRelay,
    ...touredYesTenant.messages1to1,
    ...touredYesTenant.messagesRelay,
    ...neverSignedLandlord.messages,
    ...parkedLandlord.messages,
    ...midIntakeUnitLandlord.messages,
  ];

  const tours: Record<string, unknown>[] = [
    searchingTenant.tour,
    touredYesTenant.tour,
  ];

  const tourReminders: Record<string, unknown>[] = [
    ...touredYesTenant.reminders,
  ];

  const pool_numbers: Record<string, unknown>[] = [
    searchingTenant.poolNumber,
    touredYesTenant.poolNumber,
  ];

  const listing_sends: Record<string, unknown>[] = [
    searchingTenant.listingSend1,
    searchingTenant.listingSend2,
  ];

  return {
    contacts,
    units,
    conversations,
    messages,
    tours,
    tourReminders,
    pool_numbers,
    listing_sends,
  };
}

// ---------------------------------------------------------------------------
// Export the primary phones + IDs for the drift-alarm test
// ---------------------------------------------------------------------------
export const CAST_CONTACTS_FOR_DRIFT = [
  { contactId: C_UNKNOWN,     primaryPhone: PHONES.unknownTexter,    drivable: true },
  { contactId: C_INTAKE,      primaryPhone: PHONES.midIntakeTenant,  drivable: true },
  { contactId: C_PARKED_NORTA,primaryPhone: PHONES.parkedNoRta,      drivable: true },
  { contactId: C_SEARCHING,   primaryPhone: PHONES.searchingTenant,  drivable: true },
  { contactId: C_TOURED_YES,  primaryPhone: PHONES.touredYes,        drivable: true },
  { contactId: C_COLD_CALL,   primaryPhone: PHONES.coldCallLandlord, drivable: true },
  { contactId: C_NEVER_SIGNED,primaryPhone: PHONES.neverSigned,      drivable: true },
  { contactId: C_PARKED_LL,   primaryPhone: PHONES.parkedLandlord,   drivable: true },
  { contactId: C_MID_INTAKE_LL,primaryPhone: PHONES.midIntakeLandlord,drivable: false }, // no fake-twilio persona (internal landlord number)
] as const;
