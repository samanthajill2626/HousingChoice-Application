# Inactive for every contact type - design

Status: DRAFT revision 1 (2026-10-23), before design review.
Branch: `feat/unknown-inactive` (worktree `W:\tmp\unknown-inactive`, cut from
main @916258ae).
Tracker: HousingChoice Improvements Tracker item #30 "Needs review to Inactive
without choosing a type" (Oct 16 check-in; Oct 18 decision), widened by
Cameron in the 2026-10-23 scoping conversation.
Review records: `docs/superpowers/reviews/2026-10-23-unknown-inactive/`.
intent.md holds Cameron's decisions verbatim.

Vocabulary: `partner` in code is a "caseworker" or "partner" in staff copy
(documentation/GLOSSARY.md). "Header dropdown" = the interactive status pill
in the contact page header (`StatusMenu`, `ContactDetail.tsx`), which today
exists for tenants and landlords only.

Coordination: tracker #31 (Today page as the daily checklist) is a separate
mission that reorders the Today page. As of 2026-10-23 it has no branch,
worktree or spec. This spec changes ONE condition in `app/src/routes/today.ts`
and does not reorder, rename or remove any Today section.

## 1. Goal

1. Staff can mark an unknown contact Inactive without giving it a type. It
   leaves Today's Needs review list and stays a normal contact: on the
   Contacts list, in the inbox, with its threads. It is not deleted.
2. Every contact type has an inactive-type status. Cameron: "We do need to
   have some type of inactive status for all types of contact."
3. Every contact type moves through its statuses the same way: one header
   dropdown on the contact page, and the Edit contact details Status field
   offers exactly the same choices. Cameron: "We should have one consistent
   way to move people through statuses, no matter what their contact type
   is."
4. A status with the same name means the same thing for every type. Cameron:
   "if an unknown contact has the status inactive, I don't want to treat it
   differently than we're treating a different type of contact that has the
   same exact named status."

## 2. Decisions

### D1. The status lists

One `status` field per contact (unchanged); the legal values depend on the
type (`statusAllowlistFor`, `app/src/lib/statusModel.ts`).

| Type | Statuses (in dropdown order) | Change |
|---|---|---|
| tenant | Needs review, Onboarding, Searching, Placing, Placed, On hold, Inactive | none |
| landlord | Needs review, Interested, Onboarding, Active, Parked | none (Parked is its inactive status) |
| partner (caseworker) | Needs review, Active, Inactive | adds Inactive |
| team_member | Needs review, Active, Inactive | adds Inactive |
| unknown | Needs review, Inactive | adds Inactive, REMOVES Active |

- The shared `NON_TENANT_STATUSES` splits in two: partner + team_member get
  `needs_review | active | inactive`; unknown gets its own
  `needs_review | inactive` list. `statusAllowlistFor` stays the single
  source of truth for every writer and reader.
- Removing Active from unknown: Cameron, "If we can just delete the active
  type for unknown contacts, then let's do that." The read-only count on
  2026-10-23 found ZERO (unknown, active) contacts on dev and on prod, so no
  data migration is needed. After the change the server refuses a write of
  (unknown, active) on every path (D6).
- Labels: "Needs review", "Active", "Inactive" for the non-tenant lists,
  held in the status model next to the tenant and landlord label maps (no
  call site humanizes a key).

### D2. One header dropdown for every type

- The header dropdown appears for EVERY live contact type, listing that
  type's statuses from D1. Today it renders for tenant and landlord only and
  a display-only badge for the rest (`ContactDetail.tsx` ~1003-1028).
- A soft-deleted contact keeps the display-only badge (unchanged).
- It goes through the same route the tenant and landlord dropdown already
  uses (`PATCH /api/contacts/:id/tenant-status`, which already validates
  against the stored type's allowlist). No reason prompt: no status change
  from the header asks for one today, and Inactive does not either.
- team_member renders the tenant-style page (`TenantFile`); its dropdown
  lists the team_member statuses, not the tenant ones.

### D3. The Edit contact details Status field matches the header

- The form's Status field lists exactly the D1 statuses for the contact's
  type (current or newly chosen type). Cameron: "Anywhere that we would be
  able to choose one, we need to be able to choose all of them."
- The form stops keeping its own non-tenant list
  (`ContactEditForm.tsx:32-67, 132-142`). Today that list silently resets any
  value it does not know to Needs review, so saving an Inactive caseworker
  would flip it back. The dashboard takes its per-type lists from ONE shared
  module mirrored from the backend, with a mirror test pinning the two.
- A status change with NO type change goes through the same transition route
  as the header (D2), for every type, so both places write the same
  provenance (`status_source: 'manual'`), the same audit event and the same
  timeline entry. A save that changes the type AND sets a status stays the
  plain PATCH (that path already validates status against the NEW type).

### D4. What Inactive means - the same for every type

An Inactive contact of any type is treated exactly as an Inactive tenant is
today:

1. Not chased. `isEligibleRecipient` (`app/src/lib/listingSendOutcome.ts:112`)
   drops ANY contact whose status is `inactive`, whatever its type. Placed
   stays a tenant-only rule (only tenants have it). This changes the Follow
   up worklist (`services/followUps.ts`) and the listing-send rows
   (`routes/units.ts`) for Inactive caseworkers, which today stay eligible -
   the test that pins that (`app/test/listingSendOutcome.test.ts:195-198`)
   flips.
2. Blasts: unchanged. They read Onboarding and Searching tenants only.
3. Shown everywhere else as any other contact: Contacts list, inbox, search,
   threads.
4. The same muted status colour for every type (today a non-tenant Inactive
   would fall back to neutral, `StatusBadge.tsx:117-121`).
5. The same timeline wording: a status change writes "Status -> <label>" from
   the CONTACT'S OWN type's label map. Today every non-landlord type uses the
   tenant map (`contacts.ts:2129-2139`, `services/statusTransition.ts:150-154`).

Automatic texts are NOT changed (Cameron, 2026-10-23): tour reminders, group
text rosters, the missed-call auto-text, placement nudges and hand-picked
share recipients do not check status for any type today, Inactive tenants
included. Each is set off by something staff or the contact did. No issue is
filed.

### D5. Today and Needs review

- An unknown contact leaves Today's Needs review list when it is not Needs
  review. The contacts triage pass already reads only (unknown,
  needs_review) (`today.ts:845-902`), so marking it Inactive removes it with
  no change there.
- Needs you now's "New unknown contact" row for an UNREAD unknown 1:1 thread
  (`today.ts:784-800`) shows only while that contact's status is Needs
  review. Cameron: "Needs You Now shows unread texts from any unknown contact
  that needs review. If it doesn't need review, meaning we've marked it as
  inactive, it wouldn't show there ... It just shows in the inbox." A thread
  whose contact cannot be resolved keeps today's behavior.
- This is the ONLY Today change. Ordering, sections and the Unreplied section
  are #31's.

### D6. The server refuses (unknown, active) everywhere

- Every writer validates against D1, so a write of `active` to an unknown
  contact is a 400 on: the status-only PATCH, the transition route, contact
  create with an explicit status, AI status-suggestion acceptance, and the
  import's per-type validation (which falls back to Needs review, as it does
  for any status illegal for the type).
- `POST /api/contacts` with no status currently defaults an unknown create to
  `active` AFTER the allowlist check (`contacts.ts:1006-1008`). It defaults to
  `needs_review` instead.
- A list read `GET /api/contacts?type=unknown&status=active` becomes a 400
  like any other illegal pair (`contacts.ts:1125-1132`).
- The type-change "normalize an illegal status" fallback (`contacts.ts:1746-
  1760`) already maps an illegal status to unknown -> Needs review.

### D7. A type change from Inactive starts the new type's first step

Cameron (2026-10-23, reversing his first answer the same day): "If they're
inactive and you make them a type, then do what you would normally do to make
a tenant onboarding or a landlord interested, since those are the first
steps."

- Unchanged behavior, now stated for Inactive: a type change with no explicit
  status sends tenant -> Onboarding, landlord -> Interested, partner -> Active
  (`contacts.ts:1725-1729`); the caseworker conversion writes Active
  (`services/caseworkerConversion.ts:528-532`).
- team_member and unknown: the normalize fallback keeps the stored status when
  it is legal for the new type. Under D1, Inactive is legal for both, so an
  Inactive contact re-typed to team_member or unknown would STAY Inactive -
  against Cameron's "first steps" rule. Rule: a type change with no explicit
  status from an Inactive contact sends team_member -> Active and unknown ->
  Needs review. A status legal for the new type that is NOT Inactive keeps
  today's behavior (kept).

### D8. The unknown contact page

- The "Needs triage" card (`UnknownFile.tsx:100`) keeps its Mark as buttons
  for an Inactive unknown contact - staff still classify one when they learn
  who it is. Its title reads "Needs triage" only while the contact is Needs
  review; for an Inactive one it reads "Type unknown". The body copy is
  unchanged.

### D9. The inbox

- An Inactive contact's texts and calls show in the inbox like anyone
  else's, unread when unread. Its status stays Inactive (tracker Oct 18
  decision): no inbound writer moves a contact back to Needs review. The
  build proves this with a test (inbound text and inbound call to an
  existing Inactive unknown contact).
- The "Needs triage" chip on an inbox row (`needsTriage`, today keyed on
  role === 'unknown' at `routes/inbox.ts:1116, 1175, 1566`) is true only for
  an unknown contact whose status is Needs review (and for an unlinked
  unknown number, as today).
- An inbox row whose contact is Inactive carries a small muted "Inactive" tag
  (Cameron picked it 2026-10-23 for the Unknown tab). Per D4.3 it shows for an
  Inactive contact of any type, on any tab. The wire row gains the field that
  says so.
- Unknown tab order: the server's block order becomes Needs review, then
  Inactive (`UNKNOWN_QUEUE_STATUS_ORDER`; the Active block is removed). The
  dashboard currently re-sorts EVERY loaded row newest-first
  (`useInbox.ts:149-153, 718`), which hides the block order. On the Unknown
  tab only, the dashboard sorts the loaded rows Needs review first, then
  Inactive, each newest message first. Cameron: "let's not do sorting server-
  and database-side for now ... on the page that we load, it needs to be
  newest message first." Other tabs keep newest-first.
- An Unknown-tab "load more" cursor minted before the deploy may point at the
  removed Active block and 400 once; reloading the inbox recovers. Accepted:
  zero (unknown, active) contacts exist.

### D10. Whitespace and casing

No new free-text input. Status values are fixed keys; nothing to trim.

## 3. Out of scope

- Status filters on the Landlords, Caseworkers, Unknown and All views (filed:
  `docs/issues/contacts-status-filter-tenants-only.md`).
- Server/database-side activity ordering for the Unknown tab (existing issue
  `denormalize-contact-last-activity-for-ordered-paging`).
- Status checks on automatic texts (Cameron: leave as is, no issue).
- A Mark-inactive button on Today rows, and any Today reordering (#31).
- Removing `active` from partner or team_member.
- The importer's broader type-rule gap (existing issue
  `import-bypasses-contact-type-rules`).

## 4. Surfaces (write and read) - every one is a plan task or a watch item

Writers of contact `status`:
- `app/src/lib/statusModel.ts` - the lists, labels, `statusAllowlistFor`.
- `app/src/routes/contacts.ts` - create (explicit status + the unknown
  default), triage PATCH parse (union list), status-only PATCH, type-change
  auto-advance, normalize fallback (D7), list-read validation.
- `app/src/routes/statusTransition.ts` + `app/src/services/statusTransition.ts`
  - the transition route and plan (labels per type, D4.5).
- `app/src/services/caseworkerConversion.ts` - writes Active (unchanged, D7).
- `app/src/services/suggestionResolution.ts` - allowlist check (follows D1).
- `app/src/lib/import/apply.ts`, `status.ts`, `reviewNotes.ts` - per-type
  validation and the valid-status union.
- `app/src/services/contactCapture.ts`, `groupMembers.ts`, `groupConvert.ts`,
  `routes/public.ts` - create Needs review / Onboarding stubs (unchanged;
  watch item: none of them may touch an EXISTING contact's status, D9).
- Inbound text and call webhooks - watch item: must not reset status (D9).
- Seeds: `app/src/lib/seed/performance.ts` (unknown alternates needs_review /
  active -> needs_review / inactive), `history.ts` (`OTHER_LINEAR` and the
  non-tenant ladder; an Inactive non-tenant gets a trail), `cast.ts`,
  `lean.ts`, `live.ts`, `matrix.ts` (check only). The lean world must stay
  byte-stable for existing specs.

Readers of contact `status`:
- `app/src/lib/unknownQueue.ts` - status type, block order, blocks.
- `app/src/routes/inbox.ts` - Unknown-tab cursor decode, block walk,
  `needsTriage`, the new Inactive field on the wire row.
- `app/src/routes/today.ts` - the unknown 1:1 Needs you now row (D5).
- `app/src/lib/listingSendOutcome.ts` (+ `services/followUps.ts`,
  `routes/units.ts` consumers) - D4.1.
- `app/src/services/audienceResolution.ts` - unchanged (watch item).
- `app/src/jobs/extraction.ts` - passes status to the AI profile (watch item:
  the AI never proposes Inactive or Active for an unknown contact).
- `app/scripts/measure-unread-contact-coverage.ts` - reads (unknown,
  needs_review) (check only).

Dashboard:
- `dashboard/src/api/types.ts` - one shared per-type status list + labels
  module, mirrored from the backend with a mirror test (D3).
- `dashboard/src/routes/contact/ContactDetail.tsx` - header dropdown for every
  type (D2).
- `dashboard/src/routes/contact/ContactEditForm.tsx` - status options, type-
  change reset, save path (D3).
- `dashboard/src/routes/contact/format.ts` (`contactStatusLabel`),
  `dashboard/src/ui/StatusBadge.tsx` (tone), `dashboard/src/ui/StatusMenu.tsx`
  (generic, check only), `dashboard/src/routes/contact/Card.tsx` (status
  class), `dashboard/src/routes/contacts/ContactsList.tsx` (row status label).
- `UnknownFile.tsx` (D8), `PartnerFile.tsx`, `TenantFile.tsx` (team_member),
  `LandlordFile.tsx` - status display.
- `dashboard/src/routes/inbox/useInbox.ts`, `InboxRow.tsx`,
  `inboxListMerge.ts` - Unknown-tab sort, Inactive tag, triage chip (D9).

Docs:
- `documentation/STATUS-MODEL.md` - a new section for partner, team_member
  and unknown statuses, and the D4 meaning of Inactive.
- `documentation/GLOSSARY.md` - Inactive; the "waiting on a reply" entry
  states the tenant-only inactive rule (D4.1 changes it).
- `app/src/repos/contactsRepo.ts:118-131` - stale status comment.

## 5. Tests (behavior to prove; the plan names files)

1. Allowlists: each type's list is exactly D1; (unknown, active) is refused
   on every writer in D6; an unknown create with no status is Needs review.
2. Transition route accepts Inactive for partner, team_member and unknown and
   writes `status_source: 'manual'`, the audit event and a timeline entry with
   that type's label.
3. Type change from Inactive: to tenant -> Onboarding, landlord -> Interested,
   partner -> Active, caseworker conversion -> Active, team_member -> Active,
   unknown -> Needs review. From a non-Inactive legal status: unchanged.
4. Today: an unread unknown 1:1 thread from an Inactive unknown contact is
   NOT in Needs you now; from a Needs review one it is; an Inactive unknown is
   not in the Needs review list.
5. Inbox: an Inactive unknown's unread inbound shows on All, Unread and
   Unknown; `needsTriage` false, Inactive field set; Unknown tab blocks are
   Needs review then Inactive; an inbound text and an inbound call leave the
   status Inactive.
6. Follow up / listing-send: an Inactive caseworker is ineligible (the old pin
   flips); an Active caseworker is eligible.
7. Dashboard: header dropdown renders for partner, team_member and unknown
   with the D1 options and calls the transition route; the edit form's Status
   options equal the header's for every type; saving an Inactive caseworker
   keeps Inactive; the mirror test pins dashboard lists to backend lists; the
   Unknown-tab sort; the Inactive tag; the card title (D8).
8. e2e (accessibility-first selectors): from the contact page header, mark an
   unknown Needs review contact Inactive; it leaves Today's Needs review list,
   stays on the Contacts Unknown view, shows on the inbox Unknown tab below
   the Needs review rows with an Inactive tag; a new inbound text to it shows
   unread in the inbox and does not put it back on Today; its status is still
   Inactive. The spec builds its own state rather than adding a lean-seed
   contact, unless the plan shows that is impossible.

## 6. Rollout

- No Terraform, no new GSI, no backfill: the count is zero.
- Deploy is the human's call. After deploy, an open Unknown tab's "load more"
  may 400 once (D9).
- Tracker #30's Approach and Notes are updated after the spec is approved
  (Cameron approved the edit 2026-10-23).
