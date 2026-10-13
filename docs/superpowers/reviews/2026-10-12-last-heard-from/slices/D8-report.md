# D8 - S5 Tasks 5.3-5.5: decisions record

Dispatch D8 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: wiring the outcome actions into the two send-roster hosts - the
property page's "Sent to" card (four group lists, the URL-only Schedule a
tour form, deleted property) and the contact pages' "Properties sent" cards
(error status distinct from pending, client-side interestedMode, the
per-click unit, the partner "Request a tour" link) - and the property
Activity labels. Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md`
(S5 Tasks 5.3-5.5 and the cross-slice notes; sections 3.3, 3.4 #1/#4/#10
R1-R4; contract notes N1/N2; section 11). No binding correction was listed
for D8.

## Commits

- f8a0bd20 Task 5.3 - `dashboard/src/routes/listing/listingFormat.ts`
  (`SendRowGroup` :267, `groupSendRows` :282);
  `dashboard/src/routes/listing/ListingDetail.tsx` (`useSearchParams` :256
  replaces the deleted `schedulingTour` state; `tourFormOpen` :388,
  `openTourForm` :393, `closeTourForm` :406, `onRecipientOutcome` :420;
  grouped body :1192; "+ Tour" :1245; form host :1479, keyed :1483); tests
  `listingFormat.test.ts:330`, `ListingDetail.test.tsx:2395` (new describe,
  mocks for `setListingSendOutcome` / `createTour`, `renderAt(unitId,
  search)`).
- 4f6556f9 Task 5.4 - `dashboard/src/routes/contact/TenantFile.tsx` (props
  :66-75, `personName` :163, card body :326);
  `dashboard/src/routes/contact/PartnerFile.tsx` (props :47, `personName`
  :95, card body :184, partner link :213);
  `dashboard/src/routes/contact/ContactDetail.tsx` (`tourUnitOverride` :201,
  `onListingOutcome` :665, wiring :1200 / :1253, form host :1385); tests
  `files.test.tsx` (prop rename; cases :276-336, :820-835),
  `TenantFile.test.tsx` (prop rename), `ContactDetail.test.tsx` (cases
  :1109-1146; partner case :3100).
- 04c1d5c4 Task 5.5 - `dashboard/src/routes/listing/listingFormat.ts`
  (`OUTCOME_LABELS` :172, branch :201); test `listingFormat.test.ts:174`.
  `dashboard/src/routes/contact/Timeline.tsx` unchanged (renders the server
  label verbatim, neutral default variant).

`npm run typecheck` exited 0 after each commit; `npx eslint` on every
touched .ts/.tsx file exited 0.

## RED / GREEN evidence

- Baseline (before any edit): 9 files, 500/500.
- 5.3 RED: 12 failed for the stated reasons (no `groupSendRows`; one
  interim `Sent to` list; read-only rows; nothing read `?tour=new`). The
  deleted-property case was already green on the read-only interim rows.
- 5.3 GREEN: listingFormat 36/36, ListingDetail 102/102.
- 5.4 RED: 11 failed (no error row; interim names/actions; no partner link;
  the knowing prop rename broke the PartnerFile pending case). The R1 PIN
  and the deleted-unit case were already green.
- 5.4 GREEN: files 53/53, TenantFile 5/5, ContactDetail 132/132.
- 5.5 RED: 1 failed (`{ label: 'Listing declined' }` from the humanize
  fallback). GREEN: listingFormat 37/37.
- Final: 29 files (the 9 baseline files, TourChip, every tours test) =
  1094/1094.

## Decisions and divergences (all contract-preserving)

1. The property page's Schedule a tour form is keyed by the `tenantId`
   param (`ListingDetail.tsx:1483`). Not in the plan. The form resolves its
   locked label once per mount and its fallback keeps a previous label, so
   a tenantId change while the dialog is mounted (R4 "reacts while
   mounted") showed the previous tenant's name. Pinned by
   `ListingDetail.test.tsx:2559`, proven red without the key.
2. `setListingSendOutcome` sits alphabetically BEFORE `setUnitPhotoCover`
   in the ListingDetail api import (the plan said after; cosmetic).
3. TenantFile's "no requestTourTo" comment names ContactDetail without the
   plan's line citation; PartnerFile's actionsDisabled comment restates the
   same rule. An existing TenantFile doc line carrying an em dash was
   rewritten in ASCII as part of the edit.
4. Test helpers: the TenantFile `renderIt` options use
   `TenantFileProps['onListingOutcome' | 'onOpenTourForm']`; the PartnerFile
   helper types `onListingOutcome` inline.
5. ContactDetail.test.tsx's partner fixture keeps `tour` with a comment
   saying why (it pins the client-side drop; the server sends none).

## Markup delivered (R1, R3, R4 for S8)

- R1: the property card renders one named `<ul>` per non-empty group in
  the order `Waiting`, `Interested`, `Not interested`, `Not eligible`; the
  contact cards keep ONE `<ul aria-label="Properties sent">`. Every
  listitem in a card is a roster row.
- R3: property page names use `tenantName ?? contactId` and the property's
  short address; contact page names use the page contact's display name
  and the property's address label. Partner rows (property page: `row.type
  === 'partner'`; contact page: the PartnerFile) link `Request a tour for
  <name> at <address>` to `/listings/<unitId>?tour=new` and never offer
  Interested; landlord and team-member rows get neither.
- R4: `?tour=new` opens the dialog with a free tenant picker,
  `?tour=new&tenantId=<id>` with the tenant locked (`role="group"` named
  `Tenant`). Every property-page entry point navigates there with replace;
  Cancel and create strip both params; create then pushes `/tours/<id>`.
  A deleted property shows outcomes, no actions, and ignores `?tour=new`.
- Contact cards: `listingsSentStatus` 'error' renders `We couldn't load
  properties sent.`; a row whose property is not among the page's live
  units shows its outcome with no actions; Interested in 'form' mode opens
  Schedule a tour pre-committed to the clicked row's property.
- Activity: `<who> not interested`, `<who> not interested cleared`, `<who>
  interested - tour requested` (who = contactName ?? contactId); the app's
  Activity whitelist (`app/src/routes/units.ts:343-371`) carries no `by`,
  so "(auto)" never shows there - verified, no change.

## Flagged, not changed

- A deleted CONTACT's Properties-sent rows still offer actions: the plan
  wires `onListingOutcome` unconditionally and spec B10 names a deleted
  PROPERTY only. If the product wants a deleted contact read-only there,
  ContactDetail can withhold the prop the way it withholds the relay-group
  create action (`ContactDetail.tsx:659-661`).
