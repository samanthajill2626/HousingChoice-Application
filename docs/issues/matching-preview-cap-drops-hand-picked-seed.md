---
id: matching-preview-cap-drops-hand-picked-seed
title: Above the 1000-row preview bound, a blast's hand-picked recipient is silently cut from Review recipients and never texted
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-10-19
refs: app/src/routes/broadcasts.ts:780, app/src/routes/broadcasts.ts:1054, app/src/routes/broadcasts.ts:942, app/src/routes/broadcasts.ts:245, docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:492-495
---

**Problem.** The review rows of a filter blast are the resolved audience
FIRST and the hand-picked seeds LAST (`app/src/routes/broadcasts.ts:780`), and
the preview slices them to `MAX_BROADCAST_RECIPIENTS` (1000,
`broadcasts.ts:1054`). When more than 1000 rows match, a seed - the
`?contactId=` tenant after "Add more tenants by filters", or any draft seed -
falls past the bound: Review recipients lists exactly 1000 rows, the preview's
`truncated` stays false (it reports only the resolver's read bound), so no
notice says the list is short, while "Reaches N" counts every default-checked
row including the seed (`:942`). The dashboard's send posts the rows shown
(path (a), any explicit list of at most 1000 ids is accepted, `:245`), so the
staff member's own hand pick is never texted and nobody is told. The
matching-blast-rules spec's D8 line "above 1000 the send is refused anyway
(the recipient cap)" holds only for the API's no-body path (c).

Pre-existing: main's preview builds the same union and slice (code review R2
ran the same probe against a copy of main's route - same failure), so
`feat/matching-blast-rules` did not introduce it; it carried it into the
rewritten preview. Not reachable at today's volume (far fewer than 1000
Onboarding/Searching tenants match one property's housing authorities and
voucher size). Code review R2 finding R2-1
(`docs/superpowers/reviews/2026-10-14-matching-blast-rules/code-review/r2-review.md`).

**Suggested fix.** Put the resolved seeds FIRST in the union (the dashboard
re-sorts rows by last heard from, so only the bound sees the order), and when
the rows exceed `MAX_BROADCAST_RECIPIENTS` flag both the preview and the draft
create as `truncated`, so the existing "Too many tenants to read - some
matches may be missing from this list." alert and the " - the list is
incomplete" reach suffix show. Correct the spec's D8 sentence. Regression
test: 1001 consented Searching tenants plus one consented seed - the seed is
among `candidates` and `truncated` is true (today the seed is absent and
`truncated` is false).
