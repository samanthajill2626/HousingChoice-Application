# R2-FE - adversarial re-review, round 2: dashboard + e2e half (after fix wave FW-B)

Reviewer: R2-FE. Branch `feat/clean-org-names` @6b0c3eed; fix wave FW-B =
977d092c..55f1294d over 579ae6c2; merge base d839494a. Plan-blind (read only
the charter, R1-ADV-FE.md, R1-CONF-2, R1-adjudications.md and the two diff
packages under docs/superpowers and .superpowers).

Covered, in the brief's order: (1) a fresh hunt across the state the branch
changes - OrgPicker in the tenant form, both property forms, the blast
composer and the Settle dialogs; NewOrgDialog; the AI housing authority
accept (ContactDetail, useSuggestions); the Settings tab (useOrgAdmin,
useOrgList, OrgListSection, NotOnListSection, OrgEntryDialogs) and its
polling; useComposerDraft's 422 path; the e2e driver (pickOrgName,
orgFixture, org-lists.spec.ts and every changed spec); (2) the FW-B diff line
by line as new code (B1-B9), against the backend routes/services it calls
(orgRecords.ts rewrite matching, client.ts, serverClock.ts); (3) the
adjudications; (4) whether each new test fails with its fix reverted.

Counts: CRITICAL 0 | HIGH 0 | MEDIUM 3 | LOW 5 | INFO 2.

Every throwaway test below was run alone (`npx vitest run <file>`) and then
deleted by its exact name; `git status` is clean. Test files:
`dashboard/src/routes/contact/zz-review-R2-FE-1.test.tsx`,
`settings/zz-review-R2-FE-2.test.tsx`, `broadcasts/zz-review-R2-FE-3.test.tsx`,
`contact/zz-review-R2-FE-4.test.tsx`, `listing/zz-review-R2-FE-5.test.tsx`.
Each was a passing assertion of the defect (i.e. it documents today's
behavior).

---

## R2-FE-1 | MEDIUM | CONFIRMED - a list read that fails while a picker holds typed text locks Save for good

**Where:** dashboard/src/routes/contact/ContactEditForm.tsx:397-418
(settleTypedText), :605 and :634 (`disabled={orgList.error}`), :616-624 and
:645-653 (ORG_TYPED_BLOCKED outranks the load-error message);
ListingEditForm.tsx:66-77, :276, :287-291; UnitCreateForm.tsx:85-96, :358,
:369-373; OrgPicker.tsx:340 and :363 (the input AND the chip remove buttons
are disabled with the picker); useOrgList.ts:61-82 (no retry), :102-108
(noteAdded re-reads; a failed re-read sets `error` for the dialog's life).

**Scenario:** B1's guard settles typed text against `orgList.entries` and
refuses the save unless it resolves. Nothing exempts a picker the user can no
longer edit. When a list read fails while a picker holds text, the picker is
disabled WITH the text inside; every Save / Create is refused with "Pick a
name from the list, add it as new, or clear the text." - none of which a
disabled field allows - and that message REPLACES "Couldn't load housing
authorities", so staff are not told why. The only exit is Cancel, losing
every edit in the dialog. Two paths:
- (a) staff start typing in the picker while the dialog's first
  GET /api/organizations is in flight, and it fails (any form);
- (b) tenant form: text left in Agency (or HA) while "Yes, add it" - or, new
  with B6, "Use X" / "Put it in Agency" - in the other picker triggers
  noteAdded's re-read (useOrgList.ts:105), and that read fails.
Related transient: while the list is still loading, an EXACT list name typed
is refused as unknown (entries are `[]`), with no option or add step on offer
until the read lands.

**Evidence:**
- zz-review-R2-FE-1.test.tsx "initial read fails after staff typed": list
  read pending; typed "Atlanta Housing Authority"; reject -> HA combobox
  `toBeDisabled()`, value kept; First name +X; Save -> "Pick a name from the
  list..." shown; Backspace x3 -> value unchanged; Save again ->
  `updateContact` never called, `onClose` never called (passed).
- same file, "a re-read after Yes, add it fails while the Agency picker holds
  typed text": Agency "Hope", HA "Metro HA" -> Add -> Yes, add it; second
  getOrgList rejects -> Agency disabled holding "Hope"; Save -> blocked,
  `updateContact` not called (passed).
- same file, "while the list is still loading, an exact list name typed is
  refused as if unknown" (passed).
- zz-review-R2-FE-5.test.tsx "New property: the picker is disabled holding
  the text; Create is refused every time": "DCA" typed, read fails; Create
  twice -> `createUnit` never called; `queryByText("Couldn't load housing
  authorities")` is null after the refusal (passed).

**Fix:** never block on a picker the user cannot edit. Either keep the input
editable (clear-only) under a load error, or settle a failed list as 'empty'
with a non-blocking "Housing authority not changed - the list did not load"
(and never let ORG_TYPED_BLOCKED overwrite the load-error text). While
loading, refuse with "Still loading the list - try again in a moment" (or
await the read), not the unknown-text copy. A Retry for the form's list read
would also end the dialog-long disabled state.

---

## R2-FE-2 | MEDIUM | CONFIRMED - removing a chip now wipes the typed text, and Save then succeeds without it

**Where:** dashboard/src/routes/orgs/OrgPicker.tsx:292-299 (`remove()` calls
`setText('')` - "a clear commits like a pick does: any half-typed text goes
with it"); the hosts' settle at ContactEditForm.tsx:397-418,
ListingEditForm.tsx:66-77, UnitCreateForm.tsx:85-96.

**Scenario:** B1 commits typed text on Save, but FW-B also made every chip
removal discard the typed text. The natural "replace the stale value" order
- type the new name (its option shows), then x the old chip, then Save -
loses the typed name at the x, and Save succeeds without it:
- single picker: the PATCH sends `housingAuthority: ''` and CLEARS the
  tenant's authority (staff meant DeKalb -> DCA);
- multi picker: the stale member goes and the typed authority is never
  added, so the property drops out of that authority's facet and available
  view - R1-ADV-FE-1's exact harm, through a path the fix opened.
The only cue is the input emptying while staff are clicking a DIFFERENT
control. (Pre-fix code also lost the text here, at Save; with B1's guard and
no wipe, Save would have committed it.) This is the brief's "chips removed
while text is typed" case.

**Evidence:**
- zz-review-R2-FE-4.test.tsx: stored DeKalb; type "Georgia Department of
  Community Affairs" (option rendered); click "Remove DeKalb County Housing
  Authority" -> input value `''`; Save -> `updateContact('k1',
  { housingAuthority: '' })` and `onSaved` called (passed).
- zz-review-R2-FE-5.test.tsx: Edit property holding
  ['Atlanta Housing Authority', 'ga_dca']; type "DCA"; Remove ga_dca -> input
  `''`; Save -> `{ accepted_authorities: ['Atlanta Housing Authority'] }`
  (passed).

**Fix:** do not discard the query in `remove()`; keep reporting it and let
the Save guard resolve or refuse it (single: a resolved name replaces; multi:
it is added). If a removal must consume the text, settle it (commit) rather
than drop it.

---

## R2-FE-3 | MEDIUM | CONFIRMED - challenge to the B1 ruling: the composer, where an uncommitted filter costs most, has no guard

**Where:** dashboard/src/routes/broadcasts/AudienceFilters.tsx:118-129 (no
`onPendingTextChange`); BroadcastComposer.tsx:334-360 (`onPreview` and
`canPreview` check nothing about the picker); useComposerDraft.ts:172-178
(the draft carries only the committed filter). Ruling: R1-adjudications.md
B1 "The composer keeps its commit-only-on-pick rule ... only the blur note
applies there".

**Scenario:** the composer's audience is a real SMS send. Staff type the
full authority name, see its option, do not click it, and press "Preview
recipients": the preview resolves the UNFILTERED draft (every tenant of the
voucher size) and Send texts tenants of every authority. The only cues are an
unfiltered reach count and the blur note, which appears only after focus
leaves and says "Not saved" on a screen that saves nothing. The forms got a
commit-or-block guard for the far cheaper harm (a stored field); the send
surface got none.

**Evidence:** zz-review-R2-FE-3.test.tsx: `?unitId=unit-0001`, list
[Atlanta]; type "Atlanta Housing Authority" (option rendered); "Reaches 40
tenants"; click Preview -> `previewBroadcast('draft_1')` called; every
`createBroadcast` body lacks `housing_authority` (passed).

**Fix (keeps D7 - no per-keystroke draft recreation):** AudienceFilters
forwards `onPendingTextChange`; the composer disables "Preview recipients"
while the picker holds typed text, with the hint "Pick the housing authority
from the list, or clear the text." Optionally commit a uniquely-resolving
text when Preview is pressed (one recreate, not per keystroke). Composer note
copy: "Not used as a filter - ...".

---

## R2-FE-4 | LOW | CONFIRMED - B8 groups placeholder values the server never groups

**Where:** dashboard/src/routes/settings/NotOnListSection.tsx:127-136
(`recordsText` groups by `normalizeOrgText` equality) vs
app/src/services/orgRecords.ts:540-550 (a from-text that normalizes to '' is
matched by TRIMMED EXACT text) and app/test/orgRecords.test.ts:420-436 (pins
"()" surviving a settle of "-").

**Scenario:** placeholder values such as "-", "--", "()", "." all normalize
to ''. B8 counts them as siblings and names them in the confirm, but the
server's settle (fromTexts = [row.value], orgRewrite.ts:376) rewrites only
the trimmed-exact value. Clear on "-" promises "6 records, written as -, --
or ()" and clears 2; the other rows remain. The adjudication's wording
("normalizes equal") is where the mismatch entered.

**Evidence:** zz-review-R2-FE-2.test.tsx: rows "-" (2), "--" (3), "()" (1) in
housingAuthority; Clear on "-" -> the dialog contains "(6 records, written as
-, -- or ())" (passed).

**Fix:** mirror the server's equality: key = normalized !== '' ? normalized
: 'exact:' + value.trim(). (Side note, INFO: a unit holding two sibling
variants is counted once per row, so the sum can exceed the units the pass
touches.)

---

## R2-FE-5 | LOW | CONFIRMED (mechanism) / PLAUSIBLE (trigger) - B4: one hung poll read freezes the Settings status and its actions

**Where:** dashboard/src/routes/orgs/useOrgList.ts:97-100 (`poll()` skips
while `abortRef` is set), :77-81 (released only when the read settles);
useOrgAdmin.ts:115-121; api/client.ts:115-123 (fetch with no timeout).

**Scenario:** B4 traded "a slow read never lands" for "a read that never
settles blocks every later poll". One GET /api/organizations that hangs (the
repo documents hung requests: dashboard/vite.config.ts keep-alive notes,
docs/issues/placement-detail-bundle-fetch-stall) and every tick returns
early; nothing sets state, so nothing re-renders: the status line stays
"Updating records" and Rename / Merge / Change kind / Delete and every settle
stay disabled until a page reload (after 15 min of server time a re-render
would flip to "stopped responding" + Run again, though the rewrite may have
finished). Before B4 the next tick aborted and retried.

**Evidence:** zz-review-R2-FE-2.test.tsx: mount RUNNING; the first poll read
never settles; later reads DONE; pollMs 20; after 600 ms `getOrgList` called
2 times, `lastRewrite.status` still 'running', `rewriteLive` true (passed).

**Fix:** keep skip-while-in-flight but cap a poll read's age: `poll()` aborts
and restarts a read older than ~5 x pollMs, or poll reads carry
`AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])`.

---

## R2-FE-6 | LOW | CONFIRMED - the blur note says "Not saved" for text Save then commits

**Where:** dashboard/src/routes/orgs/orgCopy.ts:101 (ORG_TYPED_NOT_SAVED);
OrgPicker.tsx:197, :393-397; the commit in ContactEditForm.tsx:402-406,
ListingEditForm.tsx:73-76, UnitCreateForm.tsx:92-95.

**Scenario:** the note shows under ANY unpicked text, but the forms' Save
commits text that names one entry. Staff who trust it leave "DCA" in the
field and save another edit: the stored DeKalb is REPLACED by Georgia
Department of Community Affairs (multi picker: DCA is added). The
adjudication specified both this copy and the commit rule; they contradict
for resolvable text.

**Evidence:** zz-review-R2-FE-1.test.tsx: stored DeKalb; type "DCA"; Tab ->
note present, accessible description contains "Not saved"; type a note; Save
-> PATCH `{ notes: 'x', housingAuthority: 'Georgia Department of Community
Affairs' }` (passed).

**Fix:** let the host choose the note from the settle verdict (a prop or a
callback): resolvable -> "Save will use <name>"; otherwise the current copy.

---

## R2-FE-7 | LOW | CONFIRMED - B6 does not cover a RENAMED entry, which its own comment claims

**Where:** dashboard/src/routes/orgs/useOrgList.ts:102-113 (`noteAdded`
appends `provisional(ref)`; the `entries` memo drops any provisional whose
orgId is already in `data.entries`); ContactEditForm.tsx:943-955,
ListingEditForm.tsx:591, UnitCreateForm.tsx:617.

**Scenario:** the comment says "a name added or renamed since this list was
read". After a rename the orgId is in the form's stale list under the OLD
name, so the provisional entry (new name) is filtered out and the chip reads
"Not on the list" until the re-read lands - the flash noteAdded exists to
prevent - and for the dialog's life if that re-read fails (R2-FE-1 then
applies too). The new B6 tests use a brand-new orgId only.

**Evidence:** zz-review-R2-FE-1.test.tsx: list [o-atl "Atlanta HA"]; /check
match {o-atl, "Atlanta Housing Authority"}; the re-read never lands; type the
new name -> Add -> "Use Atlanta Housing Authority" -> chip text contains "Not
on the list" (passed).

**Fix:** let a provisional entry win over a data entry with the same orgId
until a read returns that name (merge by orgId, provisional name first), or
keep a set of server-confirmed names that `isOnList` also consults.

---

## R2-FE-8 | LOW | PLAUSIBLE (layout; jsdom cannot show it) - the blur note reflows the form under the pointer and eats clicks

**Where:** dashboard/src/routes/orgs/OrgPicker.tsx:197, :376-384, :393-397
(blur sets `focused=false`, inserting the note line); OrgPicker.module.css
`.pendingNote`, `.chipRemove` (24 x 24 px).

**Scenario:** focus leaves on MOUSEDOWN; the blur re-render inserts a
one-line note under the field before the MOUSEUP, moving everything below. A
click on a small control below the picker - the Agency chip's Remove button,
the LIF eligible / Porting checkboxes, "+ Add relationship", on stacked
layouts the composer's buttons - ends its mouseup off the moved target, so
the click is dispatched to a common ancestor and is lost. Inputs and selects
are unaffected (they act on mousedown).

**Evidence:** trace only (file:line above).

**Fix:** reserve the note's line (min-height) or render it in place of the
hint, so a blur never reflows siblings.

---

## R2-FE-9 | INFO - no e2e covers the fix wave's new user-facing behavior

Save committing or refusing typed text, the blur note, blur-close and the
Settings poll have unit tests only (jsdom); AGENTS.md asks to add or extend a
spec for new UI behavior, and R2-FE-2 / R2-FE-8 are exactly the class jsdom
cannot see (real focus order, layout).

## R2-FE-10 | INFO | PLAUSIBLE - a repeated refused Save is silent to a screen reader

**Where:** ContactEditForm.tsx:414-416 (and the property forms' twins);
OrgPicker.tsx:398-402.

**Scenario:** a keyboard user presses Enter in a picker holding unresolvable
text: the save is refused and the `role="alert"` renders. Enter again: same
alert text, focus already in the field - no DOM change, no announcement; the
form seems to do nothing.

**Fix:** re-mount the alert per attempt (key it on a counter) or announce the
attempt in a live region.

---

## Challenges to the round-1 adjudications

- B1, composer "only the blur note applies there": disagree - R2-FE-3 (the
  send surface needs a Preview guard; D7 is preserved by not recreating).
- B1, picker spec "called with '' after a pick, a clear": read as "wipe on
  chip removal", it reopened R1-ADV-FE-1 on the replace path - R2-FE-2.
- B1, blur-note copy "Not saved - ..." together with commit-on-save: the two
  halves contradict - R2-FE-6.
- B1, silent on disabled pickers: the guard can block on a field nobody can
  edit - R2-FE-1.
- B4, "skip a tick while one is in flight": needs an age cap - R2-FE-5.
- B6, "as noteAdded does": the masking-by-orgId makes renames fail - R2-FE-7.
- B8, "every row ... whose value normalizes equal": not the server's
  equality for placeholder values - R2-FE-4.
- Agree: FILE for R1-ADV-FE-10 / R1-ADV-BE-3 / R1-ADV-BE-5, ACCEPT for
  R1-ADV-BE-6. The A1 409 (org_rewrite_running on an add) is worded in the
  dashboard (orgCopy.ts:164 via NewOrgDialog.tsx:150) - no FE gap.

## Are the nine fixes real?

Method: each new test read against the pre-fix code (579ae6c2) and, for
B2/B4/B6/B7, against R1's own repro observations; not re-run on reverted code
(no edits to tracked files).

| fix | verdict |
|---|---|
| B1 | Real for the tested paths: "exact name / unique spelling saved" and the BLOCKED alert tests fail pre-fix (no commit, no alert); the "(PIN)" cases pass both ways by design. Incomplete: R2-FE-1, R2-FE-2, R2-FE-6; composer untouched (R2-FE-3). |
| B2 | Real: "Tab away closes the list" fails pre-fix (R1 saw the listbox stay); `fireEvent.mouseDown(listbox)` returns true pre-fix (no preventDefault). Option-click is a PIN. Side effect R2-FE-8. Nested dialogs, Escape stack and pickOrgName (fill, then option click; `replacing` removes first) checked clean. |
| B3 | Real: both skew tests flip on the browser clock (fast -> "stopped responding", slow -> heartbeat in the future, never stale). getOrgList is mocked, so the explicit noteServerDate offset holds. |
| B4 | Real for slow reads: the 60 ms test never lands pre-fix (every tick aborts); StrictMode and unmount-in-flight are safe (abortRef released only by its own controller; post-await abort check). Gap: R2-FE-5. |
| B5 | Real: pre-fix PATCHes the old list / PATCHes an unchanged list. Shared-confirm path re-asks correctly when the list grew. |
| B6 | Real for a new orgId (pre-fix chip says Not on the list); not for renames - R2-FE-7. New side effect: every "Use X" now re-reads the list, feeding R2-FE-1 path (b). |
| B7 | Real: pre-fix stays on "Checking the list...". `checked` as an effect dep cannot loop (the landing check satisfies the skip). |
| B8 | Real for normal values (pre-fix copy "(2 records (+1 deleted))"); wrong for placeholder values - R2-FE-4. |
| B9 | Real: pre-fix keeps the notice after Add. |

## Areas checked and found clean

- OrgPicker option pick under blur-close: option and listbox mousedown
  preventDefault keep focus; a chip x blurs, re-focuses and leaves no list;
  focus restore from a nested NewOrgDialog re-opens only for remaining text.
- Escape: handled only while a list shows; the Modal's document listener
  respects defaultPrevented; Settle-dialog Split pickers behave the same.
- Portaled listbox vs Modal backdrop: React-tree bubbling stops at the
  dialog's onMouseDown; z-index above modals.
- Tenant form "never send an unchanged housingAuthority": holds for a typed
  name or spelling equal to the stored value; an off-list stored variant
  replaced by its list name is correctly sent as a human edit.
- Multi picker settle: de-duplicates against the chips; an already-held name
  typed changes nothing.
- Enter with nothing highlighted: lands in the guard in all three forms; the
  composer and Settle dialogs are not forms.
- useOrgList StrictMode double effect and unmount during an in-flight read:
  no state after abort; the slot is released only by its owner.
- serverClock: every response notes Date before the body is parsed
  (client.ts:134), so lastRewrite is judged on the clock it arrived with.
- SpellingsDialog B5: busy guard, Enter adds, "Save anyway" after the list
  grew is sent without confirmShared, unchanged list closes without a PATCH.
- NewOrgDialog: rendered outside every form; typed buttons; A1's 409 worded.
- ContactDetail AI accept: setContact is bound to its contactId
  (useContact.ts:51-53), so a late accept / close-name edit cannot write
  contact A onto B's page.
- useComposerDraft 422: gen-guarded, not marked stale, cleared filter matches
  the prior key or recreates.
- e2e: waitForRewrite matches action plus run-unique text (no stale-done
  race); every changed spec picks through pickOrgName (no type-and-save left
  for B1 to refuse); selectors.md copy matches ORG_TYPED_BLOCKED.
- ASCII: no non-ASCII character on any added line of the FW-B diff.
