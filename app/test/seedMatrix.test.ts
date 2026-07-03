// Coverage assertions for the full seed profile (matrix layer).
//
// These tests run against the IN-MEMORY output of matrixItems() merged with
// the lean SEED — no DynamoDB required. They assert:
//  1. Every PLACEMENT_STAGE ×2 in the full profile
//  2. Both terminal stages (moved_in, lost) ×2
//  3. Every LISTING_STATUS ×2
//  4. Every TENANT_STATUS ×2
//  5. Every LANDLORD_STATUS ×2
//  6. Every TOUR_STATUS ×2
//  7. §7 derivation holds for ALL placements (tenant+unit status == deriveStatuses(stage))
//  8. Every 'parked' landlord carries park_reason
//  9. Every reminder row belongs to a scheduled/confirmed/no_show/toured/closed/canceled
//     tour (never a 'requested' one)
// 10. All 8 consent methods appear ≥1 across the full contacts set
// 11. All IDs are unique across the full seed (no duplicate PKs)
// 12. The 'sent' broadcast has skipped_no_consent > 0
// 13. Org settings row exists
// 14. user-0003 va2@example.com va role exists
//
// NOTE: The FULL profile is lean + cast + matrix. Cast (Task 3) is still a stub
// returning empty, so this test operates on lean + matrix only. The assertions
// are written to hold against the FULL profile (lean + cast + matrix) once cast
// is implemented — they will only get easier to satisfy, not harder.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seedData.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import {
  PLACEMENT_STAGES,
  LISTING_STATUSES,
  TENANT_STATUSES,
  LANDLORD_STATUSES,
  TERMINAL_STAGES,
  deriveStatuses,
  type PlacementStage,
} from '../src/lib/statusModel.js';
import { TOUR_STATUSES } from '../src/lib/toursModel.js';

// ---------------------------------------------------------------------------
// Build the merged full-profile item set (in-memory; no DB)
// ---------------------------------------------------------------------------
function buildFullProfile(): Record<string, Record<string, unknown>[]> {
  const full: Record<string, Record<string, unknown>[]> = {};

  // Lean base
  for (const [base, items] of Object.entries(SEED)) {
    full[base] = [...items];
  }

  // Cast layer (Task 3 personas)
  for (const [base, items] of Object.entries(castItems())) {
    full[base] = [...(full[base] ?? []), ...items];
  }

  // Matrix layer
  for (const [base, items] of Object.entries(matrixItems())) {
    full[base] = [...(full[base] ?? []), ...items];
  }

  return full;
}

const PROFILE = buildFullProfile();

const allContacts = PROFILE['contacts'] ?? [];
const allUnits = PROFILE['units'] ?? [];
const allPlacements = PROFILE['placements'] ?? [];
const allTours = PROFILE['tours'] ?? [];
const allReminders = PROFILE['tourReminders'] ?? [];
const allUsers = PROFILE['users'] ?? [];
const allBroadcasts = PROFILE['broadcasts'] ?? [];
const allSettings = PROFILE['settings'] ?? [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function countByField(items: Record<string, unknown>[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const v = item[field] as string | undefined;
    if (v !== undefined) counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 1. Every PLACEMENT_STAGE ≥2
// ---------------------------------------------------------------------------
describe('seed matrix: placement stage coverage', () => {
  const stageCounts = countByField(allPlacements, 'stage');

  it('every PLACEMENT_STAGE appears ≥2 times in the full profile', () => {
    for (const stage of PLACEMENT_STAGES) {
      expect(stageCounts[stage] ?? 0, `stage '${stage}' count`).toBeGreaterThanOrEqual(2);
    }
  });

  it('terminal stage moved_in appears ≥2 times', () => {
    expect(stageCounts['moved_in'] ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('terminal stage lost appears ≥2 times', () => {
    expect(stageCounts['lost'] ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('both terminal stages are present', () => {
    for (const t of TERMINAL_STAGES) {
      expect(stageCounts[t] ?? 0, `terminal '${t}'`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every LISTING_STATUS ≥2
// ---------------------------------------------------------------------------
describe('seed matrix: unit listing status coverage', () => {
  const statusCounts = countByField(allUnits, 'status');

  it('every LISTING_STATUS appears ≥2 times in the full profile', () => {
    for (const s of LISTING_STATUSES) {
      expect(statusCounts[s] ?? 0, `unit status '${s}' count`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Every TENANT_STATUS ≥2
// ---------------------------------------------------------------------------
describe('seed matrix: tenant status coverage', () => {
  const tenants = allContacts.filter((c) => c['type'] === 'tenant');
  const statusCounts = countByField(tenants, 'status');

  it('every TENANT_STATUS appears ≥2 times in the full profile', () => {
    for (const s of TENANT_STATUSES) {
      expect(statusCounts[s] ?? 0, `tenant status '${s}' count`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Every LANDLORD_STATUS ≥2
// ---------------------------------------------------------------------------
describe('seed matrix: landlord status coverage', () => {
  const landlords = allContacts.filter((c) => c['type'] === 'landlord');
  const statusCounts = countByField(landlords, 'status');

  it('every LANDLORD_STATUS appears ≥2 times in the full profile', () => {
    for (const s of LANDLORD_STATUSES) {
      expect(statusCounts[s] ?? 0, `landlord status '${s}' count`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Every TOUR_STATUS ≥2
// ---------------------------------------------------------------------------
describe('seed matrix: tour status coverage', () => {
  const statusCounts = countByField(allTours, 'status');

  it('every TOUR_STATUS appears ≥2 times in the full profile', () => {
    for (const s of TOUR_STATUSES) {
      expect(statusCounts[s] ?? 0, `tour status '${s}' count`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. §7 derivation holds for ALL placements
// ---------------------------------------------------------------------------
describe('seed matrix: §7 derivation consistency over ALL placements', () => {
  it('every placement links a tenant+unit whose status matches deriveStatuses(stage)', () => {
    const tenantMap = new Map(allContacts.filter((c) => c['type'] === 'tenant').map((c) => [c['contactId'] as string, c]));
    const unitMap = new Map(allUnits.map((u) => [u['unitId'] as string, u]));

    for (const p of allPlacements) {
      const stage = p['stage'] as PlacementStage;
      const tenantId = p['tenantId'] as string;
      const unitId = p['unitId'] as string;

      const tenant = tenantMap.get(tenantId);
      const unit = unitMap.get(unitId);

      // Both must exist
      expect(tenant, `placement ${p['placementId']}: tenant '${tenantId}' must be seeded`).toBeDefined();
      expect(unit, `placement ${p['placementId']}: unit '${unitId}' must be seeded`).toBeDefined();

      const derived = deriveStatuses(stage);

      // Status values must match derivation
      expect(tenant!['status'], `placement ${p['placementId']} stage '${stage}': tenant status`).toBe(derived.tenantStatus);
      expect(unit!['status'], `placement ${p['placementId']} stage '${stage}': unit status`).toBe(derived.listingStatus);

      // status_source must be 'derived' or absent (never 'manual' on a derivable state)
      const tSrc = tenant!['status_source'];
      const uSrc = unit!['status_source'];
      expect(tSrc === undefined || tSrc === 'derived', `placement ${p['placementId']}: tenant status_source`).toBe(true);
      expect(uSrc === undefined || uSrc === 'derived', `placement ${p['placementId']}: unit status_source`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Every 'parked' landlord has park_reason
// ---------------------------------------------------------------------------
describe('seed matrix: parked landlords carry park_reason', () => {
  it('every landlord with status=parked has a non-empty park_reason', () => {
    const parkedLandlords = allContacts.filter((c) => c['type'] === 'landlord' && c['status'] === 'parked');
    expect(parkedLandlords.length, 'must have ≥1 parked landlord').toBeGreaterThanOrEqual(1);
    for (const l of parkedLandlords) {
      expect(l['park_reason'], `landlord ${l['contactId']} park_reason`).toBeDefined();
      expect(typeof l['park_reason']).toBe('string');
      expect((l['park_reason'] as string).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. No reminder row belongs to a 'requested' tour
// ---------------------------------------------------------------------------
describe('seed matrix: reminder invariant (no reminders on requested tours)', () => {
  it('every reminder row belongs to a tour that is NOT requested', () => {
    const requestedTourIds = new Set(allTours.filter((t) => t['status'] === 'requested').map((t) => t['tourId'] as string));
    const requestedTours = allTours.filter((t) => t['status'] === 'requested');
    expect(requestedTours.length, 'must have ≥2 requested tours').toBeGreaterThanOrEqual(2);

    for (const r of allReminders) {
      const tourId = r['tourId'] as string;
      expect(requestedTourIds.has(tourId), `reminder ${r['reminderId']} must not belong to a requested tour`).toBe(false);
    }
  });

  it('requested tours have zero reminder rows each', () => {
    const requestedTourIds = new Set(allTours.filter((t) => t['status'] === 'requested').map((t) => t['tourId'] as string));
    for (const tourId of requestedTourIds) {
      const rems = allReminders.filter((r) => r['tourId'] === tourId);
      expect(rems.length, `requested tour '${tourId}' must have 0 reminder rows`).toBe(0);
    }
  });

  it('no_show tours have ≥1 no_show_checkin reminder with sentAt set', () => {
    const noShowTourIds = new Set(allTours.filter((t) => t['status'] === 'no_show').map((t) => t['tourId'] as string));
    expect(noShowTourIds.size, 'must have ≥2 no_show tours').toBeGreaterThanOrEqual(2);
    for (const tourId of noShowTourIds) {
      const checkins = allReminders.filter((r) => r['tourId'] === tourId && r['kind'] === 'no_show_checkin');
      expect(checkins.length, `no_show tour '${tourId}' must have ≥1 no_show_checkin reminder`).toBeGreaterThanOrEqual(1);
      for (const c of checkins) {
        expect(c['sentAt'], `no_show_checkin reminder must have sentAt set`).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 9. All 8 consent methods appear ≥1
// ---------------------------------------------------------------------------
describe('seed matrix: consent method coverage', () => {
  const ALL_CONSENT_METHODS = [
    'web_form',
    'inbound_text',
    'inbound_call',
    'client_inbound',
    'verbal_phone',
    'verbal_in_person',
    'paper_form',
    'imported',
  ] as const;

  it('all 8 consent methods appear ≥1 across full contacts', () => {
    const methodsPresent = new Set(allContacts.map((c) => c['consent_method'] as string | undefined).filter(Boolean));
    for (const method of ALL_CONSENT_METHODS) {
      expect(methodsPresent.has(method), `consent method '${method}' must appear ≥1`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. IDs unique across the full seed
// ---------------------------------------------------------------------------
describe('seed matrix: no duplicate primary keys', () => {
  it('contact IDs are unique', () => {
    const ids = allContacts.map((c) => c['contactId'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('unit IDs are unique', () => {
    const ids = allUnits.map((u) => u['unitId'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('placement IDs are unique', () => {
    const ids = allPlacements.map((p) => p['placementId'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tour IDs are unique', () => {
    const ids = allTours.map((t) => t['tourId'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reminder IDs are unique', () => {
    const ids = allReminders.map((r) => r['reminderId'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('user IDs are unique', () => {
    const ids = allUsers.map((u) => u['userId'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// 11. Broadcast: sent one has skipped_no_consent > 0; draft exists
// ---------------------------------------------------------------------------
describe('seed matrix: broadcasts', () => {
  it('there is ≥1 sent broadcast with skipped_no_consent > 0', () => {
    const sentBroadcasts = allBroadcasts.filter((b) => b['status'] === 'sent');
    expect(sentBroadcasts.length).toBeGreaterThanOrEqual(1);
    const withSkipped = sentBroadcasts.filter((b) => {
      const stats = b['stats'] as Record<string, number> | undefined;
      return (stats?.['skipped_no_consent'] ?? 0) > 0;
    });
    expect(withSkipped.length, 'at least one sent broadcast must have skipped_no_consent > 0').toBeGreaterThanOrEqual(1);
  });

  it('there is ≥1 draft broadcast', () => {
    const draftBroadcasts = allBroadcasts.filter((b) => b['status'] === 'draft');
    expect(draftBroadcasts.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 12. Settings org row exists
// ---------------------------------------------------------------------------
describe('seed matrix: settings', () => {
  it('the org settings row exists', () => {
    const orgSettings = allSettings.find((s) => s['settingId'] === 'org');
    expect(orgSettings).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13. user-0003 va2 exists
// ---------------------------------------------------------------------------
describe('seed matrix: users', () => {
  it('user-0003 va2@example.com with role va exists', () => {
    const va2 = allUsers.find((u) => u['userId'] === 'user-0003');
    expect(va2).toBeDefined();
    expect(va2!['email']).toBe('va2@example.com');
    expect(va2!['role']).toBe('va');
  });
});

// ---------------------------------------------------------------------------
// 14. every_deadline_type ≥1
// ---------------------------------------------------------------------------
describe('seed matrix: next_deadline_type coverage', () => {
  // `tour_reminder` is a TOURS concept (a tour is a separate entity in the
  // `searching` phase); it is NEVER a valid placement next_deadline. So it is
  // deliberately excluded from the placement-deadline coverage set.
  const DEADLINE_TYPES = ['rta_window', 'voucher_expiration', 'stuck_placement', 'follow_up'] as const;

  it('every placement next_deadline_type value appears ≥1 across all placements', () => {
    const deadlineCounts = countByField(allPlacements, 'next_deadline_type');
    for (const dt of DEADLINE_TYPES) {
      expect(deadlineCounts[dt] ?? 0, `deadline type '${dt}'`).toBeGreaterThanOrEqual(1);
    }
  });

  it('NO placement anywhere carries a tour_reminder deadline (tours are a separate entity)', () => {
    const deadlineCounts = countByField(allPlacements, 'next_deadline_type');
    expect(deadlineCounts['tour_reminder'] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Pool numbers + relay conversations exist
// ---------------------------------------------------------------------------
describe('seed matrix: pool numbers and relay conversations', () => {
  const allPoolNumbers = PROFILE['pool_numbers'] ?? [];
  const allConversations = PROFILE['conversations'] ?? [];

  it('≥2 pool_numbers rows exist (assigned lifecycle)', () => {
    const assigned = allPoolNumbers.filter((p) => p['lifecycle_state'] === 'assigned');
    expect(assigned.length).toBeGreaterThanOrEqual(2);
  });

  it('≥2 relay_group conversations exist', () => {
    const relayConvs = allConversations.filter((c) => c['type'] === 'relay_group');
    expect(relayConvs.length).toBeGreaterThanOrEqual(2);
  });

  it('pool numbers and relay conversations are cross-referenced', () => {
    const poolConvIds = new Set(allPoolNumbers.map((p) => p['assigned_conversation_id'] as string).filter(Boolean));
    const relayConvIds = new Set(allConversations.filter((c) => c['type'] === 'relay_group').map((c) => c['conversationId'] as string));
    for (const id of poolConvIds) {
      expect(relayConvIds.has(id), `pool number assigned_conversation_id '${id}' must match a relay_group conversation`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. One-primary / phone-pointer invariants (Task 3 plan promised)
//
// For every contact row (lean + cast + matrix) that carries a phones[] array:
//   a. Exactly ONE entry has primary: true.
//   b. Every non-primary phone number has a corresponding phoneref#<E164> pointer
//      row in the contacts table (contactId = `phoneref#<phone>`, phone_ref: true,
//      phone_ref_owner = owning contactId).
// ---------------------------------------------------------------------------
describe('seed full profile: one-primary / phone-pointer invariants', () => {
  // Separate true contact rows from phoneref pointer rows
  const realContacts = allContacts.filter(
    (c) => typeof c['contactId'] === 'string' && !(c['contactId'] as string).startsWith('phoneref#'),
  );
  const pointerRows = allContacts.filter(
    (c) => typeof c['contactId'] === 'string' && (c['contactId'] as string).startsWith('phoneref#'),
  );

  it('every contact with phones[] has exactly one primary: true entry', () => {
    for (const contact of realContacts) {
      const phones = contact['phones'] as Array<{ phone: string; primary: boolean }> | undefined;
      if (!phones) continue;
      const primaryCount = phones.filter((p) => p.primary === true).length;
      expect(
        primaryCount,
        `contact '${contact['contactId']}' has ${primaryCount} primary phones (expected exactly 1)`,
      ).toBe(1);
    }
  });

  it('every non-primary phone has a phoneref# pointer row', () => {
    for (const contact of realContacts) {
      const phones = contact['phones'] as Array<{ phone: string; primary: boolean }> | undefined;
      if (!phones) continue;
      const nonPrimary = phones.filter((p) => p.primary !== true);
      for (const { phone } of nonPrimary) {
        const pointerId = `phoneref#${phone}`;
        const pointer = pointerRows.find((r) => r['contactId'] === pointerId);
        expect(
          pointer,
          `non-primary phone '${phone}' on contact '${contact['contactId']}' is missing a pointer row (contactId='${pointerId}')`,
        ).toBeDefined();
        expect(pointer!['phone_ref'], `pointer row '${pointerId}' must have phone_ref: true`).toBe(true);
        expect(
          pointer!['phone_ref_owner'],
          `pointer row '${pointerId}' must have phone_ref_owner = '${contact['contactId']}'`,
        ).toBe(contact['contactId']);
      }
    }
  });

  it('the searching tenant (multi-phone cast contact) has exactly one primary and a pointer row for its second number', () => {
    const searching = realContacts.find((c) => c['contactId'] === 'contact-cast-searching-tenant');
    expect(searching, 'searching tenant must exist in the full profile').toBeDefined();
    const phones = searching!['phones'] as Array<{ phone: string; primary: boolean }> | undefined;
    expect(phones, 'searching tenant must have a phones[] array').toBeDefined();
    const primaryCount = phones!.filter((p) => p.primary === true).length;
    expect(primaryCount, 'searching tenant: exactly one primary phone').toBe(1);
    const nonPrimaryPhones = phones!.filter((p) => p.primary !== true);
    expect(nonPrimaryPhones.length, 'searching tenant: at least one non-primary phone').toBeGreaterThanOrEqual(1);
    for (const { phone } of nonPrimaryPhones) {
      const pointer = pointerRows.find((r) => r['contactId'] === `phoneref#${phone}`);
      expect(pointer, `searching tenant: pointer row for '${phone}' must exist`).toBeDefined();
      expect(pointer!['phone_ref']).toBe(true);
      expect(pointer!['phone_ref_owner']).toBe('contact-cast-searching-tenant');
    }
  });
});
