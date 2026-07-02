# Tours dashboard gaps (addendum 5–7) — implementation plan

Source: the post-handoff addendum (gaps 5–7) + the verified audit `.superpowers/sdd/tours-dash-audit.md`.
The Tours entity feature is merged on main; this plan closes the create-UI, top-level page, and Today gaps.

## The two PROPOSALS the addendum requested (decided here)

**P1 — list-page query for upcoming + time-less tours.** Add a `byStatus` GSI to the `tours` table
(hash `status`, range `created_at`) + an optional `?status=` filter on GET /api/tours. Rationale: the
repo's strongest precedent is status-shaped GSIs (contacts `byType/status`, units `byStatus`, placements
`byStage`); the sparse `byScheduledAt` GSI cannot see time-less tours by construction; a Scan is against
repo idiom. "Upcoming" needs NO backend change (existing `?from=&to=` range). NOTE: the GSI is a
tables.ts + dev/prod tfvars DECLARATION here; the dev terraform apply happens post-merge by the human
(never run by this build). Hermetic local/e2e tables are created fresh from tables.ts, so tests run now.

**P2 — tours_today: RETIRE the placement.tour_date branch.** tours_today becomes Tour entities
scheduled today, on BOTH builders (server `/api/today` and the client fallback `buildTodayFromSources`).
Rationale: the addendum states placements with `tour_date` are legacy data only; the repo precedent
(placement.tours[] retirement) is clean repoint + retire when no real data depends on it; the audit
confirmed tours_today is the ONLY consumer of the tour_date→Today derivation. The `tour_date` FIELD
itself stays untouched (the `tour_scheduled` placement milestone still reads it — out of scope).
Requested (time-less) tours do NOT appear in tours_today — "needs booking" is the Tours page's job;
Today stays strictly "scheduled today".

## Global Constraints
- Time-less tours: status `requested`; NO reminders armed until a time is set; setting `scheduledAt` on a
  `requested` tour transitions it to `scheduled` and arms the reminder ladder (reuse the existing re-arm
  path). A `requested` tour is cancelable. Tenant status/placements untouched (tours stay separate; no
  conversion).
- Terminology: unit/property/home; placement; navigator = staff. Accessibility-first tests
  (getByRole/getByLabel). No PII in new logs.
- nav.ts LOCKED comment: the founder APPROVED this amendment — update the comment to record the
  amendment (date + "Tours added post-spec with founder approval"), do not delete its history.
- Real exit codes (output to file + `echo EXIT=$?`; never pipe through tail). e2e on this worktree's own
  lane; warm shared containers first (`npm run db:start && npm run s3:start`).
- Commit EXPLICIT paths; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  NEVER deploy/secrets/terraform apply/.env/.docx. Do NOT merge. Do NOT touch w:/tmp/tours-seq.

---

## Task 1: Backend — `requested` tours (optional time) + byStatus GSI + query

**Files:** `app/src/lib/toursModel.ts`, `app/src/repos/toursRepo.ts`, `app/src/lib/tables.ts`,
`infra/envs/dev/tables.auto.tfvars.json`, `infra/envs/prod/tables.auto.tfvars.json`,
`app/src/routes/tours.ts`, `app/src/jobs/tourReminders.ts` (only if arming needs a guard),
tests: `app/test/toursModel.test.ts`, `app/test/toursRepo.integration.test.ts`, `app/test/toursApi.test.ts`.

- `toursModel.ts`: add `'requested'` to `TOUR_STATUSES` (+ label "Requested"); transitions:
  `requested → scheduled` (time set) and `requested → canceled`; `canReschedule('requested')` = true
  (setting a time IS the scheduling); `closed` stays terminal.
- `toursRepo.ts`: `scheduledAt` optional on create (absent → status `requested`; present → `scheduled`
  as today). The sparse `byScheduledAt` GSI already tolerates absence (audit-confirmed). Add the
  `byStatus` GSI (hash `status`, range `created_at`) to tables.ts + BOTH tfvars (declaration only) +
  a `listByStatus(status)` repo fn (paginated, mirroring existing list fns).
- `routes/tours.ts`: POST — `scheduledAt` now optional; absent → create `requested`, DO NOT arm
  reminders; present → unchanged (scheduled + arm). PATCH — setting `scheduledAt` on a `requested`
  tour → status `scheduled` + arm reminders (the existing reschedule/re-arm path; verify it arms from
  zero rows). GET — add optional `?status=` filter (validated against `isTourStatus`; combinable alone;
  the existing tenantId/unitId/from+to modes unchanged; still 400 with no filter at all).

**Tests (RED first):** model (guard accepts `requested`, transitions, canReschedule); repo (create
without scheduledAt round-trips as `requested` + appears in `listByStatus('requested')` + absent from a
byScheduledAt range query); API (POST without time → 201 requested + NO reminder rows; PATCH sets time →
scheduled + reminder rows armed with correct dueAts; GET ?status=requested returns it; garbage status →
400; existing modes regression-green).

---

## Task 2 (gap 5): Schedule-a-tour dialog + ContactDetail wiring

**Files:** create `dashboard/src/routes/tours/ScheduleTourDialog.tsx` (+ `.test.tsx`); modify
`dashboard/src/routes/contact/ContactDetail.tsx` (pass `onScheduleTour` to TenantFile),
`dashboard/src/api/endpoints.ts` (`createTour` — make `scheduledAt` optional), `dashboard/src/api/types.ts`
(Tour type gains `requested` status if typed).

- Dialog (mirror the `PlacementCreateForm.tsx` modal/typeahead/AbortController pattern): tenant context
  fixed (opened from the tenant's file); pick the unit (same picker pattern/endpoint as
  PlacementCreateForm); `tourType` PREFILLED from the picked unit's `tour_process` (staff can override;
  the three values per the model); **date/time OPTIONAL** — leaving it empty creates a `requested` tour
  (copy: "No time yet — creates a tour request you can book later"), a picked datetime creates
  `scheduled`. Uses the flexible-phone-entry era form idioms (inline errors, accessible labels).
- Wire `onScheduleTour` in ContactDetail (TenantFile card action renders once the prop exists —
  audit: TenantFile.tsx:61/193–200). On success: refresh the tours card + link to the new tour.

**Tests:** dialog renders from the tenant file action; unit pick prefills tourType from tour_process;
submit WITH time → POST carries `{tenantId, unitId, scheduledAt, tourType}`; submit WITHOUT time → POST
has NO scheduledAt (and UI signals a request); API error surfaces inline; a11y (roles/labels).

---

## Task 3 (gap 6): Tours nav item + /tours list page

**Files:** modify `dashboard/src/app/nav.ts` (+ LOCKED comment amendment), `dashboard/src/App.tsx`
(route); create `dashboard/src/routes/tours/ToursPage.tsx` (+ hook + `.test.tsx`); update
`dashboard/src/app/AppFrame.test.tsx` (nav labels) and `e2e/tests/dashboard-next/frame.spec.ts` (nav
labels; flag any other nav-asserting spec the grep finds).

- Nav: "Tours" in the Workspace group AFTER Placements; update the LOCKED comment per Global
  Constraints.
- `/tours` page: two sections — **Upcoming** (GET `/api/tours?from=<today>&to=<+30d>`, grouped by
  local date, soonest first; each row: tenant, property, time, status, type → links `/tours/:tourId`)
  and **Needs booking** (GET `/api/tours?status=requested`, oldest first; rows link the same). Empty
  states for both. Mirror an existing list page's data-hook idiom (abort-safe fetch à la useToday/
  useContacts). Add the `?status=` param to the endpoints.ts client fn.

**Tests:** nav renders + routes; page renders both sections from mocked API (grouping by date correct;
needs-booking lists requested tours); row links to detail; empty states; AppFrame/frame nav label
assertions updated.

---

## Task 4 (gap 7): tours_today repoint (both builders) + retire the tour_date branch

**Files:** modify `app/src/routes/today.ts` (server builder), `dashboard/src/routes/today/buildToday.ts`
+ `useToday.ts` (client fallback), tests: `app/test/today*.test.ts` (whatever covers today.ts),
`dashboard/src/routes/today/buildToday.test.ts`.

- Server `/api/today`: inject/use toursRepo; tours_today = Tours with `scheduledAt` on the caller's
  local date (the route already receives the caller's day basis — reuse it), status in
  {scheduled, confirmed}; items link to `/tours/:tourId` (adjust the TodayItem ref shape for a tour ref —
  follow the existing refType pattern; keep other groups' shapes untouched).
- Client fallback: `useToday` fetches today's tours (`/api/tours?from&to` for the local day) alongside
  its existing sources; `buildTodayFromSources` builds tours_today from TOURS ONLY.
- RETIRE the `placement.tour_date` branch from BOTH builders (P2). The placement `tour_date` field and
  its `tour_scheduled` milestone are untouched. Update buildToday tests: tour_date placements no longer
  yield tours_today items; Tour entities scheduled today do; a `requested` tour does NOT.

---

## Task 5: e2e + full gates + adversarial review (orchestrator-led)

- e2e additions: (a) schedule a tour from a tenant file WITH a time → it appears on `/tours` Upcoming +
  on Today's "Tours today" group; (b) schedule WITHOUT a time → appears under Needs booking (and NOT on
  Today); (c) nav shows Tours. Extend existing specs/verbs; accessibility-first.
- Full suite `npm run e2e > out 2>&1; echo EXIT=$?` → EXIT=0 (own lane; warm containers first).
- typecheck + app + dashboard suites green (real exit codes; known DynamoDB-Local under-load flakes
  verified by isolation re-run only).
- Adversarial review: reminders can't fire for a requested tour; requested→scheduled arms exactly once;
  byStatus GSI declared in BOTH tfvars + tables.ts; no tours_today regression (legacy placements
  silently dropped is INTENDED — verify nothing else read that branch); nav-LOCKED amendment recorded;
  a11y. Fix loop. Leave branch ready; do NOT merge. Report must flag the post-merge dev terraform apply
  (new GSI) for the human.
