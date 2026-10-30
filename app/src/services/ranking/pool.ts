// WP1 B2a (spec D1; charter 5; plan PR3, WI20): THE pool - the eligibility
// fences and nothing else. Computed when called: by the ranking job when it
// runs (the pool scored is the pool at run time) and by the ranking read, both
// through assemble.ts. The rules are exported pure functions (the cards and
// the tests reuse them); computePool reads only through its injected deps.
//
// - Voucher size: a property's sizes come only from acceptedVoucherSizes,
//   clamped to 0-4 and de-duplicated as the composer prefill does
//   (bedroomSizesOfFilter), compared with the server twin voucherSizeMatches,
//   so 4 means 4 or more.
// - Housing authority: each recorded name is mapped with the EXISTING server
//   rule, checkScalarWrite(entries, 'audience_filter', name, undefined); none
//   recorded or none mapped limits nothing; some mapped limits to those, the
//   tenant's authority compared with case and spacing folded (normalizeOrgText
//   on both sides, never fuzzy). A deliberate widening of the send-time
//   filter's exact compare (services/audienceResolution.ts).
// - Sendable: not opted out, not unreachable, has a phone (the three tests
//   audienceResolution applies). SMS consent is NOT a rule.
// - Window (property anchor only): last heard from within
//   RANKING_POOL_WINDOW_DAYS, else created_at, except a contact carrying
//   imported_from, which never uses that fallback; lifted by includeOlder.
import { bedroomSizesOfFilter, voucherSizeMatches } from '../../lib/blastAudienceRules.js';
import type { AppConfig } from '../../lib/config.js';
import type { Logger } from '../../lib/logger.js';
import { checkScalarWrite, normalizeOrgText, type OrgEntry } from '../../lib/orgNames.js';
import { acceptedVoucherSizes, authoritiesOf } from '../../lib/unitFields.js';
import { isDeleted as isContactDeleted, type ContactItem, type ContactsRepo } from '../../repos/contactsRepo.js';
import type { PlacementsRepo } from '../../repos/placementsRepo.js';
import { isDeleted as isUnitDeleted, type UnitItem, type UnitsRepo } from '../../repos/unitsRepo.js';
import type { OrgNamesService } from '../orgNames.js';
import { DAY_MS, instantMs } from './pairHistory.js';
import type { AnchorNote, AnchorRef, AuthorityFact, AuthorityMapping } from './types.js';
// (FB4) RankingAnchorRecord, used by PoolFailure, is declared below with readRankingAnchor.

/** Spec D1: each recorded name mapped by the server rule; mapped and unmapped de-duplicated in property order. */
export function mapAuthorities(entries: readonly OrgEntry[], names: readonly string[]): AuthorityMapping {
  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text === '') continue;
    const check = checkScalarWrite(entries, 'audience_filter', text, undefined);
    if (check.ok && check.value !== null) {
      if (!mapped.includes(check.value)) mapped.push(check.value);
    } else if (!unmapped.includes(text)) {
      unmapped.push(text);
    }
  }
  return { mapped, unmapped };
}

/**
 * THE voucher-size normalizer (FB20) for the pool, the card and the
 * completeness pass: acceptedVoucherSizes, then whole sizes 0 and up,
 * clamped to 4 (4 means 4 or more), de-duplicated, ascending - exactly the
 * composer prefill (bedroomSizesOfFilter). [] takes every size.
 */
export function unitVoucherSizes(unit: Pick<UnitItem, 'voucher_size_accepted' | 'beds'>): number[] {
  return bedroomSizesOfFilter({ bedroomSizes: acceptedVoucherSizes(unit) });
}

/** The RECORDED sizes only, through the same normalizer (a size inferred from beds is not recorded). */
export function recordedVoucherSizes(unit: Pick<UnitItem, 'voucher_size_accepted'>): number[] {
  return unitVoucherSizes({ voucher_size_accepted: unit.voucher_size_accepted });
}

/** A tenant's voucher size, a whole number, else undefined. */
export function tenantVoucherSize(contact: ContactItem): number | undefined {
  const size = contact['voucherSize'];
  return typeof size === 'number' && Number.isInteger(size) ? size : undefined;
}

/**
 * Spec D1: the pool fences on authority only when the property records a name
 * the organization list maps; none recorded or none mapped limits nothing.
 * THE one decision authorityAllows and pairAuthorityFact both read.
 */
export function authorityFilters(mapping: AuthorityMapping): boolean {
  return mapping.mapped.length > 0;
}

/** Spec D1: true when the property's mapped authorities admit the tenant's. */
export function authorityAllows(mapping: AuthorityMapping, tenantAuthority: unknown): boolean {
  if (!authorityFilters(mapping)) return true;
  if (typeof tenantAuthority !== 'string') return false;
  const folded = normalizeOrgText(tenantAuthority);
  if (folded === '') return false;
  return mapping.mapped.some((name) => normalizeOrgText(name) === folded);
}

/**
 * Charter section 20 item 18: the authority fact of a pair IN the pool, from
 * the pair property's mapping (the one the pool fenced with): "matched" when
 * the pool fenced on authority (so this pair passed it), "unconfirmed" when
 * it did not.
 */
export function pairAuthorityFact(mapping: AuthorityMapping): AuthorityFact {
  return authorityFilters(mapping) ? 'matched' : 'unconfirmed';
}

/** Not opted out, not unreachable, has a phone. */
export function isSendable(contact: ContactItem): boolean {
  return (
    contact.sms_opt_out !== true &&
    contact.sms_unreachable !== true &&
    typeof contact.phone === 'string' &&
    contact.phone.length > 0
  );
}

/**
 * Spec D1 / charter 5 (IR8): the instant the pool WINDOW counts from - last
 * heard from, else created_at unless the contact carries imported_from (that
 * fallback is never used for an import); null when neither applies.
 * inPoolWindow calls it. The read's tie order uses sortRecencyAt instead
 * (spec D9 has no import exception; FB19).
 */
export function poolRecencyAt(contact: ContactItem): string | null {
  const heard = contact.last_heard_from_at;
  if (typeof heard === 'string' && instantMs(heard) !== undefined) return heard;
  if (contact['imported_from'] !== undefined) return null;
  const created = contact.created_at;
  return typeof created === 'string' && instantMs(created) !== undefined ? created : null;
}

/**
 * Spec D9 (FB19): the property-anchor tie order's instant - last heard from,
 * falling back to created_at, WITH NO import exception (that exception is
 * D1's window rule, poolRecencyAt). Null when neither parses. S6 sorts by it
 * on candidate.record.
 */
export function sortRecencyAt(contact: ContactItem): string | null {
  const heard = contact.last_heard_from_at;
  if (typeof heard === 'string' && instantMs(heard) !== undefined) return heard;
  const created = contact.created_at;
  return typeof created === 'string' && instantMs(created) !== undefined ? created : null;
}

/** Spec D1 recency: poolRecencyAt within the window (inclusive). */
export function inPoolWindow(contact: ContactItem, now: Date, windowDays: number): boolean {
  const basis = instantMs(poolRecencyAt(contact));
  if (basis === undefined) return false;
  return now.getTime() - basis <= windowDays * DAY_MS;
}

/** Spec D1: a tenant anchor that would not itself be in a pool says why. */
export function tenantAnchorNotes(contact: ContactItem): AnchorNote[] {
  const notes: AnchorNote[] = [];
  if (contact.status !== 'searching') notes.push('not_searching');
  if (!isSendable(contact)) notes.push('not_sendable');
  return notes;
}

/** Spec D1: a property anchor that is not available says so. */
export function unitAnchorNotes(unit: Pick<UnitItem, 'status'>): AnchorNote[] {
  return unit.status === 'available' ? [] : ['not_available'];
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- computePool -------------------------------------------------------------

export interface PoolDeps {
  contacts: Pick<ContactsRepo, 'getById' | 'listByType'>;
  units: Pick<UnitsRepo, 'getById' | 'listByStatus'>;
  placements: Pick<PlacementsRepo, 'hasActivePlacementForOtherTenant'>;
  orgNames: Pick<OrgNamesService, 'read'>;
  config: Pick<AppConfig, 'rankingPoolWindowDays' | 'rankingMaxPool' | 'rankingReadConcurrency'>;
  logger?: Logger;
}

export interface PoolOpts {
  /** Lifts the recency window (property anchor only; ignored for a tenant anchor). */
  includeOlder: boolean;
  now: Date;
}

interface PoolBase {
  ok: true;
  anchorNotes: AnchorNote[];
  /** Property anchor: its recorded authorities mapped. Tenant anchor: both empty. */
  authorities: AuthorityMapping;
  /** The organization list as read once for this pool; the cards map every property with it. */
  orgEntries: readonly OrgEntry[];
}

/** A property anchor: candidates are tenants, ascending contactId. */
export interface PropertyPool extends PoolBase {
  kind: 'unit';
  anchorRecord: UnitItem;
  candidates: ContactItem[];
}

/** A tenant anchor: candidates are properties, ascending unitId. */
export interface TenantPool extends PoolBase {
  kind: 'tenant';
  anchorRecord: ContactItem;
  candidates: UnitItem[];
}

export type PoolFailureReason = 'anchor_not_found' | 'org_list_failed' | 'pool_too_large';

export interface PoolFailure {
  ok: false;
  reason: PoolFailureReason;
  message: string;
  /**
   * pool_too_large only (PR16, FB4): the pool's size, the anchor (record,
   * and by kind), its notes and the organization list the pool read - what
   * the read's anchor block needs, its missing flags included
   * (assemble.ts poolTooLargeMissing). `anchorRecord` is `anchor.record`.
   */
  size?: number;
  anchorRecord?: ContactItem | UnitItem;
  anchor?: RankingAnchorRecord;
  anchorNotes?: AnchorNote[];
  orgEntries?: readonly OrgEntry[];
}

export type PoolResult = PropertyPool | TenantPool | PoolFailure;

export const POOL_MESSAGES = {
  anchorNotFound: 'This record was not found.',
  orgListFailed: 'The organization list could not be read, so the pool could not be worked out. Press Rank again.',
  poolTooLarge: (size: number): string => `Pool too large to rank (${size} candidates)`,
} as const;

const PAGE_SIZE = 200;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function notFound(): PoolFailure {
  return { ok: false, reason: 'anchor_not_found', message: POOL_MESSAGES.anchorNotFound };
}

/** A rankable anchor's record, by kind. */
export type RankingAnchorRecord = { kind: 'unit'; record: UnitItem } | { kind: 'tenant'; record: ContactItem };

export interface AnchorReadDeps {
  contacts: Pick<ContactsRepo, 'getById'>;
  units: Pick<UnitsRepo, 'getById'>;
}

/**
 * PR21: THE anchor-exists rule (spec D12's 404), the ONE function the pool
 * and the rank claim (S5) use. A tenant anchor is a contact that exists, is
 * not soft-deleted and is typed `tenant`; a unit anchor is a unit that exists
 * and is not soft-deleted, ANY status. The anchor's state never refuses a
 * ranking (spec D1: anchor notes instead). Answers the record, or undefined.
 */
export async function readRankingAnchor(anchor: AnchorRef, deps: AnchorReadDeps): Promise<RankingAnchorRecord | undefined> {
  if (anchor.kind === 'tenant') {
    const contact = await deps.contacts.getById(anchor.id);
    if (contact === undefined || isContactDeleted(contact) || contact.type !== 'tenant') return undefined;
    return { kind: 'tenant', record: contact };
  }
  const unit = await deps.units.getById(anchor.id);
  if (unit === undefined || isUnitDeleted(unit)) return undefined;
  return { kind: 'unit', record: unit };
}

/** PR21: readRankingAnchor as a yes / no, for the rank claim (S5). */
export async function rankingAnchorExists(anchor: AnchorRef, deps: AnchorReadDeps): Promise<boolean> {
  return (await readRankingAnchor(anchor, deps)) !== undefined;
}

async function readOrgEntries(deps: PoolDeps): Promise<readonly OrgEntry[] | null> {
  try {
    return (await deps.orgNames.read()).entries;
  } catch (err) {
    deps.logger?.warn({ err }, 'ranking pool: the organization list read failed');
    return null;
  }
}

/** Every searching tenant, paged to the end (the read already hides soft-deleted contacts; the belts repeat it). */
async function listSearchingTenants(contacts: PoolDeps['contacts']): Promise<ContactItem[]> {
  const out: ContactItem[] = [];
  const seen = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await contacts.listByType('tenant', {
      status: 'searching',
      limit: PAGE_SIZE,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    for (const contact of page.items) {
      if (contact.type !== 'tenant' || contact.status !== 'searching' || isContactDeleted(contact)) continue;
      if (seen.has(contact.contactId)) continue;
      seen.add(contact.contactId);
      out.push(contact);
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return out;
}

/** Every available unit, paged to the end (deleted excluded by the read; the belts repeat it). */
async function listAvailableUnits(units: PoolDeps['units']): Promise<UnitItem[]> {
  const out: UnitItem[] = [];
  const seen = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await units.listByStatus('available', {
      limit: PAGE_SIZE,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    for (const unit of page.items) {
      if (unit.status !== 'available' || isUnitDeleted(unit)) continue;
      if (seen.has(unit.unitId)) continue;
      seen.add(unit.unitId);
      out.push(unit);
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return out;
}

function tooLarge(
  size: number,
  anchor: RankingAnchorRecord,
  anchorNotes: AnchorNote[],
  orgEntries: readonly OrgEntry[],
): PoolFailure {
  return {
    ok: false,
    reason: 'pool_too_large',
    size,
    message: POOL_MESSAGES.poolTooLarge(size),
    anchorRecord: anchor.record,
    anchor,
    anchorNotes,
    orgEntries,
  };
}

async function propertyPool(unit: UnitItem, opts: PoolOpts, deps: PoolDeps): Promise<PoolResult> {
  const orgEntries = await readOrgEntries(deps);
  if (orgEntries === null) return { ok: false, reason: 'org_list_failed', message: POOL_MESSAGES.orgListFailed };
  const authorities = mapAuthorities(orgEntries, authoritiesOf(unit));
  const sizes = unitVoucherSizes(unit);
  const windowDays = deps.config.rankingPoolWindowDays;
  const candidates = (await listSearchingTenants(deps.contacts))
    .filter(
      (contact) =>
        isSendable(contact) &&
        voucherSizeMatches(sizes, tenantVoucherSize(contact)) &&
        authorityAllows(authorities, contact['housingAuthority']) &&
        (opts.includeOlder || inPoolWindow(contact, opts.now, windowDays)),
    )
    .sort((a, b) => compareIds(a.contactId, b.contactId));
  const anchorNotes = unitAnchorNotes(unit);
  if (candidates.length > deps.config.rankingMaxPool) {
    return tooLarge(candidates.length, { kind: 'unit', record: unit }, anchorNotes, orgEntries);
  }
  return { ok: true, kind: 'unit', anchorRecord: unit, candidates, anchorNotes, authorities, orgEntries };
}

async function tenantPool(anchor: ContactItem, deps: PoolDeps): Promise<PoolResult> {
  const orgEntries = await readOrgEntries(deps);
  if (orgEntries === null) return { ok: false, reason: 'org_list_failed', message: POOL_MESSAGES.orgListFailed };
  const size = tenantVoucherSize(anchor);
  const fits = (await listAvailableUnits(deps.units)).filter(
    (unit) =>
      voucherSizeMatches(unitVoucherSizes(unit), size) &&
      authorityAllows(mapAuthorities(orgEntries, authoritiesOf(unit)), anchor['housingAuthority']),
  );
  // WI20: the question is "committed to a DIFFERENT tenant", so the anchor's own
  // placement on a unit never takes it out of the anchor's pool.
  const held = await mapWithConcurrency(fits, deps.config.rankingReadConcurrency, (unit) =>
    deps.placements.hasActivePlacementForOtherTenant(unit.unitId, anchor.contactId),
  );
  const candidates = fits.filter((_unit, index) => held[index] !== true).sort((a, b) => compareIds(a.unitId, b.unitId));
  const anchorNotes = tenantAnchorNotes(anchor);
  if (candidates.length > deps.config.rankingMaxPool) {
    return tooLarge(candidates.length, { kind: 'tenant', record: anchor }, anchorNotes, orgEntries);
  }
  return {
    ok: true,
    kind: 'tenant',
    anchorRecord: anchor,
    candidates,
    anchorNotes,
    authorities: { mapped: [], unmapped: [] },
    orgEntries,
  };
}

/**
 * Spec D1: the pool for `anchor` now. Fails (never throws for these) when the
 * anchor is not found (readRankingAnchor, PR21); when the organization list
 * cannot be read; or when the pool is above RANKING_MAX_POOL. Any other read
 * error propagates to the caller.
 */
export async function computePool(anchor: AnchorRef, opts: PoolOpts, deps: PoolDeps): Promise<PoolResult> {
  const found = await readRankingAnchor(anchor, deps);
  if (found === undefined) return notFound();
  return found.kind === 'unit' ? propertyPool(found.record, opts, deps) : tenantPool(found.record, deps);
}
