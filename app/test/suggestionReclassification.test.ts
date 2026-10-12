// Spec 2026-10-12 D1 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// section 2; R2-ADV-1): an accepted AI suggestion for a TENANT-ONLY field commits
// only onto a contact typed tenant whose classification is unchanged since the
// accept read it. These cases drive the HTTP routes on the FakeWorld
// (makeWebhookHarness). The DynamoDB Local twin of the schedules is
// suggestionReclassification.integration.test.ts; the guard functions and the
// fake's parity with the real repository are in
// suggestionReclassificationGuard.test.ts.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import type { SuggestionItem } from '../src/repos/extractionRepo.js';
import { TENANT_ONLY_TARGETS } from '../src/services/suggestionResolution.js';

const suggestionIdentities = new Map<string, { revision?: string; createdAt: string; runId?: string }>();

/** A contact - a tenant with no classification_revision unless `over` says otherwise. */
function seedContact(world: FakeWorld, over: Record<string, unknown> = {}): string {
  const contactId = (over['contactId'] as string | undefined) ?? 'c1';
  world.contacts.push({
    contactId,
    type: 'tenant',
    status: 'onboarding',
    phone: '+15550100001',
    created_at: '2026-07-01T10:00:00.000Z',
    ...over,
  });
  return contactId;
}

async function seedSuggestion(
  world: FakeWorld,
  suggestion: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
): Promise<void> {
  await world.extractionRepo.putSuggestion(suggestion);
  const stored = await world.extractionRepo.getSuggestion(suggestion.ownerContactId, suggestion.target);
  if (stored !== undefined) {
    suggestionIdentities.set(`${stored.ownerContactId}#${stored.target}`, {
      revision: stored.revision,
      createdAt: stored.createdAt,
      runId: stored.runId,
    });
  }
}

function accept(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/accept`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(suggestionIdentities.get(`${contactId}#${target}`));
}

function dismiss(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/dismiss`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(suggestionIdentities.get(`${contactId}#${target}`));
}

function contactOf(world: FakeWorld, contactId: string) {
  return world.contacts.find((contact) => contact.contactId === contactId);
}

function journalsFor(world: FakeWorld, contactId: string) {
  return [...world.suggestionResolutions.values()].filter((item) => item.contactId === contactId);
}

function suggestionEmits(world: FakeWorld): number {
  return world.emitted.filter((event) => event.event === 'suggestion.updated').length;
}

// D1 cases. Later tasks insert their helpers ABOVE this line.

describe('D1 change 1: the accept plan reads the contact consistently', () => {
  it('builds the plan from a CONSISTENT contact read', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-plan-read',
    });
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    await accept(app, 'c1', 'pets').expect(200);

    // The FIRST contact read of the request is the plan read: resolve() reads
    // the journal and the suggestion first, neither through contactsRepo.
    expect(getById.mock.calls[0]).toEqual(['c1', { consistentRead: true }]);
  });
});

describe('D1 change 2: a tenant-only accept on a contact not typed tenant is refused before the claim', () => {
  it('names exactly the seven tenant-only targets', () => {
    expect([...TENANT_ONLY_TARGETS].sort()).toEqual([
      'evictions', 'housingAuthority', 'pets', 'porting', 'status', 'tenure', 'voucherSize',
    ]);
  });

  it.each([
    ['housingAuthority', 'Atlanta Housing Authority'],
    ['voucherSize', '3'],
    ['pets', 'two cats'],
    ['evictions', 'none'],
    ['tenure', '2 years'],
    ['porting', 'true'],
    ['status', 'searching'],
  ])('refuses a %s accept on a landlord with 409 suggestion_contact_not_tenant and keeps the chip', async (target, suggestedValue) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target, suggestedValue, conversationId: 'conv-ll', runId: `run-${target}`,
    });
    const emitsBefore = suggestionEmits(world);

    const res = await accept(app, 'c-ll', target);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    // Refused before the claim: the chip is still pending, no journal exists,
    // the contact is untouched and no dashboard is told anything changed.
    expect(await world.extractionRepo.getSuggestion('c-ll', target)).toBeDefined();
    expect(journalsFor(world, 'c-ll')).toEqual([]);
    expect(contactOf(world, 'c-ll')?.[target]).toEqual(target === 'status' ? 'active' : undefined);
    expect(suggestionEmits(world)).toBe(emitsBefore);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown contact', { type: 'unknown', status: 'needs_review' }],
    ['a caseworker', { type: 'partner', role: 'Caseworker', status: 'active' }],
    ['a team member', { type: 'team_member', status: 'active' }],
  ])('refuses a voucherSize accept on %s too', async (_label, kind) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-kind', ...kind });
    await seedSuggestion(world, {
      ownerContactId: 'c-kind', target: 'voucherSize', suggestedValue: '3', conversationId: 'conv-k', runId: 'run-k',
    });

    const res = await accept(app, 'c-kind', 'voucherSize');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    expect(await world.extractionRepo.getSuggestion('c-kind', 'voucherSize')).toBeDefined();
    expect(contactOf(world, 'c-kind')?.['voucherSize']).toBeUndefined();
  });

  it('never refuses a dismiss - staff clear the kept chip this way (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-ll', runId: 'run-pets',
    });

    await dismiss(app, 'c-ll', 'pets').expect(200);

    expect(await world.extractionRepo.getSuggestion('c-ll', 'pets')).toBeUndefined();
  });

  it('leaves a neutral target alone: a lastName accept on a landlord still commits (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target: 'lastName', suggestedValue: 'Okafor', conversationId: 'conv-ll', runId: 'run-last',
    });

    await accept(app, 'c-ll', 'lastName').expect(200);

    expect(contactOf(world, 'c-ll')?.['lastName']).toBe('Okafor');
  });
});
