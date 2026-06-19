# Contact soft-delete (delete / restore) — design

**Status:** implemented (landed on `main` this session).
**Date:** 2026-06-19.
**Surface:** backend (`app/` — contacts repo + routes, inbox, today) and the new
dashboard (`dashboard/`, :5174 — contact detail ⋯ menu + banner, Contacts list).

## Goal

A navigator can "delete" a contact without losing data — the record and all its
history are **retained** so it can be **resurfaced** later. Deleted contacts drop
out of the normal views and live behind a Contacts **Deleted** tab.

## Data model

A sparse `deleted_at` ISO-8601 timestamp on the contact record. **Present → the
contact is deleted.** No schema/GSI/infra change — it's just an item attribute
(the `byTypeStatus` GSI projects `ALL`, so it's filterable on the index). Restore
= REMOVE the attribute. `isDeleted(contact)` (in `contactsRepo.ts`) is the single
definition, shared by the repo and the inbox/today hydration.

## Backend

- **Repo** (`contactsRepo.ts`): `softDelete(id, at)` SETs `deleted_at`;
  `restore(id)` REMOVEs it (both `attribute_exists(contactId)`-guarded → 404).
- **List filters**: `listByType` takes `opts.deleted` — default
  `attribute_not_exists(deleted_at)` (hide deleted); `true` →
  `attribute_exists(deleted_at)` (the Deleted view, only deleted).
  `listByHousingAuthority` **always** excludes deleted (broadcast targeting must
  never reach a deleted contact).
- **`findByPhone` is deliberately NOT filtered** — inbound routing still maps a
  known number to its record, so re-contact doesn't spawn a duplicate; the record
  simply shows as deleted.
- **Routes** (`routes/contacts.ts`): `DELETE /api/contacts/:id` (stamps server-side
  `deleted_at`, audit `contact_deleted`), `POST /api/contacts/:id/restore` (audit
  `contact_restored`), and `GET /api/contacts?...&deleted=true` for the Deleted view.
- **Inbox + Today** hide deleted contacts at hydration: `inbox.ts` skips a row whose
  resolved contact is deleted; `today.ts` skips contact-anchored items (unknown /
  unreplied rows) **and** case items whose tenant is deleted (a shared cached
  `isDeletedContact`). The unknown-triage pass is covered automatically by the
  `listByType` exclusion. A lookup failure is never treated as deleted (best-effort).

## Frontend

- **⋯ menu** (`ContactActionsMenu`): **Delete contact** (danger) when live /
  **Restore contact** when deleted.
- **Confirm → navigate**: Delete opens a confirm `Modal` ("…will be hidden… nothing
  is erased… restore from the Deleted view"); on confirm it `DELETE`s and navigates
  back to `/contacts`. Restore is immediate and applies the returned contact **in
  place** (stays on the page; the banner clears).
- **Deleted detail page**: a "🗑 Deleted" header badge + a standing banner with a
  Restore button (mirrors the Do-Not-Contact treatment).
- **Contacts list**: a **Deleted** tab (`/contacts/deleted`); `useContacts('deleted')`
  fans out the audience types with `deleted=true`.

## Decisions (asked + answered this session)

- **Scope:** hide deleted from Inbox + Today too (not just the Contacts page).
- **Post-delete UX:** confirm dialog first, then navigate to the Contacts list.
- **Restore** path: from the Deleted view → the contact's page → Restore.

## Testing

- Backend: `contactSoftDelete.test.ts` (delete/restore, list exclusion, Deleted
  view, 404s, inbox + today exclusion). Repo filters verified on real DynamoDB
  Local via `contactsRepo.integration.test.ts`. Full app suite green (1169).
- Frontend: `ContactActionsMenu` (Delete/Restore items + busy), `ContactDetail`
  (confirm→navigate, Deleted banner + restore-in-place), `useContacts` (deleted
  fan-out asks `deleted:true`; normal filters don't). Full dashboard suite green (383).

## Non-goals / notes

- No hard delete. There is no UI to permanently purge a record (retention by design).
- `findByPhone` intentionally still resolves a deleted contact (routing/no-dupes).
