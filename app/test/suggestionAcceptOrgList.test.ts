// Spec 2026-10-06 D8: accepting a housingAuthority suggestion writes a NAME
// from the organization list. The server checks the suggestion's text against
// the CURRENT list while the replay plan is built - BEFORE the claim - so a
// refusal never consumes the suggestion.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import type { OrgListItem } from '../src/repos/orgListRepo.js';

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
