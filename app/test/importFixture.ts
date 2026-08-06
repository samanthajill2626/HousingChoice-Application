// Synthetic Quo + Airtable exports for the import tests.
//
// NO FOUNDER PII. Names are invented and every phone is in the +1555010xxxx
// reserved-for-fiction range. The SHAPES mirror the real export exactly: the
// same column names (including Airtable's trailing spaces and the "Casewoker"
// spelling), the same multi-`to` group rows, the same naming conventions.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeCsv } from '../src/lib/import/csv.js';

export const OUR_NUMBER = '+15550100000';

export const PHONES = {
  tenantBusy: '+15550100001', // 2 messages, -2bed, clean
  tenantConflict: '+15550100002', // 2 rows, conflicting sizes
  landlord: '+15550100003', // handshake marker
  caseworker: '+15550100004',
  orphan: '+15550100005', // traffic, no contact row
  optedOut: '+15550100006', // sent STOP
  noTraffic: '+15550100007', // saved contact, no messages
  groupTenant: '+15550100008',
  roleClash: '+15550100009', // -Nbed suffix but the name says landlord
} as const;

// Fixtures go through the real serializer, never hand-joined: a body containing
// a comma ("1460 Lavender Dr NW Atlanta, GA 30314") silently splits across
// columns otherwise, and the resulting test failure looks like a parser bug.
const CONTACT_COLS = [
  'id',
  'userId',
  'firstName',
  'lastName',
  'company',
  'sharedWith',
  'phone_number_1',
  'email_1',
];

function quoContacts(): string {
  const rows = [
    ['695ef5b40bdaade262577c01', 'Dana Whitfield-2bed', PHONES.tenantBusy],
    ['695ef5b40bdaade262577c02', 'Rey Okonkwo-3bed', PHONES.tenantConflict],
    ['695ef5b40bdaade262577c03', 'Rey Okonkwo-4bed', PHONES.tenantConflict],
    ['695ef5b40bdaade262577c04', '\u{1F91D} Marlon Pike', PHONES.landlord],
    ['695ef5b40bdaade262577c05', 'Ines Barros caseworker', PHONES.caseworker],
    ['695ef5b40bdaade262577c06', 'Tomas Vega-1bed', PHONES.optedOut],
    ['695ef5b40bdaade262577c07', 'Ghost Contact-2bed', PHONES.noTraffic],
    ['695ef5b40bdaade262577c08', 'Priya Raman-3bed', PHONES.groupTenant],
    ['695ef5b40bdaade262577c09', 'Landlord Larry-2bed', PHONES.roleClash],
  ].map(([id, firstName, phone]) => ({
    id: id!,
    userId: 'US1',
    firstName: firstName!,
    lastName: '',
    company: '',
    sharedWith: '[]',
    phone_number_1: phone!,
    email_1: '',
  }));
  return serializeCsv(CONTACT_COLS, rows);
}

interface Msg {
  id: string;
  conv: string;
  body: string;
  to: string;
  from: string;
  dir: 'incoming' | 'outgoing';
  at: string;
}

export const MESSAGES: Msg[] = [
  // A 1:1 thread with a body containing an embedded newline AND a lone CR.
  { id: 'AC001', conv: 'CN001', body: 'Hi there\nsecond line', to: OUR_NUMBER, from: PHONES.tenantBusy, dir: 'incoming', at: '2026-07-01T10:00:00.000Z' },
  { id: 'AC002', conv: 'CN001', body: 'thanks\rmore', to: PHONES.tenantBusy, from: OUR_NUMBER, dir: 'outgoing', at: '2026-07-01T11:00:00.000Z' },
  // Same person, a SECOND Quo conversation — must fold into one 1:1 thread.
  { id: 'AC003', conv: 'CN002', body: 'following up', to: PHONES.tenantBusy, from: OUR_NUMBER, dir: 'outgoing', at: '2026-07-02T10:00:00.000Z' },
  // Conflicting-size tenant, recent.
  { id: 'AC004', conv: 'CN003', body: 'still looking', to: OUR_NUMBER, from: PHONES.tenantConflict, dir: 'incoming', at: '2026-07-20T10:00:00.000Z' },
  // Landlord thread, an address she sends repeatedly.
  { id: 'AC005', conv: 'CN004', body: '1460 Lavender Dr NW Atlanta, GA 30314', to: PHONES.landlord, from: OUR_NUMBER, dir: 'outgoing', at: '2026-07-21T10:00:00.000Z' },
  { id: 'AC006', conv: 'CN004', body: '1460 Lavender Dr NW', to: PHONES.landlord, from: OUR_NUMBER, dir: 'outgoing', at: '2026-07-22T10:00:00.000Z' },
  // Caseworker.
  { id: 'AC007', conv: 'CN005', body: 'my client needs a 3 bed', to: OUR_NUMBER, from: PHONES.caseworker, dir: 'incoming', at: '2026-07-23T10:00:00.000Z' },
  // Orphan: traffic, never saved as a contact.
  { id: 'AC008', conv: 'CN006', body: 'is the house still open', to: OUR_NUMBER, from: PHONES.orphan, dir: 'incoming', at: '2026-07-24T10:00:00.000Z' },
  // Opt-out.
  { id: 'AC009', conv: 'CN007', body: 'STOP', to: OUR_NUMBER, from: PHONES.optedOut, dir: 'incoming', at: '2026-06-01T10:00:00.000Z' },
  // GROUP: outbound lists both members; inbound lists our own number too, which
  // is how carrier group MMS appears in the real export.
  { id: 'AC010', conv: 'CN008', body: 'intro', to: `${PHONES.groupTenant},${PHONES.landlord}`, from: OUR_NUMBER, dir: 'outgoing', at: '2026-07-25T10:00:00.000Z' },
  { id: 'AC011', conv: 'CN008', body: 'sounds good', to: `${OUR_NUMBER},${PHONES.landlord}`, from: PHONES.groupTenant, dir: 'incoming', at: '2026-07-26T10:00:00.000Z' },
  // Stale tenant — last contact long before the export end, so `on_hold`.
  { id: 'AC012', conv: 'CN009', body: 'ok', to: OUR_NUMBER, from: PHONES.groupTenant, dir: 'incoming', at: '2026-03-01T10:00:00.000Z' },
];

function quoMessages(): string {
  return serializeCsv(
    ['id', 'conversationId', 'body', 'sentAt', 'to', 'from', 'direction', 'createdAt'],
    MESSAGES.map((m) => ({
      id: m.id,
      conversationId: m.conv,
      body: m.body,
      sentAt: '',
      to: m.to,
      from: m.from,
      direction: m.dir,
      createdAt: m.at,
    })),
  );
}

function quoCalls(): string {
  const cols = ['id', 'conversationId', 'duration', 'to', 'from', 'direction', 'createdAt'];
  return serializeCsv(cols, [
    {
      id: 'AK001',
      conversationId: 'CN001',
      duration: '120',
      to: OUR_NUMBER,
      from: PHONES.tenantBusy,
      direction: 'incoming',
      createdAt: '2026-07-03T10:00:00.000Z',
    },
    // Zero-duration inbound = a missed call.
    {
      id: 'AK002',
      conversationId: 'CN003',
      duration: '0',
      to: OUR_NUMBER,
      from: PHONES.tenantConflict,
      direction: 'incoming',
      createdAt: '2026-07-19T10:00:00.000Z',
    },
  ]);
}

function quoUsers(): string {
  return serializeCsv(['id', 'email', 'firstName', 'lastName', 'role', 'status'], [
    { id: 'US1', email: 'op@example.com', firstName: 'Sam', lastName: 'Ops', role: 'owner', status: 'active' },
  ]);
}

function quoNumbers(): string {
  return serializeCsv(['id', 'number', 'sid', 'entityId', 'name'], [
    { id: 'PN1', number: OUR_NUMBER, sid: 'PNsid', entityId: 'US1', name: 'Ops Line' },
  ]);
}

function airtableLandlord(): string {
  return serializeCsv(['Name', 'Phone', 'Quo Id'], [
    { Name: '\u{1F91D} Marlon Pike', Phone: PHONES.landlord, 'Quo Id': '695ef5b40bdaade262577c04' },
  ]);
}

const PROPERTY_COLS = [
  'Address', 'Landlord', 'Available Status', 'Priority', 'Beds', 'Bathrooms',
  'Voucher Size Needed', 'Voucher Type', 'Utilities Tenant Responsible for',
  'Washer Dryer?', 'Tags', 'Stairs/Steps', 'Application ', 'App Fee', 'Requirements',
  'Pets?', 'Tour', 'Subzone', 'Min Rent', 'Max Rent', 'Tenant Utilities', 'Photos',
  'Flyer Link', 'Flyer Sent', 'Notes', 'Tenants Table', 'Tours Table', 'Created',
];

function airtableProperties(): string {
  return serializeCsv(PROPERTY_COLS, [
    {
      Address: '1460 Lavender Dr NW 30314',
      Landlord: 'Marlon Pike',
      'Available Status': 'Available',
      Priority: 'High ',
      Beds: '3 Bed',
      Bathrooms: '2 Bathroom',
      'Voucher Size Needed': '3 bed',
      'Voucher Type': 'Atlanta Housing',
      Tags: 'Single Family Home',
      Created: '7/1/2026 2:44pm',
    },
  ]);
}

// Column names copied VERBATIM from the real export, trailing spaces and the
// founder's "Casewoker" spelling included — the loader matches them exactly, so
// tidying them here would make the test pass against a file we never see.
const TENANT_COLS = [
  'Name', 'Phone Number', 'tenant type ', 'Voucher Size', 'voucher program', 'Note',
  'Looking for housing', 'found housing', 'caseworker organization ',
  'Properties Interested:', 'Preferences', 'Matched Properties', 'Notes', 'Tours Table',
  'Created', 'First Name fallback', 'Select', 'Last moved', 'current place Duration',
  'Eviction History ', 'Voucher In hand?', 'Pets', 'Household number', 'rent percentage',
  'staires', 'Quo ID',
];

function airtableTenants(): string {
  return serializeCsv(TENANT_COLS, [
    {
      Name: 'Ines Barros',
      'Phone Number': PHONES.caseworker,
      'tenant type ': 'Casewoker',
      'voucher program': 'Hope Atlanta',
      'caseworker organization ': 'Hope Atlanta',
      Created: '7/9/2026 11:39am',
      'Voucher In hand?': 'yes',
      'Quo ID': '695ef5b40bdaade262577c05',
    },
  ]);
}

export interface Fixture {
  quoDir: string;
  airtableDir: string;
  root: string;
}

/** Write a synthetic export pair to a temp dir and return the paths. */
export function writeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'hc-import-'));
  // Mirror the real layout: three Quo job directories, each re-exporting
  // users + phone_numbers.
  const quoDir = join(root, 'quo');
  for (const [job, file, body] of [
    ['jobA', 'ORG_contacts.csv', quoContacts()],
    ['jobB', 'ORG_messages.csv', quoMessages()],
    ['jobC', 'ORG_calls.csv', quoCalls()],
  ] as const) {
    const dir = join(quoDir, job);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), body, 'utf8');
    writeFileSync(join(dir, 'ORG_users.csv'), quoUsers(), 'utf8');
    writeFileSync(join(dir, 'ORG_phone_numbers.csv'), quoNumbers(), 'utf8');
  }

  const airtableDir = join(root, 'airtable');
  mkdirSync(airtableDir, { recursive: true });
  writeFileSync(join(airtableDir, 'Landlord-Grid view.csv'), `﻿${airtableLandlord()}`, 'utf8');
  writeFileSync(
    join(airtableDir, 'Properties Table-All Properties.csv'),
    `﻿${airtableProperties()}`,
    'utf8',
  );
  writeFileSync(
    join(airtableDir, 'Tenants Table-rough view .csv'),
    `﻿${airtableTenants()}`,
    'utf8',
  );

  return { quoDir, airtableDir, root };
}
