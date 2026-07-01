// Audience resolution (M1.8a) — turn a filtered-share audience filter into the
// concrete set of tenant contacts to text.
//
// The share-broadcast targets TENANT 1:1 contacts ONLY (never relay-group
// rosters) — filtered by housing authority and/or exact bedroom (voucher) size.
// Opted-out (STOP) and unreachable contacts are ALWAYS excluded here, at
// audience resolution, as the first TCPA fence (sendMessage's opt-out gate is
// the second fence per recipient).
//
// SCAN-BOUND ASSUMPTION (Phase-1 volumes, doc §5.1): when a housing authority
// is set we Query the byHousingAuthority GSI (tenant-sparse, single authority);
// otherwise we Query byTypeStatus (type='tenant'). Either way the candidate set
// is the active tenant working set — hundreds to low thousands of small items —
// so paginating the Query and filtering bedroom-size/opt-out in memory is fine.
// The upgrade path if tenants ever exceed tens of thousands is the same as the
// matching engine's (§5.1): a stream-fed materialized audience index.
//
// PII (doc §9): NEVER log phones/names — counts only. The RESULT carries phones
// (the send job + the authed preview need them) but the service itself logs
// only the resolved count.
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
  /** The tenant's approved bedroom (voucher) size — for the preview row display. */
  voucherSize?: number;
  /** The administering housing authority — for the preview row display. */
  housingAuthority?: string;
  /**
   * A2P/CTIA (spec §4, LOCKED CONTRACT 3): whether this contact has recorded SMS
   * consent (hasSmsConsent). The composer preview surfaces "consent not
   * recorded" for `false`, and the broadcast fan-out EXCLUDES them. Kept as a
   * per-candidate flag (not a pre-exclusion) so staff can see + fix them.
   */
  has_consent: boolean;
}

export interface ResolvedAudience {
  contactIds: string[];
  contacts: ResolvedContact[];
  count: number;
  /**
   * True when the page walk hit its maxPages cap with more candidates still
   * unread — the resolved set is INCOMPLETE. The /send route refuses on this
   * (no silent under-delivery); the preview surfaces it to the operator.
   */
  truncated: boolean;
}

export interface AudienceResolutionDeps {
  contactsRepo?: ContactsRepo;
  logger?: Logger;
  /**
   * Safety cap on the number of Query pages walked (each page is up to the
   * GSI's natural page size). Bounds the scan even if the working set grows
   * unexpectedly; the comment above is the design assumption, this is the fence.
   */
  maxPages?: number;
  /** Per-page Limit handed to the Query (bounds each round-trip). */
  pageSize?: number;
}

export type AudienceResolutionService = (filter: AudienceFilter) => Promise<ResolvedAudience>;

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_PAGE_SIZE = 200;

/** A tenant's bedroom (voucher) size — the FLEXIBLE `voucherSize` field, not indexed. */
function voucherSizeOf(contact: ContactItem): number | undefined {
  const v = contact['voucherSize'];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Resolved first name for the [TenantName] merge token, or undefined. */
function firstNameOf(contact: ContactItem): string | undefined {
  const v = contact['firstName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** The administering housing authority for the preview row, or undefined. */
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
    // Candidate page source: housing-authority Query when set (tenant-sparse,
    // narrowest), else all tenants via byTypeStatus. Both are Queries — never a
    // Scan — paginated and bounded by maxPages.
    const useHousingAuthority =
      typeof filter.housing_authority === 'string' && filter.housing_authority.length > 0;

    const resolved: ResolvedContact[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = useHousingAuthority
        ? await contacts.listByHousingAuthority(filter.housing_authority!, {
            limit: pageSize,
            ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
          })
        : await contacts.listByType('tenant', {
            limit: pageSize,
            ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
          });

      for (const contact of page.items) {
        // The byHousingAuthority GSI is tenant-sparse, but defend the type
        // invariant either way (never text a non-tenant; never relay rosters).
        if (contact.type !== 'tenant') continue;
        // Always exclude STOP'd / unreachable contacts (first TCPA fence). A
        // missing phone is unsendable — drop it.
        if (filter.excludeOptedOut !== false && contact.sms_opt_out === true) continue;
        if (filter.excludeUnreachable !== false && contact.sms_unreachable === true) continue;
        if (typeof contact.phone !== 'string' || contact.phone.length === 0) continue;
        // Bedroom-size filter: exact match on the contact's voucherSize.
        if (filter.bedroomSize !== undefined && voucherSizeOf(contact) !== filter.bedroomSize) {
          continue;
        }
        const firstName = firstNameOf(contact);
        const voucherSize = voucherSizeOf(contact);
        const housingAuthority = housingAuthorityOf(contact);
        resolved.push({
          contactId: contact.contactId,
          phone: contact.phone,
          ...(firstName !== undefined && { firstName }),
          ...(voucherSize !== undefined && { voucherSize }),
          ...(housingAuthority !== undefined && { housingAuthority }),
          // A2P/CTIA: per-candidate consent flag (spec §4). NOT a pre-exclusion
          // here — the preview surfaces it and the fan-out fences on it.
          has_consent: hasSmsConsent(contact),
        });
      }

      exclusiveStartKey = page.lastEvaluatedKey;
      pages += 1;
    } while (exclusiveStartKey !== undefined && pages < maxPages);

    // Truncated when the loop stopped on the page cap (not on exhausting the
    // candidate pages) with more candidates still unread.
    const truncated = exclusiveStartKey !== undefined;
    if (truncated) {
      // Hit the page cap with more candidates remaining: surface it loudly so
      // the operator knows the audience was truncated (and the bound revisited).
      log.warn(
        { maxPages, resolved: resolved.length },
        'audience resolution hit the page cap — audience may be truncated',
      );
    }

    log.info(
      {
        count: resolved.length,
        byHousingAuthority: useHousingAuthority,
        bedroomSizeFilter: filter.bedroomSize ?? null,
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
