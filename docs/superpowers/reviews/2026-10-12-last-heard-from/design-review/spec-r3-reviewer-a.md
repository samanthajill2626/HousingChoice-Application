# Spec review r3 - reviewer A (adversarial)

Spec: revision 3 at 37bd970b (delta read via `git diff d8bd07e3 37bd970b`).
Adjudications "Round 2" read. Repo read-only; nothing run.

Summary: nothing BLOCKING or HIGH. Two MEDIUM findings touch new mechanism:
D11's fallback input, and the hosts D14 needs. The rest are precision edits.
Most round-2 fixes check out against the code. These hold up: the attribution
discriminator, the injected lookup, the four-group cover, requireComplete,
the `baseline` Clear, the writer-side normalization and the audit
best-effort posture.

---

## 1. [MEDIUM] D11's `lastMarkedAt ?? updatedAt` fallback lets an automated tour write override a decline

**What is wrong.** `latestActivityAt` = max over qualifying tours of
`max(createdAt, lastMarkedAt ?? updatedAt)`, justified as "the model's own
'last time a person marked / rescheduled / reopened it'"
(`toursModel.ts:214-218`). That is true of `lastMarkedAt` only. The model
says `updatedAt` is a stand-in "for a tour nobody has marked since this
shipped", and that "unrelated writes that bump updatedAt (a roster edit, a
group open)" are exactly why `lastMarkedAt` exists
(`app/src/lib/toursModel.ts:154-157`, `:212-215`). The repo calls `updatedAt`
"last-touched-by-anything" (`app/src/repos/toursRepo.ts:559`). Writers that
bump it with no person acting include the group-thread set and clear
(`toursRepo.ts:517`, `:534`) and the conversion claim (`:560`).

`lastMarkedAt` is NOT stamped at create. It is stamped only by a PATCH that
changes status or sets a time (`app/src/routes/tours.ts:1315-1325`) and by
reopen (`toursRepo.ts:785-800`). So every tour created and not yet marked, a
plain scheduled or requested tour, falls back to `updatedAt`.

**When it bites.** Through the staff UI a decline can only be recorded on a
row with NO qualifying tour (5.5: an `interested` row has no buttons). Any
tour that qualifies later is either newly created (`createdAt` is later) or
revived (reschedule and reopen both stamp `lastMarkedAt`). So the fallback
adds nothing for staff declines. It changes the answer only when a decline
coexists with an older unmarked tour: a stale card, or a Work Package 3
engine decline, which section 1 and G7 say this record is built for. Then
staff opening the tour's relay group, a routine step for a
landlord-led tour, bumps `updatedAt` past `declined.at`. The decline silently
stops counting with no person acting on the tour: the row flips to
Interested, Matching drops the label, and the waiting list drops the row.

**What it implies.** Use `max(createdAt, lastMarkedAt)` with no `updatedAt`
fallback. A revival always stamps `lastMarkedAt`, and a pre-feature tour's
`updatedAt` predates every decline (declines are new), so nothing is lost.
Correct the spec's description of the input to match.

---

## 2. [MEDIUM] D14's form path needs host changes the spec does not list, and the waiting list has no host

D14: with no structured `tour_type`, the Interested click "opens the
Schedule tour form ... with the tenant and property pre-committed ... and no
time". The form supports that: `tenantId` locks the tenant, `initialUnitId`
pre-commits the unit, and an empty date creates `requested`
(`dashboard/src/routes/tours/ScheduleTourForm.tsx:1-11`, `:186-205`,
`:310-318`). The hosts do not, as they stand:

- **Contact page "Properties sent".** The only host on that page
  pre-commits the unit to `file.listingsSent.rows[0]?.unitId`, the most
  recently sent property, whichever row was clicked
  (`dashboard/src/routes/contact/ContactDetail.tsx:1306-1313`). It is one
  boolean of state (`schedulingTour`). Interested on an older row would
  pre-commit the WRONG property unless the host takes a per-click unit.
- **Property "Sent to".** The host passes `initialUnitId` but no `tenantId`
  (`dashboard/src/routes/listing/ListingDetail.tsx:1304-1312`), so the
  clicked recipient is not pre-committed. It must gain `tenantId` (and a
  per-click value, since the card has many rows).
- **Waiting list.** 5.6 gives its rows "Interested / Not interested / Undo
  as on the cards". The only `ScheduleTourForm` hosts are ContactDetail,
  ListingDetail and ToursPage (imports at `ContactDetail.tsx:70`,
  `ListingDetail.tsx:49`, `ToursPage.tsx:76`). Neither option A (a Matching
  tab) nor option B (Today) has one. `FollowUpItem` also has no field saying
  whether the unit carries `tour_type`, so the list cannot choose between the
  route and the form.
- **Navigation.** Both hosts navigate to `/tours/<id>` on create
  (`ContactDetail.tsx:1314-1317`, `ListingDetail.tsx:1308-1311`). The D14
  path therefore takes Sam off the card she was working from. The spec says
  only that "the row reads Interested on its next load". State whether the
  host should stay on the page for this entry point.

---

## 3. [LOW] `recipientMissing` rows cannot be "interested by the tour alone"

The new D12 bullet says a missing contact's outcome is "derived with no
contact facts (so `no_reply` or `interested` by the tour alone)". But
`deriveSendOutcome` reads the tour only when `recipientType === 'tenant'`
(5.4). With no contact there is no type, so the tour is ignored and
`interested` is unreachable. A stored effective decline can still yield
`not_interested`, which the bullet omits. The four-group cover does not place
a missing row either: `eligible` is undefined without a contact. Say "the
outcome ignores tours (no type); the row goes to NOT ELIGIBLE".

---

## 4. [LOW] `isEligibleRecipient` omits the phone check its stated purpose needs

5.6 justifies the eligibility half as "so every row's Text action can work",
citing the resolver's hard exclusions (the spec cites
`audienceResolution.ts:146-148`; the opt-out and unreachable fences are
actually at `:152-153`). The resolver also drops a contact with no phone, on
the very next line (`app/src/services/audienceResolution.ts:154`). Partners can be phone-less,
and a listed send can outlive a phone removal. Add "has a phone", or drop the
Text-action justification.

---

## 5. [LOW] In the preview's degraded state, a declined tenant is checked by default without warning

When the label reads fail, the preview serves "NO decline labels" plus one
line ("sends still work"). Round 2 established that a declined row is not
necessarily already sent (`shareRecipientState.ts:249-268`,
`listingSendsRepo.ts:51`). So in the degraded state a declined, not-already-sent
audience tenant starts CHECKED and goes out with a filter blast unless staff
notice the line. If that trade is intended, say so in the line's text
("Not-interested tenants are not marked and may be checked").

---

## 6. [LOW] The `?status=none` sentinel clashes with the module's own sentinel and leaves combinations undefined

`tenantFacets.ts` already uses a "none" sentinel, `NONE_KEY = '__none__'`,
for the "Not recorded" VALUE bucket (`tenantFacets.ts:10-11`, `:145`). The
status facet's `none` means the EMPTY SELECTION, a different concept with a
near-identical spelling in the same module. The spec also does not say what
`?status=none&status=searching` parses to. Pick a distinct token (or reuse
the module's double-underscore form with its own name) and define the mixed
case (the real values win, for example).

---

## Fixes checked and found correct (no finding)

- Attribution by thread type with the keyless relay clause matches
  `voice.ts:997-1054`. Live path 6's resolution (external id, else
  `findByPhone` on a soft-deleted match) equals the rule's.
- The four groups cover every row with a contact: an eligible waiting row,
  `interested`, `not_interested`, or an ineligible waiting row. The new
  projection fields are the ones the eligibility half reads.
- `requireComplete` addresses the silent drop (`contactsRepo.ts:943-951`).
  The contact-card error rendering addresses the "Arrives with the backend"
  regression (`useContactFile.ts:51-61`, `Card.tsx:79-82`).
- `ChipGroup` with a `baseline` fixes the dead Clear
  (`FilterChips.tsx:56-63`).
- The form path really does show the guess with its caption
  (`ScheduleTourForm.tsx:247-254`), which is what D14 asks for.

Contested adjudications: none.
