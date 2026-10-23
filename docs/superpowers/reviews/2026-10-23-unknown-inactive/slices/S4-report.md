# S4 slice report - dashboard contact page, second half: S4.4-S4.6 (tracker #30)

Branch feat/unknown-inactive. S4.1-S4.3 (4138acf0..d4ba5fd6) are recorded in
S4a-report.md in this folder; this report covers S4.4-S4.6 only.
Commits: 66322757 (S4.4), f6c1c495 (S4.5), plus this report.

Both tasks went RED for the plan's stated reason, then GREEN:
- S4.4 ContactEditForm.test.tsx: 19 failed / 91 passed (110), then 110 passed.
  The baseline before the edits was 88 passed. Every failure matched plan
  S4.4 Step 2's list. The PIN cases and the unrelated-field save passed on
  the old code.
- S4.5 UnknownFile.test.tsx + ContactDetail.test.tsx: 2 failed / 168 passed,
  then 170 passed. Both failures were "Unable to find role=heading and name
  Type unknown". The PIN passed on the old code.
- src/routes/contact after S4.4: 80 files, 1811 passed.
- S4.6 Step 2: the whole dashboard suite ran 266 files, 5462 passed.
  `npm run typecheck` exit 0, after S4.4 and again after S4.5.

## What the tree held that the plan got wrong

- Every S4.4 and S4.5 anchor was byte-exact. That includes the 30 one-line
  3j edits, and ContactEditForm.tsx and its test were unchanged since
  916258ae. The `?` characters in the old ContactEditForm.tsx comments were
  literal ASCII question marks, so the anchors matched as quoted.
- Two plan lines are wrong in small ways (they are the WORKLIST D lines
  below): the Step 2 failure text for the change-and-back case, and the
  Step 3j grep's expected output.
- S4.6 Step 4 diffs against `main`. Per OR-20 I diffed against 916258ae.
- S4.6 Step 3 says ContactDetail.tsx and ContactEditForm.tsx "may carry"
  pre-existing react-hooks errors. Neither does, at 916258ae or now (OR-21
  below).
- Left as is, both outside the plan's edits:
  - ContactEditForm.tsx:194 still says "A type change re-derives it (see the
    effect below)". There is no effect: the re-derive is handleKindChange at
    :273-279.
  - Two older test names are now partly inaccurate. Their assertions are
    still correct, because both use landlord fixtures.
    - ContactEditForm.test.tsx:403 is "a non-tenant status change rides
      updateContact". After D3, only a landlord's status change does.
    - :333 is "... and 2 for a non-tenant". It asserts the landlord's 5, and
      that was already wrong before this branch.

## S4.6 Step 1 - check-only surfaces (no change made)

- dashboard/src/ui/StatusMenu.tsx is generic (`options`, `tone`). Its
  `StatusTone` (:33-43) holds every `BadgeTone` (StatusBadge.tsx:20), `muted`
  included, so it covers everything `contactStatusTone` returns.
- dashboard/src/routes/contact/Card.tsx:500 `responseClass.inactive` is used
  only by routes/listing/ListingDetail.tsx:103 (property `off_market`). There
  is no contact status class.
- These pages show status through the S4.2 helpers:
  - PartnerFile.tsx:133: `contactStatusLabel(contact.type, ...)`.
  - LandlordFile.tsx:88-89, :157: `contactStatusLabel('landlord', ...)`.
  - TenantFile.tsx:250-253, which serves tenants and team members. The
    StatusBadge shows only for a `warn` tone (needs_review, the same label
    for every type). Otherwise the row is the plain label, so an Inactive
    team member reads "Inactive".

## Required records (plan S4.6 Step 5)

- Clarification 3 (built). A type change TO tenant calls setTenantStatus
  when the shown status is not onboarding OR the porting box changed
  (ContactEditForm.tsx:522-527).
- With porting changed and Onboarding kept, the server writes NO second
  milestone:
  - setTenantStatus reads with `consistentRead: true`
    (services/statusTransition.ts:630), so it sees the onboarding status the
    PATCH's auto-advance just wrote (routes/contacts.ts:1766-1770).
  - buildContactStatusTransitionPlan adds `activity` only when
    `contact.status !== toStatus` (statusTransition.ts:178-183).
- That second call still has three effects:
  - one more `tenant_status_changed` audit row, onboarding -> onboarding
    (:168-174);
  - `status_source: 'manual'` (:165), where the PATCH stamps none
    (contacts.ts:1757-1760). This changes provenance only: derivation keys on
    the status VALUE (statusTransition.ts:369), per the resolved
    docs/issues/status-pin-vs-terminal-derivation.md;
  - a second contact.updated (:678). OR-5's latest-wins re-read handles that
    on the contact page.
- Clarification 5 is a planner decision, not a builder change (also in
  S4a-report.md). Non-tenant Contacts list rows show their type's label as
  plain text (ContactsList.tsx:180, via `statusLabel` :100-103) and get no
  toned badge. So D4.4's muted color shows on the contact page header and
  details, not on those rows.
- A 409 `contact_type_changed` on the form's partner, team member or unknown
  status write (setTenantStatus) falls through to "Couldn't save - please
  try again." (ContactEditForm.tsx:576). I judge it ADEQUATE AS A SAFE
  FAILURE but WEAK AS GUIDANCE:
  - Nothing is written, and the form stays open with its draft.
  - The PATCH path's own concurrency 409 (`contact_changed`) gets the same
    line today.
  - But "try again" re-sends the same frozen choice, and the operator is
    never told the type changed. Closing and reopening the editor shows the
    new type's list, because the page behind the modal has already re-read
    the contact (S2.9).
  - Planner option, not built: map `contact_type_changed` in the form to
    a sentence like the header's CONTACT_TYPE_CHANGED_STATUS_COPY
    (ContactDetail.tsx:143), plus "close and reopen".
- Pre-existing lint errors from Step 3: one,
  ContactsList.tsx:219 (see OR-21).

## WORKLIST items

- OR-21. `npx eslint` on all 16 S4-touched .ts/.tsx files (S4a's and
  S4b's; they are exactly the plan's Step 3 list) exits 1 with ONE error:
  ContactsList.tsx:219:21 `react-hooks/set-state-in-effect`.
  - Baseline: I linted the 916258ae content of each of the 15 pre-existing
    files (`git show 916258ae:<f> | npx eslint --stdin --stdin-filename <f>`).
    It finds only the same error, at ContactsList.tsx:208:21. S4a's +11
    lines moved it.
  - The new contactStatusMirror.test.ts is clean.
  - ContactDetail.tsx and ContactEditForm.tsx are lint-clean at both
    points.
  - No S4 lint error.
- OR-20. Every S4 file's added lines are ASCII against 916258ae (all 16
  code files and docs/issues/contacts-status-filter-tenants-only.md print 0).
  The new contactStatusMirror.test.ts prints 0, and so does this report.
  None of the S4b files holds a `u2192` escape.
- OR-15. No S4 added line, in dashboard/ or docs/issues/, uses the
  British spelling of "color" (case-insensitive grep count 0).
- OR-22. I read a bare `git status` before every `git add`. Nothing was
  ever staged that I had not staged.

## Record-only lines (WORKLIST section D, S4 bullet)

- S4.4 Step 2: the change-and-back case (ContactEditForm.test.tsx:1794)
  fails at its FIRST assertion, `expected 'needs_review' to be 'interested'`.
  The old handleKindChange (base ContactEditForm.tsx:290-291) reset
  'searching' to 'needs_review' when Landlord was picked, so the test never
  reached the come-back step or a setTenantStatus. It is still a valid RED
  (s4 3). The Other-panel case (:1813) failed the same way.
- S4.4 Step 3j: the grep `contact[.[(]\|(contact)` does not print
  `let updated: Contact = contact;` (ContactEditForm.tsx:538) (s4 4). It
  prints only these lines:
  - the useState seeds (:159-262, the requirementFormValuesFromLandlord seed
    at :226 included);
  - `useState(contact)` (:154);
  - the two `contact.contactId` calls (:540, :551);
  - the `base` comment line naming contact.updated (:150).
  The second grep (old list names) prints nothing.
- A status write from the frozen-base form after a concurrent re-type is
  validated only by the route's own read (s4 5). This is the same class as
  today's PATCH path, not a regression. AR4 covers only the route's
  read-to-write window.
  - The form diffs against `base` (ContactEditForm.tsx:154). Its
    no-type-change status write (:547-556) sends no expected type.
  - The route checks `toStatus` against the type IT reads
    (routes/statusTransition.ts:279), then passes that type as
    `expectedType` (:292).
  - So a status picked from the opened type's list lands on the re-typed
    contact when it is legal there (e.g. Inactive onto a contact re-typed
    to tenant). Otherwise it 400s to the generic line above.

## As built (for S6 and the reviewers)

- ContactEditForm.tsx:
  - `base` :154; `typeChanged` :178; `initialStatus` :181;
    `statusType` :187; FIRST_STATUS_FOR_TYPE :47.
  - handleKindChange :273-279; the buildPatch status rule :339.
  - `statusTransition` :523-527; the setTenantStatus call :547-556, where
    porting rides only a tenant's write.
  - Options: `statusOptionsFor(statusType)` :598.
  - The private lists, `isTenantStatus` and `statusOptionsForType` are
    gone. Every list and label now comes from api/types.ts (AR2).
- UnknownFile.tsx:104: the card title is "Needs triage" when
  `contact.status === 'needs_review'`, else "Type unknown" (AR20, exact). A
  legacy (unknown, active) contact or a status-less one also reads "Type
  unknown". That matches D8's "only while Needs review". The e2e "Needs
  triage" selectors (caseworkers.spec.ts:86, :525;
  conversation-fact-extraction.spec.ts:304, :333, :381) all drive
  inbound-captured needs_review contacts, so they are unaffected.
- The page passes the live contact into the form with no `key`
  (ContactDetail.tsx:1357-1365), so a re-read never remounts it and `base`
  stays the contact as opened.

Untrimmed input paths: none (no new input; status values are fixed keys).
