---
id: ranking-unlawful-flag-reason-source
title: An unlawful flag's stored reason is one pair's own text, kept on the property with no TTL and shown on every ranking of it
type: decision
severity: med
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/services/ranking/flags.ts:75, app/src/services/ranking/flags.ts:109, app/src/services/ranking/runBatch.ts:329, app/src/repos/rankingRunsRepo.ts:891, app/src/services/ranking/readRanking.ts:476, app/src/routes/adminRankings.ts:276, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:40, dashboard/src/routes/settings/rankings/RankingRunDetail.tsx:159, app/test/rankingFlags.test.ts:67
---

**Problem.** An unlawful fair-housing flag is a PROPERTY record,
`uflag#<unitId>#<field>`, with no TTL (WP1 B2a spec D10). Its `reason` is
"the model's against-reason or unknown text naming it, else 'flagged as a
requirement fair housing does not allow'" (D10), and the code does exactly
that: `flagReason` (flags.ts:75-82) takes the first `against` text that
contains the field's words, else the first `unknowns` text that does, else
the default; `mergeRaisedFlags` stores it (flags.ts:109), `runBatch` writes
the record (runBatch.ts:329-338; the record is built at
rankingRunsRepo.ts:891-901, no `expires_at`); every ranking read returns it
for each property in view (readRanking.ts:476-482 - the property's own
ranking and every tenant anchor whose pool lists the property), as does the
run detail (adminRankings.ts:276-277); the page shows it as "Fair-housing
flag on <place>, <field>: <reason>" (RankAnchorPanel.tsx:40) and
"<field>: <reason>" (RankingRunDetail.tsx:159).

But against-reasons and unknowns describe THE PAIR - this tenant against
this property. The rubric forbids stating the unlawful requirement as a
reason against ("Do NOT apply an unlawful requirement ... add one unknowns
note that names the field", rubric.ts:74), so an against-reason that names
the field is, by the rubric's own contract, about something else: a LAWFUL
clause of the same field, or this tenant's facts. And the match is a
substring of the field key: the rubric's own example reason "no pets, has a
cat" (rubric.ts:82) names `pets`; "accessibility: needs a wheelchair-ready
unit" names `accessibility`; for the worked example's qualifications "No
kids under 12. No evictions in the last 3 years." (examples.ts:461), a
tenant with a recent eviction gets that failure as the FIRST reason against
(rubric.ts:59), and any wording that names qualifications becomes the
property's unlawful-flag reason. The first raising run keeps the record
(D10), so whichever tenant's pair raised it first speaks for the property
until the field's text is edited.

Why it matters: (a) one person's fact - possibly disability-related or
familial (an accessibility need, an assistance animal, children) or an
eviction - is copied out of the pair-scoped stores that expire after 180
days into a property record with no TTL, and is returned by GET
/api/rankings (admin and va) on every view involving that property: on
another tenant's page it reads as part of that tenant's ranking. (b) The
flag's one line of explanation then describes the wrong thing (the lawful
clause, or the tenant), and that line is what B4's admin review and Dismiss
will read to judge a fair-housing flag.

Found by the B2a code review round 2 (reviewer R2-server, finding
R2-server-1, MEDIUM): the mechanism CONFIRMED with a throwaway test on the
repo fakes (`runBatch` for tenant A with against "eviction in 2024 fails
qualifications" stored that text as the property's flag reason, with no
`expires_at`, and the property's read for tenant B alone returned it); the
model's wording is PLAUSIBLE. It is the same record as
[ranking-unlawful-flag-stale-overwrite](./ranking-unlawful-flag-stale-overwrite.md),
a separate defect.

**Decision for Cameron** (Q1 of the B2a code review round 2; raised at the
handback). Spec D10 names the source, so changing it is a ruling. The code
is unchanged until the ruling.

- **(a) Store only the fixed sentence** (RECOMMENDED by the review): the
  record's `reason` is always "flagged as a requirement fair housing does
  not allow" (`DEFAULT_FLAG_REASON`), so a property record never carries
  pair text; the pair's own text stays on its match and its run, under
  their 180-day TTL. A one-line change in `flagReason` (or its caller) plus
  its test. A narrower variant inside D10's words - accept only an unknown
  in the rubric's own form ("<field>: ... not applied (fair housing)") -
  is not safe: a tenant-specific unknown such as "pets: whether the dog is
  an assistance animal is unknown" shares the prefix.
- **(b) Keep spec D10 as written**: the record keeps the pair's against or
  unknown text naming the field.

Either way `app/test/rankingFlags.test.ts:67-88` pins today's order (its
fixtures have the model write the unlawful clause as a reason against - the
form the rubric forbids) and changes with (a). Test for (a): after `runBatch`
with a tenant-specific against-reason and unknown naming the flagged field,
the stored record's reason holds no pair text, and the property's read for
another tenant shows none.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R2-server.md (R2-server-1, and its challenge to A1-12) and R2-adjudications.md
(Q1).
