import { test, expect, type Page } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';

// Settings surface (:5174), Phase A — the rebuilt tabbed page (Team · Templates ·
// Notifications · System status). Proves the role-aware shell + the section flows
// end-to-end against the real backend:
//   - ADMIN: Team + System tabs visible; invite a user (appears); change a role;
//     edit a template field (persists across reload); a welcome-text edit is
//     reflected in a subsequent housing-fair welcome (asserted via the fake-twilio
//     thread store); the System status tab is reachable (Phase-A stub).
//   - VA: limited tab set (no Team/System); Templates inputs read-only.
// Served on :5174 (the suite baseURL); targeted by absolute URL for explicitness.
const NEXT = 'http://localhost:5174';

/** Dev-login as a specific persona (founder@example.com → admin per dev.ts) by
 *  driving the dev-login endpoint directly, then loading the app so the page picks
 *  up the freshly-set session cookie. */
async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test.describe('Settings — admin path', () => {
  test('admin sees Team + System, can invite/role/edit templates, and a welcome-text edit reflects in a housing-fair welcome', async ({
    page,
  }) => {
    await devLoginAs(page, 'founder@example.com');
    await page.goto(`${NEXT}/settings`);

    // /settings redirects an admin to the first visible tab (Team), and the full
    // admin tab set is present. (The redirect runs once the SPA hydrates + the
    // /auth/me probe resolves, so wait for the navigation rather than asserting
    // the URL synchronously.)
    await page.waitForURL(/\/settings\/team$/, { timeout: 15_000 });
    for (const label of ['Team', 'Templates', 'Notifications', 'System status']) {
      await expect(page.getByRole('tab', { name: label })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Team', level: 2 })).toBeVisible();

    // --- Invite a (unique) teammate → it appears in the roster ---
    const inviteEmail = `teammate-${Date.now()}@example.com`;
    await page.getByLabel('Email').fill(inviteEmail);
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(page.getByRole('status')).toContainText(/Invited/i);

    // The invited teammate appears in the roster — assert via the row's inline role
    // control (a per-row, uniquely-labeled element), which also drives the next step.
    const roleSelect = page.getByLabel(`Role for ${inviteEmail}`);
    await expect(roleSelect).toBeVisible();
    await expect(roleSelect).toHaveValue('va');

    // --- Change that teammate's role (va → admin) — the inline control reflects it ---
    await roleSelect.selectOption('admin');
    await expect(roleSelect).toHaveValue('admin');

    // --- Edit a template field; reload → it persists ---
    await page.getByRole('tab', { name: 'Templates' }).click();
    await expect(page).toHaveURL(/\/settings\/templates$/);
    const autoText = page.getByLabel(/^Missed-call auto-text/i);
    // A2P/CTIA template floor (spec §5): a first-contact template edit that drops
    // the opt-out line is rejected (400 missing_opt_out_language) → keep "Reply STOP".
    const newAutoText = `Sorry I missed you — e2e ${Date.now()}. Reply STOP to opt out.`;
    await autoText.fill(newAutoText);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel(/^Missed-call auto-text/i)).toHaveValue(newAutoText);

    // --- Welcome-text edit → reflected in a subsequent housing-fair welcome ---
    // Keep the opt-out line — the welcome is a first-contact template subject to the
    // A2P/CTIA floor (an override without "Reply STOP" is rejected 400).
    const welcomeBody = `Welcome {firstName}! e2e settings check ${Date.now()}. Reply STOP to opt out.`;
    await page.getByLabel(/Housing-fair welcome text/i).fill(welcomeBody);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    // Confirm the edit actually PERSISTED (via the API the public handler reads)
    // BEFORE signing up — the UI "Saved" badge can flip a tick before the write is
    // observable, so gate the signup on the server's own view to kill the race.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/settings`);
          return res.ok() ? ((await res.json()).settings?.welcomeText ?? null) : null;
        },
        { timeout: 10_000 },
      )
      .toBe(welcomeBody);

    // A fresh housing-fair signup must now welcome with the operator's copy. Use a
    // unique phone so the assertion is independent of any prior/other thread.
    const firstName = 'Welcometest';
    const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    const expectedWelcome = welcomeBody.replace('{firstName}', firstName);
    const submit = await page.request.post(`${NEXT}/public/housing-fair`, {
      data: { firstName, lastName: 'Person', phone, voucherSize: 2, smsConsent: true },
    });
    expect(submit.ok()).toBeTruthy();

    // PROOF OF SEND via the fake-twilio thread store (the preferred, more reliable
    // capture vs. the deprecated /__dev/outbox): the welcome lands as an outbound
    // message in this phone's thread with the operator's interpolated copy.
    await expect
      .poll(
        async () => {
          const threads = await listThreads(page.request);
          const t = threads.find((x) => x.partyNumber === phone);
          return t?.messages.some((m) => m.direction === 'outbound' && m.body === expectedWelcome) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // --- System status tab is reachable by an admin (Phase-B real section) ---
    // On the local/hermetic stack there is no AWS, so flags load (config only)
    // while the alarms + errors blocks degrade to the "Available in deployed
    // environments." notice.
    await page.getByRole('tab', { name: 'System status' }).click();
    await expect(page).toHaveURL(/\/settings\/system$/);
    await expect(page.getByRole('heading', { name: 'System status', level: 2 })).toBeVisible();
    // FlagPills always render (the go-live flags read straight from config) — the
    // Environment pill is present in every env.
    await expect(page.getByRole('heading', { name: 'Go-live flags', level: 3 })).toBeVisible();
    await expect(page.getByText('Environment', { exact: true })).toBeVisible();
    // The two A2P kill-switch pills are present (labels rendered as TEXT, not just
    // colour). On the hermetic mock stack SMS_SENDING_ENABLED=true and the relay
    // provisioning default is on (Twilio driver redirected at the fake host), so
    // they read "On" here; the off state ("Off · pre-A2P") is unit-tested in
    // FlagPills.test.tsx where the config can be driven directly.
    await expect(page.getByText('SMS sending', { exact: true })).toBeVisible();
    await expect(page.getByText('Relay provisioning', { exact: true })).toBeVisible();
    // The founder-cell + push readiness flags render too.
    await expect(page.getByText('Founder cell', { exact: true })).toBeVisible();
    await expect(page.getByText('Push notifications', { exact: true })).toBeVisible();
    // Alarms + Recent errors degrade gracefully on the local stack (no AWS).
    await expect(page.getByRole('heading', { name: 'Alarms', level: 3 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent errors', level: 3 })).toBeVisible();
    await expect(page.getByText('Available in deployed environments.')).toHaveCount(2);
    // The alarms block exposes a manual refresh affordance (the 60s-while-visible
    // auto-refresh is unit-tested); it's present even in the degraded state.
    await expect(page.getByRole('button', { name: 'Refresh alarms' })).toBeVisible();

    // --- Restore the welcome-text to a neutral copy that still interpolates
    // {firstName} so later specs (e.g. outbox.spec, which only checks the first
    // name appears) stay green. The form can't UNSET welcomeText (empty = "leave
    // default", never PUT), so we overwrite with a benign default-like string. ---
    await page.getByRole('tab', { name: 'Templates' }).click();
    // Keep "Reply STOP" so the A2P/CTIA floor accepts it; keep "thanks for stopping
    // by" so tenant-onboarding.spec's self-serve welcome assertion still matches.
    await page
      .getByLabel(/Housing-fair welcome text/i)
      .fill('Hi {firstName}, thanks for stopping by! Reply STOP to opt out.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
  });
});

test.describe('Settings — VA path', () => {
  test('a VA gets a limited tab set (no Team/System) and read-only Templates', async ({ page }) => {
    await devLoginAs(page, 'va@example.com');
    await page.goto(`${NEXT}/settings`);

    // /settings redirects a VA to Templates (the first tab they can see).
    await page.waitForURL(/\/settings\/templates$/, { timeout: 15_000 });

    // The limited tab set: Templates + Notifications only.
    await expect(page.getByRole('tab', { name: 'Templates' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Team' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'System status' })).toHaveCount(0);

    // Templates is read-only for a VA: the inputs are disabled and there's no Save.
    await expect(page.getByText(/Read-only — admins can edit/i)).toBeVisible();
    await expect(page.getByLabel(/^Missed-call auto-text/i)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // The admin-only Team route is GUARDED (not just hidden): a VA hitting it
    // directly is redirected back to Templates.
    await page.goto(`${NEXT}/settings/team`);
    await expect(page).toHaveURL(/\/settings\/templates$/);
  });
});
