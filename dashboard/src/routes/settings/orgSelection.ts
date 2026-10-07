// orgSelection - what Settings > Housing authorities & agencies shows, read
// from and written to the URL (design review 2026-10-07 Option B, ruling 7):
// which of the three lists is on screen (the segment) and which entry or
// value the detail panel holds. Pure helpers, so the URL scheme is pinned in
// one place and tested without rendering the page.
//
// The URL scheme:
// - /settings/organizations                  the Housing authorities list
// - /settings/organizations?view=agencies    another list, nothing selected
//   (view = housing-authorities | agencies | not-on-list; the first is the
//   default and is left out)
// - /settings/organizations/<orgId>          one entry; its kind picks the list
// - /settings/organizations?view=not-on-list&field=<field>&value=<value>
//   one "Not on the list" value. A value has no id - it IS its field and its
//   exact stored text - so both ride as query parameters (any text survives
//   a query string; a path segment would have to carry "/" and "%").
import type { NotOnListRow, OrgEntry, OrgKind, OrgRecordField } from '../../api/index.js';
import { KIND_PLURAL_TITLE, normalizeOrgText } from '../orgs/orgCopy.js';

export const ORG_SETTINGS_PATH = '/settings/organizations';

export type OrgSegment = 'housing-authorities' | 'agencies' | 'not-on-list';

export const ORG_SEGMENTS: readonly OrgSegment[] = ['housing-authorities', 'agencies', 'not-on-list'];

const DEFAULT_SEGMENT: OrgSegment = 'housing-authorities';

export const SEGMENT_KIND: Readonly<Record<Exclude<OrgSegment, 'not-on-list'>, OrgKind>> = {
  'housing-authorities': 'housing_authority',
  agencies: 'agency',
};

/** Each list's title: its segment's label, its region's heading. */
export const SEGMENT_LABEL: Readonly<Record<OrgSegment, string>> = {
  'housing-authorities': KIND_PLURAL_TITLE.housing_authority,
  agencies: KIND_PLURAL_TITLE.agency,
  'not-on-list': 'Not on the list',
};

export function segmentForKind(kind: OrgKind): OrgSegment {
  return kind === 'agency' ? 'agencies' : 'housing-authorities';
}

const RECORD_FIELDS: readonly OrgRecordField[] = ['housingAuthority', 'agency', 'accepted_authorities'];

/** What the URL selects: an entry by id, a value by field and text, or nothing. */
export type OrgSelection =
  | { type: 'entry'; orgId: string }
  | { type: 'value'; field: OrgRecordField; value: string }
  | null;

export interface OrgLocation {
  /** The view the URL names (the default when it names none or an unknown one). */
  view: OrgSegment;
  selection: OrgSelection;
}

function isSegment(value: string | null): value is OrgSegment {
  return value !== null && (ORG_SEGMENTS as readonly string[]).includes(value);
}

function isRecordField(value: string | null): value is OrgRecordField {
  return value !== null && (RECORD_FIELDS as readonly string[]).includes(value);
}

/** Read the page's state from the route's `orgId` and the query string. */
export function readOrgLocation(orgId: string | undefined, params: URLSearchParams): OrgLocation {
  const viewParam = params.get('view');
  const view = isSegment(viewParam) ? viewParam : DEFAULT_SEGMENT;
  if (orgId !== undefined && orgId !== '') return { view, selection: { type: 'entry', orgId } };
  const field = params.get('field');
  const value = params.get('value');
  if (view === 'not-on-list' && isRecordField(field) && value !== null) {
    return { view, selection: { type: 'value', field, value } };
  }
  return { view, selection: null };
}

/** A list with nothing selected. */
export function listHref(segment: OrgSegment): string {
  return segment === DEFAULT_SEGMENT ? ORG_SETTINGS_PATH : `${ORG_SETTINGS_PATH}?view=${segment}`;
}

export function entryHref(orgId: string): string {
  return `${ORG_SETTINGS_PATH}/${encodeURIComponent(orgId)}`;
}

export function valueHref(field: OrgRecordField, value: string): string {
  const params = new URLSearchParams({ view: 'not-on-list', field, value });
  return `${ORG_SETTINGS_PATH}?${params.toString()}`;
}

/** One key per list row, for focus return: an entry by id, a value by field + text. */
export function entryKey(orgId: string): string {
  return `entry:${orgId}`;
}

export function valueKey(field: OrgRecordField, value: string): string {
  return `value:${JSON.stringify([field, value])}`;
}

export function selectionKey(selection: OrgSelection): string | null {
  if (selection === null) return null;
  return selection.type === 'entry' ? entryKey(selection.orgId) : valueKey(selection.field, selection.value);
}

/**
 * Does `text` contain the search `query`? Compared the way the lists compare
 * names (normalizeOrgText: case, punctuation and spacing ignored), so "dca"
 * finds "Georgia Dept. of Community Affairs" through its spelling "DCA". A
 * query that normalizes to nothing (only punctuation, e.g. "-") is matched as
 * plain lowercase text instead, so a placeholder value can still be found.
 */
function textMatches(text: string, query: string): boolean {
  const normalizedQuery = normalizeOrgText(query);
  if (normalizedQuery === '') return text.toLowerCase().includes(query.trim().toLowerCase());
  return normalizeOrgText(text).includes(normalizedQuery);
}

/** An entry matches by its name or any of its spellings. */
export function entryMatches(entry: OrgEntry, query: string): boolean {
  if (query.trim() === '') return true;
  return textMatches(entry.name, query) || entry.spellings.some((s) => textMatches(s, query));
}

/** A "Not on the list" value matches by its stored text. */
export function valueMatches(row: NotOnListRow, query: string): boolean {
  if (query.trim() === '') return true;
  return textMatches(row.value, query);
}
