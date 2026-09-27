# Adversarial review, round 2 - guard fixes + undated toured tours (ec45bc83..5b30bdd5)

- Subject: bd88bb41 (fixes for round-1 findings 2-7), 12a463e6 (undated toured
  tours on the Past tab, spec 4.2a), 9a2555da (perf registry KNOWN GAP +
  refreshed Tours citations), 5b30bdd5 (docs). Diffs produced with
  `git diff ec45bc83..5b30bdd5 -- app dashboard e2e`.
- Line numbers below are AT 5b30bdd5 (read with `git show 5b30bdd5:<path>`),
  because the worktree HEAD is now the voicemail merge 28098b04.
- Read-only. No suite, e2e lane, server or port-binding process was run;
  every behavior claim is from reading source. Round-1 adjudications read:
  `guard-review-adjudications.md`.

## Findings

### 1. [LOW] A toured tour whose scheduledAt is after today is still on no Tours tab - the same "staff cannot find it" class 4.2a fixed, now a one-filter fix

- Past: the range read stops at the end of today
  (`useTours.ts:179-183`, `pastToursDateRange`); the new status read DOES
  return the row (`useTours.ts:298`), but `selectUndatedTours` discards
  every dated row (`useTours.ts:232`, `isUndated`). Active: Upcoming keeps
  only `status === 'scheduled'` (`useTours.ts:79`). Closed: closed/canceled
  only.
- Reachable two ways from the UI:
  - "Mark toured" on a scheduled tour has no time gate
    (`TourDetail.tsx:582-587`, handler `:353-358`), so a tour booked for
    Thursday marked toured on Tuesday becomes toured + future-dated;
  - "Tour already happened" accepts a future time after its warning is
    confirmed (`TourModals.tsx:208-212`, button "Mark toured anyway" `:236`;
    `pastTourTimeWarning` only warns, `tourTime.ts:34-40`); the server takes
    any valid ISO time on requested -> toured (`tours.ts` transition block,
    no future check - grep for a future guard finds none).
- Input -> wrong output: Tuesday, mark Thursday's tour toured, dismiss the
  outcome modal that `markToured` opens (`TourDetail.tsx:355-357`) ->
  the tour is on no Tours tab until Thursday (a mistyped year in the
  already-toured dialog: until that year). Both paths prompt for the outcome
  immediately, which is why this is LOW.
- Not introduced by 12a463e6 (4.2 has always ended the window at today), but
  the new read already fetches these rows: keeping `status toured, no
  decision, scheduledAt > to` in the undated/"last" group (labelled with its
  date) would close it.

### 2. [LOW] Two undated tours for the same tenant and property are indistinguishable, visually and by accessible name; the row's own invariant is now false

- `PastTourRow` docblock: "Every accessible name ends with the row's
  date-time so two tours for one tenant at one property stay distinct"
  (`ToursPage.tsx:192-193`). For an undated row `who` is
  `${tenant} at ${property}, undated` (`ToursPage.tsx:211`), so the link
  (`:243`) and "Record outcome" (`:272`) names repeat exactly, and the visible
  row is the same tenant / property / "Undated" / chip.
- Reachable: POST /api/tours has no duplicate check (`tours.ts:291` onward),
  so two requested tours for one pair can each be marked "already toured"
  with no date. Two rows, two identical "Record outcome: Tasha Nguyen at 88
  Sycamore St, undated" links; a screen-reader user (or a Playwright
  `getByRole('link', { name })`) cannot tell them apart.
- Fix shape: a second distinguishing fact on undated rows (the touch date the
  window already uses, e.g. "undated, last updated Sep 20"), and update the
  docblock.

### 3. [LOW] The undated e2e is not self-contained: alone it fails deterministically, and after an earlier failure in the file it fails as a cascade

- `tours-past.spec.ts:240-244` says it relies on "the test above" leaving
  dated rows; `:269` asserts `items.count() > 1` (non-retrying) to prove
  "last". The lean world seeds no tours (header, `:4-5`).
- Run alone (the repo's isolate-a-failing-test practice), the list holds only
  the undated tour -> `count()` is 1 -> fails. After a failure in test 1,
  Playwright starts a fresh worker for the next test and re-runs `beforeAll`
  (`:77-80`, `__dev/reseed`), wiping test 1's rows -> the undated test fails
  too, reported as a second failure that is not a second bug.
- Fix shape: create one past-dated tour inside the undated test itself.

### 4. [LOW] Contest of the finding-4 ruling: "Focus stays where the user left it (Save)" is asserted, not verified

- The Save button is `disabled={saving}` for the whole request
  (`StaffNotesCard.tsx:203`); the ruling's reason for no focus move is that
  focus stays on Save. Whether a focused button keeps focus when it becomes
  disabled is engine behavior (the HTML focus-fixup rule can drop focus to
  the body). UNVERIFIED on my side as well - but the ruling states it as fact
  without a check.
- If focus does fall to the body, a keyboard user after a 409 hears the alert
  once and must navigate back into the form; the new `aria-describedby`
  (`:194`) helps only once they reach the box. A one-line
  `textareaRef.current?.focus()` on a stale refusal (the ref exists, `:76`)
  removes the question; or verify `document.activeElement` after a 409 in
  self-QA and keep the ruling.

### 5. [LOW] Contest of the finding-5 ruling: "matching the doc and the fake" - the ORDER half of the finding is untouched

- Round 1 also reported that the harness fake checks the guard BEFORE the
  index-key refusals, while the real repo throws `EmptyIndexKeyError` /
  `RequiredIndexKeyRemovalError` inside the field loop, before any network
  call (`contactsRepo.ts:1311`, `:1320`), i.e. before the guard can be
  evaluated. The fake is unchanged: guard first (`twilioWebhookHarness.ts:2055-2063`
  at 5b30bdd5), index-key throws after (`:2071`).
- Unreachable from the PATCH route as far as I can see (the card sends only
  `staff_notes`); a fidelity gap on the seam the fake claims to mirror, not
  a behavior bug. Either reorder the fake or narrow the ruling's wording.

## Checked and found sound

Guard fixes (bd88bb41):

- Repo no-op path (`contactsRepo.ts:1341-1363`): reads with
  `consistentRead: true` exactly when a guard is present (`:1345`), applies
  the same null <-> absent / string-equality semantics as the conditional
  write, and throws ConditionalCheckFailedException on mismatch, so the route
  re-reads and answers 409/404 the same way. No write happens on this path,
  so read-then-compare has no lost-update window. Without a guard it is the
  old eventually-consistent read (`consistentRead: false`), unchanged for
  every other caller. Pinned against DynamoDB Local
  (`contactsRepo.integration.test.ts`, the two no-op cases).
- '' refusal (`contacts.ts:597-600`): '' -> 400
  `must be a non-empty string or null`; null and non-empty strings unchanged;
  spec 3.9 carries the new message (spec line 338). The card can never send
  '' (its stamp is `updatedAt ?? null` or a string from the 409 body).
- aria-describedby: the alert div carries `id={conflictId}`
  (`StaffNotesCard.tsx:170`); the textarea carries the attribute only while
  the panel is up (`:194`); the test pins presence (Cancel test) and absence
  (the no-contact 409 test). The describedby target includes the lead and
  the current note, which is what a user returning to the box needs.
- Copy: "These notes were changed since this page loaded..." is true for the
  colleague, same-user-two-tabs, lost-response-retry and stale-refetch paths
  I listed in round 1. "(The notes were cleared.)" is muted italic
  (`StaffNotesCard.module.css`, `.conflictEmpty`, `--c-text-muted` exists in
  tokens.css).
- e2e wait (`tenant-staff-notes.spec.ts:134`): the editor closes only on a
  200 (`StaffNotesCard.tsx:116`) or on a no-op compare (not this path: the
  colleague typed text); a 409 or any failure keeps it open. So
  `toHaveCount(0)` on theirs' textarea is a real "committed" barrier before
  mine is sent. The same locator form already passes as a barrier at `:65`.
- `useContact.test.tsx` now expects `staff_notes_expected_updated_at: null`
  (A has no stamp) - matches what the card sends.

Undated slice (12a463e6):

- No duplicate rows: range rows necessarily carry `scheduledAt` (the
  byScheduledAt GSI is sparse on it, `toursRepo.ts:62`); undated selection
  requires its absence (`useTours.ts:232`). A toured tour cannot gain a
  scheduledAt between the two parallel reads: a reschedule from `toured` is
  refused (`canReschedule` excludes it; `tours.ts` transition block).
- Not in another tab: Active reads the range filtered to `scheduled`
  (`useTours.ts:79`) plus `status=requested`; Closed reads closed + canceled.
  An undated toured tour left `requested`, so it leaves Needs booking.
- Bulk runner, snapshot and re-read guard unchanged: an undated row is
  `toured`, never in `notMarkedIds` (`ToursPage.tsx:382`), never `eligible`
  (`:436`), never given a result, so the vanished blocks - the only other
  place a Past row's date renders, via `whenLabel(...scheduledAt)` with a
  literal " on " (`:513`, `:523`) - can never show an undated tour.
- reload / reloadFailed / error: both reads sit in one `Promise.all` inside
  one try (`useTours.ts:292-312`), so either failure is one first-load
  error or one `reloadFailed`, rows kept; `reload()` re-runs both (epoch);
  one AbortController cancels both.
- The status read is complete: `listByStatus` walks every page with no
  `Limit` (`toursRepo.ts:366-385`), so no hidden-priority cut; the byStatus
  GSI projects ALL (`tables.ts:14`), so `scheduledAt`/`outcome`/`updatedAt`
  are present. Cost is the spec's accepted one (4.2a "Noted"): not-a-fit
  closes the tour (`TourDetail.tsx:534`) and conversion closes it
  (`placements.ts:771-775`), so `toured` is mostly work in progress.
- The 90-day window by last touch: `updatedAt` on a tour moves only on
  writes a person started - `patch` (`toursRepo.ts:410-412`; callers are the
  PATCH route, create's pointer write, conversion finalize, group
  provisioning), group-thread claim/release, conversion claim/release, the
  route's ladder CAS, roster set/clear (`toursRepo.ts:432-616`; callers in
  routes/tours.ts, routes/placements.ts, services/roster*). No background job
  bumps a toured tour, so an untouched undated tour ages out on schedule.
- Names never dangle: undated rows use ", undated" in the link, checkbox
  (never rendered) and Record outcome names (`ToursPage.tsx:209-211`); the
  page test pins the absence of " on ," / trailing " on ".
- `?outcome=1` opens the dialog on any `toured` tour with no outcome,
  independent of `scheduledAt` (`TourDetail.tsx:264-268`).
- e2e residue: the undated tour stays for later specs, but every later spec
  that touches tours reseeds (`upcoming-in-stream`, `unknown-caller-triage`,
  `tour-no-show-checkin`, `tour-roster`), and test 1 already leaves tours.

Perf citations (9a2555da):

- Correct. Traced the anchors to main (`ToursPage.tsx:181-185` = the four
  cross-reference hooks after `useTours()`, `:181-198` = through
  `unitsStatus === 'loading' ||`, `:250-346` = the h1 to the Closed list's
  `<ul>`; `useTours.ts:37-123` = `toursDateRange` to the closed/canceled
  `]);`). At 9a2555da the same code sits at `ToursPage.tsx:639-643`,
  `:639-656`, `:716-814` and `useTours.ts:47-133`, `:122-151` - exactly what
  the commit cites. The +9 on ToursPage is +4 of real drift plus a +5
  correction: c673011a's "drifted 12 lines" refresh had been 5 lines short
  (its `630-634` pointed at the function head through `useTours()`).
- Nit, not scored: the KNOWN GAP comment (`routes.ts` at 5b30bdd5, the
  TODO above `/placements`) lists the Past surface's GETs as the four tours
  reads but omits the contact/unit walks every Tours row carries
  (`TOUR_LIST_ACTIVE_GETS`, `routes.ts:274-281`); and in the contract's
  path + query-key model the Past tab's two `?status=` reads (requested,
  toured) and two `?from&to` reads share shapes - worth writing into
  `perf-pages-tours-past-surface` before someone registers the row.

Voicemail merge (28098b04) in the four shared files:

- No interaction. The harness changes are settings/media fakes and a webhook
  budget option; the contacts fake keeps the `expect` mirror (HEAD
  `twilioWebhookHarness.ts:2073-2076`). `dashboard/src/api/types.ts` adds
  `VoicemailGreeting` / `OrgSettings.voicemailGreeting`; `ContactPatch` still
  carries `staff_notes_expected_updated_at` (HEAD `:2132`). `routes.ts` /
  `routes.test.ts` change only the `/settings/voice` contract;
  `routes.test.ts:381` still pins `/tours/past` as excluded, and the Tours
  rows and citations are untouched.
