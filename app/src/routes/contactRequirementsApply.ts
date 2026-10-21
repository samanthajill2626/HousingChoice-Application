// Apply to properties (property-requirements spec D8; plan 2.4):
//
//   POST /api/contacts/:contactId/requirements/apply
//        { units: [{ unitId, ownItems, seen }], items, expected }
//        -> 200 { updated: string[], skipped: [{ unitId, reason }] }
//
// Registered on the contacts router by createContactsRouter, like the
// caseworker-review routes (routes/caseworkerReview.ts). It copies the
// landlord's CURRENT values of the listed items onto each listed property that
// still has this landlord of record, in request order, ONE conditional write
// per property (unitsRepo.applyRequirements) - never one transaction, so a
// failure part way leaves the earlier properties applied. What each property
// gets is the pure planUnitApply (lib/requirements.ts); this route validates,
// refuses, reads, writes and audits. Refusals write nothing, in this order:
// 404 contact_not_found; 400 contact is not a landlord; 400 the body (items,
// expected, units, ownItems, seen); 409 deposit_conflict; 409 requirements_changed.
// The dashboard owns every sentence; it shows only the two 409s.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';
import {
  hasDepositConflict,
  isRequirementItemId,
  itemValuesEqual,
  landlordItemValue,
  planUnitApply,
  REQUIREMENT_ITEMS,
  type ApplySkipReason,
  type ItemValue,
  type RequirementItemId,
} from '../lib/requirements.js';
import type { AuthedRequest } from '../middleware/auth.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';

/** D8: the most properties one request may name (the dialog batches by it). */
const APPLY_UNITS_MAX = 100;

const E_ITEMS = 'items must be a non-empty array of requirement item ids';
const E_EXPECTED = 'expected must hold exactly the listed items, each with exactly its keys';
const E_EXPECTED_VALUE = 'expected values must be a string, a number, a boolean or null';
const E_UNITS = `units must be a non-empty array of at most ${APPLY_UNITS_MAX} properties`;
const E_UNIT_ID = 'each entry of units needs a unitId string';
const E_UNIT_REPEAT = 'units must not repeat a unitId';
const E_OWN_ITEMS = 'each entry of units needs ownItems, a list of items from items';
const E_SEEN =
  'each entry of units needs seen: exactly its ownItems, each with exactly its keys, each value a string, a number, a boolean or null';

export interface RequirementsApplyDeps {
  contacts: ContactsRepo;
  units: UnitsRepo;
  audit: AuditRepo;
  logger: Logger;
}

interface ApplyRequirementsRequest {
  items: RequirementItemId[];
  /** Per listed item, the landlord's value as the dialog showed it (unit keys; null = blank). */
  expected: Partial<Record<RequirementItemId, ItemValue>>;
  /** `seen` (planner ruling PR-1, code review PA-1): per ownItems item, the
   *  property's value as the dialog read it (unit keys; null = blank). */
  units: Array<{ unitId: string; ownItems: RequirementItemId[]; seen: Partial<Record<RequirementItemId, ItemValue>> }>;
}

/** Every unit key of each item, in registry order. */
const KEYS_OF_ITEM = new Map<RequirementItemId, readonly string[]>(
  REQUIREMENT_ITEMS.map((item) => [item.id, item.fields.map((field) => field.key)]),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One item's wire value - `expected` and `seen` alike: an object holding
 *  exactly the item's keys, each a string, a number, a boolean or null
 *  (false reads as blank, D1). 'shape' / 'value' name what was wrong. */
function parseItemValue(raw: unknown, id: RequirementItemId): ItemValue | 'shape' | 'value' {
  const keys = KEYS_OF_ITEM.get(id) ?? [];
  if (!isPlainObject(raw)) return 'shape';
  const rawKeys = Object.keys(raw);
  if (rawKeys.length !== keys.length || !keys.every((key) => rawKeys.includes(key))) return 'shape';
  const value: ItemValue = {};
  for (const key of keys) {
    const v = raw[key];
    if (v === null || v === false) value[key] = null; // D1: false is blank
    else if (v === true || typeof v === 'string' || typeof v === 'number') value[key] = v;
    else return 'value';
  }
  return value;
}

/** Validate the body, in plan 2.4's order: items, expected, units, ownItems,
 *  then (planner ruling PR-1) each entry's seen. */
function parseApplyRequirementsBody(body: unknown): ApplyRequirementsRequest | { error: string } {
  const b = isPlainObject(body) ? body : {};

  const rawItems = b['items'];
  if (!Array.isArray(rawItems) || rawItems.length === 0 || !rawItems.every(isRequirementItemId)) {
    return { error: E_ITEMS };
  }
  // A repeated item id names the same item: de-duplicated, not refused.
  const items: RequirementItemId[] = [...new Set(rawItems as RequirementItemId[])];
  const listed = new Set<string>(items);

  const rawExpected = b['expected'];
  if (!isPlainObject(rawExpected)) return { error: E_EXPECTED };
  const expectedIds = Object.keys(rawExpected);
  if (expectedIds.length !== items.length || !expectedIds.every((id) => listed.has(id))) {
    return { error: E_EXPECTED };
  }
  const expected: Partial<Record<RequirementItemId, ItemValue>> = {};
  for (const id of items) {
    const value = parseItemValue(rawExpected[id], id);
    if (value === 'shape') return { error: E_EXPECTED };
    if (value === 'value') return { error: E_EXPECTED_VALUE };
    expected[id] = value;
  }

  const rawUnits = b['units'];
  if (!Array.isArray(rawUnits) || rawUnits.length === 0 || rawUnits.length > APPLY_UNITS_MAX) {
    return { error: E_UNITS };
  }
  const unitIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawUnits) {
    const unitId = isPlainObject(entry) ? entry['unitId'] : undefined;
    if (typeof unitId !== 'string' || unitId.length === 0) return { error: E_UNIT_ID };
    if (seen.has(unitId)) return { error: E_UNIT_REPEAT };
    seen.add(unitId);
    unitIds.push(unitId);
  }
  const units: ApplyRequirementsRequest['units'] = [];
  for (const [index, entry] of rawUnits.entries()) {
    const ownItems: unknown = isPlainObject(entry) ? entry['ownItems'] : undefined;
    if (
      !Array.isArray(ownItems)
      || !ownItems.every((id): id is RequirementItemId => typeof id === 'string' && listed.has(id))
    ) {
      return { error: E_OWN_ITEMS };
    }
    const accepted = [...new Set(ownItems)];
    // Planner ruling PR-1 (code review PA-1): keyed by EXACTLY the entry's
    // ownItems, each the item's whole value as the dialog read the property.
    const rawSeen: unknown = isPlainObject(entry) ? entry['seen'] : undefined;
    if (!isPlainObject(rawSeen)) return { error: E_SEEN };
    const seenIds = Object.keys(rawSeen);
    if (seenIds.length !== accepted.length || !seenIds.every((id) => (accepted as string[]).includes(id))) {
      return { error: E_SEEN };
    }
    const seen: Partial<Record<RequirementItemId, ItemValue>> = {};
    for (const id of accepted) {
      const value = parseItemValue(rawSeen[id], id);
      if (typeof value === 'string') return { error: E_SEEN };
      seen[id] = value;
    }
    units.push({ unitId: unitIds[index] ?? '', ownItems: accepted, seen });
  }
  return { items, expected, units };
}

export function registerRequirementsApplyRoute(router: Router, deps: RequirementsApplyDeps): void {
  const log = deps.logger;

  router.post('/:contactId/requirements/apply', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    // CONSISTENT: both 409s below are decided against this read. A phone or
    // email pointer is a routing record, never a contact (the PATCH's rule).
    const landlord = await deps.contacts.getById(contactId, { consistentRead: true });
    if (landlord === undefined || landlord.phone_ref === true || landlord.email_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    if (landlord.type !== 'landlord') {
      res.status(400).json({ error: 'contact is not a landlord' });
      return;
    }
    const body = parseApplyRequirementsBody(req.body);
    if ('error' in body) {
      res.status(400).json({ error: body.error });
      return;
    }
    if (hasDepositConflict(landlord, 'landlord')) {
      log.info({ contactId }, 'requirements apply refused: deposit_conflict');
      res.status(409).json({ error: 'deposit_conflict' });
      return;
    }
    // The landlord's CURRENT value of every listed item must equal what the
    // dialog showed (D1 equality), or staff would copy values they never saw.
    const landlordValues: Partial<Record<RequirementItemId, ItemValue>> = {};
    for (const id of body.items) {
      const current = landlordItemValue(landlord, id);
      const shown = body.expected[id];
      if (shown === undefined || !itemValuesEqual(current, shown)) {
        log.info({ contactId, item: id }, 'requirements apply refused: requirements_changed');
        res.status(409).json({ error: 'requirements_changed' });
        return;
      }
      landlordValues[id] = current;
    }

    const actor = req.user?.userId;
    const updated: string[] = [];
    const skipped: Array<{ unitId: string; reason: ApplySkipReason }> = [];
    for (const { unitId, ownItems, seen } of body.units) {
      const raw = await deps.units.getById(unitId, { consistentRead: true });
      // The route's OWN copy of the consistent read (ruling AR6): a repo may
      // hand out its live stored object (the harness does), and the fence must
      // compare the stored unit with what was READ, not with whatever that
      // object has become by the time the write runs.
      const read = raw === undefined ? undefined : structuredClone(raw);
      const plan = planUnitApply({
        unit: read,
        landlordId: contactId,
        items: body.items,
        landlordValues,
        ownItems,
        seen,
      });
      // planUnitApply skips an unread unit as not_found; the `read` test only
      // narrows the type for the write below.
      if (plan.kind === 'skip' || read === undefined) {
        skipped.push({ unitId, reason: plan.kind === 'skip' ? plan.reason : 'not_found' });
        continue;
      }
      try {
        // Conditioned on the unit still existing, not deleted, with this
        // landlordId, the requirement_sources it was read with (plan 2.3) and
        // the read values of every item it copies (code review OR-29), so an
        // edit landing between the read and this write is never overwritten.
        await deps.units.applyRequirements(read, plan.patch);
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          skipped.push({ unitId, reason: 'changed_during_apply' });
          continue;
        }
        throw err; // Express 5 forwards async throws to the error handler.
      }
      updated.push(unitId);
      // One unit_updated per written unit (D13). Best-effort, like the other
      // multi-entity loops (services/primaryHandoff.ts): the write committed,
      // so a failed audit must not lose the report of what was applied.
      try {
        await deps.audit.append(`units#${unitId}`, 'unit_updated', {
          actor,
          fields: plan.changedKeys,
          reason: 'requirements_applied',
          landlordId: contactId,
        });
      } catch (err) {
        log.warn({ err, contactId, unitId }, 'requirements apply: audit append failed (best-effort)');
      }
    }
    log.info(
      { contactId, items: body.items.length, updated: updated.length, skipped: skipped.length, actor },
      'requirements applied via api',
    );
    res.json({ updated, skipped });
  });
}
