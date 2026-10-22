# FW1 report - feat/flyer-leads (code review round 1, fix wave 1)

Findings only. Commits: `3f150137` (comments, docs, the test title),
`ee2d18fe` (the two new issue files). Every work-list item (adjudications
FIX / DOC / FILE rows) is done; the brief's line hints all matched the live
tree at `6773bfd2`.

## Where the live code differs from the adjudication / brief wording

1. A9, `ledgerEntryCounts`. The brief says the census (`ledgerEntryCounts`)
   and the summary "can differ" on a corrupt non-string `countedAt`. The two
   PREDICATES differ (`!== undefined` vs `typeof === 'string'`), but the
   census cannot reach that case today: `app/scripts/repair-share-outcomes.ts:829`
   applies `ledgerEntryCounts` only to the forecast entry for a pair with NO
   row, built by `ledgerEntryForSlot` -> `ledgerEntryFor`
   (`app/src/services/shareLedger.ts:54-70`), which stamps a string
   `countedAt` or none; recount / uncount go through `ledgerRowCounted` and
   `summarize`. The docstring (`shareLedger.ts:101-112`) says exactly that: the
   two agree on every entry the ledger writes, differ only on a corrupt
   stored one, and the census agrees with the summary where it calls this;
   a caller that applied it to a stored entry could disagree.

## Same claims found beyond the work list (corrected in 3f150137)

- `app/test/activityEventsRepoConsistentRead.test.ts:1-7` - the AR12 test
  header made the same "two quick sign-ups see each other's pin" claim
  (comment only; the file stays 2/2 green).
- `app/src/repos/activityEventsRepo.ts:218-223` - the hasEventSince
  IMPLEMENTATION comment, besides the interface docstring (`:136-148`).
- `e2e/support/selectors.md:52` - the sign-up pin row's "At most one pin per
  contact per property ... per 24 hours" (the row C4 edits) now says "for
  sign-ups that do not overlap" and cites the new issue.
- `app/src/services/shareLedger.ts:260-264` - applyFlyerShareEntry said "a
  public request never undoes a staff decision", which A5 / C2 contradicts;
  now "never undoes a decline already written", citing
  `docs/issues/flyer-signup-decline-click-race.md`. It was the only such
  claim in app/src, dashboard/src, documentation, e2e and docs/issues.
- `app/src/routes/public.ts:27-44` - the header rewrite dropped a stray `)`
  the branch had left at the end of the POST entry (main opened it at
  "(creates/dedupes ...").
- `docs/issues/flyer-signup-decline-click-race.md` adds one consequence from
  code reading, NOT part of proof B: in the race the route still records its
  "Not interested in <address>" timeline event and the property Activity row
  (`app/src/routes/units.ts:1695-1702`), so the timeline says Not interested
  while the pair reads Signed up.

## Not done (outside the ruling)

- C5 named only the `public.ts` refs. The two issue files' refs into OTHER
  files are stale too (pre-existing on main; the branch never touched those
  files) and are left as filed - the deleted-contact update now says so:
  `deleted-contact-web-signup-silent.md` cites `contactsRepo.ts:666-693`
  (findByPhone is now `app/src/repos/contactsRepo.ts:1287`),
  `sendMessage.ts:268-275` (the deleted gate is now
  `app/src/services/sendMessage.ts:532-540`) and `inbox.ts:437-448` (the
  fresh-inbound test is now `app/src/routes/inbox.ts:1053-1060`);
  `public-welcome-text-global-cap.md` cites `app.ts:165` (the /public limiter
  is now `app/src/app.ts:185-191`) and `rateLimit.ts:81` (clientIpOf is now
  `app/src/middleware/rateLimit.ts:90`).
