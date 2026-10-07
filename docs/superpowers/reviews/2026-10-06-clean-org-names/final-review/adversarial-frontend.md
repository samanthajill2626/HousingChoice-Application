# Adversarial review - dashboard and e2e half (feat/clean-org-names)

Reviewer: independent, plan-blind (nothing under docs/superpowers/ was read).
Inputs: .superpowers/review/final-frontend.diff, final-log.txt, the worktree
files they touch, and the unchanged consumers of every touched surface
(Modal, ContactSearchField, RecipientPreview, tenant facets, unit facets,
flyer, AppFrame and Settings layout, the api client, serverClock, the server
routes the new client calls). Read-only; no test, suite or server was run.

Counts: BLOCKING 0, HIGH 0, MEDIUM 0, LOW 12, INFO 6.
Nothing above LOW was found. The four hosts handle 422 org_not_on_list, no other
dashboard writer sends an org field, and the composer's draft and Preview races
hold. What remains: list freshness, a few async edge states, accessibility gaps,
and e2e fragility.

---

## L1. LOW - A picker's list is read once per mount and never refreshed, even after the server says it changed

Files: dashboard/src/routes/contact/ContactEditForm.tsx:460-470 (the catch sets
orgFieldError but never calls orgList.reload()); routes/listing/ListingEditForm.tsx:233-242;
routes/listing/UnitCreateForm.tsx:248-257; routes/broadcasts/BroadcastComposer.tsx:130-137
(rejectAuthorityPick) with routes/broadcasts/AudienceFilters.tsx:64 (the list is
private to the filter and read once); routes/orgs/useOrgList.ts:125-145
(provisional entries never expire).

Scenarios:
- Forms: a VA has the tenant form open. An admin changes the kind of an unused
  entry X to agency, or deletes it. The VA picks X from the stale list and saves.
  The server answers 422, and "X is an agency, not a housing authority." shows
  under the picker. But the chip X still has no "Not on the list" mark, the
  Housing authority picker still offers X, and the Agency picker cannot offer X
  because the stale list holds it as a housing authority. The only recovery is
  non-obvious: open the add option, let "Is this really new?" run a fresh
  /check, then press Use. Otherwise the form must be closed.
- Composer: staff open the composer, see that the housing authority they need
  is missing, add it in Settings in another tab, and come back. The picker
  never offers the new entry: the composer has no add step and nothing re-reads
  the list. The only remedy is leaving the page, which loses an edited message
  (a resumed draft reopens with an empty body). After a create or Preview 422,
  the notice says "pick it again", but the picker shows the same stale list, so
  a deleted entry is offered again and fails again.
- Provisional entries: noteAdded keeps a provisional name until a read returns
  that orgId with that same name. If the entry is renamed or deleted after the
  answer, the provisional overrides the server's copy for the rest of the form's
  life. The picker then shows and accepts a name the server refuses, and its
  chip never says Not on the list.

Fix:
- Call the host list's reload() on every 422 org_not_on_list.
- Let rejectAuthorityPick trigger a re-read, either by lifting useOrgList into
  the composer or by passing AudienceFilters a reload key.
- Drop a provisional entry once any successful read returns its orgId (under
  any name) or no longer contains it.
- Optional: re-read when a picker gains focus and the last read is old.

## L2. LOW - A "Couldn't load ..." alert after a failed re-read, although the list in hand works

Files: ContactEditForm.tsx:615 and :639; ListingEditForm.tsx:287;
UnitCreateForm.tsx:373.

Scenario:
1. Staff add "Heron Outreach" through "Yes, add it". noteAdded runs load(), and
   that GET fails transiently.
2. useOrgList.error becomes true while entries are still in hand.
3. Both tenant pickers now render role="alert" "Couldn't load housing
   authorities" and "Couldn't load agencies", so two alerts are announced at
   once.
4. They stay for the rest of the form's life, because no further read is ever
   made.

Meanwhile the pickers, the new chip and Save all work. useTypedOrgText already
treats such a list as known (R4-3); the alert contradicts it.

Fix: show orgListLoadError only when orgListUnknown(list) is true, in all four
hosts.

## L3. LOW - "Is this really new?" can enable "Yes, add it" before close names are shown, and keeps a stale failure next to a fresh answer

File: routes/orgs/NewOrgDialog.tsx:92, 106-114, 124-132 (failedFor is only
cleared by Try again).

Scenario:
1. The /check for "Foo" fails, so failedFor is "Foo".
2. Staff edit the name to "Foo2" (checked fine), then back to "Foo".
3. checkFailed is true immediately, so `checking` is false. "Yes, add it" is
   enabled, and the failure alert shows while a fresh check for "Foo" is in
   flight.
4. A click in that window adds the name without the close names ever being
   shown, which is the whole point of the dialog. The result can be a
   near-duplicate entry.
5. When the fresh check lands, its answer renders but the "Couldn't check the
   list" alert stays beside it.

Fix: clear failedFor when a check for the current name is scheduled, and in the
success branch.

## L4. LOW - Choosing the add option empties the field before the dialog opens, so Cancel loses the typed text

File: routes/orgs/OrgPicker.tsx:306-312 (setText('') runs before
onRequestAdd).

Scenario:
1. Staff type a name and choose "Add ... as a new housing authority".
2. They read the close names, then press Cancel to fix the spelling in the
   field.
3. The field is now empty and the host was told ''. The text must be retyped.
4. If they Save without noticing, the field is simply not saved. That breaks the
   "typed text is never dropped" rule the rest of the picker enforces.

Fix: keep the query while the dialog is open. Clear it through the ref's
clearText in the hosts' onUse, onUseOtherField and onAdded paths, and leave it
untouched on Cancel.

## L5. LOW - A /check that never settles leaves the dialog or the suggestion chip stuck

Files: routes/orgs/NewOrgDialog.tsx:97-121 (no timeout; adding whitespace does
not restart the check because `trimmed` is unchanged);
routes/contact/ContactDetail.tsx:733-760 (suggestionBusy stays
'housingAuthority' until the promise settles; no signal, no timeout).

Scenario: POST /api/organizations/check hangs. This is the failure mode
useOrgList and useOrgAdmin were hardened against (R2-FE-5), but this path was
not.
- In the dialog, "Checking the list..." never ends, "Yes, add it" stays
  disabled, and only Cancel works.
- On the contact page, the housing authority suggestion's Accept and Dismiss
  stay disabled until a page reload.

Fix: race the check against a timeout (for example 10 s) that lands in the
existing failed state (Try again, add allowed). Do the same for the accept-time
check.

## L6. LOW - The Settings tables' hidden "Actions" header can escape the scroller and widen the page at phone width

Files:
- settings/OrgListSection.tsx:97-99 and settings/NotOnListSection.tsx:581-583:
  `.srOnly` sits in the LAST th.
- settings/OrgListSection.module.css:86-89: `.tableWrap` is not positioned.
- settings/OrgListSection.module.css:310-320: `.srOnly` is position:absolute.

Mechanism: this is the defect class main fixed in 13b64f60 (Timeline .stream).
No ancestor of the span is positioned, so its containing block is the initial
containing block. The span is clipped by neither .tableWrap nor <main>, and it
keeps its unscrolled static position.

At 360 px the content box is about 312 px, so both tables overflow and scroll
inside .tableWrap. The span sits at roughly 24 px plus the min widths of the
four leading columns plus 12 px. For the Not on the list table, my estimate is
about 360-375 px: the headers are nowrap, and "Property housing authorities"
sets the FIELD column's minimum. That is at or past the viewport edge, so the
document can gain a horizontal scroll, and larger text settings make it certain.

NumbersSection's srOnly is in the FIRST column, which is why that idiom never
showed this.

Fix: add position: relative to .tableWrap. Add an expectNoHorizontalOverflow
pass for /settings/organizations at NARROW_360.

## L7. LOW - Settings errors, status changes and repeated server refusals are not announced

Files:
- settings/OrgListSection.tsx:274: the notice `<p>` has no role, yet it carries
  a failed Run again (orgErrorCopy).
- settings/OrgListSection.tsx:258-273: the poll rewrites the status line
  without a live region.
- ContactEditForm.tsx:416-471 with :617/:641, and the matching lines in
  ListingEditForm/UnitCreateForm: for a 422, errorAttempt is never bumped and
  orgFieldError/authoritiesError is never cleared at the start of a new Save.

Scenarios:
- An admin presses Run again and it is refused (409 org_rewrite_target_gone).
  The amber sentence appears with no role, so a screen reader user hears nothing
  and the button simply re-enables.
- A rewrite finishing during the poll ("Updating records" -> "Last update
  finished" or "stopped responding") is silent.
- A second identical 422 renders into the alert that is already mounted, so it
  is not read out again. R2-FE-10 fixed this only for the typed-text refusals.

Fix:
- Use role="alert" for error notices, kept separate from info notices.
- Put role="status" (aria-live="polite") on the status line.
- Clear the server-refusal message at Save start, or bump a key for it.

## L8. LOW - "Not on the list" row actions have context-free accessible names

File: settings/NotOnListSection.tsx:474-497.

Scenario: with 30 rows, a screen reader's button list (or Tab order) reads
"Show records, Use another name, Clear, Show records, Clear, ...". Nothing says
which value a Clear will rewrite lane-wide; the confirm repeats it, but the
destructive choice is made blind. The entry tables already name every row action
("Rename X", "Delete X").

Fix: an aria-label that keeps the visible text first, such as
"Clear - <value>", or aria-describedby pointing at the row header.

## L9. LOW - Picker keyboard gaps: ArrowDown does not reopen a dismissed list, and the active option is never scrolled into view

File: routes/orgs/OrgPicker.tsx:332-351 (handleKeyDown returns early while the
list is hidden) and :434-478 (nothing scrolls the active option into view).
The listbox floor is 9rem, about 4 options, while MAX_SHOWN is 10.

Scenarios:
- After Escape, ArrowDown does nothing; the APG combobox pattern expects Down to
  open the list. The user has to retype.
- In a modal near the viewport bottom, the list is clamped to the 9rem floor.
  Moving down past option 4 puts aria-activedescendant on an option hidden below
  the fold, so sighted keyboard users lose the highlight.

This is inherited from ContactSearchField, but OrgPicker is now the only way to
enter three tenant and property fields.

Fix: when text is held, reopen the list on ArrowDown/ArrowUp. In an effect on
activeIndex, scroll the active option into view (block 'nearest').

## L10. LOW - Stale "Not on the list" rows stay actionable after a failed details re-read

Files: settings/NotOnListSection.tsx:549-561 (the error renders only when
rows === null); settings/useOrgAdmin.ts:82-87 (a failed read keeps the old
rows).

Scenario:
1. An admin settles "AHA".
2. The re-read of the details after the rewrite fails.
3. AHA is still listed with its buttons enabled. notOnListError is true but
   nothing shows it.
4. The admin settles AHA again and starts a second lane-wide rewrite that finds
   nothing.

Fix: render the error block (with Retry) whenever `error` is true, rows or not,
and mark the table as possibly stale.

## L11. LOW - A 403 on an admin action reads as "Something went wrong - please try again."

File: routes/orgs/orgCopy.ts:285-288 and 399-400. ORG_ERROR_COPY has no row for
'forbidden', which is what requireRole answers with 403.

Scenario: an admin is demoted mid-session (isAdmin is read once). They press
Rename, a settle action or Run again. The server refuses with 403, and the copy
invites a retry that can never work.

Fix: map 'forbidden' to "Only admins can do this.".

## L12. LOW - e2e: org-lists.spec.ts fragilities and coverage gaps

File: e2e/tests/dashboard-next/org-lists.spec.ts.

- Line 342: page.waitForTimeout(1_500) is used as a negative check. It can only
  false-PASS: on a slower lane, or with a longer debounce, a filtered create
  lands after the assertion. Wait for a positive signal instead, such as the
  "Not used as a filter" note or a later known create.
- Lines 600-602: notOnListRow matches rows by a case-insensitive `hasText`
  substring. That also matches other rows whose resolution text or button
  labels name the value ("Use <name>", "close to <name>"). Every name in a test
  shares the run stamp, which closeNames scores as a shared non-generic word.
  Whether the next getByRole stays strict therefore depends on closeNames
  scoring, not on the spec. Scope by rowheader, as entryRow already does.
- Not covered:
  - the new tab at NARROW_360 (see L6);
  - the page's own poll and status line - every rewrite is synced with
    waitForRewrite plus page.reload(), so a poll that never starts or never
    stops ships green;
  - the composer's 422 "no longer on the list" path end to end.

---

## INFO

- I1. A test pins call arity. useSuggestions.test.tsx:74 asserts that
  acceptSuggestion.mock.calls[0] has length 3. To keep it passing, production
  branches twice: useSuggestions.ts:97 and ContactDetail.tsx:720. The behavior
  that matters is "no `value` key in the body", which the endpoint test already
  pins. Collapse to a single call and drop the arity assertion.
- I2. Dead and missing CSS:
  - broadcasts/AudienceFilters.module.css:64-78: `.input` is unused since the
    free-text input left.
  - `.chip` (lines 32-41) has no :disabled rule, so the voucher chips that are
    disabled during Preview (AudienceFilters.tsx:117) keep cursor:pointer and
    full color.
- I3. The composer's Preview catch, modified here, still renders err.message for
  any other ApiError (BroadcastComposer.tsx:364-365). Staff see a raw server
  string such as "broadcast_not_found" or "internal server error", now also when
  the preview's new org-list read fails. The pattern predates this branch.
- I4. Copy nits:
  - AUTHORITY_LEFT_THE_LIST (BroadcastComposer.tsx:61) lacks the terminal period
    its sibling messages have.
  - The Agency picker has no hint while Housing authority does
    (ContactEditForm.tsx:621-644), and the HA-vs-agency distinction is exactly
    what staff mix up.
  - "Save will use X." also shows for typed text naming a member the
    multi-picker already holds, although Save adds nothing.
- I5. The "Not on the list" settle buttons can carry 120-character names, and
  the shared Button is white-space: nowrap (NotOnListSection.tsx:485-497).
  NewOrgDialog fixed this for its Use buttons (OrgPicker.module.css:251-260),
  but the table was not fixed, so at 360 px it becomes very wide. It scrolls
  inside .tableWrap.
- I6. Sixteen unrelated specs still POST units with
  accepted_authorities: ['atlanta_housing'] (for example broadcasts.spec.ts:78,
  listing-photos.spec.ts:57, tours-page.spec.ts:314). They pass only because
  "Atlanta Housing" is a seeded spelling that D5 resolves, so one edit to that
  starting-list spelling would break all sixteen at once.

---

## Checked and holding

- Writers:
  - Every dashboard writer of housingAuthority, agency, accepted_authorities and
    the broadcast filter handles 422 org_not_on_list from the body, never the
    raw code: ContactEditForm, ContactDetail (accept and close-name edit),
    ListingEditForm, UnitCreateForm, and the composer's create and Preview.
  - No other writer sends these fields (grep-verified): ContactCreateForm,
    triage kind patch, consent, staff notes, PlacementDetail final_rent, email
    triage.
  - Readers only display them: TenantFile, tenant facets, unit facets,
    AuthoritySummary, FlyerPage, broadcastFormat, ListingDetail.
- Unchanged values never reach the wire:
  - the contact compare is exact;
  - the unit baseline goes through authoritiesOf;
  - the server passes held members and the legacy jurisdiction.
  An untouched off-list value never fails a save.
- RecipientPreview's send is the curated send, which the server never
  re-checks, so no 422 goes unrendered there.
- OrgPicker commit rule:
  - onChange fires only on a pick or a chip removal;
  - typed text is reported on every change;
  - an unmount reports '', and StrictMode's mount/unmount/mount reports ''
    harmlessly;
  - the ref handle works (React 19 ref-as-prop, confirmed in package.json).
- useTypedOrgText:
  - one verdict drives both the note and Save;
  - the loading, unavailable and blocked refusals are distinct;
  - a picker holding text is never disabled.
  - Enter with nothing highlighted submits and lands in settle.
- Composer:
  - draftKey === key gating;
  - a Preview is kept with its draftId and key, and the "audience changed" drop
    is announced;
  - filters are frozen while a Preview loads;
  - the gen-guarded 422 path cannot clear a newer pick;
  - the R4-2 undo branch resets pending, stale and error;
  - typed text holds Preview back, and unmount reports ''.
- useOrgList and useOrgAdmin:
  - abort and release are correct under StrictMode and on unmount;
  - the poll skips a read in flight, then restarts it after five ticks;
  - details reads are single-flight with one queued re-run;
  - the details are re-read once on the live-to-stopped transition;
  - the heartbeat is judged on the server clock.
- Escape and modals:
  - with the list open, Escape calls preventDefault, and Modal honors
    defaultPrevented (React's root listener runs before the document listener);
  - a nested Modal's Escape closes only the topmost;
  - a click on the inner backdrop cannot close the outer form;
  - focus returns to the picker input.
- Admin gating: every admin action is absent for a VA and server-enforced; the
  e2e asserts 403 for rename and resolve.
- Copy:
  - all new strings are ASCII and American English;
  - every org code the new client calls has a row or falls back to the generic
    sentence;
  - the new org code never renders ApiError.message.
- The client normalizeOrgText is byte-equal to the server's. closeNames are
  kind-scoped, so a "Use X" in a field dialog always fills that field's own kind.
- e2e isolation:
  - names are run-unique;
  - the preflight reseeds, and workers 1 with fullyParallel false means
    lane-global rewrites never overlap;
  - the dev seam is used only to plant values that are not on the list.
  - Selectors are accessibility-first, and behavior is asserted against server
    state, not just the DOM.
