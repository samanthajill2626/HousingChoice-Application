import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import type { SuggestionItem } from '../src/repos/extractionRepo.js';
import type { DecisionTarget, Verdict } from '../src/services/extraction/runTypes.js';

const ACTOR = 'usr_testva00000000000000000';

type SetVerdict = (
  runId: string,
  target: DecisionTarget,
  verdict: Verdict,
  opts?: { at?: string; by?: string },
) => Promise<boolean>;

function seedTenant(world: ReturnType<typeof makeWebhookHarness>['world'], over: Record<string, unknown> = {}): string {
  const contactId = (over['contactId'] as string) ?? 'c1';
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
  world: ReturnType<typeof makeWebhookHarness>['world'],
  suggestion: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
): Promise<void> {
  await world.extractionRepo.putSuggestion(suggestion);
}

function makeWorld(setVerdictImpl?: SetVerdict) {
  const { app, world } = makeWebhookHarness();
  const setVerdict = vi.fn<SetVerdict>(setVerdictImpl ?? (async () => true));
  world.aiRuns.setVerdict = setVerdict;
  return { app, world, setVerdict };
}

function accept(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/accept`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

function dismiss(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/dismiss`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

function patch(app: import('express').Express, contactId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

describe('verdict write-back - surface 1: suggestions.ts accept and dismiss', () => {
  it('stamps accepted on the scalar accept branch', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });

    await accept(app, 'c1', 'pets').expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-1', 'pets', 'accepted', expect.objectContaining({ by: ACTOR }));
  });

  it('stamps accepted on the status accept branch', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
    });

    await accept(app, 'c1', 'status').expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-status', 'status', 'accepted', expect.anything());
  });

  it('stamps accepted on the phone accept branch', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550102020', conversationId: 'conv-1', runId: 'run-phone',
    });

    await accept(app, 'c1', 'phone').expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-phone', 'phone', 'accepted', expect.anything());
  });

  it('stamps accepted on the address accept branch', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'address', suggestedValue: '1 Main St', suggestedAddress: { line1: '1 Main St' },
      conversationId: 'conv-1', runId: 'run-address',
    });

    await accept(app, 'c1', 'address').expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-address', 'address', 'accepted', expect.anything());
  });

  it('stamps dismissed, including for type which accept refuses', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-1',
    });

    await dismiss(app, 'c1', 'type').expect(200);
    expect(setVerdict).toHaveBeenCalledWith('run-1', 'type', 'dismissed', expect.anything());

    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-2',
    });
    await accept(app, 'c1', 'type').expect(400);
    expect(setVerdict).not.toHaveBeenCalledWith('run-2', 'type', 'accepted', expect.anything());
  });

  it('skips rows written before the run log and accepts expired runs or stamp failures', async () => {
    const legacy = makeWorld();
    seedTenant(legacy.world);
    await seedSuggestion(legacy.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1',
    });
    await accept(legacy.app, 'c1', 'pets').expect(200);
    expect(legacy.setVerdict).not.toHaveBeenCalled();

    const expired = makeWorld(async () => false);
    seedTenant(expired.world);
    await seedSuggestion(expired.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'gone',
    });
    await accept(expired.app, 'c1', 'pets').expect(200);

    const failed = makeWorld(async () => { throw new Error('ai_runs down'); });
    seedTenant(failed.world);
    await seedSuggestion(failed.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    await accept(failed.app, 'c1', 'pets').expect(200);
    expect(failed.setVerdict).toHaveBeenCalled();
  });

  it('retries a resolution while the run envelope is still being written, then resolves pending', async () => {
    let envelopeWritten = false;
    let verdict: Verdict = 'pending';
    const { app, world, setVerdict } = makeWorld(async (_runId, _target, next) => {
      if (!envelopeWritten) return false;
      verdict = next;
      return true;
    });
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const resolving = accept(app, 'c1', 'pets').expect(200);
    setTimeout(() => { envelopeWritten = true; }, 5);
    await resolving;
    expect(setVerdict).toHaveBeenCalledTimes(2);
    expect(verdict).toBe('accepted');
  });

  it('does not let a stale accept or dismiss claim a replacement suggestion', async () => {
    for (const action of [
      (app: import('express').Express) => accept(app, 'c1', 'pets'),
      (app: import('express').Express) => dismiss(app, 'c1', 'pets'),
    ]) {
      const { app, world, setVerdict } = makeWorld();
      seedTenant(world);
      await seedSuggestion(world, {
        ownerContactId: 'c1', target: 'pets', suggestedValue: 'old value', conversationId: 'conv-1', runId: 'run-old', createdAt: '2026-08-08T00:00:00.000Z',
      });
      const originalDelete = world.extractionRepo.deleteSuggestionIfCurrent;
      world.extractionRepo.deleteSuggestionIfCurrent = async (contactId, target, createdAt) => {
        await world.extractionRepo.putSuggestion({ ownerContactId: contactId, target, suggestedValue: 'new value', conversationId: 'conv-2', runId: 'run-new', createdAt: '2026-08-08T00:00:01.000Z' });
        return originalDelete(contactId, target, createdAt);
      };

      await action(app).expect(409);
      expect((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId).toBe('run-new');
      expect(setVerdict).not.toHaveBeenCalled();
    }
  });
});

describe('verdict write-back - surface 2: the contacts PATCH', () => {
  it('stamps superseded_by_human_edit only for changed fields with pending suggestions', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'tenure', suggestedValue: '3 years', conversationId: 'conv-1', runId: 'run-1',
    });

    await patch(app, 'c1', { pets: 'a dog' }).expect(200);

    expect(setVerdict).toHaveBeenCalledWith(
      'run-1', 'pets', 'superseded_by_human_edit', expect.objectContaining({ by: ACTOR }),
    );
    expect(setVerdict).not.toHaveBeenCalledWith('run-1', 'tenure', expect.anything(), expect.anything());
  });

  it('stamps accepted for a type PATCH that matches the suggestion', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-1',
    });

    await patch(app, 'c1', { type: 'tenant' }).expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-1', 'type', 'accepted', expect.anything());
  });

  it('stamps superseded_by_human_edit for a type PATCH that differs', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-1',
    });

    await patch(app, 'c1', { type: 'landlord' }).expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-1', 'type', 'superseded_by_human_edit', expect.anything());
  });

  it('confines value equality to type, so matching pets still supersedes', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });

    await patch(app, 'c1', { pets: 'two cats' }).expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-1', 'pets', 'superseded_by_human_edit', expect.anything());
  });

  it('never lets a suggestion read or verdict failure skip deletion or fail PATCH', async () => {
    const readFailure = makeWorld();
    seedTenant(readFailure.world);
    await seedSuggestion(readFailure.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const getSuggestion = vi.spyOn(readFailure.world.extractionRepo, 'getSuggestion').mockRejectedValueOnce(new Error('read boom'));
    await patch(readFailure.app, 'c1', { pets: 'a dog' }).expect(200);
    expect(getSuggestion).toHaveBeenCalledWith('c1', 'pets');
    // Without an identity-bearing read, the PATCH cannot safely delete: another
    // extraction could have replaced the row between the failed read and delete.
    expect(await readFailure.world.extractionRepo.getSuggestion('c1', 'pets')).toBeDefined();

    const verdictFailure = makeWorld(async () => { throw new Error('ai_runs down'); });
    seedTenant(verdictFailure.world);
    await seedSuggestion(verdictFailure.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    await patch(verdictFailure.app, 'c1', { pets: 'a dog' }).expect(200);
  });

  it('keeps a replacement suggestion and does not stamp it when PATCH races after its contact update', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'old value', conversationId: 'conv-1', runId: 'run-old', createdAt: '2026-08-08T00:00:00.000Z',
    });
    const originalDelete = world.extractionRepo.deleteSuggestionIfCurrent;
    world.extractionRepo.deleteSuggestionIfCurrent = async (contactId, target, createdAt) => {
      await world.extractionRepo.putSuggestion({ ownerContactId: contactId, target, suggestedValue: 'new value', conversationId: 'conv-2', runId: 'run-new', createdAt: '2026-08-08T00:00:01.000Z' });
      return originalDelete(contactId, target, createdAt);
    };

    await patch(app, 'c1', { pets: 'human edit' }).expect(200);
    expect((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId).toBe('run-new');
    expect(setVerdict).not.toHaveBeenCalled();
  });
});
