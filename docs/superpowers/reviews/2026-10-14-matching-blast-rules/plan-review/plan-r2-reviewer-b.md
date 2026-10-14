# Plan review round 2 - reviewer B (adversarial; whole plan, new rulings first)

Plan: `docs/superpowers/plans/2026-10-14-matching-blast-rules.md` @fdda1242 (PLAN v2:
section 4.1 rulings AR22-AR32 win over slice text). Inputs read: the v1->v2 diff, reviewer
A's round-1 report, the adjudications. Read-only; no test was run (none was needed to
settle a finding - each one is a literal comparison of a ruling against code or a test the
ruling does not amend).

Order of this report, as charged: (1) what we all missed, (2) the new rulings as
unreviewed material, (3) contested adjudications, (4) correct or merely plausible.

## Summary

No BLOCKING or HIGH. Two MEDIUM, both the same shape: a new ruling changes behavior that an
EXISTING or ALREADY-PLANNED dashboard test pins, and the ruling does not amend that test, so
a builder who applies the ruling literally gets a red suite and must guess which side wins.
The server half (S1/S2, not my round-1 focus) holds up on a fresh read: the resolver walk,
the parse/list-check/echo, `storedFilterRefusal` over a list, `buildReviewRows`, the create
estimate and path (c) match D1/D2/D5/D6/D8, and AR32's string reaches every assertion of
it.

---

## 1. [MEDIUM] AR26 disables "Change" during a preview, which breaks an existing pinned test the ruling does not mention

What is wrong. `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx:946-970` ("a
property changed while the preview loads: its result is never reviewed under the next
property", inside the code review R3-FE-1 describe at `:798`) clicks Preview, holds the
preview in flight, then clicks `Change property` (`:959`) and picks 12 Oak St (`:960`). AR26
(plan line 509-514) makes that button `disabled` while `previewBusy`. React does not run
`onClick` on a disabled button, so `onChangeProperty` never runs, the property step never
renders, and `findByRole('button', { name: /12 Oak St/ })` fails. No S3 task edits this
test; the S3 facts list it among the tests that keep passing.

What it implies. A literal builder hits an unexplained red in Task 3.5 (or wherever AR26 is
applied) and must choose between deleting a test an earlier code review pinned and not
disabling the button. The ruling must say which: either (a) rewrite `:946-970` to assert
Change is disabled while the preview loads (and then the "belt" in AR26 is unreachable from
the UI - see finding 5), or (b) drop the disable and keep only the belt, which preserves the
R3-FE-1 behavior this test pins (the late result is already dropped by `currentPreview`,
BroadcastComposer.tsx:404-410). See also section 3 (contested).

## 2. [MEDIUM] AR23 ("no draft while the prefill is unsettled") contradicts two Task 3.5 tests it does not amend

What is wrong. AR23 (plan line 487-496) makes the composer create NO draft while
`prefillPending`. Two tests Task 3.5 already writes assume a draft IS created then:

- "with a property and the filters on, Preview waits for the organization list - the draft
  alone does not enable it" (plan line 9425-9437) leaves the org list unresolved and waits
  for `getByRole('status')` to read `Reaches 5 recipients` (`:9430`). Under AR23 no create
  happens, the reach line stays pending, and the `waitFor` times out. AR23's own new test
  ("with the org list unresolved, createBroadcast is not called") asserts the opposite.
- "an ABORTED property load is neither loaded nor failed" (plan line 9466-9478) rejects
  every `getUnit` with an AbortError, so `loaded` never settles and the gate never opens; it
  then waits for `Reaches 5 recipients` (`:9471`). Under AR23 no draft is ever made: the test
  can never pass.

Both are also in Task 3.5 Step 2's exact RED list (plan line 9570, 9573), so the expected
counts there are wrong too.

What it implies. A red Task 3.5 GREEN step that the ruling text does not explain. Amend
AR23 to say: in the first test replace the `Reaches 5` wait with "createBroadcast not
called and the reach line pending", then resolve the list and expect exactly one create;
in the aborted-load test drop the `Reaches 5` wait and assert no create.

## 3. [LOW] AR23 leaves the hook change unspecified where its branches interact

What is wrong. `useComposerDraft`'s one effect (`useComposerDraft.ts:158-258`) has three
early exits: no body (`:160-172`, which resets reach state only when `clearedRef` is false),
same key as the live draft (`:180-185`), and the debounce. AR23 says only "makes no create
(and deletes nothing) and reports reachPending: true". Unstated: whether `hold` is an effect
dependency (it must be, or a hold that flips on mid-debounce does not cancel the timer),
whether the hold check comes before or after the no-body exit, and whether `reachPending` is
DERIVED (`reachPending || (hold && hasBody)`) or WRITTEN with `setReachPending(true)`. A
written flag set while the body is empty is never cleared: with a property load that fails
(body stays empty), the no-body branch skips its reset because `clearedRef` is already true,
and the reach line reads "Estimating reach..." until staff type. AR23's tests (org list
unresolved -> no create -> one create) do not exercise that path.

What it implies. Specify: `hold` is in the effect deps; it is checked after the no-body
exit; `reachPending` is returned as `reachPending || (input.hold === true && hasBody)`.

## 4. [LOW] AR25's "whenever the draft key changes" invites a new lint error that gate 5 would block

What is wrong. The obvious way to clear the 503 alert "whenever the draft key changes" is
`useEffect(() => setRulesUnavailable(false), [draft.key])` - a synchronous setState in an
effect body, exactly what `react-hooks/set-state-in-effect` flags (the same rule already
flags BroadcastComposer.tsx:205, `setUnit(null)`). That is a NEW error in a touched file:
Task 3.5 Step 5 expects exactly 3 pre-existing errors, and AGENTS.md gate 5 makes a new one
blocking.

What it implies. A builder who takes the obvious route fails the lint step and must design a
replacement. The ruling should prescribe the derived form: store the draft key the 503 was
for (`rulesUnavailableFor: string | null`) and render the alert only while
`draft.key === rulesUnavailableFor`. That covers every case AR25 lists (filter, message and
property changes all change the key) with no effect.

## 5. [LOW] AR26's "belt" cannot be built as worded, and with Change disabled it is reachable only by a URL change

What is wrong. "rejectAuthority ignores a 422 whose captured property id no longer equals
the current one". `onPreview` runs the `rejectAuthority` of the render that started it
(Task 3.5 step 10); that closure cannot see the CURRENT property without a ref, and writing
a ref during render is the `react-hooks/refs` error already on `useComposerDraft.ts:140`.
The workable form - inside the functional `setEdits` update, return `prev` unchanged when
`prev.unitId !== unitKey`, and skip `setAuthorityNotice` - is not what the ruling says. With
the button disabled (finding 1, option a) the only way the property changes mid-preview is
a `?unitId=` URL change without a remount.

What it implies. State the mechanism, or drop the belt if the disable stays.

## 6. [LOW] AR24's "while loading, today's loading behavior stays" literally keeps the flash it was written to remove; a failed units read is unspecified

What is wrong. Today, while `getAllUnits` loads, `unitCandidates` is `[]`
(BroadcastComposer.tsx:97) and the empty-state paragraph renders (`:482-484`). "Today's
loading behavior" IS that paragraph, so read literally the ruling shows the new copy during
loading, which is the defect. A failed read is swallowed (`:195-197`); the ruling does not
say whether it counts as loaded (then "No Available properties" is a false claim after a
network failure) or not (then the picker shows nothing, forever).

What it implies. Say "nothing renders in the empty-state slot until the read settles", and
say what a failed read shows (today's copy has no failure message; the simplest honest
choice is to set the loaded flag only on success).

## 7. [LOW] AR27 rests on a stale count and overrides a decision the repo records

What is wrong. AR27 (plan line 515-526) and AR19 assume the repo count is 23 and becomes 21.
The branch base's `docs/issues/lint-backlog-repo-wide.md` (title line 3; status block
`:13-21`, updated 2026-10-13, commit 3454a0ee, an ancestor of a2b3d80d) already records
**22 errors across 17 files** - and says AGENTS.md's "23 errors across 18 dashboard files"
"is a dated (2026-10-07) statement and is left as it is". So: the expected result is 20
(not 21); editing AGENTS.md reverses a recorded decision without saying so; "the matching
count" in the issue is ambiguous (the title, the 2026-10-13 block or the 2026-10-07 block);
eslint's summary line prints no file count, so "file count" needs its own command; and
editing "ONLY ... AGENTS.md's gate 5 sentence" leaves AGENTS.md:237 ("fails on the 23
pre-existing errors above") contradicting the new number two paragraphs later. My own
round-1 finding 6 carried the same stale 23.

What it implies. Either honor the recorded decision (update only the issue: retitle and add
a dated status block from the measured count) or supersede it explicitly and edit both
AGENTS.md mentions (`:222-224` and `:237`), with the command that yields the file count
(for example `npx eslint . -f json` counted per file, captured to a file, no pipe).

---

## The other rulings (checked, no finding)

- AR22 (draft-delete e2e): sound. Waiting for `Preview recipients` enabled implies
  `draftKey === key` (BroadcastComposer.tsx:388-394), and the page's `response` event for
  that create fires before the hook's state update can enable the button. With AR23 there
  is one create in that test anyway. Filter the recorded responses to `POST` + path
  `/api/broadcasts` + status 201, as the current `waitForResponse` does (`:411-413`).
- AR28-AR31: consistent with the slice text they amend; AR31's two lines are confirmed
  (step 3b's header and step 3h's comment each name Tasha once).
- AR32: complete. The old truncation string is asserted in exactly one plan test (Task 2.3
  T-Edit 1, plan line 5424) and produced in one place (Task 2.3 I-Edit 2, plan line 5738); no
  dashboard or e2e code reads it (the dashboard sends path (a) only; RecipientPreview's
  `/cap/i` branch, RecipientPreview.tsx:385, is for path (a)'s cap message). The existing
  over-cap test's injected resolver (`count: 5000`, 3 contacts, `truncated: true`,
  `app/test/broadcastApi.test.ts:648-687`) still takes the truncation branch under the new
  `finalContacts.length` cap check.

## Server half (fresh read; no finding)

Resolver (Task 1.3, plan 2555-2664): one walk per status in `BLAST_TENANT_STATUSES`, a
shared `maxPages`, `truncated` when the cap stops with a page unread, the status and type
belts, any-of on the trimmed value, empty list = no filter. Parse (Task 1.4, 3096-3146): AR3
honored (null = absent, both-keys first, raw-array cap, legacy 400 kept); list check and
wire echo correct. `storedFilterRefusal` (3526-3549) checks every member in order. Create
estimate (Task 2.2, 5250-5267) counts `checkedByDefault` over all rows and omits the count
only on `AudienceRulesUnavailableError`. Path (c) (Task 2.3, 5677-5751) reads the rules
before the empty and cap checks (AR12) and caps the final set. No app test outside
`broadcastApi.test.ts` asserts `estimatedCount` or `declineLabelsUnavailable` (grep of
`app/test`).

## 3. Contested adjudications

- **B5 -> AR26: contested in part.** The adjudication accepted the fix "Change is disabled
  while a preview is in flight" without checking that
  `BroadcastComposer.test.tsx:946-970` pins the opposite UI path (a property change during a
  preview, whose late result is dropped). Either keep the disable and amend that test in the
  ruling, or drop the disable and keep the belt. Finding 1.
- **A1/B6 -> AR27: contested on the premise.** The ruling's count (23 -> 21) and its AGENTS.md
  edit ignore `docs/issues/lint-backlog-repo-wide.md:13-21`. Finding 7. (I concede that my
  round-1 B6 shared the stale count.)
- B2 -> AR23: not contested on substance (it serves spec goal 5 and removes the B1 race at
  the source); contested only in execution (findings 2 and 3).
- All other rulings: conceded.

## 4. Correct or merely plausible

- AR22, AR28, AR29, AR30, AR31, AR32: correct.
- AR23: correct in intent, incomplete as an instruction (findings 2, 3).
- AR24: correct in intent, wrongly worded (finding 6).
- AR25: correct in intent; its most literal implementation breaks the lint gate (finding 4).
- AR26: plausible only - its disable contradicts a pinned test and makes its own belt
  unreachable (findings 1, 5).
- AR27: plausible only - right step placement, wrong premise (finding 7).
