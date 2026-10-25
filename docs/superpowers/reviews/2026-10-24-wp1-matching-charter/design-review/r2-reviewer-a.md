# WP1 matching charter - design review round 2, reviewer A

Spec reviewed at bea01549 (cited as "spec L<n>"). I read the round-1 diff,
adjudications.md, r1-reviewer-b.md and my own r1 report. I did not read
intent.md or any other records. Code was read at the worktree head and is
cited by file:line. ASCII only.

Priority order: new problems first (part A), then defects in the rewrite
itself (part B), then the adjudications I contest (part C), then whether my
round-1 fixes are correct (part D).

---

## Part A - What all of us missed

### A1. [HIGH] The tenant's `notes` field is unclassified, and it is where extraction writes income, rent portion and screening facts

What is wrong. Section 6.1 excludes `staff_notes` (spec L205-207) and leaves
the contact's OTHER notes field unmentioned. The section 6.2 tenant card
(L221-226) does not list it either. Under "no field is read until it is
classified" (L190-194), B2 must classify it. The charter gives no direction,
and the field is the riskiest one on the record.

Evidence.
- contactsRepo.ts:161-168: `staff_notes` is "a second box kept apart from
  `notes`, which the AI appends its dated '[Auto - <date>]' lines to".
- extraction prompt.ts:107-111: noteLines are "secondary facts about the
  client ... household size, their rent portion, utility debt, other useful
  screening facts".
- apply.ts:713-735 appends them to `contact.notes`.

What it implies.
- Include `notes` on the card and income-like and screening facts reach the
  ranker. That breaks section 6.1's promise that "credit and income ... the
  model never sees them" (L202-204) and A1's "staff see those as notes only".
- It also bypasses the section 6.4 never-extracted list (L279-281), which
  governs only the NEW matching-facts output and not noteLines. Familial
  facts and anything else the noteLines prompt pulls ride in through notes.
- Exclude `notes` and the ranker loses facts extraction already collects
  (stairs, household size, rent portion). B1 would then re-extract them as
  matching facts. Two AI outputs now carry the same fact, and Sam's "remove
  a wrong fact" (L290-293) removes it from one place only.

The charter must classify `notes` and say how noteLines and matching facts
relate.

### A2. [HIGH] The ranked pool's selection default is undecided, and today's default checks everyone

What is wrong. Section 13.1 keeps the tour-hold rule "as a SELECTION
default" (L602-604): a held tenant "starts unchecked". That only means
something if the other ranked tenants start checked. The charter never
states the selection default for a ranked row.

Evidence. Today a row starts checked when `hasConsent && (seeded ||
(!alreadySent && !declined && !held))` (blastAudienceRules.ts:160-165). The
composer shows the reach as "how many review rows will start checked"
(AudienceFilters.tsx:87-88).

What it implies. If B4 carries D5 over, as the tour-hold sentence implies,
one Send press texts the whole ranked pool (median about 50, spec L67-68).
That includes every Weak pair capped for a failed requirement (section 7.4).
The signed text EXCLUDES those tenants, and the charter's own justification
for demoting rather than excluding is that Sam sees them at the bottom
(section 4). Sam seeing them at the bottom does not help if they start
checked. A1 L111 says staff "choose one, a few, or many". The charter must
decide the selection default for ranked rows, for example "nothing checked",
or "Strong and Good checked, never a capped pair", and restate the
tour-hold rule against that default.

### A3. [HIGH] The failedRequirements cap can enforce the discriminatory requirement the fair-housing rule says is never applied

What is wrong. Section 7.4 (L380-390) caps any pair with a non-empty
`failedRequirements[]` at Weak "whatever its score". Section 7.2 (L345-349)
says an unlawful requirement ("no kids") "is NOT applied ... the model is
told to disregard it and to report it". The two lists come from the same
model output, and code never reconciles them.

Evidence. A free-text requirement lives under a requirement KEY that can
hold lawful and unlawful clauses together: `qualifications`, the evictions
notes and the pets details are text kinds (requirements.ts:70-80;
unitFields.ts:126-136). The output is keys only (L380-381), so code cannot
tell which clause failed.

What it implies. The model reports `qualifications` failed because the
tenant has children, and lists the same key in `fairHousingFlags`. Code
then caps the pair at Weak. The deterministic code path applies the exact
requirement the rubric disregarded, so the check meant to enforce section 4
becomes the mechanism of discrimination. At minimum: a key that appears in
the same call's fairHousingFlags never caps. Code should also refuse a key
that is not a recorded requirement on that property's card (today nothing
validates the model's keys). And the counterfactual check (L351-355) should
cover the cap, not only the score.

### A4. [MEDIUM] `fairHousingFlags[]` is per call, so on a tenant anchor a flag cannot be attributed to a property

What is wrong. Section 7.4 places `fairHousingFlags[]` "per call" (L381-383),
and section 13.2 shows "the fair-housing flag where raised" on the ranked row
(L615-616). On a tenant anchor one call holds every candidate PROPERTY
(section 7.1), so a per-call list of requirement keys does not say which
property's record carries the unlawful requirement. A property anchor also
batches tenants across calls, so its flags arrive split across batches and
have to be merged.

What it implies. On the tenant anchor, the flag Sam is supposed to act on
("remove from the record", L348-349) is not actionable as specified. Flags
belong per candidate when the candidates are properties. The property
anchor's flags need a merge rule across batches.

### A5. [MEDIUM] "Empty mapped authority list takes every authority" fails open where today's composer warns or holds

What is wrong. Section 5 (L153-157) maps the property's authorities through
the org list "exactly as today's composer prefill does", then says "An empty
mapped list takes every authority". That rule does not separate three cases:
the property records no authority; the property records authorities none of
which map; the org list could not be read.

Evidence. Today, when no authority maps, the composer TELLS staff "This
blast is not limited by housing authority" (AudienceFilters.tsx:48,
235-241). When the list fails to load, the prefill is HELD and no Preview
runs (BroadcastComposer.tsx:73-77, ORG_LIST_FAILED). Unmapped names show as
"Not used (not on the organization list)" (authorityPrefill.ts:1-10).
Section 7.3's completeness list does not include the property's
authorities (L367-369).

What it implies. A property recorded with a spelling that is not on the
list, or a transient org-list read failure in the worker, silently pools
every searching tenant of every authority. That adds unleasable candidates
and pays to score them, with nothing shown to Sam. The pool needs "org list
unreadable: fail the ranking", and an unmapped authority needs to surface
as a completeness gap.

### A6. [MEDIUM] Pair history's "every counted send" includes flyer sign-ups and misses legacy rows

What is wrong. Section 6.3 (L252-253) builds the send history from "the
listing_sends row's shares".

Evidence.
- A flyer sign-up is a COUNTED entry in that same map under the key `flyer`
  (shareLedgerKeys.ts:8-17; listingSendsRepo.ts:104). It is the tenant
  reaching out, not a send, and there is ONE `flyer` entry per pair, so
  repeat sign-ups collapse into it.
- A legacy row has no `shares` at all and "reads as counted" from `sentAt`
  alone (listingSendsRepo.ts:41-43, 231-236).

What it implies. The model reads "sent 3 weeks ago, no reply" for a tenant
who actually signed up from the flyer. That is the opposite signal. For
older pairs it sees no send at all. The history builder must tell share
kinds apart and fall back to `sentAt`.

### A7. [MEDIUM] Reactions on the listing_sends row: the row may not exist, and the row's writer set is closed by contract

What is wrong. Section 6.3 (L261-262) stores extracted reactions "on the
existing listing_sends pair row as a list".

Evidence.
- The repo header enumerates the row's writers and its change-token
  protocol: putShareMemory, setDeclined and clearDeclined, with every
  memory write a conditional read-modify-write on `shares_op`
  (listingSendsRepo.ts:14-43). The first share write is conditioned on
  `attribute_not_exists(shares_op)` (listingSendsRepo.ts:352-356).
- A row is LISTED when `counted !== false && sentAt` (L231-236).
- The seed runner rewrites seeded rows whole with PutCommand (L26-29).
- Partner (caseworker) recipients have rows too (L4).

What it implies. The charter does not say what happens to a reaction about
a property that has no row: a property Sam texted by hand, or one the
tenant names unprompted. An UpdateCommand would create a row. The charter
does not say whether the reaction writer joins the `shares_op` protocol,
or what a reseed does to reactions. It also does not say where a
caseworker's reply on a tenant's behalf lands. Each is a new invariant on
a row whose header says its writer set is closed. At minimum the charter
should require the row to exist (reactions only on sent pairs) and add the
writer to the repo header.

### A8. [MEDIUM] "Never ranked or paid for" does not hold for the anchor; the consent fence reverses a deliberate design

What is wrong.
- Section 5 (L142-146) says "a tenant who cannot be sent to is never ranked
  or paid for". Fences apply to candidates only (L169), and any tenant can
  be the anchor. An opted-out or no-consent tenant ANCHOR is ranked, paid
  for, and then refused at send. The banner covers "not searching" only
  (L171-175).
- Making "has SMS consent" a pool exclusion reverses a deliberate design:
  consent is "a per-candidate flag (not a pre-exclusion) so staff can see +
  fix them" (audienceResolution.ts:84-90, 233-235). Opt-out and unreachable
  ARE pre-exclusions today (L189-193). Consent is not.

What it implies. A tenant with unrecorded consent disappears from every
property's ranking with no cue to fix it, where today they show "consent
not recorded". The anchor case needs the same banner treatment as
not-available. How many tenants this affects is UNVERIFIED: `imported`
counts as a consent method (smsCompliance.ts:86, 101-103), so the count
may be small.

### A9. [MEDIUM] The created_at fallback lets every imported, never-heard tenant into the window at once

What is wrong. Section 5 (L159-160) says "a tenant never heard from counts
from when they were added".

Evidence. The import stamps `created_at = if_not_exists(created_at,
:createdAt)` from `importedAt` (import/apply.ts:1151-1159), so every
imported contact's "added" is the import run.

What it implies. Every never-heard imported tenant enters the 90-day window
on import day and leaves it together 90 days later. Section 2's 385 are
searching tenants "not heard from in 90 days or ever". If the production
import fell inside the last 90 days, the window passes far more tenants than
its median of 50 assumes (UNVERIFIED: the import date and the basis of the
section 2 count are in records I may not read). The cost envelope and the
window's purpose rest on that number. The rule should key "added" to a
real capture instant, or exclude `origin` import rows from the fallback.
The recency BUCKET for a never-heard tenant is also undefined.

### A10. [MEDIUM] Section 17 still omits two departures: size and authority as exclusions, and the sendability fences

What is wrong. Section 1 now says "Every place where this charter departs
from the signed text is listed in section 17" (L52-53).

Evidence. A1 L89-92 delivers "A ranking of EVERY available property against
a chosen tenant", with voucher size and housing authority listed as INPUTS
the ranking uses. A1's exclusion lists (L93-96, L99-102) name neither a
size mismatch, an authority mismatch, nor opt-out or consent. The pool
makes all of them hard exclusions in both directions (spec L147-157,
L142-146).

What it implies. The exclusions themselves are defensible: a lease or a
send cannot happen. The completeness claim in section 1 is not. Add them to
section 17, or soften the claim.

### A11. [MEDIUM] The never-extracted list is a prompt line on a live-write path

Section 6.4 (L279-281) says race, religion, familial facts and the rest are
"never extracted". The only mechanism is the instruction. Facts are written
LIVE with no approval step (L285). The counterfactual check (L351-355)
swaps name, address and household. It does not test whether extraction
obeys the list. A protected-class fact the model writes anyway goes live
onto the tenant record, shows to staff, and feeds the ranker. This is the
same "prompt as guarantee" pattern that M10 accepted needed a test. The
charter should either test the never-extracted list (WP2's adversarial-set
pattern, A1 L166-170) or say plainly that it is unenforced.

---

## Part B - Defects in the rewrite

### B1. [MEDIUM] SSE is a best-effort refresh hint, not a result channel

Section 10.2 (L491-494) has results "reach the composer over the existing
server-sent events as each batch finishes". A worker-process emit crosses
to the app process through a bridge that is "Best-effort BY DESIGN: 2s
timeout, no retry, no queue - SSE is a refresh hint; dashboards reconcile
via GET" (eventBridge.ts:1-11; events.ts:5-12; jobs/extraction.ts:10-16).
The SSE stream also goes to every connected dashboard (events.ts:5-8).

As written, a dropped event loses a batch's results on screen, and putting
scores in the event payload broadcasts tenant scores to every client. The
charter should say that matches are persisted per batch, the event carries
only "anchor X, batch n done", and the composer re-reads by GET. Section
19's open item (L788-790) asks only whether the bridge works, not how it
behaves when it fails.

### B2. [MEDIUM] Data-boundary statements are slogans: a "download inside production", and the counterfactual on real pairs

- Section 12 (L565-567): "a staff export, which stays inside the production
  environment". A staff download lands on a laptop, which by definition is
  outside production. A person then writes worked examples from it, which
  is development work on real client data (Agreement 7.3 as quoted in A1
  L293-295).
- Section 7.2 (L351-355): the counterfactual check runs "the same pairs" on
  the TESTING key. A1 keeps testing on a separate key (L306-307), and 7.3
  bars real data from dev and test environments. The charter does not say
  which environment holds the real pairs while the testing key scores them.
- The Rankings page is "staff only" (L545). Every dashboard user is staff,
  VAs included (broadcasts.ts:1-4: "VAs run share broadcasts day-to-day, so
  NO admin gate"), so every VA can export every review with client data.

See C4 for the remedy I argue for.

### B3. [LOW] Old filter drafts "still resume and send as filter drafts" while the filter UI is "removed from the composer"

Section 13.1 says both (L595-597, L605-606). A draft resumes in the
composer through `?draftId=` (BroadcastComposer.tsx:15). It shows its
AudienceFilters (BroadcastComposer.tsx:5-9), whose live reach re-resolves
the filter. Either the filter UI survives for old drafts, or old drafts
send without one. Say which.

### B4. [LOW] "Existing per-user rate limit for cost routes" is not one limit

Section 10.2 cites config.ts:1021-1040, which is three per-route knobs:
manual send 30/min, broadcast send 5/min, originate 10/min. Rank needs its
own knob, with the same fail-fast parse. Reusing one would charge Rank
presses against Send's budget, or the other way round.

### B5. [LOW] Ranking runs are still served by the extraction run-detail route

"The extraction run log and its readers never list ranking runs" (L535-537).
GET /api/ai-runs/:runId returns ANY run# row by id and rehydrates
`run.conversationId` (routes/aiRuns.ts:228-249). Not listing is true; never
being served is not. Fence that route by kind.

### B6. [LOW] Section 13.5 still says "a later outcome" stales a match

L642-643 conflicts with 10.3 (L526-527): "the derived outcome is never
fingerprinted". A Replied outcome comes from a new text, which by design
does NOT stale. Reword 13.5 to name the stored facts (decline, tour,
reaction).

### B7. [LOW] The version rule ignores the worked-examples file

Section 10.3 flags a match scored under another rubric version or model
(L513-514). Worked examples are "a separate versioned file" (L357-358) and
change scoring just as much. Add the examples version to the rule.

### B8. [LOW] The priority exemption does not say whether it also drops the secondary sort

Section 9.2 removes the "lift" for a failed-requirement pair (L443-445).
The tenant-anchor sort still orders "priority on before off" after the band
(L453-454). The charter does not say whether an exempt pair keeps that tie
preference inside Weak.

### B9. [LOW] "Landlord ... matching facts" on the landlord card do not exist

Section 6.2 (L242-243) says the landlord card carries the landlord's
"matching facts". Landlord-side extraction is filed, not built (L293-294;
section 18), so there are none to carry.

---

## Part C - The adjudications I contest

- M10, names and addresses on the cards: concede. It is Cameron's explicit
  call, and the counterfactual check now tests the consequence.
- M21, code checks of free text: concede. Tenant pets and evictions are
  free text (contactsRepo.ts:332-333). The new cap has its own defect (A3).
- M28, a spend ceiling: concede for production. On the testing key, A1
  L370-372 obliges notice before $750, and A1 L304-305 authorizes Developer
  to set spend limits on the account. An account-level limit on the testing
  key is the cheap enforcement, not code.

### C4. [MEDIUM] Planner default M5: argue for examples written from scratch, and no export

The anonymize-then-commit default (spec L357-363, L564-568) is what
requires the export. The export is a client-data download to a laptop
(B2), and anonymizing in a development context is processing real data
there. Examples written from scratch while reading reviews in the
production app remove the export, the anonymization step, and the 7.3
question in one move, and they lose nothing the Rankings page cannot
show. Keep review counts and the in-app review list; drop the export.

### C5. [LOW] Planner default M7 is right; one condition

Not auto-declining in WP1 is right: WP3's contract text (A1 L201-202)
wants engine declines recorded in WP1's tracking, and the `by: 'engine'`
seam already exists. But the WP3 seam must not be pre-empted by reactions
stored in a different shape from DeclineRecord (listingSendOutcome.ts:33-37).
Name the reaction values so that a WP3 "hard no" maps one-to-one onto a
decline.

---

## Part D - Are my round-1 fixes correct?

- r1-1 (voucher sizes): correct. The pool reads `acceptedVoucherSizes` and
  clamps through `bedroomSizesOfFilter` exactly as prefillVoucherChips does
  (broadcastFormat.ts:80-82). Section 2's revised counts are UNVERIFIED.
- r1-2 (examples and PII): commit is fixed. Export and processing residue
  in B2 and C4.
- r1-3 / r1-4 (derived outcome, pair history): the fingerprint fix is
  right. The history builder has the share-kind gaps in A6, and the
  reaction store has the row-protocol gaps in A7.
- r1-5 (section 17): mostly fixed; residue in A10.
- r1-6 (landlord card): the contradiction is resolved.
- r1-7 (B4 surfaces): enumerated. Open points: the selection default (A2)
  and B3.
- r1-8 (TCPA fences): fixed for candidates. Residue in A8 (the anchor; the
  consent design reversal).
- r1-9 (availability): fixed. The guard stays and the banner says so.
- r1-10 (fair housing): the test is added. The cap hole in A3 and the
  never-extracted gap in A11 remain.
- r1-11 (authority): the rule is correct for mapped names. Fail-open in A5.
- r1-12 / r1-13 (provenance, reviews): fixed. Mixed provenance is accepted
  explicitly, and reviews are their own records.
- r1-14 (AI runs): fixed for listing. Residue in B5.
- r1-15 (lean seed): fixed.
- r1-16 (latency): the architecture is chosen. Channel semantics in B1.
- r1-17 (budget): fixed. Two ledgers.
- r1-18 (live facts): the speaker demotion and the identity rule are fixed.
  The duplication with noteLines is in A1.
- r1-19 through r1-23: fixed.
