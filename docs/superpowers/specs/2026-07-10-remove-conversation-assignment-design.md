<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-10).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Remove conversation assignment ("Assigned to me") end to end

Date: 2026-07-10
Status: APPROVED (Cameron, 2026-07-10) - ready for implementation
Branch: chore/remove-conversation-assignment (worktree w:/tmp/yank-assignment, cut from main 217cdd0)

## 1. Context and decision

The app has a conversation-assignment feature (assign a contact's conversations
to a team member; an "Assigned to me" inbox filter; "Assigned - You/{name}"
chips). The workspace has a SINGLE user for the foreseeable future, so the
feature is dead weight that muddies the UI and the codebase. Cameron decided
(2026-07-10) on a FULL YANK: remove the feature end to end rather than hiding
the UI. Git history preserves the implementation; a future multi-user phase
would redesign it anyway (assignee validation against the users table was
still an open TODO).

Research findings the removal relies on (verified 2026-07-10):
- Exactly ONE UI surface renders assignment: the Inbox (filter tab + row chip
  + hover Assign/Unassign buttons). No other page reads it.
- PATCH /api/conversations/:id/assignment has ZERO callers (dashboard uses
  only the POST /api/inbox/:contactId/assign fan-out). Already-dead surface.
- No GSI, no schema, no Terraform. `assignment` is an optional free-form
  attribute on conversation items.
- No cross-feature dependency: voice (inbound bridges to the inbound-voice-
  line HOLDER, a users-table pointer - a different feature), relay, tours,
  placements, broadcasts, Today - none read conversation assignment.
- The apparent spread is (a) a REQUIRED `assignment` field on two shared
  types (ConversationSummary and the conversation.updated SSE event) forcing
  ~10 unrelated test fixtures to carry `assignment: null`, and (b) test
  coverage of the feature itself.

## 2. Goals

- G1: No assignment UI anywhere (no filter tab, no chip, no buttons).
- G2: No assignment API surface (both routes gone; unknown filter values and
  removed routes fail the same way any unknown route/param does today).
- G3: No assignment code in repos/events/types; fixtures no longer carry the
  field; the users repo is no longer a dependency of the inbox feed.
- G4: docs/issues/validate-assignee-userid.md resolved by this removal.
- G5: All gates green: typecheck + unit + e2e on a base freshly merged with
  main.

## 3. Non-goals (do NOT touch)

- Pool-number assignment (poolNumbersRepo/relayProvisioning/poolNumbers
  service; seeds' `lifecycle_state: 'assigned'` items) - a different feature
  that shares the verb.
- Inbound-voice-line holder (usersRepo.assignInboundVoiceLine, Settings ->
  Team assign/clear, voice webhook bridging, founderTriage/voice e2e) - a
  different feature.
- Landlord reassignment on units; admin role management; window.location.
  assign; Object.assign.
- NO data migration: existing `assignment` attributes on dev/prod conversation
  items and existing `assignment_changed` AUDIT rows stay in place, ignored.
  DynamoDB items are free-form; nothing reads either after this change.
- Historical docs (docs/superpowers/plans/specs mentioning assignment) stay
  untouched per the historical-docs rule.
- The audit trail MECHANISM (auditRepo) - only the two assignment_changed
  write sites disappear with their routes.

## 4. Removal inventory

### R1. Backend routes (app/src)

- app/src/routes/api.ts:
  - PATCH /conversations/:conversationId/assignment - the whole route
    (~lines 1259-1295), including its audit append and SSE emit.
  - toConversationSummary(): drop `assignment: item.assignment ?? null`.
  - Header/route comments mentioning assignment; the
    TODO(validate-assignee-userid) inline marker dies with the route.
- app/src/routes/inbox.ts:
  - POST /:contactId/assign - the whole fan-out route (~lines 775-830).
  - The `mine` branch in passesFilter and 'mine' in the filter allowlist
    (the "four valid filter values" doc comment becomes three; an incoming
    ?filter=mine now 400s like any other unknown value - correct).
  - Assignee-name hydration: resolveUserName + userNameCache and the two
    row-builder blocks that attach `assignment: { userId, name }`.
  - The `assignment` field on the InboxRow response interface (~line 91).
  - usersRepo leaves this file entirely: the import (createUsersRepo,
    displayNameOf, UsersRepo), the deps field, and the instantiation
    (~lines 71, 112, 283) - assignee hydration was its ONLY use here.
    Remove the stale "userDisplayName removed" comment block if it now
    dangles (~line 215).
- app/src/middleware/auth.ts: the comment mentioning assignment as VA
  day-to-day work - reword minimally (do not change behavior).

### R2. Repo + events (app/src)

- app/src/repos/conversationsRepo.ts: the `assignment?: string` field on
  ConversationItem, the setAssignment() interface method + implementation
  (~lines 341-349, 813-839).
- app/src/lib/events.ts: the `assignment: string | null` field on
  ConversationUpdatedEvent and its line in toConversationUpdatedEvent (the
  ONE payload builder every emit site uses - so no emit site needs editing
  beyond compiling).

### R3. Dashboard UI (dashboard/src/routes/inbox)

- inboxFilters.ts: the { filter: 'mine', label: 'Assigned to me' } tab and
  the 'mine' emptyCopy case.
- InboxRow.tsx: the "Assigned - You/{name}" chip block, the Assign-to-me /
  Unassign buttons, canAssign, and the onAssign prop. After removal, if
  currentUserId / currentUserName have no remaining use in this component,
  remove those props too (verified pre-spec: assignment is their only use in
  InboxRow) and drop the corresponding props at the Inbox.tsx call site.
- InboxRow.module.css: the .assigned class (and any now-orphaned rules).
- useInbox.ts: the assign() mutation, its optimistic patch plumbing (the
  assignment key in the patch type + merge), and the `assignment` field on
  InboxRowData.
- Inbox.tsx: the onAssign wiring (and currentUserId/currentUserName props if
  they became unused per above; keep `me` if the page still uses it
  elsewhere - remove only what is now dead).

### R4. Dashboard API layer (dashboard/src)

- api/endpoints.ts: assignInbox().
- api/types.ts: `assignment` on ConversationSummary (~line 224), on the
  conversation.updated event type (~line 822), and the
  `assignment?: { userId; name }` field on the inbox row type (~line 1643).
  InboxFilter loses 'mine' from its union.

### R5. Tests - remove or trim (never weaken unrelated assertions)

- DELETE feature tests: the PATCH-assignment coverage in
  app/test/conversationHubApi.test.ts, the assign-route + mine-filter +
  assignment-hydration coverage in app/test/inboxApi.test.ts /
  inboxFeed.test.ts / inbox.integration.test.ts, assignment cases in
  app/test/sse.test.ts + conversationHub.integration.test.ts, and the
  dashboard useInbox/InboxRow/Inbox assignment tests.
- TRIM fixtures: every unrelated test that carries `assignment: null` (or a
  userId) purely to satisfy the types - dashboard today/buildToday,
  useTourChannels, useContactTimeline, buildTimelineFallback, UnreadContext,
  useEventStream tests, and any app-side equivalents - drops the field. The
  tests' real assertions must not change.
- e2e/tests/dashboard-next/inbox.spec.ts: delete the dedicated
  "inline Assign to me ..." test; the filter-tabs expectation becomes
  ['All', 'Unread', 'Unknown'].

### R6. Issue registry

- docs/issues/validate-assignee-userid.md: flip status to resolved with a
  dated note ("feature removed 2026-07-10, chore/remove-conversation-
  assignment; validation moot").

## 5. Edge notes for the implementer

- E1: The conversation.updated event contract SHRINKS. The builder function
  is the single source of the wire shape; dashboard's event type mirrors it.
  Remove the field on BOTH sides in the same commit so typecheck pins the
  contract.
- E2: Stray `assignment` attributes persist on existing conversation items -
  by design (non-goal). Do not add read-time stripping; nothing types or
  reads the attribute after this change. ([key: string]: unknown on
  ConversationItem already tolerates unknown attributes.)
- E3: Unknown ?filter= values already 400 via the allowlist - removing
  'mine' needs no new error handling, but DO keep a test asserting
  ?filter=mine now 400s (cheap regression pin that the surface is gone).
- E4: grep-verify at the end: `rg -i "assign" app/src dashboard/src e2e`
  must return ONLY the unrelated subsystems listed in section 3 (pool
  numbers, inbound voice line, landlord reassign, window.location.assign,
  Object.assign). Any conversation-assignment remnant is a miss.
- E5: ASCII only in every touched line (repo rule); this is removal-heavy,
  but reworded comments and the issue note must stay plain ASCII.

## 6. Testing and gates

- Unit: existing suites shrink; add the E3 400-pin. All remaining tests
  green.
- E2E: inbox.spec passes with three tabs; full suite green.
- Gates (bare, real exit codes, from the worktree): npm run typecheck +
  npm test + `timeout 1500 npm run e2e`, green on a base freshly merged
  with main before handback.
- Self-QA: drive the Inbox in the live stack (e2e:session + dev-login):
  three filter tabs, no assignment chip/buttons on hover, rows and
  mark-read still work.

## 7. Post-merge

Nothing required (no deps, no schema, no infra). Dev-stack restart picks it
up. Existing audit rows/attributes decay in place.
