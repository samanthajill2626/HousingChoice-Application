<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Contact comms & Listings refinements — design

**Status:** implemented (landed on `main` this session) — documented after the fact.
**Date:** 2026-06-18.
**Surface:** new dashboard (`dashboard/`, :5174) — contact detail (Timeline + file panes),
Contacts list, Listings list + listing detail. A few touch the app shell (`AppFrame`).

## Why this doc

A run of incremental UI/UX fixes shipped without their own spec (each was small and
verified live/with unit tests). This captures the **decisions + rationale** so the behaviour
is discoverable and not re-litigated. It does not introduce new contracts; the base data
model and the [extensible-contact-creation](./2026-06-18-extensible-contact-creation-design.md)
type model are unchanged and authoritative.

## 1. Unknown (untriaged) contact treatment

A contact with `type: 'unknown'` gets its **own detail view**, not the Tenant file (the old
binary `else = tenant` mislabeled untriaged inbounds). `ContactDetail` resolves a three-way
**kind** — `landlord`/`pm` → landlord, `unknown` → unknown, everything else → tenant — which
drives the file pane + pill colour; the pill **label** is `displayKind` (`role` ?? type).

- **`UnknownFile`**: only type-agnostic cards (Details = phones + status, Preferences, Cases,
  Media) — none of the tenant-specific cards (voucher / housing authority / listings-sent /
  tours) — plus a **"Needs triage"** CTA: **Mark as Tenant / Mark as Landlord**, wired to
  `PATCH /api/contacts/:id { type }` (the triage action from the contact-create work). The
  PATCH returns the updated contact, applied in place so the page re-derives with no refetch.
- Amber **"Unknown"** pill (`--c-pill-unknown-bg`, the nav's Unknown-dot family).

## 2. Do-Not-Contact (sms_opt_out)

When `contact.sms_opt_out` is true: a red **"⛔ Do Not Contact"** badge in the header (always
visible) and a standing note at the composer. Sends are refused server-side
(`409 contact_opted_out`); the reply box maps that to a **clear reason** — *"This contact is on
the Do-Not-Contact list — texting is disabled. Clear the opt-out from the ⋯ menu…"* — instead
of a generic "couldn't send". Other refusal codes (`manual_mode`, `breaker_open`,
`sms_sending_disabled`, `relay_closed`) get human messages too; everything else falls back to
the generic line. Send stays enabled (so the attempt yields the clear reason).

## 3. Optimistic send lifecycle

Hitting Send shows the outbound bubble **immediately** (no "did it go?" gap) and clears the
draft. The bubble advances **Sending… → Sent → Delivered**:
- `queued` is relabelled **"Sending…"** (it's the app-accepted / pre-carrier waypoint).
- `useContactTimeline` owns optimistic state: `addOptimistic` (inserts a `queued` bubble),
  `resolveOptimistic` (stamps the real `tsMsgId` + status from the POST), `failOptimistic`
  (removes it). The merged `items` dedupe optimistic vs server rows **by `tsMsgId`**, so once
  the SSE refetch carries the real row the optimistic copy drops out and the server row then
  progresses Sent → Delivered on its own.
- On POST failure the optimistic bubble is removed, the draft restored, and the reason shown
  (§2). Reset per-contact.

## 4. "Media from comms" = live timeline derivation

The contact file's media gallery derives from the **live timeline** (`commsMedia(items)` →
`MediaGallery`), not the one-shot `GET /api/contacts/:id/media` slice — so it updates the moment
a new attachment arrives (the timeline refetches on SSE `message.persisted`). Reuses the
bubbles' authed `/api/messages/<sid>/media/<i>` URL. The C5 slice in `useContactFile` is now
unused (flagged `TODO(contact-file-dead-media-slice)` for removal).

## 5. Reply composer behaviour

- **Enter to send / Shift+Enter newline on desktop**; on touch (`pointer: coarse`) the return
  key makes a newline and the on-screen Send button sends (standard mobile-messaging pattern).
  `isComposing`-guarded (covers IME / Android keyCode-229).
- **Auto-grow textarea** (`useAutoGrowTextarea`): one line by default, grows to fit content up
  to a CSS `max-height` (then scrolls); a **manual drag-resize wins** until the draft clears,
  then it re-arms. Measures `scrollHeight + borders` for both empty and typed states so there's
  no sub-pixel jump on the first keystroke.

## 6. Contacts list — on-page filter tabs

The Contacts list shows **All · Tenants · Landlords · Unknown** tabs (links to the same four
routes the nav uses), so the filters live on the page and the nav links are shortcuts; the URL
stays the source of truth and the active tab reflects the current `filter` (`aria-current`).
Custom kinds show under their **base type** (no per-kind tab — matches the contact-creation
non-goal).

## 7. Listings list — filters

- **Status** dropdown: All / Available / Placed / Inactive (single-select).
- **Housing authority** multi-select chips, derived from the distinct `unit.jurisdiction`
  values present (slugs humanised: `atlanta_housing` → "Atlanta Housing", `ga_dca` → "GA DCA").
  Empty selection = all; a **Clear** affordance resets. Filters combine as **AND** with each
  other + the address search.
  *(Terminology: a listing's housing authority is the unit's `jurisdiction`; the listing detail
  still labels that field "Jurisdiction" — align later if desired.)*

## 8. Listing detail — mobile

A `@media (max-width: 768px)` reset (placed **last** in the module so it wins at equal
specificity): the header **stacks** (identity on top; actions wrap — Broadcast full-width, Edit
+ ⋯ below) instead of crushing the title into a fixed button cluster, and the detail KV grid
collapses to **one column**. The stacked columns `align-items: stretch` to full width, and the
column horizontal padding was dropped (cards fill the column; a `.cols` gap separates the two
columns on desktop). 768px matches the nav breakpoint.

## Testing

All verified by unit tests (Vitest) and, where layout-dependent, live at phone + desktop widths
via Playwright. Key specs: `Timeline` (Enter/Shift+Enter/mobile send, opt-out reason, optimistic
note), `useContactTimeline` (optimistic insert/resolve/dedupe/fail), `useAutoGrowTextarea`
(grow/cap/manual-override/no-jump), `deliveryStatus` (queued = "Sending…"), `ContactDetail`
(Unknown treatment, Do-Not-Contact badge), `ContactsList` (filter tabs), `ListingsList`
(status + housing-authority filters + clear + AND), plus `media`/`MediaGallery`.

## Non-goals

- No new data contracts (additive UI over existing endpoints/SSE).
- Mobile reset covered the **listing detail** only; other pages (Contacts/Today/Inbox/contact
  detail) are a later pass.
- Removing the dead C5 media slice is deferred (flagged in code).
