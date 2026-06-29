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
import { tenantCallNoAnswer } from '../fixtures/fakeVoice.js';

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
        phone: fields.phone ? fields.phone : '',
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
    return m[1]!;
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
