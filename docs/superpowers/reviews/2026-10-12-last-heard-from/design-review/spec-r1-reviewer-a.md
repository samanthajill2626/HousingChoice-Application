# Spec review r1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
(as committed at cb4a30e0). Repo read at the worktree tip; no source edited,
nothing run beyond `git apply --check` of the C6 patch (it applies cleanly).

Severity is consequence-if-shipped-unfixed. Every code claim cites a line read
in this tree; anything not verified is marked UNVERIFIED.

---

## 1. [HIGH] "Not interested beats a tour" is backwards for every case the mechanism can actually reach

**What is wrong.** Section 5.4 ranks `effectiveDecline` above `tour` and
justifies it with "staff closing a tour as not a fit and then marking Not
interested should read as Not interested". That case never needs the
precedence: a tour closed as not-a-fit already yields NO signal
(`app/src/lib/listingSendTour.ts:55-66`, `qualifyingState` returns undefined for
a plain `closed`), so the row falls to replied/no_reply and the Not interested
button is shown. The precedence only fires when a QUALIFYING tour
(requested / scheduled / toured) and an effective decline coexist. With staff as
the only writer, how does that state arise?

- Section 5.5 shows NO buttons on an `interested` row ("cancel or close the tour
  there"), so staff cannot record a decline while a live tour exists.
- So the coexisting state is reached only when the tour is created or revived
  AFTER the decline: the Schedule tour form (`POST /api/tours`,
  `app/src/routes/tours.ts:310-397`, no decline awareness), a tour reopen
  (Sam #18 reopen path), or a stale card (no live updates, section 3).

Every one of those is the "tenant changed their mind" case, the case where the
decline should LOSE. Instead the row reads "Not interested" next to an open
tour request on Needs booking. The waiting list excludes it, and the Matching
preview flags the tenant as declined and starts them UNCHECKED for this
property. `effectiveDecline` is superseded only by a later counted SHARE
(`sentAt`), never by a later tour.

**Evidence.** Spec 5.4 precedence block and rationale; 5.5 action table;
`listingSendTour.ts:55-66`; `tours.ts:355-362` (a timeless create calls
`tours.create` with no other checks).

**What it implies.** Either compare instants (a tour created after
`declined.at` supersedes the decline, the same way a share does), or have tour
create clear the decline. The second option means `POST /api/tours` has to be
listed as a `declined` writer, and I2 currently says the outcome route is the
only one. As written, the rationale contradicts the mechanism. The spec
rejected staff-created "interested" as stored state because it goes stale, and
this rule brings that staleness back through the decline.

---

## 2. [HIGH] The preview cannot "copy status and lastHeardFromAt from the resolver's candidate"; the resolver projects a fixed whitelist

**What is wrong.** Section 5.3 says: "The audience resolver is not touched (no
#6 overlap): the resolver's candidate projection already carries the contact,
so `status` and `lastHeardFromAt` are copied from it." False. The resolver
maps each contact to a narrow `ResolvedContact` (contactId, phone, firstName,
lastName, voucherSize, housingAuthority, has_consent). It carries no status and
no other attribute (`app/src/services/audienceResolution.ts:31-49`, push at
`:160-173`). Seeds go through `resolveSeeds`, which builds the same narrow
shape by hand (`app/src/routes/broadcasts.ts:440-473`). The preview handler
copies only what is on those objects (`broadcasts.ts:710-743`).

**What it implies.** The build MUST widen `ResolvedContact` and both builders
(the resolver and `resolveSeeds`). That is the module the spec declares
untouched. `ResolvedContact` also feeds the send path, so the widening has to
be checked against everything that snapshots or serializes it. The spec has to
name this change and drop the "not touched" claim. Otherwise a builder either
stops or reads full contacts a second time.

---

## 3. [HIGH] Added rows and the "Add a tenant" search have no source for "declined this property"

**What is wrong.** Section 5.3 requires (a) the combined list, added rows
included, to carry the declined state, and (b) "The ContactSearchField result
for a declined tenant also shows 'Not interested' after the name". Today an
added row is built entirely client-side from `tenantCandidates` (a
`getContacts({type:'tenant'})` list). Its already-sent flag comes from
`priorRecipientContactIds`, a list the preview response ships for exactly this
purpose (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:181-243`,
`:104-107`; `broadcasts.ts:654`, `:739`). The spec adds only a per-candidate
`declinedThisProperty` boolean. A tenant outside the audience is not a
candidate, so neither the added row nor the search option has any way to know
about a decline. `ContactSearchField` also has no per-option decoration hook
(`dashboard/src/routes/contact/ContactSearchField.tsx:53-64`). It is shared by
12 caller files, and the spec applies the C6 patch "verbatim" to the same file.

**What it implies.** The preview response needs a declined-contact id list (the
`priorRecipientContactIds` analog). `ContactSearchField` needs a new optional
annotation prop, and the spec must say how that lands next to the verbatim C6
patch. As written, the promised informed hand-pick silently does nothing.

---

## 4. [MEDIUM] Tenants-tab status filter: the URL rules contradict themselves and break the facet contract

**What is wrong.**
- "Default (no `status` param) = every status except inactive and placed" and
  "an explicit `?status=` set is honored as given, including an empty set
  meaning 'none'" cannot both hold. With repeated `?status=` params, an empty
  set IS zero params, which IS the default. `applyToParams` deletes and
  re-appends keys (`dashboard/src/routes/contacts/tenantFacets.ts:165-172`), so
  turning every chip off serializes to the default set.
- The facet engine's convention is "Empty sets / false = unconstrained"
  (`tenantFacets.ts:57-62`). The status facet inverts it (absent = constrained)
  without saying how the per-facet Clear behaves (back to the default, or to
  all?).
- The existing counts contract is "a chip's number always states what clicking
  it does" (`tenantFacets.ts:217-226`). Section 5.7 never folds status into
  `buildFacets` or the `facetProbe` prune (`ContactsList.tsx:197-243`). The
  voucher and authority counts would then include the hidden inactive and
  placed tenants.
- The search box filters `visible` AFTER the selection
  (`ContactsList.tsx:233-236`). Searching for a placed or inactive tenant by
  name now shows "No matches for X" (`:331-335`), which reads as a missing
  record, not a filtered one.

**What it implies.** Pick a representable "none" (for example a sentinel
`?status=none`) or drop the empty-set rule. Define Clear. Define how status
enters the contextual counts. Say what the no-match message reads while the
default filter is hiding matches.

---

## 5. [MEDIUM] The touch skips deduped inbounds, against the 1:1 pipeline's recovery design

**What is wrong.** Section 5.1: "a deduplicated inbound ... does not touch.
The touch sits after a successful, non-deduped append." The 1:1 webhook
deliberately re-runs every post-append side effect on a dedupe, so a
redelivery completes a first delivery that crashed after the append ("Dedupe
must NOT skip the side effects below", `app/src/routes/webhooks/twilio.ts:2501-2536`;
"RE-RUNS these idempotent steps", `:2538-2543`). Its siblings
(`touchPhoneLastSeen` at `:2569-2578`) run on that path. The spec's real
worry, that the redelivery's local `providerTs` is a fresh `now`, is solvable:
the deduped branch already reads the persisted row
(`persistedTsMsgId`, `:2510-2525`), and `splitTsMsgId` recovers its provider
instant (`app/src/repos/messagesRepo.ts:208-213`). The echo-of-our-own-send
dedupe is excluded by checking the persisted row's direction.

**What it implies.** A crash between the append and the touch loses the bump
for good, on the one path built to recover it. The rule should be: on a
dedupe, touch with the PERSISTED row's instant when the persisted row is
inbound. The group path's dedupe handling (`twilio.ts:2047-2070`) needs the
same decision stated.

---

## 6. [MEDIUM] The call-site table misses a refused member call, and live attribution disagrees with the backfill in several branches

**What is wrong.**
- Path 6 says "Masked relay call, refused (non-member)" and touches only via
  `relay_external_caller_contact_id`. The refusal path also fires for a MEMBER
  calling a CLOSED thread (`reason === 'closed_thread'`). That row carries
  `relaySenderKey` for the member and no external-caller id
  (`app/src/routes/webhooks/voice.ts:1035-1055`). G1 says "inbound call (any
  outcome)", but the live path never touches for it.
- The external-caller id is set only when the matched contact is not
  soft-deleted (`voice.ts:1023-1025`). Every other path touches deleted
  contacts, because `findByPhone` ignores deletion (`contactsRepo.ts:1206-1233`).
- Backfill vs live, same history, different answers:
  - Unknown-author email. Live skips it (spec row 8). The backfill attributes
    1:1 rows by `participants[0].contactId` with no author filter (spec 5.2
    step 2-3), so it counts mail the live path refuses to attribute.
  - Relay member with a `phone#` key. Live skips it (row 2). The backfill
    resolves it "by phone against the roster then findByPhone".
  - Closed-thread member call. The backfill counts it (it has
    `relay_sender_key`); live does not.
  - Imported inbound calls carry neither `imported_sender_phone` nor
    `relay_sender_key` (`app/src/lib/import/apply.ts:466-484`). So the
    importer's own stamping (spec 5.1, "1:1 rows by imported_sender_phone,
    group rows by relay_sender_key") never counts an imported inbound call,
    missed calls included.

**What it implies.** Under D2 "the two columns can never disagree", a value
depends on whether it was written live or by the backfill. Before the plan,
state ONE attribution rule that both the live paths and the backfill planner
implement, and add the closed-thread refused call to the table.

---

## 7. [MEDIUM] `touchLastHeardFrom` as specified can mint phantom contact items

**What is wrong.** The condition is
`attribute_not_exists(last_heard_from_at) OR last_heard_from_at < :at`, with no
`attribute_exists(contactId)`. An UpdateItem on an absent key CREATES the
item. The importer documents this exact hazard (`apply.ts` retract block,
"DynamoDB's UpdateItem CREATES an absent item", around `apply.ts:676-690`).
Every other contacts writer guards it (`contactsRepo.ts:1088`, `:1405`, `:1433`,
`:1550`). Touch ids come from relay rosters, roster member keys and
external-caller lookups (spec rows 2, 4, 7), which can outlive the contact
(import retract deletes contacts, `apply.ts:318-328`). The "importer's
last_activity_at pattern" the spec copies is a CONVERSATIONS write whose
existence is already established by that point, so it is not a precedent here.

**What it implies.** A dangling id produces an untyped contact row that
`getById` returns. Its id can then never be created (`create` and
`createIfAbsent` are `attribute_not_exists(contactId)`, `contactsRepo.ts:1372`,
`:1385`). Add `attribute_exists(contactId) AND (...)` and treat the resulting
conditional failure as a silent no-op too.

---

## 8. [MEDIUM] Property Activity is audit-sourced, and "unknown types render nothing" is false

**What is wrong.** Section 5.4 says a `listing_declined` ACTIVITY event makes
"the property Activity show '<name> not interested'", and "Unknown event types
already render nothing ... so no other renderer changes."
- `activity_events` is keyed by contactId (`app/src/lib/tables.ts:397-401`).
  The property Activity card reads UNIT AUDIT rows (`units#<unitId>`,
  `app/src/routes/units.ts:183-213`; dashboard
  `dashboard/src/api/types.ts:3109-3121`). An activity event never reaches the
  property card. Tours dual-write both for exactly this reason
  (`tours.ts:298-307`, `:392-396`).
- The property card's contract is "Unknown types must still render
  (humanized), never blank" (`types.ts:3119`). The contact Timeline's
  `milestoneVariant` has a `default` branch, and the row renders its stored
  label (`dashboard/src/routes/contact/Timeline.tsx:428-444`). Neither surface
  renders nothing. The cited `listing_response_set` precedent appears nowhere
  in app/ or dashboard/ source (UNVERIFIED that it ever behaved as claimed).
- `ActivityEventType` is mirrored "VERBATIM" in the dashboard union
  (`activityEventsRepo.ts:27-31`, `types.ts:2703`), so a new member is a
  two-sided change either way.

**What it implies.** For the property card, add a unit audit append
(`listing_declined`, `listing_decline_cleared`) plus its formatter. Delete the
"no other renderer changes" sentence.

---

## 9. [MEDIUM] The seed claims are wrong: lean has inbound history, and history.ts writes no messages

**What is wrong.**
- "the lean seed is left as is (its two tenants carry no inbound history)".
  Lean tenant `contact-tenant-0001` (Tasha) has inbound 1:1 messages and an
  inbound native-group message (`app/src/lib/seed/lean.ts:339-399`, `:434`,
  roster at `:303`).
- "The full seed (`app/src/lib/seed/history.ts`) stamps the contacts it writes
  inbound messages for". `history.ts` writes only audit and activity rows
  (`seed/index.ts:134-142`). It contains no message rows (no `direction` writes
  at all). The full world's inbound messages live in `seed/cast.ts` (49
  direction writes, for example `cast.ts:188-291`) and in the lean items that
  the full profile merges (`index.ts:116-118`).

**What it implies.** A builder following the spec edits the wrong module, and
the demo world either gets no values or gets values out of step with its
threads. In lean, Tasha reads "Never" beside visible inbound texts, so any e2e
that reasons from her thread content is misled. Restate which module stamps
what, and that the full profile must stamp lean contacts without changing the
lean items.

---

## 10. [MEDIUM] The derived outcome silently degrades when its best-effort joins fail

**What is wrong.** Both GET projections treat the tour join and the contacts
join as best-effort: on failure, rows serve without them and log
(`units.ts:1002-1016`, `:1023-1034`; `contacts.ts:1232-1243`). The spec feeds
those joins straight into `deriveSendOutcome` and `interestedSupported`, and
never says what happens on a failed join:
- A tour-join failure turns every `interested` row into `no_reply` or
  `replied`, and offers an Interested button.
- A contacts-batch failure drops `lastHeardFromAt` (turning Replied into
  No reply yet) and drops `type`, so `interestedSupported` is guessed.
- The waiting list (5.6) reuses the same joins, so the same failure ADDS
  interested rows to the chase list.

**What it implies.** The spec must decide: fail the request, or mark the
outcome unknown on the wire and suppress actions. Today's chip-only
degradation was harmless; an outcome that drives actions and a to-do list is
not.

---

## 11. [MEDIUM] The waiting list keeps soft-deleted and opted-out recipients

**What is wrong.** The 5.6 filters are outcome, tenant-status, lookback and
quiet. The join reads `getRecipientDisplaysByIds`, which carries `deleted_at`
(`contactsRepo.ts:1018-1025`). The spec never excludes deleted contacts, and
the projection has no `sms_opt_out`. The row's "Text" action would offer to
text a STOP'd contact (refused downstream) or a deleted one.

**What it implies.** These filters are "independent of where it lives" (5.6
says so), so they belong in this spec now, not in Sam's answers. Exclude
`deleted_at`, and decide how opted-out and unreachable rows show (no Text
action, or excluded).

---

## 12. [MEDIUM] The partner "Request a tour" link has no host that leaves the tenant picker empty

**What is wrong.** Section 5.4 says the link "opens the existing tour form
(`ScheduleTourForm`, which takes `initialUnitId`) on the property with the
tenant picker empty". The contact-page host passes
`tenantId={contact.contactId}`, which LOCKS the tenant side
(`ContactDetail.tsx:1306-1313`; prop doc `ScheduleTourForm.tsx:55-63`). On a
partner page that locks the tenant to the CASEWORKER. Nothing stops it either:
`POST /api/tours` only checks that `tenantId` is a non-empty string
(`tours.ts:325-328`). The property-page host has no URL entry to open the
form (`ListingDetail.tsx:1304-1312`).

**What it implies.** Say which host the link uses: navigate to the property
page with a new open-the-form param, or a contact-page mode with no
`tenantId`. Otherwise the obvious implementation creates a tour for a partner,
and that breaks the "partners never have tours" premise in item 13.

---

## 13. [LOW] "A partner row never has a tour" is not true in data

Tenants converted to caseworkers keep their tenant-era tours (spec 7 keeps the
listing rows, and nothing in the conversion touches tours, UNVERIFIED). The API
accepts any contactId as `tenantId` (`tours.ts:325-328`). Both GET joins attach
a tour by contactId regardless of type (`units.ts:1038-1046`,
`contacts.ts:1244-1248`). The partner page hides chips only by not passing
`s.tour` (`PartnerFile.tsx:174-178`). `deriveSendOutcome` has no type input,
so a partner row can derive `interested` while `interestedSupported: false`.
State that partner rows ignore the tour signal in the pure function, or pass
the type in.

---

## 14. [LOW] The Interested path leaves no trace, and its decline-clearing clause is unreachable from the UI

- "`created_via: 'send_outcome'` is stamped if `TourItem` has a provenance
  field; otherwise the activity event carries it." `TourItem` has none
  (`toursRepo.ts:67+`, no such field). A timeless create records no activity
  or audit event (`tours.ts:392-396`), and the spec defines no Interested
  event. The one-click create is therefore unattributed. Decide the event now.
- "An existing effective decline is cleared by Interested": a `not_interested`
  row shows only Undo (5.5), and the waiting list excludes such rows. So the
  clause is reachable only through the raw API. The spec also does not say
  whether the "tour already exists" early-return branch clears the decline
  too.

---

## 15. [LOW] The contact endpoint already does the tour join

Section 5.4 says `GET /api/contacts/:id/listings-sent` "gains ... the tour join
the units endpoint already does (one `tours.listByTenant`, grouped by unitId)".
It already does exactly that (`contacts.ts:1229-1248`). A literal builder could
add a second query. Also, `RECIPIENT_PROJECTION` is used only by the units
route (`units.ts:1029`), not "by both roster cards".

---

## 16. [LOW] The filter-resolved send path still sends to declined tenants

"The send endpoint does not change: ... 'declined rows start unchecked' IS the
exclusion". The send route keeps path (c), "filter-resolve (back-compat - no
body)" (`broadcasts.ts:812`, `:895-925`), which resolves the filter with no
decline awareness. Only the dashboard's curated list is covered. Say so, or
note it as the place Work Package 3's engine must not use.

---

## 17. [LOW] Dev seams and reseeds are unlisted writers

- `/__dev/voice/transcript-fixture` and `/__dev/extraction/message-fixture`
  append inbound rows directly (`app/src/routes/dev.ts:794-860`, `:897-1060`).
  They never touch, so e2e state built through them disagrees with the rule.
- `/__dev/reseed` re-Puts whole lean contact items (`seed/index.ts:147-156`).
  That moves `last_heard_from_at` BACKWARD to absent. I1 claims it never moves
  backward and lists the full seed as a writer, but not the reseed reset.

Both are dev-only. List them so specs are not written against a guarantee the
harness breaks.

---

## 18. [LOW] Smaller inaccuracies and gaps

- `contactsRepo.ts:435-454` (`seedPhonesForWrite`) does not "reset"
  `lastSeenAt` on a phone edit. It stamps a FAKE `now` when it materializes a
  legacy scalar (`:442-450`). The conclusion (do not reuse it) stands.
- `formatInboxTime` renders a same-day stamp as "2:14 PM", not "Today 2:14 PM"
  (`dashboard/src/routes/inbox/inboxTime.ts:52-60`). "Reusing" it needs a
  wrapper the spec does not mention.
- Glossary: "waiting on a reply = a send with no outcome" contradicts 5.6,
  which includes `replied` rows.
- `effectiveDecline` keys on `sentAt`, which follows the latest COUNTED share
  (`app/src/services/shareLedger.ts:112-120`). An acceptance-counted share is
  not terminal (`listingSendsRepo.ts:56`, only delivery-counted is). If it
  later fails, `sentAt` moves back and a superseded decline becomes effective
  again. Worth one sentence.
- Sorting the combined Review recipients list moves a just-added row away from
  the "Add a tenant" field below the list (`RecipientPreview.tsx:403-475`), so
  a long list gives no visible confirmation of the add.
- The importer's `provider_ts` is the export's raw `createdAt`
  (`apply.ts:448-449`). The forward-only condition and `Replied` both compare
  ISO strings lexically, so mixed precision or offset forms would mis-order
  (UNVERIFIED whether Quo's createdAt is normalized).
