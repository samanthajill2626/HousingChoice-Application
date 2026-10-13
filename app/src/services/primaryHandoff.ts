// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact"; plan contract 2.2): after DELETE /api/contacts/:id has persisted
// the soft delete, hand every property whose primary contact was that
// contact to its heir.
//
// ONE strongly consistent Scan of the units table - live AND soft-deleted
// units (`deleted: 'any'`), `consistentRead` (unitsRepo.list's Scan is
// eventually consistent by default) - finds every unit whose unitContacts()
// primary row is the deleted contact. There is no roster index; the
// caseworker conversion accepts the same Scan (services/contactHoldings.ts
// rosterUnitIds). Each target is handed off by unitsRepo.handOffPrimaryFrom:
// a consistent re-read, a re-check that the contact is STILL the flagged
// primary, the heir function with the deleted contact EXCLUDED - and never
// read: the batch read is eventually consistent and could still answer it
// live (spec 4.2) - and the bounded conditional retries. Per unit:
//   moved       -> unit_primary_contact_assigned { contactId: <heir>,
//                  reason: 'handoff_on_delete', from: <deleted contact> };
//   unchanged   -> nothing: no heir, so the deleted contact stays flagged
//                  (P1 skips it, the property box says so, the next eligible
//                  add promotes) - and restoring the contact then leaves the
//                  property exactly as it was;
//   not_primary -> nothing: someone already moved it;
//   unknown     -> skipped with a WARN (the liveness read failed).
//
// BEST-EFFORT AS A WHOLE, the posture of the delete's presence fan-out
// (routes/contacts.ts propagateContactPresenceChange): the delete has already
// persisted, so nothing here throws - a Scan failure, a unit whose hand-off
// throws (RosterWriteConflictError after its retries included) and a failed
// audit append are each logged with the unit id and skipped. PII (doc section
// 9): ids and counts only in logs.
import { readRosterContacts } from '../lib/propertyContact.js';
import type { Logger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type PrimaryHandOffResult, type UnitsRepo } from '../repos/unitsRepo.js';

export interface PrimaryHandoffDeps {
  units: Pick<UnitsRepo, 'list' | 'handOffPrimaryFrom'>;
  contacts: Pick<ContactsRepo, 'getManyByIds'>;
  audit: Pick<AuditRepo, 'append'>;
  logger: Logger;
}

/** What one delete hand-off did, by unit id (ids only - spec section 9 PII). */
export interface DeletedContactHandoffSummary {
  /** Units whose flagged primary was the contact when the Scan read them, in Scan order. */
  targets: string[];
  moved: string[];
  unchanged: string[];
  notPrimary: string[];
  unknown: string[];
  /** The hand-off threw for these units (logged, skipped). */
  failed: string[];
  /** The Scan failed partway; `targets` holds what it found before that. */
  scanFailed: boolean;
}

/**
 * Hand every unit whose primary is `contactId` (just soft-deleted) to its
 * heir - see the file header. `actor` is the deleting user (audit). Never
 * throws.
 */
export async function handOffPrimariesOfDeletedContact(
  deps: PrimaryHandoffDeps,
  contactId: string,
  actor: string | undefined,
): Promise<DeletedContactHandoffSummary> {
  const log = deps.logger;
  const summary: DeletedContactHandoffSummary = {
    targets: [],
    moved: [],
    unchanged: [],
    notPrimary: [],
    unknown: [],
    failed: [],
    scanFailed: false,
  };
  try {
    let key: Record<string, unknown> | undefined;
    do {
      const page = await deps.units.list({
        deleted: 'any',
        consistentRead: true,
        ...(key !== undefined && { exclusiveStartKey: key }),
      });
      for (const unit of page.items) {
        const primary = unitContacts(unit).find((row) => row.primaryContact === true);
        if (primary !== undefined && primary.contactId === contactId) summary.targets.push(unit.unitId);
      }
      key = page.lastEvaluatedKey;
    } while (key !== undefined);
  } catch (err) {
    summary.scanFailed = true;
    log.warn(
      { err, contactId, found: summary.targets.length },
      'contact delete: primary handoff scan failed (best-effort)',
    );
  }
  // The deleted contact is never read (spec 4.2); the repo leaves it out too.
  const readContacts = (ids: string[]) =>
    readRosterContacts(
      deps.contacts,
      ids.filter((id) => id !== contactId),
      log,
    );
  for (const unitId of summary.targets) {
    let result: PrimaryHandOffResult;
    try {
      result = await deps.units.handOffPrimaryFrom(unitId, contactId, readContacts);
    } catch (err) {
      summary.failed.push(unitId);
      log.warn({ err, contactId, unitId }, 'contact delete: primary handoff failed for a unit (best-effort)');
      continue;
    }
    switch (result.outcome) {
      case 'moved':
        summary.moved.push(unitId);
        try {
          await deps.audit.append(`units#${unitId}`, 'unit_primary_contact_assigned', {
            actor,
            contactId: result.to,
            reason: 'handoff_on_delete',
            from: contactId,
          });
        } catch (err) {
          log.warn(
            { err, contactId, unitId },
            'contact delete: primary handoff audit append failed (best-effort)',
          );
        }
        break;
      case 'unchanged':
        summary.unchanged.push(unitId);
        break;
      case 'not_primary':
        summary.notPrimary.push(unitId);
        break;
      case 'unknown':
        summary.unknown.push(unitId);
        log.warn({ contactId, unitId }, 'contact delete: primary handoff skipped - the liveness read failed');
        break;
    }
  }
  if (summary.targets.length > 0 || summary.scanFailed) {
    log.info(
      {
        contactId,
        targets: summary.targets.length,
        moved: summary.moved,
        unchanged: summary.unchanged,
        notPrimary: summary.notPrimary,
        unknown: summary.unknown,
        failed: summary.failed,
        scanFailed: summary.scanFailed,
      },
      'contact delete: primary handoff done',
    );
  }
  return summary;
}
