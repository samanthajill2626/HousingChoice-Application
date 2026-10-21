# Flyer leads design - review round 1, reviewer A (adversarial)

Spec under review: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`
(DRAFT revision 1). Repository read at `W:\tmp\flyer-leads` HEAD 9e329f41.
Read-only review: nothing edited, staged, committed or run beyond grep /
git show. The intent record was deliberately NOT read; the spec is judged on
what it says alone.

Severity is the consequence if the spec ships unfixed.

---

## 1. [HIGH] D7's "flyer row" does not exist: listing_sends is ONE row per (property, contact), and `via` is first-write-only furniture

**What is wrong.** D7 talks about "a flyer row" whose "source is `flyer`, a
third kind beside broadcast and individual", and promises "the wire carries no
`broadcastId` for it". The ledger it says it writes through has no such row:

- One row per pairing: PK unitId, SK contactId, "so a re-send can never
  duplicate" (`app/src/repos/listingSendsRepo.ts:10-12`). A flyer sign-up for a
  property the tenant was already texted lands on the SAME row as that
  broadcast.
- `via` is pair-level first-write furniture: `putShareMemory` writes
  `#via = if_not_exists(#via, :via)` with `:via` hard-coded `'broadcast'`
  (`listingSendsRepo.ts:318-326`), under the stated NO-RESET INVARIANT
  ("stamps created_at (and via) only when absent, so a later share never
  rewrites the first-write furniture", `listingSendsRepo.ts:14-16`).
- The row's `broadcastId` is not per share either: `summarize` sets it to the
  key of the LATEST counted entry, whatever share that was
  (`app/src/services/shareLedger.ts:112-120`).

So for the two mixed cases the spec never mentions:

- broadcast first, flyer later: `via` stays `broadcast`; the flyer entry is now
  the latest counted one, so `broadcastId` becomes the flyer key (or is
  REMOVED, if the key -> wire mapping treats it like `individual`). The pair
  reads `via: 'broadcast'` with no broadcastId - or with a fake one.
- flyer first, broadcast later: `via` stays `flyer` and the row carries a real
  `broadcastId`, which is exactly what D7 says a flyer row never carries.

**Evidence.** As cited above; D7 bullets "Its source is `flyer`" and "the wire
carries no `broadcastId` for it"; section 5 "Sent list: a flyer row ... carries
no `broadcastId` on the wire".

**Implies.** The builder cannot satisfy D7 as written; it will either break
the NO-RESET invariant (rewrite `via` per write) or ship a `via` that is wrong
for every mixed pair. D7 must be restated in the ledger's own model: a flyer
SHARE ENTRY on the pair's row, with an explicit rule for what `via` and
`broadcastId` read when a pair holds both kinds. Since no dashboard reader
renders `via` at all (finding 15), the simplest correct decision may be to not
touch `via`, and say so.

---

## 2. [HIGH] The 24-hour repeat rule keys on a "source" the milestone never stores, so the abuse guarantee it claims is not delivered

**What is wrong.** D6.3: "A source is the unitId, or 'join'. The check is a
query of the contact's activity events over the last 24 hours." But D6.1
stores the source only for ONE of three cases:

- shareable flyer: `refType: 'unit'`, `refId: unitId` - recoverable;
- flyer, property NOT shareable: "with no ref";
- /join: "with no ref".

`RecordActivityEventInput` has no source attribute
(`app/src/repos/activityEventsRepo.ts:99-109`). The non-shareable flyer and
the /join milestone are indistinguishable except by label text, and the
non-shareable flyer's source (the submitted unitId) is not stored anywhere.
Either the builder treats "no ref" as "join" (a /join sign-up is then wrongly
swallowed after a non-shareable flyer sign-up, and vice versa) or a
non-shareable flyer sign-up is never deduped.

The second reading breaks the planner's stated reason for the rule ("stops
someone re-submitting, or abusing a known phone number, from flooding a thread
or the inbox"): `unitId` is any caller-chosen string of 1-200 chars
(`app/src/routes/public.ts:160-167`), and any garbage id is "not shareable", so
every request with a fresh garbage id is a new source - a new milestone, a new
unread increment, a new bump to the top of the inbox, for ANY contact whose
phone the caller knows (landlords, caseworkers, team members included, D4
"Every type counts"). The only fence left is the per-IP limit, 5 per minute by
default (`app/src/lib/config.ts:1008`, `docs/issues/public-welcome-text-global-cap.md`).

Second-order cost of a flood: the relay roster job scans a contact's activity
log newest-first with a hard cap of 10 pages x 25 events and REFUSES the add
when the cap is hit (`app/src/jobs/rosterActions.ts:236-237`, `:268-295`), so
roughly 250 junk milestones (under an hour from one IP) block that contact's
pending relay-group adds.

The check is also check-then-write with no condition, so two concurrent
submits from the same source both pass (LOW on its own).

**Implies.** The spec must (a) store the source on the milestone as data (a
`source` attribute or a ref), (b) collapse every non-shareable flyer sign-up
to ONE source so a caller-chosen id cannot mint sources, and (c) list the
`activityEventsRepo` input change in section 4.

---

## 3. [MEDIUM] A public flyer sign-up silently supersedes a staff "Not interested" decline and re-checks the tenant in that property's blast

**What is wrong.** A decline stays effective "unless something LATER
supersedes it - a counted share (the row's sentAt follows the latest counted
share)" (`app/src/lib/listingSendOutcome.ts:42-58`). D7 writes a COUNTED entry
at the sign-up time, moving `sentAt` past any earlier decline. Readers that
change as a result, none of them discussed:

- the outcome chip flips from "Not interested" to "No reply yet"
  (`listingSendOutcome.ts:77`, `dashboard/src/routes/contact/Card.tsx:270-285`);
- the matching blast's decline set drops the tenant
  (`app/src/routes/broadcasts.ts:595-616`), so the property's next share
  checks them by default again
  (`app/src/lib/blastAudienceRules.ts:178-183`).

Because the endpoint is unauthenticated, anyone who knows a tenant's phone can
clear a staff-recorded decline. That runs against the principle the spec
itself cites from #14: "A public, unauthenticated form must not edit an
existing person's record" (`docs/superpowers/specs/2026-10-12-join-housing-authority-design.md:141-145`).

**Implies.** It may well be the desired product answer (they signed up again),
but it has to be a stated decision with a test, not a by-product. If not
desired, the flyer entry must not supersede a decline.

---

## 4. [MEDIUM] The sign-up is "inbound" for the inbox but not for Last heard from, so an existing "Replied" pair flips to "No reply yet"

**What is wrong.** D6.2 treats the sign-up like an inbound text (unread, bump,
"the inbound-message pattern"). But `last_heard_from_at` is "the most recent
inbound text, call or email ... Written ONLY by touchLastHeardFrom"
(`app/src/repos/contactsRepo.ts:226-230`), and the spec never touches it. The
outcome is `replied` only when last-heard-from is later than `sentAt`
(`listingSendOutcome.ts:79-82`). D7 moves `sentAt` to the sign-up instant, so:

- a tenant who replied to the property's broadcast and THEN signs up on its
  flyer is demoted from "Replied" to "No reply yet" on the tenant page and the
  property roster;
- a lead who reached out themselves reads "Sent <today> - Last heard from
  <older date>" with "No reply yet" (`Card.tsx:347-363`), and joins the
  Follow up tab 24 hours later (`FOLLOW_UP_QUIET_MS`,
  `listingSendOutcome.ts:24`, `isWaiting` `:116-131`).

D7 accepts the Follow up consequence in one line, but not the demotion of an
existing pair, and not the inconsistency with D6's own "treat it as inbound".

**Implies.** Decide whether a sign-up counts as heard-from (and pin it), or
state and test that a flyer sign-up resets a pair's reply state.

---

## 5. [MEDIUM] D3 misdescribes today's heading and silently drops the neighborhood from every flyer with an address

**What is wrong.** Goal 2 and D3 describe the current heading as "A home for
you". It is the AREA when one is recorded, and "A home for you" only as the
fallback: `<h1 ...>{hood ?? 'A home for you'}</h1>`
(`dashboard/src/routes/public/FlyerPage.tsx:302`, `neighborhood()` `:55-59`).
The prior spec made that line the neighborhood on purpose ("the neighborhood
line is `area` only", `2026-10-20-property-requirements-design.md:698`).

D3's new top-to-bottom layout shows the area only as a fallback when there is
NO address. Every flyer that has both loses the neighborhood name entirely,
while D1 says `area` "stays" in the projection - a published key nothing
renders. Nobody decided that; the spec does not say it happens.

**Implies.** State whether the area is dropped or where it goes (for example
the smaller second line), and add it to the section 5 page tests.

---

## 6. [MEDIUM] D4's soft-deleted rule contradicts itself and would erase the lost lead's only trace

**What is wrong.** D4 says a soft-deleted match "keeps today's behavior:
nothing is created, nothing is recorded, and no text is sent", then "the
sign-up is now not attempted at all". Today's behavior is not "nothing
recorded": for any existing contact, deleted or not, the route still runs
`createOrGetByParticipantPhone` + `setParticipantsIfAbsent`
(`app/src/routes/public.ts:378-379`) and ALWAYS appends the
`housing_fair_signup` audit event (`public.ts:420-427`). The open issue the
spec defers to says that audit row is "The only trace"
(`docs/issues/deleted-contact-web-signup-silent.md`, problem item 4), and #14
D7 promises the audit for an existing contact too
(`2026-10-12-join-housing-authority-design.md:146-149`).

Section 5 then tests "a soft-deleted match: nothing recorded, nothing sent",
which a builder will read as "skip the audit".

**Implies.** Say exactly which steps a soft-deleted match still runs. Keeping
the audit (with the new `existingContact` flag defined for this case) costs
nothing and keeps the deferred issue diagnosable.

---

## 7. [MEDIUM] "Existing" is decided by one arbitrary holder of a phone that live contacts can share

**What is wrong.** `findByPhone` returns "the FIRST item the GSI yields
(arbitrary order)" (`app/src/repos/contactsRepo.ts:1287-1292`). Shared numbers
among LIVE contacts are a supported state since caseworkers: the conversion
code says outright "findByPhone returns ONE arbitrary holder and cannot decide
this" and uses `findAllByPhone` instead
(`app/src/services/caseworkerConversion.ts:261-268`, `:295-303`;
`contactsRepo.ts:746-755`). D4 builds three decisions on that single
arbitrary pick:

- soft-deleted vs existing: if a deleted record and a live one share the
  number, GSI order alone decides whether the live person's sign-up is
  recorded or silently dropped;
- the D7 tenant-only rule: a tenant sharing a number with a partner gets no
  row when the partner is returned first;
- the milestone lands on the picked contact, while the conversation's
  participant (who owns the inbox row) may be the other one, so the unread
  row and the pin can sit on different contacts.

**Implies.** Either use `findAllByPhone` (prefer a live tenant, then any live
holder) or state the shared-number behavior as an accepted limit with a test.

---

## 8. [MEDIUM] D6.4's "never error on the public page" does not cover the reads and writes the spec adds

**What is wrong.** D6.4 makes "a milestone or unread write that FAILS" non-
fatal. The spec adds two more fallible steps that D6.4 does not mention:

- the 24-hour dedupe read of the activity log (D6.3);
- the ledger write: `applyShareLedgerEntry` throws on any read/write error and
  returns `'lost'` after its re-read bound (`app/src/services/shareLedger.ts:177-195`).

The route has no try/catch around new code by default; today every
unexpected repo throw on this path is the generic 500 (for example
`public.ts:378`, `:420`). As written, a throttled listing_sends read turns a
successful sign-up into an error page - the outcome the planner's call exists
to prevent.

**Implies.** D6.4 should name every new step (dedupe read, milestone, unread,
touch, emit, ledger write) and its failure answer, including what the dedupe
does when its read fails (fail open or closed).

---

## 9. [MEDIUM] The consent an existing contact just gave is discarded, so the page's promise "We'll text you" can be false for them

**What is wrong.** The form requires and the server enforces fresh A2P
consent (`public.ts:114-131`), but consent is stamped on CREATE only
(`public.ts:365-370`). D4 keeps "never CHANGED" for existing contacts and D5
removes the welcome for them. An existing contact with no `consent_method`
(a manually created tenant, or one the consent backfill left alone -
`app/scripts/backfillConsentMethod.ts:1-12` "Contacts whose capture_source
implies no method are left untouched") who checks the box:

- stays unconsented, so the matching blast never checks them by default
  (`blastAudienceRules.ts:182`: `hasConsent && ...`);
- cannot be texted by hand without staff re-attesting consent, because the
  JIT gate refuses a human send to a contact with no recorded consent
  (`app/src/services/sendMessage.ts:541-557`) - yet D6 pages staff precisely
  so they will text this person;
- is told "We'll text you about this home and others that fit your voucher"
  (D3.7).

The deferred issue already flags it: "the freshly-collected consent fields
should probably be recorded on the existing contact rather than dropped"
(`docs/issues/deleted-contact-web-signup-silent.md`, Suggested fix).
Prevalence of unconsented existing tenants: UNVERIFIED.

**Implies.** Decide explicitly whether a sign-up stamps consent on an existing
contact that has none (a fill-if-absent write, not an overwrite). Leaving it
unstated hands the builder an A2P judgment call.

---

## 10. [LOW] "For a landlord or a partner it is their own 1:1 thread" holds only when one exists; otherwise the route mints a tenant thread and now bumps it

**What is wrong.** The route always calls
`createOrGetByParticipantPhone(phone, 'tenant_1to1')` (`public.ts:378`); the
type is used only when it MINTS (`app/src/repos/conversationsRepo.ts:1277-1301`).
A landlord, partner or team member with no thread on that number gets a new
`tenant_1to1` thread, which D6.2 now marks unread and moves to the top of the
inbox. Type-keyed readers then miss it, for example the placement nudge
lookup wants `landlord_1to1` for a landlord rung
(`app/src/jobs/placementNudges.ts:514-519`). The mapping already exists
(`conversationTypeFor`, `app/src/routes/contacts.ts:537-543`). Pre-existing,
but D6 makes it visible.

Related slogan: D6.2's "as for any other non-message bump" has no precedent -
every `touchLastActivity` caller passes a message body (`app/src/routes/api.ts:2082`,
`app/src/services/sendMessage.ts:708`, `app/src/routes/webhooks/twilio.ts:2749`,
and the rest). The inbox row will show an unread badge over an old preview;
say so rather than citing a convention that does not exist.

---

## 11. [LOW] The stale-page analysis misstates the failure; the comment it overrides is left standing

**What is wrong.** D1 says an old bundle fed the new payload renders
"$undefined". Both old bundles would CRASH the render instead: the main
bundle's `textOrNull(undefined)` calls `.trim()` on undefined
(`FlyerPage.tsx:129-131`, reached by accessibility, lease terms, pet fee and
pets) and `flyerMoney(undefined)` calls `.toFixed` (`:145-147`, `:156`); the
deployed 1.5.6 bundle's `petsLabel(undefined)` does the same
(`git show 1.5.6:dashboard/src/routes/public/FlyerPage.tsx`, lines 107-114).
The conclusion still holds: the page fetches once on mount
(`FlyerPage.tsx:208-227`), staff "View flyer" opens a new tab
(`dashboard/src/routes/listing/ListingDetail.tsx:942-947`), and app and
dashboard ship in one image with uncached HTML
(`infra/modules/cloudfront/main.tf:203-211`, `Dockerfile` dashboard build).
The `UnitFlyer` doc comment still promises old bundles keep `deposit` and
`pets` (`app/src/lib/unitFields.ts:375-377`); the plan must reverse it.

---

## 12. [LOW] Goal 4 and D7 disagree on who gets the properties-sent row

Goal 4: "A flyer sign-up, from a new or an existing contact, puts the property
on the contact's properties-sent list." D7: "only a tenant gets the row".
One of them must change so the goal is not read as a guarantee.

---

## 13. [LOW] The 24-hour query has no repository read to run on

`activityEventsRepo` offers only `listByContact`, newest-first, default limit
50, no time bound and no type filter (`activityEventsRepo.ts:111-125`,
`:166-182`). A builder must page it until older than 24 hours (the
`rosterActions.ts:268-295` pattern) or add a bounded Query. Section 4 lists
the repo for "types" only; name the read.

---

## 14. [LOW] Section 4's surface list is incomplete

Not named, and each will need a change or a decision:

- `app/src/routes/dev.ts:1433-1484` (`/__dev/listing-send-fixture`) calls
  `putShareMemory` directly; if the `via` write changes its signature, the
  "dev fixture unchanged" line in section 4 is false.
- `dashboard/src/api/types.ts:3159` `ListingSendRow.via: 'broadcast' | 'individual'`.
- `app/test/unitFields.test.ts:639-670` pins the whole `UnitFlyer` shape.
- `app/test/requirements.test.ts:85-92` pins the Pets / Deposit tags.
- The property Activity card reads unit AUDIT events only
  (`app/src/routes/units.ts:310-318`); a flyer sign-up adds a "Sent to" roster
  row with no Activity entry explaining it. State whether that is accepted.

---

## 15. [LOW] The "third kind" is invisible: no reader renders `via`

No dashboard component reads `via` (only the type at
`dashboard/src/api/types.ts:3159`). A flyer row therefore reads exactly like a
text: "Sent <date>" (`Card.tsx:361`). D7's "No reader may treat it as a
broadcast" is satisfied vacuously; staff cannot tell from the sent list that
the property was never texted. If that is fine, say so; if staff should see
it, a reader must change and section 4 must list it.

---

## Claims checked and found accurate

- D4: `findByPhone` returns any type and soft-deleted contacts
  (`contactsRepo.ts:214-219`, `:1287-1314`).
- D5: today's rule welcomes an existing never-welcomed contact
  (`public.ts:327-330`, `:384`).
- D6.2: the inbound pattern is increment, then touch, then emit from the
  touched image (`twilio.ts:2742-2769`); `touchLastActivity` with no preview
  leaves the stored preview (`conversationsRepo.ts:1626-1645`); the inbox does
  a head read on any SSE event (`dashboard/src/routes/inbox/useInbox.ts:15-24`).
- D7: the Matching composer's already-sent set reads broadcasts, not the
  ledger (`broadcasts.ts:755-767`, `:823-832`).
- D2: the 35-row table, the requirement tags, and the hand-set `publicNote`
  on utilities / accessibility / lease terms in both forms
  (`requirements.ts:519-550`, `ListingEditForm.tsx:531-558`,
  `UnitCreateForm.tsx:666-693`; `RequirementsFields.tsx:153`).
- D8: `scoreArea` is the only subzone comparer (`similarUnits.ts:53-63`);
  saves trim the subzone (`unitFields.ts:301`).
