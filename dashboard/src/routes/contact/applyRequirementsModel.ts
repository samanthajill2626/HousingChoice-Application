// applyRequirementsModel - the pure rules behind "Apply to properties"
// (property requirements spec 2026-10-20, D8 dialog B), kept apart from the
// dialog so each rule is tested on its own: which CHECKED items would change on
// a property (by interpreted value, D1), which of those are the property's OWN
// values (the D6 definition - never what a card happens to display), each
// row's starting state and the hand rules, the request body, the batching and
// the copy. Staff copy says "property" (GLOSSARY).
import type { ApplyRequirementsBody, ApplyRequirementsResult, Contact, UnitItem } from '../../api/index.js';
import {
  REQUIREMENT_ITEMS,
  isItemBlank,
  isOwnValue,
  itemValuesEqual,
  landlordItemValue,
  readRequirementSources,
  unitItemValue,
  type ItemValue,
  type RequirementItemId,
} from '../listing/requirements.js';
import { formatAddress } from './format.js';

/** Mirror of the server's cap on one Apply request (plan 2.4: more than 100
 *  units is a 400). The dialog sends the checked properties in batches of it. */
export const APPLY_BATCH_SIZE = 100;

/** One property row of "Which properties". */
export interface ApplyRow {
  unitId: string;
  /** The CHECKED items whose value would change here, in display order. */
  changes: RequirementItemId[];
  /** The subset of `changes` that is an own value here (D6). */
  own: RequirementItemId[];
  /** Nothing would change: "Already matches", and the row cannot be checked. */
  alreadyMatches: boolean;
}

/** Hand choices by unitId: true = checked by hand, false = unchecked by hand. */
export type HandChoices = ReadonlyMap<string, boolean>;

/** D8: items with a value start checked; blank items start unchecked ("Clears"). */
export function defaultCheckedItems(landlord: Contact): Set<RequirementItemId> {
  return new Set(
    REQUIREMENT_ITEMS.filter((item) => !isItemBlank(landlordItemValue(landlord, item.id))).map((item) => item.id),
  );
}

/** Worklist OR-17: the left column after the re-read that follows an Update
 *  that STOPPED (a later batch answered 409 or failed) or whose FIRST request
 *  failed other than with 409 requirements_changed. "Review the rest and press
 *  Update again" continues the same Apply, so the items staff chose stay
 *  chosen - but only those the re-read landlord still holds: an item staff
 *  unchecked stays unchecked (it may be one staff deliberately left out, such
 *  as Touring), and an item the landlord has since blanked comes back
 *  unchecked, never a surprise "Clears". It only ever copies LESS than staff
 *  chose. On open, on Try again with nothing carried, and after a first-request
 *  409 requirements_changed the dialog starts from defaultCheckedItems instead. */
export function carryCheckedItems(
  previous: ReadonlySet<RequirementItemId>,
  landlord: Contact,
): Set<RequirementItemId> {
  return new Set([...defaultCheckedItems(landlord)].filter((id) => previous.has(id)));
}

/** The checked items in display order - the order the request lists them. */
export function orderedItems(checked: ReadonlySet<RequirementItemId>): RequirementItemId[] {
  return REQUIREMENT_ITEMS.map((item) => item.id).filter((id) => checked.has(id));
}

/** Every row, recomputed from the checked items (D8: live). */
export function applyRows(
  units: readonly UnitItem[],
  landlord: Contact,
  checked: ReadonlySet<RequirementItemId>,
): ApplyRow[] {
  const items = orderedItems(checked);
  return units.map((unit) => {
    const sources = readRequirementSources(unit['requirement_sources']);
    const changes = items.filter((id) => !itemValuesEqual(unitItemValue(unit, id), landlordItemValue(landlord, id)));
    const own = changes.filter((id) => isOwnValue(sources, id, unitItemValue(unit, id)));
    return { unitId: unit.unitId, changes, own, alreadyMatches: changes.length === 0 };
  });
}

/** D8 row state: never checked when it already matches; a hand choice wins;
 *  otherwise checked exactly when no changing item is an own value. */
export function rowIsChecked(row: ApplyRow, hand: HandChoices): boolean {
  if (row.alreadyMatches) return false;
  const chosen = hand.get(row.unitId);
  if (chosen !== undefined) return chosen;
  return row.own.length === 0;
}

/** D8, across a left-column change: a row that becomes "Already matches"
 *  drops its hand choice; a row CHECKED by hand drops it (back to the starting
 *  state, which is then unchecked) when the change ADDS an own-value item to
 *  it - staff confirm it again; removing items never resets it; a row
 *  UNCHECKED by hand stays unchecked. */
export function carryHandChoices(
  hand: HandChoices,
  before: readonly ApplyRow[],
  after: readonly ApplyRow[],
): Map<string, boolean> {
  const previous = new Map(before.map((row) => [row.unitId, row]));
  const next = new Map<string, boolean>();
  for (const row of after) {
    const chosen = hand.get(row.unitId);
    if (chosen === undefined || row.alreadyMatches) continue;
    const was = previous.get(row.unitId);
    const gainedOwn = was !== undefined && row.own.some((id) => !was.own.includes(id));
    if (chosen && gainedOwn) continue;
    next.set(row.unitId, chosen);
  }
  return next;
}

/** Split a list into consecutive batches of at most `size`. */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One request (plan 2.4): the batch's rows with the changing items shown as
 *  their own values (the ones staff accepted by checking the row), the checked
 *  items, and for each item every key as the dialog showed the landlord's
 *  value (null for blank). */
export function applyRequestBody(
  rows: readonly ApplyRow[],
  items: readonly RequirementItemId[],
  landlord: Contact,
): ApplyRequirementsBody {
  const expected: Partial<Record<RequirementItemId, ItemValue>> = {};
  for (const id of items) expected[id] = landlordItemValue(landlord, id);
  return {
    units: rows.map((row) => ({ unitId: row.unitId, ownItems: [...row.own] })),
    items: [...items],
    expected,
  };
}

/** Plan 1.1: the plain words for each skip reason. A Map, so an inherited name
 *  such as `toString` never matches. */
const SKIP_REASON_COPY: ReadonlyMap<string, string> = new Map([
  ['changed_since_opened', 'changed since you opened this - review it again'],
  ['changed_during_apply', 'changed since you opened this - review it again'],
  ['already_matches', 'already matches'],
  ['landlord_changed', 'has a different landlord now'],
  ['deleted', 'was deleted'],
  ['not_found', 'no longer exists'],
]);
export function skipReasonCopy(reason: string): string {
  return SKIP_REASON_COPY.get(reason) ?? reason.replace(/_/g, ' ');
}

/** What the landlord page shows when an Apply finishes (D8). */
export interface ApplyDoneSummary {
  updated: number;
  skipped: Array<{ unitId: string; address: string; reason: string }>;
}

/** A property's address, else its id (the done message's `<address>`). */
export function unitAddress(unit: UnitItem | undefined, unitId: string): string {
  return (unit !== undefined ? formatAddress(unit.address) : '') || unitId;
}

/** The property's label exactly as the landlord page's Properties card shows
 *  it - "address - NBR" when the bedrooms are known (LandlordFile renders its
 *  rows through this, Task 6.8). The Apply dialog's row checkbox is named by
 *  it, so a property reads the same on the page and in the dialog (planner
 *  ruling on accessible names). */
export function propertyRowLabel(unit: UnitItem): string {
  const beds = typeof unit.beds === 'number' ? ` - ${unit.beds}BR` : '';
  return `${unitAddress(unit, unit.unitId)}${beds}`;
}

/** Merge the batch responses; name each skipped property from the rows the
 *  dialog read. */
export function summarizeApply(results: readonly ApplyRequirementsResult[], units: readonly UnitItem[]): ApplyDoneSummary {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  return {
    updated: results.reduce((n, result) => n + result.updated.length, 0),
    skipped: results.flatMap((result) =>
      result.skipped.map((s) => ({
        unitId: s.unitId,
        address: unitAddress(byId.get(s.unitId), s.unitId),
        reason: skipReasonCopy(s.reason),
      })),
    ),
  };
}

/** "1 property" / "N properties". */
export function propertiesCount(n: number): string {
  return `${n} ${n === 1 ? 'property' : 'properties'}`;
}
/** Plan 1.1: `Update <N> properties` (`Update 1 property`). */
export function updateButtonLabel(n: number): string {
  return `Update ${propertiesCount(n)}`;
}
/** Plan 1.1: `Updated <N> properties` (`Updated 1 property`). */
export function doneHeadline(n: number): string {
  return `Updated ${propertiesCount(n)}`;
}
/** Plan 1.1, stopped mid-run (singular per CI-6). */
export function stoppedNotice(n: number): string {
  return `Updated ${propertiesCount(n)} before this stopped. Review the rest and press Update again.`;
}
/** Plan 1.1: the first request answered 409 requirements_changed. */
export const REQUIREMENTS_CHANGED_NOTICE =
  "This landlord's requirements changed. Review the updated list and press Update again.";
/** CI-5 (proposed): the first request failed any other way. */
export const APPLY_FAILED_NOTICE = "Couldn't update the properties. Review the list and press Update again.";
/** Worklist OR-31 (code review RD-1): ANY request answered 409
 *  deposit_conflict - the landlord record holds both deposit forms, so every
 *  further request would be refused the same way until the landlord's
 *  requirements are fixed. */
export const DEPOSIT_CONFLICT_NOTICE =
  "This landlord's deposit is set to both one month's rent and a fixed amount. Fix it with Edit requirements, then press Update again.";
/** Plan 1.1: the dialog's load error. */
export const APPLY_LOAD_ERROR = "Couldn't load this landlord's properties.";
/** Plan 1.1: why Apply to properties is disabled. */
export const APPLY_NO_PROPERTIES_REASON = 'This landlord has no properties yet.';
