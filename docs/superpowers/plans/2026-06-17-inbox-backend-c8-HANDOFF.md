<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Inbox Backend (Contract C8 / "BE7") — Handoff Summary

**Status:** ✅ Complete, reviewed, all green — **NOT merged** (left for the human to merge, per the handoff).
**Branch:** `inbox-backend` (worktree `w:/tmp/hc-inbox-backend`), branched from `ff08ca0`.
**Commits (4):**
- `745d490` docs: C8 implementation plan
- `b621f9b` feat(api): GET /api/inbox contact-aggregated feed (filters + split-proof cursor)
- `1037309` feat(api): inbox mark-read + assign (contact-keyed fan-out) over conversation.updated SSE
- `a40fc89` test(inbox): integration test exercises real message-derived channel/direction/preview

**Orchestration:** builder → reviewer → adversarial per task (BE1–BE6 pattern), plus a final whole-branch adversarial review. Final verdict: **Ready to merge = Yes; 0 Critical, 0 Important.**

---

## What changed

Production code is one new router + a 20-line mount — everything else reuses existing storage/serializers/SSE:

- **`app/src/routes/inbox.ts`** (new, ~711 lines): C8 wire types (`InboxFilter`/`InboxChannel`/`InboxRow`/`InboxPage`) verbatim; `aggregateInbox(opts, deps)` (the unit-testable aggregator); `createInboxRouter(deps)` with the four handlers.
- **`app/src/routes/api.ts`** (+20): mounts `createInboxRouter` at `/api/inbox` inside the existing authed `/api` chain; forwards the shared repos + audit + events.
- Tests: `app/test/inboxFeed.test.ts` (aggregator units, 12), `app/test/inboxApi.test.ts` (supertest, GET + mutations), `app/test/inbox.integration.test.ts` (DynamoDB-Local, 12, gated `describe.skipIf(!reachable)`).

### Endpoints (all behind origin-verify + session + `requireAuth()`)
- `GET /api/inbox?filter=all|unread|unknown|mine&cursor=&limit=` → `InboxPage` (one row per contact, newest-activity-first, split-proof cursor; default limit 25, clamp 1..100; bad filter / malformed cursor → 400).
- `POST /api/inbox/:contactId/read` → resets unread across **all** the contact's numbers; 404 if contact missing; `{ ok: true }`.
- `POST /api/inbox/read { phone }` → marks an **unknown** number's conversation read; 404 if no conversation; `{ ok: true }`.
- `POST /api/inbox/:contactId/assign { userId | null }` → sets/clears assignment across all the contact's conversations (+ `assignment_changed` audit); 404 if contact missing; 400 on malformed body; `{ ok: true }`.

### Reuse (no forked state)
`conversationsRepo.listByLastActivity` (DESC GSI Query, never a Scan) / `findByParticipantPhone` / `resetUnread` / `setAssignment`; `contactsRepo.findByPhone` (pointer-aware) + `contactPhones()`; `appEvents` + `toConversationUpdatedEvent`. The fan-out's emit + audit are byte-for-byte the same sequence as the existing `POST /conversations/:id/read` and `PATCH /conversations/:id/assignment` handlers.

---

## How it was verified (autonomous = unit + API + DynamoDB-Local integration; NO browser stack)
- `npm test -w @housingchoice/app` → **1096 passed / 5 skipped**, no regressions.
- `npm run typecheck -w @housingchoice/app` → clean.
- Integration suite (12 tests) ran **green against real DynamoDB Local**, including: split-proof cursor paging at `limit=1` across 4 pages (a contact with two numbers appears exactly once — closes the unit-only coverage gap), cross-number unread sum, unknown row, relay_group exclusion, read zeroing both of a contact's conversations, assign/unassign, and real message-derived `channel='mms'`/`direction='inbound'`/`preview`.
- Per the handoff, the **browser/full-stack e2e is deliberately NOT run here** — it's the gated post-merge integration pass the main session owns.

---

## SSE event the frontend binds to
**Reused the existing `conversation.updated` event — no new event was added.** It already fires on new inbound, on read (`resetUnread`), and on assignment (`setAssignment`); the contact-keyed fan-outs emit one per affected conversation. The frontend should bind the inbox to `conversation.updated` and treat it as "something changed, reconcile" (the spec's blessed live-update policy).

---

## Contract notes & flags (surfaced, not silently diverged — design is owned by the main session)
1. **Group texts (`relay_group`) are EXCLUDED from the feed.** C8's `InboxRow.kind` is only `'contact' | 'unknown'` — there is no row kind for a group text, so relay groups are skipped by construction. If the Inbox should surface group texts, C8 needs a new `kind` (a design change to ratify).
2. **`conversation.updated` carries `conversationId`, not `contactId`.** The inbox is keyed by contact, so surgical "patch this row in place" would require a `contactId` on the event. The frontend instead reconciles via the spec's debounced refetch (explicitly allowed). If per-contact patch-in-place is later wanted, add `contactId` to the event payload — a small future addition, not built here.
3. **`assignment.name` falls back to email → userId.** `UserItem` has no display-name field today, so the Assigned chip's `name` resolves to the user's email (then userId) when no name exists. If the chip needs a real display name, add a name field to the users repo.
4. **Keying decision (documented):** contact rows mutate by `:contactId`; unknown rows mutate by `POST /api/inbox/read { phone }` (assign is contact-only — you assign after triage).

---

## Merge / deploy notes for the human
- **No schema change.** This slice adds NO DynamoDB tables and NO GSIs — it reuses `conversations` / `contacts` / `messages` / `audit_events` and their existing indexes. **No `apply` is needed before deploying this code** (unlike BE2/BE3/BE4). It goes live on a normal `deploy:dev`.
- Branch is clean; merge `inbox-backend` into `main` when ready. The frontend ships against the identical C8 shapes and degrades until this lands.
- **DynamoDB Local** (docker) was left running from the integration run (idempotent `db:start`); stop it with `npm run db:stop` if you don't need it.

## Remaining deferred Minors (reviewer verdict: defer — non-blocking)
- Integration `assign` test doesn't re-assert the `assignment_changed` audit over real Dynamo (it's asserted at the unit level against an identical code path to the production PATCH handler).
- `POST /api/inbox/read` phone validation `/^\+\d+$/` accepts implausibly short values like `+1` (loose by design; worst case is a 404 `no_conversation_for_phone`).
