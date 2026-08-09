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

export interface SuggestionRequestIdentity {
  revision?: string;
  createdAt: string;
  runId?: string;
}

export type ResolutionBoundary = 'claimed' | 'domain_applied' | 'activity_applied' | 'verdict_attempted';

export interface SuggestionResolutionHooks {
  afterBoundary?: (boundary: ResolutionBoundary, journal: ActiveSuggestionResolution) => Promise<void> | void;
}

export interface SuggestionResolutionService {
  resolve(input: {
    contactId: string;
    target: string;
    action: ResolutionAction;
    identity: SuggestionRequestIdentity;
    actorId?: string;
  }): Promise<{ completedNow: boolean }>;
}

export class SuggestionResolutionError extends Error {
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

  async function applyJournal(initial: ActiveSuggestionResolution): Promise<void> {
    let journal = initial;
    for (let attempt = 0; attempt < MAX_RESOLUTION_LOOPS; attempt += 1) {
      const token = tokenFor(journal);
      if (journal.phase === 'claimed') {
        let result;
        try {
          result = journal.plan.kind === 'phone'
            ? await deps.resolutionRepo.commitPhoneEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' })
            : journal.plan.kind === 'dismiss'
              ? await deps.resolutionRepo.commitDismissalEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' })
              : await deps.resolutionRepo.commitContactEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' });
        } catch (error) {
          throw error;
        }
        if (result === 'phone_conflict') {
          await deps.resolutionRepo.release({ token, expectedPhase: 'claimed' });
          throw new SuggestionResolutionError(409, 'phone_in_use');
        }
        if (result === 'stale') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
        const refreshed = await deps.resolutionRepo.get(journal.contactId, journal.target);
        if (refreshed?.state !== 'active') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
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
          } catch (error) {
            deps.logger.error(
              { error, contactId: journal.contactId, target: journal.target },
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
        if (result === 'stale') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
        const refreshed = await deps.resolutionRepo.get(journal.contactId, journal.target);
        if (refreshed?.state !== 'active') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
        journal = refreshed;
        await boundary('activity_applied', journal);
        continue;
      }
      if (journal.phase === 'activity_recorded' || journal.phase === 'activity_skipped') {
        const snapshot = journal.snapshot;
        if (snapshot.runId !== undefined && isDecisionTarget(snapshot.target)) {
          try {
            await deps.aiRunsRepo.setVerdict(
              snapshot.runId,
              snapshot.target,
              journal.outcome
                ?? (journal.action === 'accept' ? 'accepted' : 'dismissed'),
              {
                at: now(),
                expectedVerdict: 'pending',
                freshSuggestionCreatedAt: snapshot.createdAt,
                ...(journal.actorId !== undefined && { by: journal.actorId }),
              },
            );
          } catch (error) {
            deps.logger.warn(
              { error, contactId: journal.contactId, target: journal.target },
              'ai run verdict stamp failed (best-effort)',
            );
          }
        }
        const result = await deps.resolutionRepo.advancePhase({
          token,
          expectedPhase: journal.phase,
          nextPhase: 'verdict_attempted',
        });
        if (result === 'stale') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
        const refreshed = await deps.resolutionRepo.get(journal.contactId, journal.target);
        if (refreshed?.state !== 'active') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
        journal = refreshed;
        await boundary('verdict_attempted', journal);
        continue;
      }
      const completed = await deps.resolutionRepo.complete({
        token,
        expectedPhase: 'verdict_attempted',
        completedAt: now(),
      });
      if (completed === 'stale') throw new SuggestionResolutionError(409, 'suggestion_resolution_lost', true);
      return;
    }
    throw new SuggestionResolutionError(409, 'suggestion_resolution_retry_exhausted', true);
  }

  return {
    async resolve(input) {
      const identityKey = requestedIdentityKey(input.contactId, input.target, input.identity);
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
          if (takeover.status === 'taken_over') await applyJournal(takeover.journal);
          continue;
        }
        if (current?.state === 'completed' && current.identityKey === identityKey) {
          if (current.action !== input.action) {
            throw new SuggestionResolutionError(409, 'suggestion_already_resolved');
          }
          return { completedNow: false };
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
            return { completedNow: false };
          }
          throw new SuggestionResolutionError(409, 'suggestion_already_resolved');
        }
        await boundary('claimed', claim.journal);
        await applyJournal(claim.journal);
        return { completedNow: true };
      }
      throw new SuggestionResolutionError(409, 'suggestion_resolution_retry_exhausted', true);
    },
  };
}
