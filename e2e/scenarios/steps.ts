// e2e/scenarios/steps.ts
//
// The diagram vocabulary for sequence-diagram-driven e2e scenarios. Each verb maps
// 1:1 to an arrow/note in documentation/tenant-onboarding-sequence.mermaid. The
// coordinator role is "Team" (the seeded VA dev-login), NEVER the founder's name.
//
// Fidelity rule: Team's in-flow actions are driven through the REAL dashboard UI;
// the tenant's inbound and pure setup use the fake-twilio API seam (and the public
// housing-fair endpoint for the self-serve portal). Outbound proof-of-send is
// asserted via fake-twilio listThreads (/control/threads).
//
// Selectors + contracts here were verified against the live --mock --local stack in
// the Task 4 conformance audit (.superpowers/sdd/task-4-audit.md).
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { sendAsParty, listThreads, registerParty } from '../fixtures/fakeTwilio.js';
import { tenantCallNoAnswer } from '../fixtures/fakeVoice.js';

const NEXT = 'http://localhost:5174';
/** The app's own number — OUR_PHONE_NUMBERS in the e2e stack (owns the conversation). */
export const APP_NUMBER = '+15550009999';
/** Seeded landlord every created property is owned by (app/src/lib/seedData.ts). */
const SEEDED_LANDLORD = 'contact-landlord-0001';

/** A fresh contact (any role) the scenarios drive. Modelled with the SAME inbound
 *  machinery regardless of role (the fake persona registry is role-agnostic for
 *  send-as-party); `firstName` is the unique, space-free handle used to locate the
 *  contact's row (e.g. a broadcast audience preview shows the FIRST name only). */
export interface Contact {
  phone: string;
  name: string;
  firstName: string;
  lastName: string;
}

/** Role-reading aliases over {@link Contact} — same shape, clearer at call sites. */
export type Tenant = Contact;
export type Landlord = Contact;

/** An available property the team can send to a tenant (sending-unit scenarios). */
export interface Unit {
  unitId: string;
  addressLine1: string;
}

/** Thin wrapper over Playwright's test.step so a scenario reads as the diagram. */
export function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return test.step(name, fn);
}

/** A fresh tenant with a per-run-unique, valid 11-digit E.164 phone + name. The
 *  number is `+1555` + 5 timestamp digits + a 2-digit zero-padded sequence, so it
 *  is always a well-formed NANP number (accepted by normalizeToE164 + the fake
 *  persona registry) and never truncates or collides within a run. */
let seq = 0;
export function freshContact(label: string): Contact {
  const stamp = `${Date.now()}`.slice(-5);
  seq += 1;
  const phone = `+1555${stamp}${String(seq).padStart(2, '0')}`;
  // firstName is unique + space-free (so a broadcast preview row — which shows the
  // FIRST name only — is locatable by an exact accessible-name match).
  const firstName = `${label}${stamp}${seq}`;
  return { phone, firstName, lastName: 'Tester', name: `${label} ${stamp}-${seq}` };
}

/** Role-reading aliases over {@link freshContact} — identical behavior; they read as
 *  the role at the call site (freshLandlord('Landlord'), freshTenant('Caller'), …).
 *  freshTenant is kept so the existing tenant/sending-unit specs need no change. */
export const freshTenant = freshContact;
export const freshLandlord = freshContact;

/** E.164 +1NXXNXXXXXX → "(NXX) NXX-XXXX" — how the dashboard displays a US number,
 *  so a nameless unknown row can be located by its visible (formatted) phone. */
function formatUsPhone(e164: string): string {
  const d = e164.replace(/\D/g, ''); // 1 + 10 digits
  const ten = d.length === 11 ? d.slice(1) : d;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6, 10)}`;
}

export class Scenario {
  private activeContactId: string | null = null;
  private activeTenant: Tenant | null = null;
  /** First name of the active tenant — to locate their broadcast preview row. */
  private activeFirstName: string | null = null;
  private readonly registered = new Set<string>();

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
      await this.ensureParty(t);
      await sendAsParty(this.request, { from: t.phone, to: APP_NUMBER, body });
    });
  }

  /** [Tenant→App] A follow-up inbound from the already-active tenant. */
  tenantAnswers(body: string): Promise<void> {
    const t = this.requireActiveTenant();
    return step(`Tenant replies: "${body}"`, async () => {
      await this.ensureParty(t);
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
   * [Tenant→App] The self-serve portal: the tenant submits their own details through
   * the public housing-fair endpoint (the diagram's "Tenant self-serves"). Driven via
   * the :5174 proxy (which injects the origin secret the public route requires). Sets
   * the active tenant; the [AUTO] welcome text is asserted with expectDeliveredToTenant.
   */
  tenantSelfServes(t: Tenant, fields: {
    firstName: string;
    lastName: string;
    voucherSize?: number;
  }): Promise<void> {
    return step('Tenant self-serves via the public portal', async () => {
      this.activeTenant = t;
      // A2P/CTIA (spec §3.1): the public form now REQUIRES the consent checkbox;
      // the server rejects a submit missing `smsConsent:true` with 400
      // consent_required. The self-serve portal always sends it (the UI gates on
      // the checked box).
      const res = await this.page.request.post(`${NEXT}/public/housing-fair`, {
        data: { ...fields, phone: t.phone, smsConsent: true },
      });
      expect(res.ok()).toBeTruthy();
    });
  }

  /**
   * [App→Tenant] The missed-call auto-text fired automatically (no Team action).
   * Asserts the operator-template body reached the tenant's fake thread.
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
   * so we locate it by its (formatted) phone under the "Unknown" tab, open it, and
   * assert the inbound body in the timeline. Records the contactId for later verbs.
   */
  expectRelayedToTeam(t: Tenant, bodyRe: RegExp): Promise<void> {
    return step('App relays the lead to Team (Unknown tab, by phone)', async () => {
      this.activeTenant = t;
      const id = await this.resolveUnknownContactId(t);
      await this.page.goto(`${NEXT}/contacts/unknown`);
      await expect(
        this.page.getByRole('link').filter({ hasText: formatUsPhone(t.phone) }),
      ).toBeVisible({ timeout: 15_000 });
      await this.page.goto(`${NEXT}/contacts/${id}`);
      await expect(this.page.getByText(bodyRe)).toBeVisible({ timeout: 10_000 });
      this.activeContactId = id;
    });
  }

  /** [App] An inbound from an unrecognized number auto-created an UNKNOWN contact. */
  expectUnknownCaptured(t: Tenant): Promise<void> {
    return step('App auto-captured an unknown contact', async () => {
      this.activeTenant = t;
      const id = await this.resolveUnknownContactId(t);
      this.activeContactId = id;
      await this.page.goto(`${NEXT}/contacts/unknown`);
      await expect(
        this.page.getByRole('link').filter({ hasText: formatUsPhone(t.phone) }),
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
    return step('App delivers to Tenant (proof-of-send)', async () => {
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
   * [Team] Triage the captured unknown → Tenant via the contact page ("Mark as
   * Tenant"). NOT "New contact" — the number already exists (that path 409s).
   * Optionally set identity fields (name, voucher, housing authority) via the edit
   * form afterward.
   */
  teamTriagesUnknownToTenant(
    t: Tenant,
    fields?: { firstName?: string; lastName?: string; voucherSize?: number; housingAuthority?: string },
  ): Promise<void> {
    return step('Team triages the unknown → Tenant', async () => {
      await this.openActiveContact(t);
      await this.page.getByRole('button', { name: 'Mark as Tenant' }).click();
      // Triage flips type → tenant in place; the "Mark as Tenant" affordance is gone.
      await expect(this.page.getByRole('button', { name: 'Mark as Tenant' })).toHaveCount(0, {
        timeout: 10_000,
      });
      if (fields) await this.editTenantIdentity(fields);
    });
  }

  /** @deprecated Alias of {@link teamCreatesTenant} — kept for the tenant/sending-unit
   *  specs that predate the rename. */
  teamCreatesContact(...args: Parameters<Scenario['teamCreatesTenant']>): Promise<void> {
    return this.teamCreatesTenant(...args);
  }

  /**
   * [Team] Housing-fair in-person path: create a brand-new Tenant via the New-contact
   * dialog (no prior number). Sets the active contact.
   */
  teamCreatesTenant(fields: {
    firstName: string;
    lastName: string;
    voucherSize?: number;
    housingAuthority?: string;
    phone?: string;
    /** A2P/CTIA (spec §3.3): record verbal consent in the optional "Consent to
     *  text" section so the contact is textable (broadcast/1:1) without hitting
     *  the JIT gate later. Defaults to verbal_in_person (a fair walk-in). */
    consent?: boolean;
  }): Promise<void> {
    return step('Team creates a new Tenant contact (housing fair)', async () => {
      await this.page.goto(`${NEXT}/contacts`);
      await this.page.getByRole('button', { name: 'New contact' }).click();
      const dialog = this.page.getByRole('dialog', { name: /New contact/i });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole('group', { name: 'Contact kind' })
        .getByRole('button', { name: 'Tenant' })
        .click();
      await dialog.getByLabel('First name').fill(fields.firstName);
      await dialog.getByLabel('Last name').fill(fields.lastName);
      if (fields.phone) await dialog.getByLabel('Phone').fill(fields.phone);
      // Record verbal text consent (the optional collapsed section) so the tenant
      // is textable. A VA recording a fair walk-in captures this on the spot.
      if (fields.consent !== false) {
        await dialog.getByRole('button', { name: '+ Record text consent' }).click();
        await dialog.getByLabel('How did they consent?').selectOption('verbal_in_person');
      }
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(this.page).toHaveURL(/\/contacts\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });
      this.activeContactId = await this.readActiveContactId();
      this.activeFirstName = fields.firstName;
      this.activeTenant = {
        phone: fields.phone ?? '',
        name: `${fields.firstName} ${fields.lastName}`,
        firstName: fields.firstName,
        lastName: fields.lastName,
      };
      if (fields.voucherSize !== undefined || fields.housingAuthority !== undefined) {
        await this.editTenantIdentity({
          voucherSize: fields.voucherSize,
          housingAuthority: fields.housingAuthority,
        });
      }
    });
  }

  /** [App] The contact is now typed Tenant (assert via API on the active contact). */
  expectTypedTenant(): Promise<void> {
    return step('App: contact is typed Tenant', async () => {
      const id = this.requireActiveContactId();
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: { type: string } };
      expect(contact.type).toBe('tenant');
    });
  }

  /**
   * [App] The onboarding identity (name / voucher size / housing authority) was
   * captured onto the tenant — the diagram collects "full name, voucher size, and
   * housing authority". Asserts via the API on the active contact; only the supplied
   * fields are checked.
   */
  expectTenantDetails(fields: {
    firstName?: string;
    lastName?: string;
    voucherSize?: number;
    housingAuthority?: string;
  }): Promise<void> {
    return step('App: tenant onboarding details captured', async () => {
      const id = this.requireActiveContactId();
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: Record<string, unknown> };
      if (fields.firstName !== undefined) expect(contact['firstName']).toBe(fields.firstName);
      if (fields.lastName !== undefined) expect(contact['lastName']).toBe(fields.lastName);
      if (fields.voucherSize !== undefined) expect(contact['voucherSize']).toBe(fields.voucherSize);
      if (fields.housingAuthority !== undefined)
        expect(contact['housingAuthority']).toBe(fields.housingAuthority);

      // UI: Team can SEE these in the Details panel — voucher renders as "<n> BR",
      // housing authority renders raw (e.g. "atlanta_housing"). Scope to the Details
      // section so the header-subtitle copy of the authority doesn't double-match.
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const details = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Details' }) });
      if (fields.voucherSize !== undefined)
        await expect(details.getByText(`${fields.voucherSize} BR`)).toBeVisible();
      if (fields.housingAuthority !== undefined)
        await expect(details.getByText(fields.housingAuthority)).toBeVisible();
    });
  }

  /** [Team] Record the eligibility intake answers via the edit form (real UI). Uses
   *  the AUDIT-PROVEN edit pattern: open via 'Edit contact details', scope to the
   *  'Edit contact' dialog, fields by label, Save{exact}, wait for the dialog to close. */
  teamRecordsIntake(i: {
    pets?: string;
    evictions?: string;
    tenure?: string;
    lifEligible?: boolean;
  }): Promise<void> {
    return step('Team records eligibility intake', async () => {
      await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
      await this.page.getByRole('button', { name: 'Edit contact details' }).click();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      await expect(dialog).toBeVisible();
      if (i.pets !== undefined) await dialog.getByLabel('Pets').fill(i.pets);
      if (i.evictions !== undefined) await dialog.getByLabel('Evictions').fill(i.evictions);
      if (i.tenure !== undefined)
        await dialog.getByLabel('Time at current address').fill(i.tenure);
      if (i.lifEligible === true) await dialog.getByLabel('LIF eligible').check();
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
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

      // UI: Team can SEE the recorded intake in the "Eligibility intake" section of
      // the Details pane (not just via the editor). Scope to that card so common
      // values like "none"/"Yes" can't double-match elsewhere on the page.
      await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
      const card = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Eligibility intake' }) });
      await expect(card).toBeVisible();
      if (i.pets) await expect(card.getByText(i.pets)).toBeVisible();
      if (i.evictions) await expect(card.getByText(i.evictions)).toBeVisible();
      if (i.tenure) await expect(card.getByText(i.tenure)).toBeVisible();
      if (i.lifEligible !== undefined)
        await expect(card.getByText(i.lifEligible ? 'Yes' : 'No')).toBeVisible();
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
      await this.page.getByRole('button', { name: 'Edit contact details' }).click();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Status' }).selectOption({ label });
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    });
  }

  expectHandoffToSendUnit(): Promise<void> {
    return step('App: tenant ready for Send-Unit (searching)', () => this.assertStatus('searching'));
  }

  expectParked(): Promise<void> {
    return step('App: tenant parked (on_hold)', () => this.assertStatus('on_hold'));
  }

  /**
   * [Team→App] Open the contact created by the self-serve portal. The public form
   * makes a `type:tenant, status:needs_review` contact (NOT an unknown), so resolve
   * it from the TENANT list by phone (paging through nextCursor — the seeded set plus
   * per-run contacts can exceed one page), record it active, and navigate to it.
   */
  openSelfServedContact(t: Tenant): Promise<void> {
    return step('Team opens the self-served contact', async () => {
      const id = await this.findTenantContactIdByPhone(t.phone);
      this.activeContactId = id;
      this.activeTenant = t;
      await this.page.goto(`${NEXT}/contacts/${id}`);
      await expect(this.page.getByRole('button', { name: 'Edit contact details' })).toBeVisible({
        timeout: 10_000,
      });
    });
  }

  // ==== Sending-unit verbs (documentation/sending-unit-sequence.mermaid) ====
  // Audited live against --mock --local (2026-06-30): "send a listing" is the
  // broadcast-to-tenants flow (no individual-send route); preferences are the
  // contact's free-form `notes`; there is NO automated matcher (the team browses
  // available units); Tours is a SEPARATE, unbuilt workflow and `searching`
  // absorbs touring (documentation/STATUS-MODEL.md), so the loop-exit signal that
  // exists today is "the fitting unit was sent + tenant stays searching".

  /**
   * [Setup] Create an AVAILABLE property the team can send. Pure setup → API:
   * POST /api/units starts a property in 'setup', then PATCH …/listing-status
   * publishes it to 'available' (the only shareable status). beds defaults to the
   * tenant's voucher size so it lands in the broadcast's pre-filled audience.
   */
  seedAvailableUnit(opts: { beds: number; jurisdiction?: string }): Promise<Unit> {
    return step(`Setup: an available ${opts.beds}-BR property to send`, async () => {
      seq += 1;
      const addressLine1 = `${200 + seq} Sender Way NW`;
      const created = await this.page.request.post(`${NEXT}/api/units`, {
        data: {
          landlordId: SEEDED_LANDLORD,
          jurisdiction: opts.jurisdiction ?? 'atlanta_housing',
          beds: opts.beds,
          rent_min: 1500,
          rent_max: 1600,
          address: { line1: addressLine1, city: 'Atlanta', state: 'GA', zip: '30314' },
        },
      });
      expect(created.ok()).toBeTruthy();
      const unitId = ((await created.json()) as { unit: { unitId: string } }).unit.unitId;
      const published = await this.page.request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
        data: { toStatus: 'available', source: 'manual' },
      });
      expect(published.ok()).toBeTruthy();
      return { unitId, addressLine1 };
    });
  }

  /**
   * [Team→App] Send a specific listing to the active tenant for feedback. Phase-1
   * mechanism = the broadcast-to-tenants composer, CURATED down to just this tenant
   * (Deselect all → check their row). The body carries [Address] + [FlyerLink] so the
   * delivered SMS is assertable by the unit's flyer link.
   */
  teamSendsListing(unit: Unit): Promise<void> {
    const firstName = this.requireActiveFirstName();
    return step(`Team sends a listing (${unit.unitId}) to the tenant`, async () => {
      await this.page.goto(`${NEXT}/listings/${unit.unitId}`);
      await this.page.getByRole('button', { name: /Broadcast to tenants/i }).click();
      await expect(this.page).toHaveURL(new RegExp(`/broadcasts/new\\?unitId=${unit.unitId}`));
      await expect(this.page.getByRole('heading', { name: 'New broadcast' })).toBeVisible();
      await this.page
        .getByLabel('Message')
        .fill('Take a look at this home: [Address] — details [FlyerLink]');
      const preview = this.page.getByRole('button', { name: 'Preview recipients' });
      await expect(preview).toBeEnabled({ timeout: 15_000 });
      await preview.click();
      await expect(this.page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
      // Curate to exactly the active tenant: clear the audience, then check only them.
      await this.page.getByRole('button', { name: 'Deselect all' }).click();
      const list = this.page.getByRole('list', { name: 'Candidate recipients' });
      // exact: the row's accessible name is the FIRST name only; without exact a
      // prior-run tenant whose firstName is a prefix (e.g. "Searcher123451" inside
      // "Searcher1234512") would also match this substring.
      await list.getByRole('checkbox', { name: firstName, exact: true }).check();
      await this.page.getByRole('button', { name: /^Send to/ }).click();
      await expect(this.page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });
    });
  }

  /**
   * [App→Tenant] The listing reached the tenant. Three proofs: (1) the templated SMS
   * (flyer link) landed in the tenant's fake thread, DELIVERED; (2) a listing_send
   * row links tenant↔unit (GET …/listings-sent); (3) Team SEES a "Property sent"
   * link to the unit on the tenant's timeline.
   */
  expectListingDelivered(t: Tenant, unit: Unit): Promise<void> {
    const id = this.requireActiveContactId();
    return step(`App delivers the listing (${unit.unitId}) to the tenant`, async () => {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(this.request);
            const thread = threads.find((x) => x.partyNumber === t.phone);
            return (
              thread?.messages.some(
                (m) =>
                  m.direction === 'outbound' &&
                  (m.body ?? '').includes(`/p/${unit.unitId}`) &&
                  m.state === 'delivered',
              ) ?? false
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            const res = await this.page.request.get(`${NEXT}/api/contacts/${id}/listings-sent`);
            if (!res.ok()) return false;
            const { sent } = (await res.json()) as { sent: Array<{ unitId: string }> };
            return sent.some((s) => s.unitId === unit.unitId);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      await this.page.goto(`${NEXT}/contacts/${id}`);
      await expect(
        this.page.locator(`a[href="/listings/${unit.unitId}"]`).first(),
      ).toBeVisible({ timeout: 10_000 });
    });
  }

  /**
   * [App→Team] The tenant's preference text was relayed to Team — it surfaces in the
   * tenant's contact timeline (the relay rule: every inbound flows to Team via the app).
   */
  expectPreferencesRelayed(re: RegExp): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App relays the tenant preferences to Team (contact timeline)', async () => {
      await this.page.goto(`${NEXT}/contacts/${id}`);
      // Scope to the timeline region so the assertion proves the inbound RENDERED
      // there (not a stray match elsewhere on the page) — per the playbook.
      const timeline = this.page.getByRole('region', { name: 'Communications and activity' });
      await expect(timeline.getByText(re)).toBeVisible({ timeout: 10_000 });
    });
  }

  /**
   * [Team, MANUAL] Save the tenant's preferences to their profile — the free-form
   * "Notes" field of the Edit-contact dialog (renders in the "Preferences & notes"
   * card). The diagram tags this [MANUAL]: a person records it.
   */
  teamSavesPreferences(prefs: string): Promise<void> {
    return step('Team saves preferences to the tenant profile', async () => {
      await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
      await this.page.getByRole('button', { name: 'Edit contact details' }).click();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Notes').fill(prefs);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    });
  }

  /**
   * [App] The preferences persisted on the tenant (contact.notes) AND Team can SEE
   * them in the "Preferences & notes" card — remembered for future matches.
   */
  expectPreferencesRecorded(prefs: string): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App: preferences saved to the tenant profile', async () => {
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: { notes?: string } };
      expect(contact.notes).toBe(prefs);
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const card = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Preferences & notes' }) });
      await expect(card.getByText(prefs)).toBeVisible();
    });
  }

  /**
   * [Team→App] "Find another match." Phase-1 reality: NO automated matcher — the team
   * browses available properties. Asserts the deterministic fact (a next listing IS
   * available to send + Team can see it in the Properties list), never a re-ranking.
   */
  teamFindsNextMatch(nextUnit: Unit): Promise<void> {
    return step('Team finds another match (browses available properties)', async () => {
      const res = await this.page.request.get(`${NEXT}/api/units?status=available&limit=100`);
      expect(res.ok()).toBeTruthy();
      const { units } = (await res.json()) as { units: Array<{ unitId: string }> };
      expect(units.some((u) => u.unitId === nextUnit.unitId)).toBe(true);
      await this.page.goto(`${NEXT}/listings`);
      await expect(
        this.page.locator(`a[href="/listings/${nextUnit.unitId}"]`).first(),
      ).toBeVisible({ timeout: 10_000 });
    });
  }

  /**
   * [App] Loop exit — a listing fits → hand off to the separate Tours workflow. Tours
   * is NOT built in Phase 1 and `searching` absorbs touring (STATUS-MODEL.md), so the
   * real, deterministic handoff signal is: the fitting unit was sent (listing_send) and
   * the tenant stays `searching` (Tours-ready — not prematurely placed). Team sees the
   * "Searching" status in Details.
   */
  expectHandoffToTours(fittingUnit: Unit): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App: a listing fits → hand off to Tours (tenant stays searching)', async () => {
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}/listings-sent`);
      expect(res.ok()).toBeTruthy();
      const { sent } = (await res.json()) as { sent: Array<{ unitId: string }> };
      expect(sent.some((s) => s.unitId === fittingUnit.unitId)).toBe(true);
      await this.assertStatus('searching');
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const details = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Details' }) });
      await expect(details.getByText('Searching')).toBeVisible();
    });
  }

  // ==== Landlord-onboarding verbs (documentation/landlord-onboarding-sequence.mermaid) ====
  // A landlord is modelled with the SAME contact machinery as a tenant (inbound via the
  // fake persona registry, triage/edit via the real dashboard), differing only by
  // `type=landlord`, the landlord lead lifecycle (needs_review|interested|active|parked),
  // and the structured deal-terms card ("Landlord onboarding"). Audited live against the
  // running e2e:session stack (2026-06-30): selectors match the Task-6 audited list.

  /**
   * [Team] Housing-fair / sourced-lead path: create a brand-new Landlord via the
   * New-contact dialog (kind "Landlord"). Models the diagram's "[MANUAL] Create the
   * landlord contact from the sourced lead" (the cold call is not app-placed in Phase 1).
   * Sets the active contact + party, mirroring teamCreatesContact.
   */
  teamCreatesLandlord(fields: { firstName: string; lastName: string; phone?: string }): Promise<void> {
    return step('Team creates a new Landlord contact (sourced lead)', async () => {
      await this.page.goto(`${NEXT}/contacts`);
      await this.page.getByRole('button', { name: 'New contact' }).click();
      const dialog = this.page.getByRole('dialog', { name: /New contact/i });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole('group', { name: 'Contact kind' })
        .getByRole('button', { name: 'Landlord' })
        .click();
      await dialog.getByLabel('First name').fill(fields.firstName);
      await dialog.getByLabel('Last name').fill(fields.lastName);
      if (fields.phone) await dialog.getByLabel('Phone').fill(fields.phone);
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(this.page).toHaveURL(/\/contacts\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });
      this.activeContactId = await this.readActiveContactId();
      this.activeFirstName = fields.firstName;
      this.activeTenant = {
        phone: fields.phone ?? '',
        name: `${fields.firstName} ${fields.lastName}`,
        firstName: fields.firstName,
        lastName: fields.lastName,
      };
    });
  }

  /** [Landlord→App] Inbound SMS from the landlord (API seam). Alias over tenantTexts —
   *  the fake persona registry is role-agnostic for send-as-party. Sets active party. */
  landlordTexts(l: Landlord, body: string): Promise<void> {
    return this.tenantTexts(l, body);
  }

  /** [Landlord→App] A follow-up inbound from the already-active landlord. */
  landlordAnswers(body: string): Promise<void> {
    return this.tenantAnswers(body);
  }

  /**
   * [Team] Triage the captured unknown → Landlord via the contact page ("Mark as
   * Landlord"). Mirrors teamTriagesUnknownToTenant.
   */
  teamTriagesUnknownToLandlord(l: Landlord): Promise<void> {
    return step('Team triages the unknown → Landlord', async () => {
      await this.openActiveContact(l);
      await this.page.getByRole('button', { name: 'Mark as Landlord' }).click();
      await expect(this.page.getByRole('button', { name: 'Mark as Landlord' })).toHaveCount(0, {
        timeout: 10_000,
      });
    });
  }

  /** [Team] Set the landlord lead status → Interested (the diagram's "set lead status
   *  to interested"). A landlord STATUS move via the edit-form Status select. */
  teamMarksLeadInterested(): Promise<void> {
    return step('Team marks the lead → Interested', async () => {
      await this.setLandlordStatus('Interested');
    });
  }

  /** [App] The lead is `interested` (raw status via API + the Details "Status" row,
   *  which renders the LABEL "Interested" — not the raw value). */
  expectLeadInterested(): Promise<void> {
    return step('App: landlord lead is interested', async () => {
      await this.assertStatus('interested');
      await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
      const details = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Details' }) });
      await expect(details.getByText('Interested')).toBeVisible();
    });
  }

  /** [Team] Record the DocuSign contract as signed (contract_status → signed). The
   *  signing itself is an external channel; Team records the outcome on the record. */
  teamRecordsContractSigned(): Promise<void> {
    return step('Team records the contract as signed', async () => {
      await this.openEditDialog();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      await dialog.getByLabel('Contract status').selectOption({ label: 'Signed' });
      await this.saveEditDialog(dialog);
    });
  }

  /**
   * [Team] Save the onboarding-call deal terms (expected rent + the operational
   * criteria + a soft-terms note). One edit session. Approval criteria is recorded
   * SEPARATELY (teamRecordsApprovalCriteria) so it doesn't overwrite Notes.
   */
  teamRecordsLandlordOnboarding(o: {
    expectedRent: number;
    registeredLandlord: boolean;
    rta48h: boolean;
    inspectionFirstTry: boolean;
    softTermsNote?: string;
  }): Promise<void> {
    return step('Team records the landlord onboarding details', async () => {
      await this.openEditDialog();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      await dialog.getByLabel('Expected rent').fill(String(o.expectedRent));
      if (o.registeredLandlord) await dialog.getByLabel('Registered landlord').check();
      if (o.rta48h) await dialog.getByLabel('Submits RTA within 48h').check();
      if (o.inspectionFirstTry) await dialog.getByLabel('Passes inspection first try').check();
      if (o.softTermsNote !== undefined) await dialog.getByLabel('Notes').fill(o.softTermsNote);
      await this.saveEditDialog(dialog);
    });
  }

  /**
   * [Team] Save the approval criteria in a SEPARATE edit session — income rule (the
   * voucher counts as income) + a free-form criteria narrative recorded as a custom
   * field so it doesn't clobber the onboarding Notes.
   */
  teamRecordsApprovalCriteria(o: { incomeIncludesVoucher: boolean; criteriaNote: string }): Promise<void> {
    return step('Team records the approval criteria', async () => {
      await this.openEditDialog();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      if (o.incomeIncludesVoucher) await dialog.getByLabel('Voucher counts as income').check();
      await dialog.getByRole('button', { name: /\+ Add custom field/ }).click();
      await dialog.getByLabel('Field label 1').fill('Approval criteria');
      await dialog.getByLabel('Field value 1').fill(o.criteriaNote);
      await this.saveEditDialog(dialog);
    });
  }

  /**
   * [App] The onboarding details + approval criteria persisted on the landlord (API)
   * AND Team can SEE them in the scoped "Landlord onboarding" card. Only the supplied
   * fields are checked.
   */
  expectLandlordOnboardingRecorded(o: {
    contractSigned: boolean;
    expectedRent: number;
    registeredLandlord: boolean;
    rta48h: boolean;
    inspectionFirstTry: boolean;
    incomeIncludesVoucher: boolean;
  }): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App: landlord onboarding details recorded', async () => {
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: Record<string, unknown> };
      expect(contact['contract_status']).toBe(o.contractSigned ? 'signed' : 'unsigned');
      expect(contact['expected_rent']).toBe(o.expectedRent);
      expect(contact['registered_landlord']).toBe(o.registeredLandlord);
      expect(contact['rta_within_48h']).toBe(o.rta48h);
      expect(contact['pass_inspection_first_try']).toBe(o.inspectionFirstTry);
      expect(contact['income_includes_voucher']).toBe(o.incomeIncludesVoucher);

      await this.page.goto(`${NEXT}/contacts/${id}`);
      const card = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Landlord onboarding' }) });
      await expect(card).toBeVisible();
      await expect(card.getByText('Contract status')).toBeVisible();
      await expect(card.getByText(o.contractSigned ? 'Signed' : 'Unsigned')).toBeVisible();
      await expect(card.getByText('Expected rent')).toBeVisible();
      await expect(card.getByText(String(o.expectedRent), { exact: true })).toBeVisible();
      await expect(card.getByText('Registered landlord')).toBeVisible();
      await expect(card.getByText('Submits RTA within 48h')).toBeVisible();
      await expect(card.getByText('Passes inspection first try')).toBeVisible();
      await expect(card.getByText('Voucher counts as income')).toBeVisible();
      // Boolean VALUES render (Yes/No) — assert by count (each true boolean row shows
      // "Yes"), scoped to the card so a bare getByText('Yes') can't multi-match/collide.
      const yesCount = [o.registeredLandlord, o.rta48h, o.inspectionFirstTry, o.incomeIncludesVoucher].filter(
        Boolean,
      ).length;
      if (yesCount > 0) await expect(card.getByText('Yes', { exact: true })).toHaveCount(yesCount);
    });
  }

  /** [Team] Log a reason + park the lead (the diagram's "[MANUAL] Log the reason. Park
   *  the lead"). Driven through the REAL edit form (mostly-UI fidelity, mirroring
   *  teamRecordsContractSigned): set Status → Parked + fill the Park reason. For a
   *  landlord both the status change and park_reason persist via the generic
   *  PATCH /api/contacts/:id in ONE Save. */
  teamParksLead(reason: string): Promise<void> {
    return step(`Team parks the lead (${reason})`, async () => {
      await this.openEditDialog();
      const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
      await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption({ label: 'Parked' });
      await dialog.getByLabel('Park reason').fill(reason);
      await this.saveEditDialog(dialog);
    });
  }

  /** [App] The lead is `parked` with park_reason (API) AND Team SEES the "Park reason"
   *  row in the "Landlord onboarding" card (which only appears when parked). */
  expectLeadParked(reason: string): Promise<void> {
    const id = this.requireActiveContactId();
    return step(`App: landlord lead parked (${reason})`, async () => {
      const res = await this.page.request.get(`${NEXT}/api/contacts/${id}`);
      expect(res.ok()).toBeTruthy();
      const { contact } = (await res.json()) as { contact: { status?: string; park_reason?: string } };
      expect(contact.status).toBe('parked');
      expect(contact.park_reason).toBe(reason);
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const card = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Landlord onboarding' }) });
      await expect(card.getByText('Park reason')).toBeVisible();
      await expect(card.getByText(reason)).toBeVisible();
    });
  }

  /**
   * [Landlord→App] Property intake, often via text/MMS — the diagram's "Property
   * details plus photos or video (MMS)". Inbound from the active landlord, optionally
   * carrying media (exercises the MMS attach path).
   */
  landlordTextsProperty(details: string, mediaUrls?: string[]): Promise<void> {
    const l = this.requireActiveTenant();
    return step(`Landlord texts property details: "${details}"`, async () => {
      await this.ensureParty(l);
      await sendAsParty(this.request, {
        from: l.phone,
        to: APP_NUMBER,
        body: details,
        ...(mediaUrls !== undefined && { mediaUrls }),
      });
    });
  }

  /**
   * [Team, MANUAL] Create the unit record under this landlord from the intake via the
   * REAL "New property" form — opened from the landlord's Properties card, pre-filled +
   * LOCKED to this landlord (dashboard/src/routes/listing/UnitCreateForm.tsx). Fields
   * default to a valid property; `voucherSizeAccepted` may be omitted to model an intake
   * still missing a field (Team then follows up + teamUpdatesUnit sets it). Publishes to
   * 'available' ONLY when voucher_size_accepted is present (the diagram publishes after
   * the record is complete) — publish stays an API seam. Returns the Unit for assertions.
   */
  teamCreatesUnitFromIntake(
    landlordId: string,
    opts: {
      beds: number;
      baths?: number;
      voucherSizeAccepted?: number;
      listingLink?: string;
      jurisdiction?: string;
    },
  ): Promise<Unit> {
    return step('Team creates the unit under the landlord (New-property form)', async () => {
      seq += 1;
      const addressLine1 = `${300 + seq} Landlord Row NW`;

      // Open the "New property" dialog from the landlord's Properties card — the form
      // is pre-filled + locked to this landlord (no owning-landlord picker to fill).
      await this.page.goto(`${NEXT}/contacts/${landlordId}`);
      await this.page.getByRole('button', { name: 'Add a property for this landlord' }).click();
      const dialog = this.page.getByRole('dialog', { name: 'New property' });
      await expect(dialog).toBeVisible();

      // Fill the intake fields.
      await dialog.getByLabel('Housing authority').fill(opts.jurisdiction ?? 'atlanta_housing');
      await dialog.getByLabel('Beds').fill(String(opts.beds));
      await dialog.getByLabel('Baths').fill(String(opts.baths ?? 2));
      await dialog.getByLabel('Rent min').fill('1400');
      await dialog.getByLabel('Rent max').fill('1500');
      await dialog
        .getByLabel('Public listing link')
        .fill(opts.listingLink ?? 'https://www.zillow.com/homedetails/example');
      if (opts.voucherSizeAccepted !== undefined) {
        await dialog.getByLabel('Voucher size accepted').fill(String(opts.voucherSizeAccepted));
      }
      await dialog.getByLabel('Street address').fill(addressLine1);
      await dialog.getByLabel('City').fill('Atlanta');
      await dialog.getByLabel('State').fill('GA');
      await dialog.getByLabel('ZIP').fill('30314');

      // Create → the app navigates to the new property's detail page (/listings/:id).
      await dialog.getByRole('button', { name: /^Create$/ }).click();
      await this.page.waitForURL(/\/listings\/[^/]+$/);
      // Extract the id defensively (exclude any query/hash), mirroring readActiveContactId.
      const match = /\/listings\/([^/?#]+)/.exec(this.page.url());
      if (!match) throw new Error('teamCreatesUnitFromIntake: expected a /listings/:id URL after create');
      const unitId = decodeURIComponent(match[1]!);

      // Publish → available ONLY when the record is complete (voucher present),
      // mirroring the diagram. Publish stays an API seam (listing-status route).
      if (opts.voucherSizeAccepted !== undefined) {
        await this.publishUnit(unitId);
      }

      // Return to the landlord's thread (the app left us on the new property's page
      // after create) so the flow can continue with landlord comms — as a real user
      // would navigate back.
      await this.page.goto(`${NEXT}/contacts/${landlordId}`);
      return { unitId, addressLine1 };
    });
  }

  /** [Team, MANUAL] Update the unit record with a previously-missing field (the
   *  intake follow-up iteration). Pure setup → API PATCH. */
  teamUpdatesUnit(unit: Unit, patch: { voucherSizeAccepted?: number }): Promise<void> {
    return step('Team updates the unit record (missing field)', async () => {
      const data: Record<string, unknown> = {};
      if (patch.voucherSizeAccepted !== undefined) data['voucher_size_accepted'] = patch.voucherSizeAccepted;
      const res = await this.page.request.patch(`${NEXT}/api/units/${unit.unitId}`, { data });
      expect(res.ok()).toBeTruthy();
    });
  }

  /** [Team, MANUAL] Publish the unit → available (pure setup → API listing-status). */
  teamPublishesUnit(unit: Unit): Promise<void> {
    return step('Team publishes the unit (available)', async () => {
      await this.publishUnit(unit.unitId);
    });
  }

  /** [App] The unit's voucher_size_accepted is set (API) — the missing-field follow-up
   *  landed on the record. */
  expectUnitVoucherSizeAccepted(unit: Unit, expected: number): Promise<void> {
    return step(`App: unit voucher_size_accepted = ${expected}`, async () => {
      const res = await this.page.request.get(`${NEXT}/api/units/${unit.unitId}`);
      expect(res.ok()).toBeTruthy();
      const { unit: u } = (await res.json()) as { unit: { voucher_size_accepted?: number } };
      expect(u.voucher_size_accepted).toBe(expected);
    });
  }

  /**
   * [App] Onboarding complete: the unit is available, its public flyer is live (the
   * "[AUTO] Listing link generated and shareable"), AND Team SEES it Available with the
   * "Voucher size accepted" row on the property detail.
   */
  expectUnitAvailableWithListingLink(unit: Unit): Promise<void> {
    return step('App: unit available + flyer live + shown on property detail', async () => {
      const res = await this.page.request.get(`${NEXT}/api/units/${unit.unitId}`);
      expect(res.ok()).toBeTruthy();
      const { unit: u } = (await res.json()) as { unit: { status?: string } };
      expect(u.status).toBe('available');

      const flyer = await this.page.request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
      expect(flyer.ok()).toBeTruthy();

      await this.page.goto(`${NEXT}/listings/${unit.unitId}`);
      const details = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Property details' }) });
      await expect(details.getByText('Voucher size accepted')).toBeVisible();
      await expect(this.page.getByText('Available', { exact: true }).first()).toBeVisible();
    });
  }

  /**
   * [App] Hand off to Property Sharing & Matching — the unit is `available` and appears
   * in GET /api/units?status=available (the surface the Sending-Unit sequence browses).
   */
  expectHandoffToMatching(unit: Unit): Promise<void> {
    return step('App: unit hands off to Matching (available list)', async () => {
      await expect
        .poll(
          async () => {
            const res = await this.page.request.get(`${NEXT}/api/units?status=available&limit=100`);
            if (!res.ok()) return false;
            const { units } = (await res.json()) as { units: Array<{ unitId: string }> };
            return units.some((u) => u.unitId === unit.unitId);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    });
  }

  /** The active contact id — landlord scenarios need it to create a unit under the landlord. */
  landlordId(): string {
    return this.requireActiveContactId();
  }

  // ---- internal helpers ---------------------------------------------------

  /** Set the landlord lead status via the edit-form Status select (exact:true — a
   *  loose /Status/ also matches "Contract status"). */
  private async setLandlordStatus(label: string): Promise<void> {
    await this.openEditDialog();
    const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
    await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption({ label });
    await this.saveEditDialog(dialog);
  }

  /** Open the Edit-contact dialog on the active contact (navigating to it first). */
  private async openEditDialog(): Promise<void> {
    await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
    await this.page.getByRole('button', { name: 'Edit contact details' }).click();
    const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
    await expect(dialog).toBeVisible();
  }

  /** Save the Edit-contact dialog and wait for it to close. */
  private async saveEditDialog(dialog: import('@playwright/test').Locator): Promise<void> {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  }

  /** Publish a unit to `available` via the listing-status route. */
  private async publishUnit(unitId: string): Promise<void> {
    const res = await this.page.request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(res.ok()).toBeTruthy();
  }

  private requireActiveFirstName(): string {
    if (!this.activeFirstName)
      throw new Error('no active tenant first name — create the tenant first');
    return this.activeFirstName;
  }

  private requireActiveTenant(): Tenant {
    if (!this.activeTenant) throw new Error('no active tenant — call tenantTexts/tenantCalls first');
    return this.activeTenant;
  }

  private requireActiveContactId(): string {
    if (!this.activeContactId) throw new Error('no active contact — triage/create one first');
    return this.activeContactId;
  }

  /** Register the tenant's number as an ad-hoc party once (send-as-party requires it). */
  private async ensureParty(t: Tenant): Promise<void> {
    if (this.registered.has(t.phone)) return;
    await registerParty(this.request, { label: t.name, role: 'tenant', number: t.phone });
    this.registered.add(t.phone);
  }

  /** Poll the unknown-contacts API until the inbound has auto-captured a contact for
   *  this phone, and return its contactId (E.164 match — the API returns raw E.164). */
  private async resolveUnknownContactId(t: Tenant): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const res = await this.page.request.get(`${NEXT}/api/contacts?type=unknown`);
          if (!res.ok()) return false;
          const { contacts } = (await res.json()) as {
            contacts: Array<{ contactId: string; phone?: string }>;
          };
          id = contacts.find((c) => c.phone === t.phone)?.contactId;
          return id !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return id as string;
  }

  /** The current contact page URL ends in /contacts/<id>; pull the id from it. */
  private async readActiveContactId(): Promise<string> {
    const m = /\/contacts\/([^/?#]+)/.exec(this.page.url());
    if (!m || m[1] === 'unknown') {
      return this.resolveUnknownContactId(this.requireActiveTenant());
    }
    return m[1]!;
  }

  /** Navigate to the active contact's page (resolving its id first if needed). */
  private async openActiveContact(t: Tenant): Promise<void> {
    const id = this.activeContactId ?? (await this.resolveUnknownContactId(t));
    this.activeContactId = id;
    await this.page.goto(`${NEXT}/contacts/${id}`);
  }

  /** Open the edit form, set identity fields, save. (Intake/RTA verbs added in Task 7.) */
  private async editTenantIdentity(fields: {
    firstName?: string;
    lastName?: string;
    voucherSize?: number;
    housingAuthority?: string;
  }): Promise<void> {
    await this.page.getByRole('button', { name: 'Edit contact details' }).click();
    const dialog = this.page.getByRole('dialog', { name: /Edit contact/i });
    await expect(dialog).toBeVisible();
    if (fields.firstName !== undefined) await dialog.getByLabel('First name').fill(fields.firstName);
    if (fields.lastName !== undefined) await dialog.getByLabel('Last name').fill(fields.lastName);
    if (fields.voucherSize !== undefined)
      await dialog.getByLabel('Voucher size (bedrooms)').fill(String(fields.voucherSize));
    if (fields.housingAuthority !== undefined)
      await dialog.getByLabel('Housing authority').fill(fields.housingAuthority);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  }

  private async assertStatus(expected: string): Promise<void> {
    const res = await this.page.request.get(`${NEXT}/api/contacts/${this.requireActiveContactId()}`);
    expect(res.ok()).toBeTruthy();
    const { contact } = (await res.json()) as { contact: { status?: string } };
    expect(contact.status).toBe(expected);
  }

  /** Page through GET /api/contacts?type=tenant (following nextCursor via ?cursor=)
   *  until a contact whose primary phone === `phone` is found; returns its contactId.
   *  Polls because the public self-serve create may lag the request. */
  private async findTenantContactIdByPhone(phone: string): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          let cursor: string | null = null;
          do {
            const url = `${NEXT}/api/contacts?type=tenant${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const res = await this.page.request.get(url);
            if (!res.ok()) return false;
            const body = (await res.json()) as {
              contacts: Array<{ contactId: string; phone?: string }>;
              nextCursor: string | null;
            };
            const hit = body.contacts.find((c) => c.phone === phone);
            if (hit) {
              id = hit.contactId;
              return true;
            }
            cursor = body.nextCursor;
          } while (cursor);
          return false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return id as string;
  }
}
