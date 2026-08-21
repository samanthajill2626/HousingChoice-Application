---
id: typeahead-scale-needs-server-side-search
title: Contact/unit typeaheads filter the whole roster client-side - relevance is already wrong at 641 tenants
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-21
refs: dashboard/src/routes/contact/ContactSearchField.tsx:39, dashboard/src/api/paging.ts, dashboard/src/routes/contact/UnitSearchField.tsx
---

**Problem.** Every contact/unit typeahead loads the ENTIRE roster and filters it
in the browser. `fix/pagination-sweep` fixed the correctness half of this (the
roster is now complete rather than the server's first page), but the design has
two limits it does not address.

**1. Relevance is already wrong, today, at production scale.**
`ContactSearchField` caps the rendered list at `MAX_SHOWN = 8` and takes the
FIRST eight matches in array order. That array arrives in `byTypeStatus` GSI
order - partitioned by `type`, sorted by `status` - so typing "a" against the 641
tenants prod held on 2026-08-20 returns eight tenants chosen by their lifecycle
status, which is meaningless to the person typing. There is no scoring, no
prefix-vs-substring preference, and no surname weighting. A staff member
searching a common first name cannot reliably reach the person they want.

This is live now. It is NOT a future concern.

**2. The page-walk cap is a ceiling nobody will see coming.**
`fetchAllPages` stops at 50 pages x 100 rows = 5,000 records and logs a
`console.warn`. It deliberately returns NO truncation flag: one existed briefly,
no caller ever read it, and an unread flag is worse than none because it makes
the problem look handled (removed 2026-08-21). So at 5,000 records a list
silently becomes a prefix again - the exact failure this branch existed to kill -
with only a browser console line as the signal.

5,000 is far off at 641 tenants. The point is that the UX is already broken well
before the correctness ceiling is reached, so the ceiling should never be the
thing that forces the fix.

**Suggested fix.** A server-side search endpoint for contacts (and units), doing
the matching and ranking where the data is:

- query -> ranked matches, capped server-side (say 20), with the ranking
  explicit (prefix beats substring; surname weighted; maybe recent-interaction
  boost)
- the typeahead becomes debounced-fetch-on-type instead of load-everything-then-
  filter, so the client holds tens of rows rather than thousands
- removes the whole-roster read from the hot path of seven modals

That also retires the 5,000 ceiling rather than raising it, and removes the
reason `fetchAllPages` needs a cap large enough to be scary in the first place.

Until then the behaviour is correct-but-arbitrary: every tenant IS reachable if
the operator types enough characters to narrow below eight matches.

Related: `docs/issues/pending-roster-actions-uncapped-walker.md`;
`dashboard/src/api/paging.ts` header for why there is no truncation flag.
