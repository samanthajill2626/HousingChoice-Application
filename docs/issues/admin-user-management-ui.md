---
id: admin-user-management-ui
title: In-app admin user-management UI (list / invite / role-change)
type: improvement
severity: med
status: resolved
area: dashboard
created: 2026-06-18
resolved: 2026-06-30
refs: dashboard/src/routes/settings/TeamSection.tsx, dashboard/src/routes/settings/InviteForm.tsx, app/src/routes/adminUsers.ts
---

**Problem.** The backend admin surface exists — `app/src/routes/adminUsers.ts` provides
`GET /api/users` (list), `POST /api/users` (invite), `PATCH /api/users/:userId/role`
(promote/demote), all behind `requireRole('admin')`. But there is **no in-app dashboard
UI** for it; the only way to invite/list/change roles is the `npm run user:invite` (and
`user:role`) CLI.

**Suggested fix.** Build the admin user-management screen in the new dashboard against the
existing `/api/users` endpoints. The CLI remains the bootstrap path.

**Resolution (2026-06-30).** Shipped as the **Settings ▸ Team** tab on the new dashboard
(merged with the settings-surface feature): `dashboard/src/routes/settings/TeamSection.tsx`
+ `InviteForm.tsx` + `useTeam.ts`, admin-gated by `AdminRoute.tsx`, calling `getUsers` /
`inviteUser` / `setRole` against `/api/users`. The `npm run user:invite` CLI remains as the
first-admin bootstrap path (before anyone can log in).

Graduated 2026-06-18 from an inline `TODO(M1.4)` at `scripts/userInvite.mjs`. (The
companion API-surface TODO in `app/src/routes/auth.ts` was already satisfied by
`adminUsers.ts` and was removed.)
