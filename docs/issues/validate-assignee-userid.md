---
id: validate-assignee-userid
title: assigneeUserId is not validated against the users table on assignment
type: improvement
severity: low
status: open
area: app/api
created: 2026-06-18
refs: app/src/routes/api.ts:861
---

**Problem.** `PATCH /api/conversations/:conversationId/assignment` accepts any non-empty
string (or `null`) as `assigneeUserId` — it does not verify the id refers to an existing
user. A conversation can be assigned to a non-existent userId. Users have existed since
M1.3, so validation is now possible.

**Suggested fix.** Look up `assigneeUserId` in `usersRepo` (or validate against the team
list) before `setAssignment`, returning 400/404 on an unknown id.

Graduated 2026-06-18 from an inline `TODO(M1.4)` at `app/src/routes/api.ts:861`.
