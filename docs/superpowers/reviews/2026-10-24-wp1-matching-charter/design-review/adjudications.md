# Design review adjudications - WP1 matching charter

Spec under review: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
Round 1 reviewed commit 94951d54. Reports: r1-reviewer-a.md (23 findings),
r1-reviewer-b.md (27 findings). Both Opus, same brief, blind to intent.md.

The two reports overlap heavily, so the rulings below are by MERGED finding
(M1..M28). "A3" means reviewer A finding 3. Load-bearing claims were checked
in the code and the contract before ruling (listed under each).

Rulings: ACCEPT = edit the spec. REJECT = no edit, reason given. DEFER =
filed elsewhere. "Planner default" = accepted with a choice Cameron has not
made yet; the spec carries the default and it is put to him at the gate.

## Round 1

M1 - Pool size and authority rules contradict the unit readers (A1, B1,
A11, B24). ACCEPT. Verified: unitFields.ts:453-478 `acceptedVoucherSizes`
falls back to beds and is the ONLY server reader; authorities go through
`authoritiesOf` (unitFields.ts:433-452) and the composer maps them through
the org list (authorityPrefill.ts); audienceResolution.ts:203-210 compares
exact names, not case-insensitive. Edit: the pool reads a unit through
those readers, applies today's composer prefill as the rule (sizes clamped
to the 0-4 chips, 4 = 4 or more; authorities through the org-list
mapping), and a beds fallback counts as Missing in the completeness pass.
Section 2 corrected: the prod count's "beds stand-in" scenario IS the
code's rule (per property median 104 / worst 158; with the 90-day window
median 50 / worst 64; per tenant at most 5). Decision changed: yes (pool).

M2 - Pool drops the TCPA and sendability fences (A8, B2). ACCEPT.
Verified audienceResolution.ts:189-193 and broadcastFanOut.ts:276. Edit:
opted out, unreachable, no phone, soft-deleted and no consent are pool
rules (a send cannot happen), so they are never ranked or paid for.
Decision changed: yes (pool).

M3 - Section 17 is incomplete (A5, B4). ACCEPT. Verified a1-signed.txt
L92-106. Edit: section 17 lists every departure: onboarding excluded, tour
holds as inputs, sent and declined not excluded automatically, the window
excludes rather than only ranks, priority default within band, landlord
notes read only when the switch is on, rankings kept as overwritten
matches plus the run log; section 1 stops saying "two places". Decision
changed: no (disclosure).

M4 - Landlord card contradiction (A6, B23). ACCEPT. Edit: the switch is
built in WP1 and turned on as Sam decides (section 18 no longer calls it
later); with it off, landlord notes not applied to a property are unread,
listed in 17; when on, the property's own value wins and the landlord's
copy-only defaults are labeled as such. Decision changed: no.

M5 - Reviews as a "training set" and examples in the repo carry client
data (A2, B10). ACCEPT, planner default. Verified a1-signed.txt L292-299
(Agreement 7.3; "Nothing in this Amendment permits Client data to be used
to train any AI model"). Edit: no model is trained; the word "training
set" goes. The review export is a staff download inside production and is
never committed. A worked example enters the repo only after a person
anonymizes it (names, phones, addresses and other identifiers removed or
replaced), the same rule A1 sets for WP2 test conversations. Decision
changed: yes. For Cameron: confirm, or use only examples written from
scratch.

M6 - Fingerprint rules vs the derived outcome (A3, B8). ACCEPT. Verified
listingSendOutcome.ts:49-91 (replied derived from last heard from; a later
share supersedes a decline). Edit: the fingerprint and the model read the
STORED pair facts (each counted share's date, the declined record with
who and when, tours, extracted reactions), never the derived outcome; so
a decline stays visible after a re-send and a new text alone still does
not stale. Decision changed: yes (fingerprint inputs).

M7 - Per-send reaction has no store; engine-decline seam (A4, B7, B20).
ACCEPT, planner default. Verified listingSendsRepo.ts:3-25, 163, 246.
Edit: reactions live on the existing listing_sends pair row as a list
(at, reaction, source message, run), no new table. In WP1 an extracted
"hard no" does NOT set a decline; staff still mark Not interested; the
`by: 'engine'` decline stays for WP3. Decision changed: yes. For Cameron:
confirm extraction does not auto-decline in WP1.

M8 - B4 removes the filter audience without listing what it carries (A7,
B17). ACCEPT, planner default. Verified PartnerFile.tsx:178,
TenantFile.tsx:320, ListingDetail.tsx:438, RecipientPreview.tsx,
blastAudienceRules.ts:59-165. Edit: hand-picks and "Add a tenant" stay
beside the ranked pool (also how Sam still reaches an onboarding tenant);
the tour-hold default-unchecked rule stays as a SELECTION default, never
an exclusion; a partner anchor keeps today's seeds-only flow with no
ranking; drafts saved with a filter audience before B4 still resume and
send as filter drafts; follow-ups are untouched; the existing Send
entries on the tenant and property records are re-pointed, not added.
Decision changed: yes (surfaces).

M9 - Any anchor vs the send-time availability refusal (A9). ACCEPT.
Verified broadcasts.ts:1181-1192. Edit: ranking runs for any anchor; a
send of a non-available property stays refused by the existing guard and
its make-available dialog; the banner says so. Decision changed: no
(matches Cameron's "not a full bar on that feature").

M10 - Fair-housing guarantee is only a prompt line (A10, B13). ACCEPT the
test, REJECT removing names and addresses. Names and whole addresses were
Cameron's explicit call 2026-10-25. Edit: B2 runs a counterfactual check
on the testing key before Sam's acceptance (same pair, name, address and
household facts swapped, scores compared against a tolerance), and the
matching-facts instruction never extracts race, color, religion, sex,
national origin or familial facts beyond household size. Decision
changed: yes (adds a B2 check). Planner default; for Cameron.

M11 - "Computed together" fails across anchors and versions (A12, B15).
ACCEPT. Edit: the claim goes; mixed provenance is accepted because scores
are absolute; a match scored under a different rubric version or model is
flagged out of date; a failed batch leaves existing matches untouched and
flagged, and candidates with no match show "not scored - retry", cleared
by the next whole-pool Update. Decision changed: no (precision).

M12 - Review storage (A13, B14). ACCEPT. Verified tables.ts:238-252 and
A1 L329 "No new infrastructure". Edit: each review is its own record,
every one kept, never expiring, holding the snapshot; not a field on the
pair row, so a rewrite cannot erase it. It lives in an EXISTING table
(B2 picks which and proposes the key); no new table. Decision changed: no.

M13 - The AI runs store is extraction-shaped (A14). ACCEPT. Verified
aiRunsRepo.ts:40-69, 148-157; routes/aiRuns.ts:31, 139-140. Edit: ranking
runs use their own entity keys and scope in that table; the extraction
run log and its readers never list them. Ranking runs are kept 180 days,
matching the matches, so "each ranking is recorded" holds for the review
period. Decision changed: no.

M14 - The lean seed already writes a legacy matches row (A15). ACCEPT.
Verified seed/lean.ts:444-456. Edit: B2 replaces it with the new shape as
a deliberate lean-world change; the reader ignores rows without the new
shape. Decision changed: no.

M15 - 25-35 s against CloudFront's 30 s origin timeout (A16, B9).
ACCEPT. Verified infra/modules/cloudfront/main.tf:114; jobs.ts:107, 199;
SSE in routes/api.ts. Edit: Rank enqueues a job (jobs.enqueue); results
reach the composer over the existing server-sent events as each batch
finishes; "join" means the anchor's in-flight job. The B2 spike measures
latency, not the architecture. Decision changed: yes (architecture).

M16 - Budget misread (A17, B16). ACCEPT. Verified a1-signed.txt L368-396:
the $750 is testing-only, the matching line is $20-40 (the $40-60 line is
simulated conversations). Edit: production rankings are an operating cost
on the production key, outside A1 section 8; the Rankings page shows spend
by environment so testing-key spend is watched against the $750. Decision
changed: no (framing).

M17 - Live facts bypass the speaker demotion; "not written again" has no
identity rule (A18, B19). ACCEPT. Verified apply.ts:159, 318-319. Edit: a
fact from a run demoted for an unknown speaker is not written (no queue);
a removed fact suppresses later facts with the same label and value after
trimming and ignoring case; a reworded fact may return. Decision changed:
no.

M18 - 7.2 rubric "demotion rule for declined sends" contradicts section 4
(A19, B18). ACCEPT. Edit: the line now says requirement failures only.

M19 - 6.1 self-contradiction and unclassified fields (A20, B11). ACCEPT.
Verified contactsRepo.ts:284, 326-336. Edit: no field is read until
classified (the B2 test forces it); defaults: relationships excluded
(other people), consent fields excluded (plumbing), lifEligible excluded
(income), voucher_expiration_date included, customFields included; the
undefined "requirement-relevant history" goes.

M20 - Forced Weak covers credit and income (B5). ACCEPT. Verified
a1-signed.txt L120 and unitFields.ts:136-138. Edit: credit and income
requirement notes are NOT on the property card at all ("staff see those
as notes only"); extraction writes no income facts. Decision changed: yes.

M21 - Priority can lift a requirement-failing pair; the Weak landing is
only a prompt (B6). ACCEPT the cap, REJECT code checks of free text.
Verified contactsRepo.ts:332-333 (tenant pets and evictions are free
text, so a code comparison would be the rule-based scorer A1 and Cameron
rejected). Edit: the output contract gains `failedRequirements[]` (keys of
recorded requirements the model judged failed); code caps such a pair at
Weak and never applies a priority lift to it (A1: "every ranking it
qualifies for"). Decision changed: yes.

M22 - Staff notes on the card reverse a documented invariant (B12).
ACCEPT, planner default. Verified contactsRepo.ts:160-168. Default: staff
notes stay OFF the card in WP1 (the promise staff wrote under holds); the
open issue extraction-prompt-read-staff-notes covers reading them later.
For Cameron: he may prefer them on, with the invariant updated and Sam
told.

M23 - The window hides tenants never heard from (B21). ACCEPT. Verified
contactsRepo.ts:228-233. Edit: a tenant never heard from is in the window
when added within it (created_at). Decision changed: yes (pool, small).

M24 - Outcome chip vocabulary (A21, B22). ACCEPT. Verified
listingSendOutcome.ts:22. Edit: chips use the shipped five outcomes; the
property anchor's hidden "already sent" group is no_reply only.

M25 - Two "match %" on the property page (A22). ACCEPT. Verified
ListingDetail.tsx:1502. Edit: GLOSSARY distinguishes them; B4 relabels the
Similar panel's number "similarity".

M26 - Tie orders and small inconsistencies (A23, B27). ACCEPT. Edit:
tenant anchor ends with property address as the final tie-break; the
section cites, the median-vs-worst mix and the timestamp-vs-bucket line
fixed; "nothing else is trusted" names failedRequirements and the fair
housing report as model output read by code.

M27 - Slice order: fingerprint helpers in B1; GLOSSARY deferred (B25).
ACCEPT. Edit: fingerprint helpers move to B2 with the cards (B1 6-8, B2
21-25); each slice adds the glossary nouns it introduces, in the same
change. Decision changed: yes (slice boundary).

M28 - Rank spends with no rate limit (B26). ACCEPT the rate limit, REJECT
a daily spend ceiling. Edit: Rank sits behind the existing per-user cost
route limit (config.ts:1021-1040). A ceiling is speculative: every press
is a human click and the Rankings page shows spend.

Round 1 totals: 28 merged findings; 26 ACCEPT, 2 partly REJECTED (M10
names and addresses, M21 code checks of free text, M28 spend ceiling as a
third partial), 0 DEFER. Decisions changed: yes (M1, M2, M5, M6, M7, M8,
M10, M15, M20, M21, M23, M27), so round 2 runs. Reviewer A continues
(more distinct accepted findings that changed decisions: M1, M5, M6, M7,
M8, M15 first-found).

## Round 2 (reviewer A continued; report r2-reviewer-a.md, 22 findings)

Verified before ruling: prompt.ts:107-111 and apply.ts:713-735 (noteLines
into `notes`); blastAudienceRules.ts:178-182 (D5 checks every eligible
row); lib/eventBridge.ts:1-11 (best-effort bridge, GET reconciles);
audienceResolution.ts:77, 235 (consent a per-candidate flag by design);
import/apply.ts:1151 (import stamps created_at).

R2-1 `notes` unclassified (A1). ACCEPT. `notes` excluded from the card;
matching facts are the ranker's channel. Decision changed: yes.
R2-2 Selection default undecided (A2). ACCEPT, planner default: ranked
rows start unchecked; hand-picks start checked; the tour-hold rule becomes
a chip and a confirm. Decision changed: yes (replaces part of M8).
R2-3 The cap can enforce an unlawful requirement (A3). ACCEPT. A key caps
only when it is a recorded requirement on that property's card and not in
the same call's fairHousingFlags; the counterfactual covers the cap.
Decision changed: yes.
R2-4 fairHousingFlags per call (A4). ACCEPT. Per candidate, merged across
batches by property and key.
R2-5 Authority fail-open (A5). ACCEPT. Unmapped authorities are a gap
shown to Sam; an unreadable org list fails the ranking.
R2-6 Flyer share and legacy rows (A6). ACCEPT. History tells a flyer
sign-up from a send and falls back to sentAt.
R2-7 Reaction storage protocol (A7, C5). ACCEPT. Only sent pairs get
reactions (others become matching facts); the writer joins `shares_op`
and the repo header; kinds interested / maybe / hard_no / question so a
WP3 hard_no maps onto DeclineRecord; tenant rows only.
R2-8 Anchor sendability; consent reversal (A8). ACCEPT. The anchor banner
covers not sendable; missing consent goes back to a per-candidate flag
(reverses that part of M2), opt-out, unreachable, no phone and deleted
stay pool rules. Decision changed: yes.
R2-9 created_at fallback and imports (A9). ACCEPT. Import-created
contacts do not use the fallback; never-heard bucket is "never".
R2-10 Section 17 misses size, authority, sendability (A10). ACCEPT.
R2-11 Never-extracted list untested (A11). ACCEPT. B1 tests it with
synthetic conversations on the testing key.
R2-12 SSE is a hint (B1). ACCEPT. Matches persisted per batch; the event
says only anchor and batch; the composer re-reads by GET with polling.
Decision changed: yes (architecture detail).
R2-13 Data-boundary slogans (B2) and R2-14 contest M5 (C4). ACCEPT. No
export; examples written from scratch after reading reviews in the app;
the counterfactual runs on synthetic pairs only. Decision changed: yes
(M5 default replaced; still for Cameron).
R2-15 Old drafts vs removed filter UI (B3). ACCEPT. Old filter drafts keep
their filter UI until sent or deleted.
R2-16 Rate limit knob (B4). ACCEPT. Rank gets its own knob.
R2-17 Run-detail route (B5). ACCEPT. Refuses ranking runs by kind.
R2-18 13.5 wording (B6). ACCEPT.
R2-19 Examples version (B7). ACCEPT. Stored and in the version rule.
R2-20 Capped pair and the priority tie (B8). ACCEPT. No priority
treatment at all.
R2-21 Landlord matching facts do not exist (B9). ACCEPT. Removed.
R2-22 Concessions on M10, M21, M28 (C). Noted. ACCEPT the testing-key
account spend limit as Cameron's enforcement (A1 L304-305).

Round 2 totals: 22 findings, 22 ACCEPT, 0 REJECT, 0 DEFER. Decisions
changed: yes (R2-1, R2-2, R2-3, R2-8, R2-12, R2-13), so round 3 runs.

## Round 3 (reviewer A continued; report r3-reviewer-a.md, 7 findings)

Verified before ruling: sqsJobConsumer.ts:11-17 (throw = redelivery up to
5, then DLQ page), infra/modules/jobs/main.tf:36 (120 s visibility),
import/apply.ts:1146-1159 (imported_from on every touched contact).

R3-1 Accommodation vs unlawful requirement (finding 1). ACCEPT. Two flag
kinds: unlawful (any requirement key or free-text field on the property
card; remove from the record) and accommodation (lawful rule that does not
apply to this tenant, e.g. No pets against an assistance animal; suppresses
the cap, asks for no record change). The counterfactual set includes an
assistance-animal pair. Decision changed: yes.
R3-2 Job semantics under at-least-once delivery (finding 2). ACCEPT. The
handler never throws on model, batch or org-list failure; a run claim
makes redelivery idempotent; batches in parallel with a per-call timeout
under the visibility timeout; job status is a ranking-job record in the AI
runs table under the ranking keys, read for join and polling. Decision
changed: yes (mechanism).
R3-3 Import predicate (finding 3). ACCEPT. Any contact with imported_from
skips the created_at fallback; the staff-added-then-matched miss is an
accepted error, stated.
R3-4 Capped pair display (finding 4). ACCEPT. Sorts last within Weak;
row reads "requirement not met".
R3-5 Reaction row condition (finding 5). ACCEPT. A listed row with a
counted send share.
R3-6 Select all (finding 6). ACCEPT. Checks every ranked row except
capped and tour-held rows.
R3-7 Never-extracted test (finding 7). ACCEPT. Asserts no fact of an
excluded kind.

Round 3 totals: 7 findings, 7 ACCEPT. Decisions changed: yes (R3-1,
R3-2), so round 4, the last allowed, runs.

## Round 4 (reviewer A continued; report r4-reviewer-a.md, 5 findings)

Verified before ruling: RecipientPreview.tsx:9-19 (Select all re-applies
checkedByDefault and skips declined), broadcasts.ts:1196-1202 (the
explicit-selection path never re-excludes already-sent rows).

R4-1 [DECISION] Select all would re-text decliners. ACCEPT. Select all
checks only what today's default would check, minus capped pairs.
R4-2 [DECISION] Run claim without a lease; join is a race. ACCEPT. The
app's one conditional write before enqueue is the claim; a renewed lease;
an expired lease means the job died and may be taken over.
R4-3 [PRECISION] Accommodation flags stay per pair; only unlawful flags
ask for a record change. ACCEPT.
R4-4 [PRECISION] Reaction condition misses legacy sent rows. ACCEPT.
sentAt fallback.
R4-5 [PRECISION] Job record TTL and key family. ACCEPT.

Round 4 totals: 5 findings, 5 ACCEPT. Decisions changed: yes (R4-1, R4-2),
both defects the round-3 rewrite introduced. HARD CAP REACHED: the loop
stops here and the open question - close the review on these fixes, or run
one more round on them - goes to Cameron with the spec gate.

## Totals, rounds 1-4

| Round | Findings | Accept | Reject | Defer | Decisions changed |
|---|---|---|---|---|---|
| 1 (A + B, merged) | 28 | 26 (3 partly rejected) | 3 partial | 0 | yes |
| 2 (A) | 22 | 22 | 0 | 0 | yes |
| 3 (A) | 7 | 7 | 0 | 0 | yes |
| 4 (A) | 5 | 5 | 0 | 0 | yes (2, introduced by round 3) |

Every REJECT, with its reason:
- M10 part: removing names and addresses from the cards. Rejected because
  Cameron decided to keep them (2026-10-25); the counterfactual check
  tests the consequence instead. Reviewer A conceded in round 2.
- M21 part: code comparing requirement text. Rejected because tenant pets
  and evictions are free text (contactsRepo.ts:332-333), so a code check
  would be the rule-based scorer A1 and Cameron rejected; the model's own
  failedRequirements report drives a code cap instead. Conceded.
- M28 part: a daily spend ceiling on Rank. Rejected as speculative: every
  press is a human click and the Rankings page shows spend; the testing
  key gets an account spend limit instead. Conceded.

## Round 5 (extension authorized by Cameron 2026-10-25; both reviewers continued)

Reports: r5-reviewer-a.md (7 findings: 1 decision, 6 precision),
r5-reviewer-b.md (16 findings: 7 decision, 9 precision). Verified before
ruling: sqsJobConsumer.ts:126-129 (the consumer awaits a whole receive
batch before receiving again); worker.ts:436-466 (extraction runs on its
own poll loop with DynamoDB state, not the queue); requirements.ts:69-108
(groups Screening, Pets, Move-in costs, Touring); contactsRepo.ts:362-363
(landlord req_credit_requirements, req_income_requirements).

R5-1 Ranking on the shared queue blocks every other job (B1). ACCEPT.
Ranking runs like extraction: its own worker poll loop over due
ranking-job records, never the SQS jobs queue. Decision changed: yes
(architecture; supersedes the queue parts of R3-2 and R4-2).
R5-2 Credit and income by field name only; cap-eligible keys undefined
(B2). ACCEPT. Rubric: credit or income content in ANY field is disregarded
and never reported failed. Cap-eligible keys listed: no_evictions_on_program,
evictions_notes, qualifications, no_pets, pets. Move-in costs, touring,
credit and income never cap. Decision changed: yes.
R5-3 An unlawful flag suppresses the cap only on its own pair (A1, B3).
ACCEPT. Unlawful flags are property-wide: once any pair raises one on a
field, that field caps no pair of that property. Decision changed: yes.
R5-4 Lease vs queued time; no fencing (B4). ACCEPT. Reframed by R5-1: the
app writes a queued record with a claim generation; the poll loop claims
it with a lease; the job checks its generation before each model call
and write and exits if superseded; a queued record has its own expiry.
Decision changed: yes.
R5-5 Disability and medical facts not on the never-extracted list (B5).
ACCEPT. Added except the stated accessibility need and an assistance
animal; the "one use" sentence fixed. Decision changed: yes.
R5-6 What a fair-housing test failure stops; the address swap (B6).
ACCEPT, planner default: a failure blocks enabling ranking (or B1's
matching facts) in production until it passes or Cameron decides; the
address swap stays within addresses equivalent for the tenant's stated
area. Decision changed: yes.
R5-7 Final read through the eventually consistent byUnit index (B7).
ACCEPT. After done, the composer reads the run's matches by key from the
base table.
R5-8 Extraction retries duplicate facts and reactions (B8). ACCEPT.
Reactions keyed by source message and kind; facts by label, value and
source message.
R5-9 Runtime allowlist (B9, contests M19). ACCEPT. The card function
drops every stored key that is not classified.
R5-10 Landlord card carries landlord credit and income (A2, B10). ACCEPT.
R5-11 Matching-facts display and remove control unowned (A3). ACCEPT. B1.
R5-12 Window toggle belongs to B4 (A4). ACCEPT.
R5-13 B2 row says "server-sent results" (A5). ACCEPT.
R5-14 Join ignores the window toggle (A6, B11). ACCEPT. A press with a
different window setting while a job runs is refused with "a ranking is
running"; it does not join.
R5-15 Cross-section mismatches (A7). ACCEPT. Banner list adds not
sendable; 19's last-heard-from order is property-anchor only; section 4's
deterministic list names the cap and the selection rules.
R5-16 The "never" bucket and fallback tie order (B12). ACCEPT.
R5-17 "A new text never stales" (B13). ACCEPT. "A text that adds nothing
to the record does not."
R5-18 Failed batch needs stored state (B14). ACCEPT. The read joins the
anchor's last job record, which lists failed batches.
R5-19 Partial authority mapping, citation, "trained against" (B15).
ACCEPT.
R5-20 Section 17 omits the WP3-scope reading B1 builds (B16, contests
M3). ACCEPT. Listed.

Round 5 totals: 23 findings, 20 merged rulings, all ACCEPT. Decisions
changed: yes (R5-1 to R5-6). Round 6 continues reviewer B (more accepted
decision findings this round).

## Round 6 (reviewer B continued; report r6-reviewer-b.md, 9 findings)

Verified before ruling: jobs/pollLoop.ts:54-77 (a poll tick runs with a
fresh pollRunId only), routes/aiRuns.ts:137 (AI runs routes admin only),
lib/tables.ts:645-655 (ai_runs: itemId key, one sparse byEntity index).

R6-1 [DECISION] The poll loses correlation and trace; AGENTS.md exception
unnamed. ACCEPT. The queued record carries the request's correlation id
and traceparent and the poll restores them; the exception to "all job
traffic through jobs.enqueue" is named, with the extraction precedent
and the reason.
R6-2 How the poll finds queued records; poll interval. ACCEPT. Queued
records carry a byEntity key family the poll queries; pickup latency and
the queued expiry count the shared poll interval.
R6-3 [DECISION] A false unlawful flag disables a lawful cap; no
dismissal; stale flags. ACCEPT. An unlawful flag becomes a property-level
record staff resolve (remove the text, or Dismiss as lawful, after which
that field is not flagged again until its text changes). While open it
suppresses the cap property-wide: a false flag costs a cap, never a
tenant.
R6-4 "Credit or income in ANY field" swallows rent and tenant portion.
ACCEPT. The disregard covers requirements about the tenant's credit or
income; rent, payment standard and the tenant's maximum portion stay
inputs.
R6-5 [DECISION] Reaction text outside the never-extracted list. ACCEPT.
The list and B1's test cover reaction text.
R6-6 Job states. ACCEPT. The poll itself takes over an expired lease
with a new generation; a superseded job can write at most the batch in
flight, which the newer job overwrites (accepted); the record's TTL is at
least RANKING_MAX_AGE_DAYS.
R6-7 Production switches unnamed. ACCEPT. AI_RANKING_ENABLED and
AI_MATCHING_FACTS_ENABLED, default off, like aiExtractionEnabled.
R6-8 [DECISION] Roles undecided. ACCEPT, planner default: Rank, Update
and review open to admin and va, as the composer is; the Rankings page
admin only, like the AI runs page.
R6-9 Leftovers. ACCEPT. "By exclusion" renamed; the B1 row gains the
facts display, remove control and suppression record; facts stored as a
list on the tenant contact; a credit, income or move-in-cost clause
inside a cap-eligible key never counts as failed.

Round 6 totals: 9 findings, 9 ACCEPT. Decisions changed: yes (R6-1, R6-3,
R6-5, R6-8). Round 7 continues reviewer B.
