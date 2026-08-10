// tenantFacets - the PURE facet engine behind the Tenants list controls (spec
// sections 5/6/10 of docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md).
// It owns voucher bucketing, authority label merging, presence rules, the
// Not-recorded sentinel, contextual counts, URL (de)serialization, and the row
// facts line. No React, no hooks: TenantFilters renders what this returns and
// ContactsList applies it.
import type { Contact } from '../../api/index.js';
import { voucherSizeLabel } from '../broadcasts/broadcastFormat.js';

/** URL + option key for the "nothing recorded" bucket of a value facet. */
export const NONE_KEY = '__none__';

/** The Not-recorded chip label (rendered as `Not recorded (N)`). */
const NONE_LABEL = 'Not recorded';

// The row separator is U+00B7 with spaces. ONE construction form, in this module
// AND in the tests: String.fromCharCode(0xB7) - never a literal middot
// character, never an HTML entity (an entity inside a JS string renders
// literally as text). A hyphen would collide with voucherSizeLabel's internal
// hyphen, and this keeps every source line ASCII.
const SEP = ' ' + String.fromCharCode(0xB7) + ' ';

/** The voucher-size facet keys - a CLOSED five-bucket enumeration. */
export type VoucherBucketKey = '0' | '1' | '2' | '3' | '4plus';

/**
 * The EXPLICIT size-to-key table (spec section 10). Deliberately not
 * `String(Math.min(size, 4))`: that writer emits `"4"`, which is not a key, so
 * parseSelection's unknown-value rule would silently drop it and every `4+ BR`
 * selection would be lost on reload while in-memory tests stayed green.
 */
const SIZE_TO_BUCKET: Readonly<Record<number, VoucherBucketKey>> = {
  0: '0',
  1: '1',
  2: '2',
  3: '3',
  4: '4plus',
};

/**
 * The FIXED five voucher chips (not derived from data - a closed enumeration
 * with stable chips scans better; an empty bucket is handled by the zero-count
 * rule). Labels come from `voucherSizeLabel`, never restated here.
 */
export const VOUCHER_BUCKETS: ReadonlyArray<{ key: VoucherBucketKey; label: string }> = [
  { key: '0', label: voucherSizeLabel(0) },
  { key: '1', label: voucherSizeLabel(1) },
  { key: '2', label: voucherSizeLabel(2) },
  { key: '3', label: voucherSizeLabel(3) },
  { key: '4plus', label: voucherSizeLabel(4) },
];

/** The literal voucher key set parseSelection validates against. */
const VOUCHER_KEYS: ReadonlySet<string> = new Set<string>(VOUCHER_BUCKETS.map((b) => b.key));

/** The active facet selection. Empty sets / false = unconstrained. */
export interface TenantSelection {
  voucher: ReadonlySet<string>;
  ha: ReadonlySet<string>;
  porting: boolean;
}

/** One rendered chip: its URL key, its display label, its contextual count. */
export interface FacetOption {
  key: string;
  label: string;
  count: number;
}

/** Everything TenantFilters needs to render the three controls. */
export interface TenantFacetModel {
  /** The fixed five, then Not recorded - always present, whatever the counts. */
  voucher: FacetOption[];
  /** Derived from the loaded data, sorted, then Not recorded last. */
  authority: FacetOption[];
  /** No tenant has a recorded authority (render the muted line, not chips). */
  authorityEmpty: boolean;
  /** No tenant has a recorded voucher size. */
  voucherEmpty: boolean;
  /** Some tenant has `porting === true` (a toggle with nothing to match is dead UI). */
  showPorting: boolean;
  /** How many tenants the Porting toggle would keep, in the current context. */
  portingCount: number;
}

/**
 * The voucher bucket a tenant falls in, or null when no size is recorded.
 * Presence is `typeof === 'number'` - NEVER truthiness, which silently drops
 * Studio (0). Sizes at or above 4 land in `4plus`; a nonsense negative reads as
 * Studio, mirroring `voucherSizeLabel`'s `<= 0` guard.
 */
export function voucherBucketOf(c: Contact): VoucherBucketKey | null {
  const size = c.voucherSize;
  if (typeof size !== 'number') return null;
  const capped = Math.min(Math.max(Math.trunc(size), 0), 4);
  return SIZE_TO_BUCKET[capped] ?? null;
}

/**
 * The grouping key for an authority spelling: fold underscores to spaces, trim,
 * collapse interior whitespace, case-fold. So `atlanta_housing`,
 * `Atlanta_Housing`, `Atlanta  Housing` and `Atlanta Housing` group as ONE chip
 * with summed counts. What it earns: interior whitespace, case, and
 * underscore/slug folding, plus legacy stored rows - byte-identical merging
 * alone would render indistinguishable duplicate chips with split counts (and a
 * Playwright strict-mode collision).
 */
export function normalizeAuthorityKey(raw: string): string {
  return raw.replace(/_/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The RAW recorded authority of a contact, or null when nothing is recorded.
 * Presence is a non-empty string; a whitespace-only stored value has no
 * normalized key, so it counts as unrecorded rather than rendering a blank chip.
 */
function authorityOf(c: Contact): string | null {
  const raw = c.housingAuthority;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return normalizeAuthorityKey(raw).length > 0 ? raw : null;
}

/** The normalized authority key of a contact, or null when nothing is recorded. */
function authorityKeyOf(c: Contact): string | null {
  const raw = authorityOf(c);
  return raw === null ? null : normalizeAuthorityKey(raw);
}

/** Read the facet selection out of the URL. */
export function parseSelection(params: URLSearchParams): TenantSelection {
  const voucher = new Set<string>();
  for (const raw of params.getAll('voucher')) {
    // STRING comparison against the literal key set - never numeric coercion or
    // truthiness, which would drop Studio ('0') from a shared link. Unknown
    // values drop INDIVIDUALLY; the rest still filter.
    if (VOUCHER_KEYS.has(raw) || raw === NONE_KEY) voucher.add(raw);
  }
  const ha = new Set<string>();
  for (const raw of params.getAll('ha')) {
    // Repeated params, never comma-joined: a passthrough authority value can
    // itself contain a comma. Values are the NORMALIZED keys this module writes;
    // a key no loaded tenant carries simply matches nothing.
    if (raw.length > 0) ha.add(raw);
  }
  // Presence-only, with the ONE documented exception: `?porting=false` reads as
  // absent (spec section 10) so an explicit off-state never filters.
  const porting = params.get('porting');
  return { voucher, ha, porting: porting !== null && porting !== 'false' };
}

/**
 * Write the selection back onto `params` IN PLACE: the three facet keys are
 * deleted and re-added, and no other key is ever touched (`?phone=` must
 * survive). Porting writes as `porting=1`; the value is never read back.
 */
export function applyToParams(params: URLSearchParams, sel: TenantSelection): void {
  params.delete('voucher');
  params.delete('ha');
  params.delete('porting');
  for (const key of sel.voucher) params.append('voucher', key);
  for (const key of sel.ha) params.append('ha', key);
  if (sel.porting) params.set('porting', '1');
}

/** OR within the voucher facet; an empty selection is unconstrained. */
function matchesVoucher(c: Contact, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return true;
  const bucket = voucherBucketOf(c);
  return bucket === null ? keys.has(NONE_KEY) : keys.has(bucket);
}

/** OR within the authority facet, matched on the NORMALIZED key. */
function matchesAuthority(c: Contact, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return true;
  const key = authorityKeyOf(c);
  return key === null ? keys.has(NONE_KEY) : keys.has(key);
}

/** The Porting toggle: presence of `porting === true`, never a falsy check. */
function matchesPorting(c: Contact, on: boolean): boolean {
  return !on || c.porting === true;
}

/**
 * The display spelling for a merged authority option: the most frequent raw
 * member, untransformed. Ties break deterministically by sort order (the
 * spellings are visited sorted, and only a STRICTLY greater count wins).
 */
function displaySpelling(spellings: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const raw of [...spellings.keys()].sort()) {
    const count = spellings.get(raw) ?? 0;
    if (count > bestCount) {
      best = raw;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Options + contextual counts for the three controls.
 *
 * The OPTION LIST (and each option's display spelling) derives from the FULL
 * loaded set, never from the filtered rows, so chips cannot vanish or re-spell
 * mid-interaction. COUNTS are contextual with standard faceted-search
 * semantics: each facet sees the search query, the Porting toggle, and the OTHER
 * value facet - never its own selection, so a chip's number always states what
 * clicking it does.
 */
export function buildFacets(
  tenants: Contact[],
  sel: TenantSelection,
  matchesQuery: (c: Contact) => boolean,
): TenantFacetModel {
  const spellingsByKey = new Map<string, Map<string, number>>();
  let anyVoucher = false;
  let anyPorting = false;
  for (const c of tenants) {
    const raw = authorityOf(c);
    if (raw !== null) {
      const key = normalizeAuthorityKey(raw);
      const spellings = spellingsByKey.get(key) ?? new Map<string, number>();
      spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
      spellingsByKey.set(key, spellings);
    }
    if (voucherBucketOf(c) !== null) anyVoucher = true;
    if (c.porting === true) anyPorting = true;
  }

  const queried = tenants.filter((c) => matchesQuery(c));
  const forVoucher = queried.filter(
    (c) => matchesAuthority(c, sel.ha) && matchesPorting(c, sel.porting),
  );
  const forAuthority = queried.filter(
    (c) => matchesVoucher(c, sel.voucher) && matchesPorting(c, sel.porting),
  );
  const forPorting = queried.filter(
    (c) => matchesVoucher(c, sel.voucher) && matchesAuthority(c, sel.ha),
  );

  const voucher: FacetOption[] = VOUCHER_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: forVoucher.filter((c) => voucherBucketOf(c) === b.key).length,
  }));
  // Not recorded is ALWAYS present: without it, selecting any value silently
  // excludes the unrecorded population, whatever its size.
  voucher.push({
    key: NONE_KEY,
    label: NONE_LABEL,
    count: forVoucher.filter((c) => voucherBucketOf(c) === null).length,
  });

  const authority: FacetOption[] = [...spellingsByKey.entries()]
    .map(([key, spellings]) => ({
      key,
      label: displaySpelling(spellings),
      count: forAuthority.filter((c) => authorityKeyOf(c) === key).length,
    }))
    // Sorted on the normalized key - which IS the case-folded label - so the
    // order is case-insensitive alphabetical and platform-independent (no locale
    // collation involved).
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  authority.push({
    key: NONE_KEY,
    label: NONE_LABEL,
    count: forAuthority.filter((c) => authorityKeyOf(c) === null).length,
  });

  return {
    voucher,
    authority,
    authorityEmpty: spellingsByKey.size === 0,
    voucherEmpty: !anyVoucher,
    showPorting: anyPorting,
    portingCount: forPorting.filter((c) => c.porting === true).length,
  };
}

/** Apply the selection: OR within each facet, AND across them. */
export function applySelection(tenants: Contact[], sel: TenantSelection): Contact[] {
  return tenants.filter(
    (c) =>
      matchesVoucher(c, sel.voucher) &&
      matchesAuthority(c, sel.ha) &&
      matchesPorting(c, sel.porting),
  );
}

/**
 * The tenant row's facts span: EXACT facts, not buckets - `Studio` for 0, else
 * `${n} BR` (so `6 BR`, never `4+ BR`; the bucket label belongs to the filter
 * chip, a control). The stored authority joins AS-IS, with no transformation.
 * Missing values collapse and the separator never leads or trails; null when
 * neither fact is present.
 */
export function factsLine(c: Contact): string | null {
  const parts: string[] = [];
  const size = c.voucherSize;
  if (typeof size === 'number' && Number.isFinite(size)) {
    parts.push(size <= 0 ? 'Studio' : `${size} BR`);
  }
  const authority = authorityOf(c);
  if (authority !== null) parts.push(authority);
  return parts.length > 0 ? parts.join(SEP) : null;
}
