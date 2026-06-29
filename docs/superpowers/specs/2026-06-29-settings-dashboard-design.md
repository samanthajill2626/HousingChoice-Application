# Settings dashboard surface — design spec

> Date: 2026-06-29 · Status: approved (brainstorm) → ready for implementation plan
> Rebuilds the deleted Settings surface on the new dashboard (:5174) as a tabbed
> page — **Team · Call-triage templates · Notifications · System Status** —
> retiring the CLI-only user management, and adds a new admin-only **System
> Status** panel (go-live flags + CloudWatch alarms + recent errors).

## 1. Goal & decisions

`/settings` is a `Placeholder` stub today; the legacy dashboard that used to host
these controls was deleted, so there is currently **no UI** for team management,
founder templates, push testing, or system health. Rebuild it. Agreed decisions:

1. **Four sections, tabbed:** Team, Call-triage templates, Notifications, System Status.
2. **Layout:** top tabs. On desktop the tab row **wraps** to a second line as
   sections grow (never a horizontal scroll). Below the dashboard's 768px
   breakpoint the tabs collapse into a single **section dropdown**. Inherits the
   `AppFrame` shell (sidebar/drawer, top bar) unchanged. (If the section count ever
   exceeds ~8, revisit a vertical left sub-nav — out of scope now.)
3. **Role-aware tabs:** **Team** and **System Status** are **admin-only** (hidden
   for VAs, routes guarded). **Templates** is visible to all but **read-only for
   VAs** (the backend already gates editing). **Notifications** is per-device, all users.
4. **Three sections are a frontend rebuild** against endpoints that already exist;
   **System Status is new** (frontend + backend + IAM); **welcome-text editing** is
   a small additive backend change to the settings record.
5. **Phasing (§11):** Phase A ships the shell + Team + Notifications + Templates
   (app-only, no infra). Phase B adds System Status (new endpoints + instance-role
   IAM, an operator `terraform apply`).

## 2. Layout & navigation

- Route stays `/settings` (footer nav, already wired). Each tab is a **sub-route**
  — `/settings/team`, `/settings/templates`, `/settings/notifications`,
  `/settings/system` — so tabs deep-link, the back button works, and admin-only
  tabs get a route guard (not just hidden chrome). `/settings` redirects to the
  first tab visible for the viewer's role (admin → Team, VA → Templates).
- **Desktop (≥768px):** a wrapping tab row (`flex-wrap`). **Mobile (<768px):** the
  tab row is replaced by a labeled section `<select>` dropdown. One source of truth
  for the tab model (id, label, route, `adminOnly`) drives both, mirroring how
  `nav.ts` feeds both the sidebar and the drawer.
- Admin-only tabs are omitted from the model for VAs; their routes redirect a VA
  back to the default tab.

## 3. Team — admin only (existing endpoints)

Backend already exists in `app/src/routes/adminUsers.ts` (mounted `/api/users`,
`requireRole('admin')`), wrapping the same `usersRepo` the `user:invite`/`user:role`
ops scripts use:

- `GET /api/users` → `{ users: [{ userId, email, name, role, status, created_at, last_login_at }] }`
- `POST /api/users { email, role }` → `201 { user, created }` (idempotent invite)
- `PATCH /api/users/:userId/role { role }` → `{ user, changed }`

Roles are `admin | va` (`USER_ROLES`). UI:

- **User list:** desktop table / mobile stacked cards — name + email, role control,
  status, last login. Role change is an inline control → `PATCH …/role`.
- **Invite:** an email input + role select → `POST /api/users`; idempotent, so
  re-inviting an existing email is a clean no-op surfaced as "already on the team."
- **Lockout guards are server-side** (`cannot_demote_self`, `cannot_demote_last_admin`
  → 409): surface them as inline errors and revert the optimistic role change.
- **No delete/deactivate in v1** — there is no backend for it (note as future).

## 4. Call-triage templates — admins edit, VAs view (existing + welcome-text add)

Backend exists in `app/src/routes/settings.ts` + `repos/settingsRepo.ts`:

- `GET /api/settings` → `{ settings }` (`requireAuth` — VAs may view)
- `PUT /api/settings { patch }` → `{ settings }` (`requireRole('admin')`)

Current `OrgSettings` fields: `preRingPauseSeconds` (int 0–10), `missedCallAutoText`
(1–320 chars), `missedCallAutoTextEnabled` (bool), `quickReplies` (≤10, each 1–320).

**New: `welcomeText`** (the housing-fair intake welcome SMS, today a hard-coded
constant). Additive backend change:

- Add `welcomeText` to `OrgSettings` (validated 1–320 chars) and to `parsePatch`
  in `settings.ts`.
- `app/src/routes/public.ts` housing-fair handler reads `settings.welcomeText` and
  renders it (preserving the `{firstName}` interpolation), **falling back to the
  existing `WELCOME_TEXT_TEMPLATE` constant** when unset or on any settings-read
  error — the welcome send is best-effort and must never break intake.

UI: a form for the four (now five) fields; pre-ring pause as a 0–10 stepper, the
auto-text as a textarea + on/off toggle, quick replies as an editable chip list,
welcome text as a textarea with a `{firstName}` hint. **VAs see the inputs
read-only/disabled** (mirrors the admin-only `PUT`). Save → `PUT /api/settings`
with only the changed fields; show a saved state; surface 400 validation inline.

## 5. Notifications — this device (existing endpoints)

Backend exists in `app/src/routes/push.ts`:

- `GET /api/push/vapid-public-key`, `POST/DELETE /api/push/subscriptions`,
  `POST /api/push/test` (self-test to the caller's own devices).

UI (scoped to the **current device**):

- Push on/off for this device — driven by `Notification.permission` +
  `pushManager.getSubscription()`. **Enable** → subscribe with the VAPID key +
  `POST /subscriptions`; **Disable** → `DELETE /subscriptions`.
- **Send test notification** → `POST /api/push/test`; show the per-call tally.
- **iOS hint:** push requires the PWA be added to the Home Screen first — show that
  guidance when running iOS Safari un-installed.
- **No device list** in v1 (no endpoint to enumerate a user's devices — defer).

## 6. System Status — admin only (NEW backend + IAM)

Admin-only. Three stacked blocks, scoped to **the environment the app runs in**
(no cross-env viewing — that would need cross-account role assumption). New routes
under `/api/system`, each `requireRole('admin')`:

- **`GET /api/system/flags`** → go-live readiness, read straight from runtime
  config — **no AWS call** (always works, incl. locally). Shape:
  `{ env, smsSendingEnabled, relayLiveProvisioning, founderCellSet, pushConfigured, messagingDriver }`
  (booleans / enums only — never secrets). UI renders status pills; the two A2P
  kill-switches show **amber "Off · pre-A2P"** (off is the *expected* pre-launch
  state, not an error).
- **`GET /api/system/alarms`** → `{ available, alarms: [{ name, state, stateUpdatedAt }] }`
  via CloudWatch **`DescribeAlarms`** filtered to `AlarmNamePrefix = hc-<env>-`.
  `state ∈ OK | ALARM | INSUFFICIENT_DATA`. UI sorts **ALARM-first**; auto-refresh
  every **60s while the tab is visible** + a manual ↻.
- **`GET /api/system/errors?since=1h|24h|7d`** →
  `{ available, events: [{ timestamp, level, message, correlationId }] }` via
  CloudWatch Logs **`FilterLogEvents`** on the app error log group, filter pattern
  for pino level ≥ 50, **limit 25, newest first**. **PII-safe projection** —
  message + correlationId only, never bodies/numbers/names. Default window 24h,
  selectable 1h/24h/7d, manual refresh.

Implementation:

- A new **observability adapter/service** (`app/src/services/systemStatus.ts` +
  a thin CloudWatch client seam) wrapping `@aws-sdk/client-cloudwatch`
  (`DescribeAlarms`) and `@aws-sdk/client-cloudwatch-logs` (`FilterLogEvents`),
  mockable in tests. Reads alarm prefix, error log group name, and env from config.
- **Graceful local degradation:** when no AWS is reachable (console-driver/local,
  or an SDK error), the alarms + errors endpoints return `{ available: false,
  reason }` (HTTP 200) → the UI shows *"available in deployed environments."* Flags
  always work.
- **IAM (operator `terraform apply`):** the EC2 instance role gains
  `cloudwatch:DescribeAlarms` and `logs:FilterLogEvents` (scoped to the env's alarm
  prefix / error log group ARN where the policy language allows). Add to the
  existing ec2/observability Terraform module.
- **Config:** error log group name + alarm name prefix (`hc-<env>-`) + env name —
  reuse existing config/log wiring where present; add named config fields otherwise.

## 7. API client + types (dashboard)

- `dashboard/src/api/endpoints.ts`: `listUsers`, `inviteUser`, `setUserRole`;
  `getSettings`, `putSettings`; `getVapidPublicKey`, `subscribePush`,
  `unsubscribePush`, `sendPushTest`; `getSystemFlags`, `getSystemAlarms`,
  `getSystemErrors`.
- `dashboard/src/api/types.ts`: `AdminUserView`, `OrgSettings` (+`welcomeText`),
  `SystemFlags`, `SystemAlarm`, `SystemErrorEvent`. Mirror the backend contracts.

## 8. Components (each one job)

- `SettingsPage` — the tab shell: role-aware tab model, wrapping tabs (desktop) /
  section dropdown (mobile), routed `<Outlet>` per tab.
- `TeamSection` (+ `UserRow`, `InviteForm`).
- `TemplatesSection` (fields; read-only mode for VAs).
- `NotificationsSection` (this-device push state + test).
- `SystemStatusSection` (+ `FlagPills`, `AlarmGrid`, `RecentErrors`).
- Backend: `routes/system.ts` + `services/systemStatus.ts` + CloudWatch client seam;
  `welcomeText` added to `settingsRepo`/`settings.ts` and read in `public.ts`.

## 9. Validation & errors

- **Team:** 400 invalid email/role inline; 409 `cannot_demote_self` /
  `cannot_demote_last_admin` inline + revert the optimistic role change.
- **Templates:** field validation (lengths/range) surfaced inline; VA inputs
  disabled (admin-only `PUT`).
- **System:** admin-only (403 otherwise — tab is also hidden); AWS error →
  "couldn't load, retry"; local/unavailable → "available in deployed environments."
- **Welcome send:** `settings.welcomeText` read is best-effort; any failure falls
  back to the constant — intake never breaks.

## 10. Testing

- **Component (dashboard):** tab set + gating by role (admin vs VA); wrapping-tabs
  ↔ dropdown responsive switch; each section happy path + error states; Templates
  read-only for VA; System Status flag/alarm/error rendering, ALARM-first sort, and
  the local-degradation message.
- **Backend:** `welcomeText` validation + `public.ts` fallback (settings →
  constant, incl. settings-read failure); `/api/system/*` admin-gating; flags
  shape; alarms mapping (`DescribeAlarms` → view, prefix filter, state mapping);
  errors mapping (`FilterLogEvents` → projection, limit 25, PII-safe); graceful
  degradation when the CloudWatch clients throw/are unconfigured. Mock the
  CloudWatch SDK clients.
- **e2e:** dev-login (admin) → Settings → invite a user (appears) → change a role;
  edit a template + reload persists; a welcome-text edit is reflected in a
  subsequent housing-fair welcome (assert via the outbox); System Status renders
  flags + the degraded alarms/errors notice on the local stack. VA path: limited
  tab set, Templates read-only.

## 11. Phasing

- **Phase A — frontend rebuild (no infra):** `SettingsPage` shell + Team +
  Notifications + Templates, including the `welcomeText` settings add (app-only).
  Ships immediately.
- **Phase B — System Status:** `/api/system/*` + the CloudWatch adapter + the
  instance-role IAM (operator `terraform apply`) + the `SystemStatusSection` UI.
  Ships after the IAM apply; degrades gracefully before it.

## 12. Notes / future

- The tab model is extensible; >8 sections → switch to a vertical left sub-nav.
- Deferred: more go-live flags (OAuth configured, custom-domain phase), user
  deactivate/remove, a per-user device list, full CloudWatch log search/tail,
  cross-env viewing.
- Naming: this surface doesn't touch the unit/home/listing vocabulary; unaffected
  by the in-flight listing→property relabel.
