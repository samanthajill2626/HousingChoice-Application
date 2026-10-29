// WP1 B2a (spec D1, D2, D3, D13; plan PR3, WI11, WI12): THE ONE GATHERER the
// ranking job (S5) and the ranking read (S6) share, so both always score and
// judge from the same pool, the same cards and the same fingerprints.
//
// The two SIDES are pure and exported, so the counterfactual check (S8) builds
// its synthetic cards through exactly this code:
// - buildTenantSide: the unbounded seen set, the tenant card (tenantCard), its
//   gaps, the full card (propertyCard) of each LISTED seen home and the
//   tenant fingerprint over every seen home with a stored outcome.
// - buildPropertySide: the property card, its gaps, its facts (for the cap
//   and the flag check) and its fingerprint.
import type { OrgEntry } from '../../lib/orgNames.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import type { ListingSendItem } from '../../repos/listingSendsRepo.js';
import type { TourItem } from '../../repos/toursRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import { listedHomeIds, propertyCard, propertyFacts, tenantCard, type PropertyCardCtx, type PropertyFacts } from './cards.js';
import { propertyMissing, tenantMissing } from './completeness.js';
import { tenantCardFingerprint, unitCardFingerprint } from './fingerprints.js';
import { MISSING_UNIT_LABEL, buildSeenSet, type SeenHome } from './seenSet.js';
import type { Card, MissingFlag } from './types.js';

/** One tenant's card inputs: its listed sends, its tours, the seen units (one complete read) and, switch on, their landlords. */
export interface TenantReads {
  sends: ListingSendItem[];
  tours: TourItem[];
  units: ReadonlyMap<string, UnitItem>;
  landlords: ReadonlyMap<string, ContactItem>;
}

export interface SideCtx {
  now: Date;
  /** RANKING_SEEN_MAX. */
  seenMax: number;
  orgEntries: readonly OrgEntry[];
  /** RANKING_LANDLORD_CARD. */
  landlordCard: boolean;
}

/** A listed seen home as the call writes it once (spec D4): its label and its FULL property card. */
export interface SeenHomeCard {
  label: string;
  card: Card;
}

export interface TenantSide {
  card: Card;
  missing: MissingFlag[];
  /** The unbounded seen set. */
  seen: SeenHome[];
  /** The LISTED seen homes only, in card order. A home a complete read did not find has an empty card. */
  homes: Map<string, SeenHomeCard>;
  fingerprint: string;
}

export interface PropertySide {
  card: Card;
  missing: MissingFlag[];
  facts: PropertyFacts;
  fingerprint: string;
}

/** The property side: card, gaps, facts and fingerprint (spec D2.1, D3, D13). */
export function buildPropertySide(unit: UnitItem, ctx: PropertyCardCtx): PropertySide {
  const card = propertyCard(unit, ctx);
  return { card, missing: propertyMissing(unit, ctx), facts: propertyFacts(unit, ctx), fingerprint: unitCardFingerprint(card) };
}

function landlordOf(unit: UnitItem, landlords: ReadonlyMap<string, ContactItem>): ContactItem | null {
  return typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? (landlords.get(unit.landlordId) ?? null) : null;
}

/** The tenant side (spec D2.1-D2.3, D3, D13). Pure. */
export function buildTenantSide(contact: ContactItem, reads: TenantReads, ctx: SideCtx): TenantSide {
  const seen = buildSeenSet(reads);
  const homeCards = new Map<string, Card>();
  for (const home of seen) {
    if (home.unit === null) continue;
    homeCards.set(
      home.unitId,
      propertyCard(home.unit, {
        orgEntries: ctx.orgEntries,
        landlordCard: ctx.landlordCard,
        landlord: landlordOf(home.unit, reads.landlords),
      }),
    );
  }
  const card = tenantCard(contact, { now: ctx.now, seenMax: ctx.seenMax, seen });
  const fingerprint = tenantCardFingerprint({
    card,
    notesText: contact['notes'],
    seen,
    homeCardFingerprint: (unitId) => {
      const homeCard = homeCards.get(unitId);
      return homeCard === undefined ? null : unitCardFingerprint(homeCard);
    },
  });
  const labels = new Map(seen.map((home) => [home.unitId, home.label] as const));
  const homes = new Map<string, SeenHomeCard>();
  for (const unitId of listedHomeIds(card)) {
    homes.set(unitId, { label: labels.get(unitId) ?? MISSING_UNIT_LABEL, card: homeCards.get(unitId) ?? {} });
  }
  return { card, missing: tenantMissing(contact), seen, homes, fingerprint };
}
