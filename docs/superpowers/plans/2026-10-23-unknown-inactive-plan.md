# Implementation plan - Inactive for every contact type (tracker #30)

- Spec (the contract - read it in full before Task S1.1):
  `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` (revision 3,
  APPROVED by Cameron 2026-10-23). Decisions are cited D1-D10; "spec section
  N" means its numbered sections 1-6.
- Branch `feat/unknown-inactive`, worktree `W:\tmp\unknown-inactive`, cut from
  main @916258ae. Mission records:
  `docs/superpowers/reviews/2026-10-23-unknown-inactive/`.
- Spec review: 2 rounds -
  `docs/superpowers/reviews/2026-10-23-unknown-inactive/design-review/adjudications.md`.
- Status: PLAN v1 DRAFT (2026-10-23), before plan review. Sections 0-4 are
  BINDING and written by the planner; slice sections 5-10 are opus section
  drafts assembled verbatim. Section 4 (planner rulings AR1-AR14) wins over
  any slice text it contradicts. "Plan section N" always means this file's
  top-level sections 0-11.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case.
- Setup, once, before S1: the worktree has NO `node_modules`. Run `npm ci`
  at the worktree root (bare; expect exit 0). Never symlink another
  worktree's node_modules. No new dependency is added by this plan.
- Commits: a separate bare `git status` read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\unknown-inactive\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name). Use repeated `-m` arguments, or a message
  file OUTSIDE the worktree.
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for a new file;
  for a pre-existing file that already carries non-ASCII (statusModel.ts,
  statusTransition.ts, contacts.ts, inbox.ts and many dashboard files carry
  em dashes, arrows and section signs), only ADDED lines must be ASCII:
  `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints 0. The existing timeline label `Status \u2192 <label>` is an
  ESCAPE in source (ASCII bytes) and stays exactly as written.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - after any
  edit near `\u2192`, verify with `grep -n 'u2192' FILE` that the source
  still holds the six-character escape, not a literal arrow.
- Run app tests from `app/` with `npx vitest run test/<file>`, dashboard
  tests from `dashboard/` with `npx vitest run src/<path>`, e2e only through
  the e2e workspace (`npm run e2e`, or `npm run e2e:session` + the
  Playwright MCP). Never pipe a test or gate command. Every app vitest run,
  even a pure file, needs DynamoDB Local (`npm run db:start` STARTS it;
  never RESTART the shared container - it wipes local data; ask the human).
  `ALLOW_SKIP_DYNAMO_TESTS=1` is allowed ONLY for a pure-file red/green
  step, never for a gate.
- Never touch the live stack (`:5174` / `:8080`).
- Never edit dashboard/app source while this worktree's e2e suite runs (it
  serves the source live). Never commit during it.
- Line numbers are hints against main @916258ae; the QUOTED text is the
  anchor. Where an earlier task changed a region, re-read the current text
  and apply the change ON TOP of it - never revert an earlier task.
- Slice reports: `docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S<n>-report.md`,
  ASCII, findings only (what the tree held that the plan got wrong, risks,
  untrimmed input paths), citing code by `file:line`. A slice with nothing
  to report writes one line saying so. Commit it with explicit paths when
  the slice ends.
- Code blocks under list bullets carry the bullet's indent in this file.
  Strip that indent before using a block as an Edit anchor or as
  replacement text; the target file's own indentation is the authority.

## 1. Global constraints (from the spec; the spec wins on any doubt)

- D1 status lists, exactly, in dropdown order:
  - tenant: needs_review, onboarding, searching, placing, placed, on_hold,
    inactive (UNCHANGED)
  - landlord: needs_review, interested, onboarding, active, parked
    (UNCHANGED; Parked is the landlord's own status and behaves as today)
  - partner and team_member: needs_review, active, inactive
  - unknown: needs_review, inactive (`active` REMOVED)
  - Labels: "Needs review", "Active", "Inactive".
- Every Inactive rule keys on the literal `inactive`. None touches `parked`.
- D2: the contact page header dropdown renders for EVERY live type with that
  type's D1 list and writes through `PATCH /api/contacts/:id/tenant-status`.
  No reason prompt. A soft-deleted contact keeps the display-only badge. The
  route's write is conditional on the stored type being unchanged; a
  mismatch is a 409 that writes nothing. Every successful status change
  through the route notifies open Today and Inbox pages (AR3).
- D3: the edit form's Status options are exactly the D1 list for the shown
  type. A type change is measured against the STORED type at save time.
  On a type change the field moves to the new type's first step (tenant
  onboarding, landlord interested, partner active, team_member active,
  unknown needs_review). Save paths: tenant and landlord with no type change
  are UNCHANGED (landlord park_reason must survive); partner, team_member and
  unknown with no type change send a status change through the transition
  route; any type change goes through the PATCH, with a tenant target
  followed by `setTenantStatus` ONLY when the shown status is not
  onboarding.
- D4.1: `isEligibleRecipient` drops any contact whose status is `inactive`,
  whatever its type. Placed stays tenant-only.
- D4.4: one muted status colour for `inactive` on every type.
- D4.5: a status-change timeline entry reads `Status -> <label>` (source
  keeps the `\u2192` escape) using the label map of the type the contact has
  AFTER the write.
- D5: in the Today unread COLLECT loop, beside the deleted-contact skip and
  BEFORE the 100-row cap, skip an `unknown_1to1` thread whose owning contact's
  status is `inactive`. Nothing else in Today changes.
- D6: (unknown, active) is refused on every writer with that path's existing
  response; an unknown create with no status defaults to needs_review (both
  `contacts.ts` create and `unmatchedEmail.ts`).
- D7: a type change with no explicit status: tenant -> onboarding, landlord ->
  interested, partner -> active (unchanged); FROM `inactive`, team_member ->
  active and unknown -> needs_review. BOTH the auto-advance and the normalize
  fallback run only when `newType !== stored.type`; a same-type PATCH never
  changes the status.
- D8: the unknown contact page card reads "Needs triage" only while the
  contact is needs_review; for an Inactive one it reads "Type unknown". Mark
  as buttons stay; body copy unchanged.
- D9: `needsTriage` is false for a contact whose status is `inactive`
  (contactless number rows unchanged). An Inactive contact's inbox row, any
  type, any tab, carries a muted "Inactive" tag. Server Unknown-tab block
  order: needs_review, then inactive. Dashboard, Unknown tab only: loaded
  rows sorted needs_review first, then inactive, each newest message first.
  Other tabs keep newest-first. The 2026-08-26 "LEAVE IT" ruling comment at
  `routes/inbox.ts:2282-2309` and its partner in `useInbox.ts` are updated to
  cite Cameron's 2026-10-23 supersession.
- No inbound text or call writer moves an EXISTING contact's status (proved
  by test). AI extraction and suggestions are NOT suppressed for Inactive.
- Automatic texts (tour reminders, group rosters, missed-call auto-text,
  placement nudges, hand-picked share recipients) are NOT changed.
- No Terraform, no GSI, no deploy, no data write against dev or prod.

## 2. Work map (build order; each slice ends with its report and commit)

| Slice | Scope | Depends on |
|---|---|---|
| S1 | Backend status model and contact writers: statusModel lists/labels/`statusLabelFor`, contacts.ts (create default, triage union, list read, auto-advance + normalize guard, D7 inactive first steps, timeline label), unmatchedEmail default, import apply/reviewNotes, caseworkerConversion label, suggestion accept test, partition fake, seeds (performance, history), contactsRepo comment | - |
| S2 | Transition route and live notify: conditional write + 409, per-type label, the `contact.updated` event end to end (events.ts, SSE route, bridge check, dashboard EventStreamProvider + types), emit from the transition and the contact PATCH, Today/Inbox/contact page refetch on it | S1 |
| S3 | Backend readers: listingSendOutcome (D4.1), today.ts collect-loop skip (D5), unknownQueue block order, inbox.ts `needsTriage` + `inactive` wire field + ruling comment, inbound no-reset tests | S1 |
| S4 | Dashboard contact page: status mirror in api/types.ts + cross-workspace mirror test, header dropdown for every type, ContactEditForm (options, type-change default, save paths), format/StatusBadge/Card/ContactsList labels and tone, UnknownFile card title | S1, S2 |
| S5 | Dashboard inbox: `inactive` on the wire type, InboxRow Inactive tag, triage chip, Unknown-tab sort, useInbox comment | S3 |
| S6 | e2e spec (spec test 8), docs (STATUS-MODEL.md, GLOSSARY.md), Today fallback watch check | S1-S5 |
| S7 | Final: one main sync, the five bare gates, gate report | S1-S6 |

## 3. Watch items (each is checked and the result recorded in a slice report)

- W1 #31 overlap. As of 2026-10-23 no #31 branch, worktree or spec exists
  (`git branch -a`, `git worktree list`). Re-check at S3 start and at S7; if
  a #31 branch now touches `app/src/routes/today.ts`, read its PLAN (not its
  commits) and record the overlap in the S3/S7 report. Do not change course
  without the planner.
- W2 `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md`:
  re-read its reopen trigger at S3; record whether a needs_review -> inactive
  flip mid-walk now meets it. File nothing new without the planner.
- W3 Dashboard Today fallback (`dashboard/src/routes/today/buildToday.ts:287`):
  record in S6 when that fallback runs. It is NOT changed.
- W4 Inbound writers must not reset status: `contactCapture.ts`,
  `groupMembers.ts`, `groupConvert.ts`, `routes/public.ts`, the Twilio text
  and voice webhooks. Proved by the S3 inbound tests; any writer found that
  DOES touch an existing contact's status is a STOP-and-report.
- W5 `services/audienceResolution.ts` and `jobs/extraction.ts`: unchanged.
  Record that extraction's status pass-through cannot make the AI propose
  `active` for an unknown contact land (the accept path refuses it, D6).
- W6 Lean seed byte-stability: no existing e2e spec may change behavior
  because of a seed edit. `lean.ts`, `cast.ts`, `live.ts`, `matrix.ts` are
  check-only; S1 records any (unknown, active) they create.
- W7 Rollout (planner and human, NOT the builder): re-count (unknown, active)
  on dev and prod just before deploy; any found move only on Cameron's go.

## 4. Planner rulings (binding; win over slice text)

- AR1 Backend constants (`app/src/lib/statusModel.ts`). `NON_TENANT_STATUSES`
  is REMOVED and every consumer migrated. New exports:
  - `PARTNER_STATUSES = ['needs_review', 'active', 'inactive'] as const`
    (partner AND team_member) with `type PartnerStatus` and
    `PARTNER_STATUS_LABELS`.
  - `UNKNOWN_STATUSES = ['needs_review', 'inactive'] as const` with
    `type UnknownStatus` and `UNKNOWN_STATUS_LABELS`.
  - `statusAllowlistFor(type)`: tenant -> TENANT_STATUSES, landlord ->
    LANDLORD_STATUSES, unknown -> UNKNOWN_STATUSES, anything else ->
    PARTNER_STATUSES.
  - `statusLabelFor(type: string | undefined, status: string): string` -
    the label from that type's map (same branching as the allowlist), else
    the raw status. It replaces BOTH private label pickers
    (`contacts.ts` timeline label and `services/statusTransition.ts`
    `contactStatusLabel`).
  statusModel.ts stays IMPORT-FREE (the dashboard mirror test imports it).
- AR2 Dashboard mirror (`dashboard/src/api/types.ts`, beside
  TENANT_STATUSES/LANDLORD_STATUSES): the same four new constants and two
  label maps with the same names, plus `statusOptionsFor(type: string):
  { value: string; label: string }[]` and `contactStatusLabelFor(type, status)`.
  Every dashboard status list and label comes from these (ContactEditForm's
  private lists are deleted). Cross-workspace drift guard:
  `dashboard/src/routes/contact/contactStatusMirror.test.ts`, built like
  `caseworkerRoleMirror.test.ts` (imports `../../../../app/src/lib/statusModel.js`,
  a leaf module - verified it has no imports), comparing each type's list,
  order and labels.
- AR3 Notify event. A NEW ID-only event `contact.updated` with payload
  `{ contactId: string }` (no PII). Added to `AppEventMap` and
  `ALL_APP_EVENTS` (`app/src/lib/events.ts`), forwarded by the SSE route in
  `app/src/routes/api.ts` (on + off, like `suggestion.updated`), and
  listened for in `dashboard/src/api/EventStreamProvider.tsx` as
  `onContactUpdated`. Emitted (a) by `setTenantStatus` after the write, the
  audit and the activity, on EVERY successful call; (b) by the contact
  `PATCH /api/contacts/:id` when the patch changed `status` or `type`.
  Subscribers: `useToday` and `useInbox` call their existing
  `scheduleRefetch`; the contact page's contact hook refetches when the
  event's `contactId` is the open contact. The cross-process bridge
  (`lib/eventBridge.ts`, `routes/internal.ts`) iterates `APP_EVENT_NAMES`;
  S2 confirms it needs no change and says so in its report.
- AR4 Conditional transition write. `SetTenantStatusInput` gains
  `expectedType?: ContactType`; the route passes `stored.type`.
  `setTenantStatus` writes with
  `contactsRepo.update(contactId, plan.patch, { expect: { attr: 'type', value: input.expectedType ?? contact.type } })`.
  On `ConditionalCheckFailedException` it re-reads with
  `{ consistentRead: true }`: gone -> `EntityNotFoundError` (404 as today);
  present -> a new `ContactTypeChangedError`, which `handleTransitionError`
  maps to `409 { error: 'contact_type_changed' }`. Nothing is audited,
  timelined or emitted on that path.
- AR5 Inbox wire field. `InboxRow` gains `inactive?: boolean`, PRESENT and
  `true` ONLY on a contact row whose contact's status is `inactive`
  (the `deleted?: boolean` convention). On contact rows
  `needsTriage: role === 'unknown' && contact.status !== 'inactive'`.
  Contactless number rows (`inbox.ts` ~1175 and ~1566) keep
  `needsTriage: true` and never carry `inactive`. Relay and group rows
  unchanged.
- AR6 Unknown-tab sort. One exported pure comparator in
  `dashboard/src/routes/inbox/inboxListMerge.ts`:
  `compareUnknownTabRows(a, b)` = rows without `inactive` before rows with
  it, then `lastActivityAt` descending (ties keep the existing tie-break of
  the newest-first sort). `useInbox` uses it instead of the newest-first
  sort when the active filter is `unknown`, and ONLY then.
- AR7 Copy. Inbox tag text: `Inactive`. Unknown card title: `Type unknown`.
  The tag uses a muted style next to the existing `Needs triage` /
  `Deleted` chips in `InboxRow.tsx`.
- AR8 Today skip, placed immediately after the deleted-contact `continue`:
  an `unknown_1to1` conversation whose `oneToOneContactId(conv)` resolves
  through the SAME memoized `getContact` to a contact with
  `status === 'inactive'` is skipped (`continue`) before `unreadRowKeys` and
  before the cap. A thread with no resolvable contact keeps today's
  behavior.
- AR9 Header dropdown. `ContactDetail.tsx` renders the existing `StatusMenu`
  for every non-deleted contact with `statusOptionsFor(contact.type)`, and
  calls the same endpoint function the tenant/landlord menu calls today with
  the same `source`. A `409 contact_type_changed` shows the page's existing
  error surface and refetches the contact. The tenant/landlord behavior is
  unchanged.
- AR10 D7 code shape (contacts.ts). The auto-advance branch and the
  normalize fallback are both guarded by `newType !== stored.type`. The
  inactive first-step rule for team_member/unknown lives in the normalize
  branch: when the type changes, no explicit status is sent and
  `stored.status === 'inactive'`, the status becomes `active` for
  team_member and `needs_review` for unknown. The tenant, landlord and
  partner auto-advance values are unchanged.
- AR11 Same-type PATCH regression: the guard in AR10 also fixes
  `{ type: 'tenant' }` on a Searching tenant writing onboarding. Spec test 3
  names it; it is a real RED case.
- AR12 e2e: one new spec file; it builds its own state (an unknown contact
  via the hermetic stack's normal create or inbound path) and does not add
  a lean-seed contact unless the S6 draft shows that is impossible, in which
  case the S6 report says why.
- AR13 Docs: `documentation/STATUS-MODEL.md` gains a section for partner,
  team_member and unknown statuses and states the D4 meaning of Inactive;
  `documentation/GLOSSARY.md` updates the inactive / "waiting on a reply"
  wording for D4.1. Both in S6.
- AR14 No slice edits `docs/issues/` except to update an existing issue's
  body where a slice changes the behavior it describes (the slice report
  names it); no new issue without the planner.

## 5-10. Slices S1-S6

(Assembled from the section drafts.)

## 11. S7 - final sync and gates

(Assembled from the S6 draft's gate section.)
