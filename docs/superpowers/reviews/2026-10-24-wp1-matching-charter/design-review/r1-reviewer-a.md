# WP1 matching charter - design review round 1, reviewer A (adversarial)

Spec: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
(cited as "spec L<n>"). Contract: Amendment No. 1, WP1 section (cited as
"A1 L<n>" against the signed text extract). Code cited by file:line as read
in W:/tmp/wp1-matching-charter at b1ee9394. The design-conversation records
were NOT read; every finding stands on the spec, the contract and the code.

Severity is consequence-if-shipped-unfixed.

---

## 1. [BLOCKING] Pool rule "an empty list on the property takes every size" contradicts the one server reader of a unit's voucher sizes

What is wrong. Section 5 (spec L134-137), a decision 15.4 says no slice may
reopen, defines the property's side of the size rule as "an empty list on the
property takes every size", and calls it "the blast rule". The code has one
reader of a unit's sizes and it does not work that way: a unit with no
recorded `voucher_size_accepted` takes its `beds` count, not every size.

Evidence.
- app/src/lib/unitFields.ts:453-478 `acceptedVoucherSizes`: (1) the recorded
  list, (2) "otherwise its bedroom count (`beds`) - the import never writes
  the field", (3) otherwise []. The comment at L466-467 says "Server code
  reads a unit's voucher size ONLY through this function."
- The flyer derives `voucher_sizes` from it (unitFields.ts:486). The current
  composer fills its size chips from the property through the dashboard copy
  of the same function (BroadcastComposer.tsx:41, `acceptedVoucherSizes`).
- The "blast rule" the spec cites (blastAudienceRules.ts:254-265
  `voucherSizeMatches`) acts on a broadcast FILTER's list, not on a unit. An
  empty FILTER filters nothing. That is a different statement from "an empty
  unit list takes every size".
- Spec section 2 (L60-61): "10 of the 22 record no accepted voucher size."
  Read through the spec's rule, those 10 properties pool every searching
  tenant of every voucher size. Read through the existing reader, they pool
  the size that matches their bedrooms.

What it implies. Follow the charter and B2 breaks the "ONLY through this
function" invariant. The ranking pool then disagrees with the flyer, with
today's composer prefill and with the property page, for nearly half the
live inventory. A 4-BR voucher holder enters a 1-bed's pool, and the model
is paid to score that pair. Follow the code instead and the slice has
reversed a locked decision. The production pool numbers in section 2 (median
104, worst 493) carry no note of which rule produced them, so they do not
settle it either. The completeness pass (7.3, "accepted voucher sizes"
missing) has the same ambiguity: is a unit that falls back to beds missing
the input or not? Decide before B2.

## 2. [BLOCKING] Sam's reviewed matches become a "training set" exported outside the app and committed as worked examples: real client PII in the repository

What is wrong. Section 12 (spec L476-480) says reviews "are a TRAINING SET
that lives outside the application data: the Rankings page exports them, and
a person chooses which become worked examples in the next versioned examples
file beside the rubric". Section 7.2 (L277, L301-303) puts the rubric and
examples files "in the app workspace", that is, in git. A review snapshot is
a real pair's score and reasons. The cards it was scored from carry the
tenant's name and whole address (6.1 L180-182, 7.2 L292-293), extracted
facts, staff notes and requirement notes.

Evidence. A1 L293-300: Agreement section 7.3 "prohibits real tenant or
landlord data in development and test environments". The one carve-out is
ANONYMIZED test conversations, "with names, phone numbers, addresses, and
other identifiers removed or replaced before use". The same paragraph ends:
"Nothing in this Amendment permits Client data to be used to train any AI
model." The spec has no anonymization step, no rule on what leaves the app,
and no rule on where an export may be stored.

What it implies. As written, B2 builds an export of real client data, and
the review path leads a person to commit real tenant data into the
repository. That repository is a development environment that the fake
driver, e2e and every worktree read. Few-shot examples are not training in
the model sense, but the spec's own word "training set" invites exactly the
reading the contract prohibits. The charter has to decide whether worked
examples are anonymized (and by whom, and when), and where an export may
live, before B2 builds the export.

## 3. [HIGH] Fingerprinting "an outcome" contradicts two stated guarantees, because the outcome is derived from last-heard-from and send time

What is wrong. Section 10.3 (L442-445) says an outcome on the pair history
changes the fingerprint, but "A new send ALONE does not make a match out of
date". Section 9.1 (L353-355) says "a new text from a tenant never makes
their matches out of date". In the code, the outcome is not a stored value.
It is DERIVED, and its inputs are exactly a new text and a new send.

Evidence. app/src/lib/listingSendOutcome.ts:
- L49-63 `effectiveDecline`: a recorded decline stops counting once a LATER
  counted share exists (`declinedMs < sentMs` returns false). A new send
  therefore flips not_interested to no_reply or replied.
- L74-91 `deriveListingSendOutcome`: `heardMs > sentMs` gives 'replied'. Any
  inbound text after a send flips no_reply to replied, on every pair sent to
  that tenant.
- A tour for the pair gives 'interested' (L86).

What it implies. If the derived outcome is what gets fingerprinted, both
guarantees are false. If the fingerprint instead uses some other "recorded
outcome", the spec has not named it, and the derived outcome Sam sees on the
row will disagree with the one the model read. One further consequence:
re-sending a property Sam earlier marked Not interested (the "maybe, rise
again" case in section 4) erases the decline from the derived outcome.
Section 6.3 assumes the decline stays on the pair history for the model to
read. It does not.

## 4. [HIGH] "Every send with its recorded outcome and extracted reaction" (pair history, 6.3) has no store, and the per-send reaction B1 writes has no home

What is wrong. Section 6.3 (L218-222) feeds the model "every send (date,
the recorded outcome, and the extracted reaction ...)". Section 6.4 (L237-238)
and B1 (L571) write "one reading per send ... to the pair history". The
existing pair record does not hold this.

Evidence. app/src/repos/listingSendsRepo.ts:
- L3-12: ONE row per unit-contact pair.
- L18-25: `declined` is a single field written only by
  setDeclined/clearDeclined. "A cleared decline's history lives in the
  activity / audit events, never on the row."
- The `shares` map (L64-75, L104-105) holds per-share attempt state and
  countedAt, but no outcome per send. The outcome is one derived value per
  pair (listingSendOutcome.ts:74).
- A decline already has a `by: 'staff' | 'engine'` slot (listingSendsRepo.ts:
  163, 246; DeclineRecord in listingSendOutcome.ts:33-37), and the dashboard
  renders "Not interested (auto)" (dashboard/src/routes/contact/Card.tsx:284).
- A1 L201-202 (WP3) requires engine-read declines to be "recorded in the
  decline tracking from Work Package 1".

What it implies. "Outcome per send" does not exist and cannot be read back
from listing_sends. B1 cannot write a per-send reaction without someone
first deciding where it lives: a new attribute on the pair row, an audit
event, or a new store (and a new store is infra, which section 12 L474 gates
behind Cameron). The charter also leaves open how an extracted "hard no"
relates to the existing `declined.by: 'engine'` record. One option sets a
decline. The other only notes a reaction, which leaves WP3 to rebuild
decline tracking WP1 was meant to deliver. These are charter-level
decisions.

## 5. [HIGH] Section 17 claims to list where the charter reads the signed text loosely; it misses at least six deviations

What is wrong. Section 1 (L52-53) and section 17 present three loose
readings as the complete set for Sam to hear. Read against the signed WP1
text, the charter departs from it in more places than that.

Evidence (contract vs spec):
- Onboarding tenants. A1 L99-100 excludes only tenants "not in Onboarding or
  Searching", so onboarding tenants are IN. Spec L132-133 excludes them.
  Existing blasts include them too (blastAudienceRules.ts:22
  `BLAST_TENANT_STATUSES = ['searching', 'onboarding']`;
  broadcasts.ts:14-16).
- Tour holds. A1 L100-101 excludes tenants with "an upcoming tour or a past
  tour without an outcome". Spec L157-158 makes "tour outcomes" an input
  only. Existing code holds those tenants unchecked
  (blastAudienceRules.ts:59-131 tour holds, L163-165 checkedByDefault).
- Already sent / declined. A1 L93-94 says properties are "excluded or
  demoted AUTOMATICALLY" when already sent or declined, and A1 L47-48 (the
  objective) says "send the best one in a single step without checking what
  was already sent or declined". Spec L105-113 does neither automatically:
  the model weighs Not interested as an input, and it is "never forced into
  Weak".
- The 90-day window. A1 L97-99 uses last heard from to RANK ("tenants in an
  active conversation rank above those who have gone quiet"). Spec L140-142
  and L348-350 EXCLUDE quiet tenants by default.
- Priority. A1 L103 says the flag pushes "a property to the top of every
  ranking it qualifies for". The spec default `within_band` (L369-370) only
  sorts first inside a band.
- Landlord requirement notes. A1 L104-105 and L95-96: the ranking "reads ...
  the free-text requirement notes on the landlord and property". Spec L212-214
  defaults the landlord card OFF, and L635 puts it under "Explicitly later".
  See finding 6.
- "Each ranking is recorded so Client can review it" (A1 L106). The spec
  overwrites pair rows on every re-score (L436-438) and keeps runs 90 days
  (L455-457). An unreviewed ranking is recoverable only from run raw output,
  and only until the run expires.

What it implies. Sam signs off section 16 believing she has heard every
departure from what she signed. The amendment's acceptance is a good-faith
review against "the description of the work package" (A1 L72-77), so an
unlisted departure is a dispute waiting to happen. Each item needs to be
listed in section 17 or brought back in line with the contract.

## 6. [HIGH] Landlord-recorded requirements are not read in WP1, and the charter contradicts itself about whether that is decided

What is wrong. Section 6.2 (L212-214) builds `RANKING_LANDLORD_CARD` with
default OFF, "decided with Sam", and section 16 Q6 (L617) asks Sam "on or off
to start?". Section 18 (L635) lists "Landlord card switched on" as
"Explicitly later (not WP1)". Both cannot hold: either Sam decides in WP1, or
switching it on is out of scope.

Evidence. Landlord requirements live on the LANDLORD contact as `req_*`
keys (contactsRepo.ts:360-374; requirements.ts:35-36 `landlordKey: 'req_' +
key`). They reach a unit only when staff press Apply
(routes/contactRequirementsApply.ts:1-16). A1 L95-96 excludes on "a
requirement recorded for that landlord or property". A1 L104-105 reads "the
free-text requirement notes on the landlord and property".

What it implies. With the switch off, every landlord requirement nobody has
Applied to a property is invisible to the ranker. That is a signed WP1 input
silently dropped, and it is not in section 17. Resolve the contradiction:
either switching it on is in WP1, decided with Sam, or the omission goes in
section 17.

## 7. [HIGH] B4 removes the filter-only audience without enumerating what that audience path carries today

What is wrong. Section 13.1 (L501-504) says "The existing filter-only
audience (status, authority, voucher size) is removed in B4; the pool rules
and the window toggle replace it." The B3 and B4 rows (L573-574) list "Send
property action on the tenant record" and "on the property record" as new
work. The composer and its audience path do much more than filter, and the
spec names none of it.

Evidence (all existing):
- Partners. Hand-picked seeds and explicit recipient lists may name
  PARTNERS of any status (broadcasts.ts:21-23, spec 2026-10-06 D20). A
  partner record already has "Send a property to this partner"
  (dashboard/src/routes/contact/PartnerFile.tsx:178;
  ContactDetail.tsx:1284-1286). The charter's anchors are "a tenant or a
  property" (5, L151-155). A partner anchor, and partner recipients on a
  property anchor, are undefined.
- The tenant entry already exists: "Send a property to this tenant"
  (TenantFile.tsx:320) navigates to `/broadcasts/new?contactId=` (a
  seeds-only draft, BroadcastComposer.tsx:13-15).
- The property entry already exists (ListingDetail.tsx:438 goToSend).
- Seeds and "Add a tenant", where a hand pick starts checked
  (RecipientPreview.tsx:13, 276-355; blastAudienceRules.ts:160-165).
- D4 tour holds and the D5 default-unchecked rule (blastAudienceRules.ts:
  59-165); the consent cue and the fan-out consent fence
  (audienceResolution.ts:84-90; broadcastFanOut.ts:276).
- Stored drafts carrying `audience_filter`, resumed by `?draftId=`
  (BroadcastComposer.tsx:15; BroadcastsList.tsx:39); the API-only
  filter-resolve send path (c) (broadcasts.ts:1205-1206); follow-ups
  (broadcasts.ts:12).

What it implies. Each item is a surface where B4 either regresses shipped
behavior or has to invent a decision the charter calls locked (13.1 is in
15.4). At minimum the charter must decide four things: what a partner
anchor or partner recipient is; whether seeds and hand-adds survive next to
a ranked pool; whether tour holds and default-unchecked survive as
selection defaults; and what happens to stored filter drafts.

## 8. [HIGH] The pool drops the TCPA fences that the audience resolver applies first, so unsendable tenants are ranked and paid for

What is wrong. Section 3 (L80-81) and section 5 (L127-128) say "Being out of
the pool is the ONLY exclusion in WP1" and "Nothing else removes a
candidate". The pool rules check status, size, authority and window. None of
them is opted out, unreachable, phone-less or no consent. B4 then removes
the resolver that applies those fences (13.1).

Evidence. audienceResolution.ts:7-10: "Opted-out (STOP) and unreachable
contacts are ALWAYS excluded here, at audience resolution, as the first TCPA
fence (sendMessage's opt-out gate is the second fence per recipient)". The
code is at L189-193. The fan-out excludes no-consent recipients
(broadcastFanOut.ts:276). Follow-up eligibility applies the same fences
(listingSendOutcome.ts:122-139 `isEligibleRecipient`).

What it implies. A STOP'd or unreachable tenant can rank at the top. Sam
selects them and the send drops them, so she sees the pick fail at send time.
Each such tenant is also a paid model candidate. Removing the first fence
leaves one layer of defense where today there are two. The charter should
either make these fences pool rules, or state that they are display and
selection fences the ranked row enforces. "Only exclusion" is not acceptable
for opt-out.

## 9. [HIGH] "Any record can be the anchor ... nothing is blocked" conflicts with the send-time availability refusal

What is wrong. Section 5 (L151-155) and section 13.1 (L498-499) say a
property that is not available can be the anchor, the composer "ranks
anyway", and "nothing is blocked".

Evidence. broadcasts.ts:1181-1192 refuses a send with 400
`unit_not_available` when the unit is missing, deleted or not in
SHAREABLE_STATUSES ("the flyer link stamped into every recipient's message
only resolves while the unit is SHAREABLE"). The public flyer returns 404 for
the same set (public.ts:843-849). SHAREABLE_STATUSES is `available` only
(unitsRepo.ts:56-64).

What it implies. On a non-available property Sam pays for a ranking, picks
tenants, and the send is refused. Alternatively B4 removes the guard and
sends a flyer link that 404s. The charter must decide which: rank but block
the send (and say so in the banner), or keep the "nothing is blocked" claim
and handle the flyer.

## 10. [HIGH] The fair-housing guarantee is a prompt sentence; the cards deliberately carry proxies, and nothing verifies it

What is wrong. Section 7.2 (L289-299) states that protected characteristics
"never lower a score". The only mechanism is a line in the rubric. The
spec's own choices then pass the strongest proxies: names (L292-293), whole
addresses on BOTH cards (L180-182, where the tenant's CURRENT address is a
neighborhood and race proxy with little matching value beside the separate
area preference), staff notes, and "everything on the tenant contact except
the exclusions" (L190). The tenant record has open-ended content:
`customFields` and `relationships` (ContactDetail.tsx:1274-1275,
CustomFieldsCard/RelationshipsCard), and staff_notes (contactsRepo.ts:169).

What it implies. "Never lower a score" is a guarantee the mechanism cannot
deliver and the spec never tests. The contract builds adversarial
fair-housing tests for the WP2 engine (A1 L166-170). The WP1 ranker, which
directly orders who gets housing offers, has none: no counterfactual check
(swap the name or address, compare scores), no audit of the flag. A
verification step needs to be a charter decision. Separately, the
model-reported "no kids" flag (L294-299) is only as good as the model's
recall and has no check either.

## 11. [MEDIUM] The authority rule is not "the blast rule": the blast compares exact canonical names, and properties are mapped through the org list first

What is wrong. Spec L138-139 says authority uses the "same any-of and
empty-list rules, compared trimmed and case-insensitive".

Evidence. audienceResolution.ts:203-210 compares with `authorities.has(
housingAuthority)`: trimmed, case-SENSITIVE, exact. The property side is
not compared raw today. The composer maps each property authority through
the organization list (canonical name, alternate spelling, or a unique
spelling) and shows any it cannot map as "Not used (not on the organization
list)" (dashboard/src/routes/broadcasts/authorityPrefill.ts:1-31). Unit
authorities are free strings (unitFields.ts:61-63, 443-451). Tenant
authorities are written as the org list's exact name (extraction apply,
apply.ts:238-260).

What it implies. Under a raw trimmed case-insensitive compare, a property
recorded with a spelling such as "AHA" pools none of the "Atlanta Housing"
tenants, which today's composer would have resolved. That shrinks the pool
silently, and pool is a locked decision. The charter should name the
mapping, not a string compare.

## 12. [MEDIUM] "One match per pair" and "every score in a ranking is computed together" cannot both hold

What is wrong. Section 10.3 (L436-440) says Update "re-scores the WHOLE pool
... every score in a ranking is computed together". Section 10.1 (L407-409)
says a pair row written from one direction is shown on the other. A
tenant-anchor press therefore overwrites one pair inside every property's
ranking that holds that tenant. Afterwards, those property rankings mix
scores from different calls, with different candidate sets in context.

Evidence. Spec L206-210 and L284-287 rest the soundness of this on "scores
are ABSOLUTE". That is a prompt instruction, not a mechanism. The spec also
says "a second press while one runs joins it" (L418-419) per ANCHOR only.
Two different anchors in flight write the same pair, last write wins, and
the spec does not say what happens to a review on that pair (finding 13).
Section 7.4 (L325-327) gives a failed batch's candidates "NO match: the row
shows 'not scored - retry'", which conflicts with "no per-candidate
re-score" (L437-438). It also leaves open whether the old row is deleted
(the history is lost) or kept (the pair stays shown at its old score, from a
different run, inside the "fresh" ranking).

What it implies. Either drop the "computed together" claim and accept mixed
provenance, or define it. Either way the charter must say what a failed
batch does to existing rows.

## 13. [MEDIUM] The review storage and "a reviewed match never expires" have no mechanism that survives the stated rewrite

What is wrong. Section 10.1 lists `review` as a pair-row field (L401) with
a 180-day TTL on the row. Section 12 (L473-474) says "Where the snapshots
are stored is B2's call; any new table only on Cameron's explicit ask".
Section 10.3 says every press "writes every pair fresh" (L437). A fresh
write of the row either drops the review or resets `expires_at`. For a
reviewed row never to expire, its `expires_at` must be removed and kept
removed across re-scores. The spec also never says whether a pair keeps one
snapshot or all of them. For a "training set" that keeps "reviewed at 62,
now 71" (L471), that choice is material.

Evidence. The matches table carries a TTL attribute (tables.ts:238-252
`ttlAttribute: 'expires_at'`). A1 L329 requires "No new infrastructure".

What it implies. B2 cannot implement "survives a re-score" plus "never
expires" on the pair row without a write rule the charter has not stated.
Putting reviews in a new table is infra, which both A1 and the spec gate.

## 14. [MEDIUM] The "existing AI runs store, same pattern" is extraction-shaped, and its existing readers would show ranking runs

What is wrong. Section 11 (L451-453) logs every ranking call as a run in the
existing AI runs store.

Evidence. app/src/repos/aiRunsRepo.ts:40-69: `conversationId` is REQUIRED,
`trigger` is sms/voice/triage/email/manual, `outcome` is
applied/no_op/skipped/failed, and `decisions` is extraction targets. Every
run writes pointers to 'global', 'outcome#...' and 'conversations#<id>'
(L148-157). The existing run log route reads 'global' by default
(routes/aiRuns.ts:139-140), accepts only global/outcome/conversations/
contacts scopes (aiRuns.ts:31), and rehydrates a conversation window per run
(aiRuns.ts:243-249).

What it implies. Ranking runs either violate the record type or land in
the extraction run log page under 'global', where every reader assumes a
conversation. A property-anchored run also has no scope. This is an
unenumerated reader. The charter should say whether ranking runs share the
`global` index with extraction or get their own entity keys.

## 15. [MEDIUM] "No rows and no repository" is false for the seeds: the lean world already writes a legacy-shape matches row

What is wrong. Section 2 (L68-70) says the `matches` table has "no rows".
Section 19 (L657-660) asks B2 only to confirm the TTL and GSI.

Evidence. app/src/lib/seed/lean.ts:36-38 and L444-456 seed a matches row
for contact-tenant-0001 / unit-0001 with `fit_score: 0.91`,
`approval_likelihood: 0.84`, `rank`, `status: 'shared'`,
`portability_required` and `generated_at`. It has none of score, for[],
against[], fingerprints or runId, and an `expires_at` of 2026-09-01, which
has already passed. The full profile includes lean (seed/index.ts:4-7, 118).

What it implies. Every e2e lane and the demo world start with a row that
the new reader must parse. The rubric "byte-stable lean world" means
changing it is a deliberate seed change. Either way it is a surface the
charter never names (prod rows may well be zero; that part is UNVERIFIED
here).

## 16. [MEDIUM] Rank latency against the 30-second CloudFront origin timeout; request vs job is undecided

What is wrong. Section 19 (L653-656) estimates 25-35 seconds for one
stage-one call and says "B2 streams rows as they arrive". The charter never
decides whether Rank is an HTTP request or a job, and section 10.2's "joins
it" behavior depends on that answer.

Evidence. infra/modules/cloudfront/main.tf:114 sets
`origin_read_timeout = 30`. AGENTS.md requires all job traffic to go through
`jobs.enqueue()`.

What it implies. A non-streamed request over 30 seconds returns 504 to Sam
while the model call (and its cost) continues. A streamed structured-output
call needs incremental JSON parsing within a batch. A job needs a result
channel. These are three architectures, and "join a press already in
flight" means something different in each. The spike B2 plans can measure
latency; it cannot pick the architecture for the charter.

## 17. [MEDIUM] The cost framing measures production ranking against a testing-only budget

What is wrong. Section 10.3 (L439-440) says "the cost per press stays inside
the A1 budget (section 14)". Section 11 (L462-463) says the Rankings page is
where Cameron and Sam "watch the A1 section 8 matching budget". Section 14
(L555-558) sets ~30 dollars a month of production rankings against "the A1
matching budget lines total 60-100 dollars".

Evidence. A1 L374-381: the $750 "covers testing before a capability goes
live. It does not cover the ongoing cost of the AI system once a capability
is running ... that is an operating cost of the business". Testing runs on a
SEPARATE key (A1 L306-307).

What it implies. Production ranking spend is not drawn from section 8 at
all. A monthly run rate compared against a one-time testing line reads as
"inside budget" while being a different ledger. The Rankings page needs to
separate testing-key spend (which A1 L370-372 requires Developer to monitor
against $750) from production spend.

## 18. [MEDIUM] Live matching facts bypass the existing write-or-suggest and speaker-role safeguards, and "not written again" has no identity rule

What is wrong. Section 6.4 (L240-245) says "Facts are written LIVE: no
approval step is added where none exists today", with only a confidence
floor in front.

Evidence. Extraction today does have an uncertain path. The model chooses
op write or suggest per field (schema.ts:55-60), and a suggestion waits for
staff. A run with unknown-speaker (inferred-role) content is demoted to
suggest-only (apply.ts:159, 318-319). A1 L34-35 describes the shipped layer
as "staff confirming anything uncertain".

What it implies. A fact pulled from a call where a caseworker or landlord
was the speaker is written live onto the tenant and fed to the ranker,
whereas today that same content would be demoted to a suggestion. Separately, "a removed
fact is not written again" (L245) needs a sameness rule for an open-label
`{label, value}` fact. Without one, either a reworded fact comes back, or
everything sharing a label is suppressed.

## 19. [LOW] The rubric's "demotion rule for ... declined sends" contradicts section 4

Spec L278-279 has the rubric state "the demotion rule for requirement
failures and declined sends". Section 4 (L105-110) says a Not interested
pair "is never forced into Weak" and the forced landing is "recorded
requirement failures ONLY". One sentence, but it is the rubric spec B2
writes from.

## 20. [LOW] Section 6.1 contradicts itself and leaves several real fields unclassified

- "Any field added to a record later is read automatically" (L169-170) vs
  "a test that fails when a new record field is neither included nor listed"
  (L185-186). The second means nothing is read automatically.
- "Timestamps other than created and last heard from" are excluded (L178-179),
  but 6.2 and 9.1 pass last heard from only as a bucket (L193, L351-353).
- Unclassified real fields: `voucher_expiration_date` (contactsRepo.ts:284;
  is it a "timestamp"?), `lifEligible` (L336; income-linked?), `customFields`,
  `relationships` (links to other people), and the consent_* family.
- "Requirement-relevant history" on the tenant card (L196) is undefined.

## 21. [LOW] The outcome vocabulary omits two shipped outcomes

Spec L510-511 and L537-538 list No reply / Interested / Not interested (and
Tour pending). The derived outcomes are no_reply, replied, interested,
not_interested and signed_up (listingSendOutcome.ts:22), and the dashboard
renders "Signed up", "Replied, quiet" and "Not interested (auto)"
(Card.tsx:271-284; FollowUpView.tsx:36). Section 13.3's "already sent and
not yet replied" filter also has to say which side `replied` and
`signed_up` fall on.

## 22. [LOW] "Match percentage" collides with the existing rule-based Similar panel on the property page

ListingDetail.tsx:1502 already renders a `matchPct%` from
lib/similarUnits.ts:1-13 (a weighted rule score). The B4 property page will
show two different "match %" numbers, one rule-based, which also sits
awkwardly next to the signed "no rule-based scorer" (spec L39). GLOSSARY
(section 3) should name the difference.

## 23. [LOW] Tenant-anchor tie order is undefined

Section 4 (L121-123) lists "tie order (section 9.2)" as deterministic. For
the tenant anchor, section 9.2 (L380-382) ends at "then score". Equal
scores have no tie-break, unlike the property anchor (last heard from), so
the row order can change between reads.
