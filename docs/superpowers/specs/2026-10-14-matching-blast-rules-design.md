# Matching blasts follow the audience rules - design

Status: DRAFT revision 2 (2026-10-14) - round 1 review folded in, plus two
rulings by Cameron (tenants with no housing authority; the reach count).
Review history: `docs/superpowers/reviews/2026-10-14-matching-blast-rules/design-review/adjudications.md`.
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
4. only Available properties offered in the property picker;
5. the "Reaches N recipients" count equal to the number of recipients that
   start checked.

A tenant picked by hand always gets the property. A tour never stops staff
from sending a property to a tenant; it only keeps the tenant from being
added to a blast automatically. Tracker #27's "Not interested" already works
this way (listed, unchecked, labeled), and the tour rule joins it as the same
mechanism.

Caseworkers are never included in a blast automatically because they are
caseworkers; they join a send only when staff pick them.

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
  422 `org_not_on_list`, field `audience_filter`), estimates the audience as
  the filter matches plus seeds (`:653-667`), stores the estimate as
  `estimatedAudience`, and answers `estimatedCount` and the stored
  `audience_filter`. The composer shows it as "Reaches N recipients"
  (`useComposerDraft.ts:213`, `AudienceFilters.tsx:179-195`).
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
  `a2p-compliance.spec.ts:445-510`, which asserts a no-consent recipient is
  counted `skipped_no_consent` through path (c)). Every path refuses a
  property that is not Available (`:879-885`). Path (c) does not subtract
  already-sent tenants.
- Tenant statuses: `needs_review, onboarding, searching, placing, placed,
  on_hold, inactive` (`app/src/lib/statusModel.ts:140-148`). POST
  `/api/contacts` defaults a new tenant to `onboarding`
  (`app/src/routes/contacts.ts:962-964`) and ignores `housingAuthority`
  (set by PATCH).
- A `/join` sign-up starts Onboarding with the housing authority picked on
  the form, or none when "Not sure" is picked; a flyer sign-up starts Needs
  review with no housing authority (`app/src/routes/public.ts:18-23`,
  `:331-349`).
- A filter-resolved audience is tenants only; partners (caseworkers) join a
  share only as a seed or an explicitly checked recipient
  (`isDirectShareRecipientType`, `broadcasts.ts:352-361`).

Tours (`app/src/repos/toursRepo.ts`, `app/src/lib/toursModel.ts`):

- Statuses `requested, scheduled, toured, no_show, canceled, closed`;
  outcomes `move_forward, not_a_fit, no_outcome`. A `requested` tour has no
  `scheduledAt`. Tours have no soft delete; deleting a property or a tenant
  leaves its tours as they are (`units.ts:2264-2280`, `contacts.ts:2273-2287`).
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
  closes `requested`, a toured tour with an outcome, or a convertible tour
  (`toursModel.ts:164-166`, `:203-205`); those rows stay in their partitions.
- New tours (since 2026-10-12) are tenant-only (`requireTenantContact`,
  `app/src/services/contactTypeGuards.ts:66-77`); older tours were not swept,
  so a tour's `tenantId` may name a non-tenant contact.
- #27's Interested creates a tour request only when the tenant and property
  have no qualifying tour yet (`app/src/routes/units.ts:1465-1481`,
  `app/src/lib/listingSendTour.ts:66`); a still-requested older request
  counts as one.

Dashboard (`dashboard/src/routes/broadcasts/`):

- The property step lists every non-deleted unit with its status label
  (`BroadcastComposer.tsx:190-199`, `:449-467`; `UnitSearchField` has no
  status option). The same step serves the bare entry and the `?contactId=`
  entry (a tenant's or caseworker's page). A non-Available property shows a
  banner (`:347-354`) and Send opens "Make Available & send"
  (`RecipientPreview.tsx:343-358`, `:682-715`). The property page's "+ Send"
  (`ListingDetail.tsx:425`) preselects the property with `?unitId=` and
  skips the picker.
- `AudienceFilters.tsx` holds voucher-size chips and a SINGLE-select
  `OrgPicker` labeled "Housing authority" (`:144-162`), which reads the
  organization list itself (`useOrgList`, `:66`). Only voucher size is
  prefilled from the property, with its first size
  (`BroadcastComposer.tsx:261-272`); the prefill writes only while the size
  is undefined, and changing the property does not re-apply it. The housing
  authority is never prefilled. `OrgPicker` already supports
  `multiple: true` (`dashboard/src/routes/orgs/OrgPicker.tsx:101-114`; in
  multi mode it hides already-chosen names from its options, `:239`), used
  by the property forms as "Housing authorities".
- A 422 `org_not_on_list` clears the authority pick and shows "That housing
  authority is no longer on the list - pick it again"
  (`BroadcastComposer.tsx:60-61`, `:129-137`, `:368-371`;
  `useComposerDraft.ts:223-237`). The draft key covers the authority
  (`useComposerDraft.ts:87-100`).
- `RecipientPreview.tsx`: a row starts checked when
  `hasConsent && (seeded || (!alreadySent && !declined))` (`:99-101`);
  Select all re-applies that (`:243-245`); declined rows carry a
  "Not interested" tag (`:582`), amber row styling (`:528`) and a checkbox
  name built by `checkboxName` (`:105-111`): consent-only for a no-consent
  row (`<name> - consent not recorded`), else `<name> - already sent,
  not interested` / `- already sent` / `- not interested` / the bare name.
  Add a tenant (tenant-only search, `:604`) annotates the option with ONE
  suffix, Not interested outranking Already sent (`:435-438`), and adds the
  row checked and seeded (`:257-336`). Rows are ordered by last heard from
  (`:194-206`).
- Truncation copy tells staff to narrow the filter
  (`AudienceFilters.tsx:191-193`, `RecipientPreview.tsx:650-655`).
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

Status-excluded tenants are NOT listed in the recipient review; the D8
caption says so. Hand-picked recipients (seeds, Add a tenant) keep any
status.

### D2 Housing authority: a list, any-of

`AudienceFilter` gains `housing_authorities?: string[]`. A tenant matches
when its `housingAuthority` (trimmed) equals any member. An absent or empty
list means no housing authority filter (every authority, as today with no
authority). While the list is non-empty, a tenant with no housing authority
(or a value that is not a member) does NOT match and is NOT listed
(Cameron 2026-10-14: leave them out and say so - the D8 caption).

- POST `/api/broadcasts` accepts `audience_filter.housing_authorities`: an
  array of strings, at most 100 members (a shape guard; the organization list
  is far smaller), else 400 `audience_filter.housing_authorities must be an
  array of at most 100 strings`. Members are checked with the existing list
  check (`orgNames.checkList('audience_filter', list, undefined, undefined)`,
  `app/src/lib/orgNames.ts:302-326`): trimmed, blanks dropped, de-duplicated,
  a unique spelling stored as the entry's exact name, and the FIRST failing
  member answered as today's 422 `org_not_on_list` body with field
  `audience_filter` and `text` set to that member. The stored draft carries
  `housing_authorities` and never `housing_authority`.
- LEGACY body: `audience_filter.housing_authority` (a string) is still
  accepted when `housing_authorities` is absent and is treated as a
  one-member list. Both present is a 400 `audience_filter: use
  housing_authorities only`. (Old open dashboard tabs and API clients keep
  working through a deploy.)
- LEGACY storage: a stored draft or historical broadcast with the old
  `housing_authority` string is read through ONE server normalizer
  (`authoritiesOfFilter(filter): string[]`): the list when present, else the
  old string as a one-member list, else `[]`. The resolver,
  `storedFilterRefusal`, preview, send path (c) and every response that
  carries a filter (the create echo, the results and list projections,
  `broadcasts.ts:393`, `:421`) go through it. Responses always send
  `housing_authorities` and never `housing_authority`, so the dashboard
  reads ONE shape and has no normalizer of its own.
- `storedFilterRefusal` checks EVERY member of the normalized list for an
  exact listed name, in order, and answers the 422 for the first that is
  not (today's body, candidate = its entry when the text is a spelling of
  one).

### D3 Prefill from the property

The composer reads the organization list itself (the list `AudienceFilters`
reads today moves up to, or is shared with, the composer). When the
composer has a property and the filters are on, the housing authority
picker is filled with the property's accepted authorities
(`authoritiesOf(unit)`, `dashboard/src/routes/listing/listingFormat.ts:63-71`),
each mapped to its entry name when it is the exact name, or a spelling of
exactly one, housing authority entry (the server's rule), in the property's
order, de-duplicated. Names that map to no entry are not put in the filter;
the picker shows "Not used (not on the organization list): <names, comma
separated>". When NONE of the property's authorities map, the same note is
followed by "This blast is not limited by housing authority."

The picker becomes `OrgPicker multiple`, labeled "Housing authorities".
Staff can remove any prefilled member or add others.

The prefill FOLLOWS THE PROPERTY until staff edit that filter: choosing or
changing the property re-applies the authority prefill (and the voucher
size prefill, D3a) unless that filter has been edited since the last
prefill. An edit is any pick, removal or clear by staff, and a member
removed after a 422 (below). Value and ownership are kept together and
checked in the functional state update (the lesson in
`docs/issues/broadcast-composer-prefill-overwrites-edit.md`).

Timing: Preview stays disabled until the prefill has settled - the property
is loaded and the organization list has loaded or failed. If the list read
fails, nothing is prefilled and the filters show "Couldn't load the
organization list, so housing authorities were not filled in from the
property." (the picker shows its own error as today).

D3a. Voucher size keeps its current prefill value (the property's first
accepted size) but gets the same follow-the-property rule, because the
current effect never re-applies after a property change
(`BroadcastComposer.tsx:261-272`, `:333-342`). Making voucher size a list
is NOT part of this change (tracker #12).

D3b. When a 422 `org_not_on_list` names a member (draft create or preview),
the composer removes THAT member only, keeps the others, and shows
"<text> is no longer on the organization list, so it was removed from the
filter." (replacing the copy at `BroadcastComposer.tsx:60-61`).

### D4 Tour holds

A tenant is HELD (left unchecked by default) while they have at least one
tour, for ANY property, that is unresolved. The rule is a pure function of
the tour and `now`, shared by preview, draft create and send path (c):

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
  `closed` and the tenant normally moves to `placing`, so D1 leaves them out
  instead.
- `requested`: the 14 days are measured from the request's `createdAt`. A
  request that is never booked stops holding after 14 days.
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
- A tenant marked Interested on #27 whose click created a tour request is
  held from every other property's blasts for up to 14 days, or until the
  booked tour resolves (Cameron 2026-10-14: intended).

### D5 Where the rules run: on the server, one rule

ONE server function produces the review rows for a draft: the filter rows
(D1, D2) united with the seeds, each with its flags (`alreadySent`,
`declined`, `tourHold`, `seeded`, consent) and `checkedByDefault`:

  `checkedByDefault = hasConsent && (seeded || (!alreadySent && !declined && !tourHold))`

Preview returns those rows; POST create counts them (D8). The dashboard
uses `checkedByDefault` for the initial state and for Select all and no
longer computes the rule itself; the only client-side default left is a row
added with Add a tenant, which starts checked (a hand pick).

The send ships exactly the list staff reviewed (path (a)), so preview and
send cannot disagree.

The open-tours read: ONE read per call, independent of audience size: the
`byStatus` partitions `scheduled`, `toured` and `no_show` to the end (the
same unbounded reads the auto-close sweep does every 15 minutes), plus
`requested` with the key condition `createdAt >= now - 14 days` (the range
key bounds the request partition, the one that grows with every unbooked
request). Group by `tenantId` in memory. The `toured` partition also keeps
toured tours with an outcome and convertible tours; at today's volume all
four reads are a few small Query pages.

FAIL CLOSED for filter drafts: if the open-tours read or the #27 decline
read throws while previewing a draft that resolves filter rows
(`audience_mode !== 'seeds_only'`), preview answers 503
`{ error: 'audience_rules_unavailable' }` and serves no list; serving one
would check people the rules leave out. The #27 `declineLabelsUnavailable`
degrade is REMOVED for those drafts.

A `seeds_only` draft (a direct send from a tenant's or caseworker's page)
holds only seeded rows, which are checked whatever the reads say, so a
failed read there serves the rows WITHOUT tour or decline labels and sets
`audienceRulesUnavailable: true`; the review shows "Tour and Not interested
labels couldn't be loaded." A direct send is never blocked by these reads.

### D6 Send paths

- (a) Explicit list (the dashboard): UNCHANGED. No status, tour or decline
  fence; a checked row is staff's decision. The existing hard fences (type
  tenant-or-partner, opt-out, unreachable, phone, Available property) stay.
- (b) `seeds_only` with no body: UNCHANGED (hand-picks skip the rules).
- (c) Filter draft with no body (API only): the recipients are the D1/D2
  resolved audience MINUS held tenants (D4, evaluated at send time) MINUS
  effective #27 declines. Already-sent tenants and tenants without recorded
  consent are NOT subtracted, as today (the fan-out skips a no-consent
  recipient and counts it `skipped_no_consent`). Seeds are not part of path
  (c) today and stay out. A thrown rules read answers 503
  `audience_rules_unavailable` and leaves the draft a draft. A truncated
  resolution is refused as today; the recipient cap compares the final
  recipient count (after the exclusions); an empty final set is today's
  400 `empty_audience`.

### D7 Recipient review (dashboard)

- Preview response, per candidate: `tourHold?: { kind, tourId, at? }`
  (`at` an ISO string, absent when the tour has no date) and
  `checkedByDefault: boolean`. Top level: `tourHolds: Array<{ contactId,
  kind, tourId, at? }>` for EVERY held contact (the analog of
  `declinedContactIds`, so Add a tenant can label a tenant outside the
  candidates) and `audienceRulesUnavailable?: true` (seeds-only drafts
  only). `declineLabelsUnavailable` is removed.
- Tour label (a tag after Not interested, same amber style; the row gets the
  same amber row class). Dates use the dashboard's existing browser-local
  short date (`shortDate`, `dashboard/src/routes/placements/placementsFormat.ts:114`,
  "Oct 20"); with no date the date and the space before it are dropped:
  - `upcoming`: "Tour Oct 20"
  - `not_marked`: "Tour Oct 9, not marked"
  - `needs_outcome`: "Toured Oct 9, needs outcome"
  - `needs_placement`: "Toured Oct 9, needs placement"
  - `no_show`: "No show Oct 9"
  - `requested`: "Tour requested Oct 12"
- Checkbox accessible name, literal format: a no-consent row stays
  `<name> - consent not recorded` (unchanged). Otherwise `<name>` followed,
  when any cue applies, by ` - ` and the cues joined with `, ` in this
  order: `already sent`, `not interested`, then the tour label in lower case
  (for example `Ana Diaz - already sent, not interested, tour oct 20`;
  `Ana Diaz - toured oct 9, needs outcome`). The existing two-cue strings are
  unchanged.
- Add a tenant option note: the applicable cues in the order `Not
  interested`, `Already sent`, then the tour label, joined with `, ` (today
  it shows only the first of the first two). The added row starts checked
  and carries its labels.
- The existing note "Flagged recipients you picked stay checked; "Select
  all" skips the others." stays as is.
- A 503 `audience_rules_unavailable` keeps staff on the compose step with
  "Couldn't check tours and Not interested replies, so the recipient list
  can't be shown yet." and a "Try again" button that re-runs the preview.
- Truncation copy no longer tells staff to narrow anything (no filter
  narrows the read any more): the review's alert reads "Too many tenants to
  read - some matches may be missing from this list." and the reach suffix
  reads " - the list is incomplete". The server's `audience_too_large`
  truncation message drops its "narrow the housing authority and/or
  bedroom-size filter" advice.

### D8 Filters area: caption and reach

While the filters are on, under the filters (Cameron 2026-10-14):

  "Only tenants in Onboarding or Searching are included. While a housing
  authority is selected, tenants with no housing authority recorded are
  left out. Add any other tenant by hand when you review recipients."

The second sentence shows only while the housing authority list is
non-empty.

"Reaches N recipients" (Cameron 2026-10-14) shows the number of rows that
will START CHECKED on the review step: POST create runs the D5 function and
answers `estimatedCount` = the count of `checkedByDefault` rows (stored as
`estimatedAudience`). It therefore leaves out held, declined, already-sent
and no-consent rows, exactly as the review step does. If a rules read
throws at create, the draft is still created, `estimatedCount` is omitted,
and the line shows today's "Reach estimate unavailable". Rows staff check
or uncheck, or add by hand, on the review step change the Send button's
count, not this line.

### D9 Property picker: Available only

The composer's property list and its search offer only properties with
status `available`, on EVERY entry that shows the picker: the bare Matching
entry and the `?contactId=` entry from a tenant's or caseworker's page
(Cameron's rule: only Available properties can be picked; every send
already requires Available). With none, the empty state reads "No Available
properties. A property must be Available to send." A property preselected
by `?unitId=` (the property page's "+ Send") is kept whatever its status,
with today's banner and Make Available dialog.

### D10 Caseworkers

Caseworkers (contact type `partner`) are never part of a filter-resolved
audience, whatever their status or housing authority - today's behavior
(the resolver's type fence), kept and pinned with tests. A caseworker joins
a send only as a seed (from their own page, which may then add filters) or
an explicitly checked row. Letting Add a tenant find caseworkers is deferred
(`docs/issues/matching-add-recipient-search-caseworkers.md`).

## 4. Consequences to know

- A tenant in Needs review, Placing, Placed, On hold or Inactive no longer
  appears in a filtered blast. A flyer sign-up starts Needs review with no
  housing authority, so it stays out until staff move it.
- When the property lists housing authorities, tenants with no housing
  authority recorded are left out of its blast by default: a `/join` lead
  who picked "Not sure", an imported tenant with a blank. The caption says
  so; staff add them by hand or clear the filter.
- The reach count now matches the default-checked rows, so it is usually
  smaller than before for the same filters.
- Available-only applies to the tenant-page and caseworker-page send too: a
  non-Available property must be made Available first (or sent from the
  property page, which keeps the Make Available dialog).
- The resolver no longer reads unwanted statuses, so the truncation issue's
  status-order cut no longer drops wanted tenants in favor of unwanted ones.
  Resolve `broadcast-audience-truncation-drops-searching-tenants` with that
  note (the bound and the truncation refusal remain; within the wanted set
  the read order is searching first).
- The `byHousingAuthority` GSI loses its only runtime caller. Removing it is
  an infrastructure change (Terraform) and is NOT done here; file a low
  `debt` issue.
- A failed tours or decline read blocks a filter blast's preview (with Try
  again) instead of showing a list without Not interested labels; a direct
  send shows a notice instead.
- Accepted exposures: a `needs_placement` tour holds until staff start the
  placement or record otherwise (the Past tab lists it); an open tour on a
  deleted property keeps holding until the two-week close; if moving a
  converted tenant to `placing` fails (best effort), that tenant stays
  Searching with no hold; a still-requested request older than 14 days
  makes Interested create no new request, so that click holds nothing.
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
- The review-rows function: `checkedByDefault` for every flag combination;
  seeds checked whatever their flags; no-consent never.
- The resolver: only `searching` and `onboarding` tenants; searching read
  first; any-of authority list; a blank or non-member authority excluded
  while the list is non-empty and included while it is empty; legacy string;
  a partner with a matching authority and any status never resolves; the
  existing fences.
- POST create: list accepted and stored as names; spelling resolved; the
  first off-list member's 422; more than 100 members 400; legacy string
  stored as a one-member list; both keys 400; `estimatedCount` equals the
  default-checked count (holds, declines, already sent, no consent left
  out); a throwing rules read creates the draft without `estimatedCount`.
- Preview: rows with `tourHold`, `checkedByDefault`, `tourHolds`; 503 on a
  throwing tours or decline read for a filter draft; a seeds-only draft
  served with `audienceRulesUnavailable`; legacy stored filter previews and
  is answered as a list; `storedFilterRefusal` over a list.
- Send (c): held and declined tenants excluded, already-sent and no-consent
  kept; 503 on a throwing read; the cap counts after exclusions; empty
  after exclusion is 400.
- The open-tours read: the `requested` key condition; every page of the
  other three partitions.

Unit (dashboard): rows use `checkedByDefault`; Select all; labels for every
kind with and without a date; the literal accessible names; the Add a
tenant note; the 503 Try again; the seeds-only notice; the caption (with and
without its second sentence); the reach line; the multi picker prefill
(exact names and unique spellings, off-list note, the not-limited line,
follow-the-property, edit ownership, a 422 removing one member, Preview
disabled until settled, a failed list read); the picker listing only
Available properties on the bare and `?contactId=` entries, the `?unitId=`
entry keeping a non-Available property, and the empty state; the truncation
copy; `audienceSummary` for a list (names joined with ", ").

e2e (new spec): one property accepting two listed authorities; tenants, all
with explicit statuses and authorities: Searching in authority A,
Onboarding in authority B, Placing in A, Searching in A with an upcoming
tour, Searching in A with a fresh tour request, Searching in A whose only
tour is closed Not a fit, Searching with no authority. Assert: both
authorities prefilled; the caption; the reach line equals the checked
count; the Placing and no-authority tenants absent; the two held tenants
listed unchecked with their labels; Select all leaves them unchecked; the
picker lists only Available properties; Add a tenant adds the Placing
tenant checked; the send reaches exactly the checked tenants (outbox). The
14-day request boundary is unit-tested; no backdating seam is added.

## 7. Places the build must also update

Server:

- `app/src/repos/broadcastsRepo.ts:84-90` (type), `broadcasts.ts`
  `parseAudienceFilter`, POST create (list check, estimate), the review-rows
  function, `storedFilterRefusal`, preview, send path (c), results (`:393`)
  and list (`:421`) projections, the router header comment (`:6-28`), the
  `audience_too_large` messages (`:1010-1012`).
- `audienceResolution.ts` (whole read; header comment; the truncation TODO;
  the `byHousingAuthority` log field).
- `toursRepo.ts`: the open-tours read (the `requested` range condition).
- The harness fake `toursRepo` (`app/test/helpers/twilioWebhookHarness.ts:3920`,
  `listByStatus` at `:3964`) and its `listByType` status support, which
  every `broadcastApi.test.ts` preview case runs against.
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
  key, create body, 422 handling, the reach count), `AudienceFilters.tsx`
  (multi picker, caption, the org list moving up, truncation suffix, the
  comment at `:102-105` about a removed audience line),
  `BroadcastComposer.tsx` (prefill and its settling, picker list, 422
  removal of one member, 503 Try again), `RecipientPreview.tsx` (row model,
  `checkedByDefault`, tags, accessible name, Add a tenant, the seeds-only
  notice, truncation alert, remove the decline-unavailable notice),
  `broadcastFormat.ts` `audienceSummary`.

Tests that pin today's shape or behavior and must change. e2e tenants get
an explicit on-list authority and status; no spec may depend on tenants
another spec left in the lane:

- app: `app/test/audienceResolution.test.ts` (its `tenant()` helper defaults
  to status `active`, so most cases resolve nothing under D1),
  `app/test/broadcastApi.test.ts` (string filters, the estimate, the
  "does NOT filter on status" comment at `:62-64`),
  `app/test/seedOrgNames.test.ts:86-87`, `:143-145`.
- dashboard: `AudienceFilters.test.tsx` (labels, filter objects, truncation
  copy at `:242`), `BroadcastComposer.test.tsx` (labels, filter objects,
  truncation copy at `:210`, the preview fixtures), 
  `BroadcastComposer.prefill.test.tsx` (the composer gains an org-list
  read), `RecipientPreview.test.tsx` (`checkedByDefault`, `:982-988`),
  `broadcastFormat.test.ts:31`.
- e2e: `broadcasts.spec.ts` test 1 (`:96-229` - the keep/drop tenants have no
  authority, and the lean seed's Tasha is `placing`) and "sending a
  non-Available property warns" (`:231-262` - its tenant has no authority,
  so its audience would depend on lane leftovers);
  `review-recipients-heard-from.spec.ts` (its tenants have no authority);
  `a2p-compliance.spec.ts` section 8.3 test 1 (`:324-441`, tenants with no
  authority) and `:480` (sends the legacy string through path (c) - keep it
  as legacy coverage; it still expects `skipped_no_consent === 1`);
  `org-lists.spec.ts` (`draftAuthority` reads a string at `:183-194`; the
  composer tests at `:321-367` and `:450-480` pin "no authority before a
  pick" and an option that multi mode hides after the prefill; the
  "Housing authority" label); `matching-entry-points.spec.ts:290,325`
  (label).
- `e2e/support/selectors.md:132-134` (the composer filter contracts: the
  singular label, "changes its filter ONLY on a pick or a chip removal" -
  now also on a property prefill) and `:147` (checkbox names).

Docs: `documentation/GLOSSARY.md` (the Matching entry gains "left out of a
blast: status, housing authority and tour holds"; the `byHousingAuthority`
line at `:322`), `RUNBOOK.md:1457`, the issue registry (resolve the
truncation issue, file the GSI debt issue).
