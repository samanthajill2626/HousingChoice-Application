// WP1 B2a spec D4 (charter 7.2, 12): the worked examples, version e3. Twelve
// SYNTHETIC pairs spread across the bands - made-up people (surnames
// Example, Sample, Placeholder) and made-up streets in real metro-Atlanta
// cities. Each is written in the exact wire shape of a real call (prompt.ts
// renders it with the same renderer as the real user content), followed by
// the output a good answer gives. Cameron checks them at the handback; B2b's
// promotion grows the set and bumps EXAMPLES_VERSION; B2a only reads it.
// ANY edit here is a new EXAMPLES_VERSION (every match records it).
//
// Exempt from the tenant-matching-inputs reader scan (spec D2.1): the cards
// are synthetic and key the inputs by their list LABELS, as real cards do.
//
// e2 (charter section 20 item 17, B2a rev 8) adds example 11: a rent-gap
// pair whose Notes carry a credit and income line that is not a reason.
// e3 (charter section 20 item 18, B2a rev 9): the authority names are off
// every card (each candidate carries the pair's authority fact instead; the
// names a record holds sit in offCard, which is never rendered), and example
// 12 adds a rent-gap pair whose Notes carry a gender-identity line that is
// not a reason and does not move the score.
import type { RankingSource } from './schema.js';
import type { AuthorityFact, Card, Direction, PairHistory } from './types.js';

export const EXAMPLES_VERSION = 'e3';

export interface ExampleHome {
  handle: string;
  label: string;
  card: Card;
}

export interface ExampleCandidate {
  handle: string;
  card: Card;
  missing: string[];
  /** Charter section 20 item 18: the pair's authority fact, as a real call carries it. */
  authority: AuthorityFact;
  pairHistory: PairHistory;
}

export interface ExampleOutputEntry {
  candidateId: string;
  score: number;
  for: Array<{ text: string; source: RankingSource }>;
  against: Array<{ text: string; source: RankingSource }>;
  unknowns: string[];
  failedRequirements: string[];
  fairHousingFlags: Array<{ kind: 'unlawful' | 'accommodation'; field: string }>;
}

export interface RankingExample {
  title: string;
  direction: Direction;
  /**
   * NEVER rendered (prompt.ts renders only anchor, homesSeen and candidates):
   * the stored attributes a record holds that its card leaves off (charter
   * section 20 item 18 - the housing authority names), keyed "anchor" or a
   * candidate handle. The shape test rebuilds each stored record from its
   * card plus these, so the missing lists stay what production computes.
   */
  offCard?: Readonly<Record<string, Card>>;
  anchor: { card: Card; missing: string[] };
  homesSeen: ExampleHome[];
  candidates: ExampleCandidate[];
  output: { candidates: ExampleOutputEntry[] };
}

const NO_HISTORY: PairHistory = { sends: [], declined: null, tours: [], daysSinceLastSend: null };

export const RANKING_EXAMPLES: readonly RankingExample[] = [
  // 1. Strong: preferences met, nothing against.
  {
    title: 'Strong: preferences met, nothing against (a property anchor)',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['Decatur Housing Authority', 'DeKalb County Housing Authority'] }, c1: { housingAuthority: 'Decatur Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '100 Sample Lane', city: 'Decatur', state: 'GA', zip: '30030' },
        status: 'available',
        beds: 2,
        baths: 1,
        area: 'Decatur',
        rent_min: 1450,
        payment_standard: 1600,
        utilities: 'Electric only',
        accessibility: 'Ground floor, no steps at the entry',
        application_fee: 0,
        deposit: 500,
        pets: 'Cats and small dogs welcome',
        pet_fee: '$200 one time',
        tour_type: 'landlord_led',
        notes: 'Fenced yard. Near the 123 bus.',
        created_at: '2026-09-02',
        voucherSizes: [2],
        voucherSizesInferredFromBeds: false,
      },
      missing: [],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Robin',
          lastName: 'Example',
          status: 'searching',
          voucherSize: 2,
          address: { line1: '9 Placeholder Court', city: 'Decatur', state: 'GA', zip: '30030' },
          pets: 'One cat',
          created_at: '2026-08-14',
          notes: '[Auto - Oct 2] Works near the Decatur square and takes the bus.',
          'Area preference': 'Decatur',
          'Maximum tenant portion': 450,
          'Preferences and constraints': 'A yard',
          lastHeardFrom: 'this week',
          propertiesSeen: [],
        },
        missing: [],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 92,
          for: [
            { text: 'in Decatur, the preferred area', source: 'area' },
            { text: 'rent under payment standard', source: 'rent' },
            { text: 'cat welcome; fenced yard', source: 'pets' },
          ],
          against: [],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 2. Absolute scores across two properties for one tenant.
  {
    title: 'Absolute scores: two properties for one tenant, each scored on its own (a tenant anchor)',
    direction: 'properties_for_tenant',
    offCard: { anchor: { housingAuthority: 'Atlanta Housing Authority' }, c1: { accepted_authorities: ['Atlanta Housing Authority'] }, c2: { accepted_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'] } },
    anchor: {
      card: {
        firstName: 'Jordan',
        lastName: 'Sample',
        status: 'searching',
        voucherSize: 3,
        address: { line1: '55 Example Avenue', city: 'Atlanta', state: 'GA', zip: '30316' },
        created_at: '2026-07-01',
        notes: 'No car; takes the bus to work.',
        'Area preference': 'East Atlanta or Kirkwood',
        'Maximum tenant portion': 600,
        'Preferences and constraints': 'Near a bus line',
        lastHeardFrom: 'this month',
        // PR20 / PR31: one seen home that is a candidate in this call (its c
        // handle) and one that is not (written once in homesSeen as h1).
        propertiesSeen: [
          {
            home: 'c2',
            label: '300 Placeholder Road, Stone Mountain',
            sends: [{ at: '2026-10-05', kind: 'sent' }],
            daysSinceLastSend: 23,
            declined: null,
            tours: [],
            feedback: ['[Auto - Oct 6] 300 Placeholder Road, Stone Mountain: too far without a car'],
          },
          {
            home: 'h1',
            label: '12 Sample Row, Atlanta',
            sends: [{ at: '2026-09-20', kind: 'sent' }],
            daysSinceLastSend: 38,
            declined: { by: 'staff', at: '2026-09-22' },
            tours: [],
            feedback: ['[Auto - Sep 21] 12 Sample Row, Atlanta: the bedrooms are too small'],
          },
        ],
      },
      missing: [],
    },
    homesSeen: [
      {
        handle: 'h1',
        label: '12 Sample Row, Atlanta',
        card: {
          address: { line1: '12 Sample Row', city: 'Atlanta', state: 'GA', zip: '30316' },
          status: 'available',
          beds: 3,
          baths: 1,
          area: 'East Atlanta',
          rent_min: 1850,
          payment_standard: 2000,
          notes: 'Bedrooms are small, about 9 by 10 feet.',
          created_at: '2026-09-01',
          voucherSizes: [3],
          voucherSizesInferredFromBeds: false,
        },
      },
    ],
    candidates: [
      {
        handle: 'c1',
        card: {
          address: { line1: '200 Example Avenue', city: 'Atlanta', state: 'GA', zip: '30317' },
          status: 'available',
          beds: 3,
          baths: 1,
          area: 'Kirkwood',
          rent_min: 1900,
          payment_standard: 2000,
          utilities: 'Gas and electric',
          notes: 'Two blocks from the 21 bus. Street parking.',
          created_at: '2026-09-20',
          voucherSizes: [3],
          voucherSizesInferredFromBeds: false,
        },
        missing: ['Pets', 'Accessibility'],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
      {
        handle: 'c2',
        card: {
          address: { line1: '300 Placeholder Road', city: 'Stone Mountain', state: 'GA', zip: '30083' },
          status: 'available',
          beds: 3,
          baths: 2,
          area: 'Stone Mountain',
          rent_min: 2300,
          payment_standard: 2000,
          notes: 'No bus nearby; a car is needed.',
          created_at: '2026-09-25',
          voucherSizes: [3],
          voucherSizesInferredFromBeds: false,
        },
        missing: ['Pets', 'Accessibility'],
        authority: 'matched',
        pairHistory: {
          sends: [{ at: '2026-10-05', kind: 'sent' }],
          declined: null,
          tours: [],
          daysSinceLastSend: 23,
        },
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 84,
          for: [
            { text: 'in Kirkwood, a preferred area', source: 'area' },
            { text: 'two blocks from the 21 bus', source: 'preferences' },
            { text: 'rent under payment standard', source: 'rent' },
          ],
          against: [{ text: 'tenant pays gas and electric', source: 'rent' }],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
        {
          candidateId: 'c2',
          score: 42,
          for: [{ text: '3 bedrooms, 2 baths', source: 'property_details' }],
          against: [
            { text: 'outside the preferred area', source: 'area' },
            { text: 'said too far without a car', source: 'feedback' },
            { text: 'rent $300 over payment standard', source: 'rent' },
          ],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 3. Good: workable with a real compromise.
  {
    title: 'Good: workable with a real compromise on area (a property anchor)',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['DeKalb County Housing Authority'] }, c1: { housingAuthority: 'DeKalb County Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '410 Example Boulevard', city: 'Tucker', state: 'GA', zip: '30084' },
        status: 'available',
        beds: 2,
        baths: 1,
        area: 'Tucker',
        rent_min: 1500,
        payment_standard: 1600,
        application_fee: 50,
        deposit: 800,
        notes: 'Second floor; laundry on site.',
        created_at: '2026-09-10',
        voucherSizes: [2],
        voucherSizesInferredFromBeds: false,
      },
      missing: ['Pets', 'Accessibility'],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Casey',
          lastName: 'Placeholder',
          status: 'searching',
          voucherSize: 2,
          created_at: '2026-06-30',
          notes: 'Wants a short commute to Decatur.',
          'Area preference': 'Decatur',
          'Maximum tenant portion': 500,
          lastHeardFrom: 'one to three months',
          propertiesSeen: [],
        },
        missing: [],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 66,
          for: [
            { text: 'rent under payment standard', source: 'rent' },
            { text: 'laundry on site', source: 'property_details' },
          ],
          against: [
            { text: 'Tucker, not Decatur', source: 'area' },
            { text: '$800 deposit', source: 'requirements' },
            { text: 'not heard from in over a month', source: 'recency' },
          ],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 4. Weak by the cap: a recorded No pets the tenant fails.
  {
    title: 'Weak: a recorded No pets the tenant fails, the failure first (capped)',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['Decatur Housing Authority'] }, c1: { housingAuthority: 'Decatur Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '77 Sample Street', city: 'Decatur', state: 'GA', zip: '30032' },
        status: 'available',
        beds: 2,
        baths: 1,
        area: 'Decatur',
        rent_min: 1400,
        payment_standard: 1600,
        no_pets: true,
        notes: 'Quiet street.',
        created_at: '2026-09-15',
        voucherSizes: [2],
        voucherSizesInferredFromBeds: false,
      },
      missing: ['Accessibility'],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Taylor',
          lastName: 'Example',
          status: 'searching',
          voucherSize: 2,
          pets: 'Two dogs, about 50 lb each',
          created_at: '2026-08-01',
          'Area preference': 'Decatur',
          'Maximum tenant portion': 500,
          lastHeardFrom: 'this week',
          propertiesSeen: [],
        },
        missing: [],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 30,
          for: [
            { text: 'in Decatur, the preferred area', source: 'area' },
            { text: 'rent under payment standard', source: 'rent' },
          ],
          against: [{ text: 'no pets, has two dogs', source: 'pets' }],
          unknowns: [],
          failedRequirements: ['no_pets'],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 5. Accommodation: No pets against an assistance animal.
  {
    title: 'Accommodation: No pets against an assistance animal - flagged, not failed, not lowered',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['Decatur Housing Authority'] }, c1: { housingAuthority: 'Decatur Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '88 Sample Street', city: 'Decatur', state: 'GA', zip: '30030' },
        status: 'available',
        beds: 1,
        baths: 1,
        area: 'Decatur',
        rent_min: 1250,
        payment_standard: 1400,
        accessibility: 'Elevator; wide doors',
        no_pets: true,
        created_at: '2026-09-18',
        voucherSizes: [1],
        voucherSizesInferredFromBeds: false,
      },
      missing: [],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Morgan',
          lastName: 'Sample',
          status: 'searching',
          voucherSize: 1,
          pets: 'Service dog (assistance animal)',
          created_at: '2026-08-20',
          'Area preference': 'Decatur',
          'Accessibility need': 'Elevator or ground floor',
          lastHeardFrom: 'this week',
          propertiesSeen: [],
        },
        missing: ['Maximum tenant portion'],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 85,
          for: [
            { text: 'elevator meets the access need', source: 'accessibility' },
            { text: 'in Decatur, the preferred area', source: 'area' },
            { text: 'rent under payment standard', source: 'rent' },
          ],
          against: [],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
        },
      ],
    },
  },
  // 6. Unlawful requirement: flagged and not applied.
  {
    title: 'Unlawful requirement: a no-kids rule is flagged on its field and not applied',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['East Point Housing Authority'] }, c1: { housingAuthority: 'East Point Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '15 Example Way', city: 'East Point', state: 'GA', zip: '30344' },
        status: 'available',
        beds: 3,
        baths: 1,
        area: 'East Point',
        rent_min: 1700,
        payment_standard: 1850,
        qualifications: 'No kids under 12. No evictions in the last 3 years.',
        created_at: '2026-09-05',
        voucherSizes: [3],
        voucherSizesInferredFromBeds: false,
      },
      missing: ['Pets', 'Accessibility'],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Avery',
          lastName: 'Example',
          status: 'searching',
          voucherSize: 3,
          created_at: '2026-08-11',
          notes: 'Has two children, ages 5 and 8.',
          'Area preference': 'East Point',
          'Maximum tenant portion': 550,
          lastHeardFrom: 'this week',
          propertiesSeen: [],
        },
        missing: [],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 78,
          for: [
            { text: 'in East Point, the preferred area', source: 'area' },
            { text: '3 bedrooms', source: 'property_details' },
            { text: 'rent under payment standard', source: 'rent' },
          ],
          against: [],
          unknowns: ['qualifications: no-kids rule not applied (fair housing)'],
          failedRequirements: [],
          fairHousingFlags: [{ kind: 'unlawful', field: 'qualifications' }],
        },
      ],
    },
  },
  // 7. Maybe: a staff Not interested plus unsure feedback.
  {
    title: 'Maybe: a staff Not interested plus unsure feedback on the same home weighs only slightly',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['Decatur Housing Authority'] }, c1: { housingAuthority: 'Decatur Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '400 Example Court', city: 'Decatur', state: 'GA', zip: '30030' },
        status: 'available',
        beds: 2,
        baths: 1,
        area: 'Decatur',
        rent_min: 1450,
        payment_standard: 1600,
        notes: 'Quiet cul-de-sac.',
        created_at: '2026-09-01',
        voucherSizes: [2],
        voucherSizesInferredFromBeds: false,
      },
      missing: ['Pets', 'Accessibility'],
    },
    // PR20: the seen home IS the anchor property, so the entry says
    // home: 'anchor' and homesSeen stays empty.
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Riley',
          lastName: 'Placeholder',
          status: 'searching',
          voucherSize: 2,
          created_at: '2026-07-22',
          notes: 'Prefers a quiet street.',
          'Area preference': 'Decatur',
          'Maximum tenant portion': 500,
          lastHeardFrom: 'this month',
          propertiesSeen: [
            {
              home: 'anchor',
              label: '400 Example Court, Decatur',
              sends: [{ at: '2026-09-12', kind: 'sent' }],
              daysSinceLastSend: 46,
              declined: { by: 'staff', at: '2026-09-14' },
              tours: [],
              feedback: ['[Auto - Sep 13] 400 Example Court, Decatur: on the fence - wants to see other homes first'],
            },
          ],
        },
        missing: [],
        authority: 'matched',
        pairHistory: {
          sends: [{ at: '2026-09-12', kind: 'sent' }],
          declined: { by: 'staff', at: '2026-09-14' },
          tours: [],
          daysSinceLastSend: 46,
        },
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 68,
          for: [
            { text: 'quiet street, as preferred', source: 'preferences' },
            { text: 'in Decatur, the preferred area', source: 'area' },
          ],
          against: [{ text: 'unsure after seeing it, 6 wks ago', source: 'feedback' }],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 8. Missing inputs: scored as uncertainty.
  {
    title: 'Missing inputs on both cards: scored as uncertainty, not guessed',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['DeKalb County Housing Authority', 'Stone Mtn HA'] }, c1: { housingAuthority: 'DeKalb County Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '500 Sample Parkway', city: 'Stone Mountain', state: 'GA', zip: '30083' },
        status: 'available',
        beds: 3,
        baths: 2,
        area: 'Stone Mountain',
        rent_min: 1950,
        notes: 'Large yard.',
        created_at: '2026-09-28',
        voucherSizes: [3],
        voucherSizesInferredFromBeds: true,
      },
      missing: ['Payment standard', 'Voucher sizes', 'Housing authority not on the organization list', 'Pets', 'Accessibility'],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Quinn',
          lastName: 'Example',
          status: 'searching',
          voucherSize: 3,
          created_at: '2026-09-30',
          notes: 'Needs to move by December.',
          lastHeardFrom: 'this week',
          propertiesSeen: [],
        },
        missing: ['Area preference', 'Maximum tenant portion'],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 55,
          for: [{ text: '3 bedrooms with a large yard', source: 'property_details' }],
          against: [],
          unknowns: ['whether the rent fits the budget', 'whether Stone Mountain suits the tenant'],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 9. Weak without a cap: an accessibility need the home cannot meet.
  {
    title: 'Weak without a cap: an accessibility need the home cannot meet (a tenant anchor)',
    direction: 'properties_for_tenant',
    offCard: { anchor: { housingAuthority: 'Atlanta Housing Authority' }, c1: { accepted_authorities: ['Atlanta Housing Authority'] } },
    anchor: {
      card: {
        firstName: 'Drew',
        lastName: 'Sample',
        status: 'searching',
        voucherSize: 1,
        created_at: '2026-08-05',
        'Area preference': 'Midtown',
        'Accessibility need': 'No stairs; wheelchair access',
        lastHeardFrom: 'this week',
        propertiesSeen: [],
      },
      missing: ['Maximum tenant portion'],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          address: { line1: '60 Example Place', city: 'Atlanta', state: 'GA', zip: '30308' },
          status: 'available',
          beds: 1,
          baths: 1,
          area: 'Midtown',
          rent_min: 1350,
          payment_standard: 1500,
          accessibility: 'Third floor walk-up; no elevator',
          created_at: '2026-09-12',
          voucherSizes: [1],
          voucherSizesInferredFromBeds: false,
        },
        missing: ['Pets'],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 12,
          for: [{ text: 'in Midtown, the preferred area', source: 'area' }],
          against: [{ text: 'third floor, no elevator', source: 'accessibility' }],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 10. Capped on the evictions part only; credit and income ignored.
  {
    title: 'Capped on the evictions part only: credit and income in the same field are ignored',
    direction: 'tenants_for_property',
    offCard: { anchor: { accepted_authorities: ['College Park Housing Authority'] }, c1: { housingAuthority: 'College Park Housing Authority' } },
    anchor: {
      card: {
        address: { line1: '25 Placeholder Avenue', city: 'College Park', state: 'GA', zip: '30337' },
        status: 'available',
        beds: 2,
        baths: 1,
        area: 'College Park',
        rent_min: 1350,
        payment_standard: 1500,
        qualifications: 'Credit score 650+, income 3x rent, no evictions in the last 5 years',
        created_at: '2026-09-08',
        voucherSizes: [2],
        voucherSizesInferredFromBeds: false,
      },
      missing: ['Pets', 'Accessibility'],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          firstName: 'Jamie',
          lastName: 'Example',
          status: 'searching',
          voucherSize: 2,
          evictions: 'Eviction in 2023',
          created_at: '2026-08-27',
          notes: '[Auto - Sep 3] Credit score around 540.',
          'Area preference': 'College Park',
          'Maximum tenant portion': 450,
          lastHeardFrom: 'this week',
          propertiesSeen: [],
        },
        missing: [],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 28,
          for: [
            { text: 'in College Park, the preferred area', source: 'area' },
            { text: 'rent under payment standard', source: 'rent' },
          ],
          against: [{ text: 'eviction in 2023 vs the 5-year rule', source: 'evictions' }],
          unknowns: [],
          failedRequirements: ['qualifications'],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 11. e2 (charter section 20 item 17): rent over the payment standard,
  // scored only from rent, payment standard, tenant-paid utilities and the
  // Maximum tenant portion. The credit and income line in Notes is not a
  // reason and does not move the score, up or down.
  {
    title: 'Rent over the payment standard: scored from rent, payment standard, utilities and the maximum portion; a credit and income line in Notes is ignored (a tenant anchor)',
    direction: 'properties_for_tenant',
    offCard: { anchor: { housingAuthority: 'Atlanta Housing Authority' }, c1: { accepted_authorities: ['Atlanta Housing Authority'] } },
    anchor: {
      card: {
        firstName: 'Parker',
        lastName: 'Placeholder',
        status: 'searching',
        voucherSize: 2,
        address: { line1: '31 Sample Terrace', city: 'Atlanta', state: 'GA', zip: '30310' },
        created_at: '2026-08-19',
        notes: 'Takes the bus to work.\nCredit score around 600. Income about $1,500 a month.',
        'Area preference': 'West End',
        'Maximum tenant portion': 300,
        lastHeardFrom: 'this week',
        propertiesSeen: [],
      },
      missing: [],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          address: { line1: '240 Example Street', city: 'Atlanta', state: 'GA', zip: '30310' },
          status: 'available',
          beds: 2,
          baths: 1,
          area: 'West End',
          rent_min: 1750,
          payment_standard: 1500,
          utilities: 'Electric',
          notes: 'Half a block from the bus.',
          created_at: '2026-09-22',
          voucherSizes: [2],
          voucherSizesInferredFromBeds: false,
        },
        missing: ['Pets', 'Accessibility'],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 48,
          for: [
            { text: 'in West End, the preferred area', source: 'area' },
            { text: 'half a block from the bus', source: 'property_details' },
          ],
          against: [
            { text: 'rent $250 over payment standard', source: 'rent' },
            { text: 'gap plus electric near the $300 max', source: 'rent' },
          ],
          unknowns: ['electric cost not stated'],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
  // 12. e3 (charter section 20 item 18): rent over the payment standard for
  // a tenant anchor whose Notes carry a gender-identity line. It scores
  // exactly as the same pair would without that line, and no reason or
  // unknown mentions it.
  {
    title: 'Rent over the payment standard: a gender-identity line in Notes changes nothing - same score, never a reason (a tenant anchor)',
    direction: 'properties_for_tenant',
    offCard: { anchor: { housingAuthority: 'Atlanta Housing Authority' }, c1: { accepted_authorities: ['Atlanta Housing Authority'] } },
    anchor: {
      card: {
        firstName: 'Rowan',
        lastName: 'Sample',
        status: 'searching',
        voucherSize: 1,
        address: { line1: '8 Placeholder Row', city: 'Atlanta', state: 'GA', zip: '30316' },
        created_at: '2026-08-26',
        notes: 'Wants to be near the train.\nIs a trans woman; uses she/her.',
        'Area preference': 'Kirkwood',
        'Maximum tenant portion': 250,
        lastHeardFrom: 'this week',
        propertiesSeen: [],
      },
      missing: [],
    },
    homesSeen: [],
    candidates: [
      {
        handle: 'c1',
        card: {
          address: { line1: '125 Sample Avenue', city: 'Atlanta', state: 'GA', zip: '30317' },
          status: 'available',
          beds: 1,
          baths: 1,
          area: 'Kirkwood',
          rent_min: 1450,
          payment_standard: 1300,
          notes: 'Four blocks from the train.',
          created_at: '2026-09-24',
          voucherSizes: [1],
          voucherSizesInferredFromBeds: false,
        },
        missing: ['Pets', 'Accessibility'],
        authority: 'matched',
        pairHistory: NO_HISTORY,
      },
    ],
    output: {
      candidates: [
        {
          candidateId: 'c1',
          score: 64,
          for: [
            { text: 'in Kirkwood, the preferred area', source: 'area' },
            { text: 'four blocks from the train', source: 'preferences' },
          ],
          against: [{ text: 'rent $150 over payment standard', source: 'rent' }],
          unknowns: [],
          failedRequirements: [],
          fairHousingFlags: [],
        },
      ],
    },
  },
];
