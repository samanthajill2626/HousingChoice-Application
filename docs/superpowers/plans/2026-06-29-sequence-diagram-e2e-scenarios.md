# Sequence-diagram → e2e scenario suite (tenant onboarding) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the tenant-onboarding sequence diagram into a runnable Playwright e2e
suite (one `test()` per alt-path), building the gaps it surfaces (structured intake
fields), and capture the repeatable method as a playbook.

**Architecture:** A new **step library** (`e2e/scenarios/steps.ts`) exposes a typed
"Team / Tenant / App" verb vocabulary that mirrors the diagram; verbs drive Team's
in-flow actions through the **real dashboard UI** and the tenant's inbound through the
**fake-twilio API seam** (`sendAsParty` for SMS, a new `fakeVoice` fixture for calls).
The scenario spec is a linear script of those verbs. A conformance audit against the
live `--mock --local` stack scopes the real gaps before the spec is written; the only
known build gap is first-class structured intake fields on the contact.

**Tech Stack:** TypeScript, Playwright (`@playwright/test`), Vitest (backend unit
tests), the existing hermetic e2e harness (`npm run e2e` / `e2e:session`), fake-twilio
(`/control/*` HTTP seam), React dashboard (`dashboard/`), Express app (`app/`).

## Global Constraints

- **Coordinator role is "Team", NEVER "Sam"** (the founder's name) in all test code,
  copy, and vocabulary. Verbs use the `team*` prefix; the backing identity is the
  seeded VA dev-login (`va@example.com`).
- **Isolation = self-clean + targeted reset.** Every scenario uses fresh, timestamped
  phone numbers / names so it creates its own contacts and never collides. NEVER call
  `/__dev/reseed` per-test (it wipes the users table and breaks the dev-login session).
  For any seeded entity a scenario must mutate, use an authenticated `page.request`
  targeted reset (the `devLoginAndReset` pattern in
  `e2e/tests/dashboard-next/placement-board.spec.ts:13-27`).
- **Fidelity: mostly-UI, API for setup.** Team's meaningful actions (reply, triage,
  record intake, set status) go through the **real dashboard UI**. The tenant's inbound
  (text/call) and pure setup/teardown use the API directly. Outbound proof-of-send is
  asserted via fake-twilio `listThreads` (`/control/threads`), never the deprecated
  `/__dev/outbox`.
- **Accessibility-first selectors** (`getByRole` / `getByLabel` / `getByText`) per
  `e2e/support/selectors.md`. `data-testid` is a last resort.
- **Triage, not New-contact, for inbound numbers.** An inbound from an unknown number
  auto-captures an UNKNOWN contact (locate by phone under the Inbox "Unknown" tab).
  Triage it → Tenant via "Mark as Tenant" / edit-type change. Do NOT use "New contact"
  for a number that already exists (it hits the proven 409). "New contact" is the
  housing-fair in-person path only (no prior number).
- **The RTA gate is a tenant-`status` move, not a flag and not a placement phase.**
  RTA-in-hand → tenant status `searching` (Send-Unit handoff); no-RTA → `on_hold`
  (parked). Driven through the dashboard Status select. (`porting`/RTA-flag gating was
  removed 2026-06-19; the Team advances status manually — `contactsRepo.ts:82-89`.)
- **Intake field shape (decided):** free-text strings `pets`, `evictions`, `tenure`
  (time at current address) + boolean `lifEligible`. First-class fields on the contact,
  NOT `customFields`.
- TDD throughout: failing test → run-red → minimal impl → run-green → commit. Commit
  messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- All work happens in the worktree `w:\tmp\hc-seq-e2e` on branch
  `feat/sequence-diagram-e2e-scenarios`. Never switch branches in the main checkout.

---

## File Structure

**New files:**
- `e2e/fixtures/fakeVoice.ts` — fixture wrapping fake-twilio `/control/place-call`,
  `/calls`, `/answer`, `/hangup`. The by-phone (voice) seam.
- `e2e/scenarios/steps.ts` — the Team/Tenant/App verb vocabulary + `step()` wrapper.
  The only new test infrastructure; the scenario spec is written purely in its verbs.
- `e2e/tests/scenarios/selfcheck.spec.ts` — proves `step()` + a verb passes and a
  deliberately-wrong assertion fails loudly.
- `e2e/tests/scenarios/tenant-onboarding.spec.ts` — one `test()` per alt-path.
- `app/test/contactIntakeFields.test.ts` — backend unit tests for the new intake fields.
- `documentation/sequence-diagram-to-test.md` — the playbook doc (written last).
- `docs/issues/<slug>.md` — one per real gap the audit surfaces (if any).

**Modified files:**
- `app/src/repos/contactsRepo.ts:56-122` — document the new optional intake fields on
  `ContactItem` (the doc is flexible; this is for type clarity).
- `app/src/routes/contacts.ts` — `parseTriageBody` (~219-350) and `parseCreateBody`
  (~368-469): accept + validate `pets`/`evictions`/`tenure`/`lifEligible`.
- `dashboard/src/api/types.ts:533-589` — add the four fields to `Contact` and
  `ContactPatch`.
- `dashboard/src/routes/contact/ContactEditForm.tsx` — state + render (tenant-only
  "Eligibility intake" fieldset after Housing authority) + `buildPatch` wiring.

---

## Phase A — Step framework + self-check (no app changes)

### Task 1: `fakeVoice` fixture

**Files:**
- Create: `e2e/fixtures/fakeVoice.ts`
- Reference (pattern to mirror): `e2e/fixtures/fakeTwilio.ts`
- Reference (control surface): `fake-twilio/src/routes/voiceControl.ts`

**Interfaces:**
- Consumes: Playwright `APIRequestContext`; env `FAKE_TWILIO_URL` (default
  `http://localhost:8889`).
- Produces:
  - `interface FakeCall { callSid: string; status: string; legs?: unknown }`
  - `placeCall(request, input: { from: string; to: string; scenario?: CallScenario }): Promise<string>` — returns `callSid`.
  - `type CallScenario = { answerLeg?: 'callee'|'founder'|'team'; digit?: '0'|'1'|null; outcome?: 'answered'|'no-answer'|'busy'; ringMs?: number; record?: boolean; transcript?: string }`
  - `listCalls(request): Promise<FakeCall[]>`
  - `answerLeg(request, sid, leg?): Promise<FakeCall>`
  - `hangup(request, sid): Promise<FakeCall>`
  - `tenantCallNoAnswer(request, input: { from: string; to: string }): Promise<string>` —
    the composed "tenant calls, founder bridge goes unanswered" helper used by the
    by-phone path. Returns `callSid`.

- [ ] **Step 1: Write the fixture**

```typescript
// e2e/fixtures/fakeVoice.ts
//
// Voice seam for scenario tests: wraps fake-twilio's voice CONTROL API
// (fake-twilio/src/routes/voiceControl.ts) the way fakeTwilio.ts wraps the SMS
// control API. Used by the by-phone tenant-onboarding path: the tenant places a
// call to the app's number; the app bridges to the founder; the founder does not
// answer; the app's missed-call auto-text fires.
import type { APIRequestContext } from '@playwright/test';

const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

export type CallScenario = {
  answerLeg?: 'callee' | 'founder' | 'team';
  digit?: '0' | '1' | null;
  outcome?: 'answered' | 'no-answer' | 'busy';
  ringMs?: number;
  record?: boolean;
  transcript?: string;
};

export interface FakeCall {
  callSid: string;
  status: string;
  [key: string]: unknown;
}

/** Place an inbound call from `from` to the app number `to`. Returns the callSid. */
export async function placeCall(
  request: APIRequestContext,
  input: { from: string; to: string; scenario?: CallScenario },
): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/place-call`, { data: input });
  if (!res.ok()) throw new Error(`place-call failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { callSid: string };
  return body.callSid;
}

export async function listCalls(request: APIRequestContext): Promise<FakeCall[]> {
  const res = await request.get(`${FAKE_BASE}/control/calls`);
  if (!res.ok()) throw new Error(`list calls failed: ${res.status()}`);
  return ((await res.json()) as { calls: FakeCall[] }).calls;
}

export async function answerLeg(
  request: APIRequestContext,
  sid: string,
  leg?: 'callee' | 'founder' | 'team',
): Promise<FakeCall> {
  const res = await request.post(`${FAKE_BASE}/control/calls/${sid}/answer`, {
    data: leg !== undefined ? { leg } : {},
  });
  if (!res.ok()) throw new Error(`answer failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { call: FakeCall }).call;
}

export async function hangup(request: APIRequestContext, sid: string): Promise<FakeCall> {
  const res = await request.post(`${FAKE_BASE}/control/calls/${sid}/hangup`, { data: {} });
  if (!res.ok()) throw new Error(`hangup failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { call: FakeCall }).call;
}

/**
 * The diagram's "Tenant phones in → Sam ignores → [AUTO] auto-reply text" move.
 * Places the inbound call with a no-answer scenario so the founder-bridge <Dial>
 * resolves missed, which is what triggers the app's missed-call auto-text job.
 * Returns the callSid.
 *
 * NOTE: whether `scenario: { outcome: 'no-answer' }` alone drives the bridge to a
 * terminal missed state on the LIVE (real-clock) e2e stack, or whether an explicit
 * `hangup(sid)` is also needed, is resolved by the Task 4 conformance audit; adjust
 * this helper to whichever the audit proves correct.
 */
export async function tenantCallNoAnswer(
  request: APIRequestContext,
  input: { from: string; to: string },
): Promise<string> {
  return placeCall(request, {
    from: input.from,
    to: input.to,
    scenario: { outcome: 'no-answer', ringMs: 1000 },
  });
}
```

- [ ] **Step 2: Type-check the fixture compiles**

Run: `cd /w/tmp/hc-seq-e2e && npx tsc -p e2e/tsconfig.json --noEmit`
Expected: PASS (no errors referencing `fakeVoice.ts`). If `e2e/tsconfig.json` does not
type-check standalone, instead run `npm run -w @housingchoice/e2e typecheck` if defined,
or `npx tsc --noEmit e2e/fixtures/fakeVoice.ts` as a smoke check.

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures/fakeVoice.ts
git commit -m "test(e2e): add fakeVoice fixture wrapping fake-twilio voice control"
```

> The behavioral proof of this fixture is the by-phone scenario (Task 11) and the
> self-check (Task 3); there is no isolated unit test because it is a thin HTTP wrapper
> that requires the live fake to exercise.

---

### Task 2: `steps.ts` — `step()` wrapper + Tenant/App/Team SMS-path vocabulary

This task builds every verb that works against EXISTING app behavior (the SMS path,
triage, reply, delivery asserts). The voice verb is added in Task 3; the intake/RTA
verbs are added in Task 9 after their UI exists.

**Files:**
- Create: `e2e/scenarios/steps.ts`
- Reference: `e2e/tests/dashboard-next/inbox-comms.spec.ts` (login + reply + listThreads
  proof), `e2e/fixtures/fakeTwilio.ts`.

**Interfaces:**
- Consumes: `sendAsParty`, `listThreads` from `../fixtures/fakeTwilio.js`; Playwright
  `Page`, `APIRequestContext`, `expect`, `test`.
- Produces:
  - `interface Tenant { phone: string; name: string }`
  - `function step<T>(name: string, fn: () => Promise<T>): Promise<T>`
  - `function freshTenant(label: string): Tenant` — timestamped phone (`+1555…`) + name.
  - `class Scenario` with constructor `(page: Page, request: APIRequestContext)` and the
    verbs below. `Scenario` tracks the **active tenant** and the **active contactId**
    (set during triage/create) so UI verbs act on the open contact.
  - SMS-path verbs produced here:
    `tenantTexts(t, body)`, `tenantAnswers(body)`,
    `expectRelayedToTeam(t, bodyRe)`, `expectUnknownCaptured(t)`,
    `teamReplies(body)`, `expectDeliveredToTenant(t, re)`,
    `teamTriagesUnknownToTenant(t, fields?)`, `teamCreatesContact(fields)`,
    `expectTypedTenant(t)`, `login()`.

- [ ] **Step 1: Write `steps.ts` (SMS-path verbs)**

```typescript
// e2e/scenarios/steps.ts
//
// The diagram vocabulary for sequence-diagram-driven e2e scenarios. Each verb maps
// 1:1 to an arrow/note in documentation/tenant-onboarding-sequence.mermaid. The
// coordinator role is "Team" (the seeded VA dev-login), NEVER the founder's name.
//
// Fidelity rule: Team's in-flow actions are driven through the REAL dashboard UI;
// the tenant's inbound and pure setup use the fake-twilio API seam. Outbound
// proof-of-send is asserted via fake-twilio listThreads (/control/threads).
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { sendAsParty, listThreads } from '../fixtures/fakeTwilio.js';

const NEXT = 'http://localhost:5174';
/** The app's own number (the number that owns the conversation). */
export const APP_NUMBER = '+15550000000';

export interface Tenant {
  phone: string;
  name: string;
}

/** Thin wrapper over Playwright's test.step so a scenario reads as the diagram. */
export function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return test.step(name, fn);
}

/** A fresh tenant with a per-run-unique phone + name (self-clean isolation). */
let seq = 0;
export function freshTenant(label: string): Tenant {
  const stamp = `${Date.now()}`.slice(-7);
  seq += 1;
  // A valid-looking E.164 that won't collide with seeded numbers (+1555010xxxx).
  const phone = `+1555${stamp}${seq}`.slice(0, 12);
  return { phone, name: `${label} ${stamp}-${seq}` };
}

export class Scenario {
  private activeContactId: string | null = null;
  private activeTenant: Tenant | null = null;

  constructor(
    private readonly page: Page,
    private readonly request: APIRequestContext,
  ) {}

  /** Team signs in to the dashboard (seeded VA dev-login). */
  login(): Promise<void> {
    return step('Team signs in to the dashboard', async () => {
      await this.page.goto(`${NEXT}/`);
      await this.page.getByRole('button', { name: /Continue as dev user/i }).click();
      await expect(this.page.getByRole('heading', { name: 'Today' })).toBeVisible();
    });
  }

  /** [Tenant→App] Inbound SMS from the tenant (API seam). Sets the active tenant. */
  tenantTexts(t: Tenant, body: string): Promise<void> {
    return step(`Tenant texts: "${body}"`, async () => {
      this.activeTenant = t;
      await sendAsParty(this.request, { from: t.phone, to: APP_NUMBER, body });
    });
  }

  /** [Tenant→App] A follow-up inbound from the already-active tenant. */
  tenantAnswers(body: string): Promise<void> {
    const t = this.requireActiveTenant();
    return step(`Tenant replies: "${body}"`, async () => {
      await sendAsParty(this.request, { from: t.phone, to: APP_NUMBER, body });
    });
  }

  /**
   * [App→Team] The inbound surfaced in the Inbox. An untriaged unknown is nameless,
   * so we locate it by phone under the "Unknown" tab (NOT by name). Opens the row so
   * subsequent Team UI verbs act on this contact, and records its contactId.
   */
  expectRelayedToTeam(t: Tenant, bodyRe: RegExp): Promise<void> {
    return step(`App relays the lead to Team (Unknown tab, by phone)`, async () => {
      await this.page.goto(`${NEXT}/contacts/unknown`);
      const row = this.page.getByRole('link').filter({ hasText: t.phone });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.first().click();
      await expect(this.page).toHaveURL(/\/contacts\//, { timeout: 10_000 });
      await expect(this.page.getByText(bodyRe)).toBeVisible({ timeout: 10_000 });
      this.activeContactId = await this.readActiveContactId();
      this.activeTenant = t;
    });
  }

  /** [App] An inbound from an unrecognized number auto-created an UNKNOWN contact. */
  expectUnknownCaptured(t: Tenant): Promise<void> {
    return step('App auto-captured an unknown contact', async () => {
      await this.page.goto(`${NEXT}/contacts/unknown`);
      await expect(
        this.page.getByRole('link').filter({ hasText: t.phone }),
      ).toBeVisible({ timeout: 15_000 });
    });
  }

  /** [Team→App] Team replies from the open contact thread (real UI). */
  teamReplies(body: string): Promise<void> {
    return step(`Team replies: "${body}"`, async () => {
      await this.page.getByRole('textbox', { name: 'Reply message' }).fill(body);
      await this.page.getByRole('button', { name: 'Send' }).click();
      await expect(this.page.getByText(body)).toBeVisible();
    });
  }

  /** [App→Tenant] The outbound reached the tenant's fake thread and was delivered. */
  expectDeliveredToTenant(t: Tenant, re: RegExp): Promise<void> {
    return step(`App delivers to Tenant (proof-of-send)`, async () => {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(this.request);
            const thread = threads.find((x) => x.partyNumber === t.phone);
            return (
              thread?.messages.some(
                (m) => m.direction === 'outbound' && re.test(m.body ?? '') && m.state === 'delivered',
              ) ?? false
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    });
  }

  /**
   * [Team] Triage the captured unknown → Tenant via the contact page (Mark as Tenant).
   * NOT "New contact" — the number already exists (that path 409s). Optionally set
   * identity fields (name, voucher, housing authority) via the edit form afterward.
   */
  teamTriagesUnknownToTenant(
    t: Tenant,
    fields?: { firstName?: string; lastName?: string; voucherSize?: number; housingAuthority?: string },
  ): Promise<void> {
    return step('Team triages the unknown → Tenant', async () => {
      await this.openActiveContact(t);
      await this.page.getByRole('button', { name: /Mark as Tenant/i }).click();
      // The triage flips type → tenant; the page re-renders as a tenant contact.
      await expect(this.page.getByText(/Tenant/).first()).toBeVisible({ timeout: 10_000 });
      if (fields) await this.editTenantIdentity(t, fields);
    });
  }

  /**
   * [Team] Housing-fair in-person path ONLY: create a brand-new Tenant via the
   * New-contact dialog (no prior number). Sets the active contact.
   */
  teamCreatesContact(fields: {
    firstName: string;
    lastName: string;
    voucherSize?: number;
    housingAuthority?: string;
    phone?: string;
  }): Promise<void> {
    return step('Team creates a new Tenant contact (housing fair)', async () => {
      await this.page.goto(`${NEXT}/contacts`);
      await this.page.getByRole('button', { name: /New contact/i }).click();
      await this.page.getByRole('textbox', { name: 'First name' }).fill(fields.firstName);
      await this.page.getByRole('textbox', { name: 'Last name' }).fill(fields.lastName);
      // Choose the Tenant type in the create dialog (exact control confirmed by audit).
      await this.page.getByRole('button', { name: /Tenant/i }).first().click();
      if (fields.phone) {
        await this.page.getByRole('textbox', { name: /Phone/i }).fill(fields.phone);
      }
      await this.page.getByRole('button', { name: /^Create|Save|Add contact$/ }).first().click();
      await expect(this.page).toHaveURL(/\/contacts\//, { timeout: 10_000 });
      this.activeContactId = await this.readActiveContactId();
      this.activeTenant = {
        phone: fields.phone ?? '',
        name: `${fields.firstName} ${fields.lastName}`,
      };
      if (fields.voucherSize !== undefined || fields.housingAuthority !== undefined) {
        await this.editTenantIdentity(this.activeTenant, {
          voucherSize: fields.voucherSize,
          housingAuthority: fields.housingAuthority,
        });
      }
    });
  }

  /** [App] The contact is now typed Tenant (assert via API on the open contact). */
  expectTypedTenant(t: Tenant): Promise<void> {
    return step('App: contact is typed Tenant', async () => {
      const id = this.requireActiveContactId();
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: { type: string } };
      expect(contact.type).toBe('tenant');
    });
  }

  // ---- internal helpers ---------------------------------------------------

  private requireActiveTenant(): Tenant {
    if (!this.activeTenant) throw new Error('no active tenant — call tenantTexts/expectRelayedToTeam first');
    return this.activeTenant;
  }

  private requireActiveContactId(): string {
    if (!this.activeContactId) throw new Error('no active contact — triage/create one first');
    return this.activeContactId;
  }

  /** The current contact page URL ends in /contacts/<id>; pull the id from it. */
  private async readActiveContactId(): Promise<string> {
    const url = this.page.url();
    const m = /\/contacts\/([^/?#]+)/.exec(url);
    if (!m || m[1] === 'unknown') {
      // On the unknown landing the id is not in the URL; read it from the API by phone.
      const t = this.requireActiveTenant();
      const res = await this.page.request.get(
        `${NEXT}/api/contacts?type=unknown`,
      );
      const { contacts } = (await res.json()) as { contacts: Array<{ contactId: string; phone?: string }> };
      const hit = contacts.find((c) => c.phone === t.phone);
      if (!hit) throw new Error(`could not resolve contactId for ${t.phone}`);
      return hit.contactId;
    }
    return m[1];
  }

  private async openActiveContact(t: Tenant): Promise<void> {
    if (this.activeContactId) {
      await this.page.goto(`${NEXT}/contacts/${this.activeContactId}`);
      return;
    }
    await this.page.goto(`${NEXT}/contacts/unknown`);
    await this.page.getByRole('link').filter({ hasText: t.phone }).first().click();
    await expect(this.page).toHaveURL(/\/contacts\//);
    this.activeContactId = await this.readActiveContactId();
  }

  /** Open the edit form, set identity fields, save. (Intake/RTA verbs added in Task 9.) */
  private async editTenantIdentity(
    _t: Tenant,
    fields: { firstName?: string; lastName?: string; voucherSize?: number; housingAuthority?: string },
  ): Promise<void> {
    await this.page.getByRole('button', { name: /^Edit$/ }).click();
    if (fields.firstName !== undefined)
      await this.page.getByRole('textbox', { name: 'First name' }).fill(fields.firstName);
    if (fields.lastName !== undefined)
      await this.page.getByRole('textbox', { name: 'Last name' }).fill(fields.lastName);
    if (fields.voucherSize !== undefined)
      await this.page.getByRole('spinbutton', { name: /Voucher size/i }).fill(String(fields.voucherSize));
    if (fields.housingAuthority !== undefined)
      await this.page.getByRole('textbox', { name: 'Housing authority' }).fill(fields.housingAuthority);
    await this.page.getByRole('button', { name: 'Save' }).click();
    await expect(this.page.getByRole('button', { name: 'Save' })).toBeHidden({ timeout: 10_000 });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd /w/tmp/hc-seq-e2e && npx tsc -p e2e/tsconfig.json --noEmit` (or the e2e
typecheck script). Expected: PASS.

> Selector exactness (the `New contact` dialog controls, the `Edit`/`Mark as Tenant`
> button names, the `/api/contacts?type=unknown` list contract) is VERIFIED against the
> live UI in the Task 4 audit and corrected there before any scenario relies on them.

- [ ] **Step 3: Commit**

```bash
git add e2e/scenarios/steps.ts
git commit -m "test(e2e): add step() wrapper + Team/Tenant/App SMS-path vocabulary"
```

---

### Task 3: Voice verbs on `Scenario` (`tenantCalls`, `expectAutoReply`)

**Files:**
- Modify: `e2e/scenarios/steps.ts`
- Consumes: `tenantCallNoAnswer` from `../fixtures/fakeVoice.js`.

**Interfaces:**
- Produces on `Scenario`:
  - `tenantCalls(t: Tenant): Promise<void>` — places an inbound call that goes
    unanswered (sets the active tenant).
  - `expectAutoReply(re: RegExp): Promise<void>` — the missed-call auto-text fired with
    NO Team action; asserts the operator-template body on the tenant's fake thread.

- [ ] **Step 1: Add the import and verbs**

Add to the imports at the top of `steps.ts`:

```typescript
import { tenantCallNoAnswer } from '../fixtures/fakeVoice.js';
```

Add these methods to the `Scenario` class (after `tenantAnswers`):

```typescript
  /** [Tenant→App] Inbound voice call that the founder bridge leaves unanswered. */
  tenantCalls(t: Tenant): Promise<void> {
    return step('Tenant phones in (no answer)', async () => {
      this.activeTenant = t;
      await tenantCallNoAnswer(this.request, { from: t.phone, to: APP_NUMBER });
    });
  }

  /**
   * [App→Tenant] The missed-call auto-text fired automatically (no Team action).
   * Asserts the operator-template body reached the tenant's fake thread, delivered.
   */
  expectAutoReply(re: RegExp): Promise<void> {
    const t = this.requireActiveTenant();
    return step('App auto-replies to the missed call', async () => {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(this.request);
            const thread = threads.find((x) => x.partyNumber === t.phone);
            return (
              thread?.messages.some(
                (m) => m.direction === 'outbound' && re.test(m.body ?? ''),
              ) ?? false
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    });
  }
```

- [ ] **Step 2: Type-check** — same command as Task 2. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/scenarios/steps.ts
git commit -m "test(e2e): add voice verbs (tenantCalls, expectAutoReply) to Scenario"
```

---

### Task 4: Conformance audit (live stack) → scoped gap list

This is an investigation task, not TDD. Its only deliverable is a **scoped gap list**
and (a) corrected selectors/contracts baked into `steps.ts`, plus (b) a registry issue
per real gap. Drive the live stack with the Playwright MCP browser + authenticated
requests; do NOT write the scenario spec yet.

- [ ] **Step 1: Boot the interactive stack**

Run (in the worktree): `npm run e2e:session` (wait for `ready`). Keep it running.

- [ ] **Step 2: Walk each diagram step and record evidence**

Using the Playwright MCP browser (dev-login first) and `curl`/`page.request`, confirm
or refute each item. Record findings in a scratch notes file
(`<scratchpad>/audit-notes.md`):

1. **Unknown auto-capture + Unknown tab.** Send an inbound from a fresh number
   (`POST :8889/control/send-as-party`). Confirm an UNKNOWN contact appears under
   `/contacts/unknown` and is locatable BY PHONE. Capture the exact row markup the
   selector must match, and the `GET /api/contacts?type=unknown` response shape (the
   field that holds the phone) — fix `readActiveContactId`/`expectUnknownCaptured` to
   match.
2. **Relay surface.** Confirm the inbound body is visible on the opened contact page
   (timeline). Note the contact-page URL pattern (`/contacts/<id>`).
3. **Reply round-trip.** Confirm `getByRole('textbox', { name: 'Reply message' })` +
   `Send` exist on the contact page and that the outbound shows `delivered` in
   `/control/threads`.
4. **Triage → Tenant.** Confirm the `Mark as Tenant` control exists on an unknown
   contact and that after triage the contact type is `tenant` (GET the contact). Fix
   the button name/selector if different.
5. **Edit form identity fields.** Confirm the `Edit` button, and the `First name` /
   `Last name` / `Voucher size` / `Housing authority` labels match the selectors.
6. **New-contact dialog (housing-fair).** Open `New contact`, confirm the exact control
   names for first/last/type-choice/phone/submit; fix `teamCreatesContact`.
7. **Missed-call auto-text fires.** Place a no-answer call via `fakeVoice`
   (`tenantCallNoAnswer`). Confirm an outbound auto-text appears in `/control/threads`
   for that number. RECORD THE EXACT BODY (compare to the default
   `"Sorry I missed you — I'll call back soon; you can also text me here."` from
   `settingsRepo.ts:52`). Determine whether the call needs an explicit `hangup` to reach
   terminal-missed on the real clock, or whether `{ outcome: 'no-answer', ringMs }`
   suffices — and fix `tenantCallNoAnswer` accordingly. CONFIRM whether the
   `missedCallAutoTextEnabled` default (`true`) means NO settings seed is required.
8. **RTA gate.** Confirm the dashboard Status select (edit form) offers `Searching` and
   `On hold` for a tenant, and that selecting them persists (GET the contact → `status`
   `searching` / `on_hold`).
9. **Self-serve portal.** Determine whether a public self-serve intake portal exists at
   all (memory says public pages are stubbed). If it does not exist, this is a LARGE
   gap — see Step 4.

- [ ] **Step 3: Apply selector/contract corrections to `steps.ts` and `fakeVoice.ts`**

Edit the two files so every verb matches the live UI/contracts observed in Step 2.
Commit:

```bash
git add e2e/scenarios/steps.ts e2e/fixtures/fakeVoice.ts
git commit -m "test(e2e): align step vocabulary with audited live selectors/contracts"
```

- [ ] **Step 4: File registry issues for real gaps + decide portal scope**

For each confirmed gap, copy `docs/issues/_TEMPLATE.md` to
`docs/issues/<slug>.md` with frontmatter (`type`/`severity`/`status: open`) and prose.
Expected known gap: **structured intake fields** (built in Phase B). Likely additional
gap: **self-serve intake portal** does not exist.

**Portal decision rule:** if the self-serve portal is a large greenfield build (a new
public page + unauthenticated submission route + contact-from-submission [AUTO] path),
do NOT silently build it under this branch. File the issue, and **STOP to confirm scope
with the human** (this plan's scenario set drops to four paths until the portal exists;
the portal becomes its own spec/plan). The other four leaf paths (by-text, by-phone,
housing-fair Team-enters-details, × RTA branches) do not depend on it.

- [ ] **Step 5: Write the gap list into the plan's tracking + commit issues**

```bash
git add docs/issues/
git commit -m "docs(issues): file gaps from tenant-onboarding conformance audit"
```

---

## Phase B — Structured intake fields (TDD)

### Task 5: Backend — accept + validate `pets`/`evictions`/`tenure`/`lifEligible`

**Files:**
- Modify: `app/src/routes/contacts.ts` (`parseTriageBody` ~219-350; `parseCreateBody`
  ~368-469)
- Modify: `app/src/repos/contactsRepo.ts:56-122` (document the fields on `ContactItem`)
- Test: `app/test/contactIntakeFields.test.ts`

**Interfaces:**
- Produces: the `PATCH /api/contacts/:id` and `POST /api/contacts` routes accept
  `pets?: string`, `evictions?: string`, `tenure?: string`, `lifEligible?: boolean`,
  validate types (strings must be strings; boolean must be boolean), and persist them
  on the contact document. They are returned on `GET /api/contacts/:id`.

- [ ] **Step 1: Write the failing test**

```typescript
// app/test/contactIntakeFields.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeTestApp } from './helpers/testApp.js'; // mirror the helper used by other
                                                     // contacts route tests — confirm
                                                     // its real name/path in app/test.

describe('contact intake fields (pets/evictions/tenure/lifEligible)', () => {
  it('PATCH persists intake fields and GET returns them', async () => {
    const app = await makeTestApp();
    // Create an unknown contact to triage/patch.
    const created = await request(app)
      .post('/api/contacts')
      .send({ type: 'tenant', firstName: 'Pat', lastName: 'Q' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .send({ pets: '1 cat', evictions: 'none', tenure: '3 years', lifEligible: true })
      .expect(200);

    const got = await request(app).get(`/api/contacts/${id}`).expect(200);
    expect(got.body.contact.pets).toBe('1 cat');
    expect(got.body.contact.evictions).toBe('none');
    expect(got.body.contact.tenure).toBe('3 years');
    expect(got.body.contact.lifEligible).toBe(true);
  });

  it('rejects a non-string pets and a non-boolean lifEligible', async () => {
    const app = await makeTestApp();
    const created = await request(app)
      .post('/api/contacts')
      .send({ type: 'tenant', firstName: 'Pat', lastName: 'Q' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app).patch(`/api/contacts/${id}`).send({ pets: 5 }).expect(400);
    await request(app).patch(`/api/contacts/${id}`).send({ lifEligible: 'yes' }).expect(400);
  });

  it('POST create accepts intake fields', async () => {
    const app = await makeTestApp();
    const created = await request(app)
      .post('/api/contacts')
      .send({ type: 'tenant', firstName: 'Lee', lastName: 'M', pets: 'none', lifEligible: false })
      .expect(201);
    expect(created.body.contact.pets).toBe('none');
    expect(created.body.contact.lifEligible).toBe(false);
  });
});
```

> Before running: confirm the test-app helper's real name/path by reading an existing
> contacts route test (e.g. `app/test/contacts*.test.ts`) and matching its bootstrap
> exactly (status codes for create — 200 vs 201 — included).

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd /w/tmp/hc-seq-e2e && npm run -w app test -- contactIntakeFields`
Expected: FAIL (`pets` etc. are `undefined` on GET; the 400 cases return 200).

- [ ] **Step 3: Add the validators to `parseTriageBody`**

Insert after the `customFields` block (`contacts.ts` ~344, before the
`changedFields.length === 0` guard):

```typescript
  // Structured intake fields (free-text + a boolean LIF flag). First-class fields,
  // not customFields, so eligibility is reportable/filterable later.
  for (const key of ['pets', 'evictions', 'tenure'] as const) {
    if (key in b) {
      const v = b[key];
      if (typeof v !== 'string') return { error: `${key} must be a string` };
      patch[key] = v;
      changedFields.push(key);
    }
  }
  if ('lifEligible' in b) {
    const v = b['lifEligible'];
    if (typeof v !== 'boolean') return { error: 'lifEligible must be a boolean' };
    patch['lifEligible'] = v;
    changedFields.push('lifEligible');
  }
```

- [ ] **Step 4: Add the validators to `parseCreateBody`**

Insert after the `customFields` block (`contacts.ts` ~449, before the status-default
comment):

```typescript
  for (const key of ['pets', 'evictions', 'tenure'] as const) {
    if (key in b) {
      if (typeof b[key] !== 'string') return { error: `${key} must be a string` };
      (item as Record<string, unknown>)[key] = b[key];
    }
  }
  if ('lifEligible' in b) {
    if (typeof b['lifEligible'] !== 'boolean') return { error: 'lifEligible must be a boolean' };
    (item as Record<string, unknown>)['lifEligible'] = b['lifEligible'];
  }
```

- [ ] **Step 5: Document the fields on `ContactItem`**

In `app/src/repos/contactsRepo.ts`, after `phone_ref_owner?: string;` (line 121, before
the `[key: string]: unknown;` index signature) add:

```typescript
  /**
   * Eligibility intake (tenant onboarding). Free-text answers to the narrow LIF
   * questions, plus a boolean LIF-eligibility flag. First-class fields (not
   * customFields) so eligibility is reportable/filterable later.
   */
  pets?: string;
  evictions?: string;
  /** Time at current address (free text, e.g. "3 years"). */
  tenure?: string;
  lifEligible?: boolean;
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `cd /w/tmp/hc-seq-e2e && npm run -w app test -- contactIntakeFields`
Expected: PASS (all three tests).

- [ ] **Step 7: Run the broader contacts route suite (no regressions)**

Run: `cd /w/tmp/hc-seq-e2e && npm run -w app test -- contacts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/src/routes/contacts.ts app/src/repos/contactsRepo.ts app/test/contactIntakeFields.test.ts
git commit -m "feat(contacts): structured intake fields (pets/evictions/tenure/lifEligible)"
```

---

### Task 6: Dashboard — intake fields in `Contact`/`ContactPatch` + edit-form UI

**Files:**
- Modify: `dashboard/src/api/types.ts:533-589`
- Modify: `dashboard/src/routes/contact/ContactEditForm.tsx`

**Interfaces:**
- Consumes: the backend fields from Task 5.
- Produces: a tenant-only "Eligibility intake" fieldset in the edit form with labelled
  controls — `Pets` (text), `Evictions` (text), `Time at current address` (text),
  `LIF eligible` (checkbox) — wired into `buildPatch` so only changed fields PATCH.

- [ ] **Step 1: Add the fields to the dashboard types**

In `dashboard/src/api/types.ts`, in `interface Contact` (after `housingAuthority?`,
~line 557) add:

```typescript
  /** Eligibility intake (free-text answers + a boolean LIF flag). */
  pets?: string;
  evictions?: string;
  tenure?: string;
  lifEligible?: boolean;
```

In `interface ContactPatch` (after `housingAuthority?`, ~line 580) add:

```typescript
  pets?: string;
  evictions?: string;
  tenure?: string;
  lifEligible?: boolean;
```

- [ ] **Step 2: Add form state in `ContactEditForm.tsx`**

After the `housingAuthority` state (~line 127) add:

```typescript
  const [pets, setPets] = useState(str(contact['pets']));
  const [evictions, setEvictions] = useState(str(contact['evictions']));
  const [tenure, setTenure] = useState(str(contact['tenure']));
  const [lifEligible, setLifEligible] = useState(contact['lifEligible'] === true);
```

- [ ] **Step 3: Wire `buildPatch`**

Inside `buildPatch`, within the `if (isTenant) { … }` block (after the
`housingAuthority` line ~223) add:

```typescript
      if (pets !== str(contact['pets'])) patch.pets = pets;
      if (evictions !== str(contact['evictions'])) patch.evictions = evictions;
      if (tenure !== str(contact['tenure'])) patch.tenure = tenure;
      if (lifEligible !== (contact['lifEligible'] === true)) patch.lifEligible = lifEligible;
```

- [ ] **Step 4: Render the fieldset**

After the Housing-authority `label` block (~line 386, before the `Current address`
fieldset) add:

```tsx
        {isTenant ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Eligibility intake</span>
            <label className={styles.field}>
              <span className={styles.label}>Pets</span>
              <input
                className={styles.input}
                value={pets}
                onChange={(e) => setPets(e.target.value)}
                placeholder="e.g. 1 cat"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Evictions</span>
              <input
                className={styles.input}
                value={evictions}
                onChange={(e) => setEvictions(e.target.value)}
                placeholder="e.g. none"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Time at current address</span>
              <input
                className={styles.input}
                value={tenure}
                onChange={(e) => setTenure(e.target.value)}
                placeholder="e.g. 3 years"
                autoComplete="off"
              />
            </label>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={lifEligible}
                onChange={(e) => setLifEligible(e.target.checked)}
              />
              <span className={styles.label}>LIF eligible</span>
            </label>
          </div>
        ) : null}
```

- [ ] **Step 5: Type-check + build the dashboard**

Run: `cd /w/tmp/hc-seq-e2e && npm run -w dashboard build` (or the dashboard typecheck
script). Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/contact/ContactEditForm.tsx
git commit -m "feat(dashboard): edit-form Eligibility intake fields (tenant)"
```

---

### Task 7: Intake + RTA verbs on `Scenario`

**Files:**
- Modify: `e2e/scenarios/steps.ts`

**Interfaces:**
- Produces on `Scenario`:
  - `teamRecordsIntake(i: { pets?: string; evictions?: string; tenure?: string; lifEligible?: boolean }): Promise<void>`
  - `expectIntakeRecorded(i): Promise<void>` — assert the fields via GET on the active
    contact.
  - `teamRecordsRtaDecision(inHand: boolean): Promise<void>` — sets tenant status via the
    edit-form Status select (`searching` when inHand, `on_hold` when not).
  - `expectHandoffToSendUnit(): Promise<void>` — active contact status `searching`.
  - `expectParked(): Promise<void>` — active contact status `on_hold`.

- [ ] **Step 1: Add the verbs**

Add these methods to the `Scenario` class:

```typescript
  /** [Team] Record the eligibility intake answers via the edit form (real UI). */
  teamRecordsIntake(i: {
    pets?: string;
    evictions?: string;
    tenure?: string;
    lifEligible?: boolean;
  }): Promise<void> {
    return step('Team records eligibility intake', async () => {
      await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
      await this.page.getByRole('button', { name: /^Edit$/ }).click();
      if (i.pets !== undefined) await this.page.getByRole('textbox', { name: 'Pets' }).fill(i.pets);
      if (i.evictions !== undefined)
        await this.page.getByRole('textbox', { name: 'Evictions' }).fill(i.evictions);
      if (i.tenure !== undefined)
        await this.page.getByRole('textbox', { name: 'Time at current address' }).fill(i.tenure);
      if (i.lifEligible === true)
        await this.page.getByRole('checkbox', { name: 'LIF eligible' }).check();
      await this.page.getByRole('button', { name: 'Save' }).click();
      await expect(this.page.getByRole('button', { name: 'Save' })).toBeHidden({ timeout: 10_000 });
    });
  }

  /** [App] The intake answers persisted on the contact. */
  expectIntakeRecorded(i: {
    pets?: string;
    evictions?: string;
    tenure?: string;
    lifEligible?: boolean;
  }): Promise<void> {
    return step('App: intake answers stored', async () => {
      const res = await this.page.request.get(`${NEXT}/api/contacts/${this.requireActiveContactId()}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: Record<string, unknown> };
      if (i.pets !== undefined) expect(contact['pets']).toBe(i.pets);
      if (i.evictions !== undefined) expect(contact['evictions']).toBe(i.evictions);
      if (i.tenure !== undefined) expect(contact['tenure']).toBe(i.tenure);
      if (i.lifEligible !== undefined) expect(contact['lifEligible']).toBe(i.lifEligible);
    });
  }

  /**
   * [Team] The RTA gate — a tenant-STATUS move via the edit-form Status select.
   * RTA in hand → 'searching' (Send-Unit handoff); no RTA → 'on_hold' (parked).
   */
  teamRecordsRtaDecision(inHand: boolean): Promise<void> {
    const label = inHand ? 'Searching' : 'On hold';
    return step(`Team records RTA decision → ${label}`, async () => {
      await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
      await this.page.getByRole('button', { name: /^Edit$/ }).click();
      await this.page.getByRole('combobox', { name: 'Status' }).selectOption({ label });
      await this.page.getByRole('button', { name: 'Save' }).click();
      await expect(this.page.getByRole('button', { name: 'Save' })).toBeHidden({ timeout: 10_000 });
    });
  }

  expectHandoffToSendUnit(): Promise<void> {
    return step('App: tenant ready for Send-Unit (searching)', () => this.assertStatus('searching'));
  }

  expectParked(): Promise<void> {
    return step('App: tenant parked (on_hold)', () => this.assertStatus('on_hold'));
  }

  private async assertStatus(expected: string): Promise<void> {
    const res = await this.page.request.get(`${NEXT}/api/contacts/${this.requireActiveContactId()}`);
    expect(res.ok()).toBeTruthy();
    const { contact } = (await res.json()) as { contact: { status?: string } };
    expect(contact.status).toBe(expected);
  }
```

- [ ] **Step 2: Type-check** — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/scenarios/steps.ts
git commit -m "test(e2e): add intake + RTA-gate verbs to Scenario"
```

---

## Phase C — Self-check + scenario spec + playbook

### Task 8: Self-check spec (framework proof)

**Files:**
- Create: `e2e/tests/scenarios/selfcheck.spec.ts`

**Interfaces:**
- Consumes: `Scenario`, `freshTenant`, `step` from `../../scenarios/steps.js`.

- [ ] **Step 1: Write the self-check (one passing verb, one deliberately-wrong assert)**

```typescript
// e2e/tests/scenarios/selfcheck.spec.ts
//
// Proves the step() wrapper + verbs behave before scenarios rely on them: one verb
// that PASSES against real behavior, and one assertion deliberately pointed at absent
// behavior to confirm it FAILS loudly (run in an expect-to-throw guard so the spec
// itself stays green while proving the failure path).
import { test, expect } from '@playwright/test';
import { Scenario, freshTenant } from '../../scenarios/steps.js';

test('framework: a real verb passes and a wrong assertion fails loudly', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Selfcheck');

  // PASS path: inbound auto-captures an unknown the App relays to Team.
  await flow.tenantTexts(tenant, `selfcheck inbound ${tenant.name}`);
  await flow.login();
  await flow.expectUnknownCaptured(tenant);

  // FAIL path: a tenant that never texted must NOT be deliverable — the verb must
  // throw (short timeout) rather than silently pass.
  const ghost = freshTenant('Ghost');
  let threw = false;
  try {
    await expect
      .poll(async () => false, { timeout: 1500 })
      .toBe(true); // stand-in for "absent behavior"; proves the assert harness fails.
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  void ghost;
});
```

- [ ] **Step 2: Run it against the live session stack**

With `npm run e2e:session` running:
`cd /w/tmp/hc-seq-e2e && npm run e2e -- --grep "framework:"`
Expected: PASS (1 passed).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/scenarios/selfcheck.spec.ts
git commit -m "test(e2e): self-check proving step verbs pass and wrong asserts fail"
```

---

### Task 9: `tenant-onboarding.spec.ts` — by-text path + shared tail helper

**Files:**
- Create: `e2e/tests/scenarios/tenant-onboarding.spec.ts`

**Interfaces:**
- Consumes: `Scenario`, `freshTenant` from `../../scenarios/steps.js`.
- Produces: a module-local `intakeAndRtaTail(flow, { inHand })` helper reused by every
  path, and the first `test()` (by-text → RTA in hand → handoff).

- [ ] **Step 1: Write the spec with the by-text path + the shared tail**

```typescript
// e2e/tests/scenarios/tenant-onboarding.spec.ts
//
// One test() per alt-path of documentation/tenant-onboarding-sequence.mermaid.
// Reads as the diagram: each line is a verb from e2e/scenarios/steps.ts. The shared
// eligibility-intake + RTA-gate tail is written once (intakeAndRtaTail) and invoked at
// the end of each path. Coordinator role is "Team", never the founder's name.
import { test } from '@playwright/test';
import { Scenario, freshTenant } from '../../scenarios/steps.js';

const ASK_DETAILS = /full name.*voucher size.*housing authority/i;

/** Eligibility intake → RTA gate → parked/handoff. Shared by every leaf path. */
async function intakeAndRtaTail(flow: Scenario, opts: { inHand: boolean }): Promise<void> {
  const intake = { pets: '1 cat', evictions: 'none', tenure: '3 years', lifEligible: true };
  await flow.teamRecordsIntake(intake);
  await flow.expectIntakeRecorded(intake);
  await flow.teamRecordsRtaDecision(opts.inHand);
  if (opts.inHand) await flow.expectHandoffToSendUnit();
  else await flow.expectParked();
}

test('inbound · by text → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Tenant');

  await flow.tenantTexts(tenant, 'Is this property still available?');
  await flow.login();
  await flow.expectRelayedToTeam(tenant, /still available/i);
  await flow.teamReplies(
    'That one is no longer available. Please send your full name, voucher size, and housing authority.',
  );
  await flow.expectDeliveredToTenant(tenant, /no longer available/i);

  await flow.tenantAnswers('Jordan Rivera, 2 bed, Atlanta Housing');
  await flow.teamTriagesUnknownToTenant(tenant, {
    firstName: 'Jordan',
    lastName: 'Rivera',
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
  });
  await flow.expectTypedTenant(tenant);

  await intakeAndRtaTail(flow, { inHand: true });
});
```

- [ ] **Step 2: Run the by-text path green**

With the session stack running:
`cd /w/tmp/hc-seq-e2e && npm run e2e -- --grep "by text"`
Expected: PASS. Debug with `superpowers:systematic-debugging` if red; after any backend
change run `npm run e2e:restart`.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/scenarios/tenant-onboarding.spec.ts
git commit -m "test(e2e): tenant-onboarding by-text path (green) + shared intake/RTA tail"
```

---

### Task 10: Remaining alt-paths

**Files:**
- Modify: `e2e/tests/scenarios/tenant-onboarding.spec.ts`

Add one `test()` per remaining leaf path. Each is a linear verb script ending in
`intakeAndRtaTail`.

- [ ] **Step 1: by-text → no RTA → parked**

```typescript
test('inbound · by text → no RTA → parked', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Tenant');
  await flow.tenantTexts(tenant, 'Is this place still open?');
  await flow.login();
  await flow.expectRelayedToTeam(tenant, /still open/i);
  await flow.teamReplies('No longer available — send full name, voucher size, and housing authority.');
  await flow.expectDeliveredToTenant(tenant, /no longer available/i);
  await flow.tenantAnswers('Sam Lee, 1 bed, DeKalb Housing');
  await flow.teamTriagesUnknownToTenant(tenant, { firstName: 'Sam', lastName: 'Lee', voucherSize: 1 });
  await flow.expectTypedTenant(tenant);
  await intakeAndRtaTail(flow, { inHand: false });
});
```

- [ ] **Step 2: by-phone → RTA in hand → handoff** (uses the voice verbs + auto-reply)

```typescript
test('inbound · by phone call → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Caller');
  await flow.tenantCalls(tenant);
  // The audited operator-template body — adjust the regex to the exact body recorded
  // in Task 4 if it differs from the default.
  await flow.expectAutoReply(/full name.*voucher size.*housing authority|missed you/i);
  await flow.login();
  await flow.expectUnknownCaptured(tenant);
  await flow.tenantAnswers('Robin Cole, 3 bed, Fulton Housing');
  await flow.expectRelayedToTeam(tenant, /Robin Cole/i);
  await flow.teamTriagesUnknownToTenant(tenant, { firstName: 'Robin', lastName: 'Cole', voucherSize: 3 });
  await flow.expectTypedTenant(tenant);
  await intakeAndRtaTail(flow, { inHand: true });
});
```

- [ ] **Step 3: housing-fair · Team enters details → RTA in hand → handoff**

```typescript
test('housing fair · Team enters details → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  await flow.login();
  await flow.teamCreatesContact({
    firstName: 'Casey',
    lastName: 'Nguyen',
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
  });
  await flow.expectTypedTenant({ phone: '', name: 'Casey Nguyen' });
  await intakeAndRtaTail(flow, { inHand: true });
});
```

- [ ] **Step 4: housing-fair · Team enters details → no RTA → parked**

```typescript
test('housing fair · Team enters details → no RTA → parked', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  await flow.login();
  await flow.teamCreatesContact({ firstName: 'Drew', lastName: 'Park', voucherSize: 1 });
  await flow.expectTypedTenant({ phone: '', name: 'Drew Park' });
  await intakeAndRtaTail(flow, { inHand: false });
});
```

> **Self-serve portal path:** only add this `test()` if the Task 4 audit proved the
> portal exists. If it does not (expected), the path is filed as a registry issue and
> the human confirmed it is out of scope for this branch — do NOT add a perpetually-red
> test here. Note its absence in the playbook (Task 12).

- [ ] **Step 5: Run the whole scenario file green**

With the session stack running:
`cd /w/tmp/hc-seq-e2e && npm run e2e -- --grep "tenant-onboarding|by text|by phone|housing fair"`
(or `--grep` the file). Expected: all paths PASS.

- [ ] **Step 6: Commit**

```bash
git add e2e/tests/scenarios/tenant-onboarding.spec.ts
git commit -m "test(e2e): tenant-onboarding remaining alt-paths (by-phone, housing-fair × RTA)"
```

---

### Task 11: Full-suite gate (hermetic)

- [ ] **Step 1: Stop the interactive session**

Run: `cd /w/tmp/hc-seq-e2e && npm run e2e:stop`

- [ ] **Step 2: Cold-boot full suite**

Run: `cd /w/tmp/hc-seq-e2e && npm run e2e`
Expected: GREEN — every spec, including the new `scenarios/*` and the pre-existing
suite (proving no regression from the contact-schema / edit-form changes). Capture the
final summary line as the completion evidence (per
`superpowers:verification-before-completion`).

- [ ] **Step 3: Commit any fixes** the cold run surfaced (selector flakiness, restart
  ordering). If none, proceed.

---

### Task 12: Playbook doc

**Files:**
- Create: `documentation/sequence-diagram-to-test.md`

- [ ] **Step 1: Write the playbook capturing the method actually used**

Document the repeatable method, reflecting what worked:
1. **Read the diagram + writeup** — identify participants and the App-owns-the-number
   relay rule.
2. **Expand alt-paths** — every nested `alt/else` leaf = one `test()`; factor the shared
   tail into a helper.
3. **Map verbs** — each arrow/note → a `Scenario` verb; Team via UI, Tenant via the
   fake seam, asserts via `listThreads` / GET.
4. **Audit against the live `--mock --local` stack** — confirm selectors/contracts,
   record gaps, file registry issues; fix the vocabulary to match reality before writing
   scenarios.
5. **Build gaps TDD** — a failing diagram step names a feature to build (here: structured
   intake fields).
6. **Go green** — interactive inner loop (`e2e:session` + `--grep`), then the hermetic
   `npm run e2e` gate.
Include: the "Team, never the founder's name" rule, the self-clean isolation rule (no
per-test reseed), the triage-not-New-contact rule, and a pointer to `e2e/scenarios/steps.ts`
as the reusable vocabulary for the next diagram (sending-unit, tours). Note the
self-serve portal as a known unbuilt path (if the audit confirmed it absent).

- [ ] **Step 2: Commit**

```bash
git add documentation/sequence-diagram-to-test.md
git commit -m "docs(e2e): sequence-diagram→test playbook (repeatable method)"
```

---

## Phase D — Review & finish

### Task 13: Code review + finish

- [ ] **Step 1:** `superpowers:requesting-code-review` on the branch diff.
- [ ] **Step 2:** Address feedback with `superpowers:receiving-code-review` (verify each
  claim before acting; don't blindly comply).
- [ ] **Step 3:** `superpowers:verification-before-completion` — re-run `npm run e2e`,
  show the green summary as evidence.
- [ ] **Step 4:** `superpowers:finishing-a-development-branch` — present merge/PR options.
  Do NOT merge to main without explicit human approval.
- [ ] **Step 5:** Stamp the design + this plan with HISTORICAL-RECORD banners only after
  merge (per the historical-doc-banner convention); never before.

---

## Self-Review (against the spec)

**Spec coverage:**
- steps.ts vocabulary + `step()` wrapper → Tasks 2, 3, 7. ✅
- `fakeVoice` fixture → Task 1. ✅
- Trivial self-check (pass + loud-fail) → Task 8. ✅
- Conformance audit → scoped gap list + issues → Task 4. ✅
- Structured intake fields (schema + edit-form UI, first-class not customFields) →
  Tasks 5, 6. ✅
- `missedCallAutoTextEnabled` settings seed → de-scoped to CONTINGENT (default is `true`;
  Task 4 confirms whether a seed is needed; if so, a seed step is added under Task 4/5). ✅
- `tenant-onboarding.spec.ts`, one test per alt-path + shared tail → Tasks 9, 10. ✅
- RTA gate as tenant-status move (`searching`/`on_hold`) → Task 7 verbs + tail. ✅
- Triage-not-New-contact (409 avoidance); New-contact for housing-fair only → Tasks 2, 10. ✅
- Self-clean isolation, no per-test reseed → `freshTenant` (Task 2) + Global Constraints. ✅
- Playbook doc, written after green → Task 12. ✅
- Green full-suite gate → Task 11. ✅

**Known scope risk (flagged, not silently dropped):** the self-serve portal leaf path
likely does not exist (public pages stubbed). Task 4 Step 4 STOPS to confirm scope with
the human rather than build a public portal under this branch.

**Type consistency:** verb names, the `Tenant`/`CallScenario`/`FakeCall` shapes, the
intake field names (`pets`/`evictions`/`tenure`/`lifEligible`), and the status strings
(`searching`/`on_hold`) are used identically across fixture, steps, backend, dashboard,
and spec tasks.
