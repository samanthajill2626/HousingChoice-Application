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

// Stable timestamps so re-runs write byte-identical items.
const T0 = '2026-06-01T14:00:00.000Z';
const T1 = '2026-06-01T14:02:10.000Z';
const T2 = '2026-06-01T14:05:45.000Z';
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

/** table base name -> items. Document-style: only keys/GSI attrs contractual.
 *  Exported so a unit test can guard the field CASING (the flexible-doc repos
 *  store any key, so a snake_case typo is silently persisted then never read). */
export const SEED: Record<string, Record<string, unknown>[]> = {
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
      created_at: T0,
    },
    {
      contactId: IDS.landlord,
      type: 'landlord',
      status: 'active',
      phone: '+15550100002',
      firstName: 'Marcus',
      lastName: 'Bell',
      lead_status: 'registered',
      contract_status: 'signed',
      authorities_served: ['atlanta_housing', 'ga_dca'],
      created_at: T0,
    },
    {
      contactId: IDS.haStaffer,
      type: 'team_member',
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
      jurisdiction: 'atlanta_housing', // byJurisdiction
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
      jurisdiction: 'ga_dca',
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
      participants: [IDS.tenant],
      last_message_preview: 'Saturday morning works great, thank you!',
      created_at: T0,
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
    },
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T1}#msg-0002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Yes! Could we do Saturday morning?',
      ts: T1,
    },
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T2}#msg-0003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Booked: Saturday 6/13 at 10am. Address: 1450 Joseph E. Boone Blvd NW.',
      ts: T2,
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
      tour_date: '2026-06-13', // byTourDate (sparse — present because scheduled)
      // No placement deadline: `tour_reminder` is retired (tours are first-class),
      // and real deadlines are now first-class placementDeadlines items.
      group_thread: IDS.conversation,
      tour_history: [{ scheduled_for: '2026-06-13T14:00:00.000Z', status: 'scheduled' }],
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
