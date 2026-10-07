// Spec 2026-10-06 clean org names, D9 (rulings R4-F5, R4-F6): the importer
// resolves the Airtable program (contacts) and the "Voucher Type" cell
// (units) against the organization list - an INPUT, ApplyOptions.orgEntries.
// Driven over a recording stub doc client like importGroupAttribution.test.ts:
// runApply takes its client by parameter, so no DynamoDB is needed.
//
//   - contact side: a housing authority is written FILL-ONLY, as the exact
//     list name; an agency named in that column goes to `agency`, fill-only,
//     never to housingAuthority; anything else is not written and is counted
//     per value - in a dry run too (the dry run is the preview)
//   - unit side: only a resolved housing authority name is written
//   - the CLI reads the list without creating it
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { runApply } from '../src/lib/import/apply.js';
import { contactIdForPhone } from '../src/lib/import/ids.js';
import { runPlan, type PlanResult } from '../src/lib/import/plan.js';
import { parseWorkbook } from '../src/lib/import/workbook.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { PHONES, writeFixture } from './importFixture.js';

const fixture = writeFixture();
const plan = runPlan({ quoDir: fixture.quoDir, airtableDir: fixture.airtableDir });
const importedAt = '2026-08-05T00:00:00.000Z';
const LIST_AT = '2026-10-06T00:00:00.000Z';

let ids = 0;
/** The starting list (spec Appendix A) - where every environment begins. */
const ENTRIES: OrgEntry[] = buildStartingEntries(LIST_AT, () => `org-${(ids += 1)}`);

const cleanReview = (): ReturnType<typeof parseWorkbook> =>
  parseWorkbook({
    contacts: plan.files['contacts.csv'],
    groups: plan.files['groups.csv'],
    units: plan.files['units.csv'],
  });

/** The plan with some people's Airtable program replaced, keyed by phone. */
function planWithPrograms(programs: Readonly<Record<string, string>>): PlanResult {
  return {
    ...plan,
    merge: {
      ...plan.merge,
      people: plan.merge.people.map((p) => {
        const program = programs[p.phone];
        if (program === undefined || p.airtableTenant === undefined) return p;
        return { ...p, airtableTenant: { ...p.airtableTenant, voucherProgram: program } };
      }),
    },
  };
}

interface RecordedCommand {
  name: string;
  input: Record<string, unknown>;
}

const READS = new Set(['GetCommand', 'QueryCommand', 'ScanCommand']);

function stubDoc(): { doc: DynamoDBDocumentClient; sent: RecordedCommand[] } {
  const sent: RecordedCommand[] = [];
  const doc = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'BatchWriteCommand') return { UnprocessedItems: {} };
      if (command.constructor.name === 'QueryCommand') return { Items: [] };
      return {};
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, sent };
}

/** The ONE UpdateCommand upsertContact sent for this phone's contact. */
function contactUpdate(sent: RecordedCommand[], phone: string): Record<string, unknown> {
  const contactId = contactIdForPhone(phone);
  const found = sent.filter(
    (c) =>
      c.name === 'UpdateCommand' &&
      (c.input['Key'] as { contactId?: unknown } | undefined)?.contactId === contactId,
  );
  expect(found, `one contact UpdateCommand for ${phone}`).toHaveLength(1);
  return found[0]!.input;
}

const expressionOf = (input: Record<string, unknown>): string => String(input['UpdateExpression']);
const valuesOf = (input: Record<string, unknown>): Record<string, unknown> =>
  input['ExpressionAttributeValues'] as Record<string, unknown>;
const namesOf = (input: Record<string, unknown>): Record<string, string> =>
  input['ExpressionAttributeNames'] as Record<string, string>;

describe('D9 contact side: the Airtable program against the org list', () => {
  it('writes a resolved housing authority FILL-ONLY, as the exact list name', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt, orgEntries: ENTRIES });
    // Vera Cole's program is "Atlanta, aha, Atlanta housing" - a listed spelling.
    const vera = contactUpdate(sent, PHONES.conflictResolved);
    expect(expressionOf(vera)).toContain(
      'housingAuthority = if_not_exists(housingAuthority, :housingAuthority)',
    );
    expect(valuesOf(vera)[':housingAuthority']).toBe('Atlanta Housing Authority');
  });

  it('puts an agency named in the housing authority column into agency, fill-only - never into housingAuthority', async () => {
    const { doc, sent } = stubDoc();
    const report = await runApply({ doc, plan, review: cleanReview(), importedAt, orgEntries: ENTRIES });
    // Ines Barros (a caseworker) carries "Hope Atlanta" - an AGENCY on the list.
    const ines = contactUpdate(sent, PHONES.caseworker);
    expect(expressionOf(ines)).toContain('#agency = if_not_exists(#agency, :agency)');
    expect(expressionOf(ines)).not.toContain('housingAuthority');
    expect(namesOf(ines)['#agency']).toBe('agency');
    expect(valuesOf(ines)[':agency']).toBe('HOPE Atlanta');
    expect(report.contacts.agencyFromHousingAuthority).toBe(1);
    expect(report.orgNotWritten).toEqual([]);
  });

  it('does not write an ambiguous or unknown program and counts it per value - in a dry run too', async () => {
    const programs: Record<string, string> = {
      [PHONES.caseworker]: 'AHA',
      [PHONES.conflictResolved]: 'Nowhere Housing Office',
    };
    const odd = planWithPrograms(programs);
    // Guard the fixture assumption: both people carry an Airtable record.
    expect(
      odd.merge.people.filter(
        (p) => programs[p.phone] !== undefined && p.airtableTenant?.voucherProgram === programs[p.phone],
      ),
    ).toHaveLength(2);
    const expected = [
      { field: 'housingAuthority', value: 'AHA', resolution: 'ambiguous', count: 1 },
      { field: 'housingAuthority', value: 'Nowhere Housing Office', resolution: 'unknown', count: 1 },
    ];

    const dry = stubDoc();
    const dryReport = await runApply({
      doc: dry.doc,
      plan: odd,
      review: cleanReview(),
      importedAt,
      orgEntries: ENTRIES,
      dryRun: true,
    });
    expect(dryReport.orgNotWritten).toEqual(expected);
    expect(dry.sent.filter((c) => !READS.has(c.name))).toEqual([]);

    const real = stubDoc();
    const report = await runApply({ doc: real.doc, plan: odd, review: cleanReview(), importedAt, orgEntries: ENTRIES });
    expect(report.orgNotWritten).toEqual(expected);
    expect(report.contacts.agencyFromHousingAuthority).toBe(0);
    for (const phone of [PHONES.caseworker, PHONES.conflictResolved]) {
      const expression = expressionOf(contactUpdate(real.sent, phone));
      expect(expression).not.toContain('housingAuthority');
      expect(expression).not.toContain('#agency');
    }
  });

  it('the list is an INPUT: a passed list is what resolves; omitted, it is the starting list', async () => {
    const custom: OrgEntry[] = [
      {
        orgId: 'o-test',
        kind: 'housing_authority',
        name: 'Test Hope Housing Board',
        spellings: ['Hope Atlanta'],
        createdAt: LIST_AT,
        createdBy: 'test',
        updatedAt: LIST_AT,
        updatedBy: 'test',
      },
    ];
    const withCustom = stubDoc();
    await runApply({ doc: withCustom.doc, plan, review: cleanReview(), importedAt, orgEntries: custom });
    expect(valuesOf(contactUpdate(withCustom.sent, PHONES.caseworker))[':housingAuthority']).toBe(
      'Test Hope Housing Board',
    );

    const withDefault = stubDoc();
    await runApply({ doc: withDefault.doc, plan, review: cleanReview(), importedAt });
    expect(valuesOf(contactUpdate(withDefault.sent, PHONES.caseworker))[':agency']).toBe('HOPE Atlanta');
  });
});

/** The ONE UpdateCommand upsertUnit sent (the fixture has one property). */
function unitUpdate(sent: RecordedCommand[]): Record<string, unknown> {
  const found = sent.filter(
    (c) => c.name === 'UpdateCommand' && (c.input['Key'] as { unitId?: unknown } | undefined)?.unitId !== undefined,
  );
  expect(found, 'one unit UpdateCommand').toHaveLength(1);
  return found[0]!.input;
}

/** The fixture's one property row (1460 Lavender Dr; its "Voucher Type" is "Atlanta Housing"). */
const lavender = (review: ReturnType<typeof cleanReview>) =>
  [...review.units.values()].find((r) => (r.address ?? '').includes('Lavender'))!;

describe('D9 unit side: the "Voucher Type" cell against the housing authority list', () => {
  it('writes the resolved housing authority NAME', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt, orgEntries: ENTRIES });
    expect(valuesOf(unitUpdate(sent))[':acceptedAuthorities']).toEqual(['Atlanta Housing Authority']);
  });

  it.each([
    ['Hope Atlanta', 'other_kind'],
    ['MHA', 'ambiguous'],
    ['Smyrna Housing Office', 'unknown'],
  ] as const)('never writes %s to a property and counts it as %s - in a dry run too', async (cell, resolution) => {
    const review = cleanReview();
    lavender(review).housing_authority = cell;
    const expected = { field: 'accepted_authorities', value: cell, resolution, count: 1 };

    const { doc, sent } = stubDoc();
    const report = await runApply({ doc, plan, review, importedAt, orgEntries: ENTRIES });
    expect(expressionOf(unitUpdate(sent))).not.toContain('accepted_authorities');
    expect(report.orgNotWritten).toContainEqual(expected);

    const dry = stubDoc();
    const dryReport = await runApply({ doc: dry.doc, plan, review, importedAt, orgEntries: ENTRIES, dryRun: true });
    expect(dryReport.orgNotWritten).toContainEqual(expected);
  });
});

describe('the importer no longer uses the hand-kept alias map', () => {
  it('apply.ts does not import lib/housingAuthority.ts (S10 retires it)', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'import', 'apply.ts'), 'utf8');
    expect(source).not.toContain('housingAuthority.js');
    expect(source).not.toContain('housingAuthorityFor');
    expect(source).not.toContain('KNOWN_AUTHORITIES');
  });
});
