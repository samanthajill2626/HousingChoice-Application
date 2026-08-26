// In-memory suggestion-resolution journal for the crash/interleaving suite.
//
// F7b: a fake that DISAGREES with the repository it stands in for turns a
// 900-line crash suite into a suite that cannot fail. Every arm below now
// mirrors a specific line range of app/src/repos/suggestionResolutionRepo.ts,
// cited inline. When the real protocol regresses, the fake keeps the old
// contract and the suite goes red - which is the entire point.
//
// It is still a FAKE, not an emulator: DynamoDB's own failure modes (contention,
// cancellation, partial visibility) live in
// suggestionResolutionRepo.integration.test.ts against DynamoDB Local. What is
// mirrored here is the DECISION LOGIC - which result each arm returns for which
// stored state, and which writes are deduplicated.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ActivityEventsRepo } from '../../src/repos/activityEventsRepo.js';
import type { AuditRepo } from '../../src/repos/auditRepo.js';
import { seedPhonesForWrite, type ContactItem, type ContactsRepo } from '../../src/repos/contactsRepo.js';
import type { ExtractionRepo, SuggestionItem } from '../../src/repos/extractionRepo.js';
import {
  makeCompletedResolution,
  resolutionItemId,
  suggestionIdentityKey,
  type ActiveSuggestionResolution,
  type PhaseInput,
  type ResolutionActivityPlan,
  type ResolutionAttributeGuard,
  type ResolutionEffectResult,
  type ResolutionPhase,
  type SuggestionResolutionItem,
  type SuggestionResolutionRepo,
} from '../../src/repos/suggestionResolutionRepo.js';

export interface SuggestionResolutionFake {
  repo: SuggestionResolutionRepo;
  items: Map<string, SuggestionResolutionItem>;
}

function sameToken(item: SuggestionResolutionItem | undefined, input: PhaseInput): item is ActiveSuggestionResolution {
  const token = input.token;
  return item?.state === 'active'
    && item.identityKey === token.identityKey
    && item.action === token.action
    && item.leaseId === token.leaseId
    && item.fence === token.fence;
}

/**
 * MIRRORS suggestionResolutionRepo.ts:444-453 (`phaseAdvanced`), including the
 * deliberate EQUAL rank of activity_recorded and activity_skipped. The repo does
 * not export it, and a private copy that drifts is exactly the failure this
 * slice exists to remove, so the rank table is reproduced verbatim.
 */
function phaseAdvanced(current: ResolutionPhase, expected: ResolutionPhase): boolean {
  const rank: Record<ResolutionPhase, number> = {
    claimed: 0,
    domain_applied: 1,
    activity_recorded: 2,
    activity_skipped: 2,
    verdict_attempted: 3,
  };
  return rank[current] > rank[expected];
}

/** MIRRORS suggestionResolutionRepo.ts:389-394 (`deterministicSuffix`). */
function deterministicSuffix(journal: ActiveSuggestionResolution, purpose: string): string {
  return createHash('sha256')
    .update(`${journal.itemId}\u0000${journal.identityKey}\u0000${journal.action}\u0000${purpose}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
}

/** MIRRORS suggestionResolutionRepo.ts:378-387 (`contactMatchesGuard`). */
function contactMatchesGuard(
  contact: ContactItem | undefined,
  guard: ResolutionAttributeGuard,
): boolean {
  if (contact === undefined) return false;
  return Object.entries(guard).every(([key, expected]) => {
    const exists = Object.prototype.hasOwnProperty.call(contact, key) && contact[key] !== undefined;
    return expected.exists
      ? exists && isDeepStrictEqual(contact[key], expected.value)
      : !exists;
  });
}

export function createSuggestionResolutionFake(deps: {
  contactsRepo: ContactsRepo;
  extractionRepo: ExtractionRepo;
  auditRepo: AuditRepo;
  activityEventsRepo: ActivityEventsRepo;
  /**
   * The world's phone-pointer primitives. The real commitPhoneEffect owns the
   * phoneref# row inside its fenced transaction (establish-or-verify, and a
   * retry repairs a missing one); ContactsRepo exposes no such primitive, so
   * the fake needs them directly to mirror that (F6). `owner` reads the pointer
   * the way repo:789-803 does - ownership is arbitrated on the POINTER, never
   * on findByPhone, because a primary number deliberately has no pointer row.
   */
  phonePointers: {
    put(phone: string, ownerContactId: string): void;
    remove(phone: string): void;
    owner(phone: string): string | undefined;
  };
  /**
   * The world's conditional suggestion write. The real release() restores its
   * snapshot with a raw `attribute_not_exists(itemId)` Put inside the SAME
   * transaction that deletes the journal (repo:1021-1040); it does NOT call
   * `restoreSuggestionIfAbsent`, which has no production caller at all. Routing
   * the fake through that dead method would tie the crash suite to a surface
   * production does not use, so the world hands over the primitive instead.
   */
  suggestionRows: {
    putIfAbsent(suggestion: SuggestionItem): boolean;
  };
}): SuggestionResolutionFake {
  const items = new Map<string, SuggestionResolutionItem>();
  const key = (contactId: string, target: string): string => `${contactId}\u0000${target}`;
  // Deterministic-key dedupe stands in for the conditional Puts at repo:726,
  // repo:898 and repo:989 (audit) and repo:921-922 (activity). Without it a
  // replay silently doubles its trail and "exactly one audit row" is unprovable.
  const auditKeys = new Set<string>();
  const activityKeys = new Set<string>();

  function activeFor(input: PhaseInput): ActiveSuggestionResolution | undefined {
    const item = items.get(key(input.token.contactId, input.token.target));
    return sameToken(item, input) && item.phase === input.expectedPhase ? item : undefined;
  }

  function advance(item: ActiveSuggestionResolution, nextPhase: PhaseInput['nextPhase']): void {
    items.set(key(item.contactId, item.target), { ...item, phase: nextPhase });
  }

  /** MIRRORS repo:396-408 (`auditItem`) and its conditional Put. */
  async function appendAuditOnce(journal: ActiveSuggestionResolution): Promise<void> {
    const entityKey = `contacts#${journal.contactId}`;
    const ts = `${journal.claimedAt}#resolve-${deterministicSuffix(journal, 'audit')}`;
    const dedupeKey = `${entityKey}\u0000${ts}`;
    if (auditKeys.has(dedupeKey)) return;
    auditKeys.add(dedupeKey);
    const actorId = journal.actorId;
    await deps.auditRepo.append(entityKey, journal.plan.audit.eventType, {
      ...(journal.plan.audit.payload ?? {}),
      // repo:403-406 folds the actor into the payload as well as the item.
      ...(actorId !== undefined && { actor: actorId }),
    });
  }

  /** MIRRORS repo:410-426 (`activityItem`) and its conditional Put. */
  async function recordActivityOnce(
    journal: ActiveSuggestionResolution,
    activity: ResolutionActivityPlan,
  ): Promise<void> {
    const eventId = `evt-resolve-${deterministicSuffix(journal, 'activity')}`;
    const dedupeKey = `${journal.contactId}\u0000${journal.claimedAt}#${eventId}`;
    if (activityKeys.has(dedupeKey)) return;
    activityKeys.add(dedupeKey);
    await deps.activityEventsRepo.record({
      contactId: journal.contactId,
      type: activity.type,
      label: activity.label,
      // repo:419-422 clocks the row from claimedAt so every replay is byte-identical.
      at: journal.claimedAt,
      ...(activity.refType !== undefined && { refType: activity.refType }),
      ...(activity.refId !== undefined && { refId: activity.refId }),
    });
  }

  async function effect(
    input: PhaseInput,
    apply: (
      journal: ActiveSuggestionResolution,
    ) => Promise<'committed' | 'phone_conflict' | 'superseded_by_human_edit' | 'stale'>,
  ): Promise<ResolutionEffectResult> {
    const current = items.get(key(input.token.contactId, input.token.target));
    // repo:497 - already_committed covers the next phase AND any phase PAST the
    // expected one. A rank-blind equality check answers 'stale' for a journal
    // that has moved further along, so a resumed replay reads as a lost race.
    if (
      sameToken(current, input)
      && (current.phase === input.nextPhase || phaseAdvanced(current.phase, input.expectedPhase))
    ) {
      return 'already_committed';
    }
    const journal = activeFor(input);
    if (journal === undefined) return 'stale';
    const result = await apply(journal);
    if (result === 'phone_conflict' || result === 'stale') return result;
    if (result === 'superseded_by_human_edit') {
      // repo:760 journalSuperseded stamps phase AND outcome together.
      items.set(key(journal.contactId, journal.target), {
        ...journal,
        phase: input.nextPhase,
        outcome: result,
      });
      return result;
    }
    advance(journal, input.nextPhase);
    return 'committed';
  }

  const repo: SuggestionResolutionRepo = {
    async get(contactId, target) {
      return items.get(key(contactId, target));
    },

    async listJournals(contactId) {
      return [...items.values()].filter((item) => item.contactId === contactId);
    },

    // The sweep's Scan page (log-hygiene spec 9.2). Ordered by itemId so the
    // cursor means the same thing here as it does in DynamoDB, and projected to
    // the same four fields - a caller that reads a snapshot off one of these
    // rows must fail here too, not only in production.
    async listActiveResolutionRows(opts) {
      const ordered = [...items.values()]
        .map((item) => ({ itemId: resolutionItemId(item.contactId, item.target), item }))
        .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
      const after =
        opts.cursor === undefined
          ? undefined
          : (JSON.parse(opts.cursor) as { itemId: string }).itemId;
      const window = after === undefined ? ordered : ordered.filter((e) => e.itemId > after);
      // `limit` bounds rows EVALUATED, not matches - the filter runs INSIDE the
      // window, exactly like a real Scan page.
      const evaluated = window.slice(0, opts.limit);
      const rows = evaluated
        .filter((e) => e.item.state === 'active')
        .map((e) => {
          const active = e.item as ActiveSuggestionResolution;
          return {
            contactId: active.contactId,
            target: active.target,
            leaseExpiresAt: active.leaseExpiresAt,
            claimedAt: active.claimedAt,
          };
        });
      const last = evaluated.at(-1);
      return {
        rows,
        ...(last !== undefined &&
          window.length > evaluated.length && {
            nextCursor: JSON.stringify({ itemId: last.itemId }),
          }),
      };
    },

    async claim(input) {
      const mapKey = key(input.suggestion.ownerContactId, input.suggestion.target);
      const identityKey = suggestionIdentityKey(input.suggestion);
      const leaseId = input.leaseId ?? randomUUID();
      const existing = items.get(mapKey);
      if (existing?.state === 'active') {
        // repo:612-618 - a LOST ACK (the claim landed, the response did not) is
        // re-claimed rather than blocked, but only when the active journal is
        // this identity AND this lease. Without the leaseId compare a caller's
        // own retry deadlocks against its own successful write.
        if (existing.identityKey === identityKey && existing.leaseId === leaseId) {
          return { status: 'claimed', journal: existing };
        }
        return { status: 'blocked', journal: existing };
      }
      if (existing?.state === 'completed' && existing.identityKey === identityKey) {
        return { status: 'completed', journal: existing };
      }
      const live = await deps.extractionRepo.getSuggestion(
        input.suggestion.ownerContactId,
        input.suggestion.target,
      );
      if (live === undefined || suggestionIdentityKey(live) !== identityKey) {
        return { status: 'suggestion_replaced' };
      }
      const deleted = await deps.extractionRepo.deleteSuggestionIfCurrent(
        live.ownerContactId,
        live.target,
        live.createdAt,
        live.runId,
        live.revision,
      );
      if (!deleted) return { status: 'suggestion_replaced' };
      const journal: ActiveSuggestionResolution = {
        itemId: resolutionItemId(live.ownerContactId, live.target),
        state: 'active',
        contactId: live.ownerContactId,
        target: live.target,
        identityKey,
        action: input.action,
        ...(input.actorId !== undefined && { actorId: input.actorId }),
        snapshot: live,
        plan: input.plan,
        phase: 'claimed',
        leaseId,
        leaseExpiresAt: new Date(Date.parse(input.now) + (input.leaseMs ?? 30_000)).toISOString(),
        fence: 1,
        claimedAt: input.now,
      };
      items.set(mapKey, journal);
      return { status: 'claimed', journal };
    },

    async takeover(input) {
      const mapKey = key(input.contactId, input.target);
      const existing = items.get(mapKey);
      if (existing?.state !== 'active') return { status: 'missing' };
      // repo:657 compares the STORED ISO string against `now` lexicographically
      // (`#leaseExpiry <= :now`). Parsing to millis here would quietly accept
      // lease strings the engine orders differently.
      if (existing.leaseExpiresAt > input.now) {
        return { status: 'blocked', journal: existing };
      }
      const journal: ActiveSuggestionResolution = {
        ...existing,
        leaseId: input.leaseId ?? randomUUID(),
        leaseExpiresAt: new Date(Date.parse(input.now) + (input.leaseMs ?? 30_000)).toISOString(),
        fence: existing.fence + 1,
      };
      items.set(mapKey, journal);
      return { status: 'taken_over', journal };
    },

    commitContactEffect(input) {
      return effect(input, async (journal) => {
        // repo:685 - a plan of the wrong kind is STALE. Reporting 'committed'
        // told the service a domain effect had landed when nothing was written.
        if (journal.plan.kind !== 'contact' && journal.plan.kind !== 'status') return 'stale';
        // repo:704 - nothing to SET and nothing to REMOVE is also stale.
        if (Object.values(journal.plan.patch).every((value) => value === undefined)) return 'stale';
        const contact = await deps.contactsRepo.getById(journal.contactId);
        // repo:732-763 - arbitration order: the journal must still be ours at
        // the expected phase (activeFor, above), THEN a consistent re-read
        // decides. A contact that still matches the guard means the write lost
        // to CONTENTION, which is 'stale'; only a MISMATCH is a human edit.
        if (!contactMatchesGuard(contact, journal.plan.guard)) {
          return 'superseded_by_human_edit';
        }
        await deps.contactsRepo.update(journal.contactId, journal.plan.patch);
        await appendAuditOnce(journal);
        return 'committed';
      });
    },

    commitPhoneEffect(input) {
      return effect(input, async (journal) => {
        if (journal.plan.kind !== 'phone') return 'stale'; // repo:781
        const plan = journal.plan;
        // repo:789-803 - ownership is decided by the phoneref# POINTER row, not
        // by findByPhone. A primary number has no pointer, so findByPhone
        // conflicted where the real transaction proceeds (and the reverse).
        const pointerOwner = deps.phonePointers.owner(plan.phone);
        if (pointerOwner !== undefined && pointerOwner !== journal.contactId) return 'phone_conflict';
        // F6: mirror the REAL commitPhoneEffect (itself addPhone-shaped, under
        // the journal fence, repo:804-824): materialize phones[] with the
        // primary's timestamps, attach the number as NON-primary, never write
        // the phone scalar, and establish-or-repair the pointer every attempt.
        const contact = await deps.contactsRepo.getById(journal.contactId);
        if (contact === undefined) return 'stale';
        const phones = seedPhonesForWrite(contact, journal.claimedAt);
        let target = phones.find((entry) => entry.phone === plan.phone);
        if (target === undefined) {
          target = {
            phone: plan.phone,
            primary: false,
            firstSeenAt: journal.claimedAt,
            lastSeenAt: journal.claimedAt,
            ...(plan.label !== undefined && { label: plan.label }),
          };
          phones.push(target);
        }
        await deps.contactsRepo.update(journal.contactId, { phones });
        if (target.primary === true) deps.phonePointers.remove(plan.phone);
        else deps.phonePointers.put(plan.phone, journal.contactId);
        await appendAuditOnce(journal);
        return 'committed';
      });
    },

    commitActivityEffect(input) {
      return effect(input, async (journal) => {
        const activity = 'activity' in journal.plan ? journal.plan.activity : undefined;
        // repo:913-914 - no activity plan is STALE, not a silent commit.
        if (activity === undefined) return 'stale';
        await recordActivityOnce(journal, activity);
        return 'committed';
      });
    },

    commitDismissalEffect(input) {
      return effect(input, async (journal) => {
        if (journal.plan.kind !== 'dismiss') return 'stale'; // repo:931
        await appendAuditOnce(journal);
        await deps.extractionRepo.putDismissal(
          journal.contactId,
          journal.target,
          journal.plan.normalizedValue,
        );
        const pending = await deps.extractionRepo.getSuggestion(journal.contactId, journal.target);
        // repo:932-934 reads the STORED _normalizedValue. Recomputing it here
        // hid any drift between the writer's normalization and the reader's.
        if (pending !== undefined && pending._normalizedValue === journal.plan.normalizedValue) {
          await deps.extractionRepo.deleteSuggestionIfCurrent(
            pending.ownerContactId,
            pending.target,
            pending.createdAt,
            pending.runId,
            pending.revision,
          );
        }
        return 'committed';
      });
    },

    advancePhase(input) {
      return effect(input, async () => 'committed');
    },

    async release(input) {
      const mapKey = key(input.token.contactId, input.token.target);
      const current = items.get(mapKey);
      const phaseInput = { token: input.token, expectedPhase: input.expectedPhase, nextPhase: input.expectedPhase };
      const held = sameToken(current, phaseInput) && current.phase === input.expectedPhase;
      const restored = await deps.extractionRepo.getSuggestion(
        input.token.contactId,
        input.token.target,
      );
      // repo:1047-1053 - the IDEMPOTENT arm: the journal is already gone and
      // our own snapshot holds the pending slot, so a previous attempt
      // released and only its acknowledgement was lost.
      if (
        current === undefined
        && restored !== undefined
        && suggestionIdentityKey(restored) === input.token.identityKey
      ) {
        return 'released';
      }
      // TENTH fake/repo divergence (conf P2-1). The real release() decides its
      // ANSWER in the catch arm, and there `pending !== undefined` -> 'unsafe'
      // (repo:1054) is tested BEFORE `!sameToken(...)` -> 'stale' (repo:1055).
      // The lease can be lost DURING the transaction - requireActive (repo:1017)
      // passes, then a helper takes the journal over while the TransactWrite is
      // in flight - so a caller that no longer holds the token still hears
      // 'unsafe' whenever a pending row occupies the slot. This fake decides
      // everything atomically, so answering 'stale' first for a lost token made
      // that interleaving inexpressible and hid the false `superseded` stamp it
      // produced. Pending row outranks lost token, exactly as repo:1054-1055.
      if (restored !== undefined) return 'unsafe';
      if (!held) return 'stale';
      // repo:1021-1040 is ONE transaction: Put the snapshot under
      // `attribute_not_exists(itemId)` AND Delete the journal under the exact
      // guard. Both conditions are decided before either mutation, so a slot
      // already held by a NEWER suggestion leaves the journal untouched.
      if (!deps.suggestionRows.putIfAbsent(current.snapshot)) return 'unsafe';
      items.delete(mapKey);
      return 'released';
    },

    async complete(input) {
      const mapKey = key(input.token.contactId, input.token.target);
      const current = items.get(mapKey);
      if (current?.state === 'completed') {
        return current.identityKey === input.token.identityKey && current.action === input.token.action
          ? 'already_completed'
          : 'stale';
      }
      const phaseInput = { token: input.token, expectedPhase: input.expectedPhase, nextPhase: input.expectedPhase };
      if (!sameToken(current, phaseInput) || current.phase !== input.expectedPhase) return 'stale';
      items.set(mapKey, makeCompletedResolution(current, input.completedAt, input.disposition));
      return 'completed';
    },
  };

  return { repo, items };
}
