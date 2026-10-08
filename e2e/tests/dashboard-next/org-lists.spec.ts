// e2e/tests/dashboard-next/org-lists.spec.ts
//
// One clean name per housing authority and agency (tracker #2; design
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md,
// branch A), end to end against the real backend:
//   1. the pickers (D6, D7): the tenant form's Housing authority and Agency
//      pickers with "Is this really new?"; a stored value that is not on the
//      list, kept as a chip through an unrelated save; the property form's
//      multi-picker; the blast composer's picker (no add step, and the filter
//      changes only on a pick); text typed but never picked (code review
//      R1-ADV-FE-1, R2-FE-9): a form's Save commits a list name and refuses
//      anything else, the composer's Preview waits for a pick;
//   2. Settings > Housing authorities & agencies (D10-D13), a list beside a
//      detail panel (design review 2026-10-07 Option B): a VA adds an entry
//      and edits its notes; an admin renames one and the rewrite job finishes;
//   3. the "Not on the list" segment (D10, D11), fed by the dev seam: Show
//      records for everyone; Use, Move to Agency, Split and Clear for admins,
//      each one pick in the panel's settle group and its confirm;
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
import { extractionTick, sendExtractSms } from '../../fixtures/extraction.js';
import {
  addOrg,
  getNotOnList,
  getOrgList,
  getOrgUsage,
  requireOrg,
  sameOrgText,
  setOffListValue,
  waitForRewrite,
} from '../../fixtures/orgFixture.js';
import { expectTodayReady } from '../../support/today.js';
import { expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/**
 * Every accessible name this spec uses that plan section 3.11 does not pin -
 * the S14 selector contract (rows N1-N4, S1-S8, L1-L6, A1-A2). S11 is built
 * before this spec: when an as-built name differs, change it HERE (the
 * picker's own names live in ORG_PICKER, e2e/scenarios/steps.ts).
 */
const UI = {
  helpText: 'The organization that runs the voucher.',
  newDialog: 'Is this really new?',
  yesAddIt: 'Yes, add it',
  use: (name: string): string => `Use ${name}`,
  nameBox: 'Name',
  notesBox: 'Notes',
  settingsTab: 'Housing authorities & agencies',
  // The three lists: each a segment button ("Agencies 7") and, when shown, a
  // region named by its heading.
  lists: 'Lists',
  search: 'Search names and spellings',
  backTo: (list: string): string => `Back to ${list}`,
  haRegion: 'Housing authorities',
  agencyRegion: 'Agencies',
  notOnListRegion: 'Not on the list',
  settleGroup: 'Settle this value',
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
    await expect(page.getByText('Reaches 2 recipients', { exact: true })).toBeVisible();
    expect(sent.filter((a) => a !== undefined).every((a) => a === plover)).toBe(true);

    // The server resolves that exact name: Preview lists both tenants.
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByText(first)).toBeVisible();
    await expect(list.getByText(second)).toBeVisible();
  });
});

// ---- Text typed in an org picker but never picked (code review R1-ADV-FE-1,
// R2-FE-3, R2-FE-6, R2-FE-8, R2-FE-9) ----
// The jsdom units cover the rules; these pin them through real focus and
// layout: a form's Save commits typed text that names exactly one entry and
// refuses anything else (never dropping it silently), the note under a field
// left holding text says what Save will do without moving the controls below,
// and the composer - whose typed text is never a filter (D7) - holds Preview
// back until a pick or a clear.
test.describe('Org pickers: text typed but never picked', () => {
  const BLOCKED = 'Pick a name from the list, add it as new, or clear the text.';
  const PREVIEW_HINT = 'Pick the housing authority from the list, or clear the text.';

  test('tenant form: a list name typed in full and saved without a pick is stored as that name', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const bittern = `Bittern Housing Authority ${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: bittern });
    const { contactId } = await createTenant(req, { firstName: `OrgTyped${stamp}` });

    await page.goto(`${NEXT}/contacts/${contactId}`);
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    const dialog = page.getByRole('dialog', { name: /Edit contact/i });
    const authority = dialog.getByRole('combobox', { name: 'Housing authority', exact: true });
    const agency = dialog.getByRole('combobox', { name: 'Agency', exact: true });
    await authority.fill(bittern);
    await expect(page.getByRole('option', { name: ORG_PICKER.option(bittern) })).toBeVisible();

    // Leaving the field: the note says what Save will do with the text, and
    // the note's line was already there - the field below does not move
    // (measured against the field above, so a scroll cannot fake it).
    const offset = async (): Promise<number> =>
      ((await agency.boundingBox())?.y ?? Number.NaN) - ((await authority.boundingBox())?.y ?? Number.NaN);
    const before = await offset();
    await authority.press('Tab');
    await expect(agency).toBeFocused();
    await expect(dialog.getByText(`Save will use ${bittern}.`, { exact: true })).toBeVisible();
    expect(await offset()).toBe(before);

    // Saved WITHOUT a pick: the typed name is committed as a pick would be.
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    expect((await getContact(req, contactId)).housingAuthority).toBe(bittern);
  });

  test('tenant form: typed text that names no entry stops Save with an alert and saves nothing', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const unlisted = `Zz Unlisted Board ${stamp}`;
    const { contactId } = await createTenant(req, { firstName: `OrgRefused${stamp}`, voucherSize: 2 });

    await page.goto(`${NEXT}/contacts/${contactId}`);
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    const dialog = page.getByRole('dialog', { name: /Edit contact/i });
    await dialog.getByLabel('Voucher size (bedrooms)').fill('3');
    const authority = dialog.getByRole('combobox', { name: 'Housing authority', exact: true });
    await authority.fill(unlisted);
    await expect(page.getByRole('option', { name: ORG_PICKER.addOption })).toBeVisible();

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(BLOCKED);
    await expect(authority).toBeFocused();
    await expect(authority).toHaveValue(unlisted);
    // Nothing was saved - not the text, and not the other edit either.
    const unsaved = await getContact(req, contactId);
    expect(unsaved.voucherSize).toBe(2);
    expect(unsaved.housingAuthority).toBeUndefined();

    // Clearing the text lets the rest of the edit save.
    await authority.fill('');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    const saved = await getContact(req, contactId);
    expect(saved.voucherSize).toBe(3);
    expect(saved.housingAuthority).toBeUndefined();
  });

  test('blast composer: Preview waits while the housing authority filter holds typed text', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const pipit = `Pipit Housing Authority ${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: pipit });
    await createTenant(req, { firstName: `PipitA${stamp}`, voucherSize: 2, housingAuthority: pipit });
    const unitId = await createUnit(req, { line1: `${stamp} Pipit Way`, authorities: [pipit], available: true });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill(`Pipit check ${stamp}`);
    const previewButton = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewButton).toBeEnabled();

    // The exact name typed, its option showing, but not picked: it is no
    // filter (D7), so Preview waits and says why.
    const box = page.getByRole('combobox', { name: 'Housing authority', exact: true });
    await box.fill(pipit);
    await expect(page.getByRole('option', { name: ORG_PICKER.option(pipit) })).toBeVisible();
    await expect(previewButton).toBeDisabled();
    await expect(page.getByText(PREVIEW_HINT, { exact: true })).toBeVisible();

    // A pick makes it the filter: Preview goes, and the reach is the filtered one.
    await pickOrgName(page, page, 'Housing authority', pipit);
    await expect(previewButton).toBeEnabled();
    await expect(page.getByText(PREVIEW_HINT, { exact: true })).toHaveCount(0);
    await expect(page.getByText('Reaches 1 recipient', { exact: true })).toBeVisible();
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

/** A named section of the tab (each <section> is labelled by its heading):
 *  a list, or the detail panel - named by the entry or value it shows. */
function region(page: Page, name: string): Locator {
  return page.getByRole('region', { name, exact: true });
}

/** Show one of the three lists (a segment button named "<list> <count>"). */
async function showList(page: Page, list: string): Promise<void> {
  await page
    .getByRole('group', { name: UI.lists })
    .getByRole('button', { name: new RegExp(`^${list} \\d+$`) })
    .click();
  await expect(region(page, list)).toBeVisible();
}

/** One entry's row in its list: a link named by the exact name. */
function entryLink(page: Page, list: string, name: string): Locator {
  return region(page, list).getByRole('link', { name, exact: true });
}

/** Pick an entry (its list must be on screen); returns the detail panel. */
async function openEntry(page: Page, list: string, name: string): Promise<Locator> {
  await entryLink(page, list, name).click();
  const panel = region(page, name);
  await expect(panel.getByRole('heading', { name, exact: true })).toBeFocused();
  return panel;
}

/** Settings > Housing authorities & agencies through its tab (visible to every
 *  signed-in user, D10); waits until the starting list has rendered. */
async function openOrgSettings(page: Page): Promise<void> {
  await page.goto(`${NEXT}/settings`);
  await page.getByRole('tab', { name: UI.settingsTab }).click();
  await expect(entryLink(page, UI.haRegion, 'Atlanta Housing Authority')).toBeVisible();
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
    // Admin-only actions are not offered to a VA - absent, not disabled (D10).
    const atlanta = await openEntry(page, UI.haRegion, 'Atlanta Housing Authority');
    await expect(atlanta.getByRole('button', { name: UI.editNotes('Atlanta Housing Authority') })).toBeVisible();
    await expect(atlanta.getByRole('button', { name: /^Rename / })).toHaveCount(0);
    await showList(page, UI.notOnListRegion);
    await showList(page, UI.agencyRegion);
    await expect(entryLink(page, UI.agencyRegion, 'Step Up')).toBeVisible();

    // Add: a name and notes, through "Is this really new?" (D10).
    await region(page, UI.agencyRegion).getByRole('button', { name: UI.addAgency, exact: true }).click();
    const isNew = page.getByRole('dialog', { name: UI.newDialog });
    await isNew.getByRole('textbox', { name: UI.nameBox, exact: true }).fill(finch);
    await isNew.getByRole('textbox', { name: UI.notesBox, exact: true }).fill(`Added by e2e ${stamp}`);
    await isNew.getByRole('button', { name: UI.yesAddIt, exact: true }).click();
    await expect(isNew).toHaveCount(0);
    // The new entry opens in the panel, selected in its list.
    const panel = region(page, finch);
    await expect(panel).toContainText(`Added by e2e ${stamp}`);
    await expect(entryLink(page, UI.agencyRegion, finch)).toHaveAttribute('aria-current', 'page');

    // Notes: everyone edits them, and they touch no records (D10).
    await panel.getByRole('button', { name: UI.editNotes(finch), exact: true }).click();
    const notes = page.getByRole('dialog', { name: UI.editNotesDialog });
    await notes.getByRole('textbox', { name: UI.notesBox, exact: true }).fill(`Edited by e2e ${stamp}`);
    await notes.getByRole('button', { name: UI.save, exact: true }).click();
    await expect(notes).toHaveCount(0);
    await expect(panel).toContainText(`Edited by e2e ${stamp}`);

    const entry = await requireOrg(req, finch);
    expect(entry).toMatchObject({ kind: 'agency', notes: `Edited by e2e ${stamp}` });
    // The server refuses a VA's rename too (requireRole('admin')).
    const rename = await req.patch(`${NEXT}/api/organizations/${entry.orgId}`, {
      data: { name: `Finch Renamed ${stamp}` },
    });
    expect(rename.status()).toBe(403);
  });

  test('at phone width one pane shows at a time: pick a row, the panel alone, Back returns to the list', async ({
    page,
  }) => {
    await devLogin(page); // the seeded VA
    await page.setViewportSize({ width: 390, height: 844 });
    // Below the nav breakpoint the Settings tabs are a <select>: go straight in.
    await page.goto(`${NEXT}/settings/organizations`);
    const atlanta = entryLink(page, UI.haRegion, 'Atlanta Housing Authority');
    await expect(atlanta).toBeVisible();
    await expect(page.getByRole('group', { name: UI.lists })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: UI.search })).toBeVisible();

    const panel = await openEntry(page, UI.haRegion, 'Atlanta Housing Authority');
    await expect(page).toHaveURL(/\/settings\/organizations\/[^/?]+$/);
    // One pane: the panel alone - no list, no segments, no search, no Close.
    await expect(region(page, UI.haRegion)).toBeHidden();
    await expect(page.getByRole('group', { name: UI.lists })).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: UI.search })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: 'Close', exact: true })).toHaveCount(0);

    // Back (its name is exactly "Back to <list>"): the list again, focus on
    // the row it came from.
    await panel.getByRole('link', { name: UI.backTo(UI.haRegion), exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/organizations$/);
    await expect(region(page, 'Atlanta Housing Authority')).toHaveCount(0);
    await expect(atlanta).toBeVisible();
    await expect(atlanta).toBeFocused();
    // No horizontal scroll at phone width - measured on the routed <main>,
    // which is what scrolls in this app shell (support/viewport.ts).
    await expectNoHorizontalOverflow(page, 'org settings list at 390px');
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
      organization: 0,
      deleted: 0,
      inUse: { active: 3, deleted: 0 },
      kindLocked: { active: 3, deleted: 0 },
    });

    await openOrgSettings(page);
    const panel = await openEntry(page, UI.haRegion, oldName);
    await expect(panel).toContainText(UI.usedByTenants(2));
    await expect(panel).toContainText(UI.usedByProperties(1));
    await panel.getByRole('button', { name: UI.rename(oldName), exact: true }).click();
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

    // The entry stays selected (its URL is its id): the panel shows the new
    // name and keeps the old one as a spelling chip (D11).
    await page.reload();
    await expect(
      region(page, newName).getByRole('list', { name: `Spellings of ${newName}` }).getByText(oldName, { exact: true }),
    ).toBeVisible();
    await expect(entryLink(page, UI.haRegion, newName)).toBeVisible();
    await expect(entryLink(page, UI.haRegion, oldName)).toHaveCount(0);

    // The property's Activity names the machine rewrite (plan 3.8).
    await page.goto(`${NEXT}/listings/${unitId}`);
    const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
    await expect(activity.getByText(UI.activityLabel).first()).toBeVisible();
    await expect(activity).toContainText(newName);
  });
});

// ---- "Not on the list" (spec D10, D11) ----

/** A value's row in the "Not on the list" list: a link named by the exact
 *  value (no two values in one test share a text across fields). */
function valueLink(page: Page, value: string): Locator {
  return region(page, UI.notOnListRegion).getByRole('link', { name: value, exact: true });
}

/** Pick a value (the list must be on screen); returns the detail panel. */
async function openValue(page: Page, value: string): Promise<Locator> {
  await valueLink(page, value).click();
  const panel = region(page, value);
  await expect(panel.getByRole('heading', { name: value, exact: true })).toBeFocused();
  return panel;
}

/** Pick a settle choice in the panel; returns the settle group, whose
 *  confirm (named as the choice) sits under the pick. */
async function pickSettle(panel: Locator, choice: string): Promise<Locator> {
  const settle = panel.getByRole('group', { name: UI.settleGroup });
  await settle.getByRole('radio', { name: choice, exact: true }).check();
  return settle;
}

/** Press the confirm, then wait until the page has left the settled value's
 *  URL (it replaces it with the list's) - so a later reload cannot land on
 *  the value it just settled (code review r1, e2e race). */
async function confirmSettle(page: Page, settle: Locator, confirm: string): Promise<void> {
  await settle.getByRole('button', { name: confirm, exact: true }).click();
  await page.waitForURL((url) => !url.searchParams.has('value'));
}

test.describe('"Not on the list" (spec D10, D11)', () => {
  test('everyone sees each value with its records; settling it is admin-only', async ({ page }) => {
    await devLogin(page); // the seeded VA
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const contactValue = `Linnet Hsg ${stamp}`;
    const unitValue = `Linnet Old ${stamp}`;
    const liveFirst = `NotListLive${stamp}`;
    const goneFirst = `NotListGone${stamp}`;
    const live = (await createTenant(req, { firstName: liveFirst })).contactId;
    const gone = (await createTenant(req, { firstName: goneFirst })).contactId;
    for (const contactId of [live, gone]) {
      await setOffListValue(req, { contactId, field: 'housingAuthority', value: contactValue });
    }
    const removed = await req.delete(`${NEXT}/api/contacts/${gone}`);
    expect(removed.ok(), await removed.text()).toBeTruthy();
    const line1 = `${stamp} Linnet Lane`;
    const unitId = await createUnit(req, { line1, authorities: ['Atlanta Housing Authority'] });
    await setOffListValue(req, { unitId, field: 'accepted_authorities', value: unitValue });

    // One row per value and field; active and deleted holders counted apart (D10).
    const rows = await getNotOnList(req);
    expect(rows.find((r) => r.field === 'housingAuthority' && r.value === contactValue)).toMatchObject({
      count: 1,
      deletedCount: 1,
    });
    expect(rows.find((r) => r.field === 'accepted_authorities' && r.value === unitValue)).toMatchObject({
      count: 1,
      deletedCount: 0,
    });

    await openOrgSettings(page);
    await showList(page, UI.notOnListRegion);
    const contactPanel = await openValue(page, contactValue);
    // A VA gets no settling at all - the group is absent, not disabled (D10)...
    await expect(contactPanel.getByRole('group', { name: UI.settleGroup })).toHaveCount(0);
    await expect(contactPanel.getByRole('radio')).toHaveCount(0);
    // ...but sees the records, each linked to its own page, the deleted one marked.
    await contactPanel.getByRole('button', { name: UI.showRecords, exact: true }).click();
    await expect(contactPanel.getByRole('link', { name: new RegExp(liveFirst) })).toHaveAttribute(
      'href',
      `/contacts/${live}`,
    );
    await expect(contactPanel.getByRole('link', { name: new RegExp(goneFirst) })).toHaveAttribute(
      'href',
      `/contacts/${gone}`,
    );
    await expect(contactPanel.getByRole('listitem').filter({ hasText: goneFirst })).toContainText(UI.deletedMarker);
    await expect(contactPanel.getByRole('listitem').filter({ hasText: liveFirst })).not.toContainText(
      UI.deletedMarker,
    );
    const unitPanel = await openValue(page, unitValue);
    await unitPanel.getByRole('button', { name: UI.showRecords, exact: true }).click();
    await expect(unitPanel.getByRole('link', { name: new RegExp(line1) })).toHaveAttribute(
      'href',
      `/listings/${unitId}`,
    );

    // The server enforces it too (requireRole('admin')).
    const resolve = await req.post(`${NEXT}/api/organizations/not-on-list/resolve`, {
      data: { field: 'housingAuthority', value: contactValue, action: 'clear' },
    });
    expect(resolve.status()).toBe(403);
  });

  test('an admin settles values: Use, Move to Agency, Split and Clear each rewrite the records', async ({
    page,
  }) => {
    test.slow(); // four rewrite jobs, strictly one at a time (D11)
    await devLoginAs(page, 'founder@example.com');
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const merlin = `Merlin Housing Authority ${stamp}`;
    const kiteAid = `Kite Aid ${stamp}`;
    const shrike = `Shrike Housing Authority ${stamp}`;
    const shrikeAid = `Shrike Aid ${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: merlin });
    await addOrg(req, { kind: 'agency', name: kiteAid });
    await addOrg(req, { kind: 'housing_authority', name: shrike });
    await addOrg(req, { kind: 'agency', name: shrikeAid });
    // Five values, none containing another (rows are found by their text).
    const useValue = merlin.toLowerCase(); // resolves to merlin, but is not its exact text (D3)
    const moveValue = kiteAid; // an agency's exact name in a housing authority field
    const splitValue = `${shrike} ${shrikeAid}`; // compound: a name of each kind (D4)
    const clearValue = `Rook Junk ${stamp}`; // resolves to nothing
    const keepValue = `Rook Keep ${stamp}`; // never settled: proves the section loaded
    const holderOf = async (label: string, value: string): Promise<string> => {
      const { contactId } = await createTenant(req, { firstName: `Settle${label}${stamp}` });
      await setOffListValue(req, { contactId, field: 'housingAuthority', value });
      return contactId;
    };
    const useHolder = await holderOf('Use', useValue);
    const moveHolder = await holderOf('Move', moveValue);
    const splitHolder = await holderOf('Split', splitValue);
    const clearHolder = await holderOf('Clear', clearValue);
    await holderOf('Keep', keepValue);

    await openOrgSettings(page);
    await showList(page, UI.notOnListRegion);
    // Each action is one pick in the panel's settle group, and its confirm
    // repeats it (selector contract L3-L6). After a settle the page goes back
    // to the list, and its URL keeps the list on reload.

    // Use <name>: the value resolves to one entry (D10). "Remember this
    // spelling" is off - the value IS the name in another case (D12) - and the
    // action still runs.
    let settle = await pickSettle(await openValue(page, useValue), UI.use(merlin));
    await expect(settle.getByRole('checkbox', { name: UI.rememberSpelling })).not.toBeChecked();
    await confirmSettle(page, settle, UI.use(merlin));
    await waitForRewrite(req, (r) => r.action === 'use' && r.fromTexts.some((t) => sameOrgText(t, useValue)));
    expect((await getContact(req, useHolder)).housingAuthority).toBe(merlin);

    // Move to Agency as <name>: an agency name out of the housing authority field.
    await page.reload();
    settle = await pickSettle(await openValue(page, moveValue), UI.moveToAgency(kiteAid));
    await confirmSettle(page, settle, UI.moveToAgency(kiteAid));
    await waitForRewrite(
      req,
      (r) => r.action === 'move_to_agency' && r.fromTexts.some((t) => sameOrgText(t, moveValue)),
    );
    const moved = await getContact(req, moveHolder);
    expect(moved.agency).toBe(kiteAid);
    expect(moved.housingAuthority).toBeUndefined();

    // Split into <housing authority> + <agency>: both halves prefilled (D10).
    await page.reload();
    settle = await pickSettle(await openValue(page, splitValue), UI.split(shrike, shrikeAid));
    await confirmSettle(page, settle, UI.splitConfirm);
    await waitForRewrite(req, (r) => r.action === 'split' && r.fromTexts.some((t) => sameOrgText(t, splitValue)));
    const split = await getContact(req, splitHolder);
    expect(split.housingAuthority).toBe(shrike);
    expect(split.agency).toBe(shrikeAid);

    // Clear: the housing authority is REMOVEd, never set to '' (D5, D11).
    await page.reload();
    settle = await pickSettle(await openValue(page, clearValue), UI.clear);
    await confirmSettle(page, settle, UI.clear);
    await waitForRewrite(req, (r) => r.action === 'clear' && r.fromTexts.some((t) => sameOrgText(t, clearValue)));
    expect((await getContact(req, clearHolder)).housingAuthority).toBeUndefined();

    // Settled values leave the list; the unsettled one stays.
    await page.reload();
    await expect(valueLink(page, keepValue)).toBeVisible();
    for (const value of [useValue, moveValue, splitValue, clearValue]) {
      await expect(valueLink(page, value)).toHaveCount(0);
    }
  });
});

// ---- AI housing authority suggestions (spec D8) ----

/** The one extraction run of a contact in the admin AI run log
 *  (ai-run-log.spec.ts's openRunFor, trimmed). Returns the detail region. */
async function openRunFor(page: Page, contactId: string): Promise<Locator> {
  await page.goto(`${NEXT}/settings/ai-runs?scope=${encodeURIComponent(`contacts#${contactId}`)}`);
  await expect(page.getByRole('heading', { name: 'AI run log' })).toBeVisible();
  const row = page.getByRole('list', { name: 'AI runs' }).getByRole('button');
  await expect(row).toHaveCount(1);
  await row.click();
  const detail = page.getByRole('region', { name: 'AI run detail' });
  await expect(detail).toBeVisible();
  return detail;
}

function decisionRow(page: Page, target: string): Locator {
  return page.getByRole('table', { name: 'Decisions' }).getByRole('row', { name: new RegExp(`^${target}\\b`, 'i') });
}

/** A fake-driver marker carrying only a housingAuthority finding. */
function housingAuthorityMarker(op: 'write' | 'suggest', value: string): Record<string, unknown> {
  return { fields: { housingAuthority: { op, value, reason: 'the tenant said so' } } };
}

test.describe('AI housing authority suggestions (spec D8)', () => {
  test('an ambiguous AHA is accepted as the candidate staff pick in "Is this really new?"', async ({
    page,
    request,
  }) => {
    await devLoginAs(page, 'founder@example.com'); // admin: the run log is admin-only
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { contactId, phone } = await createTenant(req, { firstName: `AiAha${stamp}` });
    await sendExtractSms(request, phone, housingAuthorityMarker('suggest', 'AHA'));
    expect((await extractionTick(request)).processed).toBeGreaterThan(0);

    await page.goto(`${NEXT}/contacts/${contactId}`);
    const chip = page.getByRole('group', { name: 'AI suggestion for housing authority' });
    await expect(chip.getByText('AI heard "AHA"')).toBeVisible();
    await chip.getByRole('button', { name: 'Accept' }).click();

    // AHA is a shared spelling, so the dialog offers both of its names (D8).
    const isNew = page.getByRole('dialog', { name: UI.newDialog });
    await expect(isNew.getByRole('button', { name: UI.use('Augusta Housing Authority'), exact: true })).toBeVisible();
    await isNew.getByRole('button', { name: UI.use('Atlanta Housing Authority'), exact: true }).click();
    await expect(isNew).toHaveCount(0);
    await expect(chip).toHaveCount(0);
    expect((await getContact(req, contactId)).housingAuthority).toBe('Atlanta Housing Authority');

    // One of the text's own candidates is an ACCEPT, not a human edit (D8).
    await openRunFor(page, contactId);
    await expect(decisionRow(page, 'housingAuthority')).toContainText(/accepted/i);
  });

  test('an unknown name is suggested, never written, and Yes, add it adds it and accepts', async ({
    page,
    request,
  }) => {
    await devLoginAs(page, 'founder@example.com');
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const wren = `Wren Housing Authority ${stamp}`;
    const { contactId, phone } = await createTenant(req, { firstName: `AiWren${stamp}` });
    // op "write": an unknown name is DEMOTED to a staff suggestion (D8).
    await sendExtractSms(request, phone, housingAuthorityMarker('write', wren));
    expect((await extractionTick(request)).processed).toBeGreaterThan(0);
    expect((await getContact(req, contactId)).housingAuthority).toBeUndefined();

    await page.goto(`${NEXT}/contacts/${contactId}`);
    const chip = page.getByRole('group', { name: 'AI suggestion for housing authority' });
    await expect(chip.getByText(`AI heard "${wren}"`)).toBeVisible();
    await chip.getByRole('button', { name: 'Accept' }).click();
    const isNew = page.getByRole('dialog', { name: UI.newDialog });
    await isNew.getByRole('button', { name: UI.yesAddIt, exact: true }).click();
    await expect(isNew).toHaveCount(0);
    await expect(chip).toHaveCount(0);

    // The name staff just added from the text resolves, so the accept stands.
    expect((await getContact(req, contactId)).housingAuthority).toBe(wren);
    expect((await getOrgList(req)).entries.find((e) => e.name === wren)?.kind).toBe('housing_authority');
    await openRunFor(page, contactId);
    await expect(decisionRow(page, 'housingAuthority')).toContainText(/accepted/i);
  });

  test('an agency name returned for the housing authority is dropped with its label', async ({ page, request }) => {
    await devLoginAs(page, 'founder@example.com');
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { contactId, phone } = await createTenant(req, { firstName: `AiAgency${stamp}` });
    await sendExtractSms(request, phone, housingAuthorityMarker('write', 'Step Up'));
    expect((await extractionTick(request)).processed).toBeGreaterThan(0);

    // Never written and never suggested: agency names are never housing authorities (D8).
    expect((await getContact(req, contactId)).housingAuthority).toBeUndefined();
    const pending = await req.get(`${NEXT}/api/contacts/${contactId}/suggestions`);
    expect(pending.ok(), await pending.text()).toBeTruthy();
    const { suggestions } = (await pending.json()) as { suggestions: Array<{ target: string }> };
    expect(suggestions.some((s) => s.target === 'housingAuthority')).toBe(false);

    const detail = await openRunFor(page, contactId);
    await expect(decisionRow(page, 'housingAuthority')).toContainText(UI.agencyDropLabel);

    // The run records which list it saw, and the detail header shows it (plan 3.10).
    const listed = await req.get(`${NEXT}/api/ai-runs?scope=${encodeURIComponent(`contacts#${contactId}`)}`);
    expect(listed.ok(), await listed.text()).toBeTruthy();
    const runs = ((await listed.json()) as { runs: Array<{ runId: string }> }).runs;
    expect(runs).toHaveLength(1);
    const runRes = await req.get(`${NEXT}/api/ai-runs/${runs[0]?.runId ?? ''}`);
    expect(runRes.ok(), await runRes.text()).toBeTruthy();
    const { run } = (await runRes.json()) as { run: { orgListFingerprint?: string } };
    expect(run.orgListFingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expect(detail).toContainText((run.orgListFingerprint ?? '').slice(0, 12));
  });
});
