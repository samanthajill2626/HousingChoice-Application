# Spec review R3 (reviewer B, adversarial) - DRAFT 3 delta

Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` DRAFT 3 (commit d6b2922f)
Also read: `spec-r2-adjudications.md`, `documentation/GLOSSARY.md` (DRAFT 3 edits).
Scope: the DRAFT 3 delta only (4.5 step 1/2c/2d plus the block, 4.6, 4.2 window and step 3, 4.3/4.4 "Needs placement" and the collision sentence, 3.4, 3.8 and the GLOSSARY, 5, 9 Q3/Q7/Q9/Q10/Q14).
Method: read-only; nothing executed. file:line for every claim about existing code; inferences marked UNVERIFIED. React Router internals come from the shared checkout's installed `react-router` 7.18.0, read by absolute path (no cd).

**Headline: nothing found that changes a decision.** All four decision-changing fixes are correct as stated, apart from the residuals below. The four findings are LOW precision gaps.

---

## Findings

### 1. [LOW] "Needs placement" does not cover two of the three shapes a failed conversion can leave behind

DRAFT 3 4.2 step 3 keeps a toured row with an outcome when `convertible === true` and there is no `convertedPlacementId`, and describes it as "a move-forward decision whose placement was never created". `POST /api/placements/from-tour` can fail in three places, and they leave three different shapes:

- **Placement create fails.** The claim is released (`app/src/routes/placements.ts:749-751`), so `convertedPlacementId` is absent and no placement exists. "Needs placement" is correct here, and the tour page's "Start placement" is the right retry.
- **Finalize fails after the placement exists.** The claim is released on a best-effort basis (`placements.ts:776-783`). The tour then reads as convertible and unconverted, but an ORPHAN placement with `fromTourId` already exists. The route's own comment calls this "ACCEPTED RESIDUE: a retry after a finalize-failure creates a SECOND placement" (`placements.ts:758-760`). The Past row's chip says no placement was created, which is false in this case, and its only path (row link -> "Start placement") creates the duplicate. This was already possible from the tour page; the Past tab now advertises it.
- **The release itself fails, or the process dies between claim and release.** `convertedPlacementId` keeps the `pending:<uuid>` sentinel. The server treats that as a stalled claim (`app/src/jobs/tourReminders.ts:1159-1166`, prefix check). The new predicate EXCLUDES it, because a `convertedPlacementId` is present. The tour page also mis-renders it: `isConverted` is plain string-ness (`dashboard/src/routes/tours/TourDetail.tsx:292`), so the CTA is "View placement" linking to `/placements/pending:<uuid>` (`TourDetail.tsx:528-533`). That is a pre-existing bug.

All three are rare, and the rule chosen is the right default. What is wrong is the prose: 4.2 step 3 and Q3 describe the population as "placement never created". Say instead that "Needs placement" means no LINKED placement and that an orphan may exist (the finalize-failure residue). Name the stalled-sentinel shape as an exclusion whose tour-page CTA is broken, and file it or append it to `tour-outcome-close-not-backend-enforced` or a new issue. Do not widen the predicate: listing the sentinel shape would put a row on the list whose only next step is a broken link.

Related population note, UNVERIFIED for production volume. Before 2026-07-15, move_forward did not convert automatically (`TourDetail.tsx:12-17`, "Cameron 2026-07-15"). Today's 90-day window reaches back to about 2026-06-28, so any move_forward recorded under the old two-step flow and deliberately left unconverted will surface as "Needs placement", with no way to dismiss it until it ages out in mid-October. The full-profile seed also produces one such row (`app/src/lib/seed/matrix.ts:1077-1087`, `toured` rep 1). Both are acceptable; they should be stated rather than discovered.

Also unspecified: `pastState` precedence for a `toured` tour that is `convertible` with NO `outcome`. The exit gate accepts `moveForward` alone, setting `convertible` without `outcome` (`app/src/routes/tours.ts:1174-1177`), so that row matches two table rows ("Needs outcome" and "Needs placement"). The tour page resolves it as "Start placement", because the convertible branch precedes the toured-no-outcome branch (`TourDetail.tsx:534-556`). The table should say placement wins, so the list and the page agree. This is reachable through the API only.

### 2. [LOW] Section 1 contradicts 4.2 and Q9 on today's MARKED tours

Section 1 (DRAFT 3): "A tour still scheduled for today, marked or not, stays on Active's Today group until midnight and is not repeated here." A tour marked toured or no-show is no longer `scheduled`. Active filters to `status === 'scheduled'` (`dashboard/src/routes/tours/useTours.ts:70`), so such a tour is NOT on Active's Today group, and under DRAFT 3's own 4.2 (window to the end of today; step 2 drops only `scheduled` rows) and Q9 ("lists every toured and no-show row dated today") it IS listed in Past. The intended phrase is probably "whether or not its time has passed". As written, a builder or tester reading section 1 would assert the opposite of 4.2.

### 3. [LOW] "No result is ever silent" relies on the reload succeeding, and a failed reload currently hides every result

4.5 promises every result either sits under its row or appears in the above-toolbar block "so no result is ever silent". 4.2 says a reload keeps the current rows on screen "until the new page lands"; it does not say what happens when the reload FAILS. The hook it is modeled on sets `{ status: 'error', closed: [] }` on failure (`useTours.ts:133`), and `ToursPage` renders the list only when `!loading && !error` (`ToursPage.tsx:278-284`, `339`). Mirrored, a failed reload replaces the list, every per-row result line and the above-toolbar block with "We couldn't load tours". A batch whose PATCHes all landed, followed by a network blip, reports nothing.

Say that a failed `reload()` keeps the previous rows and all results on screen and adds one alert ("Could not refresh the list"). Do not treat it as a first-load error. One sentence in 4.2 or 4.5.

### 4. [LOW] The step-1 snapshot omits the one value the new guard compares

Step 1 snapshots "tenant, property and date-time label per id". Step 2c compares the re-read's `scheduledAt` with "the one the list showed". The date-time label has minute precision ("Sep 24, 2026, 2:30 PM"), while `scheduledAt` is a full ISO instant canonicalized at write (`tours.ts:340`, `1157-1158`). If a builder takes "the one the list showed" from the snapshot, only the label is there, and comparing labels is both lossy and locale-dependent. Add the raw `scheduledAt` to the snapshot and state that 2c compares the ISO strings exactly. This works because both sides are the server's canonical `toISOString()` form, and the GSI projects every attribute (`app/src/lib/tables.ts:14`), so the range row and the GET row carry byte-identical values.

---

## The four fixes, walked (correct unless a finding above says otherwise)

### Fix 1 - two-part pre-read guard (4.5 step 2c): CORRECT, with its named residuals

Interleavings, where Staff A runs the batch and Staff B works on the tour page:

1. B reschedules a listed "Not marked" tour to Friday before A's GET. The status is still `scheduled` but the time differs, so A records "Changed since the list loaded" and sends no PATCH. After A's reload the tour sits in the future, outside the window and dropped at step 2 (it is `scheduled`), so it vanishes and the block reports it from the snapshot. Caught.
2. B reschedules to a different PAST time. Caught the same way. After reload the row is still "Not marked" at the new time and still in the derived selection (failed ids keep their raw selection), so A can re-run, and the guard now compares against the reloaded list. That is reasonable: A re-confirms against what is on screen.
3. B marks the tour no-show, or cancels it, before A's GET. The status differs, so it is caught. No-show: the row stays listed as "No show" with the failure line and drops out of the derived selection. Cancel: the row vanishes and the block reports it.
4. B's write lands between A's GET and A's PATCH. Not caught; the server accepts canceled/no_show -> toured and a same-status reschedule (`tours.ts:1065-1119`). The window is one round trip, as named.
5. B's write lands just before A's GET, but the GET is served an older replica (`tours.get` without `ConsistentRead`, `tours.ts:432-434`; `toursRepo.ts:325-337`). Not caught; named (the eventual-consistency footnote).
6. B revives a no-show or canceled tour at the SAME time. It passes the guard, which is the named residual. In the UI, the Reschedule dialog requires a time; UNVERIFIED whether it pre-fills the stored time, so this path may be API-only. Acceptable either way.
7. B's reschedule PATCH and A's toured PATCH run concurrently on the server. The last write wins on `status`, which can leave `toured` with the new `scheduledAt` and a swept ladder. This is the same class as 4, inside the round-trip window.

There is no interleaving outside the named residuals where the batch PATCHes a tour that was not `scheduled` at the listed time when it was read.

### Fix 2 - state-preserving strip (4.6): CORRECT

`setSearchParams(next, navigateOptions)` is `navigate("?" + next, navigateOptions)` (`react-router/dist/development/chunk-4ZMWKKQ3.mjs:10851-10857`), and `createLocation` uses the `state` it is given (default `null` only when absent, line 234). Passing `state: location.state` therefore keeps `{ back: '/tours/past' }`.

Walk: Record outcome link -> `/tours/<id>?outcome=1`, state `{back}`. The outer `TourDetail` loads, then `TourDetailLoaded` mounts (`TourDetail.tsx:97-134`, `key={tour.tourId}`). The effect sees `outcome=1`, calls `setModal('outcome')`, and does a replace to `/tours/<id>` with the state carried forward. `tourId` is unchanged, so `useTour` does not refetch and the keyed child does not remount, which means the modal stays open. Cancel, then the back arrow reads `state.back` and goes to `/tours/past`. Browser Back from the tour page also lands on `/tours/past` (the `?outcome=1` entry was replaced), so the dialog never reopens.

"Only when present" leaves the row-link path untouched. A StrictMode double-invoked effect would call the replace twice with the same arguments, which is idempotent (UNVERIFIED whether the dashboard mounts under StrictMode).

### Fix 3 - end-of-today window (4.2): CORRECT

- A 17:00 tour marked toured at 15:00 is `toured` with `scheduledAt` at or before the end of today. It is in range, kept (step 2 applies to `scheduled` only), and shows "Needs outcome".
- A 17:00 tour still `scheduled` is in range but dropped at step 2, so it appears on Active only.
- At midnight today's rows are "past", and nothing is double-listed at any instant: Active is `scheduled` and on or after today, Past's `scheduled` rows are before today.
- `new Date(y, m, d + 1)` minus 1 ms is DST-safe, and the November test pins it. A page left open across midnight is stale until its next load; that is acceptable and matches Active.

### Fix 4 - "Needs placement" (4.2 step 3, 4.3, 4.4): CORRECT for the shape it targets

For `convertible === true` with no `convertedPlacementId`, the tour page's CTA is "Start placement" (`isConverted` is false; the convertible branch is at `TourDetail.tsx:534-539`), so "no row action; the row link opens the tour page whose primary CTA is Start placement" holds. The gaps are the population and precedence notes in finding 1.

### Other delta items checked (no finding)

- 3.4 and its test: the two apply patches are correctly named (`app/src/services/extraction/apply.ts:459`, `704`). They are the only `deps.contacts.update` calls in the file, so "across ALL update calls" is complete.
- 3.8 and GLOSSARY: the entry sits under "Feature & label notes", the "while the box holds text" wording matches 3.6, and the Unit `notes` line now reads "INTERNAL notes". The touched lines are ASCII.
- 4.4 collision sentence: accurate, and the anchored locator in the section 5 e2e resolves uniquely.
- Section 5 contact-detail.spec "introduces" wording: accurate against lines 57-59 and 72-73.
- 9 Q10's rewording, and the 4.1 parenthetical saying the intro does not carve out undated tours, close my R2 residual.

---

## Contested adjudications

### 5. CONCEDE - all nine R2 rulings, and the recorded residuals of R2-10 and R2-11

Every R2 finding was accepted, and the text implementing each one was checked above. The four decision changes are correct apart from findings 1-4, which are wording and edge-case gaps. Nothing is left to contest.
