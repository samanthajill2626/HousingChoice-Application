// Task 4: vocabulary repo + write-path + GET /api/contacts/vocabulary
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

it('records role/relationship/field vocabulary on create and serves it', async () => {
  const { app, world } = makeWebhookHarness();
  await request(app).post('/api/contacts').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)
    .send({ type: 'tenant', role: 'Case worker', relationships: [{ role: 'Client', name: 'T' }], customFields: [{ label: 'Agency', value: 'AH' }] });
  const res = await request(app).get('/api/contacts/vocabulary').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
  expect(res.status).toBe(200);
  expect(res.body.vocabulary).toEqual({ roles: ['Case worker'], relationshipRoles: ['Client'], fieldLabels: ['Agency'] });
  expect(world.vocabularyAdds.length).toBeGreaterThan(0); // best-effort write happened
});

describe('vocabulary accumulation', () => {
  it('dedupes and sorts vocabulary across multiple creates', async () => {
    const { app, world } = makeWebhookHarness();
    // First create
    await request(app).post('/api/contacts').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', role: 'Navigator', relationships: [], customFields: [{ label: 'Zip', value: '12345' }] });
    // Second create with overlapping + new values
    await request(app).post('/api/contacts').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', role: 'Navigator', relationships: [{ role: 'Manager', name: 'Bob' }], customFields: [{ label: 'Agency', value: 'X' }] });
    const res = await request(app).get('/api/contacts/vocabulary').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    // roles: deduped 'Navigator'; fieldLabels: sorted ['Agency', 'Zip']
    expect(res.body.vocabulary.roles).toEqual(['Navigator']);
    expect(res.body.vocabulary.fieldLabels).toEqual(['Agency', 'Zip']);
    expect(res.body.vocabulary.relationshipRoles).toEqual(['Manager']);
    expect(world.vocabularyAdds.length).toBe(2);
  });

  it('vocabulary GET returns empty arrays when nothing has been created', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/contacts/vocabulary').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.vocabulary).toEqual({ roles: [], relationshipRoles: [], fieldLabels: [] });
  });
});
