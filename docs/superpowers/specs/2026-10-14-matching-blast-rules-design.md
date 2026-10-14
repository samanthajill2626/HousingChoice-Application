# Matching blasts follow the audience rules - design

Status: DRAFT revision 1 (2026-10-14), awaiting design review.
Branch: `feat/matching-blast-rules` (worktree `W:\tmp\matching-blast-rules`, cut from main @a2b3d80d)
Tracker: Improvements Tracker item #6 "Matching (blasts): housing authority and status" (Before WP1, item 5)
Review records: `docs/superpowers/reviews/2026-10-14-matching-blast-rules/`

## 1. Goal

A Matching blast (a property sent from the Matching page to tenants found by
the audience filters) should reach the tenants Sam would actually send it to,
and no one else by default:

1. only tenants in Onboarding or Searching;
2. not, by default, tenants who have an unresolved tour for ANY property
   (an upcoming tour, a past tour with no outcome, a no-show, a tour
   waiting on its placement, or a tour request with no date that is less
   than 14 days old);
3. housing authority filled in from the property, which can accept several
   housing authorities;
4. only Available properties offered in the property picker.

A tenant picked by hand always gets the property. A tour never stops staff
from sending a property to a tenant; it only keeps the tenant from being
added to a blast automatically. Tracker #27's "Not interested" already works
this way (listed, unchecked, labeled), and the tour rule joins it as the same
mechanism.

Caseworkers are never included in a blast automatically because they are
caseworkers; staff send them a property directly from their own page.

## 2. Today (verified 2026-10-14 on main @a2b3d80d)

Server (`app/src/routes/broadcasts.ts`, `app/src/services/audienceResolution.ts`):

- `AudienceFilter` (`app/src/repos/broadcastsRepo.ts:84-90`) holds
  `contact_type: 'tenant'`, an optional ONE-string `housing_authority`, an
  optional `bedroomSize`, and the opt-out / unreachable booleans. It is
  stored as given on the draft (`broadcastsRepo.ts:729`). Nothing ever
  rewrites a stored broadcast filter: no script, backfill, import or
  organization rename touches broadcasts (`app/scripts/clean-org-names.ts:29`,
  `broadcasts.ts:28`).
- `parseAudienceFilter` (`broadcasts.ts:140-171`) is the only validator; it
  requires `housing_authority`, when present, to be a non-empty string.
- POST `/api/broadcasts` (`broadcasts.ts:572-705`) checks the housing
  authority against the organization list with `orgNames.checkScalar`
  (`:642-650`; a unique spelling is stored as the entry's exact name; else
  422 `org_not_on_list`, field `audience_filter`), estimates the audience
  (`:653-667`) and answers `estimatedCount` and the stored `audience_filter`.
- `storedFilterRefusal` (`:547-567`) re-checks a stored housing authority at
  preview of a draft (`:729-736`) and in send path (c) (`:985-990`): it must
  be EXACTLY a listed name, else 422 naming its one entry as the candidate.
- The audience resolver (`audienceResolution.ts:123-191`) reads candidates
  from the `byHousingAuthority` GSI (one exact value) when an authority is
  set, else from `byTypeStatus` with `type = 'tenant'` and NO status
  condition. It fences type `tenant`, opt-out, unreachable, missing phone and
  exact `voucherSize`. It never checks tenant status. The bounded walk on
  `byTypeStatus` ascends the status range key, so a cut drops `searching`
  tenants first (`docs/issues/broadcast-audience-truncation-drops-searching-tenants.md`).
  `audienceResolution.ts:135` is the ONLY runtime caller of
  `listByHousingAuthority`.
- Preview (`broadcasts.ts:717-841`) unions the filter rows with the draft's
  hand-picked seeds (`resolveSeeds`, `:496-534`, tenant OR partner), flags
  each candidate `alreadySentThisProperty`, `seeded`,
  `declinedThisProperty`, and returns `declinedContactIds`. The #27 decline
  read (`effectiveDeclines`, `:462-489`) is caught and turned into
  `declineLabelsUnavailable: true` with no labels (`:773-782`).
- Send (`broadcasts.ts:856-1065`) has three paths: (a) an explicit
  `recipientContactIds` list, re-fenced for type tenant-or-partner, opt-out,
  unreachable and phone only - no decline, status or tour fence; (b) a
  `seeds_only` draft with no body; (c) a filter draft with no body, which
  re-resolves the filter. The dashboard ALWAYS uses (a)
  (`dashboard/src/api/endpoints.ts:2024-2031`, `RecipientPreview.tsx:368-370`);
  (b) and (c) are reached only through the API (e2e
  `a2p-compliance.spec.ts:445-510`). Every path refuses a property that is
  not Available (`:879-885`).
- Tenant statuses: `needs_review, onboarding, searching, placing, placed,
  on_hold, inactive` (`app/src/lib/statusModel.ts:140-148`). POST
  `/api/contacts` defaults a new tenant to `onboarding`
  (`app/src/routes/contacts.ts:962-964`).
- A filter-resolved audience is tenants only; partners (caseworkers) join a
  share only as a seed or an explicitly checked recipient
  (`isDirectShareRecipientType`, `broadcasts.ts:352-361`).

Tours (`app/src/repos/toursRepo.ts`, `app/src/lib/toursModel.ts`):

- Statuses `requested, scheduled, toured, no_show, canceled, closed`;
  outcomes `move_forward, not_a_fit, no_outcome`. A `requested` tour has no
  `scheduledAt`. Tours have no soft delete.
- The `byStatus` GSI is hash `status`, range `createdAt`
  (`app/src/lib/tables.ts:546-550`). `listByStatus(status)`
  (`toursRepo.ts:436-455`) walks every page with no cap and takes no range
  condition.
- The server never closes a tour on Not a fit: PATCH writes the outcome and
  `convertible = (moveForward === true)` and leaves status `toured`
  (`app/src/routes/tours.ts:1296-1327`); the dashboard's Record outcome adds
  `status: 'closed'` for Not a fit only (`TourDetail.tsx:597-601`). Move
  forward leaves the tour `toured` with `convertible: true`; conversion
  (`placements.ts:642-782`) writes a `pending:<uuid>` claim into
  `convertedPlacementId`, then sets `status: 'closed'` and the real id, and
  moves the tenant to `placing` (best effort, `placements.ts:909-915`).
  A failed conversion releases the claim ("Needs placement").
- The two-week auto-close (`app/src/jobs/tourAutoClose.ts`, every 15 minutes,
  `worker.ts:569-573`) reads the `scheduled`, `toured` and `no_show`
  partitions to the end with `listByStatus` on every run (`:72-79`). It never
  closes `requested`, so that partition only grows. It exempts a tour
  waiting on its placement.
- New tours (since 2026-10-12) are tenant-only (`requireTenantContact`,
  `app/src/services/contactTypeGuards.ts:66-77`); older tours were not swept,
  so a tour's `tenantId` may name a non-tenant contact.

Dashboard (`dashboard/src/routes/broadcasts/`):

- The property step lists every non-deleted unit with its status label
  (`BroadcastComposer.tsx:190-199`, `:449-467`; `UnitSearchField` has no
  status option). A non-Available property shows a banner (`:347-354`) and
  Send opens "Make Available & send" (`RecipientPreview.tsx:343-358`,
  `:682-715`). The property page's "+ Send" (`ListingDetail.tsx:425`)
  preselects the property with `?unitId=` and skips the picker.
- `AudienceFilters.tsx` holds voucher-size chips and a SINGLE-select
  `OrgPicker` labeled "Housing authority" (`:144-162`). Only voucher size is
  prefilled from the property, with its first size
  (`BroadcastComposer.tsx:261-272`); the prefill writes only while the size
  is undefined, and changing the property does not re-apply it. The housing
  authority is never prefilled. `OrgPicker` already supports
  `multiple: true` (`dashboard/src/routes/orgs/OrgPicker.tsx:101-114`), used
  by the property forms as "Housing authorities".
- A 422 `org_not_on_list` clears the authority pick and shows a notice
  (`BroadcastComposer.tsx:129-137`, `:368-371`; `useComposerDraft.ts:223-237`).
  The draft key covers the authority (`useComposerDraft.ts:87-100`).
- `AudienceFilters.tsx:179-195` shows "Reaches N recipients" from the
  draft's `estimatedCount`.
- `RecipientPreview.tsx`: a row starts checked when
  `hasConsent && (seeded || (!alreadySent && !declined))` (`:99-101`);
  Select all re-applies that (`:243-245`); declined rows carry a
  "Not interested" tag (`:582`), amber row styling (`:528`) and a checkbox
  name suffix (`:105-111`). Add a tenant (tenant-only search, `:604`)
  annotates the option and adds the row checked and seeded (`:257-336`,
  `:437-438`). Rows are ordered by last heard from (`:194-206`).
- Stored filters are summarized as text by `audienceSummary`
  (`dashboard/src/routes/broadcasts/broadcastFormat.ts:61-68`) on the
  broadcasts list and results header.

## 3. Decisions

### D1 Status: Onboarding and Searching only

A FILTER-resolved audience holds tenants whose `status` is `searching` or
`onboarding`, nothing else. The resolver reads exactly those two
`byTypeStatus` partitions (`type = 'tenant'` AND `status = <value>`, which
`contactsRepo.listByType` already supports with `opts.status`), `searching`
FIRST, then `onboarding`, under the existing page bound and truncation flag.
The `byHousingAuthority` branch is removed from the resolver; the housing
authority becomes an in-memory filter (D2). Every other fence (type tenant,
opt-out, unreachable, phone, voucher size, soft-deleted contacts hidden by
`listByType`) is unchanged.

Status-excluded tenants are NOT listed in the recipient review. The filters
area shows one fixed line while filters are on (D8).

Hand-picked recipients (seeds, Add a tenant) keep any status.

### D2 Housing authority: a list, any-of

`AudienceFilter` gains `housing_authorities?: string[]`. A tenant matches
when its `housingAuthority` (trimmed) equals any member. An absent or empty
list means no housing authority filter (every authority, as today with no
authority). A tenant with no housing authority matches only the empty list
(unchanged).

- POST `/api/broadcasts` accepts `audience_filter.housing_authorities`: an
  array of strings, at most 25 members, else 400
  `audience_filter.housing_authorities must be an array of at most 25
  strings`. Members are checked with the existing list check
  (`orgNames.checkList('audience_filter', list, undefined, undefined)`,
  `app/src/lib/orgNames.ts:302-326`): trimmed, blanks dropped, de-duplicated,
  a unique spelling stored as the entry's exact name, and the FIRST failing
  member answered as today's 422 `org_not_on_list` body with field
  `audience_filter` and `text` set to that member. The stored draft carries
  `housing_authorities` and never `housing_authority`. The 201 echoes the
  stored filter.
- LEGACY body: `audience_filter.housing_authority` (a string) is still
  accepted when `housing_authorities` is absent and is treated as a
  one-member list. Both present is a 400. (Old open dashboard tabs and API
  clients keep working through a deploy.)
- LEGACY storage: a stored draft or historical broadcast with the old
  `housing_authority` string is read everywhere through ONE normalizer
  (`authoritiesOfFilter(filter): string[]`, server; a dashboard twin): the
  list when present, else the old string as a one-member list, else `[]`.
- `storedFilterRefusal` checks EVERY member of the normalized list for an
  exact listed name, in order, and answers the 422 for the first that is
  not (today's body, candidate = its entry when the text is a spelling of
  one).
- The resolver, the preview, send path (c), the results and list
  projections, and `audienceSummary` all read through the normalizer.

### D3 Prefill from the property

When the composer has a property and the filters are on, the housing
authority picker is filled with the property's accepted authorities
(`authoritiesOf(unit)`, `dashboard/src/routes/listing/listingFormat.ts:63-71`)
that are EXACT names of housing authority entries on the organization list,
in the property's order. Off-list names are not put in the filter (the
server would refuse the draft); the picker shows one note under it:
"Not used (not on the organization list): <names, comma separated>".

The picker becomes `OrgPicker multiple`, labeled "Housing authorities".
Staff can remove any prefilled member or add others.

The prefill FOLLOWS THE PROPERTY until staff edit that filter: choosing or
changing the property re-applies the authority prefill (and the voucher
size prefill, D3a) unless staff have edited that filter since the last
prefill. An edit is any pick, removal or clear made by staff. Value and
ownership are kept together and checked in the functional state update
(the lesson in `docs/issues/broadcast-composer-prefill-overwrites-edit.md`).

D3a. Voucher size keeps its current prefill value (the property's first
accepted size) but gets the same follow-the-property rule, because the
current effect never re-applies after a property change
(`BroadcastComposer.tsx:261-272`, `:333-342`). Making voucher size a list
is NOT part of this change (tracker #12).

When a 422 `org_not_on_list` names a member (draft create or preview),
the composer removes THAT member only, keeps the others, and shows the
existing notice naming it (`BroadcastComposer.tsx:60-61` copy).

### D4 Tour holds

A tenant is HELD (left unchecked by default) while they have at least one
tour, for ANY property, that is unresolved. The rule is a pure function of
the tour and `now`, shared by preview and send path (c):

| Tour | Hold kind | Date shown (`at`) |
|---|---|---|
| `scheduled`, `scheduledAt` later than now | `upcoming` | scheduledAt |
| `scheduled`, `scheduledAt` now or earlier, or missing | `not_marked` | scheduledAt (if any) |
| `toured` with `convertible === true` (Move forward, placement not created or a conversion claim in flight) | `needs_placement` | scheduledAt (if any) |
| `toured` with no `outcome` (and not convertible) | `needs_outcome` | scheduledAt (if any) |
| `no_show` | `no_show` | scheduledAt (if any) |
| `requested` created less than 14 days (336 hours) before now | `requested` | createdAt |
| anything else: `canceled`, `closed` (any reason), `toured` with an outcome and not convertible, `requested` 14 days old or older | no hold | - |

- `needs_placement` follows Cameron's ruling (2026-10-14): a Move forward
  tour counts as a placement for this purpose. Once it converts, the tour is
  `closed` and the tenant is `placing`, so D1 leaves them out instead.
- `requested`: the 14 days are measured from the request's `createdAt`. A
  request that is never booked stops holding after 14 days, so it can never
  keep a tenant out forever.
- When a tenant has several unresolved tours, ONE is shown, by kind order
  `needs_placement, upcoming, needs_outcome, not_marked, no_show,
  requested`; within `upcoming` the earliest `scheduledAt`, within the
  others the latest date; ties by `tourId`.
- The hold is keyed on the tour's `tenantId` with no assumption about the
  contact's type (older tours may name a non-tenant).
- A held tenant matched by the filters is LISTED in the recipient review,
  UNCHECKED, with a reason label (D7). Select all skips them. Staff may check
  them; nothing stops the send.
- A hand-picked tenant (a seed from the contact page, or Add a tenant) is
  never held: the row starts checked and still shows the label.
- A tenant marked Interested on #27 gets a tour request, so they are held
  from every other property's blasts for up to 14 days, or until the booked
  tour resolves (Cameron 2026-10-14: intended).

### D5 Where the rules run: the preview, once, on the server

The preview computes holds for every candidate (filter rows AND seeds) and
returns them; the dashboard only renders them. The send ships exactly the
list staff reviewed (path (a)), so preview and send cannot disagree.

Read: ONE read of open tours per preview, independent of audience size:
the `byStatus` partitions `scheduled`, `toured` and `no_show` to the end
(the same reads the auto-close sweep does every 15 minutes), plus
`requested` with the key condition `createdAt >= now - 14 days` (the range
key bounds the only partition that never closes). Group by `tenantId` in
memory. The read must know when it is incomplete (a page cap hit counts as
a failed read). At today's volume this is a handful of small Query pages:
open tours are kept short by the two-week auto-close, and the request read
covers two weeks.

FAIL CLOSED: if the open-tours read or the #27 decline read fails or is
incomplete, preview answers 503 `{ error: 'audience_rules_unavailable' }`
and serves no list. The #27 `declineLabelsUnavailable` degrade is REMOVED:
both reads now decide who is checked by default, so serving a list without
them would check people the rules leave out. This applies to every preview,
including a seeds-only draft.

### D6 Send paths

- (a) Explicit list (the dashboard): UNCHANGED. No status, tour or decline
  fence; a checked row is staff's decision. The existing hard fences (type
  tenant-or-partner, opt-out, unreachable, phone, Available property) stay.
- (b) `seeds_only` with no body: UNCHANGED (hand-picks skip the rules).
- (c) Filter draft with no body (API only): the recipients are the D1/D2
  audience MINUS held tenants (D4, evaluated at send time) MINUS effective
  #27 declines, i.e. exactly the rows the preview would check by default
  (seeds are not part of path (c) today and stay out). A failed or
  incomplete rules read answers 503 `audience_rules_unavailable` and leaves
  the draft a draft. An audience left empty answers today's 400
  `empty_audience`. The truncation and cap refusals are unchanged.

### D7 Recipient review (dashboard)

- Preview response, per candidate: `tourHold?: { kind, tourId, at? }`
  (`at` an ISO string, absent when the tour has no date). Top level:
  `tourHolds: Array<{ contactId, kind, tourId, at? }>` for EVERY held
  contact (the analog of `declinedContactIds`, so Add a tenant can label a
  tenant outside the candidates). `declineLabelsUnavailable` is removed.
- Row default: checked when
  `hasConsent && (seeded || (!alreadySent && !declined && !tourHold))`.
  Select all uses the same rule.
- Label (a tag beside Not interested, same amber style, row gets the same
  amber row class). Dates use the dashboard's existing browser-local short
  date (`shortDate`, `dashboard/src/routes/placements/placementsFormat.ts:114`,
  "Oct 20"); with no date the date part is dropped:
  - `upcoming`: "Tour Oct 20"
  - `not_marked`: "Tour Oct 9, not marked"
  - `needs_outcome`: "Toured Oct 9, needs outcome"
  - `needs_placement`: "Toured Oct 9, needs placement"
  - `no_show`: "No show Oct 9"
  - `requested`: "Tour requested Oct 12"
- The checkbox's accessible name lists every reason, joined (consent,
  already sent, not interested, the tour label), instead of today's
  hand-enumerated combinations.
- Add a tenant: the option note shows the tour label after "Not interested"
  and "Already sent" when they apply; the added row starts checked (hand
  pick) and carries the label.
- The existing note "Flagged recipients you picked stay checked; "Select
  all" skips the others." stays as is.
- A 503 `audience_rules_unavailable` keeps staff on the compose step with
  "Couldn't check tours and Not interested replies, so the recipient list
  can't be shown yet." and a "Try again" button that re-runs the preview.

### D8 Filters area caption

While the filters are on, under the filters: "Only tenants in Onboarding or
Searching are included. Add anyone else by hand when you review
recipients." The "Reaches N recipients" line keeps its meaning (every
filter match plus seeds, before holds, declines and already-sent are
unchecked); it is not changed by this work.

### D9 Property picker: Available only

The composer's property list and its search offer only properties with
status `available`. With none, the empty state reads "No Available
properties. A property must be Available to send." A property preselected
by `?unitId=` (the property page's "+ Send") is kept whatever its status,
with today's banner and Make Available dialog, so that recovery path is
unchanged.

### D10 Caseworkers

Caseworkers (contact type `partner`) are never part of a filter-resolved
audience, whatever their status or housing authority. This is today's
behavior (the resolver's type fence); this change keeps it and pins it with
tests. A caseworker gets a property only when staff send it directly from
the caseworker's page (a seeds-only draft). Letting Add a tenant find
caseworkers is deferred
(`docs/issues/matching-add-recipient-search-caseworkers.md`).

## 4. Consequences to know

- A tenant in Needs review, Placing, Placed, On hold or Inactive no longer
  appears in a filtered blast. A `/join` lead now starts as Onboarding
  (tracker #14), so new fair leads are included.
- The "Reaches N recipients" count can be larger than the number checked on
  the review step (it always could, with declined and already-sent rows).
- The resolver no longer reads unwanted statuses, so the truncation issue's
  status-order cut no longer drops wanted tenants in favor of unwanted ones.
  Resolve `broadcast-audience-truncation-drops-searching-tenants` with that
  note (the bound and the truncation refusal remain; within the wanted set
  the read order is searching first).
- The `byHousingAuthority` GSI loses its only runtime caller. Removing it is
  an infrastructure change (Terraform) and is NOT done here; file a low
  `debt` issue.
- A failed tours or decline read now blocks the preview (with Try again)
  instead of showing a list without Not interested labels.
- A direct send from a tenant's page to a tenant with a tour shows the tour
  label but the row stays checked.

## 5. Out of scope

- Voucher size as a list, and the "4+" exact-match issue
  (`broadcast-4plus-exact-match-underreach`) - tracker #12.
- Add a tenant finding caseworkers (filed, deferred).
- Dropping the `byHousingAuthority` GSI (infrastructure).
- Server-side closing of a Not a fit tour (`tour-outcome-close-not-backend-enforced`).
- Tour date time zone (`tour-times-assume-org-timezone`): the labels use
  the same browser-local dates as every other tour date.
- Restoring a stored filter into the composer when a draft is resumed
  (`matching-draft-resume-seed-rehydration`).
- Any change to what the property page, Sent to list or Follow up tab show.

## 6. Testing

Unit (app):

- The hold rule: every row of the D4 table, the boundaries (scheduled at
  exactly now is `not_marked`; a request exactly 336 hours old holds no
  more), a pending conversion claim, several tours (the kind order and the
  tie-breaks), a tour on a non-tenant contact.
- The resolver: only `searching` and `onboarding` tenants; searching read
  first; any-of authority list; empty list = all; legacy string; a partner
  with a matching authority and any status never resolves; the existing
  fences.
- POST create: list accepted and stored as names; spelling resolved; the
  first off-list member's 422; more than 25 members 400; legacy string
  stored as a one-member list; both keys 400.
- Preview: holds per candidate and `tourHolds`; seeds carry holds but the
  flags are only data; 503 on a failed or incomplete tours read and on a
  failed decline read; legacy stored filter previews; `storedFilterRefusal`
  over a list.
- Send (c): held and declined tenants excluded; 503 on a failed read; empty
  after exclusion is 400.
- The open-tours read: the `requested` key condition and incompleteness.

Unit (dashboard): default checked state with holds; labels for every kind
with and without a date; the joined accessible name; Add a tenant
annotation; the 503 Try again; the caption; the multi picker prefill (on-list
only, off-list note, follow-the-property, edit ownership, a 422 removing one
member); the picker listing only Available properties and the empty state;
`audienceSummary` for a list and for the legacy string.

e2e (new spec): one property accepting two listed authorities; tenants:
Searching in authority A, Onboarding in authority B, Placing in A, Searching
in A with an upcoming tour, Searching in A with a 3-day-old tour request,
Searching in A whose only tour is closed Not a fit. Assert: both authorities
prefilled; the caption; the Placing tenant absent; the two held tenants
listed unchecked with their labels; Select all leaves them unchecked; the
picker lists only Available properties; Add a tenant adds the Placing tenant
checked; the send reaches exactly the checked tenants (outbox).

## 7. Places the build must also update

Server:

- `app/src/repos/broadcastsRepo.ts:84-90` (type), `broadcasts.ts`
  `parseAudienceFilter`, POST create (list check), `storedFilterRefusal`,
  preview, send path (c), results (`:393`) and list (`:421`) projections,
  the router header comment (`:6-28`), the audience-too-large message that
  names "the housing authority" filter (`:1010-1012`).
- `audienceResolution.ts` (whole read; header comment; the truncation TODO;
  the `byHousingAuthority` log field).
- `toursRepo.ts`: the open-tours read (range condition, completeness).
- Seeds: `app/src/lib/seed/matrix.ts:1224-1230`, `:1257-1263` (full profile,
  legacy string filters) - keep ONE legacy-shape broadcast so the full world
  exercises the normalizer, move the other to the list shape.
- Comments naming `byHousingAuthority` as the broadcast key:
  `contacts.ts:650`, `dev.ts:1263`, `lib/import/apply.ts:1208`,
  `lib/seed/lean.ts:109`.

Dashboard:

- `api/types.ts` (`AudienceFilter` `:3269-3275`, `PreviewCandidate`
  `:3461-3485`, `PreviewResponse` `:3498-3512`, comments at `:2273`,
  `:3271`), `endpoints.ts` `createBroadcast`, `useComposerDraft.ts` (draft
  key, create body, 422 handling), `AudienceFilters.tsx` (multi picker,
  caption, the comment at `:102-105` about a removed audience line),
  `BroadcastComposer.tsx` (prefill, picker list, 422 removal of one member,
  503 Try again), `RecipientPreview.tsx` (row model, defaults, tags,
  accessible name, Add a tenant, remove the decline-unavailable notice),
  `broadcastFormat.ts` `audienceSummary`.

Tests that pin today's shape or behavior and must change (from the
inventory): `app/test/audienceResolution.test.ts` (its `tenant()` helper
defaults to status `active`, so most cases resolve nothing under D1),
`app/test/broadcastApi.test.ts` (string filters and the "does NOT filter on
status" comment at `:62-64`), `app/test/seedOrgNames.test.ts:86-87`,
`:143-145`, dashboard `AudienceFilters.test.tsx`, `BroadcastComposer.test.tsx`,
`RecipientPreview.test.tsx:982-988`, `broadcastFormat.test.ts:31`; e2e
`broadcasts.spec.ts:167-175` (the lean seed's Tasha is `placing` and was
expected as a filter row), `org-lists.spec.ts` (`draftAuthority` reads a
string; the "Housing authority" label), `matching-entry-points.spec.ts:290,325`
(label), `a2p-compliance.spec.ts:480` (sends the legacy string - keep it as
legacy coverage).

Docs: `documentation/GLOSSARY.md` (the Matching entry gains "left out of a
blast: status and tour holds"; the `byHousingAuthority` line at `:322`),
`RUNBOOK.md:1457`, the issue registry (resolve the truncation issue, file
the GSI debt issue).
