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
import { runJournalSweep } from '../src/jobs/journalSweep.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import type { OrgListItem } from '../src/repos/orgListRepo.js';
import type {
  ResolutionAttributeGuard,
  ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
import { createOrgNamesService } from '../src/services/orgNames.js';
import { DECISION_TARGETS } from '../src/services/extraction/runTypes.js';
import { EXTRACTABLE_FIELDS } from '../src/services/extraction/schema.js';
import {
  createSuggestionResolutionService,
  TENANT_ONLY_TARGETS,
} from '../src/services/suggestionResolution.js';
import { quietLogger } from './helpers/orgFixtures.js';

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

/** The starting organization list (spec 2026-10-06 Appendix A) as a stored item. */
function startingOrgList(): OrgListItem {
  let n = 0;
  return {
    settingId: 'org-list',
    version: 1,
    entries: buildStartingEntries('2026-10-06T00:00:00.000Z', () => `org-${(n += 1)}`),
  };
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

/** The real caseworker conversion, through its one route. */
function convert(app: import('express').Express, contactId: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/caseworker-review`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ action: 'make' });
}

/** An app whose accept dies right after its claim (process termination). */
function crashingApp(world: FakeWorld): import('express').Express {
  return makeWebhookHarness({
    world,
    suggestionResolutionHooks: {
      afterBoundary: (boundary) => {
        if (boundary === 'claimed') throw new Error('simulated termination after claim');
      },
    },
  }).app;
}

function expireActiveResolution(world: FakeWorld, contactId: string, target: string): void {
  for (const [key, item] of world.suggestionResolutions) {
    if (item.state === 'active' && item.contactId === contactId && item.target === target) {
      world.suggestionResolutions.set(key, { ...item, leaseExpiresAt: '2000-01-01T00:00:00.000Z' });
      return;
    }
  }
  throw new Error('expected an active resolution');
}

function journalFor(world: FakeWorld, contactId: string, target: string) {
  return [...world.suggestionResolutions.values()].find(
    (item) => item.contactId === contactId && item.target === target,
  );
}

function guardOf(plan: ResolutionReplayPlan | undefined): ResolutionAttributeGuard {
  if (plan === undefined || (plan.kind !== 'contact' && plan.kind !== 'status')) {
    throw new Error('expected a contact or status plan');
  }
  return plan.guard;
}

/** The daily abandoned-journal sweep, run a day later over the world's repos. */
async function sweepADayLater(world: FakeWorld) {
  const service = createSuggestionResolutionService({
    contactsRepo: world.contactsRepo,
    extractionRepo: world.extractionRepo,
    aiRunsRepo: world.aiRuns,
    resolutionRepo: world.suggestionResolutionRepo,
    orgNamesService: createOrgNamesService({ orgListRepo: world.orgListRepo, logger: quietLogger() }),
    logger: quietLogger(),
  });
  return runJournalSweep(
    new Date(Date.now() + 25 * 3_600_000).toISOString(),
    {
      settingsRepo: {
        claimGroupPeriod: async () => true,
        getJournalSweepCursor: async () => undefined,
        putJournalSweepCursor: async () => {},
      },
      resolutionRepo: world.suggestionResolutionRepo,
      resolutionService: service,
      events: world.events,
      logger: quietLogger(),
    },
    { force: true },
  );
}

/** Turn an active journal into one claimed before the deploy: no classification_revision in its guard. */
function stripRevisionFromJournal(world: FakeWorld, contactId: string, target: string): void {
  for (const [key, item] of world.suggestionResolutions) {
    if (item.state === 'active' && item.contactId === contactId && item.target === target) {
      if (item.plan.kind !== 'contact' && item.plan.kind !== 'status') throw new Error('expected a contact plan');
      const { classification_revision: _dropped, ...legacyGuard } = item.plan.guard;
      world.suggestionResolutions.set(key, { ...item, plan: { ...item.plan, guard: legacyGuard } });
      return;
    }
  }
  throw new Error('expected an active resolution');
}

/**
 * An app whose accept pauses right after its claim until `release()` - the
 * R2-ADV-1 schedule A window, deterministic.
 */
function pausedAtClaim(world: FakeWorld): {
  app: import('express').Express;
  atClaim: Promise<void>;
  release: () => void;
} {
  let releaseHold!: () => void;
  const held = new Promise<void>((resolve) => { releaseHold = resolve; });
  let reached!: () => void;
  const atClaim = new Promise<void>((resolve) => { reached = resolve; });
  const { app } = makeWebhookHarness({
    world,
    suggestionResolutionHooks: {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') {
          reached();
          await held;
        }
      },
    },
  });
  return { app, atClaim, release: () => releaseHold() };
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
  // B1 spec D3: the four tenant matching inputs are tenant facts, so they join
  // the seven. The drift guard below fails if a new target is left unclassified.
  it('names exactly the eleven tenant-only targets', () => {
    expect([...TENANT_ONLY_TARGETS].sort()).toEqual([
      'accessibility_need', 'area_preference', 'evictions', 'housingAuthority', 'max_tenant_portion',
      'pets', 'porting', 'preferences_constraints', 'status', 'tenure', 'voucherSize',
    ]);
  });

  // R1 code review, backend finding 7 - a drift guard. TENANT_ONLY_TARGETS is
  // a literal list beside extraction's own tenant-fact rule, so a NEW
  // extractable field must be classified on purpose: every target an accept
  // can commit is tenant-only (refused on a non-tenant, fenced) or neutral,
  // exactly once, and this fails until someone decides which.
  // The neutral set, by name: spec 2026-10-12 section 1, I1 ("Neutral
  // targets (firstName, lastName, phone, address) are not affected").
  const NEUTRAL_TARGETS: ReadonlySet<string> = new Set(['firstName', 'lastName', 'phone', 'address']);
  // Every target an accept can commit, derived from the live code: the
  // extractable fields (extraction/schema.ts), status, and the rest of the
  // run's decision targets (extraction/runTypes.ts) - minus `type`, which is
  // never accepted (accept_type_via_triage).
  const ACCEPTABLE_TARGETS: readonly string[] = [
    ...new Set<string>([
      ...EXTRACTABLE_FIELDS,
      'status',
      ...DECISION_TARGETS.filter((target) => target !== 'type'),
    ]),
  ];

  it('classifies every target an accept can commit EXACTLY ONCE - tenant-only or neutral', () => {
    const unclassified = ACCEPTABLE_TARGETS.filter(
      (target) => !TENANT_ONLY_TARGETS.has(target) && !NEUTRAL_TARGETS.has(target),
    );
    const both = ACCEPTABLE_TARGETS.filter(
      (target) => TENANT_ONLY_TARGETS.has(target) && NEUTRAL_TARGETS.has(target),
    );
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
  });

  it('classifies only targets an accept can commit', () => {
    const acceptable = new Set(ACCEPTABLE_TARGETS);
    expect([...TENANT_ONLY_TARGETS, ...NEUTRAL_TARGETS].filter((target) => !acceptable.has(target))).toEqual([]);
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

describe('D1 change 3: a tenant-only accept is fenced on the classification it read', () => {
  it.each([
    ['housingAuthority', 'Atlanta Housing Authority'],
    ['voucherSize', '3'],
    ['pets', 'two cats'],
    ['evictions', 'none'],
    ['tenure', '2 years'],
    ['porting', 'true'],
    ['status', 'searching'],
  ])('a %s accept guards classification_revision as absent when the contact has none', async (target, suggestedValue) => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target, suggestedValue, conversationId: 'conv-1', runId: `run-${target}`,
    });
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');

    await accept(app, 'c1', target).expect(200);

    expect(guardOf(claim.mock.calls[0]?.[0].plan)['classification_revision']).toEqual({ exists: false });
  });

  it('guards the stored revision value when the contact has one', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { classification_revision: 3 });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');

    await accept(app, 'c1', 'pets').expect(200);

    expect(guardOf(claim.mock.calls[0]?.[0].plan)['classification_revision']).toEqual({ exists: true, value: 3 });
  });

  it.each([
    ['firstName', 'Tasha'],
    ['lastName', 'Williams'],
    ['address', '1 Main St'],
  ])('never fences the neutral %s target (PIN)', async (target, suggestedValue) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target, suggestedValue, conversationId: 'conv-1', runId: `run-${target}`,
      ...(target === 'address' && { suggestedAddress: { line1: '1 Main St' } }),
    });
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');

    await accept(app, 'c1', target).expect(200);

    expect(Object.keys(guardOf(claim.mock.calls[0]?.[0].plan))).not.toContain('classification_revision');
  });

  // R2-ADV-1 schedule B: the claim lands, the process dies before the commit,
  // the contact is converted, and recovery later finishes the journal.
  it('B (read): an authority claim that crashed, recovered by a suggestions read after a conversion, writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('active');
    await convert(app, 'c1').expect(200);
    expireActiveResolution(world, 'c1', 'housingAuthority');
    const emitsBefore = suggestionEmits(world);

    await list(app, 'c1').expect(200);

    const contact = contactOf(world, 'c1');
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
    // The journal consumed the chip, so the read still notifies every dashboard.
    expect(suggestionEmits(world)).toBe(emitsBefore + 1);
  });

  it('B (sweep): the same claim, recovered by the daily journal sweep after a conversion, writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    await convert(app, 'c1').expect(200);
    expireActiveResolution(world, 'c1', 'housingAuthority');

    const outcome = await sweepADayLater(world);

    expect(outcome.recovered).toBe(1);
    const contact = contactOf(world, 'c1');
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
  });

  it('a voucherSize claim that crashed, then a generic tenant -> landlord re-type, recovers without writing voucherSize', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'voucherSize', suggestedValue: '3', conversationId: 'conv-1', runId: 'run-voucher',
    });
    await accept(crashingApp(world), 'c1', 'voucherSize').expect(500);
    await patch(app, 'c1', { type: 'landlord' }).expect(200);
    expireActiveResolution(world, 'c1', 'voucherSize');

    await list(app, 'c1').expect(200);

    expect(contactOf(world, 'c1')).toMatchObject({ type: 'landlord' });
    expect(contactOf(world, 'c1')?.['voucherSize']).toBeUndefined();
    expect(journalFor(world, 'c1', 'voucherSize')?.state).toBe('completed');
  });
});

describe('D1 change 4: a journal claimed before the deploy (no revision in its guard)', () => {
  it('recovered by a read onto a converted contact ends superseded and writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    stripRevisionFromJournal(world, 'c1', 'housingAuthority');
    await convert(app, 'c1').expect(200);
    expireActiveResolution(world, 'c1', 'housingAuthority');

    await list(app, 'c1').expect(200);

    expect(contactOf(world, 'c1')?.['housingAuthority']).toBeUndefined();
    expect(contactOf(world, 'c1')?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
  });

  it('recovered by a read onto an unconverted tenant still commits (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    stripRevisionFromJournal(world, 'c1', 'housingAuthority');
    expireActiveResolution(world, 'c1', 'housingAuthority');

    await list(app, 'c1').expect(200);

    expect(contactOf(world, 'c1')?.['housingAuthority']).toBe('Atlanta Housing Authority');
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
  });
});

describe('D1 change 5: the requester of a refused accept hears 409 suggestion_contact_reclassified', () => {
  it('A: an authority accept paused at claimed, then a conversion, answers 409 and writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    const setVerdict = vi.spyOn(world.aiRuns, 'setVerdict');
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'housingAuthority').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    const contact = contactOf(world, 'c1');
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
    // The run log records it exactly as a human-edit refusal (spec D1 change 5).
    expect(setVerdict).toHaveBeenCalledWith(
      'run-ha', 'housingAuthority', 'superseded_by_human_edit', expect.anything(),
    );
  });

  it('A: a voucherSize accept spanning a generic tenant -> landlord re-type answers 409 reclassified', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'voucherSize', suggestedValue: '3', conversationId: 'conv-1', runId: 'run-voucher',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'voucherSize').then((res) => res);
    await paused.atClaim;
    await patch(app, 'c1', { type: 'landlord' }).expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    expect(contactOf(world, 'c1')).toMatchObject({ type: 'landlord' });
    expect(contactOf(world, 'c1')?.['voucherSize']).toBeUndefined();
    expect(journalFor(world, 'c1', 'voucherSize')?.state).toBe('completed');
  });

  it('A: a status accept spanning a conversion answers reclassified - classification wins the tie with status', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'status').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    // The conversion's own status stands; the accepted one was never written.
    expect(contactOf(world, 'c1')).toMatchObject({ type: 'partner', status: 'active' });
  });

  it('A: an accept over a prior authority spanning a conversion answers reclassified - classification wins the tie with the field', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world, {
      housingAuthority: 'DeKalb County Housing Authority',
      housingAuthority_source: { source: 'manual', at: '2026-09-01T00:00:00.000Z' },
    });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'housingAuthority').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    expect(contactOf(world, 'c1')?.['housingAuthority']).toBeUndefined();
  });

  it('A: an address accept claimed before the conversion still commits onto the caseworker (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'address', suggestedValue: '1 Main St',
      suggestedAddress: { line1: '1 Main St' }, conversationId: 'conv-1', runId: 'run-address',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'address').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(contactOf(world, 'c1')).toMatchObject({ type: 'partner', address: { line1: '1 Main St' } });
  });

  it('A: a phone accept claimed before the conversion still commits (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550102020', conversationId: 'conv-1', runId: 'run-phone',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'phone').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(200);
    const phones = (contactOf(world, 'c1')?.['phones'] as Array<{ phone: string }> | undefined) ?? [];
    expect(phones.map((entry) => entry.phone)).toContain('+15550102020');
  });
});

describe('D1 change 6: the suggestions route notifies dashboards of a reclassification refusal', () => {
  it('emits suggestion.updated once for 409 suggestion_contact_reclassified - claim() consumed the chip', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'housingAuthority').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);
    // Counted AFTER the conversion, so only the accept's own answer is measured.
    const emitsBefore = suggestionEmits(world);

    paused.release();
    const res = await pending;

    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    expect(await world.extractionRepo.getSuggestion('c1', 'housingAuthority')).toBeUndefined();
    expect(suggestionEmits(world)).toBe(emitsBefore + 1);
  });

  it('emits nothing for 409 suggestion_contact_not_tenant - nothing was consumed (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-ll', runId: 'run-pets',
    });
    const emitsBefore = suggestionEmits(world);

    const res = await accept(app, 'c-ll', 'pets');

    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    expect(suggestionEmits(world)).toBe(emitsBefore);
  });
});

// Tracker #30 (D6): an AI status suggestion of active on an unknown contact is
// refused on the accept path with that path's EXISTING response - status is a
// tenant-only target, so the 409 fires before the type-scoped allowlist.
describe('status accept on an unknown contact (tracker #30, D6)', () => {
  it('(PIN) refuses a status suggestion of active on an unknown contact with 409 suggestion_contact_not_tenant and keeps the chip', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-unk', type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c-unk', target: 'status', suggestedValue: 'active', conversationId: 'conv-unk', runId: 'run-unk-status',
    });
    const emitsBefore = suggestionEmits(world);

    const res = await accept(app, 'c-unk', 'status');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    expect(await world.extractionRepo.getSuggestion('c-unk', 'status')).toBeDefined();
    expect(journalsFor(world, 'c-unk')).toEqual([]);
    expect(contactOf(world, 'c-unk')?.status).toBe('needs_review');
    expect(suggestionEmits(world)).toBe(emitsBefore);
  });
});
