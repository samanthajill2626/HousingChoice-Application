// property requirements (spec 2026-10-20): fixtures for the unit-requirement
// route suites on the FakeWorld harness - a landlord contact holding req_
// keys, a unit row, the New form's all-blank requirements_snapshot, the
// authed unit requests and Apply request, and the unit_updated audit rows.
import request from 'supertest';
import type { Express } from 'express';
import { REQUIREMENT_ITEMS, REQUIREMENT_ITEM_IDS } from '../../src/lib/requirements.js';
import type { ContactItem } from '../../src/repos/contactsRepo.js';
import type { UnitItem } from '../../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './authSession.js';
import { ORIGIN_SECRET, type FakeWorld } from './twilioWebhookHarness.js';

export const REQ_STAMP = '2026-10-20T09:00:00.000Z';

/** Every item 'copied': a create whose form left every pre-filled field as it was. */
export const ALL_COPIED: Record<string, 'copied'> = Object.fromEntries(
  REQUIREMENT_ITEM_IDS.map((id) => [id, 'copied'] as const),
);

/** A contact typed landlord holding `requirements` (req_ keys). */
export function seedLandlord(world: FakeWorld, contactId: string, requirements: Record<string, unknown> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', firstName: 'Lee', lastName: 'Lord', ...requirements } as ContactItem);
}

/** Any other contact. */
export function seedContact(world: FakeWorld, contactId: string, fields: Record<string, unknown>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

/** A unit owned by c-ll unless `fields` says otherwise; a field given as undefined is left OFF (`landlordId: undefined` = ownerless). */
export function seedUnit(world: FakeWorld, unitId: string, fields: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: REQ_STAMP,
    updated_at: REQ_STAMP,
    ...fields,
  };
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  world.units.set(unitId, row as UnitItem);
}

/** The New form's requirements_snapshot: every item with every key null (blank), then `items` over the top. */
export function snapshotOf(
  landlordId: string,
  items: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { landlordId };
  for (const item of REQUIREMENT_ITEMS) {
    snapshot[item.id] = {
      ...Object.fromEntries(item.fields.map((field) => [field.key, null] as const)),
      ...(items[item.id] ?? {}),
    };
  }
  return snapshot;
}

export function postUnit(app: Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/units')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

export function patchUnit(app: Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/units/${unitId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

export function getUnit(app: Express, unitId: string) {
  return request(app)
    .get(`/api/units/${unitId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

/** POST /api/contacts/:contactId/requirements/apply (D8), authed. */
export function postRequirementsApply(app: Express, contactId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/contacts/${encodeURIComponent(contactId)}/requirements/apply`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

/** The unit_updated audit rows, oldest first. */
export function unitUpdatedEvents(world: FakeWorld): FakeWorld['auditEvents'] {
  return world.auditEvents.filter((e) => e.event_type === 'unit_updated');
}
