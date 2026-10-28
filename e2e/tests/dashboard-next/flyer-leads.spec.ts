// e2e/tests/dashboard-next/flyer-leads.spec.ts
//
// Flyer trim and flyer / join leads (design
// docs/superpowers/specs/2026-10-21-flyer-leads-design.md, section 5 "e2e";
// Sam's 2026-10-21 feedback and Improvements Tracker #13), end to end against
// the real backend:
//   1. the flyer's new layout (D1, D3): the address is the page heading and a
//      Google Maps link, the area is the line under it, "Same-day tours
//      available" shows, the detail rows are Application fee / Tenant pays /
//      Washer / dryer / Same-day RTA / Video tour / Listing in that order, and
//      no rent, deposit, pets, pet fee, accessibility, lease terms or address
//      row renders - nor reaches the public JSON - although the property
//      records every one of them; the sign-up box asks for alerts, not a
//      tour; nothing overflows at 320px;
//   2. an EXISTING tenant signing up from the flyer (D4-D8): no text goes out,
//      the inbox row turns unread LIVE on an inbox staff already have open
//      (no reload - the build worklist's OR-24, the e2e pin of the public
//      router's default event bus, OR-17), the thread shows the sign-up pin
//      with the TYPED name (the contact keeps its own) - a pin wider than the
//      comms pane wraps, so its whole label, the typed name at its end
//      included, stays visible (code review R2 F1), and it never widens the
//      pane over the Send button (self-QA QA-1) - and the property is on
//      the Properties sent card reading "Signed up from the flyer <date>" with
//      the "Signed up" chip and the waiting row's actions;
//   3. an EXISTING contact - a landlord with no thread yet - on /join (D4-D6):
//      the join pin and the unread mark, no text, the contact unchanged;
//   4. a NEW contact on the flyer (D5, D6 - Cameron 2026-10-21): the welcome
//      is sent, then the pin, the unread mark and the Signed up entry;
//   5. a NEW contact on an Occupied property's flyer (permanent-flyer-links
//      D2, D3, D3a, D5, D6, 2026-10-27): the flyer is still served with no
//      status word and, off Available, no external listing link; the sign-up
//      is credited exactly like one from an Available flyer, and its pin names
//      the status: "Signed up from the flyer for <address> (Occupied) as <name>".
//
// ISOLATION: every record is RUN-UNIQUE and made through the real routes.
// The lean world has no Available property (app/src/lib/seed/lean.ts:
// unit-0001 is under_application, unit-0002 occupied - both serve their
// flyers since permanent-flyer-links, but neither is ever signed up from
// here), and a sign-up from a SEEDED contact would leave a pin, a sent-list
// row and an unread thread on records other specs read
// (docs/issues/inbox-specs-flaky-shared-tasha-state.md).
// Nothing is reseeded. Every case leaves its threads READ, so no later spec
// inherits an unread row.
//
// ORDER MATTERS on the inbox checks: the contact page marks every thread of
// the contact read on mount (dashboard useMarkContactRead), so unread is
// asserted on /inbox and through the API BEFORE the contact page is opened -
// and that visit is then the clean-up.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT, a local
// devLogin, raw page.request for setup, accessibility-first locators. The
// public visitor is a SEPARATE browser context with no session, and the
// existing tenant's sign-up is posted by the bare `request` fixture (no
// session either), so the staff page can stay on the inbox throughout.
import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { getOutboundTo, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';
import {
  NARROW_360,
  WIDE_RESTORE,
  expectNoHorizontalOverflow,
  expectNoHorizontalOverflowIn,
} from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
/** A seeded housing authority NAME (app/src/lib/seed/orgList.ts); a unit
 *  create refuses an authority that is not on the list. */
const ATLANTA = 'Atlanta Housing Authority';
const CITY = 'Atlanta';
const STATE = 'GA';
const ZIP = '30314';
/** The flyer heading's second line for that address (plan 1.1). */
const CITY_LINE = `${CITY}, ${STATE} ${ZIP}`;
/** The ten keys flyer-leads D1 removes from the public flyer payload. */
const TRIMMED_KEYS = [
  'rent_min',
  'rent_max',
  'lease_terms',
  'accessibility',
  'pets',
  'no_pets',
  'pet_fee',
  'deposit',
  'deposit_one_month',
  'deposit_flexible',
] as const;
/** What every property here records but the flyer must never show (D1). */
const STAFF_ONLY = {
  rent: 1725,
  deposit: 1500,
  pets: 'Cats only',
  petFee: '$300',
  accessibility: 'Ground floor',
  leaseTerms: '12-month minimum',
} as const;

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

interface Person {
  contactId: string;
  phone: string;
  firstName: string;
  lastName: string;
  /** The display name the dashboard shows: "First Last". */
  name: string;
}

/** A contact through the real create route; `consent` records verbal
 *  consent, as a staff-entered tenant carries it. */
async function createContact(
  api: APIRequestContext,
  opts: { type: 'tenant' | 'landlord'; firstName: string; lastName: string; status?: string; consent?: boolean },
): Promise<Person> {
  const phone = uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: {
      type: opts.type,
      firstName: opts.firstName,
      lastName: opts.lastName,
      phone,
      ...(opts.status !== undefined && { status: opts.status }),
      ...(opts.consent === true && { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return {
    contactId: contact.contactId,
    phone,
    firstName: opts.firstName,
    lastName: opts.lastName,
    name: `${opts.firstName} ${opts.lastName}`,
  };
}

async function getContact(api: APIRequestContext, contactId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: Record<string, unknown> }).contact;
}

async function getUnit(api: APIRequestContext, unitId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: Record<string, unknown> }).unit;
}

interface FlyerUnit {
  unitId: string;
  line1: string;
  area: string;
  videoUrl: string;
  listingUrl: string;
}

/** An AVAILABLE (shareable) property holding every public field AND every
 *  field D1 took off the flyer. Create lands in setup; status moves only
 *  through the listing-status transition. */
async function createAvailableUnit(
  api: APIRequestContext,
  opts: { landlordId: string; line1: string; area: string; stamp: string },
): Promise<FlyerUnit> {
  const videoUrl = `https://tours.example.com/flyer-leads-${opts.stamp}`;
  const listingUrl = `https://listings.example.com/flyer-leads-${opts.stamp}`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: opts.landlordId,
      accepted_authorities: [ATLANTA],
      beds: 2,
      baths: 1,
      area: opts.area,
      address: { line1: opts.line1, city: CITY, state: STATE, zip: ZIP },
      application_fee: 45,
      utilities: 'Electric and gas',
      washer_dryer: 'hookups',
      same_day_rta: true,
      video_url: videoUrl,
      listing_link: listingUrl,
      // Staff only since flyer-leads D1/D2: recorded, never published.
      rent_min: STAFF_ONLY.rent,
      rent_max: STAFF_ONLY.rent,
      deposit: STAFF_ONLY.deposit,
      deposit_flexible: true,
      pets: STAFF_ONLY.pets,
      pet_fee: STAFF_ONLY.petFee,
      accessibility: STAFF_ONLY.accessibility,
      lease_terms: STAFF_ONLY.leaseTerms,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const published = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  return { unitId, line1: opts.line1, area: opts.area, videoUrl, listingUrl };
}

/** A public visitor: a fresh browser context with no session or cookies. */
async function openVisitor(browser: Browser): Promise<{ visitor: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  return { visitor, close: () => context.close() };
}

/** Fill the public sign-up form (the flyer's and /join's share these fields). */
async function fillSignUp(visitor: Page, p: { firstName: string; lastName: string; phone: string }): Promise<void> {
  await visitor.getByLabel('First name').fill(p.firstName);
  await visitor.getByLabel('Last name').fill(p.lastName);
  await visitor.getByLabel('Phone number').fill(p.phone);
  // A2P/CTIA: the consent box is required and starts unchecked.
  await visitor.getByRole('checkbox', { name: /I agree to receive/i }).check();
}

/** The contact's unread count as the SERVER sees it (0 when the row is absent
 *  from the unread feed), so a green UI check can never be an optimistic patch. */
async function serverUnread(api: APIRequestContext, contactId: string): Promise<number> {
  const res = await api.get(`${NEXT}/api/inbox?filter=unread&limit=100`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { rows } = (await res.json()) as { rows: Array<{ contactId?: string; unreadCount: number }> };
  return rows.find((r) => r.contactId === contactId)?.unreadCount ?? 0;
}

/** The contact's signed_up pins, each as "label|refType|refId" ('' for an absent ref). */
async function signedUpPins(api: APIRequestContext, contactId: string): Promise<string[]> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/timeline?kinds=milestone`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { items } = (await res.json()) as {
    items: Array<{ kind: string; type?: string; refType?: string; refId?: string; label?: string }>;
  };
  return items
    .filter((i) => i.kind === 'milestone' && i.type === 'signed_up')
    .map((i) => `${i.label ?? ''}|${i.refType ?? ''}|${i.refId ?? ''}`);
}

/** The derived send outcome of the (unit, contact) pair on the contact's sent list. */
async function sentOutcome(api: APIRequestContext, contactId: string, unitId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/listings-sent`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { sent } = (await res.json()) as { sent: Array<{ unitId: string; outcome?: string }> };
  return sent.find((s) => s.unitId === unitId)?.outcome;
}

/** The contact a public sign-up created, found by its phone. */
async function contactIdByPhone(api: APIRequestContext, phone: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        id = ((await res.json()) as { contacts: Array<{ contactId: string }> }).contacts[0]?.contactId;
        return id !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return id!;
}

/** OR-24: a property on `window` that only a reload or a navigation away
 *  could clear - set before the sign-up, read after the live update. */
interface NoReloadMarker {
  __flyerLeadsNoReload?: boolean;
}

/** Code review R2 F1 and R3-1: a milestone pin's WHOLE label is visible. Its
 *  text box is not cut (scrollWidth within clientWidth: it wraps, never an
 *  ellipsis) and lies inside the pin's box on all four sides - a nowrap on
 *  the label runs it out of the pin's side while the pin keeps its width, and
 *  a height cap on the pin hides the lines above and below. The pin lies
 *  inside, side to side, the nearest box that clips it (the stream that
 *  scrolls it), and that stream does not scroll sideways: the measure of
 *  support/viewport.ts expectNoHorizontalOverflowIn (scrollWidth within
 *  clientWidth), taken here on the box found by its computed overflow - the
 *  stream has no role, name or test id to locate it by - and kept soft.
 *  Soft, like the QA-1 checks beside it. */
async function expectWholePinLabelVisible(pin: Locator, where: string): Promise<void> {
  const g = await pin.evaluate((el) => {
    const label = el.querySelector('span');
    if (label === null) throw new Error('the pin has no label span');
    let clip = el.parentElement;
    while (clip !== null && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
    if (clip === null) throw new Error('no box clips the pin');
    const p = el.getBoundingClientRect();
    const t = label.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    return {
      cut: label.scrollWidth - label.clientWidth,
      // How far the label's box sits inside the pin's, per side (below 0: out of it).
      inside: { left: t.left - p.left, right: p.right - t.right, top: t.top - p.top, bottom: p.bottom - t.bottom },
      left: p.left - c.left,
      right: c.right - p.right,
      sideways: clip.scrollWidth - clip.clientWidth,
    };
  });
  const { inside } = g;
  expect.soft(g.cut, `${where}: the pin label is cut`).toBeLessThanOrEqual(1);
  expect
    .soft(
      Math.min(inside.left, inside.right, inside.top, inside.bottom),
      `${where}: the pin label runs out of its pin ${JSON.stringify(inside)}`,
    )
    .toBeGreaterThanOrEqual(-1);
  expect.soft(Math.min(g.left, g.right), `${where}: the pin runs past the side of its stream`).toBeGreaterThanOrEqual(-1);
  expect.soft(g.sideways, `${where}: the stream scrolls sideways`).toBeLessThanOrEqual(1);
}

test('the flyer: the address heading links to Maps, the area sits under it, Same-day tours available, and no staff-only row or key', async ({
  page,
  browser,
  request,
}) => {
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Layout' });
  // A street line long enough to wrap at 320px (D3).
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Martin Luther King Jr Drive Southwest`,
    area: `Flyerhood ${stamp}`,
    stamp,
  });

  // D1: off the flyer, NOT out of the system - the property keeps every value.
  expect(await getUnit(api, unit.unitId)).toMatchObject({
    rent_min: STAFF_ONLY.rent,
    rent_max: STAFF_ONLY.rent,
    deposit: STAFF_ONLY.deposit,
    deposit_flexible: true,
    pets: STAFF_ONLY.pets,
    pet_fee: STAFF_ONLY.petFee,
    accessibility: STAFF_ONLY.accessibility,
    lease_terms: STAFF_ONLY.leaseTerms,
  });

  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);

  // D3 item 2: the street line is the one h1, INSIDE the Google Maps link; the
  // city line is the link's second line; the sr-only suffix ends its name.
  const mapsLink = visitor.getByRole('link', { name: /open in Google Maps$/ });
  const heading = mapsLink.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(unit.line1);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(mapsLink).toHaveAccessibleName(new RegExp(`^${unit.line1}`));
  await expect(mapsLink.getByText(CITY_LINE, { exact: true })).toBeVisible();
  await expect(mapsLink).toHaveAttribute(
    'href',
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([unit.line1, CITY, STATE, ZIP].join(', '))}`,
  );
  await expect(mapsLink).toHaveAttribute('target', '_blank');
  await expect(mapsLink).toHaveAttribute('rel', 'noreferrer');

  // D3 item 3: the area is the line under the heading, never the heading.
  await expect(visitor.getByText(unit.area, { exact: true })).toBeVisible();
  // D3 item 4: static copy on every flyer - not the per-property Same-day RTA row.
  await expect(visitor.getByText('Same-day tours available', { exact: true })).toBeVisible();
  // D3 items 5-6: beds, baths and the voucher phrase (no rent fact), then the
  // authority line (wording unchanged).
  await expect(visitor.getByText(/^2\s*beds$/)).toBeVisible();
  await expect(visitor.getByText(/^1\s*bath$/)).toBeVisible();
  await expect(visitor.getByText('Fits a 2-bedroom voucher')).toBeVisible();
  await expect(visitor.getByText(`Accepts: ${ATLANTA}`, { exact: true })).toBeVisible();
  // D3 item 7: the detail rows, in this order, each because it is recorded.
  await expect(visitor.getByRole('term')).toHaveText([
    'Application fee',
    'Tenant pays',
    'Washer / dryer',
    'Same-day RTA',
    'Video tour',
    'Listing',
  ]);
  await expect(visitor.getByText('$45', { exact: true })).toBeVisible();
  await expect(visitor.getByText('Electric and gas', { exact: true })).toBeVisible();
  await expect(visitor.getByText('Hookups', { exact: true })).toBeVisible();
  await expect(visitor.getByRole('link', { name: 'Watch the tour' })).toHaveAttribute('href', unit.videoUrl);
  await expect(visitor.getByRole('link', { name: 'See the full listing' })).toHaveAttribute('href', unit.listingUrl);

  // Gone, although the property records each (D1; D3 item 7) - asserted after
  // the positive checks on this same load.
  for (const gone of [
    'Address',
    'Deposit',
    'Pets',
    'Pet fee',
    'Accessibility',
    'Lease terms',
    STAFF_ONLY.pets,
    STAFF_ONLY.petFee,
    STAFF_ONLY.accessibility,
    STAFF_ONLY.leaseTerms,
    'A home for you',
    'Home for rent',
    'Interested in this home?',
  ]) {
    await expect(visitor.getByText(gone, { exact: true }), gone).toHaveCount(0);
  }
  // The rent ($1,725 and "/mo"), the deposit ($1,500, "payment plan") and the
  // old "a team member will..." promise.
  await expect(visitor.getByText(/\$1,?725|\/mo\b|\$1,?500|payment plan|team member/i)).toHaveCount(0);

  // D1: the public JSON carries none of the ten keys (absent, not null).
  const flyerRes = await request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
  expect(flyerRes.ok(), await flyerRes.text()).toBeTruthy();
  const { flyer } = (await flyerRes.json()) as { flyer: Record<string, unknown> };
  expect(flyer['application_fee']).toBe(45);
  for (const key of TRIMMED_KEYS) expect(Object.keys(flyer), key).not.toContain(key);

  // D3 item 8: the sign-up box asks for alerts and says it books no tour.
  await expect(visitor.getByRole('heading', { name: 'Sign up for home alerts', exact: true })).toBeVisible();
  await expect(
    visitor.getByText(
      "We'll text you about this home and others that fit your voucher. Signing up does not book a tour.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();

  // D3: at 320px the heading wraps and nothing overflows its card; the whole
  // heading block is the tap target (the link's box holds the h1's).
  await visitor.setViewportSize({ width: 320, height: 800 });
  await expect(heading).toBeVisible();
  await expectNoHorizontalOverflow(visitor, 'the flyer at 320px');
  await expectNoHorizontalOverflowIn(
    visitor.locator('section').filter({ has: visitor.getByRole('heading', { level: 1 }) }),
    'the flyer card at 320px',
  );
  await expectNoHorizontalOverflowIn(heading, 'the address heading at 320px');
  const linkBox = await mapsLink.boundingBox();
  const headingBox = await heading.boundingBox();
  if (linkBox === null || headingBox === null) throw new Error('the heading link or the heading has no box');
  expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(320 + 1);
  expect(headingBox.x).toBeGreaterThanOrEqual(linkBox.x - 1);
  expect(headingBox.y).toBeGreaterThanOrEqual(linkBox.y - 1);
  expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(linkBox.x + linkBox.width + 1);
  expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(linkBox.y + linkBox.height + 1);
  await visitor.setViewportSize(WIDE_RESTORE);
  await close();
});

test('an existing tenant signs up from the flyer: no text, the open inbox row turns unread live, the pin, and a Signed up row on Properties sent', async ({
  page,
  request,
}) => {
  test.slow(); // an inbound, a live inbox, a public sign-up and the contact page
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Existing' });
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Existing Way`,
    area: `Existhood ${stamp}`,
    stamp,
  });
  const tenant = await createContact(api, {
    type: 'tenant',
    firstName: `Flyerexist${stamp}`,
    lastName: 'Tenant',
    status: 'searching',
    consent: true,
  });

  // An ongoing conversation: the tenant texted in earlier.
  const inbound = `Still looking for a 2 bedroom ${stamp}`;
  await registerParty(request, { label: tenant.name, role: 'tenant', number: tenant.phone });
  await sendAsParty(request, { from: tenant.phone, body: inbound });
  await expect
    .poll(() => serverUnread(api, tenant.contactId), {
      timeout: 20_000,
      message: 'the inbound never made the thread unread',
    })
    .toBe(1);
  expect(await getOutboundTo(request, { to: tenant.phone })).toHaveLength(0);

  // OR-24 (and OR-17): staff have the inbox OPEN through the whole sign-up and
  // the row must turn unread LIVE, from the conversation.updated the public
  // router emits on its DEFAULT event bus (production injects no public deps,
  // so no app test reaches that default). The page's event stream is up
  // before anything below is emitted, and a window marker proves no reload.
  const streamOpen = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
    { timeout: 20_000 },
  );
  await page.goto(`${NEXT}/inbox`);
  await streamOpen;
  const row = page.getByRole('link').filter({ hasText: tenant.name });
  await expect(row.getByLabel('1 unread')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    (window as unknown as NoReloadMarker).__flyerLeadsNoReload = true;
  });
  // Staff read the thread through the API (so the page patches nothing
  // itself): the open row learns it live - proof that a conversation.updated
  // reaches THIS page before the sign-up is posted.
  const read = await api.post(`${NEXT}/api/inbox/${tenant.contactId}/read`);
  expect(read.ok(), await read.text()).toBeTruthy();
  await expect.poll(() => serverUnread(api, tenant.contactId)).toBe(0);
  await expect(row.getByLabel(/\d+ unread/)).toHaveCount(0, { timeout: 15_000 });

  // The sign-up: the flyer form's own body (dashboard publicApi
  // submitHousingFair), posted with no session under a name of the visitor's
  // own (D6 pins the TYPED name; D4 never renames the contact). A realistically
  // long family name, so the pin below is wider than the comms pane (QA-1).
  const typed = { firstName: `Typed${stamp}`, lastName: 'Montgomery-Featherstonehaugh' };
  const signup = await request.post(`${NEXT}/public/housing-fair`, {
    data: { ...typed, phone: tenant.phone, smsConsent: true, unitId: unit.unitId },
  });
  expect(signup.status(), await signup.text()).toBe(200);
  expect(await signup.json()).toEqual({ ok: true });

  // D5: an existing contact never gets the welcome text (it is sent in-request,
  // so it would already be in the fake's store).
  expect(await getOutboundTo(request, { to: tenant.phone })).toHaveLength(0);

  // LIVE, no reload: the open row turns unread, and its preview is still the
  // tenant's own last message.
  await expect(row.getByLabel('1 unread')).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(inbound);
  expect(await page.evaluate(() => (window as unknown as NoReloadMarker).__flyerLeadsNoReload)).toBe(true);
  await expect(page).toHaveURL(/\/inbox(\?.*)?$/);

  // Server truth (D6-D8): ONE pin with the unit ref, the thread unread, the pair signed_up.
  const pinLabel = `Signed up from the flyer for ${unit.line1}, ${CITY_LINE} as ${typed.firstName} ${typed.lastName}`;
  await expect
    .poll(() => signedUpPins(api, tenant.contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}|unit|${unit.unitId}`]);
  await expect.poll(() => serverUnread(api, tenant.contactId), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => sentOutcome(api, tenant.contactId, unit.unitId), { timeout: 15_000 }).toBe('signed_up');

  // The thread pin links to the property.
  await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  const pin = timeline.getByRole('link', { name: pinLabel, exact: true });
  await expect(pin).toBeVisible({ timeout: 15_000 });
  await expect(pin).toHaveAttribute('href', `/listings/${unit.unitId}`);

  // Self-QA QA-1 and code review R2 F1, at the suite's default 1280x720: a
  // pin this long used to widen the comms pane past its column (a flex
  // item's default min-width: auto), under the right column, which painted
  // over the reply box's Send button; the QA-1 fix then cut it with an
  // ellipsis, which hid the END of the label - the typed name, the only name
  // an auto-captured contact has (spec D6.2). The pane keeps its column's
  // width and the pin WRAPS, so the whole label stays visible.
  const column = timeline.locator('xpath=..');
  const commsBox = await timeline.boundingBox();
  const columnBox = await column.boundingBox();
  if (commsBox === null || columnBox === null) throw new Error('the comms pane or its column has no box');
  // Precondition: the label really is wider than the column - otherwise a
  // flush pane and an uncut label would prove nothing. Measured as ONE line
  // in the label's own font, so it holds whether the pin wraps or is cut.
  const labelOneLine = await pin.locator('span').evaluate((el) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) throw new Error('no 2d canvas to measure the label with');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (!ctx.font.includes(cs.fontSize)) throw new Error(`the canvas did not take the label font (${ctx.font})`);
    return ctx.measureText(el.textContent ?? '').width;
  });
  expect(labelOneLine, 'the pin label is not wider than the comms column').toBeGreaterThan(columnBox.width);
  // Soft, so one run reports every symptom.
  expect
    .soft(commsBox.x + commsBox.width, 'the comms pane runs past its column')
    .toBeLessThanOrEqual(columnBox.x + columnBox.width + 1);
  const send = timeline.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  await send.scrollIntoViewIfNeeded();
  const atSendCentre = await send.evaluate((button) => {
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit !== null && (hit === button || button.contains(hit))) return 'the Send button';
    return hit === null ? 'nothing (off screen)' : `<${hit.tagName.toLowerCase()} class="${hit.getAttribute('class') ?? ''}">`;
  });
  expect.soft(atSendCentre, 'something paints over the Send button').toBe('the Send button');
  await expectWholePinLabelVisible(pin, 'at 1280x720');
  // R2 F1's worst case: on a phone the ellipsis showed NO flyer pin's typed
  // name. The stacked shell gives the comms pane the full width, and the pin
  // still wraps inside it.
  await page.setViewportSize(NARROW_360);
  await expect(pin).toBeVisible();
  await expectWholePinLabelVisible(pin, 'at 360px');
  await page.setViewportSize(WIDE_RESTORE);

  // Properties sent (D7, D8): the flyer row, its words, its chip, and the
  // waiting row's actions.
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Properties sent/ }) });
  const sentRow = card
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(`^${unit.line1}`) }) });
  await expect(sentRow.getByText(/^Signed up from the flyer (Today \d{1,2}:\d{2}\s[AP]M|Yesterday)$/)).toBeVisible();
  await expect(sentRow.getByText('Signed up', { exact: true })).toBeVisible();
  await expect(sentRow.getByText(/^Sent /)).toHaveCount(0);
  await expect(
    sentRow.getByRole('button', { name: new RegExp(`^Mark ${tenant.name} interested in ${unit.line1}`) }),
  ).toBeVisible();
  await expect(
    sentRow.getByRole('button', { name: new RegExp(`^Mark ${tenant.name} not interested in ${unit.line1}`) }),
  ).toBeVisible();

  // D4: nothing about the contact changed; the typed name lives only on the pin.
  const after = await getContact(api, tenant.contactId);
  expect(after).toMatchObject({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    type: 'tenant',
    status: 'searching',
    consent_method: 'verbal_in_person',
  });
  expect(after['capture_source']).not.toBe('flyer');
  expect(after['unit_of_interest']).toBeUndefined();

  // The open contact page read the thread: nothing stays unread for later specs.
  await expect.poll(() => serverUnread(api, tenant.contactId), { timeout: 15_000 }).toBe(0);
});

test('an existing landlord on /join: the join pin and an unread inbox row, no text, and the contact unchanged', async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // a public sign-up, the inbox and the contact page
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  // No thread yet: the sign-up makes the landlord's own (D6 conversationTypeFor).
  const landlord = await createContact(api, { type: 'landlord', firstName: `Joinexist${stamp}`, lastName: 'Landlord' });

  const typed = { firstName: `Joiner${stamp}`, lastName: 'Typed' };
  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/join`);
  await expect(visitor.getByRole('combobox', { name: 'Housing authority' })).toBeEnabled();
  await fillSignUp(visitor, { ...typed, phone: landlord.phone });
  await visitor.getByRole('button', { name: 'Sign me up' }).click();
  await expect(visitor.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
  await close();

  // Server truth (D6): ONE join pin with no ref, and the new thread unread.
  const pinLabel = `Signed up on the join page as ${typed.firstName} ${typed.lastName}`;
  await expect
    .poll(() => signedUpPins(api, landlord.contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}||`]);
  await expect.poll(() => serverUnread(api, landlord.contactId), { timeout: 15_000 }).toBe(1);
  // D5: no welcome for an existing contact.
  expect(await getOutboundTo(request, { to: landlord.phone })).toHaveLength(0);

  // The inbox, BEFORE the contact page.
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('link').filter({ hasText: landlord.name });
  await expect(row.getByLabel('1 unread')).toBeVisible({ timeout: 15_000 });

  // The pin is plain text (no ref, so no link).
  await page.goto(`${NEXT}/contacts/${landlord.contactId}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  await expect(timeline.getByText(pinLabel, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(timeline.getByRole('link', { name: pinLabel })).toHaveCount(0);

  // D4: still a landlord with its own name, and no housing authority or
  // consent picked up from the form.
  const after = await getContact(api, landlord.contactId);
  expect(after).toMatchObject({ type: 'landlord', firstName: landlord.firstName, lastName: landlord.lastName });
  expect(after['housingAuthority']).toBeUndefined();
  expect(after['consent_method']).toBeUndefined();

  await expect.poll(() => serverUnread(api, landlord.contactId), { timeout: 15_000 }).toBe(0);
});

test('a NEW contact on the flyer gets the welcome, then the pin, the unread mark and the Signed up entry', async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // a public sign-up and four server reads
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Newlead' });
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Newlead Ct`,
    area: `Newhood ${stamp}`,
    stamp,
  });

  const phone = uniquePhone();
  const person = { firstName: `Flyernew${stamp}`, lastName: 'Lead' };
  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);
  await fillSignUp(visitor, { ...person, phone });
  await visitor.getByRole('button', { name: 'Sign up', exact: true }).click();
  // D3 item 8: the thank-you keeps its heading and drops the old "a team
  // member will be in touch" promise.
  await expect(visitor.getByRole('heading', { name: /you're all set/i })).toBeVisible();
  await expect(
    visitor.getByText("We'll text you about this home and others that fit your voucher.", { exact: true }),
  ).toBeVisible();
  await close();

  // D5: a contact this request created gets the welcome - exactly once. This
  // is also the positive control for the other cases' "no text" checks.
  await expect
    .poll(async () => (await getOutboundTo(request, { to: phone })).length, { timeout: 15_000 })
    .toBe(1);
  const contactId = await contactIdByPhone(api, phone);
  const pinLabel = `Signed up from the flyer for ${unit.line1}, ${CITY_LINE} as ${person.firstName} ${person.lastName}`;
  await expect
    .poll(() => signedUpPins(api, contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}|unit|${unit.unitId}`]);
  // Cameron 2026-10-21: a new sign-up shows in the inbox as unread too.
  await expect.poll(() => serverUnread(api, contactId), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => sentOutcome(api, contactId, unit.unitId), { timeout: 15_000 }).toBe('signed_up');

  // Leave the thread read for later specs.
  const read = await api.post(`${NEXT}/api/inbox/${contactId}/read`);
  expect(read.ok(), await read.text()).toBeTruthy();
});

test("a sign-up from an Occupied property's flyer: full credit and the pin names the status", async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // two flyer loads, a public sign-up, the server reads and the contact page
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Keptlive' });
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Keptlive Ln`,
    area: `Kepthood ${stamp}`,
    stamp,
  });

  // permanent-flyer-links D3a positive control: while the property is
  // Available its flyer links out to the external listing it records.
  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);
  await expect(visitor.getByRole('link', { name: 'See the full listing' })).toHaveAttribute('href', unit.listingUrl);

  // Occupied through the manual listing-status transition (any status from any
  // status), as staff would after a move-in.
  const occupied = await api.patch(`${NEXT}/api/units/${unit.unitId}/listing-status`, {
    data: { toStatus: 'occupied', source: 'manual' },
  });
  expect(occupied.ok(), await occupied.text()).toBeTruthy();

  // D2, D3: the SAME link still serves the whole flyer (the page fetches once
  // per load, so load it again). Positive checks on this load first...
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(unit.line1);
  await expect(visitor.getByRole('link', { name: 'Watch the tour' })).toHaveAttribute('href', unit.videoUrl);
  // ...D3a: every detail row but the external Listing (the video tour stays)...
  await expect(visitor.getByRole('term')).toHaveText([
    'Application fee',
    'Tenant pays',
    'Washer / dryer',
    'Same-day RTA',
    'Video tour',
  ]);
  // ...then the absences: no listing link, no status word (never /available/i -
  // every flyer reads "Same-day tours available"), none of the retired page's words.
  await expect(visitor.getByRole('link', { name: 'See the full listing' })).toHaveCount(0);
  await expect(visitor.getByText(/under application|finalizing|occupied|on hold|off market/i)).toHaveCount(0);
  await expect(visitor.getByText(/no longer available|taken|removed/i)).toHaveCount(0);
  // The public JSON: served, the listing link nulled off Available, and no status key.
  const flyerRes = await request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
  expect(flyerRes.status(), await flyerRes.text()).toBe(200);
  const { flyer } = (await flyerRes.json()) as { flyer: Record<string, unknown> };
  expect(flyer['listing_link']).toBeNull();
  expect(flyer).not.toHaveProperty('status');

  // A NEW person signs up from the Occupied flyer.
  const phone = uniquePhone();
  const person = { firstName: `Flyerkept${stamp}`, lastName: 'Lead' };
  await fillSignUp(visitor, { ...person, phone });
  await visitor.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(visitor.getByRole('heading', { name: /you're all set/i })).toBeVisible();
  await expect(
    visitor.getByText("We'll text you about this home and others that fit your voucher.", { exact: true }),
  ).toBeVisible();
  await close();

  // D5: credited exactly like a sign-up from an Available flyer - the welcome,
  // the pin with the unit ref, the Signed up entry, the flyer capture source and
  // the unit of interest. D6: the pin names the status the home had at sign-up.
  await expect
    .poll(async () => (await getOutboundTo(request, { to: phone })).length, { timeout: 15_000 })
    .toBe(1);
  const contactId = await contactIdByPhone(api, phone);
  const pinLabel = `Signed up from the flyer for ${unit.line1}, ${CITY_LINE} (Occupied) as ${person.firstName} ${person.lastName}`;
  await expect
    .poll(() => signedUpPins(api, contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}|unit|${unit.unitId}`]);
  await expect.poll(() => sentOutcome(api, contactId, unit.unitId), { timeout: 15_000 }).toBe('signed_up');
  expect(await getContact(api, contactId)).toMatchObject({
    capture_source: 'flyer',
    unit_of_interest: unit.unitId,
  });

  // The contact page: the pin links to the property.
  await page.goto(`${NEXT}/contacts/${contactId}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  const pin = timeline.getByRole('link', { name: pinLabel, exact: true });
  await expect(pin).toBeVisible({ timeout: 15_000 });
  await expect(pin).toHaveAttribute('href', `/listings/${unit.unitId}`);

  // The open contact page read the new thread: nothing stays unread for later specs.
  await expect.poll(() => serverUnread(api, contactId), { timeout: 15_000 }).toBe(0);
});
