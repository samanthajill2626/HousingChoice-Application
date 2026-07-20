// conversation-fact-extraction (T8): the review API +
//   GET  /api/contacts/:contactId/suggestions
//   POST /api/contacts/:contactId/suggestions/:target/accept
//   POST /api/contacts/:contactId/suggestions/:target/dismiss
// plus the PATCH /api/contacts/:contactId provenance-clear + suggestion cleanup.
//
// Drives the FULL loop against the world fakes (supertest + createFakeWorld) so
// accept writes the value + `<field>_source` provenance, routes status through
// the ONE transition service, mirrors the POST /phones behavior for a phone
// accept, refuses a `type` accept, and a human PATCH supersedes both the AI
// provenance and any pending suggestion.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import type { SuggestionItem } from '../src/repos/extractionRepo.js';

const SECRET = ORIGIN_SECRET;
const ACTOR = 'usr_testva00000000000000000';

type World = ReturnType<typeof createFakeWorld>;

function seedTenant(world: World, over: Record<string, unknown> = {}): string {
  const contactId = (over['contactId'] as string) ?? 'c-sugg-1';
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
  world: World,
  s: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
): Promise<void> {
  await world.extractionRepo.putSuggestion(s);
}

function get(app: import('express').Express, contactId: string) {
  return request(app)
    .get(`/api/contacts/${contactId}/suggestions`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}
function accept(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/accept`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}
function dismiss(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/dismiss`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

describe('GET /api/contacts/:contactId/suggestions', () => {
  it('returns the pending suggestions for the contact', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'voucherSize',
      currentValue: '2',
      suggestedValue: '3',
      reason: 'said needs a 3 bed',
      conversationId: 'conv-1',
    });
    const res = await get(app, contactId);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0]).toMatchObject({
      target: 'voucherSize',
      suggestedValue: '3',
      currentValue: '2',
    });
  });

  it('returns an empty array when the contact has no suggestions', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    const res = await get(app, contactId);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });
});

describe('POST /api/contacts/:contactId/suggestions/:target/accept', () => {
  it('accepts a field suggestion: writes the value + ai provenance, deletes it, returns the updated contact + remaining', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world); // no pets value yet
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'pets',
      suggestedValue: 'yes',
      reason: 'said has a dog',
      conversationId: 'conv-9',
      tsMsgId: 'ts-9',
    });
    const res = await accept(app, contactId, 'pets');
    expect(res.status).toBe(200);
    expect(res.body.contact.pets).toBe('yes');
    // Provenance stamped with source 'ai' + the accepting actor.
    expect(res.body.contact.pets_source).toMatchObject({
      source: 'ai',
      conversationId: 'conv-9',
      tsMsgId: 'ts-9',
      accepted_by: ACTOR,
    });
    // Suggestion deleted -> not in the returned remaining list.
    expect(res.body.suggestions).toEqual([]);
    // Store side: the contact really carries the value + the suggestion is gone.
    expect(world.contacts.find((c) => c.contactId === contactId)?.pets).toBe('yes');
    expect(await world.extractionRepo.getSuggestion(contactId, 'pets')).toBeUndefined();
    // Audited ai_suggestion_accepted with from/to.
    const audit = world.auditEvents.find((e) => e.event_type === 'ai_suggestion_accepted');
    expect(audit?.entityKey).toBe(`contacts#${contactId}`);
    expect(audit?.payload).toMatchObject({ target: 'pets', to: 'yes' });
    expect(audit?.payload?.['actor']).toBe(ACTOR);
    // Emits suggestion.updated.
    expect(world.emitted.some((e) => e.event === 'suggestion.updated')).toBe(true);
  });

  it('coerces voucherSize to an integer on accept (like apply.ts)', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world, { voucherSize: 2 });
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'voucherSize',
      currentValue: '2',
      suggestedValue: '3',
      conversationId: 'conv-2',
    });
    const res = await accept(app, contactId, 'voucherSize');
    expect(res.status).toBe(200);
    expect(res.body.contact.voucherSize).toBe(3); // number, not '3'
    expect(world.contacts.find((c) => c.contactId === contactId)?.voucherSize).toBe(3);
  });

  it('routes a status suggestion through the transition service (status + status_source ai)', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world, { status: 'onboarding' });
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'status',
      currentValue: 'onboarding',
      suggestedValue: 'searching',
      conversationId: 'conv-3',
    });
    const res = await accept(app, contactId, 'status');
    expect(res.status).toBe(200);
    expect(res.body.contact.status).toBe('searching');
    expect(res.body.contact.status_source).toBe('ai');
    expect(await world.extractionRepo.getSuggestion(contactId, 'status')).toBeUndefined();
    // The transition service's audit fired.
    const audit = world.auditEvents.find((e) => e.event_type === 'tenant_status_changed');
    expect(audit?.payload).toMatchObject({ to: 'searching', source: 'ai' });
  });

  it('accepts a phone suggestion: adds the number, audits contact_phone_added, deletes the suggestion', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'phone',
      suggestedValue: '+15550102020',
      conversationId: 'conv-4',
    });
    const res = await accept(app, contactId, 'phone');
    expect(res.status).toBe(200);
    expect(res.body.contact.phones.some((p: { phone: string }) => p.phone === '+15550102020')).toBe(true);
    expect(await world.extractionRepo.getSuggestion(contactId, 'phone')).toBeUndefined();
    const audit = world.auditEvents.find((e) => e.event_type === 'contact_phone_added');
    expect(audit?.payload).toMatchObject({ phone: '+15550102020' });
    // number_added milestone recorded (mirror POST /phones).
    expect(world.activityEvents.some((e) => e.type === 'number_added')).toBe(true);
  });

  it('409s a phone accept whose number belongs to another contact, KEEPING the suggestion', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    // Another contact already owns the number.
    world.contacts.push({
      contactId: 'c-other',
      type: 'tenant',
      status: 'active',
      phone: '+15550102020',
      created_at: '2026-07-01T10:00:00.000Z',
    });
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'phone',
      suggestedValue: '+15550102020',
      conversationId: 'conv-5',
    });
    const res = await accept(app, contactId, 'phone');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('phone_in_use');
    // Suggestion NOT deleted.
    expect(await world.extractionRepo.getSuggestion(contactId, 'phone')).toBeDefined();
  });

  it('refuses a type accept (400 accept_type_via_triage) - triage owns type', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'type',
      currentValue: 'unknown',
      suggestedValue: 'tenant',
      conversationId: 'conv-6',
    });
    const res = await accept(app, contactId, 'type');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('accept_type_via_triage');
  });

  it('404s an accept when there is no pending suggestion for the target', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    const res = await accept(app, contactId, 'pets');
    expect(res.status).toBe(404);
  });

  it('404s an accept for an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await accept(app, 'nope', 'pets');
    expect(res.status).toBe(404);
  });

  it('accepts an address suggestion: writes parts + provenance, audits, deletes', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world); // no address yet
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'address',
      suggestedValue: '1 Main St, Atlanta',
      suggestedAddress: { line1: '1 Main St', city: 'Atlanta' },
      conversationId: 'conv-addr',
      tsMsgId: 'ts-9',
    });
    const res = await accept(app, contactId, 'address');
    expect(res.status).toBe(200);
    // The contact carries the cleaned parts object (edit-form-identical shape).
    expect(res.body.contact.address).toEqual({ line1: '1 Main St', city: 'Atlanta' });
    // Provenance stamped source 'ai' + the accepting actor.
    expect(res.body.contact.address_source).toMatchObject({
      source: 'ai',
      conversationId: 'conv-addr',
      tsMsgId: 'ts-9',
      accepted_by: ACTOR,
    });
    // Suggestion deleted -> not in the remaining list.
    expect(res.body.suggestions).toEqual([]);
    // Store side: the contact really carries the parts + the suggestion is gone.
    expect(world.contacts.find((c) => c.contactId === contactId)?.address).toEqual({
      line1: '1 Main St',
      city: 'Atlanta',
    });
    expect(await world.extractionRepo.getSuggestion(contactId, 'address')).toBeUndefined();
    // Audited ai_suggestion_accepted with the FORMATTED to string; no from (empty).
    const audit = world.auditEvents.find((e) => e.event_type === 'ai_suggestion_accepted');
    expect(audit?.entityKey).toBe(`contacts#${contactId}`);
    expect(audit?.payload).toMatchObject({ target: 'address', to: '1 Main St, Atlanta' });
    expect(audit?.payload?.['actor']).toBe(ACTOR);
    expect(audit?.payload?.['from']).toBeUndefined();
    // Emits suggestion.updated.
    expect(world.emitted.some((e) => e.event === 'suggestion.updated')).toBe(true);
  });

  it('400s an address accept whose item carries no usable parts, KEEPING the suggestion', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    // Display string only, no suggestedAddress parts (malformed/legacy item).
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'address',
      suggestedValue: '1 Main St, Atlanta',
      conversationId: 'conv-addr',
    });
    const res = await accept(app, contactId, 'address');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_suggestion_value' });
    // Never half-writes: the suggestion is KEPT for the human to reconcile.
    expect(await world.extractionRepo.getSuggestion(contactId, 'address')).toBeDefined();
    expect(world.contacts.find((c) => c.contactId === contactId)?.address).toBeUndefined();
  });
});

describe('POST /api/contacts/:contactId/suggestions/:target/dismiss', () => {
  it('deletes the suggestion, audits ai_suggestion_dismissed, returns the remaining', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'pets',
      suggestedValue: 'yes',
      conversationId: 'conv-7',
    });
    const res = await dismiss(app, contactId, 'pets');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(await world.extractionRepo.getSuggestion(contactId, 'pets')).toBeUndefined();
    const audit = world.auditEvents.find((e) => e.event_type === 'ai_suggestion_dismissed');
    expect(audit?.entityKey).toBe(`contacts#${contactId}`);
    expect(audit?.payload).toMatchObject({ target: 'pets' });
    expect(audit?.payload?.['actor']).toBe(ACTOR);
  });

  it('404s a dismiss for an unknown target', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    const res = await dismiss(app, contactId, 'pets');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/contacts/:contactId - human edit clears AI provenance + pending suggestions', () => {
  it('a human pets edit clears pets_source AND deletes the pending pets suggestion', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world, {
      pets: 'yes',
      pets_source: { source: 'ai', at: '2026-07-16T00:00:00.000Z', conversationId: 'conv-x' },
    });
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'pets',
      currentValue: 'yes',
      suggestedValue: 'no',
      conversationId: 'conv-x',
    });
    const res = await request(app)
      .patch(`/api/contacts/${contactId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ pets: 'no' });
    expect(res.status).toBe(200);
    expect(res.body.contact.pets).toBe('no');
    // Provenance REMOVED (human edit supersedes AI).
    expect('pets_source' in res.body.contact).toBe(false);
    expect(world.contacts.find((c) => c.contactId === contactId)?.['pets_source']).toBeUndefined();
    // Pending suggestion deleted.
    expect(await world.extractionRepo.getSuggestion(contactId, 'pets')).toBeUndefined();
  });

  it('a type triage PATCH deletes the pending type suggestion', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world, {
      contactId: 'c-unknown',
      type: 'unknown',
      status: 'needs_review',
    });
    await seedSuggestion(world, {
      ownerContactId: contactId,
      target: 'type',
      currentValue: 'unknown',
      suggestedValue: 'tenant',
      conversationId: 'conv-t',
    });
    const res = await request(app)
      .patch(`/api/contacts/${contactId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant' });
    expect(res.status).toBe(200);
    expect(await world.extractionRepo.getSuggestion(contactId, 'type')).toBeUndefined();
  });
});
