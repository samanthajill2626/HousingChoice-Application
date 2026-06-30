# Sequence diagram → e2e scenario: the repeatable method

How we turn a behavioral **sequence diagram** in `documentation/` into a runnable
Playwright end-to-end suite that proves the real flow works against the local
`--mock --local` stack. Tenant onboarding was the first; **sending-unit, tours, and
future diagrams follow this same method.** It was written after tenant-onboarding went
green, so it reflects what actually worked.

The payoff is two things at once: **regression protection** (lock in behavior that
works) and **gap discovery** (a diagram step the app can't satisfy fails red, naming a
feature to build — we built structured intake fields and fixed a reseed bug this way).

## The six steps

### 1. Read the diagram + its writeup
Identify the participants and the **one structural rule** that shapes every verb. For
tenant onboarding: *the app owns the phone number, so every message flows
Tenant → App → Team and back* — which is why most steps are a pair of arrows (inbound,
then relayed out). Note `[AUTO]` (app automation) vs `[MANUAL]` (a person acts) tags.

### 2. Expand the alt-paths
Every nested `alt/else` **leaf** becomes one `test()`. Tenant onboarding's five leaves:
by-text (×RTA-in-hand / no-RTA), by-phone, housing-fair-Team-enters-details, and
self-serve-portal. Factor the shared tail (eligibility intake → RTA gate →
parked/handoff) into ONE helper (`intakeAndRtaTail`) invoked at the end of each path so
it isn't duplicated.

### 3. Map each arrow/note to a verb
The scenario spec reads as the diagram; the only infrastructure is the **step library**
[`e2e/scenarios/steps.ts`](../e2e/scenarios/steps.ts) — a typed `Scenario` class of
verbs. Reuse it for the next diagram; add new verbs once.

- **Team** (the coordinator) acts by **driving the real dashboard UI** — backed by the
  seeded VA dev-login. The role is **"Team", NEVER the founder's name**, everywhere in
  test code and copy (`team*` verbs).
- **Tenant** acts via the **fake-twilio API seam** (inbound SMS/calls) and the public
  portal endpoint — never the UI.
- **App** assertions read the fake-twilio `listThreads` (`/control/threads`,
  proof-of-send) and the dashboard API (typed-tenant, status, intake).
- **Assert what Team SEES, not just what persisted.** An API read-back proves
  storage, not display — a field can save yet render nowhere (intake fields shipped
  write-only this way). So for anything the diagram implies Team must *see*, assert
  the **rendered** surface too, on top of the API check. Scope each UI assertion to
  its card/section (`page.locator('section').filter({ has: heading })`) so common
  values (`none`/`Yes`) and summary-line copies don't double-match.

Use **accessibility-first selectors** (`getByRole`/`getByLabel`/`getByText`,
[`e2e/support/selectors.md`](../e2e/support/selectors.md)). Dialog interactions are
scoped to the dialog (`getByRole('dialog', { name: /Edit contact/i })`).

### 4. Audit the diagram against the LIVE stack — *before* writing the spec
Boot `npm run e2e:session` and walk every diagram step with the Playwright MCP browser +
authenticated `page.request`/curl. Confirm, with evidence, what already works and what
must be built. **Fix the verbs' selectors/contracts to match reality here** — provisional
selectors transcribed from source are wrong often enough that an audit pass is mandatory.
File real gaps in [`docs/issues/`](../docs/issues/README.md).

### 5. Build the gaps with TDD
A diagram step the app can't satisfy is the signal to build. For tenant onboarding the
real gap was **structured intake fields** (pets/evictions/tenure/lifEligible — schema +
API validation + edit-form UI). Backend first (Vitest, RED→GREEN), then the dashboard
field, then the verb that drives it.

### 6. Go green
Inner loop: `npm run e2e:session` + `npm run e2e -w @housingchoice/e2e -- --grep "…"`.
After a **backend** change run `npm run e2e:restart` (the app must reload; Vite reloads
the dashboard live). Then the hermetic gate: the FULL `npm run e2e` green — proving the
new specs AND the pre-existing suite pass together (no regression).

## Non-negotiable conventions

- **"Team", never the founder's name** in all test code/copy.
- **Self-clean isolation, never per-test `/__dev/reseed`.** Each scenario uses
  fresh **timestamped** phones/names (`freshTenant`) so it creates its own contacts and
  never collides. `/__dev/reseed` wipes the users table + breaks the dev-login session;
  for a seeded entity a scenario must mutate, use a targeted authenticated `page.request`
  reset (the `devLoginAndReset` pattern), never a global wipe.
- **Mostly-UI, API for setup.** Team's meaningful actions go through the real UI; the
  tenant's inbound and pure setup use the API.
- **Triage, not New-contact, for inbound numbers.** An inbound auto-captures an UNKNOWN
  contact; triage it → Tenant via **"Mark as Tenant"** (the number already exists, so
  "New contact" hits the proven 409). New-contact is the housing-fair in-person path only.
- **The RTA gate is a tenant-`status` move** (`searching` for RTA-in-hand / `on_hold` for
  parked) via the edit-form Status select — not a flag, not the placement RTA phase.

## Audit-surfaced realities (you WILL hit these again)

These cost real debugging time on tenant onboarding; the next diagram should expect them.

- **`send-as-party` requires an ad-hoc persona first** (`POST :8889/control/personas/ad-hoc
  {label, role, number}`). A fresh tenant number is rejected (`unknown party number`)
  until registered. `place-call` does NOT need it. `steps.ts` registers lazily + once
  (`ensureParty`).
- **A missed CALL fires the auto-text but does NOT auto-capture a contact.** The tenant's
  follow-up TEXT is what creates the unknown to triage (exactly the diagram's next arrow).
  Order the by-phone path: call → auto-reply → text → relay → triage.
- **The self-serve portal is an API, not a UI page** — the public
  `POST :5174/public/housing-fair` (driven via the `:5174` proxy, which injects the origin
  secret) creates a `type:tenant, status:needs_review` contact + fires the welcome text.
- **The Unknown list shows a FORMATTED phone** (`(555) 123-4567`), not E.164 — locate the
  UI row by the formatted number; resolve the contactId via the API (`?type=unknown`).
- **The missed-call auto-text requests the onboarding details** (full name, voucher
  size, housing authority — `settingsRepo.ts` `DEFAULT_ORG_SETTINGS`), matching the
  diagram's intent. It is the founder-editable default with no settings seed, so assert
  a stable phrase from it (`/voucher size/i`), not verbatim copy.
- **`missedCallAutoTextEnabled` defaults ON** — the voice auto-text fires with no settings
  seed.
- **`/__dev/reseed` and the in-memory session-epoch cache:** a reseed used to leave the
  cache stale, so a dev-login *after* a reseed (which the scenario suite is the first to
  do) 401'd. Fixed in-app (reseed now clears the cache). If a future suite dev-logins
  after a reseed and bounces to the login screen, suspect this class of process-state
  (survives the DB wipe) — not the data.

## Audit-surfaced realities — sending-unit (the second diagram)

The sending-unit loop (send a listing → optional preferences → next listing → Tours)
surfaced these. They generalize: **a diagram verb often maps to an EXISTING feature wearing
a different name, not a gap to build** — the audit's job is to find the mapping.

- **"Send a listing" IS the broadcast-to-tenants flow.** There is no individual
  send-listing-to-one-tenant route; the Phase-1 mechanism is the broadcast composer
  (`/listings/:unitId` → "📣 Broadcast to tenants" → fill `Message` → "Preview recipients"
  → curate → "Send to N tenant(s)"), which sends a templated SMS (`[Address]`, `[Rent]`,
  `[FlyerLink]`) and records a `listing_send` row. **Curate to ONE tenant** with
  "Deselect all" → check the tenant's row by their **first name** (preview rows show the
  first name only — so `freshTenant` now mints a unique, space-free `firstName`). Assert
  delivery three ways: the fake thread (proof-of-send, body contains `/flyer/<unitId>`),
  `GET /api/contacts/:id/listings-sent` (`{ sent: [...] }`), and the timeline "Property
  sent" link (`a[href="/listings/<unitId>"]`).
- **An existing dashboard spec is a live-verified selector source.** `broadcasts.spec.ts`
  already encoded the composer selectors against the live stack — reuse those rather than
  re-deriving from component source (the "don't transcribe blind" warning is about SOURCE,
  not a passing spec). Still smoke-check the parts your scenario adds (here: single-tenant
  curation).
- **Preferences are the contact's free-form `notes`, not a structured schema.** Saved via
  the Edit-contact dialog's `Notes` textarea (`PATCH /api/contacts/:id { notes }`), shown in
  the "Preferences & notes" card. Deliberately free-form — do NOT build a preferences model.
- **A KNOWN tenant's inbound surfaces in their OWN contact timeline** — not the Unknown
  tab. `expectRelayedToTeam` is unknown-only; the relay verb for a typed tenant
  (`expectPreferencesRelayed`) just opens `/contacts/:id` and asserts the body in the
  timeline.
- **No automated matcher exists in Phase 1.** The `matches` table is seeded but unused (no
  repo/route); `GET /api/units/:id/similar` is a property-detail helper, not tenant-driven.
  "Find another match" = the team browses `GET /api/units?status=available`. Assert the
  deterministic fact (*a next listing can be sent*), **never** that an algorithm re-ranked.
- **Tours is a SEPARATE, unbuilt workflow; `searching` absorbs touring** (STATUS-MODEL.md).
  There is no tour entity to create at handoff (creating a placement would jump ahead to
  Application). The real loop-exit signal: the fitting unit's `listing_send` row exists AND
  the tenant stays `searching` (Tours-ready). Assert that — don't invent a Tours feature.
- **Set up an available property via the API:** `POST /api/units { landlordId, beds,
  jurisdiction, address:{line1,city,state,zip} }` starts a unit in `setup` (status is NOT a
  writable create field; `address` MUST be an object), then `PATCH /api/units/:id/listing-status
  { toStatus:'available', source:'manual' }` publishes it (only `available` is shareable).
  Set a tenant to searching via `PATCH /api/contacts/:id/tenant-status { toStatus, source }`.
- **Stubbed-card trap:** the tenant "Properties sent" card is wired to the backend slice but
  hard-codes the empty state (it never renders the rows — issue
  `properties-sent-card-stubbed`). Assert listing-sends via the API + the **timeline**, not
  that card. Lesson: when "assert what Team sees", confirm the rendered surface actually
  renders the data — a card can exist yet be a stub.

## Debugging discipline

When the suite is red, **find the root cause before fixing** (`superpowers:systematic-
debugging`). The reseed/epoch bug looked like four different things (rate limit, reseed
breaking login, concurrency) — each refuted by evidence — before the diagnostic
(capturing the dev-login response: 200 mint, but `/auth/me` 401) pinned it to a stale
in-memory cache. A spec that passes alone but fails in the full suite is **cross-spec
state**, usually process-memory that survives a DB reseed.

## Files

- Vocabulary: [`e2e/scenarios/steps.ts`](../e2e/scenarios/steps.ts) — reuse + extend.
- Voice seam: [`e2e/fixtures/fakeVoice.ts`](../e2e/fixtures/fakeVoice.ts).
- Framework self-check: [`e2e/tests/scenarios/selfcheck.spec.ts`](../e2e/tests/scenarios/selfcheck.spec.ts).
- Worked example: [`e2e/tests/scenarios/tenant-onboarding.spec.ts`](../e2e/tests/scenarios/tenant-onboarding.spec.ts)
  and its diagram [`documentation/tenant-onboarding-sequence.mermaid`](tenant-onboarding-sequence.mermaid).
- Second worked example: [`e2e/tests/scenarios/sending-unit.spec.ts`](../e2e/tests/scenarios/sending-unit.spec.ts)
  and its diagram [`documentation/sending-unit-sequence.mermaid`](sending-unit-sequence.mermaid).
