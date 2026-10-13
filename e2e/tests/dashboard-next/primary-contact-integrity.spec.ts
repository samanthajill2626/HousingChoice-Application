// e2e/tests/dashboard-next/primary-contact-integrity.spec.ts
//
// PRIMARY CONTACT INTEGRITY, end to end (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 10). Three walks over a property in the IMPORTED shape - no
// landlord of record, and contacts on its contact list of which none is
// primary (470 Bolton). The UI can reach a property with no primary contact
// (Restore without a landlord, then add only contacts not typed landlord),
// and can even recreate the imported shape - an eligible contact left
// non-primary - by classifying one of those contacts as a property manager
// after seating it (a type change promotes nobody, spec 4.4). The dev seam
// exists so a spec builds that shape in one call without the detour, and the
// byte-stable lean seed has none on purpose, so each walk builds its own
// through the DEV-ONLY seam POST /__dev/fixtures/zero-primary-property
// (fixtures/primaryContact.ts):
//
//   (a) THE PROPERTY BOX (spec 7.4): the Contacts card says the property has
//       no primary contact and offers "Make <Name> primary" for its one
//       eligible contact; one click makes them primary and the box goes.
//   (b) THE OPEN-GROUP DIALOG (spec 7.1): a booked tour on that property
//       previews the GENERAL intro, and the dialog says why and links to the
//       fix in a NEW TAB. The walk follows that link - a second tab in the
//       same browser context, exactly what Sam's browser does - fixes the
//       property there, comes back and presses Check again: the preview
//       becomes the TOUR intro naming the new primary contact.
//   (c) THE REMOVE HANDOFF (spec 4.6 / 7.3): removing the primary from a
//       property with no landlord of record hands it to the earliest-added
//       contact eligible for automatic routing - a tenant added before it is
//       skipped - and the confirm names who takes over.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const + a
// local devLogin, raw page.request for setup, accessibility-first locators,
// no Scenario verbs. Self-clean isolation: every contact, property and tour
// is minted fresh per test (the seam creates a NEW property and never
// touches a lean one), so NOTHING here reseeds and the lean world stays
// byte-stable. No walk opens a relay group, so nothing is texted.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createZeroPrimaryProperty } from '../../fixtures/primaryContact.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164 (the landlord-activity.spec idiom) - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** The display name every roster surface renders for this contact. */
  name: string;
}

/** A fresh typed contact WITH a phone, through the real create. A property
 *  manager is a `landlord`-typed contact; the ROLE is what the row carries. */
async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const lastName = 'Pcint';
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type, firstName, lastName, phone, ...(type === 'tenant' && { voucherSize: 2 }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, lastName, phone, name: `${firstName} ${lastName}` };
}

/** A run-unique street: the box, the dialog and the tour intro all name it. */
function freshStreet(stamp: string): string {
  return `${stamp} Primary Contact Way NW`;
}

interface UnitWire {
  landlordId?: string;
  primary_contact?: string;
  contacts?: Array<{ contactId: string; role: string; primaryContact?: boolean }>;
  propertyContact?: { contactId: string | null; reason?: 'none' | 'deleted' };
}

async function readUnit(request: APIRequestContext, unitId: string): Promise<UnitWire> {
  const res = await request.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: UnitWire }).unit;
}

/** The open-group preview exactly as the dialog receives it. */
interface PreviewWire {
  body: string;
  introFallback?: { reasons: string[]; unitId?: string; street?: string; propertyContactId?: string };
}

async function previewOpen(request: APIRequestContext, tourId: string): Promise<PreviewWire> {
  const res = await request.get(`${NEXT}/api/tours/${tourId}/roster/preview-open`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as PreviewWire;
}

/** The property page's Contacts card: Card.tsx renders a plain <section> under
 *  an <h3> whose accessible name also carries the "Edit contacts" action, so
 *  match the heading by prefix. Scoping matters: getByText is a
 *  case-insensitive substring match, and the remove confirm's no-heir notice
 *  also contains "no primary contact." */
function contactsCard(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /^Contacts\b/ }) });
}

test.describe('Primary contact integrity - a property with no primary contact', () => {
  test('(a) the property box offers Make <Name> primary, and one click fixes it', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // 470 Bolton's shape: no landlord of record; its only contact a property
    // manager typed landlord - on the contact list, not primary.
    const mark = await createContact(req, 'landlord', `Pcmark${stamp}`);
    const unitId = await createZeroPrimaryProperty(req, {
      street: freshStreet(stamp),
      rows: [{ contactId: mark.contactId, role: 'pm' }],
    });

    // The server agrees it is the broken state: no landlord, no primary, and
    // the property-contact block names nobody (reason none - not deleted).
    let unit = await readUnit(req, unitId);
    expect(unit.landlordId).toBeUndefined();
    expect(unit.primary_contact).toBeUndefined();
    expect(unit.contacts).toEqual([
      expect.objectContaining({ contactId: mark.contactId, role: 'pm', primaryContact: false }),
    ]);
    expect(unit.propertyContact).toMatchObject({ contactId: null, reason: 'none' });

    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = contactsCard(page);
    await expect(card.getByText('No primary contact.')).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByText("New tours won't include the landlord, and tour group texts use the general intro."),
    ).toBeVisible();
    // ONE eligible row: the button names the person, never "Choose a primary".
    const makePrimary = card.getByRole('button', { name: `Make ${mark.name} primary` });
    await expect(makePrimary).toBeVisible();
    await expect(card.getByRole('button', { name: 'Choose a primary' })).toHaveCount(0);

    await makePrimary.click();
    await expect(card.getByText('No primary contact.')).toHaveCount(0, { timeout: 20_000 });
    await expect(card.getByRole('link', { name: new RegExp(`^${mark.name} \\(primary\\)`) })).toBeVisible();

    unit = await readUnit(req, unitId);
    expect(unit.primary_contact).toBe(mark.contactId);
    expect(unit.contacts).toEqual([
      expect.objectContaining({ contactId: mark.contactId, role: 'pm', primaryContact: true }),
    ]);
    expect(unit.propertyContact).toMatchObject({ contactId: mark.contactId });
    expect(unit.landlordId).toBeUndefined();
  });

  test('(b) a booked tour there previews the general intro and says why; Check again after the fix shows the tour intro', async ({
    page,
  }) => {
    test.slow(); // build-a-world, a second tab, two previews.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const street = freshStreet(stamp);
    const mark = await createContact(req, 'landlord', `Pctour${stamp}`);
    const tenant = await createContact(req, 'tenant', `Pcten${stamp}`);
    const unitId = await createZeroPrimaryProperty(req, {
      street,
      rows: [{ contactId: mark.contactId, role: 'pm' }],
    });
    // BOOKED, +48h (never "today" in the org zone): only a booked tour can
    // carry the tour intro, so the general intro here is about the property.
    const tourRes = await req.post(`${NEXT}/api/tours`, {
      data: {
        tenantId: tenant.contactId,
        unitId,
        tourType: 'landlord_led',
        scheduledAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      },
    });
    expect(tourRes.ok(), await tourRes.text()).toBeTruthy();
    const tourId = ((await tourRes.json()) as { tour: { tourId: string } }).tour.tourId;
    // With no primary contact and no landlord the default people list is the
    // tenant alone - too thin to open a group. Put Mark on THIS tour by hand:
    // the silent plan add the People card makes (no thread, nothing sent).
    const added = await req.post(`${NEXT}/api/tours/${tourId}/roster/members`, {
      data: { contactId: mark.contactId },
    });
    expect(added.ok(), await added.text()).toBeTruthy();

    // The server's own preview: the GENERAL intro, and exactly one reason.
    const before = await previewOpen(req, tourId);
    expect(before.introFallback).toEqual({ reasons: ['no_property_contact'], unitId, street });
    expect(before.body).not.toContain('Putting you in a group text');

    await page.goto(`${NEXT}/tours/${tourId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open relay group' }).click();
    const confirm = page.getByRole('dialog', { name: 'Open the relay group?' });
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    const draft = confirm.getByRole('region', { name: 'Message preview' }).getByRole('textbox');
    await expect(draft).toHaveValue(before.body);

    // The box: role="status" inside the dialog, filtered by its heading (the
    // duplicate-group warning is the dialog's other status region).
    const box = confirm.getByRole('status').filter({ hasText: 'Using the general intro, not the tour intro.' });
    await expect(box).toBeVisible();
    await expect(box).toContainText(`${street} has no primary contact, so the intro can't name the landlord.`);
    const fixLink = box.getByRole('link', { name: 'Set a primary contact' });
    await expect(fixLink).toHaveAttribute('href', new RegExp(`/listings/${unitId}$`));
    await expect(fixLink).toHaveAttribute('target', '_blank');

    // Follow it: a NEW TAB in the same browser context (same session), which
    // leaves the half-built group standing in this one.
    const [propertyTab] = await Promise.all([page.waitForEvent('popup'), fixLink.click()]);
    await propertyTab.waitForLoadState('domcontentloaded');
    await expect(propertyTab).toHaveURL(new RegExp(`/listings/${unitId}$`));
    const card = contactsCard(propertyTab);
    const makeMark = card.getByRole('button', { name: `Make ${mark.name} primary` });
    await expect(makeMark).toBeVisible({ timeout: 20_000 });
    await makeMark.click();
    await expect(card.getByText('No primary contact.')).toHaveCount(0, { timeout: 20_000 });
    await propertyTab.close();

    // Back in the still-open dialog: Check again re-runs the preview.
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Check again' }).click();
    await expect(box).toHaveCount(0, { timeout: 20_000 });

    // The preview is now the TOUR intro naming Mark and the street - and the
    // UNEDITED draft followed it (spec 7.2).
    const after = await previewOpen(req, tourId);
    expect(after.introFallback).toBeUndefined();
    expect(after.body.startsWith(`Hey ${tenant.firstName}!`), after.body).toBeTruthy();
    expect(after.body).toContain(`Putting you in a group text with ${mark.firstName}`);
    expect(after.body).toContain(`to tour ${street}`);
    await expect(draft).toHaveValue(after.body);

    // Nothing is provisioned: Cancel closes the dialog.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
  });

  test('(c) removing the primary from a property with no landlord hands it to the earliest eligible contact', async ({
    page,
  }) => {
    test.slow(); // build-a-world plus three roster writes.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // Added FIRST, but a tenant - on the list by accident: never picked automatically.
    const tenant = await createContact(req, 'tenant', `Pchten${stamp}`);
    const first = await createContact(req, 'landlord', `Pcha${stamp}`);
    const second = await createContact(req, 'landlord', `Pchb${stamp}`);
    const unitId = await createZeroPrimaryProperty(req, {
      street: freshStreet(stamp),
      rows: [
        { contactId: tenant.contactId, role: 'other' },
        { contactId: first.contactId, role: 'pm' },
        { contactId: second.contactId, role: 'owner' },
      ],
    });

    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = contactsCard(page);
    // Three live, non-caseworker rows: the box asks for a deliberate choice.
    await expect(card.getByText('No primary contact.')).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Choose a primary' }).click();
    // ...which is the card's edit mode.
    await expect(page.getByRole('button', { name: 'Done editing contacts' })).toBeVisible();

    // Make the LATER-added landlord the primary contact.
    const makeSecond = page.getByRole('button', { name: `Make ${second.name} the primary contact` });
    await makeSecond.click();
    await expect(makeSecond).toHaveCount(0, { timeout: 20_000 });
    await expect(card.getByText('No primary contact.')).toHaveCount(0);

    // Remove them: the confirm names the heir from the server's block - the
    // earliest-added ELIGIBLE contact, skipping the tenant added before it.
    await page.getByRole('button', { name: `Remove ${second.name} from this property` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the primary contact?' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        `${first.name} becomes the primary contact - new tours and relay groups for this property will use them.`,
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove contact' }).click();
    await expect(page.getByRole('button', { name: `Remove ${second.name} from this property` })).toHaveCount(0, {
      timeout: 20_000,
    });

    // The handoff landed: the first landlord is primary, the tenant is not.
    await expect(page.getByRole('button', { name: `Make ${first.name} the primary contact` })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Make ${tenant.name} the primary contact` })).toBeVisible();
    await page.getByRole('button', { name: 'Done editing contacts' }).click();
    await expect(card.getByRole('link', { name: new RegExp(`^${first.name} \\(primary\\)`) })).toBeVisible();
    await expect(card.getByText('No primary contact.')).toHaveCount(0);

    const unit = await readUnit(req, unitId);
    expect(unit.landlordId).toBeUndefined();
    expect(unit.primary_contact).toBe(first.contactId);
    expect(unit.contacts).toEqual([
      expect.objectContaining({ contactId: tenant.contactId, role: 'other', primaryContact: false }),
      expect.objectContaining({ contactId: first.contactId, role: 'pm', primaryContact: true }),
    ]);
  });
});
