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
import { fakeUrl } from '../support/urls.js';
import { tenantCallNoAnswer, findOutboundCall } from '../fixtures/fakeVoice.js';
import {
  verifyCell,
  driveBridge,
  callTimeline,
  legPhones,
  uniqueVoicePhone,
} from '../fixtures/voiceSetup.js';

// Read the resolved dashboard URL from the env (set by playwright.config.ts at
// config load from the lane resolver). Fall back to the lane-0 dev default so
// `npm run e2e:session` without Playwright still has a sane value.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
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

// ==== Tour scheduling + reminder-ladder vocabulary (tours-sequence) ==========

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A contact's display name as the app resolves it for relay rosters/prefixes
 *  (contactsRepo firstName+lastName via nameFromContact — NOT Contact.name,
 *  which is a test-local label with a different shape). */
function displayNameOf(c: Contact): string {
  return `${c.firstName} ${c.lastName}`;
}

/** The reminder rungs the tour ladder arms at booking. */
export type ReminderKind =
  | 'confirmation'
  | 'day_before'
  | 'morning_of'
  | 'en_route'
  | 'no_show_checkin';

/** VERBATIM rung bodies (app/src/jobs/tourReminders.ts REMINDER_BODIES) — the
 *  test-pinned contract; asserted by exact body equality in the fake threads. */
export const TOUR_REMINDER_BODIES: Record<ReminderKind, string> = {
  confirmation: "[AUTO] Your tour is confirmed. We'll send reminders as it approaches.",
  day_before: '[AUTO] Reminder: your property tour is tomorrow.',
  morning_of: '[AUTO] Good morning! Your property tour is today.',
  en_route: "[AUTO] Your tour is coming up soon. Text us when you're on the way!",
  no_show_checkin: '[AUTO] Hi! We noticed you may have missed your tour. Want to reschedule?',
};

/** A booking time + the reminder-ladder dueAts the backend will arm off it. */
export interface TourTimes {
  /** The raw datetime-local value the Book/Reschedule forms send ('YYYY-MM-DDTHH:mm'). */
  scheduledAtLocal: string;
  /** dueAt of each pre-computed rung, full-ms ISO — feed `justAfter(x)` to the tick. */
  dayBefore: string;
  morningOf: string;
  enRoute: string;
  noShowCheckin: string;
}

/** Format a Date's LOCAL components as a datetime-local input value. */
function toDatetimeLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Pick a tour time `hoursFromNow` out (default 48h — far enough that EVERY rung
 * is in the future at booking, so the whole ladder arms; day_before = sched-24h
 * must beat the wall clock) and pre-compute the rung dueAts EXACTLY as the
 * backend does (tourReminders.ts computeDueAt): the dashboard forms send the raw
 * datetime-local value and the app parses it with new Date() (host-local tz), so
 * parsing the same string here yields byte-identical dueAt ISO strings.
 * `confirmation` is not computed — its dueAt is the server's arm-time "now"
 * (tick with no `now` fires it immediately).
 */
export function tourSchedule(hoursFromNow = 48): TourTimes {
  const sched = new Date(Date.now() + hoursFromNow * 3_600_000);
  sched.setSeconds(0, 0);
  const scheduledAtLocal = toDatetimeLocal(sched);
  const parsed = new Date(scheduledAtLocal); // mirror the backend's parse of the raw form value
  const t = parsed.getTime();
  return {
    scheduledAtLocal,
    dayBefore: new Date(t - 24 * 3_600_000).toISOString(),
    morningOf: new Date(
      Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 8, 0, 0, 0),
    ).toISOString(),
    enRoute: new Date(t - 2 * 3_600_000).toISOString(),
    noShowCheckin: new Date(t + 30 * 60_000).toISOString(),
  };
}

/** 1s past an ISO instant — a tick `now` that fires exactly the rungs due ≤ it. */
export function justAfter(iso: string): string {
  return new Date(Date.parse(iso) + 1_000).toISOString();
}

/** Masked relay pool numbers minted by the fake (+1555019xxxx). */
const POOL_NUMBER_RE = /^\+1555019\d{4}$/;

export class Scenario {
  private activeContactId: string | null = null;
  private activeTenant: Tenant | null = null;
  /** First name of the active tenant — to locate their broadcast preview row. */
  private activeFirstName: string | null = null;
  /** The navigator's VERIFIED cell for masked outbound calling — verified once per
   *  scenario (teamMaskedCallsLandlord), reused on any re-call. Null until verified. */
  private activeNavCell: string | null = null;
  /** The tour the scenario is driving (set by teamCreatesTourFromInterest); the
   *  group fields fill in when teamOpensTourGroup provisions the masked relay. */
  private activeTour: { tourId: string; poolNumber?: string; groupThreadId?: string } | null = null;
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
  // available units); Tours is now a BUILT, first-class workflow (see the tour
  // verbs below) — the loop-exit handoff creates a real timeless tour record
  // while the tenant stays `searching` (touring never changes tenant status).

  /**
   * [Setup] Create an AVAILABLE property the team can send. Pure setup → API:
   * POST /api/units starts a property in 'setup', then PATCH …/listing-status
   * publishes it to 'available' (the only shareable status). beds defaults to the
   * tenant's voucher size so it lands in the broadcast's pre-filled audience.
   * `landlordId` defaults to the seeded landlord; tour scenarios pass their own
   * fresh landlord so the tour-relay auto-resolve finds a landlord WITH a phone.
   */
  seedAvailableUnit(opts: { beds: number; jurisdiction?: string; landlordId?: string }): Promise<Unit> {
    return step(`Setup: an available ${opts.beds}-BR property to send`, async () => {
      seq += 1;
      // Run-unique street number (same rationale as freshContact): `seq` alone
      // resets when Playwright restarts the worker after a failure while the
      // DB persists — a bare `${200+seq}` then re-mints a duplicate address and
      // any address-based locator (Unit typeahead option, Tours-card row) hits
      // a strict-mode collision. The timestamp keeps addresses unique per run.
      const addressLine1 = `${`${Date.now()}`.slice(-5)}${seq} Sender Way NW`;
      const created = await this.page.request.post(`${NEXT}/api/units`, {
        data: {
          landlordId: opts.landlordId ?? SEEDED_LANDLORD,
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
   * [App] Loop exit — a listing fits → hand off to the Tours workflow (a BUILT,
   * first-class entity: documentation/tours-sequence.mermaid). The handoff signal
   * is now a REAL tour record: a timeless ('requested') tour exists for this
   * tenant + the fitting unit (GET /api/tours?tenantId=), Team SEES the row on
   * the tenant's Tours card ('Not booked' + 'Requested'), and the tenant stays
   * `searching` (touring never changes tenant status — no placement yet).
   */
  expectHandoffToTours(fittingUnit: Unit): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App: a listing fits → hand off to Tours (tour record, tenant stays searching)', async () => {
      const res = await this.page.request.get(`${NEXT}/api/tours?tenantId=${encodeURIComponent(id)}`);
      expect(res.ok()).toBeTruthy();
      const { tours } = (await res.json()) as { tours: Array<{ unitId: string; status: string }> };
      expect(tours.some((t) => t.unitId === fittingUnit.unitId)).toBe(true);
      await this.assertStatus('searching');
      await this.page.goto(`${NEXT}/contacts/${id}`);
      // Team SEES the tour on the Tours card: the row reads "<address> · Not
      // booked" with the status LABEL 'Requested' on the right (never raw enums).
      const toursCard = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Tours' }) });
      await expect(
        toursCard.getByRole('link').filter({ hasText: fittingUnit.addressLine1 }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(toursCard.getByText('Not booked')).toBeVisible();
      await expect(toursCard.getByText('Requested')).toBeVisible();
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
   * landlord lead contact from the sourced lead (needs_review) — the masked call is
   * placed FROM the contact." This verb ONLY creates the lead; the app-placed masked
   * cold call is a separate move (see {@link teamMaskedCallsLandlord}), matching the
   * updated diagram where the cold call IS a Voice Phase 1 masked outbound call.
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

  /**
   * [Team→App→Landlord] Place a MASKED OUTBOUND cold call to the active landlord lead,
   * driving the REAL dashboard Call menu. Maps to the diagram's cold-call branch:
   *
   *   S->>A: Place a masked outbound call to the landlord (from the contact)
   *   [AUTO] Masked outbound call (Voice Phase 1) — the app rings the Team member's
   *          verified cell, then bridges to the landlord from the app's number; the
   *          landlord never sees the personal cell. Recorded.
   *   A->>L: Deliver the call (caller ID = the app's number)
   *
   * Moves, in order:
   *   1. SETUP (idempotent) — the seeded VA (the logged-in navigator) needs a VERIFIED
   *      cell or the originate route 409s `cell_not_verified`. A fresh scenario VA has
   *      none, so verify one via the shared self-service path (verify-start → outbox
   *      code → verify-confirm) using a unique cell number. `activeNavCell` guards it so
   *      a re-call in the same scenario reuses the already-verified cell.
   *   2. PLACE — navigate to the active landlord contact page, open CallMenu.tsx, click
   *      the number to POST /api/contacts/:id/call. We capture the originate response
   *      (waitForResponse) to read { callSid }, and assert the "Calling…" role=status
   *      affordance appears (the 200 path). This exercises the REAL CallMenu wiring AND
   *      yields the callSid the bridge needs.
   *   3. BRIDGE — resolve the fake's paused navigator-leg call by callSid, then press '1'
   *      (driveBridge) to run whisper → gate → <Dial> the landlord from the business
   *      number → recording, exactly as the navigator pressing 1 on their ringing cell.
   *   4. ASSERT — the outbound masked call lands on the LANDLORD thread as a kind:'call',
   *      call_outcome:'answered' timeline entry; the fake bridge proves the caller ID is
   *      the app's business number (never the navigator's cell) and the landlord is the
   *      dialed <Number> leg. MASKING/PII: the navigator's personal cell appears NOWHERE
   *      in the thread, and no masked party LABEL is exposed on the wire (the landlord's
   *      own number surfaces only in the 1:1 `party_phone` slot — its own-thread number,
   *      not a masked-counterpart leak).
   *
   * Leaves activeContactId / activeTenant untouched so later steps (interested/declines
   * branch, onboarding, unit intake) operate on the same landlord lead.
   */
  teamMaskedCallsLandlord(): Promise<void> {
    const id = this.requireActiveContactId();
    return step('Team places a masked outbound cold call to the landlord', async () => {
      const api = this.page.request;

      // 1. SETUP — verify the navigator's cell once per scenario (idempotent).
      if (this.activeNavCell === null) {
        this.activeNavCell = await verifyCell(api, uniqueVoicePhone());
      }
      const navCell = this.activeNavCell;

      // 2. PLACE — drive the REAL CallMenu and capture the originate { callSid }.
      await this.page.goto(`${NEXT}/contacts/${id}`);
      await expect(this.page.getByRole('heading', { name: 'Details' })).toBeVisible();
      const callTrigger = this.page.getByRole('button', { name: /📞 Call/ });
      await callTrigger.click();
      const menu = this.page.getByRole('menu');
      await expect(menu).toBeVisible();
      const [originate] = await Promise.all([
        this.page.waitForResponse(
          (r) =>
            /\/api\/contacts\/[^/]+\/call$/.test(r.url()) && r.request().method() === 'POST',
        ),
        menu.getByRole('menuitem').first().click(),
      ]);
      expect(originate.status(), await originate.text()).toBe(200);
      const { callSid } = (await originate.json()) as { callSid: string };
      expect(typeof callSid).toBe('string');
      expect(callSid.length).toBeGreaterThan(0);
      // The UI confirms the navigator's cell is ringing (the 200 "calling" affordance).
      await expect(this.page.getByRole('status').filter({ hasText: /Calling your cell/i })).toBeVisible();

      // 3. BRIDGE — resolve the paused navigator leg, then press '1' to run the dial chain.
      const paused = await findOutboundCall(api, callSid);
      expect(paused, 'fake did not record an outbound call for the originate').toBeDefined();
      const bridged = await driveBridge(api, callSid);
      expect(bridged.status).toBe('completed');

      // 4a. Masked delivery (caller ID = the app's business number, NOT the nav cell);
      //     the landlord is the dialed <Number> leg. `direction` is outbound at the app.
      expect(bridged.from).toBe(APP_NUMBER);
      expect(bridged.from).not.toBe(navCell);
      const landlordPhone = this.requireActiveTenant().phone;
      expect(legPhones(bridged)).toContain(landlordPhone);

      // 4b. The persisted call entry lands on the LANDLORD thread: kind:'call', answered.
      let entry: Record<string, unknown> | undefined;
      await expect
        .poll(
          async () => {
            const calls = await callTimeline(api, id); // ascending; the cold call is last
            entry = calls[calls.length - 1];
            return entry ? { kind: entry['kind'], outcome: entry['call_outcome'] } : null;
          },
          { timeout: 10_000 },
        )
        .toEqual({ kind: 'call', outcome: 'answered' });

      // 4c. PII / masking invariant — the navigator's PERSONAL cell is the number
      //     masking exists to protect, and it must NEVER appear anywhere in the
      //     landlord thread. The wire timeline also exposes NO masked party LABEL that
      //     could carry a raw phone: `call_party_label` (the "Landlord (Jane D.)" role
      //     label stored on the entry) is omitted from the projection entirely, so the
      //     only phone that can surface is the landlord's OWN number in the 1:1
      //     `party_phone` slot (its own-thread number — same as any inbound call, not a
      //     masked-counterpart leak). Assert: no nav cell, and no label field present.
      const entries = await callTimeline(api, id);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain(navCell);
      for (const e of entries) {
        expect(e).not.toHaveProperty('call_party_label');
        // The stored masked role label is role/name only — never a raw phone. Assert
        // the honest label the app persists carries neither party's number.
      }
      // The landlord's number appears ONLY as its own-thread party_phone (never in a
      // label), and the navigator cell appears nowhere.
      const last = entries[entries.length - 1] ?? {};
      if ('party_phone' in last) expect(last['party_phone']).toBe(landlordPhone);
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

  // ==== Tours verbs (documentation/tours-sequence.mermaid) ====================
  // Audited live against the lane stack (2026-07-02). Structural rules encoded:
  //   - The tour record is created at INTEREST, timeless ('requested'); booking
  //     (setting the time) is what arms the reminder ladder.
  //   - Masked groups are Team-created BY HAND (a TourDetail button click) —
  //     never auto-created; reminders route to the GROUP for landlord_led/pm_team
  //     tours with a group, and to the tenant 1:1 otherwise (incl. ALL self_guided).
  //   - Group proof-of-send = the fake threads: every member receives from the
  //     POOL number (+1555019xxxx), member messages arrive masked as "Name: body".
  //   - The tick seam (POST /__dev/tour-reminders/tick) is GLOBAL — assertions
  //     scope to THIS scenario's phones; the worker's 60s wall-clock poll may
  //     also fire a due rung, so we assert ARRIVAL, never which trigger fired.
  //   - Tours never create a placement or change tenant status (exit gate only
  //     records outcome/moveForward/convertible; tenant stays `searching`).

  /** [Setup] Precondition handed off from the UPSTREAM sequences (onboarding →
   *  sending-unit): the tenant is already `searching` (RTA in hand). That gate
   *  is the onboarding diagram's move, not this one's — pure setup → the API
   *  tenant-status route. */
  seedTenantSearching(): Promise<void> {
    const id = this.requireActiveContactId();
    return step('Setup: tenant is searching (handed off from Sending Unit)', async () => {
      const res = await this.page.request.patch(`${NEXT}/api/contacts/${id}/tenant-status`, {
        data: { toStatus: 'searching', source: 'manual' },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    });
  }

  /** [Tenant→App→Team] The tenant asks to tour a specific property; the app
   *  relays it to Team (the inbound surfaces on the tenant's timeline). */
  tenantAsksToTour(unit: Unit): Promise<void> {
    const t = this.requireActiveTenant();
    const id = this.requireActiveContactId();
    return step(`Tenant texts: "I would like to tour this one" (${unit.addressLine1})`, async () => {
      await this.ensureParty(t);
      await sendAsParty(this.request, {
        from: t.phone,
        to: APP_NUMBER,
        body: `I would like to tour this one — ${unit.addressLine1}`,
      });
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const timeline = this.page.getByRole('region', { name: 'Communications and activity' });
      await expect(timeline.getByText(/would like to tour/i)).toBeVisible({ timeout: 10_000 });
    });
  }

  /**
   * [Team, MANUAL] Create the tour record for this tenant + unit — NO tour time
   * yet (the coordination anchor). Drives the REAL "Schedule a tour" dialog from
   * the tenant page (Tours card '+ Schedule'); the date field is left EMPTY so
   * the tour is created timeless → status 'Requested', nothing armed. On create
   * the app navigates to /tours/:tourId; the tourId is captured for later verbs.
   */
  teamCreatesTourFromInterest(
    unit: Unit,
    tourType: 'Self-guided' | 'Landlord-led' | 'PM team',
  ): Promise<string> {
    const id = this.requireActiveContactId();
    return step(`Team creates the tour record (${tourType}, no time yet)`, async () => {
      await this.page.goto(`${NEXT}/contacts/${id}`);
      await this.page.getByRole('button', { name: 'Schedule a tour' }).click();
      const dialog = this.page.getByRole('dialog', { name: 'Schedule a tour' });
      await expect(dialog).toBeVisible();
      // The tenant side is pre-filled + LOCKED (the dialog was opened from the
      // tenant's file); the unit side is a typeahead over the property roster.
      await expect(dialog.getByRole('group', { name: 'Tenant' })).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Unit' }).fill(unit.addressLine1);
      await dialog
        .getByRole('option', { name: new RegExp(escapeRegExp(unit.addressLine1)) })
        .click();
      await dialog.getByLabel('Tour type').selectOption({ label: tourType });
      // 'Date and time' stays EMPTY — "Leave empty to create the tour without a
      // time — book it later." (the diagram's timeless create).
      await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
      await this.page.waitForURL(/\/tours\/[^/?#]+$/, { timeout: 10_000 });
      const m = /\/tours\/([^/?#]+)/.exec(this.page.url());
      if (!m) throw new Error('teamCreatesTourFromInterest: expected a /tours/:tourId URL after create');
      const tourId = decodeURIComponent(m[1]!);
      this.activeTour = { tourId };
      // Requested + not booked — the rendered LABELS, never raw enums.
      await expect(this.page.getByLabel('Status: Requested')).toBeVisible();
      await expect(this.page.getByLabel('Scheduled: Not yet booked')).toBeVisible();
      return tourId;
    });
  }

  /**
   * [Team, MANUAL] Open the masked relay group ON the tour (TourDetail button —
   * groups are always Team-created by hand in Phase 1). Members are auto-resolved
   * server-side ([tenant, unit's landlord]); the 201 response is captured to
   * record the pool number + groupThreadId for the group assertions.
   */
  teamOpensTourGroup(): Promise<void> {
    const tour = this.requireActiveTour();
    return step('Team opens the masked relay group on the tour', async () => {
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      const [res] = await Promise.all([
        this.page.waitForResponse(
          (r) => /\/api\/tours\/[^/]+\/relay$/.test(r.url()) && r.request().method() === 'POST',
        ),
        this.page
          .getByRole('button', { name: 'Open a masked group thread for this tour' })
          .click(),
      ]);
      expect(res.status(), await res.text()).toBe(201);
      const { tour: updated, conversation } = (await res.json()) as {
        tour: { groupThreadId?: string };
        conversation: { conversationId: string; pool_number?: string };
      };
      expect(conversation.pool_number).toMatch(POOL_NUMBER_RE);
      expect(updated.groupThreadId).toBe(conversation.conversationId);
      tour.poolNumber = conversation.pool_number as string;
      tour.groupThreadId = conversation.conversationId;
      // The 'Group thread' row + link appear once the tour carries the thread
      // id. exact:true — a loose 'Group thread' also matches the link text
      // 'View group thread' (strict-mode violation, seen live).
      await expect(this.page.getByText('Group thread', { exact: true })).toBeVisible();
      await expect(
        this.page.getByRole('link', { name: 'Open group thread in inbox' }),
      ).toBeVisible();
    });
  }

  /** [App→each member, AUTO] The intro message naming everyone connected reached
   *  EVERY member's fake thread FROM the pool number. */
  expectGroupIntros(members: Contact[]): Promise<void> {
    const pool = this.requireActiveTourGroup().poolNumber;
    return step('App sends the group intros (naming everyone connected)', async () => {
      const names = members.map(displayNameOf);
      for (const member of members) {
        await expect
          .poll(
            async () => {
              const threads = await listThreads(this.request);
              const thread = threads.find((x) => x.partyNumber === member.phone);
              return (
                thread?.messages.some(
                  (m) =>
                    m.direction === 'outbound' &&
                    m.from === pool &&
                    /You're now connected with/.test(m.body ?? '') &&
                    names.every((n) => (m.body ?? '').includes(n)),
                ) ?? false
              );
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }
    });
  }

  /** [Member→App] A party (tenant or landlord/PM) texts the GROUP: an inbound to
   *  the tour's pool number via the fake seam. `role` labels the persona on the
   *  fake registry (first registration wins; role-agnostic for send-as-party). */
  partyProposesTimeInGroup(
    party: Contact,
    body: string,
    role: 'tenant' | 'landlord' | 'pm' = 'tenant',
  ): Promise<void> {
    const pool = this.requireActiveTourGroup().poolNumber;
    return step(`${displayNameOf(party)} texts the group: "${body}"`, async () => {
      await this.ensureParty(party, role);
      await sendAsParty(this.request, { from: party.phone, to: pool, body });
    });
  }

  /** [App→member, AUTO] The group message was relayed MASKED to another member:
   *  arrives FROM the pool number as "<Sender Name>: <body>" — never a phone. */
  expectRelayedInGroup(recipient: Contact, sender: Contact, body: string): Promise<void> {
    const pool = this.requireActiveTourGroup().poolNumber;
    const masked = `${displayNameOf(sender)}: ${body}`;
    return step(`App relays in the group (masked) → ${displayNameOf(recipient)}`, async () => {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(this.request);
            const thread = threads.find((x) => x.partyNumber === recipient.phone);
            return (
              thread?.messages.some(
                (m) => m.direction === 'outbound' && m.from === pool && m.body === masked,
              ) ?? false
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    });
  }

  /** [Team, MANUAL] Book the tour: set the agreed date/time on the 'requested'
   *  tour via the TourDetail Book control. Booking auto-advances to 'Scheduled'
   *  and arms the reminder ladder off the booked time (server-side). */
  teamBooksTour(times: TourTimes): Promise<void> {
    const tour = this.requireActiveTour();
    return step(`Team books the tour (${times.scheduledAtLocal})`, async () => {
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      await this.page.getByRole('button', { name: 'Book this tour' }).click();
      const form = this.page.getByRole('form', { name: 'Book tour form' });
      await expect(form).toBeVisible();
      // datetime-local input — fill takes the raw 'YYYY-MM-DDTHH:mm' value; the
      // form sends it as-is (valid ISO for the backend's Date.parse).
      await form.getByLabel('Date and time').fill(times.scheduledAtLocal);
      await form.getByRole('button', { name: 'Confirm booking' }).click();
      await expect(this.page.getByLabel('Status: Scheduled')).toBeVisible({ timeout: 10_000 });
    });
  }

  /**
   * [App, AUTO — dev seam] One deterministic tour-reminder poll pass. Omitting
   * `now` uses the server wall clock (fires the just-armed 'confirmation' rung);
   * pass `justAfter(times.<rung>)` to fire a future rung. GLOBAL: fires every
   * due row in the DB — callers assert arrival scoped to THEIR OWN phones only.
   */
  tickTourReminders(nowIso?: string): Promise<void> {
    return step(`App: reminder poll ticks${nowIso !== undefined ? ` (now=${nowIso})` : ''}`, async () => {
      const res = await this.page.request.post(`${NEXT}/__dev/tour-reminders/tick`, {
        data: nowIso !== undefined ? { now: nowIso } : {},
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    });
  }

  /** [App→group, AUTO] A reminder rung landed in EVERY member's fake thread FROM
   *  the pool number (the founder routing rule for landlord_led/pm_team tours). */
  expectReminderInGroup(kind: ReminderKind, members: Contact[]): Promise<void> {
    const pool = this.requireActiveTourGroup().poolNumber;
    const body = TOUR_REMINDER_BODIES[kind];
    return step(`App: '${kind}' reminder lands in the group (every member)`, async () => {
      for (const member of members) {
        await expect
          .poll(
            async () => {
              const threads = await listThreads(this.request);
              const thread = threads.find((x) => x.partyNumber === member.phone);
              return (
                thread?.messages.some(
                  (m) => m.direction === 'outbound' && m.from === pool && m.body === body,
                ) ?? false
              );
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }
    });
  }

  /** [App→Tenant, AUTO] A reminder rung landed in the tenant's 1:1 thread FROM
   *  the APP number (self_guided always; landlord_led with no group falls back).
   *  `atLeast` supports the re-armed-ladder assert (a 2nd 'confirmation' copy). */
  expectReminderTo1to1(kind: ReminderKind, t: Tenant, atLeast = 1): Promise<void> {
    const body = TOUR_REMINDER_BODIES[kind];
    return step(`App: '${kind}' reminder lands 1:1 with the tenant (×${atLeast})`, async () => {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(this.request);
            const thread = threads.find((x) => x.partyNumber === t.phone);
            return (
              thread?.messages.filter(
                (m) => m.direction === 'outbound' && m.from === APP_NUMBER && m.body === body,
              ).length ?? 0
            );
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(atLeast);
    });
  }

  /** [Tenant→App] "On my way" — the tenant texts the GROUP thread. */
  tenantSendsOnMyWay(): Promise<void> {
    const t = this.requireActiveTenant();
    const pool = this.requireActiveTourGroup().poolNumber;
    return step('Tenant texts the group: "On my way!"', async () => {
      await this.ensureParty(t);
      await sendAsParty(this.request, { from: t.phone, to: pool, body: 'On my way!' });
    });
  }

  /** [App→Landlord, AUTO] The en-route heads-up reached the landlord/PM in the
   *  group, masked ("<Tenant Name>: On my way!" from the pool number). */
  expectOnMyWayInGroup(landlord: Contact): Promise<void> {
    const t = this.requireActiveTenant();
    return this.expectRelayedInGroup(landlord, t, 'On my way!');
  }

  /** [Team, MANUAL] Confirm the scheduled tour (TourDetail control). */
  teamConfirmsTour(): Promise<void> {
    return this.tourStatusAction('Confirm this tour', 'Confirmed', 'Team confirms the tour');
  }

  /** [Team, MANUAL] Log the tour outcome: toured (TourDetail control) — this is
   *  what makes the exit gate reachable. */
  teamMarksToured(): Promise<void> {
    return this.tourStatusAction('Mark this tour as toured', 'Toured', 'Team logs the tour outcome (toured)');
  }

  /** [Team, MANUAL] Log a no-show (TourDetail control). No-show tours stay
   *  reschedulable. */
  teamMarksNoShow(): Promise<void> {
    return this.tourStatusAction('Mark this tour as a no-show', 'No show', 'Team logs a no-show');
  }

  /** [Team, MANUAL] Reschedule the tour to a new time — cancels the pending
   *  ladder and RE-ARMS it off the new time (asserted by a fresh confirmation). */
  teamReschedulesTour(times: TourTimes): Promise<void> {
    const tour = this.requireActiveTour();
    return step(`Team reschedules the tour (${times.scheduledAtLocal})`, async () => {
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      await this.page.getByRole('button', { name: 'Reschedule this tour' }).click();
      const form = this.page.getByRole('form', { name: 'Reschedule tour form' });
      await expect(form).toBeVisible();
      await form.getByLabel('New date and time').fill(times.scheduledAtLocal);
      await form.getByRole('button', { name: 'Confirm reschedule' }).click();
      await expect(this.page.getByLabel('Status: Scheduled')).toBeVisible({ timeout: 10_000 });
    });
  }

  /** [Team→App→Tenant] Self-guided scheduling: Team offers tour windows in the
   *  tenant's 1:1 thread (no group — nothing mutual to negotiate). */
  teamOffersTourWindows(windows: string): Promise<void> {
    const t = this.requireActiveTenant();
    return step(`Team offers tour windows: "${windows}"`, async () => {
      await this.teamTexts1to1(windows);
      await this.expectDeliveredToTenant(t, new RegExp(escapeRegExp(windows)));
    });
  }

  /** [Tenant→App→Team] The tenant picks a window; the app relays the choice
   *  (surfaces on the tenant's timeline). */
  tenantPicksWindow(choice: string): Promise<void> {
    const t = this.requireActiveTenant();
    const id = this.requireActiveContactId();
    return step(`Tenant picks a window: "${choice}"`, async () => {
      await this.ensureParty(t);
      await sendAsParty(this.request, { from: t.phone, to: APP_NUMBER, body: choice });
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const timeline = this.page.getByRole('region', { name: 'Communications and activity' });
      await expect(timeline.getByText(new RegExp(escapeRegExp(choice)))).toBeVisible({
        timeout: 10_000,
      });
    });
  }

  /** [Team→App→Tenant] The ID gate opens: ask for a photo ID ahead of the tour
   *  window (self-guided only — NO ID, NO code, ever). */
  teamRequestsPhotoId(): Promise<void> {
    const t = this.requireActiveTenant();
    return step('Team asks for a photo ID ahead of the tour window', async () => {
      await this.teamTexts1to1('Before your tour window, please text us a photo ID.');
      await this.expectDeliveredToTenant(t, /photo ID/i);
    });
  }

  /**
   * [Tenant→App→Team] The tenant sends the photo ID and Team reviews it (= sees
   * it on the timeline). Sent as a REAL MMS: the media URL is one of the fake's
   * canned raster images (/canned/room.png, served from the fake's own host) —
   * the app's inbound mirror allowlists the configured fake origin
   * (TWILIO_API_BASE_URL) alongside api.twilio.com, so the attachment mirrors
   * cleanly (verified live: no MediaFetchRefusedError / media errors in the app
   * log). The invariant this suite asserts is the GATE ORDERING (no code before
   * the ID), not media plumbing.
   */
  tenantSendsPhotoId(): Promise<void> {
    const t = this.requireActiveTenant();
    const id = this.requireActiveContactId();
    return step('Tenant sends the photo ID (MMS) — Team reviews it', async () => {
      await this.ensureParty(t);
      await sendAsParty(this.request, {
        from: t.phone,
        to: APP_NUMBER,
        body: 'Here is my photo ID',
        mediaUrls: [`${fakeUrl}/canned/room.png`],
      });
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const timeline = this.page.getByRole('region', { name: 'Communications and activity' });
      await expect(timeline.getByText(/Here is my photo ID/)).toBeVisible({ timeout: 10_000 });
    });
  }

  /** [App] GATE ORDERING: the access code has NOT been sent yet — the code
   *  string appears NOWHERE in the tenant's outbound thread so far. */
  expectNoLockboxCodeYet(code: string): Promise<void> {
    const t = this.requireActiveTenant();
    return step('App: no lockbox code sent yet (NO ID, NO code)', async () => {
      const threads = await listThreads(this.request);
      const thread = threads.find((x) => x.partyNumber === t.phone);
      const leaked =
        thread?.messages.some(
          (m) => m.direction === 'outbound' && (m.body ?? '').includes(code),
        ) ?? false;
      expect(leaked).toBe(false);
    });
  }

  /** [Team→App→Tenant] ID reviewed → send the lockbox access code in real time. */
  teamSendsLockboxCode(code: string): Promise<void> {
    const t = this.requireActiveTenant();
    return step('Team sends the lockbox access code', async () => {
      await this.teamTexts1to1(`ID looks good — lockbox code: ${code}`);
      await this.expectDeliveredToTenant(t, new RegExp(escapeRegExp(code)));
    });
  }

  /** [Team→App→Tenant] Post-tour feedback ask ("what did you think — want to
   *  move forward?"), Team-manual in Phase 1. */
  teamAsksFeedback(): Promise<void> {
    const t = this.requireActiveTenant();
    return step('Team asks for feedback (move forward?)', async () => {
      await this.teamTexts1to1('What did you think — want to move forward with this one?');
      await this.expectDeliveredToTenant(t, /move forward/i);
    });
  }

  /** [App→Team] A tenant inbound was relayed to Team — it surfaces on the
   *  tenant's contact timeline (the generic relay rule). */
  expectInboundRelayedToTeam(re: RegExp): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App relays the tenant reply to Team (contact timeline)', async () => {
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const timeline = this.page.getByRole('region', { name: 'Communications and activity' });
      await expect(timeline.getByText(re)).toBeVisible({ timeout: 10_000 });
    });
  }

  /** [Team, MANUAL] Record the exit-gate decision on the toured tour (the
   *  em-dash radio labels are part of the pinned contract). */
  teamRecordsExitGate(decision: 'yes' | 'no'): Promise<void> {
    const tour = this.requireActiveTour();
    const radio = decision === 'yes' ? 'Yes — move forward' : 'No — not a fit';
    const outcomeLabel = decision === 'yes' ? 'Move forward' : 'Not a fit';
    return step(`Team records the exit gate → ${radio}`, async () => {
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      await this.page.getByRole('button', { name: 'Record exit gate decision' }).click();
      const form = this.page.getByRole('form', { name: 'Exit gate form' });
      await expect(form).toBeVisible();
      await form.getByRole('radio', { name: radio }).check();
      await form.getByRole('button', { name: 'Save decision' }).click();
      // Wait for the form to CLOSE first (it closes only on a successful PATCH)
      // — getByText substring-matches, so asserting the outcome label while the
      // form is still open would match the radio's own text ('Yes — move
      // forward') and pass BEFORE the save landed (a race seen live).
      await expect(this.page.getByRole('form', { name: 'Exit gate form' })).toHaveCount(0, {
        timeout: 10_000,
      });
      // The Outcome row renders the decision LABEL once saved.
      const article = this.page.getByRole('article', { name: 'Tour details' });
      await expect(article.getByText(outcomeLabel)).toBeVisible();
    });
  }

  /** [App] Exit gate YES: the tour is CONVERTIBLE (API) and Team SEES the
   *  convertible row — and NOTHING ELSE moved (no placement, tenant untouched
   *  — asserted separately via expectNoPlacement/expectTenantStillSearching). */
  expectTourConvertible(): Promise<void> {
    const tour = this.requireActiveTour();
    return step('App: the tour is convertible (ready for Post-Tour & Application)', async () => {
      const res = await this.page.request.get(`${NEXT}/api/tours/${tour.tourId}`);
      expect(res.ok()).toBeTruthy();
      const { tour: t } = (await res.json()) as {
        tour: { convertible?: boolean; outcome?: string; moveForward?: boolean };
      };
      expect(t.outcome).toBe('move_forward');
      expect(t.moveForward).toBe(true);
      expect(t.convertible).toBe(true);
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      await expect(
        this.page.getByText('Yes — ready for placement (not yet converted)'),
      ).toBeVisible();
    });
  }

  /**
   * [Team, MANUAL] Close the tour (exit gate NO → "Close the tour"). TourDetail
   * has NO Close button (closing is not a shipped control), so the [MANUAL] step
   * is an authed API PATCH { status: 'closed' } — the same seam Team tooling
   * would call; the UI is then reloaded to assert the 'Closed' label renders.
   */
  teamClosesTour(): Promise<void> {
    const tour = this.requireActiveTour();
    return step('Team closes the tour', async () => {
      const res = await this.page.request.patch(`${NEXT}/api/tours/${tour.tourId}`, {
        data: { status: 'closed' },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      await expect(this.page.getByLabel('Status: Closed')).toBeVisible();
    });
  }

  /** [App] Exit gate NO: outcome not_a_fit, NOT convertible, tour closed
   *  (terminal). The tenant re-enters the Sending-Unit loop unchanged. */
  expectTourClosedNotAFit(): Promise<void> {
    const tour = this.requireActiveTour();
    return step('App: tour closed as not-a-fit (re-match — back to Sending Unit)', async () => {
      const res = await this.page.request.get(`${NEXT}/api/tours/${tour.tourId}`);
      expect(res.ok()).toBeTruthy();
      const { tour: t } = (await res.json()) as {
        tour: { status?: string; outcome?: string; convertible?: boolean };
      };
      expect(t.status).toBe('closed');
      expect(t.outcome).toBe('not_a_fit');
      expect(t.convertible).not.toBe(true);
    });
  }

  /** [App] The tenant is STILL `searching` — touring never changes tenant status
   *  (Team sees 'Searching' in the Details card). */
  expectTenantStillSearching(): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App: tenant stays searching (no status change from touring)', async () => {
      await this.assertStatus('searching');
      await this.page.goto(`${NEXT}/contacts/${id}`);
      const details = this.page
        .locator('section')
        .filter({ has: this.page.getByRole('heading', { name: 'Details' }) });
      await expect(details.getByText('Searching')).toBeVisible();
    });
  }

  /** [App] NO placement was created by any tour move (conversion belongs to
   *  Post-Tour & Application, a separate downstream sequence). */
  expectNoPlacement(): Promise<void> {
    const id = this.requireActiveContactId();
    return step('App: no placement exists for the tenant', async () => {
      const res = await this.page.request.get(
        `${NEXT}/api/placements?tenantId=${encodeURIComponent(id)}`,
      );
      expect(res.ok()).toBeTruthy();
      const { placements } = (await res.json()) as { placements: unknown[] };
      expect(placements).toHaveLength(0);
    });
  }

  /** [App] NO group thread EXISTS for this tour (self-guided default — the
   *  'Open group thread' button still shows because an admin MAY hand-create
   *  one, so the assert is on existence: no groupThreadId + no intro reached
   *  the tenant from any pool number). */
  expectNoTourGroup(): Promise<void> {
    const tour = this.requireActiveTour();
    const t = this.requireActiveTenant();
    return step('App: no group thread exists (self-guided default)', async () => {
      const res = await this.page.request.get(`${NEXT}/api/tours/${tour.tourId}`);
      expect(res.ok()).toBeTruthy();
      const { tour: got } = (await res.json()) as { tour: { groupThreadId?: string } };
      expect(got.groupThreadId).toBeUndefined();
      const threads = await listThreads(this.request);
      const thread = threads.find((x) => x.partyNumber === t.phone);
      const introFromPool =
        thread?.messages.some(
          (m) => m.direction === 'outbound' && POOL_NUMBER_RE.test(m.from),
        ) ?? false;
      expect(introFromPool).toBe(false);
    });
  }

  // ---- internal helpers ---------------------------------------------------

  /** Click a TourDetail status control and assert the new status LABEL renders. */
  private tourStatusAction(buttonAria: string, newLabel: string, stepName: string): Promise<void> {
    const tour = this.requireActiveTour();
    return step(stepName, async () => {
      await this.page.goto(`${NEXT}/tours/${tour.tourId}`);
      await this.page.getByRole('button', { name: buttonAria }).click();
      await expect(this.page.getByLabel(`Status: ${newLabel}`)).toBeVisible({ timeout: 10_000 });
    });
  }

  /** Team texts the ACTIVE tenant 1:1 from their contact page (the real reply box). */
  private async teamTexts1to1(body: string): Promise<void> {
    await this.page.goto(`${NEXT}/contacts/${this.requireActiveContactId()}`);
    await this.page.getByRole('textbox', { name: 'Reply message' }).fill(body);
    await this.page.getByRole('button', { name: 'Send' }).click();
    await expect(this.page.getByText(body)).toBeVisible();
  }

  private requireActiveTour(): { tourId: string; poolNumber?: string; groupThreadId?: string } {
    if (!this.activeTour) throw new Error('no active tour — call teamCreatesTourFromInterest first');
    return this.activeTour;
  }

  private requireActiveTourGroup(): { tourId: string; poolNumber: string; groupThreadId: string } {
    const tour = this.requireActiveTour();
    if (tour.poolNumber === undefined || tour.groupThreadId === undefined) {
      throw new Error('no tour group — call teamOpensTourGroup first');
    }
    return tour as { tourId: string; poolNumber: string; groupThreadId: string };
  }

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

  /** Register the contact's number as an ad-hoc party once (send-as-party requires
   *  it). `role` labels the persona on the fake registry (role-agnostic for
   *  send-as-party; the FIRST registration for a number wins). */
  private async ensureParty(t: Tenant, role: 'tenant' | 'landlord' | 'pm' | 'staff' = 'tenant'): Promise<void> {
    if (this.registered.has(t.phone)) return;
    await registerParty(this.request, { label: t.name, role, number: t.phone });
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
