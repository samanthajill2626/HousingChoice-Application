# Spec review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
(branch feat/last-heard-from @ cb4a30e0). Read-only review: no source edited,
no tests or servers run. Every claim about current behavior below cites code
read in this worktree; anything not verified is marked UNVERIFIED.

Severity is consequence-if-shipped-unfixed.

---

## F1. [HIGH] The preview's `status` / `lastHeardFromAt` mechanism is false: the resolver does not carry the contact

**What is wrong.** Section 5.3 says: "The audience resolver is not touched
(no #6 overlap): the resolver's candidate projection already carries the
contact, so `status` and `lastHeardFromAt` are copied from it." It does not.

**Evidence.**
- `app/src/services/audienceResolution.ts:30-48` - `ResolvedContact` is a
  narrow projection: `contactId, phone, firstName?, lastName?, voucherSize?,
  housingAuthority?, has_consent`. No `status`, no `last_heard_from_at`, no
  reference to the `ContactItem`.
- `audienceResolution.ts:158-168` builds exactly those fields and drops the
  rest of the item.
- Seeds are built separately and to the same narrow type in
  `app/src/routes/broadcasts.ts:440-473` (`resolveSeeds`), which also
  deliberately strips voucher facts from partners.
- The preview handler builds candidates from that `combined` list only
  (`broadcasts.ts:719-745`); it never sees a `ContactItem`.
- (Also: the spec cites `audienceResolution.ts:129-138` as if under `lib/`;
  the file is `app/src/services/audienceResolution.ts`.)

**What it implies.** The builder must either (a) widen `ResolvedContact` and
both producers (the resolver - the very module the spec says is untouched to
stay clear of #6 - and `resolveSeeds`), or (b) add a second contacts read in
the preview handler, or (c) join client-side from `tenantCandidates`, which
`RecipientPreview` already holds (`RecipientPreview.tsx:56-58`). The spec
picks none, and its "no #6 overlap" justification rests on a false premise.
Separately, "status ... absent on a partner seed" is not what copying
delivers: a partner contact carries a status (`needs_review` | `active`,
`app/src/lib/statusModel.ts:194`), which `StatusBadge kind="tenant"` would
render as a tenant label or a humanized fallback
(`dashboard/src/ui/StatusBadge.tsx:93-101`). The spec must say the field is
omitted for non-tenants, and where.

---

## F2. [HIGH] `touchLastHeardFrom`'s condition can MINT phantom contact rows

**What is wrong.** Section 5.1 specifies UpdateItem `SET last_heard_from_at =
:at` under `attribute_not_exists(last_heard_from_at) OR last_heard_from_at <
:at`, and cites the importer as the pattern. DynamoDB UpdateItem CREATES an
absent item; that condition is satisfied by a missing row.

**Evidence.**
- The cited importer pattern is on the CONVERSATIONS table
  (`app/src/lib/import/apply.ts:1352-1362`), not contacts.
- The same file documents this exact hazard for contacts and makes
  `attribute_exists(contactId)` load-bearing: `apply.ts:663-686`
  ("adversarial finding 14 ... B would MINT a phantom carrying nothing but
  `{contactId, ...}`. With no phone, type or status it sits on neither GSI").
- Every other contacts writer in the repo is guarded with
  `attribute_exists(contactId)` (e.g. `contactsRepo.ts:1086`, `:1159`,
  `:1405`, `:1433`, `:1561`, `:1822`).
- Contacts are hard-deleted by the import retract (`apply.ts:776-783`).
  Message rows keep `relay_sender_key` contactIds and rosters keep
  `participants[].contactId` forever, so stale ids are reachable, and the
  backfill (section 5.2 step 3) attributes BY those stored ids.

**What it implies.** A live touch or (much more likely) a backfill run over
history writes `{contactId, last_heard_from_at}` rows for deleted contacts.
`getById` returns them, so any roster/participant hydration that reads a
stale id now gets a nameless, typeless "contact" instead of absence. The
condition must be `attribute_exists(contactId) AND (attribute_not_exists(...)
OR ... < :at)`, and a ConditionalCheckFailed must then be disambiguated
(missing row vs already later) or both swallowed knowingly. Also state that
pointer rows (`phoneref#` / `emailref#`, `contactsRepo.ts:385-399`) are never
touch targets.

---

## F3. [HIGH] Outcome precedence lets an OLD decline beat a NEWER tour created anywhere but the Interested button

**What is wrong.** `deriveSendOutcome` (5.4) puts `effectiveDecline(row)`
unconditionally above `tour !== undefined`. A decline is superseded only by a
later counted share (`sentAt`) or removed only by the outcome route (I2:
"Writers of `declined`: the outcome route only"). Nothing ties a decline to
tours created by any other path.

**Evidence.**
- Tours are created by `POST /api/tours` (`app/src/routes/tours.ts:310-409`)
  from the Schedule tour form, the Tours page and the contact page; none of
  those touch `listing_sends`.
- The spec's own partner design (5.4, "Request a tour" link) sends staff to
  that same form for a caseworker's client - a client who may have a recorded
  decline on this property.
- The only stated justification is the reverse case ("staff closing a tour as
  not a fit and then marking Not interested should read as Not interested"),
  which a closed/not-a-fit tour already satisfies because it yields no signal
  (`app/src/lib/listingSendTour.ts:18-22`, `:56-66`).

**What it implies.** Tenant says no on Monday (marked Not interested), changes
her mind Wednesday, staff schedules the tour from the Tours page: the property
card shows "Not interested" with only an Undo button and hides the scheduled
tour chip; the contact card mirrors it; Review recipients starts her
unchecked with "Not interested"; the waiting list hides her. The rule must
compare instants (decline beats a tour only when `declined.at` is later than
the tour's `createdAt` / last transition), or every tour create must clear
the pair's decline. Either way the spec needs to enumerate the tour-create
surfaces, which it does not.

---

## F4. [HIGH] Hand-added rows and the "Add a tenant" search results have no source for the decline flag

**What is wrong.** 5.3 requires (a) the combined list - "audience rows and
added rows alike" - to be decline-aware, and (b) "The ContactSearchField
result for a declined tenant also shows 'Not interested' after the name".
The only decline data the spec puts on the wire is a per-candidate
`declinedThisProperty` boolean.

**Evidence.**
- Added rows are built client-side from `tenantCandidates` (plain `Contact`
  objects), not from preview candidates (`RecipientPreview.tsx:170-240`).
- The existing already-sent annotation for added rows works only because the
  preview ALSO returns the full key set `priorRecipientContactIds`
  (`broadcasts.ts:752`, consumed at `RecipientPreview.tsx:110-113`, `:225`).
  The spec adds no equivalent declined-id list.
- `ContactSearchField` has no per-result annotation prop today
  (`dashboard/src/routes/contact/ContactSearchField.tsx:53-64`), and its
  header warns that folding extra text into a result writes it into the
  committed `name` (`ContactSearchField.tsx:13`). Section 5.8 also says the
  component changes ONLY by the C6 patch, applied verbatim.

**What it implies.** As written, an added declined tenant shows no tag and
starts checked, and the search shows nothing - the exact "informed hand-pick"
the spec promises cannot be built from the specified payload. Add
`declinedContactIds` (or reuse the decline read to return the set), and
specify the ContactSearchField prop and how the label stays out of the
committed value.

---

## F5. [MEDIUM] "Interested clears the decline" and "the stale record stays as history" cannot both hold

**What is wrong.** 5.4 (interested bullet): "An existing effective decline is
cleared by Interested (the tenant changed their mind; the stale record stays
as history)."

**Evidence.** The only clearing primitive is `clearDeclined`, which REMOVEs
`declined` (5.4 writer paragraph). `effectiveDecline` depends only on
`declined.at` vs `sentAt`; Interested does not move `sentAt`. There is no
field that makes a decline ineffective while keeping it. Because decline
outranks tour (F3), leaving it in place would keep the row Not interested
after Interested created the tour.

Also ambiguous: Interested's early-return branch ("if a tour ... exists ...
return the row with that tour") says nothing about clearing the decline, so a
declined pair with an open tour would return still `not_interested`. And the
two writes (tour create, clearDeclined) have no specified order or
partial-failure behavior.

**What it implies.** Decide: REMOVE (history lives only in the activity
event) or add a `cleared_at`/`supersededAt` field and fold it into
`effectiveDecline`. Specify clear-before-or-after-create and the early-return
path.

---

## F6. [MEDIUM] The dedupe rule loses touches and conflicts with "exactly like touchPhoneLastSeen"

**What is wrong.** 5.1 says the touch "sits after a successful, non-deduped
append" and also that its failure posture is "exactly like
`touchPhoneLastSeen` at `twilio.ts:2571-2577`". It further claims writing
`provider_ts` instead of `now` protects against webhook retries.

**Evidence.**
- The 1:1 path deliberately RE-RUNS its idempotent post-append steps on the
  dedupe path so a first delivery that died after the append is recovered by
  the redelivery: `twilio.ts:2540-2546` ("the dedupe path re-runs it
  harmlessly"), `:2566-2568` ("Twilio redelivery re-runs it idempotently").
  `touchPhoneLastSeen` (`:2570-2578`) is NOT gated on `deduped`.
- The native group path states the same principle explicitly for its
  side effect: `twilio.ts:2190-2200` ("DELIBERATELY NOT GATED ON
  `appended.deduped`").
- `providerTs` on every live SMS path is the SERVER clock at webhook arrival,
  not a provider timestamp: `twilio.ts:906`, `:1287`, `:2015`, `:2469`; voice
  uses `new Date()` too (`voice.ts:777`, `:1016`, `:1110`). On a redelivery
  the local `providerTs` variable is a NEW, later `now`.

**What it implies.** Gating on `!deduped` means a crash between append and
touch is never repaired (the value stays stale until the contact's next
inbound) - avoidable, since the touch is forward-only and idempotent. Copying
`touchPhoneLastSeen` literally instead re-runs on dedupe with the
redelivery's later `now`, moving the value past the message. The correct rule
is: touch on BOTH branches, with the instant taken from the persisted row
(`splitTsMsgId(appended.tsMsgId).providerTs`, `messagesRepo.ts:207-213`,
the deduped append returns the first delivery's key per `twilio.ts:2017-2021`).
The spec's rationale paragraph should stop calling `provider_ts` a provider
instant.

---

## F7. [MEDIUM] Live touch and backfill use different attribution rules, so the "same definition" is not one definition

**What is wrong.** G1/D2 define one rule ("inbound ... from that contact",
calls "any outcome"). The live table (5.1) and backfill (5.2 step 3) disagree
in at least three places, and the live table itself violates "any outcome".

**Evidence.**
1. Refused masked call from a MEMBER (closed thread, no callee, no pool
   number): `voice.ts:1006-1014` covers all four refusal reasons; the row
   carries `relaySenderKey` for a member caller (`voice.ts:1048`). The live
   table row 6 touches only via `relay_external_caller_contact_id`
   (non-member). So live: no touch; backfill (attributes relay rows by
   `relay_sender_key`): touch. And G1 "inbound call (any outcome)" fails live.
2. Open-relay NON-member text: live resolves the sender only through the
   roster (`twilio.ts:891-897`); a non-member gets `phone#From` and no
   contact, so no touch. Backfill: "else by phone against the roster then
   `findByPhone`" - touches.
3. Unverified-address email filed into a known 1:1 (`author: 'unknown'`,
   `inboundEmail.ts:861-873`): live explicitly does not touch (row 8).
   Backfill attributes every inbound row in a 1:1 to `participants[0]` and
   "stops at its first inbound" - which can be that unattributed email,
   both crediting the wrong evidence and stopping before the real one.

**What it implies.** After the backfill, some contacts carry a value the live
path would never have written, and ongoing behavior differs from the
backfilled history. Pick one attribution rule, write it once (a pure
`attributeInbound(row, thread)` shared by planner and live paths is the
natural home given G7), and fix row 6 to touch the member caller.

---

## F8. [MEDIUM] The backfill reads `provider_ts`, which seed rows do not have; the full-seed stamping is pointed at the wrong module

**What is wrong.** 5.2 step 4 keeps "the max `provider_ts` per contact". The
only environment an agent may run the backfill against is `--env local`,
whose data is the seed.

**Evidence.**
- Seed message rows carry `ts`, not `provider_ts`: lean
  (`app/src/lib/seed/lean.ts:346-353`, `:369-379`), cast
  (`app/src/lib/seed/cast.ts:1415-1424`). `grep provider_ts app/src/lib/seed`
  hits only `performance.ts`. Real appends do write it
  (`messagesRepo.ts:2592`).
- 5.1 says "The full seed (`app/src/lib/seed/history.ts`) stamps the contacts
  it writes inbound messages for". `history.ts` writes no messages (0
  inbound rows); `historyItems` returns only `audit_events` and
  `activity_events` (`history.ts:1071-1074`; wired at
  `seed/index.ts:134-141`). The 26 inbound seed rows are in `cast.ts`.

**What it implies.** The local backfill run - the spec's only agent-run
proof - finds no `provider_ts` on seed rows and either writes nothing or
compares `undefined`. Use the `tsMsgId` prefix (always present,
`messagesRepo.ts:207-213`) as the instant, in the backfill and the seed
stamping, and name the right seed module (and whether the full profile
stamps the lean contacts it inherits - see F9).

---

## F9. [MEDIUM] The lean-seed rationale is false: lean tenants DO have inbound history

**What is wrong.** 5.1: "the lean seed is left as is (its two tenants carry
no inbound history, and e2e specs create their own)"; I4 builds on it.

**Evidence.** `lean.ts:256-266` - the lean tenant's 1:1
(`participants: [{ contactId: IDS.tenant, ... }]`) has an inbound tenant
reply at `lean.ts:346-354` ("Yes! Could we do Saturday morning?"), plus a
second inbound fixture at `lean.ts:432-436`. The lean native group text has
inbound rows at `lean.ts:369-379` and `:392-400`.

**What it implies.** In the byte-stable e2e world the contact page will show
a visible tenant reply next to "Last heard from: Never", and any e2e that
asserts Never/ordering on lean contacts encodes an inconsistency. Either stamp
the lean contacts (accepting a lean byte change, deliberately) or keep I4
but state the true reason and that lean is intentionally inconsistent. As
written, the decision rests on a false fact.

---

## F10. [MEDIUM] The Tenants-tab status filter: default hides people from search, "empty = none" is unrepresentable, and the Name sort references an order that does not exist

**What is wrong / evidence.**
- Default = all statuses except Inactive and Placed (5.7). The search box
  filters the same `visible` list (`ContactsList.tsx:232-236`), so typing a
  placed tenant's name on the Tenants tab yields "No matches for ..." with no
  hint why. This is the exact failure D4 rejects for Review recipients ("a
  missing name never reads as a bug").
- "An explicit `?status=` set is honored as given, including an empty set
  meaning 'none'": with repeated `?status=` params an empty set serializes to
  NO param, which the spec defines as the default. Turning off the last chip
  silently re-lights five. The existing facet contract is the opposite -
  "an empty selection is unconstrained" (`tenantFacets.ts:174` and
  `parseSelection` drops empty values, `:150-153`) - and `ChipGroup` renders
  a "Clear" button whenever a facet is non-empty (`FilterChips.tsx:56-66`),
  whose meaning for status (none? default? all?) is unspecified.
- "`name` = last name, first name, the existing display order": there is no
  existing sort. `useContacts` merges per-type pages in map order
  (`useContacts.ts:63-71`), `ContactsList` never sorts
  (`ContactsList.tsx:232-236`); section 1 of the spec itself says the order
  is GSI byte order. The comparator must be specified.

**What it implies.** Specify search-vs-status interplay (e.g. a query
searches all statuses, or the no-matches line names the hidden statuses), an
explicit sentinel for the empty set (or drop "none"), the Clear semantics,
and the name comparator.

---

## F11. [MEDIUM] The property Activity cannot show a `listing_declined` activity event, and "no other renderer changes" contradicts wanting it shown

**What is wrong.** 5.4 Audit: a new `ActivityEventType` member is recorded "so
the contact timeline and the property Activity show 'Not interested in
<address>' / '<name> not interested' ... Unknown event types already render
nothing ... so no other renderer changes."

**Evidence.**
- Activity events are keyed per CONTACT (`activityEventsRepo.ts:62-67`, PK
  `contactId`).
- The property Activity reads the AUDIT trail `units#<unitId>`
  (`app/src/routes/units.ts:1320`) through a fixed-key whitelist projection
  (`units.ts:216-246`). A contact activity event never reaches it; it needs
  an `audit.append('units#...')` plus a projection/label path.
- `ActivityEventType` is documented as a VERBATIM mirror of the dashboard's
  `TimelineMilestoneType` union (`activityEventsRepo.ts:27-30`), so the
  dashboard type changes too.
- "Unknown types render nothing" is a reason the event would be INVISIBLE,
  not a reason no renderer changes are needed.

**What it implies.** Enumerate: contact-timeline (activity_events, dashboard
union + colour switch), property Activity (audit append + whitelist +
dashboard label), or drop the property-Activity promise.

---

## F12. [MEDIUM] Best-effort joins turn into silently wrong outcomes, and "never creates a second tour" is narrower in the mechanism

**What is wrong.** 5.4 makes `outcome` and `interestedSupported` mandatory
wire fields derived from joins the existing endpoints treat as best-effort.

**Evidence.**
- Units recipients: tour join failure serves rows with no tour
  (`units.ts:1003-1017`); contact display join failure leaves names/type
  absent (`units.ts:1018-1034`). Contact listings-sent: same for tours
  (`contacts.ts:1229-1240`).
- With the spec's derivation, a failed tour join turns every Interested row
  into Replied / No reply yet and re-shows the Interested button; a failed
  display join leaves `lastHeardFromAt` absent (outcome falls to No reply
  yet) and `type` unknown (`interestedSupported` undefined - unspecified).
- The Interested route re-checks only tours in `requested` or `scheduled`
  (5.4). A `toured` (or converted / auto-closed-from-toured) tour qualifies
  as Interested in `deriveTourSignal` (`listingSendTour.ts:56-66`) but not in
  the route's check, so clicking Interested on a toured pair (reachable via
  the degraded join, a stale tab, or the waiting list) creates a fresh
  `requested` tour that lands on Needs booking. D6/G4 say "never creates a
  second tour".

**What it implies.** Either make the joins required for these endpoints
(500/retry rather than wrong data) or add an "unknown" outcome the UI renders
without actions; and make the route's existence check use the same
qualifying set as `deriveTourSignal` (one home, per G7).

---

## F13. [MEDIUM] The waiting-list filters keep opted-out and unreachable contacts and offer "Text"

**What is wrong.** 5.1 decides a STOP counts as inbound ("Opt-out is a
separate, visible fact"), so a STOP after a send makes the row Replied. 5.6's
keep-filters exclude only interested / not_interested / inactive / placed;
the row action list includes "Text".

**Evidence.** Spec 5.1 (STOP bullet), 5.6 step 3, 5.6 row actions. The
filter-resolved audience already treats `sms_opt_out` / `sms_unreachable` as
hard exclusions (`audienceResolution.ts:146-148`).

**What it implies.** A tenant who texted STOP becomes a "waiting on a reply"
chase item after QUIET days, with a Text button. The send gate will refuse
the text (UNVERIFIED for the 1:1 composer path), but the list itself is
wrong. Add opt-out / unreachable to the exclusions (or render and disable).
Related: under Option C the property card IS the list, but 5.5's card sort
does not apply D1's Inactive/Placed exclusion, contradicting D1's
"wherever it lives".

---

## F14. [LOW] The one-click Interested silently commits a guessed tour type; its provenance has nowhere to go

**Evidence.** `deriveTourType` is keyword guessing and never returns undefined
(`ScheduleTourForm.tsx:84-114`), so `?? 'self_guided'` is dead; the form
itself captions a guess "Guessed from the property's tour notes - check it"
(`ScheduleTourForm.tsx:74`). `TourItem` has no provenance field
(`toursRepo.ts:366-396`), so 5.4 falls back to "the activity event carries
it" - but the spec defines activity events only for decline set/clear, and a
`requested` create emits none (`tours.ts:397-401`).

**What it implies.** Say whether a guessed type is acceptable for a one-click
create (or create without a type decision surfaced), and define the
provenance record or drop the sentence.

---

## F15. [LOW] The importer stamping rule omits imported inbound calls

**Evidence.** 5.1 (historical writers) attributes "1:1 rows by
`imported_sender_phone`, group rows by `relay_sender_key`". Imported call rows
carry neither (`apply.ts:465-481`), yet G1 counts inbound calls.

**What it implies.** Attribute 1:1 rows (all types) by thread participant;
say what happens to group-thread calls.

---

## F16. [LOW] Misdescriptions of current code a builder could trip on

- "The contact endpoint ... gains ... the tour join the units endpoint already
  does (one `tours.listByTenant` ...)": the contact endpoint ALREADY does
  exactly this join (`contacts.ts:1229-1247`); the units endpoint uses
  `tours.listByUnit` (`units.ts:1008`).
- "All twelve `ContactSearchField` callers": 10 render sites in 10 files
  (`grep "<ContactSearchField" dashboard/src`, tests excluded).
- "the existing mobile e2e pins in `broadcasts.spec.ts`": that spec has no
  mobile / viewport reference (UNVERIFIED which pins are meant; possibly
  `composer-mobile.spec.ts`).
- `phones[].lastSeenAt` "is reset when staff edit a phone
  (`contactsRepo.ts:435-454`)": that code stamps it once when seeding the
  array from the legacy scalar; it is not a per-edit reset. The conclusion
  (do not reuse it) still holds.
- Section 9 says "Everything in sections 5.1-5.5 ... is independent of those
  answers", while the section is titled "the waiting list, and the row
  design" and question 5 asks Sam what belongs on a row - which is 5.5.

---

## F17. [LOW] `declinedThisProperty` adds no exclusion beyond already-sent; the combined accessible name is unspecified

**Evidence.** A decline can be recorded only on a LISTED row (5.4, 404
otherwise), and every listed pair is in `priorRecipientKeys`, which already
starts the row unchecked unless seeded (`RecipientPreview.tsx:80-93`,
`:165-169`). So "declined rows start unchecked IS the exclusion" (5.3) is
already true via Already sent; the new flag is a label. The aria-label today
is `<name> - already sent` (`RecipientPreview.tsx:419-425`); the spec gives
`<name> - not interested` but not the both-flags case it says always shows
both tags.

**What it implies.** Fine as a label; state the both-flags accessible name so
existing specs that select by `already sent` are knowingly updated.
