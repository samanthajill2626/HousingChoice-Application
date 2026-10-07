# R3-FE - adversarial re-review, round 3: dashboard + e2e half (after fix wave FW2-B)

Reviewer: R3-FE. Branch `feat/clean-org-names` @ec33ebf1; fix wave FW2-B =
e03d39aa..5848ff6d (10 commits); merge base d839494a. Plan-blind: read only the
charter, R1-ADV-FE.md, R2-FE.md, R1-adjudications.md, R2-adjudications.md,
FW2-B-report.md and the three frontend diff packages.

Covered, in the brief's order: (1) the FW2-B diff cold, line by line - above
all `useTypedOrgText.ts` and every Save / Create / Preview path through it in
ContactEditForm, ListingEditForm, UnitCreateForm and the composer (exact name,
unique / shared spelling, other kind, unknown, text equal to the stored value,
list loading, list failed, a re-read after "Yes, add it" / "Use X", a chip
removed while text is typed, the type-change unmount, Enter vs click), the
reserved note line, the re-announced alert, B14's tick restart under
StrictMode, B16's provisional override, B13 against the server's matcher, and
the composer guard down to the Send route (app/src/routes/broadcasts.ts);
(2) a fresh hunt for what rounds 1-2 missed (Settings details reads, the
pickers under a failed list, the Settle dialogs, e2e specs and selectors);
(3) challenges to the R2 rulings and the fixer's decisions; (4) whether each
FW2-B test fails with its fix reverted.

Counts: CRITICAL 0 | HIGH 0 | MEDIUM 1 | LOW 3 | INFO 4.

Every throwaway test below was run alone (`npx vitest run <file>`) and then
deleted by its exact name; `git status` shows none of them (the one untracked
file is another reviewer's R3-BE.md). Each was a PASSING assertion of the
defect. Files: `dashboard/src/routes/orgs/zz-review-R3-FE-1.test.tsx`,
`settings/zz-review-R3-FE-2.test.tsx`, `contact/zz-review-R3-FE-3.test.tsx`,
`broadcasts/zz-review-R3-FE-4.test.tsx`, `broadcasts/zz-review-R3-FE-5.test.tsx`,
`contact/zz-review-R3-FE-6.test.tsx`, and for charge 4
`orgs/zz-review-R3-FE-7.test.tsx` with two pre-fix copies of useOrgList
(`zz-review-R3-FE-prefixB14.ts`, `zz-review-R3-FE-prefixB16.ts`, from `git show`).

---

## R3-FE-1 | MEDIUM | CONFIRMED - a filter change while a Preview is in flight sends to the pre-change audience (pre-existing mechanism; B12 does not cover it)

**Answers the brief's question** "can Preview or Send still run on an
unfiltered audience by any path?": Preview can no longer START while text is
pending (no path found - see the clean list). But the guard is checked only at
the click, and the filters stay live while the preview request runs.

**Where:** dashboard/src/routes/broadcasts/BroadcastComposer.tsx:342-362
(`onPreview` adopts the result with no check that the draft it previewed is
still current), :458-479 (the review step takes `draft.draftId` LIVE),
:503-512 + :549-557 (only the Preview button is disabled while `previewBusy`;
AudienceFilters stays interactive); useComposerDraft.ts:194-197 (when the
recreate lands, the previewed draft is deleted and `draftId` switches under the
review); RecipientPreview.tsx:282-284 (Send posts the SHOWN ids to the current
`draftId`); app/src/routes/broadcasts.ts:804-836 (an explicit selection is
re-fenced but never re-checked against the draft's filter). The merge base has
the same `onPreview` (d839494a BroadcastComposer.tsx:311-317) and a filter that
changed per keystroke, so the race predates the branch; the new picker is one
more trigger.

**Scenario:** staff click "Preview recipients" with no authority filter, notice
it while 'Loading...' shows (a preview pages the whole audience, so seconds on
a large one) and pick "Atlanta Housing Authority". (a) The preview of the
UNFILTERED draft_1 lands and the review step mounts with every 2-BR tenant;
600 ms later the pick's recreate lands as draft_2 (filtered), draft_1 is
deleted, and "Send to N tenants" posts draft_1's candidates to draft_2. Tenants
of every authority are texted, and the stored broadcast says
`housing_authority: Atlanta Housing Authority`. (b) Text typed (not picked)
during the same window is dropped without a word when the review mounts - the
hint B12 added is never shown.

**Evidence:**
- zz-review-R3-FE-5.test.tsx: preview held; pick Atlanta; land candidates
  [c-dekalb]; wait for the recreate; click "Send to 1 tenant" -> log
  `previewed: draft_1 | draft_2 filter: Atlanta Housing Authority | send:
  ["draft_2",["c-dekalb"]]`; `expect(sendBroadcast).toHaveBeenCalledWith('draft_2', ['c-dekalb'])`
  passed.
- zz-review-R3-FE-4.test.tsx: preview held; type "Atlanta Housing Authority"
  (option shown, field enabled); land -> "Review recipients" rendered, the
  combobox gone, every draft `housing_authority` undefined (passed).

**Fix:** freeze the audience while a preview is in flight (disable
AudienceFilters - picker, chips, voucher chips - when `previewBusy`), AND in
`onPreview` keep the previewed id and discard the result ("The audience
changed - preview again.") when `draft.draftId` changed or a recreate is
pending when it lands. Either half alone leaves one variant open. If ruled
out of scope as pre-existing, FILE it - its outcome is a real send to the
wrong tenants.

---

## R3-FE-2 | LOW | CONFIRMED (mechanism) / PLAUSIBLE (trigger) - B16's provisional entry never yields once the server's name moves on

**Where:** dashboard/src/routes/orgs/useOrgList.ts:88 (a provisional is dropped
only by a read carrying the SAME orgId AND name), :127 (a later noteAdded for
the same orgId is ignored - the first, possibly stale, ref stays), :136-145
(the provisional's name and kind override the read's copy).

**Scenario:** a VA opens "Is this really new?"; the /check answer names o-atl
"Atlanta Housing Authority". While the dialog is open an admin renames o-atl
again (the Settings tab exists to clean names, so concurrent edits are the
use case). The VA clicks "Use Atlanta Housing Authority": noteAdded's re-read
returns "Atlanta Housing Authority of Fulton" - but B16 keeps the provisional,
so for the dialog's life the picker offers the stale name, and a later "Use
<the current name>" (a fresh /check) is ignored and its chip reads "Not on the
list". Before B16 any read of the orgId replaced the provisional. (Saving the
stale name is not data loss: D5 resolves the old name as a spelling,
app/src/lib/orgNames.ts:258-272.)

**Evidence:** zz-review-R3-FE-1.test.tsx (useOrgList): read o-atl "Atlanta HA";
noteAdded {o-atl, "Atlanta Housing Authority"} with the re-read returning
"... of Fulton" -> entries `["Atlanta Housing Authority"]`; a further reload ->
unchanged; noteAdded {o-atl, "... of Fulton"} ->
`isOnList(entries, 'Atlanta Housing Authority of Fulton', ['housing_authority'])`
is `false` (passed).

**Fix:** the list read is one strongly consistent, uncached GetItem
(app/src/repos/orgListRepo.ts:8, :162), so a read that STARTED after the answer
is at least as new as it. Tag each provisional with the load noteAdded starts;
let it override only data from an older read, and drop it when any read
started at or after its load lands (whatever the name). Let a newer noteAdded
for the same orgId replace the older one. R2-FE-7 (the stale pre-answer list)
stays fixed.

---

## R3-FE-3 | LOW | CONFIRMED - challenge to B10: under a failed list read, typed text is skipped and Save/Create succeeds without it

**Where:** dashboard/src/routes/orgs/orgCopy.ts:171 ('unavailable' is answered
BEFORE the entries are looked at); useTypedOrgText.ts:63; the forms' settle
wrappers (ContactEditForm.tsx:395-413, ListingEditForm.tsx:66-75,
UnitCreateForm.tsx:85-94); useOrgList.ts:91-94 (a failed read keeps `data`).
Contradicts UnitCreateForm.tsx:81 ("A property is never created without the
authority staff typed") and UnitCreateForm.test.tsx:334.

**Scenario:**
- New property: staff type "DCA" while the list loads; the read fails; the
  field is disabled holding "DCA" and Create creates the property with no
  `accepted_authorities` - R1-ADV-FE-1's exact harm (missing from the
  authority's facet and available view), now reached through a failed read.
  The fixer's own test pins it: UnitCreateForm.test.tsx:424 ("Create goes on
  without it", `createUnit` called with `{ landlordId }` only).
- Tenant form: "Step Up" typed in Agency (note: "Save will use Step Up.");
  a "Yes, add it" in Housing authority triggers noteAdded's re-read, which
  fails. The entries are still in hand, yet the agency is dropped and the
  dialog closes as saved.
The composer applies the opposite rule for the same situation (FW2-B decision
7, AudienceFilters.tsx:137: the field stays clearable and holds the action
back), because skipping there would cause the harm. The forms' skip causes it
here.

**Evidence:** zz-review-R3-FE-3.test.tsx test 1: Agency "Step Up" -> description
"Save will use Step Up."; re-read rejects 503; Agency note becomes "Not saved -
the list did not load."; Save -> `onSaved` called, PATCH
`{"housingAuthority":"Metro Housing Authority"}`, `not.toHaveProperty('agency')`
(passed).

**Fix:** one rule for all four hosts: when the list failed but entries are in
hand (a failed RE-read), settle against them (resolved -> commit as usual);
otherwise keep the input enabled while it holds text (clear-only, as the
composer does) and refuse Save/Create with "The list did not load - clear the
text to save without it." That still never blocks on a field staff cannot
use (R2-FE-1), and never drops typed text.

---

## R3-FE-4 | LOW | CONFIRMED (mechanism) / PLAUSIBLE (trigger) - MISSED: a Settings details read that never settles blocks every later one

**Where:** dashboard/src/routes/settings/useOrgAdmin.ts:57-61 (a request made
while a details read is in flight only sets `againRef`), :66-69 (the two scans
have no timeout or age cap), :129-137 (the once-on-stop re-read queues behind
it). Same class as R2-FE-5, which B14 fixed for the list poll only; R1 listed
"details read never aborted" as clean.

**Scenario:** an admin settles "AHA" (Clear); the action's details read hangs
(the repo documents hung requests: placement-detail-bundle-fetch-stall,
vite.config keep-alive notes). The rewrite runs and stops, the status line
says done, but the "Not on the list" table and the use counts never refresh
until the page remounts: the settled row still offers Use / Clear, and every
later action's re-read is queued behind the hung one. (Server guards refuse a
settle that no longer applies, so this is a stale page, not bad data.)

**Evidence:** zz-review-R3-FE-2.test.tsx: mount rows [AHA]; reload with the next
`getNotOnList` hung and every later one resolving []; the rewrite polled to
done; another reload -> `getNotOnList` called 2 times, `notOnList` still
[AHA] (passed).

**Fix:** give each details read an age cap (abort and restart one older than
~10 s, or `AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])`),
releasing the slot so the queued request runs.

---

## R3-FE-5 | INFO | CONFIRMED - MISSED: a failed list read marks every stored chip "Not on the list"

**Where:** dashboard/src/routes/orgs/OrgPicker.tsx:359 (`!loading && !isOnList(entries, ...)`;
after a failed first read `loading` is false and `entries` is []);
useOrgList.ts:91-94.

**Scenario:** the list read fails; a tenant's valid "Atlanta Housing
Authority" chip reads "Not on the list" beside "Couldn't load housing
authorities" - a false statement about the stored data (the chip cannot be
removed in the forms, so it misleads rather than harms).

**Evidence:** zz-review-R3-FE-3.test.tsx test 2: read rejects; chip text
`Atlanta Housing AuthorityNot on the list` (passed).

**Fix:** no mark when the list is unknown: hosts pass
`loading={orgList.loading || orgList.error}`, or the picker skips the mark
when `disabled` by a load error.

---

## R3-FE-6 | INFO | CONFIRMED - a refusal outlives its cause and contradicts the note

**Where:** dashboard/src/routes/orgs/useTypedOrgText.ts:56-63, :66-67 (the
refusal is cleared only by a text change, never re-evaluated).

**Scenario:** Save before the list loads -> "Still loading the list - try
again in a moment."; the list lands; the field is now described as "... Save
will use DeKalb County Housing Authority. Still loading the list - try again
in a moment." The same staleness hits a 'blocked' refusal whose text becomes
resolvable after a re-read.

**Evidence:** zz-review-R3-FE-6.test.tsx: held read; type "HADC"; Save -> alert
"Still loading..."; land the list; Tab -> alert still "Still loading the list -
try again in a moment." and "Save will use DeKalb County Housing Authority."
present (passed).

**Fix:** after a refused Save, show the CURRENT verdict's refusal:
`refusal: list.error || refusal === null ? null : typedOrgRefusal(verdict)`.

---

## R3-FE-7 | INFO | PLAUSIBLE (layout; jsdom cannot show it) - B17 reserves one line; the forms' longest notes wrap

**Where:** dashboard/src/routes/orgs/OrgPicker.module.css:128-134 (min-height =
one 18 px line); OrgPicker.tsx:422-426; contact/Modal.module.css (`.dialog`
max-width 30rem, `.bodyInner` padding 1rem); orgCopy.ts:108.

**Scenario:** the refusal note "Not saved - pick a name from the list, add it
as new, or clear the text." is 72 characters of 12 px text (~400+ px); "Save
will use <name>." grows with the name. A phone-width dialog has ~294 px of
content (360 px viewport - 2 x 16 backdrop - 2 x 16 padding); a desktop window
under ~520 px narrows it too. There the blur still inserts a line under the
field - R2-FE-8's reflow, on exactly the refused-text case. The fixer
acknowledged the wrap (decision 10); B19 case 1 measures a one-line note only.

**Fix:** reserve by content - render the note's text while focused with
`visibility: hidden` (out of the accessibility tree; aria-describedby still
only when shown), so the box always has the note's own wrapped height.

---

## R3-FE-8 | INFO | CONFIRMED - hint and note run together in the field's description

**Where:** dashboard/src/routes/contact/ContactEditForm.tsx:596 (hint "The
organization that runs the voucher", no period); OrgPicker.tsx:299-302.

**Scenario/Evidence:** a screen reader hears one run-on sentence, pinned by
ContactEditForm.test.tsx:876: "The organization that runs the voucher Save
will use Georgia Department of Community Affairs."

**Fix:** end the hint with a period (and update that assertion).

---

## Challenges to the round-2 rulings and the fixer's decisions

- B10 ruling ("the typed-text guard skips that picker"): R3-FE-3 - skipping is
  R1-ADV-FE-1's harm under a failed read, worst on New property; the
  composer's clear-only rule (decision 7) is the better shared rule.
- B12 ruling (Preview disabled while text is pending): sound for pending text,
  but the state that matters can change after the click - R3-FE-1.
- B16 ruling ("until a read returns that name"): R3-FE-2 - the right condition
  is "until a read that started after the answer lands"; the read is strongly
  consistent, so the name condition can only make the provisional permanent.
- Decision 10 (B17 reserves one line): R3-FE-7.
- Decision 6 (a refusal hidden under a failed list, shown again later): fine;
  its sibling, a refusal never re-evaluated, is R3-FE-6.
- Decision 8 (B14 counts ticks, not wall time): agree. Note: there is no
  backoff, so a read slower than ~5 ticks (10 s) never lands - R1-ADV-FE-5's
  symptom at a higher threshold. Acceptable for one GetItem; record it.
- Decision 3 (the unmount report replaces the manual reset): agree; the PIN at
  ContactEditForm.test.tsx "(PIN) text typed in a tenant picker goes when the
  type changes away and back" fails without it (the stale hook text would be
  committed and PATCHed).
- B13, B18, B19: agree (B13 checked against app/src/services/orgRecords.ts:542-552).

## Are the FW2-B fixes real?

Method: every new test read against its fix's parent commit in the diff; B14
and B16 also run EMPIRICALLY - the fixer's test steps executed against the
pre-fix hook (`git show 78e5fa71^` / `b5c07f9e^` copied to throwaway modules)
and against HEAD (zz-review-R3-FE-7.test.tsx, 4 passing assertions).

| fix | verdict |
|---|---|
| B10 | Real: pre-fix refuses the save (updateContact / createUnit never called) and shows the unknown-text copy while loading. Policy challenged - R3-FE-3. |
| B11 | Real: pre-fix `remove()` called `setText('')`, so the field held '' and Save sent '' / dropped the name. |
| B12 | Real: pre-fix `canPreview` ignored typed text, AudienceFilters had no `onAuthorityTextChange`, and the field was disabled under a failed list. Incomplete for the in-flight window - R3-FE-1. |
| B13 | Real: pre-fix grouped "-", "--", "()" by normalized ''. Mirrors the server exactly. |
| B14 | Real (empirical): pre-fix makes 1 read after 5 ticks on a hung read; HEAD makes 2. StrictMode case verified by trace. |
| B15 | Real: pre-fix rendered the constant "Not saved - ..." for every host. |
| B16 | Real (empirical): pre-fix entries `[["o-atl","Atlanta HA"]]` after the "Use"; HEAD `[["o-atl","Atlanta Housing Authority"]]`. Over-corrects - R3-FE-2. |
| B17 | Real: pre-fix inserted the note `<p>` only once focus left. Residual - R3-FE-7. |
| B18 | Real: pre-fix kept the same alert node on a repeated identical refusal. |
| B19 | Written after the fixes (first run GREEN), but each case would fail on the pre-fix code: case 1 (note copy B15, offset B17, commit B1), case 2 (pre-B1 saved the voucher), case 3 (pre-B12 Preview enabled). |

## Areas checked and found clean

- useTypedOrgText: the verdict is recomputed every render from (list, kinds,
  text); `settle()` records the refusal before `clearText()`, whose '' report
  clears it for a commit; handlers are rebuilt per render (no React Compiler
  in the build, dashboard/vite.config.ts:77), so Save never reads a stale verdict.
- Save / Create paths in all three forms: exact name, unique spelling, shared
  spelling and other kind (kind filter first) and unknown text and '()'
  (blocked), text equal to the stored value (tenant: never sent; multi:
  de-duplicated), list loading (refused in its own words), a chip removed
  while text is pending (kept, then settled), a type change (unmount report),
  Enter vs click (both reach onSubmit; Enter on a highlighted option picks).
- ContactEditForm's two-picker settle: a resolvable picker commits even when
  the other refuses; a later buildPatch validation error leaves the committed
  chip, which the next Save sends.
- OrgPicker: `setQuery` is reached only through `setText`, so every text
  change is reported; the unmount report reads a ref refreshed every commit;
  StrictMode's mount cleanup reports '' harmlessly; Fast Refresh aside.
- B18: the alert's key changes only on a refused settle; a plain re-render
  keeps the node; aria-describedby keeps pointing at the same id.
- B17: the line exists whenever the field holds text, a blur only fills it,
  and the note joins aria-describedby only when shown.
- B12: no path to Preview while text is pending - the composer is not a form
  (Enter does nothing), every query change is reported, the review step and
  "Change property" unmount the picker (reports ''), a failed list keeps the
  field clearable; Send exists only on the review step, where no picker is.
- B14 under StrictMode: refs survive the simulated remount, ticks reset on
  every load, a restarted read that later settles is ignored and never frees
  the newer slot, and no interval exists at mount (rewriteLive starts false).
- B16 common paths: /check refs and the POST /api/organizations entry carry
  the stored names (app/src/services/orgNames.ts:243-290), so the next read
  drops a provisional in every case except a concurrent rename (R3-FE-2).
- Settle dialogs (NotOnListSection.tsx:377-405): confirm stays disabled
  without a pick, so B11's kept text and B15's default note change no outcome.
- OrgListSection.tsx:154: a failed poll read never flips the section into its
  error state (only a never-loaded list does).
- e2e: B19's three cases (org-lists.spec.ts:360-467) drive real focus and
  layout; `pickOrgName` removes before it fills, so B11 changes no existing
  spec; no other spec types into the composer filter; the new selectors.md
  row matches the copy (it omits "Not saved - the list did not load.").
- ASCII: 0 non-ASCII characters on added lines of the FW2-B diff. No API call
  changed in this wave.
