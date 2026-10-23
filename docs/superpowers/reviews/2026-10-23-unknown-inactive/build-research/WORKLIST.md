# Build worklist - feat/unknown-inactive (Phase 1 merge, orchestrator rulings OR-1..OR-22)

Merged by the build orchestrator on 2026-10-23 from six parallel read-only
readers on the tree at fd0bd61e (code = main @916258ae):
`s1-writers-findings.md`, `s2-notify-findings.md`, `s3-readers-findings.md`,
`s4-contact-page-findings.md`, `s5-s6-inbox-e2e-findings.md`,
`invariant-sweep-findings.md` (all in this folder). Totals: 0 BLOCKER,
2 MAJOR, 32 MINOR. Every plan anchor in every slice was verified byte-exact
and unique where an Edit needs it; every RED/PIN holds except where noted
below. W4: no inbound writer writes an EXISTING contact's status (no STOP).
W2: a needs_review -> inactive flip mid-walk does not meet the reopen trigger.
Baseline at fd0bd61e: typecheck 0, smoke 0, npm test 0 (app 526 files /
11046 passed, 1 skipped; dashboard 265 / 5391; e2e workspace 22 / 508).

Precedence: the spec wins over everything; then the planner rulings AR1-AR24
(plan section 4); then THIS worklist; then the plan's slice text. No item
below contradicts an AR ruling; where an item adds work, it says which slice
and task own it. Each implementer applies the items for its slice and names
each OR-n it applied (or why not) in its slice report.

## A. Behavior and test changes (binding)

OR-1 (MAJOR, invariant-sweep 1) - Contacts > Unknown view lists Inactive rows
LAST. Owner: S4.2 (and S6.1 for the e2e assertion).
- Why: `listByType` is one byTypeStatus Query (app/src/repos/contactsRepo.ts:1379-1414)
  returning rows ascending by `status`; `'inactive' < 'needs_review'`, and the
  non-tenant views are never re-sorted (dashboard/src/routes/contacts/ContactsList.tsx:267
  `if (!isTenantView) return queried;`). After this branch every Inactive
  unknown would sort ABOVE every Needs review one on Contacts > Unknown - the
  reverse of Cameron's rule for the inbox Unknown tab ("ordered by needs
  review first") and of the filed issue's premise that a retired contact
  "stays mixed in".
- Ruling (orchestrator, reversible; surfaced for Cameron in the handback):
  for `filter === 'unknown'` ONLY, the `visible` memo returns the queried
  rows stably partitioned: rows whose `status !== 'inactive'` first, then the
  `inactive` rows, each group keeping server order (Array.prototype.sort is
  stable; a comparator on `Number(a.status === 'inactive') -
  Number(b.status === 'inactive')` over a copy). Keyed on the literal
  `inactive` (plan section 1). No other view changes: Tenants keeps its
  facets/sort; All, Landlords and Deleted keep server order; the Caseworkers
  page is a separate component (dashboard/src/routes/contacts/CaseworkersList.tsx:98-99,
  sorted by name) and is untouched. `ContactsFilter` is
  `'all' | 'tenant' | 'landlord' | 'unknown' | 'deleted'`
  (dashboard/src/routes/contacts/useContacts.ts:16). Add `filter` to the
  memo's deps if the memo reads it (react-hooks lint).
- Tests (ContactsList.test.tsx, which already renders
  `<ContactsList filter="unknown" />` ~:261): RED - an Inactive unknown row
  returned FIRST by the mocked list renders AFTER a Needs review row; PIN -
  the All view (`filter="all"`) keeps server order for an Inactive row
  returned first.
- S6.1 step (6): add an ORDER assertion on Contacts > Unknown - the Needs
  review contact's row is above the Inactive contact's row (same technique
  as the inbox step (7)).
- Issue body (AR14 allows it: this changes the behavior the issue describes):
  in docs/issues/contacts-status-filter-tenants-only.md replace the premise
  "so a contact staff have retired stays mixed in with the ones they are
  working" with an accurate sentence: on the Unknown view Inactive contacts
  now list after the Needs review ones (tracker #30); the Caseworkers view
  sorts by name, so a retired caseworker stays mixed in there. S4 owns this
  edit and names it in its report.

OR-2 (MAJOR, s1-writers 1) - S1.3's label tests must use COPY reads. Owner:
S1.3.
- Why: the harness getById returns the LIVE object that update mutates in
  place (app/test/helpers/twilioWebhookHarness.ts:2280-2282, :2455-2458), and
  the PATCH writes (app/src/routes/contacts.ts:1930) before it labels
  (:2129-2135), so `statusLabelFor(stored.type, ...)` - the defect D4.5 fixes
  - would pass all three label tests.
- Ruling: in "labels the milestone with the NEW type: an unknown re-typed to
  partner" and in the tenant -> landlord label case, spy getById to return a
  structuredClone before the PATCH, exactly the `snapshotReads` pattern at
  app/test/contactTriage.test.ts:728-732. The tenant -> landlord case drops
  its "(PIN)" prefix and harness-only comment and becomes a real RED (old
  code: TENANT map, "Status -> interested"). Restate S1.3 Step 2's RED reason
  for unknown -> partner: the pre-write copy's type is `unknown`, the old
  picker falls back to TENANT_STATUS_LABELS, which has no `active`. The
  Inactive tenant -> unknown case stays as written (it cannot discriminate).

OR-3 (MINOR x2, invariant-sweep 2 + s2-notify 3) - a status-only contact
PATCH reads consistently and is fenced on the stored type. Owner: NEW task
S2.5b, built and committed right after S2.5 (TDD as every task).
- Why: AR4 fences the transition route; the status-only PATCH validates
  against `stored.type` (contacts.ts:1665-1675) read eventually consistently
  (:1619-1622 - consistent only for org/classification/requirement bodies)
  and writes with no condition on `type` (:1922-1934). A concurrent re-type
  can store exactly the pairs spec D2/D6 forbid ((landlord, inactive),
  (unknown, active)), and a stale read can also suppress S2.5's
  contact.updated emit and the milestone diff (`priorStatus`, :1631).
- Ruling: (i) add `'status' in parsed.patch` to the consistent-read
  condition at ~1621; (ii) when `'status' in parsed.patch &&
  !('type' in parsed.patch) && stored !== undefined`, add
  `...guardAsRead(stored, 'type')` (contacts.ts:527-534) to the write's
  guards unless the requirement guards already pushed the same clause
  (:1647). A lost guard is the EXISTING `409 { error: 'contact_changed',
  contact }` path (:1950-1953) - no new error code, nothing audited,
  timelined or emitted.
- Tests (app/test/contactTriage.test.ts or the S1.1 status-only PATCH
  describe, whichever holds the status-only PATCH cases): RED (1) a
  status-only PATCH `{ status: 'inactive' }` on a partner whose stored type
  is re-typed to landlord between the read and the write (getById spy:
  return a structuredClone of the partner, then re-type the stored record)
  -> 409 contact_changed, stored record still (landlord, <its status>), no
  "Status -> Inactive" milestone, no contact.updated; RED (2) a status-only
  PATCH calls getById with `{ consistentRead: true }`. Before writing them,
  grep app/test for pins on the PATCH's read options (`consistentRead`) and
  flip any that pin an eventually consistent read for a status-only body;
  name each in the S2 report.

OR-4 (MINOR, invariant-sweep 4) - the contact timeline refetches on
contact.updated for its own contact. Owner: S2.9 (same commit or a second
commit in S2.9).
- Why: useContactTimeline refetches on message.persisted /
  conversation.updated / scheduled.updated only
  (dashboard/src/routes/contact/useContactTimeline.ts:539-545); after a D3
  edit-form status save (now through setTenantStatus, which emits only
  contact.updated) or a change in another tab, the "Status -> X" milestone
  would stay missing until an unrelated event.
- Ruling: add `onContactUpdated: (event) => { if (event.contactId ===
  contactId) scheduleRefetch(); }` to that useEventStream call. Test in
  useContactTimeline.test.tsx (it captures handlers via `lastHandlers`,
  ~:11-21; widen that type): RED - onContactUpdated for the open contact
  triggers a timeline refetch after the debounce; PIN - another contact's
  event does not. Add both files to S2's file list and the S2.10 checks.

OR-5 (MINOR, s2-notify 1) - S2.9's `refetchInPlace` is latest-wins. Owner:
S2.9.
- Why: a D3 type change to tenant whose shown status is not Onboarding
  emits contact.updated TWICE (the PATCH, then setTenantStatus); two
  consistent GETs answering out of order would leave the intermediate
  (tenant, onboarding) contact on screen.
- Ruling: a `useRef` sequence number bumped per re-read; a response whose
  number is not the latest is dropped. Test: two onContactUpdated events,
  the first getContact resolving LAST -> the second response's contact is
  shown. Record in the S2 report that the initial-load fetch is not part of
  the sequence (unchanged).

OR-6 (MINOR, s3-readers 6) - S3.3 gains an Inactive TEAM MEMBER case: its
unread unknown_1to1 thread is NOT in Needs you now
(`newUnknownRefIds(items)` = []). Real RED on current code (today.ts:784-808).
Step 2's RED list then has three entries.

OR-7 (MINOR, s3-readers 7) - a resurfaced soft-deleted Inactive contact's
inbox row carries `deleted: true` AND `inactive: true` (inbox.ts:1040-1078;
AR5 does not exclude it). Ruling: keep AR5 literal - InboxRow shows BOTH the
Deleted chip and the Inactive tag (the contact page also keeps showing a
deleted contact's status, spec D2). S5.1 pins it with one InboxRow.test.tsx
case.

## B. Comment and documentation fixes (binding, no behavior)

OR-8 (s1-writers 2) - S1.1 step 1f: also replace
app/test/unknownQueue.test.ts:199-200 "the empty `active` block" with "the
empty `inactive` block" (assertion unchanged).

OR-9 (s1-writers 3) - S1.5: replace the WHOLE non-ASCII comment line
app/src/lib/seed/history.ts:215 (copy it from a Read into old_string) with an
ASCII line, e.g. `// Non-tenant/non-landlord contacts (partner/team_member/unknown):`,
followed by the comment lines the plan already adds.

OR-10 (s1-writers 4) - S1.2: replace app/src/routes/contacts.ts:990 with
`// A manual create of a known type asserts identity (past the front door, not`
`// needs_review); an unknown create does not (see the unknown arm below).`

OR-11 (s1-writers 5) - S1.1 (beside step 3h): correct
app/test/contactsPartitionFake.test.ts:97-99 to name `needs_review` and
`inactive` (both 'active' and 'inactive' sort before 'needs_review', so the
pin itself stays valid).

OR-12 (s1-writers 6) - S3.6 (the W5 record task): comment-only edit of
app/src/services/audienceResolution.ts:84-85 "(a partner's needs_review |
active ..." -> "(a partner's needs_review | active | inactive ...". Behavior
unchanged, so W5 ("unchanged") still holds; S3 report says so.

OR-13 (s3-readers 1) - S3.4 Step 7 Edit C: the "IT IS NOT THE ORDER THE
OPERATOR SEES" paragraph cites `(dashboard/src/routes/inbox/useInbox.ts,
sortForFilter)` (AR15 requires both `sortForFilter` and
`compareUnknownTabRows`).

OR-14 (s3-readers 3) - S3.6: in the W2 issue-body paragraph and the S3
report, replace "The change does not grow the partition (an Inactive unknown
stays in it exactly as an Active one did)" with: "The change adds no rows by
itself, but Inactive is now the one-click set-aside and it does NOT drain
the partition (only a re-type or a delete does, unknownQueue.ts:64-65), so
the partition only grows and a status write between Load-more clicks is now
routine. The trigger is NOT met on the recorded counts; nobody re-measured.
Re-measure beside the W7 re-count." File nothing new (AR14).

OR-15 (s5-s6 1) - American English: "color", never "colour", in every new
line (S6.2 5b item 4; the S4.2 test comment the plan writes as "muted
colour"; any other).

OR-16 (s5-s6 2) - S6.2 5b and the S6.3 Inactive glossary entry also say that
an Inactive TEAM MEMBER leaves Needs you now (its threads are unknown_1to1,
today.ts:784), while an Inactive tenant's or partner's unread text still
shows under Unreplied (today.ts:815-817).

OR-17 (s5-s6 3) - S6.1: after the step (8) unread poll, add the Unknown-feed
poll `expect.poll(async () => (await inboxWireRow(api, 'unknown', idA))?.unreadCount ?? 0, { timeout: 15_000 }).toBe(1)`
(or the spec's equivalent helper), so the coverage claim "unread on
All/Unread/Unknown" is true.

OR-18 (s5-s6 4) - S6.1 runner: repeat the Step 4 stack-free check
(session.pid, lane.json ports, Get-NetTCPConnection) before EACH of red1,
red2 and green2; an exit of 124 is an aborted run: stop, prove the ports
free, re-run.

OR-19 (s5-s6 5) - S5.3: update the dashboard/src/routes/inbox/Inbox.tsx:1-4
header comment ("newest-activity-first" now holds for every tab except
Unknown, which lists Needs review first); add Inbox.tsx to S5.3's commit and
the S5.4 lint/ASCII lists.

## C. Process rules (binding on every slice)

OR-20 (s3-readers 8, s4 2) - the ASCII added-lines check runs on EVERY file
a task commits, diffed against the fixed base 916258ae (never against the
moving `main`):
`git -C /w/tmp/unknown-inactive diff -U0 916258ae -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
prints 0 (a new file: `tr -d ... < FILE | wc -c` prints 0).

OR-21 (s4 1) - gate-5 expectations: the only pre-existing lint error in a
file this plan touches is dashboard/src/routes/contacts/ContactsList.tsx:208
`react-hooks/set-state-in-effect` (it moves to ~:209 after S4.2);
ContactDetail.tsx and ContactEditForm.tsx are lint-clean today. Any other
lint error in a touched file is the slice's and blocking. S4 lints its files
and records the result.

OR-22 - shared branch: the planner commits mission records to this branch
(e.g. fd0bd61e, intent.md). Before every `git add`, read the bare
`git status`; if anything is STAGED that you did not stage, STOP and report
instead of committing (a commit takes the whole index).

## D. Record-only items (each owner writes the line in its slice report)

- S2 report: the PATCH's contact.updated emit follows non-best-effort awaits
  (contacts.ts:2073-2093, :2119), so a committed write that then throws sends
  no event (s2-notify 2); W8 citations are today.ts:870 (GSI) and
  today.ts:362 (GetItem), plus the inbox Unknown-tab GSI read
  unknownQueue.ts:350 (s2-notify 4); C4's sse.test.ts:364-387 is the
  status-webhook exact assert, the PATCH one is contactTriage.test.ts:85-96
  (s2-notify 5); the resolved issue staff-notes-stale-page-overwrite.md:15-17
  ("no contact SSE event") is superseded by S2.9 - no edit (s2-notify 6);
  the D3 tenant-retype double contact.updated (s2-notify 1, handled by OR-5).
- S3 report: S3.4 Step 6's check grep also prints Edit C's new line
  (s3-readers 2); W5 - the first line of defense is
  app/src/services/extraction/apply.ts:535-540 (status suggestions only for
  an onboarding tenant, always 'searching'), the 409 and the allowlist are
  the backstop (s3-readers 4); W4 - the full writer list in
  s3-readers-findings.md item 5.
- S4 report: S4.4 Step 2's change-and-back case fails at its FIRST assertion
  (`expected 'needs_review' to be 'interested'`, ContactEditForm.tsx:290-291)
  - still a valid RED (s4 3); S4.4 Step 3j's grep does not print
  `let updated: Contact = contact;` (s4 4); the frozen-base form's status
  write after a concurrent re-type is validated only by the route's own read
  (AR4 covers the route's read-to-write window), same class as today - not a
  regression (s4 5).
- S1 report (and the handback, for the planner): the importer keeps a
  preserved status while it re-types (app/src/lib/import/apply.ts:1150-1154,
  :1173-1174, :1226-1231), so it can still store (landlord, inactive) or
  (unknown, active); spec section 3 scopes the importer gap out and no
  existing issue names this pair shape - a planner call whether to append it
  to docs/issues/import-bypasses-contact-type-rules.md (invariant-sweep 3).
