# Plan review round 1 - reviewer B (adversarial; dashboard + e2e halves)

Plan: `docs/superpowers/plans/2026-10-14-matching-blast-rules.md` (PLAN v1, @ccc32a88)
Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` (rev 5)
Focus: sections 0-4 (binding), 7 (S3 dashboard), 8 (S4 e2e/docs/completion), and their
seams with 1.1 / 2.6 / 2.7. Read-only review; no tests were run.

## Summary

No BLOCKING or HIGH defect found in the dashboard or e2e halves. Every spec decision on the
dashboard side (D2 wire shape, D3/D3a/D3b prefill and ownership, the settle gate, D5 server
`checkedByDefault` plus the hand-pick case, D7 labels/names/notes/503/truncation, D8 caption
and reach, D9 Available-only) maps to a concrete task with a real RED case, and the new e2e
spec covers every item of spec section 6. The S3 old_strings I spot-checked match the files
at a2b3d80d (types.ts :3265-3275 and :3497-3512, broadcastFormat.test.ts :27-34,
RecipientPreview.tsx :99-111, :294-336, :528, :582, :650-655, BroadcastComposer.test.tsx
:107/:131/:234/:496/:677/:687-688/:744/:829, selectors.md :132-134, :147). Findings below
are one MEDIUM e2e flake vector the plan's spec inventory (F16-F21) missed and several LOW
items.

---

## 1. [MEDIUM] The draft-delete e2e test gains a new supersede-and-delete race; F16-F21 never examine it

What is wrong. `e2e/tests/dashboard-next/broadcasts.spec.ts` test "compose a draft, see it
in the Drafts list, delete it" (`:398-440`) registers `page.waitForResponse(...)` for the
FIRST `POST /api/broadcasts` response after the heading shows (`:411-413`), fills the
message, and then looks for THAT draft id in the Drafts list (`:420-424`). The composer
deletes a superseded draft as soon as a newer create lands
(`dashboard/src/routes/broadcasts/useComposerDraft.ts:218-221`), and every material change
restarts a 600 ms debounce (`:28`, `:187-190`).

Today the only late filter change after the fill is the voucher-size prefill on the unit
load. After Task 3.5 the filter ALSO changes when the organization list lands: the derived
`authorityPrefill` (plan step 8, Task 3.5) needs both the unit and the list, and unit-0001
accepts Atlanta Housing Authority, which maps. So whenever `GET /api/organizations` lands
more than 600 ms after both the fill and the unit load, the first create fires without the
authority, the list then changes the filter, a second create supersedes the first and the
hook deletes it - the id the test captured. The test then waits 10 s for a row that no
longer exists and fails.

Evidence. Plan section 8 F16-F21 (plan lines 10592-10627) list what breaks and what does not;
this test is in neither list, and Task 4.1 (files list, plan lines 10696-10702) does not
touch it. The composer reads the list concurrently with `getAllContacts({ type: 'tenant' })`
(BroadcastComposer.tsx:279-288), which walks every tenant page of the lane, so the list read
is not guaranteed to win.

What it implies. A probabilistic failure in gate 4 that AGENTS.md classifies as a
regression ("there is no longer a named-flake re-run list"). Fix in Task 4.1: capture the
LAST create (wait for `Preview recipients` to be enabled - the gate now implies the prefill
settled - and read the id from the most recent create response), or assert the prefilled
chip before filling. Add the test to F16-F21 either way.

## 2. [LOW] The reach line can show a pre-prefill draft's count while Preview is still gated

What is wrong. The draft hook creates a draft as soon as the body is non-empty
(`useComposerDraft.ts:158-201`); the body is filled on the unit load, independent of the
org list. If the list lands after unit-load + 600 ms + the create round trip, the reach
line shows "Reaches N recipients" for a filter WITHOUT the property's authorities (every
Searching/Onboarding tenant of the size) until the list lands and the draft is recreated.
The plan's gate only disables Preview (`prefillPending`, Task 3.5 step 8/18); the reach
line is not gated or marked pending.

Evidence. Spec goal 5 and D8 ("shows the number of rows that will START CHECKED");
AR16 (plan line 444-453) reuses only the "Sizing the audience" hint for the gate.

What it implies. A transient, wrong-for-this-property number in front of staff (it will
usually be much larger than the final one). Cheap fix: render `reachPending` (or hide the
count) while `prefillPending`.

## 3. [LOW] Task 3.6's new empty state shows during the property load, and its unit test cannot tell loading-empty from loaded-empty

What is wrong. `unitCandidates` starts as `[]` (BroadcastComposer.tsx:97) and the empty
state renders on `unitCandidates.length === 0` (`:482-484`), so "No Available properties. A
property must be Available to send." now flashes on EVERY bare and `?contactId=` entry while
`getAllUnits` walks the portfolio - a false statement where the old copy ("No properties
yet") was merely premature. The Task 3.6 test "with no Available property the picker says
why" (plan lines 10268-10276) finds the text and checks the Oak row absent; both hold during
the initial loading render, so the test would also pass with the Available filter removed
(only its sibling tests, which wait for Peachtree first, protect D9).

What it implies. A misleading message on every entry and a test with no power over the
behavior it names. Gate the empty state on a loaded flag (the candidate effect already
knows when it settled) and make the test wait for `getAllUnits` to resolve before asserting.

## 4. [LOW] The 503 "Try again" alert is never cleared by an audience, message or property change

What is wrong. `rulesUnavailable` is set only in `onPreview`'s catch and cleared only at the
start of the next `onPreview` (Task 3.5 steps 9, 15, 16). `onFilterChange`, `onBodyChange`,
`pickProperty` and `onChangeProperty` leave it set, so the alert "Couldn't check tours and
Not interested replies, so the recipient list can't be shown yet." stays on screen after
staff change the audience, beside a Try again that is disabled while the new draft is made
(`disabled={!canPreview || previewBusy}`, step 22).

What it implies. Stale copy about a draft that no longer exists. Clear it wherever
`setAuthorityNotice(null)` / the message reset already run, or tie it to the draft key.

## 5. [LOW] A Preview 422 that lands after "Change property" rewrites the OLD property's edits and shows its notice on the new property

What is wrong. The "Change" button (BroadcastComposer.tsx:552-564) is not disabled while a
Preview is in flight (only AudienceFilters is frozen, `disabled={previewBusy}`). `onPreview`
closes over the render that started it, so a late 422 calls that render's `rejectAuthority`
with the OLD `unitKey` and OLD `authorityPrefill.names` (Task 3.5 step 10). Its functional
update returns `{ unitId: <old>, authorities: kept }`, replacing the new property's edits
state, and `setAuthorityNotice("<text> is no longer on the organization list...")` shows
under the NEW property's picker.

What it implies. A wrong notice and a reset of the new property's ownership slot (the new
property then shows its prefill, so no data is sent wrongly). Either freeze "Change" while
`previewBusy`, or have `rejectAuthority` ignore a refusal whose captured `unitKey` no longer
matches the current one.

## 6. [LOW] AR19 assigns the lint-count update to Task 4.3, which runs BEFORE the gate that measures it; no step implements it

What is wrong. AR19 (plan lines 463-467): "If gate 5's baseline comparison shows the branch
REMOVED pre-existing errors ... Task 4.3 updates the count in
`docs/issues/lint-backlog-repo-wide.md` and in AGENTS.md's gate 5 paragraph to the measured
number". Gate 5 and its baseline comparison are Task 4.4 Steps 3-5 (plan lines 12470-12550),
which run after Task 4.3. Task 4.3's body (plan lines 12215-12387) has no such step, names
neither file in its Files line, and its commit stages only GLOSSARY, RUNBOOK and the
truncation issue. The "measured number" is a repo-wide `npm run lint` count; gate 5 lints
only the branch's files, and no task runs `npm run lint`.

What it implies. A literal builder skips it (stale "23 errors" in AGENTS.md) or improvises
an unplanned post-gate commit to AGENTS.md. State where it happens (after Task 4.4, as its
own docs commit), the exact command that measures the repo count, and the exact old/new
strings.

## 7. [LOW] Task 4.1 Step 3's closing grep expects one "Tasha" line, but step 3h adds a second

What is wrong. The check after step 3o (plan lines 11079-11080) says
`grep -n "TASHA\|Tasha\|tashaConsent" e2e/tests/dashboard-next/broadcasts.spec.ts` "prints
only the header comment line from 3b". Step 3h's new text adds
`// The already-sent tenant is ours, not the lean seed's Tasha: she is` (plan line 10938),
so the grep prints two lines.

What it implies. A builder following the plan literally sees a failed check after a correct
edit. Change the expectation to "only comment lines (3b and 3h)".

## 8. [LOW] Binding 1.1's server truncation copy states a bound that is not the truncation bound

What is wrong. 1.1 (plan line 124) binds `audience resolution was truncated (more than
${MAX_BROADCAST_RECIPIENTS} candidates) - the audience could not be read completely`.
`MAX_BROADCAST_RECIPIENTS` is 1000 (`app/src/repos/broadcastsRepo.ts:75`), but the resolver
truncates only after `DEFAULT_MAX_PAGES` x `DEFAULT_PAGE_SIZE` = 50 x 200 = 10,000 rows read
(`app/src/services/audienceResolution.ts:88-89`, `:191-195`). The inaccuracy is inherited
from today's message (`app/src/routes/broadcasts.ts:1010-1011`), but the plan rewrites this
exact string and makes it binding.

What it implies. An API client is told the wrong limit. Since the string is being rewritten
anyway, drop the parenthetical or state the read bound.

---

## Checked and found sound (no finding)

- Derived prefill (Task 3.5): `FilterEdits` keyed by property, per-filter ownership
  (`authorities?` / `size?`), functional updates, `UnitLoad` keyed by id, AbortError neither
  loaded nor failed (matches `useOrgList.ts:91-92` and `client.ts:124-125`), filter memoized
  by content so the draft hook's effect (`useComposerDraft.ts:258`) is not restarted, gate
  only with `audienceEnabled && effectiveUnitId && !resumeDraftId`. A query-param change of
  `?unitId=` without unmount is also handled (edits for another id are ignored).
- Settle -> Preview: the filter change at settle changes `draft.key` in the same render, so
  `draftKey === key` holds Preview off until the post-settle draft exists.
- Hand-pick case: added row `checkedByDefault: true`, promoted row
  `checkedByDefault: r.hasConsent`; RecipientPreview.test.tsx :315-360 is left unchanged.
- Wire seams: dashboard reads `tourHolds` unconditionally and `checkedByDefault` per row; S2
  Task 2.1 (plan lines 4781-4851) always sends both, including the seeds-only degrade.
- e2e new spec: run-unique authorities via `addOrg`, explicit statuses, consent on the POST
  (`contacts.ts:864-870`, `:972`), tours on a Setup unit (`tours.ts` POST does not check unit
  status; PATCH requested->toured->closed is legal, `tours.ts` exit gate), browser-local
  label dates, exact checkbox names, reach = 3, Select all, Add a tenant of the Placing
  tenant, outbox exactness. Workers = 1 (`e2e/playwright.config.ts:140-141`) and the lane is
  reseeded per run (`e2e/support/preflight.ts:143`), so the 10,000-row bound is not reached.
- Specs F21 calls unaffected (sending-unit via `teamSendsListing`, share-skip-fix,
  partner-share, send-outcome-*, landlord/listing-activity, follow-up-tab) check rows by
  name or send path (a); none asserts a filter audience or an exact checkbox name on a
  possibly-held lean tenant.
