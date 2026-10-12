// Spec 2026-10-12 D1 changes 4-5 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// section 2): the ONE guard commitContactEffect and its test fake evaluate
// (effectiveGuard), and how a refusal is told apart as a reclassification
// (guardMismatchIsClassification). Pure functions - no DynamoDB.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  effectiveGuard,
  guardMismatchIsClassification,
  type ActiveSuggestionResolution,
  type ResolutionAttributeGuard,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';

const TENANT_ONLY = ['housingAuthority', 'voucherSize', 'pets', 'evictions', 'tenure', 'porting', 'status'];

function journal(target: string, plan: ResolutionReplayPlan): ActiveSuggestionResolution {
  return {
    itemId: `resolve#c1#${target}`,
    state: 'active',
    contactId: 'c1',
    target,
    identityKey: `revision#rev-${target}`,
    action: 'accept',
    snapshot: {
      itemId: `sugg#c1#${target}`,
      ownerContactId: 'c1',
      target,
      suggestedValue: 'x',
      conversationId: 'conv-1',
      createdAt: '2026-10-12T11:00:00.000Z',
    },
    plan,
    phase: 'claimed',
    leaseId: 'lease-1',
    leaseExpiresAt: '2026-10-12T12:01:30.000Z',
    fence: 1,
    claimedAt: '2026-10-12T12:01:00.000Z',
  };
}

function fieldPlan(guard: ResolutionAttributeGuard, kind: 'contact' | 'status' = 'contact'): ResolutionReplayPlan {
  return { kind, patch: { x: 1 }, guard, audit: { eventType: 'ai_suggestion_accepted' } };
}

function contact(over: Record<string, unknown> = {}): ContactItem {
  return { contactId: 'c1', type: 'tenant', ...over } as ContactItem;
}

describe('effectiveGuard', () => {
  it.each(TENANT_ONLY)('adds caseworker_conversion absent to a pre-deploy %s guard', (target) => {
    const guard: ResolutionAttributeGuard = { [target]: { exists: false } };
    const kind = target === 'status' ? 'status' : 'contact';

    expect(effectiveGuard(journal(target, fieldPlan(guard, kind)))).toEqual({
      [target]: { exists: false },
      caseworker_conversion: { exists: false },
    });
  });

  it('leaves a guard that carries classification_revision exactly as it is', () => {
    const guard: ResolutionAttributeGuard = {
      voucherSize: { exists: false },
      classification_revision: { exists: true, value: 4 },
    };

    expect(effectiveGuard(journal('voucherSize', fieldPlan(guard)))).toEqual(guard);
  });

  it.each(['firstName', 'lastName', 'address'])('never extends a neutral %s guard', (target) => {
    const guard: ResolutionAttributeGuard = { [target]: { exists: false } };

    expect(effectiveGuard(journal(target, fieldPlan(guard)))).toEqual(guard);
  });

  it('answers an empty guard for a phone or a dismiss plan', () => {
    expect(effectiveGuard(journal('phone', {
      kind: 'phone', phone: '+15550102020', audit: { eventType: 'contact_phone_added' },
    }))).toEqual({});
    expect(effectiveGuard(journal('pets', {
      kind: 'dismiss', normalizedValue: 'two cats', audit: { eventType: 'ai_suggestion_dismissed' },
    }))).toEqual({});
  });

  it('never mutates the stored guard', () => {
    const guard: ResolutionAttributeGuard = { pets: { exists: false } };

    effectiveGuard(journal('pets', fieldPlan(guard)));

    expect(guard).toEqual({ pets: { exists: false } });
  });
});

describe('guardMismatchIsClassification', () => {
  it('is true when classification_revision was read absent and is now stored', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: false } },
      contact({ classification_revision: 1 }),
    )).toBe(true);
  });

  it('is true when the stored revision moved on', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: true, value: 1 } },
      contact({ classification_revision: 2 }),
    )).toBe(true);
  });

  it('is true when the legacy caseworker_conversion key mismatches', () => {
    expect(guardMismatchIsClassification(
      { housingAuthority: { exists: false }, caseworker_conversion: { exists: false } },
      contact({ caseworker_conversion: { at: '2026-10-12T12:00:00.000Z', by: 'u1', fromType: 'tenant' } }),
    )).toBe(true);
  });

  it('is false when only a written field changed', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: true, value: 2 } },
      contact({ pets: 'one dog', classification_revision: 2 }),
    )).toBe(false);
  });

  it('is true when a field AND the classification changed - classification wins the tie', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: false } },
      contact({ pets: 'one dog', classification_revision: 1 }),
    )).toBe(true);
  });

  it('is false for a contact that no longer exists', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: false } },
      undefined,
    )).toBe(false);
  });

  it('is false for a guard that names no classification key', () => {
    expect(guardMismatchIsClassification(
      { address: { exists: false } },
      contact({ address: { line1: '1 Main St' }, classification_revision: 5 }),
    )).toBe(false);
  });
});
