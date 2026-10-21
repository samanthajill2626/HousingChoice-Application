# Flyer leads design - adversarial review R1 (reviewer B)

Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md` (DRAFT rev 1).
Repo read at `feat/flyer-leads` @9e329f41 (worktree `W:\tmp\flyer-leads`).
Read-only review: no code, test or spec was edited; no suite was run.
`intent.md` was deliberately NOT read - the spec has to stand on its own.

Line references are `path:line` in this worktree. UNVERIFIED marks a claim I
could not prove from the code.

---

## 1. [HIGH] The 24-hour repeat rule cannot identify the source of a non-shareable flyer sign-up, so the anti-flood guarantee fails exactly where abuse lands

**What is wrong.** D6.3 says the repeat check compares a `signed_up` milestone
"from the SAME source within the last 24 hours", where "a source is the unitId,
or 'join'". D6.1 says a flyer sign-up for a NON-shareable property is recorded
"with no ref", and a /join sign-up is also recorded "with no ref". The
milestone record has nowhere else to put the source: `RecordActivityEventInput`
carries only `type`, `label`, `refType`, `refId`, `broadcastId`, `at`
(`app/src/repos/activityEventsRepo.ts:99-109`). So the stored milestone of a
non-shareable flyer sign-up is indistinguishable from a /join one, and it does
not carry the unitId the rule says is its source.

Whichever way a builder resolves it, the stated guarantee breaks:
- Treat "no ref" as `join`: a /join sign-up and a non-shareable flyer sign-up
  dedupe against each other (wrong, but harmless).
- Treat the posted unitId as the source (stored somewhere the spec does not
  define): `unitId` is any string of 1-200 chars (`app/src/routes/public.ts:160-167`),
  and a missing/junk id is accepted and degrades silently to "not shareable"
  (`public.ts:310-319`). Every distinct junk id is a new source, so the rule
  dedupes nothing.
- Never dedupe the no-ref case: same result.

The spec frames the non-shareable case as "a race, since that flyer would show
'no longer available'". It is not only a race: it is the case any scripted POST
with a made-up unitId reaches, which is the abuse the rule exists for
("abusing a known phone number from flooding a thread or the inbox").

**Impact if shipped.** The public endpoint is unauthenticated and limited to 5
requests per minute per IP by default (`app/src/lib/config.ts:1008`,
`app/src/app.ts:185-191`), i.e. ~7,200 per IP per day. Anyone who knows a
contact's phone - a landlord's, a team member's, a tenant's - can, per IP,
plant thousands of pins a day in that contact's thread, each carrying
ATTACKER-CHOSEN text (D6.1 puts the typed first and last name, up to 100 chars
each, `public.ts:89,133-140`, into the label verbatim), and bump the thread
unread to the top of the inbox each time, firing a `conversation.updated` SSE
event to every connected dashboard (the badge recount is the app's
highest-frequency read, `app/src/lib/unreadFeed.ts:18-27`). Today the same
request leaves no visible trace for an existing contact (`public.ts:324-330`,
`384`). Even with a correct source key, the attacker-text pin is still
available once per shareable unit per 24h per victim, which deserves a
sentence in the spec.

**Implies.** The spec must (a) define the source key for every case, including
a non-shareable/missing unitId (one bucket, e.g. "flyer, unavailable", not the
raw id), (b) say where that key is stored on the milestone (a new attribute on
the activity row, since `refId` is deliberately absent), and (c) state the
accepted residual for the attacker-text pin.

---

## 2. [HIGH] "Its source is `flyer`, a third kind" contradicts how `via` and `broadcastId` actually work: they are PAIR attributes, a flyer is a SHARE

**What is wrong.** D7 says the flyer row's "source is `flyer`, a third kind
beside broadcast and individual", that "the wire carries no `broadcastId` for
it", and that it is written "through the same ledger path every share uses
(`applyShareLedgerEntry` -> `putShareMemory`)". In the code:

- A `listing_sends` row is one per (unit, contact) PAIR
  (`app/src/repos/listingSendsRepo.ts:10-12`). A flyer sign-up would be one
  ENTRY in that pair's `shares` map, next to any broadcast entries.
- `via` is first-write furniture: `putShareMemory` sets
  `#via = if_not_exists(#via, :via)` with `:via` hard-coded `'broadcast'`
  (`listingSendsRepo.ts:318,326`), under the documented NO-RESET INVARIANT
  (`listingSendsRepo.ts:14-16`). The harness fake mirrors it
  (`app/test/helpers/twilioWebhookHarness.ts:3624,3631`). Today even the dev
  "individual" fixture is stored `via: 'broadcast'` (`app/src/routes/dev.ts:1466-1476`).
- The row's `broadcastId` is DERIVED by `summarize`: the key of the latest
  counted entry, unless that key is literally `individual`
  (`app/src/services/shareLedger.ts:112-120`, the mapping at `:119`).

So:
- A pair first sent by broadcast, then flyer-signed-up: `via` stays
  `broadcast` forever; the flyer entry becomes the latest counted one, and
  `summarize` writes the flyer entry's KEY into `broadcastId`, which
  `toListingSendRow` puts on the wire (`listingSendsRepo.ts:260`).
- A pair created by a flyer sign-up, then broadcast: if `via` is made
  `flyer`, it stays `flyer` after the broadcast and the row then carries that
  broadcast's `broadcastId` - a `flyer` row WITH a broadcastId, the exact thing
  D7 forbids.
- Making `via` follow the latest share breaks the NO-RESET INVARIANT, which the
  spec never mentions.

The spec also leaves the entry shape open: the share key name, and `by`. If a
builder picks `by: 'delivery'` ("they have seen it"), `mayReplace` makes the
entry terminal (`shareLedger.ts:80`) and "a later one moves `sentAt` forward"
(D7) silently stops working.

Finally, nothing reads `via` at all: the app only copies it to the wire
(`listingSendsRepo.ts:259`) and the dashboard only types it
(`dashboard/src/api/types.ts:3159`). The "third kind" would be invisible to
every staff surface (see finding 3).

**Implies.** Decide and write down: is "flyer" a property of the pair (then
say which write sets it and whether it survives a later broadcast) or of the
entry (then `via` is irrelevant and the guarantee is "the `summarize` mapping
treats the flyer key like `individual`")? Name the share key, require
`state: 'counted', by: 'acceptance'`, and state how `summarize` maps the key.
`shareLedger.ts` is in the surface list as "the key -> wire mapping", but the
decision itself is missing.

---

## 3. [MEDIUM] Every sent-list reader renders a flyer sign-up as an unanswered outbound text: "Sent - Last heard from Never - No reply yet", then "waiting on a reply"

**What is wrong.** D6 treats a sign-up as inbound enough to mark the thread
unread "using the inbound-message pattern", but nothing in the spec makes it
count as hearing from the person. `last_heard_from_at` moves only on an inbound
MESSAGE row (`app/src/lib/heardFrom.ts:60-64`; GLOSSARY "last heard from",
`documentation/GLOSSARY.md:602-614`: "Outbound and automated traffic never move
it"), and the sign-up writes no message. The flyer row's `sentAt` is the
sign-up instant, and "Replied" needs `last_heard_from > sentAt`
(`app/src/lib/listingSendOutcome.ts:67-83`), so the sign-up itself can never
make its own row read Replied.

The readers then show, for someone who reached out a minute ago:
- `SendRosterRow` (contact page and property page): "Sent <date> - Last heard
  from Never" with the outcome chip "No reply yet"
  (`dashboard/src/routes/contact/Card.tsx:345-367`);
- the Follow up tab and the Properties list "<n> waiting" pill, 24 hours later,
  "waiting on a reply" since the sign-up (`app/src/services/followUps.ts:170-196`,
  `listingSendOutcome.ts:116-131`).

D7 accepts the Follow up consequence in one sentence, but no reader is told
how a flyer row should READ, and the spec names a "source" that no renderer
shows (finding 2). Staff will believe the property was texted to the tenant
and that the tenant has gone quiet.

**Implies.** Either decide that a sign-up counts as heard from (and say which
writer moves `last_heard_from_at`), or give the renderers flyer wording, or
state explicitly that the row reads exactly like an unanswered text. This is a
reader that disagrees with the new rule, not additive scope.

---

## 4. [MEDIUM] The "query over the last 24 hours" has no repo support, and its failure mode is unspecified

**What is wrong.** D6.3 says "the check is a query of the contact's activity
events over the last 24 hours". `ActivityEventsRepo` has only `record` and a
newest-first `listByContact` with an upper bound (`before`) and a default
limit of 50, returning no continuation key
(`app/src/repos/activityEventsRepo.ts:111-125,166-182`). A lower-bound query
(`tsEventId > <now-24h>`) is a new repo method, plus its harness fake
(`twilioWebhookHarness.ts:3562-3590`), which the harness integration test holds
to the real repo. Section 4 lists only "`activityEventsRepo` types". A builder
who reuses `listByContact` with its default limit misses an older `signed_up`
behind 50 newer milestones (a busy tenant gets `listing_sent` per share).

D6.4 covers a failed milestone or unread WRITE ("does not fail the request").
It says nothing about a failed dedupe READ. If it propagates, the public page
shows an error - contrary to the planner's call that "the sign-up must never
error on the public page" - and if it is swallowed, it must be decided whether
that fails open (record, maybe flood) or closed (drop the lead's trace).

The check-then-record is also not atomic: two concurrent submits both see no
milestone and both record and increment (LOW on its own).

**Implies.** Name the repo method and its bound, add it and the fake to
section 4, and state the read-failure behavior.

---

## 5. [MEDIUM] An existing contact's web-form consent is thrown away, and the follow-up D6 invites runs into the JIT consent gate

**What is wrong.** The form enforces `smsConsent === true`
(`public.ts:127-131`) and records `consent_method: 'web_form'` only on CREATE
(`public.ts:368-370`); D4 keeps "an existing contact is never CHANGED". Today
that gap is hidden because the existing, never-welcomed contact gets the
automated welcome, which skips the JIT gate (`app/src/services/sendMessage.ts:542-557`:
automated sends are not gated). D5 removes that welcome. D6 then surfaces the
contact as unread so staff follow up by hand - and a HUMAN send to a contact
with no `consent_method` is refused `contact_no_consent`
(`sendMessage.ts:551-556`). Contacts with no consent are real: the manual
create makes `consent_method` optional (`app/src/routes/contacts.ts:342-349`).
So staff are asked to re-attest consent the system received seconds ago and
discarded. The open issue on the deleted-contact case already recommends
recording the fresh consent on the existing contact
(`docs/issues/deleted-contact-web-signup-silent.md:51-52`).

D5's "Staff can text them by hand" is true for a NEW contact (consent stamped
at create), not for an existing one without consent.

**Implies.** Decide whether a sign-up stamps consent on an existing contact
that has none (a narrow exception to the #14 "never changed" rule) or state
the JIT-modal friction as accepted.

---

## 6. [MEDIUM] "For a landlord or a partner it is their own 1:1 thread" is false when they have no thread: the route creates a `tenant_1to1` one and D6 now surfaces it

**What is wrong.** The route always calls
`createOrGetByParticipantPhone(phone, 'tenant_1to1')` (`public.ts:378`). That
returns the phone's existing thread when one exists
(`app/src/repos/conversationsRepo.ts:1277-1334`), so the spec's sentence holds
only then. For an existing landlord, partner (caseworker) or team member with
no 1:1 thread yet - e.g. a caseworker created from an org list, an imported
landlord - the route CREATES a thread typed `tenant_1to1`. Every other
call site derives the type from the contact (`conversationTypeFor`,
`app/src/lib/voiceMasking.ts:28-39`; e.g. `app/src/routes/webhooks/twilio.ts:2252`).
The type is not repaired later (the only re-typer is caseworker conversion,
`app/src/services/caseworkerConversion.ts:383`), and it gates behavior: a fresh
inbound on a `tenant_1to1` thread schedules AI fact extraction
(`twilio.ts:2792-2795`), which is excluded for landlord threads by type.
Whether extraction would then write tenant facts onto a landlord is
UNVERIFIED.

This creation is pre-existing, but until now it was silent. D6 deliberately
extends the flow to landlords, partners and team members, bumps that thread to
the top of the inbox and marks it unread - and the spec asserts the invariant
that does not hold.

**Implies.** Either use `conversationTypeFor(existing)` when resolving the
thread for an existing contact, or correct the sentence and accept the
mistyped thread.

---

## 7. [MEDIUM] The spec misdescribes today's flyer heading, and the change silently stops showing the area

**What is wrong.** Goal 2 and D3 say "the address is the heading (the 'A home
for you' heading is gone)". Today the heading is the AREA, and "A home for
you" is only the fallback: `<h1>{hood ?? 'A home for you'}</h1>`
(`dashboard/src/routes/public/FlyerPage.tsx:302`, `neighborhood()` at `:57-59`).
The e2e suite pins the area heading
(`e2e/tests/dashboard-next/public-pages.spec.ts:217`), and the GLOSSARY calls
`area` the flyer's "neighborhood line" (`documentation/GLOSSARY.md:199-201`).

Under D3 the area shows only when there is no address at all (fallback 2). D3's
top-to-bottom list (photos, heading, same-day line, facts, authorities, detail
rows) has no other place for it. So for every property with an address, the
neighborhood disappears from the flyer, while D1 says `area` stays in the
projection. Nowhere does the spec say the neighborhood is removed from the page.

**Implies.** State the decision. Either keep the area on the page (e.g. a line
under the heading), or say it is now only a fallback, then update the GLOSSARY
and `public-pages.spec.ts:217`. A spec built on "the 'A home for you' heading
is gone" will be reviewed against the wrong baseline.

---

## 8. [MEDIUM] For a soft-deleted match, "keeps today's behavior" and "the sign-up is now not attempted at all" cannot both hold, and the only trace may be removed

**What is wrong.** D4 says a soft-deleted match "keeps today's behavior: nothing
is created, nothing is recorded, and no text is sent", then "the sign-up is
now not attempted at all". Today, for a deleted match, the route still runs
`createOrGetByParticipantPhone` (which CREATES a conversation if the phone has
none, `public.ts:378`), `setParticipantsIfAbsent` (`:379`), attempts the
welcome when the contact was never welcomed (refused `contact_deleted`,
`sendMessage.ts:537-540` - and makes no attempt at all when
`housing_fair_welcomed` is true, `public.ts:384`), and appends the
`housing_fair_signup` audit event (`public.ts:420-427`).

The open issue names that audit row as "the only trace" of a deleted
contact's sign-up (`docs/issues/deleted-contact-web-signup-silent.md:42`), and
`app/scripts/backfill-join-housing-authority.ts:226` reads
`housing_fair_signup` events. A builder who implements "not attempted at all"
as an early return deletes that trace; one who "keeps today's behavior" still
creates conversations and writes the audit. The audit section of section 4
(`existingContact`, `recorded`, `sentRecorded`) does not say what a deleted
match records either.

**Implies.** Say exactly which steps a deleted match runs (I recommend: no
conversation write, no send, audit kept with `existingContact: false` and a
`deleted: true` flag) and correct the "today's behavior" sentence.

---

## 9. [LOW] The stale-page reasoning misstates what the old page does: it crashes, it does not print "$undefined"

**What is wrong.** D1 says an old bundle fed the new payload would render
"$undefined". Before reaching the rent fact, the old page calls
`petsLabel(flyer)` -> `textOrNull(flyer.pets)`, and `textOrNull` does
`v === null || v.trim() === ''` (`FlyerPage.tsx:129-131,136-137,281`). With
`pets` undefined, `undefined.trim()` throws during render (likewise
`pet_fee`, `accessibility`, `lease_terms` at `:282,290-291`): a blank page, not
a "$undefined" line. The window argument itself holds up: the dashboard is
served from the app container (`app/src/app.ts:248-304`), the deploy swaps one
container (`scripts/deploy.mjs:19-24`), CloudFront caches nothing on the
default behavior (`infra/modules/cloudfront/main.tf:199-209`), the service
worker does no precaching (`dashboard/src/main.tsx:22`), and "View flyer" is a
`target="_blank"` full load (`dashboard/src/routes/listing/ListingDetail.tsx:942-947`).
This also departs from the projection's own documented rule that old bundles
are served by "only ADDS keys" (`app/src/lib/unitFields.ts:375-377`).

**Implies.** Correct the consequence (white page), keep the acceptance if the
window is judged negligible, and update the `unitFields.ts:375-377` comment,
which will otherwise state a rule this change breaks.

---

## 10. [LOW] A counted flyer entry changes ledger-derived state the spec does not enumerate

- **Decline supersession.** A recorded "Not interested" stops counting when a
  later counted share moves `sentAt` (`listingSendOutcome.ts:47-58`). A flyer
  sign-up for that property (past 24h) therefore clears a staff or engine
  decline, re-checks the tenant by default in the Matching blast for that
  property (`app/src/routes/broadcasts.ts:595-618`,
  `app/src/lib/blastAudienceRules.ts:178-183`) and returns the row to Follow up.
  Arguably right (they asked about the home), but it is a mutation of a
  staff-recorded state by a public form and should be stated.
- **Pre-branch "Property text failed" pins.** A tenant pin with no share id
  takes its words from the PAIR: `row.counted === false ? 'Property text failed'
  : 'Property sent'` (`app/src/routes/contactTimeline.ts:732`). Once a flyer
  entry counts the pair, an old failed-text pin re-reads "Property sent".
- **The repair census** (`app/scripts/repair-share-outcomes.ts:826,848`) runs
  `ledgerWouldChange`/`summarize` over all entries, so a counted flyer entry
  changes its uncount/recount forecasts. This reader is missing from section 4.

---

## 11. [LOW] Goal 4 overstates D7, and excluding `unknown` is permanent

Goal 4: "A flyer sign-up, from a new or an existing contact, puts the property
on the contact's properties-sent list". D7 then limits the row to tenants (and
shareable units). The excluded set includes the auto-captured `unknown`
contact - someone who texted first, then filled in a TENANT intake form. That
is plausibly the most common existing non-tenant sign-up. D4 forbids retyping
them, and nothing adds the row when staff later retype them as tenant, so for
these leads "it counts as sent" is lost for good. Planner's call, but the goal
text should match the rule, and the permanence should be stated.

---

## 12. [LOW] incrementUnread before touchLastActivity can leave an invisible unread resident

D6.2 copies the inbound order: `incrementUnread`, then `touchLastActivity`
(the touch is what sets `status = 'open'`, `conversationsRepo.ts:1633-1637`).
`isUnreadVisible` requires `status === 'open'` for a 1:1
(`unreadFeed.ts:309-317`). If the thread was closed and the touch fails after
the increment succeeded, D6.4 swallows the error and the thread sits flagged
unread in `byUnread` but invisible, until some later inbound reopens it - the
residue class `app/src/lib/markUnread.ts:6-13` exists to prevent. Rare, but
the sign-up path has no message to justify the inbound shortcut: say whether
touch-then-increment (or the conditional `setUnread`) is acceptable.

---

## 13. [LOW] Gaps in the heading specification

- Zip-only address: "no street line, but a city or state" and "no address at
  all" both miss it. Which fallback applies?
- The removed Address row carried an sr-only " - open in Google Maps" suffix
  for WCAG 2.5.3 and new-tab disclosure (`FlyerPage.tsx:337-346`). D3 makes the
  whole heading a `target="_blank"` link and says nothing about its accessible
  name.
- `addressLines` (`FlyerPage.tsx:82-87`) loses its only caller, but the
  deletion list names `petsLabel`, `depositLabel` and `rentRange` only
  (`flyerMoney` must stay - `applicationFeeLabel` uses it).

---

## 14. [LOW] Section 4 misses surfaces the mechanism needs

- `dashboard/src/api/types.ts:3159` - the dashboard `ListingSendRow.via`
  mirror (`'broadcast' | 'individual'`).
- `app/src/routes/dev.ts:1466-1476` - a `putShareMemory` caller. The spec says
  "the dev fixture [is] unchanged", which holds only if the `via` change does
  not alter the signature.
- `app/test/helpers/twilioWebhookHarness.ts:3601-3636` (the listing-sends fake
  hard-codes `via: 'broadcast'`) and `:3562-3590` (the activity-events fake
  needs the new bounded query), plus the integration test that holds the fakes
  to the real repos.
- `app/scripts/repair-share-outcomes.ts` (finding 10).
- `app/src/lib/unitFields.ts:375-377` - the "only ADDS keys" comment (finding 9).

---

## 15. [LOW] GLOSSARY drift is not in the plan

AGENTS.md requires the GLOSSARY to change in the same change that fixes drift
or adds a domain noun. `documentation/GLOSSARY.md:198-201` says "`lease_terms`
is PUBLIC: the flyer shows it as 'Lease terms'" and that the flyer's
neighborhood line is `area`; `:219-221` says the Pets item and the deposit
fields reach the public flyer. All three go false. The new "flyer" send kind,
if kept (finding 2), and the `signed_up` milestone are new vocabulary. Section
4 does not list `documentation/GLOSSARY.md`.

---

## Checked and found consistent (no finding)

- D4: `findByPhone` returns soft-deleted contacts and every type
  (`contactsRepo.ts:1287-1314`; `twilio.ts:517`).
- D5: today's rule welcomes any existing contact never welcomed
  (`public.ts:329,384`).
- D2: the forms hand-set `publicNote` on Tenant-paid utilities, Accessibility
  and Lease terms (`ListingEditForm.tsx:527-531,545,558`;
  `UnitCreateForm.tsx:666,680,693`), and `RequirementsFields` derives it from
  text AND `on_flyer` (`RequirementsFields.tsx:153`). The parity walk is
  output-diff based (`app/test/propertyFormFlyerParity.test.ts:148-170`) and
  pins 35 rows (`:175`).
- D7 known limit: the Matching "already sent" flag reads broadcasts only
  (`broadcasts.ts:822-842`, `broadcastsRepo.ts:441-446`).
- D8: `scoreArea` compares raw strings today (`similarUnits.ts:53-65`), the
  form save trims the subzone (`unitFields.ts:300-309`), no other app or
  dashboard reader compares subzones, and the "Same subzone" text is
  `similarUnits.ts:126`.
- Broadcast flyer links carry `?cta=text` (`app/src/lib/mergeFields.ts:28-31`),
  so the form variant reaches existing tenants mainly through forwarded bare
  links, as the spec's "Why" says.
- The inbox row for a contact of type `unknown` is kind `contact` and links to
  the contact page, where the pin renders (`dashboard/src/routes/inbox/InboxRow.tsx:44-55`;
  `app/src/routes/inbox.ts:1146-1170`).
