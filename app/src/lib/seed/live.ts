// Live seed items — now-relative showcase. Items here are intentionally NOT
// byte-stable across reseeds (their dates depend on `now`). Called by seedAll
// only for the 'full' profile; the 'lean' profile never includes these.
//
// What gets seeded (spec §6):
//   TOUR-A  self-guided tour scheduled TODAY at 14:00 UTC → surfaces in Today's
//           tours_today group. Its reminders are armed via the real armTourReminders.
//   TOUR-B  landlord-led tour TOMORROW at 14:00 UTC + a relay group conv + pool
//           number. Full 5-rung reminder ladder armed via armTourReminders.
//   TOUR-C  confirmed tour +2 days (no new contacts — reuses live tenant/unit).
//
//   PLACEMENT-A  overdue RTA deadline (rta_window, next_deadline_at in the PAST)
//                → surfaces in Today's needs_you_now.
//   PLACEMENT-B  due follow-up (follow_up, next_deadline_at at/just before now)
//                → surfaces in Today's follow_ups (also tested as ≤ now).
//
// Tenant IDs, unit IDs, placement IDs, and conversation IDs all use the
// *-live-* namespace to avoid collisions with lean (*-000N), matrix (mx-*),
// and cast (cast-*).
//
// Arm strategy: we import armTourReminders from jobs/tourReminders.ts and
// construct a minimal TourRemindersRepo pointing at DynamoDB Local. This is the
// REAL arm logic — dueAts are computed by the same computeDueAt function the
// worker uses — so no hand-written date literals live here.

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from '../dynamo.js';
import { tableName } from '../config.js';
import { armTourReminders } from '../../jobs/tourReminders.js';
import { createTourRemindersRepo } from '../../repos/tourRemindersRepo.js';
import { deriveStatuses } from '../statusModel.js';
import type { TourItem } from '../../repos/toursRepo.js';

// ---------------------------------------------------------------------------
// ID constants — live namespace
// ---------------------------------------------------------------------------

export const LIVE_IDS = {
  // Contacts
  tenantA: 'contact-live-tenant-a',
  tenantB: 'contact-live-tenant-b',
  landlordA: 'contact-live-landlord-a',
  // Units
  unitA: 'unit-live-a',
  unitB: 'unit-live-b',
  unitC: 'unit-live-c',
  // Tours
  tourToday: 'tour-live-today',
  tourTomorrow: 'tour-live-tomorrow',
  tourConfirmed: 'tour-live-confirmed',
  // Conversations
  tenantAConv: 'conv-live-tenant-a',
  tenantBConv: 'conv-live-tenant-b',
  relayGroup: 'conv-live-relay-group',
  // Pool number for relay group
  poolNumber: '+15550160001',
  // Placements
  placementOverdueRta: 'placement-live-overdue-rta',
  placementFollowUp: 'placement-live-follow-up',
  // Phones (not colliding with lean +1555010000X, cast +1555010010X, matrix +1555020XXXX)
  tenantAPhone: '+15550170001',
  tenantBPhone: '+15550170002',
  landlordAPhone: '+15550170003',
} as const;

// ---------------------------------------------------------------------------
// Build static items (contacts, units, conversations, placements)
// These are written as plain PutCommands; only the tours need the repos.
// ---------------------------------------------------------------------------

/**
 * Build all static items for the live seed, using `now` as the reference point.
 * All dates are derived from `now` — no hardcoded calendar dates.
 */
function buildLiveStaticItems(now: Date): Record<string, Record<string, unknown>[]> {
  const iso = now.toISOString();

  // --- Scheduling instants ---------------------------------------------------
  // TODAY: same UTC date as now, at 14:00 UTC.
  const todayYmd = iso.slice(0, 10);
  const scheduledAtToday = `${todayYmd}T14:00:00.000Z`;

  // TOMORROW: next UTC calendar day at 14:00 UTC.
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowYmd = tomorrow.toISOString().slice(0, 10);
  const scheduledAtTomorrow = `${tomorrowYmd}T14:00:00.000Z`;

  // +2 DAYS at 14:00 UTC.
  const dayAfter = new Date(now);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 2);
  const dayAfterYmd = dayAfter.toISOString().slice(0, 10);
  const scheduledAtConfirmed = `${dayAfterYmd}T14:00:00.000Z`;

  // --- Derived statuses for live placements ---------------------------------
  // Both live placements are in 'awaiting_landlord_submission' (RTA phase →
  // tenant placing, unit under_application).
  const derivedRta = deriveStatuses('awaiting_landlord_submission');
  const derivedFollowUp = deriveStatuses('collect_rta');

  // Overdue RTA deadline: set in the past (2 hours ago).
  const overdueAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  // Due follow-up: set at (now - 5 minutes) so it is definitively ≤ now.
  const followUpAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

  return {
    contacts: [
      // Tenant A — ties to self-guided today tour + tomorrow relay tour
      {
        contactId: LIVE_IDS.tenantA,
        type: 'tenant',
        status: derivedRta.tenantStatus, // 'placing'
        status_source: 'derived',
        firstName: 'Diana',
        lastName: 'Osei',
        phone: LIVE_IDS.tenantAPhone,
        voucherSize: 2,
        housingAuthority: 'atlanta_housing',
        voucher_program: 'HCV',
        rta_expiration_date: tomorrowYmd, // urgently expiring — matches scenario
        porting: false,
        created_at: iso,
      },
      // Tenant B — ties to the follow-up placement (separate story)
      {
        contactId: LIVE_IDS.tenantB,
        type: 'tenant',
        status: derivedFollowUp.tenantStatus, // 'placing'
        status_source: 'derived',
        firstName: 'Leon',
        lastName: 'Abara',
        phone: LIVE_IDS.tenantBPhone,
        voucherSize: 3,
        housingAuthority: 'ga_dca',
        voucher_program: 'HCV',
        porting: false,
        created_at: iso,
      },
      // Landlord A — owns all three live units
      {
        contactId: LIVE_IDS.landlordA,
        type: 'landlord',
        status: 'active',
        firstName: 'Gloria',
        lastName: 'Mensah',
        phone: LIVE_IDS.landlordAPhone,
        lead_status: 'registered',
        contract_status: 'signed',
        authorities_served: ['atlanta_housing', 'ga_dca'],
        created_at: iso,
      },
    ],

    units: [
      // Unit A — self-guided tour today (tenant A, placement A overdue RTA)
      {
        unitId: LIVE_IDS.unitA,
        landlordId: LIVE_IDS.landlordA,
        status: derivedRta.listingStatus, // 'under_application'
        status_source: 'derived',
        address: {
          line1: '320 Auburn Ave NE',
          city: 'Atlanta',
          state: 'GA',
          zip: '30303',
        },
        jurisdiction: 'atlanta_housing',
        beds: 2,
        baths: 1,
        rent_min: 1600,
        rent_max: 1600,
        deposit: 1600,
        pets: 'No pets',
        tour_process: 'Self-guided with lockbox. Text landlord for code.',
        created_at: iso,
      },
      // Unit B — landlord-led tour tomorrow + confirmed tour +2d
      {
        unitId: LIVE_IDS.unitB,
        landlordId: LIVE_IDS.landlordA,
        status: 'available', // no active placement on this unit
        status_source: 'manual',
        address: {
          line1: '718 Ponce de Leon Ave NE',
          city: 'Atlanta',
          state: 'GA',
          zip: '30306',
        },
        jurisdiction: 'atlanta_housing',
        beds: 2,
        baths: 1,
        rent_min: 1750,
        rent_max: 1750,
        deposit: 1750,
        pets: 'Cats OK',
        tour_process: 'Landlord-led. Contact Gloria to arrange.',
        created_at: iso,
      },
      // Unit C — follow-up placement (tenant B)
      {
        unitId: LIVE_IDS.unitC,
        landlordId: LIVE_IDS.landlordA,
        status: derivedFollowUp.listingStatus, // 'under_application'
        status_source: 'derived',
        address: {
          line1: '45 Edgewood Ave SE',
          city: 'Atlanta',
          state: 'GA',
          zip: '30303',
        },
        jurisdiction: 'atlanta_housing',
        beds: 3,
        baths: 2,
        rent_min: 1900,
        rent_max: 1900,
        deposit: 1900,
        pets: 'No pets',
        tour_process: 'Landlord-led.',
        created_at: iso,
      },
    ],

    conversations: [
      // Tenant A's 1:1 thread (for self-guided reminder routing)
      {
        conversationId: LIVE_IDS.tenantAConv,
        participant_phone: LIVE_IDS.tenantAPhone,
        status: 'open',
        type: 'tenant_1to1',
        participants: [{ contactId: LIVE_IDS.tenantA, phone: LIVE_IDS.tenantAPhone }],
        participant_display_name: 'Diana Osei',
        last_activity_at: iso,
        last_message_preview: 'Looking forward to the tour!',
        unread_count: 0,
        created_at: iso,
      },
      // Phone-claim row for tenant A's 1:1
      {
        conversationId: `phone#${LIVE_IDS.tenantAPhone}`,
        ref_conversationId: LIVE_IDS.tenantAConv,
      },
      // Tenant B's 1:1 thread
      {
        conversationId: LIVE_IDS.tenantBConv,
        participant_phone: LIVE_IDS.tenantBPhone,
        status: 'open',
        type: 'tenant_1to1',
        participants: [{ contactId: LIVE_IDS.tenantB, phone: LIVE_IDS.tenantBPhone }],
        participant_display_name: 'Leon Abara',
        last_activity_at: iso,
        last_message_preview: 'Thanks for the update.',
        unread_count: 0,
        created_at: iso,
      },
      // Phone-claim row for tenant B's 1:1
      {
        conversationId: `phone#${LIVE_IDS.tenantBPhone}`,
        ref_conversationId: LIVE_IDS.tenantBConv,
      },
      // Relay group for the tomorrow tour (landlord-led)
      {
        conversationId: LIVE_IDS.relayGroup,
        participant_phone: LIVE_IDS.poolNumber,
        pool_number: LIVE_IDS.poolNumber,
        status: 'open',
        type: 'relay_group',
        ai_mode: 'manual',
        participants: [
          { contactId: LIVE_IDS.tenantA, phone: LIVE_IDS.tenantAPhone, name: 'Diana Osei' },
          { contactId: LIVE_IDS.landlordA, phone: LIVE_IDS.landlordAPhone, name: 'Gloria Mensah' },
        ],
        participant_display_name: 'Diana Osei + Gloria Mensah',
        owner: { type: 'tour', id: LIVE_IDS.tourTomorrow },
        last_activity_at: iso,
        last_message_preview: '[AUTO] Tour group opened.',
        unread_count: 0,
        created_at: iso,
      },
    ],

    pool_numbers: [
      {
        poolNumber: LIVE_IDS.poolNumber,
        lifecycle_state: 'assigned',
        voice_capable: true,
        sms_capable: true,
        provisioned_via: 'console',
        quarantine_until: '0000-00-00T00:00:00.000Z',
        assigned_conversation_id: LIVE_IDS.relayGroup,
        provisioned_at: iso,
        assigned_at: iso,
      },
    ],

    tours: [
      // TOUR-A: self-guided TODAY
      {
        tourId: LIVE_IDS.tourToday,
        tenantId: LIVE_IDS.tenantA,
        unitId: LIVE_IDS.unitA,
        tourType: 'self_guided',
        status: 'scheduled',
        scheduledAt: scheduledAtToday,
        _schedPartition: 'tours',
        createdAt: iso,
        updatedAt: iso,
      },
      // TOUR-B: landlord-led TOMORROW — group thread + full reminder ladder
      {
        tourId: LIVE_IDS.tourTomorrow,
        tenantId: LIVE_IDS.tenantA,
        unitId: LIVE_IDS.unitB,
        tourType: 'landlord_led',
        status: 'scheduled',
        scheduledAt: scheduledAtTomorrow,
        _schedPartition: 'tours',
        groupThreadId: LIVE_IDS.relayGroup,
        createdAt: iso,
        updatedAt: iso,
      },
      // TOUR-C: confirmed +2 days
      {
        tourId: LIVE_IDS.tourConfirmed,
        tenantId: LIVE_IDS.tenantA,
        unitId: LIVE_IDS.unitB,
        tourType: 'landlord_led',
        status: 'confirmed',
        scheduledAt: scheduledAtConfirmed,
        _schedPartition: 'tours',
        groupThreadId: LIVE_IDS.relayGroup,
        createdAt: iso,
        updatedAt: iso,
      },
    ],

    placements: [
      // PLACEMENT-A: overdue RTA deadline → needs_you_now
      {
        placementId: LIVE_IDS.placementOverdueRta,
        tenantId: LIVE_IDS.tenantA,
        unitId: LIVE_IDS.unitA,
        stage: 'awaiting_landlord_submission',
        stage_source: 'manual',
        stage_entered_at: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(),
        next_deadline_type: 'rta_window',
        next_deadline_at: overdueAt,
        created_at: iso,
        updated_at: iso,
      },
      // PLACEMENT-B: due follow-up → follow_ups
      {
        placementId: LIVE_IDS.placementFollowUp,
        tenantId: LIVE_IDS.tenantB,
        unitId: LIVE_IDS.unitC,
        stage: 'collect_rta',
        stage_source: 'manual',
        stage_entered_at: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
        next_deadline_type: 'follow_up',
        next_deadline_at: followUpAt,
        created_at: iso,
        updated_at: iso,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// seedLive — the public entry point
// ---------------------------------------------------------------------------

/**
 * Side-effectful now-relative seeding. Called by seedAll('full') after static
 * items are written. Writes tours, contacts, units, conversations, placements,
 * pool_numbers, and tour reminder rows. Items are intentionally NOT
 * byte-stable across reseeds (their dates depend on `now`).
 *
 * Arm strategy: armTourReminders (from jobs/tourReminders.ts) is called with
 * a real TourRemindersRepo pointing at the seed endpoint — so reminder dueAts
 * are computed by the identical computeDueAt logic the production worker uses.
 * No hand-written dueAt literals exist in this file.
 *
 * @param endpoint  DynamoDB Local endpoint URL.
 * @param now       Injected current time. seedAll passes `new Date()`; tests
 *                  pass a fixed Date for deterministic assertions.
 */
export async function seedLive(endpoint: string, now: Date = new Date()): Promise<void> {
  const doc = createDocumentClient({ endpoint });
  const nowIso = now.toISOString();

  try {
    const staticItems = buildLiveStaticItems(now);

    // Write all static items (contacts, units, conversations, pool_numbers,
    // tours, placements) as plain PutCommands.
    for (const [base, items] of Object.entries(staticItems)) {
      if (items.length === 0) continue;
      const table = tableName(base);
      for (const item of items) {
        await doc.send(new PutCommand({ TableName: table, Item: item }));
      }
      console.log(
        `  seeded   ${table} (live): ${items.length} item${items.length === 1 ? '' : 's'}`,
      );
    }

    // Arm reminder ladders via the REAL armTourReminders function.
    // We construct a TourRemindersRepo pointed at the seed endpoint.
    // armTourReminders only needs tourRemindersRepo (+ optional logger) — it does
    // NOT send messages; it only writes reminder rows. This is the exact same
    // code path the booking handler uses, so dueAts always match the worker's view.
    const remindersRepo = createTourRemindersRepo({ doc });

    // Build TourItem shapes matching what the repo would return (needed by armTourReminders).
    const toursArr = staticItems['tours'] ?? [];
    const tourToday = toursArr[0] as TourItem;
    const tourTomorrow = toursArr[1] as TourItem;
    const tourConfirmed = toursArr[2] as TourItem;

    // Arm TOUR-A (today, self-guided): confirmation always fires; day_before/
    // morning_of/en_route/no_show_checkin are skipped if their dueAt < now
    // (which is likely for a tour at 14:00 UTC if now is already past those
    // offsets). This mirrors real behavior exactly.
    const armedToday = await armTourReminders(tourToday, nowIso, { tourRemindersRepo: remindersRepo });
    console.log(
      `  seeded   tourReminders (live tour-today): ${armedToday.length} reminder${armedToday.length === 1 ? '' : 's'}`,
    );

    // Arm TOUR-B (tomorrow, landlord-led): full ladder. confirmation is armed
    // now; day_before/morning_of/en_route/no_show_checkin all have future dueAts
    // (because scheduledAt is tomorrow at 14:00 UTC) — so all 5 rungs should arm.
    const armedTomorrow = await armTourReminders(tourTomorrow, nowIso, { tourRemindersRepo: remindersRepo });
    console.log(
      `  seeded   tourReminders (live tour-tomorrow): ${armedTomorrow.length} reminder${armedTomorrow.length === 1 ? '' : 's'}`,
    );

    // Arm TOUR-C (+2 days, confirmed): similar to tomorrow — all 5 rungs should
    // arm since scheduledAt is 2 days in the future.
    const armedConfirmed = await armTourReminders(tourConfirmed, nowIso, { tourRemindersRepo: remindersRepo });
    console.log(
      `  seeded   tourReminders (live tour-confirmed): ${armedConfirmed.length} reminder${armedConfirmed.length === 1 ? '' : 's'}`,
    );
  } finally {
    doc.destroy();
  }
}
