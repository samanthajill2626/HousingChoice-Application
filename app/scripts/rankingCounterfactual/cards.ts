// WP1 B2a spec D17 / plan PR7: the counterfactual check builds every card
// with PRODUCTION code - tenantCard / propertyCard / propertyFacts (S3,
// services/ranking/cards.ts) and the completeness flags (S3,
// services/ranking/completeness.ts) - bypassing only the pool. This is the
// one script module that reaches S3's card context; every other script file
// sees only PreparedTenant / PreparedProperty.
//
// S3 NAMES USED HERE (S3's published shapes, IR16): PropertyCardCtx
// { orgEntries, landlordCard, landlord }, TenantCardCtx { now, seenMax,
// seen }, tenantCard, propertyCard, propertyFacts, tenantMissing,
// propertyMissing. The contexts: the starting organization list (the
// authorities map against it) with the landlord card switch OFF; the clock
// (COUNTERFACTUAL_NOW, so every card is byte-stable), the D19 default seen
// bound (8) and an EMPTY seen set (synthetic tenants have no sends and no
// tours). Each property also carries its pair authority fact (charter
// section 20 item 18), from production's mapAuthorities and
// pairAuthorityFact over the same organization list.
import type { OrgEntry } from '../../src/lib/orgNames.js';
import { buildStartingEntries } from '../../src/lib/orgStartingList.js';
import type { ContactItem } from '../../src/repos/contactsRepo.js';
import { authoritiesOf } from '../../src/lib/unitFields.js';
import type { UnitItem } from '../../src/repos/unitsRepo.js';
import { propertyCard, propertyFacts, tenantCard, type PropertyCardCtx, type TenantCardCtx } from '../../src/services/ranking/cards.js';
import { propertyMissing, tenantMissing } from '../../src/services/ranking/completeness.js';
import { mapAuthorities, pairAuthorityFact } from '../../src/services/ranking/pool.js';
import type { PropertyFactsLike } from '../../src/services/ranking/prompt.js';
import type { AuthorityFact, Card, MissingFlag } from '../../src/services/ranking/types.js';
import { COUNTERFACTUAL_NOW } from './records.js';

export interface PreparedTenant {
  contactId: string;
  card: Card;
  missing: MissingFlag[];
  /** The context the card was built with (tests rebuild the card through tenantCard). */
  ctx: TenantCardCtx;
}

export interface PreparedProperty {
  unitId: string;
  card: Card;
  missing: MissingFlag[];
  facts: PropertyFactsLike;
  /** The authority fact of any pair this property is in (charter section 20 item 18). */
  authority: AuthorityFact;
}

let entriesCache: OrgEntry[] | undefined;

/** The starting organization list, with stable synthetic ids. */
export function counterfactualOrgEntries(): OrgEntry[] {
  if (entriesCache === undefined) {
    let n = 0;
    entriesCache = buildStartingEntries(COUNTERFACTUAL_NOW, () => `cf-org-${(n += 1)}`);
  }
  return entriesCache;
}

/** RANKING_SEEN_MAX's D19 default. */
const SEEN_MAX = 8;

function propertyCtx(): PropertyCardCtx {
  return { orgEntries: counterfactualOrgEntries(), landlordCard: false, landlord: null };
}

function tenantCtx(): TenantCardCtx {
  return { now: new Date(COUNTERFACTUAL_NOW), seenMax: SEEN_MAX, seen: [] };
}

export function prepareTenant(contact: ContactItem): PreparedTenant {
  const ctx = tenantCtx();
  return { contactId: contact.contactId, card: tenantCard(contact, ctx), missing: tenantMissing(contact), ctx };
}

export function prepareProperty(unit: UnitItem): PreparedProperty {
  const ctx = propertyCtx();
  return {
    unitId: unit.unitId,
    card: propertyCard(unit, ctx),
    missing: propertyMissing(unit, ctx),
    facts: propertyFacts(unit, ctx),
    authority: pairAuthorityFact(mapAuthorities(ctx.orgEntries, authoritiesOf(unit))),
  };
}
