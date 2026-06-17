# New Dashboard (sub-project B) — Design (LIVING DOC)

**Date started:** 2026-06-16
**Status:** Brainstorming **in progress** (mid-flight). This document is the durable
record of locked decisions + open items so the work can resume even if the
conversation context is lost. It is updated as we go and finalized before
writing the implementation plan(s).

> Companion to sub-project A (the dashboard→dashboard-legacy rename, DONE). This
> is the from-scratch rebuild of the entire end-user dashboard, on :5174.

## Drivers (why rebuild)

New UX paradigm/workflow + architecture/code health + design quality. **Not** a
clean slate — keep the sound tech foundation (React 19 + Vite + react-router + CSS
Modules + the typed API/SSE client) and the **proven backend API contract**. Reuse
`dashboard-legacy/src/api/types.ts` as the contract reference.

## Foundations carried from sub-project A (see 2026-06-16-dashboard-legacy-rename-design.md)

- New app in a fresh `dashboard/` (`@housingchoice/dashboard`) on **:5174**.
- New `vite.config.ts` clones the legacy `appProxy` (target :8080, `x-origin-verify`,
  proxy `/api /auth /public /__dev`); pin `port:5174, strictPort:true`.
- **New dashboard owns Google OAuth** (`PUBLIC_BASE_URL=:5174`, register the
  callback). Dev-login button works on both dashboards.

## Core paradigm — LOCKED

**Entity-centric, not thread-centric.** Contacts and Cases are the spine.
Communications (SMS/MMS/calls) always live **in the context of a contact/case**,
never as free-floating threads. The **Inbox survives as a secondary communications
hub** (a lens — valuable especially on the mobile PWA), but it is not the center.
Build **piecemeal**, surfacing every structural decision for explicit sign-off
(the legacy app drifted thread-first without input — do not repeat that).

## Information architecture / left nav — LOCKED

Persistent left nav, **equal weight (nothing dimmed)**, grouped:

- **Workspace:** Today · Cases · **Contacts** (a clickable parent → full list) with
  children **Tenants / Landlords / Unknown** (filtered views of the one Contacts
  surface; `Unknown` = untriaged inbounds awaiting triage) · Listings
- *visual divider*
- **Communications:** Inbox · Broadcasts
- **Foot:** Settings · signed-in user + account menu (Sign out)

Home = the **Today** action queue.

## Home — "Today" action queue — LOCKED

A prioritized queue of what needs the navigator now, **every item anchored to a
case or contact** (never a bare thread). Groups: **Needs you now** (case
business-clock deadlines + `attention` escalation flags + untriaged inbounds),
**Tours today**, **Unreplied**, **Follow-ups due**. Fed by `CaseItem.next_deadline_*`,
`CaseItem.attention`, unread conversations, and missed calls.

## Tenant detail — LOCKED (for now)

**Layout:** comms-LEFT, file-RIGHT (reversed-C). This page + the Inbox are the two
comms-heavy pages. Mobile leads with comms + an easy toggle to the file.

**Left — unified Communications & activity timeline:**
- Merges **all of the contact's phone numbers** into one timeline (a tenant may use
  several numbers over the process).
- **Blended chronology:** message bubbles (with content) interleaved with lightweight
  **milestone markers** — case opened, listing sent, tour scheduled, stage change,
  tour took place (+outcome), listing reviewed (👍/👎), number-change, added to group
  text. Markers **link out, never inline content** (esp. group-text content).
- **Full-length messages** — no per-message "Show more"/truncation by default
  (scrolling beats clicking).
- **Calls** = a collapsed card; transcript behind a pulldown (never auto-shown).
- A **"Comms only"** toggle hides milestones.
- **Reply box** sends to the **most-recent number** with an override picker; the
  **Call** button likewise shows/picks which number.

**Right — the tenant's file (stacked cards, inline edit per section):** Details
(voucher size, housing authority, current address, phone numbers, status) ·
Preferences & notes (chips; **manual now, auto-gleaned later**) · Listings sent
(👍/👎/⏳) · Tours (+outcomes) · Cases · Group texts · Media from comms.

**Header:** avatar · name · type pill · facts · **Call** (number picker) · **⋯**
overflow (merge duplicate contact · mark unreachable · opt-out). Messaging = the
reply box (no redundant header button on desktop); editing = inline per section.

## Landlord detail — LOCKED (for now)

Same shell as the tenant page. The **right file** differs: Details (role/company,
no voucher) · Preferences (landlord-style: accepts-programs, lease terms, pet
policy, contact pref) · **Listings = the units they own** (with status) · **Cases on
their units** · Group texts · Media. Listing rows hint co-contacts ("+N contacts").

## Listing detail — LOCKED

A **structured record, NOT a comms hub** (comms live on contacts; "who did we talk
to about this unit" is answered by **pivoting through the contact roster**, not an
aggregated unit-comms view — that is **deferred**, not built).

- **Header:** address · status · facts · **📣 Broadcast to tenants** (opens the
  broadcast composer pre-filled with this unit) · Edit · ⋯.
- **Left column:** a single small **hero image**; a **flyer** affordance —
  **View flyer ↗** + **Copy public link** (the flyer is a live public page generated
  from the listing — there is **no "create" step**); **Listing details** (beds/baths,
  rent, payment standard, deposit, jurisdiction, utilities, accessibility, pets) with
  **Accepted vouchers as a bulleted list** (programs + housing authorities + best-fit
  size) rendered as a normal detail (not emphasized); **Tour & application process**;
  **Activity** (this listing's history — lives on the left, under the process card).
- **Right column:** **Contacts** (landlord/PM roster — many per unit, each opens that
  contact's page) · **Sent to tenants** (recipients + responses 👍/👎/⏳; the inverse
  of the tenant page's "Listings sent"; each links to the tenant) · **Cases on this
  listing** · **Related listings** (duplex siblings / same landlord or property) ·
  **Similar listings** (other *available* units with comparable beds/area/rent/
  accepted vouchers — alternatives, with a match %).
- **Bottom (full-width):** **Photos** — thumbnail gallery with "+ Add".

**Broadcast composer note (for when we design it):** the recipient chooser must allow
adding **specific tenants — even one, even if they don't match the listing's
requirements** — with a **mismatch flag shown before confirm**.

## Conventions

- Human-facing copy says **"group text"** (not "relay"/"placement relay"); code keeps
  `relay_group`. Audience nouns per [GLOSSARY](../../../documentation/GLOSSARY.md)
  (home/listing/unit).
- Mockup **amber annotations are commentary only** — never real UI.
- All current mockups are **structure/layout wireframes**, not final visual design
  (color, type, polish come in a later design-system pass).

## Backend dependencies to schedule (NEW work — flag, don't silently assume)

1. One contact → **multiple phone numbers**.
2. **Person-centric merged timeline** (comms + activity) across a contact's numbers.
3. **Listings-sent + per-listing yes/no** and **tour outcomes** as queryable contact
   history.
4. **Media aggregation** from a contact's comms.
5. **Unit ↔ contacts many-to-many** (a roster of landlord/PM contacts with roles) —
   replaces the single `unit.landlordId`.
6. Per-listing **recipients + responses** (the listing-side inverse of #3 — the
   "Sent to tenants" list on the Listing page).
7. **Related-unit grouping**: a parent "property" (duplex/building) link + a
   same-landlord lookup, to populate "Related listings".
8. **Similar-listings matching**: rank available units by attribute similarity
   (beds/area/rent/accepted vouchers) for the "Similar listings" pane.
9. *(later phase)* **auto-gleaned preferences** from comms.
10. *(deferred — not building now)* listing-level comms aggregation across the roster.

Design the pages for these now; launch against the primary number / single landlord
until the corresponding backend slice lands.

## Decision log (chronological, condensed)

1. Org principle: entity-centric; Inbox secondary; build piecemeal.
2. Nav = persistent left (workspace vs communications groups); Contacts parent with
   Tenants/Landlords/Unknown children; nothing dimmed.
3. Home = Today action queue (entity-anchored items).
4. Tenant page = comms-left/file-right; unified multi-number blended timeline;
   full-length messages; calls collapsed; reply→most-recent number.
5. Landlord page = same shell, listings-centric file.
6. Multi-number designed now; backend flagged.
7. Listing page = roster pivot (multi-contact per unit); backend many-to-many flagged.
8. Listing detail **LOCKED**: roster-pivot only (aggregated unit-comms deferred);
   added "Sent to tenants" (inverse roster), Related + Similar listings; flyer =
   View/Copy-link (no "create"); accepted vouchers = plain bulleted detail; Activity
   on the left; Broadcast must allow adding non-matching tenants with a flag.

## Still to detail (piecemeal, upcoming)

**Cases pipeline** (kanban/views over `CASE_STAGES`) → Contacts list views
(Tenants/Landlords/Unknown) → Inbox (comms hub) → Broadcasts → Settings/Admin →
public pages (housing-fair signup, flyer) → mobile treatments → then architecture +
design-system approaches → finalize this spec → writing-plans → phased implementation.

## Visual record (committed)

- `docs/superpowers/specs/2026-06-16-new-dashboard-mockups/progress-print.html` —
  the **three locked screens** (Home, Tenant, Landlord), self-contained + printable
  (Print → Save as PDF, Background graphics ON).
- `…/listing-detail.html` — the draft Listing page.
- Working scratch lives under `.superpowers/brainstorm/` (gitignored, ephemeral).

## How to resume

This doc + the committed mockups are the source of truth. To continue the visual
brainstorm: restart the companion with
`BRAINSTORM_PORT=7321 bash <superpowers>/skills/brainstorming/scripts/start-server.sh
--project-dir <repo>` and re-open/iterate mockups (copy the committed ones into the
new session `content/` dir if needed). Then proceed from "Still to detail".
