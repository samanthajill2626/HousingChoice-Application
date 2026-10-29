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
import { checkScalarWrite, normalizeOrgText, type OrgEntry } from '../../lib/orgNames.js';
import { acceptedVoucherSizes } from '../../lib/unitFields.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import { DAY_MS, instantMs } from './pairHistory.js';
import type { AnchorNote, AuthorityMapping } from './types.js';

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

/** Spec D1: true when the property's mapped authorities admit the tenant's. */
export function authorityAllows(mapping: AuthorityMapping, tenantAuthority: unknown): boolean {
  if (mapping.mapped.length === 0) return true;
  if (typeof tenantAuthority !== 'string') return false;
  const folded = normalizeOrgText(tenantAuthority);
  if (folded === '') return false;
  return mapping.mapped.some((name) => normalizeOrgText(name) === folded);
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
