// The contacts PATCH's classification side effects, shared with the
// caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19 step 2: "the PATCH's existing revision-guarded type drain"; step 3: the
// display-name denorm). MOVED from routes/contacts.ts with identical behavior
// and log lines; routes/contacts.ts (PATCH) and
// services/caseworkerConversion.ts both call these. Best-effort by design:
// failures keep the PATCH warning behavior unless a caller supplies reporting.
import type { Logger } from '../lib/logger.js';
import type { AiRunsRepo } from '../repos/aiRunsRepo.js';
import { contactClassificationRevision, type ContactItem } from '../repos/contactsRepo.js';
import {
  sameSuggestionIdentity,
  type ExtractionRepo,
  type GuardedTypeDeleteResult,
  type SuggestionItem,
} from '../repos/extractionRepo.js';
import { canonicalSuggestedContactKind } from './extraction/contactKinds.js';
import { isDecisionTarget, type Verdict } from './extraction/runTypes.js';
import { normalizeSuggestionValue } from './extraction/schema.js';

/**
 * The denormalized inbox display name from a contact's resolved fields:
 * `firstName`/`lastName` joined and trimmed -> a non-empty string, else null.
 * HONEST: returns null when no name is known - the inbox falls back to the
 * phone; a name is NEVER invented. PII (doc section 9): the name is data, never
 * logged here.
 */
export function displayNameOf(contact: ContactItem): string | null {
  // Part-wise trim BEFORE the join: a legacy padded part ("Cameron   ") must
  // never render an interior gap ("Cameron   Abt"). New writes arrive trimmed
  // (trimJsonBody), but stored data predating it may not be.
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : null;
}

export interface SuggestionEffectDeps {
  extraction: ExtractionRepo;
  aiRuns: AiRunsRepo;
  log: Logger;
  /** Conversion reports post-commit failures at error; PATCH retains warnings. */
  reportFailure?: (fields: { contactId: string; err?: unknown; field?: string }, message: string) => void;
}

function reportFailure(
  deps: SuggestionEffectDeps,
  fields: { contactId: string; err?: unknown; field?: string },
  message: string,
): void {
  if (deps.reportFailure) deps.reportFailure(fields, message);
  else deps.log.warn(fields, message);
}

/**
 * Delete exactly the pending suggestion identity the caller read, then stamp
 * `verdict` on its run's decision (only for a decision target with a run).
 * Returns whether the suggestion was deleted. A suggestion created or replaced
 * since the read stays pending and unstamped.
 */
export async function supersedePendingSuggestion(
  deps: SuggestionEffectDeps,
  input: {
    contactId: string;
    target: string;
    pending: SuggestionItem;
    verdict: Verdict;
    verdictAt: string;
    actor?: string;
  },
): Promise<boolean> {
  const { contactId, target, pending, verdict, verdictAt, actor } = input;
  let deleted = false;
  try {
    deleted = await deps.extraction.deleteSuggestionIfCurrent(
      contactId, target, pending.createdAt, pending.runId, pending.revision,
    );
  } catch (err) {
    reportFailure(deps, { err, contactId, field: target }, 'extraction conditional delete (human edit) failed (best-effort)');
  }
  if (!deleted || pending.runId === undefined || !isDecisionTarget(target)) return deleted;
  try {
    await deps.aiRuns.setVerdict(pending.runId, target, verdict, {
      at: verdictAt, expectedVerdict: 'pending',
      freshSuggestionCreatedAt: pending.createdAt,
      ...(actor !== undefined && { by: actor }),
    });
  } catch (err) {
    reportFailure(deps, { err, contactId, field: target }, 'ai run verdict stamp failed (best-effort)');
  }
  return deleted;
}

/**
 * The revision-guarded type drain (frozen design 7.3). A type suggestion is
 * judged against the COMPLETE committed kind (`canonicalSuggestedContactKind`),
 * not a request field: Property Manager is landlord plus an exact role, and the
 * caseworker preset is partner plus an exact role. Drains a bounded number of
 * older rows so a replacement racing the contact write cannot remain
 * actionable for an already-committed classification. `accepted` only for the
 * identity read BEFORE the write whose value equals the committed kind.
 * Returns whether any suggestion state changed.
 */
export async function drainTypeSuggestion(
  deps: SuggestionEffectDeps,
  input: {
    contactId: string;
    committed: ContactItem;
    pendingTypeBefore: SuggestionItem | undefined;
    verdictAt: string;
    actor?: string;
  },
): Promise<boolean> {
  const { contactId, committed, pendingTypeBefore, verdictAt, actor } = input;
  let changed = false;
  const committedRevision = contactClassificationRevision(committed);
  const appliedKind = canonicalSuggestedContactKind(committed);
  let candidate = pendingTypeBefore;
  let exhausted = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (candidate === undefined) {
      try {
        candidate = await deps.extraction.getSuggestion(contactId, 'type', {
          consistentRead: true,
        });
      } catch (err) {
        reportFailure(deps, { err, contactId }, 'type suggestion drain read failed (best-effort)');
        exhausted = false;
        break;
      }
      if (candidate === undefined) {
        exhausted = false;
        break;
      }
    }

    const candidateContactRevision = candidate.contactClassificationRevision ?? 0;
    if (candidateContactRevision >= committedRevision) {
      exhausted = false;
      break;
    }

    let result: GuardedTypeDeleteResult;
    try {
      result = await deps.extraction.deleteTypeSuggestionIfCurrentAtContactRevision(
        candidate,
        committedRevision,
      );
    } catch (err) {
      reportFailure(deps, { err, contactId }, 'type suggestion drain failed (best-effort)');
      exhausted = false;
      break;
    }
    if (result === 'contact_revision_changed') {
      exhausted = false;
      break;
    }
    if (result === 'suggestion_changed_or_absent') {
      candidate = undefined;
      continue;
    }

    changed = true;
    const wasPrewriteIdentity = pendingTypeBefore !== undefined
      && sameSuggestionIdentity(candidate, pendingTypeBefore);
    const verdict = wasPrewriteIdentity
      && appliedKind !== undefined
      && normalizeSuggestionValue('type', candidate.suggestedValue)
        === normalizeSuggestionValue('type', appliedKind)
      ? 'accepted'
      : 'superseded_by_human_edit';
    if (candidate.runId !== undefined) {
      try {
        await deps.aiRuns.setVerdict(candidate.runId, 'type', verdict, {
          at: verdictAt,
          expectedVerdict: 'pending',
          freshSuggestionCreatedAt: candidate.createdAt,
          ...(actor !== undefined && { by: actor }),
        });
      } catch (err) {
        reportFailure(deps,
          { err, contactId, field: 'type' },
          'ai run verdict stamp failed (best-effort)',
        );
      }
    }
    candidate = undefined;
  }
  if (exhausted) {
    reportFailure(deps, { contactId }, 'type suggestion drain exhausted bounded retries');
  }
  return changed;
}
