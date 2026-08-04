<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-04).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Relay pool numbers: area-code preference (property-local, Atlanta default)

- **Status:** Approved design (brainstormed with Cameron 2026-08-03)
- **Scope:** which phone numbers we BUY for the relay pool; no change to the
  reuse/spare assignment ladder

## Problem

When a relay group chat needs a pool number, the Twilio search that backs every
purchase runs with no geographic hint, so Twilio returns the first available US
local number from anywhere - members see a random out-of-state area code. The
adapter already accepts an optional `areaCode` search hint
(`provisionPhoneNumber` in `app/src/adapters/messaging.ts`), but no caller
passes it.

## Decision (approach chosen)

**Preference only, applied at buy time.** The three-tier acquisition ladder
(reuse -> fresh spare -> connect-when-ready) is untouched; we never buy an
extra number, skip a reusable one, or consume an extra A2P sender-pool slot to
get a prettier area code. Instead, the ONE place numbers are actually bought
(`warmOneNumber` in `app/src/services/poolNumbers.ts` - both untagged buffer
refills and tier-3 connect-when-ready buys funnel through it) searches with
geographic hints in preference order:

1. **Property ZIP** (tier-3 buys for a tour- or placement-owned group only):
   Twilio `inPostalCode` search against the unit's `address.zip`. Twilio does
   the ZIP-to-locality mapping; we never maintain a ZIP -> area-code table.
2. **Preferred area codes** (all buys): each code from config, in order.
3. **Bare search** (today's exact behavior): any US voice+sms local number;
   still fails loud when Twilio has nothing at all.

Because prod's pool is currently empty (RELAY_LIVE_PROVISIONING is off pending
A2P), every number that ever enters the pool will be Atlanta-coded or
property-local from day one - so tier-1/2 picks need no area-code awareness.
Explicitly rejected: candidate ordering at tiers 1/2 (YAGNI on an empty pool)
and strict matching (buys more numbers).

## Config

New env var **`RELAY_PREFERRED_AREA_CODES`** - comma-separated NANP area
codes, default **`404,470,678,770,943`** (Atlanta metro). Parsed in
`app/src/lib/config.ts` to `relayPreferredAreaCodes: string[]`:

- Trim entries; drop empties. Each entry must be a valid 3-digit NANP area
  code (first digit 2-9, i.e. `/^[2-9]\d{2}$/`) - a
  malformed entry fails config load loudly (matching existing config
  validation style) rather than silently searching a bogus code.
- Empty string / all-empty value => `[]` => no area-code preference (ladder
  step 2 vanishes; behavior degrades to today's).
- Added to `.env.example`, `.env.dev.example`, `.env.prod.example` with a
  one-line comment, and documented in RUNBOOK.md (ops-visible knob).

## Adapter changes (`app/src/adapters/messaging.ts`)

`provisionPhoneNumber` opts gain one field; it stays a SINGLE-search primitive
(the fallback ladder is service policy, not adapter policy):

```ts
provisionPhoneNumber(opts: {
  voiceCapable: true;
  areaCode?: string;      // existing
  postalCode?: string;    // NEW - Twilio inPostalCode search
}): Promise<ProvisionPhoneNumberResult>
```

- Callers pass at most one of `areaCode` / `postalCode` per call (the ladder
  tries them in separate attempts). If both are somehow set, `postalCode`
  wins; not worth a throw.
- **Twilio driver:** thread `...(opts.postalCode !== undefined && { inPostalCode:
  opts.postalCode })` into the `available('US').local.list` call, exactly like
  the existing `areaCode` spread.
- **New error `NumberUnavailableError extends VoiceCapabilityError`** (exported
  beside it): thrown when the availability SEARCH returns zero candidates.
  Subclassing keeps every existing `VoiceCapabilityError` catch / 503 mapping
  working unchanged. The post-purchase "purchased number is not voice-capable"
  check keeps throwing plain `VoiceCapabilityError` - that distinction is what
  stops the ladder from buying twice (below).
- **Console driver:** already honors `areaCode` as a fake `+1<code>` prefix.
  Add the analogous deterministic marker for `postalCode` - prefix
  `+1<first-3-of-zip>` - so unit tests can assert WHICH hint won purely from
  the fake number. Document the collision-with-real-NPA possibility as
  irrelevant (fake numbers never leave the local loop).

## The ladder in `warmOneNumber` (`app/src/services/poolNumbers.ts`)

`warmOneNumber(conversationId?, postalCode?)`. Build the hint list:

```
hints = [ {postalCode}?          // only when postalCode was provided
        , {areaCode} per config.relayPreferredAreaCodes (in order)
        , {} ]                   // bare - today's search
```

For each hint in order, call `adapter.provisionPhoneNumber({ voiceCapable:
true, ...hint })`:

- **`NumberUnavailableError`** => that locality/NPA is sold out; log
  (`event: 'relay_warm_hint_miss'`, hint TYPE only - `postal` | `areaCode` |
  `bare` - never the ZIP or code value with the number) and try the next hint.
- **Any other error** (Twilio auth/API failure, post-purchase
  `VoiceCapabilityError`) => propagate immediately. A number that was already
  PURCHASED must never trigger another hint's purchase (no buy-and-leak).
- First successful purchase exits the ladder; the existing
  `MAX_PROVISION_ATTEMPTS` collision-retry loop wraps ladder attempts as it
  wraps the single call today (a `createWarming` collision retries the ladder
  from the top - collisions are local-only, so re-running hints is harmless).
- Bare-hint failure behaves exactly as today (throw; warm job retries/alerts).

The dedup-resume path (an earmarked warming/active record already exists)
ignores `postalCode` - the number is already bought.

Success log gains the winning hint TYPE (`relay_number_warming` +
`hintTier: 'postal' | 'areaCode' | 'bare'`) for observability. PII rule
(doc section 9) holds: never log the ZIP value or the phone number.

## Threading the property ZIP (tier-3 only)

- **`ProvisionRelayInput`** (`app/src/services/relayProvisioning.ts`) gains
  optional `postalCode?: string`. At a tier-3 `needs_connecting` result, it is
  included in the `RELAY_WARM_JOB` payload; tiers 1/2 ignore it (preference
  only). Nothing else in the provisioning chain changes.
- **`RelayWarmPayload`** (`app/src/jobs/relayWarm.ts`) gains optional
  `postalCode?: string`; `parseRelayWarmPayload` tolerates missing/non-string
  (same style as `conversationId`); the handler forwards it to
  `warmOneNumber(conversationId, postalCode)`. Riding the payload means job
  RETRIES keep the hint.
- **Callers resolve unit -> ZIP, best-effort:**
  - `POST /api/placements/:placementId/relay` (`routes/placements.ts`)
    already loads the unit for the landlord roster - reuse it.
  - `POST /api/tours/:tourId/...` group-thread route (`routes/tours.ts`)
    already has `unitsRepo`; ensure the unit is loaded on the explicit-members
    path too (one `units.getById(tour.unitId)`).
  - Standalone `POST /api/relay-groups` passes nothing.
  - ZIP normalization: take `address.zip`, strip to leading 5 digits
    (`/^\d{5}/` match on the trimmed value; ZIP+4 truncates). No match /
    missing address / missing unit => omit `postalCode` (Atlanta default
    ladder). Resolution failure must never fail group creation.
- Buffer refills (`refillBufferIfNeeded`) keep enqueueing `{}` - untagged
  spares always use the Atlanta-default ladder. The refill triggered by a
  tier-3 miss does NOT inherit the group's ZIP (spares are for anyone).

## Test seams and coverage

- **fake-twilio** (`fake-twilio/src/routes/rest.ts` + number registry): the
  AvailablePhoneNumbers route gains `InPostalCode` filter parity so e2e runs
  through the twilio driver exercise the real query params. Mirror the console
  driver's determinism: a searched `InPostalCode` yields numbers prefixed with
  the ZIP's first 3 digits; `AreaCode` already filters.
- **Unit tests:**
  - Ladder order: postal -> each configured area code -> bare; asserts via
    console-driver prefixes and a stub adapter's received opts.
  - `NumberUnavailableError` advances the ladder; any other error aborts it
    (and provably does NOT buy again).
  - Collision retry re-runs the ladder without corrupting hint order.
  - Config parsing: default list, custom list, empty => `[]`, malformed
    entry => loud failure.
  - `parseRelayWarmPayload` postalCode tolerance; handler forwards it.
  - `provisionRelayGroup` puts `postalCode` in the tier-3 warm payload and
    ignores it at tiers 1/2.
  - Route-level: placement + tour relay creation thread the unit ZIP;
    ZIP-less unit still creates the group.
- **Gates:** `npm run typecheck` + `npm test` + `npm run e2e` (backend change
  -> full suite, not the small-fix lane).

## Out of scope

- Tier-1/2 candidate ordering by area code (rejected - empty pool + buy-side
  hints make it moot).
- Any ZIP -> area-code dataset, geocoding, or locality math on our side.
- Retroactively replacing numbers already in a pool (none exist in prod).
- Toll-free or non-US search.

## Ops notes

- `RELAY_PREFERRED_AREA_CODES` ships in every env template; prod keeps the
  Atlanta default unless changed.
- Observability: `relay_warm_hint_miss` (per skipped hint) and `hintTier` on
  `relay_number_warming` tell ops whether metro inventory is drying up (a
  steady drift to `bare` means the preferred NPAs are exhausted at Twilio).
- No infra/Terraform, IAM, or schema change is ANTICIPATED (no new attributes
  on pool records). This is an expectation, not a non-goal: if the build
  surfaces a genuinely needed infra change (or a best-practices conformance
  fix), it is in scope - land it on the branch with the feature. Applying
  infra to any environment remains an explicit Cameron go, per house rule.
