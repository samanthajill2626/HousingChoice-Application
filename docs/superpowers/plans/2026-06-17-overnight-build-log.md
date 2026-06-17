# New Dashboard — Overnight Build Log (2026-06-16 → 06-17)

Autonomous frontend build on the **`dashboard-next`** worktree (branched from `main`
`1b79301`). Backend slices BE1–BE6 are being built **separately** (another worktree,
merged to `main` by Cameron). The two tracks meet at the committed **API Contract**
(C1–C7 in `2026-06-16-new-dashboard-build.md`).

**Status: all locked pages + a first-pass list layer built, reviewed, and
live-verified on :5174.** 165 dashboard tests passing; typecheck + eslint + build
green. 34 commits.

## What was built (each: builder → reviewer → adversarial review → triage/fix → live Playwright verify)

| Phase | Result |
|-------|--------|
| **B0 foundation** (pre-overnight) | app on :5174, auth, frame, tokens. |
| **Visual: dark nav + icons** | dark slate sidebar, fresh SVG icon set, Contacts filter dots — matches the locked wireframe. Icon polish (Settings → sliders). |
| **B1 — Today** | action queue; server-first `/api/today` with a **client fallback** from `/api/cases` + `/api/conversations`; SSE live-refresh. Live-verified (real seeded item). |
| **B2/B3 — Tenant + Landlord detail** | shared ContactDetail shell (dark header band, comms-left/file-right); blended timeline w/ a **messages-only fallback** (real seeded SMS render in order); type-driven file panes. Both live-verified. |
| **B4 — Listing detail** | structured record per the locked v4 mockup; real details/roster(fallback)/cases/related(fallback); honest pending panels. Live-verified. |
| **Stretch — list views** (first-pass, pending-design) | Contacts (Tenants/Landlords/Unknown/all, search) + Listings (search), wired into the nav → detail pages. Live-verified. |

## REAL now vs PENDING-until-backend-merges

**Real today (existing endpoints + fallbacks):** auth/frame/nav; Today queue; contact
Details + Cases + Tours; the **contact timeline** (real seeded messages, chronological);
landlord Listings; listing details/roster(landlord)/cases/related(same-landlord);
the list views.

**Lights up when BE1–BE6 merge** (each panel already calls its endpoint and degrades
to "pending" on 404 — no component changes needed):
- **BE2** `/api/contacts/:id/timeline` → timeline gains **milestones + call cards +
  number-change/group-text markers** (today it's messages-only).
- **BE4** `/recipients` + `/listings-sent` → "Sent to tenants" / "Listings sent" rows.
- **BE5** `/media` → "Media from comms".
- **BE3** `/api/units/:id` `contacts[]` + `/related` → full PM roster + real duplex/
  same-property related (today: single-landlord fallback).
- **BE6** `/api/today`, `/similar` → server-enriched Today (real names instead of
  IDs) + "Similar listings".
- **BE1** multi-phone → the timeline already merges across a contact's numbers when
  the wire provides them.

## NEEDS CAMERON'S INPUT / known gaps (flagged, not guessed)

1. **Public flyer URL (decision needed).** `/public/units/:id/flyer` is a **JSON
   endpoint** and only serves `available` units — not a shareable HTML page. I made
   the Listing page's flyer affordance an **honest pending note** rather than ship a
   misleading "View flyer" JSON link. **Q: what's the real public flyer page URL?**
   (Likely a future "public routes" phase — the legacy app renders it client-side.)
2. **Raw IDs as labels** on Today case rows, "Cases on this listing", and (future)
   "Sent to tenants" — the wire carries no name on `CaseItem`/`ListingSendRow`. Honest
   (not fabricated); **BE6's `/api/today` and BE4's enrichment resolve them**. If you
   want names sooner, a client-side contacts-map is possible but doesn't scale (BE is
   the right fix).
3. **First-page-only** fan-out (lists, listing Related/Cases, contact timeline) — a
   project-wide transitional limitation; the corresponding BE endpoints supersede it.
   Documented in code + page copy.
4. **List views are first-pass / pending-design** — conventional row lists to make the
   nav navigable; they want a proper design pass with you.
5. **Non-wired header actions** (Broadcast / Edit / ⋯) — intentional; the broadcast
   composer + edit forms are later phases (the button + prefill contract is defined).
6. Minor: Listing header facts show `$1,650/mo` while the details grid shows Rent/
   Payment-standard `—` for the same unit (seed sparseness + facts uses a different
   field than the grid) — cosmetic, worth a glance.

## Integration / merge

- Frontend lives on `dashboard-next` (from `main` `1b79301`). Backend merges to
  `main` separately. After both are on `main`, the pending panels light up via the
  contract — the frontend's `api/types.ts` holds the **same C1–C7 shapes verbatim**
  (plus frontend-local copies of legacy types like `Contact`/`CaseItem`, which won't
  conflict with backend code).
- `scripts/dev.mjs` launches **both** dashboards (`legacy` :5173, new `dashboard`
  :5174); `e2e-session.mjs` serves :5174 too.
- Hermetic stack: DynamoDB Local + MinIO containers left running (`npm run db:stop` /
  `s3:stop` to stop); app/worker/vites torn down.

## Verify it yourself
`npm run dev -- --local` (or `npm run e2e:session`) → open **http://localhost:5174**,
dev-login → Today, then `/contacts/contact-tenant-0001`, `/contacts/contact-landlord-0001`,
`/listings/unit-0001`, `/contacts/tenants`, `/listings`.
