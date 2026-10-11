# Fix wave 2 - independent adversarial review

Range: `e6447786..10de23e7` (70cbfe8e code + tests, 10de23e7 docs), branch
`feat/caseworkers`. Answers planner-spec-conformance-review.md P3-1..P3-8,
T-1, T-2, D-1, D-2 (P3-9 deliberately out of scope).

Verdict: every code fix is correct against its finding and every new test
kills its mutation. One should-fix is in the docs (the D-1 RUNBOOK step
restores the wrong status in two common cases). One P3-6 error path is still
missing, and the P3-7 CSS has a phone-width side effect. Nothing blocks.

## Findings

### FW2-1 - P2 should-fix - RUNBOOK status restore "in the same edit" lands on the auto-advanced status

- Where: `RUNBOOK.md:469` (new step 4), against
  `dashboard/src/routes/contact/ContactEditForm.tsx:256-264` (kind change
  re-derives Status), `:317-319` (non-tenant status sent only when it differs
  from the type default), `:480-483` (tenant status sent only when it differs
  from the default), and `app/src/routes/contacts.ts:1578-1582` (a type
  change with no `status` in the body auto-advances: tenant -> onboarding,
  landlord -> interested).
- Failure scenario:
  - (a) Tenant whose earlier status was Needs review (no earlier milestone,
    or one reading `Status -> Needs review`). Step 3 picks Tenant, and the
    form re-derives Status to Needs review. Staff leave it there, which is
    exactly what step 4 asks. The form sends `{type:'tenant', role:''}` with
    no status and no setTenantStatus. The server stores **onboarding**.
  - (b) Landlord whose earlier status was Active. The conversion recorded no
    milestone, and step 4 says that means Active. The form keeps Active,
    which is valid for a landlord and equals the default, so no status is
    sent. The server stores **interested**.
  - In both cases the procedure reports success with the wrong status.
- Secondary inaccuracy: "with no earlier status milestone at all, the contact
  still held the status it was created with" is not strictly true.
  - An importer re-run rewrites `status` when `status_source` is `import`,
    and it records no milestone (`app/src/lib/import/apply.ts:1091,1162`).
  - Milestone writes are best-effort (`contacts.ts:1959-1969`), so a write
    can fail silently.
- Verified: two scratch tests in a copy under /tmp/claude-0/review-fw2.
  - Dashboard: ContactEditForm on `{partner, Caseworker, active}`, Change
    type > Tenant (or Landlord), Status left on the re-derived value, Save.
    The PATCH body was `{"type":"tenant","role":""}` (or `"landlord"`), with
    0 setTenantStatus calls.
  - App harness: PATCH `{type, role:''}` on a `{partner, Caseworker, active}`
    contact. The stored status was `onboarding` (tenant) and `interested`
    (landlord).
- Suggested fix (docs only):
  - Step 4: after saving step 3, read the Status shown on the contact page.
    A kind change whose Status choice is left at the form's default lets the
    server pick it: Tenant -> Onboarding, Landlord -> Interested.
  - If the shown Status is not the earlier one, edit once more and set it.
    That second edit sends `status` explicitly.
  - Soften the "no milestone" sentence: an imported contact's status may have
    changed with no milestone.
  - Optional code fix, separate change: the form sends `status` whenever
    `type` changes.

### FW2-2 - P3 minor - a dismissal refused for a team member still offers a retry that loops

- Where: `dashboard/src/routes/contacts/CaseworkersList.tsx:55-60`
  (`finalDismissError`) against `app/src/services/caseworkerConversion.ts:206`
  and `:597-598`. `dismiss` calls `readSubject` first, which answers
  `400 caseworker_team_member` before dismiss's own
  `caseworker_dismiss_not_allowed` check.
- Failure scenario:
  1. A Possible row's contact is re-typed to team member in another tab.
  2. On the stale list, staff click Not a caseworker > Hide.
  3. The answer is 400 `caseworker_team_member`. That code is not mapped, so
     the modal shows `DISMISS_FAILED` ("... please try again.") with Hide
     enabled and no re-read, so every retry fails the same way.
  4. This is the same stale-list loop class that P3-6 closed for 404 and
     `caseworker_dismiss_not_allowed`. The dialog side maps
     `caseworker_team_member`; the dismiss side does not.
- Verified: by reading (the readSubject order; the mapping in
  finalDismissError).
- Suggested fix:
  - Map it too, for example
    `finalCaseworkerError(err) ?? (400 && caseworker_dismiss_not_allowed ? DISMISS_NOT_POSSIBLE : null)`.
    That also drops the duplicate 404 branch.
  - Add a third case to the parametrized test at
    `CaseworkersList.test.tsx:251-278`.

### FW2-3 - P3 minor - at a narrow pane a caseworker's organization is now cut to one line

- Where: `dashboard/src/routes/contacts/CaseworkersList.module.css:13-21`
  (`.org` is now `nowrap` + ellipsis at every width) together with
  `ContactsList.module.css:286-326` (the 560px container query stacks the
  row: `.meta` gets its own line, and `.factsRow .meta` keeps
  `overflow: hidden`).
- Failure scenario:
  - Before the fix, `.org` had no white-space rule. In the stacked layout
    (phones, and the narrow pane just above the nav breakpoint), a long
    organization wrapped and was readable in full.
  - Now it is ellipsized to one line. The full text is only in `title`,
    which a touch device never shows.
  - Wide panes are unaffected; the fix was only needed there.
- Verified: by reading the cascade.
  - The pre-fix `.org` (diff) had font-size and color only.
  - Under the container query, `.factsRow .name` is reset to wrap, but
    nothing resets `.org`.
  - Not measured live (Playwright is off-limits while the session lane runs).
- Suggested fix: in CaseworkersList.module.css, add
  `@container (max-width: 560px) { .org { white-space: normal; overflow: visible; } }`.
  The `.page` container is the nearest one, so this mirrors the
  `.factsRow .name` stacking rule.

### FW2-4 - note - contact_changed followed by a final preview shows two contradictory alerts

- Where: `dashboard/src/routes/contact/CaseworkerDialog.tsx:292-295` (409
  `contact_changed` sets `error` = `CONTACT_CHANGED_COPY` and re-reads),
  `:339-342` (final branch), `:403-407` (the `error` paragraph still renders).
- Failure scenario:
  1. Make answers 409 `contact_changed`.
  2. The re-read preview then answers 404, or 400 for a team member.
  3. The body shows "This contact no longer exists." (or the team-member
     line), and under it "This contact changed while this was open. Review
     and try again." There is no Try again button and Confirm is disabled.
  - Reachable only through a race: make's own conflict path answers 404
    directly when the contact was deleted (`caseworkerConversion.ts:579-584`).
- Suggested fix: call `setError(null)` when a preview read lands `final`.

### FW2-5 - note - the new pointer comments claim "the GET 404s it"; it does not for an email pointer

- Where: `app/src/routes/contacts.ts:1527-1529` and
  `app/test/contactTriage.test.ts:994`, against `contacts.ts:1204`. The GET
  guards `phone_ref` only.
- Failure scenario:
  - `GET /api/contacts/emailref%23...` answers 200 with the pointer row.
  - The same phone-only guard sits on listings-sent `:1223`, relay-groups
    `:1267`, group-threads `:1358`, media `:1437`, extraction-run `:2393`
    and voice-opt-out `:2151`.
  - voice-opt-out is a WRITE: it sets a flag on an email pointer.
  - This gap existed before this branch and is outside this wave's scope.
    `app/src/routes/api.ts:2131-2134` already calls phone-only guarding a
    bug.
- Verified: scratch harness test. GET of a phone pointer -> 404; GET of an
  email pointer -> 200.
- Suggested fix:
  - Reword the two comments ("the GET 404s a phone pointer").
  - File a `docs/issues/` entry for an `email_ref` sweep of those routes.
    The PATCH and possibleCaseworkers changes here are already correct for
    both kinds.

### FW2-6 - note - "This contact no longer exists." is also shown for a restorable soft-deleted contact

- Where: `dashboard/src/routes/contact/CaseworkerDialog.tsx:49`, also used by
  `CaseworkersList.tsx:57`. `readSubject` answers 404 for soft-deleted
  contacts too (`caseworkerConversion.ts:202`).
- Detail:
  - A soft-deleted contact can be restored
    (`dashboard/src/api/endpoints.ts:1743-1747`).
  - The catalog wording for the same code elsewhere is "That contact is
    gone, so nothing changed." (`dashboard/src/api/types.ts:1666`), plus
    "That contact was deleted - restore them to send." (`:1566`).
- Suggested fix: "This contact was deleted." Wording only.

### FW2-7 - note - on rows with an organization the name is now capped at 55cqw

- Where: `CaseworkersList.tsx:251-254` opts organization rows into
  `.factsRow`, whose `.name` is `flex: 1 0 auto; max-width: 55cqw`
  (`ContactsList.module.css:252-255`).
- Detail:
  - A long name on a row with a SHORT organization now ellipsizes at 55% of
    the pane, where before it took all the free space.
  - Rows without an organization keep the uncapped name, so two long names
    in one list can truncate differently.
  - This is the same documented tradeoff as tenant rows
    (`docs/issues/tenant-row-longname-midpane-overflow.md`), so no change is
    needed.

### FW2-8 - note - the contact page host does not re-read on a final answer

- Where: `dashboard/src/routes/contact/ContactDetail.tsx:1231-1236` passes no
  `onStale`. That covers both More actions and the Unknown card.
- Detail:
  - A 404 there now shows final copy, which is correct.
  - The page keeps showing the deleted contact until it reloads.
  - The finding scoped the re-read to the Possible list, so this is
    acceptable. A follow-up could pass `onStale={reload}`.

## Checked and sound

- P3-1 CSS cascade:
  - `.segmentBarSix` (`KindPicker.module.css:57`) precedes the
    `@media (max-width: 599px) .segmentBar` rule (`:70`). Both selectors have
    the same specificity, so phones keep 2 columns.
  - With six items the last item is even, so no item spans the full row.
  - The 5-choice bar is untouched.
  - Both hosts use the same 30rem Modal: the new-contact form, and the edit
    form for a stored caseworker (`ContactEditForm.tsx:588-592`).
  - A column is about 147px, which fits "Property Manager" at 13px with
    12px padding.
  - The 1280px clip check fails on the pre-fix flex row (the reviewer
    measured "Other" at 458 > 444).
- P3-2:
  - Only the Other path carried the role. Tenant, Landlord, Partner and PM
    set their own role.
  - The test fails with the fix reverted.
- P3-3:
  - `ContactItem.caseworker_conversion` is typed, and the spread typechecks.
  - A hand-typed caseworker's audit invents no record, and a test asserts it.
  - The RUNBOOK step 1 addition is accurate.
- P3-4:
  - The test fails with the push removed (3 cases).
  - Side effect: one extra suggestions GetItem per staff override in the
    `pendingByField` loop (`contacts.ts:1737-1744`). It is harmless and
    matches how `status` and `consent_captured_by` are handled.
- P3-5 error precedence:
  - The order is now blank -> kind -> field pair -> lock -> on-list ->
    variant -> named. Everything that answered 400 before still answers 400.
  - Organization-row Move/Split stays 400
    (`orgRewriteService.test.ts:416-428` passes).
  - With the pre-fix `orgRewrite.ts` restored, the new test fails on
    `org_rewrite_running`.
  - `isOnListFor` is an exact match, so the name-variant half also tests
    the fix.
- P3-6 React:
  - The `onStaleRef` pattern is lint-clean.
  - There is no loop. The preview effect depends only on
    `[contactId, attempt]`, and `onStale` only bumps the list generation.
  - The dialog and the Hide modal stay mounted during the re-read, because
    their `converting` / `dismissing` state is independent of load state.
  - StrictMode double effects are guarded by abort.
  - `dismissFinal` resets per opened row.
  - All four new list tests and the dialog tests fail with the fix removed.
- P3-7 wide layout:
  - Only `.meta` and `.org` shrink. The name and the phone stay
    unshrinkable.
  - Rows without an organization are untouched. Rows with one stay
    right-aligned via `margin-left: auto`.
- P3-8:
  - The guard runs after body parsing, so a malformed body still answers
    400 first, and before every other 404, 409 and 422.
  - The PATCH test fails with the guard removed (200).
  - The `readPartition` test fails with the filter removed.
- T-1:
  - The fake matches `listByStatus` and the real repo (`queryIndex`: no
    limit, no cap).
  - The new test fails against the OLD fake and with a broken loop.
  - The other callers stay green: `unitsApi*`, `unitsSoftDelete` and
    `contactTimeline` tests (71 + 124 tests across 9 files).
- T-2: the test fails with the tenant fence deleted (3 ids returned).
- D-2: the refs match 10de23e7. `contacts.ts:1543-1544` is
  newType/convType, and `:1911-1919` and `:1916` are the flip loop.
- Repo rules:
  - Added lines are ASCII-only (grep of the diff).
  - Comment density matches the surrounding code.
  - New copy follows the dialog's own constants convention.
- Gates run by this reviewer:
  - `tsc` for dashboard, app, app tests and e2e: clean.
  - `npx eslint` on the 17 changed ts/tsx files: exit 0.
  - vitest on the changed files: app 5 files / 196 tests, dashboard 5 files
    / 149 tests, all passing.
  - The e2e specs (contact-create, caseworkers) were NOT run: the live
    session lane forbids Playwright. They were checked by reading and
    typecheck only.
