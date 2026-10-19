import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';
import { addOrg } from '../../fixtures/orgFixture.js';
import { statValue, statusPill } from '../../support/broadcastSelectors.js';
import { expectTodayReady } from '../../support/today.js';

// Broadcasts surface (:5174), Phase B — the rebuilt "Share a property with a
// curated set of tenants" flow, end-to-end against the real backend (draft →
// preview → send-by-explicit-selection → live results) plus draft delete.
//
// Per design §8:
//   - from a seeded PROPERTY detail → "📣 Broadcast to tenants" → composer with
//     the audience PRE-FILLED (voucher size from the unit beds) → write a message
//     → Preview → uncheck one candidate + add one tenant + see an already-sent
//     flag → Send → land on Results with the right recipient count + a recipient
//     row linking to a contact;
//   - delete an unsent draft from the list (create a draft, see it, delete it,
//     confirm it's gone).
//
// Seeded data (app/src/lib/seedData.ts): unit-0001 = 1450 Joseph E. Boone Blvd
// NW (beds 2, Atlanta Housing Authority) - only the draft-delete test uses it.
// The first two tests build their audience per run (tracker #6): a Matching blast
// reads Searching and Onboarding tenants only and limits them to the property's
// housing authorities, so each adds a RUN-UNIQUE housing authority, gives the
// property and its tenants that name, and (the first test) plants a PRIOR send
// to one of its own tenants so the next preview flags them "already sent" (the
// lean seed's Tasha is Placing, so the filters leave her out).
// To get a multi-candidate, order-independent audience we create our OWN tenants
// (voucherSize 2, unique per-run phones) via the API. Sends are asserted via the
// fake-twilio thread store — never real SMS. Served on :5174 (the suite baseURL).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SEEDED_UNIT = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW, beds 2

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Create a tenant via the API (camelCase voucherSize so the resolver matches).
 *  `voucherSize` defaults to 2 (the unit-0001 audience); pass 3 for a tenant the
 *  2-BR filter will NOT catch (so it must be added manually via search).
 *  The status is EXPLICIT (default Searching): a Matching blast reads Searching
 *  and Onboarding tenants only (tracker #6 D1). `housingAuthority`, when given,
 *  must already be an organization-list name (the PATCH below checks it; the
 *  create ignores the field).
 *  Returns the new contactId + the display name we can search/assert on. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  voucherSize = 2,
  opts: { housingAuthority?: string; status?: 'searching' | 'onboarding' } = {},
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName,
      lastName: 'Bcastest',
      phone,
      voucherSize,
      status: opts.status ?? 'searching',
    },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  // A2P/CTIA (spec §4): a no-consent tenant is fenced out of broadcasts (its preview
  // row is disabled). These test tenants are meant to be SENDABLE, so record consent.
  const consentRes = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: {
      consent_method: 'verbal_in_person',
      consent_at: new Date().toISOString(),
      ...(opts.housingAuthority !== undefined && { housingAuthority: opts.housingAuthority }),
    },
  });
  expect(consentRes.ok()).toBeTruthy();
  // Preview rows from the resolver show the FIRST name only (no lastName); the
  // add-a-tenant search row shows the full "First Last".
  return { contactId, firstName, name: `${firstName} Bcastest`, phone };
}

/** Create a fresh per-run property via the API. New units start in 'setup'
 *  (not shareable); pass available: true to flip it Available through the
 *  transition route - the status the send guard (spec 2026-07-10) requires.
 *  Hermetic on purpose: shared seeded units keep their statuses (unit-0001
 *  MUST stay under_application for public-pages.spec.ts). */
async function createUnitViaApi(
  request: APIRequestContext,
  stamp: string,
  opts: { available: boolean; authorities?: string[] },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      // List names or unique spellings (the default `atlanta_housing` is a
      // spelling of Atlanta Housing Authority). A test whose audience is
      // asserted passes its own run-unique name: the composer prefills its
      // housing authority filter from this list (tracker #6 D3).
      accepted_authorities: opts.authorities ?? ['atlanta_housing'],
      address: { line1: `${stamp} Broadcast Guard Ave`, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok()).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  if (opts.available) {
    const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(flip.ok()).toBeTruthy();
  }
  return unitId;
}

test.describe('Broadcasts — compose from a property → curate → send → results', () => {
  test('pre-filled audience, uncheck one + add one + an already-sent flag, Send → Results', async ({
    page,
    request,
  }) => {
    // dev-login FIRST so page.request carries the session cookie for the
    // authenticated /api setup calls below (the bare `request` fixture has none).
    await devLogin(page);

    // --- Set up the audience: three fresh 2-BR Searching tenants we control
    // (unique names) in a RUN-UNIQUE housing authority (tracker #6: the
    // composer prefills the property's authorities and the blast reads
    // Searching and Onboarding tenants in them only, so a shared authority
    // would pull in every earlier spec's tenants). ---
    const stamp = `${Date.now()}`.slice(-6);
    const authority = `Bcast Compose Authority ${stamp}`;
    await addOrg(page.request, { kind: 'housing_authority', name: authority });
    // Per-run Available property (spec 2026-07-10): with the send guard live,
    // sending against seeded unit-0001 would 400 (it is under_application, kept
    // that way for public-pages.spec.ts). Create + publish our own.
    const unitId = await createUnitViaApi(page.request, stamp, { available: true, authorities: [authority] });
    const keep = await createTenant(page.request, `Keepme${stamp}`, 2, { housingAuthority: authority });
    const drop = await createTenant(page.request, `Dropme${stamp}`, 2, { housingAuthority: authority });
    // The already-sent tenant is ours, not the lean seed's Tasha: she is
    // Placing, so the filters leave her out (tracker #6 D1).
    const prior = await createTenant(page.request, `Priorsent${stamp}`, 2, { housingAuthority: authority });
    // A 3-BR tenant: NOT caught by the 2-BR filter → must be added via search.
    const added = await createTenant(page.request, `Addme${stamp}`, 3);

    // --- Seed a PRIOR send of this property to `prior`, so the next preview
    // flags them "already sent". Built straight through the API. ---
    const draftRes = await page.request.post(`${NEXT}/api/broadcasts`, {
      data: {
        unitId,
        body_template: `Prior send ${stamp} for [TenantName]`,
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      },
    });
    expect(draftRes.ok()).toBeTruthy();
    const priorId = (await draftRes.json()).broadcastId as string;
    const sentRes = await page.request.post(`${NEXT}/api/broadcasts/${priorId}/send`, {
      data: { recipientContactIds: [prior.contactId] },
    });
    expect(sentRes.ok()).toBeTruthy();

    // --- Compose from the property: "Send this property" in the kebab menu. ---
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Send this property', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?unitId=${unitId}`));
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();

    // The voucher size is PRE-FILLED from the unit's 2 beds (the 2-BR chip is
    // pressed + tagged "matches property").
    const twoBr = page.getByRole('button', { name: /2-BR/ });
    await expect(twoBr).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/matches property/i)).toBeVisible();

    // The housing authority filter is PRE-FILLED with the property's run-unique
    // authority (tracker #6 D3): one chip in the "Housing authorities" picker.
    await expect(page.getByRole('button', { name: `Remove ${authority}`, exact: true })).toBeVisible();

    // Let the message prefill settle before typing: it is written on property
    // load, then again with the server's ?cta=text link
    // (docs/issues/a2p-consent-reinclude-fill-races-prefill.md).
    await expect(page.getByLabel('Message')).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), {
      timeout: 15_000,
    });

    // Write a message (unique so its outbound copy is assertable in the fake).
    const body = `Open house ${stamp} — a 2BR home is available.`;
    await page.getByLabel('Message').fill(body);

    // The live reach resolves (a non-empty audience) and Preview enables.
    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();

    // --- The curated recipient list. ---
    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list).toBeVisible();

    // Our three 2-BR tenants are filter-matched candidates; `prior` is the
    // already-sent one.
    await expect(list.getByText(keep.firstName)).toBeVisible();
    await expect(list.getByText(drop.firstName)).toBeVisible();

    // `prior` is flagged "already sent" and starts UNCHECKED (soft opt-in to resend).
    const priorRow = list.locator('li', { hasText: prior.name });
    await expect(priorRow.getByText('Already sent')).toBeVisible();
    await expect(
      list.getByRole('checkbox', { name: `${prior.name} - already sent`, exact: true }),
    ).not.toBeChecked();

    // Uncheck one candidate (drop) so it is excluded from the send.
    const dropRow = list.locator('li', { hasText: drop.firstName });
    await dropRow.getByRole('checkbox').uncheck();
    await expect(dropRow.getByRole('checkbox')).not.toBeChecked();

    // Add a tenant the 2-BR filter did NOT catch (our 3-BR tenant), via the
    // search → it appends as an "Added" row, checked.
    await page.getByRole('combobox', { name: 'Add a tenant' }).fill(`Addme${stamp}`);
    await page.getByRole('option', { name: new RegExp(added.name) }).click();
    const addedRow = list.locator('li', { hasText: added.name });
    await expect(addedRow.getByText('Added')).toBeVisible();
    await expect(addedRow.getByRole('checkbox')).toBeChecked();

    // Send to the curated selection: keep + the hand-added tenant (drop was
    // unchecked by hand, prior starts unchecked).
    await page.getByRole('button', { name: 'Send to 2 recipients', exact: true }).click();

    // --- Lands on Results for this broadcast (the send POST resolves, then the
    // composer navigates). Allow headroom for the send round-trip. ---
    await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /Tenants/ })).toBeVisible();
    await expect(page.getByLabel('Delivery stats')).toBeVisible();

    // A recipient row links to a tenant's contact page (the comms disposition path).
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients).toBeVisible({ timeout: 10_000 });
    // At least one recipient row is a contact link → /contacts/<id>.
    await expect(recipients.getByRole('link').first()).toHaveAttribute('href', /\/contacts\//);

    // Regression net (the DLR-rollup race that let recipients stick at "Sent"):
    // a recipient advances to Delivered. The fake fires delivery callbacks a
    // beat after the send; the results view live-updates via the broadcast.updated
    // SSE (debounced refetch), so a recipient row's badge reaches "Delivered"
    // with no manual reload. This is the assertion that was missing before.
    await expect(recipients.getByText('Delivered').first()).toBeVisible({ timeout: 15_000 });

    // --- PROOF OF SEND via the fake-twilio thread store (not real SMS): the
    // "keep" tenant got the outbound broadcast body; the "drop" tenant did NOT. ---
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const t = threads.find((x) => x.partyNumber === keep.phone);
          return t?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body)) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const droppedGotIt = (await listThreads(request))
      .find((x) => x.partyNumber === drop.phone)
      ?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body));
    expect(droppedGotIt ?? false).toBe(false);
  });

  test('sending a non-Available property warns, and Make Available & send flips it + sends', async ({
    page,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    // A sendable 2-BR Searching tenant in a RUN-UNIQUE housing authority the
    // property accepts, so the prefilled audience is exactly this tenant
    // (tracker #6: a shared authority would pull in other specs' tenants).
    const authority = `Bcast Warn Authority ${stamp}`;
    await addOrg(page.request, { kind: 'housing_authority', name: authority });
    await createTenant(page.request, `Warnme${stamp}`, 2, { housingAuthority: authority });
    // Fresh unit left in 'setup' - NOT shareable, so the flyer link is dead.
    const unitId = await createUnitViaApi(page.request, stamp, { available: false, authorities: [authority] });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    // The early banner names the coming ask.
    await expect(page.getByText(/its flyer link won't work/i)).toBeVisible();

    await page.getByLabel('Message').fill(`Warn flow ${stamp} - see [FlyerLink]`);
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    await page.getByRole('button', { name: 'Send to 1 recipient', exact: true }).click();

    // The blocking dialog - nothing sent yet.
    const dialog = page.getByRole('dialog', { name: "Property isn't Available" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Make Available & send' }).click();

    // The send proceeded to the results page (mirrors the compose test's
    // Results-landing assertion - lands on /broadcasts/<id>).
    await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });

    // The flip really persisted server-side.
    const unitRes = await page.request.get(`${NEXT}/api/units/${unitId}`);
    expect(unitRes.ok()).toBeTruthy();
    expect(((await unitRes.json()) as { unit: { status: string } }).unit.status).toBe('available');
  });

  test('the voucher size pre-fills from a RECORDED voucher size, not the bedroom count', async ({ page }) => {
    // The 2026-10-12 report: a property with its own voucher size was matched on
    // its bedrooms. A 2-bed unit that records a 3-BR voucher size.
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const unitId = await createUnitViaApi(page.request, stamp, { available: true });
    const patch = await page.request.patch(`${NEXT}/api/units/${unitId}`, {
      data: { voucher_size_accepted: 3 },
    });
    expect(patch.ok()).toBeTruthy();

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    const threeBr = page.getByRole('button', { name: /^3-BR/ });
    await expect(threeBr).toHaveAttribute('aria-pressed', 'true');
    await expect(threeBr).toContainText(/matches property/i);
    await expect(page.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Pre-filled to the 3-bedroom voucher this property takes')).toBeVisible();
  });
});

test.describe('Broadcasts - live send progress + disjoint buckets + recipient identity', () => {
  // The chip and pill reads (statValue, statusPill) live in
  // support/broadcastSelectors.ts with their collision rules.
  test('curated send: land while Sending, chips tick, terminal Delivered=N with all in-flight buckets drained, rows show names + formatted phones + contact links', async ({
    page,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);

    // Five fresh, consented 2-BR tenants we fully control. Five recipients gives
    // a clean all-delivered set AND a wall-clock sending window: the shared A2P
    // token bucket admits ~1 send/sec (capacity 1, refill 1/s), so the paced
    // fan-out cannot finish in under ~4s regardless of CPU. That guaranteed window
    // is what lets us land on the detail page WHILE the broadcast is still Sending
    // even when page mount + first paint are slow on a loaded box.
    const tenants: Array<{ contactId: string; firstName: string; name: string; phone: string }> = [];
    for (const label of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      tenants.push(await createTenant(page.request, `${label}${stamp}`));
    }
    const N = tenants.length;
    const body = `Live progress ${stamp} - a 2BR home is available.`;
    // Per-run Available property (spec 2026-07-10): the send guard rejects a
    // non-available unit, and seeded unit-0001 must stay under_application for
    // public-pages.spec.ts. Create + publish our own.
    const unitId = await createUnitViaApi(page.request, stamp, { available: true });

    // A curated send (explicit recipientContactIds = the curation) driven straight
    // through the API - the SAME send mechanism the composer posts. The send POST
    // now returns in milliseconds (the in-process queue adapter defers dispatch to
    // a macrotask instead of awaiting the whole fan-out), so navigating immediately
    // after it resolves lands us mid-send.
    const draftRes = await page.request.post(`${NEXT}/api/broadcasts`, {
      data: {
        unitId,
        body_template: `${body} [TenantName]`,
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      },
    });
    expect(draftRes.ok()).toBeTruthy();
    const broadcastId = (await draftRes.json()).broadcastId as string;
    const sendRes = await page.request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
      data: { recipientContactIds: tenants.map((t) => t.contactId) },
    });
    expect(sendRes.ok(), await sendRes.text()).toBeTruthy();

    // Land on the detail page while the send is running.
    await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
    await expect(page.getByLabel('Delivery stats')).toBeVisible({ timeout: 10_000 });

    // (1) We ARE mid-send: the header pill reads "Sending" (scoped + exact, so
    // neither a per-recipient "Sending..." badge nor any chip label can match).
    // Proves G1 - the deferred adapter returns fast enough that the operator
    // lands during the run.
    await expect(statusPill(page, 'Sending')).toBeVisible({ timeout: 10_000 });

    // (2) The chips TICK during the run, observed live on a page we never reload:
    //   - Queued (still on OUR box) falls below the full audience as the paced
    //     fan-out dispatches each leg (it moves to Sending, then the fake's
    //     carrier callbacks walk it Sent -> Delivered);
    //   - Sent + Delivered rises above zero.
    // Both are monotonic, so polling is race-free (they become true and stay true).
    await expect
      .poll(async () => statValue(page, 'Queued'), {
        timeout: 15_000,
        message: 'Queued should tick down below the audience during the send',
      })
      .toBeLessThan(N);
    await expect
      .poll(async () => (await statValue(page, 'Sent')) + (await statValue(page, 'Delivered')), {
        timeout: 15_000,
        message: 'Sent+Delivered should rise above zero during the send',
      })
      .toBeGreaterThan(0);

    // (3) Terminal state - the fake's DLRs drive every slot to delivered. Disjoint
    // buckets: Delivered = N, Sent = 0, Sending = 0, Queued = 0 (no double-
    // counting). Read the chips together so the assertion reflects one snapshot.
    await expect
      .poll(
        async () => ({
          delivered: await statValue(page, 'Delivered'),
          sent: await statValue(page, 'Sent'),
          sending: await statValue(page, 'Sending'),
          queued: await statValue(page, 'Queued'),
        }),
        {
          timeout: 20_000,
          message: 'buckets should finalize to Delivered=N, Sent=0, Sending=0, Queued=0',
        },
      )
      .toEqual({ delivered: N, sent: 0, sending: 0, queued: 0 });

    // The lifecycle pill live-updated to the terminal "Sent" (no manual reload).
    // MUST be the scoped pill: the "Sent" chip <dt> always exists, so an unscoped
    // getByText would pass without the pill ever flipping.
    await expect(statusPill(page, 'Sent')).toBeVisible({ timeout: 10_000 });

    // (4) Recipient identity: each row shows the tenant's NAME (primary) + FORMATTED
    // phone (secondary, "(555) XXX-XXXX" - never the raw E.164) and links to
    // /contacts/:id. No "Tenant" fallback - the results endpoint enriched every row.
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients).toBeVisible({ timeout: 10_000 });
    for (const t of tenants) {
      const row = recipients.getByRole('link').filter({ hasText: t.name });
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('href', `/contacts/${t.contactId}`);
      // Formatted (not raw): area-code grouping + this tenant's unique last 4 digits.
      await expect(row).toContainText('(555) ');
      await expect(row).toContainText(t.phone.slice(-4));
    }
  });
});

test.describe('Broadcasts — delete an unsent draft', () => {
  test('compose a draft, see it in the Drafts list, delete it → gone afterwards', async ({
    page,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);

    // Compose a fresh draft through the UI. Capture its id from the create
    // response so we can assert it leaves the Drafts list after deletion. The
    // composer makes no draft until the property prefill settles (tracker #6),
    // then (re)creates its throwaway draft on a debounced material change and
    // deletes the superseded one - so record EVERY create of this compose, wait
    // until Preview is enabled (the current draft is then made for what is on
    // screen) and take the LAST create made for the typed message.
    const message = `Draft to delete ${stamp}`;
    const creates: Response[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/broadcasts') creates.push(r);
    });
    await page.goto(`${NEXT}/broadcasts/new?unitId=${SEEDED_UNIT}`);
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    await page.getByLabel('Message').fill(message);
    await expect(page.getByRole('button', { name: 'Preview recipients' })).toBeEnabled({ timeout: 15_000 });
    const created = creates
      .filter((r) =>
        ((r.request().postDataJSON() as { body_template?: string } | null)?.body_template ?? '').includes(message),
      )
      .at(-1);
    expect(created, 'a draft create for the typed message').toBeDefined();
    // Read before navigating away (the response body goes with the page).
    const draftId = ((await created?.json()) as { broadcastId: string }).broadcastId;

    // It shows in the Drafts list (resume link carries ?draftId=).
    await page.goto(`${NEXT}/broadcasts`);
    await page.getByRole('tab', { name: 'Drafts' }).click();
    const draftRow = page
      .getByRole('listitem')
      .filter({ has: page.locator(`a[href="/broadcasts/new?draftId=${draftId}"]`) });
    await expect(draftRow).toBeVisible({ timeout: 10_000 });

    // Delete straight from the list row (the direct affordance — the composer
    // can't rehydrate a draft, so the list is where a draft gets killed) →
    // confirm in the modal.
    await draftRow.getByRole('button', { name: /^Delete draft:/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete draft?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete draft' }).click();

    // The row drops from the Drafts list without a reload.
    await expect(page.locator(`a[href="/broadcasts/new?draftId=${draftId}"]`)).toHaveCount(0, {
      timeout: 10_000,
    });
    // The API confirms the original draft is deleted (404).
    await expect
      .poll(async () => (await page.request.get(`${NEXT}/api/broadcasts/${draftId}/results`)).status(), {
        timeout: 10_000,
      })
      .toBe(404);
  });
});
