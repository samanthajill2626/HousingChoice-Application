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
import type { AppConfig } from '../../lib/config.js';
import { contactDisplayName } from '../../lib/contactName.js';
import type { Logger } from '../../lib/logger.js';
import type { OrgEntry } from '../../lib/orgNames.js';
import { propertyLabel } from '../../lib/propertyLabel.js';
import { hasSmsConsent } from '../../lib/smsCompliance.js';
import { authoritiesOf } from '../../lib/unitFields.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../../repos/contactsRepo.js';
import type { RepoDeps } from '../../repos/conversationsRepo.js';
import { createListingSendsRepo, type ListingSendItem, type ListingSendsRepo } from '../../repos/listingSendsRepo.js';
import { createOrgListRepo } from '../../repos/orgListRepo.js';
import { createPlacementsRepo } from '../../repos/placementsRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../../repos/toursRepo.js';
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../../repos/unitsRepo.js';
import { createOrgNamesService } from '../orgNames.js';
import { listedHomeIds, propertyCard, propertyFacts, tenantCard, type PropertyCardCtx, type PropertyFacts } from './cards.js';
import { propertyMissing, tenantMissing } from './completeness.js';
import { pairHistoryFingerprint, tenantCardFingerprint, unitCardFingerprint } from './fingerprints.js';
import { pairHistoryOf } from './pairHistory.js';
import { computePool, mapAuthorities, mapWithConcurrency, pairAuthorityFact, type PoolDeps, type PoolFailure, type PoolOpts } from './pool.js';
import { MISSING_UNIT_LABEL, NO_ADDRESS_LABEL, buildSeenSet, seenUnitIds, type SeenHome } from './seenSet.js';
import type {
  AnchorNote,
  AnchorRef,
  AuthorityFact,
  AuthorityMapping,
  Card,
  CardFingerprints,
  Direction,
  MissingFlag,
  PairHistory,
} from './types.js';

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

// --- assembleRanking -----------------------------------------------------------

export interface AssembleDeps extends PoolDeps {
  contacts: Pick<ContactsRepo, 'getById' | 'listByType' | 'getManyByIds'>;
  units: Pick<UnitsRepo, 'getById' | 'listByStatus' | 'getManyByIds'>;
  listingSends: Pick<ListingSendsRepo, 'listByContact'>;
  tours: Pick<ToursRepo, 'listByTenant'>;
  config: Pick<
    AppConfig,
    'rankingPoolWindowDays' | 'rankingMaxPool' | 'rankingReadConcurrency' | 'rankingSeenMax' | 'rankingLandlordCard'
  >;
}

export type AssembleOpts = PoolOpts;

export interface AssembledAnchor {
  ref: AnchorRef;
  record: ContactItem | UnitItem;
  /** IR7: a tenant's name, else its contactId; a property's label, else NO_ADDRESS_LABEL (tenantDisplay / propertyDisplay). */
  display: string;
  card: Card;
  missing: MissingFlag[];
  anchorNotes: AnchorNote[];
  /** The anchor's half of every pair's fingerprints (spec D9 cardChanged). */
  fingerprint: string;
  /** Property anchor: its facts (every candidate carries the same). Tenant anchor: null. */
  propertyFacts: PropertyFacts | null;
  /** Property anchor: its recorded authorities mapped. Tenant anchor: both empty. */
  authorities: AuthorityMapping;
}

interface CandidateBase {
  tenantId: string;
  unitId: string;
  /** The candidate record's id: the contactId (property anchor) or the unitId (tenant anchor). */
  candidateId: string;
  /** IR7: tenantDisplay / propertyDisplay - always a string; never sent to the model. */
  display: string;
  record: ContactItem | UnitItem;
  /** Property anchor only: hasSmsConsent, shown by B3/B4; never a pool rule. */
  hasConsent?: boolean;
  /** Tenant anchor only: the property's Priority switch; read here, never sent to the model. */
  priority?: boolean;
}

export interface VerifiedCandidate extends CandidateBase {
  unverified: false;
  card: Card;
  missing: MissingFlag[];
  /**
   * Charter section 20 item 18: the pair's authority fact, from the mapping
   * the pool fenced this pair with (pool.ts pairAuthorityFact). Sent to the
   * model; in no fingerprint (it moves only with an authority mapping).
   */
  authority: AuthorityFact;
  pairHistory: PairHistory;
  fingerprints: CardFingerprints;
  /** The pair's property's facts (the cap and the flag check read them). */
  propertyFacts: PropertyFacts;
}

/** Spec D2.3: a candidate whose OWN card reads did not complete - never read as "not on file". */
export interface UnverifiedCandidate extends CandidateBase {
  unverified: true;
  card: null;
  missing: null;
  pairHistory: null;
  fingerprints: null;
  /** The anchor's facts for a property anchor; null for a tenant anchor. */
  propertyFacts: PropertyFacts | null;
}

export type AssembledCandidate = VerifiedCandidate | UnverifiedCandidate;

export interface AssembledRanking {
  ok: true;
  direction: Direction;
  anchor: AssembledAnchor;
  /** Pool order; an unverified candidate stays in its place. */
  candidates: AssembledCandidate[];
  /** Every listed seen home of every tenant card, by first reference in pool order. */
  homes: Map<string, SeenHomeCard>;
  unverifiedCount: number;
}

export interface AnchorUnreadable {
  ok: false;
  reason: 'anchor_unreadable';
  message: string;
  /**
   * PR38 / PR43: set when the anchor's own reads fail AFTER its pool was
   * computed (a tenant anchor's seen set; a property anchor's landlord read,
   * switch on) - the pool's candidate ids in pool order (unitIds, or
   * contactIds), so the job (S5) records each as notScored `unreadable`.
   * Absent when no pool was computed.
   */
  candidateIds?: string[];
}

export type AssembleResult = AssembledRanking | PoolFailure | AnchorUnreadable;

export const ASSEMBLE_MESSAGES = {
  anchorUnreadable: 'This record could not be read in full. Try again.',
} as const;

type Settled<T> = { ok: true; value: T } | { ok: false; err: unknown };

async function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work };
  } catch (err) {
    return { ok: false, err };
  }
}

/** The landlords of record of `units`, one complete batch read (switch on only). */
async function readLandlords(
  units: readonly UnitItem[],
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
): Promise<ReadonlyMap<string, ContactItem>> {
  const ids = [
    ...new Set(
      units.flatMap((unit) => (typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? [unit.landlordId] : [])),
    ),
  ].sort();
  if (ids.length === 0) return new Map();
  return contacts.getManyByIds(ids, { requireComplete: true });
}

/** IR7: a tenant's display - its name, else its contactId (the id never reaches the model). */
export function tenantDisplay(contact: ContactItem): string {
  return contactDisplayName(contact) ?? contact.contactId;
}

/**
 * IR7: a property's display - its label; else a legacy plain-string address
 * as stored, trimmed (WORKLIST WL-S3-3, as every other staff surface shows
 * it); else the no-address placeholder (PR23). DISPLAY ONLY: the label the
 * model sees (SeenHome.label) and the attach step (attachLabel) never use it.
 */
export function propertyDisplay(unit: UnitItem): string {
  const label = propertyLabel(unit);
  if (label !== undefined) return label;
  // UnitItem types `address` as structured; a legacy row may hold a string.
  const stored: unknown = unit.address;
  if (typeof stored === 'string' && stored.trim().length > 0) return stored.trim();
  return NO_ADDRESS_LABEL;
}

export interface CreateAssembleDepsOpts extends Pick<RepoDeps, 'env' | 'doc'> {
  config: AppConfig;
  logger: Logger;
}

/**
 * IR9: the production deps of the gatherer - the contacts, units, placements,
 * listing sends and tours repos and the organization names service, all on
 * the given env / doc (the WI18 test runs on a throwaway TABLE_PREFIX). The
 * job (S5 jobWiring.ts) and the read (S6) both build their deps here.
 */
export function createAssembleDeps(opts: CreateAssembleDepsOpts): AssembleDeps {
  const repo: RepoDeps = {
    logger: opts.logger,
    ...(opts.env !== undefined && { env: opts.env }),
    ...(opts.doc !== undefined && { doc: opts.doc }),
  };
  return {
    contacts: createContactsRepo(repo),
    units: createUnitsRepo(repo),
    placements: createPlacementsRepo(repo),
    listingSends: createListingSendsRepo(repo),
    tours: createToursRepo(repo),
    orgNames: createOrgNamesService({ orgListRepo: createOrgListRepo(repo), logger: opts.logger }),
    config: opts.config,
    logger: opts.logger,
  };
}

async function readLandlordOf(
  unit: UnitItem,
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
  landlordCard: boolean,
): Promise<ContactItem | null> {
  if (!landlordCard) return null;
  return (await readLandlords([unit], contacts)).get(unit.landlordId) ?? null;
}

/**
 * Spec D2.3: one tenant card's inputs - one listByContact, one listByTenant,
 * ONE units batch read for the whole seen set (requireComplete: an
 * unprocessed key THROWS, never reads as "not on file") and, switch on, one
 * batch read of those units' landlords. Throws on any failed read; the caller
 * scopes the failure to this card.
 */
export async function readTenantInputs(
  tenantId: string,
  deps: Pick<AssembleDeps, 'contacts' | 'units' | 'listingSends' | 'tours'>,
  landlordCard: boolean,
): Promise<TenantReads> {
  const [sends, tours] = await Promise.all([deps.listingSends.listByContact(tenantId), deps.tours.listByTenant(tenantId)]);
  const ids = seenUnitIds(sends, tours);
  const units: ReadonlyMap<string, UnitItem> =
    ids.length === 0 ? new Map() : await deps.units.getManyByIds(ids, { requireComplete: true });
  const landlords = landlordCard ? await readLandlords([...units.values()], deps.contacts) : new Map<string, ContactItem>();
  return { sends, tours, units, landlords };
}

/**
 * THE gatherer (plan PR3): the pool, the anchor card, every candidate card
 * with its missing flags, pair history, fingerprints and the facts of the
 * pair's property, and the full card of every listed seen home. Candidate
 * reads run with at most RANKING_READ_CONCURRENCY in flight. A candidate
 * whose own reads fail is returned in place, `unverified`; a failure of the
 * anchor's own reads is `anchor_unreadable`; a pool failure passes through.
 * Any other error (the pool's list reads) propagates to the caller.
 */
export async function assembleRanking(anchor: AnchorRef, opts: AssembleOpts, deps: AssembleDeps): Promise<AssembleResult> {
  const pool = await computePool(anchor, opts, deps);
  if (!pool.ok) return pool;
  const ctx: SideCtx = {
    now: opts.now,
    seenMax: deps.config.rankingSeenMax,
    orgEntries: pool.orgEntries,
    landlordCard: deps.config.rankingLandlordCard,
  };
  const limit = deps.config.rankingReadConcurrency;
  const unreadable = (err: unknown): AnchorUnreadable => {
    deps.logger?.warn({ anchorKind: anchor.kind, anchorId: anchor.id, err }, 'ranking: the anchor card could not be read');
    return { ok: false, reason: 'anchor_unreadable', message: ASSEMBLE_MESSAGES.anchorUnreadable };
  };
  const unverifiedLog = (candidateId: string, err: unknown): void => {
    deps.logger?.warn(
      { anchorKind: anchor.kind, anchorId: anchor.id, candidateId, err },
      'ranking: a candidate card could not be read; the candidate is unverified',
    );
  };

  if (pool.kind === 'unit') {
    const unit = pool.anchorRecord;
    const landlord = await settle(readLandlordOf(unit, deps.contacts, ctx.landlordCard));
    if (!landlord.ok) {
      return { ...unreadable(landlord.err), candidateIds: pool.candidates.map((contact) => contact.contactId) };
    }
    const anchorSide = buildPropertySide(unit, { orgEntries: ctx.orgEntries, landlordCard: ctx.landlordCard, landlord: landlord.value });
    // Every candidate's pair property is the anchor: the pool fenced them all with pool.authorities.
    const authority = pairAuthorityFact(pool.authorities);
    const results = await mapWithConcurrency(pool.candidates, limit, async (contact) => {
      const base = {
        tenantId: contact.contactId,
        unitId: unit.unitId,
        candidateId: contact.contactId,
        display: tenantDisplay(contact),
        record: contact,
        hasConsent: hasSmsConsent(contact),
      };
      const reads = await settle(readTenantInputs(contact.contactId, deps, ctx.landlordCard));
      if (!reads.ok) {
        unverifiedLog(contact.contactId, reads.err);
        const candidate: UnverifiedCandidate = {
          ...base,
          unverified: true,
          card: null,
          missing: null,
          pairHistory: null,
          fingerprints: null,
          propertyFacts: anchorSide.facts,
        };
        return { candidate, homes: new Map<string, SeenHomeCard>() };
      }
      const side = buildTenantSide(contact, reads.value, ctx);
      const pairHistory = pairHistoryOf(side.seen.find((home) => home.unitId === unit.unitId), opts.now);
      const candidate: VerifiedCandidate = {
        ...base,
        unverified: false,
        card: side.card,
        missing: side.missing,
        authority,
        pairHistory,
        fingerprints: {
          tenantCard: side.fingerprint,
          unitCard: anchorSide.fingerprint,
          pairHistory: pairHistoryFingerprint(pairHistory),
        },
        propertyFacts: anchorSide.facts,
      };
      return { candidate, homes: side.homes };
    });
    const homes = new Map<string, SeenHomeCard>();
    for (const result of results) {
      for (const [unitId, home] of result.homes) if (!homes.has(unitId)) homes.set(unitId, home);
    }
    const candidates: AssembledCandidate[] = results.map((result) => result.candidate);
    return {
      ok: true,
      direction: 'tenants_for_property',
      anchor: {
        ref: anchor,
        record: unit,
        display: propertyDisplay(unit),
        card: anchorSide.card,
        missing: anchorSide.missing,
        anchorNotes: pool.anchorNotes,
        fingerprint: anchorSide.fingerprint,
        propertyFacts: anchorSide.facts,
        authorities: pool.authorities,
      },
      candidates,
      homes,
      unverifiedCount: candidates.filter((candidate) => candidate.unverified).length,
    };
  }

  const anchorTenant = pool.anchorRecord;
  const anchorReads = await settle(readTenantInputs(anchorTenant.contactId, deps, ctx.landlordCard));
  if (!anchorReads.ok) {
    return { ...unreadable(anchorReads.err), candidateIds: pool.candidates.map((unit) => unit.unitId) };
  }
  const anchorSide = buildTenantSide(anchorTenant, anchorReads.value, ctx);
  const candidates = await mapWithConcurrency(pool.candidates, limit, async (unit): Promise<AssembledCandidate> => {
    const base = {
      tenantId: anchorTenant.contactId,
      unitId: unit.unitId,
      candidateId: unit.unitId,
      display: propertyDisplay(unit),
      record: unit,
      priority: unit.priority === true,
    };
    const landlord = await settle(readLandlordOf(unit, deps.contacts, ctx.landlordCard));
    if (!landlord.ok) {
      unverifiedLog(unit.unitId, landlord.err);
      return { ...base, unverified: true, card: null, missing: null, pairHistory: null, fingerprints: null, propertyFacts: null };
    }
    const side = buildPropertySide(unit, { orgEntries: ctx.orgEntries, landlordCard: ctx.landlordCard, landlord: landlord.value });
    const pairHistory = pairHistoryOf(anchorSide.seen.find((home) => home.unitId === unit.unitId), opts.now);
    return {
      ...base,
      unverified: false,
      card: side.card,
      missing: side.missing,
      // The same mapping tenantPool fenced this unit with (pool order, same organization list).
      authority: pairAuthorityFact(mapAuthorities(ctx.orgEntries, authoritiesOf(unit))),
      pairHistory,
      fingerprints: {
        tenantCard: anchorSide.fingerprint,
        unitCard: side.fingerprint,
        pairHistory: pairHistoryFingerprint(pairHistory),
      },
      propertyFacts: side.facts,
    };
  });
  return {
    ok: true,
    direction: 'properties_for_tenant',
    anchor: {
      ref: anchor,
      record: anchorTenant,
      display: tenantDisplay(anchorTenant),
      card: anchorSide.card,
      missing: anchorSide.missing,
      anchorNotes: pool.anchorNotes,
      fingerprint: anchorSide.fingerprint,
      propertyFacts: null,
      authorities: pool.authorities,
    },
    candidates,
    homes: anchorSide.homes,
    unverifiedCount: candidates.filter((candidate) => candidate.unverified).length,
  };
}

/**
 * FB4 (PR16): the anchor's missing flags for a pool over the ceiling (the
 * read's anchor block), from what the PoolFailure carries - a tenant
 * anchor's tenantMissing; a property anchor's propertyMissing with the
 * pool's organization list and, switch on, its landlord (read here). [] for
 * any other failure. THROWS when the landlord read cannot finish: the
 * anchor's own read, so the read answers 503 (PR17).
 */
export async function poolTooLargeMissing(
  failure: PoolFailure,
  deps: Pick<AssembleDeps, 'contacts' | 'config'>,
): Promise<MissingFlag[]> {
  const found = failure.anchor;
  if (failure.reason !== 'pool_too_large' || found === undefined) return [];
  if (found.kind === 'tenant') return tenantMissing(found.record);
  const landlordCard = deps.config.rankingLandlordCard;
  const landlord = await readLandlordOf(found.record, deps.contacts, landlordCard);
  return propertyMissing(found.record, { orgEntries: failure.orgEntries ?? [], landlordCard, landlord });
}

/**
 * IR9: each property's CURRENT-card facts, for the run detail's open-flag
 * check (S6): one complete units read for the distinct ids, then
 * propertyFactsOf. A unit the complete read did not find is absent; an
 * incomplete read THROWS (the caller scopes the failure). The facts read no
 * authority mapping, so no organization list is read.
 */
export async function loadPropertyFacts(
  unitIds: readonly string[],
  deps: Pick<AssembleDeps, 'contacts' | 'units' | 'config'>,
): Promise<Map<string, PropertyFacts>> {
  const ids = [...new Set(unitIds)].sort();
  if (ids.length === 0) return new Map();
  return propertyFactsOf(await deps.units.getManyByIds(ids, { requireComplete: true }), deps);
}

/**
 * The CURRENT-card facts of units already read: switch on, one landlord
 * read (complete, THROWS when it cannot finish), then propertyFacts. The one
 * builder loadPropertyFacts and the property page's flag read share
 * (propertyFlags.ts reads its one unit consistently, so a re-check right
 * after a save sees the saved text - spec D10 rev 7).
 */
export async function propertyFactsOf(
  units: ReadonlyMap<string, UnitItem>,
  deps: { contacts: Pick<ContactsRepo, 'getManyByIds'>; config: Pick<AppConfig, 'rankingLandlordCard'> },
): Promise<Map<string, PropertyFacts>> {
  const out = new Map<string, PropertyFacts>();
  const landlordCard = deps.config.rankingLandlordCard;
  const landlords = landlordCard ? await readLandlords([...units.values()], deps.contacts) : new Map<string, ContactItem>();
  for (const [unitId, unit] of units) {
    out.set(unitId, propertyFacts(unit, { orgEntries: [], landlordCard, landlord: landlordOf(unit, landlords) }));
  }
  return out;
}
