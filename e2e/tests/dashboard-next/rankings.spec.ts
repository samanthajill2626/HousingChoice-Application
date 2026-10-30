// e2e/tests/dashboard-next/rankings.spec.ts
//
// The admin Rankings page (WP1 B2a spec D18; spec section 6 e2e) end to end
// on the hermetic lane. RANKING_DRIVER=fake and RANKING_WORKER_POLL=off
// (scripts/e2e-session.mjs): a queued job runs ONLY when this spec calls
// POST /__dev/ranking/tick (fixtures/ranking.ts rankingTick), so "not ranked
// yet" before the tick and the ranked table after it are both deterministic.
//
// ISOLATION: one reseed in beforeAll wipes every local table to the lean
// world (routes/dev.ts reseed). Each test then builds its own records through
// the API with run-unique names and its OWN run-unique housing authority on
// both sides, so its pool holds exactly its own tenants or properties.
//
// The fake driver's rules (app/src/adapters/rankingFake.ts, spec D6): every
// pair starts at 70; minus 25 for a recorded No pets against tenant pets text
// (failed requirement no_pets - cap-eligible and recorded, so the read caps
// the pair to Weak and sorts it last); plus 10 when the tenant's area
// preference appears in the property's area. So: area match 80 Strong, plain
// 70 Good, pets against No pets capped Weak. `[fake:fail-batch]` in a
// tenant's notes fails every batch holding that tenant; `[fake:unlawful:
// <field>]` in a PROPERTY's notes raises an unlawful flag on <field> for
// every pair (kept only while that field holds text on the card).
//
// getByRole name matching is a SUBSTRING match, so labels that are prefixes
// of others pass `exact: true`.
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  createAvailableProperty,
  createSearchingTenant,
  rankingTick,
  runUniqueAuthority,
} from '../../fixtures/ranking.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stamp(): string {
  return `${Date.now()}`.slice(-6);
}

async function openRankings(page: Page): Promise<void> {
  await page.goto(`${NEXT}/settings/rankings`);
  await expect(page.getByRole('heading', { name: 'Rankings', exact: true })).toBeVisible();
}

function rankPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Rank this anchor' });
}

function rankingTable(page: Page): Locator {
  return rankPanel(page).getByRole('table', { name: 'Ranking' });
}

/** Every row of the ranking table; nth(0) is the header row. */
function rankingRows(page: Page): Locator {
  return rankingTable(page).getByRole('row');
}

function rankingRow(page: Page, name: string): Locator {
  return rankingTable(page).getByRole('row', { name: new RegExp(escapeRegExp(name)) });
}

function jobStatus(page: Page): Locator {
  return rankPanel(page).getByRole('status', { name: 'Ranking job' });
}

async function pickProperty(page: Page, line1: string): Promise<void> {
  const panel = rankPanel(page);
  await panel.getByRole('radio', { name: 'Property', exact: true }).check();
  await panel.getByRole('combobox', { name: 'Property to rank', exact: true }).fill(line1);
  // The suggestion list is portaled to document.body (UnitSearchField).
  await page.getByRole('option', { name: new RegExp(escapeRegExp(line1)) }).click();
}

async function pickTenant(page: Page, name: string): Promise<void> {
  const panel = rankPanel(page);
  await panel.getByRole('radio', { name: 'Tenant', exact: true }).check();
  await panel.getByRole('combobox', { name: 'Tenant to rank', exact: true }).fill(name);
  await page.getByRole('option', { name: new RegExp(escapeRegExp(name)) }).click();
}

async function pressRank(page: Page): Promise<void> {
  await rankPanel(page).getByRole('button', { name: 'Rank', exact: true }).click();
  // Queued, and nothing runs it: the worker's ranking poll is off here.
  await expect(jobStatus(page)).toHaveText('Waiting for a free slot');
}

test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test('an admin ranks a property: not ranked yet before the tick, ranked after, the capped pair last; the run lists with its cost and opens to its own results', async ({
  page,
}) => {
  test.slow();
  await devLoginAs(page, 'founder@example.com');
  const api = page.request;
  const s = stamp();
  const authority = await runUniqueAuthority(api, `Rankprop Authority ${s}`);
  const line1 = `${s} Rankprop Ave`;
  await createAvailableProperty(api, { line1, authority, area: 'Westview', noPets: true });
  // Band-free first names (WORKLIST WL-S7-3): no name holds a band or cap
  // word, so a row or cell assertion can never pass on the name alone.
  const strong = await createSearchingTenant(api, { firstName: `Areamatch${s}`, authority, areaPreference: 'Westview' });
  const good = await createSearchingTenant(api, { firstName: `Plain${s}`, authority });
  const capped = await createSearchingTenant(api, { firstName: `Haspets${s}`, authority, pets: 'Two large dogs' });

  await openRankings(page);
  await pickProperty(page, line1);
  // The pool is read at once: three tenants, none ranked yet.
  await expect(rankingRows(page)).toHaveCount(4);
  for (const tenant of [strong, good, capped]) {
    await expect(rankingRow(page, tenant.name)).toContainText('not ranked yet');
  }

  await pressRank(page);
  await expect(rankingTable(page)).toContainText('not ranked yet');

  await rankingTick(api);
  // The event (or the 5 s job poll) reports the end; the page reads again.
  await expect(jobStatus(page)).toContainText('Done: 1 batch');
  await expect(jobStatus(page)).not.toContainText('not scored');
  // Every row assertion below runs against the RE-READ table, never the
  // stale one (WORKLIST WL-S7-3).
  await expect(rankingTable(page)).not.toContainText('not ranked yet');
  // Band and cap asserted per CELL (RankingTable cell order: Band, Score,
  // Capped, Out of date, Reasons, Missing; the name is the row header).
  const rows = rankingRows(page);
  await expect(rows.nth(1)).toContainText(strong.name);
  await expect(rows.nth(1).getByRole('cell').first()).toHaveText('Strong');
  await expect(rows.nth(2)).toContainText(good.name);
  await expect(rows.nth(2).getByRole('cell').first()).toHaveText('Good');
  // The capped pair sorts last, in Weak.
  await expect(rows.nth(3)).toContainText(capped.name);
  await expect(rows.nth(3).getByRole('cell').first()).toHaveText('Weak');
  await expect(rows.nth(3).getByRole('cell').nth(2)).toHaveText('Capped: requirement not met');

  // The run log, filtered to this property: one run (one batch of three).
  await rankPanel(page).getByRole('button', { name: 'Show runs for this anchor', exact: true }).click();
  const runRow = page.getByRole('list', { name: 'Ranking runs' }).getByRole('button');
  await expect(runRow).toHaveCount(1);
  await expect(runRow).toContainText(line1);
  await expect(runRow).toContainText('Tenants for property');
  await expect(runRow).toContainText('3 candidates');
  await expect(runRow).toContainText('fake');
  await expect(runRow).toContainText(/\$\d+\.\d{4}/);
  await expect(runRow).toContainText('scored');
  await expect(page.getByRole('region', { name: 'Cost by week' })).toContainText(/Environment: \S+/);

  // It opens to its OWN results.
  await runRow.click();
  const detail = page.getByRole('region', { name: 'Ranking run detail' });
  await expect(detail).toBeVisible();
  const pairs = detail.getByRole('table', { name: 'Run pairs' });
  await expect(pairs.getByRole('row')).toHaveCount(4);
  // Per CELL (cell order Score, Band, Cap, For, Against, Missing, Flags,
  // Current match).
  await expect(pairs.getByRole('row', { name: new RegExp(escapeRegExp(strong.name)) }).getByRole('cell').first()).toHaveText('80');
  await expect(pairs.getByRole('row', { name: new RegExp(escapeRegExp(capped.name)) }).getByRole('cell').nth(2)).toHaveText('Capped');
  await expect(pairs).toContainText('This run');
  await expect(detail.getByText('Raw model output', { exact: true })).toBeVisible();
  await expect(detail.getByText('Input sent', { exact: true })).toBeVisible();
});

test('a failed batch reads "not scored - retry"', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  const api = page.request;
  const s = stamp();
  const authority = await runUniqueAuthority(api, `Rankfail Authority ${s}`);
  const line1 = `${s} Rankfail Ct`;
  await createAvailableProperty(api, { line1, authority });
  const failing = await createSearchingTenant(api, { firstName: `Failing${s}`, authority, notes: '[fake:fail-batch]' });
  const beside = await createSearchingTenant(api, { firstName: `Beside${s}`, authority });

  await openRankings(page);
  await pickProperty(page, line1);
  await expect(rankingRows(page)).toHaveCount(3);
  await pressRank(page);
  await rankingTick(api);

  // Counted in CANDIDATES not scored, never "a batch failed" (plan PR42) -
  // by the job's own message, which the page does not count again
  // (code review R1, conformance N3).
  await expect(jobStatus(page)).toContainText('Done: 1 batch. 2 tenants could not be scored. Press Rank again.');
  // Both sat in the one failed batch: neither has a match, and both say so.
  for (const tenant of [failing, beside]) {
    await expect(rankingRow(page, tenant.name)).toContainText('not scored - retry');
  }
});

test('an edit to the property card marks its matches out of date', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  const api = page.request;
  const s = stamp();
  const authority = await runUniqueAuthority(api, `Rankedit Authority ${s}`);
  const line1 = `${s} Rankedit Rd`;
  const unitId = await createAvailableProperty(api, { line1, authority });
  const tenant = await createSearchingTenant(api, { firstName: `Edited${s}`, authority });

  await openRankings(page);
  await pickProperty(page, line1);
  await pressRank(page);
  await rankingTick(api);
  await expect(rankingRow(page, tenant.name)).toContainText('Good');
  await expect(rankingRow(page, tenant.name)).not.toContainText('Out of date');

  // `notes` is on the property card (spec D2.1), so its fingerprint moves.
  const patch = await api.patch(`${NEXT}/api/units/${unitId}`, { data: { notes: `E2E card edit ${s}` } });
  expect(patch.ok(), await patch.text()).toBeTruthy();

  // Opening the page reads stored matches and says which are out of date; the
  // anchor is in the URL, so a reload reads it again. The match still shows.
  await page.reload();
  await expect(rankingRow(page, tenant.name)).toContainText('Out of date: a card changed');
  await expect(rankingRow(page, tenant.name)).toContainText('Good');
});

test('a tenant anchor ranks the available properties', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  const api = page.request;
  const s = stamp();
  const authority = await runUniqueAuthority(api, `Rankten Authority ${s}`);
  const plainLine = `${s} Rankten Way`;
  const noPetsLine = `${s} Rankten Pl`;
  await createAvailableProperty(api, { line1: plainLine, authority });
  await createAvailableProperty(api, { line1: noPetsLine, authority, noPets: true });
  const tenant = await createSearchingTenant(api, { firstName: `Anchor${s}`, authority, pets: 'A cat' });

  await openRankings(page);
  await pickTenant(page, tenant.name);
  // The window checkbox is for a property anchor only (spec D1).
  await expect(rankPanel(page).getByRole('checkbox')).toHaveCount(0);
  await expect(rankingTable(page).getByRole('columnheader', { name: 'Property', exact: true })).toBeVisible();
  await expect(rankingRows(page)).toHaveCount(3);

  await pressRank(page);
  await rankingTick(api);
  await expect(jobStatus(page)).toContainText('Done: 1 batch');
  const rows = rankingRows(page);
  await expect(rows.nth(1)).toContainText(plainLine);
  await expect(rows.nth(1)).toContainText('Good');
  await expect(rows.nth(2)).toContainText(noPetsLine);
  await expect(rows.nth(2)).toContainText('Weak');
  await expect(rows.nth(2)).toContainText('Capped: requirement not met');
});

// Spec D10 rev 7 (charter items 15 and 16): an unlawful flag's record holds
// the fixed reason; it shows on the property's own ranking and on the
// property page, never on a tenant's ranking; editing the flagged text on the
// property page clears the notice at once, with no reload.
test('an unlawful flag shows on the property ranking and the property page, never on the tenant ranking, and goes when its text is edited', async ({
  page,
}) => {
  test.slow();
  await devLoginAs(page, 'founder@example.com');
  const api = page.request;
  const s = stamp();
  const authority = await runUniqueAuthority(api, `Rankflag Authority ${s}`);
  const line1 = `${s} Rankflag Ln`;
  // The marker flags `qualifications` unlawful on every pair; the field holds text, so the flag survives parsing.
  const unitId = await createAvailableProperty(api, {
    line1,
    authority,
    notes: '[fake:unlawful:qualifications]',
    qualifications: 'No kids under 12.',
  });
  const tenant = await createSearchingTenant(api, { firstName: `Flagpair${s}`, authority });

  await openRankings(page);
  await pickProperty(page, line1);
  await pressRank(page);
  await rankingTick(api);
  await expect(jobStatus(page)).toContainText('Done: 1 batch');
  await expect(rankingRow(page, tenant.name)).toContainText('Good');
  // The property anchor's own ranking lists its open flag, with the fixed reason.
  const facts = rankPanel(page).getByRole('list', { name: 'About this anchor' });
  await expect(facts).toContainText(`Fair-housing flag on ${line1}`);
  await expect(facts).toContainText('qualifications: flagged as a requirement fair housing does not allow');

  // The tenant anchor's ranking of the same pair: the stored match shows, no flag line.
  await pickTenant(page, tenant.name);
  await expect(rankingRow(page, line1)).toContainText('Good');
  await expect(rankPanel(page).getByText(/Fair-housing flag/)).toHaveCount(0);

  // The property page: the read-only notice.
  await page.goto(`${NEXT}/listings/${unitId}`);
  const notice = page.getByRole('region', { name: 'Fair-housing flags' });
  await expect(notice).toHaveText(
    'Fair-housing flag - Qualifications: flagged as a requirement fair housing does not allow. Edit this text to clear the flag.',
  );

  // Edit the flagged text through the property's edit form; the save's
  // re-check clears the notice in place (a window marker proves no reload).
  await page.evaluate(() => {
    (window as unknown as { __rankflagNoReload?: boolean }).__rankflagNoReload = true;
  });
  await page.getByRole('button', { name: 'Edit property details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Edit property/i });
  await dialog.getByLabel('Qualifications', { exact: true }).fill('Two years of rental history.');
  const recheck = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/rankings/unit/${unitId}/flags`,
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  expect((await recheck).status()).toBe(200);
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __rankflagNoReload?: boolean }).__rankflagNoReload)).toBe(true);
});

test('a VA cannot open the Rankings tab, but can rank, read and poll a ranking (WI17)', async ({ page }) => {
  await devLoginAs(page, 'va@example.com');
  await page.goto(`${NEXT}/settings`);
  await page.waitForURL(/\/settings\/templates$/, { timeout: 15_000 });
  await expect(page.getByRole('tab', { name: 'Rankings', exact: true })).toHaveCount(0);
  // The route is GUARDED, not just hidden.
  await page.goto(`${NEXT}/settings/rankings`);
  await expect(page).toHaveURL(/\/settings\/templates$/);
  await expect(page.getByRole('heading', { name: 'Rankings', exact: true })).toHaveCount(0);

  const api = page.request;
  expect((await api.get(`${NEXT}/api/admin/rankings/runs`)).status()).toBe(403);
  expect((await api.get(`${NEXT}/api/admin/rankings/cost`)).status()).toBe(403);

  // The rank, read and job endpoints are admin AND va (spec D12). The lean
  // tenant is any record (spec D1); no available property accepts her
  // authority, so her job finishes with no batches.
  const tenantId = 'contact-tenant-0001';
  const read = await api.get(`${NEXT}/api/rankings/tenant/${tenantId}`);
  expect(read.status(), await read.text()).toBe(200);
  const press = await api.post(`${NEXT}/api/rankings/tenant/${tenantId}/rank`, { data: {} });
  expect(press.status(), await press.text()).toBe(202);
  await rankingTick(api);
  const jobRes = await api.get(`${NEXT}/api/rankings/tenant/${tenantId}/job`);
  expect(jobRes.status(), await jobRes.text()).toBe(200);
  expect(((await jobRes.json()) as { job: { status: string } | null }).job?.status).toBe('done');
  // The property page's fair-housing flag read is admin AND va (spec D10 rev 7).
  const flags = await api.get(`${NEXT}/api/rankings/unit/unit-0001/flags`);
  expect(flags.status(), await flags.text()).toBe(200);
  expect(await flags.json()).toEqual({ flags: [] });
});
