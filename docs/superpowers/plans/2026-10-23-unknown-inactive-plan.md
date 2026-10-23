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
  drafts assembled verbatim. Section 4 (planner rulings AR1-AR24) wins over
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
  prints 0. The timeline arrow: `services/statusTransition.ts` writes it as
  the `\u2192` ESCAPE (ASCII bytes), which stays exactly as written;
  `routes/contacts.ts` ~2135 holds a LITERAL arrow, which S1.3 replaces with
  an ASCII-source constant (AR22).
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

Assembly rulings (from the six section drafts; each draft's own
"Contradictions" block is a record of what it found - where it differs
from these, these win):

- AR15 Names across S3 and S5: S5 renames the dashboard's inline
  `sortByActivity` to `sortForFilter` and exports `compareByActivity` and
  `compareUnknownTabRows` from `inboxListMerge.ts`. S3's rewrite of the
  server ruling comment in `app/src/routes/inbox.ts` (~2282-2310) cites
  `sortForFilter` and `compareUnknownTabRows`, never `sortByActivity`.
  The useInbox "partner comment" is the one-line JSDoc at `useInbox.ts:148`,
  which S5.3 replaces.
- AR16 `priorType`: S2.5 declares `const priorType` beside `priorStatus` in
  the contact PATCH handler. If S1.3 introduces a stored-type snapshot of its
  own in that handler, S1.3 names it `priorType` and S2.5 reuses it instead
  of declaring a second one.
- AR17 Fixture flips forced by the block-order change (every commit stays
  green). S1.1 changes `UNKNOWN_QUEUE_STATUS_ORDER` and flips the
  (unknown, active) fixtures it lists in its step 1f
  (`unknownQueue.test.ts`, `inboxUnknownTab.test.ts`,
  `inboxUnknownParity.test.ts`). S1.1 ALSO applies S3.4 Step 5 (the
  `app/test/inbox.integration.test.ts` flip) and adds that file to its
  RED/GREEN commands and its commit. In S3.4: Step 1 becomes a GREEN state
  check (the four files pass on S1's tree); in Steps 2-5 the builder applies
  only edits whose OLD text is still present (an edit S1.1 already made is
  done - skip it) and every NEW test case those steps add. Steps 6-9 run as
  written.
- AR18 Other (unknown, active) fixtures (`followUps.test.ts`,
  `listingSendsApi.test.ts`, `unitsApiActivity.test.ts`, and any other a
  slice did not name) stay unchanged unless they fail. One that fails moves
  to `needs_review`, never `inactive`, and the slice report names it.
- AR19 `ai-run-log.spec.ts` ~66-70 (e2e) creates an unknown contact with no
  status; after S1.2 it is needs_review, not active. S1.2 records in the S1
  report whether anything that spec asserts depends on it; S6.1 re-runs it as
  a pin.
- AR20 The header dropdown's accessible name stays "Contact status" (S4.3);
  the Inactive unknown card title is exactly "Type unknown" (S4.5); the
  inbox tag text is exactly "Inactive" (S5.1). S6.1 selects on these.
- AR21 Contacts list rows for non-tenant types show their type's status
  LABEL as plain text, as those rows do today; no new toned badge there. The
  D4.4 muted tone applies wherever a status badge already renders.
- AR22 `routes/contacts.ts` timeline label: the literal arrow at ~2135 is
  replaced by an ASCII-source constant (`String.fromCharCode(0x2192)`), as
  S1.3 drafts; the rendered text is unchanged.
- AR23 `routes/unmatchedEmail.ts`: it only creates tenant, landlord or
  partner, and an existing test pins unknown -> 400, so spec D6's "duplicate
  default" there is a comment-only change (S1.2), not a behavior change.
- AR24 Edit collisions in `routes/contacts.ts`: S2.5's emit anchors on the
  `'contact triaged'` log call (~2143); S1 must not change that call. S2.5
  re-reads the handler after S1 and anchors on the current text.

## 5. S1 - Backend status model and contact writers

Scope: plan section 2 row S1; rulings AR1, AR10, AR11 (binding). Spec D1,
D4.5, D6, D7. Every line number below is a hint against main @916258ae; the
QUOTED text is the anchor.

Notation used ONLY inside "old text" anchors: this plan is ASCII, so where a
CURRENT file line holds a non-ASCII character the anchor writes it as
`[U+2192]` (right arrow), `[U+00A7]` (section sign) or `[U+2014]` (em dash).
Copy those lines from your own Read of the file into `old_string` (the real
character, not the bracket notation). Replacement text is always ASCII and
never contains these characters.

Test code in this slice NEVER writes the six-character escape `\u2192`: the
Edit/Write tools decode `\u` escapes into a literal arrow. Tests build the
arrow as `String.fromCharCode(0x2192)`, the pattern
`app/test/caseworkerConversion.test.ts:593` already uses.

### Contradictions

C1. Spec D6 / spec test 1 / brief: "the duplicate default in
`unmatchedEmail.ts:455-466` does the same" (unknown create -> needs_review).
The code cannot create an unknown contact there:
`app/src/routes/unmatchedEmail.ts:73` is
`const CREATE_CONTACT_TYPES = ['tenant', 'landlord', 'partner'] as const;`,
the type check at :437-443 400s anything else, and
`app/test/unmatchedEmailRoutes.test.ts` "400s validation: missing/empty name;
type outside tenant|landlord|partner" already pins `{ name: 'Sam', type:
'unknown' }` -> 400. The `: 'active'` arm at :461 is the PARTNER default.
Closest correct alternative (S1.2): no code change in unmatchedEmail.ts; the
comment at :455-458 is corrected to say unknown is not a create type there,
and the existing pin is cited in the slice report. Spec test 1's "both create
paths" is satisfied by the one path that can create an unknown contact.

C2. Plan section 0 says "The existing timeline label `Status \u2192 <label>`
is an ESCAPE in source (ASCII bytes)". True for
`app/src/services/statusTransition.ts:178` and `:285`; FALSE for
`app/src/routes/contacts.ts:2135`, which holds a LITERAL U+2192 (bytes 342 206
222, checked with `od -c`). Rewriting that line keeps a non-ASCII added line
unless the arrow moves out of the source. Closest correct alternative (S1.3):
a module constant `const STATUS_ARROW = String.fromCharCode(0x2192);` (the
`app/src/services/caseworkerConversion.ts:165` pattern) and the label line
becomes ``label: `Status ${STATUS_ARROW} ${statusLabelFor(...)}` `` - same
runtime string, ASCII source, immune to the Edit tool's `\u` decoding.

C3. Brief: "S3 owns the rest of unknownQueue/inbox behavior and its tests".
S1's forced edit to `UNKNOWN_QUEUE_STATUS_ORDER`
(`app/src/lib/unknownQueue.ts:179-182`, guarded by
`satisfies Record<UnknownQueueStatus, number>`: once the type derives from
UNKNOWN_STATUSES, `active` is an excess key and `inactive` a missing key - a
typecheck failure) removes the `(unknown, active)` block. Existing pins that
seed `(unknown, active)` as the second block then go red:
`app/test/unknownQueue.test.ts:46-70, 84-100, 127-145, 150-152, 273-285`,
`app/test/inboxUnknownTab.test.ts:153, 212-214, 345, 678-679, 921-929`,
`app/test/inboxUnknownParity.test.ts:119-124`. S1.1 flips exactly those
fixture values from `active` to `inactive` (listed verbatim in S1.1) so S1
ends green. S3 must NOT redo them; S3 owns every other comment and behavior in
those files (list in "Cross-slice notes").

No other ruling conflicts with the code. AR10 is implementable exactly as
written (S1.3).

### Cross-slice notes (for the planner)

- Names S1 exports from `app/src/lib/statusModel.ts` (S4's mirror test must
  use them verbatim): `PARTNER_STATUSES`, `type PartnerStatus`,
  `PARTNER_STATUS_LABELS`, `UNKNOWN_STATUSES`, `type UnknownStatus`,
  `UNKNOWN_STATUS_LABELS`, `statusAllowlistFor`, `statusLabelFor`.
  `NON_TENANT_STATUSES` no longer exists. statusModel.ts stays import-free.
- `app/src/services/statusTransition.ts` (S2 also edits): S1.4 touches ONLY
  (a) the statusModel import list (lines 17-35: drops `LANDLORD_STATUS_LABELS`
  and `TENANT_STATUS_LABELS`, adds `statusLabelFor`), (b) deletes the private
  `function contactStatusLabel` (lines 150-154), (c) the expression
  `contactStatusLabel(contact.type, toStatus)` on line 178, (d) the expression
  `contactStatusLabel(contactType, to)` on line 285, (e) the one comment line
  630 `// type-keyed label map picks LANDLORD_STATUS_LABELS vs
  TENANT_STATUS_LABELS.` inside setTenantStatus. S2 anchors its setTenantStatus
  edits on the text AFTER S1.4.
- `app/src/routes/contacts.ts` PATCH handler (S2 adds the `contact.updated`
  emit there): S1.3 rewrites the timeline-label block (the `if (typeof
  parsed.patch.status === 'string' && stored && parsed.patch.status !==
  priorStatus) {` block right after `await audit.append(...)`, ~2125-2141) and
  adds `const STATUS_ARROW` above `// --- M1.5 list pagination + cursor`. S2
  anchors after S1.3. S1 adds NO emit.
- `app/test/transitionRoutes.test.ts` (S2 extends): S1.1 inserts one new
  `describe('PATCH /api/contacts/:contactId/tenant-status - non-tenant lists
  (tracker #30, D1/D6)')` directly before
  `describe('PATCH /api/units/:unitId/listing-status'`. It checks only the
  allowlist (400 / 200 + stored status); S2 owns source/audit/label/409/notify.
- `setTenantStatus`'s `toStatus: TenantStatus | LandlordStatus` type is left
  alone (every D1 value is in that union); widening it is S2's call.
- S3 leftovers in files S1 touches (S1 does NOT change them):
  `app/src/lib/unknownQueue.ts` header lines 16-71 (the class-f history that
  names `(unknown, active)`); `app/src/routes/inbox.ts:2022, 2030` (flip
  comments); `app/test/inboxUnknownTab.test.ts:170-175` comment "(needs_review,
  then active)"; `app/test/unknownQueue.test.ts:122` comment "Plus ONE on the
  empty `active` block"; `app/test/contactsPartitionFake.test.ts:96-130`
  (generic sort pin with `active` fixtures - still valid, comment names the old
  pair); reader fixtures that seed `(unknown, active)` directly and still pass
  (`followUps.test.ts:212-213, 385`, `listingSendsApi.test.ts:595, 637-639,
  667`, `unitsApiActivity.test.ts:430-431, 445`).
- Between S1 and S4 the dashboard edit form can still OFFER Active for an
  unknown contact; the server now 400s it. S4 removes the option.
- `docs/issues/*.md` that mention `NON_TENANT_STATUSES`
  (`inbox-filter-tabs-full-walk.md:527`, `landlord-lead-status-and-park.md:20`,
  `unknown-queue-cap-starves-needs-review.md:57`) and the historical review
  records are history; AR14 - S1 does not edit them.

---

### Task S1.1 - Per-type status lists, `statusLabelFor`, and every path that follows the allowlist

Removes `NON_TENANT_STATUSES`, adds the partner/team_member and unknown lists
(AR1), migrates every consumer (compile-forced, one commit), and proves the
allowlist change on every D6 path that validates through it: status-only
PATCH, type+status PATCH, explicit-status create, list read, the transition
route, and the import. Spec test 1.

Files:
- `app/src/lib/statusModel.ts`
- `app/src/routes/contacts.ts` (imports, triage parse union, three comments)
- `app/src/lib/import/apply.ts`, `app/src/lib/import/reviewNotes.ts`,
  `app/src/lib/import/status.ts` (comment)
- `app/src/lib/unknownQueue.ts` (import, type alias, order map, 3 comment
  words - nothing else)
- `app/src/repos/contactsRepo.ts` (comment)
- `app/test/helpers/contactsPartitionFake.ts` (comment)
- Tests: `app/test/statusModel.test.ts`, `app/test/contactsCrud.test.ts`,
  `app/test/contactTriage.test.ts`, `app/test/transitionRoutes.test.ts`,
  `app/test/importApply.integration.test.ts`, `app/test/unknownQueue.test.ts`,
  `app/test/inboxUnknownTab.test.ts`, `app/test/inboxUnknownParity.test.ts`

#### Step 1 - failing tests

1a. `app/test/statusModel.test.ts` - extend the import list. Edit:

old:
```ts
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  LISTING_OVERRIDE_STATES,
```
new:
```ts
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  LISTING_OVERRIDE_STATES,
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  statusAllowlistFor,
  statusLabelFor,
  UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS,
```

Append at the end of the file:
```ts

// Tracker #30 (spec 2026-10-23-unknown-inactive D1): every contact type has
// an Inactive status, and an unknown contact has no Active.
describe('statusModel - per-type contact status lists (D1)', () => {
  it('each type allows exactly its D1 list, in dropdown order', () => {
    expect([...statusAllowlistFor('tenant')]).toEqual([
      'needs_review', 'onboarding', 'searching', 'placing', 'placed', 'on_hold', 'inactive',
    ]);
    expect([...statusAllowlistFor('landlord')]).toEqual([
      'needs_review', 'interested', 'onboarding', 'active', 'parked',
    ]);
    expect([...statusAllowlistFor('partner')]).toEqual(['needs_review', 'active', 'inactive']);
    expect([...statusAllowlistFor('team_member')]).toEqual(['needs_review', 'active', 'inactive']);
    expect([...statusAllowlistFor('unknown')]).toEqual(['needs_review', 'inactive']);
  });

  it('an unknown contact can never be active', () => {
    expect(statusAllowlistFor('unknown')).not.toContain('active');
  });

  it('returns the exported lists themselves - one source of truth', () => {
    expect(statusAllowlistFor('partner')).toBe(PARTNER_STATUSES);
    expect(statusAllowlistFor('team_member')).toBe(PARTNER_STATUSES);
    expect(statusAllowlistFor('unknown')).toBe(UNKNOWN_STATUSES);
    expect(statusAllowlistFor(undefined)).toBe(PARTNER_STATUSES);
  });

  it('the non-tenant label maps are Needs review / Active / Inactive, one label per listed status', () => {
    expect(PARTNER_STATUS_LABELS).toEqual({
      needs_review: 'Needs review',
      active: 'Active',
      inactive: 'Inactive',
    });
    expect(UNKNOWN_STATUS_LABELS).toEqual({ needs_review: 'Needs review', inactive: 'Inactive' });
    expect(Object.keys(PARTNER_STATUS_LABELS)).toEqual([...PARTNER_STATUSES]);
    expect(Object.keys(UNKNOWN_STATUS_LABELS)).toEqual([...UNKNOWN_STATUSES]);
    // (PIN) the landlord map is unchanged.
    expect(Object.keys(LANDLORD_STATUS_LABELS)).toEqual([...LANDLORD_STATUSES]);
  });

  it('statusLabelFor reads the label map of the given type', () => {
    expect(statusLabelFor('tenant', 'on_hold')).toBe('On hold');
    expect(statusLabelFor('landlord', 'interested')).toBe('Interested');
    expect(statusLabelFor('partner', 'active')).toBe('Active');
    expect(statusLabelFor('team_member', 'inactive')).toBe('Inactive');
    expect(statusLabelFor('unknown', 'needs_review')).toBe('Needs review');
    expect(statusLabelFor('unknown', 'inactive')).toBe('Inactive');
  });

  it('statusLabelFor falls back to the raw status when the type has no such status', () => {
    expect(statusLabelFor('unknown', 'active')).toBe('active');
    expect(statusLabelFor('tenant', 'parked')).toBe('parked');
    // An inherited object key is not a label.
    expect(statusLabelFor('partner', 'constructor')).toBe('constructor');
  });
});
```

1b. `app/test/contactsCrud.test.ts` - append at the end of the file:
```ts

// Tracker #30 (D1/D6): the list read and an explicit-status create validate
// against the type's own list - (unknown, active) is refused, Inactive is
// legal for partner, team_member and unknown.
describe('per-type status lists on the list read and the create (tracker #30)', () => {
  it('400s a list read of type=unknown&status=active', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/contacts?type=unknown&status=active')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status must be one of: needs_review, inactive');
  });

  it('lists (unknown, inactive) and (partner, inactive)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-unk-off', type: 'unknown', status: 'inactive' });
    seedContact(world, { contactId: 'c-unk-new', type: 'unknown', status: 'needs_review' });
    seedContact(world, { contactId: 'c-cw-off', type: 'partner', status: 'inactive' });
    const unknowns = await request(app)
      .get('/api/contacts?type=unknown&status=inactive')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(unknowns.status).toBe(200);
    expect(unknowns.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['c-unk-off']);
    const partners = await request(app)
      .get('/api/contacts?type=partner&status=inactive')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(partners.status).toBe(200);
    expect(partners.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['c-cw-off']);
  });

  it('400s a create of (unknown, active) and writes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const before = world.contacts.length;
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'unknown', firstName: 'Una', status: 'active' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status must be one of: needs_review, inactive');
    expect(world.contacts.length).toBe(before);
  });

  for (const type of ['partner', 'team_member', 'unknown'] as const) {
    it(`creates a ${type} with an explicit inactive status`, async () => {
      const { app } = makeWebhookHarness();
      const res = await request(app)
        .post('/api/contacts')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ type, firstName: 'Ina', lastName: 'Off', status: 'inactive' });
      expect(res.status).toBe(201);
      expect(res.body.contact.status).toBe('inactive');
    });
  }
});
```

1c. `app/test/contactTriage.test.ts` - flip the existing allowlist test
(line ~535, title "allowlists status ... (L1)"; it PATCHes the seeded UNKNOWN
contact with `active`, which is no longer an unknown status). Edit:

old:
```ts
      .send({ status: 'active' });
    expect(ok.status).toBe(200);
    expect(ok.body.contact.status).toBe('active');
```
new:
```ts
      .send({ status: 'inactive' });
    // Tracker #30: an unknown contact's statuses are needs_review | inactive.
    expect(ok.status).toBe(200);
    expect(ok.body.contact.status).toBe('inactive');
```
and Edit:

old:
```ts
    expect(world.contacts.find((c) => c.contactId === 'contact-triage-1')?.status).toBe('active');
```
new:
```ts
    expect(world.contacts.find((c) => c.contactId === 'contact-triage-1')?.status).toBe('inactive');
```

Also the partner test comment (line ~178) and its title. Edit:

old:
```ts
  it('setting type=partner propagates -> partner_1to1 and auto-advances to active (a resolved NON_TENANT identity)', async () => {
```
new:
```ts
  it('setting type=partner propagates -> partner_1to1 and auto-advances to active (a resolved partner identity)', async () => {
```
Edit:

old:
```ts
    // partner has NO rich lifecycle (NON_TENANT_STATUSES: needs_review|active);
```
new:
```ts
    // partner has NO rich lifecycle (PARTNER_STATUSES: needs_review|active|inactive);
```

Append at the end of `app/test/contactTriage.test.ts`:
```ts

// Tracker #30 (D1/D6): the contact PATCH validates status against the type's
// own list - against the BODY's type when it carries one, else the STORED
// type. (unknown, active) is refused; Inactive is legal for partner,
// team_member and unknown.
describe('PATCH /api/contacts/:contactId - per-type status lists (tracker #30)', () => {
  type World = ReturnType<typeof makeWebhookHarness>['world'];
  function seedTyped(world: World, contactId: string, type: ContactItem['type'], status: string): void {
    world.contacts.push({
      contactId,
      type,
      status,
      phone: '+15550107901',
      created_at: '2026-06-12T10:00:00.000Z',
    } as ContactItem);
  }
  function patchContact(app: import('express').Express, contactId: string, body: Record<string, unknown>) {
    return request(app)
      .patch(`/api/contacts/${contactId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);
  }

  it('400s a status-only PATCH of active on an unknown contact and writes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    seedTyped(world, 'c-unk', 'unknown', 'needs_review');
    const res = await patchContact(app, 'c-unk', { status: 'active' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status must be one of: needs_review, inactive');
    expect(world.contacts.find((c) => c.contactId === 'c-unk')?.status).toBe('needs_review');
    expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated')).toEqual([]);
  });

  it('400s {type: unknown, status: active} in one body and writes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    seedTyped(world, 'c-ten', 'tenant', 'searching');
    const res = await patchContact(app, 'c-ten', { type: 'unknown', status: 'active' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status must be one of: needs_review, inactive');
    expect(world.contacts.find((c) => c.contactId === 'c-ten')).toMatchObject({
      type: 'tenant',
      status: 'searching',
    });
  });

  for (const [type, from] of [
    ['unknown', 'needs_review'],
    ['partner', 'active'],
    ['team_member', 'active'],
  ] as const) {
    it(`a status-only PATCH moves a ${type} to inactive`, async () => {
      const { app, world } = makeWebhookHarness();
      seedTyped(world, 'c-off', type, from);
      const res = await patchContact(app, 'c-off', { status: 'inactive' });
      expect(res.status).toBe(200);
      expect(res.body.contact.status).toBe('inactive');
      expect(world.contacts.find((c) => c.contactId === 'c-off')?.status).toBe('inactive');
    });
  }
});
```

1d. `app/test/transitionRoutes.test.ts` - insert a describe INSIDE the
top-level `describe('status-model transition routes', ...)` (it uses that
block's `world` and `authedPatch`). Edit:

old:
```ts
  describe('PATCH /api/units/:unitId/listing-status', () => {
```
new:
```ts
  // Tracker #30 (D1/D6): the route validates toStatus against the stored
  // type's list. S1 pins the allowlist only; the write's source, audit,
  // timeline label, 409 and notify are pinned by S2.
  describe('PATCH /api/contacts/:contactId/tenant-status - non-tenant lists (tracker #30, D1/D6)', () => {
    it('REJECTS active for an unknown contact with 400 and writes nothing', async () => {
      await world.contactsRepo.create({ contactId: 'unk-1', type: 'unknown', status: 'needs_review' });
      const res = await authedPatch('/api/contacts/unk-1/tenant-status', { toStatus: 'active', source: 'manual' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('toStatus must be one of: needs_review, inactive');
      expect((await world.contactsRepo.getById('unk-1'))!.status).toBe('needs_review');
    });

    it('accepts inactive for a partner, a team member and an unknown contact', async () => {
      for (const [contactId, type, from] of [
        ['p-1', 'partner', 'active'],
        ['tm-1', 'team_member', 'active'],
        ['unk-2', 'unknown', 'needs_review'],
      ] as const) {
        await world.contactsRepo.create({ contactId, type, status: from });
        const res = await authedPatch(`/api/contacts/${contactId}/tenant-status`, { toStatus: 'inactive', source: 'manual' });
        expect(res.status, type).toBe(200);
        expect(res.body.contact.status, type).toBe('inactive');
        expect((await world.contactsRepo.getById(contactId))!.status, type).toBe('inactive');
      }
    });
  });

  describe('PATCH /api/units/:unitId/listing-status', () => {
```

1e. `app/test/importApply.integration.test.ts` - insert directly after the
"a RETYPED row never stores the old type vocabulary" test. Edit:

old:
```ts
    // Restore the fixture shape for the tests that follow.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
  });

  it('excludes a dropped person and skips their thread', async () => {
```
new:
```ts
    // Restore the fixture shape for the tests that follow.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
  });

  it('a row retyped to unknown never stores active - it lands needs_review with a warning (tracker #30, D6)', async () => {
    // The generated workbook pre-fills the landlord's status ("active"). Active
    // is not an unknown status (UNKNOWN_STATUSES), so the per-type guard must
    // refuse it exactly as it refuses any status illegal for the type.
    const review = cleanReview();
    const row = [...review.contacts.values()].find((r) => r.phone === PHONES.landlord)!;
    row.type = 'unknown';

    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    const item = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.landlord) },
      }),
    );
    expect(item.Item).toMatchObject({ type: 'unknown', status: 'needs_review' });
    expect(report.warnings.some((w) => w.includes('not a legal unknown status'))).toBe(true);

    // Restore the fixture shape for the tests that follow.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
  });

  it('excludes a dropped person and skips their thread', async () => {
```

1f. Fixture flips forced by the order-map change (C3). These are the ONLY
edits S1 makes in these three files.

`app/test/unknownQueue.test.ts`:
- Edit with `replace_all: true`: old `{ status: 'active' }` -> new
  `{ status: 'inactive' }` (exactly 5 occurrences: lines ~49, 88, 89, 128,
  151; the tenant fixture on line ~51 reads `status: 'active' }` after a
  comma and does not match).
- Edit: old `  it('reads the blocks in QUEUE ORDER - needs_review first, active second - and narrows on nothing else', async () => {`
  -> new `  it('reads the blocks in QUEUE ORDER - needs_review first, inactive second - and narrows on nothing else', async () => {`
- Edit: old `    // NON_TENANT_STATUSES at COMPILE time, which is the same array` -> new
  `    // UNKNOWN_STATUSES at COMPILE time, which is the same array`
- Edit: old
  `    expect(UNKNOWN_QUEUE_BLOCKS.map((b) => b.status)).toEqual(['needs_review', 'active']);`
  -> new
  `    expect(UNKNOWN_QUEUE_BLOCKS.map((b) => b.status)).toEqual(['needs_review', 'inactive']);`

`app/test/inboxUnknownTab.test.ts`:
- Edit: old `  status: 'needs_review' | 'active',` -> new `  status: 'needs_review' | 'inactive',`
- Edit with `replace_all: true`: old `', 'active', ` -> new `', 'inactive', `
  (exactly 5 occurrences: the `queueContact('c-a0'|'c-a1'|'c-a2'|'c-r3-broken'|'c-r4', 'active', ...)` calls, lines ~212-214, 678-679).
- Edit (the "honest cursor", block 1 is now the inactive block): old
  `      JSON.stringify({ q: 1, b: 1, k: { type: 'unknown', status: 'active', contactId: 'c-x' } }),`
  -> new
  `      JSON.stringify({ q: 1, b: 1, k: { type: 'unknown', status: 'inactive', contactId: 'c-x' } }),`
  (Leave line ~323 `{ q: 1, b: 0, k: { type: 'unknown', status: 'active', contactId: 'a1' } }`:
  it is a TAMPERED cursor and `active` still contradicts block 0.)
- Edit: old `        { contactId: 'c-new', type: 'unknown', status: 'active', phone: '+15550002601' },`
  -> new `        { contactId: 'c-new', type: 'unknown', status: 'inactive', phone: '+15550002601' },`
- Edit (the backticks are literal characters in the file), shown below this
  list as block N1.

Block N1, old:
```ts
    // NOTE what this does NOT say: c-new is `active` and c-old is
```
Block N1, new:
```ts
    // NOTE what this does NOT say: c-new is `inactive` and c-old is
```

`app/test/inboxUnknownParity.test.ts` - Edit:

old:
```ts
  it('class f: a (type=unknown, status=active) contact is a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-active', type: 'unknown', status: 'active', phone: '+15550001002' }],
```
new:
```ts
  it('class f: a (type=unknown, status=inactive) contact is a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-active', type: 'unknown', status: 'inactive', phone: '+15550001002' }],
```
(The contactId `c-active` and the expectation `['c-active']` stay - renaming
ids is churn.)

#### Step 2 - RED

Needs DynamoDB Local up (`npm run db:start` STARTS it; never restart it).

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/statusModel.test.ts test/contactsCrud.test.ts test/contactTriage.test.ts test/transitionRoutes.test.ts test/importApply.integration.test.ts test/unknownQueue.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts
```
Expected failures, and why:
- statusModel.test.ts: `TypeError: statusLabelFor is not a function`; the
  allowlist cases get `['needs_review', 'active']` for partner/team_member/
  unknown; `PARTNER_STATUSES` / `UNKNOWN_STATUSES` are undefined.
- contactsCrud.test.ts: the list read of (unknown, active) is 200 not 400; the
  (unknown, inactive) list read and the three inactive creates are 400 (old
  list has no `inactive`); the (unknown, active) create is 201.
- contactTriage.test.ts: the flipped L1 test and the three "moves a ... to
  inactive" cases are 400 not 200; the two (unknown, active) refusals are 200.
- transitionRoutes.test.ts: unknown -> active is 200; -> inactive is 400.
- importApply.integration.test.ts: the row stores `status: 'active'`.
- unknownQueue / inboxUnknownTab / inboxUnknownParity: the `inactive` rows are
  never queried (the blocks are still needs_review / active), so row lists,
  walks and the block-status pin fail.
Every other case in those files stays green.

#### Step 3 - implementation

A rule for every comment edit in this slice: a CHANGED line counts as an
added line for the ASCII check, so a line that holds a non-ASCII character is
either left untouched or replaced WHOLE by an ASCII line (old text in bracket
notation). Never edit a substring of such a line.

3a. `app/src/lib/statusModel.ts`. Edit (lines 137-138, both carry non-ASCII;
copy them from your Read):

old:
```ts
// type-scoped lifecycle, NOT a second field [U+2014] see contactsRepo.ContactItem.status
// and STATUS-MODEL.md [U+00A7]5). Non-tenant contacts use needs_review|active instead.
```
new:
```ts
// type-scoped lifecycle, NOT a second field - see contactsRepo.ContactItem.status
// and STATUS-MODEL.md section 5). Other types: PARTNER_STATUSES / UNKNOWN_STATUSES.
```

Edit - replace the whole block from the `/**` above `NON_TENANT_STATUSES`
through the closing `}` of `statusAllowlistFor` (lines 189-208). Old text (two
lines carry non-ASCII; copy them from your Read):
```ts
/**
 * Status allowlist for contact types WITHOUT a lifecycle (team_member/unknown):
 * the simple `needs_review` (auto-capture stub) [U+2192] `active` (resolved). Tenant and
 * landlord have their own richer lifecycles above; see {@link statusAllowlistFor}.
 */
export const NON_TENANT_STATUSES = ['needs_review', 'active'] as const;

/**
 * The single source of truth for the type-scoped status allowlist. A TENANT
 * carries its [U+00A7]5 lifecycle (TENANT_STATUSES); a LANDLORD carries the lead
 * lifecycle (LANDLORD_STATUSES); every other type (team_member/unknown) carries
 * the simple needs_review|active. Used by BOTH status-setting paths (the generic
 * contact PATCH and the `/tenant-status` transition route) so a landlord can
 * never be pushed into a tenant-only state.
 */
export function statusAllowlistFor(type: string | undefined): readonly string[] {
  if (type === 'tenant') return TENANT_STATUSES;
  if (type === 'landlord') return LANDLORD_STATUSES;
  return NON_TENANT_STATUSES;
}
```
new:
```ts
// --- Partner and team_member statuses (type=partner | team_member) ---------
// No rich lifecycle: `needs_review` is the auto-capture/triage front door,
// `active` a resolved contact, `inactive` a contact set aside. Inactive means
// the same thing for EVERY type that has it (tracker #30, spec D4): not chased
// by the Follow up worklist or listing sends, still shown on the Contacts list,
// in the inbox, in search and on its threads. (`partner` is a "caseworker" or
// "partner" in staff copy - documentation/GLOSSARY.md.)
export const PARTNER_STATUSES = ['needs_review', 'active', 'inactive'] as const;

export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const PARTNER_STATUS_LABELS: Readonly<Record<PartnerStatus, string>> = {
  needs_review: 'Needs review',
  active: 'Active',
  inactive: 'Inactive',
};

// --- Unknown-contact statuses (type=unknown) --------------------------------
// An unknown contact is either waiting for review (`needs_review`: the triage
// queue and Today's Needs you now) or set aside without a type (`inactive`).
// There is NO `active` (Cameron, 2026-10-23): every writer validates through
// statusAllowlistFor, so every writer refuses (unknown, active).
export const UNKNOWN_STATUSES = ['needs_review', 'inactive'] as const;

export type UnknownStatus = (typeof UNKNOWN_STATUSES)[number];

export const UNKNOWN_STATUS_LABELS: Readonly<Record<UnknownStatus, string>> = {
  needs_review: 'Needs review',
  inactive: 'Inactive',
};

/**
 * The single source of truth for the type-scoped status allowlist, in dropdown
 * order: tenant -> TENANT_STATUSES, landlord -> LANDLORD_STATUSES, unknown ->
 * UNKNOWN_STATUSES, any other type (partner, team_member) -> PARTNER_STATUSES.
 * Every status writer (create, the contact PATCH, the `/tenant-status`
 * transition route, the AI status accept, the import) and the list read
 * validate against it, so no path stores a pair its type does not allow.
 */
export function statusAllowlistFor(type: string | undefined): readonly string[] {
  if (type === 'tenant') return TENANT_STATUSES;
  if (type === 'landlord') return LANDLORD_STATUSES;
  if (type === 'unknown') return UNKNOWN_STATUSES;
  return PARTNER_STATUSES;
}

/**
 * The display label of `status` on a contact of `type`, from that type's label
 * map (the same branching as {@link statusAllowlistFor}); the raw status when
 * the type has no such status. The ONE label picker for the contact timeline's
 * status entries - never humanize a key at a call site.
 */
export function statusLabelFor(type: string | undefined, status: string): string {
  const labels: Readonly<Record<string, string>> =
    type === 'tenant'
      ? TENANT_STATUS_LABELS
      : type === 'landlord'
        ? LANDLORD_STATUS_LABELS
        : type === 'unknown'
          ? UNKNOWN_STATUS_LABELS
          : PARTNER_STATUS_LABELS;
  return Object.prototype.hasOwnProperty.call(labels, status) ? (labels[status] ?? status) : status;
}
```
statusModel.ts gains no import.

3b. `app/src/routes/contacts.ts`. Edit the statusModel import:

old:
```ts
  LANDLORD_STATUSES,
  NON_TENANT_STATUSES,
  statusAllowlistFor,
```
new:
```ts
  LANDLORD_STATUSES,
  PARTNER_STATUSES,
  statusAllowlistFor,
```
Edit:

old:
```ts
  TERMINAL_STAGES,
} from '../lib/statusModel.js';
```
new:
```ts
  TERMINAL_STAGES,
  UNKNOWN_STATUSES,
} from '../lib/statusModel.js';
```
Edit (triage parse union, ~628):

old:
```ts
      : ([...TENANT_STATUSES, ...LANDLORD_STATUSES, ...NON_TENANT_STATUSES] as readonly string[]);
```
new:
```ts
      : ([...TENANT_STATUSES, ...LANDLORD_STATUSES, ...PARTNER_STATUSES, ...UNKNOWN_STATUSES] as readonly string[]);
```
Edit (comment block ~423-427; lines 423, 425 and 426 carry non-ASCII, copy
them from your Read):

old:
```ts
// The type-scoped status allowlist (a TENANT's [U+00A7]5 lifecycle, a LANDLORD's lead
// lifecycle, else needs_review|active) is centralized in lib/statusModel.ts
// (statusAllowlistFor) so BOTH status-setting paths [U+2014] this generic PATCH and the
// /tenant-status transition route [U+2014] share ONE source of truth. NON_TENANT_STATUSES
// (needs_review|active) is imported for the "no explicit type" fallback union.
```
new:
```ts
// The type-scoped status allowlist (a TENANT's section 5 lifecycle, a LANDLORD's
// lead lifecycle, PARTNER_STATUSES for partner/team_member, UNKNOWN_STATUSES for
// unknown) is centralized in lib/statusModel.ts (statusAllowlistFor) so BOTH
// status-setting paths - this generic PATCH and the /tenant-status transition
// route - share ONE source of truth. The four per-type lists are imported for
// the "no explicit type" fallback union.
```
Edit (list-read comment ~1125-1126; line 1126 carries a section sign):

old:
```ts
      // Type-scoped allowlist (status-model unification): a tenant-typed filter
      // accepts the [U+00A7]5 lifecycle values; other types accept needs_review|active.
```
new:
```ts
      // Type-scoped allowlist (statusAllowlistFor): each type accepts only its
      // own statuses, so type=unknown&status=active is a 400 (tracker #30, D6).
```
Edit (auto-advance comment ~1718):

old:
```ts
    // rich lifecycle - NON_TENANT_STATUSES needs_review|active - so a resolved
```
new:
```ts
    // rich lifecycle - PARTNER_STATUSES needs_review|active|inactive - so a resolved
```

3c. `app/src/lib/import/apply.ts`. Edit:

old:
```ts
import {
  LANDLORD_STATUSES,
  NON_TENANT_STATUSES,
  TENANT_STATUSES,
  type TransitionSource,
} from '../statusModel.js';
```
new:
```ts
import { statusAllowlistFor, type TransitionSource } from '../statusModel.js';
```
Edit (~975-980):

old:
```ts
  const validStatuses: readonly string[] =
    type === 'tenant'
      ? TENANT_STATUSES
      : type === 'landlord'
        ? LANDLORD_STATUSES
        : NON_TENANT_STATUSES;
```
new:
```ts
  // statusAllowlistFor is the ONE per-type list (lib/statusModel.ts), so an
  // (unknown, active) row falls back like any other illegal pair (tracker #30).
  const validStatuses: readonly string[] = statusAllowlistFor(type);
```

3d. `app/src/lib/import/reviewNotes.ts`. Edit:

old:
```ts
import {
  LANDLORD_STATUSES,
  NON_TENANT_STATUSES,
  TENANT_STATUSES,
} from '../statusModel.js';
```
new:
```ts
import {
  LANDLORD_STATUSES,
  PARTNER_STATUSES,
  TENANT_STATUSES,
  UNKNOWN_STATUSES,
} from '../statusModel.js';
```
Edit:

old:
```ts
  ...NON_TENANT_STATUSES,
]);
```
new:
```ts
  ...PARTNER_STATUSES,
  ...UNKNOWN_STATUSES,
]);
```
(No behavior change: `inactive` was already in the union via TENANT_STATUSES.)

3e. `app/src/lib/import/status.ts` (comment only, ~63). Edit:

old:
```ts
  // partner (incl. caseworkers) and team_member have no lifecycle: needs_review | active.
```
new:
```ts
  // partner (incl. caseworkers) and team_member have no lifecycle (PARTNER_STATUSES);
  // the import never derives inactive - setting a contact aside is a staff decision.
```

3f. `app/src/lib/unknownQueue.ts` - ONLY these edits (S3 owns the rest).

Edit: old `import { NON_TENANT_STATUSES } from './statusModel.js';` -> new
`import { UNKNOWN_STATUSES } from './statusModel.js';`

Edit:

old:
```ts
 * The statuses a `type='unknown'` contact may legally carry. Taken from
 * NON_TENANT_STATUSES, which is what `statusAllowlistFor('unknown')` returns -
```
new:
```ts
 * The statuses a `type='unknown'` contact may legally carry. Taken from
 * UNKNOWN_STATUSES, which is what `statusAllowlistFor('unknown')` returns -
```
Edit: old `type UnknownQueueStatus = (typeof NON_TENANT_STATUSES)[number];` -> new
`type UnknownQueueStatus = (typeof UNKNOWN_STATUSES)[number];`

Edit (the backticks are literal characters in the file):

old:
```ts
 * `active` block's first Query is issued.
```
new:
```ts
 * `inactive` block's first Query is issued.
```

Edit:

old:
```ts
export const UNKNOWN_QUEUE_STATUS_ORDER = {
  needs_review: 0,
  active: 1,
} as const satisfies Record<UnknownQueueStatus, number>;
```
new:
```ts
export const UNKNOWN_QUEUE_STATUS_ORDER = {
  needs_review: 0,
  inactive: 1,
} as const satisfies Record<UnknownQueueStatus, number>;
```
Edit: old ` * way: anything that hard-codes "needs_review then active" outside this file`
-> new ` * way: anything that hard-codes "needs_review then inactive" outside this file`

3g. `app/src/repos/contactsRepo.ts` (comment, ~123-124, both lines ASCII). Edit:

old:
```ts
   *   - non-tenant (landlord/team_member/unknown): needs_review | active
   *     (they have no lifecycle).
```
new:
```ts
   *   - landlord: LANDLORD_STATUSES - needs_review/interested/onboarding/
   *     active/parked.
   *   - partner and team_member: PARTNER_STATUSES - needs_review/active/
   *     inactive.
   *   - unknown: UNKNOWN_STATUSES - needs_review/inactive (never active).
   *   statusAllowlistFor (lib/statusModel.ts) is the one source of these lists.
```

3h. `app/test/helpers/contactsPartitionFake.ts` (comment, ~53-57). Edit:

old:
```ts
//      consequential property INEXPRESSIBLE. Within `type='unknown'` the only
//      legal statuses are 'needs_review' and 'active' (NON_TENANT_STATUSES,
//      lib/statusModel.ts:194) and 'active' < 'needs_review' lexicographically,
//      so an UN-NARROWED Query returns EVERY 'active' unknown before ANY
//      'needs_review' one. That is what made the deleted result cap and page
```
new:
```ts
//      consequential property INEXPRESSIBLE. Within `type='unknown'` the only
//      legal statuses are 'needs_review' and 'inactive' (UNKNOWN_STATUSES,
//      lib/statusModel.ts; 'active' until tracker #30, 2026-10-23), and both
//      'active' and 'inactive' sort before 'needs_review', so an UN-NARROWED
//      Query returns EVERY reviewed unknown before ANY 'needs_review' one.
//      That is what made the deleted result cap and page
```

#### Step 4 - GREEN

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/statusModel.test.ts test/contactsCrud.test.ts test/contactTriage.test.ts test/transitionRoutes.test.ts test/importApply.integration.test.ts test/unknownQueue.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/importReviewNotes.test.ts test/contactsPartitionFake.test.ts test/suggestionReclassification.test.ts
```
Expect all green. Then the compile check (bare):
```
cd W:/tmp/unknown-inactive; npm run typecheck
```
Expect exit 0. If typecheck names a file that still imports
`NON_TENANT_STATUSES`, the Step-6 grep below finds it; migrate it the same way
(`statusAllowlistFor(type)` for a per-type check, the four lists for a union)
and record it in the slice report.

#### Step 5 - ASCII check on added lines

```
cd W:/tmp/unknown-inactive; git diff -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```
Expect `0`.

#### Step 6 - commit

```
git -C W:/tmp/unknown-inactive status
ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD"
```
(The `ls` must report "No such file or directory"; in PowerShell use
`Test-Path` and expect `False`.)
```
git -C W:/tmp/unknown-inactive add app/src/lib/statusModel.ts app/src/routes/contacts.ts app/src/lib/import/apply.ts app/src/lib/import/reviewNotes.ts app/src/lib/import/status.ts app/src/lib/unknownQueue.ts app/src/repos/contactsRepo.ts app/test/helpers/contactsPartitionFake.ts app/test/statusModel.test.ts app/test/contactsCrud.test.ts app/test/contactTriage.test.ts app/test/transitionRoutes.test.ts app/test/importApply.integration.test.ts app/test/unknownQueue.test.ts app/test/inboxUnknownTab.test.ts app/test/inboxUnknownParity.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(status): per-type contact status lists - Inactive for every type, no Active for unknown (tracker #30 S1.1)" -m "Replaces NON_TENANT_STATUSES with PARTNER_STATUSES (partner, team_member) and UNKNOWN_STATUSES; adds statusLabelFor. Every allowlist path follows: PATCH, create, list read, transition route, import. Unknown-tab block order is now needs_review then inactive." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S1.2 - Unknown create defaults to Needs review; suggestion accept and unmatched-email pins

Spec D6 defaults; spec test 1 ("an unknown create with no status is Needs
review") and the D6 AI-accept path.

Files:
- `app/src/routes/contacts.ts` (create default + its comment)
- `app/src/routes/unmatchedEmail.ts` (comment only - see C1)
- Tests: `app/test/contactsCrud.test.ts`,
  `app/test/suggestionReclassification.test.ts`

#### Step 1 - failing tests

Append at the end of `app/test/contactsCrud.test.ts`:
```ts

// Tracker #30 (D6): an unknown create with no status is a contact nobody has
// reviewed yet - needs_review, never active.
describe('POST /api/contacts - the unknown create default (tracker #30)', () => {
  it('an unknown create with no status defaults to needs_review', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'unknown', firstName: 'Una', lastName: 'Known' });
    expect(res.status).toBe(201);
    expect(res.body.contact.status).toBe('needs_review');
    expect(world.contacts.find((c) => c.contactId === res.body.contact.contactId)?.status).toBe('needs_review');
  });

  for (const type of ['partner', 'team_member'] as const) {
    it(`(PIN) a ${type} create with no status still defaults to active`, async () => {
      const { app } = makeWebhookHarness();
      const res = await request(app)
        .post('/api/contacts')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ type, firstName: 'Pat', lastName: 'Default' });
      expect(res.status).toBe(201);
      expect(res.body.contact.status).toBe('active');
    });
  }
});
```

Append at the end of `app/test/suggestionReclassification.test.ts`:
```ts

// Tracker #30 (D6): an AI status suggestion of active on an unknown contact is
// refused on the accept path with that path's EXISTING response - status is a
// tenant-only target, so the 409 fires before the type-scoped allowlist.
describe('status accept on an unknown contact (tracker #30, D6)', () => {
  it('(PIN) refuses a status suggestion of active on an unknown contact with 409 suggestion_contact_not_tenant and keeps the chip', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-unk', type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c-unk', target: 'status', suggestedValue: 'active', conversationId: 'conv-unk', runId: 'run-unk-status',
    });
    const emitsBefore = suggestionEmits(world);

    const res = await accept(app, 'c-unk', 'status');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    expect(await world.extractionRepo.getSuggestion('c-unk', 'status')).toBeDefined();
    expect(journalsFor(world, 'c-unk')).toEqual([]);
    expect(contactOf(world, 'c-unk')?.status).toBe('needs_review');
    expect(suggestionEmits(world)).toBe(emitsBefore);
  });
});
```

#### Step 2 - RED

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/contactsCrud.test.ts test/suggestionReclassification.test.ts
```
Expected: "an unknown create with no status defaults to needs_review" fails
(`expected 'active' to be 'needs_review'`). The two partner/team_member PINs
and the suggestion PIN pass (the accept is refused at
`app/src/services/suggestionResolution.ts:819-826` before buildPlan's
allowlist check at :298).

#### Step 3 - implementation

`app/src/routes/contacts.ts`, create default (~1006-1008). Edit:

old:
```ts
  if (item.status === undefined) {
    item.status =
      item.type === 'tenant' ? 'onboarding' : item.type === 'landlord' ? 'interested' : 'active';
  }
```
new:
```ts
  if (item.status === undefined) {
    item.status =
      item.type === 'tenant'
        ? 'onboarding'
        : item.type === 'landlord'
          ? 'interested'
          : item.type === 'unknown'
            ? 'needs_review'
            : 'active';
  }
```
Edit (comment ~997, ASCII line):

old:
```ts
  //   - other (team_member/unknown) -> 'active' (unchanged: no lifecycle).
```
new:
```ts
  //   - unknown -> 'needs_review': an unknown contact has no 'active'
  //     (UNKNOWN_STATUSES, tracker #30); a create without a type is a contact
  //     nobody has reviewed yet.
  //   - other (partner/team_member) -> 'active' (unchanged: no lifecycle).
```

`app/src/routes/unmatchedEmail.ts` (~455-458, comment only; the code on :461
is unchanged - C1). Edit:

old:
```ts
    // default the manual-create route applies (tenant -> onboarding,
    // landlord -> interested, else active).
```
new:
```ts
    // default the manual-create route applies (tenant -> onboarding,
    // landlord -> interested, partner -> active). `unknown` is not a create
    // type here (CREATE_CONTACT_TYPES), so this path never mints an unknown
    // contact; the manual-create route defaults one to needs_review
    // (tracker #30, D6).
```

#### Step 4 - GREEN

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/contactsCrud.test.ts test/suggestionReclassification.test.ts test/unmatchedEmailRoutes.test.ts test/contactTriage.test.ts
```
All green (unmatchedEmailRoutes.test.ts "400s validation ... type outside
tenant|landlord|partner" is the existing pin that no unknown is created
there).

#### Step 5 - ASCII check and commit

```
cd W:/tmp/unknown-inactive; git diff -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
git -C W:/tmp/unknown-inactive status
ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD"
git -C W:/tmp/unknown-inactive add app/src/routes/contacts.ts app/src/routes/unmatchedEmail.ts app/test/contactsCrud.test.ts app/test/suggestionReclassification.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(contacts): an unknown create with no status defaults to needs_review (tracker #30 S1.2)" -m "Pins: partner/team_member still default to active; an AI status suggestion of active on an unknown contact stays a 409 suggestion_contact_not_tenant; unmatched email cannot create an unknown contact." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(ASCII count `0`; MERGE_HEAD absent.)

---

### Task S1.3 - Type change from Inactive, same-type PATCH, timeline label by the new type

AR10 + AR11 exactly; spec D7 and D4.5; spec test 3 (contact PATCH part).

Files:
- `app/src/routes/contacts.ts` (statusModel import, `STATUS_ARROW`,
  auto-advance guard, normalize guard + inactive first step, timeline label)
- Test: `app/test/contactTriage.test.ts`

#### Step 1 - failing tests

Append at the end of `app/test/contactTriage.test.ts`:
```ts

// Tracker #30 (D7, AR10, AR11): a type change with no explicit status FROM
// Inactive starts the new type's first step; both the auto-advance and the
// normalize fallback run only on a REAL type change, so a same-type PATCH
// never moves the status. D4.5: the status milestone is labelled by the type
// the contact has AFTER the write.
describe('PATCH /api/contacts/:contactId - type change from Inactive and same-type PATCH (tracker #30)', () => {
  const ARROW = String.fromCharCode(0x2192);
  type World = ReturnType<typeof makeWebhookHarness>['world'];
  function seedD7(world: World, over: Partial<ContactItem>): void {
    world.contacts.push({
      contactId: 'c-d7',
      type: 'tenant',
      status: 'inactive',
      phone: '+15550107801',
      created_at: '2026-06-12T10:00:00.000Z',
      ...over,
    } as ContactItem);
  }
  function patchD7(app: import('express').Express, body: Record<string, unknown>) {
    return request(app)
      .patch('/api/contacts/c-d7')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);
  }
  const storedD7 = (world: World) => world.contacts.find((c) => c.contactId === 'c-d7');
  const statusMilestones = (world: World) =>
    world.activityEvents.filter((e) => e.type === 'contact_status_changed').map((e) => e.label);

  // [from type, to type, expected status, already true before this task]
  const FROM_INACTIVE = [
    ['tenant', 'landlord', 'interested', true],
    ['tenant', 'partner', 'active', true],
    ['tenant', 'team_member', 'active', false],
    ['tenant', 'unknown', 'needs_review', false],
    ['unknown', 'tenant', 'onboarding', true],
    ['unknown', 'landlord', 'interested', true],
    ['unknown', 'partner', 'active', true],
    ['unknown', 'team_member', 'active', false],
    ['partner', 'team_member', 'active', false],
    ['partner', 'unknown', 'needs_review', false],
    ['team_member', 'partner', 'active', true],
    ['team_member', 'unknown', 'needs_review', false],
  ] as const;
  for (const [from, to, expected, pin] of FROM_INACTIVE) {
    it(`${pin ? '(PIN) ' : ''}an Inactive ${from} re-typed to ${to} with no status starts at ${expected}`, async () => {
      const { app, world } = makeWebhookHarness();
      seedD7(world, { type: from, status: 'inactive' });
      const res = await patchD7(app, { type: to });
      expect(res.status).toBe(200);
      expect(res.body.contact).toMatchObject({ type: to, status: expected });
      expect(storedD7(world)?.status).toBe(expected);
    });
  }

  // From a non-Inactive status: today's behavior, unchanged.
  for (const [from, fromStatus, to, expected] of [
    ['partner', 'active', 'team_member', 'active'],
    ['partner', 'needs_review', 'team_member', 'needs_review'],
    ['team_member', 'active', 'unknown', 'needs_review'],
    ['tenant', 'placing', 'unknown', 'needs_review'],
  ] as const) {
    it(`(PIN) a ${fromStatus} ${from} re-typed to ${to} with no status lands ${expected}`, async () => {
      const { app, world } = makeWebhookHarness();
      seedD7(world, { type: from, status: fromStatus });
      const res = await patchD7(app, { type: to });
      expect(res.status).toBe(200);
      expect(res.body.contact).toMatchObject({ type: to, status: expected });
    });
  }

  it('a same-type PATCH on a Searching tenant leaves the status alone - no status write, no milestone', async () => {
    const { app, world } = makeWebhookHarness();
    seedD7(world, { type: 'tenant', status: 'searching' });
    const res = await patchD7(app, { type: 'tenant' });
    expect(res.status).toBe(200);
    expect(res.body.contact.status).toBe('searching');
    expect(storedD7(world)?.status).toBe('searching');
    expect(statusMilestones(world)).toEqual([]);
    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    expect(audit?.payload?.['fields']).toEqual(['type']);
  });

  it('a same-type PATCH on an Inactive partner leaves it Inactive', async () => {
    const { app, world } = makeWebhookHarness();
    seedD7(world, { type: 'partner', status: 'inactive' });
    const res = await patchD7(app, { type: 'partner' });
    expect(res.status).toBe(200);
    expect(storedD7(world)?.status).toBe('inactive');
    expect(statusMilestones(world)).toEqual([]);
  });

  it('a role-only switch inside one type (an Active landlord to Property Manager) keeps Active', async () => {
    const { app, world } = makeWebhookHarness();
    seedD7(world, { type: 'landlord', status: 'active' });
    const res = await patchD7(app, { type: 'landlord', role: 'Property Manager' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ type: 'landlord', role: 'Property Manager', status: 'active' });
    expect(statusMilestones(world)).toEqual([]);
  });

  for (const type of ['unknown', 'team_member'] as const) {
    it(`(guard) a same-type PATCH on an Inactive ${type} leaves it Inactive`, async () => {
      // Green before this task (inactive is already legal for the type); it
      // goes red if the D7 first-step rule is implemented without the
      // newType !== stored.type guard.
      const { app, world } = makeWebhookHarness();
      seedD7(world, { type, status: 'inactive' });
      const res = await patchD7(app, { type });
      expect(res.status).toBe(200);
      expect(storedD7(world)?.status).toBe('inactive');
    });
  }

  it('labels the milestone with the NEW type: an unknown re-typed to partner reads "Status -> Active"', async () => {
    const { app, world } = makeWebhookHarness();
    seedD7(world, { type: 'unknown', status: 'needs_review' });
    await patchD7(app, { type: 'partner' }).expect(200);
    expect(statusMilestones(world)).toEqual([`Status ${ARROW} Active`]);
  });

  it('labels a tenant re-typed to landlord "Status -> Interested"', async () => {
    const { app, world } = makeWebhookHarness();
    seedD7(world, { type: 'tenant', status: 'onboarding' });
    await patchD7(app, { type: 'landlord' }).expect(200);
    expect(statusMilestones(world)).toEqual([`Status ${ARROW} Interested`]);
  });

  it('(PIN) labels an Inactive tenant re-typed to unknown "Status -> Needs review"', async () => {
    const { app, world } = makeWebhookHarness();
    seedD7(world, { type: 'tenant', status: 'inactive' });
    await patchD7(app, { type: 'unknown' }).expect(200);
    expect(statusMilestones(world)).toEqual([`Status ${ARROW} Needs review`]);
  });
});
```

#### Step 2 - RED

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/contactTriage.test.ts
```
Expected failures, and why (after S1.1, `inactive` is legal for team_member
and unknown, so the normalize fallback KEEPS it):
- the six non-PIN "an Inactive X re-typed to Y" cases: status stays
  `inactive` instead of `active` / `needs_review`;
- the Searching tenant same-type case: status `onboarding`, a "Status ->
  Onboarding" milestone, fields `['type', 'status']` (today's unguarded
  auto-advance);
- the Inactive partner same-type case: status `active`;
- the Property Manager case: status `interested`;
- the unknown -> partner label: `Status -> active` (raw key - the stored type
  `unknown` picked the TENANT map, which has no `active`);
- the tenant -> landlord label: `Status -> interested` (same reason).
The PIN and (guard) cases pass.

#### Step 3 - implementation (all in `app/src/routes/contacts.ts`)

3a. statusModel import. Edit:

old:
```ts
import {
  LANDLORD_STATUS_LABELS,
  LANDLORD_STATUSES,
  PARTNER_STATUSES,
  statusAllowlistFor,
  TENANT_STATUS_LABELS,
  TENANT_STATUSES,
  TERMINAL_STAGES,
  UNKNOWN_STATUSES,
} from '../lib/statusModel.js';
```
new:
```ts
import {
  LANDLORD_STATUSES,
  PARTNER_STATUSES,
  statusAllowlistFor,
  statusLabelFor,
  TENANT_STATUSES,
  TERMINAL_STAGES,
  UNKNOWN_STATUSES,
} from '../lib/statusModel.js';
```

3b. The arrow constant. Edit:

old:
```ts
// --- M1.5 list pagination + cursor -----------------------------------------
```
new:
```ts
/** U+2192 (right arrow) for status milestones, built from its code point so this source stays ASCII. */
const STATUS_ARROW = String.fromCharCode(0x2192);

// --- M1.5 list pagination + cursor -----------------------------------------
```

3c. Auto-advance guard (AR10). Edit:

old:
```ts
    // fabricate a name to do it.
    if (convType !== undefined && !('status' in parsed.patch)) {
```
new:
```ts
    // fabricate a name to do it. ONLY on a REAL type change (tracker #30 D7,
    // AR11): a same-type PATCH - `{type: 'tenant'}` from a stale edit form on a
    // Searching tenant, or a role-only switch inside one type - never moves
    // the status.
    if (convType !== undefined && !('status' in parsed.patch) && newType !== stored?.type) {
```

3d. Normalize guard + the Inactive first step (AR10). Edit:

old:
```ts
      if (!statusAllowlistFor(newType).includes(stored.status ?? '')) {
        parsed.patch['status'] =
          newType === 'unknown'
```
new:
```ts
      // Tracker #30 D7 (AR10): only on a REAL type change. FROM inactive the new
      // type starts at its first step - team_member -> 'active', unknown ->
      // 'needs_review', which is exactly the default mapping below - even though
      // inactive is legal for both. Any other stored status is kept when it is
      // legal for the new type (today's behavior).
      if (
        newType !== stored.type
        && (stored.status === 'inactive' || !statusAllowlistFor(newType).includes(stored.status ?? ''))
      ) {
        parsed.patch['status'] =
          newType === 'unknown'
```
(The mapping lines below it and the `parsed.changedFields.push('status');`
are unchanged.)

3e. Timeline label by the type after the write (D4.5; C2). Edit - the old
text's label line holds a literal U+2192, copy it from your Read:

old:
```ts
    if (typeof parsed.patch.status === 'string' && stored && parsed.patch.status !== priorStatus) {
      const labels = stored.type === 'landlord' ? LANDLORD_STATUS_LABELS : TENANT_STATUS_LABELS;
      try {
        await activityEvents.record({
          contactId,
          type: 'contact_status_changed',
          label: `Status [U+2192] ${(labels as Record<string, string>)[parsed.patch.status] ?? parsed.patch.status}`,
        });
```
new:
```ts
    if (typeof parsed.patch.status === 'string' && stored && parsed.patch.status !== priorStatus) {
      // Tracker #30 D4.5: labelled by the type the contact has AFTER this write
      // (on a re-type, the NEW type's label map).
      const labelType = isContactType(newType) ? newType : stored.type;
      try {
        await activityEvents.record({
          contactId,
          type: 'contact_status_changed',
          label: `Status ${STATUS_ARROW} ${statusLabelFor(labelType, parsed.patch.status)}`,
        });
```
After this edit, `grep -n 'STATUS_ARROW' W:/tmp/unknown-inactive/app/src/routes/contacts.ts`
shows exactly two lines (the constant and the label), and
`cd W:/tmp/unknown-inactive; git diff -U0 -- app/src/routes/contacts.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
prints `0`.

#### Step 4 - GREEN

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/contactTriage.test.ts test/contactsCrud.test.ts test/contactTypeChangeRefusals.test.ts test/contactEmailReaders.test.ts test/aiRunVerdicts.test.ts test/contactStaffNotes.test.ts test/landlordRequirementsPatch.test.ts
```
All green (the neighbours are the other suites that PATCH `type`). Then:
```
cd W:/tmp/unknown-inactive; npm run typecheck
```
Exit 0.

#### Step 5 - ASCII check and commit

```
cd W:/tmp/unknown-inactive; git diff -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
git -C W:/tmp/unknown-inactive status
ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD"
git -C W:/tmp/unknown-inactive add app/src/routes/contacts.ts app/test/contactTriage.test.ts
git -C W:/tmp/unknown-inactive commit -m "fix(contacts): a type change from Inactive starts the new type's first step; a same-type PATCH never moves the status (tracker #30 S1.3)" -m "Both the auto-advance and the normalize fallback now run only when the type changes. The status milestone is labelled by the type after the write." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S1.4 - One label picker: the transition plan and the caseworker conversion use `statusLabelFor`

AR1 (`statusLabelFor` replaces `contactStatusLabel`); D4.5; spec test 3's
"caseworker conversion -> Active" from Inactive.

Files:
- `app/src/services/statusTransition.ts` (ONLY the lines listed in
  "Cross-slice notes")
- `app/src/services/caseworkerConversion.ts` (import, the milestone label,
  its comment)
- Tests: `app/test/statusTransition.test.ts`,
  `app/test/caseworkerConversion.test.ts`

#### Step 1 - failing tests

Append at the end of `app/test/statusTransition.test.ts`:
```ts

// Tracker #30 (D4.5): the status milestone reads the label map of the
// contact's own type - a partner or team member moving to active reads
// "Active", not the raw key the tenant map used to fall back to.
describe('contact status semantic plan - labels by type (tracker #30)', () => {
  it('labels each type from its own map', () => {
    const arrow = String.fromCharCode(0x2192);
    const cases = [
      [{ type: 'partner', status: 'needs_review' }, 'active', 'Active'],
      [{ type: 'team_member', status: 'needs_review' }, 'active', 'Active'],
      [{ type: 'team_member', status: 'active' }, 'inactive', 'Inactive'],
      [{ type: 'unknown', status: 'needs_review' }, 'inactive', 'Inactive'],
      [{ type: 'landlord', status: 'needs_review' }, 'interested', 'Interested'],
      [{ type: 'tenant', status: 'onboarding' }, 'on_hold', 'On hold'],
    ] as const;
    for (const [contact, toStatus, label] of cases) {
      const plan = buildContactStatusTransitionPlan(
        { contactId: 'c-plan', created_at: '2026-01-01T00:00:00.000Z', ...contact },
        { toStatus, source: 'manual' },
      );
      expect(plan.activity, `${contact.type} -> ${toStatus}`).toEqual({
        type: 'contact_status_changed',
        label: `Status ${arrow} ${label}`,
      });
    }
  });
});
```

Append at the end of `app/test/caseworkerConversion.test.ts`:
```ts

// Tracker #30 (D7): the conversion still writes Active - from Inactive too -
// and labels its milestone by the NEW type (partner).
describe('make from an Inactive contact (tracker #30)', () => {
  for (const type of ['unknown', 'tenant', 'partner'] as const) {
    it(`(PIN) an Inactive ${type} becomes an Active caseworker with one "Status -> Active" milestone`, async () => {
      const { world, service } = setup();
      seed(world, { type, status: 'inactive' });
      await service.make(ID, { actor: ACTOR });
      expect(stored(world)).toMatchObject({ type: 'partner', role: 'Caseworker', status: 'active' });
      const arrow = String.fromCharCode(0x2192);
      expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed').map((e) => e.label))
        .toEqual([`Status ${arrow} Active`]);
    });
  }
});
```

#### Step 2 - RED

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/statusTransition.test.ts test/caseworkerConversion.test.ts
```
Expected: "labels each type from its own map" fails on the first two cases
(`Status -> active`: the private `contactStatusLabel` used the TENANT map for
every non-landlord type and fell back to the raw key). The other four cases
and the three conversion PINs pass.

#### Step 3 - implementation

`app/src/services/statusTransition.ts`. Edit the import list:

old:
```ts
  isTenantOverrideStatus,
  LANDLORD_STATUS_LABELS,
  STAGE_LABELS,
  TENANT_STATUS_LABELS,
  TERMINAL_STAGES,
```
new:
```ts
  isTenantOverrideStatus,
  STAGE_LABELS,
  statusLabelFor,
  TERMINAL_STAGES,
```
Edit - delete the private picker (old text, then an empty replacement):

old:
```ts
function contactStatusLabel(contactType: string | undefined, status: string): string {
  return (contactType === 'landlord'
    ? (LANDLORD_STATUS_LABELS as Record<string, string>)[status]
    : (TENANT_STATUS_LABELS as Record<string, string>)[status]) ?? status;
}

```
new: (empty string)

Edit: old `contactStatusLabel(contact.type, toStatus)` -> new
`statusLabelFor(contact.type, toStatus)`

Edit: old `contactStatusLabel(contactType, to)` -> new
`statusLabelFor(contactType, to)`

Edit (comment inside setTenantStatus, ~630):

old:
```ts
      // type-keyed label map picks LANDLORD_STATUS_LABELS vs TENANT_STATUS_LABELS.
```
new:
```ts
      // label comes from statusLabelFor(contact.type, ...) (lib/statusModel.ts).
```
Neither expression edit includes the `\u2192` escape, so the Edit tool does
not decode it. Verify it survived:
`grep -c 'u2192' W:/tmp/unknown-inactive/app/src/services/statusTransition.ts`
prints `2`.

`app/src/services/caseworkerConversion.ts`. Edit:

old:
```ts
import { isCaseworker, type PossibleSignal } from '../lib/caseworkers.js';
```
new:
```ts
import { isCaseworker, type PossibleSignal } from '../lib/caseworkers.js';
import { statusLabelFor } from '../lib/statusModel.js';
```
Edit:

old:
```ts
    // R1-F12: labelled by the NEW type (partner -> "Active"); the PATCH's own
    // milestone keeps labelling by the stored type.
    if (!ctx.repair && ctx.priorStatus !== 'active') {
      try {
        await activityEvents.record({ contactId, type: 'contact_status_changed', label: `Status ${ARROW} Active` });
```
new:
```ts
    // R1-F12: labelled by the NEW type (partner -> "Active"), as the contact
    // PATCH's own milestone is since tracker #30 (D4.5).
    if (!ctx.repair && ctx.priorStatus !== 'active') {
      try {
        await activityEvents.record({
          contactId,
          type: 'contact_status_changed',
          label: `Status ${ARROW} ${statusLabelFor('partner', 'active')}`,
        });
```
(The conversion patch's `status: 'active'` at ~531 is unchanged, per D7.)

#### Step 4 - GREEN

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/statusTransition.test.ts test/caseworkerConversion.test.ts test/transitionRoutes.test.ts test/suggestionResolutionRecovery.test.ts test/deriveTenantStatusSkip.test.ts test/caseworkerReviewApi.test.ts
```
All green. Then:
```
cd W:/tmp/unknown-inactive; npm run typecheck
```
Exit 0.

#### Step 5 - ASCII check and commit

```
cd W:/tmp/unknown-inactive; git diff -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
git -C W:/tmp/unknown-inactive status
ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD"
git -C W:/tmp/unknown-inactive add app/src/services/statusTransition.ts app/src/services/caseworkerConversion.ts app/test/statusTransition.test.ts app/test/caseworkerConversion.test.ts
git -C W:/tmp/unknown-inactive commit -m "refactor(status): one status label picker - statusLabelFor in the transition plan and the caseworker conversion (tracker #30 S1.4)" -m "A partner or team member moved to active now reads Status -> Active, not the raw key." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S1.5 - Seeds: no (unknown, active); Inactive is a branch from Needs review

Spec section 4 Seeds; W6.

Files:
- `app/src/lib/seed/performance.ts`
- `app/src/lib/seed/history.ts`
- Tests: `app/test/performanceSeed.test.ts`, `app/test/seedHistory.test.ts`,
  `app/test/seedContactTypeInvariants.test.ts`
- Check-only (NO edit): `app/src/lib/seed/lean.ts`, `cast.ts`, `live.ts`,
  `matrix.ts`

#### Step 1 - failing tests

Append at the end of `app/test/performanceSeed.test.ts`:
```ts

// Tracker #30 (D1): an unknown contact has no active status, so the generator
// alternates the two statuses an unknown contact CAN hold. 300 contacts makes
// 3 unknowns (resolvedContactTypeCounts: floor(300 / 100)).
describe('performance seed unknown contacts (tracker #30)', () => {
  it('alternates needs_review / inactive and never seeds an active unknown', () => {
    const { tables } = generatePerformanceSeed(resolvePerformanceSeedConfig(zeroWorld({ contacts: 300 }), ANCHOR));
    const unknowns = tables.contacts.filter((row) => row.type === 'unknown');
    expect(unknowns.map((row) => row.status)).toEqual(['needs_review', 'inactive', 'needs_review']);
  });
});
```

Append at the end of `app/test/seedHistory.test.ts`:
```ts

// Tracker #30 (D1): Inactive is a BRANCH off Needs review for partner,
// team_member and unknown - the seeded trail never passes through Active, which
// an unknown contact can no longer hold.
describe('seed history - non-tenant Inactive trails (tracker #30)', () => {
  const trail = (contact: Record<string, unknown>) =>
    standaloneContactHistory({ contactId: 'c-hist', created_at: '2026-06-01T00:00:00.000Z', ...contact })
      .map((row) => [row.payload['from'], row.payload['to']]);

  it.each(['partner', 'team_member', 'unknown'])('an Inactive %s branches straight from needs_review', (type) => {
    expect(trail({ type, status: 'inactive' })).toEqual([['needs_review', 'inactive']]);
  });

  it.each(['partner', 'team_member'])('(PIN) an Active %s keeps its needs_review -> active trail', (type) => {
    expect(trail({ type, status: 'active' })).toEqual([['needs_review', 'active']]);
  });

  it('an (unknown, active) contact - no longer a legal pair - gets no trail', () => {
    expect(trail({ type: 'unknown', status: 'active' })).toEqual([]);
  });

  it.each(['partner', 'team_member', 'unknown'])('(PIN) a needs_review %s gets no trail', (type) => {
    expect(trail({ type, status: 'needs_review' })).toEqual([]);
  });
});
```

`app/test/seedContactTypeInvariants.test.ts` - add the import. Edit:

old:
```ts
import { isCaseworker } from '../src/lib/caseworkers.js';
```
new:
```ts
import { isCaseworker } from '../src/lib/caseworkers.js';
import { statusAllowlistFor } from '../src/lib/statusModel.js';
```
Append at the end of the file:
```ts

// Tracker #30 (D1). Seeds are raw puts, so no route allowlist runs for them:
// a seed could store a (type, status) pair the app refuses - (unknown, active)
// above all. Checked for the three types whose lists this change touched; the
// extra world generates enough contacts (300 -> 3 unknowns) for the
// performance generator's second unknown to exist.
describe('seeded partner, team_member and unknown statuses are legal for their type (tracker #30)', () => {
  const worlds: Readonly<Record<string, readonly Tables[]>> = {
    ...WORLDS,
    'performance-300-contacts': [SEED, performanceTables({ contacts: 300 })],
  };
  for (const [world, layers] of Object.entries(worlds)) {
    it(`${world}: every partner, team_member and unknown contact holds a status from its own list`, () => {
      const illegal: string[] = [];
      let checked = 0;
      for (const [id, contact] of byId(layers, 'contacts', 'contactId')) {
        const type = String(contact['type']);
        if (type !== 'partner' && type !== 'team_member' && type !== 'unknown') continue;
        const status = contact['status'];
        if (status === undefined) continue;
        checked += 1;
        if (typeof status !== 'string' || !statusAllowlistFor(type).includes(status)) {
          illegal.push(`contacts ${id}: (${type}, ${String(status)})`);
        }
      }
      expect(illegal, `${world} illegal pairs`).toEqual([]);
      // Not vacuous: every world carries at least the lean partner.
      expect(checked, `${world} contacts checked`).toBeGreaterThan(0);
    });
  }
});
```

#### Step 2 - RED

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/performanceSeed.test.ts test/seedHistory.test.ts test/seedContactTypeInvariants.test.ts
```
Expected failures, and why:
- performanceSeed: `['needs_review', 'active', 'needs_review']`
  (performance.ts:552-556 alternates needs_review / active).
- seedHistory: the three Inactive cases return `[]` (`OTHER_LINEAR` has no
  `inactive` and there are no non-tenant overrides, history.ts:216, 460-464);
  the (unknown, active) case returns `[['needs_review', 'active']]`.
- seedContactTypeInvariants: `performance-300-contacts` reports
  `contacts perf-contact-00298: (unknown, active)` (300 contacts = 285
  tenants, 12 landlords, 3 unknowns at indexes 297-299; index 298 is unknown
  ordinal 1, the `active` one). The other worlds pass.
The PIN cases pass.

#### Step 3 - implementation

`app/src/lib/seed/performance.ts` (~552-556). Edit:

old:
```ts
        : ordinal % 2 === 0
          ? 'needs_review'
          : 'active';
```
new:
```ts
        : ordinal % 2 === 0
          ? 'needs_review'
          // unknown alternates the two statuses it can hold (UNKNOWN_STATUSES, tracker #30).
          : 'inactive';
```

`app/src/lib/seed/history.ts` (~216-220). Edit:

old:
```ts
const OTHER_LINEAR = ['needs_review', 'active'] as const;
const OTHER_STATUS_DURATION_DAYS: Readonly<Record<string, number>> = {
  needs_review: 2,
  active: 0,
};
```
new:
```ts
// partner and team_member walk needs_review -> active; unknown has no active
// (UNKNOWN_STATUSES, tracker #30), so its linear ladder is needs_review alone.
// Inactive is a BRANCH off needs_review for all three: an Inactive contact's
// trail is needs_review -> inactive and never passes through active.
const OTHER_LINEAR = ['needs_review', 'active'] as const;
const UNKNOWN_LINEAR = ['needs_review'] as const;
const OTHER_OVERRIDES: ReadonlySet<string> = new Set(['inactive']);
const OTHER_BRANCH_FROM = 'needs_review';
const OTHER_STATUS_DURATION_DAYS: Readonly<Record<string, number>> = {
  needs_review: 2,
  active: 0,
  inactive: 0,
};
```
Edit (~459-464):

old:
```ts
  } else {
    linear = OTHER_LINEAR;
    overrides = new Set<string>();
    branchFrom = 'needs_review';
    durations = OTHER_STATUS_DURATION_DAYS;
  }
```
new:
```ts
  } else {
    linear = type === 'unknown' ? UNKNOWN_LINEAR : OTHER_LINEAR;
    overrides = OTHER_OVERRIDES;
    branchFrom = OTHER_BRANCH_FROM;
    durations = OTHER_STATUS_DURATION_DAYS;
  }
```
(Line 215's comment above `OTHER_LINEAR` carries a U+2192 and stays as is;
the four new comment lines below it state the current rule.)

Check-only (W6), record in the slice report, edit nothing:
- `lean.ts`: contacts are tenant `placing`, landlord `active`, partner
  `active` (haStaffer), tenant `searching` - no unknown, no team_member, no
  inactive non-tenant. The lean world is untouched; history.ts runs only for
  the full profile, so lean stays byte-stable.
- `cast.ts`: one unknown, `needs_review` (`unknown-texter`, :150-166).
- `matrix.ts`, `live.ts`: tenants and landlords only.
- So the full world's generated audit trails are byte-identical before and
  after this task (no full-world contact is a non-tenant Inactive or an
  (unknown, active)); the existing seedHistory "is byte-stable" pin and the
  e2e lean world are unaffected.

#### Step 4 - GREEN

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/performanceSeed.test.ts test/seedHistory.test.ts test/seedContactTypeInvariants.test.ts test/seedData.test.ts test/seedLive.test.ts test/seedMatrix.test.ts test/performanceSeed.integration.test.ts
```
All green. Then:
```
cd W:/tmp/unknown-inactive; npm run typecheck
```
Exit 0.

#### Step 5 - ASCII check and commit

```
cd W:/tmp/unknown-inactive; git diff -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
git -C W:/tmp/unknown-inactive status
ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD"
git -C W:/tmp/unknown-inactive add app/src/lib/seed/performance.ts app/src/lib/seed/history.ts app/test/performanceSeed.test.ts app/test/seedHistory.test.ts app/test/seedContactTypeInvariants.test.ts
git -C W:/tmp/unknown-inactive commit -m "fix(seed): no (unknown, active) in the performance seed; Inactive is a branch from needs_review in seeded trails (tracker #30 S1.5)" -m "Adds a cross-world check that every seeded partner, team_member and unknown status is legal for its type. Lean is untouched." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S1.6 - Sweep, typecheck, slice report

#### Step 1 - no NON_TENANT_STATUSES left in the app workspace

```
git -C W:/tmp/unknown-inactive grep -n NON_TENANT_STATUSES -- app
```
Expect NO output (exit 1). Any hit is a missed consumer: migrate it as in
S1.1 Step 3, re-run its test file, commit it with explicit paths, and record
it in the report. (Outside `app/`: `dashboard/src/routes/contact/ContactEditForm.tsx`
has its OWN local `NON_TENANT_STATUSES` - S4 deletes it; `docs/issues/` and
`docs/superpowers/reviews/` mentions are history and stay, AR14.)

Also confirm no source writer still defaults an unknown contact to active:
```
git -C W:/tmp/unknown-inactive grep -n "'active'" -- app/src/routes/contacts.ts app/src/routes/unmatchedEmail.ts app/src/services/caseworkerConversion.ts
```
Read each hit: the only `'active'` values left are the landlord/partner/
team_member arms (create default, auto-advance, normalize mapping), the
unmatched-email partner default, and the conversion's partner write.

#### Step 2 - typecheck (bare)

```
cd W:/tmp/unknown-inactive; npm run typecheck
```
Exit 0.

#### Step 3 - the app workspace, once

```
cd W:/tmp/unknown-inactive/app; npx vitest run
```
Needs DynamoDB Local. Expect green. If any file is red, follow AGENTS.md
re-run-and-compare: re-run that FILE alone more than once
(`cd W:/tmp/unknown-inactive/app; npx vitest run test/<file>`). A file that
stays red and that this slice touched, or that exercises a path this slice
changed (contact PATCH/create, status lists, unknown queue, seeds), is this
slice's bug: fix it in a follow-up commit with explicit paths. A file that
stays red and has no connection to this slice: do NOT create another worktree
or move HEAD to test the merge base - stop and record the file, the failing
case and the error in the report for the planner.
Any `[dynamoAdmin]` line in the output is a real container fault: capture
`err.$metadata.httpStatusCode` and `attempts` into the report.

#### Step 4 - ASCII check across the slice

```
cd W:/tmp/unknown-inactive; git diff -U0 916258ae -- app | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
grep -c 'u2192' W:/tmp/unknown-inactive/app/src/services/statusTransition.ts
```
Expect `0`, then `2`.

#### Step 5 - slice report

Write `W:/tmp/unknown-inactive/docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S1-report.md`
(ASCII, findings only, code cited by `file:line`). It must record at least:
- C1 (unmatched email cannot create an unknown contact - `unmatchedEmail.ts:73`,
  pinned by `unmatchedEmailRoutes.test.ts`), C2 (the literal arrow in
  `contacts.ts` and the `STATUS_ARROW` constant), C3 (the fixture flips made in
  `unknownQueue.test.ts`, `inboxUnknownTab.test.ts`, `inboxUnknownParity.test.ts`
  and what S3 still owns there).
- W6: the check-only result for `lean.ts`, `cast.ts`, `live.ts`, `matrix.ts`
  (no (unknown, active); lean byte-stable; the only offender was
  `performance.ts`, now fixed).
- The D6 path table: status-only PATCH 400, type+status PATCH 400,
  explicit create 400, list read 400, transition route 400, AI status accept
  409 `suggestion_contact_not_tenant` (unchanged, `suggestionResolution.ts:819-826`),
  import falls back to needs_review with a warning, unmatched email N/A.
- Any extra consumer found in Step 1 and any red file from Step 3.
- Untrimmed input paths: none new (status values are fixed keys, D10).

Commit:
```
git -C W:/tmp/unknown-inactive status
ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD"
git -C W:/tmp/unknown-inactive add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S1-report.md
git -C W:/tmp/unknown-inactive commit -m "docs(records): unknown-inactive S1 slice report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### S1 coverage

Spec section 4 surfaces covered:
- `app/src/lib/statusModel.ts` - lists, labels, `statusAllowlistFor`,
  `statusLabelFor` (S1.1).
- `app/src/routes/contacts.ts` - create explicit status (S1.1), the unknown
  default (S1.2), triage parse union (S1.1), status-only PATCH (S1.1),
  auto-advance + normalize guard and D7 (S1.3), list-read validation (S1.1),
  timeline label (S1.3).
- `app/src/routes/unmatchedEmail.ts` - checked; no unknown create exists (C1,
  S1.2 comment).
- `app/src/services/statusTransition.ts` - the label picker only (S1.4); the
  route/conditional write/notify are S2.
- `app/src/services/caseworkerConversion.ts` - Active unchanged, label by the
  new type (S1.4).
- `app/src/services/suggestionResolution.ts` - follows the allowlist; accept
  refusal pinned (S1.2).
- `app/src/lib/import/apply.ts`, `status.ts`, `reviewNotes.ts` (S1.1).
- Seeds: `performance.ts`, `history.ts` changed; `cast.ts`, `lean.ts`,
  `live.ts`, `matrix.ts` checked (S1.5).
- Test fakes: `app/test/helpers/contactsPartitionFake.ts` (S1.1, comment).
- Readers: `app/src/lib/unknownQueue.ts` status type and block order only
  (S1.1; the rest is S3).
- Docs: `app/src/repos/contactsRepo.ts` status comment (S1.1).

Spec section 5 tests covered:
- Test 1 in full: each type's list is exactly D1 (S1.1 statusModel.test.ts);
  (unknown, active) refused on every D6 path with that path's response (S1.1
  PATCH / create / list read / transition route / import, S1.2 AI accept);
  an unknown create with no status is Needs review (S1.2; the second create
  path cannot create an unknown contact - C1).
- Test 3 in full: from Inactive, tenant -> Onboarding, landlord ->
  Interested, partner -> Active, team_member -> Active, unknown -> Needs review
  (S1.3), caseworker conversion -> Active (S1.4); from a non-Inactive legal
  status unchanged (S1.3); same-type PATCH on a Searching tenant and an
  Inactive unknown unchanged (S1.3); the timeline label uses the new type
  (S1.3, S1.4).
- Test 2 (transition route) only its allowlist half (S1.1 transitionRoutes);
  the rest is S2.



## 6. S2 - Transition route and live notify (rulings AR3, AR4; spec D2, test 2)

Depends on S1 (the allowlists and `statusLabelFor`). S1 has already replaced
the private `contactStatusLabel` in `app/src/services/statusTransition.ts`
with `statusLabelFor`; S2 does not touch any label code. Re-read every quoted
anchor before editing: where S1 changed a region, apply S2's change on top.

Files S2 touches (and nothing else):

- `app/src/lib/events.ts` (new event)
- `app/src/routes/api.ts` (SSE route import + on/off only)
- `app/src/services/statusTransition.ts` (error class, input field, the
  conditional write and the emit inside `setTenantStatus`, two imports)
- `app/src/routes/statusTransition.ts` (route passes `expectedType`, the 409
  mapping, one stale comment line)
- `app/src/routes/contacts.ts` (one snapshot line after `priorStatus` at
  ~1631, one emit block after the `'contact triaged'` log at ~2141-2144)
- `dashboard/src/api/types.ts` (one interface after `SuggestionUpdatedEvent`)
- `dashboard/src/api/EventStreamProvider.tsx`
- `dashboard/src/routes/today/useToday.ts`
- `dashboard/src/routes/inbox/useInbox.ts` (the ONE line
  `useEventStream({ onConversationUpdated: scheduleRefetch });` at ~563 only;
  S5 owns the rest of this file)
- `dashboard/src/routes/contact/useContact.ts`
- Tests: `app/test/eventBridge.test.ts`, `app/test/internalRoute.test.ts`,
  `app/test/sse.test.ts`, `app/test/statusTransition.test.ts`,
  `app/test/transitionRoutes.test.ts`, `app/test/contactTriage.test.ts`,
  `dashboard/src/api/useEventStream.test.tsx`,
  `dashboard/src/routes/today/useToday.test.tsx`,
  `dashboard/src/routes/inbox/useInbox.test.tsx`,
  `dashboard/src/routes/contact/useContact.test.tsx`

### Contradictions and clarifications (read before S2.1)

No ruling is contradicted. Four clarifications the builder needs:

C1. There is no shared "is this a conditional-check failure" helper in
`app/src`. Every caller tests `err instanceof ConditionalCheckFailedException`
imported from `@aws-sdk/client-dynamodb`, services included
(`app/src/services/caseworkerConversion.ts:12` and `:552-557` - the same
"conditional write failed -> consistent re-read -> gone is 404, present is
409" shape AR4 asks for). S2.3 reuses exactly that idiom. The repo contract
is `app/src/repos/contactsRepo.ts:717-734` (`UpdateContactOptions.expect`; a
lost guard throws ConditionalCheckFailedException exactly like a missing
contact) and the harness fake mirrors it
(`app/test/helpers/twilioWebhookHarness.ts:2439-2453`).

C2. The bridge needs NO code change, verified: `app/src/lib/eventBridge.ts:45`
subscribes `for (const name of APP_EVENT_NAMES)` and
`app/src/routes/internal.ts:34` validates against
`new Set(APP_EVENT_NAMES)`; `APP_EVENT_NAMES` is built from `ALL_APP_EVENTS`
(`app/src/lib/events.ts:318-331`), which is `Record<AppEventName, true>`, so
adding the event to `AppEventMap` without `ALL_APP_EVENTS` is a compile
error. One TEST must change: `app/test/eventBridge.test.ts:43` hard-codes
`expect(APP_EVENT_NAMES).toHaveLength(9)`; it becomes 10 (S2.1).

C3. The SSE route's listeners are hand-written per event
(`app/src/routes/api.ts:2748-2765` on, `:2790-2798` off) - nothing in the
type system catches a missing one, which is why S2.2 extends the
disconnect-cleanup test (`app/test/sse.test.ts:192-229`) and adds a forward
test.

C4. Do NOT add `contact.updated` to the harness recorder
(`app/test/helpers/twilioWebhookHarness.ts:616-623`). Existing tests assert
`world.emitted` by EXACT equality after a contact PATCH
(`app/test/contactTriage.test.ts:85-96`, `app/test/sse.test.ts:364-387`);
recording the new event there would turn those red for a reason unrelated to
their subject. Every S2 test subscribes its own listener with
`world.events.on('contact.updated', ...)`.

### Task S2.1 - the `contact.updated` event (events.ts)

Files: `app/src/lib/events.ts`, `app/test/eventBridge.test.ts`,
`app/test/internalRoute.test.ts`.

Step 1 - failing tests.

Edit `app/test/eventBridge.test.ts`. Current text:

```ts
    // 9 = the 8 pre-manual-trigger events + ai_run.completed (manual-extraction-trigger 4.4b).
    expect(APP_EVENT_NAMES).toHaveLength(9);
```

Replacement:

```ts
    // 10 = the 8 pre-manual-trigger events + ai_run.completed (manual-extraction-trigger 4.4b)
    // + contact.updated (unknown-inactive ruling AR3).
    expect(APP_EVENT_NAMES).toHaveLength(10);
    expect(APP_EVENT_NAMES).toContain('contact.updated');
```

Edit `app/test/internalRoute.test.ts`. Current text (end of the last test):

```ts
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ contactId: 'c-204' }]);
  });
```

Replacement:

```ts
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ contactId: 'c-204' }]);
  });

  // unknown-inactive ruling AR3: the route validates names against
  // APP_EVENT_NAMES, so a new event crosses the bridge with no route change.
  it('accepts and re-emits contact.updated (the bridge needs no per-event code)', async () => {
    const { app, events } = makeApp();
    const seen: unknown[] = [];
    events.on('contact.updated', (p) => seen.push(p));
    const res = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .set('x-bridge-token', TOKEN)
      .send({ name: 'contact.updated', payload: { contactId: 'c-bridge' } });
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ contactId: 'c-bridge' }]);
  });
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/eventBridge.test.ts test/internalRoute.test.ts
```

Expected: `eventBridge.test.ts` "subscribes exactly one listener per
AppEventMap name" fails `expected [...] to have a length of 10 but got 9`;
`internalRoute.test.ts` new case fails `expected 400 to be 204` (the name is
not in APP_EVENT_NAMES yet).

Step 3 - implementation in `app/src/lib/events.ts`.

Edit A. Current text:

```ts
export interface UnmatchedEmailUpdatedEvent {
  unmatchedId?: string;
}
```

Replacement:

```ts
export interface UnmatchedEmailUpdatedEvent {
  unmatchedId?: string;
}

/**
 * A contact's status or type changed (unknown-inactive spec D2, ruling AR3).
 * Emitted by the status transition (services/statusTransition.ts
 * setTenantStatus - every successful call, the header dropdown's path) and by
 * PATCH /api/contacts/:contactId when that PATCH changed `status` or `type`
 * (the edit form's path). The Today page and the inbox refetch on it; the
 * contact page re-reads the contact when `contactId` is the one it shows. It
 * exists because the conversation.updated emits cover only linked threads
 * that flipped type or carry a name, so an unnamed or threadless contact got
 * no event at all. ID-only - NEVER a name, phone or status value (PII, doc
 * section 9); consumers re-read.
 */
export interface ContactUpdatedEvent {
  contactId: string;
}
```

Edit B. Current text:

```ts
  'unmatched_email.updated': UnmatchedEmailUpdatedEvent;
  'ai_run.completed': AiRunCompletedEvent;
}
```

Replacement:

```ts
  'unmatched_email.updated': UnmatchedEmailUpdatedEvent;
  'ai_run.completed': AiRunCompletedEvent;
  'contact.updated': ContactUpdatedEvent;
}
```

Edit C. Current text:

```ts
  'unmatched_email.updated': true,
  'ai_run.completed': true,
};
```

Replacement:

```ts
  'unmatched_email.updated': true,
  'ai_run.completed': true,
  'contact.updated': true,
};
```

No change to `app/src/lib/eventBridge.ts` or `app/src/routes/internal.ts`
(C2). Record that in the S2 report.

Step 4 - GREEN: the same command as Step 2; both files pass.

Step 5 - commit (plan section 0: bare `git status` first, MERGE_HEAD check):

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/lib/events.ts app/test/eventBridge.test.ts app/test/internalRoute.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(events): add the ID-only contact.updated event (unknown-inactive AR3)" -m "The bridge and the internal route iterate APP_EVENT_NAMES, so neither changes." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.2 - forward `contact.updated` on the SSE stream (api.ts)

Files: `app/src/routes/api.ts`, `app/test/sse.test.ts`.

Step 1 - failing tests in `app/test/sse.test.ts`.

Edit A (a new forward test). Current text:

```ts
    await client.waitFor('event: ai_run.completed');
    expect(client.received()).toContain(`data: ${JSON.stringify(payload)}`);
  });
```

Replacement:

```ts
    await client.waitFor('event: ai_run.completed');
    expect(client.received()).toContain(`data: ${JSON.stringify(payload)}`);
  });

  it('forwards contact.updated frames (the Today / inbox / contact page live path)', async () => {
    // unknown-inactive ruling AR3. Registration is hand-written per event in
    // the SSE route, so only this test catches a missing one.
    const { app, world } = makeWebhookHarness();
    const port = await startServer(app);
    const client = await connectSse(port);
    await client.waitFor(': connected');

    world.events.emit('contact.updated', { contactId: 'c-sse-1' });

    await client.waitFor('event: contact.updated');
    expect(client.received()).toContain(`data: ${JSON.stringify({ contactId: 'c-sse-1' })}`);
  });
```

Edit B (disconnect cleanup, baseline). Current text:

```ts
    const aiRunBaseline = world.events.listenerCount('ai_run.completed');
```

Replacement:

```ts
    const aiRunBaseline = world.events.listenerCount('ai_run.completed');
    // contact.updated is not recorded by the harness either (unknown-inactive
    // keeps it out of world.emitted), so it carries its own baseline too.
    const contactUpdatedBaseline = world.events.listenerCount('contact.updated');
```

Edit C. Current text:

```ts
    expect(world.events.listenerCount('ai_run.completed')).toBe(aiRunBaseline + 1);
```

Replacement:

```ts
    expect(world.events.listenerCount('ai_run.completed')).toBe(aiRunBaseline + 1);
    expect(world.events.listenerCount('contact.updated')).toBe(contactUpdatedBaseline + 1);
```

Edit D. Current text:

```ts
    expect(world.events.listenerCount('ai_run.completed')).toBe(aiRunBaseline);
```

Replacement:

```ts
    expect(world.events.listenerCount('ai_run.completed')).toBe(aiRunBaseline);
    // A deleted events.off('contact.updated', ...) fails HERE.
    expect(world.events.listenerCount('contact.updated')).toBe(contactUpdatedBaseline);
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/sse.test.ts
```

Expected: the new forward test fails `timed out waiting for "event:
contact.updated"`; "cleans up bus listeners on client disconnect" fails
`expected 0 to be 1` on the `contactUpdatedBaseline + 1` line.

Step 3 - implementation in `app/src/routes/api.ts`.

Edit A (import). Current text:

```ts
  type SuggestionUpdatedEvent,
  type UnmatchedEmailUpdatedEvent,
```

Replacement:

```ts
  type SuggestionUpdatedEvent,
  type ContactUpdatedEvent,
  type UnmatchedEmailUpdatedEvent,
```

Edit B (listener). Current text:

```ts
    const onSuggestionUpdated = (payload: SuggestionUpdatedEvent): void => {
      writeEvent('suggestion.updated', payload);
    };
```

Replacement:

```ts
    const onSuggestionUpdated = (payload: SuggestionUpdatedEvent): void => {
      writeEvent('suggestion.updated', payload);
    };
    const onContactUpdated = (payload: ContactUpdatedEvent): void => {
      writeEvent('contact.updated', payload);
    };
```

Edit C (subscribe). Current text:

```ts
    events.on('suggestion.updated', onSuggestionUpdated);
```

Replacement:

```ts
    events.on('suggestion.updated', onSuggestionUpdated);
    events.on('contact.updated', onContactUpdated);
```

Edit D (unsubscribe, inside the `res.on('close', ...)` handler). Current
text:

```ts
      events.off('suggestion.updated', onSuggestionUpdated);
```

Replacement:

```ts
      events.off('suggestion.updated', onSuggestionUpdated);
      events.off('contact.updated', onContactUpdated);
```

Step 4 - GREEN: the same command as Step 2; the whole file passes.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/routes/api.ts app/test/sse.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(sse): forward contact.updated to dashboard clients (unknown-inactive AR3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.3 - conditional status write, ContactTypeChangedError, emit (service)

Files: `app/src/services/statusTransition.ts`,
`app/test/statusTransition.test.ts`.

Step 1 - failing tests in `app/test/statusTransition.test.ts`.

Edit A (vitest import). Current text:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
```

Replacement:

```ts
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
```

Edit B (service import). Current text:

```ts
  buildContactStatusTransitionPlan,
  createStatusTransitionService,
  EntityNotFoundError,
```

Replacement:

```ts
  buildContactStatusTransitionPlan,
  ContactTypeChangedError,
  createStatusTransitionService,
  EntityNotFoundError,
```

Edit C (new describe). Current text (the end of the
"tenant status (no RTA-in-hand gate ...)" describe):

```ts
    expect(thrown).toBeInstanceOf(StatusTransitionCommittedError);
    expect((thrown as StatusTransitionCommittedError).cause).toBe(cause);
    expect((await world.contactsRepo.getById('t-audit-failure'))?.status).toBe('searching');
  });
});
```

Replacement:

```ts
    expect(thrown).toBeInstanceOf(StatusTransitionCommittedError);
    expect((thrown as StatusTransitionCommittedError).cause).toBe(cause);
    expect((await world.contactsRepo.getById('t-audit-failure'))?.status).toBe('searching');
  });
});

// unknown-inactive spec D2, rulings AR3 + AR4: the status write is conditioned
// on the contact type the caller checked the status against, and every
// successful call emits the ID-only contact.updated.
describe('statusTransition - conditional type write + contact.updated (AR3, AR4)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;
  let notified: unknown[];

  beforeEach(() => {
    world = createFakeWorld();
    svc = makeServiceWithActivity(world);
    notified = [];
    world.events.on('contact.updated', (payload) => notified.push(payload));
  });

  it('writes when the stored type is still the expected one and emits contact.updated { contactId }', async () => {
    await world.contactsRepo.create({ contactId: 'uk-1', type: 'unknown', status: 'needs_review' });
    const updated = await svc.setTenantStatus('uk-1', {
      toStatus: 'inactive',
      source: 'manual',
      expectedType: 'unknown',
    });
    expect(updated.status).toBe('inactive');
    expect(updated.status_source).toBe('manual');
    // ID-only payload: exact equality proves no name/phone/status rides along.
    expect(notified).toEqual([{ contactId: 'uk-1' }]);
  });

  it('a contact re-typed since the caller checked is ContactTypeChangedError: nothing written, audited, timelined or emitted', async () => {
    // The caller validated `inactive` against `unknown`; a concurrent writer
    // has since made the contact a landlord, for whom `inactive` is illegal.
    await world.contactsRepo.create({ contactId: 'uk-2', type: 'landlord', status: 'needs_review' });
    await expect(
      svc.setTenantStatus('uk-2', { toStatus: 'inactive', source: 'manual', expectedType: 'unknown' }),
    ).rejects.toBeInstanceOf(ContactTypeChangedError);
    const stored = await world.contactsRepo.getById('uk-2');
    expect(stored?.type).toBe('landlord');
    expect(stored?.status).toBe('needs_review');
    expect(stored?.status_source).toBeUndefined();
    expect(world.auditEvents.filter((a) => a.entityKey === 'contacts#uk-2')).toEqual([]);
    expect(world.activityEvents.filter((e) => e.contactId === 'uk-2')).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('a contact deleted under the write is EntityNotFoundError (404), not a type change', async () => {
    await world.contactsRepo.create({ contactId: 'uk-3', type: 'unknown', status: 'needs_review' });
    vi.spyOn(world.contactsRepo, 'update').mockImplementationOnce(async () => {
      // The contact vanishes between the setter's read and its conditional
      // write; the real repo answers that with the same conditional error.
      world.contacts.splice(world.contacts.findIndex((c) => c.contactId === 'uk-3'), 1);
      throw new ConditionalCheckFailedException({ message: 'contact gone', $metadata: {} });
    });
    await expect(
      svc.setTenantStatus('uk-3', { toStatus: 'inactive', source: 'manual', expectedType: 'unknown' }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    expect(notified).toEqual([]);
  });

  it('(PIN) without expectedType the write is guarded on the type the setter read - direct callers keep working', async () => {
    await world.contactsRepo.create({ contactId: 't-direct', type: 'tenant', status: 'onboarding' });
    const updated = await svc.setTenantStatus('t-direct', { toStatus: 'searching', source: 'manual' });
    expect(updated.status).toBe('searching');
  });

  it('emits contact.updated on EVERY successful call, a same-status call included', async () => {
    await world.contactsRepo.create({ contactId: 'pt-1', type: 'partner', status: 'active' });
    await svc.setTenantStatus('pt-1', { toStatus: 'active', source: 'manual', expectedType: 'partner' });
    await svc.setTenantStatus('pt-1', { toStatus: 'inactive', source: 'manual', expectedType: 'partner' });
    expect(notified).toEqual([{ contactId: 'pt-1' }, { contactId: 'pt-1' }]);
  });

  it('(PIN) emits nothing when the required audit fails after the write (the call did not succeed)', async () => {
    await world.contactsRepo.create({ contactId: 't-audit-down', type: 'tenant', status: 'onboarding' });
    world.auditRepo.append = async () => { throw new Error('audit down'); };
    await expect(
      svc.setTenantStatus('t-audit-down', { toStatus: 'searching', source: 'manual', expectedType: 'tenant' }),
    ).rejects.toBeInstanceOf(StatusTransitionCommittedError);
    expect(notified).toEqual([]);
  });
});
```

`makeServiceWithActivity` is a function declaration further down the same
file (~959), so it is hoisted and usable here. `world.contacts` is the
harness's backing array (`FakeWorld.contacts`,
`twilioWebhookHarness.ts:284`) that the fake `getById` reads.

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/statusTransition.test.ts
```

Expected failures: "writes when the stored type ..." fails on `notified`
(`expected [] to deeply equal [ { contactId: 'uk-1' } ]`); "re-typed ..."
fails `promise resolved "{...status: 'inactive'...}" instead of rejecting`
(today the setter writes (landlord, inactive)); "deleted under the write"
fails because the raw ConditionalCheckFailedException propagates (`expected
ConditionalCheckFailedException to be an instance of EntityNotFoundError`);
"EVERY successful call" fails on `notified`. The two (PIN) cases pass.

Step 3 - implementation in `app/src/services/statusTransition.ts`.

Edit A (SDK import, top of the import block). Current text:

```ts
import { mergeContext } from '../lib/context.js';
import { toPlacementUpdatedEvent, type EventBus } from '../lib/events.js';
```

Replacement:

```ts
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { mergeContext } from '../lib/context.js';
import { toPlacementUpdatedEvent, type EventBus } from '../lib/events.js';
```

(Precedent for a service importing this SDK error class:
`services/caseworkerConversion.ts:12`. Record it in the S2 report.)

Edit B (contact repo import). Current text:

```ts
import { type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
```

Replacement:

```ts
import { type ContactItem, type ContactsRepo, type ContactType } from '../repos/contactsRepo.js';
```

Edit C (input field). Current text (inside `SetTenantStatusInput`; this
line is unique in the file - the comment above it carries non-ASCII and is
left as it is, so anchor on this line alone):

```ts
  porting?: boolean;
```

Replacement:

```ts
  porting?: boolean;
  /**
   * The contact type the caller validated `toStatus` against (the route
   * passes the stored type it read - unknown-inactive spec D2, ruling AR4).
   * The write is conditioned on the stored type still being this value, so a
   * concurrent re-type can never leave an illegal pair such as
   * (landlord, inactive). A mismatch throws ContactTypeChangedError and
   * writes nothing. Absent: the type this setter itself read is used.
   */
  expectedType?: ContactType;
```

(Only the lines after `porting?: boolean;` are added; they are ASCII.)

Edit D (error class). Current text:

```ts
    super(`${entity} ${id} not found`);
    this.name = 'EntityNotFoundError';
  }
}
```

Replacement:

```ts
    super(`${entity} ${id} not found`);
    this.name = 'EntityNotFoundError';
  }
}

/**
 * The contact's stored type changed between the caller's status check and the
 * conditional status write (unknown-inactive spec D2, ruling AR4). The write
 * was refused, so nothing was written, audited, timelined or emitted. The
 * route maps it to 409 { error: 'contact_type_changed' }. Carries the id only.
 */
export class ContactTypeChangedError extends Error {
  constructor(readonly contactId: string) {
    super(`contact ${contactId} type changed before the status write`);
    this.name = 'ContactTypeChangedError';
  }
}
```

Edit E (the conditional write, inside `setTenantStatus`). Current text:

```ts
      const updated = await contactsRepo.update(contactId, plan.patch);
```

Replacement:

```ts
      // Conditioned on the type the caller validated `toStatus` against
      // (ruling AR4): the route's allowlist check and this write are separate
      // calls, so without the guard a concurrent re-type could store a pair
      // the check never allowed. A lost guard and a missing contact fail the
      // same way; a consistent re-read tells them apart (the
      // caseworkerConversion commit uses the same shape).
      const expectedType = input.expectedType ?? contact.type;
      let updated: ContactItem;
      try {
        updated = await contactsRepo.update(contactId, plan.patch, {
          expect: { attr: 'type', value: expectedType },
        });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          const current = await contactsRepo.getById(contactId, { consistentRead: true });
          if (!current) throw new EntityNotFoundError('contact', contactId);
          log.info(
            { contactId, expectedType, storedType: current.type },
            'tenant status refused: the contact type changed since the check',
          );
          throw new ContactTypeChangedError(contactId);
        }
        throw err;
      }
```

Edit F (the emit). Current text (inside `setTenantStatus`):

```ts
      if (plan.activity !== undefined) await recordStatusActivity(contactId, plan.activity);
      mergeContext({ contactId });
```

Replacement:

```ts
      if (plan.activity !== undefined) await recordStatusActivity(contactId, plan.activity);
      // Live notify (ruling AR3): EVERY successful call, a same-status call
      // included, after the write, the audit and the timeline entry. ID-only.
      // Not on the refused paths above, and not when the audit throws
      // StatusTransitionCommittedError (the call did not succeed).
      events.emit('contact.updated', { contactId });
      mergeContext({ contactId });
```

`events` is already destructured from `deps` at the top of
`createStatusTransitionService`.

Step 4 - GREEN: the same command as Step 2; the whole file passes (the
existing setTenantStatus cases pass no `expectedType` and are unaffected).
Also run the real-DynamoDB integration file, which exercises the real repo's
`expect` clause on `type`:

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/statusTransition.integration.test.ts
```

Expected: green, unchanged.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/services/statusTransition.ts app/test/statusTransition.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(status): condition the status write on the checked type and emit contact.updated (unknown-inactive AR3, AR4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.4 - the route passes expectedType and maps the 409 (spec test 2)

Files: `app/src/routes/statusTransition.ts`,
`app/test/transitionRoutes.test.ts`.

Step 1 - failing tests in `app/test/transitionRoutes.test.ts`.

Edit A. Current text:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
```

Replacement:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
```

Edit B (new describe inside `describe('PATCH /api/contacts/:contactId/tenant-status', ...)`,
after the landlord describe). Current text:

```ts
      it('REJECTS an unknown status for a landlord with 400', async () => {
        expect((await authedPatch('/api/contacts/ll-1/tenant-status', { toStatus: 'bogus', source: 'manual' })).status).toBe(400);
      });
    });
  });
```

Replacement:

```ts
      it('REJECTS an unknown status for a landlord with 400', async () => {
        expect((await authedPatch('/api/contacts/ll-1/tenant-status', { toStatus: 'bogus', source: 'manual' })).status).toBe(400);
      });
    });

    // unknown-inactive spec D2 + section 5 test 2 (rulings AR3, AR4): every
    // contact type moves through this route; the write is conditioned on the
    // type the route's check read; every success notifies open pages.
    describe('every contact type: Inactive, the conditional write, contact.updated', () => {
      let notified: unknown[];

      beforeEach(async () => {
        await world.contactsRepo.create({ contactId: 'pt-1', type: 'partner', status: 'active' });
        await world.contactsRepo.create({ contactId: 'tm-1', type: 'team_member', status: 'active' });
        await world.contactsRepo.create({ contactId: 'uk-1', type: 'unknown', status: 'needs_review' });
        notified = [];
        world.events.on('contact.updated', (payload) => notified.push(payload));
      });

      it('(PIN after S1) accepts inactive for partner, team_member and unknown: status_source manual, the audit, a typed timeline label', async () => {
        const cases = [
          { contactId: 'pt-1', from: 'active' },
          { contactId: 'tm-1', from: 'active' },
          { contactId: 'uk-1', from: 'needs_review' },
        ] as const;
        for (const { contactId, from } of cases) {
          const res = await authedPatch(`/api/contacts/${contactId}/tenant-status`, { toStatus: 'inactive', source: 'manual' });
          expect(res.status, contactId).toBe(200);
          expect(res.body.contact.status, contactId).toBe('inactive');
          expect(res.body.contact.status_source, contactId).toBe('manual');
          expect((await world.contactsRepo.getById(contactId))?.status, contactId).toBe('inactive');
          const audit = world.auditEvents.filter(
            (a) => a.entityKey === `contacts#${contactId}` && a.event_type === 'tenant_status_changed',
          );
          expect(audit, contactId).toHaveLength(1);
          expect(audit[0]!.payload, contactId).toMatchObject({ from, to: 'inactive', source: 'manual' });
          // The seeded session's userId rides on the audit row (byActor GSI).
          expect(typeof (audit[0]!.payload as { actor?: unknown }).actor, contactId).toBe('string');
          const timeline = world.activityEvents.filter(
            (e) => e.contactId === contactId && e.type === 'contact_status_changed',
          );
          // The partner map labels partner + team_member; the unknown map
          // labels unknown (S1 statusLabelFor). Both read "Inactive".
          expect(timeline.map((e) => e.label), contactId).toEqual(['Status \u2192 Inactive']);
        }
      });

      it('emits contact.updated { contactId } on every successful call, every type, a same-status call included', async () => {
        await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'inactive', source: 'manual' });
        await authedPatch('/api/contacts/tenant-1/tenant-status', { toStatus: 'searching', source: 'manual' });
        await authedPatch('/api/contacts/pt-1/tenant-status', { toStatus: 'active', source: 'manual' });
        expect(notified).toEqual([{ contactId: 'uk-1' }, { contactId: 'tenant-1' }, { contactId: 'pt-1' }]);
      });

      it('(PIN) emits nothing on a refused call (400 status illegal for the type, 404 unknown contact)', async () => {
        expect((await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'searching', source: 'manual' })).status).toBe(400);
        expect((await authedPatch('/api/contacts/c-ghost/tenant-status', { toStatus: 'inactive', source: 'manual' })).status).toBe(404);
        expect(notified).toEqual([]);
      });

      it('a re-type landing between the route check and the write is 409 contact_type_changed and writes nothing', async () => {
        // The route's check read sees `unknown` (inactive is legal); a
        // concurrent writer makes the contact a landlord right after it, so
        // the status write must not store (landlord, inactive). The fake
        // repo hands out its LIVE stored object, so the route gets a
        // snapshot and the re-type lands on the stored contact.
        const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
        let reads = 0;
        vi.spyOn(world.contactsRepo, 'getById').mockImplementation(async (id, opts) => {
          const hit = await realGetById(id, opts);
          if (id !== 'uk-1' || hit === undefined) return hit;
          reads += 1;
          if (reads !== 1) return hit;
          const snapshot = structuredClone(hit);
          hit.type = 'landlord';
          return snapshot;
        });

        const res = await authedPatch('/api/contacts/uk-1/tenant-status', { toStatus: 'inactive', source: 'manual' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'contact_type_changed' });
        const stored = await world.contactsRepo.getById('uk-1');
        expect(stored?.type).toBe('landlord'); // the concurrent writer's type stands
        expect(stored?.status).toBe('needs_review'); // (landlord, inactive) was never stored
        expect(stored?.status_source).toBeUndefined();
        expect(
          world.auditEvents.filter((a) => a.entityKey === 'contacts#uk-1' && a.event_type === 'tenant_status_changed'),
        ).toEqual([]);
        expect(world.activityEvents.filter((e) => e.contactId === 'uk-1')).toEqual([]);
        expect(notified).toEqual([]);
      });
    });
  });
```

After the edit, confirm the label escape survived as six ASCII characters
(plan section 0):

```
grep -n 'u2192' W:/tmp/unknown-inactive/app/test/transitionRoutes.test.ts
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/transitionRoutes.test.ts
```

Expected: "a re-type landing between ..." fails `expected 200 to be 409` -
the route does not pass `expectedType` yet, so the setter guards on the type
IT read (already `landlord`) and stores (landlord, inactive). The other three
new cases pass (the accept case is green since S1; the emit case is green
since S2.3; the refusal case is a PIN). If the accept case fails with
`expected 400 to be 200`, S1's allowlists are missing - stop and report.

Step 3 - implementation in `app/src/routes/statusTransition.ts`.

Edit A (import). Current text:

```ts
import {
  createStatusTransitionService,
  EntityNotFoundError,
  TransitionRefusedError,
```

Replacement:

```ts
import {
  ContactTypeChangedError,
  createStatusTransitionService,
  EntityNotFoundError,
  TransitionRefusedError,
```

Edit B (the stale allowlist comment; ASCII line only). Current text:

```ts
    // lifecycle (LANDLORD_STATUSES), else needs_review|active. Previously it only
```

Replacement:

```ts
    // lifecycle (LANDLORD_STATUSES), an unknown's needs_review|inactive, else the
    // partner/team_member needs_review|active|inactive. Previously it only
```

Edit C (pass the checked type). Current text:

```ts
      const updated = await service.setTenantStatus(contactId, {
        toStatus: b['toStatus'] as import('../lib/statusModel.js').TenantStatus,
        source: b['source'],
```

Replacement:

```ts
      const updated = await service.setTenantStatus(contactId, {
        toStatus: b['toStatus'] as import('../lib/statusModel.js').TenantStatus,
        source: b['source'],
        // Ruling AR4: the write is conditioned on the type the allowlist
        // check above read, so a concurrent re-type is a 409, never an
        // illegal (type, status) pair.
        expectedType: stored.type,
```

Edit D (the 409 mapping). Current text:

```ts
  if (sendContactTypeError(err, res)) return;
  if (err instanceof EntityNotFoundError) {
```

Replacement:

```ts
  if (sendContactTypeError(err, res)) return;
  if (err instanceof ContactTypeChangedError) {
    // Ruling AR4: the contact was re-typed between the status route's
    // allowlist check and its conditional write. Nothing was written.
    res.status(409).json({ error: 'contact_type_changed' });
    return;
  }
  if (err instanceof EntityNotFoundError) {
```

Step 4 - GREEN: the same command as Step 2; the whole file passes.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/routes/statusTransition.ts app/test/transitionRoutes.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(status): 409 contact_type_changed when a re-type lands between the status check and the write (unknown-inactive AR4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.5 - the contact PATCH emits contact.updated on a status or type change

Files: `app/src/routes/contacts.ts`, `app/test/contactTriage.test.ts`.

S1 edits the auto-advance / normalize branch (~1710-1762) and the timeline
label block (~2125-2140) of the SAME handler. S2 anchors elsewhere: one line
after `priorStatus` (~1631) and one block after the `'contact triaged'` log
(~2141-2144). If S1 already declared a primitive snapshot of the stored type
in this handler, reuse it instead of adding `priorType`.

Step 1 - failing tests in `app/test/contactTriage.test.ts`. Current text (the
end of the GET describe near the top of the file):

```ts
  it('404s an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/contacts/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});
```

Replacement:

```ts
  it('404s an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/contacts/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

// unknown-inactive spec D2, ruling AR3: the PATCH emits ONE ID-only
// contact.updated when it changed `status` or `type` - whether or not a
// linked thread was touched - and none otherwise. The harness does not
// record this event in world.emitted (that list is asserted exactly above
// and below), so each case subscribes its own listener.
describe('PATCH /api/contacts/:contactId - contact.updated (AR3)', () => {
  function recordContactUpdated(world: ReturnType<typeof createFakeWorld>): unknown[] {
    const seen: unknown[] = [];
    world.events.on('contact.updated', (payload) => seen.push(payload));
    return seen;
  }
  function patchContact(app: Parameters<typeof request>[0], contactId: string, body: object) {
    return request(app)
      .patch(`/api/contacts/${contactId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);
  }

  it('emits once when the PATCH changes the type (unknown -> landlord)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const seen = recordContactUpdated(world);
    const res = await patchContact(app, 'contact-triage-1', { type: 'landlord' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ contactId: 'contact-triage-1' }]);
  });

  it('emits once when a status-only PATCH changes the status (an unknown marked Inactive)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const seen = recordContactUpdated(world);
    const res = await patchContact(app, 'contact-triage-1', { status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.contact.status).toBe('inactive');
    expect(seen).toEqual([{ contactId: 'contact-triage-1' }]);
  });

  it('emits once when the type changes and the status is kept (unknown -> team_member keeps needs_review)', async () => {
    // No status is written (needs_review is legal for team_member), so only
    // the TYPE snapshot can see the change - and the fake repo mutates the
    // live stored object on write, which is why the route snapshots it first.
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const seen = recordContactUpdated(world);
    const res = await patchContact(app, 'contact-triage-1', { type: 'team_member' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ type: 'team_member', status: 'needs_review' });
    expect(seen).toEqual([{ contactId: 'contact-triage-1' }]);
  });

  it('(PIN) emits nothing for a name-only edit, a status echo, a type echo or a refused PATCH', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const seen = recordContactUpdated(world);
    expect((await patchContact(app, 'contact-triage-1', { firstName: 'Keisha' })).status).toBe(200);
    // The name still denormalizes onto the thread as before.
    expect(world.emitted.some((e) => e.event === 'conversation.updated')).toBe(true);
    expect((await patchContact(app, 'contact-triage-1', { status: 'needs_review' })).status).toBe(200);
    expect((await patchContact(app, 'contact-triage-1', { type: 'unknown' })).status).toBe(200);
    // searching is a tenant status: refused for an unknown, nothing written.
    expect((await patchContact(app, 'contact-triage-1', { status: 'searching' })).status).toBe(400);
    expect(seen).toEqual([]);
  });
});
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/contactTriage.test.ts
```

Expected: the three "emits once" cases fail `expected [] to deeply equal [
{ contactId: 'contact-triage-1' } ]`; the (PIN) case passes. If "an unknown
marked Inactive" fails with a 400, S1's unknown allowlist is missing - stop
and report.

Step 3 - implementation in `app/src/routes/contacts.ts`.

Edit A (snapshot). Current text:

```ts
    const priorStatus = typeof stored?.status === 'string' ? stored.status : undefined;
```

Replacement:

```ts
    const priorStatus = typeof stored?.status === 'string' ? stored.status : undefined;
    // The prior TYPE as a primitive too, for the contact.updated emit below
    // (unknown-inactive ruling AR3) - the same live-object hazard as above.
    const priorType = typeof stored?.type === 'string' ? stored.type : undefined;
```

Edit B (emit). Current text:

```ts
    log.info(
      { contactId, fields: parsed.changedFields, propagatedConversations, actor: req.user?.userId },
      'contact triaged',
    );
```

Replacement:

```ts
    log.info(
      { contactId, fields: parsed.changedFields, propagatedConversations, actor: req.user?.userId },
      'contact triaged',
    );

    // LIVE NOTIFY (unknown-inactive spec D2, ruling AR3): one ID-only
    // contact.updated when this PATCH changed the status or the type, so an
    // open Today page drops or adds the row and an open inbox re-renders its
    // tag and chip. The conversation.updated emits above cover only linked
    // threads that flipped type or carry a name - an unnamed or threadless
    // contact gets none - so this fires whether or not a thread was touched.
    // The status value is the one actually written (an auto-advance or a
    // normalize included); a same-value echo emits nothing.
    const statusChanged =
      typeof parsed.patch['status'] === 'string' && parsed.patch['status'] !== priorStatus;
    const typeChanged =
      typeof parsed.patch['type'] === 'string' && parsed.patch['type'] !== priorType;
    if (statusChanged || typeChanged) {
      events.emit('contact.updated', { contactId });
    }
```

Step 4 - GREEN: the same command as Step 2; the whole file passes. Then run
the other PATCH suites that assert `world.emitted` or PATCH behavior, to
prove nothing else moved:

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/contactsCrud.test.ts test/landlordContactFields.test.ts test/contactStaffNotes.test.ts test/suggestions.test.ts test/suggestionReclassification.test.ts
```

Expected: green, unchanged.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/routes/contacts.ts app/test/contactTriage.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(contacts): emit contact.updated when a PATCH changes status or type (unknown-inactive AR3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.6 - dashboard event type and EventStreamProvider listener

Files: `dashboard/src/api/types.ts`,
`dashboard/src/api/EventStreamProvider.tsx`,
`dashboard/src/api/useEventStream.test.tsx`.

Step 1 - failing test in `dashboard/src/api/useEventStream.test.tsx`.

Edit A. Current text:

```ts
import type { PlacementUpdatedEvent, ConversationUpdatedEvent } from './types.js';
```

Replacement:

```ts
import type { PlacementUpdatedEvent, ConversationUpdatedEvent, ContactUpdatedEvent } from './types.js';
```

Edit B. Current text:

```ts
    expect(onConversationUpdated).toHaveBeenCalledWith(conv);
    expect(onPlacementUpdated).toHaveBeenCalledWith(kase);
  });
```

Replacement:

```ts
    expect(onConversationUpdated).toHaveBeenCalledWith(conv);
    expect(onPlacementUpdated).toHaveBeenCalledWith(kase);
  });

  it('dispatches contact.updated to onContactUpdated (unknown-inactive AR3)', () => {
    const onContactUpdated = vi.fn();
    const onSuggestionUpdated = vi.fn();
    render(
      <EventStreamProvider>
        <Sub onContactUpdated={onContactUpdated} onSuggestionUpdated={onSuggestionUpdated} />
      </EventStreamProvider>,
    );
    const event: ContactUpdatedEvent = { contactId: 'c-1' };
    act(() => {
      FakeEventSource.instances[0]?.emit('contact.updated', event);
    });
    expect(onContactUpdated).toHaveBeenCalledWith(event);
    // Its own channel: never delivered as a suggestion event.
    expect(onSuggestionUpdated).not.toHaveBeenCalled();
  });
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/api/useEventStream.test.tsx
```

Expected: the new case fails `expected "spy" to be called with arguments: [
{ contactId: 'c-1' } ]` (number of calls: 0) - the provider adds no
`contact.updated` listener yet.

Step 3 - implementation.

Edit A, `dashboard/src/api/types.ts`. Current text:

```ts
export interface SuggestionUpdatedEvent {
  contactId: string;
}
```

Replacement:

```ts
export interface SuggestionUpdatedEvent {
  contactId: string;
}

/** GET /api/events 'contact.updated' payload (unknown-inactive spec D2, ruling
 *  AR3). A contact's status or type changed - through the status transition
 *  route (the header dropdown) or the contact PATCH (the edit form). Today and
 *  the inbox refetch on it; the contact page re-reads the contact when
 *  `contactId` is the one it shows. Mirrors app/src/lib/events.ts
 *  ContactUpdatedEvent. ID-only - NO PII. */
export interface ContactUpdatedEvent {
  contactId: string;
}
```

Edit B, `dashboard/src/api/EventStreamProvider.tsx` (import). Current text:

```ts
  SuggestionUpdatedEvent,
  AiRunCompletedEvent,
```

Replacement:

```ts
  SuggestionUpdatedEvent,
  ContactUpdatedEvent,
  AiRunCompletedEvent,
```

Edit C (handler type). Current text:

```ts
  onSuggestionUpdated?: (event: SuggestionUpdatedEvent) => void;
```

Replacement:

```ts
  onSuggestionUpdated?: (event: SuggestionUpdatedEvent) => void;
  /** A contact's status or type changed (unknown-inactive AR3) - Today and the
   *  inbox refetch; the contact page re-reads the contact it shows. */
  onContactUpdated?: (event: ContactUpdatedEvent) => void;
```

Edit D (listener). Current text:

```ts
      source.addEventListener('suggestion.updated', (ev) => {
        markActivity();
        const data = parse<SuggestionUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onSuggestionUpdated, data);
      });
```

Replacement:

```ts
      source.addEventListener('suggestion.updated', (ev) => {
        markActivity();
        const data = parse<SuggestionUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onSuggestionUpdated, data);
      });

      source.addEventListener('contact.updated', (ev) => {
        markActivity();
        const data = parse<ContactUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onContactUpdated, data);
      });
```

Step 4 - GREEN: the same command as Step 2; the whole file passes.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/api/types.ts dashboard/src/api/EventStreamProvider.tsx dashboard/src/api/useEventStream.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(dashboard): listen for contact.updated on the shared event stream (unknown-inactive AR3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.7 - Today refetches on contact.updated

Files: `dashboard/src/routes/today/useToday.ts`,
`dashboard/src/routes/today/useToday.test.tsx`.

Step 1 - failing test in `dashboard/src/routes/today/useToday.test.tsx`.

Edit A. Current text:

```ts
  onTourUpdated?: () => void;
} = {};
```

Replacement:

```ts
  onTourUpdated?: () => void;
  onContactUpdated?: () => void;
} = {};
```

Edit B. Current text:

```ts
    getToday.mockResolvedValue({ ...TODAY, items: [] });
    lastHandlers.onTourUpdated?.();
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(getToday).toHaveBeenCalledTimes(2);
  });
```

Replacement:

```ts
    getToday.mockResolvedValue({ ...TODAY, items: [] });
    lastHandlers.onTourUpdated?.();
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(getToday).toHaveBeenCalledTimes(2);
  });

  it('refetches when a contact.updated event arrives (a contact marked Inactive leaves Needs you now)', async () => {
    // unknown-inactive spec D2 / AR3: a header status change writes no
    // thread, so no conversation.updated arrives for it.
    getToday.mockResolvedValue(TODAY);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getToday).toHaveBeenCalledTimes(1);

    getToday.mockResolvedValue({ ...TODAY, items: [] });
    lastHandlers.onContactUpdated?.();
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(getToday).toHaveBeenCalledTimes(2);
  });
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/today/useToday.test.tsx
```

Expected: the new case times out in `waitFor` with `expected element to have
text content "0", received "1"` - `onContactUpdated` is undefined, so `?.()`
is a no-op.

Step 3 - implementation in `dashboard/src/routes/today/useToday.ts`.

Edit A (header comment). Current text:

```ts
// suggestion.updated / tour.updated so the queue stays live. Returns a small { status, items, source } state for the view.
```

Replacement:

```ts
// suggestion.updated / tour.updated / contact.updated so the queue stays live. Returns a small { status, items, source } state for the view.
```

Edit B. Current text:

```ts
    onTourUpdated: scheduleRefetch,
  });
```

Replacement:

```ts
    onTourUpdated: scheduleRefetch,
    // unknown-inactive (spec D2, AR3): a contact marked Inactive or re-typed
    // leaves (or joins) Needs you now. A header status change writes no
    // thread, so contact.updated is the only signal for it.
    onContactUpdated: scheduleRefetch,
  });
```

Step 4 - GREEN: the same command as Step 2; the whole file passes.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/routes/today/useToday.ts dashboard/src/routes/today/useToday.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(today): refetch on contact.updated (unknown-inactive AR3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.8 - the inbox refetches on contact.updated

Files: `dashboard/src/routes/inbox/useInbox.ts` (the ~563 line ONLY),
`dashboard/src/routes/inbox/useInbox.test.tsx` (a new case inside the main
`describe('useInbox', ...)`, NOT at the end of the file - S5 appends there).

Step 1 - failing test. Current text in `useInbox.test.tsx`:

```ts
        participant_display_name: 'Bo',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
  });
```

Replacement:

```ts
        participant_display_name: 'Bo',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
  });

  it('refetches (coalesced) the current page on an SSE contact.updated (a header status change writes no thread)', async () => {
    // unknown-inactive spec D2 / AR3: the row's Inactive tag and triage chip
    // must update without a reload, and no conversation.updated arrives for
    // a status-only change.
    getInbox.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(1));
    act(() => {
      sse.onContactUpdated?.({ contactId: 'c1' });
      sse.onContactUpdated?.({ contactId: 'c1' });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
  });
```

(The anchor is the end of "refetches (coalesced) the current page on an SSE
conversation.updated"; `participant_display_name: 'Bo',` occurs once in the
file - confirm with `grep -n "participant_display_name: 'Bo'"` before
editing.)

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/inbox/useInbox.test.tsx
```

Expected: the new case times out with `expected "spy" to be called 2 times,
but got 1 times`.

Step 3 - implementation in `dashboard/src/routes/inbox/useInbox.ts`. Current
text:

```ts
  useEventStream({ onConversationUpdated: scheduleRefetch });
```

Replacement:

```ts
  // contact.updated (unknown-inactive spec D2, AR3): a status or type change
  // re-reads the head so a row's Inactive tag and triage chip update without a
  // reload. A header status change writes no thread, so no
  // conversation.updated arrives for it.
  useEventStream({ onConversationUpdated: scheduleRefetch, onContactUpdated: scheduleRefetch });
```

Step 4 - GREEN: the same command as Step 2; the whole file passes.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/useInbox.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(inbox): refetch on contact.updated (unknown-inactive AR3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.9 - the contact page re-reads the open contact on contact.updated

`useContact` owns the header's contact fetch (`ContactDetail.tsx:301`
`useContact(contactId)`; `useContactFile` fetches placements/units/tours
only). It already re-reads in place on `suggestion.updated`; this task routes
both events through one helper.

Files: `dashboard/src/routes/contact/useContact.ts`,
`dashboard/src/routes/contact/useContact.test.tsx`.

Step 1 - failing tests in `dashboard/src/routes/contact/useContact.test.tsx`.

Edit A (capture the SSE handlers; the file used the real hook before, which
is a no-op with no provider mounted, so the existing cases are unaffected).
Current text:

```ts
import type { Contact } from '../../api/index.js';

const getContact = vi.fn();
const updateContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
  };
});
```

Replacement:

```ts
import type { Contact, EventStreamHandlers } from '../../api/index.js';

const getContact = vi.fn();
const updateContact = vi.fn();
// The page's only useEventStream caller is useContact, so last-writer-wins
// capture is exact here.
let sse: EventStreamHandlers = {};
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});
```

Edit B. Current text:

```ts
beforeEach(() => {
  getContact.mockReset();
  updateContact.mockReset();
```

Replacement:

```ts
beforeEach(() => {
  sse = {};
  getContact.mockReset();
  updateContact.mockReset();
```

Edit C (new describe at the end of the file). Current text (the file's last
lines):

```ts
    expect(await screen.findByText('note B - updated')).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(1);
  });
});
```

Replacement:

```ts
    expect(await screen.findByText('note B - updated')).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(1);
  });
});

// unknown-inactive spec D2 / AR3: a status or type change made elsewhere (the
// edit form, another tab, another operator) re-reads the open contact in
// place - no spinner, no reload.
describe('useContact - live re-read on contact.updated', () => {
  it('re-reads the open contact in place when contact.updated names it', async () => {
    render(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(1);

    getContact.mockResolvedValue({ ...B, firstName: 'Benjamin' });
    act(() => {
      sse.onContactUpdated?.({ contactId: 'B' });
    });
    expect(await screen.findByRole('heading', { name: 'Benjamin' })).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('page loading')).not.toBeInTheDocument();
  });

  it('(PIN) ignores contact.updated for another contact', async () => {
    render(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    await act(async () => {
      sse.onContactUpdated?.({ contactId: 'A' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(getContact).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Ben' })).toBeInTheDocument();
  });
});
```

Step 2 - RED.

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/contact/useContact.test.tsx
```

Expected: "re-reads the open contact in place" fails - `findByRole('heading',
{ name: 'Benjamin' })` times out (`onContactUpdated` is undefined). The (PIN)
and the two existing cases pass.

Step 3 - implementation in `dashboard/src/routes/contact/useContact.ts`.
Current text:

```ts
  useEventStream({
    onSuggestionUpdated: (event) => {
      if (event.contactId !== contactId) return;
      void getContact(contactId)
        .then((contact) => {
          setState((prev) => (prev.forId === contactId ? { status: 'ready', contact, forId: contactId } : prev));
        })
        .catch(() => {
          /* best-effort: keep the current contact on a fetch hiccup */
        });
    },
  });
```

Replacement:

```ts
  // contact.updated (unknown-inactive spec D2, AR3) re-reads the same way: a
  // status or type change made elsewhere (the edit form, another tab or
  // operator) lands without a reload. Both events name the contact; only the
  // open one is re-read.
  const refetchInPlace = (eventContactId: string): void => {
    if (eventContactId !== contactId) return;
    void getContact(contactId)
      .then((contact) => {
        setState((prev) => (prev.forId === contactId ? { status: 'ready', contact, forId: contactId } : prev));
      })
      .catch(() => {
        /* best-effort: keep the current contact on a fetch hiccup */
      });
  };
  useEventStream({
    onSuggestionUpdated: (event) => refetchInPlace(event.contactId),
    onContactUpdated: (event) => refetchInPlace(event.contactId),
  });
```

Step 4 - GREEN: the same command as Step 2; the whole file passes. Then run
the page suite, whose `useEventStream` stub merges every caller's handlers
(`ContactDetail.test.tsx:152-163`), to prove the extra key changes nothing:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/contact/ContactDetail.test.tsx
```

Expected: green, unchanged.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/routes/contact/useContact.ts dashboard/src/routes/contact/useContact.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(contact): re-read the open contact on contact.updated (unknown-inactive AR3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S2.10 - slice checks and report

Step 1 - ASCII on every touched file (plan section 0): for each file listed
at the top of this section,

```
git -C W:/tmp/unknown-inactive diff -U0 916258ae -- <FILE> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```

prints 0. (`statusTransition.ts`, `api.ts`, `contacts.ts`, `events.ts`,
`EventStreamProvider.tsx` and several tests already carry non-ASCII on
untouched lines; only ADDED lines are checked.) And:

```
grep -n 'u2192' W:/tmp/unknown-inactive/app/test/transitionRoutes.test.ts
```

shows the six-character escape, not a literal arrow.

Step 2 - typecheck the two workspaces S2 touched (vitest strips types):

```
cd W:/tmp/unknown-inactive; npm run typecheck
```

Expected exit 0. A failure naming `expectedType`, `ContactTypeChangedError`,
`onContactUpdated` or `'contact.updated'` is S2's to fix before the report.

Step 3 - write
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S2-report.md`
(ASCII, findings only, `file:line` citations). It must record at least:

- C2 confirmed: no change to `app/src/lib/eventBridge.ts` (`:45` iterates
  `APP_EVENT_NAMES`) or `app/src/routes/internal.ts` (`:34`); only
  `app/test/eventBridge.test.ts:43` changed (9 -> 10).
- C4: `contact.updated` is deliberately NOT in the harness recorder
  (`twilioWebhookHarness.ts:616-623`), and why.
- The service now imports `ConditionalCheckFailedException` from the AWS SDK
  (precedent `services/caseworkerConversion.ts:12`) - against the letter of
  AGENTS.md "Vendor SDK imports belong in app/src/adapters", in line with
  existing practice.
- No `contact.updated` on the StatusTransitionCommittedError path (the
  write committed, the audit failed, the route answers 500): an open page is
  not notified of that change. AR3 says "every successful call"; this is that
  reading. TODO(suggestion-status-accept-contract-drift) already tracks the
  500.
- Known extra reads, accepted: after the operator's OWN header change the
  contact page applies the route's response and then re-reads the contact
  once more on the echoed `contact.updated`; a PATCH that changes the type
  AND drains a type suggestion emits both `suggestion.updated` and
  `contact.updated`, so `useContact` re-reads twice. One GET each, on a user
  action, never on page load.
- Writers that change status or type but emit no `contact.updated` (outside
  AR3's two emitters, not changed): the caseworker conversion
  (`services/caseworkerConversion.ts:528-559`), the AI status-suggestion
  accept (journal path, emits `suggestion.updated` only - Today refetches on
  it, the inbox does not), the derived tenant status
  (`services/statusTransition.ts` deriveTenantStatus) and the import. Report
  them; file nothing (AR14).
- Untrimmed input paths: none. `toStatus`, `status` and `type` are fixed keys
  validated against allowlists; `contactId` is a path id.
- Anything the tree held that this plan got wrong.

Step 4 - commit the report:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S2-report.md
git -C W:/tmp/unknown-inactive commit -m "docs(records): unknown-inactive S2 slice report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S2 coverage

Spec section 4 surfaces covered:

- `app/src/routes/statusTransition.ts` + `app/src/services/statusTransition.ts`
  - the conditional write (409, nothing written) and the notify (D2). The
  per-type label is S1's.
- `app/src/routes/contacts.ts` - the PATCH side of the notify (AR3); the
  other contacts.ts surfaces are S1's.
- Dashboard "Today and Inbox SSE refetch triggers - must fire on the D2
  notify": `useToday.ts`, `useInbox.ts`, plus the contact page's
  `useContact.ts`, carried by `EventStreamProvider.tsx` and the
  `ContactUpdatedEvent` type in `dashboard/src/api/types.ts`.
- New plumbing the spec left to the plan (D2 "The plan picks the event"):
  `app/src/lib/events.ts`, the SSE route in `app/src/routes/api.ts`; the
  bridge (`eventBridge.ts`, `internal.ts`) verified unchanged.

Spec section 5 tests covered:

- Test 2 in full: Inactive accepted through the route for partner,
  team_member and unknown with `status_source: 'manual'`, the
  `tenant_status_changed` audit and a `Status \u2192 Inactive` timeline entry
  (S2.4); a concurrent re-type between check and write is a 409 with no write,
  audit, timeline entry or emit (S2.3 service level, S2.4 route level); the
  change notifies open Today and Inbox pages (S2.1-S2.8: emitted on success
  only, forwarded over SSE, refetched by `useToday` and `useInbox`).
- The e2e half of "an open Today page drops the row ... without a reload" is
  spec test 8 (S6).



## 7. S3 - Backend readers (D4.1, D5, D9; rulings AR5, AR8)

Scope: `isEligibleRecipient` drops Inactive for every type (D4.1); the Today
unread collect loop skips an Inactive contact's `unknown_1to1` thread before
the cap (D5, AR8); the Unknown-tab block order is needs_review then inactive
(tests, comments, the pre-deploy cursor, D9); the inbox wire row gains
`inactive?: boolean` and `needsTriage` is false for an Inactive contact (D9,
AR5); inbound text and call to an existing Inactive contact leave its status
alone (W4). Watch items W1, W2, W4, W5 are checked and recorded.

Depends on S1: `app/src/lib/statusModel.ts` exports `UNKNOWN_STATUSES`, and
`app/src/lib/unknownQueue.ts` already imports it, types
`UnknownQueueStatus = (typeof UNKNOWN_STATUSES)[number]` and declares
`UNKNOWN_QUEUE_STATUS_ORDER = { needs_review: 0, inactive: 1 }`.

### Contradictions

None with AR1-AR14. Two precision notes the planner should know:

1. Spec test 4's cap case ("100+ unread Inactive unknown threads ahead of a
   live one do not hide the live one") CANNOT go red with a Needs review
   unknown as the live one: the contacts-triage pass (`app/src/routes/today.ts`
   ~845-941) reads the (unknown, needs_review) partition on its own and emits
   that contact's "New unknown contact" row even when its thread fell off the
   cap. S3.3's real RED therefore puts an Active TEAM MEMBER's `unknown_1to1`
   thread and a TENANT's thread behind the wall (neither has a second source)
   and keeps the Needs review contact in the same fixture as a pin.
2. S1's change to `UNKNOWN_QUEUE_STATUS_ORDER` turns these existing tests red
   until S3.4 flips them (they seed (unknown, active) contacts, which no block
   reads any more): `app/test/unknownQueue.test.ts`,
   `app/test/inboxUnknownTab.test.ts`, `app/test/inboxUnknownParity.test.ts`
   (class f), `app/test/inbox.integration.test.ts` (~485). S3.4 owns those
   flips. S1 must not "fix" them a different way, and no gate may run between
   S1 and S3.4 expecting them green.

### S3.1 Start-of-slice checks (W1, and S1 landed)

No code, no commit. Record each result in the slice report (S3.7).

Step 1 (W1, #31 overlap). Run, bare:

```
git -C W:/tmp/unknown-inactive branch -a
git -C W:/tmp/unknown-inactive worktree list
```

On 2026-10-23 the branches were `feat/flyer-leads`,
`feat/property-requirements`, `feat/unknown-inactive`, `main` (+ remotes) and
the worktrees were the main checkout, `W:/tmp/flyer-leads`,
`W:/tmp/property-requirements`, `W:/tmp/unknown-inactive`. If a branch or
worktree for tracker #31 (Today as the daily checklist) now exists, find its
PLAN (`docs/superpowers/plans/*` on that branch, read with
`git -C W:/tmp/unknown-inactive show <branch>:<path>`), and record whether it
touches `app/src/routes/today.ts` ~704-800 (the unread collect/emit loops).
Do not change course; record it and continue. If none exists, record "W1: no
#31 branch or worktree at S3 start".

Step 2 (S1 landed). Run:

```
grep -n "UNKNOWN_STATUSES\|UNKNOWN_QUEUE_STATUS_ORDER = {" -A3 W:/tmp/unknown-inactive/app/src/lib/unknownQueue.ts
```

Expected: the import `import { UNKNOWN_STATUSES } from './statusModel.js';`,
`type UnknownQueueStatus = (typeof UNKNOWN_STATUSES)[number];`, and the order
object holding `needs_review: 0,` and `inactive: 1,`. If any is missing,
STOP and report to the planner - S3.4 cannot be built on it.

### S3.2 Inactive is not chased, whatever the type (D4.1)

Files:
- `app/src/lib/listingSendOutcome.ts` (edit)
- `app/test/listingSendOutcome.test.ts` (edit)
- `app/test/followUps.test.ts` (edit)
- `app/test/listingSendsApi.test.ts` (edit)

Consumers need NO change: `app/src/services/followUps.ts:182`
(`const eligible = isEligibleRecipient(contact);`) and
`app/src/routes/units.ts:301` (`eligible: isEligibleRecipient(contact),`)
both pass the contact item, whose `type` and `status` are already in the
recipient projection (`RECIPIENT_ATTRS` in `app/test/followUps.test.ts`
mirrors it). The new cases in the two consumer tests prove that.

Step 1 - the failing tests.

In `app/test/listingSendOutcome.test.ts`, replace this current text (~195-198):

```ts
  it('the status clause is TENANT-only: a partner marked inactive/placed stays eligible', () => {
    expect(isEligibleRecipient({ type: 'partner', status: 'inactive', phone: '+14045550101' })).toBe(true);
    expect(isEligibleRecipient({ type: 'partner', status: 'placed', phone: '+14045550101' })).toBe(true);
  });
```

with:

```ts
  // FLIPPED by unknown-inactive D4.1 (2026-10-23): Inactive means the same
  // thing for every contact type, so it is never chased. This case used to pin
  // the opposite ("the status clause is TENANT-only").
  it('Inactive is NOT eligible for ANY type: caseworker, team member, unknown', () => {
    expect(isEligibleRecipient({ type: 'partner', status: 'inactive', phone: '+14045550101' })).toBe(false);
    expect(isEligibleRecipient({ type: 'team_member', status: 'inactive', phone: '+14045550103' })).toBe(false);
    expect(isEligibleRecipient({ type: 'unknown', status: 'inactive', phone: '+14045550104' })).toBe(false);
  });
  it('PIN: placed stays TENANT-only - a partner carrying placed stays eligible', () => {
    expect(isEligibleRecipient({ type: 'partner', status: 'placed', phone: '+14045550101' })).toBe(true);
  });
  it('PIN: an Active caseworker is eligible', () => {
    expect(isEligibleRecipient({ type: 'partner', status: 'active', phone: '+14045550105' })).toBe(true);
  });
  it('PIN: a Parked landlord keeps today\'s behavior - parked is the landlord\'s own status, not inactive', () => {
    expect(isEligibleRecipient({ type: 'landlord', status: 'parked', phone: '+14045550106' })).toBe(true);
  });
```

In `app/test/followUps.test.ts`, insert this test immediately BEFORE the
current line
`  // The id rung of the fallback is unreachable for a KEPT row (eligibility`
(it follows the test named
`'eligibility: drops deleted, opted-out, unreachable, phone-less and inactive/placed tenants; keeps a partner'`):

```ts
  it('unknown-inactive D4.1: an Inactive caseworker, team member and unknown contact are dropped; an Active caseworker and a Parked landlord are kept', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(
      { contactId: 'p-inactive', type: 'partner', status: 'inactive', phone: '+15550100101', firstName: 'Ina', lastName: 'Ctive', role: 'Case worker' } as ContactItem,
      { contactId: 'p-active', type: 'partner', status: 'active', phone: '+15550100102', firstName: 'Act', lastName: 'Ive', role: 'Case worker' } as ContactItem,
      { contactId: 'tm-inactive', type: 'team_member', status: 'inactive', phone: '+15550100103', firstName: 'Team', lastName: 'Gone' } as ContactItem,
      { contactId: 'u-inactive', type: 'unknown', status: 'inactive', phone: '+15550100104' } as ContactItem,
      { contactId: 'l-parked', type: 'landlord', status: 'parked', phone: '+15550100105', firstName: 'Park', lastName: 'Ed' } as ContactItem,
    );
    for (const c of w.contacts) w.sends.push(send('u1', c.contactId, ago(3 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId).sort()).toEqual(['l-parked', 'p-active']);
  });
```

In `app/test/listingSendsApi.test.ts`, insert this test immediately BEFORE
the current line
`  it('a PARTNER row is served WITHOUT tour even when tour data exists (B11), interestedSupported false', async () => {`
(it follows the test named
`'eligible follows isEligibleRecipient (inactive tenant, opted out); interestedMode follows the unit tour_type'`,
whose helpers `makeWebhookHarness`, `seedUnit`, `seedListingSend`, `get` and
`SENT_AT` it reuses):

```ts
  it('unknown-inactive D4.1: an INACTIVE caseworker recipient is eligible:false; an Active one stays eligible:true', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    world.contacts.push({ contactId: 'c-pt-off', type: 'partner', status: 'inactive', phone: '+15550109011', role: 'Caseworker' });
    world.contacts.push({ contactId: 'c-pt-on', type: 'partner', status: 'active', phone: '+15550109012', role: 'Caseworker' });
    for (const contactId of ['c-pt-off', 'c-pt-on']) {
      await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
    }
    const res = await get(app, '/api/units/unit-1/recipients');
    const byId = new Map((res.body.recipients as Array<Record<string, unknown>>).map((r) => [r['contactId'] as string, r]));
    expect(byId.get('c-pt-off')).toMatchObject({ eligible: false, type: 'partner' });
    expect(byId.get('c-pt-on')).toMatchObject({ eligible: true, type: 'partner' });
  });
```

Leave every existing `(unknown, active)` fixture in `followUps.test.ts`
(~212-213, ~385), `listingSendsApi.test.ts` (~595, ~637-639, ~667) and
`unitsApiActivity.test.ts` (~430-431) AS IS: they test phone formatting and
labels of an eligible unknown recipient, `active` is not `inactive`, and they
stay green. If any slice sweeps those illegal pairs, it must move them to
`needs_review`, NEVER to `inactive` (that would make them ineligible and break
the tests for an unrelated reason).

Step 2 - RED. DynamoDB Local must be up (plan section 0; `npm run db:start`
once, never a restart).

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/listingSendOutcome.test.ts test/followUps.test.ts test/listingSendsApi.test.ts
```

Expected failures, and only these:
- `Inactive is NOT eligible for ANY type ...` - `expected true to be false`
  (the partner line fails first).
- the new followUps case - received
  `['l-parked', 'p-active', 'p-inactive', 'tm-inactive', 'u-inactive']`.
- the new listingSendsApi case - `c-pt-off` has `eligible: true`.
The three PIN cases pass. If `l-parked` is ABSENT from the followUps RED
output, a rule other than eligibility drops landlords from Follow up: remove
`l-parked` from that case (expect `['p-active']`), keep the unit-level Parked
pin, and record it in the slice report.

Step 3 - implementation. In `app/src/lib/listingSendOutcome.ts`, replace the
current text (~100-114):

```ts
/** Spec 5.6 / B6: can this recipient be chased by text at all? */
export function isEligibleRecipient(c: {
  type?: string;
  status?: string;
  deleted_at?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  phone?: string;
}): boolean {
  if (typeof c.deleted_at === 'string' && c.deleted_at.length > 0) return false;
  if (c.sms_opt_out === true || c.sms_unreachable === true) return false;
  if (typeof c.phone !== 'string' || c.phone.length === 0) return false;
  if (c.type === 'tenant' && (c.status === 'inactive' || c.status === 'placed')) return false;
  return true;
}
```

with:

```ts
/**
 * Spec 5.6 / B6: can this recipient be chased by text at all?
 *
 * unknown-inactive D4.1 (2026-10-23): `inactive` is dropped for EVERY type -
 * Inactive means the same thing for a tenant, caseworker, team member or
 * unknown contact. `placed` stays tenant-only (only tenants have it). The
 * landlord's own `parked` is NOT `inactive` and is untouched.
 */
export function isEligibleRecipient(c: {
  type?: string;
  status?: string;
  deleted_at?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  phone?: string;
}): boolean {
  if (typeof c.deleted_at === 'string' && c.deleted_at.length > 0) return false;
  if (c.sms_opt_out === true || c.sms_unreachable === true) return false;
  if (typeof c.phone !== 'string' || c.phone.length === 0) return false;
  if (c.status === 'inactive') return false;
  if (c.type === 'tenant' && c.status === 'placed') return false;
  return true;
}
```

Step 4 - GREEN: the same command as Step 2; every case passes.

Step 5 - commit (a separate bare `git status` read first; MERGE_HEAD check
per plan section 0):

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/lib/listingSendOutcome.ts app/test/listingSendOutcome.test.ts app/test/followUps.test.ts app/test/listingSendsApi.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(follow-ups): an Inactive contact of any type is not chased (unknown-inactive D4.1)" -m "isEligibleRecipient drops status inactive whatever the type; placed stays tenant-only; parked untouched. Flips the tenant-only pin." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S3.3 Today: an Inactive contact's unknown_1to1 thread leaves Needs you now (D5, AR8)

Files:
- `app/src/routes/today.ts` (edit)
- `app/test/todayApi.test.ts` (edit)

Step 1 - the failing tests. In `app/test/todayApi.test.ts`, insert this
block immediately BEFORE the current line (~995)
`  // --- FIX B: relay_group threads never surface in unreplied --------------------`
(it follows the test
`'has NO deleted-contact lookup bound: 101 deleted ahead of 1 live shows exactly the 1, and announces the skips'`).
It uses the file's own `world`, `seedConversation`, `seedTenant`, `iso` and
`getItems` from the enclosing describe.

```ts
  // --- unknown-inactive D5 (AR8): skip an Inactive contact's unknown_1to1 thread
  // Cameron 2026-10-23: Needs you now shows unread texts from an unknown contact
  // that needs review; an Inactive one "just shows in the inbox". The skip is
  // "skip Inactive", not "keep only needs_review" (team_member threads are
  // unknown_1to1 too), it is limited to unknown_1to1 (an Inactive tenant stays
  // in Unreplied, #31's section), and it runs ahead of the cap.
  describe('unknown-inactive D5: an Inactive contact\'s unknown_1to1 thread', () => {
    const unknownThread = (conversationId: string, contactId: string, phone: string, offset: number): ConversationItem =>
      seedConversation({
        conversationId,
        participant_phone: phone,
        participants: [{ contactId, phone }],
        status: 'open',
        last_activity_at: iso(offset),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);
    const newUnknownRefIds = (items: TodayItem[]): string[] =>
      items
        .filter((i) => i.group === 'needs_you_now' && i.why === 'New unknown contact')
        .map((i) => i.refId)
        .sort();

    it('RED: an unread thread from an INACTIVE unknown contact is NOT in needs_you_now (nor anywhere on Today)', async () => {
      world.contacts.push({ contactId: 'c-unk-off', type: 'unknown', status: 'inactive', phone: '+15550360001' });
      unknownThread('conv-unk-off', 'c-unk-off', '+15550360001', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual([]);
      expect(items.map((i) => i.refId)).not.toContain('c-unk-off');
    });

    it('PIN: an unread thread from a NEEDS REVIEW unknown contact is in needs_you_now, once', async () => {
      world.contacts.push({ contactId: 'c-unk-nr', type: 'unknown', status: 'needs_review', phone: '+15550360002' });
      unknownThread('conv-unk-nr', 'c-unk-nr', '+15550360002', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual(['c-unk-nr']);
    });

    it('PIN: an unread unknown_1to1 thread from an ACTIVE team member is still in needs_you_now (unchanged)', async () => {
      world.contacts.push({ contactId: 'c-team-on', type: 'team_member', status: 'active', firstName: 'Tea', lastName: 'Mate', phone: '+15550360003' });
      unknownThread('conv-team-on', 'c-team-on', '+15550360003', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual(['c-team-on']);
    });

    it('PIN: an INACTIVE TENANT\'s unread thread is still in unreplied (the skip is unknown_1to1 only)', async () => {
      world.contacts.push({ contactId: 'c-ten-off', type: 'tenant', status: 'inactive', firstName: 'Ina', lastName: 'Tenant', phone: '+15550360004' });
      seedConversation({
        conversationId: 'conv-ten-off',
        participant_phone: '+15550360004',
        participant_display_name: 'Ina Tenant',
        participants: [{ contactId: 'c-ten-off', phone: '+15550360004' }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);

      const items = await getItems();
      expect(items.filter((i) => i.group === 'unreplied').map((i) => i.refId)).toEqual(['c-ten-off']);
    });

    it('RED: more than TODAY_UNREAD_CAP Inactive unknown threads ahead of live work do not hide it (the skip runs BEFORE the cap)', async () => {
      // 101 Inactive unknown threads, all NEWER than the live rows, so without
      // a collect-loop skip they spend all 100 slots. Behind them: an Active
      // team member's unknown_1to1 thread and a tenant's thread - neither has a
      // second source, so the cap hides them - plus a Needs review unknown
      // (PIN only: the contacts-triage pass would rescue it by itself).
      for (let i = 0; i < 101; i += 1) {
        const id = `c-off-${String(i).padStart(3, '0')}`;
        const phone = `+1555034${String(i).padStart(4, '0')}`;
        world.contacts.push({ contactId: id, type: 'unknown', status: 'inactive', phone });
        unknownThread(`conv-off-${String(i).padStart(3, '0')}`, id, phone, -1_000 - i);
      }
      world.contacts.push({ contactId: 'c-live-team', type: 'team_member', status: 'active', firstName: 'Live', lastName: 'Team', phone: '+15550359001' });
      unknownThread('conv-live-team', 'c-live-team', '+15550359001', -400_000);
      world.contacts.push({ contactId: 'c-live-nr', type: 'unknown', status: 'needs_review', phone: '+15550359002' });
      unknownThread('conv-live-nr', 'c-live-nr', '+15550359002', -400_001);
      seedTenant('c-live-ten', 'Live', 'Tenant');
      seedConversation({
        conversationId: 'conv-live-ten',
        participant_phone: '+15550359003',
        participant_display_name: 'Live Tenant',
        participants: [{ contactId: 'c-live-ten', phone: '+15550359003' }],
        status: 'open',
        last_activity_at: iso(-400_002),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual(['c-live-nr', 'c-live-team']);
      expect(items.filter((i) => i.group === 'unreplied').map((i) => i.refId)).toEqual(['c-live-ten']);
    });
  });

```

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/todayApi.test.ts
```

Expected failures, and only these two:
- `RED: an unread thread from an INACTIVE unknown contact ...` - received
  `['c-unk-off']`.
- `RED: more than TODAY_UNREAD_CAP ...` - `newUnknownRefIds` receives 100
  `c-off-*` ids plus `c-live-nr` (no `c-live-team`), and Unreplied is `[]`.
The three PIN cases pass.

Step 3 - implementation. In `app/src/routes/today.ts`, in the unread COLLECT
loop, replace the current text (~743-748):

```ts
        const ownerId = oneToOneContactId(conv);
        if (ownerId !== undefined && (await isDeletedContact(ownerId))) {
          skippedDeletedContacts.add(ownerId);
          continue;
        }
        const rowKey = unreadRowKeyOf(conv);
```

with:

```ts
        const ownerId = oneToOneContactId(conv);
        if (ownerId !== undefined && (await isDeletedContact(ownerId))) {
          skippedDeletedContacts.add(ownerId);
          continue;
        }
        // INACTIVE CONTACTS' UNKNOWN THREADS, ALSO BEFORE THE CAP
        // (unknown-inactive spec D5, plan ruling AR8). Cameron 2026-10-23:
        // Needs you now shows unread texts from an unknown contact that needs
        // review; "If it doesn't need review, meaning we've marked it as
        // inactive, it wouldn't show there ... It just shows in the inbox."
        // It sits HERE, beside the deleted-contact skip and ahead of the cap,
        // for the A9 reason above: Inactive threads that stay unread would
        // otherwise spend the TODAY_UNREAD_CAP slots and empty Needs you now
        // AND Unreplied. The rule is "skip Inactive", NOT "keep only
        // needs_review": team_member threads are `unknown_1to1` too and an
        // Active team member keeps today's row. It is limited to
        // `unknown_1to1`: an Inactive tenant/landlord/caseworker thread still
        // feeds Unreplied (tracker #31 owns that section). A thread whose
        // contact cannot be resolved keeps today's behavior. NO EXTRA READ:
        // `getContact` is memoized and isDeletedContact just read this id.
        if (
          conv.type === 'unknown_1to1' &&
          ownerId !== undefined &&
          (await getContact(ownerId))?.status === 'inactive'
        ) {
          continue;
        }
        const rowKey = unreadRowKeyOf(conv);
```

Nothing else in `today.ts` changes (no section, order, label or cap edit).

Step 4 - GREEN: the Step 2 command; the whole file passes (the existing
deleted-contact and cap tests included).

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/routes/today.ts app/test/todayApi.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(today): an Inactive contact's unknown thread leaves Needs you now (unknown-inactive D5)" -m "Skip in the unread collect loop, beside the deleted-contact skip and ahead of the cap; unknown_1to1 only, so Unreplied is unchanged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S3.4 Unknown-tab blocks: needs_review, then inactive (D9) - tests, comments, the pre-deploy cursor

Files:
- `app/src/lib/unknownQueue.ts` (comments only; S1 owns the import, type and order object)
- `app/src/routes/inbox.ts` (comments only)
- `app/test/unknownQueue.test.ts` (edit)
- `app/test/inboxUnknownTab.test.ts` (edit)
- `app/test/inboxUnknownParity.test.ts` (edit)
- `app/test/inbox.integration.test.ts` (edit)

The pre-deploy cursor, stated (spec D9): the decoder needs NO code change.
`b` is an ordinal into `UNKNOWN_QUEUE_BLOCKS`, which is still two blocks long,
so `b: 1` now names the `inactive` block. A pre-deploy cursor resuming INSIDE
the removed `active` block is `{q:1, b:1, k:{type:'unknown', status:'active',
contactId}}`; `decodeUnknownCursor` (`app/src/routes/inbox.ts` ~493-497,
`if (key['type'] !== block.type || key['status'] !== block.status)`) throws
`InboxBadRequestError('invalid cursor')` - a 400, once; reloading the inbox
recovers. A pre-deploy cursor at the START of block 1 (`{q:1, b:1}`, no `k`,
minted on a roll-over) resumes at the first page of the `inactive` block,
which is the right place. Block-0 cursors (`needs_review`) are unaffected.
S3.4 pins all three.

Step 1 - RED (state check: S1's order change already broke the old
expectations). Run:

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/unknownQueue.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/inbox.integration.test.ts
```

Expected failures - every one because a fixture seeds (unknown, active),
which no block reads now, or because a test names the old block:
- unknownQueue.test.ts: `reads the blocks in QUEUE ORDER ...` (no
  `c-unk-002`), `ROLLS OVER between blocks ...` (no `c-unk-003`),
  `an exhausted block that fills want exactly ...` (no `c-unk-002`),
  `the block statuses ARE statusAllowlistFor("unknown") ...` (blocks are
  `['needs_review', 'inactive']`).
- inboxUnknownTab.test.ts: `THE FULL WALK ...` (no `c-a*`),
  `rejects a FOREIGN cursor ...` (the "honest" `b:1` `active` cursor now
  rejects), `a page-head failure AFTER A BLOCK ROLL-OVER ...` (no `c-r4`),
  `sorts the triage rows on ONE page ...` (no `c-new`).
- inboxUnknownParity.test.ts: `class f: ...` (rows `[]`).
- inbox.integration.test.ts: `filter=unknown pages the REAL byTypeStatus
  index across a block boundary ...` (the reviewed rows missing).
If none of these fail, S1's order change is not in the tree: STOP (S3.1 Step
2 should have caught it).

Step 2 - flip `app/test/unknownQueue.test.ts`.

Edit A: replace

```ts
  it('reads the blocks in QUEUE ORDER - needs_review first, active second - and narrows on nothing else', async () => {
```

with

```ts
  it('reads the blocks in QUEUE ORDER - needs_review first, inactive second - and narrows on nothing else', async () => {
```

Edit B (replace_all): `{ status: 'active' })` -> `{ status: 'inactive' })`.
Exactly five occurrences, all `unk(n, { status: 'active' })` calls (~49, ~88,
~89, ~128, ~151). The tenant fixture at ~51
(`{ contactId: 'c-ten', type: 'tenant', phone: '+15550009000', status: 'active' },`)
does not match the pattern and stays. Check:
`grep -c "status: 'inactive' })" W:/tmp/unknown-inactive/app/test/unknownQueue.test.ts`
prints 5, and `grep -n "unk([0-9]*, { status: 'active' })" ...` prints nothing.

Edit C: replace

```ts
    // unreadIndexFake.ts:104-116). Plus ONE on the empty `active` block.
```

with

```ts
    // unreadIndexFake.ts:104-116). Plus ONE on the empty `inactive` block.
```

Edit D: replace

```ts
    // exhaustion here would strand every `active` row behind a null cursor.
```

with

```ts
    // exhaustion here would strand every `inactive` row behind a null cursor.
```

Edit E: replace the current text (~273-285):

```ts
  it('the block statuses ARE statusAllowlistFor("unknown") - the two cannot drift', () => {
    // The type alias on UNKNOWN_QUEUE_STATUS_ORDER pins it to
    // NON_TENANT_STATUSES at COMPILE time, which is the same array
    // statusAllowlistFor returns for `unknown`. This is the RUNTIME half: a
    // change made inside statusAllowlistFor (a special case for `unknown`, say)
    // would not move the alias, and a status legal for a contact but absent
    // from the blocks is a contact that silently never appears on the tab.
    const blockStatuses = [...new Set(UNKNOWN_QUEUE_BLOCKS.map((b) => String(b.status)))].sort();
    expect(blockStatuses).toEqual([...statusAllowlistFor('unknown')].sort());
    // And the ORDER decision covers exactly those, untriaged first.
    expect(Object.keys(UNKNOWN_QUEUE_STATUS_ORDER).sort()).toEqual(blockStatuses);
    expect(UNKNOWN_QUEUE_BLOCKS.map((b) => b.status)).toEqual(['needs_review', 'active']);
  });
```

with:

```ts
  it('the block statuses ARE statusAllowlistFor("unknown") - the two cannot drift', () => {
    // The type alias on UNKNOWN_QUEUE_STATUS_ORDER pins it to
    // UNKNOWN_STATUSES at COMPILE time, which is the same array
    // statusAllowlistFor returns for `unknown`. This is the RUNTIME half: a
    // change made inside statusAllowlistFor (a special case for `unknown`, say)
    // would not move the alias, and a status legal for a contact but absent
    // from the blocks is a contact that silently never appears on the tab.
    const blockStatuses = [...new Set(UNKNOWN_QUEUE_BLOCKS.map((b) => String(b.status)))].sort();
    expect(blockStatuses).toEqual([...statusAllowlistFor('unknown')].sort());
    // And the ORDER decision covers exactly those, untriaged first.
    expect(Object.keys(UNKNOWN_QUEUE_STATUS_ORDER).sort()).toEqual(blockStatuses);
    // unknown-inactive spec D9 (2026-10-23): needs_review, then inactive. The
    // `active` block is gone with `active` itself (spec D1).
    expect(UNKNOWN_QUEUE_BLOCKS.map((b) => b.status)).toEqual(['needs_review', 'inactive']);
  });
```

The two historical comments at ~55 and ~79 (`'active' < 'needs_review'`,
describing the pre-rework un-narrowed Query) stay as written: they describe
the old defect, not the current blocks.

Step 3 - flip `app/test/inboxUnknownTab.test.ts`.

Edit A: in `queueContact`, replace `  status: 'needs_review' | 'active',` with
`  status: 'needs_review' | 'inactive',`.

Edit B (replace_all): `, 'active', ` -> `, 'inactive', `. Exactly five
occurrences, all `queueContact(...)` calls (~212-214 `c-a0`..`c-a2`, ~678-679
`c-r3-broken`, `c-r4`). Check with
`grep -c "queueContact('c-[a-z0-9-]*', 'inactive'" W:/tmp/unknown-inactive/app/test/inboxUnknownTab.test.ts`
printing 5.

Edit C: replace

```ts
    // bounded Query per STATUS BLOCK (needs_review, then active) so a
    // (unknown, active) contact stays covered - coverage class f - while the
```

with

```ts
    // bounded Query per STATUS BLOCK (needs_review, then inactive) so a
    // (unknown, inactive) contact stays covered - coverage class f - while the
```

Edit D: replace

```ts
    // the `active` block. Before F1 that page came back empty with the cursor it
    // was sent and every remaining `active` row was unreachable from the UI.
```

with

```ts
    // the `inactive` block. Before F1 that page came back empty with the cursor
    // it was sent and every remaining later-block row was unreachable from the UI.
```

Edit E: replace

```ts
    // NOTE what this does NOT say: c-new is `active` and c-old is
```

with

```ts
    // NOTE what this does NOT say: c-new is `inactive` and c-old is
```

and replace

```ts
        { contactId: 'c-new', type: 'unknown', status: 'active', phone: '+15550002601' },
```

with

```ts
        { contactId: 'c-new', type: 'unknown', status: 'inactive', phone: '+15550002601' },
```

(This test pins the SERVER's per-page newest-first sort, which stays: the
Unknown-tab Needs-review-first order is the dashboard's, S5.)

Edit F (the pre-deploy cursor, D9): replace the current text (~344-350):

```ts
    const honest = Buffer.from(
      JSON.stringify({ q: 1, b: 1, k: { type: 'unknown', status: 'active', contactId: 'c-x' } }),
      'utf8',
    ).toString('base64url');
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25, cursor: honest }, deps),
    ).resolves.toMatchObject({ rows: [] });
```

with:

```ts
    const honest = Buffer.from(
      JSON.stringify({ q: 1, b: 1, k: { type: 'unknown', status: 'inactive', contactId: 'c-x' } }),
      'utf8',
    ).toString('base64url');
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25, cursor: honest }, deps),
    ).resolves.toMatchObject({ rows: [] });
    // A PRE-DEPLOY cursor (unknown-inactive spec D9): minted INSIDE the removed
    // `active` block, it no longer agrees with block 1 (`inactive`), so it is a
    // 400 - once; reloading the inbox recovers. Never a wrong-partition Query.
    const preDeploy = Buffer.from(
      JSON.stringify({ q: 1, b: 1, k: { type: 'unknown', status: 'active', contactId: 'c-x' } }),
      'utf8',
    ).toString('base64url');
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25, cursor: preDeploy }, deps),
    ).rejects.toBeInstanceOf(InboxBadRequestError);
    // ...while a pre-deploy cursor at the START of block 1 (no `k`, minted on a
    // roll-over) resumes at the first page of the inactive block - the right place.
    const preDeployBlockStart = Buffer.from(JSON.stringify({ q: 1, b: 1 }), 'utf8').toString('base64url');
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25, cursor: preDeployBlockStart }, deps),
    ).resolves.toMatchObject({ rows: [] });
```

The tamper case `'k.status contradicting the block'` at ~323
(`{ q: 1, b: 0, k: { type: 'unknown', status: 'active', contactId: 'a1' } }`)
stays: it is still a contradiction with block 0.

Step 4 - flip `app/test/inboxUnknownParity.test.ts` class f. Replace:

```ts
  it('class f: a (type=unknown, status=active) contact is a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-active', type: 'unknown', status: 'active', phone: '+15550001002' }],
      conversations: [conv({ conversationId: 'cv-active', participant_phone: '+15550001002', last_activity_at: '2026-06-12T09:00:00.000Z' })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-active']);
  });
```

with:

```ts
  // FLIP (unknown-inactive, 2026-10-23): class f was (unknown, active). `active`
  // is no longer legal for an unknown contact (spec D1) and its block is gone;
  // the reviewed-but-untyped class is now (unknown, inactive), read in the
  // second block - still on the tab.
  it('class f: a (type=unknown, status=inactive) contact is a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-inactive', type: 'unknown', status: 'inactive', phone: '+15550001002' }],
      conversations: [conv({ conversationId: 'cv-inactive', participant_phone: '+15550001002', last_activity_at: '2026-06-12T09:00:00.000Z' })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-inactive']);
  });
```

Step 5 - flip `app/test/inbox.integration.test.ts`. Replace

```ts
        status: untriaged.includes(contactId) ? 'needs_review' : 'active',
```

with

```ts
        status: untriaged.includes(contactId) ? 'needs_review' : 'inactive',
```

Step 6 - comments in `app/src/lib/unknownQueue.ts` (no code change). First
re-read lines 1-212: S1 changed the import, the type alias and the order
object; keep S1's code exactly.

Edit A: replace the current header text (~48-72), from the line that starts
`//   NOW COPIED, and this is the reworked half` through the line
`//   one it is simply the SECOND block, read after the untriaged one is drained.`,
i.e.:

```ts
//   NOW COPIED, and this is the reworked half - `status` NARROWING. The reader
//   issues one bounded Query PER STATUS BLOCK, in the order
//   UNKNOWN_QUEUE_BLOCKS declares. COVERAGE DOES NOT NARROW: every legal status
//   is a block and every block is read, so a live (unknown, active) contact -
//   coverage class f - is still on the tab exactly as before. Only the ORDER
//   changed. The old file said "NOT COPIED - status: 'needs_review'" because
//   narrowing to ONE status would have dropped class f; narrowing to a
//   PARTITION OF ALL of them drops nothing.
//
//   WHAT MANUFACTURES (unknown, active) AT ALL (round-2 finding N3): the
//   STATUS-ONLY triage PATCH. PATCH /api/contacts/:id handles
//   `'status' in patch && !('type' in patch)` and re-validates against
//   statusAllowlistFor(stored.type), which for `unknown` is
//   ['needs_review','active'] - and the dashboard's edit form reaches it. An
//   operator can therefore mark an unknown contact `active` while it stays
//   type='unknown': it leaves Today's triage block (which DOES narrow on
//   needs_review) but it NEVER leaves this queue. Only a RE-TYPE - to ANY other
//   ContactType, team_member included - or a SOFT-DELETE drains a row. It is
//   also the only UI-REACHABLE manufacturer: POST /api/contacts defaults an
//   `unknown` create to status 'active' but that is API-ONLY (KindPicker,
//   dashboard/src/routes/contact/KindPicker.tsx, offers no `unknown` segment),
//   which is why both deployed environments measure ZERO (unknown, active)
//   today. Under the OLD reader that population was a starvation hazard,
//   because `active` sorted first and crowded out the front door. Under this
//   one it is simply the SECOND block, read after the untriaged one is drained.
```

with:

```ts
//   NOW COPIED, and this is the reworked half - `status` NARROWING. The reader
//   issues one bounded Query PER STATUS BLOCK, in the order
//   UNKNOWN_QUEUE_BLOCKS declares. COVERAGE DOES NOT NARROW: every legal status
//   is a block and every block is read, so a live (unknown, inactive) contact -
//   coverage class f - is on the tab exactly like an untriaged one, just read
//   later. Only the ORDER changed. The old file said "NOT COPIED - status:
//   'needs_review'" because narrowing to ONE status would have dropped class f;
//   narrowing to a PARTITION OF ALL of them drops nothing.
//
//   THE SECOND BLOCK IS `inactive`, NOT `active` (unknown-inactive spec D1/D9,
//   docs/superpowers/specs/2026-10-23-unknown-inactive-design.md, approved by
//   Cameron 2026-10-23). `active` is no longer legal for an unknown contact:
//   statusAllowlistFor('unknown') is ['needs_review', 'inactive'] and every
//   writer refuses (unknown, active), so its block is gone. Staff mark an
//   unknown contact Inactive WITHOUT choosing a type - from the contact page
//   header or the edit form; both validate against
//   statusAllowlistFor(stored.type). The contact leaves Today's Needs you now
//   (the triage pass reads only needs_review, and the unread pass skips an
//   Inactive contact's unknown_1to1 thread) but it NEVER leaves this queue:
//   only a RE-TYPE - to ANY other ContactType, team_member included - or a
//   SOFT-DELETE drains a row. The read-only count on 2026-10-23 found ZERO
//   (unknown, active) contacts on dev and on prod, so no stored row is
//   stranded by the removed block (the rollout re-counts just before deploy).
//   Under the pre-rework reader the reviewed population was a starvation
//   hazard, because it sorted first and crowded out the front door. Under this
//   one it is simply the SECOND block, read after the untriaged one is drained.
//
//   AN OLD CURSOR. `b` is an ordinal into the DERIVED block list, so a
//   pre-deploy cursor resuming INSIDE the removed `active` block (b=1,
//   k.status='active') no longer agrees with block 1 (`inactive`) and
//   inbox.ts's decodeUnknownCursor answers 400 - once; reloading the inbox
//   recovers. A cursor at the START of block 1 (no `k`) resumes at the first
//   page of the inactive block, which is the right place.
```

Edit B: in the docblock above `type UnknownQueueStatus` (~155-162), if it
still says `Taken from` + `NON_TENANT_STATUSES`, replace

```ts
 * The statuses a `type='unknown'` contact may legally carry. Taken from
 * NON_TENANT_STATUSES, which is what `statusAllowlistFor('unknown')` returns -
```

with

```ts
 * The statuses a `type='unknown'` contact may legally carry. Taken from
 * UNKNOWN_STATUSES, which is what `statusAllowlistFor('unknown')` returns -
```

(If S1 already made this edit, leave it.)

Edit C: in the `UNKNOWN_QUEUE_STATUS_ORDER` docblock, replace

```ts
 * rather than merely unlikely: the untriaged block is EXHAUSTED before the
 * `active` block's first Query is issued.
```

with

```ts
 * rather than merely unlikely: the untriaged block is EXHAUSTED before the
 * `inactive` block's first Query is issued (the `active` block it replaced was
 * removed 2026-10-23 with `active` itself, unknown-inactive spec D1/D9).
```

Edit D: in the `UNKNOWN_QUEUE_BLOCKS` docblock, replace

```ts
 * way: anything that hard-codes "needs_review then active" outside this file
 * un-does the isolation.
```

with

```ts
 * way: anything that hard-codes "needs_review then inactive" outside this file
 * un-does the isolation.
```

Check: `grep -n "active" W:/tmp/unknown-inactive/app/src/lib/unknownQueue.ts | grep -v "inactive\|activity"`
prints only the historical sentences in Edit A's replacement and the
pre-rework sentence at ~15-18 (`'active' < 'needs_review'`).

Step 7 - comments in `app/src/routes/inbox.ts` (no code change).

Edit A: replace the current text (~1814-1820):

```ts
  // THIS READ IS PAGED AND UNBOUNDED (human ruling 2026-08-26). It issues one
  // bounded Query per STATUS BLOCK, in the order UNKNOWN_QUEUE_BLOCKS declares
  // - `needs_review` first, then `active` - and pages with the index's own
  // cursor, rolling from one block to the next when a block exhausts. Coverage
  // is UNCHANGED: both blocks are read, so a live (unknown, active) contact,
  // coverage class f, is still on the tab. Only the ORDER changed, and the
  // trade it buys is stated plainly at the per-page sort below.
```

with:

```ts
  // THIS READ IS PAGED AND UNBOUNDED (human ruling 2026-08-26). It issues one
  // bounded Query per STATUS BLOCK, in the order UNKNOWN_QUEUE_BLOCKS declares
  // - `needs_review` first, then `inactive` (the `active` block was removed
  // 2026-10-23, unknown-inactive spec D9) - and pages with the index's own
  // cursor, rolling from one block to the next when a block exhausts. Coverage
  // is UNCHANGED: both blocks are read, so a live (unknown, inactive) contact,
  // coverage class f, is still on the tab. Only the ORDER changed, and the
  // trade it buys is stated plainly at the per-page sort below.
```

Edit B: replace the current text (~2022-2032):

```ts
        //   * 'needs_review' -> 'active' is the COMMON action (triage, from the
        //     dashboard's edit form). The row leaves the block behind the
        //     cursor and joins a block not yet read, so it ships on TWO pages.
        //     The dashboard keys the wire row by contactId (useInbox `rowKey`
        //     -> `c:<contactId>`), and its appendPage dedupes a loaded page by
        //     that key, so the second copy is DROPPED: the stale page-one copy
        //     (still showing Needs triage) silently wins until the next head
        //     read.
        //   * 'active' -> 'needs_review' (un-triage) is the RARE one and moves
        //     the row backward into a block already read, so it ships on NO
        //     page. INVISIBLE, and no guard here can see it.
```

with:

```ts
        //   * 'needs_review' -> 'inactive' is the COMMON action (marking an
        //     unknown contact Inactive from the contact page header or the
        //     edit form; before 2026-10-23 it was 'needs_review' -> 'active').
        //     The row leaves the block behind the cursor and joins a block not
        //     yet read, so it ships on TWO pages. The dashboard keys the wire
        //     row by contactId (useInbox `rowKey` -> `c:<contactId>`), and its
        //     appendPage dedupes a loaded page by that key, so the second copy
        //     is DROPPED: the stale page-one copy (still showing Needs triage)
        //     silently wins until the next head read.
        //   * 'inactive' -> 'needs_review' (un-triage) is the RARE one and
        //     moves the row backward into a block already read, so it ships on
        //     NO page. INVISIBLE, and no guard here can see it.
```

Edit C (the superseded ruling, spec D9): replace the current text (~2282-2309),
from `    // A PER-PAGE SORT, and that is the accepted trade rather than an oversight.`
through `    // different questions, and this one is settled.`, i.e.:

```ts
    // A PER-PAGE SORT, and that is the accepted trade rather than an oversight.
    //
    // WHAT THE BLOCK ORDER ACTUALLY GOVERNS IS FETCH ORDER - which rows you
    // RETRIEVE first, and in what order they cross the wire. The untriaged
    // block is drained before the reviewed one is touched, so a walk reaches
    // every `needs_review` row before any `active` one, and that is what makes
    // starvation structurally impossible. This sort then makes each page read
    // naturally top-to-bottom. Page 2 can contain a row NEWER than anything on
    // page 1, which is exactly what "page in queue order" means and what the
    // 2026-08-26 ruling chose: a triage queue's job is that nothing rots
    // unseen, and recency is what the All and Unread tabs are for.
    //
    // IT IS NOT THE ORDER THE OPERATOR SEES, and this comment used to claim it
    // was ("the TOTAL order across pages is QUEUE order"). Corrected 2026-08-26
    // (rework review B1a): the dashboard accumulates every page into one array
    // and sorts the WHOLE accumulation newest-first, with no filter gate
    // (dashboard/src/routes/inbox/useInbox.ts, `sortByActivity` over `visible`)
    // - so the moment the operator clicks Load more, page 2's reviewed rows can
    // sit above page 1's untriaged ones on screen. Untriaged-first is a
    // property of the FETCH, and of any single page, not of the rendered list.
    // RULED 2026-08-26: LEAVE IT. The client keeps re-sorting the accumulation
    // for every filter, this branch included. So what the operator SEES is
    // "newest of whatever has been fetched so far", and what untriaged-first
    // buys is FETCH PRIORITY - the untriaged block is drained before a single
    // Query is spent on the reviewed one, so no amount of reviewed backlog can
    // delay an untriaged row's retrieval. That is the property the ruling
    // wanted; the display order was never the point. Do NOT "fix" either side
    // unilaterally on the theory that the two sorts disagree - they answer
    // different questions, and this one is settled.
```

with:

```ts
    // A PER-PAGE SORT, and that is the accepted trade rather than an oversight.
    //
    // WHAT THE BLOCK ORDER ACTUALLY GOVERNS IS FETCH ORDER - which rows you
    // RETRIEVE first, and in what order they cross the wire. The untriaged
    // block is drained before the Inactive one is touched, so a walk reaches
    // every `needs_review` row before any `inactive` one, and that is what
    // makes starvation structurally impossible: no amount of Inactive backlog
    // can delay an untriaged row's retrieval. This sort then makes each page
    // read naturally top-to-bottom. Page 2 can contain a row NEWER than
    // anything on page 1, which is exactly what "page in queue order" means.
    //
    // IT IS NOT THE ORDER THE OPERATOR SEES: the dashboard accumulates every
    // page into one array and sorts the accumulation itself
    // (dashboard/src/routes/inbox/useInbox.ts), so this per-page order never
    // reaches the screen as such.
    //
    // SUPERSEDED 2026-10-23. The 2026-08-26 ruling recorded here ("RULED
    // 2026-08-26: LEAVE IT" - the client re-sorted the whole accumulation
    // newest-first for every filter, this one included, and "Do NOT 'fix'
    // either side") is replaced by Cameron's decision for tracker #30
    // (unknown-inactive spec D9,
    // docs/superpowers/specs/2026-10-23-unknown-inactive-design.md): on the
    // Unknown tab "it should be ordered by needs review first and then by
    // newest message", and "let's not do sorting server- and database-side
    // for now ... we can do that browser-side." So the DASHBOARD, on the
    // Unknown tab only, sorts every loaded row Needs review first, then
    // Inactive, each newest message first (`compareUnknownTabRows`,
    // dashboard/src/routes/inbox/inboxListMerge.ts); every other tab keeps
    // newest-first. THIS server sort is deliberately UNCHANGED - per page,
    // newest first, with fetch priority from the block order - because the
    // decision keeps ordering browser-side. Do not add a status sort here.
```

The paragraph that follows (`    // Global newest-first is not impossible, it is just not free: ...` through
`    // it lands, UNKNOWN_QUEUE_BLOCKS is the one thing that has to change.`) and
the `unknownRows.sort(...)` call stay exactly as they are.

ASCII check on the edited pre-existing files (inbox.ts carries non-ASCII
elsewhere):

```
git -C W:/tmp/unknown-inactive diff -U0 -- app/src/routes/inbox.ts app/src/lib/unknownQueue.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```

prints 0.

Step 8 - GREEN: the Step 1 command; all four files pass (the integration
file needs DynamoDB Local).

Step 9 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/lib/unknownQueue.ts app/src/routes/inbox.ts app/test/unknownQueue.test.ts app/test/inboxUnknownTab.test.ts app/test/inboxUnknownParity.test.ts app/test/inbox.integration.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(inbox): Unknown-tab blocks are needs_review then inactive (unknown-inactive D9)" -m "Flips the (unknown, active) fixtures to inactive, pins the pre-deploy cursor (400 inside the removed block, block-start resumes), and records Cameron's 2026-10-23 supersession of the 2026-08-26 LEAVE IT ruling." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S3.5 Inbox rows: `inactive: true`, no triage chip (D9, AR5) + inbound no-reset (W4)

Files:
- `app/src/routes/inbox.ts` (edit: `InboxRow` interface, `buildContactRow`)
- `app/test/inboxInactive.test.ts` (NEW)
- `app/test/twilioSmsWebhook.test.ts` (edit, W4 pin)
- `app/test/founderTriage.test.ts` (edit, W4 pin)

Step 1 - the failing tests.

Create `app/test/inboxInactive.test.ts` (the deps are the
`inboxUnknownParity.test.ts` deps, plus an empty `getDisplaysByIds`, the
method the roster-name batch calls - `inboxUnreadParity.test.ts` carries it
for the same reason):

```ts
// app/test/inboxInactive.test.ts
//
// unknown-inactive spec D9 / plan ruling AR5 (tracker #30, 2026-10-23): a
// contact row whose contact's status is `inactive` - any type, any filter -
// carries `inactive: true` and never the Needs triage chip (`needsTriage:
// false`). A Needs review unknown, an Active team member and a contactless
// number keep today's chip and carry NO `inactive` field. The deps are copied
// from test/inboxUnknownParity.test.ts, plus the empty getDisplaysByIds that
// test/inboxUnreadParity.test.ts carries for the roster-name batch.
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps } from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface World {
  contacts: ContactItem[];
  conversations: ConversationItem[];
  latestMessage?: Record<string, Partial<MessageItem>>;
}

function conv(
  over: Partial<ConversationItem> & { conversationId: string; last_activity_at: string },
): ConversationItem {
  return {
    status: 'open',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00.000Z',
    ...unreadFlagFor(over),
    ...over,
  };
}

function makeDeps(world: World): InboxRouterDeps {
  return {
    conversationsRepo: {
      async getById(id: string) {
        return world.conversations.find((c) => c.conversationId === id);
      },
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        return queryUnreadPageFromItems(world.conversations, opts);
      },
      async listByLastActivity({ limit }: { status: string; limit?: number }) {
        const open = world.conversations
          .filter((c) => c.status === 'open')
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items: open.slice(0, limit ?? 50) };
      },
      async findByParticipantPhone(phone: string) {
        return world.conversations.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail(email: string) {
        return world.conversations.filter((c) => c.participant_email === email);
      },
      async listRelayGroups(status: string) {
        return {
          items: world.conversations.filter((c) => c.type === 'relay_group' && c.status === status),
          truncated: false,
        };
      },
      async listGroupTexts() {
        return { items: [], truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        return world.contacts.find((c) => c.phone === phone);
      },
      async findByEmail(email: string) {
        return world.contacts.find((c) => c.email === email);
      },
      async getById(contactId: string) {
        return world.contacts.find((c) => c.contactId === contactId);
      },
      async listByType(type: string, opts = {}) {
        return listByTypeFromContacts(world.contacts, type, opts);
      },
      async getDisplaysByIds() {
        return new Map();
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        const latest = world.latestMessage?.[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
}

const inactiveUnknownWorld = (): World => ({
  contacts: [{ contactId: 'c-off', type: 'unknown', status: 'inactive', phone: '+15550004001' }],
  conversations: [
    conv({ conversationId: 'cv-off', participant_phone: '+15550004001', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
  ],
  latestMessage: {
    'cv-off': { type: 'sms', direction: 'inbound', body: 'still looking', created_at: '2026-06-12T10:00:00.000Z' },
  },
});

describe('unknown-inactive D9 / AR5: Inactive contact rows', () => {
  it.each(['all', 'unread', 'unknown'] as const)(
    'RED: an Inactive unknown contact\'s unread inbound shows on filter=%s, unread, with needsTriage false and inactive true',
    async (filter) => {
      const page = await aggregateInbox({ filter, limit: 25 }, makeDeps(inactiveUnknownWorld()));
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        kind: 'contact',
        contactId: 'c-off',
        role: 'unknown',
        unreadCount: 1,
        needsTriage: false,
        inactive: true,
      });
    },
  );

  it('RED: inactive is true for an Inactive TENANT and an Inactive CASEWORKER too (any type), with no triage chip', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-ten-off', type: 'tenant', status: 'inactive', phone: '+15550004002' },
        { contactId: 'c-cw-off', type: 'partner', status: 'inactive', phone: '+15550004003' },
      ],
      conversations: [
        conv({ conversationId: 'cv-ten-off', type: 'tenant_1to1', participant_phone: '+15550004002', last_activity_at: '2026-06-12T09:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-cw-off', type: 'partner_1to1', participant_phone: '+15550004003', last_activity_at: '2026-06-12T08:00:00.000Z' }),
      ],
    }));
    const byId = new Map(page.rows.map((r) => [r.contactId, r]));
    expect(byId.get('c-ten-off')).toMatchObject({ kind: 'contact', role: 'tenant', needsTriage: false, inactive: true });
    expect(byId.get('c-cw-off')).toMatchObject({ kind: 'contact', role: 'partner', needsTriage: false, inactive: true });
  });

  it('RED: an Inactive team member (role falls through to unknown) loses the chip and carries the tag; PIN: an Active team member keeps today\'s chip and no tag', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-tm-off', type: 'team_member', status: 'inactive', phone: '+15550004004' },
        { contactId: 'c-tm-on', type: 'team_member', status: 'active', phone: '+15550004005' },
      ],
      conversations: [
        conv({ conversationId: 'cv-tm-off', participant_phone: '+15550004004', last_activity_at: '2026-06-12T07:00:00.000Z' }),
        conv({ conversationId: 'cv-tm-on', participant_phone: '+15550004005', last_activity_at: '2026-06-12T06:00:00.000Z' }),
      ],
    }));
    const byId = new Map(page.rows.map((r) => [r.contactId, r]));
    expect(byId.get('c-tm-off')).toMatchObject({ role: 'unknown', needsTriage: false, inactive: true });
    expect(byId.get('c-tm-on')).toMatchObject({ role: 'unknown', needsTriage: true });
    expect(byId.get('c-tm-on')).not.toHaveProperty('inactive');
  });

  it('PIN: a Needs review unknown keeps needsTriage true and carries NO inactive field; a Parked landlord carries none either', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-nr', type: 'unknown', status: 'needs_review', phone: '+15550004006' },
        { contactId: 'c-ll-parked', type: 'landlord', status: 'parked', phone: '+15550004007' },
      ],
      conversations: [
        conv({ conversationId: 'cv-nr', participant_phone: '+15550004006', last_activity_at: '2026-06-12T05:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-ll-parked', type: 'landlord_1to1', participant_phone: '+15550004007', last_activity_at: '2026-06-12T04:00:00.000Z' }),
      ],
    }));
    const byId = new Map(page.rows.map((r) => [r.contactId, r]));
    expect(byId.get('c-nr')).toMatchObject({ role: 'unknown', needsTriage: true });
    expect(byId.get('c-nr')).not.toHaveProperty('inactive');
    expect(byId.get('c-ll-parked')).toMatchObject({ role: 'landlord', needsTriage: false });
    expect(byId.get('c-ll-parked')).not.toHaveProperty('inactive');
  });

  it.each(['all', 'unread'] as const)(
    'PIN: a CONTACTLESS unknown number keeps needsTriage true and never carries inactive (filter=%s)',
    async (filter) => {
      const page = await aggregateInbox({ filter, limit: 25 }, makeDeps({
        contacts: [],
        conversations: [
          conv({ conversationId: 'cv-noc', participant_phone: '+14049824979', last_activity_at: '2026-06-12T03:00:00.000Z', unread_count: 1 }),
        ],
      }));
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ kind: 'unknown', phone: '+14049824979', needsTriage: true });
      expect(page.rows[0]).not.toHaveProperty('inactive');
    },
  );
});
```

W4 pins. In `app/test/twilioSmsWebhook.test.ts`, inside the describe that
holds `'a contact with an UNRESOLVED type (unknown) also yields unknown_1to1'`
(the "conversation resolution" describe, ~471), insert the test below as its
LAST test - i.e. replace this current text at the end of that describe
(~527-530):

```ts
    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('unknown_1to1');
  });
});
```

with:

```ts
    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('unknown_1to1');
  });

  it('unknown-inactive D9 (W4): an inbound text to an EXISTING Inactive unknown contact leaves its status inactive - no stub, no reset', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-U-off', type: 'unknown', status: 'inactive', phone: TENANT_PHONE });

    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    expect(res.status).toBe(200);
    // The only contact is the pre-existing one, and its status survived the
    // whole inbound path (capture, the consent stamp, last-heard-from).
    expect(world.contacts).toHaveLength(1);
    expect(world.contacts[0]).toMatchObject({ contactId: 'contact-U-off', type: 'unknown', status: 'inactive' });
    const conv = [...world.conversations.values()][0]!;
    expect(conv.type).toBe('unknown_1to1');
    expect(conv.participants).toEqual([{ contactId: 'contact-U-off', phone: TENANT_PHONE }]);
  });
});
```

(If the Edit tool reports the 4-line anchor is not unique, extend it upward
by the line `    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());` and
the `world.contacts.push({ contactId: 'contact-U', ...` line above it.)

In `app/test/founderTriage.test.ts`, insert this test immediately BEFORE the
current line
`  it('the <Pause length> comes from the founder-editable OrgSettings preRingPauseSeconds', async () => {`
(it follows `'a KNOWN caller is never re-captured ...'` and reuses that
file's `createFakeWorld`, `founderHarness`, `bizVoiceParams`, `CALLER`):

```ts
  it('unknown-inactive D9 (W4): an inbound call from an EXISTING Inactive unknown contact leaves its status inactive (the consent stamp writes consent only)', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-caller-off', type: 'unknown', status: 'inactive', phone: CALLER });
    const { app } = founderHarness(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);

    expect(world.contacts).toHaveLength(1);
    expect(world.contacts[0]).toMatchObject({
      contactId: 'c-caller-off',
      type: 'unknown',
      status: 'inactive',
      consent_method: 'inbound_call',
    });
    const conv = [...world.conversations.values()].find((c) => c.participant_phone === CALLER);
    expect(conv?.participants).toEqual([{ contactId: 'c-caller-off', phone: CALLER }]);
    expect(world.auditEvents).toEqual([]);
  });

```

The two W4 cases are PINs (green on unchanged code). They prove spec D9's
"no inbound writer moves an existing contact back to Needs review". The
code reading behind them, for the slice report:
- `app/src/services/contactCapture.ts:22-24, 103-117`: the only contact
  write is `createIfAbsent` on a NEW id (`attribute_not_exists(contactId)`,
  `app/src/repos/contactsRepo.ts` ~1472); an existing contact is returned
  as-is.
- `app/src/services/groupMembers.ts` ~112, ~155: creates
  `(unknown, needs_review)` stubs through `createIfAbsent` only.
- `app/src/services/groupConvert.ts` ~311-351, ~471: a known member gets
  `stampGroupParticipation`, which is `SET group_participation_at = :at`
  only (`contactsRepo.ts` ~1908); an unknown one gets a `createIfAbsent` stub.
- `app/src/routes/public.ts` ~526-533: "A live holder (any type) is an
  EXISTING contact and is never changed by a sign-up (no name, type, status,
  ...)"; the create at ~594 is for a NEW tenant; the update at ~661
  (`housing_fair_welcomed: true`) runs only `if (isNew)`.
- `app/src/routes/webhooks/twilio.ts` ~1210 and ~1251, and
  `app/src/routes/webhooks/voice.ts` ~727: `contacts.update(..., {
  consent_method, consent_at })` only.
None touches an existing contact's `status`. If the builder finds any writer
that does, STOP and report (plan W4).

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/inboxInactive.test.ts test/twilioSmsWebhook.test.ts test/founderTriage.test.ts
```

Expected failures, and only these: the three `RED: an Inactive unknown
contact's unread inbound shows on filter=...` cases (received
`needsTriage: true`, no `inactive`), `RED: inactive is true for an Inactive
TENANT ...` (no `inactive`), `RED: an Inactive team member ...` (received
`needsTriage: true`, no `inactive`). The PIN cases in the new file and both
W4 pins pass. If `filter=unknown` returns NO row, S1's inactive block is not
in the tree - STOP.

Step 3 - implementation in `app/src/routes/inbox.ts`.

Edit A (the wire type, AR5). Replace

```ts
  needsTriage: boolean; // true for untriaged unknowns; ALWAYS false for relay_group
```

with

```ts
  needsTriage: boolean; // true for untriaged unknowns (never for an Inactive contact); ALWAYS false for relay_group
```

and replace

```ts
  deleted?: boolean;
  // --- multi-party rows (relay_group AND group_text) ---------------------------
```

with

```ts
  deleted?: boolean;
  /** unknown-inactive spec D9 / plan ruling AR5: present and `true` ONLY on a
   *  contact row whose contact's status is `inactive` - any type, any filter -
   *  and the dashboard renders a muted "Inactive" tag. Absent otherwise, and
   *  never on a contactless number row, a relay_group row or a group_text row
   *  (the `deleted?: boolean` convention above). */
  inactive?: boolean;
  // --- multi-party rows (relay_group AND group_text) ---------------------------
```

Edit B (the one contact-row builder, `buildContactRow`, which the `all`
pager, the unread branch and the unknown branch all call). Replace

```ts
      lastActivityAt: maxConv.last_activity_at,
      needsTriage: role === 'unknown',
      ...(deleted && { deleted: true }),
    };
```

with

```ts
      lastActivityAt: maxConv.last_activity_at,
      // unknown-inactive D9 (AR5): an Inactive contact - any type - is not
      // waiting on triage, so it never carries the chip; it carries the
      // `inactive` tag instead. The literal `inactive` only: a landlord's own
      // `parked` is untouched. Contactless number rows (rowForConversation and
      // the unread branch's inline literal) keep `needsTriage: true`.
      needsTriage: role === 'unknown' && contact.status !== 'inactive',
      ...(deleted && { deleted: true }),
      ...(contact.status === 'inactive' && { inactive: true }),
    };
```

The two contactless literals (`rowForConversation` ~1165-1176 and the
unread branch ~1556-1567, both `kind: 'unknown'` with `needsTriage: true`),
`relayRowFor` (`needsTriage: false`, ~1288) and the group row (~1319) are NOT
changed. The `passesFilter` `'unknown'` arm (`return row.needsTriage;`, ~994)
is unreachable since the 2026-08-25 contact-side read (the unknown branch
returns first) and is NOT changed; the Unknown tab is built from the block
read, which serves Inactive rows regardless of the chip.

Step 4 - GREEN: the Step 2 command; all cases pass. Then the neighbouring
inbox suites, which must stay green with the new optional field:

```
cd W:/tmp/unknown-inactive/app; npx vitest run test/inboxApi.test.ts test/inboxFeed.test.ts test/inboxEmail.test.ts test/inboxGroups.test.ts test/inboxUnreadParity.test.ts test/inboxUnknownParity.test.ts test/inboxUnknownTab.test.ts
```

ASCII check:

```
git -C W:/tmp/unknown-inactive diff -U0 -- app/src/routes/inbox.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
tr -d '\11\12\15\40-\176' < W:/tmp/unknown-inactive/app/test/inboxInactive.test.ts | wc -c
```

Both print 0.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add app/src/routes/inbox.ts app/test/inboxInactive.test.ts app/test/twilioSmsWebhook.test.ts app/test/founderTriage.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(inbox): Inactive contact rows carry inactive:true and no triage chip (unknown-inactive D9)" -m "InboxRow gains inactive?: boolean on contact rows only; needsTriage is false for an inactive contact; contactless rows unchanged. Pins that an inbound text and call leave an existing Inactive contact inactive." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S3.6 Watch items W2 and W5 (records; one issue-body note)

Files:
- `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` (edit, AR14: the slice changed the block it describes)

Step 1 (W2). Read
`docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` in full.
Its reopen trigger: "escalate when the live unknown partition exceeds one
dashboard page (100 live rows with an open non-relay thread)". This slice
does not change the partition's SIZE: an Inactive unknown stays in the
`(type='unknown')` partition exactly as an Active one did, and only a re-type
or soft-delete drains a row. The last recorded measurements are 16 dev / 7
prod (2026-08-25) and 0 on the hermetic lean lane (2026-09-02). The builder
has no live access (never touch the live stack, never query dev/prod) and
does NOT re-measure. Record in the slice report: "W2: reopen trigger NOT met
on the recorded counts; not re-measured; this change renames the blocks and
does not grow the partition."

Step 2 (W2, AR14 body note). In that issue, replace the frontmatter line
`updated: 2026-09-25` with `updated: 2026-10-23`, and insert this paragraph
immediately BEFORE the paragraph whose first line starts
`**Problem.** The Unknown tab pages the`:

```
**Re-read 2026-10-23 (unknown-inactive, tracker #30).** The second block is
now `inactive`, not `active`: `active` is no longer legal for an unknown
contact (`docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` D1,
D9). The mechanism below is unchanged with the names swapped - the COMMON
action is now `needs_review -> inactive` (served on two pages; the
dashboard's `appendPage` drops the second copy, so the stale Needs-triage
copy wins until the next head read) and the RARE one `inactive ->
needs_review` (served on no page). Read `active` below as `inactive`. The
change does not grow the partition (an Inactive unknown stays in it exactly
as an Active one did), so the reopen trigger is NOT met on the recorded
counts; nobody re-measured. The dashboard's new Unknown-tab sort (Needs
review first, then Inactive, each newest first, browser-side) orders what is
loaded and changes nothing about which rows a walk serves.

```

ASCII check: `git -C W:/tmp/unknown-inactive diff -U0 -- docs/issues/unknown-queue-status-flip-duplicates-across-pages.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints 0.

Step 3 (W5). Record in the slice report, after re-reading the cited lines:
- `app/src/services/audienceResolution.ts` is UNCHANGED: it walks only
  `BLAST_TENANT_STATUSES` (`['searching', 'onboarding']`,
  `app/src/lib/blastAudienceRules.ts:22`) tenant partitions
  (`audienceResolution.ts` ~168-194); no partner, team_member or unknown
  status is ever read.
- `app/src/jobs/extraction.ts` is UNCHANGED: `toProfile` passes the stored
  status to the AI profile (~147-148); landlord, partner and team_member are
  skipped as ineligible (~457); a tenant or unknown contact is extracted
  whatever its status (spec section 3: AI is not suppressed for Inactive). A
  proposed status for an UNKNOWN contact cannot land: `status` is a
  `TENANT_ONLY_TARGETS` target (`app/src/services/extraction/runTypes.ts:28-30`),
  so a non-tenant accept is refused `409 suggestion_contact_not_tenant`
  before the claim (`app/src/services/suggestionResolution.ts` ~820-826), and
  behind it the allowlist check (~297-299) refuses `active` for `unknown`
  since S1 (400 `invalid_suggestion_value`).
- `app/scripts/measure-unread-contact-coverage.ts` (spec section 4, check
  only): `--no-status-narrow` reads the whole `type=unknown` partition, so it
  still counts Inactive rows for the W2 trigger; its comment at ~661-664
  about the `active` create default is S1's D6 surface, not S3's - record
  it for the planner, do not edit it here.

Step 4 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add docs/issues/unknown-queue-status-flip-duplicates-across-pages.md
git -C W:/tmp/unknown-inactive commit -m "docs(issues): status-flip duplicates - the second Unknown-tab block is now inactive (unknown-inactive D9)" -m "Reopen trigger re-read 2026-10-23: not met on the recorded counts; the change renames the block and does not grow the partition." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S3.7 Slice report

Write `docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S3-report.md`
(ASCII, findings only, citing code by `file:line`). It records:
- W1 (S3.1 Step 1): the branch/worktree listing result and any #31 overlap.
- W2 (S3.6 Steps 1-2): trigger not met / not re-measured; the issue note.
- W4 (S3.5): the writer-by-writer reading and that no inbound writer touches
  an existing contact's status (or the STOP, if one does).
- W5 (S3.6 Step 3): audienceResolution and extraction unchanged, and why the
  AI cannot land `active` on an unknown contact; the measure-script comment
  left for the planner.
- The pre-deploy cursor behavior pinned in S3.4 (400 inside the removed
  block, block-start resumes).
- Whether `l-parked` was kept in the S3.2 followUps case.
- Anything the tree held that this section got wrong (anchor text that
  differed, a fixture that broke for another reason).

Check: `tr -d '\11\12\15\40-\176' < W:/tmp/unknown-inactive/docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S3-report.md | wc -c` prints 0.

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S3-report.md
git -C W:/tmp/unknown-inactive commit -m "docs(records): unknown-inactive S3 slice report (backend readers; W1, W2, W4, W5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S3 coverage

Spec section 4 surfaces covered:
- Readers: `app/src/lib/unknownQueue.ts` (block order comments; S1 owns the
  type and order object), `app/src/routes/inbox.ts` (Unknown-tab cursor
  decode - no code change, behavior pinned; block walk comments;
  `needsTriage`; the `inactive` wire field; the superseded ruling comment),
  `app/src/routes/today.ts` (the collect-loop skip),
  `app/src/lib/listingSendOutcome.ts` (+ `services/followUps.ts`,
  `routes/units.ts` consumers, unchanged and proved by test),
  `app/src/services/audienceResolution.ts` (watch, unchanged),
  `app/src/jobs/extraction.ts` (watch, unchanged),
  `app/scripts/measure-unread-contact-coverage.ts` (check only).
- Writers (watch items): `app/src/services/contactCapture.ts`,
  `groupMembers.ts`, `groupConvert.ts`, `app/src/routes/public.ts`, and the
  inbound text and call webhooks (no status reset, proved by test).

Spec section 5 tests covered: test 4 (all five cases; the cap case uses a
team member and a tenant as the live rows, see Contradictions 1), test 5
(backend half: All/Unread/Unknown rows, `needsTriage` false, `inactive` for
unknown, tenant, caseworker and team member, block order, inbound text and
call keep Inactive; the dashboard tag and sort are S5), test 6 (Inactive
caseworker ineligible in the unit rule, Follow up and listing-send; Active
caseworker eligible; Parked landlord unchanged).

Cross-slice notes for the planner:
- S5 must add `inactive?: boolean` to the dashboard's `InboxRow`
  (`dashboard/src/api/types.ts` ~3801, the wire mirror) with AR5's meaning,
  and must name the comparator `compareUnknownTabRows` in
  `dashboard/src/routes/inbox/inboxListMerge.ts` - the server comment
  rewritten in S3.4 cites that name.
- S1 vs S3.4: see Contradictions 2 (four test files red between S1 and S3.4).
- `app/src/routes/inbox.ts` is touched by S3 only (comments in S3.4, code in
  S3.5); `app/src/lib/unknownQueue.ts` by S1 (code) and S3.4 (comments).



## 8. S4 - Dashboard contact page (rulings AR2, AR7, AR9; spec D2, D3, D4.4, D8; test 7 except the inbox parts)

Depends on S1 (the backend `PARTNER_STATUSES`, `UNKNOWN_STATUSES`, their
label maps and `statusLabelFor` in `app/src/lib/statusModel.ts`, which the
S4.1 mirror test imports) and S2 (the transition route's
`409 { error: 'contact_type_changed' }`, which S4.3 handles). Re-read every
quoted anchor before editing: where an earlier slice changed a region, apply
S4's change on top of it.

Files S4 touches (and nothing else):

- `dashboard/src/api/types.ts` (the tenant-lifecycle comment and one new block
  after `LANDLORD_STATUS_LABELS`; S2 adds `ContactUpdatedEvent` near ~2065 and
  S5 adds `inactive` to `InboxRow` near ~3801 - different regions)
- `dashboard/src/api/endpoints.ts` (the `setTenantStatus` input type and two
  import names only)
- `dashboard/src/api/statusModel.test.ts`
- `dashboard/src/routes/contact/contactStatusMirror.test.ts` (new)
- `dashboard/src/routes/contact/format.ts`, `format.test.ts`
- `dashboard/src/ui/StatusBadge.tsx`, `StatusBadge.test.tsx`
- `dashboard/src/routes/contacts/ContactsList.tsx`, `ContactsList.test.tsx`
- `dashboard/src/routes/contact/ContactDetail.tsx`, `ContactDetail.test.tsx`
- `dashboard/src/routes/contact/ContactEditForm.tsx`, `ContactEditForm.test.tsx`
- `dashboard/src/routes/contact/UnknownFile.tsx`, `UnknownFile.test.tsx`

Check-only (read, record the result in the S4 report, do not edit):
`dashboard/src/ui/StatusMenu.tsx`, `dashboard/src/routes/contact/Card.tsx`,
`PartnerFile.tsx`, `TenantFile.tsx`, `LandlordFile.tsx` (see S4.6 Step 1).

### Contradictions and clarifications (read before S4.1)

Contradictions: none. Clarifications the code forced:

1. AR2 names `statusOptionsFor(type: string)` and
   `contactStatusLabelFor(type, status)` without a fallback contract. This
   slice gives both `type: string | undefined` (every caller passes
   `contact.type`, and `format.ts` already accepts `undefined`), and
   `contactStatusLabelFor` returns `string | undefined` (undefined for a
   status that is not on that type's list) so `format.ts` keeps its
   `humanize` fallback for off-list legacy values. The backend
   `statusLabelFor` returns the raw status instead; the mirror test compares
   the two only over legal values, where they agree.
2. One extra exported type, `ContactStatusValue` (the union of the four
   per-type status types), in `types.ts`. It replaces the
   `TenantStatus | LandlordStatus` casts in `ContactDetail.tsx`,
   `ContactEditForm.tsx` and the `setTenantStatus` input in `endpoints.ts`.
   Note that `PartnerStatus` and `UnknownStatus` values are already members
   of `TenantStatus | LandlordStatus`; the widening is for honesty, not for
   the compiler.
3. Porting on a type change TO tenant (spec D3 is silent): the form calls
   `setTenantStatus` when the shown status is not `onboarding` OR the porting
   box was changed (porting is only writable through the transition). With
   the box untouched and Onboarding kept, there is exactly one milestone, as
   D3 requires.
4. `Card.tsx` has no contact status class: `responseClass.inactive` is used
   only by `ListingDetail.tsx:103` (property `off_market`). Nothing to change.
5. `ContactsList.tsx` renders a toned `StatusBadge` for TENANT rows only;
   every other row's status is plain text (`styles.status`). S4 moves those
   rows onto the per-type label map but does NOT give landlord, partner,
   team member or unknown rows a toned badge (that would restyle every
   landlord row, which no decision asks for). So D4.4's muted colour shows
   on the contact page header and details, not on non-tenant list rows. The
   S4 report names this for the planner.

### Task S4.1 - the status mirror in api/types.ts and the cross-workspace drift guard

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/statusModel.test.ts`,
`dashboard/src/routes/contact/contactStatusMirror.test.ts` (new).

Confirmed: `app/src/lib/statusModel.ts` has no `import` statement at all
(main @916258ae), so the dashboard test can import it the way
`caseworkerRoleMirror.test.ts` imports `app/src/lib/caseworkers.js`. AR1 keeps
it import-free; if S1 added an import, STOP and report.

Step 1 - failing tests.

1a. `dashboard/src/api/statusModel.test.ts`. Edit the import block. Current
text:

```
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  LOST_REASON_CATEGORIES,
  LOST_REASON_CATEGORY_LABELS,
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  formatLostReason,
} from './index.js';
```

Replacement:

```
import {
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  LOST_REASON_CATEGORIES,
  LOST_REASON_CATEGORY_LABELS,
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS,
  contactStatusLabelFor,
  formatLostReason,
  statusOptionsFor,
} from './index.js';
```

Then, in the same file, current text:

```
  it('every lost-reason category has a label', () => {
```

Replacement (insert the new case ABOVE it):

```
  it('every landlord, partner / team member and unknown status has a label (spec 2026-10-23 D1)', () => {
    for (const s of LANDLORD_STATUSES) expect(LANDLORD_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(LANDLORD_STATUS_LABELS)).toHaveLength(LANDLORD_STATUSES.length);
    for (const s of PARTNER_STATUSES) expect(PARTNER_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(PARTNER_STATUS_LABELS)).toHaveLength(PARTNER_STATUSES.length);
    for (const s of UNKNOWN_STATUSES) expect(UNKNOWN_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(UNKNOWN_STATUS_LABELS)).toHaveLength(UNKNOWN_STATUSES.length);
  });

  it('every lost-reason category has a label', () => {
```

Then append at the END of the file (after the `formatLostReason` describe):

```

// Spec 2026-10-23 D1/D3: the ONE per-type list the header dropdown and the
// edit form both read.
describe('statusOptionsFor / contactStatusLabelFor (spec 2026-10-23 D1)', () => {
  it.each([
    ['tenant', ['Needs review', 'Onboarding', 'Searching', 'Placing', 'Placed', 'On hold', 'Inactive']],
    ['landlord', ['Needs review', 'Interested', 'Onboarding', 'Active', 'Parked']],
    ['partner', ['Needs review', 'Active', 'Inactive']],
    ['team_member', ['Needs review', 'Active', 'Inactive']],
    ['unknown', ['Needs review', 'Inactive']],
  ] as const)('a %s offers exactly its D1 list, in dropdown order', (type, labels) => {
    expect(statusOptionsFor(type).map((o) => o.label)).toEqual(labels);
  });

  it('values are the stored keys; unknown has no Active', () => {
    expect(statusOptionsFor('partner').map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
    expect(statusOptionsFor('unknown').map((o) => o.value)).toEqual(['needs_review', 'inactive']);
  });

  it('an unset or unrecognized type gets the partner / team member list (the server fallback)', () => {
    expect(statusOptionsFor(undefined).map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
    expect(statusOptionsFor('something_new').map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
  });

  it("labels a status from its own type's map and returns undefined off that list", () => {
    expect(contactStatusLabelFor('partner', 'inactive')).toBe('Inactive');
    expect(contactStatusLabelFor('team_member', 'active')).toBe('Active');
    expect(contactStatusLabelFor('unknown', 'needs_review')).toBe('Needs review');
    expect(contactStatusLabelFor('landlord', 'parked')).toBe('Parked');
    expect(contactStatusLabelFor('tenant', 'on_hold')).toBe('On hold');
    expect(contactStatusLabelFor('unknown', 'active')).toBeUndefined();
    expect(contactStatusLabelFor('landlord', 'on_hold')).toBeUndefined();
    // An inherited object key is not a label.
    expect(contactStatusLabelFor('tenant', 'constructor')).toBeUndefined();
  });
});
```

1b. New file `dashboard/src/routes/contact/contactStatusMirror.test.ts`:

```
// Cross-workspace contact-status MIRROR DRIFT GUARD (spec 2026-10-23 D1, D3;
// plan ruling AR2).
//
// api/types.ts HAND-COPIES the per-type contact status lists and labels from
// app/src/lib/statusModel.ts (the dashboard is a separate package and cannot
// import app code at runtime). The contact page header dropdown and the Edit
// contact details Status field both read the dashboard copy, so a status the
// server accepts that the dashboard does not offer - or one the dashboard
// offers that the server refuses - is exactly the drift D3 exists to remove.
//
// MECHANISM: the caseworkerRoleMirror.test.ts one - import both copies and
// compare. The app module is a LEAF with no imports at all (plan ruling AR1
// keeps it that way), so the dashboard typecheck compiles one app file and
// never the repos, adapters or lib/config.ts. Import nothing else from app/
// here.
import { describe, expect, it } from 'vitest';
import {
  LANDLORD_STATUSES as APP_LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS as APP_LANDLORD_STATUS_LABELS,
  PARTNER_STATUSES as APP_PARTNER_STATUSES,
  PARTNER_STATUS_LABELS as APP_PARTNER_STATUS_LABELS,
  TENANT_STATUSES as APP_TENANT_STATUSES,
  TENANT_STATUS_LABELS as APP_TENANT_STATUS_LABELS,
  UNKNOWN_STATUSES as APP_UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS as APP_UNKNOWN_STATUS_LABELS,
  statusAllowlistFor,
  statusLabelFor,
} from '../../../../app/src/lib/statusModel.js';
import {
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS,
  contactStatusLabelFor,
  statusOptionsFor,
} from '../../api/types.js';

/** Every contact type, plus the unset type both sides must treat alike. */
const TYPES = ['tenant', 'landlord', 'partner', 'team_member', 'unknown', undefined] as const;

describe('dashboard contact status lists mirror app/src/lib/statusModel.ts', () => {
  it('each list constant is identical, in order', () => {
    expect([...TENANT_STATUSES]).toEqual([...APP_TENANT_STATUSES]);
    expect([...LANDLORD_STATUSES]).toEqual([...APP_LANDLORD_STATUSES]);
    expect([...PARTNER_STATUSES]).toEqual([...APP_PARTNER_STATUSES]);
    expect([...UNKNOWN_STATUSES]).toEqual([...APP_UNKNOWN_STATUSES]);
  });

  it('each label map is identical', () => {
    expect(TENANT_STATUS_LABELS).toEqual(APP_TENANT_STATUS_LABELS);
    expect(LANDLORD_STATUS_LABELS).toEqual(APP_LANDLORD_STATUS_LABELS);
    expect(PARTNER_STATUS_LABELS).toEqual(APP_PARTNER_STATUS_LABELS);
    expect(UNKNOWN_STATUS_LABELS).toEqual(APP_UNKNOWN_STATUS_LABELS);
  });

  it.each(TYPES.map((type) => [type]))('statusOptionsFor(%s) offers exactly the server allowlist, in order', (type) => {
    expect(statusOptionsFor(type).map((o) => o.value)).toEqual([...statusAllowlistFor(type)]);
  });

  it.each(TYPES.map((type) => [type]))('every %s option carries the server label', (type) => {
    for (const { value, label } of statusOptionsFor(type)) {
      expect(label).toBe(statusLabelFor(type, value));
      expect(contactStatusLabelFor(type, value)).toBe(statusLabelFor(type, value));
    }
  });

  it('does not compare empty lists (the D1 floor)', () => {
    expect(statusOptionsFor('unknown').map((o) => o.value)).toEqual(['needs_review', 'inactive']);
    expect(statusOptionsFor('partner').map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
  });
});
```

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/api/statusModel.test.ts src/routes/contact/contactStatusMirror.test.ts
```

Expected: the new statusModel cases fail with `TypeError` (`PARTNER_STATUSES`
is not iterable / `statusOptionsFor is not a function` - the dashboard does
not export them yet); the mirror file fails the same way on its dashboard
imports (its app imports resolve, because S1 landed them; if an APP import is
undefined, S1 is missing - STOP). The pre-existing statusModel cases stay
green.

Step 3 - implementation, `dashboard/src/api/types.ts`.

Edit A. Current text:

```
// --- Tenant lifecycle (coarse) ----------------------------------------------
// The values a TENANT contact's single `status` field holds. Non-tenant
// contacts use needs_review|active instead. `porting` is a SEPARATE boolean
// flag on the tenant, never a status value.
```

Replacement:

```
// --- Tenant lifecycle (coarse) ----------------------------------------------
// The values a TENANT contact's single `status` field holds. Every other type
// has its own list below (LANDLORD_STATUSES; PARTNER_STATUSES for partner and
// team_member; UNKNOWN_STATUSES). `porting` is a SEPARATE boolean flag on the
// tenant, never a status value.
```

Edit B. Current text:

```
  active: 'Active',
  parked: 'Parked',
};

// --- Property lifecycle (coarse, mostly derived) -----------------------------
```

Replacement:

```
  active: 'Active',
  parked: 'Parked',
};

// --- Partner / team member and unknown statuses -----------------------------
// MIRRORS app/src/lib/statusModel.ts PARTNER_STATUSES / UNKNOWN_STATUSES and
// their label maps (spec 2026-10-23 D1; pinned by
// routes/contact/contactStatusMirror.test.ts). A partner (caseworker) and a
// team member carry needs_review | active | inactive; an unknown contact
// carries needs_review | inactive - it has no Active.
export const PARTNER_STATUSES = ['needs_review', 'active', 'inactive'] as const;

export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const PARTNER_STATUS_LABELS: Readonly<Record<PartnerStatus, string>> = {
  needs_review: 'Needs review',
  active: 'Active',
  inactive: 'Inactive',
};

export const UNKNOWN_STATUSES = ['needs_review', 'inactive'] as const;

export type UnknownStatus = (typeof UNKNOWN_STATUSES)[number];

export const UNKNOWN_STATUS_LABELS: Readonly<Record<UnknownStatus, string>> = {
  needs_review: 'Needs review',
  inactive: 'Inactive',
};

/** Any value a contact's single `status` field can hold, across every type. */
export type ContactStatusValue = TenantStatus | LandlordStatus | PartnerStatus | UnknownStatus;

/** The list + label map for a type - the SAME branching as the backend
 *  statusAllowlistFor: tenant, landlord and unknown explicitly, every other
 *  (or unset) type the partner / team member list. */
function contactStatusListFor(type: string | undefined): {
  values: readonly string[];
  labels: Readonly<Record<string, string>>;
} {
  if (type === 'tenant') return { values: TENANT_STATUSES, labels: TENANT_STATUS_LABELS };
  if (type === 'landlord') return { values: LANDLORD_STATUSES, labels: LANDLORD_STATUS_LABELS };
  if (type === 'unknown') return { values: UNKNOWN_STATUSES, labels: UNKNOWN_STATUS_LABELS };
  return { values: PARTNER_STATUSES, labels: PARTNER_STATUS_LABELS };
}

/** The selectable statuses for a contact type, in dropdown order (spec
 *  2026-10-23 D1). THE one source for the contact page header dropdown and
 *  the Edit contact details Status field (D3: exactly the same choices). */
export function statusOptionsFor(type: string | undefined): { value: string; label: string }[] {
  const { values, labels } = contactStatusListFor(type);
  return values.map((value) => ({ value, label: labels[value] ?? value }));
}

/** The label for a status from its contact type's own map, or undefined when
 *  the status is not on that type's list (the caller picks the fallback). */
export function contactStatusLabelFor(type: string | undefined, status: string): string | undefined {
  const { labels } = contactStatusListFor(type);
  return Object.hasOwn(labels, status) ? labels[status] : undefined;
}

// --- Property lifecycle (coarse, mostly derived) -----------------------------
```

(The dashboard tsconfig targets ES2022 with the ES2022 lib, so
`Object.hasOwn` is available.)

Step 4 - GREEN: the Step 2 command; both files pass in full.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/api/types.ts dashboard/src/api/statusModel.test.ts dashboard/src/routes/contact/contactStatusMirror.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(dashboard): mirror the per-type contact status lists with a cross-workspace drift guard (unknown-inactive AR2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S4.2 - labels and tone: format.ts, StatusBadge (inactive muted for every type), ContactsList rows

Files: `dashboard/src/routes/contact/format.ts`, `format.test.ts`,
`dashboard/src/ui/StatusBadge.tsx`, `StatusBadge.test.tsx`,
`dashboard/src/routes/contacts/ContactsList.tsx`, `ContactsList.test.tsx`.

Step 1 - failing tests.

1a. `dashboard/src/ui/StatusBadge.test.tsx`. Current text (end of file):

```
describe('contactStatusTone', () => {
  it('gives landlord onboarding the same tone as tenant onboarding (progress)', () => {
    expect(contactStatusTone('landlord', 'onboarding')).toBe('progress');
    expect(contactStatusTone('tenant', 'onboarding')).toBe(
      contactStatusTone('landlord', 'onboarding'),
    );
  });
});
```

Replacement:

```
describe('contactStatusTone', () => {
  it('gives landlord onboarding the same tone as tenant onboarding (progress)', () => {
    expect(contactStatusTone('landlord', 'onboarding')).toBe('progress');
    expect(contactStatusTone('tenant', 'onboarding')).toBe(
      contactStatusTone('landlord', 'onboarding'),
    );
  });

  // Spec 2026-10-23 D4.4: Inactive reads the same muted colour for every type.
  it.each(['tenant', 'partner', 'team_member', 'unknown', undefined] as const)(
    'an Inactive %s is muted',
    (type) => {
      expect(contactStatusTone(type, 'inactive')).toBe('muted');
    },
  );

  it('(PIN) the rest of the non-tenant tones are unchanged: Needs review warns, Active is neutral, Parked is muted', () => {
    expect(contactStatusTone('partner', 'needs_review')).toBe('warn');
    expect(contactStatusTone('unknown', 'needs_review')).toBe('warn');
    expect(contactStatusTone('partner', 'active')).toBe('neutral');
    expect(contactStatusTone('team_member', 'active')).toBe('neutral');
    expect(contactStatusTone('landlord', 'parked')).toBe('muted');
    expect(contactStatusTone('partner', 'some_legacy_value')).toBe('neutral');
  });
});
```

1b. `dashboard/src/routes/contact/format.test.ts`. Current text:

```
  it('humanizes for unknown/other types and off-list values (never raw snake_case)', () => {
```

Replacement (insert the new case ABOVE it):

```
  it('(PIN) uses each type list for partner, team member and unknown (spec 2026-10-23 D1)', () => {
    expect(contactStatusLabel('partner', 'inactive')).toBe('Inactive');
    expect(contactStatusLabel('team_member', 'active')).toBe('Active');
    expect(contactStatusLabel('unknown', 'inactive')).toBe('Inactive');
    // A legacy (unknown, active) is off the unknown list: still never raw.
    expect(contactStatusLabel('unknown', 'active')).toBe('Active');
  });
  it('humanizes for unknown/other types and off-list values (never raw snake_case)', () => {
```

1c. `dashboard/src/routes/contacts/ContactsList.test.tsx`. Current text:

```
  it('renders a row per contact with name, phone, type, and a detail link', () => {
```

Replacement (insert the new case ABOVE it):

```
  it('(PIN) a non-tenant row labels its status from its own type list (spec 2026-10-23 D1)', () => {
    state = {
      status: 'ready',
      contacts: [
        { contactId: 'p1', type: 'partner', firstName: 'Renee', lastName: 'Carter', phone: '+14045550123', status: 'inactive' },
        { contactId: 'u1', type: 'unknown', firstName: 'Una', lastName: 'Known', phone: '+14045550124', status: 'needs_review' },
      ],
    };
    renderList('all');
    expect(within(screen.getByRole('link', { name: /Renee Carter/ })).getByText('Inactive')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /Una Known/ })).getByText('Needs review')).toBeInTheDocument();
  });

  it('renders a row per contact with name, phone, type, and a detail link', () => {
```

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/ui/StatusBadge.test.tsx src/routes/contact/format.test.ts src/routes/contacts/ContactsList.test.tsx
```

Expected: the four `an Inactive <type> is muted` cases for partner,
team_member, unknown and undefined fail (`expected 'neutral' to be
'muted'`); the tenant case and every (PIN) case pass.

Step 3 - implementation.

3a. `dashboard/src/ui/StatusBadge.tsx`. Current text:

```
/** Resolve a CONTACT's status tone across every audience the contact page shows:
 *  tenant + landlord get their own lifecycle maps; every other type (unknown / pm /
 *  team_member) carries the coarse needs_review|active pair, where only the triage
 *  front door (`needs_review`) warns. Off-list values fall back to neutral. This is
 *  the single source of truth for "does this status want attention?" (tone === 'warn'). */
export function contactStatusTone(type: string | undefined, status: string): BadgeTone {
  if (type === 'tenant') return TENANT_TONE[status as TenantStatus] ?? 'neutral';
  if (type === 'landlord') return LANDLORD_TONE[status as LandlordStatus] ?? 'neutral';
  return status === 'needs_review' ? 'warn' : 'neutral';
}
```

Replacement:

```
/** Resolve a CONTACT's status tone across every audience the contact page shows:
 *  tenant + landlord get their own lifecycle maps; every other type (partner,
 *  team_member, unknown) carries the short needs_review | active | inactive list
 *  (unknown has no active), where the triage front door (`needs_review`) warns
 *  and `inactive` is muted - the SAME muted an Inactive tenant gets (spec
 *  2026-10-23 D4.4). Off-list values fall back to neutral. This is the single
 *  source of truth for "does this status want attention?" (tone === 'warn'). */
export function contactStatusTone(type: string | undefined, status: string): BadgeTone {
  if (type === 'tenant') return TENANT_TONE[status as TenantStatus] ?? 'neutral';
  if (type === 'landlord') return LANDLORD_TONE[status as LandlordStatus] ?? 'neutral';
  if (status === 'needs_review') return 'warn';
  if (status === 'inactive') return 'muted';
  return 'neutral';
}
```

3b. `dashboard/src/routes/contact/format.ts`. Edit the import. Current text:

```
import {
  LANDLORD_STATUS_LABELS,
  TENANT_STATUS_LABELS,
  type Address,
  type Contact,
  type LandlordStatus,
  type TenantStatus,
} from '../../api/types.js';
```

Replacement:

```
import { contactStatusLabelFor, type Address, type Contact } from '../../api/types.js';
```

Then replace `contactStatusLabel`. Delete the four-line docblock directly
above it (it starts `/** The user-facing label for a CONTACT's status` and
ends `route it through here. */`; it carries a non-ASCII dash, so it is not
quoted here) together with the function. Current function text:

```
export function contactStatusLabel(type: string | undefined, status: string): string {
  if (type === 'tenant') return TENANT_STATUS_LABELS[status as TenantStatus] ?? humanize(status);
  if (type === 'landlord') return LANDLORD_STATUS_LABELS[status as LandlordStatus] ?? humanize(status);
  return humanize(status);
}
```

Replacement for docblock + function:

```
/** The user-facing label for a CONTACT's status, from the contact's OWN type's
 *  label map (api/types.ts contactStatusLabelFor - tenant, landlord, partner /
 *  team member, unknown; spec 2026-10-23 D1). An off-list or legacy value
 *  humanizes. NEVER render a raw snake_case status - route it through here. */
export function contactStatusLabel(type: string | undefined, status: string): string {
  return contactStatusLabelFor(type, status) ?? humanize(status);
}
```

3c. `dashboard/src/routes/contacts/ContactsList.tsx`. Edit the import. Current
text:

```
import { contactDisplayName, formatPhone, humanize } from '../contact/format.js';
```

Replacement:

```
import { contactDisplayName, contactStatusLabel, formatPhone } from '../contact/format.js';
```

Then current text:

```
/** Non-tenant status label (the coarse needs_review|active lifecycle): a naive
 *  capitalize. Tenants render a StatusBadge instead (the F1 tenant-status map). */
function statusLabel(status: string | undefined): string {
  if (!status) return '';
  return humanize(status);
}
```

Replacement:

```
/** Non-tenant status label from the contact's OWN type's label map (spec
 *  2026-10-23 D1), via the shared contactStatusLabel. Tenants render a
 *  StatusBadge instead (the F1 tenant-status map). */
function statusLabel(contact: Contact): string {
  if (!contact.status) return '';
  return contactStatusLabel(contact.type, contact.status);
}
```

Then current text:

```
          ) : statusLabel(contact.status) ? (
            <span className={styles.status}>{statusLabel(contact.status)}</span>
```

Replacement:

```
          ) : statusLabel(contact) ? (
            <span className={styles.status}>{statusLabel(contact)}</span>
```

(`humanize` has no other use in ContactsList.tsx at main @916258ae - verify
with `grep -n humanize dashboard/src/routes/contacts/ContactsList.tsx`
printing nothing after the edit.)

Step 4 - GREEN: the Step 2 command; all three files pass.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/ui/StatusBadge.tsx dashboard/src/ui/StatusBadge.test.tsx dashboard/src/routes/contact/format.ts dashboard/src/routes/contact/format.test.ts dashboard/src/routes/contacts/ContactsList.tsx dashboard/src/routes/contacts/ContactsList.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(dashboard): Inactive is muted for every contact type; status labels from the per-type maps (unknown-inactive D4.4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S4.3 - one header dropdown for every live type (D2, AR9)

Files: `dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/api/endpoints.ts`,
`dashboard/src/routes/contact/ContactDetail.test.tsx`.

The header calls `setTenantStatus(contactId, { toStatus, source: 'manual' })`
(`ContactDetail.tsx:941-946`), i.e. `PATCH /api/contacts/:id/tenant-status`
(`endpoints.ts:477-499`). AR9: every live type uses that same call and
source; only the options change. `StatusMenu` (`ui/StatusMenu.tsx`) takes
`value`, `options: { value, label }[]`, `onChange`, `tone`, `disabled`,
`label`, `error` - unchanged.

Step 1 - failing tests in `dashboard/src/routes/contact/ContactDetail.test.tsx`.

1a. Import the new copy constant. Current text:

```
import {
  ContactDetail,
  MARK_UNREAD_NO_THREAD,
  RUN_INDICATOR_TIMEOUT_MS,
} from './ContactDetail.js';
```

Replacement:

```
import {
  CONTACT_TYPE_CHANGED_STATUS_COPY,
  ContactDetail,
  MARK_UNREAD_NO_THREAD,
  RUN_INDICATOR_TIMEOUT_MS,
} from './ContactDetail.js';
```

1b. Delete the whole test whose name starts `an untriaged (unknown) contact
keeps the display-only status badge` (main @916258ae lines 513-520; its name
ends in a non-ASCII dash, so it is not quoted). Its body is:

```
    getContact.mockResolvedValue(UNKNOWN);
    renderAt('u9');
    await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Contact status/i })).not.toBeInTheDocument();
    // The status still reads (display badge in the header + the Details row).
    expect(screen.getAllByText('Needs review').length).toBeGreaterThanOrEqual(1);
  });
```

It pins the old badge-only behavior D2 removes. In its place (same position,
inside `describe('ContactDetail', ...)`, directly before
`it('renders the landlord file (Properties card) for a landlord'`), insert:

```
  // Spec 2026-10-23 D2: ONE header dropdown for every live type, listing that
  // type's D1 statuses, through the same transition endpoint and source the
  // tenant and landlord pill use. team_member renders the tenant page, but its
  // dropdown lists the team member statuses.
  const HEADER_PARTNER: Contact = {
    contactId: 'p1',
    type: 'partner',
    firstName: 'Renee',
    lastName: 'Carter',
    status: 'active',
    phone: '+14045550123',
    organization: 'Hope Atlanta',
  };
  const HEADER_TEAM_MEMBER: Contact = { ...TENANT, type: 'team_member', status: 'active' };

  it.each([
    ['partner', HEADER_PARTNER, 'Active', ['Needs review', 'Active', 'Inactive']],
    ['team_member', HEADER_TEAM_MEMBER, 'Active', ['Needs review', 'Active', 'Inactive']],
    ['unknown', UNKNOWN, 'Needs review', ['Needs review', 'Inactive']],
  ] as const)(
    '%s status pill: lists exactly its own statuses and changes it via the transition service',
    async (_type, contact, current, labels) => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(contact);
      setTenantStatus.mockResolvedValue({ ...contact, status: 'inactive' });
      renderAt(contact.contactId);

      await user.click(await screen.findByRole('button', { name: `Contact status: ${current}` }));
      const menu = screen.getByRole('menu', { name: 'Contact status' });
      // Each item is [check mark span][label text]; the text node is the label.
      const items = within(menu)
        .getAllByRole('menuitemradio')
        .map((el) => el.lastChild?.textContent ?? '');
      expect(items).toEqual(labels);
      // Tenant-only values never leak in (team_member renders the tenant page).
      expect(within(menu).queryByRole('menuitemradio', { name: 'Searching' })).toBeNull();

      await user.click(within(menu).getByRole('menuitemradio', { name: 'Inactive' }));
      expect(setTenantStatus).toHaveBeenCalledWith(contact.contactId, { toStatus: 'inactive', source: 'manual' });
      await screen.findByRole('button', { name: 'Contact status: Inactive' });
      expect(updateContact).not.toHaveBeenCalled();
    },
  );

  it('(PIN) a soft-deleted unknown contact keeps the display-only status badge - no pill', async () => {
    getContact.mockResolvedValue({ ...UNKNOWN, status: 'inactive', deleted_at: '2026-10-01T00:00:00.000Z' });
    renderAt('u9');
    await waitFor(() => expect(screen.getAllByText('Inactive').length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByRole('button', { name: /Contact status/i })).not.toBeInTheDocument();
  });

  it('a 409 contact_type_changed shows the inline error and re-reads the contact (AR4, AR9)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    setTenantStatus.mockRejectedValue(
      new ApiError(409, 'contact_type_changed', 'contact_type_changed', { error: 'contact_type_changed' }),
    );
    renderAt('u9');
    const pill = await screen.findByRole('button', { name: 'Contact status: Needs review' });

    // Staff B made the contact a tenant between this page's read and the pick.
    getContact.mockResolvedValue({ ...UNKNOWN, type: 'tenant', status: 'onboarding' });
    const readsBefore = getContact.mock.calls.length;
    await user.click(pill);
    await user.click(screen.getByRole('menuitemradio', { name: 'Inactive' }));

    expect(await screen.findByText(CONTACT_TYPE_CHANGED_STATUS_COPY)).toBeInTheDocument();
    await waitFor(() => expect(getContact.mock.calls.length).toBeGreaterThan(readsBefore));
    // The pill now offers the re-typed contact's statuses, on its stored value.
    await screen.findByRole('button', { name: 'Contact status: Onboarding' });
  });
```

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/contact/ContactDetail.test.tsx
```

Expected: the three `status pill` cases fail (no `Contact status: ...`
button: partner, team_member and unknown get the display-only badge today);
the 409 case fails the same way; the deleted PIN passes. Every other case in
the file stays green. (`CONTACT_TYPE_CHANGED_STATUS_COPY` imports as
`undefined` until Step 3; that only affects the 409 case.)

Step 3 - implementation.

3a. `dashboard/src/api/endpoints.ts`, the import list. Current text:

```
  LandlordStatus,
  ListingSendRow,
```

Replacement:

```
  ListingSendRow,
```

Current text:

```
  TenantStatus,
  TodayResponse,
```

Replacement:

```
  ContactStatusValue,
  TodayResponse,
```

(At main @916258ae `LandlordStatus` and `TenantStatus` are used in
endpoints.ts only by the `setTenantStatus` input type edited next; after that
edit, `grep -n "TenantStatus\|LandlordStatus" dashboard/src/api/endpoints.ts`
prints nothing, so no unused import is left for gate 5.)

Then current text:

```
    toStatus: TenantStatus | LandlordStatus;
```

Replacement:

```
    toStatus: ContactStatusValue;
```

And in the docblock directly above `setTenantStatus`, current text:

```
 *  the STORED contact's own type-scoped allowlist (tenant lifecycle vs the
 *  landlord lead lifecycle), so the input type is the union. Returns the
 *  updated contact (unwrapped from { contact }). */
```

Replacement:

```
 *  the STORED contact's own type-scoped allowlist (tenant lifecycle, the
 *  landlord lead lifecycle, partner / team member, unknown), so the input type
 *  is the union of all four. A 409 { error: 'contact_type_changed' } means the
 *  type changed since the route's own read and nothing was written. Returns
 *  the updated contact (unwrapped from { contact }). */
```

3b. `dashboard/src/routes/contact/ContactDetail.tsx`, the api import. Current
text:

```
  deleteContact,
  markInboxRead,
```

Replacement:

```
  deleteContact,
  getContact,
  markInboxRead,
```

Current text:

```
  useEventStream,
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
```

Replacement:

```
  useEventStream,
  statusOptionsFor,
```

Current text:

```
  type Contact,
  type ConversationUpdatedEvent,
  type LandlordStatus,
  type OrgCheckResult,
  type TenantStatus,
} from '../../api/index.js';
```

Replacement:

```
  type Contact,
  type ContactStatusValue,
  type ConversationUpdatedEvent,
  type OrgCheckResult,
} from '../../api/index.js';
```

(If S2 added a name to this import list, keep it.)

3c. The copy constant. Current text:

```
export const MARK_UNREAD_NO_THREAD =
  'No thread to mark unread yet - if this contact has messages, try again.';
```

Replacement:

```
export const MARK_UNREAD_NO_THREAD =
  'No thread to mark unread yet - if this contact has messages, try again.';

/** The header status pill's 409 contact_type_changed (plan ruling AR4): the
 *  contact was re-typed between this page's read and the pick, so the route
 *  wrote nothing. The page re-reads the contact, so the pill already offers
 *  the new type's statuses when this shows. Exported for the test. */
export const CONTACT_TYPE_CHANGED_STATUS_COPY =
  "This contact's type just changed, so its status list did too. Pick the status again.";
```

3d. Current text:

```
  // The header's interactive status pill (tenant/landlord lifecycle change).
```

Replacement:

```
  // The header's interactive status pill (every live type, spec 2026-10-23 D2).
```

3e. In `onChangeStatus`, current text:

```
      // StatusMenu is stringly-typed; the value came from the type-scoped option
      // list (TENANT_STATUSES / LANDLORD_STATUSES), so the union cast is exact.
      toStatus: toStatus as TenantStatus | LandlordStatus,
```

Replacement:

```
      // StatusMenu is stringly-typed; the value came from the type-scoped option
      // list (statusOptionsFor, spec 2026-10-23 D2), so the union cast is exact.
      toStatus: toStatus as ContactStatusValue,
```

Current text:

```
      .catch(() => setStatusError("Couldn't update the status - please try again."))
```

Replacement:

```
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 409 && err.code === 'contact_type_changed') {
          // Plan rulings AR4/AR9: someone re-typed the contact between this
          // page's read and the pick, so the route wrote nothing. Say so, and
          // re-read the contact so the pill offers the new type's statuses
          // (setContact is bound to this contactId, so a late answer after
          // navigating away is a no-op).
          setStatusError(CONTACT_TYPE_CHANGED_STATUS_COPY);
          void getContact(contact.contactId)
            .then((fresh) => setContact(fresh))
            .catch(() => {
              /* best-effort: the message already asks staff to try again */
            });
          return;
        }
        setStatusError("Couldn't update the status - please try again.");
      })
```

3f. The header. Current text:

```
            {/* Tenant/landlord lifecycle status: an interactive pill that shows AND
                changes it (same pattern as the property/placement headers). Other
                types (and deleted contacts) keep the display-only badge. */}
            {contact.status && !deleted && contact.type === 'tenant' ? (
              <StatusMenu
                value={contact.status}
                options={TENANT_STATUSES.map((s) => ({ value: s, label: TENANT_STATUS_LABELS[s] }))}
                onChange={onChangeStatus}
                tone={contactStatusTone(contact.type, contact.status)}
                disabled={statusBusy}
                label="Contact status"
                error={statusError}
              />
            ) : contact.status && !deleted && contact.type === 'landlord' ? (
              <StatusMenu
                value={contact.status}
                options={LANDLORD_STATUSES.map((s) => ({ value: s, label: LANDLORD_STATUS_LABELS[s] }))}
                onChange={onChangeStatus}
                tone={contactStatusTone(contact.type, contact.status)}
                disabled={statusBusy}
                label="Contact status"
                error={statusError}
              />
            ) : contact.status ? (
              <ContactStatusBadge type={contact.type} status={contact.status} />
            ) : null}
```

Replacement:

```
            {/* The lifecycle status: an interactive pill that shows AND changes
                it (same pattern as the property/placement headers), for EVERY
                live type with that type's own statuses (spec 2026-10-23 D2 - one
                way to move anyone through statuses). A deleted contact keeps
                the display-only badge. */}
            {contact.status && !deleted ? (
              <StatusMenu
                value={contact.status}
                options={statusOptionsFor(contact.type)}
                onChange={onChangeStatus}
                tone={contactStatusTone(contact.type, contact.status)}
                disabled={statusBusy}
                label="Contact status"
                error={statusError}
              />
            ) : contact.status ? (
              <ContactStatusBadge type={contact.type} status={contact.status} />
            ) : null}
```

After the edits, `grep -n "TENANT_STATUS\|LANDLORD_STATUS\|TenantStatus\|LandlordStatus" dashboard/src/routes/contact/ContactDetail.tsx`
prints nothing (no unused import left for gate 5).

Step 4 - GREEN: the Step 2 command; the whole file passes (the tenant and
landlord pill cases at ~413-480 are PINs of AR9's "tenant/landlord behavior
unchanged"). Also run `cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/api`
(endpoints type change only; expect green).

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/api/endpoints.ts
git -C W:/tmp/unknown-inactive commit -m "feat(contact): the header status dropdown for every live contact type, refetch on contact_type_changed (unknown-inactive D2, AR9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S4.4 - the Edit contact details Status field matches the header (D3)

Files: `dashboard/src/routes/contact/ContactEditForm.tsx`,
`dashboard/src/routes/contact/ContactEditForm.test.tsx`.

What the form does today (main @916258ae): its private non-tenant list
(`ContactEditForm.tsx:32-67, 132-142`) is `needs_review | active`, so an
Inactive caseworker DISPLAYS as Needs review; `handleKindChange` (`:287-295`)
only resets an INVALID status; `buildPatch` (`:345-347`) puts every
non-tenant status change in the PATCH; `onSubmit` (`:514-549`) calls
`setTenantStatus` for a tenant status/porting change. The KindPicker
(`KindPicker.tsx:38-47`) reaches tenant, landlord and partner (Property
Manager is landlord + role, Caseworker is partner + role, Other is a role on
a tenant or landlord base, with `type: null` while no base is picked) - never
team_member or unknown. So a type change in this form always TARGETS tenant,
landlord or partner, while the STORED type can be any of the five.

The rules this task implements (plan section 1 D3):

- options: `statusOptionsFor(liveType)` - the header's list;
- the field starts on the stored status when it is legal for the stored type,
  else Needs review;
- a type change = `kind.type !== null && kind.type !== contact.type` at save
  time; a change of base type in the picker moves the field to the new
  type's first step (`FIRST_STATUS_FOR_TYPE`), and coming back to the stored
  type shows the stored status again; a role-only switch leaves the field;
- save, no type change: tenant unchanged (`setTenantStatus` on a status or
  porting change); landlord unchanged (status in the PATCH, with park
  reason); partner / team_member / unknown: a status change through
  `setTenantStatus(id, { toStatus, source: 'manual' })`, never the PATCH;
- save, type change: non-tenant target - the PATCH carries `type` AND the
  shown `status`; tenant target - the PATCH carries `type` only, then
  `setTenantStatus` only if the shown status is not `onboarding` (or the
  porting box changed, clarification 3).

Step 1 - failing tests in `dashboard/src/routes/contact/ContactEditForm.test.tsx`.

1a. The api import. Current text:

```
import { ApiError, type Contact, type OrgEntry } from '../../api/index.js';
```

Replacement:

```
import { ApiError, statusOptionsFor, type Contact, type ContactType, type OrgEntry } from '../../api/index.js';
```

1b. Existing test `changing the Type swaps the type-specific fields and
PATCHes { type }` - its expectation flips (D3: a non-tenant target carries
the shown status). Current text:

```
    // A tenant on 'needs_review' resolves to the SAME default for a landlord, so
    // the type switch sends only { type } (no incidental status delta).
```

Replacement:

```
    // Spec 2026-10-23 D3: a type change moves the Status field to the new
    // type's first step (landlord Interested), and a non-tenant target's PATCH
    // carries that shown status explicitly.
```

Current text:

```
    expect(updateContact).toHaveBeenCalledWith('k1', { type: 'landlord' });
```

Replacement:

```
    expect(updateContact).toHaveBeenCalledWith('k1', { type: 'landlord', status: 'interested' });
```

1c. Existing test `editing Unknown to Property Manager sends the full
landlord and role pair`. Current text:

```
    expect(updateContact).toHaveBeenCalledWith('u9', { type: 'landlord', role: 'Property Manager' });
```

Replacement:

```
    expect(updateContact).toHaveBeenCalledWith('u9', {
      type: 'landlord',
      role: 'Property Manager',
      status: 'interested',
    });
```

1d. Delete the whole existing test whose name starts `changing type
landlord` (main @916258ae lines 443-468; its name carries a non-ASCII arrow,
so it is not quoted). Its body begins:

```
    const user = userEvent.setup();
    // LANDLORD.status === 'active' (valid for a non-tenant). Switching to tenant
    // must reset the selection to a valid tenant status.
```

In its place (same position, directly before the comment line
`// --- Landlord onboarding inputs (Task 4b) ---`), insert:

```
  it('changing type landlord to tenant shows Onboarding and saves ONE milestone - no follow-up setTenantStatus (spec 2026-10-23 D3)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const retyped = { ...LANDLORD, type: 'tenant' as const, status: 'onboarding' };
    updateContact.mockResolvedValue(retyped);
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={onSaved} />);

    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));

    // The tenant list, on the tenant's first step - never the landlord's 'active'.
    const select = screen.getByRole('combobox', { name: /^Status$/ }) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(7);
    expect(select.value).toBe('onboarding');

    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // The PATCH never carries a tenant status: the server's own auto-advance
    // writes Onboarding, which is what the field shows, so there is no second write.
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { type: 'tenant' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(retyped));
  });

```

1e. Append a new describe at the END of the file:

```

// Spec 2026-10-23 D1/D3: the Status field offers exactly the header's list for
// every type, shows an Inactive caseworker as Inactive, writes a partner /
// team member / unknown status change the way the header does, and follows
// the type-change rules (measured against the STORED type).
describe('ContactEditForm - one status list per type and the type-change rules (spec 2026-10-23 D1, D3)', () => {
  const INACTIVE_CASEWORKER: Contact = {
    contactId: 'p1',
    type: 'partner',
    role: 'Caseworker',
    status: 'inactive',
    firstName: 'Renee',
    lastName: 'Carter',
    phone: '+14045550123',
  };
  const INACTIVE_PARTNER: Contact = {
    contactId: 'p2',
    type: 'partner',
    status: 'inactive',
    firstName: 'Pat',
    lastName: 'Moss',
    phone: '+14045550125',
  };
  const TEAM_MEMBER: Contact = {
    contactId: 'tm1',
    type: 'team_member',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Lee',
    phone: '+14045550124',
  };
  const UNKNOWN_REVIEW: Contact = { contactId: 'u9', type: 'unknown', status: 'needs_review', phone: '+15550100001' };
  const UNKNOWN_INACTIVE: Contact = { ...UNKNOWN_REVIEW, status: 'inactive' };

  // EXACT 'Status' name: a landlord's dialog also has "Contract status".
  const statusSelect = (): HTMLSelectElement => screen.getByRole('combobox', { name: /^Status$/ }) as HTMLSelectElement;
  const optionPairs = (): Array<[string, string]> =>
    within(statusSelect())
      .getAllByRole('option')
      .map((o) => [(o as HTMLOptionElement).value, o.textContent ?? '']);
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  const D1: Array<[ContactType, Array<[string, string]>]> = [
    [
      'tenant',
      [
        ['needs_review', 'Needs review'],
        ['onboarding', 'Onboarding'],
        ['searching', 'Searching'],
        ['placing', 'Placing'],
        ['placed', 'Placed'],
        ['on_hold', 'On hold'],
        ['inactive', 'Inactive'],
      ],
    ],
    [
      'landlord',
      [
        ['needs_review', 'Needs review'],
        ['interested', 'Interested'],
        ['onboarding', 'Onboarding'],
        ['active', 'Active'],
        ['parked', 'Parked'],
      ],
    ],
    ['partner', [['needs_review', 'Needs review'], ['active', 'Active'], ['inactive', 'Inactive']]],
    ['team_member', [['needs_review', 'Needs review'], ['active', 'Active'], ['inactive', 'Inactive']]],
    ['unknown', [['needs_review', 'Needs review'], ['inactive', 'Inactive']]],
  ];

  it.each(D1)('a %s offers exactly its D1 list - the same list the header dropdown offers', (type, pairs) => {
    render(
      <ContactEditForm
        contact={{ contactId: 'c1', type, status: 'needs_review', phone: '+14045550100' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(optionPairs()).toEqual(pairs);
    expect(optionPairs()).toEqual(statusOptionsFor(type).map((o) => [o.value, o.label]));
  });

  it('a legacy (unknown, active) contact shows Needs review - Active is not an unknown status', () => {
    render(<ContactEditForm contact={{ ...UNKNOWN_REVIEW, status: 'active' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(statusSelect().value).toBe('needs_review');
    expect(optionPairs().map(([value]) => value)).not.toContain('active');
  });

  it('DISPLAYS an Inactive caseworker as Inactive', () => {
    render(<ContactEditForm contact={INACTIVE_CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(statusSelect().value).toBe('inactive');
    expect(within(statusSelect()).getByRole('option', { name: 'Inactive' })).toHaveProperty('selected', true);
  });

  it('an Inactive caseworker stays Inactive across an unrelated-field save: no status write', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...INACTIVE_CASEWORKER, firstName: 'Rene' });
    render(<ContactEditForm contact={INACTIVE_CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Rene');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('p1', { firstName: 'Rene' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['a caseworker', INACTIVE_CASEWORKER, 'active'],
    ['a team member', TEAM_MEMBER, 'inactive'],
    ['an unknown contact', UNKNOWN_REVIEW, 'inactive'],
  ] as const)(
    'with no type change, %s status change goes through the transition service, as the header does',
    async (_label, contact, toStatus) => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const updated = { ...contact, status: toStatus };
      setTenantStatus.mockResolvedValue(updated);
      render(<ContactEditForm contact={contact} onClose={vi.fn()} onSaved={onSaved} />);
      await user.selectOptions(statusSelect(), toStatus);
      await user.click(save());
      await waitFor(() =>
        expect(setTenantStatus).toHaveBeenCalledWith(contact.contactId, { toStatus, source: 'manual' }),
      );
      // Never the plain PATCH (no other field changed, so no PATCH at all).
      expect(updateContact).not.toHaveBeenCalled();
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    },
  );

  it('a type change from an Inactive partner to tenant shows Onboarding and writes it once', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const retyped = { ...INACTIVE_PARTNER, type: 'tenant' as const, status: 'onboarding' };
    updateContact.mockResolvedValue(retyped);
    render(<ContactEditForm contact={INACTIVE_PARTNER} onClose={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('p2', { type: 'tenant' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(retyped));
  });

  it('a type change to tenant with another status picked: the PATCH, then ONE setTenantStatus with that status', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateContact.mockResolvedValue({ ...UNKNOWN_INACTIVE, type: 'tenant', status: 'onboarding' });
    const searching = { ...UNKNOWN_INACTIVE, type: 'tenant' as const, status: 'searching' };
    setTenantStatus.mockResolvedValue(searching);
    render(<ContactEditForm contact={UNKNOWN_INACTIVE} onClose={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.selectOptions(statusSelect(), 'searching');
    await user.click(save());
    await waitFor(() =>
      expect(setTenantStatus).toHaveBeenCalledWith('u9', { toStatus: 'searching', source: 'manual', porting: false }),
    );
    expect(updateContact).toHaveBeenCalledWith('u9', { type: 'tenant' });
    expect(setTenantStatus).toHaveBeenCalledTimes(1);
    expect(updateContact.mock.invocationCallOrder[0]!).toBeLessThan(setTenantStatus.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(searching));
  });

  it('a type change from an Inactive unknown contact to partner shows Active and the PATCH carries it', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...UNKNOWN_INACTIVE, type: 'partner', status: 'active' });
    render(<ContactEditForm contact={UNKNOWN_INACTIVE} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    expect(statusSelect().value).toBe('active');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('u9', { type: 'partner', status: 'active' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('on a type change staff may pick another status first: the PATCH carries the shown one', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...UNKNOWN_INACTIVE, type: 'landlord', status: 'parked' });
    render(<ContactEditForm contact={UNKNOWN_INACTIVE} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    expect(statusSelect().value).toBe('interested');
    await user.selectOptions(statusSelect(), 'parked');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('u9', { type: 'landlord', status: 'parked' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('(PIN) a role-only switch (Landlord to the Property Manager preset) keeps the stored status and writes none', async () => {
    const user = userEvent.setup();
    const onboarding: Contact = { ...LANDLORD, status: 'onboarding' };
    updateContact.mockResolvedValue({ ...onboarding, role: 'Property Manager' });
    render(<ContactEditForm contact={onboarding} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Property Manager' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { role: 'Property Manager' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('a change-and-back (tenant to landlord to tenant) is not a type change: the stored status shows and none is written', async () => {
    const user = userEvent.setup();
    const searching: Contact = { ...TENANT, status: 'searching' };
    updateContact.mockResolvedValue({ ...searching, firstName: 'Tash' });
    render(<ContactEditForm contact={searching} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    expect(statusSelect().value).toBe('interested');
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('searching');
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Tash');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('k1', { firstName: 'Tash' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('(PIN) a Parked landlord keeps its park reason across an unrelated-field save', async () => {
    const user = userEvent.setup();
    const parked: Contact = { ...LANDLORD, status: 'parked', park_reason: 'Declined the program' };
    updateContact.mockResolvedValue({ ...parked, firstName: 'Jim' });
    render(<ContactEditForm contact={parked} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(statusSelect().value).toBe('parked');
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Jim');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { firstName: 'Jim' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('(PIN) a landlord moved to Parked saves status and park reason in ONE PATCH - never the transition (it would overwrite park_reason)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD, status: 'parked', park_reason: 'Not a fit' });
    render(<ContactEditForm contact={{ ...LANDLORD, status: 'interested' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.selectOptions(statusSelect(), 'parked');
    await user.type(screen.getByLabelText(/^Park reason$/i), 'Not a fit');
    await user.click(save());
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('L1', { status: 'parked', park_reason: 'Not a fit' }),
    );
    expect(setTenantStatus).not.toHaveBeenCalled();
  });
});
```

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/contact/ContactEditForm.test.tsx
```

Expected failures, each for the stated reason:
- the partner, team_member and unknown D1-list cases (the private list is
  `needs_review | active`); the tenant and landlord cases pass;
- legacy (unknown, active): `active` is offered;
- DISPLAYS Inactive: `select.value` is `needs_review`;
- the three no-type-change transition cases: `selectOptions` finds no
  `inactive` option (team member, unknown), or the caseworker's change rides
  `updateContact` instead of `setTenantStatus`;
- every type-change case: the field does not move to the new type's first
  step (`expected 'needs_review' to be 'onboarding' / 'interested' /
  'active'`), and the edited 1b/1c/1d expectations;
- change-and-back: the field shows `needs_review` after coming back, and a
  `setTenantStatus` is sent.
The (PIN) cases and the unrelated-field save pass. Every pre-existing case
not edited in 1b-1d stays green.

Step 3 - implementation, `dashboard/src/routes/contact/ContactEditForm.tsx`.

3a. The api import. Current text:

```
import {
  ApiError,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  setTenantStatus,
  updateContact,
  type Address,
  type Contact,
  type ContactPatch,
  type Relationship,
  type CustomField,
  type TenantStatus,
  type ContactType,
  type OrgRef,
} from '../../api/index.js';
```

Replacement:

```
import {
  ApiError,
  setTenantStatus,
  statusOptionsFor,
  updateContact,
  type Address,
  type Contact,
  type ContactPatch,
  type ContactStatusValue,
  type Relationship,
  type CustomField,
  type ContactType,
  type OrgRef,
} from '../../api/index.js';
```

3b. The private status helpers. Current text (the whole block between the
api import and `import { Button } from '../../ui/index.js';`):

```
// The valid status values, per contact type. Tenants use the 7-value tenant
// lifecycle; landlords use the 4-value lead lifecycle; everyone else uses the
// coarse needs_review|active lifecycle.
const NON_TENANT_STATUS_VALUES = ['needs_review', 'active'] as const;
type NonTenantStatus = (typeof NON_TENANT_STATUS_VALUES)[number];

function isTenantStatus(v: string): v is TenantStatus {
  return (TENANT_STATUSES as readonly string[]).includes(v);
}

function isNonTenantStatus(v: string): v is NonTenantStatus {
  return (NON_TENANT_STATUS_VALUES as readonly string[]).includes(v);
}

function isLandlordStatus(v: string): boolean {
  return (LANDLORD_STATUSES as readonly string[]).includes(v);
}

/** The set of valid status values for a given type. */
function validStatusesForType(type: ContactType): readonly string[] {
  if (type === 'tenant') return TENANT_STATUSES;
  if (type === 'landlord') return LANDLORD_STATUSES;
  return NON_TENANT_STATUS_VALUES;
}

/** The status to start with (and to reset to) for a type, given the contact's
 *  stored status. Keeps the selection VALID for the type: a stored value that's
 *  off-list for the type falls back to that type's front door - tenant ?
 *  'needs_review'; landlord ? keep the stored lead value if valid, else
 *  'needs_review'; non-tenant ? keep 'active' if that's what was stored, else
 *  'needs_review'. Never surfaces an off-list value as a selectable option. */
function defaultStatusForType(type: ContactType, storedStatus: string): string {
  if (type === 'tenant') {
    return isTenantStatus(storedStatus) ? storedStatus : 'needs_review';
  }
  if (type === 'landlord') {
    return isLandlordStatus(storedStatus) ? storedStatus : 'needs_review';
  }
  return isNonTenantStatus(storedStatus) ? storedStatus : 'needs_review';
}
```

Replacement:

```
// The valid status values and labels per contact type come from the ONE shared
// mirror of the backend status model (api/types.ts statusOptionsFor, spec
// 2026-10-23 D3) - the same list the contact page header dropdown offers. This
// form keeps no list of its own.

/** The valid status values for a type, in dropdown order. */
function validStatusesForType(type: ContactType): readonly string[] {
  return statusOptionsFor(type).map((o) => o.value);
}

/** The status the field starts on for a type, given the contact's stored
 *  status: the stored value when it is legal for the type, else the type's
 *  front door ('needs_review'). Never surfaces an off-list value as a
 *  selectable option. */
function defaultStatusForType(type: ContactType, storedStatus: string): string {
  return validStatusesForType(type).includes(storedStatus) ? storedStatus : 'needs_review';
}

/** The status a TYPE CHANGE moves the field to (spec 2026-10-23 D3): the new
 *  type's first step - the same values the server writes for a type change
 *  with no explicit status (D7). Staff may pick another before saving. */
const FIRST_STATUS_FOR_TYPE: Readonly<Record<ContactType, ContactStatusValue>> = {
  tenant: 'onboarding',
  landlord: 'interested',
  partner: 'active',
  team_member: 'active',
  unknown: 'needs_review',
};
```

3c. Delete the second private list. Current text (remove it entirely, with
the blank line after it):

```
// Non-tenant contacts use the coarse needs_review|active lifecycle.
const NON_TENANT_STATUSES: { value: string; label: string }[] = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'active', label: 'Active' },
];

/** The selectable status options for a type (no off-list value ever prepended). */
function statusOptionsForType(type: ContactType): { value: string; label: string }[] {
  if (type === 'tenant') return TENANT_STATUS_OPTIONS;
  if (type === 'landlord') return LANDLORD_STATUS_OPTIONS;
  return NON_TENANT_STATUSES;
}

// Tenants use the 7-value tenant lifecycle (the status model).
const TENANT_STATUS_OPTIONS: { value: string; label: string }[] = TENANT_STATUSES.map((s) => ({
  value: s,
  label: TENANT_STATUS_LABELS[s],
}));

// Landlords use the 5-value lead lifecycle (needs_review|interested|onboarding|active|parked).
const LANDLORD_STATUS_OPTIONS: { value: string; label: string }[] = LANDLORD_STATUSES.map((s) => ({
  value: s,
  label: LANDLORD_STATUS_LABELS[s],
}));

```

3d. The type-change measure. Current text:

```
  // The live base type for status scoping (KindPicker may be momentarily null
  // mid-change; fall back to the stored type).
  const liveType: ContactType = kind.type ?? contact.type;
```

Replacement:

```
  // The live base type for status scoping (KindPicker may be momentarily null
  // mid-change; fall back to the stored type).
  const liveType: ContactType = kind.type ?? contact.type;
  // Spec 2026-10-23 D3: a TYPE change is measured against the STORED type - the
  // picker left on a different base type at save time. A role-only switch
  // inside one type and a change-and-back are not type changes.
  const typeChanged = kind.type !== null && kind.type !== contact.type;
  // The stored status as the field first shows it (an off-list stored value
  // reads as the type's front door).
  const initialStatus = defaultStatusForType(contact.type, str(contact.status));
```

3e. `handleKindChange`. Current text:

```
  // Changing the type re-scopes the valid status set. If the current selection
  // isn't valid for the new type, reset it to that type's default (tenant ?
  // 'needs_review'; non-tenant ? keep 'active' if stored else 'needs_review') so
  // we never carry a type-invalid status (e.g. landlord 'active' ? tenant).
  function handleKindChange(next: KindPickerValue): void {
    setKind(next);
    setTypeRefusals(null);
    if (next.type !== null && !validStatusesForType(next.type).includes(status)) {
      setStatus(defaultStatusForType(next.type, str(contact.status)));
    }
```

Replacement:

```
  // Spec 2026-10-23 D3: a change of BASE type moves the Status field to the new
  // type's first step (tenant Onboarding, landlord Interested, partner Active);
  // coming back to the STORED type shows the stored status again (a
  // change-and-back is not a change). A role-only switch inside one type
  // (Landlord to the Property Manager preset) and the Other panel's base-less
  // step (type null) leave the field alone, so it never carries a
  // type-invalid status.
  function handleKindChange(next: KindPickerValue): void {
    setKind(next);
    setTypeRefusals(null);
    if (next.type !== null && next.type !== liveType) {
      setStatus(next.type === contact.type ? initialStatus : FIRST_STATUS_FOR_TYPE[next.type]);
    }
```

3f. `buildPatch`. Current text:

```
    // For TENANTS the status (and porting) is written via setTenantStatus (which
    // applies provenance/derivation) - NOT this plain PATCH, which would bypass
    // it. Non-tenant status may ride the plain PATCH. Compare against the initial
    // VALID selection (the stored value normalized to the type's valid set), so
    // an off-list stored value doesn't masquerade as a no-op change.
    if (!isTenant && status !== defaultStatusForType(liveType, str(contact.status))) {
      patch.status = status;
    }
```

Replacement:

```
    // Status in THIS PATCH (spec 2026-10-23 D3) - only two cases:
    //  - a type change to a NON-tenant: the shown status, ALWAYS, explicitly
    //    (the server honors it over its own type-change default);
    //  - a landlord with no type change, when the status changed: its park
    //    reason rides this PATCH too, and the transition plan overwrites
    //    park_reason on every move to parked, so the landlord status stays
    //    here. Compared against the initial VALID selection, so an off-list
    //    stored value does not masquerade as a no-op change.
    // A tenant (stored or target) never sends status here - setTenantStatus
    // applies provenance/derivation; a partner, team member or unknown contact
    // with no type change sends it through setTenantStatus too (onSubmit), as
    // the header dropdown does.
    if (typeChanged) {
      if (!isTenant) patch.status = status;
    } else if (isLandlord && status !== initialStatus) {
      patch.status = status;
    }
```

3g. `onSubmit`, the change detection. Current text:

```
    // For a tenant, a status OR porting change is a SEPARATE write through the
    // transition service (NOT the plain PATCH). Detect either, comparing status
    // against the initial VALID tenant selection (a legacy off-list value was
    // normalized to 'needs_review' on load).
    const initialStatus = defaultStatusForType(liveType, str(contact.status));
    const tenantStatusChanged =
      isTenant && (status !== initialStatus || porting !== (contact.porting === true));

    if (Object.keys(result).length === 0 && !tenantStatusChanged) {
```

Replacement:

```
    // The status write that does NOT ride the PATCH goes through the transition
    // service (setTenantStatus serves every type; spec 2026-10-23 D3):
    //  - a tenant with no type change: a status or porting change (unchanged);
    //  - a type change TO tenant: the PATCH never carries a tenant status and
    //    the server auto-advances to Onboarding, so only a different shown
    //    status (or a porting change - porting is only writable here) needs
    //    this second write; the default case writes ONE milestone, not two;
    //  - a partner, team member or unknown contact with no type change: a
    //    status change, exactly as the header dropdown writes it.
    // Compared against the initial VALID selection (a legacy off-list value
    // was normalized to 'needs_review' on load).
    const portingChanged = porting !== (contact.porting === true);
    const statusTransition = typeChanged
      ? isTenant && (status !== 'onboarding' || portingChanged)
      : isTenant
        ? status !== initialStatus || portingChanged
        : !isLandlord && status !== initialStatus;

    if (Object.keys(result).length === 0 && !statusTransition) {
```

3h. `onSubmit`, the write. Current text:

```
      // Tenant lifecycle status + porting go through setTenantStatus so
      // provenance/derivation apply. The returned contact supersedes the PATCH's.
      // toStatus is GUARANTEED valid here (the selection is kept in the tenant
      // set), but narrow defensively - never cast an unchecked value, and fall
      // back to the front door if somehow off-list.
      if (tenantStatusChanged) {
        const toStatus: TenantStatus = isTenantStatus(status) ? status : 'needs_review';
        updated = await setTenantStatus(contact.contactId, {
          toStatus,
          source: 'manual',
          porting,
        });
      }
```

Replacement:

```
      // The transition-service write (see statusTransition above), AFTER the
      // PATCH so a type change lands first. The returned contact supersedes the
      // PATCH's. toStatus is kept in the live type's list by the select, but
      // narrow defensively - never send an unchecked value; fall back to the
      // front door if somehow off-list. Porting rides only a tenant's write.
      if (statusTransition) {
        const toStatus = (
          validStatusesForType(liveType).includes(status) ? status : 'needs_review'
        ) as ContactStatusValue;
        updated = await setTenantStatus(contact.contactId, {
          toStatus,
          source: 'manual',
          ...(isTenant && { porting }),
        });
      }
```

3i. The select's options. Current text:

```
  // Status options for the live type - ALWAYS just that type's valid set (no
  // off-list value is ever prepended). The selected `status` is guaranteed to be
  // a member (seeded valid; re-derived on type change), so the select never shows
  // nor submits an off-list/type-invalid value.
  const statusOptions = statusOptionsForType(liveType);
```

Replacement:

```
  // Status options for the live type - EXACTLY the header dropdown's list
  // (statusOptionsFor, spec 2026-10-23 D3); no off-list value is ever
  // prepended. The selected `status` is kept a member (seeded valid; moved on
  // a type change), so the select never shows nor submits a type-invalid value.
  const statusOptions = statusOptionsFor(liveType);
```

After the edits, `grep -n "TENANT_STATUS\|LANDLORD_STATUS\|NON_TENANT\|TenantStatus\|isTenantStatus\|statusOptionsForType\|tenantStatusChanged" dashboard/src/routes/contact/ContactEditForm.tsx`
prints nothing.

Step 4 - GREEN: the Step 2 command; the whole file passes. Then the page
suite, which renders this form:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/contact
```

Expected: green.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(contact): the edit form's Status field offers the header's list; type change starts the new type's first step (unknown-inactive D3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S4.5 - the unknown contact card title (D8, AR7)

Files: `dashboard/src/routes/contact/UnknownFile.tsx`,
`dashboard/src/routes/contact/UnknownFile.test.tsx`,
`dashboard/src/routes/contact/ContactDetail.test.tsx`.

Step 1 - failing tests.

1a. `UnknownFile.test.tsx`: let `renderIt` take a contact. Current text:

```
  triageError?: TriageError | null;
} = {}): void {
```

Replacement:

```
  triageError?: TriageError | null;
  contact?: Contact;
} = {}): void {
```

Current text:

```
          contact={UNKNOWN}
```

Replacement:

```
          contact={opts.contact ?? UNKNOWN}
```

Append at the END of the file:

```

// Spec 2026-10-23 D8 (copy: plan ruling AR7): the card reads "Needs triage"
// only while the contact is Needs review; an Inactive one reads "Type
// unknown". The Mark as actions stay and the body copy is unchanged.
describe('UnknownFile - the card title follows the status (spec 2026-10-23 D8)', () => {
  it('(PIN) reads Needs triage while the contact is Needs review', () => {
    renderIt();
    expect(screen.getByRole('heading', { name: 'Needs triage' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Type unknown' })).toBeNull();
  });

  it('reads Type unknown for an Inactive contact and keeps every Mark as action and the body copy', () => {
    renderIt({ contact: { ...UNKNOWN, status: 'inactive' } });
    const card = screen.getByRole('heading', { name: 'Type unknown' }).closest('section') as HTMLElement;
    expect(screen.queryByRole('heading', { name: 'Needs triage' })).toBeNull();
    for (const label of [
      'Mark as Tenant',
      'Mark as Landlord',
      'Mark as Partner',
      'Mark as Caseworker',
      'Mark as Property Manager',
    ]) {
      expect(within(card).getByRole('button', { name: label })).toBeEnabled();
    }
    expect(within(card).getByText(/Tenant, Landlord, Partner, Caseworker, or Property Manager/)).toBeInTheDocument();
    // The Details row names the status.
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });
});
```

1b. `ContactDetail.test.tsx`: the page-level flow. Current text (the end of
the 409 case added in S4.3):

```
    await screen.findByRole('button', { name: 'Contact status: Onboarding' });
  });
```

Replacement (append the new case after it):

```
    await screen.findByRole('button', { name: 'Contact status: Onboarding' });
  });

  it('marking an unknown contact Inactive from the header retitles its card Type unknown; the Mark as actions stay (spec 2026-10-23 D8)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    setTenantStatus.mockResolvedValue({ ...UNKNOWN, status: 'inactive' });
    renderAt('u9');
    await user.click(await screen.findByRole('button', { name: 'Contact status: Needs review' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Inactive' }));
    const card = (await screen.findByRole('heading', { name: 'Type unknown' })).closest('section') as HTMLElement;
    expect(screen.queryByRole('heading', { name: 'Needs triage' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Mark as Tenant' })).toBeEnabled();
  });
```

Step 2 - RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/contact/UnknownFile.test.tsx src/routes/contact/ContactDetail.test.tsx
```

Expected: `reads Type unknown ...` and `marking an unknown contact Inactive
...` fail (no heading "Type unknown" - the title is always "Needs triage");
the (PIN) and every other case pass.

Step 3 - implementation, `UnknownFile.tsx`. Current text:

```
      <Card title="Needs triage">
```

Replacement:

```
      {/* Spec 2026-10-23 D8: "Needs triage" only while the contact is Needs
          review; an Inactive one is not waiting on triage, so it reads "Type
          unknown". The Mark as actions stay - staff still classify one when
          they learn who it is - and the body copy is unchanged. */}
      <Card title={contact.status === 'needs_review' ? 'Needs triage' : 'Type unknown'}>
```

Step 4 - GREEN: the Step 2 command; both files pass in full (every existing
"Needs triage" query uses a needs_review fixture).

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.test.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(contact): an Inactive unknown contact's card reads Type unknown (unknown-inactive D8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S4.6 - check-only surfaces, slice checks and the S4 report

Step 1 - check-only reads (record each result in the report):

- `dashboard/src/ui/StatusMenu.tsx`: generic (`options`, `tone`); its
  `StatusTone` already includes every `BadgeTone` `contactStatusTone`
  returns (`muted` included). No change.
- `dashboard/src/routes/contact/Card.tsx`: `responseClass.inactive` is used
  only by `routes/listing/ListingDetail.tsx` for property `off_market`; no
  contact status class exists. No change.
- `PartnerFile.tsx` (Details "Status" row, `contactStatusLabel(contact.type,
  ...)`), `LandlordFile.tsx` (`contactStatusLabel('landlord', ...)`),
  `TenantFile.tsx` (renders tenants AND team members; the Status row uses
  `contactStatusTone` / `contactStatusLabel`, so an Inactive team member
  reads "Inactive" as plain text, and the header dropdown - S4.3 - lists the
  team member statuses). All read through the S4.2 helpers. No change. Note:
  `TenantFile.tsx` shows a `StatusBadge kind="tenant"` only for a `warn`
  tone (`needs_review`), whose label is the same for every type.

Step 2 - the whole dashboard unit suite (catches any other test that leaned
on the old lists), then typecheck:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run
```

```
cd W:/tmp/unknown-inactive; npm run typecheck
```

Expected: both green. (The mirror test needs S1's backend exports; the
typecheck compiles `app/src/lib/statusModel.ts` once through it.)

Step 3 - lint the touched files (gate 5 ratchet; plan section 0):

```
cd W:/tmp/unknown-inactive; npx eslint dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/statusModel.test.ts dashboard/src/routes/contact/contactStatusMirror.test.ts dashboard/src/routes/contact/format.ts dashboard/src/routes/contact/format.test.ts dashboard/src/ui/StatusBadge.tsx dashboard/src/ui/StatusBadge.test.tsx dashboard/src/routes/contacts/ContactsList.tsx dashboard/src/routes/contacts/ContactsList.test.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.test.tsx
```

Any error: attribute by baseline (run the same paths at the merge base);
anything new is S4's and blocking. (`ContactDetail.tsx` and
`ContactEditForm.tsx` may carry pre-existing `react-hooks/*` errors; name
them in the report.)

Step 4 - ASCII. For the new file:

```
cd W:/tmp/unknown-inactive; tr -d '\11\12\15\40-\176' < dashboard/src/routes/contact/contactStatusMirror.test.ts | wc -c
```

prints 0. For every other touched file (all pre-existing; several already
carry non-ASCII):

```
cd W:/tmp/unknown-inactive; for f in dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/statusModel.test.ts dashboard/src/routes/contact/format.ts dashboard/src/routes/contact/format.test.ts dashboard/src/ui/StatusBadge.tsx dashboard/src/ui/StatusBadge.test.tsx dashboard/src/routes/contacts/ContactsList.tsx dashboard/src/routes/contacts/ContactsList.test.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.test.tsx; do echo "$f $(git diff -U0 main -- "$f" | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c)"; done
```

Every line ends in ` 0`.

Step 5 - write
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S4-report.md`
(ASCII, findings only, `file:line` citations). It records at least:

- the Step 1 check-only results;
- clarification 3 (porting on a type change to tenant also triggers the
  one `setTenantStatus`), and whether the server writes a second milestone
  when that call keeps `onboarding` (read `services/statusTransition.ts`;
  report, do not change);
- clarification 5 (ContactsList non-tenant rows: per-type label, no toned
  badge, so D4.4's muted colour is not shown on those rows) - a planner
  decision, not a builder change;
- the edit form's partner / team member / unknown status write maps a
  `409 contact_type_changed` to the generic "Couldn't save - please try
  again." (the header has its own copy, S4.3); state whether that is
  adequate;
- any pre-existing lint errors named in Step 3;
- anything the tree held that this section got wrong.

Commit it:

```
git -C W:/tmp/unknown-inactive status
git -C W:/tmp/unknown-inactive add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S4-report.md
git -C W:/tmp/unknown-inactive commit -m "docs(records): unknown-inactive S4 slice report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S4 coverage

Spec section 4 surfaces (Dashboard): `dashboard/src/api/types.ts` (the
mirror + the drift guard, D3); `ContactDetail.tsx` (header dropdown for
every type, D2); `ContactEditForm.tsx` (options, type-change default, save
paths, D3); `format.ts` (`contactStatusLabel`), `StatusBadge.tsx` (tone,
D4.4), `StatusMenu.tsx` (check only), `Card.tsx` (check only),
`ContactsList.tsx` (row status label); `UnknownFile.tsx` (D8),
`PartnerFile.tsx`, `TenantFile.tsx` (team_member), `LandlordFile.tsx`
(status display, check only). Not S4: `useInbox.ts`, `InboxRow.tsx`,
`inboxListMerge.ts` (S5) and the Today/Inbox SSE triggers (S2).

Spec section 5 tests: test 7, all parts except the Unknown-tab sort and the
Inactive tag (S5): the header dropdown for partner, team_member and unknown
with the D1 options, calling the transition route (S4.3); the edit form's
options equal the header's for every type (S4.4); an Inactive caseworker
DISPLAYS Inactive and keeps it across an unrelated save (S4.4); a type change
shows the new type's first step and the contact ends with it, tenant target
with no follow-up `setTenantStatus` when Onboarding is kept (S4.4); a
role-only switch and a change-and-back write no status (S4.4); a landlord
park reason survives an edit-form save (S4.4); the mirror test (S4.1); the
card title (S4.5). Also D4.4's muted tone for every type (S4.2) and the
dashboard half of AR4's 409 (S4.3).



## 9. S5 - Dashboard inbox: Inactive tag, triage chip, Unknown-tab sort

Covers spec D9 (dashboard half), rulings AR5 (wire field, dashboard mirror),
AR6 (Unknown-tab comparator), AR7 (tag copy), and the inbox parts of spec
test 7 ("the Unknown-tab sort; the Inactive tag"). Depends on S3 (the server
sends `inactive` and the new `needsTriage`); every S5 test is a dashboard unit
test with mocked rows, so S5 can be built and tested before S3 is deployed
anywhere, but it is built AFTER S3 in the work map.

Files touched by S5 (and nothing else, except the one conditional comment
fix in S5.3 step 6):

- `dashboard/src/api/types.ts` (InboxRow interface only; S2 and S4 edit other
  regions of this file - anchor on the quoted text, never on line numbers)
- `dashboard/src/routes/inbox/InboxRow.tsx`
- `dashboard/src/routes/inbox/InboxRow.module.css`
- `dashboard/src/routes/inbox/InboxRow.test.tsx`
- `dashboard/src/routes/inbox/InboxRow.styles.test.ts`
- `dashboard/src/routes/inbox/inboxListMerge.ts`
- `dashboard/src/routes/inbox/inboxListMerge.test.ts`
- `dashboard/src/routes/inbox/useInbox.ts` (the sort helper at ~148-153, the
  import block at ~39-47 and the render line at ~718 ONLY - S2 edits the
  `useEventStream({ onConversationUpdated: scheduleRefetch });` line at ~563;
  do not touch that line or anchor on it)
- `dashboard/src/routes/inbox/useInbox.test.tsx` (a new describe block appended
  at the end of the file)

### Contradictions and clarifications (read before S5.1)

C1. The brief says useInbox.ts holds "the comment there that records the
2026-08-26 'LEAVE IT' ruling". It does not. `grep -n "LEAVE IT\|RULED\|2026-08-26"
dashboard/src/routes/inbox/useInbox.ts` finds nothing. The ruling is recorded
ONLY at `app/src/routes/inbox.ts:2282-2310` (S3 updates that one). The
useInbox.ts partner is the sort helper's one-line JSDoc at
`useInbox.ts:148`: `/** Newest-activity-first, matching the server's inbox
ordering. */`. S5.3 replaces that JSDoc with the supersession record (spec D9:
"The build updates that comment and the matching one in useInbox.ts").

C2. AR6 says "ties keep the existing tie-break of the newest-first sort". The
existing comparator is NOT in inboxListMerge.ts; it is inline in
`useInbox.ts:149-153` (`sortByActivity`), and it has NO explicit tie-break:
equal instants compare 0 and `Array.prototype.sort` is stable, so ties keep
the order of `baseOf(list)` (head ++ tail, server order). S5.2 moves that
exact comparator body into inboxListMerge.ts as an exported
`compareByActivity`, and `compareUnknownTabRows` falls through to it, so the
tie-break is the same one (stable sort over the same base order).

C3. `app/src/routes/inbox.ts:2298` names the helper:
``(dashboard/src/routes/inbox/useInbox.ts, `sortByActivity` over `visible`)``.
S5.3 renames `sortByActivity` to `sortForFilter`. If S3's rewrite of that
comment still carries the old name, S5.3 step 6 re-points that one reference
(comment only, no code).

C4. Re-sort after SSE and Load more: no extra code is needed. The sort runs at
RENDER over `baseOf(list)` (`useInbox.ts:713-718`), so every commit - a head
read through `mergeHeadRead` (initial load, retry, SSE reconcile), a Load more
page through `appendPage` (`inboxListMerge.ts:145-159`), and a store restore
(`listFromSnapshot`, `useInbox.ts:181-192`; the snapshot keeps SERVER order,
`snapshotOf` at ~164-179) - is re-sorted the same way on the next render.
S5.3 pins the head-read and Load-more cases with tests.

### Task S5.1 - wire field `inactive` and the muted Inactive tag

Files: `dashboard/src/api/types.ts`, `dashboard/src/routes/inbox/InboxRow.tsx`,
`dashboard/src/routes/inbox/InboxRow.module.css`,
`dashboard/src/routes/inbox/InboxRow.test.tsx`,
`dashboard/src/routes/inbox/InboxRow.styles.test.ts`.

Step 1 - failing tests. Append this block at the END of
`dashboard/src/routes/inbox/InboxRow.test.tsx` (after the closing `});` of
`describe('InboxRow - a phone-named row keeps every digit (spec 5.4)', ...)`).
It reuses the file's own `mkRow`, `renderRow`, `cleanupAndRender`, `onOpen`,
`onMarkRead` and imports (`render`, `screen`, `within`, `MemoryRouter`, `vi`
are already imported at the top of the file).

```tsx
// Spec 2026-10-23 D9, rulings AR5 + AR7: a contact row whose contact is
// Inactive carries `inactive: true` on the wire (present and true ONLY then,
// the `deleted?` convention) and renders a muted "Inactive" tag - for any
// contact type, on any tab. The server sets needsTriage false for such a row.
describe('InboxRow - Inactive tag (spec D9, AR5, AR7)', () => {
  it('renders a muted Inactive tag inside the row link when row.inactive is true', () => {
    renderRow(mkRow({ role: 'unknown', inactive: true }));
    const link = screen.getByRole('link', { name: /Tasha Williams/ });
    const tag = within(link).getByText('Inactive');
    expect(tag.className).toMatch(/inactiveTag/);
  });

  it('renders NO Inactive tag on a row without the field', () => {
    renderRow(mkRow({ role: 'unknown' }));
    expect(screen.queryByText('Inactive')).toBeNull();
  });

  it('shows for an Inactive contact of any type, read or unread (Goal 4)', () => {
    renderRow(mkRow({ role: 'tenant', inactive: true, unreadCount: 0 }));
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    cleanupAndRender(mkRow({ role: 'partner', inactive: true, unreadCount: 3 }));
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  // The chip follows the wire flag; the server sends needsTriage false for an
  // Inactive contact (AR5), so no Needs triage chip sits beside the tag. (The
  // first assertion is a PIN; the second is RED until the tag exists.)
  it('an Inactive unknown row with needsTriage false shows no Needs triage chip', () => {
    renderRow(mkRow({ role: 'unknown', inactive: true, needsTriage: false }));
    expect(screen.queryByText(/Needs triage/i)).toBeNull();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  // (PIN) Inactive does not gate the read/unread toggle - only a deleted
  // contact's row and a closed relay row do.
  it('a read Inactive row still offers Mark unread', () => {
    const onMarkUnread = vi.fn();
    render(
      <MemoryRouter>
        <ul>
          <InboxRow
            row={mkRow({ role: 'unknown', inactive: true, unreadCount: 0 })}
            onOpen={onOpen}
            onMarkRead={onMarkRead}
            onMarkUnread={onMarkUnread}
          />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Mark Tasha Williams as unread' })).toBeInTheDocument();
  });
});
```

In `dashboard/src/routes/inbox/InboxRow.styles.test.ts`, Edit:

```ts
  it.each(['.tag', '.deletedTag', '.channel'])('%s is a rigid state marker: no flex-shrink, no min-width: 0', (selector) => {
```

->

```ts
  it.each(['.tag', '.deletedTag', '.inactiveTag', '.channel'])('%s is a rigid state marker: no flex-shrink, no min-width: 0', (selector) => {
```

and insert this case directly AFTER that `it.each(...)` block's closing `});`:

```ts
  // Spec 2026-10-23 D9 / AR7: the Inactive tag is MUTED - the `.tag` look -
  // never the danger tint of `.deletedTag` or the amber of `.triage`.
  it('.inactiveTag is muted: the .tag look, no danger or amber tint', () => {
    const body = bodyOf('.inactiveTag');
    expect(body).toMatch(/(?:^|\s)color:\s*var\(--c-text-muted\)\s*;/);
    expect(body).toMatch(/background:\s*var\(--c-surface-2\)\s*;/);
    expect(body).not.toMatch(/--c-danger|--c-evt-amber/);
  });
```

Step 2 - run RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/inbox/InboxRow.test.tsx src/routes/inbox/InboxRow.styles.test.ts
```

Expected: four InboxRow cases fail with `Unable to find an element with the
text: Inactive` (the first, third and fourth new cases; the fourth passes its
`Needs triage` assertion and fails on `getByText('Inactive')`). The
"renders NO Inactive tag" case and the Mark unread case are PINs and pass.
In the styles file, the `.inactiveTag` rigid case
and the muted case fail with `missing CSS rule for .inactiveTag`. Every
pre-existing case stays green.

Step 3 - implement.

3a. `dashboard/src/api/types.ts`, InboxRow interface. Edit (quoted current
text; the em dash in the `deleted?` JSDoc above it is pre-existing - do not
touch it, and keep every ADDED line ASCII):

```ts
  deleted?: boolean;
  // --- relay_group only (present iff kind === 'relay_group') --------------------
```

->

```ts
  deleted?: boolean;
  /** Inactive contact (spec 2026-10-23 D9, ruling AR5): present and true ONLY
   *  on a contact row whose contact's status is `inactive` (any type) - the
   *  dashboard renders a muted "Inactive" tag, and the Unknown tab sorts these
   *  rows after the Needs review rows (compareUnknownTabRows). Absent on every
   *  other row: live non-inactive contacts, contactless number rows, relay and
   *  group rows. MIRROR of app/src/routes/inbox.ts InboxRow `inactive`. */
  inactive?: boolean;
  // --- relay_group only (present iff kind === 'relay_group') --------------------
```

3b. `dashboard/src/routes/inbox/InboxRow.tsx`. Edit:

```tsx
            {row.needsTriage ? <span className={styles.triage}>Needs triage</span> : null}
            {row.deleted ? <span className={styles.deletedTag}>Deleted</span> : null}
```

->

```tsx
            {row.needsTriage ? <span className={styles.triage}>Needs triage</span> : null}
            {/* Inactive contact (spec 2026-10-23 D9): a muted, rigid state
                marker on a contact row of any type, on any tab. The server
                sends needsTriage false for such a row (AR5), so the tag never
                sits beside the Needs triage chip. */}
            {row.inactive ? <span className={styles.inactiveTag}>Inactive</span> : null}
            {row.deleted ? <span className={styles.deletedTag}>Deleted</span> : null}
```

3c. `dashboard/src/routes/inbox/InboxRow.module.css`. First Edit (the chip
rule comment, so it names the new rigid chip):

```css
   - The channel chip (`.channel`), the relay Closed tag (`.tag`) and the
     Deleted chip (`.deletedTag`) are short fixed-vocabulary state markers and
     NEVER shrink (no flex-shrink, no min-width: 0 - rigid as on main).
```

->

```css
   - The channel chip (`.channel`), the relay Closed tag (`.tag`), the
     Deleted chip (`.deletedTag`) and the Inactive tag (`.inactiveTag`) are
     short fixed-vocabulary state markers and NEVER shrink (no flex-shrink,
     no min-width: 0 - rigid as on main).
```

Second Edit (insert the new rule after `.deletedTag`; anchor on the end of the
`.deletedTag` rule and the start of `.preview`):

```css
  color: var(--c-danger);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}

.preview {
```

->

```css
  color: var(--c-danger);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}

/* Inactive contact (spec 2026-10-23 D9): MUTED - the `.tag` look
   (declarations duplicated: this module does not use `composes`), so it reads
   as a quiet status note, not a warning. A rigid state marker (the chip rule
   above). */
.inactiveTag {
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  white-space: nowrap;
}

.preview {
```

Step 4 - run GREEN (same command as step 2) - all cases pass. Then the
dashboard typecheck (the new tests use `inactive` on `Partial<InboxRow>`):

```
cd W:/tmp/unknown-inactive/dashboard; npx tsc -p tsconfig.json --noEmit
```

Expect exit 0. ASCII check on the added lines of each touched file:

```
cd W:/tmp/unknown-inactive; for f in dashboard/src/api/types.ts dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.module.css dashboard/src/routes/inbox/InboxRow.test.tsx dashboard/src/routes/inbox/InboxRow.styles.test.ts; do echo "$f $(git diff -U0 -- "$f" | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c)"; done
```

Every line must end in ` 0`.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
test ! -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD" && echo no-merge-in-progress
git -C W:/tmp/unknown-inactive add dashboard/src/api/types.ts dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.module.css dashboard/src/routes/inbox/InboxRow.test.tsx dashboard/src/routes/inbox/InboxRow.styles.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(inbox): muted Inactive tag on an Inactive contact's inbox row (spec D9, AR5, AR7)" -m "InboxRow gains inactive?: boolean, mirroring the server field. The row renders a rigid, muted Inactive tag beside the Needs triage / Deleted chips; the triage chip keeps following needsTriage." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Read the `git status` output before the `add`: only the five paths above may
be staged by this task. Stop if MERGE_HEAD exists.)

### Task S5.2 - `compareByActivity` and `compareUnknownTabRows` in inboxListMerge.ts

Files: `dashboard/src/routes/inbox/inboxListMerge.ts`,
`dashboard/src/routes/inbox/inboxListMerge.test.ts`.

Step 1 - failing tests. In `dashboard/src/routes/inbox/inboxListMerge.test.ts`
Edit the import block:

```ts
import {
  appendPage,
  baseOf,
  dedupeConversations,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';
```

->

```ts
import {
  appendPage,
  baseOf,
  compareByActivity,
  compareUnknownTabRows,
  dedupeConversations,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';
```

Then append at the END of the file (after the `describe('patchUnread', ...)`
block). It uses the file's own `contact(id, at, over)` and `ids(rows)`
helpers.

```ts
// The newest-first comparator every tab but Unknown renders with, moved here
// from useInbox.ts (where it was `sortByActivity`) so the Unknown-tab
// comparator can reuse it, tie-break included.
describe('compareByActivity', () => {
  it('orders newest activity first; equal instants compare 0', () => {
    const older = contact('old', '2026-06-10T10:00:00.000Z');
    const newer = contact('new', '2026-06-20T10:00:00.000Z');
    expect(compareByActivity(newer, older)).toBeLessThan(0);
    expect(compareByActivity(older, newer)).toBeGreaterThan(0);
    expect(compareByActivity(older, contact('twin', '2026-06-10T10:00:00.000Z'))).toBe(0);
  });
});

// Spec 2026-10-23 D9 / ruling AR6: on the Unknown tab the LOADED rows render
// Needs review first, then Inactive, each newest message first. "Inactive" is
// the wire flag `inactive: true` (AR5); a row without it - a Needs review
// contact or a contactless number row - is in the first group.
describe('compareUnknownTabRows (spec D9, AR6)', () => {
  const nrNew = contact('nr-new', '2026-06-18T10:00:00.000Z', { role: 'unknown', needsTriage: true });
  const nrOld = contact('nr-old', '2026-06-10T10:00:00.000Z', { role: 'unknown', needsTriage: true });
  const inNew = contact('in-new', '2026-06-20T10:00:00.000Z', { role: 'unknown', inactive: true });
  const inOld = contact('in-old', '2026-06-15T10:00:00.000Z', { role: 'unknown', inactive: true });
  const numberRow: InboxRow = {
    ...contact('n', '2026-06-12T10:00:00.000Z', { needsTriage: true }),
    kind: 'unknown',
    contactId: undefined,
    phone: '+15550001111',
  };

  it('a row without inactive sorts before an Inactive row, even an older one before a newer one', () => {
    expect(compareUnknownTabRows(nrOld, inNew)).toBeLessThan(0);
    expect(compareUnknownTabRows(inNew, nrOld)).toBeGreaterThan(0);
  });

  it('orders newest first inside each group', () => {
    expect(compareUnknownTabRows(nrNew, nrOld)).toBeLessThan(0);
    expect(compareUnknownTabRows(nrOld, nrNew)).toBeGreaterThan(0);
    expect(compareUnknownTabRows(inNew, inOld)).toBeLessThan(0);
    expect(compareUnknownTabRows(inOld, inNew)).toBeGreaterThan(0);
  });

  it('equal instants in one group compare 0, so the stable sort keeps the list order (the newest-first tie-break)', () => {
    const x = contact('x', '2026-06-12T10:00:00.000Z', { inactive: true });
    const y = contact('y', '2026-06-12T10:00:00.000Z', { inactive: true });
    expect(compareUnknownTabRows(x, y)).toBe(0);
    expect(ids([x, y].sort(compareUnknownTabRows))).toEqual(['c:x', 'c:y']);
    expect(ids([y, x].sort(compareUnknownTabRows))).toEqual(['c:y', 'c:x']);
  });

  it('only a present true value moves a row down (inactive: false is not Inactive)', () => {
    const notInactive = contact('f', '2026-06-01T10:00:00.000Z', { inactive: false });
    expect(compareUnknownTabRows(notInactive, inOld)).toBeLessThan(0);
  });

  it('sorts a mixed list: Needs review rows (a contactless number row among them) newest first, then Inactive newest first', () => {
    const sorted = [inOld, nrOld, numberRow, inNew, nrNew].sort(compareUnknownTabRows);
    expect(ids(sorted)).toEqual(['c:nr-new', 'u:+15550001111', 'c:nr-old', 'c:in-new', 'c:in-old']);
  });
});
```

Step 2 - run RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/inbox/inboxListMerge.test.ts
```

Expected: every new case fails with `TypeError: ... compareByActivity is not a
function` / `... compareUnknownTabRows is not a function` (the exports do not
exist yet, so the imports resolve to `undefined`). Every pre-existing case
stays green.

Step 3 - implement. In `dashboard/src/routes/inbox/inboxListMerge.ts` Edit
(insert the two comparators between `baseOf` and `isAdditive`):

```ts
export function baseOf(state: ListState): InboxRow[] {
  return [...state.head, ...state.tail];
}

function isAdditive(row: InboxRow, filter: InboxFilter): boolean {
```

->

```ts
export function baseOf(state: ListState): InboxRow[] {
  return [...state.head, ...state.tail];
}

/** Newest-activity-first, matching the server's inbox ordering: the render
 *  order of every tab but Unknown. Equal instants compare 0, so the stable
 *  `Array.prototype.sort` keeps the list's own (head ++ tail, server) order
 *  for ties - that IS the tie-break, and compareUnknownTabRows reuses it.
 *  Moved here unchanged from useInbox.ts (`sortByActivity`). */
export function compareByActivity(a: InboxRow, b: InboxRow): number {
  return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
}

/** The Unknown tab's render order (spec 2026-10-23 D9, ruling AR6): rows
 *  WITHOUT `inactive` (Needs review contacts and contactless number rows)
 *  before rows with `inactive: true`, then newest activity first inside each
 *  group with compareByActivity's tie-break. It orders the LOADED rows only;
 *  which rows are loaded is the server's block order (needs_review, then
 *  inactive). */
export function compareUnknownTabRows(a: InboxRow, b: InboxRow): number {
  const aInactive = a.inactive === true ? 1 : 0;
  const bInactive = b.inactive === true ? 1 : 0;
  if (aInactive !== bInactive) return aInactive - bInactive;
  return compareByActivity(a, b);
}

function isAdditive(row: InboxRow, filter: InboxFilter): boolean {
```

Step 4 - run GREEN (same command as step 2) - all cases pass. ASCII check:

```
cd W:/tmp/unknown-inactive; for f in dashboard/src/routes/inbox/inboxListMerge.ts dashboard/src/routes/inbox/inboxListMerge.test.ts; do echo "$f $(git diff -U0 -- "$f" | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c)"; done
```

Every line must end in ` 0`.

Step 5 - commit:

```
git -C W:/tmp/unknown-inactive status
test ! -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD" && echo no-merge-in-progress
git -C W:/tmp/unknown-inactive add dashboard/src/routes/inbox/inboxListMerge.ts dashboard/src/routes/inbox/inboxListMerge.test.ts
git -C W:/tmp/unknown-inactive commit -m "feat(inbox): compareUnknownTabRows - Needs review first, then Inactive, each newest first (spec D9, AR6)" -m "The newest-first comparator moves into inboxListMerge.ts as compareByActivity (same body, same stable-sort tie-break) so the Unknown-tab comparator can reuse it." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task S5.3 - useInbox sorts the Unknown tab with compareUnknownTabRows

Files: `dashboard/src/routes/inbox/useInbox.ts`,
`dashboard/src/routes/inbox/useInbox.test.tsx`; conditionally one comment in
`app/src/routes/inbox.ts` (step 6).

Step 1 - failing tests. Append this block at the END of
`dashboard/src/routes/inbox/useInbox.test.tsx` (after the closing `});` of
`describe('useInbox + Inbox - the scroll root after an error with rows (R2-3)', ...)`).
It uses the file's own `getInbox` mock, `sse` capture, `mkRow`, `pageOf` and
`Probe` (whose `ids` testid renders `rowKey` per row, in render order), and
the already-imported `act`, `render`, `screen`, `waitFor`, `describe`, `it`,
`expect`. `beforeEach` at the top of the file already resets `getInbox`, the
store and `sse`.

```tsx
// Spec 2026-10-23 D9 / ruling AR6, superseding the 2026-08-26 "LEAVE IT"
// ruling: on the Unknown tab the LOADED rows render Needs review first, then
// Inactive, each newest message first; every other tab stays newest-first.
// Every Inactive fixture is NEWER than a Needs review one, so the old global
// newest-first sort interleaves them and fails each Unknown case.
describe('useInbox - Unknown tab order (spec D9, AR6)', () => {
  const nrNew = mkRow({ contactId: 'nr-new', role: 'unknown', needsTriage: true, lastActivityAt: '2026-06-18T10:00:00.000Z' });
  const nrOld = mkRow({ contactId: 'nr-old', role: 'unknown', needsTriage: true, lastActivityAt: '2026-06-10T10:00:00.000Z' });
  const inNew = mkRow({ contactId: 'in-new', role: 'unknown', inactive: true, lastActivityAt: '2026-06-20T10:00:00.000Z' });
  const inOld = mkRow({ contactId: 'in-old', role: 'unknown', inactive: true, lastActivityAt: '2026-06-15T10:00:00.000Z' });
  const order = (): string | null => screen.getByTestId('ids').textContent;

  it('Unknown tab: loaded rows are Needs review first, then Inactive, each newest first', async () => {
    getInbox.mockResolvedValue(pageOf([inOld, nrOld, inNew, nrNew]));
    render(<Probe filter="unknown" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(order()).toBe('c:nr-new,c:nr-old,c:in-new,c:in-old');
  });

  it('Unknown tab: the order holds after Load more appends newer Inactive rows', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([nrNew, nrOld], 'CUR'))
      .mockResolvedValueOnce(pageOf([inNew, inOld], null));
    render(<Probe filter="unknown" />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    expect(order()).toBe('c:nr-new,c:nr-old');
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'));
    expect(order()).toBe('c:nr-new,c:nr-old,c:in-new,c:in-old');
  });

  it('Unknown tab: a row that flips to Inactive moves below the Needs review rows on the next head read', async () => {
    const flipBefore = mkRow({ contactId: 'flip', role: 'unknown', needsTriage: true, lastActivityAt: '2026-06-20T10:00:00.000Z' });
    const flipAfter = mkRow({ contactId: 'flip', role: 'unknown', needsTriage: false, inactive: true, lastActivityAt: '2026-06-20T10:00:00.000Z' });
    const stay = mkRow({ contactId: 'stay', role: 'unknown', needsTriage: true, lastActivityAt: '2026-06-10T10:00:00.000Z' });
    getInbox
      .mockResolvedValueOnce(pageOf([flipBefore, stay]))
      .mockResolvedValueOnce(pageOf([stay, flipAfter]));
    render(<Probe filter="unknown" />);
    await waitFor(() => expect(order()).toBe('c:flip,c:stay'));
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x', last_activity_at: '2026-06-20T10:00:00.000Z', unread_count: 0,
        type: 'unknown_1to1', participant_display_name: null,
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(order()).toBe('c:stay,c:flip'));
  });

  // (PIN) Every other tab keeps newest-first, Inactive rows included.
  it.each(['all', 'unread'] as const)('(PIN) %s tab: the same rows stay newest-first', async (filter) => {
    getInbox.mockResolvedValue(pageOf([inOld, nrOld, inNew, nrNew]));
    render(<Probe filter={filter} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(order()).toBe('c:in-new,c:nr-new,c:in-old,c:nr-old');
  });
});
```

(`mkRow` defaults `unreadCount: 2`, so all four rows survive the Unread
tab's client narrowing. `type: 'unknown_1to1'` is a `ConversationType`; the
event only schedules the debounced head read, `useInbox.ts:553-563`.)

Step 2 - run RED:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/inbox/useInbox.test.tsx
```

Expected: the three Unknown cases fail on their order assertion - received
`c:in-new,c:nr-new,c:in-old,c:nr-old` for the first two, and the flip case's
last `waitFor` times out having received `c:flip,c:stay`. The two PIN cases
pass. Every pre-existing case stays green.

Step 3 - implement in `dashboard/src/routes/inbox/useInbox.ts`.

3a. Edit the inboxListMerge import (the block at ~39-47):

```ts
import {
  appendPage,
  baseOf,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';
```

->

```ts
import {
  appendPage,
  baseOf,
  compareByActivity,
  compareUnknownTabRows,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';
```

3b. Edit the sort helper (~148-153):

```ts
/** Newest-activity-first, matching the server's inbox ordering. */
function sortByActivity(rows: InboxRowData[]): InboxRowData[] {
  return [...rows].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}
```

->

```ts
/** The render order of the loaded rows.
 *
 *  Every tab but Unknown: newest activity first, matching the server's inbox
 *  ordering (compareByActivity, inboxListMerge.ts).
 *
 *  The Unknown tab ONLY: Needs review rows first, then Inactive rows, each
 *  newest message first (compareUnknownTabRows, spec 2026-10-23 D9, ruling
 *  AR6). This SUPERSEDES the 2026-08-26 ruling recorded in
 *  app/src/routes/inbox.ts at the Unknown branch's per-page sort ("RULED
 *  2026-08-26: LEAVE IT ... Do NOT 'fix' either side"), under which this
 *  helper re-sorted EVERY filter newest-first with no filter gate, so the
 *  operator never saw the server's untriaged-first block order once Load more
 *  ran. Superseded by Cameron, 2026-10-23: "it should be ordered by needs
 *  review first and then by newest message", and "let's not do sorting
 *  server- and database-side for now ... we can do that browser-side". So the
 *  order is a property of the LOADED rows: the server's block order
 *  (needs_review, then inactive) still decides which rows arrive first, and a
 *  global order across unloaded pages stays filed as
 *  docs/issues/denormalize-contact-last-activity-for-ordered-paging.md.
 *
 *  It runs at RENDER over head ++ tail, so every commit - a head read
 *  (initial, retry, SSE reconcile), a Load more page, a store restore - comes
 *  out in this order; the store itself keeps server order (snapshotOf). The
 *  sort is stable, so rows with equal instants keep the list's order on every
 *  tab. */
function sortForFilter(rows: InboxRowData[], filter: InboxFilter): InboxRowData[] {
  return [...rows].sort(filter === 'unknown' ? compareUnknownTabRows : compareByActivity);
}
```

(`InboxFilter` is already imported as a type from `../../api/index.js` at the
top of the file.)

3c. Edit the render line (~718):

```ts
  const rows = sortByActivity(visible);
```

->

```ts
  const rows = sortForFilter(visible, filter);
```

Step 4 - run GREEN:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/inbox/useInbox.test.tsx src/routes/inbox/inboxListMerge.test.ts src/routes/inbox/Inbox.test.tsx
```

All pass (Inbox.test.tsx is the composed consumer of the hook; it must stay
green). Then:

```
cd W:/tmp/unknown-inactive/dashboard; npx tsc -p tsconfig.json --noEmit
```

Expect exit 0 (an unused `sortByActivity` left behind would not fail tsc but
would fail lint - confirm `grep -n "sortByActivity" dashboard/src/routes/inbox/useInbox.ts`
from the worktree root prints nothing).

Step 5 - ASCII check:

```
cd W:/tmp/unknown-inactive; for f in dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/useInbox.test.tsx; do echo "$f $(git diff -U0 -- "$f" | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c)"; done
```

Every line must end in ` 0`.

Step 6 - the server comment's citation (C3). Run from the worktree root:

```
cd W:/tmp/unknown-inactive; grep -n "sortByActivity" app/src/routes/inbox.ts
```

- No output: nothing to do (S3's rewrite already names the new helper).
- A line printed: Edit that ONE comment phrase in `app/src/routes/inbox.ts`,
  replacing the text `` `sortByActivity` over `visible` `` with
  `` `sortForFilter` over `visible` `` and leaving the rest of the comment
  as S3 wrote it. Comment-only; no app test is needed. Add
  `app/src/routes/inbox.ts` to the commit below and confirm its added lines
  are ASCII with the step 5 command on that path.

Do NOT edit the historical records that also name `sortByActivity`
(`docs/superpowers/plans/2026-06-17-inbox-frontend-plan.md`,
`docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md`, the
`docs/superpowers/reviews/2026-08-25-*` and `2026-09-25-*` records, and
`docs/issues/thread-hooks-refetch-whole-page-per-event.md:158`, which cites
`useInbox.ts:117-121` as of an older revision). Name them in the slice report.

Step 7 - commit:

```
git -C W:/tmp/unknown-inactive status
test ! -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD" && echo no-merge-in-progress
git -C W:/tmp/unknown-inactive add dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/useInbox.test.tsx
git -C W:/tmp/unknown-inactive commit -m "feat(inbox): Unknown tab renders Needs review first, then Inactive, each newest first (spec D9, AR6)" -m "useInbox sorts with compareUnknownTabRows on the Unknown filter only; every other tab keeps compareByActivity. The sort helper's comment records Cameron's 2026-10-23 supersession of the 2026-08-26 LEAVE IT ruling." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(If step 6 edited `app/src/routes/inbox.ts`, add it to the `git add` paths.)

### Task S5.4 - slice-end checks and the S5 report

Step 1 - the slice's dashboard tests together:

```
cd W:/tmp/unknown-inactive/dashboard; npx vitest run src/routes/inbox
```

All pass.

Step 2 - lint on the files S5 touched (gate 5 shape, this slice's files only;
this list is never empty, so the repo-wide trap does not apply):

```
cd W:/tmp/unknown-inactive; npx eslint dashboard/src/api/types.ts dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.test.tsx dashboard/src/routes/inbox/InboxRow.styles.test.ts dashboard/src/routes/inbox/inboxListMerge.ts dashboard/src/routes/inbox/inboxListMerge.test.ts dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/useInbox.test.tsx
```

Expected: exit 0 (`docs/issues/lint-backlog-repo-wide.md` lists no
dashboard inbox file). If an error is reported, attribute it by baseline as AGENTS.md
gate 5 says: run the same command against the same paths at main @916258ae
(the shared checkout at `W:\AI Projects\Housing Choice\HC Application` is on
main; read it there, never move its HEAD, never `git stash` here) and diff
the two outputs. An error present here and absent there is S5's and is fixed
before the report; a pre-existing one is named in the report and left.

Step 3 - write
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S5-report.md`
(ASCII, findings only, citing `file:line`). It must record at least:

- C1: useInbox.ts carried no comment recording the 2026-08-26 ruling; the
  sort helper's JSDoc (useInbox.ts, `sortForFilter`) now records the
  supersession.
- C2: the newest-first comparator moved to inboxListMerge.ts as
  `compareByActivity`; the tie-break is the stable sort over head ++ tail.
- C3: whether step 6 of S5.3 edited `app/src/routes/inbox.ts` (and the line),
  and the historical records left naming `sortByActivity`.
- Risk (not measured by S5): a soft-deleted Inactive contact's resurfaced row
  carries BOTH rigid chips (Deleted and Inactive); at 360px the name yields
  to them. S6's live self-QA should look at one such row if it can build it.
- Untrimmed input paths: none (S5 adds no input; D10).
- For S6 (e2e): the tag is a plain `<span>` with the exact text `Inactive`
  inside the row's link - select the row with
  `getByRole('link', { name: /<contact name>/ })` and then
  `getByText('Inactive', { exact: true })` within it. On the Unknown tab the
  Inactive rows render after every Needs review row that is LOADED.

Commit it:

```
git -C W:/tmp/unknown-inactive status
test ! -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/unknown-inactive/MERGE_HEAD" && echo no-merge-in-progress
git -C W:/tmp/unknown-inactive add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S5-report.md
git -C W:/tmp/unknown-inactive commit -m "docs(records): unknown-inactive S5 slice report (dashboard inbox)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### S5 coverage

Spec section 4 surfaces covered:

- Dashboard: `dashboard/src/routes/inbox/useInbox.ts`, `InboxRow.tsx`,
  `inboxListMerge.ts` - Unknown-tab sort, Inactive tag, triage chip (D9).
- Dashboard: `dashboard/src/api/types.ts` - the InboxRow `inactive` wire
  mirror only (the status mirror module in that file is S4's).
- Readers: `app/src/routes/inbox.ts` - only the conditional re-pointing of the
  superseded ruling comment's helper name (S3 owns the comment).

Spec section 5 tests covered:

- Test 7 (dashboard), the inbox parts: "the Unknown-tab sort" (S5.2
  comparator cases; S5.3 Unknown head read, Load more and flip cases; All and
  Unread PINs) and "the Inactive tag" (S5.1, any type, read and unread, muted
  style pin).
- Test 5 (inbox), dashboard side only: `needsTriage` false renders no Needs
  triage chip on an Inactive row (S5.1 PIN); the server half is S3's.

Not covered here (other slices): the SSE trigger that refetches the inbox on
a status change (`contact.updated`, S2), the server `inactive` field,
`needsTriage` rule and block order (S3), and the e2e walk (S6).



## 10. S6 - e2e spec, docs, Today fallback watch (W3)

Depends on S1-S5 (all committed). Covers spec test 8, rulings AR12 and AR13,
watch item W3.

### Contradictions

1. The S6 brief says `caseworkers.spec.ts` "is named in the spec as needing
   update for the header dropdown". It is not named in the spec, the plan or
   the review records (grep of `docs/superpowers/specs/2026-10-23-*`,
   `docs/superpowers/plans/2026-10-23-*`,
   `docs/superpowers/reviews/2026-10-23-unknown-inactive/` finds nothing). On
   the code it needs NO edit:
   - `e2e/tests/dashboard-next/caseworkers.spec.ts:274-279` addresses the
     partner page by `getByText('Caseworker', { exact: true }).first()` and
     `getByRole('button', { name: 'More actions' })` /
     `getByRole('menuitem', { name: 'Make caseworker', exact: true })`. The new
     header control is a button named `Contact status: Active` (no substring of
     `More actions`), and its items are `menuitemradio`, which
     `getByRole('menuitem')` does not match. The dropdown only renders its
     menu while open.
   - `caseworkers.spec.ts:515-516` reads the Unknown card by
     `getByRole('heading', { name: 'Needs triage' })` on a Needs review
     contact; D8 keeps that title while the contact is Needs review.
   - `caseworkers.spec.ts:289` and `:538` read `status: 'active'` after a
     conversion; D7 leaves the conversion writing Active.
   So S6.1 RUNS it as a regression pin instead of editing it.
2. AR13 says GLOSSARY.md "updates the inactive ... wording". There is no
   `inactive` entry today (`grep -n -i inactive documentation/GLOSSARY.md`
   finds only `:644`, inside "waiting on a reply"). S6.3 ADDS an
   **Inactive** entry and updates "waiting on a reply"; it also corrects one
   sentence in the **signed up** entry (`GLOSSARY.md:697-700`) that D5 made
   wrong for an Inactive unknown contact. Closest reading of AR13; no
   deviation in intent.

### Cross-slice names this slice depends on (verify in S6.1 step 1)

- S4: the contact page header renders `StatusMenu` with `label="Contact status"`
  for an unknown contact (trigger accessible name `Contact status: <label>`,
  menu accessible name `Contact status`), options exactly Needs review,
  Inactive. The Unknown card's `Card title` reads `Type unknown` for an
  Inactive unknown contact (AR7).
- S5: an inbox row of an Inactive contact renders the visible text
  `Inactive` (exactly) inside its `<li>` (AR7), and no `Needs triage` chip.
  The Unknown tab sorts loaded rows Needs review first via
  `compareUnknownTabRows` (AR6) in `dashboard/src/routes/inbox/useInbox.ts`.
- S3: the AR8 skip in the Today collect loop (`app/src/routes/today.ts`) and
  the AR5 wire field `inactive: true`.
- S2: an open Today page refetches on `contact.updated` (AR3).

If an as-built name differs, change ONLY the spec's `UI` constants object and
record the difference in the S6 report.

---

### Task S6.1 - the e2e spec (spec test 8) and its selector rows

Files:
- Create `e2e/tests/dashboard-next/unknown-inactive.spec.ts`
- Modify `e2e/support/selectors.md` (two new rows)
- Create (gitignored, not committed) `W:/tmp/unknown-inactive/.superpowers/s6/run-spec.sh`

Why it builds its own state (AR12): the lean seed holds ZERO unknown
contacts (`e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:121-124`
relies on that), and an inbound text from a never-seen number makes the
app capture an `(unknown, needs_review)` stub with an `unknown_1to1` thread
(`app/src/services/contactCapture.ts:3`, `:77-80`;
`caseworkers.spec.ts:506-516` drives exactly that with `sendExtractSms`).
So no lean-seed contact is needed. The texts go straight to the app's
signed SMS webhook through `postInboundSms` (`e2e/fixtures/fakeTwilio.ts:62-100`),
which needs no fake persona registration.

Step 1 - confirm the as-built names (read-only):

```
cd W:/tmp/unknown-inactive
grep -n 'label="Contact status"' dashboard/src/routes/contact/ContactDetail.tsx
grep -n "Type unknown" dashboard/src/routes/contact/UnknownFile.tsx
grep -n "Inactive" dashboard/src/routes/inbox/InboxRow.tsx
grep -n "compareUnknownTabRows" dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/inboxListMerge.ts
grep -n "inactive" app/src/routes/today.ts
```

Expect: one StatusMenu path that serves every non-deleted type with
`label="Contact status"`; `Type unknown` in UnknownFile; an `Inactive` tag
in InboxRow; the comparator used in useInbox; the AR8 skip in today.ts.

Step 2 - write the spec, complete:

```ts
// e2e/tests/dashboard-next/unknown-inactive.spec.ts
//
// Inactive for every contact type (tracker #30; spec
// docs/superpowers/specs/2026-10-23-unknown-inactive-design.md, test 8):
// staff mark an unknown Needs review contact Inactive from the contact page
// HEADER DROPDOWN, without giving it a type. It leaves Today's Needs you now
// (live, on an already-open Today page), stays on Contacts > Unknown, sits on
// the inbox Unknown tab BELOW the Needs review rows with an "Inactive" tag, and
// a new inbound text from it shows unread in the inbox without putting it back
// in Needs you now or moving its status.
//
// STATE. Every test reseeds first and last. The lean world holds ZERO unknown
// contacts (unknown-caller-triage.spec.ts relies on that), so after the reseed
// every unknown contact on the lane is one this test made, and the reseed
// after keeps this test's Inactive contact and unread rows out of later
// specs. The test builds two unknown contacts from inbound texts: A, the one
// marked Inactive, and B, a Needs review POSITIVE CONTROL that must stay on
// Needs you now and sit ABOVE A on the Unknown tab. No lean-seed contact is
// added (plan AR12).
//
// THE TEXTS go straight to the app's signed SMS webhook (postInboundSms), so
// no fake persona is needed: the inbound pipeline captures each new number as
// an (unknown, needs_review) stub with an unknown_1to1 thread. B is texted
// FIRST, so A's activity is newer: a newest-first sort would put A ABOVE B,
// and only the Unknown tab's Needs-review-first sort (D9) puts it below.
//
// UNREAD ORDERING. Opening a contact page marks every thread of the contact
// read (useMarkContactRead). A's page is opened BEFORE the Today page, so the
// read and its refetch have landed before the Today page starts watching; the
// second inbound's unread is asserted on the inbox and on Today BEFORE the
// last visit to A's page.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** Every accessible name and copy string this spec uses. If an as-built name
 *  differs, change it HERE only. */
const UI = {
  statusTrigger: (label: string): string => `Contact status: ${label}`,
  statusMenu: 'Contact status',
  needsReview: 'Needs review',
  inactive: 'Inactive',
  active: 'Active',
  triageCard: 'Needs triage',
  typeUnknownCard: 'Type unknown',
  markAsTenant: 'Mark as Tenant',
  needsYouNow: 'Needs you now',
  newUnknown: 'New unknown contact',
  inboxList: 'Conversations',
  unknownTab: 'Unknown',
  contactsUnknownList: 'Unknown',
  triageChip: 'Needs triage',
  inactiveTag: 'Inactive',
  unreadOne: '1 unread',
};

/** A window flag set on the open Today page; still set later = no reload. */
const NO_RELOAD = '__hcUnknownInactiveNoReload';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164: +1 555 8 <4 stamp digits> <2-digit index>. The leading
 *  8 keeps it clear of the lean seed's +1555010000x numbers, the fake's
 *  +155501990xx ad-hoc range and the app number. */
function mintNumber(stamp: string, i: number): string {
  return `+15558${stamp.slice(-4)}${String(i).padStart(2, '0')}`;
}

/** "+15551234567" -> "(555) 123-4567", how the app shows an unnamed contact. */
function displayOf(e164: string): string {
  const d = e164.replace(/\D/g, '').slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

let sidSeq = 0;
/** A per-call-unique inbound MessageSid (the webhook dedupes by SID). */
function uniqueSid(): string {
  sidSeq += 1;
  return `SMui${Date.now()}${sidSeq}`;
}

/** One signed inbound SMS from `from` to the business number. */
async function textIn(request: APIRequestContext, from: string, body: string): Promise<void> {
  const res = await postInboundSms(request, { from, body, messageSid: uniqueSid() });
  expect(res.status, `inbound webhook from ${from}: ${res.body}`).toBe(200);
}

/** The unknown contact the inbound captured, by the EXACT ?phone= lookup
 *  (the caseworkers.spec.ts idiom: never a scan of ?type=unknown). */
async function findUnknownContactId(api: APIRequestContext, phone: string): Promise<string> {
  let contactId: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        const { contacts } = (await res.json()) as {
          contacts: Array<{ contactId: string; type?: string }>;
        };
        contactId = contacts.find((c) => c.type === 'unknown')?.contactId;
        return contactId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return contactId as string;
}

async function readStatus(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), `read contact ${contactId}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { contact: { status?: string } }).contact.status;
}

interface TodayWireItem {
  group: string;
  refType: string;
  refId: string;
}

/** The contact ids on Today's Needs you now, server truth. Throws on a
 *  non-200 so a failed read can never pass a "not in" check. */
async function needsYouNowIds(api: APIRequestContext): Promise<string[]> {
  const res = await api.get(`${NEXT}/api/today`);
  if (res.status() !== 200) throw new Error(`GET /api/today: ${res.status()} ${await res.text()}`);
  const { items } = (await res.json()) as { items: TodayWireItem[] };
  return items.filter((i) => i.group === 'needs_you_now' && i.refType === 'contact').map((i) => i.refId);
}

interface InboxWireRow {
  contactId?: string;
  unreadCount: number;
  needsTriage: boolean;
  inactive?: boolean;
}

/** One contact's row in an inbox feed (absent = not in that feed). */
async function inboxWireRow(
  api: APIRequestContext,
  filter: 'unread' | 'unknown',
  contactId: string,
): Promise<InboxWireRow | undefined> {
  const res = await api.get(`${NEXT}/api/inbox?filter=${filter}&limit=100`);
  if (!res.ok()) throw new Error(`GET /api/inbox?filter=${filter}: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { rows: InboxWireRow[] }).rows.find((r) => r.contactId === contactId);
}

/** A "New unknown contact" row on Today's Needs you now, by the display phone. */
function todayRow(page: Page, phone: string): Locator {
  return page.getByRole('list', { name: UI.needsYouNow }).getByRole('link').filter({ hasText: displayOf(phone) });
}

function inboxList(page: Page): Locator {
  return page.getByRole('list', { name: UI.inboxList, exact: true });
}

/** An inbox row by its contact href (the inbox-nav-badge.spec.ts idiom). */
function inboxRow(page: Page, contactId: string): Locator {
  return inboxList(page)
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/contacts/${contactId}"]`) });
}

function statusTrigger(page: Page, label: string): Locator {
  return page.getByRole('button', { name: UI.statusTrigger(label), exact: true });
}

test.describe('Inactive for an unknown contact', () => {
  test.beforeEach(async ({ request }) => {
    await reseed(request);
  });
  test.afterEach(async ({ request }) => {
    await reseed(request);
  });

  test('the header dropdown marks an unknown contact Inactive: off Needs you now, still in the inbox, status kept', async ({
    page,
    request,
  }) => {
    test.slow(); // a reseed each side, three inbounds, two pages and several feeds
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const phoneB = mintNumber(stamp, 0); // stays Needs review: the positive control
    const phoneA = mintNumber(stamp, 1); // marked Inactive

    await devLogin(page);

    // (1) Two unknown contacts from inbound texts - B first, so A is newer.
    await textIn(request, phoneB, `hello from the control ${stamp}`);
    const idB = await findUnknownContactId(api, phoneB);
    await textIn(request, phoneA, `hello from the subject ${stamp}`);
    const idA = await findUnknownContactId(api, phoneA);
    expect(await readStatus(api, idA)).toBe('needs_review');
    expect(await readStatus(api, idB)).toBe('needs_review');

    // (2) A's contact page: the header carries the DROPDOWN (not a display-only
    //     badge) with exactly the unknown statuses. Opening the page marks A's
    //     thread read; wait for that to land so nothing from it is in flight
    //     when the Today page starts watching below.
    await page.goto(`${NEXT}/contacts/${idA}`);
    await expect(page.getByRole('heading', { name: UI.triageCard })).toBeVisible();
    await expect(statusTrigger(page, UI.needsReview)).toBeEnabled();
    await expect
      .poll(async () => (await inboxWireRow(api, 'unread', idA)) === undefined, { timeout: 15_000 })
      .toBe(true);

    // (3) An OPEN Today page, on the event stream, shows both contacts.
    const today = await page.context().newPage();
    const streamOpen = today.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
    );
    await today.goto(`${NEXT}/`);
    await expectTodayReady(today);
    await streamOpen;
    await expect(todayRow(today, phoneA)).toBeVisible();
    await expect(todayRow(today, phoneA)).toContainText(UI.newUnknown);
    await expect(todayRow(today, phoneB)).toBeVisible();
    await today.evaluate((k) => {
      (window as unknown as Record<string, unknown>)[k] = true;
    }, NO_RELOAD);

    // (4) Mark A Inactive from the header dropdown.
    await page.bringToFront();
    await statusTrigger(page, UI.needsReview).click();
    const menu = page.getByRole('menu', { name: UI.statusMenu });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { name: UI.needsReview, exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: UI.active, exact: true })).toHaveCount(0);
    await menu.getByRole('menuitemradio', { name: UI.inactive, exact: true }).click();
    await expect(statusTrigger(page, UI.inactive)).toBeEnabled();
    expect(await readStatus(api, idA)).toBe('inactive');
    // D8: the card keeps its Mark as buttons; only the title changes.
    await expect(page.getByRole('heading', { name: UI.typeUnknownCard })).toBeVisible();
    await expect(page.getByRole('heading', { name: UI.triageCard })).toHaveCount(0);
    await expect(page.getByRole('button', { name: UI.markAsTenant })).toBeVisible();

    // (5) The open Today page drops A WITHOUT a reload; B stays.
    await today.bringToFront();
    await expect(todayRow(today, phoneA)).toHaveCount(0);
    await expect(todayRow(today, phoneB)).toBeVisible();
    expect(
      await today.evaluate((k) => (window as unknown as Record<string, unknown>)[k], NO_RELOAD),
      'the Today page reloaded - the drop was not live',
    ).toBe(true);
    await today.close();
    await page.bringToFront();
    await expect(async () => {
      const ids = await needsYouNowIds(api);
      expect(ids).not.toContain(idA);
      expect(ids).toContain(idB);
    }).toPass({ timeout: 10_000 });

    // (6) Contacts > Unknown still lists A, labelled Inactive.
    await page.goto(`${NEXT}/contacts/unknown`);
    const unknownRows = page.getByRole('list', { name: UI.contactsUnknownList }).getByRole('listitem');
    const contactsRowA = unknownRows.filter({ has: page.locator(`a[href="/contacts/${idA}"]`) });
    await expect(contactsRowA).toHaveCount(1);
    await expect(contactsRowA).toContainText(UI.inactive);
    await expect(unknownRows.filter({ has: page.locator(`a[href="/contacts/${idB}"]`) })).toHaveCount(1);

    // (7) Inbox Unknown tab: B (older, Needs review) ABOVE A (newer, Inactive);
    //     A carries the Inactive tag and no Needs triage chip.
    await page.goto(`${NEXT}/inbox?filter=unknown`);
    await expect(page.getByRole('tab', { name: UI.unknownTab })).toHaveAttribute('aria-selected', 'true');
    const tabRowA = inboxRow(page, idA);
    const tabRowB = inboxRow(page, idB);
    await expect(tabRowA).toBeVisible();
    await expect(tabRowB).toBeVisible();
    await expect(tabRowA.getByText(UI.inactiveTag, { exact: true })).toBeVisible();
    await expect(tabRowA.getByText(UI.triageChip, { exact: true })).toHaveCount(0);
    await expect(tabRowB.getByText(UI.triageChip, { exact: true })).toBeVisible();
    await expect(tabRowB.getByText(UI.inactiveTag, { exact: true })).toHaveCount(0);
    const order = await inboxList(page)
      .getByRole('link')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    const atB = order.indexOf(`/contacts/${idB}`);
    const atA = order.indexOf(`/contacts/${idA}`);
    expect(atB, `rows: ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0);
    expect(atB, `Needs review must sort above Inactive: ${JSON.stringify(order)}`).toBeLessThan(atA);
    expect(await inboxWireRow(api, 'unknown', idA)).toMatchObject({ needsTriage: false, inactive: true });
    const wireB = await inboxWireRow(api, 'unknown', idB);
    expect(wireB?.needsTriage).toBe(true);
    expect(wireB?.inactive).toBeUndefined();

    // (8) Another inbound text from A: unread in the inbox (All and Unread).
    await textIn(request, phoneA, `still looking ${stamp}`);
    await expect
      .poll(async () => (await inboxWireRow(api, 'unread', idA))?.unreadCount ?? 0, { timeout: 15_000 })
      .toBe(1);
    expect(await inboxWireRow(api, 'unread', idA)).toMatchObject({ needsTriage: false, inactive: true });
    await page.goto(`${NEXT}/inbox`);
    await expect(inboxRow(page, idA).getByLabel(UI.unreadOne)).toBeVisible();
    await page.goto(`${NEXT}/inbox?filter=unread`);
    await expect(inboxRow(page, idA).getByLabel(UI.unreadOne)).toBeVisible();
    await expect(inboxRow(page, idA).getByText(UI.inactiveTag, { exact: true })).toBeVisible();

    // (9) ...but NOT back in Needs you now (D5); B still is.
    await expect(async () => {
      const ids = await needsYouNowIds(api);
      expect(ids).not.toContain(idA);
      expect(ids).toContain(idB);
    }).toPass({ timeout: 10_000 });
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(todayRow(page, phoneB)).toBeVisible();
    await expect(todayRow(page, phoneA)).toHaveCount(0);

    // (10) The inbound did not move the status (D9), and the header says so.
    expect(await readStatus(api, idA)).toBe('inactive');
    await page.goto(`${NEXT}/contacts/${idA}`);
    await expect(statusTrigger(page, UI.inactive)).toBeVisible();
    await expect(page.getByRole('heading', { name: UI.typeUnknownCard })).toBeVisible();
  });
});
```

Step 3 - add the selector rows. Edit `e2e/support/selectors.md`.

Anchor (current text, one line):

```
| Inbox | filter tabs | `getByRole('tab', { name: 'All'\|'Unread'\|'Unknown'\|'Groups' })` - the active tab carries `aria-selected="true"`. The filter is a URL param, so `/inbox?filter=groups` is a real deep link |
```

Replacement (the same line, then one new line):

```
| Inbox | filter tabs | `getByRole('tab', { name: 'All'\|'Unread'\|'Unknown'\|'Groups' })` - the active tab carries `aria-selected="true"`. The filter is a URL param, so `/inbox?filter=groups` is a real deep link |
| Inbox | the Inactive tag | `getByText('Inactive', { exact: true })` SCOPED to the row's listitem (`getByRole('list', { name: 'Conversations', exact: true }).getByRole('listitem').filter({ has: page.locator('a[href="/contacts/<id>"]') })`) - a muted tag beside `Needs triage` / `Deleted` on the row of an Inactive contact of ANY type, on any tab (wire: `inactive: true`, present only then). An Inactive row carries no `Needs triage` chip. On the Unknown tab ONLY, loaded rows sort Needs review first, then Inactive, each newest first; every other tab is newest first (unknown-inactive D9; `unknown-inactive.spec.ts`) |
```

Anchor (current text, one line):

```
| Contact page | Group threads card | `getByRole('heading', { name: 'Group threads' })` - the NATIVE card; the RELAY card beside it is `Relay groups` (S1 renamed it off "Group texts") |
```

Replacement (the same line, then one new line):

```
| Contact page | Group threads card | `getByRole('heading', { name: 'Group threads' })` - the NATIVE card; the RELAY card beside it is `Relay groups` (S1 renamed it off "Group texts") |
| Contact page | header status dropdown | `getByRole('button', { name: 'Contact status: <label>', exact: true })` opens `getByRole('menu', { name: 'Contact status' })`, whose items are `getByRole('menuitemradio', { name: '<label>', exact: true })` (the check mark is `aria-hidden`, so it is not part of the name - but it IS in the text, so never `toHaveText` the items). Since 2026-10-23 EVERY live contact type gets the dropdown with its own statuses: tenant and landlord as before, partner and team_member `Needs review` / `Active` / `Inactive`, unknown `Needs review` / `Inactive`. A soft-deleted contact keeps the display-only badge. The Unknown card's heading reads `Needs triage` only while the contact is Needs review; an Inactive unknown contact's reads `Type unknown` (same Mark as buttons) |
```

Step 4 - the run script (gitignored location, never committed). Create
`W:/tmp/unknown-inactive/.superpowers/s6/run-spec.sh`:

```bash
#!/usr/bin/env bash
# Usage: bash run-spec.sh <tag> <spec path relative to e2e/>...
# A cold-boot spec-only run through the e2e WORKSPACE (the root
# `npm run e2e -- <args>` is a double npm hop that drops the arguments and runs
# EVERYTHING). The gate command is the LAST thing on its line; its status is
# read on the next line only.
tag="$1"
shift
D=W:/tmp/unknown-inactive/.superpowers/s6
cd W:/tmp/unknown-inactive || exit 99
rm -f "$D/$tag.exit"
timeout 1500 npm run e2e -w @housingchoice/e2e -- "$@" > "$D/$tag.log" 2>&1
echo "$?" > "$D/$tag.exit"
```

Each run boots its own hermetic lane (Playwright `webServer`, dashboard as a
`vite preview` build of the CURRENT source) and tears it down, so a source
edit between runs is picked up with no restart. Launch every run DETACHED
(the Bash tool caps one command near 600 s) and wait for its `.exit` file
(Monitor until-loop, or one check command at a time); never TaskStop it. Read
the verdict from the LOG, not from a notification:

```
mkdir -p W:/tmp/unknown-inactive/.superpowers/s6
nohup bash W:/tmp/unknown-inactive/.superpowers/s6/run-spec.sh green1 tests/dashboard-next/unknown-inactive.spec.ts > W:/tmp/unknown-inactive/.superpowers/s6/green1.runner 2>&1 & disown
```

When `green1.exit` exists:

```
cat W:/tmp/unknown-inactive/.superpowers/s6/green1.exit
grep -nE "passed|failed|flaky|Error:|npm error code" W:/tmp/unknown-inactive/.superpowers/s6/green1.log
```

Before the first run: Docker running, `npm run db:start` (STARTS DynamoDB
Local; never restart it), and no other e2e stack of THIS worktree alive
(`npm run e2e:stop` if `e2e/.artifacts/session.pid` exists; then read the
lane's four ports from `e2e/.artifacts/lane.json` and prove none listens:
`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in <app>,<dashboard>,<fake>,<publicBase> }`
prints nothing). `reuseExistingServer` would otherwise adopt an orphan on a
commit match alone.

Optional interactive inner loop (for debugging only, not the evidence):
start `npm run e2e:session` in the background, wait for its `ready` line,
sign in through `POST /auth/dev-login` `{ "email": "va@example.com" }` on the
lane's dashboard URL (printed by the launcher; never :5174 / :8080) and drive
with the Playwright MCP; backend edits need `npm run e2e:restart`, and the
spec-only command above then REUSES that live session. Stop it with
`npm run e2e:stop` and prove the ports free before any cold-boot run.

Step 5 - GREEN (first run). Expected: exit file `0`, log `1 passed`. This
spec lands after S1-S5, so it is green on arrival; steps 6-7 are its real
RED cases (each proves an assertion discriminates against a real
regression).

Step 6 - RED case 1 (D5 / AR8, the Today skip). With no run alive, open
`app/src/routes/today.ts` and, in the unread COLLECT loop, comment out the
AR8 `continue` that S3 added immediately after the deleted-contact skip
(the block after
`if (ownerId !== undefined && (await isDeletedContact(ownerId))) {`
... `continue;` `}`). Leave every other line. Then:

```
nohup bash W:/tmp/unknown-inactive/.superpowers/s6/run-spec.sh red1 tests/dashboard-next/unknown-inactive.spec.ts > W:/tmp/unknown-inactive/.superpowers/s6/red1.runner 2>&1 & disown
```

Expected: exit non-zero, `1 failed`, the failure inside step (9): the
`toPass` block's `expect(ids).not.toContain(idA)` (the second inbound made
A's unknown_1to1 thread unread, and without the skip it emits a "New
unknown contact" row). Steps (1)-(8) pass: A's first thread was read in
step (2), so the walk never sees it before the second inbound. If it fails
anywhere else, STOP and report. Restore and prove it:

```
cd W:/tmp/unknown-inactive
git checkout -- app/src/routes/today.ts
git status
```

`git status` shows no change to `app/src/routes/today.ts`.

Step 7 - RED case 2 (D9 / AR6, the Unknown-tab sort). In
`dashboard/src/routes/inbox/useInbox.ts`, make the `unknown`-filter branch
S5 added use the same newest-first sort every other tab uses instead of
`compareUnknownTabRows` (one expression; leave the rest). Then:

```
nohup bash W:/tmp/unknown-inactive/.superpowers/s6/run-spec.sh red2 tests/dashboard-next/unknown-inactive.spec.ts > W:/tmp/unknown-inactive/.superpowers/s6/red2.runner 2>&1 & disown
```

Expected: `1 failed` at step (7)'s
`expect(atB, 'Needs review must sort above Inactive: ...').toBeLessThan(atA)`
(received atB 1, atA 0: newest-first puts the newer A first). Restore:

```
cd W:/tmp/unknown-inactive
git checkout -- dashboard/src/routes/inbox/useInbox.ts
git status
```

Step 8 - GREEN again on the restored tree, plus the regression pins (PIN)
for the surfaces this branch moved. One cold-boot run:

```
nohup bash W:/tmp/unknown-inactive/.superpowers/s6/run-spec.sh green2 tests/dashboard-next/unknown-inactive.spec.ts tests/dashboard-next/caseworkers.spec.ts tests/dashboard-next/unknown-caller-triage.spec.ts tests/flows/conversation-fact-extraction.spec.ts tests/dashboard-next/ai-run-log.spec.ts tests/dashboard-next/inbox-rows-timestamps.spec.ts > W:/tmp/unknown-inactive/.superpowers/s6/green2.runner 2>&1 & disown
```

Expected: exit `0`, every test passed. Why each pin: caseworkers (the
partner header now a dropdown, the Unknown card, the conversion's Active -
Contradiction 1); unknown-caller-triage (the Unknown tab and Needs you now
for a Needs review caller, the `Needs triage` chip); conversation-fact-
extraction (`:279-283` the tenant `Contact status:` trigger; `:340-349`
Mark as Partner from an unknown contact -> Active, D7); ai-run-log
(`:66-70` creates `{ type: "unknown" }` with NO status, which defaults to
Needs review after S1 instead of Active - its tests then re-type the
contact, so the default must not matter); inbox-rows-timestamps (minted
unknown stubs on every tab, the newest-first order of non-Unknown tabs).
A failure here is a regression to diagnose (AGENTS.md: there is no
named-flake list). Before any re-run, copy the run's artifacts
(`e2e/.artifacts/` test results and the `green2.log`) to
`W:/tmp/unknown-inactive/.superpowers/s6/green2-artifacts/`; then re-run
the failing file alone and report both runs.

Step 9 - ASCII and the final check that no lane survived:

```
cd W:/tmp/unknown-inactive
tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/unknown-inactive.spec.ts | wc -c
git diff -U0 -- e2e/support/selectors.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```

Both print `0`. Prove the lane ports free (step 4's check).

Step 10 - commit (no e2e run alive). Read `git status` bare first; check
`W:\AI Projects\Housing Choice\HC Application\.git\worktrees\unknown-inactive\MERGE_HEAD`
is absent; expect exactly the two paths below changed (the `.superpowers/`
files are gitignored).

```
cd W:/tmp/unknown-inactive
git status
git add e2e/tests/dashboard-next/unknown-inactive.spec.ts e2e/support/selectors.md
git commit -m "test(e2e): mark an unknown contact Inactive from the header dropdown (spec test 8)" -m "Builds its own unknown contacts from inbound texts (no lean-seed contact, AR12): the open Today page drops the row live, Contacts > Unknown keeps it, the inbox Unknown tab sorts it below Needs review with an Inactive tag, and a new inbound shows unread without returning it to Needs you now or moving its status. Adds the header status dropdown and Inactive tag selector rows." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S6.2 - documentation/STATUS-MODEL.md: partner, team member and unknown statuses (AR13)

Files: Modify `documentation/STATUS-MODEL.md`. The file carries non-ASCII
(box drawing, em dashes, arrows); only ADDED lines must be ASCII.

RED (the section does not exist yet):

```
cd W:/tmp/unknown-inactive
grep -n "### 5b. Partner, team member and unknown statuses" documentation/STATUS-MODEL.md
```

Expected: no output, exit 1.

Edit 1. Anchor (line 7):

```
> [GLOSSARY.md](GLOSSARY.md)). Last substantive update: **2026-10-12**.
```

Replacement:

```
> [GLOSSARY.md](GLOSSARY.md)). Last substantive update: **2026-10-23**.
```

Edit 2. Anchor (the end of section 5a, lines 212-215):

```
Transitions are **manual** via the status menu (no enforced transition graph, no
derivation from `contract_status` or from units added) - the menu must stay free to
correct a mis-set status. Landlord statuses take no part in placement/property
derivation (see section 7).
```

Replacement (the same four lines, then the new section):

```
Transitions are **manual** via the status menu (no enforced transition graph, no
derivation from `contract_status` or from units added) - the menu must stay free to
correct a mis-set status. Landlord statuses take no part in placement/property
derivation (see section 7).

### 5b. Partner, team member and unknown statuses

Every other contact type carries a short list on the same `status` field
(type-scoped like the landlord list: `statusAllowlistFor` in
`app/src/lib/statusModel.ts` is the one list every writer and reader checks, and
the dashboard mirrors it as `statusOptionsFor` in `dashboard/src/api/types.ts`,
pinned by a mirror test).

| Type | Statuses (dropdown order) |
|---|---|
| partner (a caseworker or other partner) | Needs review, Active, Inactive |
| team_member | Needs review, Active, Inactive |
| unknown | Needs review, Inactive |

- **`Needs review`** - the same front door as above. An unknown contact that is
  Needs review shows on Today's Needs you now as a "New unknown contact" and
  carries the inbox "Needs triage" chip.
- **`Active`** - a partner or team member staff work with. An unknown contact has
  no `Active` (removed 2026-10-23): it is either waiting for review or set aside.
- **`Inactive`** - set aside without being deleted. For an unknown contact it is
  how staff clear it from Needs review WITHOUT choosing a type; staff can still
  classify it later from its "Type unknown" card (the card reads "Needs triage"
  only while the contact is Needs review).

Moves are **manual**, through ONE header dropdown on the contact page that every
live contact type now has (tenant and landlord included); the Edit contact details
Status field offers exactly the same choices for the contact's type. A type
change with no explicit status starts the new type's first step: tenant
`Onboarding`, landlord `Interested`, partner `Active`, and - from `Inactive` -
team member `Active` and unknown `Needs review`. A save or PATCH that keeps the
contact's current type is not a type change and leaves the status alone.
`(unknown, active)` is refused by every writer.

#### What Inactive means - the same for every type

Cameron, 2026-10-23: an Inactive unknown contact is not treated differently from a
contact of another type with the same named status. Tenant, partner, team member
and unknown all have `Inactive`, and on each it means:

1. **Not chased.** It drops out of the Follow up worklist and the listing-send
   recipient rows (`isEligibleRecipient`, `app/src/lib/listingSendOutcome.ts`).
   `Placed` stays a tenant-only exclusion (only tenants have it).
2. **Blasts unchanged** - they read Onboarding and Searching tenants only.
3. **Still a normal contact** - on the Contacts lists, in search, in its threads
   and in the inbox, where its texts and calls show unread when unread and its
   row carries a small muted "Inactive" tag (and no "Needs triage" chip). Nothing
   is deleted. An inbound text or call never moves it back to Needs review.
4. **The same muted status colour.**
5. **The same timeline wording** - a status change reads "Status -> <label>"
   (the UI renders an arrow), labelled from the type the contact has AFTER the
   change.

On the inbox Unknown tab, Needs review rows sort above Inactive rows, each newest
message first; every other tab stays newest first.

Two differences remain, on purpose:

- The Tenants view hides Inactive tenants by default; the other Contacts views have
  no status filter (`docs/issues/contacts-status-filter-tenants-only.md`).
- An Inactive tenant's unread text still shows in Today's Unreplied, while an
  Inactive unknown contact's unread text does NOT show in Needs you now - it shows
  only in the inbox.

Automatic texts (tour reminders, group text rosters, the missed-call auto-text,
placement nudges, hand-picked share recipients) check no status for any type, and
were left that way.

A landlord's **`Parked`** is the landlord's own retired status, not `Inactive`:
every rule above keys on the literal `inactive`, so none of them touches a Parked
landlord.
```

GREEN:

```
cd W:/tmp/unknown-inactive
grep -n "### 5b. Partner, team member and unknown statuses" documentation/STATUS-MODEL.md
grep -n "Last substantive update: \*\*2026-10-23\*\*" documentation/STATUS-MODEL.md
git diff -U0 -- documentation/STATUS-MODEL.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```

Expected: one match each (exit 0), and `0`.

Commit (bare `git status` first, MERGE_HEAD absent, one path changed):

```
cd W:/tmp/unknown-inactive
git status
git add documentation/STATUS-MODEL.md
git commit -m "docs(status-model): partner, team member and unknown statuses; what Inactive means for every type" -m "New section 5b (AR13): the per-type lists, the one header dropdown, first steps on a type change, and the D4 meaning of Inactive with its two stated differences. Parked stays the landlord's own status." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S6.3 - documentation/GLOSSARY.md: Inactive, "waiting on a reply", "signed up" (AR13, D4.1, D5)

Files: Modify `documentation/GLOSSARY.md`. Lines 640-706 are ASCII today
(`sed -n 640,706p documentation/GLOSSARY.md | tr -d '\11\12\15\40-\176' | wc -c`
prints 0); every added line must be ASCII.

RED:

```
cd W:/tmp/unknown-inactive
grep -c "not an inactive or placed tenant" documentation/GLOSSARY.md
grep -n "^- \*\*Inactive\*\* (contact status" documentation/GLOSSARY.md
```

Expected: `1` (the tenant-only wording D4.1 makes wrong), then no output
(exit 1: no Inactive entry).

Edit 1 - "waiting on a reply" (D4.1). Anchor (lines 642-645):

```
- **waiting on a reply** (last-heard-from, 2026-10-12) - a send at No reply
  yet or Replied whose recipient can be texted (not deleted, not opted out,
  not unreachable, has a phone, and not an inactive or placed tenant) and has
  been quiet for 24 hours since the later of the send and their last heard
```

Replacement:

```
- **waiting on a reply** (last-heard-from, 2026-10-12; updated 2026-10-23) - a
  send at No reply yet or Replied whose recipient can be texted (not deleted,
  not opted out, not unreachable, has a phone, not **Inactive** - any contact
  type since 2026-10-23, tenants only before - and not a placed tenant) and has
  been quiet for 24 hours since the later of the send and their last heard
```

Edit 2 - "signed up" (D5). Anchor (lines 699-700):

```
  Unreplied", an existing unknown contact's under Needs you now as a "New
  unknown contact". When the contact had no thread on that phone, the
```

Replacement:

```
  Unreplied", an existing unknown contact's under Needs you now as a "New
  unknown contact" (not when that contact is **Inactive**: its thread then
  shows only in the inbox). When the contact had no thread on that phone, the
```

Edit 3 - the new entry, at the end of "Feature & label notes" (after the
**signed up** entry, before the `---` above "For the future AI layer").
Anchor (lines 702-705, the end of **signed up**, the blank line, the rule):

```
  blank preview and, as the contact's newest conversation, heads that
  contact's row.

---
```

Replacement:

```
  blank preview and, as the contact's newest conversation, heads that
  contact's row.

- **Inactive** (contact status; unknown-inactive, 2026-10-23) - the status
  that sets a contact aside WITHOUT deleting it, on every contact type that
  has it: tenant, partner (a caseworker or other partner), team member and
  unknown (code `inactive`, label "Inactive"). It means the same thing on
  each (Cameron, 2026-10-23): the contact is not chased (no **waiting on a
  reply** row, not a listing-send recipient - `isEligibleRecipient`,
  `app/src/lib/listingSendOutcome.ts`) but stays on the Contacts lists, in
  search and in the inbox, where its texts and calls still show unread and
  its row carries a small muted "Inactive" tag and no "Needs triage" chip.
  An inbound text or call never moves it back to Needs review. An unknown
  contact marked Inactive leaves Today's Needs you now (its unread texts
  show only in the inbox) and sorts below the Needs review rows on the
  inbox Unknown tab; an Inactive tenant's unread text still shows under
  Unreplied. Staff set it from the contact page header dropdown or the Edit
  contact details Status field, which offer the same choices for every
  type; an unknown contact has no "Active" (Needs review or Inactive
  only). NOT a landlord's "Parked" (the landlord's own retired status,
  which needs a reason), which none of these rules touch. Full rules:
  [STATUS-MODEL.md](STATUS-MODEL.md) section 5b.

---
```

GREEN:

```
cd W:/tmp/unknown-inactive
grep -c "not an inactive or placed tenant" documentation/GLOSSARY.md
grep -n "^- \*\*Inactive\*\* (contact status" documentation/GLOSSARY.md
grep -n "not when that contact is \*\*Inactive\*\*" documentation/GLOSSARY.md
git diff -U0 -- documentation/GLOSSARY.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```

Expected: `0`; one match; one match; `0`.

Commit (bare `git status` first, MERGE_HEAD absent, one path changed):

```
cd W:/tmp/unknown-inactive
git status
git add documentation/GLOSSARY.md
git commit -m "docs(glossary): Inactive for every contact type; waiting on a reply excludes any Inactive contact" -m "Adds the Inactive entry (AR13), updates waiting on a reply for D4.1 (any type, not tenants only) and the signed up entry for D5 (an Inactive unknown contact's thread is not on Needs you now)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task S6.4 - W3 record and the S6 slice report

Files: Create `docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S6-report.md`.
No code changes (W3: the fallback is NOT changed, spec D5).

Step 1 - re-verify W3 on the current tree (read-only):

```
cd W:/tmp/unknown-inactive
grep -n "err.status !== 404\|buildTodayFromSources(" dashboard/src/routes/today/useToday.ts
grep -n "'/today'" app/src/routes/api.ts
grep -n "router.get\|res.status(" app/src/routes/today.ts
grep -n "unknown_1to1\|New inbound" dashboard/src/routes/today/buildToday.ts
grep -n "export interface ConversationSummary" -A20 dashboard/src/api/types.ts
```

Expected on main @916258ae plus S1-S5 (line numbers drift; the TEXT is the
anchor): `useToday.ts:57-59` assembles the fallback only when `getToday`
rejects with an `ApiError` whose status is 404; `api.ts:1284-1285` mounts
`/today` with no condition; `today.ts:331` is its only handler and answers
200 or 400 (`:338`, `:347`), never 404; `buildToday.ts:286-299` emits a
"New inbound - untriaged" row for EVERY `unknown_1to1` conversation;
`ConversationSummary` has no contact status. (RED/GREEN: this is a
read-only watch item; the "test" is these greps matching.) If any of
these differ (a new 404 path in today.ts, a conditional mount), STOP and
report to the planner: the fallback would then run on a live backend and
show an Inactive unknown contact on Needs you now.

Step 2 - write the report (ASCII, findings only, `file:line` citations). Its
content, with the builder's actual results filled in where marked:

```
# S6 report - e2e, docs, W3

- W3 (dashboard Today fallback, buildToday.ts): UNCHANGED, as spec D5
  rules. It runs only when GET /api/today answers 404
  (dashboard/src/routes/today/useToday.ts:57-59). The router is mounted
  unconditionally (app/src/routes/api.ts:1284-1285) and its only handler
  (app/src/routes/today.ts:331) answers 200 or 400 (:338, :347), never 404.
  So against this backend the fallback never runs; it would run only
  against an app build that has no Today router (a dashboard deployed ahead
  of a much older app). In that case it would still list an Inactive
  unknown contact's thread as "New inbound - untriaged"
  (buildToday.ts:286-299): ConversationSummary carries no contact status
  (dashboard/src/api/types.ts, ConversationSummary).
- caseworkers.spec.ts: no edit needed (plan S6 Contradiction 1); ran green
  as a pin in S6.1 step 8 <fill: or the failure and its diagnosis>.
- ai-run-log.spec.ts:66-70 creates an unknown contact with no status; after
  S1 it defaults to needs_review instead of active. <fill: pin result in
  S6.1 step 8>.
- RED evidence: red1 failed at <fill: assertion and message> with the AR8
  skip commented out; red2 failed at <fill> with the Unknown-tab
  comparator swapped for newest-first. Both files restored (git status
  clean for them) before green2.
- <fill: anything the tree held that this plan got wrong, e.g. an as-built
  name that differed and the UI constant changed; or "nothing else to
  report">.
```

Step 3 - ASCII check and commit:

```
cd W:/tmp/unknown-inactive
tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S6-report.md | wc -c
git status
git add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S6-report.md
git commit -m "docs(records): unknown-inactive S6 report - e2e RED/GREEN evidence, W3 fallback recorded unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The ASCII check prints `0`; `git status` (read before the add) shows only
the report as new.

### S6 coverage

- Spec section 4 surfaces: `documentation/STATUS-MODEL.md` (S6.2),
  `documentation/GLOSSARY.md` (S6.3), `dashboard/src/routes/today/buildToday.ts:287`
  fallback (W3, S6.4, unchanged). Exercised end to end by the e2e spec:
  the header dropdown (`ContactDetail.tsx`), the Unknown card title
  (`UnknownFile.tsx`), `ContactsList.tsx` row label, `InboxRow.tsx` tag and
  chip, `useInbox.ts` Unknown-tab sort, the `inbox.ts` wire fields
  (`needsTriage`, `inactive`), the `today.ts` collect-loop skip, the D2
  notify reaching an open Today page, and the inbound text webhook's
  no-reset (W4, text only).
- Spec section 5 tests: test 8 (whole). It also re-proves, through the real
  stack, parts of test 4 (Inactive unknown not in Needs you now; Needs
  review one is), test 5 (unread on All/Unread/Unknown, `needsTriage`
  false, `inactive` set, Unknown block order, an inbound text leaves the
  status Inactive), test 7 (dropdown options for unknown, Unknown-tab sort,
  Inactive tag, card title) and test 2's "notifies open Today" observable
  rule.

---



## 11. S7 - final: one main sync, the five bare gates, gate report

Depends on S1-S6 committed. Writes
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-gates.md`
(gate results, real exit codes) and
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-report.md`
(the W1 re-check and the sync record - one file, one kind). No source edits
in this slice except merge results. Never pipe a gate; never `;`-chain
anything after a gate on its line; never edit or commit while a gate runs.

### Task S7.1 - W1 re-check and the one main sync

Step 1 - W1 (#31 overlap), read-only:

```
cd W:/tmp/unknown-inactive
git worktree list --porcelain
git branch -a
```

Look for any branch or worktree that is #31's (Today page as the daily
checklist; names like `today-checklist`, `today-*`, `daily-checklist`). For
each candidate `<b>`:

```
git diff --name-only main...<b> -- app/src/routes/today.ts dashboard/src/routes/today
git ls-tree -r --name-only <b> -- docs/superpowers/plans docs/superpowers/specs
```

If it touches `app/src/routes/today.ts`, read its PLAN (not its commits):
`git show <b>:<plan path>`, and record in S7-report.md which of its tasks
touch the unread collect loop (`today.ts` ~704-800) or the triage pass
(~845-941), where this branch put the AR8 skip. Do NOT change course;
the planner decides. No candidate -> record "W1: no #31 branch or worktree
as of <date time>".

Step 2 - has main advanced? Read-only:

```
cd W:/tmp/unknown-inactive
git status
git rev-parse HEAD main
git merge-base HEAD main
git rev-list --count HEAD..main
git rev-parse github/main origin/main
```

`git status` must be clean (it is the bare read; `.superpowers/` is
ignored). Record all SHAs. The sync source is the local `main` (the shared
checkout's branch). If `github/main` or `origin/main` is AHEAD of local
`main` (`git rev-list --count main..github/main` > 0), do not fetch or
merge a remote ref: record it and tell the planner.

- Count `0`: nothing to merge. Record "main @<sha> already contained;
  no merge commit".
- Count > 0: dry-run the merge without touching the tree:

```
cd W:/tmp/unknown-inactive
git diff --name-only HEAD...main
git merge-tree --write-tree --name-only HEAD main
```

  If `merge-tree` exits non-zero (conflicts) AND any conflicted path is one
  this branch changed (`git diff --name-only main...HEAD`), STOP and ask
  the planner before merging. Otherwise merge (bare `git status` read just
  before; check that
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\unknown-inactive\MERGE_HEAD`
  is absent first):

```
cd W:/tmp/unknown-inactive
git merge --no-ff main -m "merge main into feat/unknown-inactive (S7 sync, once)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  Expected: exit 0, a merge commit. If git still reports a conflict
  (merge-tree said clean but the merge did not), run `git merge --abort`
  and STOP for the planner. After the merge:

```
cd W:/tmp/unknown-inactive
git diff --name-only HEAD^1 HEAD -- package-lock.json package.json app/package.json dashboard/package.json e2e/package.json fake-twilio/package.json
```

  Any path listed -> run `npm ci` at the worktree root (bare; expect exit
  0) before the gates. Sync happens ONCE; later drift of main is reported,
  not chased.

### Task S7.2 - gates 1-4 (detached, sequential, logged)

Step 1 - preconditions (read-only, then one start):

```
cd W:/tmp/unknown-inactive
env | grep '^AWS_' | cut -d= -f1
docker ps
npm run db:start
```

Record the NAMES of any exported `AWS_*` variables (never their values).
`npm run db:start` STARTS DynamoDB Local if it is down; never restart or
remove the shared container (it wipes local data; ask the human). Gate 2
is required with DynamoDB Local up; `ALLOW_SKIP_DYNAMO_TESTS` is NOT set
for a gate. No e2e stack of this worktree may be alive: if
`e2e/.artifacts/session.pid` exists run `npm run e2e:stop`; then read the
lane ports from `e2e/.artifacts/lane.json` and prove none listens
(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in <app>,<dashboard>,<fake>,<publicBase> }`
prints nothing).

Step 2 - the runner (gitignored location, not committed). Create
`W:/tmp/unknown-inactive/.superpowers/gates/run-gates.sh`:

```bash
#!/usr/bin/env bash
# S7 gates 1-4, in AGENTS.md order. Each gate is the LAST command on its
# line; its status is read on the NEXT line only (never pipe a gate).
G=W:/tmp/unknown-inactive/.superpowers/gates
cd W:/tmp/unknown-inactive || exit 99
rm -f "$G"/*.exit "$G/ALL.done"
date > "$G/started.txt"
npm run typecheck > "$G/1-typecheck.log" 2>&1
echo "$?" > "$G/1-typecheck.exit"
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test > "$G/2-test.log" 2>&1
echo "$?" > "$G/2-test.exit"
npm run smoke > "$G/3-smoke.log" 2>&1
echo "$?" > "$G/3-smoke.exit"
timeout 2700 npm run e2e > "$G/4-e2e.log" 2>&1
echo "$?" > "$G/4-e2e.exit"
date > "$G/ALL.done"
```

(`env -u` drops any exported AWS key for `npm test` only - AGENTS.md: an
exported key collapses every app test file onto one DynamoDB Local
database. `npm run e2e` is unaffected: each lane forces its own key. The
45-minute `timeout` is a hard outer cap for a suite that can wedge; a
timeout is a gate FAILURE to report, not a pass.)

Step 3 - launch detached (the Bash tool caps one command near 600 s; the
gates take 30-60 min):

```
mkdir -p W:/tmp/unknown-inactive/.superpowers/gates
nohup bash W:/tmp/unknown-inactive/.superpowers/gates/run-gates.sh > W:/tmp/unknown-inactive/.superpowers/gates/runner.out 2>&1 & disown
```

Wait for `ALL.done` (Monitor until-loop; re-arm it; never TaskStop the
script - on Windows that kills the current step and the script runs the
NEXT gate as an orphan). Do not edit any file in the worktree or commit
while it runs (the e2e gate builds and serves the current tree).

Step 4 - read the verdicts from the exit files and LOGS (never from a
notification):

```
cd W:/tmp/unknown-inactive/.superpowers/gates
cat 1-typecheck.exit 2-test.exit 3-smoke.exit 4-e2e.exit
grep -nE "error TS|npm error code" 1-typecheck.log
grep -nE "Test Files|Tests |FAIL|npm error code|\[dynamoAdmin\]" 2-test.log
grep -nE "npm error code|Error|ok" 3-smoke.log
grep -nE "passed|failed|flaky|timed out|npm error code" 4-e2e.log
```

Expected: every exit file `0`; gate 2 lists each workspace's `Test Files`
/ `Tests` lines with 0 failed; gate 4 ends `<n> passed`.

If a gate is red:
- Gate 2 red on DynamoDB Local suites: re-run-and-compare (AGENTS.md; do
  NOT export an access key). (1) Re-run each failing FILE alone, twice
  (`cd W:/tmp/unknown-inactive/app; npx vitest run test/<file>`, bare, one
  per Bash call); (2) run the full suite at the branch's merge base (a
  detached worktree, e.g. `git worktree add --detach W:\tmp\unknown-inactive-base <merge-base>`,
  copy `.claude\settings.local.json` into it, `npm ci` there, then the same
  `env -u ... npm test` redirected to a log; leave that worktree for the
  human to remove); (3) compare failing FILES, not cases, and report both
  runs. Any `[dynamoAdmin]` line in real suite output is one real container
  fault: capture that run's `err.$metadata.httpStatusCode` and `attempts`
  first.
- Gate 4 red: a named-spec failure is a REGRESSION (no named-flake list).
  FIRST copy the run's artifacts (`e2e/.artifacts/` test results and
  reports, and `4-e2e.log`) to
  `W:/tmp/unknown-inactive/.superpowers/gates/e2e-run1/`; then re-run the
  failing file(s) alone through the S6 runner
  (`bash .superpowers/s6/run-spec.sh gate-rerun <file>`, detached as in S6)
  and report both runs. A failure in a file this branch touched, or on a
  surface it changed, goes to the planner as blocking.
- Gate 4 exit 124 (timeout) or any aborted run: orphan cleanup before
  anything else - `npm run e2e:stop`, then prove the lane ports from
  `e2e/.artifacts/lane.json` free; if a listener survives, list this
  worktree's node processes
  (`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*unknown-inactive*' }`)
  and `taskkill /PID <pid> /T /F` from the TOP of each surviving tree.
  Never kill shared MCP browser processes.
- A fix is a new task for the planner, not an edit inside S7; after any
  fix ALL gates run again from gate 1.

### Task S7.3 - gate 5 (eslint on the branch's own files)

Step 1 - the file list (the extension filter, `main...HEAD` - a bare
`git diff --name-only` lists unstaged changes and would check nothing):

```
cd W:/tmp/unknown-inactive
git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' > .superpowers/gates/5-files.txt
wc -l < .superpowers/gates/5-files.txt
```

This branch changes `.ts`/`.tsx` files, so the count is not 0. (If it ever
were 0, gate 5 is SKIPPED - never run `npx eslint` with no paths: it goes
repo-wide and fails on the pre-existing backlog.)

Step 2 - the gate, bare, last on its line; status on the next line:

```
cd W:/tmp/unknown-inactive
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') > .superpowers/gates/5-eslint.log 2>&1
echo "$?" > .superpowers/gates/5-eslint.exit
```

Exit `0` with an empty log: done. Note in the report that the config lints
`.ts`/`.tsx` only, so any `.mjs`/`.js` in the list was checked by NO rule.

Step 3 - only if errors are reported: attribute by BASELINE, not by line
number. Lint each listed file as it stands at the merge base, through the
branch's config, and compare per file by rule id and message (line numbers
shift):

```
cd W:/tmp/unknown-inactive
BASE=$(git merge-base main HEAD)
: > .superpowers/gates/5-eslint-base.log
while read -r f; do if git cat-file -e "$BASE:$f" 2>/dev/null; then echo "== $f" >> .superpowers/gates/5-eslint-base.log; git show "$BASE:$f" | npx eslint --stdin --stdin-filename "$f" >> .superpowers/gates/5-eslint-base.log 2>&1; else echo "== $f NEW FILE (no baseline)" >> .superpowers/gates/5-eslint-base.log; fi; done < .superpowers/gates/5-files.txt
```

(This baseline is an attribution aid, not the gate, so its pipe is
allowed.) An error present on the branch and absent at the base is THIS
branch's and BLOCKING - including `no-unused-vars` on an import line the
diff never touched (a deleted last use). Every error in a NEW file is the
branch's. The rest are pre-existing: leave them, and NAME each one
(`file:line rule`) in S7-gates.md so nobody re-diagnoses them.

### Task S7.4 - the gate report, the S7 report, commit

Step 1 - write
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-gates.md`
(ASCII; real exit codes copied from the `.exit` files; result lines copied
from the logs):

```
# S7 - gate results (feat/unknown-inactive)

- Gates run: <start - end, local time>, Windows host, Node <node --version>.
- Tree under test: HEAD <sha>. main synced: <main sha>; <"already
  contained, no merge commit" | "merge commit <sha>">. npm ci after the
  merge: <yes/no>.
- DynamoDB Local: up (npm run db:start). Exported AWS_* names: <none |
  names only>.

| # | Gate | Command (bare) | Exit | Result (from the log) |
|---|---|---|---|---|
| 1 | typecheck | npm run typecheck | <n> | <"no errors" or the first error lines> |
| 2 | test | env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test | <n> | <each workspace's Test Files / Tests line> |
| 3 | smoke | npm run smoke | <n> | <the smoke's summary line> |
| 4 | e2e | timeout 2700 npm run e2e | <n> | <"N passed (Xm)" or the failed list> |
| 5 | eslint, branch files | npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') | <n> | <file count; "0 problems" or the attributed list> |

- [dynamoAdmin] lines in gate 2: <none | each line, httpStatusCode, attempts>.
- Re-runs: <none | which file, why, both results>.
- Pre-existing lint errors (baseline-attributed, not this branch's):
  <none | file:line rule>.
- Lint coverage hole: <any .js/.mjs in the list, checked by no rule | none>.
```

Step 2 - write
`docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-report.md`
(ASCII, findings only): the W1 result (S7.1 step 1), the sync record
(main/github/origin SHAs, merged or already contained, any conflict
dry-run result), any remote main ahead of local main, and anything the
tree held that the plan got wrong. Nothing else to report -> one line
saying so beside the W1 and sync lines.

Step 3 - ASCII checks and commit (no gate running; bare `git status`
first; MERGE_HEAD absent; exactly the two reports new):

```
cd W:/tmp/unknown-inactive
tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-gates.md | wc -c
tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-report.md | wc -c
git status
git add docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-gates.md docs/superpowers/reviews/2026-10-23-unknown-inactive/slices/S7-report.md
git commit -m "docs(records): unknown-inactive S7 - main sync and the five gate results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Both ASCII checks print `0`. The branch is merge-ready only if every gate
exit is 0 (gate 5: no error attributable to this branch). Merging into
main is the human's call; S7 never merges the branch into main, never
deploys, and deletes no branch or worktree.

### S7 coverage

- Spec section 4: none directly; it proves every slice's surfaces together
  under the five AGENTS.md completion gates.
- Spec section 5: all tests 1-8 run inside gates 2 and 4.
- Watch items: W1 re-checked at S7 (S7-report.md).
