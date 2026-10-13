# Code review round 2 - Reviewer A (SPEC CONFORMANCE) - feat/last-heard-from

Date: 2026-10-13. Tree: fix-wave tip 72c522f0 (fix diff 177bae7a..72c522f0).
Same brief and rules as round 1 (`conformance-findings.md`). Inputs read:
`adjudications-round1.md`, `fixwave1-report.md`, `.superpowers/review/fixwave1-diff.txt`
(the live tree re-read around every hunk), `adversarial-findings.md`, and the
self-QA record `../self-qa/self-qa.md` with its screenshots.

Counts (round 2): BLOCKER 0, MAJOR 0, MINOR 1, NIT 3.
Closures: A-1 FIXED (measured), A-2 FIXED as ruled (comment), A-3 FIXED.

## 1. New findings (most severe first)

### R2-1 MINOR (CONFIRMED) - whether a decline comes back after a canceled tour depends on WHICH button made the tour

This is a challenge to the ADV-1 ruling ("behavior kept - the approved spec's
literal rule"), and a gap my round 1 missed (I marked D11 CONFORMS).

- Where: `app/src/lib/listingSendOutcome.ts:47-59` (supersession recomputed on
  every read) + `app/src/lib/listingSendTour.ts:106-118` (a canceled / no_show
  / not-a-fit tour contributes nothing) vs the Interested route, which REMOVES
  the record (`app/src/routes/units.ts:1329-1347`). The record survives every
  other tour-creating path (POST /api/tours - the Schedule tour form, the Tours
  page, the contact page's "+ Tour").
- What is wrong: spec D11 (`spec:184-185`) and 5.4 (`spec:533-538`) say a tour
  supersedes a decline "from ANY tour-creating path (the Schedule tour form,
  the Tours page, the contact page, the Interested action)" and that "A
  superseded `declined` record stays on the row and is simply ineffective".
  The shipped rule makes supersession by a tour TEMPORARY, and only for the
  non-Interested paths: the Interested path deletes the record, the others do
  not, so after the same later cancel the two pairs read differently. The spec
  calls out exactly one acceptable resurrection - a superseding SHARE that later
  fails (`spec:539-542`) - not a canceled tour. So "literal rule" holds for the
  formula but contradicts two sentences of the same section; it is a product
  inconsistency, not a settled rule.
- Failing scenario (proved): decline at 06-25 on a counted send.
  (a) A stale client clicks Interested -> tour created AND decline cleared;
  the tour is later canceled -> the row reads `no_reply` (Waiting, on Follow
  up). (b) Instead, staff schedule the tour from the Tours page -> Interested;
  the tour is later canceled -> the row reads `not_interested` (off Follow up,
  grouped Not interested, unchecked with a tag in the next Matching preview).
- Proof: throwaway `app/test/conformanceA2.review-tmp.test.ts` (deleted),
  harness world: case R2-2a -> GET recipients `interested`, then all tours set
  `canceled` (+ lastMarkedAt) -> `no_reply`; case R2-2b -> `interested`, then
  canceled -> `not_interested`. `cd app; npx vitest run test/conformanceA2.review-tmp.test.ts`
  -> 3 passed (log `.superpowers/review/reviewerA-r2-tmp.log`).
- Smallest fix: this stays Cameron's call (the ruling already raises it), but
  the evidence for the reviewer's narrow alternative is now stronger: let a
  NON-qualifying tour still contribute its `createdAt` (never its
  `lastMarkedAt`) to the supersession instant. That makes every tour-creating
  path equivalent (matching D11 and "simply ineffective") and keeps "staff
  canceled the tour BECAUSE of the decline" correct. Until he answers: reword
  the two new comments that call the behavior "deliberate per spec 5.4"
  (`app/src/repos/listingSendsRepo.ts:106-113`,
  `app/test/listingSendOutcome.test.ts:99-103`) to "the literal formula;
  conflicts with 5.4/D11 prose; pending Cameron", and file it (R2-3).

### R2-2 NIT (CONFIRMED) - after the ADV-3 reorder, a clear that THROWS after a successful create answers 500 and leaves the decline stored

New code (fix wave), reviewed cold.

- Where: `app/src/routes/units.ts:1329-1347` - the post-create
  `listingSends.clearDeclined` is awaited with no catch, so a non-condition
  error (throttle, network) escapes as Express's 500 after the tour and its
  `listing_interested` event were already written.
- What is wrong: the response says nothing was saved ("Couldn't save - try
  again.", `dashboard/src/lib/listingOutcomeErrors.ts`) although the tour
  exists. That is the A-3 honesty contract the same fix wave introduced, broken
  the other way. Spec 5.4's intent - a failure stays recoverable by a second
  click - still holds (the retry finds the tour, creates nothing, records
  nothing). But the stale decline stays on the row, and under R2-1 it comes back
  if that tour is later canceled, although the click's whole purpose was to
  clear it.
- Proof: same throwaway file, case R2-1: an effective decline, the unit typed,
  `clearDeclined` throwing -> status 500, `body.saved` undefined, `toursMap.size`
  1, stored `declined` still present, events `['listing_interested']`. Passed.
- Smallest fix: the clear is now cleanup (the new tour already supersedes the
  decline). Catch its error after a create, log it at error ("decline clear
  failed after create - stale decline left"), and continue to the
  re-projection (200 Interested), or answer 503 `{ saved: true }`. Either is
  honest. The left-behind record is then R2-1's concern.

### R2-3 NIT - the deferrals are only named in the handback, not tracked in docs/issues

This challenges the "NO CHANGE" list and the out-of-scope parts of the
adjudications.

- Where: `adjudications-round1.md` "NO CHANGE" (ADV-4, ADV-6), A-2 ("formatter
  alignment is out of scope"), ADV-1 ("RAISED FOR CAMERON"); no
  `docs/issues/` entry exists for any of them (`git diff 16ca96cc..HEAD --stat
  -- docs/issues` shows only the C6, denormalize, tenant-row and
  tour-create-no-dedupe files).
- What is wrong: AGENTS.md:350-356 - "Bugs, gaps, debt, and deferrals go in
  `docs/issues/`". A handback line is lost at merge; ADV-1 in particular is an
  open product decision with a PIN test that says "change only with that
  call".
- Smallest fix: one tier-2 issue for the decline-resurrection decision (R2-1 +
  ADV-1, with both options and the R2-2a/b evidence). One small issue (or
  `TODO(slug)` markers at `app/src/services/followUps.ts:44` and
  `shareLedger.ts`) for the formatter split and the 30003-retry edge (ADV-4).
  ADV-6 is a spec non-goal and may stay recorded only.

### R2-4 NIT (CONFIRMED, spec-text) - on a contact card every Undo button has the same accessible name

Missed in round 1.

- Where: `dashboard/src/routes/contact/Card.tsx:387`
  (`Undo not interested for ${name}`) with `name={personName}` for EVERY row on
  the contact cards (`TenantFile.tsx:345`, `PartnerFile.tsx:203`).
- What is wrong: the copy table's Undo name has no `<address>`, and on the
  contact page `<name>` is the page's own contact. So two declined properties
  give two identical "Undo not interested for Tia Moss" buttons, while the Mark
  buttons on the same card are unique (they carry the address). The code is
  verbatim to the copy table; the table is what is under-specified.
  Screen-reader and voice-control users cannot tell the buttons apart.
- Proof: code reading (the name is the same prop on every row of one card).
- Smallest fix (a copy decision, so the orchestrator rules): on the contact
  cards, render `Undo not interested for <name> at <address>` - the
  property-card form can stay. The e2e Undo selectors are row-scoped
  prefix regexes (`send-outcome-cards.spec.ts`, `follow-up-tab.spec.ts`) and
  survive the change.

## 2. The fix diff, reviewed cold

| item | verdict | evidence |
|---|---|---|
| A-3 `wrote` flag | CONFORMS (spec 5.4 "after a successful write") | `units.ts` `wrote` set only after create / setDeclined / clear 'ok'; both late 503s use it; tests `listingSendOutcomeApi.test.ts:261`, :284 (33/33 green, run singly) |
| ADV-3 reorder (create before clear) | HONORS 5.4's intent, with R2-2 | a create failure now leaves the decline and timeline untouched (`:392` test); the retry stays single (existing tour -> no create, no event); `declineEffective` judged on the pre-create tours; the 'not_found'-after-create -> 503 saved path is consistent with A-3. Event order is now interested-then-cleared (one shared `at`; the unit Activity lists "not interested cleared" above "interested - tour requested") - acceptable |
| ADV-2 projected read | CONFORMS (5.6 field list; 14.3 B7 requireComplete) | `followUps.ts:77`, :145 - RECIPIENT_PROJECTION (`contactsRepo.ts:1043-1055`) carries every attribute the builder reads (name parts, phone, type, role, status, deleted_at, sms flags, last_heard_from_at); the typeless-contact skip (:156) is unreachable for a real item. Spec 5.6 names `getManyByIds`; the substance (same fields, required, 503) is kept |
| ORCH-1 heading name | CONFORMS to markup F2 and the e2e | `FollowUpView.tsx:236` `aria-label="<unitLabel> - <n> waiting"`; the section takes it via `aria-labelledby`; the visible text is unchanged (copy table: heading = unitLabel, sub `<n> waiting`); F2 needs the heading to START with unitLabel and contain `<n> waiting` - it does; `follow-up-tab.spec.ts:122-124` `^<line1>` still matches (unitLabel starts with line1). Self-QA on 72c522f0 read the name "Q84105 Untyped St, Atlanta, GA 30314 - 2 waiting". The full e2e on the fix tip is still owed (S10) |
| A-1 CSS | CONFORMS (5.7, 14.5 F6) | see section 4 |
| A-2 comment | CONFORMS (as ruled) | `followUps.ts:44-47` now names the server formatter |
| ADV-1 comment + PIN | behavior unchanged; wording challenged | R2-1 |

## 3. Re-walk of the most-touched spec items (what round 1 might have missed)

- 5.4 outcome route: re-read whole (`units.ts:1230-1414`). Order is now
  unit -> deleted -> counted row -> body -> recipient read -> (interested:
  type 400 -> requireTenantContact -> tours read -> existing? -> 409
  tour_type_required -> CREATE -> CLEAR) -> re-projection. The only gaps found are
  R2-1 and R2-2. A missing contact may still be declined or cleared through the
  API (the cards offer no action); the spec does not forbid it. Not a finding.
- 5.6 follow-ups: re-checked with the projected read. The `Text` action
  navigates to `/conversations/<1:1 id>`, which redirects to the contact page
  (`ConversationDetail.tsx:156-160`); that page opens on the comms pane
  (`ContactDetail.tsx:191`, default 'comms'), so "opens the 1:1 conversation"
  holds on phone widths too.
- 5.7 contact header: measured (section 4). The copy table was re-walked
  string by string after the fix wave: the only text change is ORCH-1's name,
  which is additive to the visible copy. R2-4 is the one
  copy-table-level weakness.

## 4. Closures - real or plausible?

- A-1 FIXED (measured twice). (1) The self-QA on the real page at 360px
  (`../self-qa/self-qa.md` section 2): the heard span is whole, scrollWidth 114 =
  clientWidth 114, right edge = the facts line's right edge, and the facts text
  ellipsizes. (2) My own Chromium replica of the header CSS at a 360px frame
  (24px content pad, 16px header pad), facts "Voucher 2BR - Atlanta Housing
  Authority", label "Last heard from Today 2:14 PM":
  - OLD rules: the heard span ran from 268 to 431px against a 320px line end,
    so it was clipped.
  - NEW rules: facts text 105/216px (ellipsized), separator 11px, heard span
    156-320px with scrollWidth = clientWidth = 164.
  - No-facts case: heard span 137px whole.
- A-2 FIXED as ruled: the comment is corrected; the two spellings remain by the
  ruling. Screenshot 13 shows "Typed Ave, Atlanta, GA, 30314" on the contact
  card, while the Follow up heading reads "..., GA 30314" - see R2-3 for
  tracking.
- A-3 FIXED: an Interested click that wrote nothing now answers a plain 503
  (pinned at `:261` and `:284`; the file ran 33/33 green). The fix's own new
  edge is R2-2.

## 5. Runs and a disclosure

- Single files, run after `p3-e2e.exit`:
  - app `test/listingSendOutcomeApi.test.ts` 33 passed
  - app `test/followUps.test.ts` 14 passed
  - dashboard `src/routes/broadcasts/FollowUpView.test.tsx` 18 passed
  - throwaway `test/conformanceA2.review-tmp.test.ts` 3 passed, then deleted
  - logs: `.superpowers/review/reviewerA-r2-*.log`

  `git status --short` shows none of my files.
- DISCLOSURE: for the A-1 replica I used the project Playwright MCP page
  (`about:blank`, then `document.write`) at 18:00:38 EDT. The orchestrator's
  self-QA was driving that same shared page on lane 10 at the time; its
  screenshots 12-13 were saved at 18:00:44. I opened both: they show the real
  app (property Activity; Alpha's Properties sent), not my page. I touched no
  app, lane, port or data. Still, please confirm the section-6 timeline reads
  in `self-qa.md` were taken after a fresh navigation. A reviewer should not
  share the MCP page while self-QA runs.
