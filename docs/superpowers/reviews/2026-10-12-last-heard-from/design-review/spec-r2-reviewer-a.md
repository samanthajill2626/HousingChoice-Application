# Spec review r2 - reviewer A (adversarial)

Spec: revision 2 at d8bd07e3 (diffed against cb4a30e0). Read alongside
`adjudications.md` and `spec-r1-reviewer-b.md`. Repo read-only; nothing run.
New problems come first. Every code claim cites a line read in this tree.

---

## 1. [HIGH] D11 compares the decline against the wrong tour, and against a timestamp that reschedule and reopen never move

**What is wrong.** `effectiveDecline(row, tour)` compares `declined.at` with
`tour.createdAt`, where `tour` is `deriveTourSignal`'s result (5.4: "gains
`createdAt` on its result"). `deriveTourSignal` returns the MOST PROGRESSED
qualifying tour: rank `toured` > `scheduled` > `requested`, with createdAt only
as the tie-break within one rank (`app/src/lib/listingSendTour.ts:41-45`,
`:72-89`). It does not return the most recent tour. Two ways this defeats D11's
stated meaning ("a tour created after a decline means the tenant changed their
mind, from any tour-creating path"):

- **Rank masks the new tour.** A tenant toured this property months ago (a
  `toured`, converted or auto-closed-from-toured tour), later declined, then
  changed their mind, and staff create a NEW requested tour. The signal is the
  OLD toured tour, whose `createdAt` predates the decline, so the decline stays
  effective. The row reads "Not interested", the Matching preview flags it, and
  the waiting list drops it, while a live request sits on Needs booking.
- **Revived tours keep their createdAt.** A canceled or no-show tour can be
  RESCHEDULED back to `scheduled`, and a closed tour can be REOPENED to
  `scheduled` / `toured` (`app/src/lib/toursModel.ts:14`, `:18`, `:234-258`;
  `POST /api/tours/:tourId/reopen`, `app/src/routes/tours.ts:1634`).
  `createdAt` is written once at create (`app/src/repos/toursRepo.ts:368`,
  `:381`). A reschedule or reopen after a decline is exactly "changed their
  mind", and D11 misses it. The model already records the instant a person
  last acted on a tour: `lastMarkedAt`, "the last time a person marked /
  rescheduled / reopened it" (`toursModel.ts:155`, `:214`).

**What it implies.** The comparison input must be "the latest instant any
qualifying tour for the pair was created or revived". That is a separate value
from the chip winner: a max over qualifying tours of `max(createdAt,
lastMarkedAt)`, or equivalent. As written, the D11 fix holds only when the pair
has no older qualifying tour and nothing was revived. The new e2e (4), a tour
scheduled after a decline, will pass and would not catch either case.

---

## 2. [HIGH] `attributeInbound`'s relay branch cannot attribute a non-member's refused call, and the key-presence wording would pin it on a roster member

**What is wrong.** The rule says the relay / group branch keys on
`relay_sender_key` and "covers a member, a non-member texting an open relay,
and a refused masked call from a member or a non-member alike". The
non-member refused call row carries NO `relay_sender_key`. The voice handler
writes it only when a roster `caller` was found
(`...(caller !== undefined && { relaySenderKey: relayMemberKey(caller) })`,
`app/src/routes/webhooks/voice.ts:1048`). `caller` is undefined for exactly the
`non_member` reason (`voice.ts:997`, `:1006-1011`). That row carries
`relay_external_caller_phone` / `relay_external_caller_contact_id` instead
(`voice.ts:1050-1054`), and the rule never reads either field.

The branch header reads "Thread type `relay_group` or native group
(`relay_sender_key` present)". If a builder takes the parenthetical as the
discriminator, the keyless row falls into "Any other thread (1:1 of any
type)", which attributes it to `participants[0].contactId`. On a relay thread
that is a ROSTER MEMBER. The backfill would then mark a member as heard from
(and every send to them as Replied) because a stranger called the pool number.
If the discriminator is the thread type instead, the row is simply
unattributed. Either way, the conformance test the spec requires (each live
path's touched id equals `attributeInbound` on the row it wrote, section 8)
fails for table row 6's non-member case. Live touches
`relayExternalCallerContactId` or `findByPhone`; the rule returns undefined or
member #1.

**What it implies.** Name the discriminator explicitly as THREAD TYPE, never
key presence. Add a relay-branch clause for keyless rows:
`relay_external_caller_contact_id`, else `relay_external_caller_phone ->
findByPhone`. Say what happens to any other keyless inbound row on a group
thread.

---

## 3. [MEDIUM] `attributeInbound` is called "pure", but its rule does lookups

The spec defines `attributeInbound(row, thread): contactId | undefined` as "A
pure function" (5.1). Its own rule then calls `contacts.findByPhone` (relay
`phone#` keys, the 1:1 `participant_phone` fallback) and `findByEmail`. The seed
derivation is also called "pure" (`deriveSeedHeardFrom(messages,
conversations)`, 5.1 and D13). It runs before the Put loop, with no contacts
repo and no contact list in its signature. So no version of the stated
signature can implement the stated rule. The seed path has to resolve phones
against the seed's own contact items, and the backfill and live paths against
the repo.

**What it implies.** Give the function an injected resolver
(`lookup: { byPhone, byEmail }`, synchronous over a map for seeds, async over
the repo elsewhere), or split it into a pure key extractor plus a resolver.
State it, because "one rule" is the guarantee the whole of G1 now rests on.
Hiding the I/O inside a "pure" name is how live and backfill drift apart
again.

---

## 4. [MEDIUM] The preview's `declinedContactIds` cannot apply D11; it is computed with no tour join

5.3: `declinedThisProperty` and `declinedContactIds` "Both come from ONE
`listingSends.listByUnit(unitId)` read in the handler (rows whose decline is
effective, section 5.4)". Under D11, `effectiveDecline(row, tour)` needs the
pair's tour signal, and `deriveSendOutcome` drops that signal for non-tenants,
so it needs the recipient's type as well. The preview handler reads neither
(`app/src/routes/broadcasts.ts:654-756`), and the spec adds no tours or
contacts join there. The preview is also missing from D12's list of
outcome-serving endpoints (5.4, "Outcome-serving endpoints and their joins").

**What it implies.** The tenant D11 was written for (declined, then booked a
tour) still reads "Not interested" on Review recipients and in the "Add a
tenant" search. Add `tours.listByUnit(unitId)` (one query) plus the types
already on the candidates. For hand-added ids outside the audience, that means
a type source too. Then say whether a failed join 503s the preview or degrades
to "no labels".

---

## 5. [MEDIUM] The property card's groups leave rows in no group, and the projection cannot compute NOT ELIGIBLE

- 5.6 step 3 calls the WHOLE keep-list "the RECIPIENT RULE, shared with 5.5's
  card grouping". That list includes LOOKBACK and QUIET. 5.5 defines WAITING
  as a waiting outcome "on a recipient the waiting list would consider - section
  5.6's recipient rule", and NOT ELIGIBLE as a waiting outcome on an inactive,
  placed, deleted, opted-out or unreachable contact. An eligible tenant sent
  the property an hour ago (not yet QUIET), or 20 days ago (past LOOKBACK),
  fits neither group, and fits no other group either. Under option C ("this
  card IS the list") that row disappears from "Sent to". Either the card uses
  only the eligibility half of the rule (say so), or it needs a fifth group.
- The property card is served by the units recipients route through
  `RECIPIENT_PROJECTION` (`app/src/repos/contactsRepo.ts:1018-1025`,
  `app/src/routes/units.ts:1029`). 5.1 widens that projection with
  `last_heard_from_at` and `status` only. NOT ELIGIBLE also needs `sms_opt_out`
  and `sms_unreachable`. They are absent, so the grouping cannot be computed
  from the stated read. (5.6's own list reads full items via `getManyByIds`;
  the card does not.)

---

## 6. [MEDIUM] D12's "required join" cannot be detected through the stated read, and its error surfaces are wrong

- The contacts join on the card endpoint is `getRecipientDisplaysByIds`, which
  takes no options (`contactsRepo.ts:1284-1286`). It runs the DEFAULT
  best-effort `batchGetByIds`: unprocessed keys and thrown chunks are counted,
  WARNed and DROPPED (`contactsRepo.ts:943-951`, `:986-998`). Only
  `requireComplete` throws. So a partial read never surfaces as "a failed
  join". It serves rows with no type and no `lastHeardFromAt`, which is exactly
  the guessed outcome D12 forbids. The spec must route the projection through
  `requireComplete`. It must also say what a genuinely MISSING contact (a row
  for a hard-deleted contact, which is not "incomplete") derives to.
- 5.4 says that on a 503 "the card shows its error row ('We couldn't load
  recipients.')". That is true only for the property card
  (`dashboard/src/routes/listing/ListingDetail.tsx:1057-1058`). The contact
  cards treat any non-ready slice as pending: `loadSlice` maps a non-404 error
  to `'error'` (`dashboard/src/routes/contact/useContactFile.ts:51-61`), and
  `listingsSentPending={file.listingsSent.status !== 'ready'}`
  (`ContactDetail.tsx:1134`, `:1185`) renders `PendingPanel`, which reads
  "Arrives with the backend." (`Card.tsx:79-82`). A transient 503 on a tenant
  page therefore says the feature is not built yet.
- Option B reuses the waiting-list builder "inside `GET /api/today`" (5.6).
  Under D12 a failed join is a 503. The spec never says whether that fails the
  whole Today payload or only the section, and Today is the "what needs me
  now" page. Decide it now, since the mechanism is declared independent of
  Sam's answer.

---

## 7. [LOW] The status facet's new rules contradict the chip contract

- "Turning off the last lit chip is a no-op (the chip stays lit)" contradicts
  the invariant ContactsList cites for every facet: "a selected chip is always
  clickable - deselection must never lock" (`ContactsList.tsx:216-218`). The
  chip stays an enabled `aria-pressed=true` button that ignores the click.
- `ChipGroup` renders Clear whenever `selected.size > 0`
  (`dashboard/src/routes/contacts/FilterChips.tsx:56-63`). The default status
  set is non-empty, so Clear is visible in the default state, where "Clear
  returns to the default set" makes it a dead control.
- If a URL carries only invalid status values, the prune leaves an empty set,
  which the spec calls "not representable". Say that it reads as the default.

---

## 8. [LOW] "Every declined row is necessarily also already sent" is not guaranteed

5.3 leans on this to say the unchecked default "is already true today" and that
`<name> - not interested` "is never produced alone". "Already sent" comes from
`priorRecipientKeys`, which is derived from BROADCAST records and is
best-effort: a byUnit read failure returns a partial set
(`app/src/services/shareRecipientState.ts:249-268`). A LISTED `listing_sends`
row needs no broadcast behind it. Legacy and seeded rows carry the `!legacy` /
`!individual` ledger entries (`app/src/repos/listingSendsRepo.ts:51`). So a
declined row can arrive without the already-sent flag. The explicit "declined
starts unchecked" rule still covers the checkbox. The accessible-name sentence
is false and needs the declined-only form after all.

---

## 9. [LOW] Interested-route audit and retry details

- Step (4) writes `listing_interested`, labeled "Interested in <address> -
  tour requested", even when step (1) found an existing qualifying tour and
  created nothing. A retry after a 503 (step 1 now finds the tour) writes it a
  second time. Write it only when step (3) created the tour, or label the
  no-create case differently.
- The route serves 503 when a re-projection join fails AFTER the write
  succeeded (decline set or tour created). The card then shows "a failure ...
  leaves it unchanged" over a state that did change. A retry is idempotent,
  but the message should not claim nothing happened.
- The spec does not say whether the audit writes are best-effort (tour events
  use a shared best-effort writer, `tours.ts:298-307`) or can fail the route.

---

## 10. [LOW] Timestamps are normalized in the backfill only, not at the single writer

5.2 normalizes through `Date.parse` because the importer stores the export's
raw `createdAt` (`apply.ts:448-449`; the parser only trims it,
`app/src/lib/import/quoSource.ts:219-225`). The importer stamp, however, goes
straight through `touchLastHeardFrom` (5.1, "Historical writers"), and its
DynamoDB condition `last_heard_from_at < :at` compares stored strings
lexically. Normalize inside `touchLastHeardFrom`, the one writer, not in one
caller.

---

## 11. [LOW] Smaller points in the new material

- "The touch runs on BOTH the fresh and the deduped branch of every inbound
  path." The email path's deduped branch returns early by design, because "the
  winner runs the side effects" (`app/src/services/inboundEmail.ts:735-742`). A
  touch there is harmless under forward-only, but the stated precedent does not
  hold for email. Scope the claim to the SMS and voice paths, or say email is
  covered by the winner.
- D13 / I4 "every seeded world is self-consistent" leaves out the performance
  world (`/__dev/performance/reseed`, `app/src/lib/performanceSeed.ts` and
  `seed/performance.ts:975` write inbound relay rows), which the derivation in
  `seed/index.ts` never sees.
- The NOT ELIGIBLE group is described as having "no Text action", but the
  cards have no Text action for any row (5.5 actions). Say instead whether
  NOT ELIGIBLE rows keep Interested / Not interested.

---

## Contested adjudication: B14 (the guessed tour type) - CONTEST

The rejection rests on two premises. Both are false in code.

1. "The tour is editable afterwards like any requested tour." `tourType` is
   NOT editable. `PATCH /api/tours/:id` accepts only `scheduledAt`, `status`,
   `outcome`, `moveForward` (`app/src/routes/tours.ts:157`), and unknown fields
   are refused (`tours.ts:1155`). Once created, the guess is permanent.
2. "It is the same guess the Schedule tour form pre-fills." Same function,
   different posture. The form shows the guess to a human with an explicit
   provenance caption, "Guessed from the property's tour notes - check it"
   (`dashboard/src/routes/tours/ScheduleTourForm.tsx:74`, applied at
   `:250-253`), and the staffer can override it before submitting. The
   one-click create commits it unseen.

It matters because `tourType` is not cosmetic. It routes every reminder:
non-`self_guided` tours send reminders to the masked group thread with the
landlord, and `self_guided` sends them to the tenant 1:1
(`app/src/jobs/tourReminders.ts:1059-1068`, `:1307`). A wrong keyword guess
over free-text `tour_process` (for example "owner shows it" or "pm" read as
pm_team, `ScheduleTourForm.tsx:84-114`) therefore sends tenant reminders to
the wrong audience, with no way to fix the type afterwards. D6 ("the button
picks the type itself") can stand. The spec should then either (a) use only
the structured `unit.tour_type` and, when it is absent, fall back to a labeled
default the booking step can see, or (b) make `tourType` correctable at
booking. "Accepted by design" is not supported by the code. Severity:
MEDIUM (wrong reminder routing, permanently).
