// Audience resolution (M1.8a; matching-blast-rules 2026-10-14 D1, D2, D10) -
// turn a filtered-share (Matching blast) audience filter into the concrete
// set of tenant contacts to text.
//
// A FILTER audience is TENANT 1:1 contacts ONLY (never relay-group rosters,
// and never caseworkers - D10: a partner joins a share only as a seed or an
// explicitly checked recipient), and only tenants whose status is
// `searching` or `onboarding` (D1). Opted-out (STOP) and unreachable contacts
// are ALWAYS excluded here, at audience resolution, as the first TCPA fence
// (sendMessage's opt-out gate is the second fence per recipient).
//
// THE READ (D1): exactly two byTypeStatus partitions, (tenant, searching) and
// then (tenant, onboarding) - BLAST_TENANT_STATUSES order, searching FIRST -
// under ONE page bound (maxPages counts the pages of both). A cut therefore
// drops onboarding tenants before any searching one, and no other status is
// ever read. (The old un-narrowed walk ascended the status range key and cut
// `searching` tenants first - docs/issues/
// broadcast-audience-truncation-drops-searching-tenants.md, resolved by D1.)
// `truncated` is true when the bound stops the walk with any page still
// unread, in the current partition or a later one.
//
// HOUSING AUTHORITIES (D2) are an in-memory any-of filter. The list comes
// from authoritiesOfFilter (the ONE reader of a stored filter - a legacy
// one-string row is its one member); a tenant matches when its trimmed
// housingAuthority is a member. While the list is non-empty, a tenant with no
// housing authority, or one that is not on the list, does not match. The
// byHousingAuthority GSI and contactsRepo.listByHousingAuthority are KEPT
// (Cameron 2026-10-14) but no longer read here.
//
// VOUCHER SIZES (property-requirements 2026-10-20 D12) are an in-memory
// any-of filter too. The list comes from bedroomSizesOfFilter (the ONE
// reader - a legacy one-number row reads as [min(n, 4)]); a tenant matches
// when its voucherSize is a listed size below 4, or is 4 or more while the 4
// chip is listed (voucherSizeMatches). While the list is non-empty, a tenant
// with no voucherSize does not match.
//
// SCAN-BOUND ASSUMPTION (Phase-1 volumes, doc section 5.1): the two
// partitions are the active tenant working set - hundreds to low thousands of
// small items - so paginating the Query and filtering in memory is fine. The
// upgrade path if tenants ever exceed tens of thousands is the matching
// engine's (section 5.1): a stream-fed materialized audience index.
//
// PII (doc section 9): NEVER log phones/names - counts only. The RESULT
// carries phones (the send job + the authed preview need them) but the
// service itself logs only counts.
import {
  authoritiesOfFilter,
  bedroomSizesOfFilter,
  BLAST_TENANT_STATUSES,
  voucherSizeMatches,
} from '../lib/blastAudienceRules.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import type { AudienceFilter } from '../repos/broadcastsRepo.js';

/** One resolved recipient: enough to send + render the per-recipient merge field. */
export interface ResolvedContact {
  contactId: string;
  phone: string;
  firstName?: string;
  /** For the review-recipients rows, which show the FULL name (people are not
   *  identifiable by first name alone at roster scale). */
  lastName?: string;
  /** The tenant's approved bedroom (voucher) size - for the preview row display. */
  voucherSize?: number;
  /** The administering housing authority (trimmed) - for the preview row display. */
  housingAuthority?: string;
  /**
   * A2P/CTIA (spec section 4, LOCKED CONTRACT 3): whether this contact has
   * recorded SMS consent (hasSmsConsent). The composer preview surfaces
   * "consent not recorded" for `false`, and the broadcast fan-out EXCLUDES
   * them. Kept as a per-candidate flag (not a pre-exclusion) so staff can see
   * + fix them.
   */
  has_consent: boolean;
  /**
   * last-heard-from (spec 5.3): the contact's lifecycle status, for the review
   * row's StatusBadge kind="tenant". TENANT rows only - the resolver is
   * tenant-fenced and resolveSeeds omits it for a partner seed (a partner's
   * needs_review | active is not a tenant status).
   */
  status?: string;
  /** last-heard-from: contact.last_heard_from_at (any type), for the review
   *  row's column and its order. */
  lastHeardFromAt?: string;
}

export interface ResolvedAudience {
  contactIds: string[];
  contacts: ResolvedContact[];
  count: number;
  /**
   * True when the page walk hit its maxPages cap with a page still unread
   * (in the current status partition or a later one) - the resolved set is
   * INCOMPLETE. The /send route refuses on this (no silent under-delivery);
   * the preview surfaces it to the operator.
   */
  truncated: boolean;
}

export interface AudienceResolutionDeps {
  contactsRepo?: ContactsRepo;
  logger?: Logger;
  /**
   * Safety cap on the number of Query pages walked, counted ACROSS both
   * status partitions (each page is up to the GSI's natural page size).
   * Bounds the scan even if the working set grows unexpectedly; the header
   * comment is the design assumption, this is the fence.
   */
  maxPages?: number;
  /** Per-page Limit handed to the Query (bounds each round-trip). */
  pageSize?: number;
}

export type AudienceResolutionService = (filter: AudienceFilter) => Promise<ResolvedAudience>;

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_PAGE_SIZE = 200;

/** A tenant's bedroom (voucher) size - the FLEXIBLE `voucherSize` field, not indexed. */
function voucherSizeOf(contact: ContactItem): number | undefined {
  const v = contact['voucherSize'];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Resolved first name for the [TenantName] merge token, or undefined. */
function firstNameOf(contact: ContactItem): string | undefined {
  const v = contact['firstName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Resolved last name (the preview rows show the FULL name), or undefined. */
function lastNameOf(contact: ContactItem): string | undefined {
  const v = contact['lastName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** The administering housing authority, trimmed, or undefined when blank. */
function housingAuthorityOf(contact: ContactItem): string | undefined {
  const v = contact['housingAuthority'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function createAudienceResolutionService(
  deps: AudienceResolutionDeps = {},
): AudienceResolutionService {
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const log = deps.logger ?? defaultLogger;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;

  return async function resolve(filter) {
    // D2: the any-of list, read through the ONE normalizer (legacy rows too).
    const authorities = new Set(authoritiesOfFilter(filter));
    // D12: the voucher size list, read through its ONE normalizer.
    const sizes = bedroomSizesOfFilter(filter);

    const resolved: ResolvedContact[] = [];
    // contactIds already resolved - the de-duplication below.
    const seen = new Set<string>();
    let pages = 0;
    let truncated = false;
    // D1: one Query walk per wanted status partition, in read order.
    for (const status of BLAST_TENANT_STATUSES) {
      if (truncated) break;
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        if (pages >= maxPages) {
          // The bound stops the walk with a page still unread - the next page
          // of this partition, or the first page of a later one.
          truncated = true;
          break;
        }
        const page = await contacts.listByType('tenant', {
          status,
          limit: pageSize,
          ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
        });
        pages += 1;

        for (const contact of page.items) {
          // A FILTER-resolved audience is tenants only (spec 2026-10-06 D20,
          // matching-blast-rules D10). The partition is type-keyed; this belt
          // keeps a caseworker out even if an index ever hands one back.
          if (contact.type !== 'tenant') continue;
          // D1: only the partition's own status - the same belt for status
          // (an index that hands back a row of another status). It does NOT
          // stop a row resolving twice: see `seen` below.
          if (contact.status !== status) continue;
          // Always exclude STOP'd / unreachable contacts (first TCPA fence). A
          // missing phone is unsendable - drop it.
          if (filter.excludeOptedOut !== false && contact.sms_opt_out === true) continue;
          if (filter.excludeUnreachable !== false && contact.sms_unreachable === true) continue;
          if (typeof contact.phone !== 'string' || contact.phone.length === 0) continue;
          // D12: any listed voucher size, the 4 chip meaning 4 or more; an
          // empty list filters nothing.
          if (!voucherSizeMatches(sizes, voucherSizeOf(contact))) continue;
          const housingAuthority = housingAuthorityOf(contact);
          // D2: any-of on the trimmed value; an empty list filters nothing,
          // a non-empty one leaves out a missing or non-member authority.
          if (
            authorities.size > 0 &&
            (housingAuthority === undefined || !authorities.has(housingAuthority))
          ) {
            continue;
          }
          // The two partition reads are NOT a snapshot. A tenant moved from
          // searching to onboarding between them comes back from BOTH reads,
          // each time with that partition's status, so the belt above keeps
          // both rows: de-duplicate by contactId, first row wins (the
          // searching one - it is read first). The opposite move (onboarding
          // to searching mid-walk) can miss a tenant in both reads; staff
          // add them by hand (Add a tenant).
          if (seen.has(contact.contactId)) continue;
          seen.add(contact.contactId);
          const firstName = firstNameOf(contact);
          const lastName = lastNameOf(contact);
          const voucherSize = voucherSizeOf(contact);
          resolved.push({
            contactId: contact.contactId,
            phone: contact.phone,
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
            ...(voucherSize !== undefined && { voucherSize }),
            ...(housingAuthority !== undefined && { housingAuthority }),
            // last-heard-from (spec 5.3): projection only.
            ...(typeof contact.status === 'string' && contact.status.length > 0 && { status: contact.status }),
            ...(typeof contact.last_heard_from_at === 'string' && { lastHeardFromAt: contact.last_heard_from_at }),
            // A2P/CTIA: per-candidate consent flag (spec section 4). NOT a
            // pre-exclusion here - the preview surfaces it and the fan-out
            // fences on it.
            has_consent: hasSmsConsent(contact),
          });
        }

        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
    }

    if (truncated) {
      // Hit the page cap with more candidates remaining: surface it loudly so
      // the operator knows the audience was truncated (and the bound revisited).
      log.warn(
        { maxPages, resolved: resolved.length },
        'audience resolution hit the page cap - audience may be truncated',
      );
    }

    log.info(
      {
        count: resolved.length,
        authorities: authorities.size,
        bedroomSizesFilter: sizes,
        truncated,
      },
      'broadcast audience resolved',
    );

    return {
      contactIds: resolved.map((c) => c.contactId),
      contacts: resolved,
      count: resolved.length,
      truncated,
    };
  };
}
