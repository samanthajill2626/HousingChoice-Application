// Spec 2026-10-12 D1 changes 4-5 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// section 2): the ONE guard commitContactEffect and its test fake evaluate
// (effectiveGuard), and how a refusal is told apart as a reclassification
// (guardMismatchIsClassification). Pure functions - no DynamoDB.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  effectiveGuard,
  guardMismatchIsClassification,
  tokenFor,
  type ActiveSuggestionResolution,
  type ResolutionAttributeGuard,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

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

// The FakeWorld half of the parity the real-repo cases in
// suggestionResolutionRepo.integration.test.ts prove on DynamoDB Local - the
// same plans, the same contact states, the same answers.
describe('the FakeWorld journal answers like the real repository (spec 2026-10-12 D1, W4)', () => {
  const NOW = '2026-10-12T12:01:00.000Z';
  const CONVERTED = {
    type: 'partner',
    role: 'Caseworker',
    status: 'active',
    classification_revision: 1,
    caseworker_conversion: { at: '2026-10-12T12:00:30.000Z', by: 'user-2', fromType: 'tenant' },
  };

  function authorityPlan(guard: ResolutionAttributeGuard): ResolutionReplayPlan {
    return {
      kind: 'contact',
      patch: {
        housingAuthority: 'Atlanta Housing Authority',
        housingAuthority_source: { source: 'ai', at: NOW },
      },
      guard,
      audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'housingAuthority' } },
    };
  }

  function seedFakeContact(world: FakeWorld, contactId: string, over: Record<string, unknown> = {}): void {
    world.contacts.push({
      contactId, type: 'tenant', status: 'onboarding', created_at: '2026-07-01T10:00:00.000Z', ...over,
    });
  }

  /** The conversion's commit, applied to the stored contact: authority removed, re-typed, revision bumped. */
  function convertInPlace(world: FakeWorld, contactId: string): void {
    const contact = world.contacts.find((c) => c.contactId === contactId);
    if (contact === undefined) throw new Error('no contact');
    delete contact['housingAuthority'];
    delete contact['housingAuthority_source'];
    Object.assign(contact, CONVERTED);
  }

  async function claimOnFake(
    world: FakeWorld,
    input: { contactId: string; target: string; suggestedValue: string; plan: ResolutionReplayPlan },
  ) {
    await world.extractionRepo.putSuggestion({
      ownerContactId: input.contactId,
      target: input.target,
      suggestedValue: input.suggestedValue,
      conversationId: `conv-${input.contactId}`,
    });
    const suggestion = await world.extractionRepo.getSuggestion(input.contactId, input.target);
    if (suggestion === undefined) throw new Error('suggestion not stored');
    const claimed = await world.suggestionResolutionRepo.claim({
      suggestion,
      action: 'accept',
      actorId: 'user-1',
      plan: input.plan,
      now: NOW,
      leaseId: `lease-${input.contactId}`,
      leaseMs: 30_000,
    });
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    return {
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed' as const,
      nextPhase: 'domain_applied' as const,
    };
  }

  function storedJournal(world: FakeWorld, contactId: string, target: string) {
    return [...world.suggestionResolutions.values()].find(
      (item) => item.contactId === contactId && item.target === target,
    );
  }

  it('answers superseded_by_reclassification when classification_revision moved on, storing the human-edit outcome', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-revision');
    const phase = await claimOnFake(world, {
      contactId: 'f-revision', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({
        housingAuthority: { exists: false },
        housingAuthority_source: { exists: false },
        classification_revision: { exists: false },
      }),
    });
    convertInPlace(world, 'f-revision');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_reclassification');

    expect(world.contacts.find((c) => c.contactId === 'f-revision')?.['housingAuthority']).toBeUndefined();
    expect(storedJournal(world, 'f-revision', 'housingAuthority')).toMatchObject({
      state: 'active', phase: 'domain_applied', outcome: 'superseded_by_human_edit',
    });
  });

  it('answers superseded_by_reclassification when the field ALSO changed - classification wins the tie', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-tie', { housingAuthority: 'DeKalb County Housing Authority' });
    const phase = await claimOnFake(world, {
      contactId: 'f-tie', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({
        housingAuthority: { exists: true, value: 'DeKalb County Housing Authority' },
        housingAuthority_source: { exists: false },
        classification_revision: { exists: false },
      }),
    });
    convertInPlace(world, 'f-tie');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_reclassification');
  });

  it('ends a pre-deploy journal on a converted contact as superseded, never committed', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-legacy');
    const phase = await claimOnFake(world, {
      contactId: 'f-legacy', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({ housingAuthority: { exists: false }, housingAuthority_source: { exists: false } }),
    });
    convertInPlace(world, 'f-legacy');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_reclassification');
    expect(world.contacts.find((c) => c.contactId === 'f-legacy')?.['housingAuthority']).toBeUndefined();
  });

  it('still commits that pre-deploy journal onto an unconverted tenant (PIN)', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-legacy-tenant');
    const phase = await claimOnFake(world, {
      contactId: 'f-legacy-tenant', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({ housingAuthority: { exists: false }, housingAuthority_source: { exists: false } }),
    });

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('committed');
    expect(world.contacts.find((c) => c.contactId === 'f-legacy-tenant')?.['housingAuthority'])
      .toBe('Atlanta Housing Authority');
  });

  it('keeps a field-only change a human edit when the revision is unchanged (PIN)', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-field', { classification_revision: 2 });
    const phase = await claimOnFake(world, {
      contactId: 'f-field', target: 'pets', suggestedValue: 'two cats',
      plan: {
        kind: 'contact',
        patch: { pets: 'two cats' },
        guard: { pets: { exists: false }, classification_revision: { exists: true, value: 2 } },
        audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'pets' } },
      },
    });
    const contact = world.contacts.find((c) => c.contactId === 'f-field');
    if (contact === undefined) throw new Error('no contact');
    contact['pets'] = 'one dog';

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_human_edit');
  });

  it('never extends a neutral guard: an address journal still commits onto a converted contact (PIN)', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-neutral');
    const phase = await claimOnFake(world, {
      contactId: 'f-neutral', target: 'address', suggestedValue: '1 Main St',
      plan: {
        kind: 'contact',
        patch: { address: { line1: '1 Main St' } },
        guard: { address: { exists: false } },
        audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'address' } },
      },
    });
    convertInPlace(world, 'f-neutral');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('committed');
  });
});

describe('one guard function for the repository and its fake (spec 2026-10-12 D1 change 4)', () => {
  const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const count = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length;

  it('commitContactEffect evaluates effectiveGuard at all three sites and never the raw plan guard', () => {
    const repo = read('../src/repos/suggestionResolutionRepo.ts');

    expect(count(repo, /\.plan\.guard\b/g)).toBe(0);
    expect(count(repo, /effectiveGuard\(journal\)/g)).toBe(1);
    expect(repo).toContain('contactGuardCondition(guard, true)');
    expect(repo).toContain('contactMatchesGuard(contact, guard)');
    expect(repo).toContain('contactGuardCondition(guard, false)');
  });

  it('the fake imports both guard functions from the repository and reads no plan guard of its own', () => {
    const fake = read('./helpers/suggestionResolutionFake.ts');

    expect(count(fake, /\.plan\.guard\b/g)).toBe(0);
    expect(count(fake, /effectiveGuard\(journal\)/g)).toBe(1);
    expect(fake).toMatch(
      /import \{[^}]*\beffectiveGuard\b[^}]*\} from '\.\.\/\.\.\/src\/repos\/suggestionResolutionRepo\.js'/,
    );
    expect(fake).toMatch(
      /import \{[^}]*\bguardMismatchIsClassification\b[^}]*\} from '\.\.\/\.\.\/src\/repos\/suggestionResolutionRepo\.js'/,
    );
  });
});
