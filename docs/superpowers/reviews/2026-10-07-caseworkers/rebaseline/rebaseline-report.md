# Caseworkers (branch B) - plan rebaseline on 54e7b0d0

Date: 2026-10-07. Plan: `docs/superpowers/plans/2026-10-07-caseworkers.md`
(written at 8a5cf2d4). Trigger: main, carrying `fix/org-settings-layout`,
was merged into `feat/caseworkers` at 54e7b0d0. That branch rebuilt
Settings > "Housing authorities & agencies" as a list + detail panel and
made every Settings tab full width (its records:
`docs/superpowers/reviews/2026-10-07-org-settings-layout/`, handback
sections 1, 5, 8 and 9; design review section 7).

Scope of this pass: the plan text only. No spec decision changed; no plan
ruling (sections 0-3, planner rulings, assembly rulings, plan-review
adjudications A1-A17, S1-S11, B1-B10, round 2) was altered. Only where and
how the Settings parts land moved, plus line-number drift in the files the
merge touched. Nothing was implemented, run or committed.

Checks run at the end:
- `LC_ALL=C grep -c '[^ -~]'` on the plan prints 0.
- 61 anchors this pass wrote or re-confirmed in the 22 changed files were
  checked with a script against the working tree at 54e7b0d0: each occurs
  exactly once (the `const kind = kindForField(row.field);` anchor exactly
  twice, as the plan's FIRST / SECOND wording requires). 0 failures.
- Removed names grepped in the plan: `SettleDialog`, `NotOnListTableRow`,
  `rowKey`, `adminActions`, `entryRow`, `notOnListRow`, `valueRow`, "Settle
  dialog", "Used by cell", `max-width`. Remaining hits are all explanatory
  (the rebaseline notes saying what the old names were, and Task 8.12's
  rule "never give the page a `max-width`"). No instruction still targets
  a removed name.

## (a) Impacted tasks - what changed and why

### Header, section 0, section 2, section 3.6, section 3.9 (binding text: locations only)

- Header: a "REBASELINED on 54e7b0d0" bullet naming the re-derived tasks
  and this report.
- Section 0, line-number bullet: numbers in the files the layout branch
  changed are as of 54e7b0d0.
- Section 2, S7 row: "the Settle dialog" became "their settle confirm
  (`SettleConfirm` in `NotOnListPanel`)", and it adds the client URL scheme
  (`orgSelection.ts`).
- 3.6: the e2e usage pin is `org-lists.spec.ts:619-624` at 54e7b0d0. It
  was `:557-562`, and its text is unchanged.
- 3.9 org-pickers row: "the Settings Used by cell" became "the Settings
  'Used by' text (the entry panel's Used by fact, `usageText`)". It also
  says that `FIELD_LABEL.organization` names the field in a value's row
  description and in the panel's Field fact. The copy strings are
  byte-for-byte unchanged.

### S7 slice header

- The Files list gains `OrgListPane.tsx`, `OrgDetailPanel.tsx` and
  `orgSelection.ts`.
- A new paragraph describes the merged tab:
  - Segments; each list row is one link, with its use count as the link's
    description (`OrgListPane.tsx:86-107`).
  - The entry panel with labeled actions (`OrgDetailPanel.tsx:112-239`).
  - The value panel (`NotOnListSection.tsx:520-643`): a "Settle this
    value" radio fieldset (`:593-639`) over the inline `SettleConfirm`
    (`:244-484`) and the page's `SettleGate` (`:218-225`;
    `OrgListSection.tsx:206-218`).
  - It states that B adds no fourth segment, and that
    `FIELD_LABEL.organization` flows into the row description
    (`OrgListPane.tsx:240`) and the Field fact (`NotOnListSection.tsx:567`)
    with no code change (handback section 5).
- Pins table:
  - The 7.4 row now lists the list-row description pins `'8 records'`,
    `'Not used'` and `'1 record'` (`OrgListSection.test.tsx:202, 204, 219`)
    as PINs on the distinct totals.
  - The 7.5 row names the test titles as rewritten
    (`NotOnListSection.test.tsx:266, 406, 423, 509`).
  - A 7.5a row pins `orgSelection.test.ts` "ignores a value outside ...".

### Task 7.3 (minor)

The `OrgKindChoice` header comment said "the Settle dialog's 'Add as
new'". It now says "Settings' settle confirm ('Add as new' on a 'Not on
the list' organization value)". There is no code or test change.

### Task 7.4 - use counts and Delete / Change kind (REVISED)

Why: A's `usageTotal` (a column sum, `orgCopy.ts:590-592`) now has five
call sites, not three:
- `OrgListPane.tsx:157`: each list row's "N records" / "Not used".
- `OrgDetailPanel.tsx:125`: the panel's "Not used" check at `:164`.
- `OrgEntryDialogs.tsx:111`, `:447` and `:503`.

The plan's old RED located rows with `entryRow(...)` and row buttons, and
both are gone.

Plan changes:
- Files gain `OrgListPane.tsx` and `OrgDetailPanel.tsx`. A note lists the
  five readers.
- RED 2 keeps the `const USAGE = {` replacement. The anchor is unique
  (`OrgListSection.test.tsx:77`), and the current fixture is now one-line
  rows.
- NEW case in `describe('OrgListSection - the detail panel')`: a name held
  only as a contact's organization. Its list row reads `'1 record'` and its
  panel shows "... 1 organization field", not "Not used".
  - RED: the column sum is 0, so the row and the panel both read "Not used".
- The admin case is rewritten onto the merged helpers:
  - It uses `openEntry`, `region` and the panel's
    `Delete Step Up` / `Change kind of Step Up` buttons.
  - It adds the list-row pin `'3 records'`: distinct `inUse` 2 + 1. The
    old column sum gave "1 record".
- The Atlanta Change-kind case uses `openEntry` instead of `entryRow`.
- Implement keeps steps 1-2 (`orgCopy.ts`, `OrgEntryDialogs.tsx`; their
  anchors are unchanged, because `OrgEntryDialogs.tsx` is not in the
  merge). It adds:
  - Step 3, `OrgListPane.tsx`: the import (`:12`), and `:157` becomes
    `blockingUses(usage[entry.orgId], 'delete')`.
  - Step 4, `OrgDetailPanel.tsx`: the import (`:16`), and `:125` becomes
    `blockingUses(usage, 'delete')`.
  - The `blockingUses` doc now says that 'delete' is also the record count
    Settings shows.
- The DISTINCT totals are used everywhere, so a record holding the name in
  two fields counts once.
- Ruling A10 kept: `usageText` / `usageBreakdown` read `inUse.deleted`
  (step 1 is unchanged).
- GREEN names the A pins that stay green on the distinct totals. The
  commit stages the two new files.

### Task 7.5 - organization values and the settle confirm (REVISED, re-derived in full)

Why: there is no Settle dialog and no table row.
- `NotOnListPanel` shows one value. An admin picks one radio of
  `settleChoices()`, and under it `SettleConfirm` (the former dialog body,
  inline) repeats the choice as its button.
- A request goes through the page's `SettleGate`, and the whole fieldset
  is disabled while any settle is out (`NotOnListSection.tsx:541-550`,
  `:593-597`).
- `kindForField` has three uses: the import at `:35`, `settleChoices` at
  `:69`, and `SettleConfirm` at `:254`.

Plan changes:
- RED is a new describe after `NotOnListPanel - an in-flight settle ...`.
  It uses the file's `renderPanel` / `fact` / `choices` / `pick` / `gate`
  / `deferred` helpers. Six cases:
  1. The choices for a compound value and for an unknown value: either
     kind for Use, never Move or Split. The Field fact `Organization` is a
     PIN after 7.1.
  2. Use of an agency name keeps "Remember this spelling", checked against
     the agency.
  3. "Use another name" searches both lists.
  4. Add as new: the `Kind` group has no default, the confirm stays
     disabled until a kind is chosen, and the body carries `kind`.
  5. NEW: while the add is out, the Kind radios and the confirm are
     disabled, `gate.begin` gets the organization value key, and only one
     request goes.
  6. NEW: a refused compound Add as new says "... Pick one of them." and
     never "Split". This makes the plan's old step 5 ("add a case") concrete
     (ruling S8 extended).
- Implement re-anchors every edit on the merged text: imports, the
  `settleChoices` doc (ruling S6 anchors still valid), and in
  `SettleConfirm`: `kinds`, `organizationRow`, `addKind`, the target
  lookup, `checkKind`, the 'add' sentence and body, the picker kinds, and
  the one `OrgKindChoice` placement (ruling S4). The JSX anchor's
  indentation was verified (14/12/10/8/8).
  - NEW in step 3: `confirm()`'s `orgErrorCopy(err)` (`:387`) becomes
    `orgErrorCopy(err, { organization: organizationRow })`. That one call
    covers both the inline error and the `onFailedAway` page notice.
  - The Kind choice sits inside `SettleConfirm`, inside the gated fieldset.
    "Add as new" with its required Kind is therefore inside the gate. The
    organization no-Split copy is kept.
- Step 4 (delete `kindForField`) is unchanged.

### Task 7.5a - NEW (see b)

### Task 8.12 (note only)

A "Width" paragraph after the CSS. It records Cameron's standing rule (no
page-level width cap; only controls and prose get widths) and that the page
already complies:
- The page container is `ContactsList.module.css` `.page`, which has no
  cap.
- The new module adds no `max-width`.

There is no code change: the plan's CSS never had a page cap.

### Task 8.13 - route, profiler exclusion (REVISED)

- (d) `App.tsx`: the three anchors (`:19`, `:67`, `:155`) are unchanged and
  unique. The merge only changed `:229-234` (now
  `organizations/:orgId?`), which B does not touch.
- (e) `routes.test.ts`: the old 3-line anchor no longer exists (the comment
  is now 3 lines and the entry 2 paths). The new anchor is the pair
  `'/settings/organizations',` / `'/settings/organizations/:orgId?',`
  (`:401-402`, unique). `/contacts/caseworkers` goes after them. A note
  says the `settingsChildren` list (`:371-385`, which now holds
  `'/organizations/:orgId?'`) is not touched. The cited range is now
  `:391-407`.
- (f) `routes.ts`: the anchor line is unchanged and unique, now `:663`. The
  merge rewrote the TODO above it.

### Task 9.4 (line refs only)

The two `org-lists.spec.ts` "Reaches ..." anchors are at `:358` / `:474`
(they were `:349` / `:465`). The text is unchanged.

### S9 -> S10 handoff table (line refs only)

The same two org-lists rows are annotated with their 54e7b0d0 lines.

### Task 10.3 - usage pin (REVISED: notes and refs; the edit is unchanged)

- The pin is an API assertion, and its text is unchanged. It moved to
  `:618-624` (the comment line plus the expect).
- A note says the rename test now reads the use through the detail panel
  (`openEntry`; `panel` contains `UI.usedByTenants(2)` /
  `UI.usedByProperties(1)`, `org-lists.spec.ts:626-629`), and that Steps
  2-4 touch no selector.
- Step 5's explanation now reads "the entry panel's Used by fact" and
  "found by their exact run-unique text - `valueLink`".
- The S10 assembly note's `:557-562` is annotated `:619-624`.

### Task 10.4 (REVISED: run command)

The Playwright `file:line` selectors for org-lists must name the test
DECLARATION line. Those moved:
- "blast composer: the picker has no add step ..." went from `:309` to
  `:318`.
- "blast composer: Preview waits ..." went from `:438` to `:447`.

The command and its note were updated, and the "moved by Task 9.4" sentence
carries the new pin lines.

### Task 10.8a - org-lists organization value (REVISED, re-derived in full)

Why: `notOnListRow`, row buttons and `page.getByRole('dialog')` are gone.
The merged spec's helpers are:
- `showList` (`:495`), `valueLink` (`:665`) and `openValue` (`:670`).
- `pickSettle` (`:679`): it checks the radio in "Settle this value".
- `confirmSettle` (`:688`): it presses the confirm, then waits until the
  URL has no `value=`.

Plan changes:
- The helpers step is unchanged (`createPartner`, `organizationOf`). Its
  anchor `test.describe('"Not on the list" ...` is unique.
- The Step 2 anchor is now the merged end of the settle test
  (`valueLink(...)).toHaveCount(0)`, `:836-840`).
- The test now:
  1. Opens the Not-on-the-list segment.
  2. Asserts each value's link description starts with `Organization - `
     (a prefix, never a count).
  3. Opens the add value and asserts the Field fact `Organization`.
  4. Picks "Add as new". It asserts the confirm is disabled and the nested
     `Kind` group has no default, checks "Housing authority", then
     `confirmSettle`.
  5. Waits for the rewrite and asserts the entry's kind and the holder's
     organization.
  6. Reloads, opens the use value, picks `Use <wren>`, `confirmSettle`,
     waits, and asserts the holder holds the agency name.
  7. Reloads and asserts both links are gone.
- The E2E rules are kept: run-unique stamps, exact matching, no count, no
  empty state, and a wait for each rewrite. Opening the value through its
  link also exercises Task 7.5a end to end.

### Task 10.10 (one phrase)

The new GLOSSARY entry's "counted in Settings' 'Used by' column" became
"counted in Settings' use counts (an entry's list row and its panel's 'Used
by')".

### Task 10.11 - RUNBOOK (REVISED: refs and one sentence)

- Every anchor was re-checked at 54e7b0d0:
  - The "Tour reminder supersession" heading is unique, now `:450`.
  - `:179`, `:376` and `:386` are unchanged.
  - The `:415` anchor is now `:417`: the merge added two lines in "Tour
    auto-close".
- A note records that the merge rewrote the organization-names section
  again (now "DONE dev + prod 2026-10-07"). B's block still goes before
  "Tour reminder supersession", outside that section.
- The inserted block's last paragraph changed from "as an organization
  row, settled with Use ..." to "as a value whose field is Organization;
  open it and settle it in its panel's 'Settle this value' choice with Use
  ...".

### Task 10.13 (wording)

"org-lists - the usage UI" became "the use counts in the list + detail
layout (row descriptions, the panel's Used by) and the settle confirm".

## (b) New task

**Task 7.5a - `orgSelection`: an organization value's URL selects it (the client RECORD_FIELDS).** It is placed after 7.5 and depends on 7.1, which
widens the dashboard `OrgRecordField`.

- Why: `orgSelection.ts:46` has its own
  `RECORD_FIELDS = ['housingAuthority', 'agency', 'accepted_authorities']`,
  and `readOrgLocation` (`:64-66`, `:76`) drops any other `field`. An
  organization value's row link (`valueHref`, `:93-96`) would open nothing:
  the selection is null and the panel stays on its placeholder (layout
  handback section 8, "Merge note for branch B (addition)"). Task 5.5 only
  widens the SERVER's `RECORD_FIELDS` (`app/src/services/orgRecords.ts`).
- RED 1, `orgSelection.test.ts`: `readOrgLocation` reads
  `field=organization`, both from a literal query and from `valueHref`.
- RED 2, `OrgListSection.test.tsx` "Not on the list" describe:
  - The organization value's link description is `Organization - 2 records`
    and its href is pinned. These two pass after 7.1 and are PINs of the
    FIELD_LABEL flow.
  - Clicking the link opens the region named by the value, with the Field
    fact `Organization`.
  - The row becomes `aria-current`.
  - RED: no region appears.
- Implement: add `'organization'` to the client `RECORD_FIELDS`, with a
  comment pointing at the server's list.
- GREEN: `src/routes/settings`. The PIN `field=nope` is still no
  selection. Typecheck.

## (c) Tasks checked and found unaffected

- S1-S6 (Tasks 1.1-6.5, S4 close-out, the S6 checkpoint). None of them
  touches a changed file, except Task 5.3's e2e usage-pin edit. Its anchors
  (`// What uses the entry, counted per kind of record (D3, D10).` plus the
  `toEqual({` block) are unchanged and unique, so the task needs no change.
  Task 5.5 widens the server `RECORD_FIELDS` only, which is correct as
  written. Task 5.7's README, selectors and fixture anchors are in files
  the merge did not change.
- 7.1: `orgCopy.ts` and the api types are unchanged by the merge. Its GREEN
  over `src/routes/settings` still holds. `FIELD_LABEL` is still the only
  compile-forced `Record<OrgRecordField, ...>`; `orgSelection.ts` uses
  `OrgRecordField` only as parameter types. Its note that the A USAGE rows
  lack `inUse` until 7.4 still applies.
- 7.2, 7.6: `OrgPicker` and `ContactEditForm` are not in the merge.
- 7.3: code unchanged. Only the comment wording changed (see a).
- S8: 8.1-8.11 are unaffected. In 8.12 only the width note was added. 8.13
  is covered above.
- S9: 9.1-9.3 and 9.5-9.6 are unaffected. 9.4 changed only line refs. The
  checkpoint after S9 is unaffected.
- S10:
  - 10.1: its greps for `'/contacts/caseworkers',` and the TODO still
    match exactly one line after 8.13.
  - 10.2: unaffected.
  - 10.5-10.8: no Settings surface.
  - 10.9: unaffected as written, but see open question 1.
  - 10.12: none of its issue files changed in the merge. The only issue
    file the merge changed is `e2e-scenario-specs-rotate-failures-full-suite.md`,
    which B does not touch.
  - 10.14: unaffected, but see open question 4.
- Full width (brief item 7):
  - No B task adds a page-level width. The Caseworkers page reuses the
    uncapped `ContactsList` `.page`.
  - `CaseworkerDialog` is a Modal (a dialog width, not a page).
  - The Settings additions (the Kind choice in `SettleConfirm`) sit inside
    the already-sized settle box (`OrgSettings.module.css` `.settle`,
    48rem).
  - `OrgKindChoice`'s CSS has `width: 100%` on its legend only.
  - Nothing to remove.

## (d) Open questions, with proposed answers

1. **`e2e/support/selectors.md` rows 123-124 still describe the OLD Settings
   table.**
   - The stale text: `getByRole('row')`, `rowheader`, `hasText` substring
     values.
   - The layout branch did not update them. B's Task 10.8a and the merged
     org-lists spec now use the list + panel contract.
   - Proposed: add a step to Task 10.9 that rewrites those two rows to the
     merged contract:
     - segments `group 'Lists'`;
     - entry links named exactly;
     - the panel as a region named by the entry or value;
     - "Settle this value" radios plus a confirm named as the choice;
     - `valueLink` exact matching, no substring rule;
     - a value's URL `?view=not-on-list&field=&value=`.
   - Alternative: file a docs issue against the layout branch's leftovers.
     The step is docs-only and small, and keeping it in B avoids a known
     stale contract next to B's new rows.
2. **`blockingUses(u, 'delete')` doubles as the display count.** The list
   row and the panel's "Not used" read the same distinct total that blocks
   Delete. Proposed: keep one helper, with its doc saying so (as written).
   A separate `usageRecords(u)` alias would be the same arithmetic under a
   second name.
3. **Deleted records in the list row's count.** A's `usageTotal` counted
   deleted holders, and its pin is "8 records" = 6 active + 2 deleted.
   Proposed: keep it, as written. The row counts `inUse.active +
   inUse.deleted`, so A's pins hold and Delete's blocker and the row agree.
4. **Task 10.14's "sync main once".** Main was already merged mid-mission
   at 54e7b0d0 (that is what this rebaseline answers). Proposed: keep Task
   10.14 as written. Its sync is a no-op if main has not moved, and the
   gates must still run on the latest main. Name the 54e7b0d0 merge in the
   handback, so the two syncs are not read as a breach of "one main sync
   per branch".
5. **`toHaveAccessibleDescription` in e2e.** Task 10.8a uses this
   Playwright matcher, which no existing e2e spec uses yet. It exists from
   Playwright 1.44, and the e2e workspace pins `^1.50.0`. Proposed: keep
   it. If the installed version lacks it, fall back to
   `expect(valueLink(...)).toHaveAttribute('aria-describedby', /.+/)` plus
   the panel's Field fact. Never a count.
6. **A's leftover wording "the Settle dialogs".** `OrgPicker.tsx:93` and
   `orgCopy.ts:114` still say it, in comments the layout branch did not
   touch. Proposed: leave them. They are A's / layout's text, and B does
   not edit those lines.

## (e) Revised task list (whole plan)

- S1
  - 1.1 `CASEWORKER_ROLE` and the canonicalizer accepts partner + `Caseworker` - unchanged
  - 1.2 `app/src/lib/caseworkers.ts` helpers - unchanged
  - 1.3 `OrgField` gains `organization`; `KINDS_FOR_FIELD.organization` - unchanged
  - 1.4 the dashboard mirror `caseworkerRole.ts` and its drift test - unchanged
- S2
  - 2.1 `ContactItem` caseworker fields; `update` guards - unchanged
  - 2.2 `findAllByPhone` / `findAllByEmail` - unchanged
  - 2.3 `getRecipientDisplaysByIds` - unchanged
  - 2.4 `conversationsRepo.setTypeIfCurrent` - unchanged
  - 2.5 unit lists: FakeWorld paging; `deleted: 'any'` - unchanged
- S3
  - 3.1 classification side effects into `contactClassification.ts` - unchanged
  - 3.2 `caseworkerConversion.ts`: types, domain, refusals, preview removes - unchanged
  - 3.3 the organization: stored, list match, carried text - unchanged
  - 3.4 the thread plan - unchanged
  - 3.5 `make`: refusals, request organization, fenced commit, step-4 effects - unchanged
  - 3.6 `make` steps 2 and 3, the repair path - unchanged
  - 3.7 `dismiss` - unchanged
  - 3.8 `possibleCaseworkers.ts` - unchanged
- S4
  - 4.1 contacts POST and PATCH refuse the server-owned keys - unchanged
  - 4.2 PATCH `organization` - unchanged
  - 4.3 PATCH 409 `caseworker_use_conversion`; `type_source` - unchanged
  - 4.4 the caseworker-review routes, router wiring, `unitsRepo` - unchanged
  - 4.5 the importer leaves a manual type alone - unchanged
  - S4 close-out - unchanged
- S5
  - 5.1 `rewriteOrgFields` writes `organization` - unchanged
  - 5.2 the rewrite pass covers `organization` - unchanged
  - 5.3 usage: organization column, distinct totals, `refuseWhileUsed(mode)` - unchanged (its e2e anchors re-verified)
  - 5.4 "Not on the list" organization rows and holders - unchanged
  - 5.5 settling an organization row; Run again and the claim - unchanged
  - 5.6 `/check` takes `kinds` - unchanged
  - 5.7 the dev seam accepts `organization` - unchanged
- S6
  - 6.1 seeds and explicit recipients accept tenants or partners - unchanged
  - 6.2 preview voucher facts tenant-only - unchanged
  - 6.3 both fan-out mint sites use the contact's type - unchanged
  - 6.4 units recipients rows carry type and role - unchanged
  - 6.5 landlord timeline share labels go neutral - unchanged
  - Checkpoint after S6 - unchanged
- S7 (slice header revised)
  - 7.1 wire types, `checkOrgText` `kinds`, both-lists vocabulary in `orgCopy` - unchanged
  - 7.2 `OrgPicker` over both lists - unchanged
  - 7.3 `NewOrgDialog` organization mode and `OrgKindChoice` - revised (comment wording only)
  - 7.4 Settings: the use counts (list rows, entry panel), and Delete / Change kind read the server totals - revised
  - 7.5 "Not on the list": organization values and the settle confirm across both kinds - revised
  - 7.5a `orgSelection`: an organization value's URL selects it (the client RECORD_FIELDS) - NEW
  - 7.6 `ContactEditForm` routes org answers by field - unchanged
- S8
  - 8.1 API client wire types, endpoints, mutation-catalog rows - unchanged
  - 8.2 KindPicker: the Caseworker segment - unchanged
  - 8.3 CaseworkerDialog - unchanged
  - 8.4 ContactCreateForm offers Caseworker - unchanged
  - 8.5 ContactEditForm: offer gate, 409 copy, partner Organization picker - unchanged
  - 8.6 UnknownFile: "Mark as Caseworker" - unchanged
  - 8.7 ContactActionsMenu: "Make caseworker" - unchanged
  - 8.8 ContactDetail: header facts, Make caseworker, dialog host, perf pin - unchanged
  - 8.9 PartnerFile: Role, Organization, Staff notes - unchanged
  - 8.10 FilterChips factored out of TenantFilters - unchanged
  - 8.11 "Filter contacts" links gain Caseworkers - unchanged
  - 8.12 CaseworkersList page - revised (full-width note only)
  - 8.13 nav sub-link and dot, the route, the profiler exclusion, the e2e selector - revised
- S9
  - 9.1 property page "Send this property" and "Sent to" - unchanged
  - 9.2 "Sent to" rows label non-tenant recipients - unchanged
  - 9.3 property Activity share row says recipients - unchanged
  - 9.4 composer review step and reach line say recipients - revised (org-lists line refs)
  - 9.5 Matching list and results say recipients - unchanged
  - 9.6 PartnerFile Properties sent card and Send; selectors.md - unchanged
  - S9 -> S10 handoff - revised (org-lists line refs)
  - Checkpoint after S9 - unchanged
- S10
  - 10.1 VERIFY the profiler pins and the mutation catalog - unchanged
  - 10.2 the nav pins and the Caseworker preset - unchanged
  - 10.3 the organization usage wire pin, fixture types, dev-seam README line - revised (refs and notes)
  - 10.4 VERIFY the share-wording pins - revised (org-lists test lines in the run command)
  - 10.5 caseworkers.spec.ts part 1 - unchanged
  - 10.6 caseworkers.spec.ts part 2 - unchanged
  - 10.7 caseworkers.spec.ts part 3 - unchanged
  - 10.8 partner-share.spec.ts - unchanged
  - 10.8a org-lists.spec.ts: an organization value under "Not on the list" - revised
  - 10.9 selectors.md caseworker rows - unchanged (open question 1 proposes a step)
  - 10.10 GLOSSARY - revised (one phrase)
  - 10.11 RUNBOOK - revised (refs, one sentence)
  - 10.12 issues - unchanged
  - 10.13 the whole e2e suite - revised (wording)
  - 10.14 sync main, then the five gates - unchanged (open question 4)

## (f) Planner rulings on the open questions (2026-10-07)

Anchors spot-checked by the planner at 54e7b0d0: `orgSelection.ts:46`
RECORD_FIELDS, `OrgListPane.tsx:157` and `OrgDetailPanel.tsx:125`
usageTotal, three `kindForField` uses and `orgErrorCopy(err)` at `:387` in
NotOnListSection.tsx, `routes.test.ts:401-402` - all as the report says.

1. selectors.md rows 123-124 still describe the old table - ACCEPT: Task
   10.9 gains Step 2a (rewrite both rows from the merged spec's helpers).
2. One helper serves the Delete-blocking total and the displayed count -
   ACCEPT as proposed, documented at the helper.
3. The list row keeps counting deleted records (the old "8 records" pin) -
   ACCEPT.
4. Task 10.14's sync after the mid-mission merge - no change: its Step 1
   already skips when main has not moved since the last sync; the handback
   names both syncs (c1530f9d, 54e7b0d0) and any final one.
5. `toHaveAccessibleDescription` new to the e2e specs - ACCEPT with the
   given fallback.
6. "Settle dialogs" wording in comments B does not touch - leave it (not
   B's change).

No spec decision and no plan-review ruling changed. The plan's binding
sections moved only in WHERE things land (3.6, 3.9).
