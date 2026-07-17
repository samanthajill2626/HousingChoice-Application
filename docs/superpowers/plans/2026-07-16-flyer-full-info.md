<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-16).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Flyer Full-Info Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the teaser/intake/reveal flyer funnel with ONE public page showing all
tenant-useful unit info upfront, plus a bottom CTA that is an intake form (bare link) or a
tap-to-text button (`?cta=text`, what auto-sent [FlyerLink]s carry).

**Architecture:** Merge the two backend flyer projections into one allowlist and delete the
/details endpoint; the flyer payload (and the opaque 404 body) carry `contact_number` =
`config.ourPhoneNumbers[0]`. The FlyerFunnel component becomes FlyerPage: no stage machine,
variant chosen by the `cta` query param (stripped from the URL on load, persisted in
sessionStorage). Spec: docs/superpowers/specs/2026-07-16-flyer-full-info-design.md.

**Tech Stack:** Express + vitest/supertest (app), React 18 + react-router + testing-library
(dashboard), Playwright (e2e).

## Global Constraints

- ASCII only in every file this plan touches (verify: `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0). ONE exception: the ported "Loading" status paragraph keeps its existing non-ASCII ellipsis glyph, byte-identical from FlyerFunnel.tsx. All NEW copy is plain ASCII (hyphens, three dots).
- Tenant-facing copy calls the dwelling a "home" - never unit/property/listing.
- Every `do-not-remove` comment (A2P consent gates) stays byte-identical.
- The public projection stays a strict build-UP allowlist - never strip-down.
- Gates run BARE from the worktree (w:/tmp/flyer-full-info): `npm run typecheck`, `npm test`, `npm run e2e`. Never pipe a gate command.
- Commit after every task; explicit paths in `git add` (no `git add -A`).
- NEVER public: notes, landlordId, primary_voice_contact, payment_standard, lif, priority, tour_process, tour_type, application_process, status, status_source, propertyId, jurisdiction, final_rent, voucher_size_accepted.

## File structure

- `app/src/lib/unitFields.ts` - ONE merged `UnitFlyer` projection (delete `UnitFlyerDetails`/`toUnitFlyerDetails`).
- `app/src/routes/public.ts` - flyer route returns everything + `contact_number`; 404 body carries `contact_number`; /details route deleted; new `contactNumber` dep.
- `app/src/app.ts` - wires `contactNumber: config.ourPhoneNumbers[0]` into the public router.
- `app/src/lib/mergeFields.ts` - `flyerUrl()` appends `?cta=text`.
- `dashboard/src/routes/public/publicApi.ts` - merged `PublicFlyer` type (+`contact_number`); delete `PublicFlyerDetails`/`getFlyerDetails`.
- `dashboard/src/routes/public/FlyerPage.tsx` (renamed from FlyerFunnel.tsx, + .module.css + test) - the single page.
- `dashboard/src/App.tsx` - import rename.
- `dashboard/src/routes/listing/listingLinks.ts` - `flyerPath` points at `/p/:unitId`.
- `dashboard/src/routes/listing/ListingEditForm.tsx` - one public-visibility hint line.
- `e2e/tests/dashboard-next/public-pages.spec.ts` - reworked.

---

### Task 1: Backend - merged projection, single flyer endpoint, 404 contact_number

**Files:**
- Modify: `app/src/lib/unitFields.ts` (projection section, lines ~192-275, + stale field comments)
- Modify: `app/src/routes/public.ts`
- Modify: `app/src/app.ts` (public router mount, ~line 121)
- Test: `app/test/unitFields.test.ts`, `app/test/publicIntake.test.ts`

**Interfaces:**
- Consumes: existing `validateAddress`, `resolveUnitMedia`, `SHAREABLE_STATUSES`, harness `makeWebhookHarness` (its default env sets `OUR_PHONE_NUMBERS = OUR_NUMBER = '+15550009999'`).
- Produces: `UnitFlyer` (merged interface below), `toUnitFlyer(unit: UnitItem): UnitFlyer`, `PublicRouterDeps.contactNumber?: string`. Wire shape: `GET /public/units/:id/flyer` -> `{ flyer: UnitFlyer & { contact_number: string | null } }`; 404 -> `{ error: 'not_found', contact_number: string | null }`. `GET /public/units/:id/details` no longer exists (Express default 404, body `{}` or HTML - tests assert only `status === 404`).

- [ ] **Step 1: Rework `app/test/unitFields.test.ts` projection tests**

Rename the `toUnitFlyerDetails` describe block to `toUnitFlyer - the merged public allowlist` and update imports (`toUnitFlyer`, `type UnitFlyer` instead of the Details pair). In `fullUnit()`, move the four newly-public fields to NON-secret values (they are exposed now); keep SECRET markers only on internal fields:

```ts
      // newly PUBLIC (flyer-full-info 2026-07-16) - real values, asserted below
      deposit: 1400,
      accessibility: 'Ground floor, no stairs',
      lease_terms: '12-month minimum',
      pets: 'Cats only',
      // still INTERNAL - SECRET markers prove they never serialize
      lif: 500,
      notes: 'SECRET in-unit washer note',
      priority: 'SECRET high',
      tour_process: 'SECRET lockbox 9999',
      application_process: 'SECRET portal',
```

Replace the exact-shape test:

```ts
  it('exposes the merged public field set (teaser + reveal + tenant-useful)', () => {
    const flyer = toUnitFlyer(fullUnit());
    expect(flyer).toEqual<UnitFlyer>({
      unitId: 'unit-9',
      media: ['s3://photo1.jpg'],
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      voucher_size: 2,
      accepted_programs: ['GHV'],
      listing_link: 'https://example.com/listing/9',
      rent_min: 1400,
      rent_max: 1600,
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour9',
      application_fee: 50,
      same_day_rta: true,
      pets: 'Cats only',
      accessibility: 'Ground floor, no stairs',
      deposit: 1400,
      lease_terms: '12-month minimum',
    });
  });
```

Update the allowlist-wall test's forbidden list to (deposit/lease_terms/pets/accessibility REMOVED - they are public now):

```ts
    for (const forbidden of [
      'landlordId', 'primary_voice_contact', 'tour_process', 'tour_type',
      'application_process', 'status', 'status_source', 'notes',
      'payment_standard', 'lif', 'propertyId', 'jurisdiction', 'priority',
      'final_rent', 'voucher_size_accepted',
    ]) {
```

Keep the `not.toContain('SECRET')` + `not.toContain('contact-ll-secret')` assertions. Update the absent-fields test to also expect `pets`/`accessibility`/`deposit`/`lease_terms` to be null, and add a pets pass-through case:

```ts
  it('passes pets through as string or boolean; null when absent', () => {
    expect(toUnitFlyer(fullUnit({ pets: true })).pets).toBe(true);
    expect(toUnitFlyer(fullUnit({ pets: false })).pets).toBe(false);
    expect(toUnitFlyer(fullUnit({ pets: 'Cats only' })).pets).toBe('Cats only');
    expect(toUnitFlyer({ unitId: 'x', landlordId: 'll', status: 'available' }).pets).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /w/tmp/flyer-full-info/app && npx vitest run test/unitFields.test.ts`
Expected: FAIL - `toUnitFlyer` does not carry address/pets/etc (and `UnitFlyerDetails` import errors once removed).

- [ ] **Step 3: Implement the merged projection in `app/src/lib/unitFields.ts`**

Replace the whole projection section (interfaces + both functions) with:

```ts
/**
 * The public flyer projection - EVERYTHING a flyer link exposes, shown upfront
 * (flyer-full-info 2026-07-16: the teaser/reveal split is gone). This is an
 * allowlist (build up), never a denylist (strip down): a future internal field
 * added to UnitItem can NEVER leak, because it simply won't be copied here.
 * NEVER include tour_process, tour_type, application_process, landlordId,
 * primary_voice_contact, notes, internal status/status_source, payment_standard,
 * lif, priority, propertyId, jurisdiction, final_rent, voucher_size_accepted.
 */
export interface UnitFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  subzone: string | null;
  /** Voucher size the unit is sized for - derived from beds (shareable). */
  voucher_size: number | null;
  accepted_programs: string[];
  listing_link: string | null;
  rent_min: number | null;
  rent_max: number | null;
  /** The structured postal address (allowlisted sub-fields only). */
  address: Address;
  /** Tenant-paid utilities (which utilities the tenant pays). */
  utilities: string | null;
  /** Tour video link. */
  video_url: string | null;
  /** Application fee in dollars. */
  application_fee: number | null;
  /** Same-day RTA available. */
  same_day_rta: boolean | null;
  /** Pet policy - free-form string, or a bare boolean (allowed / not allowed). */
  pets: string | boolean | null;
  /** Accessibility notes (tenant-useful, staff-authored). */
  accessibility: string | null;
  /** Security deposit in dollars. */
  deposit: number | null;
  /** Lease terms - free-form ("12-month minimum, month-to-month after"). */
  lease_terms: string | null;
}

export function toUnitFlyer(unit: UnitItem): UnitFlyer {
  // voucher_size: a unit's bedroom count IS the voucher size it serves. The
  // address is re-validated through the SAME write-surface validator so the
  // projection carries ONLY allowlisted sub-fields, never a legacy string blob.
  const beds = isFiniteNumber(unit.beds) ? unit.beds : null;
  const addr = validateAddress(unit.address, 'address');
  return {
    unitId: unit.unitId,
    media: isStringArray(unit.media) ? unit.media : [],
    beds,
    baths: isFiniteNumber(unit.baths) ? unit.baths : null,
    area: typeof unit.area === 'string' ? unit.area : null,
    subzone: typeof unit.subzone === 'string' ? unit.subzone : null,
    voucher_size: beds,
    accepted_programs: isStringArray(unit.accepted_programs) ? unit.accepted_programs : [],
    listing_link: typeof unit.listing_link === 'string' ? unit.listing_link : null,
    rent_min: isFiniteNumber(unit.rent_min) ? unit.rent_min : null,
    rent_max: isFiniteNumber(unit.rent_max) ? unit.rent_max : null,
    address: addr.ok ? addr.address : {},
    utilities: typeof unit.utilities === 'string' ? unit.utilities : null,
    video_url: typeof unit.video_url === 'string' ? unit.video_url : null,
    application_fee: isFiniteNumber(unit.application_fee) ? unit.application_fee : null,
    same_day_rta: typeof unit.same_day_rta === 'boolean' ? unit.same_day_rta : null,
    pets: typeof unit.pets === 'string' || typeof unit.pets === 'boolean' ? unit.pets : null,
    accessibility: typeof unit.accessibility === 'string' ? unit.accessibility : null,
    deposit: isFiniteNumber(unit.deposit) ? unit.deposit : null,
    lease_terms: typeof unit.lease_terms === 'string' ? unit.lease_terms : null,
  };
}
```

Delete `UnitFlyerDetails` and `toUnitFlyerDetails` entirely. Fix the now-stale WRITABLE_FIELDS comments: `lease_terms` and `pets` comments now say "PUBLIC on the flyer projection (flyer-full-info)"; `notes` keeps "NEVER on the flyer"; `accessibility` and `deposit` get a "public on the flyer" note.

- [ ] **Step 4: Rework the flyer/details route tests in `app/test/publicIntake.test.ts`**

(a) In the `GET .../flyer - shareable view only` describe: the exact-keys assertion
(`Object.keys(flyer).sort()`) gains `address`, `utilities`, `video_url`, `application_fee`,
`same_day_rta`, `pets`, `accessibility`, `deposit`, `lease_terms`, `contact_number`. Add:

```ts
    // The flyer now carries the FULL public payload upfront (no reveal tier)
    // plus contact_number - the main 1:1 business number from config.
    expect(flyer.contact_number).toBe(OUR_NUMBER);
```

(import `OUR_NUMBER` from `./helpers/twilioWebhookHarness.js`).

(b) Replace the whole `GET /public/units/:unitId/details - the post-intake reveal` describe with:

```ts
describe('GET /public/units/:unitId/details - REMOVED (flyer-full-info)', () => {
  it('the details route no longer exists (plain 404 for any id)', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-1', {
      unitId: 'unit-1', landlordId: 'll-1', status: 'available',
    } as UnitItem);
    const res = await request(app)
      .get('/public/units/unit-1/details')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
  });
});

describe('GET /public/units/:unitId/flyer - the opaque 404 carries contact_number', () => {
  it('missing, deleted, and not-shareable all return the IDENTICAL body', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-held', {
      unitId: 'unit-held', landlordId: 'll-1', status: 'on_hold',
    } as UnitItem);
    world.units.set('unit-gone', {
      unitId: 'unit-gone', landlordId: 'll-1', status: 'available', deleted_at: 'x',
    } as UnitItem);
    const bodies: unknown[] = [];
    for (const id of ['nope', 'unit-held', 'unit-gone']) {
      const res = await request(app)
        .get(`/public/units/${id}/flyer`)
        .set('x-origin-verify', SECRET);
      expect(res.status, id).toBe(404);
      bodies.push(res.body);
    }
    // Identical bodies - no existence oracle; the number is config, not unit data.
    expect(bodies[0]).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});
```

(Match the harness's actual soft-delete marker: check how existing tests build a
deleted unit - `isDeleted` reads `deleted_at`; mirror whatever the existing 404
tests at lines ~379-403 use.) Any other test in this file asserting a flyer 404
body of exactly `{ error: 'not_found' }` must now expect the contact_number key.

- [ ] **Step 5: Run to verify failure**

Run: `cd /w/tmp/flyer-full-info/app && npx vitest run test/publicIntake.test.ts`
Expected: FAIL - flyer payload lacks the new fields/contact_number; 404 body lacks contact_number; typecheck errors on the deleted `toUnitFlyerDetails` import in `routes/public.ts`.

- [ ] **Step 6: Implement `app/src/routes/public.ts` + `app/src/app.ts`**

public.ts:
- Import only `toUnitFlyer` (drop `toUnitFlyerDetails`).
- `PublicRouterDeps` gains:

```ts
  /**
   * flyer-full-info: the public-facing texting number shown on the flyer (the
   * "I'm interested - text us" CTA) - config.ourPhoneNumbers[0], the SAME main
   * number all 1:1 Twilio traffic uses. Absent -> the page degrades to
   * reply-prompt copy (never a broken button).
   */
  contactNumber?: string;
```

- In `createPublicRouter`: `const contactNumber = deps.contactNumber ?? null;` and a shared opaque-404 helper INSIDE the factory:

```ts
  // The opaque 404 - IDENTICAL for missing, soft-deleted, and not-shareable
  // (no existence oracle). It carries contact_number (config, not unit data)
  // so the public page's "unavailable" state can still offer the text-us CTA.
  function sendNotFound(res: Response): void {
    res.status(404).json({ error: 'not_found', contact_number: contactNumber });
  }
```

(import `type Response` from express). Use it in the flyer route; response becomes:

```ts
    res.json({ flyer: { ...toUnitFlyer(unit), media, contact_number: contactNumber } });
```

- DELETE the entire `/units/:unitId/details` route handler and update the router header comment (routes list: no /details; flyer returns the full public payload upfront).

app.ts (public router mount): pass the number through - `ourPhoneNumbers[0]` is `string | undefined` under noUncheckedIndexedAccess, and the dep is optional, so spread conditionally:

```ts
    createPublicRouter({
      logger: log,
      ...(config.ourPhoneNumbers[0] !== undefined && { contactNumber: config.ourPhoneNumbers[0] }),
      ...(publicMediaStore !== undefined && { mediaStore: publicMediaStore }),
      ...deps.public,
    }),
```

- [ ] **Step 7: Run the app suites**

Run: `cd /w/tmp/flyer-full-info/app && npx vitest run test/unitFields.test.ts test/publicIntake.test.ts test/apiRoutes.test.ts test/unitsApiPhotos.test.ts`
Expected: PASS. (unitsApiPhotos + apiRoutes touch flyer surfaces - if either asserts the old flyer key set or the bare 404 body, update those assertions the same way.)

- [ ] **Step 8: Commit**

```bash
cd /w/tmp/flyer-full-info && git add app/src/lib/unitFields.ts app/src/routes/public.ts app/src/app.ts app/test/unitFields.test.ts app/test/publicIntake.test.ts && git status && git commit -m "feat(flyer): merged public projection, single flyer endpoint, 404 contact_number"
```

(If step 7 touched apiRoutes/unitsApiPhotos tests, add those paths too.)

---

### Task 2: Backend - flyerUrl carries ?cta=text

**Files:**
- Modify: `app/src/lib/mergeFields.ts:23-28` (+ header comment line 10)
- Test: `app/test/mergeFields.test.ts`
- Possibly: `app/test/broadcastApi.test.ts`, `app/test/broadcastFanOut.test.ts`, `app/test/sendMessage.test.ts` (exact-string [FlyerLink] assertions)

**Interfaces:**
- Produces: `flyerUrl(base, unitId)` -> `${base}/p/${unitId}?cta=text`. Every auto-sent [FlyerLink] (1:1 + broadcast, both call this one function) now lands on the known-tenant variant.

- [ ] **Step 1: Update `app/test/mergeFields.test.ts` expectations**

```ts
  it('flyerUrl builds ${PUBLIC_BASE_URL}/p/${unitId}?cta=text, trimming a trailing slash', () => {
    // ?cta=text = the known-tenant CTA variant (flyer-full-info): everyone WE
    // text gets the text-us CTA, never the re-onboarding form.
    expect(flyerUrl(BASE, 'unit-7')).toBe(`${BASE}/p/unit-7?cta=text`);
    expect(flyerUrl(`${BASE}/`, 'unit-7')).toBe(`${BASE}/p/unit-7?cta=text`);
    expect(flyerUrl(undefined, 'unit-7')).toBe('/p/unit-7?cta=text');
  });
```

And the renderBody expectation becomes `... See ${BASE}/p/unit-7?cta=text`.

- [ ] **Step 2: Run to verify failure**

Run: `cd /w/tmp/flyer-full-info/app && npx vitest run test/mergeFields.test.ts`
Expected: FAIL on the three flyerUrl assertions + renderBody.

- [ ] **Step 3: Implement**

```ts
/** Public flyer URL shape - the full-info page at /p/:unitId. ?cta=text selects
 *  the known-tenant CTA (tap-to-text, no signup form): every AUTO-SENT
 *  [FlyerLink] goes to someone we already text, so it always carries the flag.
 *  The page strips the param from the address bar on load (copied URLs stay
 *  clean). The BARE /p/:unitId (dashboard "Copy public link") keeps the form. */
export function flyerUrl(publicBaseUrl: string | undefined, unitId: string): string {
  const base = (publicBaseUrl ?? '').replace(/\/+$/, '');
  return `${base}/p/${unitId}?cta=text`;
}
```

Update the token table comment (line 10) to `${PUBLIC_BASE_URL}/p/${unitId}?cta=text`.

- [ ] **Step 4: Run the FULL app suite to catch exact-string assertions elsewhere**

Run: `cd /w/tmp/flyer-full-info/app && npm test`
Expected: mergeFields PASSES; any broadcast/send test asserting a rendered body or `flyerUrl` field with the old bare URL FAILS - update each to expect `?cta=text` (byte-for-byte; the watch item in the spec). Re-run until green.

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/flyer-full-info && git add app/src/lib/mergeFields.ts app/test/mergeFields.test.ts && git status && git commit -m "feat(flyer): auto-sent [FlyerLink] carries ?cta=text (known-tenant CTA)"
```

(Plus any broadcast test files updated in step 4.)

---

### Task 3: Dashboard - FlyerPage (merged type, variant CTAs, strip+persist)

**Files:**
- Modify: `dashboard/src/routes/public/publicApi.ts`
- Rename+rewrite: `dashboard/src/routes/public/FlyerFunnel.tsx` -> `FlyerPage.tsx`; `FlyerFunnel.module.css` -> `FlyerPage.module.css`; `FlyerFunnel.test.tsx` -> `FlyerPage.test.tsx`
- Modify: `dashboard/src/App.tsx:36,88` (import + element) and its comment block (~line 76)

**Interfaces:**
- Consumes: `IntakeForm` (unchanged; `onSubmit(input: Omit<HousingFairInput,'unitId'>)`, `submitLabel`), `safeHttpUrl`, `ApiError` (`.status`, `.body`), Task 1 wire shape.
- Produces: `PublicFlyer` (merged, + `contact_number: string | null`), `FlyerPage` component on `/p/:unitId`. `getFlyerDetails`/`PublicFlyerDetails` are GONE.

- [ ] **Step 1: Update `publicApi.ts`**

`PublicFlyer` becomes the merged mirror of the app's `UnitFlyer` PLUS `contact_number`:

```ts
/** The full public flyer - mirrors app/src/lib/unitFields.ts UnitFlyer exactly
 *  (same names + nullability), PLUS contact_number (config-sourced by the
 *  route: the main 1:1 business number, null when unconfigured). Everything is
 *  shown upfront - the teaser/reveal split is gone (flyer-full-info). */
export interface PublicFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  subzone: string | null;
  voucher_size: number | null;
  accepted_programs: string[];
  listing_link: string | null;
  rent_min: number | null;
  rent_max: number | null;
  address: PublicAddress;
  utilities: string | null;
  video_url: string | null;
  application_fee: number | null;
  same_day_rta: boolean | null;
  pets: string | boolean | null;
  accessibility: string | null;
  deposit: number | null;
  lease_terms: string | null;
  contact_number: string | null;
}
```

Delete `PublicFlyerDetails` and `getFlyerDetails`. Keep `PublicAddress`, `getFlyer`,
`HousingFairInput`, `submitHousingFair` (all `do-not-remove` comments intact). Update the
file header (no more funnel/reveal).

- [ ] **Step 2: Write `FlyerPage.test.tsx` (replaces FlyerFunnel.test.tsx)**

Keep the existing mock pattern (mock `getFlyer` + `submitHousingFair`; no `getFlyerDetails`).
Fixture:

```tsx
const FLYER: PublicFlyer = {
  unitId: 'unit-1',
  media: ['https://img.example/a.jpg'],
  beds: 3, baths: 2,
  area: 'Decatur', subzone: 'Oakhurst',
  voucher_size: 3,
  accepted_programs: ['HCV', 'VASH'],
  listing_link: 'https://external.example/listing/1',
  rent_min: 1800, rent_max: 2000,
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
  utilities: 'Electric and gas',
  video_url: 'https://video.example/tour',
  application_fee: 40,
  same_day_rta: true,
  pets: 'Cats only',
  accessibility: 'Ground floor',
  deposit: 1800,
  lease_terms: '12-month minimum',
  contact_number: '+15550009999',
};
```

Render helper mounts a location probe next to the page so URL-stripping is assertable:

```tsx
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderPage(entry = '/p/unit-1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/p/:unitId" element={<><FlyerPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
```

Test cases (each its own `it`; complete assertions):

1. `public variant shows ALL info upfront plus the intake form` - `getFlyer.mockResolvedValue(FLYER)`; `renderPage()`; findByText('88 Sycamore St', {exact:false}); assert visible: Deposit `$1800`, Application fee `$40`, Tenant pays `Electric and gas`, Pets `Cats only`, Accessibility `Ground floor`, Lease terms `12-month minimum`, Same-day RTA `Available`, link `Watch the tour` href `https://video.example/tour`, link `See the full listing` href FLYER.listing_link, heading matching `/Oakhurst/`; form present (`getByLabelText(/first name/i)`), NO sms: link (`expect(screen.queryByRole('link', { name: /text us/i })).toBeNull()`).
2. `submit swaps ONLY the CTA to a thank-you; the info stays` - fill/submit like the old funnel test (`I'm interested` submit button); `submitHousingFair` called with `{ unitId: 'unit-1', smsConsent: true, phone: '+14045551234', ... }`; then `findByRole('heading', { name: /you're all set|we've got your info/i })`, and `screen.getByText('88 Sycamore St', {exact:false})` STILL present, form gone.
3. `?cta=text renders the text-us CTA, no form, and strips the URL` - `renderPage('/p/unit-1?cta=text')`; sms link: `expect(await screen.findByRole('link', { name: /text us/i })).toHaveAttribute('href', 'sms:+15550009999?&body=' + encodeURIComponent("I'm interested in 88 Sycamore St, Decatur"))`; `expect(screen.queryByLabelText(/first name/i)).toBeNull()`; `expect(screen.getByTestId('loc').textContent).toBe('/p/unit-1')`.
4. `the known variant survives a remount WITHOUT the param (sessionStorage)` - renderPage with the param, `unmount()`, renderPage bare `/p/unit-1` -> sms link still rendered, no form.
5. `known variant with a null contact_number degrades to the reply prompt` - mock flyer `{ ...FLYER, contact_number: null }`, entry with `?cta=text` -> `findByText(/reply to the text we sent you/i)`, no link with sms: href, no form.
6. `sms prefill falls back: neighborhood, then "this home"` - flyer with `address: {}` -> body encodes `I'm interested in Oakhurst, Decatur`; flyer with `address: {}` and `area/subzone: null` -> `I'm interested in this home`.
7. `unsafe URLs are not rendered as links` - flyer with `video_url: 'javascript:alert(1)'`, `listing_link: 'javascript:alert(2)'` -> neither link rendered.
8. `unavailable (public variant) keeps the /join link` - `getFlyer.mockRejectedValue(new ApiError(404, 'not_found', 'not_found', { error: 'not_found', contact_number: '+15550009999' }))`; renderPage bare -> heading `/no longer available/i` + link `See other homes` href `/join`, no sms link.
9. `unavailable (known variant) offers the text-us CTA from the 404 body` - same rejection, entry `?cta=text` -> sms link with href `sms:+15550009999?&body=` + encodeURIComponent("The home I was looking at is no longer available - I'm interested in similar homes."); with body `{ error: 'not_found', contact_number: null }` -> the reply-prompt copy instead.

- [ ] **Step 3: Run to verify failure**

Run: `cd /w/tmp/flyer-full-info/dashboard && npx vitest run src/routes/public/FlyerPage.test.tsx`
Expected: FAIL - FlyerPage does not exist.

- [ ] **Step 4: Write `FlyerPage.tsx` and rename the css module**

`git mv dashboard/src/routes/public/FlyerFunnel.module.css dashboard/src/routes/public/FlyerPage.module.css`
then `git rm dashboard/src/routes/public/FlyerFunnel.tsx dashboard/src/routes/public/FlyerFunnel.test.tsx` (the rewrite replaces them). Update the css header comment ("FlyerPage - the full-info public flyer. Mobile-first. Tokens only.") and add one class:

```css
.ctaSection {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  border-top: 1px solid var(--c-border);
  padding-top: var(--sp-4);
}
```

Component (complete reference implementation - keep helpers `rentRange`/`neighborhood`/`addressLines` from the old file verbatim):

```tsx
// FlyerPage (/p/:unitId) - the public, unauthenticated FULL-INFO flyer for one
// shareable unit (flyer-full-info 2026-07-16: the teaser->intake->reveal funnel
// is gone; everything public is shown upfront). This route is what flyerUrl()
// emits, so every broadcast [FlyerLink] share lands here.
//
// Two CTA variants, selected by ?cta=text (stripped from the URL on load so a
// copied/shared address never carries it; sessionStorage keeps the variant
// across a same-tab refresh):
//   form (bare link)  - the IntakeForm signup funnel at the bottom.
//   text (?cta=text)  - "I'm interested - text us": a tap-to-text sms: link to
//                       our main business number (contact_number). No form -
//                       these visitors are ALREADY onboarded.
// The unavailable state is variant-aware too (the opaque 404 body carries
// contact_number so the text CTA still works there).
//
// Tenant-facing copy: the dwelling is a "home" (never unit/property/listing).
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import {
  getFlyer,
  submitHousingFair,
  type PublicFlyer,
  type HousingFairInput,
} from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import { safeHttpUrl } from '../../lib/safeUrl.js';
import styles from './FlyerPage.module.css';

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable'; contactNumber: string | null }
  | { kind: 'ready'; flyer: PublicFlyer };

type Variant = 'form' | 'text';

const UNAVAILABLE_PREFILL =
  "The home I was looking at is no longer available - I'm interested in similar homes.";

/** Build the cross-platform tap-to-text href. The `?&body=` form is DELIBERATE
 *  (iOS takes &body / modern iOS ?body, Android takes ?body) - do not "fix" it. */
function smsHref(number: string, body: string): string {
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

/** "I'm interested in <line1, city | neighborhood | this home>" */
function interestedPrefill(flyer: PublicFlyer): string {
  const line1 = flyer.address.line1;
  const where =
    typeof line1 === 'string' && line1 !== ''
      ? [line1, flyer.address.city].filter(Boolean).join(', ')
      : neighborhood(flyer) ?? 'this home';
  return `I'm interested in ${where}`;
}

/** Pull contact_number out of the opaque 404 body (null when absent). */
function contactFromError(err: unknown): string | null {
  if (err instanceof ApiError && err.body !== null && typeof err.body === 'object') {
    const n = (err.body as Record<string, unknown>)['contact_number'];
    if (typeof n === 'string') return n;
  }
  return null;
}

function petsLabel(pets: string | boolean | null): string | null {
  if (pets === true) return 'Allowed';
  if (pets === false) return 'Not allowed';
  return pets;
}

export function FlyerPage(): React.JSX.Element {
  const { unitId } = useParams<{ unitId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [submitted, setSubmitted] = useState(false);
  const storageKey = `flyer-cta-${unitId ?? ''}`;

  // Variant: ?cta=text wins (and is persisted + stripped); else sessionStorage
  // (same-tab refresh keeps the known-tenant CTA); else the public form.
  const [variant, setVariant] = useState<Variant>('form');
  useEffect(() => {
    const fromParam = searchParams.get('cta') === 'text';
    if (fromParam) {
      try {
        sessionStorage.setItem(storageKey, 'text');
      } catch {
        // Private-mode storage failure: the variant just won't survive refresh.
      }
    }
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(storageKey);
    } catch {
      stored = null;
    }
    setVariant(fromParam || stored === 'text' ? 'text' : 'form');
    // Strip cta (and ONLY cta) so a copied/shared URL never carries the flag.
    if (searchParams.get('cta') !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('cta');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per unit
  }, [unitId]);

  // Focus the swapped-in heading (thank-you) so the change is announced to SRs.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (submitted) headingRef.current?.focus();
  }, [submitted]);

  useEffect(() => {
    if (unitId === undefined) {
      setStage({ kind: 'unavailable', contactNumber: null });
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const flyer = await getFlyer(unitId, controller.signal);
        if (controller.signal.aborted) return;
        setStage({ kind: 'ready', flyer });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // Opaque 404 (missing/not-shareable) or any other failure -> the
        // friendly unavailable state; its body may carry our texting number.
        setStage({ kind: 'unavailable', contactNumber: contactFromError(err) });
      }
    })();
    return () => controller.abort();
  }, [unitId]);

  async function handleIntakeSubmit(input: Omit<HousingFairInput, 'unitId'>): Promise<void> {
    if (unitId === undefined) return;
    // A throw propagates to the IntakeForm so it shows its error and stays put.
    await submitHousingFair({ ...input, unitId });
    setSubmitted(true);
  }

  if (stage.kind === 'loading') {
    // Copy this block BYTE-IDENTICAL from FlyerFunnel.tsx (its "Loading" string
    // ends with the existing non-ASCII ellipsis glyph - keep it).
    return (
      <p className={styles.status} role="status">
        {/* ported verbatim from FlyerFunnel.tsx */}
      </p>
    );
  }

  if (stage.kind === 'unavailable') {
    return (
      <section className={styles.card}>
        <h1 className={styles.title}>This home is no longer available</h1>
        <p className={styles.muted}>
          The home you&apos;re looking for has been taken or removed.
        </p>
        {variant === 'text' ? (
          stage.contactNumber !== null ? (
            <a className={styles.linkButton} href={smsHref(stage.contactNumber, UNAVAILABLE_PREFILL)}>
              I&apos;m interested in similar homes - text us
            </a>
          ) : (
            <p className={styles.muted}>
              Interested in similar homes? Reply to the text we sent you and
              we&apos;ll help you take the next step.
            </p>
          )
        ) : (
          <a className={styles.linkButton} href="/join">
            See other homes
          </a>
        )}
      </section>
    );
  }

  const { flyer } = stage;
  const rent = rentRange(flyer);
  const hood = neighborhood(flyer);
  const safeVideoUrl = safeHttpUrl(flyer.video_url);
  const safeListingUrl = safeHttpUrl(flyer.listing_link);
  const pets = petsLabel(flyer.pets);
  const address = addressLines(flyer.address);

  return (
    <section className={styles.card}>
      {flyer.media.length > 0 && (
        <div className={styles.gallery} aria-label="Photos">
          {flyer.media.map((src, i) => (
            <img key={i} className={styles.photo} src={src} alt={`Home photo ${i + 1}`} />
          ))}
        </div>
      )}
      <h1 className={styles.title}>{hood ?? 'A home for you'}</h1>

      <ul className={styles.facts}>
        {flyer.beds !== null && (
          <li>
            <strong>{flyer.beds}</strong> bed{flyer.beds === 1 ? '' : 's'}
          </li>
        )}
        {flyer.baths !== null && (
          <li>
            <strong>{flyer.baths}</strong> bath{flyer.baths === 1 ? '' : 's'}
          </li>
        )}
        {rent !== null && (
          <li>
            <strong>{rent}</strong>/mo
          </li>
        )}
        {flyer.voucher_size !== null && (
          <li>
            Fits a <strong>{flyer.voucher_size}-bedroom</strong> voucher
          </li>
        )}
      </ul>

      {flyer.accepted_programs.length > 0 && (
        <p className={styles.programs}>Accepts: {flyer.accepted_programs.join(', ')}</p>
      )}

      <dl className={styles.details}>
        {address !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Address</dt>
            <dd className={styles.dd}>{address}</dd>
          </div>
        )}
        {flyer.deposit !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Deposit</dt>
            <dd className={styles.dd}>${flyer.deposit}</dd>
          </div>
        )}
        {flyer.application_fee !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Application fee</dt>
            <dd className={styles.dd}>${flyer.application_fee}</dd>
          </div>
        )}
        {flyer.utilities !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Tenant pays</dt>
            <dd className={styles.dd}>{flyer.utilities}</dd>
          </div>
        )}
        {pets !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Pets</dt>
            <dd className={styles.dd}>{pets}</dd>
          </div>
        )}
        {flyer.accessibility !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Accessibility</dt>
            <dd className={styles.dd}>{flyer.accessibility}</dd>
          </div>
        )}
        {flyer.lease_terms !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Lease terms</dt>
            <dd className={styles.dd}>{flyer.lease_terms}</dd>
          </div>
        )}
        {flyer.same_day_rta === true && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Same-day RTA</dt>
            <dd className={styles.dd}>Available</dd>
          </div>
        )}
        {safeVideoUrl !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Video tour</dt>
            <dd className={styles.dd}>
              <a href={safeVideoUrl} target="_blank" rel="noreferrer">
                Watch the tour
              </a>
            </dd>
          </div>
        )}
        {safeListingUrl !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Listing</dt>
            <dd className={styles.dd}>
              <a href={safeListingUrl} target="_blank" rel="noreferrer">
                See the full listing
              </a>
            </dd>
          </div>
        )}
      </dl>

      <div className={styles.ctaSection}>
        {variant === 'text' ? (
          flyer.contact_number !== null ? (
            <>
              <h2 className={styles.title}>Interested in this home?</h2>
              <a className={styles.linkButton} href={smsHref(flyer.contact_number, interestedPrefill(flyer))}>
                I&apos;m interested - text us
              </a>
            </>
          ) : (
            <p className={styles.muted}>
              Interested? Reply to the text we sent you and we&apos;ll help you
              take the next step.
            </p>
          )
        ) : submitted ? (
          <>
            <h2 className={styles.title} ref={headingRef} tabIndex={-1}>
              Thanks - you&apos;re all set!
            </h2>
            <p className={styles.muted}>
              We&apos;ve got your info and a team member will be in touch.
            </p>
          </>
        ) : (
          <>
            <h2 className={styles.title}>Interested in this home?</h2>
            <p className={styles.muted}>
              Share your info and a team member will reach out about this home.
            </p>
            <IntakeForm onSubmit={handleIntakeSubmit} submitLabel="I'm interested" />
          </>
        )}
      </div>
    </section>
  );
}
```

NOTE: all NEW copy above is plain ASCII (hyphens, `&apos;` entities); only the ported
Loading string keeps its existing ellipsis glyph. Keep prefill strings
(`interestedPrefill`, `UNAVAILABLE_PREFILL`) plain ASCII because they become SMS bodies.
The `headingRef` moves focus only on the submit swap (loading->ready is the initial
render, nothing to rescue). The sms-link test in Step 2 asserts the accessible name
/text us/i - keep "text us" in the button copy.

App.tsx: change the import to `FlyerPage` from `./routes/public/FlyerPage.js`, swap the
element, and reword the comment block (~line 76): "/p/:unitId is what flyerUrl() emits, so
every shared [FlyerLink] lands on the full-info flyer page."

- [ ] **Step 5: Run the dashboard tests**

Run: `cd /w/tmp/flyer-full-info/dashboard && npx vitest run src/routes/public`
Expected: FlyerPage.test.tsx PASSES; IntakeForm tests still pass. Then the full sweep:
`cd /w/tmp/flyer-full-info/dashboard && npm test` - fix any test still importing
FlyerFunnel/getFlyerDetails.

- [ ] **Step 6: Typecheck both workspaces**

Run: `cd /w/tmp/flyer-full-info && npm run typecheck`
Expected: exit 0 (this is the gate that catches a stale import the runtime suites miss).

- [ ] **Step 7: Commit**

```bash
cd /w/tmp/flyer-full-info && git add dashboard/src/routes/public/publicApi.ts dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/FlyerPage.module.css dashboard/src/routes/public/FlyerPage.test.tsx dashboard/src/App.tsx && git status && git commit -m "feat(flyer): FlyerPage - full info upfront, form/text CTA variants, cta flag strip+persist"
```

(git mv/git rm staged the renames already - `git status` confirms before committing.)

---

### Task 4: Dashboard - flyerPath points at the page, not the JSON API

**Files:**
- Modify: `dashboard/src/routes/listing/listingLinks.ts`
- Test: `dashboard/src/routes/listing/listingLinks.test.ts`

**Interfaces:**
- Produces: `flyerPath(unitId)` -> `/p/${encodeURIComponent(unitId)}`. Consumed by ListingDetail's "View flyer" / "Copy public link" (bare = public form variant, correct for a shared/copied link).

- [ ] **Step 1: Update the test**

```ts
  it('builds the public flyer PAGE path (bare = the public form variant)', () => {
    expect(flyerPath('u1')).toBe('/p/u1');
  });
  it('URL-encodes the unitId', () => {
    expect(flyerPath('a/b c')).toBe('/p/a%2Fb%20c');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /w/tmp/flyer-full-info/dashboard && npx vitest run src/routes/listing/listingLinks.test.ts`
Expected: FAIL (old `/public/units/...` shape).

- [ ] **Step 3: Implement**

```ts
// listingLinks - the public flyer link for a unit: the full-info PAGE at
// /p/:unitId (pre-2026-07-16 this wrongly pointed at the JSON API path
// /public/units/:id/flyer, so "View flyer" opened raw JSON). Bare (no ?cta)
// = the public form variant - right for a copied/shared link.
export function flyerPath(unitId: string): string {
  return `/p/${encodeURIComponent(unitId)}`;
}
```

- [ ] **Step 4: Run to verify pass + check the consumer**

Run: `cd /w/tmp/flyer-full-info/dashboard && npx vitest run src/routes/listing`
Expected: PASS. If a ListingDetail test snapshot/assertion carries the old href, update it.

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/flyer-full-info && git add dashboard/src/routes/listing/listingLinks.ts dashboard/src/routes/listing/listingLinks.test.ts && git status && git commit -m "fix(dashboard): View flyer / Copy public link point at the flyer page, not the JSON API"
```

---

### Task 5: Dashboard - public-visibility hint on the property edit form

**Files:**
- Modify: `dashboard/src/routes/listing/ListingEditForm.tsx`
- Test: `dashboard/src/routes/listing/ListingEditForm.test.tsx`

**Interfaces:**
- Consumes: nothing new. Produces: one static hint paragraph - NO label changes (labels are load-bearing for getByLabel selectors in tests/e2e).

- [ ] **Step 1: Add a failing assertion**

In ListingEditForm.test.tsx (any existing render-the-form test, or a new `it`):

```ts
  it('tells staff which facts are publicly visible on the flyer', () => {
    renderForm(); // reuse the file's existing render helper
    expect(
      screen.getByText(/shown on the public flyer/i),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /w/tmp/flyer-full-info/dashboard && npx vitest run src/routes/listing/ListingEditForm.test.tsx`
Expected: FAIL - text not found.

- [ ] **Step 3: Implement**

Near the top of the form (or above the details fieldset - match the file's existing
layout idioms and css module classes), add one muted paragraph:

```tsx
      <p className={styles.hint}>
        Address, rent, deposit, fees, utilities, pets, accessibility, and lease
        terms are shown on the public flyer.
      </p>
```

If the module has no `.hint` class, add one (muted color token, small font - mirror
`.programs` in FlyerPage.module.css). Do NOT touch any field label.

- [ ] **Step 4: Run to verify pass, commit**

Run: `cd /w/tmp/flyer-full-info/dashboard && npx vitest run src/routes/listing/ListingEditForm.test.tsx`
Expected: PASS.

```bash
cd /w/tmp/flyer-full-info && git add dashboard/src/routes/listing/ListingEditForm.tsx dashboard/src/routes/listing/ListingEditForm.test.tsx && git status && git commit -m "feat(dashboard): edit form notes which property facts are public on the flyer"
```

(Plus the module.css file if a class was added.)

---

### Task 6: E2E - rework public-pages.spec.ts

**Files:**
- Modify: `e2e/tests/dashboard-next/public-pages.spec.ts`
- Check-only: `e2e/scenarios/steps.ts` (grep for flyer assumptions; update if it asserts the old funnel)

**Interfaces:**
- Consumes: the hermetic stack (Docker + `npm run e2e`), dev-login, `getOutbox`, `createShareableUnit` helper (extend its create body with the new fields), seeded `unit-0001` (non-shareable).

- [ ] **Step 1: Rework the spec**

Update the header comment (full-info page, two CTA variants, no funnel). Extend
`createShareableUnit`'s create body with the newly-public facts:

```ts
      deposit: 1500,
      pets: 'Cats only',
      accessibility: 'Ground floor',
      lease_terms: '12-month minimum',
```

(and add `deposit: number` etc. to the `ShareableUnit` interface + defaults so tests can
assert them). Replace the five tests with:

1. `full info is public with NO session and NO gate` - goto `/p/<unit>`; assert visible: area heading, beds/rent facts, `unit.addressLine1`, `Deposit` + `$1500`, `Application fee` + `$45`, `unit.utilities`, `Pets` + `Cats only`, `Accessibility`, `Lease terms`, `Same-day RTA`, `Watch the tour` link href `unit.videoUrl`; the intake form IS present (`getByLabel('First name')`); no login redirect (`Sign in with Google` count 0). API sanity: `GET /public/units/<id>/flyer` -> `flyer.address.line1 === unit.addressLine1`, `flyer.application_fee === 45`, `typeof flyer.contact_number === 'string'` (the e2e stack sets OUR_PHONE_NUMBERS).
2. `bottom form submit -> thank-you in place; contact flyer-attributed; welcome SMS in outbox` - fill the form AT THE BOTTOM (no "I'm interested" button-click first - the form is inline), submit button name `I'm interested`; expect heading `/you're all set/i`; `unit.addressLine1` STILL visible (info not swapped away); attribution + outbox polls copied from the old funnel test verbatim.
3. `?cta=text: text-us CTA, no form, URL stripped` - goto `/p/<unit>?cta=text`; expect link `/text us/i` with `href` matching `/^sms:\+1\d+\?&body=I%27m%20interested/`; `getByLabel('First name')` count 0; `await expect(page).toHaveURL(new RegExp('/p/' + unit.unitId + '$'))` (the flag is gone).
4. `a staff edit flows straight to the public page` - PATCH fee/video/same_day_rta like today, re-goto the BARE url in a FRESH context (or clear sessionStorage) -> edited values visible without any funnel steps; `Same-day RTA` absent.
5. `/join unchanged` - keep today's test verbatim.
6. `unavailable: bogus + non-shareable stay opaque; both CTA variants land somewhere` - bare bogus id -> heading `/no longer available/i` + `See other homes` link href `/join`; `?cta=text` on a bogus id -> heading + link `/text us/i` with `href` starting `sms:`; non-shareable seeded unit (bare) -> same heading. Use a fresh browser context for the bare-after-flagged navigation (sessionStorage persists the variant within a context - that persistence is EXPECTED; the fresh context is how we test the bare experience).

- [ ] **Step 2: Grep the harness scenarios for stale funnel coupling**

Run: `cd /w/tmp/flyer-full-info && rg -n "flyer|Get the full details|I'm interested" e2e/scenarios e2e/tests --glob '!public-pages.spec.ts'`
Update anything asserting the funnel copy or the bare flyer URL (broadcast steps assert `[FlyerLink]` rendering - those now expect `?cta=text`).

- [ ] **Step 3: Run the e2e suite**

Run: `cd /w/tmp/flyer-full-info && npm run e2e`
Expected: exit 0, all specs green (Docker must be up). Fix and re-run until green - do not pipe the command.

- [ ] **Step 4: Commit**

```bash
cd /w/tmp/flyer-full-info && git add e2e/tests/dashboard-next/public-pages.spec.ts && git status && git commit -m "test(e2e): public flyer page - full info, two CTA variants, stripped flag"
```

(Plus any scenario/step files updated in step 2.)

---

### Task 7: Final gates on a synced base

- [ ] **Step 1: Sync main ONCE** - `cd /w/tmp/flyer-full-info && git fetch origin && git merge origin/main` (or local `git merge main` if no remote tracking); resolve conflicts keeping BOTH sides' intent.
- [ ] **Step 2: Full bare gates** - `npm run typecheck` then `npm test` then `npm run e2e`, each from `/w/tmp/flyer-full-info`, each exit 0. `npm test` and `npm run e2e` do NOT type-check - typecheck is its own required gate.
- [ ] **Step 3: Live self-QA (Playwright MCP against the e2e session stack)** - `npm run e2e:session`; dev-login; create a shareable unit with all fields; visit bare `/p/<id>` (full info + form), `?cta=text` (sms CTA, stripped URL), a bogus id both variants; screenshot each into `.playwright-mcp/`.
- [ ] **Step 4: Commit anything the gates changed; write the handback.**

## Self-review notes (already applied)

- Spec coverage: S2 fields -> Task 1; single endpoint + 404 body -> Task 1; flyerUrl flag -> Task 2; page + variants + strip/persist + variant-aware unavailable -> Task 3; flyerPath wart -> Task 4; helper text -> Task 5; e2e -> Task 6.
- Type consistency: `UnitFlyer` (app) and `PublicFlyer` (dashboard) field lists match 1:1 (+`contact_number` on the wire/client only); `smsHref`/`interestedPrefill`/`contactFromError` defined and used only in Task 3.
- The old funnel's `getFlyerDetails` details-fetch-failure path has no successor (nothing to fetch post-submit) - deleted, not ported.
