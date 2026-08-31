import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_COOKIE, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { SuggestionDismissedError, type SuggestionItem } from '../src/repos/extractionRepo.js';
import type { AiRunRecordInput } from '../src/repos/aiRunsRepo.js';
import { makeCompletedResolution } from '../src/repos/suggestionResolutionRepo.js';
import type { DecisionTarget, Verdict } from '../src/services/extraction/runTypes.js';

const ACTOR = 'usr_testva00000000000000000';

type SetVerdict = (
  runId: string,
  target: DecisionTarget,
  verdict: Verdict,
  opts?: { at?: string; by?: string; expectedVerdict?: Verdict; freshSuggestionCreatedAt?: string },
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

/**
 * A second contact that owns `phone` the way the PRODUCT can detect it.
 *
 * commitPhoneEffect arbitrates ownership on the `phoneref#` pointer row ALONE
 * (suggestionResolutionRepo.ts:797-803), and a contact's PRIMARY number
 * deliberately has no pointer (repo:845-849). These tests used to push a bare
 * contact carrying the number as its primary scalar - a state the real
 * conflict check cannot see - and passed only because the fake asked
 * findByPhone instead. Owning the number as a SECONDARY creates the pointer the
 * real transaction actually reads.
 *
 * The gap that fixture was hiding is FILED, not fixed here
 * (TODO(suggestion-phone-ownership-pointer-only-arbitration)): a number held as
 * another contact's primary is still invisible to commitPhoneEffect. The
 * expired-journal HELP path now runs the same advisory findByPhone pre-check the
 * ordinary accept does, which closes the common case; the eventually consistent
 * GSI read means the race itself remains.
 */
async function seedPhoneOwner(
  world: ReturnType<typeof makeWebhookHarness>['world'],
  phone: string,
): Promise<void> {
  world.contacts.push({
    contactId: 'c-other',
    type: 'tenant',
    phone: '+15550109090',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await world.contactsRepo.addPhone('c-other', { phone, label: 'Other' });
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

/**
 * Model the extraction job's post-record displaced-run stamp. A type
 * replacement first performs the same repository CAS as production, then its
 * producing job terminally marks the exact displaced pending decision.
 */
async function replaceTypeSuggestionFromExtraction(
  world: ReturnType<typeof makeWebhookHarness>['world'],
  suggestion: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
): Promise<void> {
  const { displaced } = await world.extractionRepo.putSuggestion(suggestion);
  if (displaced?.runId === undefined) return;
  await world.aiRuns.setVerdict(displaced.runId, 'type', 'superseded', {
    at: new Date().toISOString(),
    expectedVerdict: 'pending',
    freshSuggestionCreatedAt: displaced.createdAt,
  });
}

function pendingTypeRun(
  runId: string,
  createdAt: string,
  proposedValue: 'tenant' | 'landlord' | 'partner',
): AiRunRecordInput {
  return {
    runId,
    startedAt: createdAt,
    finishedAt: createdAt,
    durationMs: 0,
    conversationId: `conv-${runId}`,
    contactId: 'c1',
    trigger: 'sms',
    outcome: 'applied',
    driver: 'fake',
    decisions: {
      type: {
        proposedOp: 'suggest',
        proposedValue,
        outcome: 'suggested',
        verdict: 'pending',
      },
    },
    notedLines: 0,
  };
}

function makeFaithfulRouteWorld() {
  const { app, world } = makeWebhookHarness();
  const setVerdict = vi.spyOn(world.aiRuns, 'setVerdict');
  return { app, world, setVerdict };
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

function list(app: import('express').Express, contactId: string) {
  return request(app)
    .get(`/api/contacts/${contactId}/suggestions`)
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

  // F9a: the identity fence stays for MODERN callers - a body that is present
  // but malformed is still a 400. (An ABSENT/EMPTY body is the legacy contract;
  // see the body-less tests below.)
  it('rejects a malformed immutable identity before claiming or mutating', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });

    const res = await request(app)
      .post('/api/contacts/c1/suggestions/pets/accept')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ createdAt: 42 })
      .expect(400);

    expect(res.body.error).toBe('invalid_suggestion_identity');
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeDefined();
    expect(world.suggestionResolutions.size).toBe(0);
    expect(setVerdict).not.toHaveBeenCalled();
  });

  // F9a: the documented pre-identity contract was "(no body)". Express hands a
  // body-less POST to the route as {}, which the identity fence 400'd - the
  // route rejected a request shape it published. Body-less now falls back to
  // the CURRENT pending row.
  it('resolves the current pending row for a legacy body-less accept', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-legacy',
    });

    const res = await request(app)
      .post('/api/contacts/c1/suggestions/pets/accept')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);

    expect(res.body.contact.pets).toBe('two cats');
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-legacy', 'pets', 'accepted', expect.objectContaining({ by: ACTOR }));
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
  });

  it('404s a legacy body-less accept when nothing is pending for that target', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);

    const res = await request(app)
      .post('/api/contacts/c1/suggestions/pets/accept')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(404);

    expect(res.body.error).toBe('no_pending_suggestion');
    expect(world.suggestionResolutions.size).toBe(0);
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('dismisses the current pending row for a legacy body-less dismiss', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'tenure', suggestedValue: 'three years', conversationId: 'conv-1', runId: 'run-legacy-dismiss',
    });

    await request(app)
      .post('/api/contacts/c1/suggestions/tenure/dismiss')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'tenure')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith(
      'run-legacy-dismiss', 'tenure', 'dismissed', expect.objectContaining({ by: ACTOR }),
    );
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

  // F1: a crash between claim and commit deletes the sugg# row, so the card the
  // UI would resume from is gone. Recovery must therefore be reachable from an
  // ORDINARY read of the contact's suggestions, not only from a second accept.
  it('completes and scrubs an abandoned claimed journal on an ordinary suggestions read', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const update = vi.spyOn(world.contactsRepo, 'update');
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'pets').expect(500);
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBeUndefined();
    expireActiveResolution(world, 'c1', 'pets');
    const emittedBefore = world.emitted.filter((event) => event.event === 'suggestion.updated').length;

    const readApp = makeWebhookHarness({ world }).app;
    const res = await list(readApp, 'c1').expect(200);

    expect(res.body).toEqual({ suggestions: [] });
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('two cats');
    expect(update).toHaveBeenCalledTimes(1);
    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted')).toHaveLength(1);
    expect(setVerdict).toHaveBeenCalledTimes(1);
    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal?.state).toBe('completed');
    expect(JSON.stringify(journal)).not.toContain('two cats');
    expect(world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(emittedBefore + 1);

    // Terminal after one pass: the refetch the SSE triggers finds nothing active,
    // so it neither replays an effect nor emits again (no event loop).
    await list(readApp, 'c1').expect(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(emittedBefore + 1);
  });

  it('recovers an abandoned journal crashed after its domain effect on a read, without duplicating effects', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
    });
    const update = vi.spyOn(world.contactsRepo, 'update');
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'domain_applied') throw new Error('simulated termination after domain effect');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'status').expect(500);
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.status).toBe('searching');
    expireActiveResolution(world, 'c1', 'status');

    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    expect(update).toHaveBeenCalledTimes(1);
    expect(world.auditEvents.filter((event) => event.event_type === 'tenant_status_changed')).toHaveLength(1);
    expect(world.activityEvents.filter((event) => event.type === 'contact_status_changed')).toHaveLength(1);
    expect(setVerdict).toHaveBeenCalledTimes(1);
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
    expect(world.emitted.some((event) => event.event === 'suggestion.updated')).toBe(true);
  });

  // Recovery is a passenger on the read the dashboard cannot live without, so a
  // failed enumeration must degrade to "serve the list" rather than 500.
  it('never fails a suggestions read when journal enumeration throws', async () => {
    const { world } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'pets').expect(500);
    expireActiveResolution(world, 'c1', 'pets');
    world.suggestionResolutionRepo.listJournals = async () => {
      throw new Error('journal enumeration unavailable');
    };

    const res = await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    expect(res.body).toEqual({ suggestions: [] });
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('active');
  });

  it('keeps recovering a contact other journals when one journal help throws', async () => {
    const { world } = makeWorld();
    seedTenant(world);
    const crashing = (): import('express').Express => makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    await accept(crashing(), 'c1', 'pets').expect(500);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
    });
    await accept(crashing(), 'c1', 'status').expect(500);
    expireActiveResolution(world, 'c1', 'pets');
    expireActiveResolution(world, 'c1', 'status');
    const takeover = world.suggestionResolutionRepo.takeover.bind(world.suggestionResolutionRepo);
    world.suggestionResolutionRepo.takeover = async (input) => {
      if (input.target === 'pets') throw new Error('journal takeover unavailable');
      return takeover(input);
    };

    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    const contact = world.contacts.find((entry) => entry.contactId === 'c1');
    expect(contact?.status).toBe('searching');
    expect(contact?.pets).toBeUndefined();
    expect([...world.suggestionResolutions.values()].map((item) => [item.target, item.state])).toEqual([
      ['pets', 'active'],
      ['status', 'completed'],
    ]);
  });

  // R5 (docs/issues/ai-run-log-recovery-hook-unbounded). Recovery rides the read
  // the contact page makes on every open, and each journal costs its own
  // takeover plus a bounded phase ladder, so an unbounded pass makes a contact
  // carrying several abandoned journals pay for all of them before any
  // suggestion renders. Bounded WORK, not wall clock: the clock is injectable
  // and pinned by this suite, so a deadline would be untestable or flaky.
  it('caps how many abandoned journals one read recovers and finishes the rest on the next', async () => {
    const { world } = makeWorld();
    seedTenant(world);
    const crashing = (): import('express').Express => makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;
    const targets = [
      ['pets', 'two cats'],
      ['tenure', '2 years'],
      ['housingAuthority', 'Metro HA'],
    ] as const;
    for (const [target, suggestedValue] of targets) {
      await seedSuggestion(world, {
        ownerContactId: 'c1', target, suggestedValue, conversationId: 'conv-1', runId: `run-${target}`,
      });
      await accept(crashing(), 'c1', target).expect(500);
      expireActiveResolution(world, 'c1', target);
    }
    const states = (): string[] => [...world.suggestionResolutions.values()].map((item) => item.state);
    // Counts, never identities: listJournals is a Map in the fake but an
    // unordered BatchGet in the repo.
    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);
    expect(states().filter((state) => state === 'completed')).toHaveLength(2);
    expect(states().filter((state) => state === 'active')).toHaveLength(1);

    // The remainder is picked up by the next ordinary read - starvation-free,
    // because a completed journal stops being a candidate.
    for (const [target] of targets) {
      if ([...world.suggestionResolutions.values()].some(
        (item) => item.state === 'active' && item.target === target,
      )) {
        expireActiveResolution(world, 'c1', target);
      }
    }
    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);
    expect(states().filter((state) => state === 'completed')).toHaveLength(3);
  });

  it('lets a scalar PATCH supersede an expired claimed accept without replaying AI effects', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;

    await accept(crashing, 'c1', 'pets').expect(500);
    await patch(makeWebhookHarness({ world }).app, 'c1', { pets: 'one dog' }).expect(200);
    const auditCount = world.auditEvents.length;
    const activityCount = world.activityEvents.length;
    expireActiveResolution(world, 'c1', 'pets');

    await accept(makeWebhookHarness({ world }).app, 'c1', 'pets').expect(200);

    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('one dog');
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(world.auditEvents).toHaveLength(auditCount);
    expect(world.activityEvents).toHaveLength(activityCount);
    expect(setVerdict).toHaveBeenCalledWith(
      'run-pets', 'pets', 'superseded_by_human_edit', expect.objectContaining({ by: ACTOR }),
    );
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
    // H3: nothing committed to the contact, but the `sugg#` row was consumed and
    // the journal is terminal, so every open dashboard just went stale. The flag
    // that drives this emit means "durable state the dashboard has not been told
    // about", NOT "a domain effect landed" - a naive flip to false on the
    // superseded path would delete this SSE.
    expect(world.emitted.filter((event) => event.event === 'suggestion.updated').length)
      .toBeGreaterThan(0);
  });

  // H1 / item 1: the contact read that builds the plan and its attribute guard is
  // eventually consistent, so the requester's OWN claim can still lose the fence
  // to a human edit that lands before the commit. The journal must still run to
  // completion (verdict stamped, snapshot scrubbed) - but answering 200 would
  // tell the operator their accept applied when the fenced write was REFUSED and
  // the returned contact does not carry the value. Same class as F2.
  it('answers 409 when a human edit supersedes the requester own accept', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    // The edit lands after the plan was built from the eventually consistent
    // read and before the fenced contact write - the real race, not a helper.
    const racing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: async (boundary) => {
          if (boundary === 'claimed') await world.contactsRepo.update('c1', { pets: 'one dog' });
        },
      },
    }).app;

    const res = await accept(racing, 'c1', 'pets');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('suggestion_field_edited');
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('one dog');
    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted')).toHaveLength(0);
    expect(setVerdict).toHaveBeenCalledWith(
      'run-pets', 'pets', 'superseded_by_human_edit', expect.objectContaining({ by: ACTOR }),
    );
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
    // The chip was consumed by claim() and the journal scrubbed, so the refusal
    // still has to tell every open dashboard - exactly once.
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(1);
  });

  it('lets a status PATCH supersede an expired claimed accept without replaying status effects', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;

    await accept(crashing, 'c1', 'status').expect(500);
    await patch(makeWebhookHarness({ world }).app, 'c1', { status: 'on_hold' }).expect(200);
    const auditCount = world.auditEvents.length;
    const activityCount = world.activityEvents.length;
    expireActiveResolution(world, 'c1', 'status');

    await accept(makeWebhookHarness({ world }).app, 'c1', 'status').expect(200);

    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.status).toBe('on_hold');
    expect(world.auditEvents).toHaveLength(auditCount);
    expect(world.activityEvents).toHaveLength(activityCount);
    expect(setVerdict).toHaveBeenCalledWith(
      'run-status', 'status', 'superseded_by_human_edit', expect.objectContaining({ by: ACTOR }),
    );
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
  });

  it('treats cleared provenance as a human edit even when the apparent value is unchanged', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world, {
      pets: 'two cats',
      pets_source: { source: 'ai', at: '2026-08-01T00:00:00.000Z', conversationId: 'conv-old' },
    });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;

    await accept(crashing, 'c1', 'pets').expect(500);
    await patch(makeWebhookHarness({ world }).app, 'c1', { pets: 'two cats' }).expect(200);
    expireActiveResolution(world, 'c1', 'pets');
    await accept(makeWebhookHarness({ world }).app, 'c1', 'pets').expect(200);

    const contact = world.contacts.find((entry) => entry.contactId === 'c1');
    expect(contact?.pets).toBe('two cats');
    expect(contact?.pets_source).toBeUndefined();
    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted')).toEqual([]);
    expect(setVerdict).toHaveBeenCalledWith(
      'run-pets', 'pets', 'superseded_by_human_edit', expect.anything(),
    );
  });

  it('recovers a durable superseded phase after a second crash without replaying or duplicating effects', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const claimCrash = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app;
    await accept(claimCrash, 'c1', 'pets').expect(500);
    await patch(makeWebhookHarness({ world }).app, 'c1', { pets: 'one dog' }).expect(200);
    const auditCount = world.auditEvents.length;
    const activityCount = world.activityEvents.length;
    expireActiveResolution(world, 'c1', 'pets');
    const supersededCrash = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'domain_applied') throw new Error('simulated termination after superseded phase');
        },
      },
    }).app;

    await accept(supersededCrash, 'c1', 'pets').expect(500);
    expect([...world.suggestionResolutions.values()][0]).toMatchObject({
      state: 'active', phase: 'domain_applied', outcome: 'superseded_by_human_edit',
    });
    expireActiveResolution(world, 'c1', 'pets');
    await accept(makeWebhookHarness({ world }).app, 'c1', 'pets').expect(200);

    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('one dog');
    expect(world.auditEvents).toHaveLength(auditCount);
    expect(world.activityEvents).toHaveLength(activityCount);
    expect(setVerdict).toHaveBeenCalledTimes(1);
    expect(setVerdict).toHaveBeenCalledWith(
      'run-pets', 'pets', 'superseded_by_human_edit', expect.anything(),
    );
    expect([...world.suggestionResolutions.values()][0]?.state).toBe('completed');
  });

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
    await seedPhoneOwner(conflict.world, '+15550104040');
    expireActiveResolution(conflict.world, 'c1', 'phone');
    await accept(makeWebhookHarness({ world: conflict.world }).app, 'c1', 'phone').expect(409);
    expect(await conflict.world.extractionRepo.getSuggestion('c1', 'phone')).toBeDefined();
    expect(conflict.world.suggestionResolutions.size).toBe(0);
  });

  // F8: when the crashed action can no longer be restored (a REPLACEMENT
  // suggestion holds the pending slot), the old journal must end terminally.
  // Otherwise every attempt at the replacement re-helps the old journal, hits
  // the same ownership conflict, and the newer suggestion is deadlocked.
  it('resolves a replacement phone suggestion on the first attempt after an unsafe release', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    await seedPhoneOwner(world, '+15550104040');
    expireActiveResolution(world, 'c1', 'phone');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });

    await accept(makeWebhookHarness({ world }).app, 'c1', 'phone').expect(200);

    const contact = await world.contactsRepo.getById('c1');
    expect(contact?.phones?.map((phone) => phone.phone)).toEqual(
      expect.arrayContaining(['+15550105050']),
    );
    expect(contact?.phones?.some((phone) => phone.phone === '+15550104040')).toBe(false);
    expect(await world.extractionRepo.getSuggestion('c1', 'phone')).toBeUndefined();
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_phone_added')).toHaveLength(1);
    // adv P1-1 / conf P2-2: the OLD run must not be left `pending` - spec 7.3
    // reads that as "nobody has looked yet" for a decision a named operator
    // explicitly accepted. `superseded` is exactly what the extraction job
    // would have stamped had the replacement displaced the row normally; claim()
    // had already deleted the `sugg#` row, so nothing else can ever say it.
    expect(setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['run-a', 'superseded'],
      ['run-b', 'accepted'],
    ]);
    expect(setVerdict.mock.calls[0]?.[3]).toMatchObject({ expectedVerdict: 'pending' });
    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal?.state).toBe('completed');
  });

  it('terminally finalizes an unsafe-released journal on a read without touching the replacement row', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    const abandoned = [...world.suggestionResolutions.values()][0];
    const originalSnapshot = abandoned?.state === 'active' ? abandoned.snapshot : undefined;
    const originalIdentity = originalSnapshot === undefined ? undefined : {
      createdAt: originalSnapshot.createdAt,
      ...(originalSnapshot.revision !== undefined && { revision: originalSnapshot.revision }),
      ...(originalSnapshot.runId !== undefined && { runId: originalSnapshot.runId }),
    };
    await seedPhoneOwner(world, '+15550104040');
    expireActiveResolution(world, 'c1', 'phone');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });
    const replacement = await world.extractionRepo.getSuggestion('c1', 'phone');

    const res = await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    // The replacement is untouched: still pending, byte for byte.
    expect(res.body.suggestions).toHaveLength(1);
    expect(await world.extractionRepo.getSuggestion('c1', 'phone')).toEqual(replacement);
    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal).toEqual({
      itemId: abandoned?.itemId,
      state: 'completed',
      contactId: 'c1',
      target: 'phone',
      identityKey: abandoned?.identityKey,
      action: 'accept',
      completedAt: expect.any(String),
      disposition: 'released_unsafe',
    });
    expect(JSON.stringify(journal)).not.toContain('+15550104040');
    // A refused pre-mutation conflict never wrote the phone or its audit.
    expect((await world.contactsRepo.getById('c1'))?.phones ?? []).toHaveLength(0);
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_phone_added')).toHaveLength(0);
    // adv P1-1 / conf P2-2: it DOES record the verdict, best-effort. The run log
    // is the whole point of the feature and `pending` would claim nobody looked.
    expect(setVerdict.mock.calls).toHaveLength(1);
    expect(setVerdict.mock.calls[0]?.slice(0, 3)).toEqual(['run-a', 'phone', 'superseded']);
    expect(setVerdict.mock.calls[0]?.[3]).toMatchObject({ expectedVerdict: 'pending' });

    // adv P1-1b: the original tab retries the identity it still has on screen.
    // The completed row carries `released_unsafe`, so the honest answer is that
    // a newer suggestion replaced it - NOT the 200 "accepted" the plain
    // identity-match branch used to return for an action that never applied.
    const retry = await accept(makeWebhookHarness({ world }).app, 'c1', 'phone', originalIdentity);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('suggestion_replaced');
    expect((await world.contactsRepo.getById('c1'))?.phones ?? []).toHaveLength(0);
  });

  // H2 / item 4. Same terminal finalization as above, except the Put's
  // ACKNOWLEDGEMENT is lost, so the repo's catch arm re-reads the row it just
  // wrote and reports this caller's OWN finalization as somebody else's
  // (repo:1084-1087). Nothing else can ever stamp that decision - claim()
  // deleted the sugg# row so the replacement displaced nothing, and
  // recoverAbandoned skips completed journals - so `pending` would tell the run
  // log nobody ever looked at a decision a named operator accepted.
  it('stamps the terminal verdict when its own completion is reported already_completed', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    await seedPhoneOwner(world, '+15550104040');
    expireActiveResolution(world, 'c1', 'phone');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });
    const realComplete = world.suggestionResolutionRepo.complete.bind(world.suggestionResolutionRepo);
    world.suggestionResolutionRepo.complete = async (input) => {
      const result = await realComplete(input);
      // The Put landed; its acknowledgement did not, so the catch arm re-reads
      // the row it just wrote and reports `already_completed` (repo:1084-1087).
      return result === 'completed' ? 'already_completed' : result;
    };

    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal).toMatchObject({ state: 'completed', disposition: 'released_unsafe' });
    expect(setVerdict.mock.calls).toHaveLength(1);
    expect(setVerdict.mock.calls[0]?.slice(0, 3)).toEqual(['run-a', 'phone', 'superseded']);
    expect(setVerdict.mock.calls[0]?.[3]).toMatchObject({ expectedVerdict: 'pending' });
  });

  // conf P1-1. The confirm read the block above added is OBSERVABILITY, on a path
  // whose own contract two comments up is "it must never fail the human action" -
  // which is exactly why stampVerdict wraps its write. The read sat outside any
  // catch: the only enclosing swallow is recoverAbandoned's, so on the resolve()
  // path a single transient GetItem fault escaped applyJournal and turned the
  // operator's answer into a 500.
  it('answers the human even when the terminal confirm read faults', async () => {
    const { world } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    const abandoned = [...world.suggestionResolutions.values()][0];
    const originalSnapshot = abandoned?.state === 'active' ? abandoned.snapshot : undefined;
    const originalIdentity = originalSnapshot === undefined ? undefined : {
      createdAt: originalSnapshot.createdAt,
      ...(originalSnapshot.revision !== undefined && { revision: originalSnapshot.revision }),
      ...(originalSnapshot.runId !== undefined && { runId: originalSnapshot.runId }),
    };
    await seedPhoneOwner(world, '+15550104040');
    expireActiveResolution(world, 'c1', 'phone');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });
    const realComplete = world.suggestionResolutionRepo.complete.bind(world.suggestionResolutionRepo);
    world.suggestionResolutionRepo.complete = async (input) => {
      const result = await realComplete(input);
      return result === 'completed' ? 'already_completed' : result;
    };
    // ...and the confirm read that follows faults exactly ONCE, the way a
    // throttled or briefly unavailable table does.
    const realGet = world.suggestionResolutionRepo.get.bind(world.suggestionResolutionRepo);
    let faulted = false;
    world.suggestionResolutionRepo.get = async (contactId, target) => {
      const row = await realGet(contactId, target);
      if (!faulted && row?.state === 'completed') {
        faulted = true;
        throw new Error('GetItem down');
      }
      return row;
    };

    // The operator's own retry of the identity still on their screen.
    const harness = makeWebhookHarness({ world });
    const res = await accept(harness.app, 'c1', 'phone', originalIdentity);

    expect(faulted).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('suggestion_replaced');
    expect(
      harness.capture.atLevel(40).map((line) => line['msg']),
    ).toContain('ai run terminal verdict confirm read failed (best-effort)');
  });

  // conf P2-2. Pins the ADJUDICATED shape of the block above: the rejected
  // `finalized !== 'stale'` one-liner cannot tell "my own finalization came back
  // as somebody else's" from "somebody else finished this journal NORMALLY", and
  // stamping `superseded` over the latter is the conf P2-1 lie with a green
  // suite. Here the journal really is completed - by another actor, through the
  // ordinary ladder, with its true `accepted` verdict already recorded - so the
  // helper that lands in the terminal block must stamp NOTHING.
  it('does not stamp superseded when the already_completed journal completed NORMALLY', async () => {
    const recorded = new Map<string, Verdict>();
    const { world, setVerdict } = makeWorld(async (runId, target, verdict, opts) => {
      const decision = `${runId}#${target}`;
      const current = recorded.get(decision) ?? 'pending';
      if (opts?.expectedVerdict !== undefined && current !== opts.expectedVerdict) return false;
      recorded.set(decision, verdict);
      return true;
    });
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    await seedPhoneOwner(world, '+15550104040');
    expireActiveResolution(world, 'c1', 'phone');
    // A replacement holds the pending slot, so a release can only be 'unsafe'.
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });

    const helperB = makeWebhookHarness({ world }).app;
    const helperA = makeWebhookHarness({ world }).app;
    const realRelease = world.suggestionResolutionRepo.release;
    world.suggestionResolutionRepo.release = async (input) => {
      // Helper A stalls INSIDE release (SDK retry, GC pause, throttled table)
      // past its own lease. Once only - B must see the real protocol.
      world.suggestionResolutionRepo.release = realRelease;
      // The conflict clears while A is stalled: the other contact's number is
      // removed, pointer and all.
      const pointerIndex = world.contacts.findIndex(
        (contact) => contact.phone_ref === true && contact.phone === '+15550104040',
      );
      if (pointerIndex < 0) throw new Error('expected the foreign owner pointer');
      world.contacts.splice(pointerIndex, 1);
      const other = world.contacts.find((contact) => contact.contactId === 'c-other');
      if (other !== undefined) {
        other.phones = (other.phones ?? []).filter((entry) => entry.phone !== '+15550104040');
      }
      // ...and B takes the journal over and drives it to NORMAL completion:
      // phone committed, activity recorded, `accepted` stamped, journal scrubbed
      // with NO disposition.
      expireActiveResolution(world, 'c1', 'phone');
      await list(helperB, 'c1').expect(200);
      return realRelease(input);
    };

    await list(helperA, 'c1').expect(200);

    // The journal is terminal and carries no disposition, so A's complete()
    // answers `already_completed` for a journal it did not finalize.
    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal?.state).toBe('completed');
    expect(journal).not.toHaveProperty('disposition');
    // Exactly one verdict, and it is the true one B wrote. A `superseded` here
    // would be permanent: setVerdict is fenced on the CURRENT verdict.
    expect(setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([['run-a', 'accepted']]);
    expect(recorded.get('run-a#phone')).toBe('accepted');
  });

  // FIX-4 / conf P2-3 mitigation. A number held as another contact's PRIMARY has
  // no `phoneref#` pointer row by design, so commitPhoneEffect - which arbitrates
  // on the pointer alone - cannot see its owner and would attach it anyway. The
  // ordinary accept path is fenced by the service's findByPhone pre-check; the
  // HELP path (takeover from resolve(), or recoverAbandoned on this read) used to
  // skip it entirely. Advisory only: findByPhone reads an eventually consistent
  // GSI, so this narrows reachability rather than proving ownership.
  it('does NOT attach a number that became another contact PRIMARY while a journal was abandoned', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    // The number becomes somebody else's PRIMARY - a bare contact scalar, with
    // NO pointer row (that is the invariant addPhone maintains for primaries).
    world.contacts.push({
      contactId: 'c-primary-owner',
      type: 'tenant',
      phone: '+15550104040',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expireActiveResolution(world, 'c1', 'phone');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });

    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    // Nothing was attached and no pointer was minted, so the number still
    // resolves to exactly one owner.
    expect((await world.contactsRepo.getById('c1'))?.phones ?? []).toHaveLength(0);
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_phone_added')).toHaveLength(0);
    expect((await world.contactsRepo.findByPhone('+15550104040'))?.contactId).toBe('c-primary-owner');
    expect(world.contacts.some((contact) => contact.phone_ref === true)).toBe(false);
    // The journal still ends terminally, with its verdict recorded.
    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal?.state).toBe('completed');
    expect(journal).toMatchObject({ disposition: 'released_unsafe' });
    expect(setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([['run-a', 'superseded']]);
  });

  // conf P2-1. `release()` decides its answer in the catch arm, where
  // "a pending row exists" -> 'unsafe' (repo:1054) outranks "somebody took this
  // journal from us" -> 'stale' (repo:1055): requireActive (repo:1017) passes,
  // the lease is lost while the TransactWrite is in flight, and the caller
  // still hears 'unsafe'. So a helper that no longer owns the journal reaches
  // the terminal-finalization block. Its `complete()` correctly no-ops - and
  // the verdict stamp must no-op with it, because setVerdict is fenced on the
  // CURRENT verdict (aiRunsRepo.ts writeRunVerdict, `#d.#t.#verdict =
  // :expectedVerdict`), so whichever verdict lands FIRST is permanent.
  it('does not stamp superseded from a helper whose complete() no-opped', async () => {
    const recorded = new Map<string, Verdict>();
    const { world, setVerdict } = makeWorld(async (runId, target, verdict, opts) => {
      const decision = `${runId}#${target}`;
      const current = recorded.get(decision) ?? 'pending';
      if (opts?.expectedVerdict !== undefined && current !== opts.expectedVerdict) return false;
      recorded.set(decision, verdict);
      return true;
    });
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    await seedPhoneOwner(world, '+15550104040');
    expireActiveResolution(world, 'c1', 'phone');
    // A replacement holds the pending slot, so a release can only be 'unsafe'.
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });

    // Helper B commits the phone effect for real, then dies before its verdict
    // stamp - leaving the journal ACTIVE and owned by B at activity_recorded.
    const helperB = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'activity_applied') throw new Error('simulated termination before verdict');
        },
      },
    }).app;
    const helperA = makeWebhookHarness({ world }).app;
    const realRelease = world.suggestionResolutionRepo.release;
    world.suggestionResolutionRepo.release = async (input) => {
      // Helper A stalls INSIDE release (SDK retry, GC pause, throttled table)
      // past its own 30 s lease. Once only - B must see the real protocol.
      world.suggestionResolutionRepo.release = realRelease;
      // The conflict clears while A is stalled: the other contact's number is
      // removed, pointer and all.
      const pointerIndex = world.contacts.findIndex(
        (contact) => contact.phone_ref === true && contact.phone === '+15550104040',
      );
      if (pointerIndex < 0) throw new Error('expected the foreign owner pointer');
      world.contacts.splice(pointerIndex, 1);
      const other = world.contacts.find((contact) => contact.contactId === 'c-other');
      if (other !== undefined) {
        other.phones = (other.phones ?? []).filter((entry) => entry.phone !== '+15550104040');
      }
      // ...and B takes the journal over and commits the number.
      expireActiveResolution(world, 'c1', 'phone');
      await list(helperB, 'c1').expect(200);
      return realRelease(input);
    };

    await list(helperA, 'c1').expect(200);

    // B committed the human's accept for real.
    expect((await world.contactsRepo.getById('c1'))?.phones?.map((phone) => phone.phone)).toEqual(
      expect.arrayContaining(['+15550104040']),
    );
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_phone_added')).toHaveLength(1);
    // A finalized nothing (complete() answered 'stale'), so A must stamp nothing.
    expect(setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([]);

    // The journal's true owner finishes it on the next ordinary read, and the
    // run log records what actually happened.
    expireActiveResolution(world, 'c1', 'phone');
    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);
    expect(setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([['run-a', 'accepted']]);
    expect(recorded.get('run-a#phone')).toBe('accepted');
  });

  // conf P2-2. FIX-4's advisory findByPhone reads the eventually consistent
  // byPhone GSI, and on the HELP path its answer is PERMANENT: terminal
  // finalization, a `superseded` verdict, a scrubbed snapshot, and 409
  // suggestion_replaced for the operator's retry. A hit must therefore be
  // CONFIRMED by a strongly consistent point read; a disproved one falls
  // through to the fenced transaction, which is the real guard.
  it('falls through to the fenced transaction when the advisory phone owner is stale', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const crashing = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(crashing, 'c1', 'phone').expect(500);
    // The number was already freed, but the index still projects its former
    // owner. The fake answers findByPhone and getById from ONE array, so the
    // staleness is staged on findByPhone itself - that divergence between an
    // index read and the authoritative item is the whole of what an eventually
    // consistent GSI adds, and it is what the confirm read exists to catch.
    world.contacts.push({
      contactId: 'c-former-owner',
      type: 'tenant',
      phone: '+15550109090',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const realFindByPhone = world.contactsRepo.findByPhone;
    world.contactsRepo.findByPhone = async (phone) => (
      phone === '+15550104040'
        ? world.contacts.find((contact) => contact.contactId === 'c-former-owner')
        : realFindByPhone(phone)
    );
    expireActiveResolution(world, 'c1', 'phone');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550105050', conversationId: 'conv-b', runId: 'run-b',
    });

    await list(makeWebhookHarness({ world }).app, 'c1').expect(200);

    // The consistent read disproved the index, so the human's accept applied
    // instead of being destroyed by a guess.
    expect((await world.contactsRepo.getById('c1'))?.phones?.map((phone) => phone.phone)).toEqual(
      expect.arrayContaining(['+15550104040']),
    );
    expect(world.auditEvents.filter((event) => event.event_type === 'contact_phone_added')).toHaveLength(1);
    expect(setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([['run-a', 'accepted']]);
    const journal = [...world.suggestionResolutions.values()][0];
    expect(journal?.state).toBe('completed');
    expect(journal).not.toHaveProperty('disposition');
    // The replacement was never touched.
    expect((await world.extractionRepo.getSuggestion('c1', 'phone'))?.runId).toBe('run-b');
  });

  // adv P2-5. The `if (opts.helping) return` was nested inside the
  // `released === 'unsafe'` arm alone, so a helped conflict that released
  // SAFELY (no replacement existed, the snapshot went back into the pending
  // slot) still threw 409 phone_in_use - out of the help and into the
  // requester's own request, about a number the requester never chose. A
  // restored suggestion must answer through the identity fence instead.
  it('hands control back to the requester when a helped phone conflict releases safely', async () => {
    // The requester DISMISSES: their own action cannot conflict with phone
    // ownership at all, so a phone_in_use answer can only have come from the
    // journal they helped.
    const dismissing = makeWorld();
    seedTenant(dismissing.world);
    await seedSuggestion(dismissing.world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const dismissCrash = makeWebhookHarness({
      world: dismissing.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(dismissCrash, 'c1', 'phone').expect(500);
    await seedPhoneOwner(dismissing.world, '+15550104040');
    expireActiveResolution(dismissing.world, 'c1', 'phone');

    const dismissed = await dismiss(makeWebhookHarness({ world: dismissing.world }).app, 'c1', 'phone');

    expect(dismissed.status).toBe(200);
    expect(await dismissing.world.extractionRepo.getSuggestion('c1', 'phone')).toBeUndefined();
    // Nothing about the number changed - it was never this request's business.
    expect((await dismissing.world.contactsRepo.getById('c1'))?.phones ?? []).toHaveLength(0);
    expect((await dismissing.world.contactsRepo.findByPhone('+15550104040'))?.contactId).toBe('c-other');
    expect(dismissing.setVerdict.mock.calls.map((call) => [call[0], call[2]])).toEqual([['run-a', 'dismissed']]);

    // And a requester whose tab holds a STALE identity gets the fence's answer
    // about their own chip, not the helped journal's ownership complaint.
    const stale = makeWorld();
    seedTenant(stale.world);
    await seedSuggestion(stale.world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550104040', conversationId: 'conv-a', runId: 'run-a',
    });
    const staleCrash = makeWebhookHarness({
      world: stale.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after phone claim');
        },
      },
    }).app;
    await accept(staleCrash, 'c1', 'phone').expect(500);
    await seedPhoneOwner(stale.world, '+15550104040');
    expireActiveResolution(stale.world, 'c1', 'phone');

    const staleRetry = await accept(makeWebhookHarness({ world: stale.world }).app, 'c1', 'phone', {
      createdAt: '2026-07-01T09:00:00.000Z',
      runId: 'run-stale',
    });

    expect(staleRetry.status).toBe(409);
    expect(staleRetry.body.error).toBe('suggestion_replaced');
    // The helped journal's snapshot really did go back into the pending slot.
    const restored = await stale.world.extractionRepo.getSuggestion('c1', 'phone');
    expect(restored?.runId).toBe('run-a');
    expect(restored?.suggestedValue).toBe('+15550104040');
    expect(stale.world.suggestionResolutions.size).toBe(0);
    expect(stale.setVerdict).not.toHaveBeenCalled();
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

  // adv P3-25: a helped journal writes the contact and the pending list for
  // somebody else's suggestion. Whether this request then succeeds on its own
  // identity or fails on it, every open dashboard has just gone stale.
  it('emits suggestion.updated for a helped journal whether the request then succeeds or fails', async () => {
    const succeeding = makeWorld();
    seedTenant(succeeding.world);
    await seedSuggestion(succeeding.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-a', runId: 'run-a',
    });
    await accept(makeWebhookHarness({
      world: succeeding.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after claim');
        },
      },
    }).app, 'c1', 'pets').expect(500);
    expireActiveResolution(succeeding.world, 'c1', 'pets');

    await accept(makeWebhookHarness({ world: succeeding.world }).app, 'c1', 'pets').expect(200);

    expect(succeeding.world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('two cats');
    expect(succeeding.world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(1);

    const failing = makeWorld();
    seedTenant(failing.world);
    await seedSuggestion(failing.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-a', runId: 'run-a',
    });
    await dismiss(makeWebhookHarness({
      world: failing.world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after dismiss claim');
        },
      },
    }).app, 'c1', 'pets').expect(500);
    expireActiveResolution(failing.world, 'c1', 'pets');
    // Same normalized value, so helping the abandoned dismiss consumes it and the
    // request has no identity of its own left to resolve.
    await seedSuggestion(failing.world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: ' TWO   CATS ', conversationId: 'conv-b', runId: 'run-b',
    });

    await dismiss(makeWebhookHarness({ world: failing.world }).app, 'c1', 'pets').expect(404);

    expect(await failing.world.extractionRepo.hasDismissal('c1', 'pets', 'two cats')).toBe(true);
    expect(failing.world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(1);
  });

  // H6 / item 28: the same helped commit, but this request then fails on a RAW
  // store error rather than a SuggestionResolutionError. Both gates used to test
  // `instanceof SuggestionResolutionError`, so the contact and the pending list
  // changed and no dashboard was told. A repo/SDK throw is not less of a state
  // change than a typed refusal.
  it('emits suggestion.updated for a helped journal when the request then throws a raw store error', async () => {
    const { world } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-a', runId: 'run-a',
    });
    await dismiss(makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary) => {
          if (boundary === 'claimed') throw new Error('simulated termination after dismiss claim');
        },
      },
    }).app, 'c1', 'pets').expect(500);
    expireActiveResolution(world, 'c1', 'pets');
    // Same normalized value, so helping the abandoned dismiss consumes it.
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: ' TWO   CATS ', conversationId: 'conv-b', runId: 'run-b',
    });
    const repo = world.suggestionResolutionRepo;
    const realGet = repo.get.bind(repo);
    repo.get = async (contactId, target) => {
      const item = await realGet(contactId, target);
      // The help has finished and scrubbed the journal; the store then fails on
      // the loop's next read, with an error that is not a resolution error.
      if (item?.state === 'completed') throw new Error('journal store unavailable');
      return item;
    };

    await dismiss(makeWebhookHarness({ world }).app, 'c1', 'pets').expect(500);

    expect(await world.extractionRepo.hasDismissal('c1', 'pets', 'two cats')).toBe(true);
    expect(world.emitted.filter((event) => event.event === 'suggestion.updated')).toHaveLength(1);
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

  // F2: every one of these sites fires AFTER the single atomic transaction that
  // wrote the contact, its audit, and the phase advance. Losing the journal to
  // another helper afterwards is not the operator's problem - their action took
  // effect, so the answer is the success answer.
  it('answers 200 when a competing helper finishes the journal after the domain effect commits', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const repo = world.suggestionResolutionRepo;
    const commitContactEffect = repo.commitContactEffect.bind(repo);
    repo.commitContactEffect = async (input) => {
      const result = await commitContactEffect(input);
      // Another helper scrubs the journal in the window between our committed
      // effect and our re-read of it.
      for (const [mapKey, item] of world.suggestionResolutions) {
        if (item.state === 'active' && item.contactId === input.token.contactId && item.target === input.token.target) {
          world.suggestionResolutions.set(mapKey, makeCompletedResolution(item, '2026-08-08T00:00:00.000Z'));
        }
      }
      return result;
    };

    const res = await accept(app, 'c1', 'pets').expect(200);

    expect(res.body.contact.pets).toBe('two cats');
    expect(world.contacts.find((contact) => contact.contactId === 'c1')?.pets).toBe('two cats');
    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted')).toHaveLength(1);
    expect(setVerdict).not.toHaveBeenCalled();
    expect(world.emitted.some((event) => event.event === 'suggestion.updated')).toBe(true);
  });

  it('answers 200 when only the final scrub is lost to a competing lease takeover', async () => {
    const { world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const app = makeWebhookHarness({
      world,
      suggestionResolutionHooks: {
        afterBoundary: (boundary, journal) => {
          if (boundary !== 'verdict_attempted') return;
          for (const [mapKey, item] of world.suggestionResolutions) {
            if (item.state === 'active' && item.contactId === journal.contactId && item.target === journal.target) {
              world.suggestionResolutions.set(mapKey, { ...item, leaseId: 'competing-lease', fence: item.fence + 1 });
            }
          }
        },
      },
    }).app;

    const res = await accept(app, 'c1', 'pets').expect(200);

    expect(res.body.contact.pets).toBe('two cats');
    expect(world.auditEvents.filter((event) => event.event_type === 'ai_suggestion_accepted')).toHaveLength(1);
    expect(setVerdict).toHaveBeenCalledTimes(1);
    // We must not scrub a journal we no longer own - the new lease holder finishes it.
    expect([...world.suggestionResolutions.values()][0]).toMatchObject({
      state: 'active', leaseId: 'competing-lease',
    });
    expect(world.emitted.some((event) => event.event === 'suggestion.updated')).toBe(true);
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

  // F9c: pino applies its standard error serializer ONLY to the `err` key. The
  // same Error under `error` has non-enumerable message/stack and serializes to
  // {}, so the best-effort failure was logged blind.
  it('serializes a best-effort verdict-stamp failure under a readable err', async () => {
    const { app, world, capture } = makeWebhookHarness();
    world.aiRuns.setVerdict = async () => {
      throw new Error('ai run store unavailable');
    };
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-log',
    });

    await accept(app, 'c1', 'pets').expect(200);

    const line = capture.lines.find(
      (entry) => entry['msg'] === 'ai run verdict stamp failed (best-effort)',
    );
    expect(line).toBeDefined();
    expect(line?.['err']).toMatchObject({ message: 'ai run store unavailable' });
    // Ids only - a journal carries the suggestion's values.
    expect(line?.['contactId']).toBe('c1');
    expect(line?.['target']).toBe('pets');
  });

  // F9d: the accept response re-reads the contact the transaction just wrote.
  // An eventually consistent GetItem can serve the pre-write item, so the
  // operator's own accept can render as if nothing changed.
  it('re-reads the accepted contact with a consistent read', async () => {
    const { app, world } = makeWorld();
    seedTenant(world);
    const getById = vi.spyOn(world.contactsRepo, 'getById');
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-consistent',
    });

    await accept(app, 'c1', 'pets').expect(200);

    expect(getById).toHaveBeenCalledWith('c1', { consistentRead: true });
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

    // The dismissal is PERMANENT and the writer enforces it
    // (extractionRepo.ts:437-445): re-suggesting the SAME value is refused at
    // the repository, not merely ignored downstream. This used to be seeded
    // straight back in because the harness double ignored its own dismissals -
    // so the "accept refuses type" assertion below ran against a pending row
    // the real system can never produce.
    await expect(seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-2',
    })).rejects.toBeInstanceOf(SuggestionDismissedError);

    // A DIFFERENT value is still suggestible, and accept still refuses `type`.
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'landlord', conversationId: 'conv-1', runId: 'run-2',
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

  it('emits suggestion.updated when a human field edit deletes a pending suggestion', async () => {
    const { app, world } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats',
      conversationId: 'conv-1', runId: 'run-pets',
    });

    await patch(app, 'c1', { pets: 'a dog' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(world.emitted.filter(({ event }) => event === 'suggestion.updated')).toEqual([
      { event: 'suggestion.updated', payload: { contactId: 'c1' } },
    ]);
  });

  it('emits suggestion.updated when a classification PATCH drains a type suggestion', async () => {
    const { app, world } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'partner',
      conversationId: 'conv-1', runId: 'run-type', contactClassificationRevision: 0,
    });

    await patch(app, 'c1', { type: 'partner' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(world.emitted.filter(({ event }) => event === 'suggestion.updated')).toEqual([
      { event: 'suggestion.updated', payload: { contactId: 'c1' } },
    ]);
  });

  it.each([
    ['property_manager', { type: 'landlord', role: 'Property Manager' }, 'accepted'],
    ['property_manager', { type: 'landlord', role: 'property manager' }, 'superseded_by_human_edit'],
    ['property_manager', { type: 'landlord', role: '' }, 'superseded_by_human_edit'],
    ['partner', { type: 'partner', role: '' }, 'accepted'],
    ['landlord', { type: 'landlord', role: 'Leasing Agent' }, 'superseded_by_human_edit'],
  ] as const)('%s plus %o produces %s', async (suggestedValue, patchBody, verdict) => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1',
      target: 'type',
      suggestedValue,
      conversationId: 'conv-1',
      runId: 'run-kind',
      contactClassificationRevision: 0,
      createdAt: '2026-08-26T12:00:00.000Z',
    });

    await patch(app, 'c1', patchBody).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith(
      'run-kind',
      'type',
      verdict,
      expect.objectContaining({
        at: expect.any(String),
        expectedVerdict: 'pending',
        freshSuggestionCreatedAt: '2026-08-26T12:00:00.000Z',
        by: ACTOR,
      }),
    );
  });

  it('accepts the role-only dashboard PATCH that makes a landlord a Property Manager', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'landlord', status: 'interested' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'property_manager',
      conversationId: 'conv-1', runId: 'run-role-only', contactClassificationRevision: 0,
    });

    await patch(app, 'c1', { role: 'Property Manager' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-role-only', 'type', 'accepted', expect.anything());
  });

  it('accepts the role-only dashboard PATCH that clears a Property Manager to landlord', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'landlord', role: 'Property Manager', status: 'interested' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'landlord',
      conversationId: 'conv-1', runId: 'run-role-clear', contactClassificationRevision: 0,
    });

    await patch(app, 'c1', { role: '' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-role-clear', 'type', 'accepted', expect.anything());
  });

  it('deletes a safely fenced legacy type suggestion without stamping a nonexistent run', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'partner',
      conversationId: 'conv-legacy', contactClassificationRevision: 0,
    });

    await patch(app, 'c1', { type: 'partner' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('drains an older replacement published during contacts.update from the repository, Today, and run verdict', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-old',
      runId: 'run-old', contactClassificationRevision: 0,
    });
    const originalUpdate = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (contactId, body) => {
      const updated = await originalUpdate(contactId, body);
      await seedSuggestion(world, {
        ownerContactId: contactId, target: 'type', suggestedValue: 'landlord', conversationId: 'conv-new',
        runId: 'run-new', contactClassificationRevision: 0,
      });
      return updated;
    };

    await patch(app, 'c1', { type: 'tenant' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    const today = await request(app)
      .get('/api/today')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(today.body.items).not.toContainEqual(expect.objectContaining({
      group: 'ai_suggestions', refId: 'c1',
    }));
    expect(setVerdict).toHaveBeenCalledWith(
      'run-new', 'type', 'superseded_by_human_edit', expect.objectContaining({
        expectedVerdict: 'pending', by: ACTOR,
      }),
    );
  });

  it('drains an older row injected after an empty pre-write type snapshot and stamps its stored run', async () => {
    const { app, world, setVerdict } = makeFaithfulRouteWorld();
    const createdAt = '2026-08-26T13:00:00.000Z';
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await world.aiRuns.putRun(pendingTypeRun('run-empty-snapshot', createdAt, 'tenant'));
    let consistentTypeReads = 0;
    world.suggestionHooks.beforeGetSuggestion = async (_contactId, target, opts) => {
      if (target !== 'type' || opts?.consistentRead !== true) return;
      consistentTypeReads += 1;
      if (consistentTypeReads !== 2) return;
      await world.extractionRepo.putSuggestion({
        ownerContactId: 'c1',
        target: 'type',
        suggestedValue: 'tenant',
        conversationId: 'conv-empty-snapshot',
        runId: 'run-empty-snapshot',
        contactClassificationRevision: 0,
        createdAt,
      });
    };

    await patch(app, 'c1', { type: 'partner' }).expect(200);

    const routeConsistentTypeReads = consistentTypeReads;
    // Pre-write snapshot, injection/read after the committed PATCH, then the
    // bounded drain's final no-row read after it deletes the injected row.
    expect(routeConsistentTypeReads).toBe(3);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    await expect(list(app, 'c1')).resolves.toMatchObject({ body: { suggestions: [] } });
    const today = await request(app).get('/api/today')
      .set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).expect(200);
    expect(today.body.items).not.toContainEqual(expect.objectContaining({ group: 'ai_suggestions', refId: 'c1' }));
    expect((await world.aiRuns.getRun('run-empty-snapshot'))?.decisions.type).toMatchObject({
      proposedValue: 'tenant', outcome: 'suggested', verdict: 'superseded_by_human_edit', verdictBy: ACTOR,
    });
    expect(setVerdict).toHaveBeenCalledWith('run-empty-snapshot', 'type', 'superseded_by_human_edit', expect.objectContaining({
      by: ACTOR, freshSuggestionCreatedAt: createdAt, expectedVerdict: 'pending',
    }));
  });

  it('re-reads and exact-deletes the second older replacement after two guarded delete identity misses', async () => {
    const { app, world, setVerdict } = makeFaithfulRouteWorld();
    const createdAtA = '2026-08-26T14:00:00.000Z';
    const createdAtB = '2026-08-26T14:01:00.000Z';
    const createdAtC = '2026-08-26T14:02:00.000Z';
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await Promise.all([
      world.aiRuns.putRun(pendingTypeRun('run-race-a', createdAtA, 'tenant')),
      world.aiRuns.putRun(pendingTypeRun('run-race-b', createdAtB, 'landlord')),
      world.aiRuns.putRun(pendingTypeRun('run-race-c', createdAtC, 'partner')),
    ]);
    await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-race-a',
      runId: 'run-race-a', contactClassificationRevision: 0, createdAt: createdAtA,
    });
    const getSuggestion = vi.spyOn(world.extractionRepo, 'getSuggestion');
    const guardedDelete = vi.spyOn(world.extractionRepo, 'deleteTypeSuggestionIfCurrentAtContactRevision');
    let deleteBoundary = 0;
    world.suggestionHooks.beforeDeleteTypeSuggestion = async () => {
      deleteBoundary += 1;
      if (deleteBoundary === 1) {
        await replaceTypeSuggestionFromExtraction(world, {
          ownerContactId: 'c1', target: 'type', suggestedValue: 'landlord', conversationId: 'conv-race-b',
          runId: 'run-race-b', contactClassificationRevision: 0, createdAt: createdAtB,
        });
      }
      if (deleteBoundary === 2) {
        await replaceTypeSuggestionFromExtraction(world, {
          ownerContactId: 'c1', target: 'type', suggestedValue: 'partner', conversationId: 'conv-race-c',
          runId: 'run-race-c', contactClassificationRevision: 0, createdAt: createdAtC,
        });
      }
    };

    await patch(app, 'c1', { type: 'partner' }).expect(200);

    const routeConsistentReads = getSuggestion.mock.calls
      .filter(([, target, opts]) => target === 'type' && opts?.consistentRead === true);
    // The last read is the bounded drain proving C stayed gone after its CAS.
    expect(routeConsistentReads).toHaveLength(4);
    expect(guardedDelete).toHaveBeenCalledTimes(3);
    expect(guardedDelete.mock.calls.map(([candidate]) => candidate.runId)).toEqual([
      'run-race-a', 'run-race-b', 'run-race-c',
    ]);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    await expect(list(app, 'c1')).resolves.toMatchObject({ body: { suggestions: [] } });
    const today = await request(app).get('/api/today')
      .set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).expect(200);
    expect(today.body.items).not.toContainEqual(expect.objectContaining({ group: 'ai_suggestions', refId: 'c1' }));
    expect((await world.aiRuns.getRun('run-race-a'))?.decisions.type).toMatchObject({
      proposedValue: 'tenant', outcome: 'suggested', verdict: 'superseded',
    });
    expect((await world.aiRuns.getRun('run-race-b'))?.decisions.type).toMatchObject({
      proposedValue: 'landlord', outcome: 'suggested', verdict: 'superseded',
    });
    expect((await world.aiRuns.getRun('run-race-c'))?.decisions.type).toMatchObject({
      proposedValue: 'partner', outcome: 'suggested', verdict: 'superseded_by_human_edit', verdictBy: ACTOR,
    });
    expect(setVerdict).toHaveBeenCalledWith('run-race-a', 'type', 'superseded', expect.objectContaining({
      at: expect.any(String), expectedVerdict: 'pending', freshSuggestionCreatedAt: createdAtA,
    }));
    expect(setVerdict).toHaveBeenCalledWith('run-race-b', 'type', 'superseded', expect.objectContaining({
      at: expect.any(String), expectedVerdict: 'pending', freshSuggestionCreatedAt: createdAtB,
    }));
    expect(setVerdict).toHaveBeenCalledWith('run-race-c', 'type', 'superseded_by_human_edit', expect.objectContaining({
      at: expect.any(String), by: ACTOR, freshSuggestionCreatedAt: createdAtC, expectedVerdict: 'pending',
    }));
    const cVerdictOptions = setVerdict.mock.calls.find(([runId]) => runId === 'run-race-c')?.[3];
    expect((await world.aiRuns.getRun('run-race-c'))?.decisions.type?.verdictAt)
      .toBe(cVerdictOptions?.at);
  });

  it('banks the real PATCH superseded verdict during finalization and merges it into the pending type run', async () => {
    const { app, world, setVerdict } = makeFaithfulRouteWorld();
    const createdAt = '2026-08-26T15:00:00.000Z';
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    expect(await world.aiRuns.beginFinalization('run-finalizing', createdAt)).toBe(true);
    await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-finalizing',
      runId: 'run-finalizing', contactClassificationRevision: 0, createdAt,
    });

    await patch(app, 'c1', { type: 'partner' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    await expect(list(app, 'c1')).resolves.toMatchObject({ body: { suggestions: [] } });
    const today = await request(app).get('/api/today')
      .set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).expect(200);
    expect(today.body.items).not.toContainEqual(expect.objectContaining({ group: 'ai_suggestions', refId: 'c1' }));
    expect(setVerdict).toHaveBeenCalledWith('run-finalizing', 'type', 'superseded_by_human_edit', expect.objectContaining({
      at: expect.any(String), by: ACTOR, expectedVerdict: 'pending', freshSuggestionCreatedAt: createdAt,
    }));
    const verdictOptions = setVerdict.mock.calls.find(([runId]) => runId === 'run-finalizing')?.[3];
    await world.aiRuns.putRun(pendingTypeRun('run-finalizing', createdAt, 'tenant'));
    expect((await world.aiRuns.getRun('run-finalizing'))?.decisions.type).toMatchObject({
      proposedValue: 'tenant', outcome: 'suggested', verdict: 'superseded_by_human_edit', verdictBy: ACTOR,
      verdictAt: verdictOptions?.at,
    });
  });

  it('preserves a later Unknown epoch, then accepts its matching later classification', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-old',
      runId: 'run-old', contactClassificationRevision: 0,
    });
    let injected = false;
    world.suggestionHooks.beforeDeleteTypeSuggestion = async () => {
      if (injected) return;
      injected = true;
      await patch(app, 'c1', { type: 'unknown' }).expect(200);
      await seedSuggestion(world, {
        ownerContactId: 'c1', target: 'type', suggestedValue: 'partner', conversationId: 'conv-later',
        runId: 'run-later', contactClassificationRevision: 2,
      });
    };

    await patch(app, 'c1', { type: 'tenant' }).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toMatchObject({
      runId: 'run-later', contactClassificationRevision: 2,
    });
    expect(setVerdict).not.toHaveBeenCalledWith('run-later', 'type', expect.anything(), expect.anything());

    world.suggestionHooks.beforeDeleteTypeSuggestion = undefined;
    await patch(app, 'c1', { type: 'partner' }).expect(200);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-later', 'type', 'accepted', expect.anything());
  });

  // F10: the value-match is CONFINED to `type` (frozen spec 7.3, lines 609-616:
  // "This value comparison is confined to `type`. It must NOT be generalized to
  // the other eleven targets: for them the PATCH is a human edit that supersedes
  // the suggestion regardless of value"). This test used to assert the opposite
  // - a matching `pets` PATCH stamping `accepted` - and is now the confinement pin.
  it('CONFINEMENT: a non-type PATCH supersedes even when the value matches the suggestion', async () => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });

    await patch(app, 'c1', { pets: 'two cats' }).expect(200);

    expect(setVerdict).toHaveBeenCalledWith('run-1', 'pets', 'superseded_by_human_edit', expect.anything());
    expect(setVerdict).not.toHaveBeenCalledWith('run-1', 'pets', 'accepted', expect.anything());
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
