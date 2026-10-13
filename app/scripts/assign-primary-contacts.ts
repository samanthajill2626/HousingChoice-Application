// assign-primary-contacts - the ONE-TIME repair of the properties whose
// primary contact is missing or deleted (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 8; plan constraint C12). From this branch on, every write keeps the
// primary pointing at a usable person (spec section 4); this pass repairs the
// properties already in the broken state - 470 Bolton's shape: no primary
// contact, no landlord of record, one live contact added as Property Manager.
//
// READS every unit (live AND soft-deleted) with a consistent Scan
// (unitsRepo.list, deleted 'any', consistentRead), and per unit ONE complete
// batch read of the contacts its contact list and landlord of record name
// (readRosterContacts: requireComplete; ANY throw = liveness unknown, never
// "deleted" - spec 4.2).
//
// PER UNIT (planUnitPrimary, pure):
//   - TARGET: its flagged primary (unitContacts()) is absent or not live AND
//     the heir function (chooseHeir, nothing excluded) names an heir. The
//     write flags exactly the heir (adding the landlord's row when the heir is
//     an off-roster landlord of record - applyPrimary) and sets the
//     primary_contact scalar to it; then ONE unit_primary_contact_assigned
//     audit event { contactId, reason: 'backfill', from? } with no actor
//     (from = the flagged contact it replaces, when there was one).
//   - ALIGN (counted scalarAligned): its flagged primary is live and stored,
//     but the scalar is absent or names someone else. The write sets the
//     scalar (the contact list goes back unchanged); no audit event - the
//     primary did not change. A landlord-only unit (no stored contact list:
//     its primary is the DERIVED landlord row) is left alone.
//   - COUNTED, never written: noHeir (no live contact and no live landlord of
//     record), noEligible (live contacts, none eligible for automatic routing
//     - only a tenant or a caseworker; listed by unit id so Sam can choose on
//     the property page), unknown (the contact read failed - re-run),
//     unchanged (nothing to do).
//
// NO LOCK (spec section 8): every write is unitsRepo.assignPrimaryIfCurrent,
// conditional on the contact list AND landlordId THIS run read - never
// addContact, which re-reads and would overwrite a primary set meanwhile. A
// unit changed since the read is counted skippedOnCondition and left for a
// re-run. Idempotent: a completed apply plans nothing on a re-run.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). An agent
// runs this ONLY with --env local --lane <L> against a hermetic e2e lane it
// started. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the human does, per
// the RUNBOOK, after that environment's deploy.
//
//   npx tsx app/scripts/assign-primary-contacts.ts --env dev
//   npx tsx app/scripts/assign-primary-contacts.ts --env dev --apply
//
// Exit codes: 0 the run completed (units skipped on their condition included
// - re-run for them); 1 it completed with failures (a unit whose contact read
// failed, or a write that failed), aborted (the Scan failed: a PARTIAL
// report), or the target could not be resolved (nothing read); 2 usage.
//
// PII: prints and logs counts, unit ids and contact ids only - never a
// person's name, a phone or a street.
import { applyPrimary, chooseHeir, type RosterContactsRead } from '../src/lib/propertyContact.js';
import { isDeleted as isContactDeleted } from '../src/repos/contactsRepo.js';
import { unitContacts, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';

// ---------------------------------------------------------------------------
// Planning (pure): what one unit needs
// ---------------------------------------------------------------------------

export const SCRIPT_NAME = 'assign-primary-contacts';

/** The audit event each primary assignment appends (plan contract 2.4). */
export const PRIMARY_ASSIGNED_EVENT = 'unit_primary_contact_assigned';

/** One unit's conditional write: its whole contact list and the scalar. */
export interface PrimaryWrite {
  contacts: UnitContact[];
  primaryContact: string;
}

/**
 * What one unit needs (spec section 8). `target`: its primary is absent or
 * not live and the heir function named an heir (`from` = the flagged contact
 * it replaces, when there was one). `align`: its live, stored primary does
 * not match the scalar. The rest are counted only.
 */
export type UnitPrimaryPlan =
  | { kind: 'target'; heirId: string; from?: string; write: PrimaryWrite }
  | { kind: 'align'; write: PrimaryWrite }
  | { kind: 'noHeir' }
  | { kind: 'noEligible' }
  | { kind: 'unknown' }
  | { kind: 'unchanged' };

/** The landlord of record as the repos read it: a non-empty string, else none. */
function landlordOf(unit: Pick<UnitItem, 'landlordId'>): string | undefined {
  return typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
}

/** Live (spec section 3): the complete read returned the contact and it is not soft-deleted. */
function isLive(read: Extract<RosterContactsRead, { ok: true }>, contactId: string): boolean {
  const contact = read.byId.get(contactId);
  return contact !== undefined && !isContactDeleted(contact);
}

/**
 * ONE unit's plan, from the unit as the Scan read it and the complete contact
 * read of its contact list + landlord of record. WHO takes over is never
 * decided here: chooseHeir answers it (nothing excluded - this run deleted
 * nobody) and applyPrimary builds the contact list - the same two functions
 * every app write uses (spec 4.3).
 */
export function planUnitPrimary(unit: UnitItem, read: RosterContactsRead): UnitPrimaryPlan {
  // A failed read decides nothing, and is never read as "deleted" (spec 4.2).
  if (!read.ok) return { kind: 'unknown' };
  const roster = unitContacts(unit);
  const flagged = roster.find((row) => row.primaryContact === true);
  if (flagged !== undefined && isLive(read, flagged.contactId)) {
    // A live primary stays. Only the scalar may need aligning - and only on a
    // STORED contact list: a landlord-only unit's primary is the derived
    // landlord row, which has no stored scalar to agree with (spec section 8).
    const stored = Array.isArray(unit.contacts) && unit.contacts.length > 0;
    if (stored && unit.primary_contact !== flagged.contactId) {
      return {
        kind: 'align',
        write: { contacts: roster.map((row) => ({ ...row })), primaryContact: flagged.contactId },
      };
    }
    return { kind: 'unchanged' };
  }
  const heir = chooseHeir({ roster, landlordId: landlordOf(unit), read });
  if (heir.kind === 'unknown') return { kind: 'unknown' };
  if (heir.kind === 'none') return { kind: heir.why === 'no_eligible_candidate' ? 'noEligible' : 'noHeir' };
  const applied = applyPrimary(roster, { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow });
  return {
    kind: 'target',
    heirId: heir.contactId,
    ...(flagged !== undefined && { from: flagged.contactId }),
    write: { contacts: applied.contacts, primaryContact: heir.contactId },
  };
}
