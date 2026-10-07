// Spec 2026-10-06 D8: accepting a housingAuthority suggestion writes a NAME
// from the organization list. The server checks the suggestion's text against
// the CURRENT list while the replay plan is built - BEFORE the claim - so a
// refusal never consumes the suggestion.
import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { createLogger } from '../src/lib/logger.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import type { AiRunsRepo } from '../src/repos/aiRunsRepo.js';
import type { ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ExtractionRepo, SuggestionItem } from '../src/repos/extractionRepo.js';
import type { OrgListItem } from '../src/repos/orgListRepo.js';
import {
  resolutionValueKey,
  type CompletedSuggestionResolution,
  type SuggestionResolutionRepo,
} from '../src/repos/suggestionResolutionRepo.js';
import { createSuggestionResolutionService } from '../src/services/suggestionResolution.js';

type World = ReturnType<typeof makeWebhookHarness>['world'];

const NOW = '2026-10-06T00:00:00.000Z';
const CONTACT = 'c-org-accept';

/** The starting list (spec Appendix A) plus any extra entries, as a stored item. */
function storedList(extra: OrgEntry[] = []): OrgListItem {
  let n = 0;
  return {
    settingId: 'org-list',
    version: 1,
    entries: [...buildStartingEntries(NOW, () => `org-${(n += 1)}`), ...extra],
  };
}

function authority(name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`, kind: 'housing_authority', name, spellings,
    createdAt: NOW, createdBy: 'test', updatedAt: NOW, updatedBy: 'test',
  };
}

/** A tenant with one pending suggestion; returns the request identity. */
async function setup(suggestedValue: string, opts: { target?: string; list?: OrgListItem } = {}) {
  const { app, world } = makeWebhookHarness();
  await world.orgListRepo.putForSeed(opts.list ?? storedList());
  world.contacts.push({
    contactId: CONTACT,
    type: 'tenant',
    status: 'onboarding',
    phone: '+15550100001',
    created_at: '2026-07-01T10:00:00.000Z',
  });
  const target = opts.target ?? 'housingAuthority';
  await world.extractionRepo.putSuggestion({
    ownerContactId: CONTACT,
    target,
    suggestedValue,
    reason: 'client said so',
    conversationId: 'conv-org',
    tsMsgId: 'ts-org',
  });
  const stored = await world.extractionRepo.getSuggestion(CONTACT, target);
  if (stored === undefined) throw new Error('suggestion not stored');
  const identity = {
    createdAt: stored.createdAt,
    ...(stored.revision !== undefined && { revision: stored.revision }),
    ...(stored.runId !== undefined && { runId: stored.runId }),
  };
  return { app, world, target, identity };
}

function post(
  app: import('express').Express,
  target: string,
  action: 'accept' | 'dismiss',
  body: Record<string, unknown>,
) {
  return request(app)
    .post(`/api/contacts/${CONTACT}/suggestions/${target}/${action}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function storedAuthority(world: World): unknown {
  return world.contacts.find((c) => c.contactId === CONTACT)?.['housingAuthority'];
}

describe('accepting a housingAuthority suggestion (spec 2026-10-06 D8)', () => {
  it('writes the full list name when the text is a unique spelling', async () => {
    const { app, world, target, identity } = await setup('Atlanta (AHA)');
    const res = await post(app, target, 'accept', identity);
    expect(res.status).toBe(200);
    expect(res.body.contact.housingAuthority).toBe('Atlanta Housing Authority');
    expect(res.body.contact.housingAuthority_source).toMatchObject({ source: 'ai', conversationId: 'conv-org' });
    expect(storedAuthority(world)).toBe('Atlanta Housing Authority');
    const audit = world.auditEvents.find((e) => e.event_type === 'ai_suggestion_accepted');
    expect(audit?.payload).toMatchObject({ target: 'housingAuthority', to: 'Atlanta Housing Authority' });
  });

  it('writes an exact list name as it is (PIN)', async () => {
    const { app, world, target, identity } = await setup('Marietta Housing Authority');
    const res = await post(app, target, 'accept', identity);
    expect(res.status).toBe(200);
    expect(storedAuthority(world)).toBe('Marietta Housing Authority');
  });

  it('refuses a text that is not on the list with 422 org_not_on_list - before the claim', async () => {
    const { app, world, target, identity } = await setup('Metro HA');
    const res = await post(app, target, 'accept', identity);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'org_not_on_list', field: 'housingAuthority', text: 'Metro HA', candidates: [],
    });
    expect(Array.isArray(res.body.close)).toBe(true);
    expect(res.body.retryable).toBeUndefined();
    // Not consumed: still pending, nothing written, no journal row.
    expect(await world.extractionRepo.getSuggestion(CONTACT, target)).toBeDefined();
    expect(storedAuthority(world)).toBeUndefined();
    expect(world.suggestionResolutions.size).toBe(0);
  });

  it('refuses a shared abbreviation and names both candidates', async () => {
    const { app, target, identity } = await setup('AHA');
    const res = await post(app, target, 'accept', identity);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('org_not_on_list');
    expect(res.body.candidates.map((c: { name: string }) => c.name)).toEqual([
      'Atlanta Housing Authority',
      'Augusta Housing Authority',
    ]);
  });

  it('refuses an agency name and says which agency it is', async () => {
    const { app, target, identity } = await setup('Hope Atlanta');
    const res = await post(app, target, 'accept', identity);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'org_not_on_list',
      otherKind: [{ kind: 'agency', name: 'HOPE Atlanta' }],
    });
  });
});

describe('the accept value (spec 2026-10-06 D8)', () => {
  it('accepts one of a shared abbreviation\'s candidates', async () => {
    const { app, world, target, identity } = await setup('AHA');
    const res = await post(app, target, 'accept', { ...identity, value: 'Augusta Housing Authority' });
    expect(res.status).toBe(200);
    expect(storedAuthority(world)).toBe('Augusta Housing Authority');
  });

  it('accepts the name the text resolves to (PIN)', async () => {
    const { app, world, target, identity } = await setup('Atlanta (AHA)');
    const res = await post(app, target, 'accept', { ...identity, value: 'Atlanta Housing Authority' });
    expect(res.status).toBe(200);
    expect(storedAuthority(world)).toBe('Atlanta Housing Authority');
  });

  it('accepts a name staff just added from the text (PIN)', async () => {
    const { app, world, target, identity } = await setup('Metro HA', { list: storedList([authority('Metro HA')]) });
    const res = await post(app, target, 'accept', { ...identity, value: 'Metro HA' });
    expect(res.status).toBe(200);
    expect(storedAuthority(world)).toBe('Metro HA');
  });

  it('refuses a value that is not from the suggestion with 422 - keeping the suggestion', async () => {
    const { app, world, target, identity } = await setup('AHA');
    const res = await post(app, target, 'accept', { ...identity, value: 'Marietta Housing Authority' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'value_not_from_suggestion' });
    expect(await world.extractionRepo.getSuggestion(CONTACT, target)).toBeDefined();
    expect(world.suggestionResolutions.size).toBe(0);
  });

  it('refuses a value on any other target', async () => {
    const { app, world, target, identity } = await setup('two cats', { target: 'pets' });
    const res = await post(app, target, 'accept', { ...identity, value: 'one dog' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'value_not_from_suggestion' });
    expect(await world.extractionRepo.getSuggestion(CONTACT, target)).toBeDefined();
  });

  it('refuses a blank or non-string value with 400 invalid_suggestion_value', async () => {
    const { app, world, target, identity } = await setup('two cats', { target: 'pets' });
    for (const value of ['   ', 7]) {
      const res = await post(app, target, 'accept', { ...identity, value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_suggestion_value' });
    }
    expect(await world.extractionRepo.getSuggestion(CONTACT, target)).toBeDefined();
  });

  it('ignores a value on a dismiss (PIN)', async () => {
    const { app, world, target, identity } = await setup('two cats', { target: 'pets' });
    const res = await post(app, target, 'dismiss', { ...identity, value: 'anything' });
    expect(res.status).toBe(200);
    expect(await world.extractionRepo.getSuggestion(CONTACT, target)).toBeUndefined();
  });

  it('keeps only a hash of the value on the completed journal row', async () => {
    const { app, world, target, identity } = await setup('AHA');
    await post(app, target, 'accept', { ...identity, value: 'Augusta Housing Authority' }).expect(200);
    const rows = [...world.suggestionResolutions.values()];
    expect(rows).toEqual([{
      itemId: `resolve#${CONTACT}#housingAuthority`,
      state: 'completed',
      contactId: CONTACT,
      target: 'housingAuthority',
      identityKey: expect.any(String),
      action: 'accept',
      completedAt: expect.any(String),
      valueKey: createHash('sha256').update('Augusta Housing Authority', 'utf8').digest('hex'),
    }]);
    expect(JSON.stringify(rows)).not.toContain('Augusta');
  });

  it('replays a re-accept with the same value; a different or missing value is 409', async () => {
    const { app, target, identity } = await setup('AHA');
    await post(app, target, 'accept', { ...identity, value: 'Augusta Housing Authority' }).expect(200);
    expect((await post(app, target, 'accept', { ...identity, value: 'Augusta Housing Authority' })).status).toBe(200);
    const other = await post(app, target, 'accept', { ...identity, value: 'Atlanta Housing Authority' });
    expect(other.status).toBe(409);
    expect(other.body).toEqual({ error: 'suggestion_already_resolved' });
    const none = await post(app, target, 'accept', identity);
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: 'suggestion_already_resolved' });
  });

  it('a value-less re-accept of a value-less accept replays - absent equals absent (PIN)', async () => {
    const { app, target, identity } = await setup('Atlanta (AHA)');
    await post(app, target, 'accept', identity).expect(200);
    expect((await post(app, target, 'accept', identity)).status).toBe(200);
  });
});

describe('the claim-race twin compares the value key too (spec 2026-10-06 D8)', () => {
  // The journal can complete between resolve()'s completed-row read and its
  // claim; the claim then answers `completed`, and that branch must apply the
  // same value rule as the completed-row branch.
  function raceService(completedValueKey: string | undefined) {
    const suggestion: SuggestionItem = {
      itemId: `sugg#${CONTACT}#housingAuthority`,
      ownerContactId: CONTACT,
      target: 'housingAuthority',
      suggestedValue: 'AHA',
      conversationId: 'conv-org',
      createdAt: '2026-10-06T10:00:00.000Z',
      revision: 'rev-race',
      _pendingPartition: 'pending',
    };
    const completed: CompletedSuggestionResolution = {
      itemId: `resolve#${CONTACT}#housingAuthority`,
      state: 'completed',
      contactId: CONTACT,
      target: 'housingAuthority',
      identityKey: 'revision#rev-race',
      action: 'accept',
      completedAt: '2026-10-06T10:01:00.000Z',
      ...(completedValueKey !== undefined && { valueKey: completedValueKey }),
    };
    return createSuggestionResolutionService({
      contactsRepo: { getById: async () => ({ contactId: CONTACT, type: 'tenant' }) } as unknown as ContactsRepo,
      extractionRepo: { getSuggestion: async () => suggestion } as unknown as ExtractionRepo,
      aiRunsRepo: {} as AiRunsRepo,
      resolutionRepo: {
        get: async () => undefined,
        claim: async () => ({ status: 'completed', journal: completed }),
      } as unknown as SuggestionResolutionRepo,
      orgNamesService: { read: async () => storedList() },
      logger: createLogger({ destination: createLogCapture().stream }),
      now: () => '2026-10-06T10:02:00.000Z',
    });
  }
  const input = (value: string) => ({
    contactId: CONTACT,
    target: 'housingAuthority',
    action: 'accept' as const,
    identity: { createdAt: '2026-10-06T10:00:00.000Z', revision: 'rev-race' },
    value,
  });

  it('replays when the raced journal completed with the same value', async () => {
    const service = raceService(resolutionValueKey('Augusta Housing Authority'));
    await expect(service.resolve(input('Augusta Housing Authority')))
      .resolves.toEqual({ completedNow: false, helpedCommitted: false });
  });

  it('refuses 409 suggestion_already_resolved when it completed with a different value', async () => {
    const service = raceService(resolutionValueKey('Atlanta Housing Authority'));
    await expect(service.resolve(input('Augusta Housing Authority')))
      .rejects.toMatchObject({ status: 409, code: 'suggestion_already_resolved' });
  });
});
