<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-15).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Property-level tour type: structured default, editable at tour creation

Date: 2026-07-15
Status: APPROVED (Cameron, 2026-07-15 - the "hybrid" option) - ready for implementation
Branch: feat/unit-tour-type (worktree w:/tmp/unit-tour-type, cut from main 95f9e8e)

## 1. Context and decision

Creating a tour requires picking a tour type (self_guided / landlord_led /
pm_team) every time. That is mostly a PROPERTY-level fact, but today the only
property-side signal is the free-form `tour_process` text, and the create-tour
modal silently keyword-guesses a prefill from it (ScheduleTourForm
deriveTourType), defaulting to self_guided - an invisible guess that looks
authoritative and never shows its source text.

Constraint that shapes everything: tour type is LOAD-BEARING per tour -
reminder ROUTING branches on it (self_guided routes reminders 1:1 instead of
via the group thread, in the reminders job, the reminders route, and the
timeline). A wrong value mis-routes reminders, so the modal must keep a
per-tour override; info-only-from-property was explicitly REJECTED (a
see-but-cannot-fix modal is a trap when the property value is unset/wrong).

Cameron's decision (the hybrid): the property carries a STRUCTURED optional
tour type that the modal prefills from - with visible provenance - while the
modal picker stays editable for exceptions, and the property's free-form
tour_process text shows in the modal as context.

## 2. Goals

- G1: Units gain an optional structured `tour_type` (the existing TourType
  union), editable in the property editor + create form, displayed on the
  property page. NOT exposed on the public flyer.
- G2: The create-tour modal prefills with visible provenance:
  unit.tour_type ("From the property") > keyword guess over tour_process
  ("Guessed from the property's tour notes - check it") > self_guided
  ("Default - no tour info on the property"). Picker stays editable; a manual
  pick sticks until a NEW unit is picked (existing semantics).
- G3: The modal shows the unit's tour_process free text (read-only) beneath
  the picker when present.
- G4: Tour storage/API unchanged (TourItem.tourType, POST /api/tours body).
- G5: Gates green; lean seed stays byte-identical.

## 3. Non-goals

- NO change to tour reminder routing, tour lifecycle, or the tours API.
- NO required-ness: unit.tour_type stays optional; no onboarding checklist
  coupling; no migration/backfill of existing units (absent = unset, the
  fallback chain covers it).
- NO public-flyer exposure: the public unit projection (routes/public.ts) is
  an explicit whitelist - tour_type is NOT added to it.
- NO removal of deriveTourType (it becomes the labeled fallback).
- Lean seed untouched (byte-stable e2e baseline).

## 4. Design

### S1. Model (app)

- unitsRepo.ts UnitItem gains `tour_type?: TourType` (snake_case per the
  unit's field convention: tour_process, application_process, lease_terms).
- TourType + a labels map become shareable WITHOUT a repo->repo import:
  suggested home app/src/lib/toursModel.ts (where TOUR_STATUSES/TOUR_OUTCOMES
  live); toursRepo re-exports TourType for existing importers (keep every
  current import path compiling). Builder verifies no import cycle; if the
  move is noisier than expected, an equivalent cycle-free home is fine - the
  requirement is ONE canonical union + label map shared by units and tours.
- PATCH /api/units/:unitId accepts tour_type following the route's existing
  optional-field validation pattern: must be one of the TourType union;
  clearable (null/empty -> attribute removed) exactly the way the route's
  other optional string fields clear; 400 on anything else.
- Unit create route accepts it the same way (optional).

### S2. Property page (dashboard)

- ListingDetail details card: a "Tour type" KV row (label via the shared
  labels map; em-dash placeholder when unset) - placed near the existing
  "Tour & application process" card content so the structured + free-form
  facts read together.
- ListingEditForm: a "Tour type" select with Not set / Self-guided /
  Landlord-led / PM team, following the form's existing select conventions;
  clearing back to Not set persists the removal.
- UnitCreateForm ("New property"): the same optional select, default Not set.

### S3. Create-tour modal (dashboard/src/routes/tours/ScheduleTourForm.tsx)

- Prefill chain on unit pick (replaces the silent chain, keeps the
  manual-pick-sticks-until-new-unit semantics):
    1. unit.tour_type set -> prefill it; provenance caption "From the
       property".
    2. else tour_process non-empty -> deriveTourType(tour_process); caption
       "Guessed from the property's tour notes - check it".
    3. else -> self_guided; caption "Default - no tour info on the property".
- The provenance caption renders under/beside the type select, updates when
  the unit changes, and is replaced by nothing (or a neutral "Manual pick")
  once the staff member overrides - implementer's choice, but a manual pick
  must never keep a stale "From the property" caption.
- When the picked unit has tour_process text, show it read-only beneath the
  picker (small, quoted block; long text may clamp with full text on
  hover/title). No unit picked -> no caption, no text block.
- The submit payload is unchanged (tourType from the select).

### S4. Types/API mirror (dashboard)

- dashboard api/types.ts UnitItem mirror gains tour_type?; keep the
  hand-mirror sync comments. TOUR_TYPE_LABELS already exists dashboard-side -
  reuse it everywhere (property page + modal); do not introduce a second map.

### S5. Seeds

- FULL profile only: give a couple of cast/matrix units a tour_type that
  AGREES with their tour_process text (e.g. the unit whose text says
  "Landlord-led; text to schedule" gets landlord_led); leave at least one
  toured unit UNSET so the guess + default paths stay exercised in dev.
  LEAN SEED UNTOUCHED - byte-stable.
- Seed-coherence tests updated only if they enumerate unit fields.

## 5. Edge notes

- E1: Provenance must be honest: caption 1 ONLY when the structured field is
  set; caption 2 ONLY when a non-empty tour_process produced the guess; the
  self_guided DEFAULT must never be captioned as property-derived.
- E2: Clearing the unit pick (Clear button) resets type + caption + text
  block to the no-unit state.
- E3: The public flyer projection must NOT gain tour_type - add a test pin
  (the projection's exact-shape test is the natural home).
- E4: The units PATCH clear semantics must not leave a stray empty-string
  tour_type (match the route's existing optional-field clearing; pin with a
  set -> clear -> absent test).
- E5: ASCII only in every touched line (captions, labels, comments).

## 6. Testing and gates

- Unit (app): units PATCH/create accept + validate + clear tour_type; public
  projection pin (E3/E4); TourType home move compiles every existing importer
  (typecheck is the pin).
- Unit (dashboard): prefill chain - all three provenance branches + override
  + unit-change re-derive + clear (E1/E2); tour_process text block renders
  when present; ListingEditForm set/clear round-trip; ListingDetail KV row.
- E2E (extend the tours spec): set a tour type on a property via the edit
  form -> open Schedule a tour, pick that property -> the select shows the
  value with "From the property"; override it -> caption no longer claims
  property provenance; create -> the tour carries the override. One
  guess-path assertion on a unit with text but no structured field.
- Gates (bare, real exit codes, from the worktree): npm run typecheck +
  npm test + `timeout 1500 npm run e2e`, green on a base freshly merged with
  main ONCE (the one-main-sync rule; note later drift, do not chase it).
- Self-QA (live stack + Playwright MCP, full seed): walk the three provenance
  states live; set/clear on the property editor; verify the public flyer page
  shows no tour type.

## 7. Post-merge

Nothing required (no deps, no schema/GSI, no infra). Dev-stack restart picks
it up; existing units simply have the field unset until staff set it.
