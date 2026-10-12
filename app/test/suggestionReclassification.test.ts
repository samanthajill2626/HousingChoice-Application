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
