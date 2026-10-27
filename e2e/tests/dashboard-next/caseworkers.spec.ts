// e2e/tests/dashboard-next/caseworkers.spec.ts
//
// Caseworkers (tracker #19; design
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md,
// branch B, D16-D22), end to end against the real backend:
//   1. the caseworker conversion from a contact page: More actions > Make
//      caseworker, the dialog's read-only preview, Confirm; the contact, its
//      re-typed thread, and the Caseworkers tab row with its Organization chip;
//   2. the conversion's refusals, READ-ONLY, on two seeded contacts: Tasha
//      Nguyen (open placement) and Marcus Bell (landlord of record);
//   3. the Possible caseworkers list: one row per signal, Make caseworker from
//      a row, and Not a caseworker;
//   4. the Unknown card's Mark as Caseworker on an inbound-created unknown
//      contact, accepting the AI's partner suggestion.
//
// dashboard-next dialect (e2e/support/selectors.md). ISOLATION (planner
// rulings, "E2E rules"): every contact a test converts or dismisses is one it
// created with a run-unique name; seeded contacts are only READ (Tasha and
// Marcus are refused, so their dialogs are cancelled and their refusals are
// read through the GET preview, never a POST); no test asserts a count or an
// empty state on the Possible list or the Caseworkers tab - every spec in the
// lane adds rows there (contact-create's "Case worker <stamp>" tenants among
// them). The one reseed in beforeAll makes the two refusal fixtures
// deterministic (placement-0001 open, Marcus the landlord of unit-0001 and
// unit-0002); a reseed logs the browser out, and every test signs in.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { addOrg } from '../../fixtures/orgFixture.js';
import { extractionTick, sendExtractSms } from '../../fixtures/extraction.js';
import { ORG_PICKER } from '../../scenarios/steps.js';
import { expectNoAiSuggestionFor, expectTodayReady } from '../../support/today.js';
import { WIDE_RESTORE, expectNoHorizontalOverflowIn } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
/** Lean seed: a tenant with an OPEN placement (placement-0001). Read-only. */
const TASHA = { contactId: 'contact-tenant-0001', name: 'Tasha Nguyen' };
/** Lean seed: the landlord of record of unit-0001 and unit-0002. Read-only. */
const MARCUS = { contactId: 'contact-landlord-0001', name: 'Marcus Bell' };
const ATLANTA = 'Atlanta Housing Authority';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every accessible name and copy string this spec uses - the S10 selector
 * contract (plan 3.9; the plan's assembly rulings on the row lists, the
 * dismiss confirm container and the singular dialog sentences). When S8's as-built name
 * differs from a non-binding row, change it HERE only.
 */
const UI = {
  workspaceNav: 'Workspace',
  navLink: 'Caseworkers',
  pageHeading: 'Caseworkers',
  rowsList: 'Caseworkers',
  possibleList: 'Possible caseworkers',
  orgChips: 'Organization',
  orgChip: (org: string): RegExp => new RegExp(`^${escapeRegExp(org)} \\(`),
  moreActions: 'More actions',
  makeMenuItem: 'Make caseworker',
  dialog: (name: string): string => `Make ${name} a caseworker`,
  anyDialog: /^Make .+ a caseworker$/,
  confirm: 'Make caseworker',
  cancel: 'Cancel',
  orgPicker: 'Organization',
  removesHousingAuthority: (value: string): string => `Housing authority: ${value}`,
  removesAgency: (value: string): string => `Agency: ${value}`,
  retypesOne: /^1 conversation will become (a )?partner conversations?\.$/,
  refusalPlacement: "Finish or close this contact's placement first.",
  refusalLandlord:
    "This contact is the landlord of record for a property. Change that property's landlord first.",
  viewPlacement: 'View placement',
  viewProperty: 'View property',
  caseworkerBadge: 'Caseworker',
  makeRow: (name: string): string => `Make ${name} a caseworker`,
  dismissRow: (name: string): string => `${name} is not a caseworker`,
  dismissQuestion: (name: string): string => `Hide ${name} from Possible caseworkers?`,
  dismissWarning: "This can't be undone in the app.",
  hide: 'Hide',
  signal: {
    roleMentions: 'Role mentions caseworker',
    aiNote: 'AI noted caseworker',
    relationship: 'Linked as a caseworker',
    partnerNoRole: 'Partner with no role',
  },
  triageHeading: 'Needs triage',
  markAsCaseworker: 'Mark as Caseworker',
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

/** POST /api/contacts (a NEW contact: the POST takes type, role, notes and
 *  relationships; it ignores the org fields). Returns the contactId. */
async function createContact(request: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts`, { data });
  expect(res.ok(), `create ${String(data['firstName'])}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** PATCH /api/contacts/:id - the org fields go through the D5 check here. */
async function patchContact(
  request: APIRequestContext,
  contactId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`${NEXT}/api/contacts/${contactId}`, { data });
  expect(res.ok(), `patch ${contactId}: ${await res.text()}`).toBeTruthy();
}

async function readContact(request: APIRequestContext, contactId: string): Promise<Record<string, unknown>> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), `read contact ${contactId}`).toBeTruthy();
  return ((await res.json()) as { contact: Record<string, unknown> }).contact;
}

/** POST /api/contacts/:id/conversation is ensureContactConversation: it
 *  RETURNS the contact's open 1:1 thread, minting one by contact type only
 *  when there is none. Every caller here reads a thread that already exists
 *  (or, the first call in the conversion test, deliberately mints the
 *  tenant thread the conversion must re-type). */
async function readConversationType(request: APIRequestContext, contactId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), `resolve conversation ${contactId}`).toBeTruthy();
  return ((await res.json()) as { conversation: { type: string } }).conversation.type;
}

interface PreviewWire {
  alreadyCaseworker: boolean;
  refusals: Array<Record<string, string>>;
}

/** GET /api/contacts/:id/caseworker-review/preview - read-only (plan 3.5). */
async function readPreview(request: APIRequestContext, contactId: string): Promise<PreviewWire> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}/caseworker-review/preview`);
  expect(res.ok(), `preview ${contactId}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as PreviewWire;
}

/** Open the conversion dialog from the contact page's More actions menu. */
async function openMakeCaseworker(page: Page, contactId: string, name: string): Promise<Locator> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await page.getByRole('button', { name: UI.moreActions }).click();
  await page.getByRole('menuitem', { name: UI.makeMenuItem, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: UI.dialog(name), exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Contacts > Caseworkers through the Workspace nav link (D18). */
async function openCaseworkersTab(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: UI.workspaceNav })
    .getByRole('link', { name: UI.navLink, exact: true })
    .click();
  await expect(page).toHaveURL(/\/contacts\/caseworkers(\?|$)/);
  await expect(page.getByRole('heading', { name: UI.pageHeading, exact: true })).toBeVisible();
}

/** A caseworker row on the Caseworkers tab, by a run-unique full name. */
function caseworkerRow(page: Page, name: string): Locator {
  return page
    .getByRole('list', { name: UI.rowsList, exact: true })
    .getByRole('listitem')
    .filter({ hasText: name });
}

/** A Possible caseworkers row, by a run-unique full name. */
function possibleRow(page: Page, name: string): Locator {
  return page
    .getByRole('list', { name: UI.possibleList, exact: true })
    .getByRole('listitem')
    .filter({ hasText: name });
}

/**
 * The auto-captured (unknown) contact an inbound created, by phone - through
 * the EXACT `?phone=` lookup (a byPhone Query answering 0 or 1 contact,
 * app/src/routes/contacts.ts), never by scanning `?type=unknown`: that list is
 * one page of 50, unordered within a status, so a lane holding more than 50
 * unknowns would hide this one (plan review R1 ruling A11).
 */
async function findUnknownContactId(request: APIRequestContext, phone: string): Promise<string> {
  let contactId: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        contactId = ((await res.json()) as { contacts: Array<{ contactId: string; type?: string }> }).contacts.find(
          (c) => c.type === 'unknown',
        )?.contactId;
        return contactId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return contactId as string;
}

/** The targets of the contact's PENDING AI suggestions. */
async function pendingSuggestionTargets(request: APIRequestContext, contactId: string): Promise<string[]> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}/suggestions`);
  expect(res.ok(), `suggestions ${contactId}`).toBeTruthy();
  return ((await res.json()) as { suggestions: Array<{ target: string }> }).suggestions.map((s) => s.target);
}

function formattedPhone(phone: string): string {
  return `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
}

test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test.describe('Caseworkers - the conversion from a contact page', () => {
  test('More actions > Make caseworker converts a tenant; the Caseworkers tab lists it under its organization', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const agency = `Quillwort Family Services ${stamp}`;
    const lastName = `Cwkconv${stamp}`;
    const name = `Convert ${lastName}`;

    await addOrg(req, { kind: 'agency', name: agency });
    const contactId = await createContact(req, {
      type: 'tenant',
      firstName: 'Convert',
      lastName,
      phone: uniquePhone(),
    });
    await patchContact(req, contactId, { housingAuthority: ATLANTA, agency });
    // The tenant's own 1:1 thread, minted here as tenant_1to1 - the thread the
    // conversion must re-type (D21).
    expect(await readConversationType(req, contactId)).toBe('tenant_1to1');

    // The contacts PATCH never makes a caseworker (D16): 409, nothing written.
    const refused = await req.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { type: 'partner', role: 'Caseworker' },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toBe('caseworker_use_conversion');
    expect(await readContact(req, contactId)).toMatchObject({ type: 'tenant' });

    const dialog = await openMakeCaseworker(page, contactId, name);
    // The read-only preview: what the conversion removes, the thread it
    // re-types, and the organization it would write - the agency, a list
    // match (D19: the agency wins over the housing authority).
    await expect(dialog.getByText(UI.removesHousingAuthority(ATLANTA), { exact: true })).toBeVisible();
    await expect(dialog.getByText(UI.removesAgency(agency), { exact: true })).toBeVisible();
    await expect(dialog.getByText(UI.retypesOne)).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: UI.orgPicker, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: ORG_PICKER.removeChip(agency), exact: true })).toBeVisible();

    const confirm = dialog.getByRole('button', { name: UI.confirm, exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);

    // The page re-renders as a partner file, badged "Caseworker", with the
    // organization in the header facts (D22).
    await expect(page.getByText(UI.caseworkerBadge, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(agency).first()).toBeVisible();
    // The offer is gated on the STORED contact: a caseworker gets no Make caseworker.
    await page.getByRole('button', { name: UI.moreActions }).click();
    await expect(page.getByRole('menuitem', { name: UI.makeMenuItem, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // One write: the new identity, the removed values kept on the record
    // (D19 step 1), and the thread re-typed (step 3).
    const contact = await readContact(req, contactId);
    expect(contact).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      type_source: 'manual',
      organization: agency,
      agency: '',
      caseworker_conversion: { fromType: 'tenant', housingAuthority: ATLANTA, agency },
    });
    expect(contact['housingAuthority']).toBeUndefined();
    expect(await readConversationType(req, contactId)).toBe('partner_1to1');

    // Contacts > Caseworkers: the row with its organization, gone from the
    // Possible list, and found by its Organization chip (URL param `org`).
    await openCaseworkersTab(page);
    const row = caseworkerRow(page, name);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agency);
    await expect(possibleRow(page, name)).toHaveCount(0);
    const chip = page
      .getByRole('group', { name: UI.orgChips, exact: true })
      .getByRole('button', { name: UI.orgChip(agency) });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]org=/);
    await expect(row).toBeVisible();
  });

  test('the refusals show read-only on seeded contacts: an open placement and a landlord of record', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;

    // The preview is a GET: it computes the refusals and writes nothing.
    const tasha = await readPreview(req, TASHA.contactId);
    expect(tasha.alreadyCaseworker).toBe(false);
    expect(tasha.refusals).toContainEqual({ code: 'caseworker_open_placement', placementId: 'placement-0001' });
    const marcus = await readPreview(req, MARCUS.contactId);
    expect(marcus.refusals).toContainEqual({ code: 'caseworker_landlord_of_record', unitId: 'unit-0001' });

    // Tasha: the open-placement sentence links the placement; Make caseworker
    // stays disabled (R4-09); Cancel writes nothing.
    let dialog = await openMakeCaseworker(page, TASHA.contactId, TASHA.name);
    await expect(dialog.getByText(UI.refusalPlacement)).toBeVisible();
    await expect(dialog.getByRole('link', { name: UI.viewPlacement }).first()).toHaveAttribute(
      'href',
      '/placements/placement-0001',
    );
    await expect(dialog.getByRole('button', { name: UI.confirm, exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: UI.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Marcus: one landlord-of-record sentence per blocking property (two in
    // the lean world - and more if a spec gave him another unit): first only.
    dialog = await openMakeCaseworker(page, MARCUS.contactId, MARCUS.name);
    await expect(dialog.getByText(UI.refusalLandlord).first()).toBeVisible();
    await expect(dialog.getByRole('link', { name: UI.viewProperty }).first()).toHaveAttribute(
      'href',
      /^\/listings\/[^/]+$/,
    );
    await expect(dialog.getByRole('button', { name: UI.confirm, exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: UI.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Nothing was written to either seeded contact.
    expect(await readContact(req, TASHA.contactId)).toMatchObject({ type: 'tenant' });
    expect(await readContact(req, MARCUS.contactId)).toMatchObject({ type: 'landlord' });
  });
});

test.describe('Caseworkers - the Caseworkers tab rows', () => {
  test('a long organization gives way on the row: the name stays whole at mid widths', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // Organization names may run to 120 characters; this one is ~100.
    const agency = `Longorg ${stamp} Metropolitan Community Behavioral Health and Supportive Housing Collaborative`;
    const lastName = `Cwklong${stamp}`;
    const name = `Wide ${lastName}`;
    await addOrg(req, { kind: 'agency', name: agency });
    const contactId = await createContact(req, {
      type: 'partner',
      role: 'Caseworker',
      firstName: 'Wide',
      lastName,
      phone: uniquePhone(),
    });
    await patchContact(req, contactId, { organization: agency });

    await openCaseworkersTab(page);
    const row = caseworkerRow(page, name);
    await expect(row).toBeVisible();
    // 1024 and 900 are the widths that once crushed the name to 0px: the pane
    // is above the 560px stacking query, so the row stays on one line and the
    // organization, not the name, must absorb the deficit.
    for (const width of [1024, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const link = row.getByRole('link');
      await expectNoHorizontalOverflowIn(link, `caseworker row at ${width}px`);
      const nameBox = await row.getByText(name, { exact: true }).evaluate((el) => ({
        width: el.clientWidth,
        overflow: el.scrollWidth - el.clientWidth,
      }));
      expect(nameBox.width, `the name is visible at ${width}px`).toBeGreaterThan(0);
      expect(nameBox.overflow, `the name is not truncated at ${width}px`).toBeLessThanOrEqual(1);
      const org = row.getByText(agency, { exact: true });
      await expect(org).toBeVisible();
      await expect(org).toHaveAttribute('title', agency);
    }
    // Stacked (a pane at or under 560px, a phone): the organization wraps in
    // full, since a touch device never shows the title.
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoHorizontalOverflowIn(row.getByRole('link'), 'caseworker row at 375px');
    const orgOverflow = await row
      .getByText(agency, { exact: true })
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(orgOverflow, 'the organization is not truncated at 375px').toBeLessThanOrEqual(1);
    await page.setViewportSize(WIDE_RESTORE);
  });
});

test.describe('Caseworkers - the Possible caseworkers list', () => {
  test('one row per signal; Make caseworker from a row; Not a caseworker hides a row for good', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const lastName = `Pcw${stamp}`;
    const full = (first: string): string => `${first} ${lastName}`;

    // One run-unique contact per signal (D19, D22), plus three that must be
    // on NEITHER list. All through the real POST: no seed, no dev seam.
    const mentions = await createContact(req, {
      type: 'tenant',
      firstName: 'Mentions',
      lastName,
      role: `Case Manager ${stamp}`,
    });
    await createContact(req, {
      type: 'tenant',
      firstName: 'Noted',
      lastName,
      // The extraction's own line: the `[Auto - <date>]` prefix is required.
      notes: `[Auto - Jan 5] Identified as a caseworker at Quillwort ${stamp}`,
    });
    const linked = await createContact(req, { type: 'tenant', firstName: 'Linked', lastName });
    await createContact(req, {
      type: 'tenant',
      firstName: 'Holder',
      lastName,
      relationships: [{ role: 'Caseworker', name: full('Linked'), contactId: linked }],
    });
    const norole = await createContact(req, { type: 'partner', firstName: 'Norole', lastName });
    // A partner whose role is not a caseworker role is on neither list (D19).
    await createContact(req, {
      type: 'partner',
      firstName: 'Staffer',
      lastName,
      role: `Case Manager ${stamp}`,
    });
    // The same words WITHOUT the extraction prefix are not the AI's line (D22).
    await createContact(req, {
      type: 'tenant',
      firstName: 'Typed',
      lastName,
      notes: 'Identified as a caseworker at the front desk',
    });

    await openCaseworkersTab(page);
    await expect(possibleRow(page, full('Mentions'))).toContainText(UI.signal.roleMentions);
    await expect(possibleRow(page, full('Noted'))).toContainText(UI.signal.aiNote);
    await expect(possibleRow(page, full('Linked'))).toContainText(UI.signal.relationship);
    await expect(possibleRow(page, full('Norole'))).toContainText(UI.signal.partnerNoRole);
    for (const first of ['Holder', 'Staffer', 'Typed']) {
      await expect(possibleRow(page, full(first))).toHaveCount(0);
      await expect(caseworkerRow(page, full(first))).toHaveCount(0);
    }

    // Make caseworker from a row: the same dialog as the contact page (D19).
    await possibleRow(page, full('Mentions'))
      .getByRole('button', { name: UI.makeRow(full('Mentions')), exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: UI.dialog(full('Mentions')), exact: true });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: UI.confirm, exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(possibleRow(page, full('Mentions'))).toHaveCount(0);
    await expect(caseworkerRow(page, full('Mentions'))).toBeVisible();
    expect(await readContact(req, mentions)).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      caseworker_conversion: { fromType: 'tenant', fromRole: `Case Manager ${stamp}` },
    });

    // Not a caseworker: a one-line confirm, then the row is gone for good.
    await possibleRow(page, full('Norole'))
      .getByRole('button', { name: UI.dismissRow(full('Norole')), exact: true })
      .click();
    const hide = page.getByRole('dialog').filter({ hasText: UI.dismissQuestion(full('Norole')) });
    await expect(hide).toContainText(UI.dismissWarning);
    await hide.getByRole('button', { name: UI.hide, exact: true }).click();
    await expect(hide).toHaveCount(0);
    await expect(possibleRow(page, full('Norole'))).toHaveCount(0);
    await page.reload();
    await expect(possibleRow(page, full('Noted'))).toBeVisible(); // the list has loaded
    await expect(possibleRow(page, full('Norole'))).toHaveCount(0);
    const dismissed = await readContact(req, norole);
    expect(dismissed).toMatchObject({ type: 'partner', caseworker_review: 'dismissed' });
    expect(dismissed['role']).toBeUndefined();
  });
});

test.describe('Caseworkers - the Unknown card', () => {
  test('Mark as Caseworker converts an inbound unknown contact and accepts the AI partner suggestion', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const phone = uniquePhone();
    const noteLine = `Identified as a caseworker at Quillwort ${stamp}`;

    // A text from a new number creates an unknown contact and its unknown_1to1
    // thread; the fake driver turns the body into a partner type suggestion and
    // an AI note line.
    await sendExtractSms(request, phone, {
      typeSuggestion: { value: 'partner', reason: `caseworker at Quillwort ${stamp}` },
      noteLines: [{ text: noteLine, confidence: 0.9 }],
    });
    expect((await extractionTick(request)).processed).toBeGreaterThanOrEqual(1);
    const contactId = await findUnknownContactId(req, phone);
    expect(await pendingSuggestionTargets(req, contactId)).toContain('type');

    await page.goto(`${NEXT}/contacts/${contactId}`);
    const triage = page.locator('section').filter({ has: page.getByRole('heading', { name: UI.triageHeading }) });
    await triage.getByRole('button', { name: UI.markAsCaseworker, exact: true }).click();
    // The unknown has no name yet, so the dialog is named by its phone.
    const dialog = page.getByRole('dialog', { name: UI.anyDialog });
    await expect(dialog.getByText(UI.retypesOne)).toBeVisible();
    await dialog.getByRole('button', { name: UI.confirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: UI.markAsCaseworker })).toHaveCount(0);

    const contact = await readContact(req, contactId);
    expect(contact).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      type_source: 'manual',
      caseworker_conversion: { fromType: 'unknown' },
    });
    expect(String(contact['notes'])).toContain(noteLine);
    expect(await readConversationType(req, contactId)).toBe('partner_1to1');
    // The AI's partner suggestion is resolved by the conversion (accepted
    // through the canonicalizer, D16): nothing pending, Today's review clear.
    expect(await pendingSuggestionTargets(req, contactId)).not.toContain('type');
    // Today's AI suggestions are one collapsed line under At a glance
    // (tracker #31). The original intent - this contact has no AI row left -
    // is checked on server truth, then on the page: the line ABSENT when Today
    // holds no AI rows at all, else the opened list without this contact.
    await expectNoAiSuggestionFor(page, contactId, formattedPhone(phone));
  });
});

// ---------------------------------------------------------------------------
// Caseworker integrity (spec docs/superpowers/specs/2026-10-12-caseworker-
// integrity-design.md D2): the GENERIC type change - the edit form's kind
// picker - is refused while the contact is the tenant of an open placement or
// the landlord of record of a live property. The placement refusal reuses the
// conversion's sentence and link; the landlord one is D2's own, because no
// dashboard path reassigns a property's landlord. Self-contained: every
// contact, property and placement is run-unique (the reseed above is not
// relied on), and the holdings reads are polled through the read-only
// conversion preview, which runs the same index reads, before the UI acts.
// ---------------------------------------------------------------------------

/** The edit form and the type-change refusals' copy (dashboard
 *  src/lib/holdingRefusals.ts; the placement sentence is UI.refusalPlacement). */
const RETYPE = {
  editDetails: 'Edit contact details',
  editDialog: /Edit contact/i,
  changeType: 'Change type',
  kindGroup: 'Contact kind',
  save: 'Save',
  cancel: 'Cancel',
  openPlacement: "Finish or close this contact's placement first.",
  viewPlacement: 'View placement',
  landlordOfRecord:
    "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.",
  viewProperty: 'View property',
};

/** POST /api/units - a live property owned by `landlordId` (it starts in Setup). */
async function createOwnedUnit(request: APIRequestContext, landlordId: string, line1: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), `create property ${line1}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
}

/** POST /api/placements - an OPEN placement at the ladder's first rung. */
async function createOpenPlacement(request: APIRequestContext, tenantId: string, unitId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/placements`, {
    data: { tenantId, unitId, stage: 'send_application' },
  });
  expect(res.ok(), `create placement: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { placement: { placementId: string } }).placement.placementId;
}

/** Open the contact page's Edit contact details dialog with its kind picker expanded. */
async function openKindChange(page: Page, contactId: string): Promise<Locator> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await page.getByRole('button', { name: RETYPE.editDetails }).click();
  const dialog = page.getByRole('dialog', { name: RETYPE.editDialog });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: RETYPE.changeType, exact: true }).click();
  return dialog;
}

/** Press the edit form's Save and read the answer to the PATCH it sends - the
 *  server's own refusal, beside the sentence the dialog shows for it. */
async function saveAndReadAnswer(
  page: Page,
  dialog: Locator,
  contactId: string,
): Promise<{ status: number; body: unknown }> {
  const answer = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/contacts/${contactId}`,
  );
  await dialog.getByRole('button', { name: RETYPE.save, exact: true }).click();
  const res = await answer;
  return { status: res.status(), body: await res.json() };
}

test.describe('Caseworker integrity - the edit form refuses a type change that would break a record', () => {
  test('an open placement keeps a tenant a tenant; a live property keeps its landlord a landlord', async ({
    page,
  }) => {
    test.slow(); // two contacts, a property and a placement, then two edit-form round trips.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const lastName = `Cwkret${stamp}`;
    const tenantId = await createContact(req, { type: 'tenant', firstName: 'Retyped', lastName, phone: uniquePhone() });
    const ownerId = await createContact(req, { type: 'landlord', firstName: 'Owner', lastName, phone: uniquePhone() });
    const unitId = await createOwnedUnit(req, ownerId, `${stamp} Retype Refusal Way NW`);
    const placementId = await createOpenPlacement(req, tenantId, unitId);
    // The holdings reads are index queries (spec L1): wait until they see both
    // records, read-only, so the PATCH below cannot slip through the lag.
    await expect
      .poll(
        async () =>
          (await readPreview(req, tenantId)).refusals.some(
            (r) => r['code'] === 'caseworker_open_placement' && r['placementId'] === placementId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await readPreview(req, ownerId)).refusals.some(
            (r) => r['code'] === 'caseworker_landlord_of_record' && r['unitId'] === unitId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // 1. Tenant -> Landlord with an open placement: refused, the draft kept.
    let dialog = await openKindChange(page, tenantId);
    const kinds = dialog.getByRole('group', { name: RETYPE.kindGroup });
    await kinds.getByRole('button', { name: 'Landlord', exact: true }).click();
    const tenantAnswer = await saveAndReadAnswer(page, dialog, tenantId);
    expect(tenantAnswer.status).toBe(409);
    expect(tenantAnswer.body).toMatchObject({
      error: 'type_change_refused',
      refusals: [{ code: 'open_placement', placementId }],
    });
    await expect(dialog.getByText(RETYPE.openPlacement)).toBeVisible();
    await expect(dialog.getByRole('link', { name: RETYPE.viewPlacement })).toHaveAttribute(
      'href',
      `/placements/${placementId}`,
    );
    await expect(kinds.getByRole('button', { name: 'Landlord', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: RETYPE.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readContact(req, tenantId)).toMatchObject({ type: 'tenant' });

    // 2. Landlord -> Tenant while the landlord of record of a live property.
    dialog = await openKindChange(page, ownerId);
    await dialog
      .getByRole('group', { name: RETYPE.kindGroup })
      .getByRole('button', { name: 'Tenant', exact: true })
      .click();
    const ownerAnswer = await saveAndReadAnswer(page, dialog, ownerId);
    expect(ownerAnswer.status).toBe(409);
    expect(ownerAnswer.body).toMatchObject({
      error: 'type_change_refused',
      refusals: [{ code: 'landlord_of_record', unitId }],
    });
    await expect(dialog.getByText(RETYPE.landlordOfRecord)).toBeVisible();
    await expect(dialog.getByRole('link', { name: RETYPE.viewProperty })).toHaveAttribute(
      'href',
      `/listings/${unitId}`,
    );
    await dialog.getByRole('button', { name: RETYPE.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readContact(req, ownerId)).toMatchObject({ type: 'landlord' });

    // On the wire: one refusal per blocking record, nothing written.
    const refused = await req.patch(`${NEXT}/api/contacts/${tenantId}`, { data: { type: 'partner' } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'type_change_refused',
      refusals: [{ code: 'open_placement', placementId }],
    });
    expect(await readContact(req, tenantId)).toMatchObject({ type: 'tenant' });
  });
});
