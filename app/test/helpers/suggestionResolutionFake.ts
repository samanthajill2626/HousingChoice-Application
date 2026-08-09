import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ActivityEventsRepo } from '../../src/repos/activityEventsRepo.js';
import type { AuditRepo } from '../../src/repos/auditRepo.js';
import type { ContactsRepo } from '../../src/repos/contactsRepo.js';
import type { ExtractionRepo } from '../../src/repos/extractionRepo.js';
import {
  makeCompletedResolution,
  resolutionItemId,
  suggestionIdentityKey,
  tokenFor,
  type ActiveSuggestionResolution,
  type PhaseInput,
  type ResolutionEffectResult,
  type SuggestionResolutionItem,
  type SuggestionResolutionRepo,
} from '../../src/repos/suggestionResolutionRepo.js';
import { normalizeSuggestionValue } from '../../src/services/extraction/schema.js';

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

export function createSuggestionResolutionFake(deps: {
  contactsRepo: ContactsRepo;
  extractionRepo: ExtractionRepo;
  auditRepo: AuditRepo;
  activityEventsRepo: ActivityEventsRepo;
}): SuggestionResolutionFake {
  const items = new Map<string, SuggestionResolutionItem>();
  const key = (contactId: string, target: string): string => `${contactId}\u0000${target}`;

  function activeFor(input: PhaseInput): ActiveSuggestionResolution | undefined {
    const item = items.get(key(input.token.contactId, input.token.target));
    return sameToken(item, input) && item.phase === input.expectedPhase ? item : undefined;
  }

  function advance(item: ActiveSuggestionResolution, nextPhase: PhaseInput['nextPhase']): void {
    items.set(key(item.contactId, item.target), { ...item, phase: nextPhase });
  }

  async function effect(
    input: PhaseInput,
    apply: (
      journal: ActiveSuggestionResolution,
    ) => Promise<'committed' | 'phone_conflict' | 'superseded_by_human_edit'>,
  ): Promise<ResolutionEffectResult> {
    const current = items.get(key(input.token.contactId, input.token.target));
    if (current?.state === 'active' && sameToken(current, input) && current.phase === input.nextPhase) {
      return 'already_committed';
    }
    const journal = activeFor(input);
    if (journal === undefined) return 'stale';
    const result = await apply(journal);
    if (result === 'phone_conflict') return result;
    if (result === 'superseded_by_human_edit') {
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

    async claim(input) {
      const mapKey = key(input.suggestion.ownerContactId, input.suggestion.target);
      const identityKey = suggestionIdentityKey(input.suggestion);
      const existing = items.get(mapKey);
      if (existing?.state === 'active') return { status: 'blocked', journal: existing };
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
        leaseId: input.leaseId ?? randomUUID(),
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
      if (Date.parse(existing.leaseExpiresAt) > Date.parse(input.now)) {
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
        if (journal.plan.kind !== 'contact' && journal.plan.kind !== 'status') return 'committed';
        const contact = await deps.contactsRepo.getById(journal.contactId);
        const matches = contact !== undefined
          && Object.entries(journal.plan.guard).every(([field, expected]) => {
            const value = contact[field];
            return expected.exists
              ? value !== undefined && isDeepStrictEqual(value, expected.value)
              : value === undefined;
          });
        if (!matches) return 'superseded_by_human_edit';
        await deps.contactsRepo.update(journal.contactId, journal.plan.patch);
        await deps.auditRepo.append(
          `contacts#${journal.contactId}`,
          journal.plan.audit.eventType,
          journal.plan.audit.payload,
        );
        return 'committed';
      });
    },

    commitPhoneEffect(input) {
      return effect(input, async (journal) => {
        if (journal.plan.kind !== 'phone') return 'committed';
        const owner = await deps.contactsRepo.findByPhone(journal.plan.phone);
        if (owner !== undefined && owner.contactId !== journal.contactId) return 'phone_conflict';
        await deps.contactsRepo.addPhone(journal.contactId, {
          phone: journal.plan.phone,
          ...(journal.plan.label !== undefined && { label: journal.plan.label }),
        });
        await deps.auditRepo.append(
          `contacts#${journal.contactId}`,
          journal.plan.audit.eventType,
          journal.plan.audit.payload,
        );
        return 'committed';
      });
    },

    commitActivityEffect(input) {
      return effect(input, async (journal) => {
        if (journal.plan.kind !== 'dismiss' && journal.plan.activity !== undefined) {
          await deps.activityEventsRepo.record({
            contactId: journal.contactId,
            type: journal.plan.activity.type,
            label: journal.plan.activity.label,
            ...(journal.plan.activity.refType !== undefined && { refType: journal.plan.activity.refType }),
            ...(journal.plan.activity.refId !== undefined && { refId: journal.plan.activity.refId }),
          });
        }
        return 'committed';
      });
    },

    commitDismissalEffect(input) {
      return effect(input, async (journal) => {
        if (journal.plan.kind !== 'dismiss') return 'committed';
        await deps.auditRepo.append(
          `contacts#${journal.contactId}`,
          journal.plan.audit.eventType,
          journal.plan.audit.payload,
        );
        await deps.extractionRepo.putDismissal(
          journal.contactId,
          journal.target,
          journal.plan.normalizedValue,
        );
        const pending = await deps.extractionRepo.getSuggestion(journal.contactId, journal.target);
        if (
          pending !== undefined
          && normalizeSuggestionValue(pending.target, pending.suggestedValue) === journal.plan.normalizedValue
        ) {
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
      if (!sameToken(current, phaseInput) || current.phase !== input.expectedPhase) return 'stale';
      const live = await deps.extractionRepo.getSuggestion(current.contactId, current.target);
      if (live !== undefined) return 'unsafe';
      await deps.extractionRepo.restoreSuggestionIfAbsent(current.snapshot);
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
