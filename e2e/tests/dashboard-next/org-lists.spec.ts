// e2e/tests/dashboard-next/org-lists.spec.ts
//
// One clean name per housing authority and agency (tracker #2; design
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md,
// branch A), end to end against the real backend:
//   1. the pickers (D6, D7): the tenant form's Housing authority and Agency
//      pickers with "Is this really new?"; a stored value that is not on the
//      list, kept as a chip through an unrelated save; the property form's
//      multi-picker; the blast composer's picker (no add step, and the filter
//      changes only on a pick);
//   2. Settings > Housing authorities & agencies (D10-D13): a VA adds an entry
//      and edits its notes; an admin renames one and the rewrite job finishes;
//   3. the "Not on the list" section (D10, D11), fed by the dev seam: Show
//      records for everyone; Use, Move to Agency, Split and Clear for admins;
//   4. AI suggestions (D8): an ambiguous and an unknown housing authority
//      accepted through "Is this really new?", and an agency name dropped with
//      its run-log label.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const and
// local sign-in helpers, raw page.request for setup, accessibility-first
// locators. ISOLATION: every name and value a test settles is RUN-UNIQUE (a
// stamp per test, and words no other test in this file uses), added through
// POST /api/organizations or written by the dev seam onto records the test
// itself created. NOTHING here reseeds (a reseed mid-suite wipes other specs'
// data and logs the session out), and the starting-list entries read here -
// Atlanta and Augusta (which share the spelling AHA) and the agency Step Up -
// are never changed. A rewrite is lane-global and one runs at a time (D11), so
// every action that starts one waits for it to finish.
import { test, expect, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test';
import { ORG_PICKER, pickOrgName } from '../../scenarios/steps.js';
import {
  addOrg,
  getOrgList,
  getOrgUsage,
  requireOrg,
  sameOrgText,
  setOffListValue,
  waitForRewrite,
} from '../../fixtures/orgFixture.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/**
 * Every accessible name this spec uses that plan section 3.11 does not pin -
 * the S14 selector contract (rows N1-N4, S1-S8, L1-L6, A1-A2). S11 is built
 * before this spec: when an as-built name differs, change it HERE (the
 * picker's own names live in ORG_PICKER, e2e/scenarios/steps.ts).
 */
const UI = {
  helpText: 'The organization that runs the voucher',
  newDialog: 'Is this really new?',
  yesAddIt: 'Yes, add it',
  use: (name: string): string => `Use ${name}`,
  nameBox: 'Name',
  notesBox: 'Notes',
  settingsTab: 'Housing authorities & agencies',
  haRegion: 'Housing authorities',
  agencyRegion: 'Agencies',
  notOnListRegion: 'Not on the list',
  addAgency: 'Add agency',
  editNotes: (name: string): string => `Edit notes for ${name}`,
  editNotesDialog: 'Edit notes',
  save: 'Save',
  usedByTenants: (n: number): string => `${n} tenant${n === 1 ? '' : 's'}`,
  usedByProperties: (n: number): string => `${n} propert${n === 1 ? 'y' : 'ies'}`,
  rename: (name: string): string => `Rename ${name}`,
  newNameBox: 'New name',
  renameConfirm: 'Rename',
  showRecords: 'Show records',
  deletedMarker: /deleted/i,
  rememberSpelling: 'Remember this spelling',
  moveToAgency: (name: string): string => `Move to Agency as ${name}`,
  split: (ha: string, agency: string): string => `Split into ${ha} + ${agency}`,
  splitConfirm: 'Split',
  clear: 'Clear',
  agencyDropLabel: 'Agency, not a housing authority',
  activityLabel: 'Housing authority updated',
};

/** Sign in as the seeded VA (the "Continue as dev user" identity). */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

/** A tenant through the real routes. `housingAuthority` must already be a list
 *  name: the PATCH applies the D5 check (the POST ignores the field). */
async function createTenant(
  request: APIRequestContext,
  opts: { firstName: string; voucherSize?: number; housingAuthority?: string },
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName: 'Orglist',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  if (opts.housingAuthority !== undefined) {
    const patch = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { housingAuthority: opts.housingAuthority },
    });
    expect(patch.ok(), await patch.text()).toBeTruthy();
  }
  return { contactId, phone };
}

interface ContactWire {
  housingAuthority?: string;
  agency?: string;
  voucherSize?: number;
}

async function getContact(request: APIRequestContext, contactId: string): Promise<ContactWire> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: ContactWire }).contact;
}

/** A 2-BR property under the seeded landlord; published Available on request
 *  (the composer's send guard needs it). `authorities` must be list names. */
async function createUnit(
  request: APIRequestContext,
  opts: { line1: string; authorities: string[]; available?: boolean },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      accepted_authorities: opts.authorities,
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1: opts.line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  if (opts.available === true) {
    const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(pub.ok(), await pub.text()).toBeTruthy();
  }
  return unitId;
}

async function getUnitAuthorities(request: APIRequestContext, unitId: string): Promise<string[]> {
  const res = await request.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: { accepted_authorities?: string[] } }).unit.accepted_authorities ?? [];
}

interface DraftBody {
  audience_filter?: { housing_authority?: string };
}

/** A blast-draft create: the composer's estimate engine, one per material change. */
function isDraftCreate(r: Request): boolean {
  return r.method() === 'POST' && new URL(r.url()).pathname === '/api/broadcasts';
}

function draftAuthority(r: Request): string | undefined {
  return (r.postDataJSON() as DraftBody | null)?.audience_filter?.housing_authority;
}

test.describe('Org pickers (spec D6, D7)', () => {
  test('tenant form: a spelling lists its names; "Is this really new?" offers a close name; Yes, add it adds one', async ({
    page,
  }) => {
    await devLogin(page); // the seeded VA: adding a name is for everyone (D10)
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const kestrel = `Kestrel Housing Authority ${stamp}`;
    // No option matches this misspelling, yet it is CLOSE to kestrel (shared
    // words and a small edit distance - closeNames in app/src/lib/orgNames.ts).
    const nearMiss = `Kestrel Hsg Authority ${stamp}`;
    const heron = `Heron Outreach ${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: kestrel });
    const { contactId } = await createTenant(req, { firstName: `OrgPick${stamp}` });

    await page.goto(`${NEXT}/contacts/${contactId}`);
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    const dialog = page.getByRole('dialog', { name: /Edit contact/i });
    await expect(dialog.getByText(UI.helpText)).toBeVisible();

    // A spelling two names share lists BOTH (AHA: Atlanta and Augusta), and
    // with names matching there is no add option.
    const authority = dialog.getByRole('combobox', { name: 'Housing authority', exact: true });
    await authority.fill('AHA');
    await expect(page.getByRole('option', { name: ORG_PICKER.option('Atlanta Housing Authority') })).toBeVisible();
    await expect(page.getByRole('option', { name: ORG_PICKER.option('Augusta Housing Authority') })).toBeVisible();
    await expect(page.getByRole('option', { name: ORG_PICKER.addOption })).toHaveCount(0);

    // Nothing matches the misspelling, so the last option adds it - and "Is
    // this really new?" offers the close name first. Using it picks kestrel.
    await authority.fill(nearMiss);
    await page.getByRole('option', { name: ORG_PICKER.addOption }).click();
    const isNew = page.getByRole('dialog', { name: UI.newDialog });
    await isNew.getByRole('button', { name: UI.use(kestrel), exact: true }).click();
    await expect(isNew).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: ORG_PICKER.removeChip(kestrel), exact: true })).toBeVisible();

    // A brand-new agency: Yes, add it creates the entry and picks it.
    await dialog.getByRole('combobox', { name: 'Agency', exact: true }).fill(heron);
    await page.getByRole('option', { name: ORG_PICKER.addOption }).click();
    await isNew.getByRole('button', { name: UI.yesAddIt, exact: true }).click();
    await expect(isNew).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: ORG_PICKER.removeChip(heron), exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });

    // Records hold the exact names (D3); the agency joined the list; the
    // misspelling never became a name.
    const saved = await getContact(req, contactId);
    expect(saved.housingAuthority).toBe(kestrel);
    expect(saved.agency).toBe(heron);
    const list = await getOrgList(req);
    expect(list.entries.find((e) => e.name === heron)?.kind).toBe('agency');
    expect(list.entries.some((e) => sameOrgText(e.name, nearMiss))).toBe(false);
  });

  test('tenant form: a stored value that is not on the list is a chip, and an unrelated save keeps it', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // Written past the D5 check, the way pre-deploy data looks.
    const legacy = `Legacy Spelling ${stamp}`;
    const { contactId } = await createTenant(req, { firstName: `OrgKeep${stamp}`, voucherSize: 2 });
    await setOffListValue(req, { contactId, field: 'housingAuthority', value: legacy });

    await page.goto(`${NEXT}/contacts/${contactId}`);
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    const dialog = page.getByRole('dialog', { name: /Edit contact/i });
    await expect(dialog.getByRole('button', { name: ORG_PICKER.removeChip(legacy), exact: true })).toBeVisible();
    await expect(dialog.getByText(ORG_PICKER.notOnList).first()).toBeVisible();
    await dialog.getByLabel('Voucher size (bedrooms)').fill('3');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });

    // Saving never fails because of an unchanged value (D5, D6).
    const saved = await getContact(req, contactId);
    expect(saved.voucherSize).toBe(3);
    expect(saved.housingAuthority).toBe(legacy);
  });

  test('property form: the multi-picker adds a name and keeps a member not on the list until it is removed', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const osprey = `Osprey Housing Authority ${stamp}`;
    const legacy = `Osprey Old Spelling ${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: osprey });
    const unitId = await createUnit(req, { line1: `${stamp} Osprey Way`, authorities: ['Atlanta Housing Authority'] });
    await setOffListValue(req, { unitId, field: 'accepted_authorities', value: legacy });

    const dialog = page.getByRole('dialog', { name: /Edit property/i });
    const openEdit = async (): Promise<void> => {
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: /Edit property/i }).click();
      await expect(dialog).toBeVisible();
    };
    await page.goto(`${NEXT}/listings/${unitId}`);
    await openEdit();
    await expect(
      dialog.getByRole('button', { name: ORG_PICKER.removeChip('Atlanta Housing Authority'), exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: ORG_PICKER.removeChip(legacy), exact: true })).toBeVisible();
    await expect(dialog.getByText(ORG_PICKER.notOnList).first()).toBeVisible();
    // Properties take housing authorities only.
    await pickOrgName(page, dialog, 'Housing authorities', osprey, { query: 'Osprey' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The untouched member rides along unchanged: D5 passes what the unit holds.
    expect((await getUnitAuthorities(req, unitId)).sort()).toEqual(
      ['Atlanta Housing Authority', legacy, osprey].sort(),
    );

    // Its chip is the way to remove it.
    await openEdit();
    await dialog.getByRole('button', { name: ORG_PICKER.removeChip(legacy), exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await getUnitAuthorities(req, unitId)).sort()).toEqual(['Atlanta Housing Authority', osprey].sort());
  });

  test('blast composer: the picker has no add step and changes the filter only on a pick', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const plover = `Plover Housing Authority ${stamp}`;
    const first = `PloverA${stamp}`;
    const second = `PloverB${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: plover });
    for (const firstName of [first, second]) {
      await createTenant(req, { firstName, voucherSize: 2, housingAuthority: plover });
    }
    const unitId = await createUnit(req, { line1: `${stamp} Plover Way`, authorities: [plover], available: true });

    // The housing authority every draft create carried (undefined = no filter).
    const sent: Array<string | undefined> = [];
    page.on('request', (r) => {
      if (isDraftCreate(r)) sent.push(draftAuthority(r));
    });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill(`Plover check ${stamp}`);
    const box = page.getByRole('combobox', { name: 'Housing authority', exact: true });

    // Names are offered; the add option never is (D7: filters name list entries only).
    await box.fill('Plover');
    await expect(page.getByRole('option', { name: ORG_PICKER.option(plover) })).toBeVisible();
    await expect(page.getByRole('option', { name: ORG_PICKER.addOption })).toHaveCount(0);
    await box.fill(`Zz Nowhere ${stamp}`);
    await expect(page.getByRole('option', { name: ORG_PICKER.option(plover) })).toHaveCount(0);
    await expect(page.getByRole('option', { name: ORG_PICKER.addOption })).toHaveCount(0);
    // Typing is never a filter change: outlast the 600 ms create debounce, then
    // no draft has carried a housing authority.
    await page.waitForTimeout(1_500);
    expect(sent.filter((a) => a !== undefined)).toEqual([]);

    // A pick commits the filter, and the reach counts exactly the two tenants.
    const committed = page.waitForRequest((r) => isDraftCreate(r) && draftAuthority(r) === plover);
    await pickOrgName(page, page, 'Housing authority', plover, { query: 'Plover' });
    await committed;
    await expect(page.getByText('Reaches 2 tenants', { exact: true })).toBeVisible();
    expect(sent.filter((a) => a !== undefined).every((a) => a === plover)).toBe(true);

    // The server resolves that exact name: Preview lists both tenants.
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByText(first)).toBeVisible();
    await expect(list.getByText(second)).toBeVisible();
  });
});

// ---- Settings > Housing authorities & agencies (spec D10-D13) ----

/** Sign in as a named dev persona (founder@example.com is the admin). */
async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok(), `dev-login as ${email}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** A named section of the tab (each <section> is labelled by its heading). */
function region(page: Page, name: string): Locator {
  return page.getByRole('region', { name, exact: true });
}

/** One entry's row in its list section, by its exact name. */
function entryRow(page: Page, regionName: string, name: string): Locator {
  return region(page, regionName)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) });
}

/** Settings > Housing authorities & agencies through its tab (visible to every
 *  signed-in user, D10); waits until the starting list has rendered. */
async function openOrgSettings(page: Page): Promise<void> {
  await page.goto(`${NEXT}/settings`);
  await page.getByRole('tab', { name: UI.settingsTab }).click();
  await expect(entryRow(page, UI.haRegion, 'Atlanta Housing Authority')).toBeVisible();
}

test.describe('Settings > Housing authorities & agencies (spec D10-D13)', () => {
  test('a VA sees the three sections, adds an agency with notes and edits them - and cannot rename', async ({
    page,
  }) => {
    await devLogin(page); // the seeded VA
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const finch = `Finch Mission ${stamp}`;
    await openOrgSettings(page);
    await expect(entryRow(page, UI.agencyRegion, 'Step Up')).toBeVisible();
    await expect(region(page, UI.notOnListRegion)).toBeVisible();
    // Admin-only actions are not offered to a VA (D10).
    await expect(region(page, UI.haRegion).getByRole('button', { name: /^Rename / })).toHaveCount(0);

    // Add: a name and notes, through "Is this really new?" (D10).
    await region(page, UI.agencyRegion).getByRole('button', { name: UI.addAgency, exact: true }).click();
    const isNew = page.getByRole('dialog', { name: UI.newDialog });
    await isNew.getByRole('textbox', { name: UI.nameBox, exact: true }).fill(finch);
    await isNew.getByRole('textbox', { name: UI.notesBox, exact: true }).fill(`Added by e2e ${stamp}`);
    await isNew.getByRole('button', { name: UI.yesAddIt, exact: true }).click();
    await expect(isNew).toHaveCount(0);
    const row = entryRow(page, UI.agencyRegion, finch);
    await expect(row).toContainText(`Added by e2e ${stamp}`);

    // Notes: everyone edits them, and they touch no records (D10).
    await row.getByRole('button', { name: UI.editNotes(finch), exact: true }).click();
    const notes = page.getByRole('dialog', { name: UI.editNotesDialog });
    await notes.getByRole('textbox', { name: UI.notesBox, exact: true }).fill(`Edited by e2e ${stamp}`);
    await notes.getByRole('button', { name: UI.save, exact: true }).click();
    await expect(notes).toHaveCount(0);
    await expect(row).toContainText(`Edited by e2e ${stamp}`);

    const entry = await requireOrg(req, finch);
    expect(entry).toMatchObject({ kind: 'agency', notes: `Edited by e2e ${stamp}` });
    // The server refuses a VA's rename too (requireRole('admin')).
    const rename = await req.patch(`${NEXT}/api/organizations/${entry.orgId}`, {
      data: { name: `Finch Renamed ${stamp}` },
    });
    expect(rename.status()).toBe(403);
  });

  test('an admin renames an entry: the rewrite job finishes and every record holds the new name', async ({
    page,
  }) => {
    test.slow(); // a rewrite job runs in-process, deferred, and is polled to done
    await devLoginAs(page, 'founder@example.com');
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const oldName = `Egret Housing Authority ${stamp}`;
    const newName = `Egret Valley Housing Authority ${stamp}`;
    const entry = await addOrg(req, { kind: 'housing_authority', name: oldName });
    const tenants = [
      (await createTenant(req, { firstName: `RenameA${stamp}`, housingAuthority: oldName })).contactId,
      (await createTenant(req, { firstName: `RenameB${stamp}`, housingAuthority: oldName })).contactId,
    ];
    const unitId = await createUnit(req, { line1: `${stamp} Egret Row`, authorities: [oldName] });

    // What uses the entry, counted per kind of record (D3, D10).
    expect((await getOrgUsage(req))[entry.orgId]).toEqual({
      tenants: 2,
      otherContacts: 0,
      properties: 1,
      deleted: 0,
    });

    await openOrgSettings(page);
    const row = entryRow(page, UI.haRegion, oldName);
    await expect(row).toContainText(UI.usedByTenants(2));
    await expect(row).toContainText(UI.usedByProperties(1));
    await row.getByRole('button', { name: UI.rename(oldName), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: UI.newNameBox, exact: true }).fill(newName);
    await dialog.getByRole('button', { name: UI.renameConfirm, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // A 202 starts the job; the lane runs it in-process and deferred - poll it.
    const rewrite = await waitForRewrite(req, (r) => r.action === 'rename' && r.toName === newName);
    expect(rewrite.counts).toMatchObject({ housingAuthority: 2, accepted_authorities: 1 });
    for (const contactId of tenants) {
      expect((await getContact(req, contactId)).housingAuthority).toBe(newName);
    }
    expect(await getUnitAuthorities(req, unitId)).toEqual([newName]);

    // The list shows the new name and keeps the old one as a spelling (D11).
    await page.reload();
    await expect(entryRow(page, UI.haRegion, newName)).toContainText(oldName);
    await expect(entryRow(page, UI.haRegion, oldName)).toHaveCount(0);

    // The property's Activity names the machine rewrite (plan 3.8).
    await page.goto(`${NEXT}/listings/${unitId}`);
    const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
    await expect(activity.getByText(UI.activityLabel).first()).toBeVisible();
    await expect(activity).toContainText(newName);
  });
});
