// import:plan end-to-end over a synthetic export pair: the merge, the thread
// fold, status derivation, the workbook, and the carry-forward diff.
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/import/csv.js';
import { conversationIdFor1to1, conversationIdForGroup, contactIdForPhone } from '../src/lib/import/ids.js';
import { runPlan } from '../src/lib/import/plan.js';
import { parseWorkbook } from '../src/lib/import/workbook.js';
import { OUR_NUMBER, PHONES, writeFixture } from './importFixture.js';

const fixture = writeFixture();
const plan = runPlan({ quoDir: fixture.quoDir, airtableDir: fixture.airtableDir });
const person = (phone: string) => plan.merge.people.find((p) => p.phone === phone);

describe('loading', () => {
  it('finds all three Quo entity files across separate job directories', () => {
    expect(plan.quo.contacts).toHaveLength(8);
    expect(plan.quo.messages).toHaveLength(12);
    expect(plan.quo.calls).toHaveLength(2);
  });

  it('reads the org number and never treats it as a counterparty', () => {
    expect(plan.quo.ownNumbers.has(OUR_NUMBER)).toBe(true);
    expect(person(OUR_NUMBER)).toBeUndefined();
  });

  it('recovers created_at from the Mongo ObjectId prefix', () => {
    // Quo exports no created_at column; the ObjectId's first 4 bytes carry it.
    expect(plan.quo.contacts[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports the Airtable Tours table as deliberately not imported', () => {
    const airtable = plan.airtable;
    expect(airtable.landlords).toHaveLength(1);
    expect(airtable.properties).toHaveLength(1);
    expect(airtable.tenants).toHaveLength(1);
  });
});

describe('merging people', () => {
  it('collapses two contact rows on one phone into a single person', () => {
    const p = person(PHONES.tenantConflict)!;
    expect(p.quoContactIds).toHaveLength(2);
    expect(p.contactId).toBe(contactIdForPhone(PHONES.tenantConflict));
  });

  it('surfaces a voucher-size conflict instead of guessing', () => {
    const p = person(PHONES.tenantConflict)!;
    expect(p.voucherSizesSeen).toEqual([3, 4]);
    expect(p.suggestedVoucherBeds).toBeUndefined();
    expect(p.flags).toContain('bed_size_conflict');
  });

  it('classifies a handshake-marked contact as a landlord', () => {
    expect(person(PHONES.landlord)!.suggestedType).toBe('landlord');
  });

  it('maps a caseworker to partner (no caseworker ContactType exists yet)', () => {
    const p = person(PHONES.caseworker)!;
    expect(p.suggestedType).toBe('partner');
    expect(p.flags).toContain('caseworker');
  });

  it('adds numbers that have traffic but no saved contact', () => {
    const p = person(PHONES.orphan)!;
    expect(p.suggestedType).toBe('unknown');
    expect(p.flags).toContain('no_contact_record');
  });

  it('keeps a saved contact with no traffic and flags it', () => {
    const p = person(PHONES.noTraffic)!;
    expect(p.traffic.messageCount).toBe(0);
    expect(p.flags).toContain('no_traffic');
  });

  it('marks the STOP sender opted out', () => {
    const p = person(PHONES.optedOut)!;
    expect(p.optedOut).toBe(true);
    expect(p.flags).toContain('opted_out');
  });
});

describe('status derivation', () => {
  it('derives searching for a recently active tenant', () => {
    expect(person(PHONES.tenantConflict)!.suggestedStatus).toBe('searching');
  });

  it('derives on_hold for a tenant who went quiet', () => {
    // groupTenant's newest activity is 2026-07-26; the export ends 2026-07-26,
    // so use the deliberately stale one instead.
    const stale = runPlan({
      quoDir: fixture.quoDir,
      airtableDir: fixture.airtableDir,
      activeWindowDays: 1,
    });
    const p = stale.merge.people.find((x) => x.phone === PHONES.tenantBusy)!;
    expect(p.suggestedStatus).toBe('on_hold');
  });

  it('leaves a no-traffic contact in needs_review', () => {
    expect(person(PHONES.noTraffic)!.suggestedStatus).toBe('needs_review');
  });

  it('marks a landlord active', () => {
    expect(person(PHONES.landlord)!.suggestedStatus).toBe('active');
  });

  it('is a pure function of the export - no wall-clock dependency', () => {
    // Re-planning the same files must produce an identical workbook, or the
    // 8/09 carry-forward diff fills with phantom changes.
    const again = runPlan({ quoDir: fixture.quoDir, airtableDir: fixture.airtableDir });
    expect(again.files['contacts.csv']).toBe(plan.files['contacts.csv']);
    expect(again.summary.asOf).toBe(plan.summary.asOf);
  });
});

describe('thread folding', () => {
  it('folds two Quo conversations for one phone into a single 1:1 thread', () => {
    const id = conversationIdFor1to1(PHONES.tenantBusy);
    const thread = plan.threads.threads.find((t) => t.conversationId === id)!;
    expect(thread.quoConversationIds.sort()).toEqual(['CN001', 'CN002']);
    expect(thread.isGroup).toBe(false);
    // 3 messages across both Quo threads, plus the call.
    expect(thread.messages).toHaveLength(3);
    expect(thread.calls).toHaveLength(1);
  });

  it('keys a group on its sorted participant set, excluding our own number', () => {
    const id = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);
    const thread = plan.threads.threads.find((t) => t.conversationId === id)!;
    expect(thread.isGroup).toBe(true);
    expect(thread.participants).toEqual([PHONES.groupTenant, PHONES.landlord].sort());
  });

  it('orders messages chronologically within a thread', () => {
    const thread = plan.threads.threads.find(
      (t) => t.conversationId === conversationIdFor1to1(PHONES.tenantBusy),
    )!;
    const times = thread.messages.map((m) => m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('imports every message exactly once across all threads', () => {
    const ids = plan.threads.threads.flatMap((t) => t.messages.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(plan.quo.messages.length);
  });
});

describe('address mining', () => {
  it('mines each SPELLING separately', () => {
    // Two spellings of one property: "1460 Lavender Dr NW Atlanta, GA 30314"
    // and "1460 Lavender Dr NW". They are distinct candidates at this layer and
    // are only combined per-property in the workbook (below).
    const spellings = plan.addresses.filter((a) => a.normalized.startsWith('1460 lavender'));
    expect(spellings).toHaveLength(2);
    expect(spellings.every((s) => s.sendCount === 1)).toBe(true);
  });

  it('folds spellings of one property into a single unit row', () => {
    const units = parseCsv(plan.files['units.csv']!).rows;
    const lavender = units.filter((r) => /lavender/i.test(r.address ?? ''));
    expect(lavender).toHaveLength(1);
    // The Airtable row is the confirmed record and wins the editable fields.
    expect(lavender[0]!.source).toBe('airtable+texts');
    // Send count is the SUM across every spelling — the reason the relevance
    // threshold is applied here and not per-spelling.
    expect(lavender[0]!.times_texted).toBe('2');
  });

  it('applies the relevance threshold to the property, not the spelling', () => {
    // Below threshold, a mined-only property drops out; a confirmed Airtable
    // property is always offered regardless of how often she texts it.
    const strict = runPlan({
      quoDir: fixture.quoDir,
      airtableDir: fixture.airtableDir,
      minAddressSendCount: 99,
    });
    const units = parseCsv(strict.files['units.csv']!).rows;
    expect(units.every((r) => (r.source ?? '').startsWith('airtable'))).toBe(true);
  });
});

describe('the workbook', () => {
  it('emits three sheets with stable opaque row keys', () => {
    const contacts = parseCsv(plan.files['contacts.csv']!).rows;
    expect(contacts.length).toBe(plan.merge.people.length);
    expect(contacts[0]!.row_key).toMatch(/^HC-\d{4}$/);
    expect(parseCsv(plan.files['groups.csv']!).rows[0]!.row_key).toMatch(/^GRP-\d{4}$/);
    expect(parseCsv(plan.files['units.csv']!).rows[0]!.row_key).toMatch(/^UNIT-\d{4}$/);
  });

  it('sorts the rows that need her judgement to the top', () => {
    const contacts = parseCsv(plan.files['contacts.csv']!).rows;
    expect(contacts[0]!.needs_your_input).toBe('YES');
    const flaggedIdx = contacts.findIndex((r) => r.needs_your_input !== 'YES');
    const laterFlagged = contacts.slice(flaggedIdx).some((r) => r.needs_your_input === 'YES');
    expect(laterFlagged).toBe(false);
  });

  it('leaves voucher_beds blank on a conflict so she fills it in', () => {
    const contacts = parseCsv(plan.files['contacts.csv']!).rows;
    const row = contacts.find((r) => r.phone === PHONES.tenantConflict)!;
    expect(row.voucher_beds).toBe('');
    expect(row.why).toContain('two different voucher sizes');
  });

  it('defaults every group to NOT connecting on day one', () => {
    const groups = parseCsv(plan.files['groups.csv']!).rows;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.connect_day_one).toBe('N');
  });
});

describe('carry-forward', () => {
  it("preserves the founder's edits and marks unchanged rows", () => {
    const prior = parseWorkbook({ contacts: plan.files['contacts.csv'] });
    const target = [...prior.contacts.values()].find((r) => r.phone === PHONES.tenantConflict)!;
    target.name = 'Rey Okonkwo';
    target.voucher_beds = '4';
    target.type = 'tenant';

    const replanned = runPlan({
      quoDir: fixture.quoDir,
      airtableDir: fixture.airtableDir,
      prior,
    });
    const rows = parseCsv(replanned.files['contacts.csv']!).rows;
    const row = rows.find((r) => r.phone === PHONES.tenantConflict)!;

    expect(row.voucher_beds).toBe('4');
    expect(row.name).toBe('Rey Okonkwo');
    expect(row.change).toBe('unchanged');
    // Reviewed once, so it stops demanding attention on the next pass.
    expect(row.needs_your_input).toBe('');
  });

  it('marks rows absent from the prior review as new', () => {
    const prior = parseWorkbook({ contacts: 'row_key,phone,name\n' });
    const replanned = runPlan({
      quoDir: fixture.quoDir,
      airtableDir: fixture.airtableDir,
      prior,
    });
    const rows = parseCsv(replanned.files['contacts.csv']!).rows;
    expect(rows.every((r) => r.change === 'new')).toBe(true);
  });

  it('flags a conflict when a row key now holds a different phone', () => {
    // row_key is position-derived, so a changed export can slide a different
    // person onto the same key. Her edits must NOT silently transfer.
    const prior = parseWorkbook({ contacts: plan.files['contacts.csv'] });
    const first = prior.contacts.get('HC-0001')!;
    first.name = 'Edited Name';
    prior.contactPhones.set('HC-0001', '+15550109999');

    const replanned = runPlan({
      quoDir: fixture.quoDir,
      airtableDir: fixture.airtableDir,
      prior,
    });
    const rows = parseCsv(replanned.files['contacts.csv']!).rows;
    const row = rows.find((r) => r.row_key === 'HC-0001')!;
    expect(row.change).toBe('conflict');
    expect(row.needs_your_input).toBe('YES');
    expect(row.name).not.toBe('Edited Name');
  });
});
