// Lean seed: the canonical minimal dev/e2e fixture set.
//
// Moved verbatim from app/src/lib/seedData.ts (historical home) so the seed/
// module can compose profiles on top. Every item has a hardcoded id + stable
// timestamps so repeated runs write byte-identical rows (PutCommand idempotency;
// no table clears here — that is resetLocalData's job).
//
// Field-casing notes (enforced by app/test/seedData.test.ts):
//   - Contact name + voucher: camelCase (firstName/lastName/voucherSize/housingAuthority)
//   - Unit canonical names: beds/rent_min/rent_max/pets
//   - Status field: single `status` on contacts; single `stage` on placements

import { conversationIdForGroup } from '../import/ids.js';
import type { SeedConversationRow } from './types.js';

// Stable timestamps so re-runs write byte-identical items.
const T0 = '2026-06-01T14:00:00.000Z';
const T1 = '2026-06-01T14:02:10.000Z';
const T2 = '2026-06-01T14:05:45.000Z';
// Native group texting (S8/T8.2). DELIBERATELY EARLIER THAN T2 (adjudication
// A29): `last_activity_at` is the byLastActivity RANGE key, so a group thread
// timestamped after T2 would displace Tasha as the newest inbox row and quietly
// re-point every spec that reads the first one. Both new threads also carry
// `unread_count: 0` - a nonzero one would take up permanent residence in the
// Unread tab that inbox-markread.spec.ts exercises.
const TG0 = '2026-06-01T13:40:00.000Z';
const TG1 = '2026-06-01T13:42:30.000Z';
const TG2 = '2026-06-01T13:45:00.000Z';
const TC0 = '2026-06-01T13:30:00.000Z';
// matches TTL: epoch seconds for 2026-09-01T00:00:00Z (far enough out that
// DynamoDB Local's TTL sweep never deletes it mid-demo).
const MATCH_EXPIRES_AT = 1_787_270_400;

const IDS = {
  tenant: 'contact-tenant-0001',
  landlord: 'contact-landlord-0001',
  haStaffer: 'contact-hastaff-0001',
  unitA: 'unit-0001',
  unitB: 'unit-0002',
  conversation: 'conv-0001',
  placement: 'placement-0001',
  invoice: 'invoice-0001',
  founder: 'user-0001',
  va: 'user-0002',
} as const;

// ---------------------------------------------------------------------------
// Native group texting (group-texting spec 4.1 / 12)
// ---------------------------------------------------------------------------
//
// The ids are DERIVED, never hardcoded. A group thread's identity IS
// `uuidv5` over its sorted roster, and the import and the runtime must agree or
// the same carrier group yields two threads (invariant 13.5). Deriving here
// means a fixture can never drift from the function under test; it is still
// byte-stable, because the derivation is pure and the rosters are literals.
const GROUP_TEXT_MEMBERS = ['+15550100001', '+15550100002'] as const;
const GROUP_TEXT_ID = conversationIdForGroup([...GROUP_TEXT_MEMBERS]);

/**
 * THE CONVERSION FIXTURE: an imported relay group still waiting for a pool
 * number, which the migration turns into a native group text. Its id is derived
 * from its roster too, because `convertConnectingRelayGroupToGroupText` REFUSES
 * a thread whose id does not match its members (`roster_id_mismatch`) - the
 * guard that stops a conversion from minting a thread nobody can find again.
 *
 * It carries NO `pool_number`, which is what `connecting` means and is also a
 * conversion precondition.
 */
const CONNECTING_MEMBERS = ['+15550100002', '+15550100003'] as const;
const CONNECTING_GROUP_ID = conversationIdForGroup([...CONNECTING_MEMBERS]);

/** table base name -> items. Document-style: only keys/GSI attrs contractual.
 *  Exported so a unit test can guard the field CASING (the flexible-doc repos
 *  store any key, so a snake_case typo is silently persisted then never read).
 *  `conversations` is narrowed to SeedConversationRow so a roster written as
 *  bare contactId strings fails tsc (types.ts). */
export const SEED: Record<string, Record<string, unknown>[]> & {
  conversations: SeedConversationRow[];
} = {
  contacts: [
    {
      contactId: IDS.tenant,
      type: 'tenant', // byTypeStatus HASH
      // byTypeStatus RANGE — and the tenant's SINGLE §5 lifecycle status (one
      // field, not two). She is the tenant on the seeded placement placement-0001
      // (Inspection phase: awaiting_inspection), so by §7 derivation she reads
      // `placing`; source 'derived' so the denormalized value agrees with what
      // derivation produces and a future placement transition can still drive it
      // (a 'manual' pin would both disagree with §7 and block derivation — the
      // regression this seed must not reintroduce). Tenant lifecycle values live
      // in the type='tenant' partition, so they never pollute the triage queue
      // (type='unknown', status='needs_review').
      status: 'placing', // byTypeStatus RANGE = §5 tenant lifecycle
      status_source: 'derived', // §8 provenance — derivation-permitting
      phone: '+15550100001', // byPhone
      // Email-channel A1: BOTH the scalar (byEmail hash) and the emails[] array
      // (mirror how phone/phones[] are represented on read). Deterministic +
      // ASCII + stable so re-runs stay byte-identical.
      email: 'tasha.nguyen@example.com', // byEmail
      emails: [{ email: 'tasha.nguyen@example.com', primary: true }],
      housingAuthority: 'atlanta_housing', // byHousingAuthority (tenants only)
      // Name, voucher size, and housingAuthority are camelCase EVERYWHERE the app
      // reads them (contactFullName / displayNameOf / audienceResolution.voucherSizeOf;
      // the byHousingAuthority GSI hash key is `housingAuthority`); the flexible-doc
      // repo would silently store snake_case keys the UI then never finds, so seeded
      // contacts would render as their phone + miss bedroom-size broadcast targeting.
      // Keep these aligned with the live intake (routes/public.ts, routes/contacts.ts).
      firstName: 'Tasha',
      lastName: 'Nguyen',
      voucherSize: 2,
      voucher_program: 'HCV',
      rta_expiration_date: '2026-08-15',
      caseworker: 'D. Okafor',
      preferences_notes: 'Ground floor preferred; near MARTA.',
      // §5 porting flag (a flag, not a status): informational only — the
      // 2026-06-19 product decision REMOVED the RTA-in-hand→searching gate, so
      // `porting` no longer blocks any transition (the admin advances tenants).
      porting: false,
      // A2P/CTIA consent: her inbound reply (messages msg-0002 at T1, "Yes! Could we
      // do Saturday morning?") confers inbound_text consent per the app's own
      // auto-consent rule (services/contactCapture + webhooks/twilio) — so a proactive
      // send to her is NOT hard-blocked by the JIT consent gate. consent_at = the
      // instant of that first inbound message.
      consent_method: 'inbound_text',
      consent_at: T1,
      created_at: T0,
    },
    {
      contactId: IDS.landlord,
      type: 'landlord',
      status: 'active',
      phone: '+15550100002',
      // Email-channel A1: scalar (byEmail hash) + emails[] array, like the tenant.
      email: 'marcus.bell@example.com', // byEmail
      emails: [{ email: 'marcus.bell@example.com', primary: true }],
      firstName: 'Marcus',
      lastName: 'Bell',
      lead_status: 'registered',
      contract_status: 'signed',
      authorities_served: ['atlanta_housing', 'ga_dca'],
      // A2P/CTIA consent: a registered + contract-signed active landlord was
      // onboarded through a human conversation (and, in the full profile, texts us
      // inbound in the cast relay-group tours) — so he carries consent and proactive
      // texts to him are not JIT-gated. verbal_phone reflects the human onboarding
      // (his earliest consent basis, at contact creation). Renee (the HA staffer
      // below) is left with NO consent: she has no message thread with us.
      consent_method: 'verbal_phone',
      consent_at: T0,
      created_at: T0,
    },
    {
      contactId: IDS.haStaffer,
      // `partner` (retyped 2026-08-24): an OUTSIDE agency contact, which is what
      // the glossary defines partner to mean. She spent two months as
      // `team_member` only because her ORIGINAL type (`housing_authority_staff`)
      // was never a valid ContactType at all, and the 2026-06-18 triage picked
      // the least-wrong bucket that existed before `partner` did (2026-07-21).
      // team_member is the internal-staff bucket - excluded from audience
      // fan-out, no 1:1 lifecycle - so the mistype quietly hid her from every
      // outside-contact surface. See
      // docs/issues/lean-seed-ha-staffer-should-be-partner.md.
      type: 'partner',
      status: 'active',
      phone: '+15550100003',
      firstName: 'Renee',
      lastName: 'Carter',
      housingAuthority: 'atlanta_housing',
      role_title: 'HCV Program Specialist',
      created_at: T0,
    },
  ],
  units: [
    {
      unitId: IDS.unitA,
      landlordId: IDS.landlord, // byLandlord
      // status MUST be a LISTING_STATUSES value (setup|available|under_application
      // |finalizing|occupied|on_hold|off_market) — it's the byStatus GSI key AND
      // gates the public flyer (only 'available' is shareable, §6). beds /
      // rent_min / rent_max / pets are the canonical field
      // names the app reads (unitFields WRITABLE_FIELDS + toUnitFlyer + the
      // dashboard UnitItem); the flexible-doc repo would silently store
      // bedrooms / rent / pets_allowed and the UI would never find them.
      // unitA is the unit on the seeded placement placement-0001 (Inspection phase:
      // awaiting_inspection), so by §7 derivation the property reads
      // 'under_application', source 'derived' (NOT 'manual') — the denormalized
      // value matches what derivation produces and stays drivable. (Stamping
      // 'manual' here would disagree with §7 AND block the first derived write.)
      status: 'under_application', // byStatus
      status_source: 'derived', // §8 provenance — derivation-permitting
      accepted_authorities: ['atlanta_housing'], // accepted authorities (spec section 8)
      address: '1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314',
      beds: 2,
      rent_min: 1650,
      rent_max: 1650,
      deposit: 1650,
      pets: 'No pets',
      tour_process: 'Text landlord; lockbox tours weekdays 9-5.',
      created_at: T0,
    },
    {
      unitId: IDS.unitB,
      landlordId: IDS.landlord,
      // Status-model (§6): the placed unit is now `occupied` (replaced legacy
      // 'placed'); legacy 'inactive' would map to 'off_market'. final_rent is
      // the accepted rent written at rent-acceptance (used for billing, §4).
      // DELIBERATE manual override: unitB is NOT the unit on the active seeded
      // placement (placement-0001 → unitA), so there is no placement to derive it;
      // 'manual' here is an intentional demo pin of a previously-placed unit,
      // not the regression (which was pinning a freshly-derivable property).
      status: 'occupied',
      status_source: 'manual',
      final_rent: 1975,
      accepted_authorities: ['ga_dca'],
      address: '88 Sycamore St, Decatur, GA 30030',
      beds: 3,
      rent_min: 1975,
      rent_max: 1975,
      deposit: 1975,
      pets: 'Cats & dogs OK',
      created_at: T0,
    },
  ],
  conversations: [
    {
      conversationId: IDS.conversation,
      participant_phone: '+15550100001', // byParticipantPhone (the tenant)
      status: 'open', // byLastActivity HASH
      last_activity_at: T2, // byLastActivity RANGE
      type: 'tenant_1to1',
      // ConversationParticipant object (the app-wide roster contract) — a bare
      // contactId string has no phone for consumers to read.
      participants: [{ contactId: IDS.tenant, phone: '+15550100001' }],
      last_message_preview: 'Saturday morning works great, thank you!',
      created_at: T0,
    },
    // A NATIVE CARRIER group text (type `group_text`). It lives in its OWN
    // byLastActivity partition (`group_open`) and carries none of relay's
    // mechanism - no `pool_number`, no `relay_status`, no `participant_phone`.
    // Nobody is masked here: everyone on a carrier group sees everyone's number.
    {
      conversationId: GROUP_TEXT_ID,
      status: 'group_open', // byLastActivity HASH - its own partition
      last_activity_at: TG2, // byLastActivity RANGE - see A29 above
      type: 'group_text',
      // A carrier group is staff-run in v1; `manual` matches relay groups and
      // keeps the automated-send breaker in its manual posture.
      ai_mode: 'manual',
      participants: [
        { contactId: IDS.tenant, phone: GROUP_TEXT_MEMBERS[0], name: 'Tasha Nguyen' },
        { contactId: IDS.landlord, phone: GROUP_TEXT_MEMBERS[1], name: 'Marcus Bell' },
      ],
      last_message_preview: 'Works for me - see you both there.',
      unread_count: 0,
      created_at: TG0,
    },
    // An imported relay group still CONNECTING (no pool number yet): the
    // conversion fixture the migration e2e drives to `group_text`.
    {
      conversationId: CONNECTING_GROUP_ID,
      status: 'connecting', // byLastActivity HASH
      relay_status: 'relay_group#connecting', // byRelayStatus HASH (sparse; relay only)
      last_activity_at: TC0,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: IDS.landlord, phone: CONNECTING_MEMBERS[0], name: 'Marcus Bell' },
        { contactId: IDS.haStaffer, phone: CONNECTING_MEMBERS[1], name: 'Renee Carter' },
      ],
      participant_display_name: 'Marcus Bell + Renee Carter',
      // Import provenance: the migration reports the connect flag, and keeping
      // it is what makes a re-run report the same thing rather than `false`.
      imported_from: 'quo',
      imported_at: TC0,
      import_connect_requested: true,
      last_message_preview: 'Imported group - waiting on a number.',
      unread_count: 0,
      created_at: TC0,
    },
  ],
  messages: [
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T0}#msg-0001`, // SK value shape: <ISO ts>#<msgId> (doc: ts#msgId)
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Tasha! A 2BR near MARTA just opened up — want to tour it this week?',
      ts: T0,
      created_at: T0, // production stamps every appended message; absent, the extraction window silently DROPS the row (docs/issues/seed-messages-missing-created-at.md)
    },
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T1}#msg-0002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Yes! Could we do Saturday morning?',
      ts: T1,
      created_at: T1,
    },
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T2}#msg-0003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Booked: Saturday 6/13 at 10am. Address: 1450 Joseph E. Boone Blvd NW.',
      ts: T2,
      created_at: T2,
    },
    // The carrier group's transcript. Inbound rows carry `relay_sender_key` -
    // the SHARED sender-attribution field - keyed PHONE-scoped (`phone#<E164>`)
    // for a group text, never contactId-scoped the way a relay group keys it.
    {
      conversationId: GROUP_TEXT_ID,
      tsMsgId: `${TG0}#msg-group-0001`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Marcus, can we all walk the unit Saturday morning?',
      delivery_status: 'delivered',
      relay_sender_key: `phone#${GROUP_TEXT_MEMBERS[0]}`,
      ts: TG0,
      created_at: TG0,
    },
    {
      conversationId: GROUP_TEXT_ID,
      tsMsgId: `${TG1}#msg-group-0002`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Saturday 10am works on our side - confirming with the owner.',
      delivery_status: 'delivered',
      ts: TG1,
      created_at: TG1,
    },
    {
      conversationId: GROUP_TEXT_ID,
      tsMsgId: `${TG2}#msg-group-0003`,
      type: 'sms',
      direction: 'inbound',
      author: 'landlord',
      body: 'Works for me - see you both there.',
      delivery_status: 'delivered',
      relay_sender_key: `phone#${GROUP_TEXT_MEMBERS[1]}`,
      ts: TG2,
      created_at: TG2,
    },
  ],
  matches: [
    {
      tenantId: IDS.tenant,
      unitId: IDS.unitA, // byUnit
      fit_score: 0.91,
      approval_likelihood: 0.84,
      rank: 1,
      status: 'shared',
      portability_required: false,
      expires_at: MATCH_EXPIRES_AT, // TTL attribute (epoch seconds)
      generated_at: T0,
    },
  ],
  placements: [
    {
      placementId: IDS.placement,
      tenantId: IDS.tenant, // byTenant
      unitId: IDS.unitA, // byUnit
      // status-model (§4): a valid PLACEMENT_STAGES value (legacy 'touring' is
      // gone — `searching` absorbs touring on the tenant now). Mid-ladder here.
      stage: 'awaiting_inspection', // byStage
      stage_entered_at: T2, // §8 time-in-stage basis
      stage_source: 'manual', // §8 provenance
      // No placement deadline: `awaiting_inspection` is the Inspection phase — tours
      // are a separate first-class entity in the `searching` phase, so a placement
      // here NEVER carries a `tour_reminder` (nor a tour_date/tour_history). Real
      // deadlines are now first-class placementDeadlines items, and the "stuck" clock
      // is DERIVED from time-in-stage (stage_entered_at T2 + the awaiting_inspection
      // threshold), not a stored deadline — so no raw next_deadline_* fields and no
      // placementDeadlines item belong here.
      group_thread: IDS.conversation,
      created_at: T2,
    },
  ],
  invoices: [
    {
      invoiceId: IDS.invoice,
      landlordId: IDS.landlord, // byLandlord
      status: 'sent', // byStatus
      amount_cents: 165000, // one month's determined rent
      placementId: IDS.placement,
      due_at: '2026-07-01',
      sent_at: T2,
    },
  ],
  users: [
    {
      userId: IDS.founder,
      email: 'founder@example.com', // byEmail
      role: 'admin',
      name: 'Jordan Avery',
      google_sub: 'google-oauth2|seed-founder',
      scopes: ['*'],
      created_at: T0,
    },
    {
      userId: IDS.va,
      email: 'va@example.com',
      role: 'va',
      name: 'Sam Rivera',
      google_sub: 'google-oauth2|seed-va',
      scopes: ['conversations:rw', 'contacts:rw'],
      created_at: T0,
    },
  ],
  // Org settings singleton (repos/settingsRepo.ts: table `settings`, PK
  // settingId = ORG_SETTINGS_ID). Only the fields that must DIFFER from
  // DEFAULT_ORG_SETTINGS are stored - getOrgSettings merges the item over the
  // defaults, so everything omitted here still reads its product default.
  //
  // quietHoursEnabled: false is a LEAN-SEED-ONLY posture (worklist A1). The
  // PRODUCT default stays ON (a fresh stack must never text at 4am), but with
  // it on, arm-time clamping makes every tour-booking e2e time-of-day
  // dependent: a night run would clamp a rung forward to 08:00 org-local, and
  // a spec that ticks at a rung's COMPUTED time would stop firing it. (Until
  // 2026-08-31 the sharpest case was the confirmation rung, armed at `now` and
  // therefore clamped by the clock the suite happened to run on; that rung no
  // longer arms, but day_before at 19:30 org-local still moves under a window
  // whose start is earlier.) Turning it off
  // for the seeded e2e/dev world keeps those specs clock-independent;
  // e2e/tests/scenarios/quiet-hours.spec.ts enables it explicitly (and
  // restores it) for its own scenarios.
  settings: [
    {
      settingId: 'org',
      quietHoursEnabled: false,
    },
  ],
  // auditRepo.append writes event_type + payload (the actor is hoisted to the
  // top-level actorId GSI key from payload.actor). The seed mirrors that shape:
  // `action`/`detail` would be silently stored and never read back.
  audit_events: [
    {
      entityKey: `placements#${IDS.placement}`,
      ts: T2, // table SK + byActor RANGE
      actorId: IDS.founder, // byActor HASH
      event_type: 'placement_stage_changed',
      payload: { actor: IDS.founder, from: 'send_rta_to_landlord', to: 'awaiting_inspection', source: 'manual' },
    },
    {
      entityKey: `contacts#${IDS.tenant}`,
      ts: T1,
      actorId: IDS.va,
      event_type: 'contact.profile_edited',
      payload: { actor: IDS.va, field: 'preferences_notes' },
    },
  ],
};
