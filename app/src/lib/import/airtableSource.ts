// Load + normalize the Airtable export (spec §2.2).
//
// Airtable is a THIN layer over the Quo corpus, and knowing where it is thin is
// the point of this module:
//
//   Landlord    40 rows -> 18 distinct phones. Carries a `Quo Id` join column
//               that resolves against Quo contact ObjectIds (21 of 25 resolve).
//   Properties  10 rows, 38 columns, 26 of them 100% EMPTY. The schema exists;
//               the data never did.
//   Tenants     17 rows. Sparse, but the richest structured data in either
//               system — voucher program, caseworker org, household size,
//               pets, eviction history. Carries `Quo ID` (10 of 12 resolve).
//   Tours       13 rows, 10 of them seeded demo data (+1404555xxxx, all created
//               1/17/2026). NOT LOADED — there is nothing real in it.
//
// Files are matched by a filename PREFIX because Airtable names exports
// "<Table>-<View>.csv" and the view name is whatever the founder had open
// ("Tenants Table-rough view .csv", trailing space included).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeToE164 } from '../phone.js';
import { parseCsv, type CsvRow } from './csv.js';

export interface AirtableLandlord {
  name: string;
  phone?: string;
  rawPhone: string;
  /** Quo contact ObjectId, when the founder filled it in. */
  quoId?: string;
}

export interface AirtableProperty {
  address: string;
  /** Free-text landlord NAME — not a link. Resolved by name match, best effort. */
  landlord: string;
  availableStatus: string;
  beds: string;
  bathrooms: string;
  voucherSizeNeeded: string;
  /** The housing authority ("Atlanta Housing", "Dekalb Housing", "Jonesboro Housing"). */
  voucherType: string;
  tags: string;
  washerDryer: string;
  priority: string;
  createdAt: string;
}

export interface AirtableTenant {
  name: string;
  phone?: string;
  rawPhone: string;
  /** "Tenant" or "Casewoker" [sic] — the founder's own spelling. */
  tenantType: string;
  voucherSize: string;
  /** Program: "Georgia Housing Voucher, GHV", "HUD VASH", "Claratel", "Hope Atlanta". */
  voucherProgram: string;
  caseworkerOrganization: string;
  note: string;
  voucherInHand: string;
  pets: string;
  householdNumber: string;
  rentPercentage: string;
  evictionHistory: string;
  lookingForHousing: string;
  createdAt: string;
  quoId?: string;
}

export interface AirtableExport {
  landlords: AirtableLandlord[];
  properties: AirtableProperty[];
  tenants: AirtableTenant[];
  warnings: string[];
}

function findByPrefix(root: string, prefix: string): string | undefined {
  const matches = readdirSync(root).filter(
    (f) => f.toLowerCase().startsWith(prefix.toLowerCase()) && f.toLowerCase().endsWith('.csv'),
  );
  return matches.length > 0 ? join(root, matches[0]!) : undefined;
}

function readTable(root: string, prefix: string, warnings: string[]): CsvRow[] {
  const path = findByPrefix(root, prefix);
  if (!path) {
    warnings.push(`Airtable export has no "${prefix}*" file under ${root} — that table is skipped.`);
    return [];
  }
  return parseCsv(readFileSync(path, 'utf8')).rows;
}

/** Trim + drop values Airtable writes for an empty cell. */
function cell(row: CsvRow, name: string): string {
  return (row[name] ?? '').trim();
}

/**
 * A `Quo Id` value is only usable when it is actually a Mongo ObjectId. The real
 * export contains at least one hand-typed value ("Claratel") in that column, so
 * shape-checking here keeps garbage out of the join rather than producing a
 * mystery non-resolving id downstream.
 */
function quoIdOf(raw: string): string | undefined {
  const v = raw.trim();
  return /^[0-9a-f]{24}$/i.test(v) ? v : undefined;
}

export function loadAirtableExport(root: string): AirtableExport {
  const warnings: string[] = [];

  const landlords: AirtableLandlord[] = [];
  for (const row of readTable(root, 'Landlord', warnings)) {
    const name = cell(row, 'Name');
    const rawPhone = cell(row, 'Phone');
    if (!name && !rawPhone) continue;
    const phone = rawPhone ? normalizeToE164(rawPhone) : undefined;
    const rawQuo = cell(row, 'Quo Id');
    const quoId = quoIdOf(rawQuo);
    if (rawQuo && !quoId) {
      warnings.push(
        `Airtable landlord ${JSON.stringify(name)}: "Quo Id" is ${JSON.stringify(rawQuo)}, ` +
          `not an id — ignored for joining.`,
      );
    }
    landlords.push({ name, ...(phone && { phone }), rawPhone, ...(quoId && { quoId }) });
  }

  const properties: AirtableProperty[] = [];
  for (const row of readTable(root, 'Properties', warnings)) {
    const address = cell(row, 'Address');
    if (!address) continue;
    properties.push({
      address,
      landlord: cell(row, 'Landlord'),
      availableStatus: cell(row, 'Available Status'),
      beds: cell(row, 'Beds'),
      bathrooms: cell(row, 'Bathrooms'),
      voucherSizeNeeded: cell(row, 'Voucher Size Needed'),
      voucherType: cell(row, 'Voucher Type'),
      tags: cell(row, 'Tags'),
      washerDryer: cell(row, 'Washer Dryer?'),
      priority: cell(row, 'Priority'),
      createdAt: cell(row, 'Created'),
    });
  }

  const tenants: AirtableTenant[] = [];
  for (const row of readTable(root, 'Tenants', warnings)) {
    const name = cell(row, 'Name');
    const rawPhone = cell(row, 'Phone Number');
    if (!name && !rawPhone) continue;
    const phone = rawPhone ? normalizeToE164(rawPhone) : undefined;
    tenants.push({
      name,
      ...(phone && { phone }),
      rawPhone,
      // Column headers carry the founder's trailing spaces and spelling; match
      // them EXACTLY rather than tidying, or every lookup silently returns ''.
      tenantType: cell(row, 'tenant type '),
      voucherSize: cell(row, 'Voucher Size'),
      voucherProgram: cell(row, 'voucher program'),
      caseworkerOrganization: cell(row, 'caseworker organization '),
      note: cell(row, 'Note'),
      voucherInHand: cell(row, 'Voucher In hand?'),
      pets: cell(row, 'Pets'),
      householdNumber: cell(row, 'Household number'),
      rentPercentage: cell(row, 'rent percentage'),
      evictionHistory: cell(row, 'Eviction History '),
      lookingForHousing: cell(row, 'Looking for housing'),
      createdAt: cell(row, 'Created'),
      ...(quoIdOf(cell(row, 'Quo ID')) && { quoId: quoIdOf(cell(row, 'Quo ID'))! }),
    });
  }

  // Tours is deliberately not loaded — spec §2.2/§8. Say so out loud rather than
  // leaving a reader to wonder whether we forgot.
  const toursPath = findByPrefix(root, 'Tours');
  if (toursPath) {
    warnings.push(
      'Airtable Tours table found but NOT imported: 10 of its 13 rows are seeded demo data ' +
        '(+1404555xxxx, all created 1/17/2026) and the rest are test rows. No real tour history exists.',
    );
  }

  return { landlords, properties, tenants, warnings };
}
