# Planner review - spec conformance (permanent flyer links)

Reviewer: independent spec-conformance reviewer (read-only on source).
Reviewed: `git diff main...3635160e -- . ":(exclude)docs/superpowers"` (45
files). Worktree HEAD 5e471d04 carries no source change beyond 3635160e
(`git diff --stat 3635160e HEAD` outside docs/superpowers is empty).
Measured against: spec rev 3 (D1-D9, sections 4 and 5), intent.md
(Decisions 1-7, Explicit NOs, Preferences), mission-block.md T1-T10.
The build's own review records were not read.

## What was checked

- Every reader and writer of the status gate. `git grep` for `SHAREABLE`,
  `FLYER_PUBLIC`, `shareable` and `'available'` comparisons in app/src,
  dashboard/src, e2e and scripts:
  - Flyer API gate: `app/src/routes/public.ts:871` uses
    `FLYER_PUBLIC_STATUSES`; missing / deleted / setup / off-list share one
    `sendNotFound` body (`public.ts:471-473`, unchanged).
  - Sign-up attribution: `public.ts:535` (`viaFlyer`) uses
    `FLYER_PUBLIC_STATUSES`. Everything downstream keys on `viaFlyer`:
    capture_source and unit_of_interest (`public.ts:629-630`), the repeat-check
    source (`public.ts:713`), the pin label (`public.ts:221-225`) and the
    ledger entry / `'not_shareable'` skip (`public.ts:784-797`).
  - Broadcast send guard: `app/src/routes/broadcasts.ts:1189`. Only the
    comment above it changed (1181-1186), and the `SHAREABLE_STATUSES` import
    is unchanged. The draft-create `flyer_url` path (broadcasts.ts:888-900)
    is untouched.
  - Composer unit list: `BroadcastComposer.tsx:376` (Available-only) is
    unchanged. Only the note's words changed (545-550). RecipientPreview's
    pre-flight check (`:391`) is unchanged. Only the 400 text (`:420`) and
    the modal body (`:758`) changed.
  - Property page: `ListingDetail.tsx:429` uses the dashboard `FLYER_PUBLIC`
    mirror, and `deleted` is now computed before it (`:422`).
  - Remaining `'available'` comparisons are not flyer gates:
    similarUnits.ts:167, ListingsList.tsx:429, unitListFacets.ts:248 and the
    D3a / D6 checks at public.ts:224 and :885. `listingLinks.ts` `flyerPath`
    has no caller.
- Public page wording. The fallback stage (`FlyerPage.tsx:293-327`) has no
  "no longer available", "taken", "removed" or status word.
  `UNAVAILABLE_PREFILL` and the "See other homes" link are gone. The served
  stage takes no status input, and the payload carries no status key. The
  remaining "available" words on a served flyer are "Same-day tours
  available" and the Same-day RTA row's "Available" value, and spec D3 keeps
  both by name.
- Tours / follow-ups. The sign-up handler and `applyFlyerShareEntry`
  (`app/src/services/shareLedger.ts:276`) write no tour, placement or
  follow-up. Follow up lists Available properties only
  (`app/src/services/followUps.ts:143-149`), so a non-Available sign-up does
  not land there. Only a staff Interested click books a tour, as Cameron
  accepted (intent Decision 6, D9).
- Explicit NOs:
  - No off switch: none was added.
  - Row buttons: the properties-sent rows are untouched (Card.tsx and
    listingFormat.ts are not in the diff).
  - Broadcast guard: unchanged.
  - Public wording: no "no longer available" or similar on any public page.
  - Setup is never documented as a take-down. `STATUS-MODEL.md` says the
    opposite, and GLOSSARY points there.
- Tests ran green: app statusModel, publicIntake and publicSignupLeads (188
  tests); dashboard FlyerPage, ListingDetail, flyerPublicMirror,
  RecipientPreview and BroadcastComposer (370 tests). Each decision has a
  test that would fail on revert:
  - D2 / D3a: a per-status whole-body `toEqual` covers all six statuses with
    the listing link nulled off Available (`publicIntake.test.ts`, the
    "every public status" block). A one-body 404 test covers setup, deleted,
    off-list and missing.
  - D5 / D6: the occupied and on_hold pin labels with refs and ledger rows,
    the no-address label, the off-list `not_shareable` case, a repeat-check
    spy keyed on the unit, and the opt-out note after the suffix
    (`publicSignupLeads.test.ts`).
  - D4: both variants with and without a number, 5xx / 429 / network /
    TypeError, and unitId boundaries at 200 and 201, trimmed and blank
    (`FlyerPage.test.tsx`).
  - D7: six statuses, setup, deleted, deleted + setup and unknown
    (`ListingDetail.test.tsx`).
  - D8: full-sentence pins (`BroadcastComposer.test.tsx`,
    `RecipientPreview.test.tsx`).
  - Parity: the app and dashboard sets (`statusModel.test.ts`,
    `flyerPublicMirror.test.ts`).
  - The `'placed'` stand-ins were moved to `'setup'`, so the boundary is
    really tested, and `'placed'` is kept only as the explicit off-list case.
  - The section 5 e2e list is covered: public-pages fallback plus the
    renamed seeded unit served read-only, listing-photos On hold served,
    environment-identity, the broadcasts D8 note and the Occupied sign-up in
    flyer-leads. e2e was not run, per the brief.

## Findings

### PC-1 - medium - D2 (existence oracle / imported unitIds); a human decision is pending

- Where: `app/src/routes/public.ts:871` (flyer gate) and `:535` (sign-up
  attribution). The spec text is at
  `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md:133-136`.
- Failure: D2 accepts "nothing beyond holding the id" on the premise that
  the import namespace "is in the private repository only". That premise is
  false. `app/src/lib/import/ids.ts:24` is on the public GitHub remote, and
  the branch's own update to `docs/issues/public-signup-abuse-hardening.md`
  (item (d)) now says so. The consequence: anyone who knows an imported
  property's address can compute its unitId. They can then load the flyer of
  any non-Setup home, including Occupied and Off market ones, and pin and
  rewrite properties-sent state against it. The code conforms to the spec as
  written, which is option (c), "accept as is". But intent.md STATE records
  this as an open question put to Cameron with options (a), (b) and (c), and
  no answer is recorded.
- Suggested fix: get Cameron's ruling before merge.
  - If (c): amend spec D2's sentence to say the namespace is public and the
    reach is accepted. No code change is needed.
  - If (a) or (b): add an imported-unit condition at both gates
    (`public.ts:535` and `:871`) and in the dashboard D7 line
    (`ListingDetail.tsx:429`), plus tests.

### PC-2 - low - D1 / section 4 vocabulary sweep

- Where: `app/src/repos/unitsRepo.ts:481`, `:483` and `:485`, and
  `app/src/lib/unitFields.ts:418`.
- Failure: these public-field doc comments still end in "Shareable.",
  meaning "part of the public flyer projection". The branch's new GLOSSARY
  entry (`documentation/GLOSSARY.md:715`) says not to call the flyer's set
  "shareable", because "shareable" now means sendable (Available only). The
  tags are harmless at runtime, but they contradict the new vocabulary in
  the same file that re-exports both sets.
- Suggested fix: reword "Shareable." to "Public (on the flyer)." at those
  four sites.

### PC-3 - info - D3 copy on a non-Available served flyer (no action)

- Where: `dashboard/src/routes/public/FlyerPage.tsx:466` and `:475` (the form
  variant's sign-up line and thank-you).
- Note: an Occupied or Off market home's flyer still says "We'll text you
  about this home and others that fit your voucher". This is exactly what D3
  requires ("renders exactly as an Available one does today"), and it is not
  a status word, so it is not a defect. It is listed only so Sam's copy
  review knows the line now appears on homes that are not open to apply.

## Verdict

The branch implements D1-D9 as written at every reader and writer of the
status gate. The flyer API and the sign-up attribution both moved to
`FLYER_PUBLIC`. The broadcast guard, composer list and pre-flight check are
byte-unchanged in code. No public page says "no longer available", taken,
removed or a status word. A flyer sign-up creates no tour or follow-up. All
five Explicit NOs hold, and the tests are specific enough to fail on revert.
No blocking or high conformance defect was found. The one item that should
gate the merge is PC-1. It is not a code defect but an unanswered human
question: spec D2's premise about imported unitIds is false, and the build
defaults to "accept as is". Cameron's ruling should be recorded, and the
spec sentence amended or the gate narrowed, before the merge. PC-2 is a
cosmetic comment sweep and PC-3 needs no action.
