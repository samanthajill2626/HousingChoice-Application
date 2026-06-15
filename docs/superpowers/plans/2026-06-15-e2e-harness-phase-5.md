# E2E Harness — Phase 5: Proving vertical slice (cross-UI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One end-to-end spec that proves the whole harness top to bottom across BOTH UIs: a tenant submits the public housing-fair form → the conversation appears in the staff dashboard inbox → a staff member opens the thread and replies → both the automated welcome and the staff reply are recorded in the dev outbox.

**Architecture:** A single Playwright spec drives the real public page (unauthenticated `page` fixture) and the real staff dashboard (authenticated `vaPage` fixture), then asserts the outbox via the `getOutbox` fixture. No backend changes: the R1 investigation confirmed local in-process job dispatch works AND the staff 1:1 reply is fully synchronous (awaits the messaging adapter in-request), so the flow needs no worker and no relay provisioning.

**Tech Stack:** Playwright (existing fixtures: `auth` → `page`/`vaPage`, `outbox` → `getOutbox`).

**Working directory:** worktree `w:/tmp/hc-e2e-worktree` on branch `e2e-testing-harness`. Do NOT switch branches or touch the main checkout. Commit on the current branch. **Docker must be running.**

---

## Spec reference

Implements **Phase 5** of `docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md` (§8/§11) and discharges risk **R1** (§10).

### R1 — RESOLVED (no fix needed)
Local in-process job dispatch DOES run: in hermetic local mode (`JOBS_QUEUE_URL` unset) the app wires an `InProcessOutboundQueueAdapter` and immediate jobs (`delaySeconds<=0`) dispatch **synchronously in the same request** (`app/src/adapters/scheduler.ts`), so even `relay.fanOut` runs locally. The chosen proving slice uses the **staff 1:1 reply**, which is synchronous regardless (`app/src/routes/api.ts` → `services/sendMessage.ts` awaits the adapter, then persists), so it needs neither the worker nor relay number provisioning. (The relay path is verified-capable but intentionally not the chosen slice — simpler, fewer prerequisites.)

## Facts this plan relies on (verified against the codebase)

- **Public intake form** (`dashboard/src/routes/HousingFair.tsx`, route `/housing-fair`, unauthenticated): fields are rendered via `<Field label="First name"|"Last name"|"Phone"|"Voucher size (optional)">` (label-associated inputs → `getByLabel`). Submit button text is **"Sign me up"**. On success it renders an h1 **"Thanks, we'll text you!"**. On submit it POSTs `/public/housing-fair`, which creates a `tenant_1to1` conversation (status `open`) and sends an automated welcome SMS synchronously; the welcome body contains the tenant's first name (proven by the Phase 3 outbox test).
- **Inbox** (`dashboard/src/routes/Inbox.tsx`, route `/`, authenticated): lists `status=open` conversations newest-first; no type filter hides `tenant_1to1`. Each row is a `NavLink` (`role=link`) to `/conversations/:id` whose visible content includes the **preview = the last message = the welcome text** (so it contains the tenant's first name). (`dashboard/src/routes/inbox/ConversationRow.tsx`.)
- **Thread reply** (`dashboard/src/routes/thread/SendBox.tsx`): a textarea with `aria-label="Message"` (and `Field label="Message"`) → `getByLabel('Message')`; the send control is a submit `<Button>` with text **"Send"** → `getByRole('button', { name: 'Send' })`. A manual staff send is always allowed (not gated by the circuit breaker); a fresh intake contact is not opted out. The sent message renders in the thread timeline.
- **Backend send** (`POST /api/conversations/:id/messages`): for a `tenant_1to1` it calls `sendMessage()` synchronously (awaits `adapter.sendMessage`, persists), sending to the tenant's `participant_phone`. With `MESSAGING_RECORD_OUTBOX=1` (set by the session launcher), both the welcome and the reply land in `hc-local-dev-outbox`, queryable via `GET /__dev/outbox?to=<phone>` (proxied through `:5173`; the `getOutbox` fixture uses it).
- **Fixtures available** (Phases 2–3): `e2e/fixtures/auth.ts` exports an extended `test` with `page` (unauthenticated) and `vaPage` (authenticated as seeded `va@example.com`); `e2e/fixtures/outbox.ts` exports `getOutbox(request, {to,since})`.
- No `data-testid` additions are required — role/label/text selectors suffice.

---

## File structure (what this phase creates)

- Create `e2e/tests/flows/intake-to-reply.spec.ts` — the cross-UI proving spec.
- Create `e2e/support/selectors.md` — the accessibility-first selector convention + the key selectors this harness relies on.

---

## Task 1: The cross-UI proving spec

**Files:** Create `e2e/tests/flows/intake-to-reply.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '../../fixtures/auth.js';
import { getOutbox } from '../../fixtures/outbox.js';

// Phase 5 cross-UI proving slice: a tenant submits the PUBLIC housing-fair form
// → the conversation appears in the STAFF dashboard inbox → a staff member opens
// the thread and replies → both the automated welcome and the staff reply are
// recorded in the dev outbox. Spans public UI + staff UI + API + outbox.
// Unique per-run name/phone so the test is independent of prior state.
test('public intake → staff inbox → staff reply → outbox', async ({ page, vaPage, request }) => {
  const stamp = `${Date.now()}`.slice(-7);
  const firstName = `Flowtest${stamp}`;
  const phone = `+1555${stamp}`;
  const reply = `A navigator will help you shortly. [ref ${stamp}]`;

  // 1) Tenant submits the public form (unauthenticated).
  await page.goto('/housing-fair');
  await page.getByLabel('First name').fill(firstName);
  await page.getByLabel('Last name').fill('Tester');
  await page.getByLabel('Phone').fill(phone);
  await page.getByRole('button', { name: 'Sign me up' }).click();
  await expect(page.getByText("Thanks, we'll text you!")).toBeVisible();

  // 2) Staff sees the new conversation in the inbox (the row's preview is the
  //    welcome text, which contains the tenant's first name).
  await vaPage.goto('/');
  const convo = vaPage.getByRole('link').filter({ hasText: firstName });
  await expect(convo.first()).toBeVisible();

  // 3) Open the thread and send a reply.
  await convo.first().click();
  await expect(vaPage).toHaveURL(/\/conversations\//);
  await vaPage.getByLabel('Message').fill(reply);
  await vaPage.getByRole('button', { name: 'Send' }).click();

  // 4) The reply renders in the thread.
  await expect(vaPage.getByText(reply)).toBeVisible();

  // 5) The outbox recorded BOTH the welcome (contains the first name) and the
  //    staff reply, to this tenant's phone.
  await expect
    .poll(async () => (await getOutbox(request, { to: phone })).map((m) => m.body ?? ''), {
      timeout: 10_000,
    })
    .toEqual(
      expect.arrayContaining([expect.stringContaining(firstName), reply]),
    );
});
```

FALLBACKS if a selector doesn't resolve (use only if needed, and note it):
- If `getByLabel('Phone')` is ambiguous/missing, use `page.getByPlaceholder('(555) 555-1234')`.
- If `getByLabel('First name')`/`'Last name'` fail (Field not label-associated), inspect `HousingFair.tsx`/the `Field` component and use the actual association (e.g. an `id`/placeholder). Do NOT add markup unless there is genuinely no usable selector.
- If clicking `convo.first()` doesn't navigate, click the inner preview text then assert the URL; if still flaky, navigate via the link's `href`.

- [ ] **Step 2: Run the full e2e suite — verify GREEN**

From the worktree root (Docker up): `npm run e2e`
Expected: setup + housing-fair smoke + 2 auth specs + outbox flow + the NEW intake-to-reply flow — all passing. The new flow drives both UIs and asserts the outbox.
(If a session is already running via `e2e:session`, Playwright reuses it; otherwise it boots the launcher, which sets `MESSAGING_RECORD_OUTBOX=1` so the outbox assertion works.)

- [ ] **Step 3: Typecheck**

`npm run typecheck -w @housingchoice/e2e` → clean.

- [ ] **Step 4: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add e2e/tests/flows/intake-to-reply.spec.ts
git -C w:/tmp/hc-e2e-worktree commit -m "test(e2e): cross-UI proving slice — public intake -> staff reply -> outbox

Drives the public housing-fair form and the staff dashboard end to end and
asserts both the automated welcome and the staff reply land in the dev outbox.
R1 (local job dispatch) resolved: the 1:1 reply path is synchronous.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Selector convention doc

**Files:** Create `e2e/support/selectors.md`

- [ ] **Step 1: Write `e2e/support/selectors.md`**

```markdown
# Selector conventions

Accessibility-first, in priority order. These double as the snapshot the
Playwright MCP reads, and they pressure the UI toward accessibility.

1. **`getByRole(role, { name })`** — buttons, links, headings, textboxes.
2. **`getByLabel(text)`** — form fields associated with a `<label>` / `Field`.
3. **`getByText(text)`** — visible copy / status messages.
4. **`getByPlaceholder(text)`** — only when no label exists.
5. **`data-testid`** — last resort, ONLY when none of the above can identify an
   element. None are needed today; add one (and note it here) if a future
   element is genuinely unaddressable.

## Key selectors this harness relies on
| Surface | Element | Selector |
|---------|---------|----------|
| Login | sign-in affordance | `getByText('Sign in with Google')` |
| Inbox | heading | `getByRole('heading', { name: 'Inbox' })` |
| Inbox | a conversation row | `getByRole('link').filter({ hasText: <preview/name> })` |
| Public form | fields | `getByLabel('First name'|'Last name'|'Phone')` |
| Public form | submit | `getByRole('button', { name: 'Sign me up' })` |
| Public form | success | `getByText("Thanks, we'll text you!")` |
| Thread | reply box | `getByLabel('Message')` |
| Thread | send | `getByRole('button', { name: 'Send' })` |

## Dev-only assertions (not UI)
- Outbox: `getOutbox(request, { to, since })` → `GET /__dev/outbox`.
- Reset: `reseed(request)` → `POST /__dev/reseed`.
- Stack identity: `GET /__dev/ping` → `{ dev: true }`.
```

- [ ] **Step 2: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add e2e/support/selectors.md
git -C w:/tmp/hc-e2e-worktree commit -m "docs(e2e): selector conventions + key-selector reference

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 exit gate (per spec §12)

1. **Build + test:** Tasks 1–2 complete.
2. **Verification gate (evidence required):** `npm run e2e` green including the new `intake-to-reply` flow; `npm run typecheck -w @housingchoice/e2e` clean. Capture the summary lines.
3. **Adversarial review:** fresh independent reviewer over the Phase 5 diff, off-the-leash, focusing on: is the flow a TRUE end-to-end proof (does it actually drive both UIs, or shortcut via API)? Determinism/flake (unique name/phone, the inbox-row selector matching the right row, the `expect.poll` window, reliance on the welcome preview containing the first name), correctness of the outbox assertion (both messages, right phone), and whether the test could pass for the wrong reason. Plus selector robustness.
4. **Done** only on green + clean review. Then Phase 6.

## Notes for Phase 6 (do NOT do now)

- The relay path (async `relay.fanOut`) is verified to run locally in-process; a dedicated relay e2e could be added later but is out of scope.
- Phase 6 documents CI: start DynamoDB Local, `reuseExistingServer` off in CI, integration tests skip without the DB, and the deferred Linux/CI teardown validation (§15).
