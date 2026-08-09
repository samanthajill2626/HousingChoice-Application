import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_COOKIE, TEST_SESSION_COOKIE } from './helpers/authSession.js';
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

const suggestionIdentities = new Map<string, { revision?: string; createdAt: string; runId?: string }>();

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
  const stored = await world.extractionRepo.getSuggestion(suggestion.ownerContactId, suggestion.target);
  if (stored !== undefined) {
    suggestionIdentities.set(`${stored.ownerContactId}\u0000${stored.target}`, {
      revision: stored.revision,
      createdAt: stored.createdAt,
      runId: stored.runId,
    });
  }
}

function makeWorld(setVerdictImpl?: SetVerdict) {
  const { app, world } = makeWebhookHarness();
  const setVerdict = vi.fn<SetVerdict>(setVerdictImpl ?? (async () => true));
  world.aiRuns.setVerdict = setVerdict;
  return { app, world, setVerdict };
}

function accept(
  app: import('express').Express,
  contactId: string,
  target: string,
  identity = suggestionIdentities.get(`${contactId}\u0000${target}`),
  cookie = TEST_SESSION_COOKIE,
) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/accept`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', cookie)
    .send(identity);
}

function dismiss(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/dismiss`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(suggestionIdentities.get(`${contactId}\u0000${target}`));
}

function patch(app: import('express').Express, contactId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function expireActiveResolution(
  world: ReturnType<typeof makeWebhookHarness>['world'],
  contactId: string,
  target: string,
): void {
  for (const [key, item] of world.suggestionResolutions) {
    if (item.state === 'active' && item.contactId === contactId && item.target === target) {
      world.suggestionResolutions.set(key, { ...item, leaseExpiresAt: '2000-01-01T00:00:00.000Z' });
      return;
    }
  }
  throw new Error('expected active resolution');
}

describe('verdict write-back - surface 1: suggestions.ts accept and dismiss', () => {
  it('rejects a mismatched immutable identity before claiming or mutating', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
      createdAt: '2026-07-01T11:00:00.000Z',
    });

    const before = await world.extractionRepo.getSuggestion('c1', 'pets');
    if (before === undefined) throw new Error('expected seeded suggestion');
    await accept(app, 'c1', 'pets', {
        revision: 'wrong-revision',
        createdAt: before.createdAt,
        runId: before.runId,
      })
      .expect(409);

    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBeUndefined();
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toEqual(before);
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('rejects a missing immutable identity before claiming or mutating', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });

    await request(app)
      .post('/api/contacts/c1/suggestions/pets/accept')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({})
      .expect(400);

    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeDefined();
    expect(world.suggestionResolutions.size).toBe(0);
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('runs status, phone, address, scalar, and dismiss through the shared phase executor', async () => {
    const { app, world } = makeWorld();
    seedTenant(world);
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');
    const contactEffect = vi.spyOn(world.suggestionResolutionRepo, 'commitContactEffect');
    const phoneEffect = vi.spyOn(world.suggestionResolutionRepo, 'commitPhoneEffect');
    const dismissalEffect = vi.spyOn(world.suggestionResolutionRepo, 'commitDismissalEffect');

    const accepts = [
      { target: 'status', suggestedValue: 'searching' },
      { target: 'phone', suggestedValue: '+15550102020' },
      { target: 'address', suggestedValue: '1 Main St', suggestedAddress: { line1: '1 Main St' } },
      { target: 'pets', suggestedValue: 'two cats' },
    ];
    for (const item of accepts) {
      await seedSuggestion(world, {
        ownerContactId: 'c1', conversationId: 'conv-1', runId: `run-${item.target}`, ...item,
      });
      await accept(app, 'c1', item.target).expect(200);
    }
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'tenure', suggestedValue: 'three years', conversationId: 'conv-1', runId: 'run-dismiss',
    });
    await dismiss(app, 'c1', 'tenure').expect(200);

    expect(claim).toHaveBeenCalledTimes(5);
    expect(contactEffect).toHaveBeenCalledTimes(3);
    expect(phoneEffect).toHaveBeenCalledTimes(1);
    expect(dismissalEffect).toHaveBeenCalledTimes(1);
    for (const item of world.suggestionResolutions.values()) expect(item.state).toBe('completed');
  });

  it('blocks a live concurrent resolver so only the claimed request wins', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    let releaseClaim!: () => void;
    const held = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let claimReached!: () => void;
    const reached = new Promise<void>((resolve) => { claimReached = resolve; });
    const firstApp = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: async (boundary) => {
          if (boundary === 'claimed') {
            claimReached();
            await held;
          }
        },
      },
    }).app;

    const first = accept(firstApp, 'c1', 'pets').then((response) => response);
    await reached;
    const second = await accept(firstApp, 'c1', 'pets');
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'suggestion_resolution_in_progress', retryable: true });
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBeUndefined();
    const pending = await request(firstApp)
      .get('/api/contacts/c1/suggestions')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(pending.body).toEqual({ suggestions: [] });
    releaseClaim();
    expect((await first).status).toBe(200);

    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('two cats');
    expect(setVerdict).toHaveBeenCalledTimes(1);
  });

  for (const boundary of ['claimed', 'domain_applied', 'activity_applied', 'verdict_attempted'] as const) {
    it(`recovers after process termination at the ${boundary} boundary without duplicate effects`, async () => {
      const { world, setVerdict } = makeWorld();
      seedTenant(world);
      await seedSuggestion(world, {
        ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
      });
      const update = vi.spyOn(world.contactsRepo, 'update');
      const firstApp = makeWebhookHarness({
        world,
        suggestionResolutionHooks: {
          afterBoundary: (seen) => {
            if (seen === boundary) throw new Error(`simulated termination after ${boundary}`);
          },
        },
      }).app;

      await accept(firstApp, 'c1', 'status').expect(500);
      const active = [...world.suggestionResolutions.values()][0];
      expect(active?.state).toBe('active');
      expect(await world.extractionRepo.getSuggestion('c1', 'status')).toBeUndefined();
      if (boundary === 'claimed') {
        expect(world.contacts.find((contact) => contact.contactId === 'c1')?.status).toBe('onboarding');
      }

      expireActiveResolution(world, 'c1', 'status');
      const recoveryApp = makeWebhookHarness({ world }).app;
      await accept(recoveryApp, 'c1', 'status').expect(200);

      expect(update).toHaveBeenCalledTimes(1);
      expect(world.auditEvents.filter((event) => event.event_type === 'tenant_status_changed')).toHaveLength(1);
      expect(world.activityEvents.filter((event) => event.type === 'contact_status_changed')).toHaveLength(1);
      expect(setVerdict).toHaveBeenCalledTimes(1);
      expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
    });
  }

  it('helps an expired original actor and action before claiming the reloaded revision', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'old value', conversationId: 'conv-a', runId: 'run-a',
    });
    const firstApp = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;
    await accept(firstApp, 'c1', 'pets').expect(500);
    expireActiveResolution(world, 'c1', 'pets');

    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'new value', conversationId: 'conv-b', runId: 'run-b',
    });
    const replacement = await world.extractionRepo.getSuggestion('c1', 'pets');
    if (replacement === undefined) throw new Error('expected replacement suggestion');
    const sawReplacementDuringHelp: boolean[] = [];
    const secondApp = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: async (boundary, journal) => {
          if (boundary === 'domain_applied' && journal.snapshot.runId === 'run-a') {
            sawReplacementDuringHelp.push((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId === 'run-b');
          }
        },
      },
    }).app;
    await accept(secondApp, 'c1', 'pets', {
      revision: replacement.revision,
      createdAt: replacement.createdAt,
      runId: replacement.runId,
    }, TEST_ADMIN_COOKIE).expect(200);

    expect(sawReplacementDuringHelp).toEqual([true]);
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('new value');
    const accepted = world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted');
    expect(accepted.map((event) => event.payload?.['actor'])).toEqual([
      ACTOR,
      'usr_testadmin000000000000000',
    ]);
    expect(setVerdict.mock.calls.map((call) => call[0])).toEqual(['run-a', 'run-b']);
  });

  it('recovers a phone claim without losing concurrent phones and releases a new ownership conflict', async () => {
    const first = makeWorld();
    seedTenant(first.world);
    await seedSuggestion(first.world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550102020', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world: first.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    await first.world.contactsRepo.addPhone('c1', { phone: '+15550103030', label: 'Concurrent' });
    expireActiveResolution(first.world, 'c1', 'phone');
    await accept(makeWebhookHarness({ world: first.world }).app, 'c1', 'phone').expect(200);
    expect((await first.world.contactsRepo.getById('c1'))?.phones?.map((phone) => phone.phone)).toEqual(
      expect.arrayContaining(['+15550100001', '+15550102020', '+15550103030']),
    );
    const pointerIndex = first.world.contacts.findIndex(
      (contact) => contact.phone_ref === true && contact.phone === '+15550102020',
    );
    if (pointerIndex < 0) throw new Error('expected secondary phone pointer');
    first.world.contacts.splice(pointerIndex, 1);
    expect(await first.world.contactsRepo.findByPhone('+15550102020')).toBeUndefined();
    await seedSuggestion(first.world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550102020', conversationId: 'conv-repair', runId: 'run-repair',
    });
    const repairCrash = makeWebhookHarness({
      world: first.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination before pointer repair');
        },
      },
    }).app;
    await accept(repairCrash, 'c1', 'phone').expect(500);
    expireActiveResolution(first.world, 'c1', 'phone');
    await accept(makeWebhookHarness({ world: first.world }).app, 'c1', 'phone').expect(200);
    expect((await first.world.contactsRepo.findByPhone('+15550102020'))?.contactId).toBe('c1');

    const conflict = makeWorld();
    seedTenant(conflict.world);
    await seedSuggestion(conflict.world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const conflictCrash = makeWebhookHarness({
      world: conflict.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(conflictCrash, 'c1', 'phone').expect(500);
    conflict.world.contacts.push({
      contactId: 'c-other', type: 'tenant', phone: '+15550104040', created_at: '2026-01-01T00:00:00.000Z',
    });
    expireActiveResolution(conflict.world, 'c1', 'phone');
    await accept(makeWebhookHarness({ world: conflict.world }).app, 'c1', 'phone').expect(409);
    expect(await conflict.world.extractionRepo.getSuggestion('c1', 'phone')).toBeDefined();
    expect(conflict.world.suggestionResolutions.size).toBe(0);
  });

  it('dismiss recovery suppresses only the same normalized replacement value', async () => {
    for (const [replacementValue, preserved] of [
      [' TWO   CATS ', false],
      ['one dog', true],
    ] as const) {
      const { world } = makeWorld();
      seedTenant(world);
      await seedSuggestion(world, {
        ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-a', runId: 'run-a',
      });
      const crashing = makeWebhookHarness({
        world,
        suggestionResolutionHooks: {
          afterBoundary: (boundary) => {
            if (boundary === 'claimed') throw new Error('simulated termination after dismiss claim');
          },
        },
      }).app;
      await dismiss(crashing, 'c1', 'pets').expect(500);
      expireActiveResolution(world, 'c1', 'pets');
      await seedSuggestion(world, {
        ownerContactId: 'c1', target: 'pets', suggestedValue: replacementValue, conversationId: 'conv-b', runId: 'run-b',
      });
      const replacement = await world.extractionRepo.getSuggestion('c1', 'pets');
      if (replacement === undefined) throw new Error('expected replacement');
      const observations: boolean[] = [];
      const helping = makeWebhookHarness({
        world,
        suggestionResolutionHooks: {
          afterBoundary: async (boundary, journal) => {
            if (boundary === 'domain_applied' && journal.snapshot.runId === 'run-a') {
              observations.push((await world.extractionRepo.getSuggestion('c1', 'pets')) !== undefined);
            }
          },
        },
      }).app;
      const response = await dismiss(helping, 'c1', 'pets');
      expect(observations).toEqual([preserved]);
      expect(response.status).toBe(preserved ? 200 : 404);
    }
  });

  it('resumes a committed dismissal without duplicating its audit or tombstone effect', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'domain_applied') throw new Error('simulated termination after dismissal');
        },
      },
    }).app;
    await dismiss(crashing, 'c1', 'pets').expect(500);
    expireActiveResolution(world, 'c1', 'pets');
    await dismiss(makeWebhookHarness({ world }).app, 'c1', 'pets').expect(200);

    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_dismissed')).toHaveLength(1);
    expect(setVerdict).toHaveBeenCalledTimes(1);
    expect(await world.extractionRepo.hasDismissal('c1', 'pets', 'two cats')).toBe(true);
  });

  it('makes a completed same-action retry idempotent and fences the opposite action', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    const update = vi.spyOn(world.contactsRepo, 'update');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const identity = suggestionIdentities.get('c1\u0000pets');
    if (identity === undefined) throw new Error('expected identity');
    await accept(app, 'c1', 'pets', identity).expect(200);
    await accept(app, 'c1', 'pets', identity).expect(200);
    await request(app)
      .post('/api/contacts/c1/suggestions/pets/dismiss')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(identity)
      .expect(409);

    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'one dog', conversationId: 'conv-2', runId: 'run-2',
    });
    await accept(app, 'c1', 'pets', identity).expect(200);
    expect((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId).toBe('run-2');

    expect(update).toHaveBeenCalledTimes(1);
    expect(setVerdict).toHaveBeenCalledTimes(1);
    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted')).toHaveLength(1);
  });

  it('attempts the journaled verdict only after durable effects and ignores logging failure', async () => {
    const { app, world, setVerdict } = makeWorld(async () => {
      expect(world.contacts.find((contact) => contact.contactId === 'c1')?.status).toBe('searching');
      expect(world.auditEvents.some((event) => event.event_type === 'tenant_status_changed')).toBe(true);
      expect(world.activityEvents.some((event) => event.type === 'contact_status_changed')).toBe(true);
      throw new Error('ai run store unavailable');
    });
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'winning-run',
    });

    await accept(app, 'c1', 'status').expect(200);
    expect(setVerdict).toHaveBeenCalledWith('winning-run', 'status', 'accepted', expect.anything());
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
  });

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
      world.extractionRepo.deleteSuggestionIfCurrent = async (contactId, target, createdAt, runId) => {
        await world.extractionRepo.putSuggestion({ ownerContactId: contactId, target, suggestedValue: 'new value', conversationId: 'conv-2', runId: 'run-new', createdAt });
        return originalDelete(contactId, target, createdAt, runId);
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

  it('stamps accepted when the retained suggestion value matches the applied human value', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });

    await patch(app, 'c1', { pets: 'two cats' }).expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-1', 'pets', 'accepted', expect.anything());
  });

  it('snapshots before update so a replacement created inside contacts.update remains pending and unstamped', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'old value', conversationId: 'conv-old', runId: 'run-old',
    });
    const originalUpdate = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (contactId, body) => {
      await world.extractionRepo.putSuggestion({
        ownerContactId: contactId,
        target: 'pets',
        suggestedValue: 'new value',
        conversationId: 'conv-new',
        runId: 'run-new',
      });
      return originalUpdate(contactId, body);
    };

    await patch(app, 'c1', { pets: 'human edit' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toMatchObject({
      suggestedValue: 'new value', runId: 'run-new',
    });
    expect(setVerdict).not.toHaveBeenCalledWith('run-new', 'pets', expect.anything(), expect.anything());
    expect(setVerdict).not.toHaveBeenCalledWith('run-old', 'pets', expect.anything(), expect.anything());
  });

  it('does not delete a suggestion first created inside contacts.update after an empty snapshot', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    const originalUpdate = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (contactId, body) => {
      await world.extractionRepo.putSuggestion({
        ownerContactId: contactId,
        target: 'pets',
        suggestedValue: 'new value',
        conversationId: 'conv-new',
        runId: 'run-new',
      });
      return originalUpdate(contactId, body);
    };

    await patch(app, 'c1', { pets: 'human edit' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toMatchObject({ runId: 'run-new' });
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('reads before update, then exact-deletes and stamps the retained run on ordinary PATCH', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const pending = await world.extractionRepo.getSuggestion('c1', 'pets');
    if (pending === undefined) throw new Error('expected pending suggestion');
    const getSuggestion = vi.spyOn(world.extractionRepo, 'getSuggestion');
    const update = vi.spyOn(world.contactsRepo, 'update');
    const conditionalDelete = vi.spyOn(world.extractionRepo, 'deleteSuggestionIfCurrent');

    await patch(app, 'c1', { pets: 'a dog' }).expect(200);

    expect(getSuggestion).toHaveBeenCalledTimes(1);
    expect(getSuggestion.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(conditionalDelete.mock.invocationCallOrder[0]!);
    expect(conditionalDelete).toHaveBeenCalledWith(
      'c1', 'pets', pending.createdAt, pending.runId, pending.revision,
    );
    expect(setVerdict).toHaveBeenCalledWith(
      'run-1', 'pets', 'superseded_by_human_edit', expect.anything(),
    );
  });

  it('snapshots before a failed contacts.update and leaves the original suggestion and verdict untouched', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const getSuggestion = vi.spyOn(world.extractionRepo, 'getSuggestion');
    world.contactsRepo.update = vi.fn(async () => { throw new Error('contact update failed'); });

    await patch(app, 'c1', { pets: 'a dog' }).expect(500);

    expect(getSuggestion).toHaveBeenCalledWith('c1', 'pets');
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toMatchObject({ runId: 'run-1' });
    expect(setVerdict).not.toHaveBeenCalled();
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
    world.extractionRepo.deleteSuggestionIfCurrent = async (contactId, target, createdAt, runId) => {
      await world.extractionRepo.putSuggestion({ ownerContactId: contactId, target, suggestedValue: 'new value', conversationId: 'conv-2', runId: 'run-new', createdAt });
      return originalDelete(contactId, target, createdAt, runId);
    };

    await patch(app, 'c1', { pets: 'human edit' }).expect(200);
    expect((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId).toBe('run-new');
    expect(setVerdict).not.toHaveBeenCalled();
  });
});
