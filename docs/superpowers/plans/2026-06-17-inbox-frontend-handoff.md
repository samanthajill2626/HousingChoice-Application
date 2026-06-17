# Inbox Frontend Handoff — new dashboard `/inbox` (ORCHESTRATOR PROMPT)

> **You are the ORCHESTRATOR for this frontend slice.** Do NOT write all the code
> yourself. Drive specialist subagents — a **builder**, a **reviewer**, and an
> **adversarial reviewer** — and triage their findings, exactly as this project has
> done for every surface so far. Use the **superpowers:subagent-driven-development**
> sub-skill to run each phase (builder implements TDD-style → reviewer checks →
> adversarial reviewer attacks). You decide which findings are real; fix those, drop
> the pedantic ones. **Self-QA before you declare done — the human is NOT your
> bug-finder** (a hard expectation on this project: see "state-sync" below). Your
> autonomous verification is **unit tests + reviews ONLY** — do NOT run the browser
> hermetic stack, e2e, or a live :5174 pass (see *Acceptance* for why).

## Goal

Build the new entity-centric **Inbox** at `/inbox` in the `dashboard/`
(`@housingchoice/dashboard`, :5174) workspace, replacing the current `Placeholder`.

## Read first (source of truth — design owned by the main session; do not redesign)

- **`docs/superpowers/specs/2026-06-17-inbox-design.md`** — the full locked design.
  Build to it. **The C8 wire shapes there are the contract — copy them verbatim;
  don't invent/rename fields.**
- `docs/superpowers/specs/2026-06-16-new-dashboard-design.md` — paradigm + nav +
  conventions. Study the EXISTING built surfaces and match their structure/idiom:
  `dashboard/src/routes/today/`, `dashboard/src/routes/contacts/`,
  `dashboard/src/routes/contact/` (esp. the legacy `useInbox` live-update policy this
  references), `dashboard/src/api/`, `dashboard/src/app/nav.ts`,
  `dashboard/src/ui/tokens.css`.
- `.claude/CLAUDE.md` + `documentation/GLOSSARY.md` — terminology (tenant→"home",
  landlord/staff→"listing"; **"group text" not "relay"**; never "property").

## Worktree (isolation — required)

- From the main checkout, create a NEW worktree **under `w:\tmp`** (NOT in
  `.claude/worktrees/`): `git worktree add w:/tmp/hc-inbox-frontend -b inbox-frontend HEAD`
  then `cd` into it. Branch from **local HEAD**.
- **Do NOT switch HEAD in the main checkout. Work only in your worktree. Do NOT merge
  or push to `main`** — leave the branch for the human to merge and report back.

## Scope

- Route `/inbox` (nav entry already exists) — replace `Placeholder`.
- Components: `Inbox.tsx` (header + filter tabs + list + pagination + states),
  `InboxRow.tsx` (the locked row + actions), `useInbox.ts` (data + live updates +
  optimistic mark-read), `inboxFilters.ts` (tab state → query).
- Contract: copy C8 types into `dashboard/src/api/types.ts`; add endpoints to
  `dashboard/src/api/endpoints.ts`. **Degrade gracefully** — `GET /api/inbox` will
  **404 until the backend slice lands**; handle it like the existing "pending"
  panels (honest empty/loading), NOT a crash. (The backend is a parallel handoff:
  `2026-06-17-inbox-backend-handoff.md`.)
- Behaviors (per spec): filters **All (default)** / Unread / Unknown / Assigned-to-me;
  rows newest-activity-first, unknowns inline w/ amber "Needs triage"; **tap row →
  contact page, reply box NOT auto-focused**; inline **Mark read + Assign** (hover on
  desktop, **swipe** on mobile); **opening marks read** (optimistic); live updates via
  `useEventStream` (patch-in-place + debounced refetch, modeled on legacy `useInbox`);
  **nav Inbox badge = unread count**, live; empty/loading/error states from the spec.
- **Non-goals:** no in-inbox reading pane, no quick-reply composer, no triage UI
  here (unknown rows just route to the contact/triage view), no search yet.

## ⚠️ State-sync (the recurring bug class — get this right)

"**Anything live on the page must update when data changes.**" After mark-read /
assign / a new inbound (SSE), EVERY surface showing that data must re-render: the
row (preview/unread/assignment), the **nav badge**, and the **filter counts**. The
adversarial reviewer must specifically hunt stale-after-mutation bugs and
optimistic-update rollback-on-failure. This is the project's #1 historical UI defect.

## Suggested phases (formalize with writing-plans, then build)

1. Contract types + endpoints + `useInbox` (first page, filters, cursor) with unit
   tests; degrade-on-404.
2. `Inbox.tsx` + `InboxRow.tsx` + states + filter tabs; nav badge.
3. Live updates (SSE patch/refetch) + optimistic mark-read/assign + inline actions
   (hover/swipe).
4. Adversarial review across the whole slice; fix real findings. (No e2e / live
   :5174 pass — deferred to the integration phase; see *Acceptance*.)

## Conventions & guardrails

- **CSS Modules + design tokens — NO hardcoded hex** (reuse/extend `tokens.css`).
- `noUncheckedIndexedAccess` is ON — index access yields `T | undefined`; guard with
  `?? …`. TypeScript strict.
- Tests use **accessibility-first selectors** (`getByRole`/`getByLabel`).
- Match the existing surfaces' file layout and the typed `fetch` client; reuse
  `useEventStream`.

## Adversarial review — make the adversarial subagent hunt for

**State-sync / live-update correctness** (see above), **SSE race conditions** (patch
vs debounced refetch coalescing; ordering), **optimistic-update rollback** on failed
mutation, **accessibility** (roles/labels/focus; swipe has a keyboard/pointer
fallback), **mobile swipe** correctness, **contract drift** vs C8, **XSS** in
preview/name rendering, and missed renames/terminology ("relay"→"group text").
**You confirm each finding is real before acting; drop pedantic ones.**

## Acceptance / verification (autonomous = UNIT ONLY; e2e is deferred)

Run autonomously, all must be clean:
- `npm test -w @housingchoice/dashboard` (vitest unit — port-free, hermetic),
- `npm run typecheck -w @housingchoice/dashboard`,
- `npx eslint dashboard/`,
- `npm run build -w @housingchoice/dashboard`.

**Do NOT run `e2e:session`, do NOT run/author browser e2e, do NOT do a live :5174
pass.** Rationale: the browser hermetic stack uses fixed ports shared across
worktrees (can't run concurrently), AND the Inbox only behaves for real once C8 is
merged behind it — in isolation it can only exercise the 404/degrade path. So **all
e2e + the live UI verification are deferred to a single integration pass** that the
**main session** runs **after both branches merge, gated by Cameron's approval**.

Cover behavior thoroughly in **unit tests** instead — including the state-sync paths
(mark-read/assign/new-inbound → row + nav badge + filter counts), optimistic-update
rollback, and SSE patch-vs-refetch — since that's your only autonomous safety net.

**Deferred to integration (do NOT do these now; note them in your summary):** the
`/inbox` browser e2e (`e2e/tests/dashboard-next/inbox.spec.ts`), the live :5174
click-through, and the SMS/MMS/voice/intake round-trip rebuild (dropped in
`40bd4f0`, needs C8 + inbound data).

## Ports

You do **not** run the hermetic stack, so no port coordination is needed. Unit
tests are port-free and run fine alongside the other worktree.

## Reporting (do not merge)

When unit tests + reviews are green, **STOP**. Write a short handoff summary: what
you built, how you verified (unit coverage), the **integration follow-ups deferred
to the main session** (the `/inbox` browser e2e, live :5174 pass, and the comms
round-trip rebuild — all run after C8 merges, gated by Cameron), and any contract
notes. Leave branch `inbox-frontend` for the human to merge. **If you find
C8 needs to change, do NOT silently diverge** — flag it back; the design is owned by
the main session.
