// The property page's fair-housing notice (WP1 B2a spec D10 rev 7; charter
// 7.2 and section 20 item 16): one property's OPEN unlawful flags, for every
// staff role that can open the property (admin and va - routes/rankings.ts).
// Read-only: no Dismiss here (B4's, admin only).
//
// ONE definition of open, shared with the ranking read and the run detail:
// the property's flag records (rankingRunsRepo.getOpenCandidateFlags) through
// flags.ts openFlags against the property's CURRENT card facts, built by
// assemble.ts propertyFactsOf (the landlord-card switch and the landlord
// defaults honored). The unit is read CONSISTENTLY, so the re-check the page
// makes right after a save sees the saved text and an edited field's notice
// goes at once. A missing or soft-deleted property is not found, by the
// ranking's one anchor-exists rule (pool.ts readRankingAnchor, PR21).
//
// Each flag carries its field's human label (cardFields.ts flagFieldLabel)
// and the record's reason - always the fixed sentence (flags.ts
// DEFAULT_FLAG_REASON). Never the run id or any pair text. A failed read
// THROWS; the route answers 503.
import type { AppConfig } from '../../lib/config.js';
import type { ContactsRepo } from '../../repos/contactsRepo.js';
import type { RankingRunsRepo } from '../../repos/rankingRunsRepo.js';
import type { UnitsRepo } from '../../repos/unitsRepo.js';
import { propertyFactsOf } from './assemble.js';
import { flagFieldLabel } from './cardFields.js';
import { openFlags } from './flags.js';
import { readRankingAnchor } from './pool.js';

/** One open unlawful flag as the property page shows it. */
export interface PropertyFlagView {
  /** The card field (or its `landlord:<key>` twin) - the notice's key. */
  field: string;
  /** Staff copy for the field, e.g. "Qualifications". */
  label: string;
  /** Always "flagged as a requirement fair housing does not allow". */
  reason: string;
}

export type PropertyFlagsRead = { kind: 'ok'; flags: PropertyFlagView[] } | { kind: 'not_found' };

export interface PropertyFlagsDeps {
  units: Pick<UnitsRepo, 'getById'>;
  /** getById for the anchor-exists rule's shape; getManyByIds for the landlord read (switch on). */
  contacts: Pick<ContactsRepo, 'getById' | 'getManyByIds'>;
  flags: Pick<RankingRunsRepo, 'getOpenCandidateFlags'>;
  config: Pick<AppConfig, 'rankingLandlordCard'>;
}

export async function readPropertyFlags(unitId: string, deps: PropertyFlagsDeps): Promise<PropertyFlagsRead> {
  const found = await readRankingAnchor(
    { kind: 'unit', id: unitId },
    { contacts: deps.contacts, units: { getById: (id) => deps.units.getById(id, { consistentRead: true }) } },
  );
  if (found === undefined || found.kind !== 'unit') return { kind: 'not_found' };
  const facts = (await propertyFactsOf(new Map([[unitId, found.record]]), deps)).get(unitId);
  if (facts === undefined) return { kind: 'ok', flags: [] };
  const open = openFlags(await deps.flags.getOpenCandidateFlags(unitId), facts.freeTextByField);
  return {
    kind: 'ok',
    flags: open.map((record) => ({ field: record.field, label: flagFieldLabel(record.field), reason: record.reason })),
  };
}
