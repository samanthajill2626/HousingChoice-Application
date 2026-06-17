# New Dashboard Build — Implementation Plan (frontend) + API Contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax. This is a large greenfield app: each **phase** is a buildable, verifiable increment; within a phase, builders work task-by-task with TDD and the two-stage review.

**Goal:** Build the new entity-centric HousingChoice dashboard from scratch (`dashboard/` workspace on :5174) — foundation + app frame + Today + Tenant/Landlord/Listing pages — against a defined API contract, with the backend slices implemented separately by another agent.

**Architecture:** React 19 + Vite 7 + react-router 7 + CSS Modules + a typed `fetch` API client (same stack as legacy, fresh code). **Contract-first**: the frontend imports a local `api/types.ts` and calls existing endpoints where they suffice and new endpoints (defined in §API Contract) where needed; new endpoints degrade gracefully (loading/empty/"pending backend") until the backend agent ships them. SSE for live updates (reuse the legacy `useEventStream` pattern).

**Tech Stack:** TypeScript (strict), React 19, Vite 7, react-router-dom 7, Vitest + @testing-library/react (jsdom), Playwright (e2e via the shared harness).

**Design source of truth:** [2026-06-16-new-dashboard-design.md](../specs/2026-06-16-new-dashboard-design.md) + committed mockups in [../specs/2026-06-16-new-dashboard-mockups/](../specs/2026-06-16-new-dashboard-mockups/).

**Backend handoffs (other agent):** [2026-06-16-new-dashboard-backend-handoffs.md](./2026-06-16-new-dashboard-backend-handoffs.md) — sequenced, self-contained prompts, each with builder → reviewer → adversarial-review orchestration.

---

## Division of labor & sequencing

| Track | Owner | Depends on |
|-------|-------|-----------|
| Frontend foundation (B0) | this session | nothing (existing backend only) |
| Frontend frame + Today (B1) | this session | existing `/api/cases`, `/api/conversations` (+ optional `/api/today`) |
| Frontend pages (B2 Tenant, B3 Landlord, B4 Listing) | this session | the **API Contract** below; degrade until backend lands |
| Backend slices (BE1–BE6) | **other agent** (handoffs doc) | existing repos in `app/` |

**Interlock rule:** the contract types in §API Contract are copied **verbatim** into both the frontend `dashboard/src/api/types.ts` and the backend route serializers. Neither side invents fields the other doesn't know. Changes to the contract are made here first.

---

## API Contract (the shared seam)

These are the **new / extended** wire shapes. Existing shapes (Contact, UnitItem, CaseItem, Conversation, Message, etc.) are reused from the legacy contract (`dashboard-legacy/src/api/types.ts`) unless extended here.

### C1 — Contact ↔ multiple phone numbers
Extends `Contact`. Existing single `phone` stays (the primary, for back-compat).
```ts
export interface ContactPhone {
  phone: string;            // E.164
  label?: string;           // "cell", "work", operator note
  primary: boolean;         // exactly one true
  firstSeenAt?: string;     // ISO; when first observed
  lastSeenAt?: string;      // ISO; most recent inbound/outbound
}
// Contact gains:
//   phones?: ContactPhone[]   // when absent, treat [{phone, primary:true}]
```
Backend: `GET /api/contacts/:id` includes `phones`. Reply/call default = the `primary` (else most recent `lastSeenAt`).

### C2 — Person-centric merged timeline
```ts
export type TimelineMilestoneType =
  | 'case_opened' | 'case_closed'
  | 'listing_sent' | 'listing_reviewed'
  | 'tour_scheduled' | 'tour_took_place'
  | 'stage_changed'
  | 'number_added'
  | 'added_to_group_text' | 'removed_from_group_text';

interface TimelineBase { id: string; at: string; /* ISO, sort key */ }

export interface TimelineMessage extends TimelineBase {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;       // reuse legacy
  author: MessageAuthor;             // reuse legacy
  type: 'sms' | 'mms';
  body?: string;                     // FULL body (no server truncation)
  media_attachments?: { s3Key: string; contentType: string }[];
  delivery_status: DeliveryStatus;   // reuse legacy
  fromPhone?: string; toPhone?: string;  // which number this used
}
export interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  call_outcome: CallOutcome;         // reuse legacy
  call_duration?: number;
  party_phone?: string;              // which number
  recording_s3_key?: string;         // present ⇒ playable
  transcript?: string;               // present ⇒ collapsible (never auto-shown)
}
export interface TimelineMilestone extends TimelineBase {
  kind: 'milestone';
  type: TimelineMilestoneType;
  label: string;                     // human text, e.g. "Tour took place · Toured"
  refType?: 'case' | 'unit' | 'conversation' | 'broadcast';
  refId?: string;                    // deep-link target (links out, no inline content)
}
export type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone;

export interface ContactTimelinePage {
  items: TimelineItem[];             // chronological; client renders oldest→newest
  nextCursor: string | null;
}
```
Backend: `GET /api/contacts/:id/timeline?cursor=&kinds=` — merges every conversation tied to the contact (across all `phones`) + the milestone/event log. `kinds=message,call` filters out milestones (the "Comms only" toggle).

### C3 — Unit ↔ contacts roster + related
```ts
export interface UnitContact {
  contactId: string;
  role: 'landlord' | 'pm' | 'owner' | 'other';
  primaryVoice: boolean;             // the ☎ primary
  name?: string; company?: string;   // denormalized for the roster row
}
// UnitItem gains: contacts?: UnitContact[]   (legacy landlordId stays = the primary landlord)
export interface RelatedUnit {
  unitId: string;
  address?: Address | string;        // reuse legacy
  status: UnitStatus;                // reuse legacy
  relation: 'same_property' | 'same_landlord';
  label?: string;                    // "Same building (duplex)"
}
```
Backend: `GET /api/units/:id` includes `contacts`; `POST /api/units/:id/contacts` `{contactId, role, primaryVoice?}`, `DELETE /api/units/:id/contacts/:contactId`; `GET /api/units/:id/related → { related: RelatedUnit[] }`.

### C4 — Sent-to-tenants / listings-sent (inverse pair)
```ts
export type ListingResponse = 'interested' | 'not_a_fit' | 'no_reply';
export interface ListingSendRow {
  contactId: string; unitId: string;
  response: ListingResponse;
  sentAt: string;                    // ISO
  via: 'broadcast' | 'individual';
  broadcastId?: string;
}
```
Backend: `GET /api/units/:id/recipients → { recipients: ListingSendRow[] }` (the "Sent to tenants" list); `GET /api/contacts/:id/listings-sent → { sent: ListingSendRow[] }` (the tenant page's "Listings sent"). Same rows, two query directions.

### C5 — Media aggregation
```ts
export interface ContactMediaItem { s3Key: string; contentType: string; at: string; conversationId: string; }
```
Backend: `GET /api/contacts/:id/media → { media: ContactMediaItem[] }`.

### C6 — Similar listings
```ts
export interface SimilarUnit { unitId: string; address?: Address|string; status: UnitStatus; matchPct: number; summary: string; }
```
Backend: `GET /api/units/:id/similar → { similar: SimilarUnit[] }` (available units ranked by beds/area/rent/accepted-programs similarity).

### C7 — Today action queue
```ts
export type TodayGroup = 'needs_you_now' | 'tours_today' | 'unreplied' | 'follow_ups';
export interface TodayItem {
  group: TodayGroup;
  refType: 'case' | 'contact' | 'conversation';
  refId: string;
  who: string;                       // display name / phone
  why: string;                       // "RTA window closing"
  urgency?: string;                  // "2h left"
  tag?: string;                      // "Case · Touring"
  attention?: boolean;
}
export interface TodayResponse { items: TodayItem[]; generatedAt: string; }
```
Backend: `GET /api/today → TodayResponse`. **Frontend fallback** (B1 ships with this if `/api/today` 404s): assemble client-side from `/api/cases` (`next_deadline_*`, `attention`, `tour_date`) + `/api/conversations` (`unread_count`).

---

## Frontend file structure (`dashboard/`)

```
dashboard/
  package.json            # @housingchoice/dashboard, scripts dev/build/test/typecheck
  index.html
  vite.config.ts          # port 5174, strictPort, appProxy clone (/api /auth /public /__dev)
  tsconfig.json           # extends ../tsconfig.base.json
  public/                 # favicon, manifest, sw.js (push — later phase)
  src/
    main.tsx              # bootstrap + Router
    App.tsx               # routes + AppFrame
    index.css             # token import + base reset
    app/
      AuthContext.tsx     # /auth/me probe, dev-login, Google login
      AppFrame.tsx        # left nav + outlet + account menu
      nav.ts              # nav model (Workspace / Communications groups)
    api/
      types.ts            # contract (legacy reuse + §API Contract)
      client.ts           # fetch wrapper, relative URLs, credentials, error envelope
      endpoints.ts        # path builders
      useApi.ts           # data-fetch hook (loading/error/data)
      useEventStream.ts   # SSE (port of legacy)
    ui/                   # design system: tokens.css, Button, Field, Badge, Avatar,
                          #   Sheet, Spinner, EmptyState, IconButton, Toast, icons
    routes/
      Today.tsx
      contacts/           # ContactDetail (Tenant+Landlord share a shell), list views
      listings/           # ListingDetail, list
      (cases/, inbox/, broadcasts/, settings/  — later phases, stubbed routes)
    test/setup.ts
```

---

## PHASE B0 — Foundation (build first; no backend changes)

**Outcome:** a running, login-able `@housingchoice/dashboard` on :5174 with the app frame, routing shell, design tokens, and auth — verifiable in Playwright.

### Task B0.1 — Workspace scaffold
**Files:** Create `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/index.html`, `dashboard/vite.config.ts`; Modify root `package.json` (`workspaces += "dashboard"`).
- [ ] **Step 1:** Create `dashboard/package.json` mirroring `dashboard-legacy/package.json` (name `@housingchoice/dashboard`, same scripts + React 19 / Vite 7 deps).
- [ ] **Step 2:** Create `dashboard/vite.config.ts` — clone the legacy `appProxy` (target `http://localhost:8080`, header `x-origin-verify: dev-placeholder-not-a-secret`, proxy `/api /auth /public /__dev`), `server: { port: 5174, strictPort: true, open: false }`, `modulePreload:{polyfill:false}`, and the same Vitest block.
- [ ] **Step 3:** Create `dashboard/index.html` + `dashboard/tsconfig.json` (extend `../tsconfig.base.json`, jsx react-jsx, DOM libs, types vite/client + vitest/globals + jest-dom).
- [ ] **Step 4:** Add `"dashboard"` to root `package.json` `workspaces`; run `npm install`; verify `npm ls -w @housingchoice/dashboard`.
- [ ] **Step 5:** Commit `feat(dashboard): scaffold new dashboard workspace on :5174`.

### Task B0.2 — App bootstrap + smoke
**Files:** Create `dashboard/src/main.tsx`, `dashboard/src/App.tsx`, `dashboard/src/index.css`, `dashboard/src/ui/tokens.css`, `dashboard/src/test/setup.ts`.
- [ ] **Step 1 (test):** `App.test.tsx` — renders a "HousingChoice" heading. Run, fail.
- [ ] **Step 2:** Minimal `main.tsx` (React root + `<BrowserRouter>`), `App.tsx` (a placeholder route), `index.css` importing `tokens.css`. Run test, pass.
- [ ] **Step 3:** Author `ui/tokens.css` — a FRESH token set (color, type scale, spacing, radius) for the new design language (do not copy legacy verbatim; this is the new look's foundation). Keep it small; expand during page phases.
- [ ] **Step 4:** `npm run build -w @housingchoice/dashboard` succeeds. Commit.

### Task B0.3 — Auth (dev-login + Google + session probe)
**Files:** Create `dashboard/src/app/AuthContext.tsx`, `dashboard/src/routes/Login.tsx`, `dashboard/src/api/client.ts`, `dashboard/src/api/endpoints.ts`, `dashboard/src/api/types.ts` (start: `Me`, `DevLoginResult`).
- [ ] **Step 1 (test):** `AuthContext.test.tsx` — 401 on `/auth/me` → `Login` rendered; 200 → children. (jsdom fetch mock.) Run, fail.
- [ ] **Step 2:** `client.ts` (relative-URL fetch, `credentials:'same-origin'`, JSON, throws typed errors), `endpoints.ts` (`/auth/me`, `/auth/login`, `/auth/dev-login`, `/auth/logout`), `AuthContext` (probe `/auth/me`).
- [ ] **Step 3:** `Login.tsx` — "Sign in with Google" (link to `/auth/login`) + the hermetic **"Continue as dev user (seeded VA)"** button (`POST /auth/dev-login` → reload). Run tests, pass.
- [ ] **Step 4:** Commit `feat(dashboard): auth context + login (dev-login + Google)`.

### Task B0.4 — App frame (left nav + account menu)
**Files:** Create `dashboard/src/app/nav.ts`, `dashboard/src/app/AppFrame.tsx` (+ `.module.css`); Modify `App.tsx` (wrap routes in `AppFrame`).
- [ ] **Step 1 (test):** `AppFrame.test.tsx` — nav shows roles Today, Cases, Contacts (with Tenants/Landlords/Unknown children), Listings, Inbox, Broadcasts, Settings; account menu shows the user email + Sign out. Run, fail.
- [ ] **Step 2:** `nav.ts` — the nav model (two groups: Workspace [Today, Cases, Contacts▸{Tenants,Landlords,Unknown}, Listings], Communications [Inbox, Broadcasts]); `AppFrame.tsx` renders the persistent left nav + `<Outlet/>` + account menu (reuse AuthContext for the user + Sign out). Accessibility-first (`getByRole` nav/links). Run tests, pass.
- [ ] **Step 3:** Stub routes for every nav target (each renders an `<h1>` placeholder) so the frame is navigable. Commit.

### Task B0.5 — dev.mjs launches the new dashboard on :5174
**Files:** Modify `scripts/dev.mjs`.
- [ ] **Step 1:** Add a second Vite command for `@housingchoice/dashboard` (alongside the legacy one) with a `killPort(5174)` reap (mirror the legacy :5173 reap); set `PUBLIC_BASE_URL=http://localhost:5174` default (new dashboard owns Google OAuth) — keep the legacy reachable on :5173. Update the banner.
- [ ] **Step 2:** `npm run dev -- --local`, verify both :5173 (legacy) and :5174 (new) serve, new app logs in via dev-login. Commit.

### Task B0.6 — Playwright verification
**Files:** Create `e2e/tests/dashboard-next/frame.spec.ts` (or extend the harness target to :5174).
- [ ] **Step 1:** Spec: navigate :5174 → dev-login → AppFrame renders, nav roles present, Sign out works. Run `npm run e2e` (or the session + MCP), green.
- [ ] **Step 2:** Self-verify with the Playwright MCP (boot `e2e:session`, drive :5174) as we did for legacy. Commit.

**B0 done = the new app runs on :5174, you can log in, and the frame is navigable.**

---

## PHASE B1 — Today

- `routes/Today.tsx` + `useToday()` calling `GET /api/today` (C7) with the **client-side fallback** assembling from `/api/cases` + `/api/conversations` when it 404s. Groups: Needs-you-now / Tours-today / Unreplied / Follow-ups; each row links to its case/contact/conversation. Live-update via `useEventStream` (`case.updated`, `conversation.updated`). Tests: grouping logic (pure fn) + render. Verify in Playwright.

## PHASE B2 — Tenant detail  ·  B3 — Landlord detail

- Shared `routes/contacts/ContactDetail.tsx` shell (comms-left / file-right); a `type`-driven right pane (tenant file vs landlord file). 
- Left: `Timeline.tsx` consuming `GET /api/contacts/:id/timeline` (C2) — message bubbles (full body), call cards (collapsed transcript), milestone pins (link out), number-change + group-text markers; "Comms only" toggle (`kinds=` param); reply box (sends to primary/most-recent number, picker); Call button (number picker).
- Right (tenant): Details (phones from C1), Preferences (chips), Listings sent (`/api/contacts/:id/listings-sent`, C4), Tours, Cases, Group texts, Media (`/api/contacts/:id/media`, C5). Right (landlord): Details (role/company), Preferences, Listings (their units), Cases on their units, Group texts, Media.
- **Graceful degrade:** any C2–C5 endpoint not yet live → that panel shows a "pending" empty state, not an error. Tests per panel + Playwright once backend lands.

## PHASE B4 — Listing detail

- `routes/listings/ListingDetail.tsx` per the locked design: header (Broadcast / Edit / ⋯), left (hero, flyer View+Copy-link, details with bulleted accepted-vouchers, tour/application process, Activity), right (Contacts roster from C3, Sent-to-tenants from C4, Cases, Related from C3, Similar from C6), bottom Photos. Broadcast button → broadcast composer route (composer itself is a later phase; the button + prefill contract is defined now).

---

## Self-review notes (run before execution)

- **Spec coverage:** frame/Today/Tenant/Landlord/Listing all map to phases B0–B4; conventions (group-text, full-length messages, flyer view/copy) encoded in the contract + phase notes. ✓
- **Contract consistency:** every new endpoint the pages call (C1–C7) has a backend handoff (BE1–BE6). ✓
- **Backend not blocking:** pages degrade on missing endpoints (explicit "pending" states), so the frontend ships before/independently of the backend. ✓
