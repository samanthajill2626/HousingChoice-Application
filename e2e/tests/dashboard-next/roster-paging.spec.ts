import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { dashboardUrl } from '../../support/urls.js';
import { expectTodayReady } from '../../support/today.js';

// Roster paging e2e - THE regression test for the bug this branch exists to fix.
//
// GET /api/contacts pages at 50, and the byTypeStatus GSI's range key is
// `status`, so DynamoDB returns the tenant partition ORDERED BY STATUS. In
// production (measured 2026-08-20) `searching` sorted last, which put 591 of 641 tenants - nearly
// every active one - past the first page. The Schedule-a-tour tenant typeahead
// read only that first page, so those tenants could not be picked and a tour
// could not be booked from that side of the form.
//
// The unit side of this same form had a "walks every page" test. The tenant side
// had none, which is exactly why it stayed broken after the unit side was fixed.
//
// WHY THIS SPEC MINTS ITS OWN VOLUME: the lean world holds far fewer than 50
// tenants, so against it a first-page-only read and a full walk are
// indistinguishable - the bug is INVISIBLE below one page.
//
// WHY IT CLEANS UP: the lean world is byte-stable and shared with every other
// spec (see tour-roster.spec.ts). Leaving 60 extra tenants behind would change
// what any other spec sees. Everything minted here is soft-deleted in a
// `finally`.
//
// Precisely: that restores the DEFAULT list scope, which is what other specs
// read. It does NOT restore the world - the rows and their phone numbers
// persist, and the Contacts "Deleted" view grows by 60 per run. A spec that
// asserts on the deleted view, or a lane kept alive across many runs, will
// notice.
//
// WHY THE TARGET IS DISCOVERED, NOT HARD-CODED: which tenant lands past position
// 50 depends on generated contactIds. Rather than guess, the spec asks the
// server for page one exactly as the buggy client did, walks every page, and
// picks a tenant present in the full walk but ABSENT from page one. That is
// deterministic whatever the ids turn out to be, and it fails loudly if the
// minting did not actually produce a second page.
//
// dashboard-next dialect: a local devLogin and `page.request` for setup. TWO
// things are load-bearing there and BOTH answer `{"error":"forbidden"}` when
// missed: the bare `request` fixture carries no session cookie, and API calls
// must go through the DASHBOARD origin, not the app's. The Vite dev server
// proxies /api and injects the `x-origin-verify` header the origin-secret
// middleware demands; hitting the app port directly skips the proxy and is
// refused at the edge before any route runs.

/** Enough `searching` tenants to guarantee a second page on top of the seed. */
const EXTRA_TENANTS = 60;
const PAGE_LIMIT = 50;
const MARKER = 'Pagedtenant';

/** A run-unique E.164 (the tour-roster.spec idiom) - never a seeded number, and
 *  never a repeat of a prior run's (POST /api/contacts 409s on a duplicate
 *  phone, and a soft-deleted contact still holds its number). */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Contact {
  contactId: string;
  firstName?: string;
  lastName?: string;
}

/** One page of tenants, exactly as the pre-fix client read it. */
async function tenantPageOne(req: APIRequestContext): Promise<Contact[]> {
  const res = await req.get(`${dashboardUrl}/api/contacts?type=tenant&limit=${PAGE_LIMIT}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contacts: Contact[] }).contacts;
}

/** EVERY tenant, following nextCursor - what the fixed client reads. */
async function allTenants(req: APIRequestContext): Promise<Contact[]> {
  const out: Contact[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const qs = `type=tenant&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await req.get(`${dashboardUrl}/api/contacts?${qs}`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = (await res.json()) as { contacts: Contact[]; nextCursor: string | null };
    out.push(...body.contacts);
    if (!body.nextCursor) return out;
    cursor = body.nextCursor;
  }
  throw new Error('allTenants: page cap hit - far more tenants exist than this spec minted');
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${dashboardUrl}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

test.describe('tenant roster paging', () => {
  // Minting + cleaning 60 contacts does not fit the 30s default. It matters that
  // this is generous: when the budget runs out mid-`finally`, Playwright reports
  // the CLEANUP timeout and the real assertion failure is never shown - which is
  // exactly the wrong diagnostic for the regression this guards.
  test.setTimeout(180_000);

  test('a tenant past the first server page can be picked in Schedule a tour', async ({ page }) => {
    // Log in FIRST: page.request inherits the session cookie, the bare `request`
    // fixture does not.
    await devLogin(page);
    const req = page.request;
    const minted: string[] = [];

    try {
      // `status: 'searching'` is deliberate, not incidental: it is the value
      // that sorts LAST in the type partition, so these land at the far end of
      // the GSI exactly the way the production roster did.
      const stamp = `${Date.now()}`.slice(-6);
      // Each id is recorded THE MOMENT it exists, never collected at the end.
      // With `minted.push(...await Promise.all(...))` a single failed POST
      // rejects the batch, `minted` stays empty, and the `finally` cleans up
      // nothing - leaving up to 59 tenants in a lane that every other spec
      // shares. A phone collision against a soft-deleted contact from an earlier
      // run (they keep their numbers) is a live trigger for exactly that.
      await Promise.all(
        Array.from({ length: EXTRA_TENANTS }, async (_unused, i) => {
          const res = await req.post(`${dashboardUrl}/api/contacts`, {
            data: {
              type: 'tenant',
              status: 'searching',
              firstName: MARKER,
              lastName: `${stamp}${String(i).padStart(3, '0')}`,
              phone: freshPhone(),
              voucherSize: 2,
            },
          });
          if (res.ok()) minted.push(((await res.json()) as { contact: Contact }).contact.contactId);
          expect(res.ok(), await res.text()).toBeTruthy();
        }),
      );

      const [pageOne, everyone] = await Promise.all([tenantPageOne(req), allTenants(req)]);

      // The minting must actually have produced more than one page, or this test
      // would pass against the very bug it exists to catch.
      expect(
        everyone.length,
        'no second page of tenants - the regression this guards is invisible below one page',
      ).toBeGreaterThan(pageOne.length);

      const onPageOne = new Set(pageOne.map((c) => c.contactId));
      const offPageOne = everyone.find(
        (c) => !onPageOne.has(c.contactId) && c.firstName === MARKER && Boolean(c.lastName),
      );
      expect(offPageOne, 'no minted tenant landed beyond page one to test with').toBeTruthy();
      const target = offPageOne!;
      const targetName = `${target.firstName} ${target.lastName}`;

      await page.goto(`${dashboardUrl}/tours`);
      await page.getByRole('button', { name: /New tour/i }).click();
      await expect(page.getByRole('dialog', { name: 'Schedule a tour' })).toBeVisible();

      // The typeahead filters its candidate roster CLIENT-side, so a tenant
      // missing from that roster is not merely hard to browse - unfindable.
      await page.getByRole('combobox', { name: 'Tenant' }).fill(target.lastName!);

      // Assert the option EXISTS before clicking it, on a short timeout. Clicking
      // a never-appearing option would burn the whole test budget and then report
      // "locator.click timed out" - true, but it buries the actual finding, which
      // is that this tenant is not in the picker's roster at all.
      const option = page.getByRole('option', { name: new RegExp(targetName) });
      await expect(
        option,
        `${targetName} is past the first server page and was not offered - the typeahead is reading a prefix of the roster`,
      ).toBeVisible({ timeout: 10_000 });
      await option.click();

      await expect(page.getByRole('combobox', { name: 'Tenant' })).toHaveValue(
        new RegExp(targetName),
      );
    } finally {
      // Restore the lean world. Soft-delete drops these back out of the default
      // list scope, so the next spec sees the roster it expects.
      //
      // NEVER throws: this runs in a `finally`, so an error raised here would
      // REPLACE whatever the test was actually failing on. A cleanup problem is
      // worth knowing about, but not at the cost of hiding the real failure.
      // `request.delete` resolves on a non-2xx rather than throwing, so the
      // catch is for transport faults only - a REFUSED delete is silent here by
      // construction. Accepted: this must not mask the real failure.
      await Promise.all(
        minted.map(async (contactId) => {
          try {
            await req.delete(`${dashboardUrl}/api/contacts/${contactId}`);
          } catch {
            /* best-effort - see above */
          }
        }),
      );
    }
  });
});
