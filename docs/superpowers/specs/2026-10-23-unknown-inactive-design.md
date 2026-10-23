# Inactive for every contact type - design

Status: DRAFT revision 2 (2026-10-23).
- Rev 2 folds in design review round 1: two reviewers, 21 merged findings,
  19 accepted, 1 accepted as wording only, 1 kept as a watch item.
- Next: review round 2 (one continued reviewer), then Cameron's spec gate.

Adjudications:
`docs/superpowers/reviews/2026-10-23-unknown-inactive/design-review/adjudications.md`.
Branch: `feat/unknown-inactive` (worktree `W:\tmp\unknown-inactive`, cut from
main @916258ae).
Tracker: HousingChoice Improvements Tracker item #30 "Needs review to Inactive
without choosing a type" (Oct 16 check-in; Oct 18 decision), widened by
Cameron in the 2026-10-23 scoping conversation.
Review records: `docs/superpowers/reviews/2026-10-23-unknown-inactive/`.
intent.md holds Cameron's decisions verbatim.

Vocabulary: `partner` in code is a "caseworker" or "partner" in staff copy
(documentation/GLOSSARY.md). "Header dropdown" = the interactive status pill
in the contact page header (`StatusMenu`, `ContactDetail.tsx` ~1003-1028),
which today exists for tenants and landlords only. "Needs you now" is the
Today group where an untriaged unknown contact appears as a "New unknown
contact" row (`Today.tsx:38-44`); Sam calls those rows her Needs review list.

Coordination: tracker #31 (Today page as the daily checklist) is a separate
mission that reorders the Today page. As of 2026-10-23 it has no branch,
worktree or spec. This spec adds ONE skip rule to `app/src/routes/today.ts`
(D5) and does not reorder, rename or remove any Today section.

## 1. Goal

1. Staff can mark an unknown contact Inactive without giving it a type. It
   leaves Needs you now and stays a normal contact: on the Contacts list, in
   the inbox, with its threads. It is not deleted.
2. Every contact type has an inactive-type status. Cameron: "We do need to
   have some type of inactive status for all types of contact."
3. Every contact type moves through its statuses the same way: one header
   dropdown on the contact page, and the Edit contact details Status field
   offers exactly the same choices. Cameron: "We should have one consistent
   way to move people through statuses, no matter what their contact type
   is."
4. Inactive means the same thing for every type. Cameron: "if an unknown
   contact has the status inactive, I don't want to treat it differently than
   we're treating a different type of contact that has the same exact named
   status."

## 2. Decisions

### D1. The status lists

One `status` field per contact (unchanged); the legal values depend on the
type (`statusAllowlistFor`, `app/src/lib/statusModel.ts`).

| Type | Statuses (in dropdown order) | Change |
|---|---|---|
| tenant | Needs review, Onboarding, Searching, Placing, Placed, On hold, Inactive | none |
| landlord | Needs review, Interested, Onboarding, Active, Parked | none |
| partner (caseworker) | Needs review, Active, Inactive | adds Inactive |
| team_member | Needs review, Active, Inactive | adds Inactive |
| unknown | Needs review, Inactive | adds Inactive, REMOVES Active |

- The shared `NON_TENANT_STATUSES` splits in two: partner + team_member get
  `needs_review | active | inactive`; unknown gets its own
  `needs_review | inactive` list. `statusAllowlistFor` handles tenant,
  landlord and unknown explicitly and returns the partner/team_member list for
  any other type. It stays the single source of truth for every writer and
  reader.
- Parked is the landlord's OWN retired status (Cameron: "Landlord has parked,
  which is fine"). It behaves exactly as it does today. Every Inactive rule in
  this spec keys on the literal `inactive`, so none of them touches a Parked
  landlord.
- Removing Active from unknown: Cameron, "If we can just delete the active
  type for unknown contacts, then let's do that." The read-only count on
  2026-10-23 found ZERO (unknown, active) contacts on dev and on prod. See
  Rollout for the pre-deploy re-count.
- Labels: "Needs review", "Active", "Inactive" for the non-tenant lists, held
  in the status model next to the tenant and landlord label maps (no call
  site humanizes a key).

### D2. One header dropdown for every type

- The header dropdown appears for EVERY live contact type, listing that
  type's statuses from D1. Today it renders for tenant and landlord only and
  a display-only badge for the rest.
- A soft-deleted contact keeps the display-only badge (unchanged).
- It goes through the route the tenant and landlord dropdown already uses
  (`PATCH /api/contacts/:id/tenant-status`, which validates `toStatus`
  against the stored type's allowlist, `routes/statusTransition.ts:268-278`).
  No reason prompt: no header status change asks for one today.
- team_member renders the tenant-style page (`TenantFile`); its dropdown
  lists the team_member statuses, not the tenant ones.
- The route's write is conditioned on the stored type being unchanged since
  the check (today the check and the write are separate, so a concurrent
  re-type could store an illegal pair such as (landlord, inactive)). A
  mismatch is a 409 and writes nothing.
- A status change through the route notifies open Today and Inbox pages the
  same way a contact PATCH does today (the PATCH emits `conversation.updated`
  for linked threads, `contacts.ts:2081-2094`; the route emits nothing,
  `services/statusTransition.ts:605-637`). The plan picks the event; the
  observable rule is that an open Today page drops the row and an open Inbox
  page shows the new tag/chip without a reload.

### D3. The Edit contact details Status field matches the header

- The form's Status field lists exactly the D1 statuses for the contact's
  type. Cameron: "Anywhere that we would be able to choose one, we need to be
  able to choose all of them."
- The form stops keeping its own non-tenant list
  (`ContactEditForm.tsx:32-67, 132-142`). Today that list does not contain
  Inactive, so the form DISPLAYS an Inactive caseworker as Needs review (an
  untouched value is not sent, so the stored status survives a save - the bug
  is what staff see). The dashboard takes its per-type lists and labels from
  ONE shared module mirrored from the backend, with a mirror test pinning the
  two.
- On a type change in the form, the Status field moves to the NEW type's
  first step (tenant Onboarding, landlord Interested, partner Active,
  team_member Active, unknown Needs review - the same values D7 writes).
  Staff may pick another status before saving. Whatever the field shows is
  what is saved: the form sends it as an explicit status, which the server
  honors over its own default.
- Save paths:
  - tenant and landlord: unchanged (a landlord's park reason is PATCHed
    first and must not be overwritten by a later transition, see
    `services/statusTransition.ts:164`).
  - partner, team_member, unknown with NO type change: a status change goes
    through the transition route, as the header does, so both places write
    the same `status_source: 'manual'`, audit event and timeline entry.
  - any save that changes the type: unchanged path (the PATCH validates the
    status against the NEW type; a tenant target is followed by the existing
    `setTenantStatus` call).

### D4. What Inactive means - the same for every type

What an Inactive tenant gets today, and what this spec gives an Inactive
partner, team_member or unknown contact:

1. Not chased. `isEligibleRecipient` (`app/src/lib/listingSendOutcome.ts:112`)
   drops ANY contact whose status is `inactive`, whatever its type. Placed
   stays tenant-only (only tenants have it). This removes Inactive caseworkers
   from the Follow up worklist (`services/followUps.ts`) and the listing-send
   rows (`routes/units.ts`), where today they stay eligible; the test that
   pins that (`app/test/listingSendOutcome.test.ts:195-198`) flips.
2. Blasts: unchanged; they read Onboarding and Searching tenants only.
3. Shown as any other contact: Contacts list, inbox, search, threads.
4. The same muted status colour (today a non-tenant Inactive would fall back
   to neutral, `StatusBadge.tsx:117-121`).
5. The same timeline wording: a status change writes "Status -> <label>"
   using the label map of the type the contact HAS AFTER the write (on a
   retype, the new type). Today every non-landlord type uses the tenant map
   (`contacts.ts:2129-2139`, `services/statusTransition.ts:150-154`).

Two differences remain, on purpose:
- The Tenants view hides Inactive tenants by default; the other Contacts
  views have no status filter at all. Filed, out of scope:
  `docs/issues/contacts-status-filter-tenants-only.md`.
- An Inactive tenant's unread text shows in Today's Unreplied; an Inactive
  unknown contact's does not show in Needs you now (D5, Cameron's direction).
  Unreplied belongs to #31, which removes it.

Automatic texts are NOT changed (Cameron, 2026-10-23): tour reminders, group
text rosters, the missed-call auto-text, placement nudges and hand-picked
share recipients do not check status for any type today, Inactive tenants
included. No issue is filed.

### D5. Today: Needs you now

- The contacts triage pass already reads only (unknown, needs_review)
  (`today.ts:845-902`), so an Inactive unknown contact leaves it with no
  change there.
- The unread-thread source (`today.ts:704-800`) emits a "New unknown contact"
  row for an unread `unknown_1to1` thread. It SKIPS a thread whose contact's
  status is `inactive`. Cameron: "Needs You Now shows unread texts from any
  unknown contact that needs review. If it doesn't need review, meaning we've
  marked it as inactive, it wouldn't show there ... It just shows in the
  inbox."
- The skip runs in the COLLECT loop, beside the deleted-contact skip and
  ahead of the 100-row cap (`today.ts:711-752`), reusing the same memoized
  contact read. Placed at the emit site, Inactive threads that stay unread
  would fill the cap and empty Needs you now and Unreplied - the A9 defect
  that loop already fixed once for deleted contacts.
- The rule is "skip Inactive", not "keep only Needs review": team_member
  threads are also `unknown_1to1` (`contacts.ts:537-543`) and an Active team
  member keeps today's behavior. A thread whose contact cannot be resolved
  keeps today's behavior.
- The dashboard's Today fallback (`dashboard/src/routes/today/buildToday.ts:287`)
  applies the same rule if it builds that row.
- This is the ONLY Today change. Ordering, sections, Unreplied and the AI
  suggestions group are #31's.

### D6. (unknown, active) is refused everywhere

Every writer validates against D1, so `active` for an unknown contact is
refused on every path, each with its existing response shape:
- status-only PATCH, the transition route, and create with an explicit
  status: 400;
- AI status-suggestion accept: refused (today a non-tenant accept is a 409
  `suggestion_contact_not_tenant` before the allowlist check - unchanged);
- the import: falls back to Needs review with a warning, as it does for any
  status illegal for the type;
- list read `GET /api/contacts?type=unknown&status=active`: 400
  (`contacts.ts:1125-1132`).

Defaults:
- `POST /api/contacts` with no status defaults an unknown create to `active`
  AFTER the allowlist check (`contacts.ts:1006-1008`); it defaults to
  `needs_review`. The duplicate default in `unmatchedEmail.ts:455-466` does
  the same.
- The type-change normalize fallback (`contacts.ts:1746-1760`) already maps an
  illegal status to unknown -> Needs review.

### D7. A type change from Inactive starts the new type's first step

Cameron (2026-10-23, reversing his first answer the same day): "If they're
inactive and you make them a type, then do what you would normally do to make
a tenant onboarding or a landlord interested, since those are the first
steps."

- Unchanged behavior, now stated for Inactive: a type change with no explicit
  status sends tenant -> Onboarding, landlord -> Interested, partner -> Active
  (`contacts.ts:1725-1729`); the caseworker conversion writes Active
  (`services/caseworkerConversion.ts:528-532`).
- team_member and unknown (API-only targets: KindPicker offers neither): the
  normalize fallback keeps the stored status when it is legal for the new
  type, and under D1 Inactive is legal for both. Rule: a type change with no
  explicit status FROM Inactive sends team_member -> Active and unknown ->
  Needs review. Any other stored status keeps today's behavior. The fallback
  runs only when the type actually changes (newType !== stored.type), so a
  same-type PATCH never resets a status.
- The dashboard form always sends an explicit status on a type change (D3),
  so this rule governs API callers.

### D8. The unknown contact page

- The "Needs triage" card (`UnknownFile.tsx:100`) keeps its Mark as buttons
  for an Inactive unknown contact - staff still classify one when they learn
  who it is. Its title reads "Needs triage" only while the contact is Needs
  review; for an Inactive one it reads "Type unknown". Body copy unchanged.

### D9. The inbox

- An Inactive contact's texts and calls show in the inbox like anyone else's,
  unread when unread. Its status stays Inactive (tracker Oct 18 decision): no
  inbound writer moves an existing contact back to Needs review. The build
  proves this with a test (inbound text and inbound call to an existing
  Inactive unknown contact). AI extraction still runs on those inbounds
  (`jobs/extraction.ts:457`) and may file a suggestion, e.g. a type
  suggestion; that is not Needs review and is unchanged.
- The "Needs triage" chip (`needsTriage`, `routes/inbox.ts:1116, 1175, 1566`)
  keeps today's rule (role falls through to `unknown`, so team_member rows
  carry it too) EXCEPT that it is false for a contact whose status is
  `inactive`.
- An inbox row whose contact is Inactive carries a small muted "Inactive" tag
  (Cameron picked it 2026-10-23 for the Unknown tab). Per Goal 4 it shows for
  an Inactive contact of any type, on any tab. The wire row gains the field
  that says so.
- Unknown tab order. Server block order becomes Needs review, then Inactive
  (`UNKNOWN_QUEUE_STATUS_ORDER`; the Active block is removed). The dashboard
  re-sorts EVERY loaded row newest-first for every tab (`useInbox.ts:149-153,
  718`), so the operator never sees the block order. On the Unknown tab only,
  the dashboard sorts the loaded rows Needs review first, then Inactive, each
  newest message first. Other tabs keep newest-first.
- This SUPERSEDES the 2026-08-26 ruling recorded at `routes/inbox.ts:2282-2309`
  ("RULED 2026-08-26: LEAVE IT ... Do NOT 'fix' either side"), by Cameron on
  2026-10-23: "it should be ordered by needs review first and then by newest
  message" and "let's not do sorting server- and database-side for now ... on
  the page that we load, it needs to be newest message first ... we can do
  that browser-side." The build updates that comment and the matching one in
  `useInbox.ts`.
- Watch item: `unknown-queue-status-flip-duplicates-across-pages`. A
  needs_review -> inactive flip during a walk is now the common flip; on
  screen the dashboard drops already-loaded rows by rowKey on Load more
  (`inboxListMerge.ts:145-159`), but a flip can still skip a row across pages.
  The plan re-reads the issue's reopen trigger.
- An Unknown-tab "load more" cursor minted before the deploy may point at the
  removed Active block and 400 once; reloading the inbox recovers.

### D10. Whitespace and casing

No new free-text input. Status values are fixed keys; nothing to trim.

## 3. Out of scope

- Status filters on the Landlords, Caseworkers, Unknown and All views (filed:
  `docs/issues/contacts-status-filter-tenants-only.md`).
- Server/database-side activity ordering for the Unknown tab (existing issue
  `denormalize-contact-last-activity-for-ordered-paging`).
- Status checks on automatic texts (Cameron: leave as is, no issue).
- Suppressing AI extraction or AI suggestions for Inactive contacts.
- A Mark-inactive button on Today rows, and any Today reordering (#31).
- Removing `active` from partner or team_member.
- Any change to how Parked landlords behave.
- The importer's broader type-rule gap (existing issue
  `import-bypasses-contact-type-rules`).

## 4. Surfaces (write and read) - every one is a plan task or a watch item

Writers of contact `status`:
- `app/src/lib/statusModel.ts` - the lists, labels, `statusAllowlistFor`.
- `app/src/routes/contacts.ts` - create (explicit status + the unknown
  default), triage PATCH parse (union list), status-only PATCH, type-change
  auto-advance, normalize fallback (D7, incl. the same-type guard), list-read
  validation, timeline label (D4.5).
- `app/src/routes/unmatchedEmail.ts:455-466` - duplicate create default.
- `app/src/routes/statusTransition.ts` + `app/src/services/statusTransition.ts`
  - the route, the plan (labels per type, D4.5), the conditional write and
  the notify (D2).
- `app/src/services/caseworkerConversion.ts` - writes Active (unchanged, D7;
  label by new type).
- `app/src/services/suggestionResolution.ts` - allowlist check (follows D1).
- `app/src/lib/import/apply.ts`, `status.ts`, `reviewNotes.ts` - per-type
  validation and the valid-status union.
- `app/src/services/contactCapture.ts`, `groupMembers.ts`, `groupConvert.ts`,
  `routes/public.ts` - create stubs (unchanged; watch item: none touches an
  EXISTING contact's status, D9).
- Inbound text and call webhooks - watch item: must not reset status (D9).
- Seeds: `app/src/lib/seed/performance.ts` (unknown alternates needs_review /
  active -> needs_review / inactive), `history.ts` (`OTHER_LINEAR` and the
  non-tenant ladder; an Inactive non-tenant gets a trail), `cast.ts`,
  `lean.ts`, `live.ts`, `matrix.ts` (check only). The lean world stays
  byte-stable for existing specs.
- Test fakes: `app/test/helpers/contactsPartitionFake.ts:53-60`.

Readers of contact `status`:
- `app/src/lib/unknownQueue.ts` - status type, block order, blocks.
- `app/src/routes/inbox.ts` - Unknown-tab cursor decode, block walk,
  `needsTriage`, the new Inactive field on the wire row, the superseded
  ruling comment.
- `app/src/routes/today.ts` - the collect-loop skip (D5).
- `dashboard/src/routes/today/buildToday.ts:287` - fallback (D5).
- `app/src/lib/listingSendOutcome.ts` (+ `services/followUps.ts`,
  `routes/units.ts` consumers) - D4.1.
- `app/src/services/audienceResolution.ts` - unchanged (watch item).
- `app/src/jobs/extraction.ts` - passes status to the AI profile (watch item:
  the AI never proposes Active for an unknown contact; suggestions it files
  are unchanged).
- `app/scripts/measure-unread-contact-coverage.ts` - reads (unknown,
  needs_review) (check only).

Dashboard:
- `dashboard/src/api/types.ts` - one shared per-type status list + labels
  module, mirrored from the backend with a mirror test (D3).
- `dashboard/src/routes/contact/ContactDetail.tsx` - header dropdown for every
  type (D2).
- `dashboard/src/routes/contact/ContactEditForm.tsx` - status options, the
  type-change default (D3), save paths.
- `dashboard/src/routes/contact/format.ts` (`contactStatusLabel`),
  `dashboard/src/ui/StatusBadge.tsx` (tone), `dashboard/src/ui/StatusMenu.tsx`
  (generic, check only), `dashboard/src/routes/contact/Card.tsx` (status
  class), `dashboard/src/routes/contacts/ContactsList.tsx` (row status label).
- `UnknownFile.tsx` (D8), `PartnerFile.tsx`, `TenantFile.tsx` (team_member),
  `LandlordFile.tsx` - status display.
- `dashboard/src/routes/inbox/useInbox.ts`, `InboxRow.tsx`,
  `inboxListMerge.ts` - Unknown-tab sort, Inactive tag, triage chip (D9).
- Today and Inbox SSE refetch triggers - must fire on the D2 notify.

Docs:
- `documentation/STATUS-MODEL.md` - a new section for partner, team_member
  and unknown statuses, and the D4 meaning of Inactive.
- `documentation/GLOSSARY.md` - Inactive; the "waiting on a reply" entry
  states the tenant-only inactive rule (D4.1 changes it).
- `app/src/repos/contactsRepo.ts:118-131` - stale status comment.

## 5. Tests (behavior to prove; the plan names files)

1. Allowlists: each type's list is exactly D1; (unknown, active) is refused on
   every path in D6 with that path's response; an unknown create with no
   status (both create paths) is Needs review.
2. Transition route: accepts Inactive for partner, team_member and unknown,
   writes `status_source: 'manual'`, the audit event and a timeline entry with
   that type's label; a concurrent re-type between check and write yields a
   409 and no write; the change notifies open Today/Inbox.
3. Type change from Inactive with no explicit status: tenant -> Onboarding,
   landlord -> Interested, partner -> Active, caseworker conversion -> Active,
   team_member -> Active, unknown -> Needs review. From a non-Inactive legal
   status: unchanged. Same-type PATCH: status unchanged. Timeline label uses
   the new type.
4. Today: an unread unknown_1to1 thread from an Inactive unknown contact is
   NOT in Needs you now; from a Needs review one it is; from an Active team
   member it is (unchanged); 100+ unread Inactive threads ahead of a live one
   do not hide the live one.
5. Inbox: an Inactive unknown's unread inbound shows on All, Unread and
   Unknown; `needsTriage` false; Inactive field set (also for an Inactive
   tenant and caseworker); Unknown-tab blocks are Needs review then Inactive;
   an inbound text and an inbound call leave the status Inactive.
6. Follow up / listing-send: an Inactive caseworker is ineligible (the old pin
   flips); an Active caseworker is eligible; a Parked landlord's behavior is
   unchanged.
7. Dashboard: header dropdown renders for partner, team_member and unknown
   with the D1 options and calls the transition route; the edit form's Status
   options equal the header's for every type; the form DISPLAYS an Inactive
   caseworker as Inactive, and changing another field and saving keeps
   Inactive; on a type change the field shows the new type's first step and
   that value is what is sent; a landlord park reason survives an edit-form
   save; the mirror test pins dashboard lists to backend lists; the
   Unknown-tab sort; the Inactive tag; the card title (D8).
8. e2e (accessibility-first selectors): from the contact page header, mark an
   unknown Needs review contact Inactive; it leaves Needs you now, stays on
   the Contacts Unknown view, shows on the inbox Unknown tab below the Needs
   review rows with an Inactive tag; a new inbound text to it shows unread in
   the inbox and does not put it back in Needs you now; its status is still
   Inactive. The spec builds its own state rather than adding a lean-seed
   contact, unless the plan shows that is impossible.

## 6. Rollout

- No Terraform, no new GSI.
- Just before deploy, re-run the read-only count of (unknown, active) on dev
  and prod (it was 0 / 0 on 2026-10-23). Staff can still create one from the
  edit form until the deploy lands, and after it such a contact would drop
  off the Unknown tab. Any found are moved to Needs review only on Cameron's
  explicit go.
- Deploy is the human's call. After deploy, an open Unknown tab's "load more"
  may 400 once (D9).
- Tracker #30's Approach and Notes are updated after the spec is approved
  (Cameron approved the edit 2026-10-23).
