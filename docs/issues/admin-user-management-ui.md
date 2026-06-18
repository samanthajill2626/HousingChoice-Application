---
id: admin-user-management-ui
title: In-app admin user-management UI (list / invite / role-change)
type: improvement
severity: med
status: open
area: dashboard
created: 2026-06-18
refs: app/src/routes/adminUsers.ts, scripts/userInvite.mjs
---

**Problem.** The backend admin surface exists — `app/src/routes/adminUsers.ts` provides
`GET /api/users` (list), `POST /api/users` (invite), `PATCH /api/users/:userId/role`
(promote/demote), all behind `requireRole('admin')`. But there is **no in-app dashboard
UI** for it; the only way to invite/list/change roles is the `npm run user:invite` (and
`user:role`) CLI.

**Suggested fix.** Build the admin user-management screen in the new dashboard against the
existing `/api/users` endpoints. The CLI remains the bootstrap path.

Graduated 2026-06-18 from an inline `TODO(M1.4)` at `scripts/userInvite.mjs`. (The
companion API-surface TODO in `app/src/routes/auth.ts` was already satisfied by
`adminUsers.ts` and was removed.)
