import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { APP_NUMBER, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

// The Follow up tab (spec 2026-10-12 section 8 (6), 5.6, 14.4): a listed send
// at least 24 hours quiet waits under its property on Matching's Follow up tab,
// longest-waiting first, with the tab's count, the deep link, and the same
// count as the Properties list's "<n> waiting" pill. A reply removes the row on
// the next load; Not interested resolves it in place and removes it on the next
// load. Sends are planted with the hermetic `/__dev/listing-send-fixture` seam
// (never wait on a clock) and an aged reply with `/__dev/extraction/message-fixture`.
//
// The lean world seeds NO listing_sends, so after the per-test reseed every
// waiting row is this test's own and the tab count is exact. (No afterAll
// reseed: a planted row is harmless to later specs - the Properties pill joins
// the row link's name and properties-available-view.spec.ts matches by regex.)

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DAY = 86_400_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** A consented, run-unique tenant (consent so a send reaches them). */
async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Followtest';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone, voucherSize },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} ${lastName}`, phone };
}

async function heardAt(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { last_heard_from_at?: string } }).contact.last_heard_from_at;
}

/** An Available 2-BR property; `tourType` set = the Interested ROUTE mode. */
async function createUnitViaApi(
  api: APIRequestContext,
  stamp: string,
  tourType?: 'self_guided' | 'landlord_led' | 'pm_team',
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp}${Math.floor(Math.random() * 90) + 10} Heardfrom Ave`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['Atlanta Housing Authority'],
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  if (tourType !== undefined) {
    const typed = await api.patch(`${NEXT}/api/units/${unitId}`, { data: { tour_type: tourType } });
    expect(typed.ok(), await typed.text()).toBeTruthy();
  }
  const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return { unitId, line1 };
}

/** A COUNTED, listed send with the given sentAt and NO broadcast behind it
 *  (S7's hermetic seam). */
async function plantListedSend(api: APIRequestContext, unitId: string, contactId: string, sentAt: string): Promise<void> {
  const res = await api.post(`${NEXT}/__dev/listing-send-fixture`, { data: { unitId, contactId, sentAt } });
  expect(res.status(), await res.text()).toBe(201);
}

/** A sentAt n days back, padded a minute so floor() cannot read n-1. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY - 60_000).toISOString();
}

interface FollowUpWire {
  items: Array<{ unitId: string; contactId: string; outcome: string; waitingSince: string }>;
  byUnit: Record<string, number>;
  truncated: boolean;
}

async function followUps(api: APIRequestContext): Promise<FollowUpWire> {
  const res = await api.get(`${NEXT}/api/broadcasts/follow-ups`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as FollowUpWire;
}

function followUpTab(page: Page): Locator {
  // The name is "Follow up <n>" only while a count shows (bare "Follow up" otherwise).
  return page.getByRole('tab', { name: /^Follow up\b/ });
}

/** A property group: a region named by its heading, `<unitLabel> - <n> waiting`
 *  (code review ORCH-1 added the separator) - so match a pattern that STARTS
 *  with the street line. */
function groupFor(page: Page, line1: string): Locator {
  return page.getByRole('region', { name: new RegExp(`^${escapeRegExp(line1)}`) });
}

function propertyRow(page: Page, line1: string): Locator {
  return page.getByRole('list', { name: 'Properties', exact: true }).getByRole('listitem').filter({ hasText: line1 });
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test.describe('Matching Follow up tab (spec 2026-10-12 5.6)', () => {
  test('a send quiet past 24 hours waits under its property, counted on the tab and the Properties list; a reply removes it', async ({
    page,
    request,
  }) => {
    test.slow();
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
    const quiet = await createTenant(api, `Quiet${stamp}`);
    const replied = await createTenant(api, `Repliedq${stamp}`);
    await plantListedSend(api, unitId, quiet.contactId, daysAgo(2));
    await plantListedSend(api, unitId, replied.contactId, daysAgo(5));

    // An AGED reply for `replied` (S1 Task 1.11 makes this seam touch).
    const conv = await api.post(`${NEXT}/api/contacts/${replied.contactId}/conversation`);
    expect(conv.ok(), await conv.text()).toBeTruthy();
    const conversationId = ((await conv.json()) as { conversation: { conversationId: string } }).conversation.conversationId;
    const heard = daysAgo(3);
    const fixture = await api.post(`${NEXT}/__dev/extraction/message-fixture`, {
      data: { conversationId, body: 'Is it still open?', createdAt: heard, direction: 'inbound' },
    });
    expect(fixture.ok(), await fixture.text()).toBeTruthy();
    await expect
      .poll(async () => Date.parse((await heardAt(api, replied.contactId)) ?? ''), { timeout: 20_000 })
      .toBe(Date.parse(heard));

    // API: both wait, longest-waiting first (replied since 3 days, quiet since 2).
    const fu = await followUps(api);
    expect(fu.byUnit[unitId]).toBe(2);
    expect(
      fu.items.filter((i) => i.unitId === unitId).map((i) => [i.contactId, i.outcome]),
    ).toEqual([
      [replied.contactId, 'replied'],
      [quiet.contactId, 'no_reply'],
    ]);

    // Deep link: the tab, its count, the group, the rows, both chips' wording.
    await page.goto(`${NEXT}/broadcasts?tab=follow-up`);
    await expect(followUpTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(followUpTab(page)).toHaveText(/^Follow up\s*2$/);
    const group = groupFor(page, line1);
    await expect(group).toContainText('2 waiting');
    const rows = group.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(replied.name);
    await expect(rows.nth(0).getByText('Replied, quiet 3 days', { exact: true })).toBeVisible();
    await expect(rows.nth(1)).toContainText(quiet.name);
    await expect(rows.nth(1).getByText('No reply yet, 2 days', { exact: true })).toBeVisible();
    await expect(rows.nth(1)).toContainText(/Last heard from\s*Never/);
    await expect(rows.nth(1).getByRole('link', { name: quiet.name })).toHaveAttribute(
      'href',
      `/contacts/${quiet.contactId}`,
    );
    await expect(
      rows.nth(1).getByRole('button', { name: new RegExp(`^Mark ${escapeRegExp(quiet.name)} not interested in `) }),
    ).toBeVisible();

    // A tab click writes the URL.
    await page.goto(`${NEXT}/broadcasts`);
    await followUpTab(page).click();
    await expect(page).toHaveURL(/[?&]tab=follow-up(&|$)/);

    // The Properties list (the Active tab defaults to Available) shows the same count.
    await page.goto(`${NEXT}/listings`);
    await expect(propertyRow(page, line1)).toContainText('2 waiting');

    // A reply moves max(sentAt, lastHeardFromAt) to now: `quiet` stops waiting.
    await registerParty(request, { label: quiet.name, role: 'tenant', number: quiet.phone });
    await sendAsParty(request, { from: quiet.phone, to: APP_NUMBER, body: `Yes ${quiet.firstName}` });
    await expect
      .poll(
        async () => {
          const next = await followUps(api);
          return !next.items.some((i) => i.contactId === quiet.contactId) && next.byUnit[unitId] === 1;
        },
        { timeout: 20_000, message: 'the reply never took quiet off the follow-up list' },
      )
      .toBe(true);

    // The tab never drops a row live (a row leaves on the NEXT LOAD), so load it fresh.
    await page.goto(`${NEXT}/broadcasts?tab=follow-up`);
    await expect(async () => {
      await page.reload();
      await expect(groupFor(page, line1)).toContainText('1 waiting', { timeout: 5_000 });
      await expect(groupFor(page, line1).getByRole('listitem')).toHaveCount(1, { timeout: 5_000 });
      await expect(groupFor(page, line1).getByRole('listitem').filter({ hasText: quiet.name })).toHaveCount(0);
      await expect(followUpTab(page)).toHaveText(/^Follow up\s*1$/, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await page.goto(`${NEXT}/listings`);
    await expect(propertyRow(page, line1)).toContainText('1 waiting');
  });

  test('Not interested on the Follow up tab removes the row', async ({ page }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
    const t = await createTenant(api, `Declineq${stamp}`);
    await plantListedSend(api, unitId, t.contactId, daysAgo(3));

    await page.goto(`${NEXT}/broadcasts?tab=follow-up`);
    const row = groupFor(page, line1).getByRole('listitem').filter({ hasText: t.name });
    await expect(row.getByText('No reply yet, 3 days', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: new RegExp(`^Mark ${escapeRegExp(t.name)} not interested in `) }).click();

    // In place, for the session: the row stays and shows its new state.
    await expect(row.getByRole('button', { name: /^Undo not interested for / })).toBeVisible();
    await expect(row.getByText('Not interested', { exact: true })).toBeVisible();

    // On the next load it is gone - and it was the only waiting row after the reseed.
    await page.reload();
    await expect(page.getByText('Nothing waiting on a reply.', { exact: true })).toBeVisible();
    await expect(groupFor(page, line1)).toHaveCount(0);

    // API: not_interested never waits.
    const fu = await followUps(api);
    expect(fu.items.some((i) => i.contactId === t.contactId)).toBe(false);
    expect(fu.byUnit[unitId]).toBeUndefined();
    const rec = await api.get(`${NEXT}/api/units/${unitId}/recipients`);
    expect(rec.ok(), await rec.text()).toBeTruthy();
    const recRows = ((await rec.json()) as { recipients: Array<{ contactId: string; outcome: string }> }).recipients;
    expect(recRows.find((r) => r.contactId === t.contactId)?.outcome).toBe('not_interested');

    await page.goto(`${NEXT}/listings`);
    await expect(propertyRow(page, line1)).toBeVisible();
    await expect(propertyRow(page, line1)).not.toContainText('waiting');
  });
});
