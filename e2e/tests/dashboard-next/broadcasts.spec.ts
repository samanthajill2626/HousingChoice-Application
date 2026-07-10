import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';

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
// Seeded data (app/src/lib/seedData.ts):
//   - unit-0001 = 1450 Joseph E. Boone Blvd NW (beds 2, atlanta_housing)
//   - contact-tenant-0001 = Tasha Nguyen (voucherSize 2) → matches unit-0001's
//     2-BR audience. We seed a PRIOR sent broadcast for unit-0001 that includes
//     Tasha so the next preview flags her "already sent" (the byUnit GSI resolves
//     this on the local DynamoDB).
// To get a multi-candidate, order-independent audience we create our OWN tenants
// (voucherSize 2, unique per-run phones) via the API. Sends are asserted via the
// fake-twilio thread store — never real SMS. Served on :5174 (the suite baseURL).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SEEDED_UNIT = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW, beds 2
const TASHA = 'contact-tenant-0001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Create a tenant via the API (camelCase voucherSize so the resolver matches).
 *  `voucherSize` defaults to 2 (the unit-0001 audience); pass 3 for a tenant the
 *  2-BR filter will NOT catch (so it must be added manually via search).
 *  Returns the new contactId + the display name we can search/assert on. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Bcastest', phone, voucherSize },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  // A2P/CTIA (spec §4): a no-consent tenant is fenced out of broadcasts (its preview
  // row is disabled). These test tenants are meant to be SENDABLE, so record consent.
  const consentRes = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
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
  opts: { available: boolean },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      jurisdiction: 'atlanta_housing',
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

    // A2P/CTIA (spec §4): seeded Tasha (contact-tenant-0001) now carries inbound_text
    // consent from her seeded inbound reply, so she's already a normal already-sent
    // candidate row (not badged no-consent). This PATCH is now a redundant no-op —
    // kept so the test stays robust regardless of the seed's consent state.
    const tashaConsent = await page.request.patch(`${NEXT}/api/contacts/${TASHA}`, {
      data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
    });
    expect(tashaConsent.ok()).toBeTruthy();

    // --- Set up the audience: two fresh 2-BR tenants we control (unique names). ---
    const stamp = `${Date.now()}`.slice(-6);
    // Per-run Available property (spec 2026-07-10): with the send guard live,
    // sending against seeded unit-0001 would 400 (it is under_application, kept
    // that way for public-pages.spec.ts). Create + publish our own.
    const unitId = await createUnitViaApi(page.request, stamp, { available: true });
    const keep = await createTenant(page.request, `Keepme${stamp}`);
    const drop = await createTenant(page.request, `Dropme${stamp}`);
    // A 3-BR tenant: NOT caught by the 2-BR filter → must be added via search.
    const added = await createTenant(page.request, `Addme${stamp}`, 3);

    // --- Seed a PRIOR sent broadcast for unit-0001 that includes Tasha, so the
    // next preview flags her "already sent". Built straight through the API. ---
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
      data: { recipientContactIds: [TASHA] },
    });
    expect(sentRes.ok()).toBeTruthy();

    // --- Compose from the property: "Broadcast to tenants" in the kebab menu. ---
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Broadcast to tenants' }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?unitId=${unitId}`));
    await expect(page.getByRole('heading', { name: 'New broadcast' })).toBeVisible();

    // The voucher size is PRE-FILLED from the unit's 2 beds (the 2-BR chip is
    // pressed + tagged "matches property").
    const twoBr = page.getByRole('button', { name: /2-BR/ });
    await expect(twoBr).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/matches property/i)).toBeVisible();

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

    // Our two 2-BR tenants are filter-matched candidates (preview rows show the
    // FIRST name only). Tasha is too (already-sent).
    await expect(list.getByText(keep.firstName)).toBeVisible();
    await expect(list.getByText(drop.firstName)).toBeVisible();

    // Tasha is flagged "already sent" and starts UNCHECKED (soft opt-in to resend).
    const tashaRow = list.locator('li', { hasText: 'Tasha' });
    await expect(tashaRow.getByText('Already sent')).toBeVisible();
    await expect(tashaRow.getByRole('checkbox')).not.toBeChecked();

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

    // Send to the curated selection.
    await page.getByRole('button', { name: /^Send to/ }).click();

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
    // A sendable 2-BR tenant the default audience will catch.
    await createTenant(page.request, `Warnme${stamp}`);
    // Fresh unit left in 'setup' - NOT shareable, so the flyer link is dead.
    const unitId = await createUnitViaApi(page.request, stamp, { available: false });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    // The early banner names the coming ask.
    await expect(page.getByText(/its flyer link won't work/i)).toBeVisible();

    await page.getByLabel('Message').fill(`Warn flow ${stamp} - see [FlyerLink]`);
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    await page.getByRole('button', { name: /^Send to \d+ tenants?$/ }).click();

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
});

test.describe('Broadcasts - live send progress + disjoint buckets + recipient identity', () => {
  // Read one StatChips value by its label. The chips render as a
  // <dl aria-label="Delivery stats"> of <div><dt>{label}</dt><dd>{value}</dd></div>;
  // scope to that dl (so a recipient DeliveryBadge like "Sent"/"Delivered" can't
  // collide) and match the label's <dt> EXACTLY, then read its sibling <dd>.
  async function statValue(page: Page, label: string): Promise<number> {
    const chip = page
      .getByLabel('Delivery stats')
      .locator('div')
      .filter({ has: page.getByText(label, { exact: true }) });
    const text = (await chip.locator('dd').textContent()) ?? '';
    return Number(text.trim());
  }

  // The lifecycle pill, scoped to the results <header> (the one holding the
  // page h1). Scoping matters: the StatChips row ALWAYS renders a "Sent" <dt>,
  // so a bare page-level getByText('Sent') can match the chip label and pass
  // VACUOUSLY even if the pill never flipped.
  function statusPill(page: Page, label: string) {
    return page
      .locator('header')
      .filter({ has: page.getByRole('heading', { level: 1 }) })
      .getByText(label, { exact: true });
  }

  test('curated send: land while Sending, chips tick, terminal Delivered=N/Sent=0/Queued=0, rows show names + formatted phones + contact links', async ({
    page,
    request,
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
    //   - Queued falls below the full audience as the paced fan-out drains it;
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
    // buckets: Delivered = N, Sent = 0, Queued = 0 (no double-counting). Read the
    // three chips together so the assertion reflects one consistent snapshot.
    await expect
      .poll(
        async () => ({
          delivered: await statValue(page, 'Delivered'),
          sent: await statValue(page, 'Sent'),
          queued: await statValue(page, 'Queued'),
        }),
        { timeout: 20_000, message: 'buckets should finalize to Delivered=N, Sent=0, Queued=0' },
      )
      .toEqual({ delivered: N, sent: 0, queued: 0 });

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
    // response so we can assert it leaves the Drafts list after deletion. (The
    // composer's throwaway draft is (re)created on a debounced material change;
    // the LAST create for this compose is the one Preview/Delete acts on.)
    await page.goto(`${NEXT}/broadcasts/new?unitId=${SEEDED_UNIT}`);
    await expect(page.getByRole('heading', { name: 'New broadcast' })).toBeVisible();

    const createResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/broadcasts') && r.request().method() === 'POST',
    );
    await page.getByLabel('Message').fill(`Draft to delete ${stamp}`);
    const created = await createResp;
    const draftId = (await created.json()).broadcastId as string;

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
