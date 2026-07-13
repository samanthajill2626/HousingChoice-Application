<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-10).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Remove Team Member -- Design

Date: 2026-07-10
Status: Approved (ready for implementation plan)

## Problem

The Settings > Team page lists team members and supports invite, change-role,
and inbound-voice-line assignment, but there is no way to remove a member. The
UI even carries a stale comment: "FUTURE: no delete/deactivate in v1 (no backend
for it)." The backend has no delete method and no DELETE route. We are adding a
"remove team member" capability end to end.

## Decisions (locked)

- **Hard delete.** Delete the DynamoDB user row outright. Because `userId` is
  deterministic from the normalized email (`usr_<sha256(email)[:24]>`), removing
  a member frees the key so the same email can be cleanly re-invited later via
  the existing `attribute_not_exists(userId)` conditional put. No soft-delete
  field is added.
- **Confirm dialog** in the UI (not type-to-confirm, not inline-undo).
- **Block removal when the member holds the inbound voice line.** Removal is
  refused until an admin reassigns the line to someone else.
- **Safety guards:** block removing yourself; block removing the last admin.
  These mirror the existing role-change (`cannot_demote_self`,
  `cannot_demote_last_admin`) guards.

## Architecture / Components

### Backend

**Repo -- `app/src/repos/usersRepo.ts`**
- Add `remove(userId: string): Promise<boolean>` using `DeleteCommand` (new
  import alongside the existing Get/Put/Query/Scan/Update commands). Returns
  whether a row existed (delete is idempotent-friendly).
- No new status value. The row is deleted; it is not marked.

**Route -- `app/src/routes/adminUsers.ts`**
- Add `router.delete('/:userId', ...)` behind the existing
  `requireRole('admin')` that already guards this router.
- Guard order, each returning HTTP 409 with a stable machine code:
  1. `cannot_remove_self` -- `req.user?.userId === userId`.
  2. `cannot_remove_last_admin` -- if the target's role is `admin` and they are
     the only admin. Use the same pre-check plus verify-after pattern the
     demote path uses to stay safe under concurrent removals.
  3. `voice_line_assigned` -- if the target is the current inbound-voice-line
     holder (`getInboundVoiceLineHolder()` resolves to this userId). Message:
     "Reassign the inbound voice line before removing this member."
- On success: call `usersRepo.remove(userId)`, then write an audit event
  mirroring the existing `role_changed` event (e.g. `user_removed`,
  `actor = req.user?.userId`, target userId + email).
- Session revocation is automatic: `sessionMiddleware` already detects a missing
  user row on cache miss, clears the cookie, and proceeds unauthenticated within
  the session-epoch cache TTL (<= 60s). No extra logout wiring is needed.
- Route ordering is safe: the self-router mounted first at `/api/users` only
  matches the literal `me` segment, so `DELETE /:userId` does not collide.

**Client -- `dashboard/src/api/endpoints.ts`**
- Add `removeUser(userId: string)` issuing `DELETE /api/users/:userId`, next to
  the existing `inviteUser` / `setUserRole` / voice-line client functions.

### Frontend

**Hook -- `dashboard/src/routes/settings/useTeam.ts`**
- Add a `remove(userId)` action. On success, drop the row from local roster
  state. On a 409, surface the returned error message inline, reusing the
  error-handling shape the change-role action already uses.

**Row -- `dashboard/src/routes/settings/UserRow.tsx`**
- Add a "Remove" control (trailing column or overflow menu, consistent with the
  existing row layout).
- Disable/hide the control for the acting user's own row and for the last admin,
  so a guard failure is the rare backstop rather than the primary path.
- Clicking opens a confirmation dialog naming the member: "Remove Jane Doe?
  They will lose dashboard access immediately." with Cancel / Remove. If the
  member holds the voice line, the dialog explains it must be reassigned first;
  the server 409 remains the authoritative backstop.

**`dashboard/src/routes/settings/TeamSection.tsx`**
- Remove the stale "FUTURE: no delete/deactivate in v1" comment.

## Data Flow

1. Admin clicks Remove on a member row -> confirmation dialog.
2. Confirm -> `useTeam.remove(userId)` -> `endpoints.removeUser` ->
   `DELETE /api/users/:userId`.
3. Route runs guards (self / last-admin / voice-line). On failure, returns 409
   with a code; the hook surfaces the message and the row stays.
4. On success, repo deletes the row, an audit event is written, response 200/204.
5. Hook drops the row from local state. The removed member is logged out on
   their next request within <= 60s via existing session middleware.

## Error Handling

- All guard failures are HTTP 409 with a stable code
  (`cannot_remove_self`, `cannot_remove_last_admin`, `voice_line_assigned`),
  matching the existing role-change error convention so the frontend can map
  codes to friendly copy.
- Delete is treated as idempotent: removing an already-absent row is not an error.

## Cascade / References (no cleanup required)

- Conversations no longer reference a member's userId (recent
  remove-conversation-assignment change).
- `broadcasts.created_by` and audit `actor` are plain attribution strings that
  degrade gracefully via `displayNameOf` (name -> email -> id). No FK cleanup.
- `push_subscriptions` live on the user row and vanish with it.
- Inbound-voice-line pointer: not a concern because removal is blocked while the
  member is the holder.

## Testing

- **Repo (`app/test/usersRepo.integration.test.ts`):** `remove()` deletes the
  row; re-inviting the same email afterward succeeds and lands on the same key.
- **Route (admin users integration test):** happy path returns success, the row
  is gone, and an audit event is written; each guard returns its specific 409
  code (self, last-admin, voice-line-holder).
- **Component (`TeamSection.test.tsx`):** Remove opens the dialog; confirming
  calls the endpoint and drops the row; the control is disabled for the own row
  and the last admin; a 409 surfaces the error message.
- **e2e (`e2e/tests/dashboard-next/settings.spec.ts`):** an admin invites then
  removes a user and the roster updates.

## Out of Scope (YAGNI)

- Soft-delete, deactivate, or undo.
- Bulk remove.
- Email/notification to the removed member.
- A reassignment-of-owned-work step (nothing user-owned needs reassignment;
  attribution strings degrade gracefully).
- Auto-clearing the voice line on removal (we block instead, per decision).
