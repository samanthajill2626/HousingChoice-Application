<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Contact "Group texts" card — relay-group memberships read path — design

**Status:** in progress (branch `feat/contact-relay-groups-card`).
**Date:** 2026-07-02.
**Surface:** backend (`app/` — conversations repo + contacts routes) and the new
dashboard (`dashboard/`, :5174 — contact detail file pane, tenant + landlord).

## Goal

The contact detail page's "Group texts" card (TenantFile + LandlordFile) is a
construction-era placeholder — an unconditional `PendingPanel` ("Group-text
membership arrives with the backend"). Relay groups shipped in M1.7, but no
endpoint answers **"which relay-group conversations is contact X a member of?"**
Build that read path and wire the card with real rows and an honest empty state.

## Investigation findings (why the "obvious" query doesn't exist)

- A `relay_group` conversation's **`participant_phone` is the pool number**
  (synthetic — `conversationsRepo.createRelayGroup`), and the member roster
  lives in the **un-indexed `participants[]` list**. So the `byParticipantPhone`
  GSI **cannot** return a contact's relay memberships — a per-phone Query finds
  only 1:1 threads. (The task brief's suggested index path was verified false.)
- The conversations table's only GSIs are `byParticipantPhone`, `byLastActivity`
  (hash `status`, range `last_activity_at`), and sparse `byPoolNumber`
  (`lib/tables.ts`). None key on member identity.
- `added_to_group_text` / `removed_from_group_text` activity events are emitted
  **only** by the member-add/remove routes — `provisionRelayGroup` records
  nothing for **founding members** (the common case: placement/tour relays are
  created with tenant + landlord already on the roster). Events are therefore
  not an authoritative membership source.
- Precedent: `today.ts` already enumerates relay groups by reading the
  `byLastActivity` **`open` partition and filtering `type === 'relay_group'` in
  code** (the relay opt-out attention items).
- 1:1 threads **only ever write `status: 'open'`** (repo contract), so the
  `closed` partition contains **only closed relay groups** — cheap to read.

## Approaches considered

1. **Membership pointer items + a new GSI** (one item per member-phone →
   conversation, like the phone-claim pattern). Correct O(memberships) reads,
   but: a Terraform GSI change (dev apply + prod riding M1.11), write-path
   changes at three mutation points (create/add/remove), a backfill for existing
   rows, and a standing roster↔pointer drift risk. Overkill for Phase-1 scale.
2. **Derive from activity events.** Rejected — misses founding members (above).
3. **Bounded partition Query + in-code roster match** (CHOSEN). One paged Query
   per relay status partition (`open`, `closed`) on the existing `byLastActivity`
   GSI with a `type = relay_group` FilterExpression — a Query, never a Scan, no
   schema/infra change — then match the roster in code against the contact's
   id + phones. Same shape as `today.ts` and the `/media` route. The `open`
   partition read scales with total open conversations (the whole inbox), which
   is acceptable at this product's scale and already the cost profile of every
   inbox/today load; the no-silent-truncation rule applies (warn on cap).

## Backend

- **Repo** (`conversationsRepo.ts`): new `listRelayGroups(status)` →
  `{ items, truncated }`. Pages the `byLastActivity` GSI (partition = status,
  newest-activity-first) with `FilterExpression #t = :relay`, looping
  `ExclusiveStartKey` up to a fixed page bound; `truncated: true` when the bound
  stopped it early (caller warns — never silent).
- **Route** (`routes/contacts.ts`, after `listings-sent`):
  `GET /api/contacts/:contactId/relay-groups` → `{ groups: RelayGroupRow[] }`.
  - 404 `contact_not_found` for unknown ids and phone-pointer (`phone_ref`) ids
    (mirrors `listings-sent` / `media`).
  - Membership: a roster entry matches when `entry.contactId === contactId` OR
    `entry.phone ∈ contactPhones(contact)` (all the contact's numbers).
  - Reads BOTH `open` and `closed` partitions (a closed group is still context;
    the row is labeled Closed). Merged newest-activity-first.
  - **Wire shape (VERBATIM — the frontend imports identical field names):**
    `RelayGroupRow { conversationId, status: 'open'|'closed', poolNumber?,
    memberCount, lastActivityAt, owner: { type: 'tour'|'placement'|null, id? },
    tag?, otherMemberNames: string[] }`. `owner` comes from the existing
    `getOwner()` (canonical `owner` field with legacy `placementId` fallback);
    `otherMemberNames` are the OTHER members' roster `name`s (known names only,
    no phones — least data that makes the row useful); `poolNumber` is absent on
    closed groups (cleared on close). Responses may carry numbers to the authed
    client (M1.7 posture); **log lines are IDs/counts only** (doc §9).

## Frontend

- **Types/endpoint** (`api/types.ts`, `api/endpoints.ts`): `RelayGroupRow` +
  `getContactRelayGroups(contactId, signal)` (unwraps `{ groups }`).
- **Hook** (`useContactFile.ts`): new `relayGroups: Slice<RelayGroupRow>` loaded
  via the existing `loadSlice` (404 → `'pending'` keeps the honest degraded
  state on a not-yet-deployed backend).
- **Card** (new `GroupTextsCard.tsx`, shared by BOTH files — one implementation,
  one test): pending → `PendingPanel`; ready+empty → `EmptyRow` **"No group
  texts yet."**; rows → `Row` per group:
  - label: "With {names}" when other members' names are known, else the
    operator `tag`, else the formatted pool number, else "Group text";
  - right: member count ("3 members") or "Closed";
  - link: the group's owner detail — `/tours/:id` (tour-owned) or
    `/placements/:id` (placement-owned); standalone groups don't link. (The
    new dashboard's Inbox is contact-centric with NO per-conversation view —
    verified — so "link to the Inbox thread" is not possible today; the owner
    page is where the group thread is operated, e.g. TourDetail's group panel.)
- **Wiring**: `TenantFile` + `LandlordFile` replace the placeholder with
  `<GroupTextsCard pending={...} groups={...} />`; `ContactDetail` threads
  `file.relayGroups` into both (same pattern as `listingsSent`).

## Testing

- Backend `app/test/contactRelayGroups.test.ts` (mirrors `contactMedia.test.ts`
  on the in-memory harness; the harness fake gains `listRelayGroups` mirroring
  the real repo's semantics): 404 unknown + phone-pointer id; `[]` for none;
  match by roster `contactId`; match by SECONDARY phone; non-member groups
  excluded; closed groups included (status `closed`, no `poolNumber`);
  newest-first ordering; `otherMemberNames` excludes self and nameless entries;
  1:1 threads never match.
- Dashboard: `GroupTextsCard.test.tsx` (pending / empty / rows / owner links /
  Closed label) + `useContactFile.test.tsx` extended for the new slice
  (ready / 404→pending).
- E2E: extend the tours scenario — after the group thread is provisioned, the
  tenant's contact page shows the group row (real UI, hermetic stack).

## Non-goals / notes

- No new GSI/table/Terraform — deliberately (approach 1 rejected for now). If
  conversation volume ever makes the `open`-partition read hot, the pointer-item
  index is the upgrade path; this endpoint's contract wouldn't change.
- No member management from the card (add/remove stays on the owner surfaces).
- The card links out; it does not render the group's messages.
