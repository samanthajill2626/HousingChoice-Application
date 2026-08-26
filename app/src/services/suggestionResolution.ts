import { randomUUID } from 'node:crypto';
import type { Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import type { AiRunsRepo } from '../repos/aiRunsRepo.js';
import { contactPhones, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { ExtractionRepo, SuggestionItem } from '../repos/extractionRepo.js';
import {
  suggestionIdentityKey,
  tokenFor,
  type ActiveSuggestionResolution,
  type ResolutionAttributeGuard,
  type ResolutionAction,
  type ResolutionReplayPlan,
  type SuggestionResolutionRepo,
} from '../repos/suggestionResolutionRepo.js';
import type { ExtractableField } from '../adapters/extraction.js';
import { EXTRACTABLE_FIELDS, normalizeSuggestionValue } from './extraction/schema.js';
import {
  cleanAddressParts,
  contactAddressToParts,
  formatAddressParts,
} from './extraction/address.js';
import { isDecisionTarget } from './extraction/runTypes.js';
import { buildContactStatusTransitionPlan } from './statusTransition.js';
import type { TenantStatus } from '../lib/statusModel.js';
import { statusAllowlistFor } from '../lib/statusModel.js';

const EXTRACTABLE = new Set<string>(EXTRACTABLE_FIELDS);
const MAX_RESOLUTION_LOOPS = 6;
/**
 * Journals one ordinary suggestions read will drive. This read is on the contact
 * page's open path and each journal costs its own takeover plus a bounded phase
 * ladder, so an unbounded pass makes a contact carrying several abandoned
 * journals pay for all of them before any suggestion renders. The remainder is
 * picked up by the next read (docs/issues/ai-run-log-recovery-hook-unbounded).
 *
 * This is now the DEFAULT rather than the only budget: recoverAbandoned takes
 * an optional maxAttempts, and the daily abandoned-journal sweep passes 12. The
 * rationale above is about a READ - a duty with no page to hold open does not
 * inherit it.
 */
const MAX_RECOVERIES_PER_READ = 2;

export interface SuggestionRequestIdentity {
  revision?: string;
  createdAt: string;
  runId?: string;
}

export type ResolutionBoundary = 'claimed' | 'domain_applied' | 'activity_applied' | 'verdict_attempted';

export interface SuggestionResolutionHooks {
  afterBoundary?: (boundary: ResolutionBoundary, journal: ActiveSuggestionResolution) => Promise<void> | void;
}

export interface ResolutionOutcomeSummary {
  /** This request claimed and drove its own requested identity to completion. */
  completedNow: boolean;
  /**
   * This request helped somebody else's abandoned journal commit its domain
   * effect. The caller emits `suggestion.updated` for it even when the
   * request's own identity resolved to nothing (adv P3-25).
   */
  helpedCommitted: boolean;
}

export interface SuggestionResolutionService {
  resolve(input: {
    contactId: string;
    target: string;
    action: ResolutionAction;
    identity: SuggestionRequestIdentity;
    actorId?: string;
  }): Promise<ResolutionOutcomeSummary>;
  /**
   * F1 lazy recovery. A crash between claim and commit deletes the `sugg#` row,
   * so no suggestion card can offer the identity needed to resume. Any ordinary
   * read of the contact's suggestions therefore helps that contact's expired
   * journals to completion first - at most MAX_RECOVERIES_PER_READ of them per
   * read, counting ATTEMPTS, so one page load cannot be held open driving a
   * backlog. Any remainder is picked up by the next read. Best-effort per
   * journal: one journal's failure never blocks the others, and the next read
   * retries.
   *
   * `stateChanged` is a NOTIFY flag - "durable state changed that the dashboard
   * has not been told about" - and is true for a refused (consumed-chip) journal
   * as well as a committed one. See `applyJournal`.
   *
   * `maxAttempts` overrides that per-call budget. It exists for the daily
   * abandoned-journal sweep (log-hygiene spec 9.3), which passes 12 - the size
   * of the closed DECISION_TARGETS key set - so a poison pair of
   * persistently-failing journals cannot starve the other ten on a duty that
   * has no page load to hold open. Omitted (the read path) keeps
   * MAX_RECOVERIES_PER_READ, so nothing about the contact page changes.
   */
  recoverAbandoned(
    contactId: string,
    opts?: { maxAttempts?: number },
  ): Promise<{ recovered: number; stateChanged: boolean }>;
}

export class SuggestionResolutionError extends Error {
  /**
   * Set when a foreign journal's domain effect committed during this request
   * before it failed on its own identity, so the route still emits.
   */
  helpedCommitted = false;

  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'SuggestionResolutionError';
  }
}

interface ResolutionServiceDeps {
  contactsRepo: ContactsRepo;
  extractionRepo: ExtractionRepo;
  aiRunsRepo: AiRunsRepo;
  resolutionRepo: SuggestionResolutionRepo;
  logger: Logger;
  now?: () => string;
  leaseId?: () => string;
  leaseMs?: number;
  hooks?: SuggestionResolutionHooks;
}

type Coerced = { ok: true; value: unknown } | { ok: false };

function coerceAccept(field: ExtractableField, raw: string): Coerced {
  const value = raw.trim();
  if (field === 'voucherSize') {
    if (!/^\d+$/.test(value)) return { ok: false };
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 12
      ? { ok: true, value: number }
      : { ok: false };
  }
  if (field === 'porting') {
    if (value === 'true') return { ok: true, value: true };
    if (value === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  return value.length > 0 ? { ok: true, value } : { ok: false };
}

function matchesIdentity(suggestion: SuggestionItem, identity: SuggestionRequestIdentity): boolean {
  return suggestion.revision === identity.revision
    && suggestion.createdAt === identity.createdAt
    && suggestion.runId === identity.runId;
}

function requestedIdentityKey(contactId: string, target: string, identity: SuggestionRequestIdentity): string {
  return suggestionIdentityKey({ ownerContactId: contactId, target, ...identity });
}

function provenance(suggestion: SuggestionItem, at: string, actorId: string | undefined) {
  return {
    source: 'ai',
    at,
    conversationId: suggestion.conversationId,
    ...(suggestion.tsMsgId !== undefined && { tsMsgId: suggestion.tsMsgId }),
    ...(actorId !== undefined && { accepted_by: actorId }),
  };
}

function guardForPatch(
  contact: ContactItem,
  patch: Record<string, unknown>,
): ResolutionAttributeGuard {
  const guard: ResolutionAttributeGuard = {};
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    const value = contact[key];
    guard[key] = value === undefined
      ? { exists: false }
      : { exists: true, value };
  }
  return guard;
}

function buildPlan(
  contact: ContactItem,
  suggestion: SuggestionItem,
  action: ResolutionAction,
  actorId: string | undefined,
  at: string,
): ResolutionReplayPlan {
  const target = suggestion.target;
  if (action === 'dismiss') {
    return {
      kind: 'dismiss',
      normalizedValue: normalizeSuggestionValue(target, suggestion.suggestedValue),
      audit: {
        eventType: 'ai_suggestion_dismissed',
        payload: { ...(actorId !== undefined && { actor: actorId }), target },
      },
    };
  }
  if (target === 'type') throw new SuggestionResolutionError(400, 'accept_type_via_triage');
  if (target === 'status') {
    if (!statusAllowlistFor(contact.type).includes(suggestion.suggestedValue)) {
      throw new SuggestionResolutionError(400, 'invalid_suggestion_value');
    }
    const status = buildContactStatusTransitionPlan(contact, {
      toStatus: suggestion.suggestedValue as TenantStatus,
      source: 'ai',
      ...(actorId !== undefined && { actor: actorId }),
    });
    return {
      kind: 'status',
      patch: status.patch,
      guard: guardForPatch(contact, status.patch),
      audit: status.audit,
      ...(status.activity !== undefined && { activity: status.activity }),
    };
  }
  if (target === 'phone') {
    const phone = normalizeToE164(suggestion.suggestedValue);
    if (phone === undefined) {
      throw new SuggestionResolutionError(400, 'phone is not a valid phone number');
    }
    const alreadyAttached = contactPhones(contact).some((entry) => entry.phone === phone);
    return {
      kind: 'phone',
      phone,
      audit: {
        eventType: 'contact_phone_added',
        payload: { ...(actorId !== undefined && { actor: actorId }), phone },
      },
      ...(!alreadyAttached && {
        activity: { type: 'number_added' as const, label: 'Number added' },
      }),
    };
  }
  if (target === 'address') {
    const parts = cleanAddressParts(suggestion.suggestedAddress);
    const formatted = formatAddressParts(parts);
    if (formatted.length === 0) throw new SuggestionResolutionError(400, 'invalid_suggestion_value');
    const from = formatAddressParts(contactAddressToParts(contact['address']));
    return {
      kind: 'contact',
      patch: { address: parts, address_source: provenance(suggestion, at, actorId) },
      guard: guardForPatch(contact, {
        address: parts,
        address_source: provenance(suggestion, at, actorId),
      }),
      audit: {
        eventType: 'ai_suggestion_accepted',
        payload: {
          ...(actorId !== undefined && { actor: actorId }),
          target,
          ...(from.length > 0 && { from }),
          to: formatted,
        },
      },
    };
  }
  if (EXTRACTABLE.has(target)) {
    const field = target as ExtractableField;
    const coerced = coerceAccept(field, suggestion.suggestedValue);
    if (!coerced.ok) throw new SuggestionResolutionError(400, 'invalid_suggestion_value');
    const patch = {
      [field]: coerced.value,
      [`${field}_source`]: provenance(suggestion, at, actorId),
    };
    return {
      kind: 'contact',
      patch,
      guard: guardForPatch(contact, patch),
      audit: {
        eventType: 'ai_suggestion_accepted',
        payload: {
          ...(actorId !== undefined && { actor: actorId }),
          target,
          from: contact[field],
          to: coerced.value,
        },
      },
    };
  }
  throw new SuggestionResolutionError(400, 'unknown_target');
}

export function createSuggestionResolutionService(deps: ResolutionServiceDeps): SuggestionResolutionService {
  const now = deps.now ?? (() => new Date().toISOString());
  const nextLeaseId = deps.leaseId ?? randomUUID;

  async function boundary(name: ResolutionBoundary, journal: ActiveSuggestionResolution): Promise<void> {
    await deps.hooks?.afterBoundary?.(name, journal);
  }

  /**
   * The same ownership question `resolve()` asks before its own claim, asked
   * again for a journal this request only HELPS. Advisory: `findByPhone` reads
   * an eventually consistent GSI, so a `false` is not proof the number is free -
   * it narrows the reachable window, it does not close it
   * (TODO(suggestion-phone-ownership-pointer-only-arbitration)). A `true` IS
   * confirmed, by a strongly consistent read of the named owner, because on the
   * help path it drives an irreversible outcome. Best-effort by construction: an
   * unreadable or disproved answer proceeds to the fenced transaction exactly as
   * before.
   */
  async function phoneOwnedElsewhere(contactId: string, phone: string): Promise<boolean> {
    try {
      const owner = await deps.contactsRepo.findByPhone(phone);
      if (owner === undefined || owner.contactId === contactId) return false;
      // conf P2-2: on the HELP path this answer is PERMANENT - it finalizes the
      // journal, stamps a verdict and scrubs the snapshot, and the operator's
      // retry is then told a newer suggestion replaced theirs. An eventually
      // consistent index must not decide that alone, so confirm the foreign
      // owner with one strongly consistent point read. Disproved (the contact
      // no longer holds the number) or unreadable -> fall through to the fenced
      // transaction, the real guard, exactly as if this check had not fired.
      const confirmed = await deps.contactsRepo.getById(owner.contactId, { consistentRead: true });
      if (confirmed === undefined) return false;
      return confirmed.phone === phone
        || contactPhones(confirmed).some((entry) => entry.phone === phone);
    } catch (err) {
      // `err` by house convention: err/error/cause/reason are ALL serializer-wired.
      deps.logger.warn(
        { err, contactId },
        'phone ownership pre-check failed (advisory, proceeding)',
      );
      return false;
    }
  }

  /**
   * Best-effort verdict stamp, in the shape the ordinary verdict phase uses.
   * Never fails the human action - the run log is observability.
   */
  async function stampVerdict(
    journal: ActiveSuggestionResolution,
    verdict: 'accepted' | 'dismissed' | 'superseded' | 'superseded_by_human_edit',
  ): Promise<void> {
    const snapshot = journal.snapshot;
    if (snapshot.runId === undefined || !isDecisionTarget(snapshot.target)) return;
    try {
      await deps.aiRunsRepo.setVerdict(snapshot.runId, snapshot.target, verdict, {
        at: now(),
        expectedVerdict: 'pending',
        freshSuggestionCreatedAt: snapshot.createdAt,
        ...(journal.actorId !== undefined && { by: journal.actorId }),
      });
    } catch (err) {
      // `err` by house convention: err/error/cause/reason are ALL serializer-wired.
      deps.logger.warn(
        { err, contactId: journal.contactId, target: journal.target },
        'ai run verdict stamp failed (best-effort)',
      );
    }
  }

  /**
   * Drives one journal to completion.
   *
   * `stateChanged` means "durable state changed that the dashboard has NOT been
   * told about", not "a domain effect was written". It covers the refusal cases
   * too: a `superseded_by_human_edit` accept writes nothing to the contact, but
   * `claim()` already consumed the `sugg#` row and this pass finalizes the
   * journal, so every open dashboard is showing a chip that no longer exists.
   * It is a NOTIFY flag (the only consumers are the two `suggestion.updated`
   * emits), never a report of what committed.
   *
   * `refusedByHumanEdit` is the honest answer for the REQUESTER: the fenced
   * write was refused because the field changed after the plan was built, so
   * nothing of theirs applied.
   */
  async function applyJournal(
    initial: ActiveSuggestionResolution,
    opts: { helping: boolean },
  ): Promise<{ stateChanged: boolean; refusedByHumanEdit: boolean }> {
    let journal = initial;
    // Entering above `claimed` means the domain effect is already durable (a
    // previous process committed it), so carrying the journal forward is still
    // a state change the dashboard has never been told about.
    let stateChanged = initial.phase !== 'claimed';
    let refusedByHumanEdit = false;
    for (let attempt = 0; attempt < MAX_RESOLUTION_LOOPS; attempt += 1) {
      const token = tokenFor(journal);
      if (journal.phase === 'claimed') {
        const plan = journal.plan;
        // commitPhoneEffect arbitrates ownership on the `phoneref#` POINTER row
        // alone, and a contact's PRIMARY number deliberately has none - so a
        // number that became somebody else's primary while this journal was
        // abandoned is invisible to the fenced transaction. `resolve()` fences
        // its OWN claim with this same question below; a journal reached by
        // HELPING (takeover, or recoverAbandoned on a read) never asked it.
        const helpedPhoneConflict = opts.helping
          && plan.kind === 'phone'
          && await phoneOwnedElsewhere(journal.contactId, plan.phone);
        const result = helpedPhoneConflict
          ? ('phone_conflict' as const)
          : plan.kind === 'phone'
            ? await deps.resolutionRepo.commitPhoneEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' })
            : plan.kind === 'dismiss'
              ? await deps.resolutionRepo.commitDismissalEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' })
              : await deps.resolutionRepo.commitContactEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' });
        if (result === 'phone_conflict') {
          const released = await deps.resolutionRepo.release({ token, expectedPhase: 'claimed' });
          if (released === 'unsafe') {
            // F8: a REPLACEMENT suggestion already occupies the pending slot, so
            // restoring the snapshot would overwrite it. Finalize this journal
            // terminally instead (identity + action + the released-unsafe
            // disposition only, never the newer `sugg#` row); otherwise every
            // later resolution of the replacement replays this same conflict and
            // the newer suggestion is deadlocked forever.
            const finalized = await deps.resolutionRepo.complete({
              token,
              expectedPhase: 'claimed',
              completedAt: now(),
              disposition: 'released_unsafe',
            });
            // The journal is terminal, so the ordinary verdict phase below can
            // never run for it - and nothing else can stamp this run either:
            // claim() deleted the `sugg#` row, so the replacement's
            // putSuggestion reported no displaced row and the extraction job's
            // own `superseded` stamp never fired. Leaving it `pending` would
            // tell the run log nobody ever looked at a decision a named
            // operator explicitly accepted. `superseded` is exactly what the
            // job would have written had the replacement displaced the row
            // normally. Best-effort: it must never fail the human action.
            //
            // conf P2-1: stamp ONLY when THIS caller performed the terminal
            // finalization. release() answers 'unsafe' from its catch arm
            // (repo:1054) BEFORE it tests whether we still hold the token
            // (repo:1055), so a helper that lost its lease mid-conflict lands
            // here with a journal somebody else now owns. Its complete()
            // correctly no-ops ('stale' / 'already_completed'), and the stamp
            // must no-op with it: setVerdict is fenced on the CURRENT verdict,
            // so a `superseded` written by a helper that finalized nothing is
            // permanent and blocks the true owner's `accepted`.
            if (finalized === 'completed') {
              await stampVerdict(journal, 'superseded');
            } else if (finalized === 'already_completed') {
              // H2 / item 4: a lost Put acknowledgement (repo:1084-1087) reports
              // our OWN finalization as somebody else's. The journal is terminal,
              // the `sugg#` row is gone and recoverAbandoned skips completed
              // rows, so nothing else will ever stamp this decision. Confirm the
              // terminal DISPOSITION first: a journal that completed NORMALLY
              // already stamped its real verdict at the verdict phase, and
              // `superseded` over that would be the conf P2-1 lie again - the
              // narrow `finalized !== 'stale'` test cannot tell the two apart.
              //
              // conf P1-1: the confirm READ is best-effort too, and it has to be
              // wrapped to say so. stampVerdict swallows its own failure for
              // exactly this contract; an unguarded GetItem here escaped
              // applyJournal, and on the resolve() path (takeover help, or the
              // requester's own claim) it turned a 200 into a 500 - the run log
              // failing the human action it only observes.
              try {
                const terminal = await deps.resolutionRepo.get(journal.contactId, journal.target);
                if (terminal?.state === 'completed' && terminal.disposition === 'released_unsafe') {
                  await stampVerdict(journal, 'superseded');
                }
              } catch (err) {
                // `err` by house convention: err/error/cause/reason are ALL serializer-wired.
                // Ids and the error only: never the value under review.
                deps.logger.warn(
                  { err, contactId: journal.contactId, target: journal.target },
                  'ai run terminal verdict confirm read failed (best-effort)',
                );
              }
            }
          }
          // Helping somebody else's journal: hand control back so the caller
          // can go on to its OWN identity. Only the requester's own claim turns
          // this conflict into its answer. Both settled answers qualify - the
          // journal was finalized terminally ('unsafe') or its snapshot went
          // back into the pending slot ('released'), where the identity fence
          // gives the requester an answer about their OWN chip (adv P2-5).
          // 'stale' alone still throws: nothing is settled and the caller
          // should retry.
          if (opts.helping && released !== 'stale') return { stateChanged, refusedByHumanEdit };
          throw new SuggestionResolutionError(409, 'phone_in_use');
        }
        // `stale` means this token can no longer prove its domain transaction
        // committed - the common reading is pre-commit contention, but a
        // committed-then-lost acknowledgement whose journal was taken over
        // before the re-read lands here too. With lazy recovery in place the
        // journal is finished by whoever holds it, so a retry is honest and
        // safe either way.
        if (result === 'stale') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
        stateChanged = true;
        // The ONLY producer of this result is commitContactEffect (repo:763,
        // repo:772) - the fenced write found the field changed since the plan's
        // guard was built, so nothing of the human's accept was applied. The
        // journal still runs to completion below (verdict + scrub); this flag is
        // what lets `resolve()` answer the REQUESTER honestly (H1 / item 1).
        if (result === 'superseded_by_human_edit') refusedByHumanEdit = true;
        const refreshed = await deps.resolutionRepo.get(journal.contactId, journal.target);
        // Post-commit: the effect + audit + phase advance landed atomically and
        // somebody else now owns the journal. The human's action took effect.
        if (refreshed?.state !== 'active') return { stateChanged, refusedByHumanEdit };
        // FENCE NOTE (item 12): this re-ADOPTS whatever token the journal now
        // carries instead of enforcing our own - a helper that took over mid
        // flight is followed, not refused. Benign ONLY because every effect
        // below is independently idempotent (deterministic audit/activity keys,
        // conditional puts, phase guards). The moment anyone adds a
        // NON-idempotent effect to this protocol, the fence must be ENFORCED
        // here (compare tokens and bail) - see
        // docs/issues/ai-run-log-final-review-followups.md item 12.
        journal = refreshed;
        await boundary('domain_applied', journal);
        continue;
      }
      if (journal.phase === 'domain_applied') {
        let result;
        if (
          journal.outcome !== 'superseded_by_human_edit'
          && journal.plan.kind !== 'dismiss'
          && journal.plan.activity !== undefined
        ) {
          try {
            result = await deps.resolutionRepo.commitActivityEffect({
              token,
              expectedPhase: 'domain_applied',
              nextPhase: 'activity_recorded',
            });
          } catch (err) {
            // `err` by house convention: err/error/cause/reason are ALL serializer-wired.
            deps.logger.error(
              { err, contactId: journal.contactId, target: journal.target },
              'suggestion resolution activity failed (best-effort)',
            );
            result = await deps.resolutionRepo.advancePhase({
              token,
              expectedPhase: 'domain_applied',
              nextPhase: 'activity_skipped',
            });
          }
        } else {
          result = await deps.resolutionRepo.advancePhase({
            token,
            expectedPhase: 'domain_applied',
            nextPhase: 'activity_skipped',
          });
        }
        // Post-commit from here on: the domain effect and its audit are durable,
        // so losing the journal to another helper is not the human's problem.
        if (result === 'stale') return { stateChanged, refusedByHumanEdit };
        const refreshed = await deps.resolutionRepo.get(journal.contactId, journal.target);
        if (refreshed?.state !== 'active') return { stateChanged, refusedByHumanEdit };
        // Same fence re-adoption as the post-commit read above - see FENCE NOTE.
        journal = refreshed;
        await boundary('activity_applied', journal);
        continue;
      }
      if (journal.phase === 'activity_recorded' || journal.phase === 'activity_skipped') {
        await stampVerdict(
          journal,
          journal.outcome ?? (journal.action === 'accept' ? 'accepted' : 'dismissed'),
        );
        const result = await deps.resolutionRepo.advancePhase({
          token,
          expectedPhase: journal.phase,
          nextPhase: 'verdict_attempted',
        });
        if (result === 'stale') return { stateChanged, refusedByHumanEdit };
        const refreshed = await deps.resolutionRepo.get(journal.contactId, journal.target);
        if (refreshed?.state !== 'active') return { stateChanged, refusedByHumanEdit };
        // Same fence re-adoption as the post-commit read above - see FENCE NOTE.
        journal = refreshed;
        await boundary('verdict_attempted', journal);
        continue;
      }
      // The only non-success answer left is `stale`, i.e. another helper took the
      // journal before this final PII scrub. Every durable effect committed and
      // that helper finishes the scrub, so the human's action still succeeded.
      await deps.resolutionRepo.complete({
        token,
        expectedPhase: 'verdict_attempted',
        completedAt: now(),
      });
      return { stateChanged, refusedByHumanEdit };
    }
    throw new SuggestionResolutionError(409, 'suggestion_resolution_retry_exhausted', true);
  }

  return {
    async recoverAbandoned(contactId, opts) {
      const at = now();
      // The read path passes nothing and keeps MAX_RECOVERIES_PER_READ; the
      // daily sweep passes the closed key-set size. Nullish coalescing on
      // purpose: an explicit 0 is a real budget of zero, not "unset".
      const budget = opts?.maxAttempts ?? MAX_RECOVERIES_PER_READ;
      let recovered = 0;
      let stateChanged = false;
      let attempted = 0;
      for (const journal of await deps.resolutionRepo.listJournals(contactId)) {
        if (journal.state !== 'active') continue;
        if (Date.parse(journal.leaseExpiresAt) > Date.parse(at)) continue;
        // After the two free in-memory filters and before the first round trip,
        // so cheap skips never consume the budget and every journal that costs
        // IO does. ATTEMPTS, not successes: `recovered` only counts wins, so a
        // contact whose journals keep failing would still walk all twelve keys
        // per read - the cost the cap exists to bound.
        if (attempted >= budget) break;
        attempted += 1;
        try {
          const takeover = await deps.resolutionRepo.takeover({
            contactId,
            target: journal.target,
            now: at,
            leaseId: nextLeaseId(),
            ...(deps.leaseMs !== undefined && { leaseMs: deps.leaseMs }),
          });
          if (takeover.status !== 'taken_over') continue;
          const applied = await applyJournal(takeover.journal, { helping: true });
          recovered += 1;
          if (applied.stateChanged) stateChanged = true;
        } catch (err) {
          // Ids and the error only - a journal carries the suggestion's values.
          deps.logger.warn(
            { err, contactId, target: journal.target },
            'abandoned suggestion resolution recovery failed (best-effort)',
          );
        }
      }
      return { recovered, stateChanged };
    },

    async resolve(input) {
      const identityKey = requestedIdentityKey(input.contactId, input.target, input.identity);
      // A help that commits somebody else's domain effect must still reach the
      // SSE, even when this request then fails on its own identity (adv P3-25).
      let helpedCommitted = false;
      try {
        for (let attempt = 0; attempt < MAX_RESOLUTION_LOOPS; attempt += 1) {
          const current = await deps.resolutionRepo.get(input.contactId, input.target);
          if (current?.state === 'active') {
            const at = now();
            if (Date.parse(current.leaseExpiresAt) > Date.parse(at)) {
              throw new SuggestionResolutionError(409, 'suggestion_resolution_in_progress', true);
            }
            const takeover = await deps.resolutionRepo.takeover({
              contactId: input.contactId,
              target: input.target,
              now: at,
              leaseId: nextLeaseId(),
              ...(deps.leaseMs !== undefined && { leaseMs: deps.leaseMs }),
            });
            if (takeover.status === 'blocked') {
              throw new SuggestionResolutionError(409, 'suggestion_resolution_in_progress', true);
            }
            if (takeover.status === 'taken_over') {
              const helped = await applyJournal(takeover.journal, { helping: true });
              // A journal reached by HELPING never turns its refusal into this
              // request's answer - that belongs to whoever owns the identity.
              if (helped.stateChanged) helpedCommitted = true;
            }
            continue;
          }
          if (current?.state === 'completed' && current.identityKey === identityKey) {
            if (current.action !== input.action) {
              throw new SuggestionResolutionError(409, 'suggestion_already_resolved');
            }
            // An identity match is normally proof the action already applied,
            // and this immediate retry is idempotent. `released_unsafe` is the
            // one completed state where it did NOT: the effect was refused
            // pre-mutation and the snapshot could not be restored because a
            // NEWER suggestion already held the pending slot. Answering 200
            // would tell the operator their accept succeeded when nothing was
            // written, so say what is true - a newer suggestion replaced it.
            if (current.disposition === 'released_unsafe') {
              throw new SuggestionResolutionError(409, 'suggestion_replaced');
            }
            return { completedNow: false, helpedCommitted };
          }

          const suggestion = await deps.extractionRepo.getSuggestion(input.contactId, input.target);
          if (!suggestion) throw new SuggestionResolutionError(404, 'no_pending_suggestion');
          if (!matchesIdentity(suggestion, input.identity)) {
            throw new SuggestionResolutionError(409, 'suggestion_replaced');
          }
          const contact = await deps.contactsRepo.getById(input.contactId);
          if (!contact) throw new SuggestionResolutionError(404, 'contact_not_found');
          const claimedAt = now();
          const plan = buildPlan(contact, suggestion, input.action, input.actorId, claimedAt);

          if (plan.kind === 'phone') {
            const owner = await deps.contactsRepo.findByPhone(plan.phone);
            if (owner !== undefined && owner.contactId !== input.contactId) {
              throw new SuggestionResolutionError(409, 'phone_in_use');
            }
          }

          const claim = await deps.resolutionRepo.claim({
            suggestion,
            action: input.action,
            plan,
            now: claimedAt,
            leaseId: nextLeaseId(),
            ...(input.actorId !== undefined && { actorId: input.actorId }),
            ...(deps.leaseMs !== undefined && { leaseMs: deps.leaseMs }),
          });
          if (claim.status === 'suggestion_replaced') {
            throw new SuggestionResolutionError(409, 'suggestion_replaced');
          }
          if (claim.status === 'blocked') {
            if (Date.parse(claim.journal.leaseExpiresAt) <= Date.parse(now())) continue;
            throw new SuggestionResolutionError(409, 'suggestion_resolution_in_progress', true);
          }
          if (claim.status === 'completed') {
            if (claim.journal.identityKey === identityKey && claim.journal.action === input.action) {
              // Same reading as the completed-row branch above: this is the
              // race where the journal finished between our read and our claim.
              if (claim.journal.disposition === 'released_unsafe') {
                throw new SuggestionResolutionError(409, 'suggestion_replaced');
              }
              return { completedNow: false, helpedCommitted };
            }
            throw new SuggestionResolutionError(409, 'suggestion_already_resolved');
          }
          await boundary('claimed', claim.journal);
          const applied = await applyJournal(claim.journal, { helping: false });
          // H1 / item 1: the journal ran to completion - verdict stamped,
          // snapshot scrubbed - but the fenced write was REFUSED because the
          // field changed after the plan's guard was built. The chip is gone and
          // the contact does NOT carry the accepted value, so a 200 would tell
          // the operator their action applied when nothing of it did. Same
          // shape as the `released_unsafe` refusal above: throw AFTER the
          // durable work, never instead of it.
          if (applied.refusedByHumanEdit) {
            throw new SuggestionResolutionError(409, 'suggestion_field_edited');
          }
          return { completedNow: true, helpedCommitted };
        }
        throw new SuggestionResolutionError(409, 'suggestion_resolution_retry_exhausted', true);
      } catch (error) {
        // A help that committed must reach the SSE whatever this request then
        // failed on - a raw repo/SDK throw (claim() rethrowing its stored
        // lastError, a ValidationException, a network fault in getSuggestion or
        // getById) is not less of a state change than a
        // SuggestionResolutionError (adv P3-25 / item 28). The declared field on
        // SuggestionResolutionError keeps its type; this only adds the same
        // property to other Error instances.
        if (helpedCommitted && error instanceof Error) {
          (error as { helpedCommitted?: boolean }).helpedCommitted = true;
        }
        throw error;
      }
    },
  };
}
