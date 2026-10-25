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
