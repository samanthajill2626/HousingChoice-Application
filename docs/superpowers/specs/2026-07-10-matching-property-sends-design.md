# Matching: one send pipeline for one-to-one and one-to-many property sends

- Date: 2026-07-10
- Status: approved (design review with Cameron, 2026-07-10)
- Related: documentation/sending-unit-sequence-writeup.md (the matching loop),
  docs/superpowers/specs/2026-06-30-broadcasts-dashboard-design.md (existing
  pipeline), app/src/routes/units.ts individual-send seam comment

## Problem

Staff cannot send a property to a single tenant. The only send flow is the
broadcast composer (audience filters -> curated recipient list -> send), and
its entry points and copy are all one-to-many ("Broadcasts", "New broadcast").
The tenant file's "Properties sent" card and the property page's "Sent to
tenants" card are read-only records with no way to start a send. The backend
even reserved a seam for this (units.ts: "there is currently NO individual-send
route"; the listing_sends model already supports via:'individual').

An early idea (a separate one-to-one modal) was rejected in review: it forks
sending into two pipelines and forces a confusing chooser on the property page.
Decision: ONE cohesive send process, adaptable to one recipient or many, with
entry points that seed the recipient scope.

## Goals

1. A staff user can send a property to exactly one tenant, from the tenant's
   file or from the property page, through the same pipeline broadcasts use
   today (consent gates, per-recipient delivery tracking, listing_sends
   capture, 1:1 conversation delivery).
2. Any send can hand-pick specific tenants in addition to (or instead of)
   audience filters.
3. The section is renamed from "Broadcasts" to "Matching" in all human-facing
   copy; the send flow is called "Send a property".
4. The existing cards ("Properties sent" on the tenant file, "Sent to tenants"
   on the property page) gain "+ Send" header actions that open the pipeline
   pre-seeded, and continue to list ALL sends regardless of reach.

## Non-goals

- No new send entity. Code and data keep the broadcast* names (tables, repos,
  routes, ids). The rename is copy-level only.
- No URL churn. Routes stay /broadcasts, /broadcasts/new,
  /broadcasts/:broadcastId. The nav label "Matching" points at /broadcasts.
- No changes to delivery mechanics (A2P pacing, DLR rollups, live progress),
  audience filter semantics, or response tracking (interested / not_a_fit).
- No preference-capture or match-suggestion features (future Matching surface
  growth; out of scope here).
- Generic no-property sends remain supported and unchanged (composer without
  a property attached).

## Naming and glossary

- Nav item + list page heading: "Matching" (was "Broadcasts").
- Primary action on the list page: "Send a property" (was "New broadcast").
- An individual record reads as a send with its reach: "to 12 tenants",
  "to Brianna Whitfield". Avoid the bare noun "a matching".
- All remaining human-facing "broadcast" copy in the dashboard is replaced
  (list page, composer, review step, results page, empty states, aria-labels).
  Internal identifiers, API paths, table names, and log fields keep broadcast*.
- documentation/GLOSSARY.md gains the mapping in the same change:
  human-facing "Matching" (the workflow surface) and "property send" (one send
  event) <-> code broadcast* (entity/table/route). Include the audience->noun
  row so future copy stays consistent.

## UX design

### Entry points

1. Tenant file, "Properties sent" card: a "+ Send" CardAction in the card
   header (same pattern as the Tours card's "+ Schedule"). Navigates to
   /broadcasts/new?contactId=<tenantContactId>. The card's count aside moves
   into the title row unchanged (count still visible).
2. Property page, "Sent to tenants" card: a "+ Send" CardAction. Navigates to
   /broadcasts/new?unitId=<unitId> (existing param). The kebab menu's
   "Broadcast" action is renamed "Send to tenants" and points at the same URL
   (one entry, two affordances; no separate chooser).
3. Matching list page: "Send a property" button (existing /broadcasts/new
   navigation, relabeled).

Params compose: /broadcasts/new?unitId=X&contactId=Y is valid (property page
row-level future use; nothing in v1 emits it but the composer must not break).

### Composer with a seeded recipient

- ?contactId= seeds the draft with that tenant as an explicit recipient. The
  recipients step opens showing the seeded tenant as a pre-checked row,
  annotated exactly like any candidate (consent notes, opt-out, phone).
- Audience filters remain available on a seeded draft: applying them unions
  more candidates into the list; the seeded row stays pre-checked. Filters are
  a way to PROPOSE candidates; the checked set is what sends.
- The seeded tenant can be unchecked like any row (a seed is a starting point,
  not a lock).
- Unknown/missing contactId: composer loads as a normal unseeded draft and
  shows a dismissible notice ("Could not preload that tenant"); no crash.

### Hand-picking tenants (new capability, all sends)

- The Review Recipients step gains an "Add tenant" search (name or phone,
  contacts of type tenant only). Picking one adds them to the candidate list
  as a checked row with the same consent/opt-out annotations.
- Adding a tenant already in the list is a no-op highlight (no duplicates).
- Hand-picked additions persist on the draft (survive ?draftId= resume) via
  the same seed mechanism below.

### Message step

- Exactly ONE checked recipient: the template editor shows the RESOLVED text,
  editable in place ("Hi Brianna, a 2 BR home at 44 Clifton Rd NE is available
  for $1,600/mo. Details: <flyer link>"). What you see is what sends. Edits in
  resolved mode set the body verbatim for that send (no token round-trip).
- Two or more checked recipients: the tokens + merge chips editor, unchanged.
- Crossing the 1 <-> many boundary after editing: switching from resolved mode
  to token mode (or back) prompts before discarding manual edits; the default
  template re-seeds the editor.
- No property attached: resolved mode still works (tenant tokens resolve; no
  flyer line), matching today's no-property template behavior.

### After sending

Unchanged: the existing send + results flow (live progress, per-recipient
delivery). A single-recipient send's results page simply shows one row. Return
navigation stays whatever the composer does today.

## Backend design

### Draft seeding

- The broadcast draft row gains an optional field seed_contact_ids: string[]
  (explicit recipients attached to the draft, whether from an entry-point seed
  or the Add-tenant search).
- POST /api/broadcasts (createDraft) accepts optional seedContactIds.
- PATCH (draft update) can replace seedContactIds (the composer syncs it when
  staff add/remove hand-picked tenants).
- Preview (POST /api/broadcasts/:id/preview) resolves candidates as the UNION
  of audience-filter matches and seed_contact_ids, deduped by contactId. Seeded
  rows carry a flag (seeded: true) so the UI pre-checks them; every row gets
  the same consent/opt-out annotations as today. Unresolvable seed ids are
  dropped from candidates and reported in the preview response
  (unresolvedSeedIds: string[]) so the UI can surface the notice.
- Send (POST /api/broadcasts/:id/send) is UNCHANGED: it already takes the
  explicit curated selection.

### Delivery and capture (all unchanged, verified)

- The send fan-out already delivers through each tenant's own 1:1 conversation
  and records per-recipient delivery slots.
- listing_sends capture already happens per recipient on property sends; the
  tenant card and property card read those rows, so one-to-one sends appear in
  both automatically. The via field distinguishes 'broadcast' rows today;
  seeded single sends still flow through the broadcast pipeline, so via stays
  as the pipeline writes it (no schema change; the units.ts 'individual' seam
  comment should be updated to point at this spec instead of a hypothetical
  separate endpoint).

### Consent

Unchanged: per-recipient JIT consent gates and opt-out suppression run in the
send pass exactly as today; a seeded tenant without consent is annotated in
review and refused at send like any other recipient.

## Testing

TDD per slice (failing test first):

1. Backend: createDraft/PATCH persist seedContactIds; preview unions + dedupes
   + flags seeded rows + reports unresolved ids; send unchanged (regression).
2. Composer: ?contactId= seeds a pre-checked annotated row; unknown id shows
   the notice; filters union; draft resume restores hand-picked tenants.
3. RecipientPreview: Add-tenant search adds checked rows, dedupes, annotates.
4. MessageEditor: resolved mode at exactly one recipient, token mode at 2+,
   boundary-crossing prompt, no-property resolved mode.
5. Rename: list/nav/composer/results copy assertions updated; no user-visible
   "broadcast" string remains in the dashboard (test greps the rendered copy
   surfaces, not code identifiers).
6. e2e: (a) tenant-file "+ Send" -> pick property -> send -> SMS in dev outbox
   for that tenant only + row appears in "Properties sent"; (b) property-page
   "+ Send" -> hand-pick one tenant -> send -> row appears in "Sent to
   tenants" + tenant's conversation shows the message; (c) existing broadcast
   e2e specs updated for the new copy.
7. Full gates before done: npm run typecheck + npm test + npm run e2e, green
   on a base synced with current main.

## Implementation slices (ordered)

1. Backend draft seeding (seed_contact_ids + preview union + unresolved
   reporting).
2. Composer seeding (?contactId=) + RecipientPreview pre-checked seeded rows.
3. Add-tenant search in RecipientPreview (writes seeds back to the draft).
4. Resolved-text message mode at exactly one recipient.
5. Entry points: tenant-file card action, property-page card action + kebab
   relabel.
6. The Matching rename (copy + nav + glossary).
7. e2e coverage + full gates.
