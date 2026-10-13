# Code review round 1 - fix wave 1 (FW1) - decisions record

Date: 2026-10-13. Branch `feat/last-heard-from`, base 177bae7a (the round-1
adjudications). Scope: exactly the "FIX in the fix wave" list of
`adjudications-round1.md` - A-1, A-3, ADV-3, ADV-2, A-2, ADV-1 (comment + PIN
only), ORCH-1. Nothing under "NO CHANGE" was touched. Strict TDD: a RED test
before every behavior change; the ADV-1 PIN is green on unchanged code by
design. No slow gate was run (no `npm test`, `npm run e2e`, `npm run smoke`);
Playwright was not run.

## Commits (one per item)

| item | commit | what |
|---|---|---|
| A-3 | b1d32988 | outcome route: `saved: true` on a late 503 only when the click wrote |
| ADV-3 | 41f6a6c3 | Interested creates the tour BEFORE clearing an effective decline |
| ADV-2 | 13587b2e | buildFollowUps reads the recipient projection, requireComplete |
| ORCH-1 | 8066dddc | Follow up group heading name `<unitLabel> - <n> waiting` |
| A-1 | 22370bbe | contact header: facts text is the one shrinking child |
| A-2 | c912a21a | `unitLabel` comment names the server formatter (comment only) |
| ADV-1 | da67b0f1 | `declined` field comment corrected + PIN (behavior unchanged) |

Typecheck (`npm run typecheck`) exit 0 after every commit. eslint exit 0 on
every touched `.ts` / `.tsx` file (CSS is not linted). Every added line ASCII.

## Per item - evidence and decisions

### A-3 (b1d32988)
- RED: `listingSendOutcomeApi.test.ts:261` (existing tour, no decline, the
  re-projection tours read throws) and `:284` (same, the re-read finds no
  counted row) both failed on `expected { error, saved } to deeply equal
  { error }`. GREEN after the change.
- Change: a `wrote` flag (`app/src/routes/units.ts:1273`) set after
  setDeclined / clearDeclined 'ok' / tour create; both late-503 answers use
  it (`units.ts:1386`). The route header comment states the rule.
- Decision: the 'clear' outcome on a row with no decline still counts as a
  write (clearDeclined ran an UpdateItem) - the adjudication lists
  clearDeclined as a write without exception.
- Decision: the re-projection warn line now reads
  `outcome: re-projection read failed - 503` with a `wrote` field (it used to
  say "after the write - 503 saved", false for the no-write case). Nothing
  pinned the old text (only the historical plan quotes it).

### ADV-3 (41f6a6c3)
- RED: the knowing rewrite of the order pin (`listingSendOutcomeApi.test.ts:379`,
  now create THEN clear) failed on the old order; `:392` (create throws ->
  500, stored decline intact, no event, no tour) failed with the decline gone;
  `:409` failed with a 404. All GREEN after.
- Change: `units.ts` Interested branch - effectiveness is judged on the tours
  AS READ, before the create (`units.ts:1307`); then create + listing_interested;
  then clear + listing_decline_cleared. The route header comment
  (`units.ts:1220-1226`) says this deliberately reverses spec 5.4 steps 3/4
  per adjudication ADV-3.
- Decision (new edge the reorder creates): a clear that answers 'not_found'
  AFTER a successful create is no longer a 404 - the tour was written, so it
  records no cleared event and falls through to the re-projection, which
  answers 503 `saved: true` for an uncounted row (`units.ts:1331`). With no
  create, 'not_found' is still the 404 `send_not_found`. Pinned at `:409`.
- Note: the two events share one `at`, and the activity SK is
  `<at>#<random eventId>` (`app/src/repos/activityEventsRepo.ts:9`, :142), so
  their relative display order was already arbitrary; no e2e or dashboard test
  pins it (grep).

### ADV-2 (13587b2e)
- Verified before changing: `RECIPIENT_PROJECTION`
  (`app/src/repos/contactsRepo.ts:1043-1055`, with DISPLAY_PROJECTION
  :1027-1036) carries contactId, firstName, lastName, phone, deleted_at, type,
  role, status, last_heard_from_at, sms_opt_out, sms_unreachable - every
  attribute buildFollowUps reads (nameOf, isEligibleRecipient, the outcome
  derivation, the item fields). Nothing missing; the projection was not widened.
- RED: `followUps.test.ts:232` (one batch through the projected read, with
  requireComplete, and NO whole-item read) failed with 0 projected batches;
  the reject case failed (not an IncompleteBatchReadError);
  `followUpsApi.test.ts:49` (spy on the projected read rejecting with
  IncompleteBatchReadError) answered 200. All GREEN after.
- Change: `FollowUpsDeps.contacts` is `Pick<ContactsRepo,
  'getRecipientDisplaysByIds'>` (`app/src/services/followUps.ts:77`); the
  batch at :145. Same completeness contract: an incomplete batch rejects and
  the route answers 503.
- Test fake (`followUps.test.ts:38-47`): serves PROJECTED contacts only, so
  every existing case now runs on projected data; it also records any
  whole-item read (asserted empty).
- Decision: the projection types `type` optional while `FollowUpItem.type` is
  required; a projected contact with no type is skipped (`followUps.ts:156`).
  Unreachable for a real item (type is required on every contact); pinned at
  `followUps.test.ts:207-214`.

### ORCH-1 (8066dddc)
- RED: `FollowUpView.test.tsx:83` (headings named `<unitLabel> - <n> waiting`,
  in order; the region shares the name) and the Not interested / Undo case
  (name follows the count) failed with "Unable to find ... name". GREEN after.
- Change: an explicit `aria-label` on the group `h2`
  (`dashboard/src/routes/broadcasts/FollowUpView.tsx:236`); the section keeps
  `aria-labelledby` and takes the heading's name. Visible text unchanged.
- Decision: aria-label rather than a visually hidden " - " span - the address
  and the count are flex items, and a separator whose spaces sit at a flex
  item's edges is exactly what a from-content name drops; an explicit name is
  deterministic in every browser.
- Knowing rewrite: the test that pinned the concatenated textContent now pins
  the accessible names.
- e2e: `follow-up-tab.spec.ts:122-124` `groupFor` matches
  `^<escaped street line>` against the region name; the unitLabel starts with
  the street line, so `<unitLabel> - <n> waiting` still matches; the group
  `toContainText('<n> waiting')` reads textContent, unchanged. Only the
  helper's comment (:119-121) was updated. Not run.

### A-1 (22370bbe) - CSS + markup only
- No new test (jsdom does no layout). `ContactDetail.test.tsx`: 132 / 132
  green, including the pins on the facts span's exact text and the heard
  span's text / title (`ContactDetail.test.tsx:2878-2922`).
- Change: the facts span gets `.factsText`, the separator becomes its own
  `.factsSep` span (`dashboard/src/routes/contact/ContactDetail.tsx:1006-1007`);
  `.facts` is a one-line flex row (`ContactDetail.module.css:96`), `.factsText`
  the only shrinkable / ellipsizing child (:107), `.factsSep` `flex: 0 0 auto;
  white-space: pre` (:116 - pre keeps the separator's spaces, which a flex item
  would trim), `.heardFrom` `flex: 0 0 auto` (:124). Text nodes unchanged.
- For self-QA at a 360px viewport (to MEASURE; estimated, not rendered):
  below 768px the sidebar is hidden and AppFrame `.content` pads 24px a side
  (312px); the header pads 16px a side (280px); at <=860px the header wraps,
  the actions take their own row, and the identity column gets about
  280 - 36 (avatar) - 12 (gap) = 232px. At 12px (`--fs-xs`) "Last heard from
  Today 2:14 PM" is roughly 170-190px and " - " about 10px, so a tenant with
  voucher + housing authority shows the facts text cut to a few characters
  plus an ellipsis ("Vouc..."), then " - Last heard from Today 2:14 PM" whole;
  a "Never" label leaves room for about "Voucher 2BR - At...". Expected
  measurements: the `.heardFrom` span's right edge <= the `.facts` right edge
  and its scrollWidth == clientWidth; `.factsText` scrollWidth > clientWidth;
  visible spaces on both sides of the dash. A contact with no facts shows the
  heard span alone.

### A-2 (c912a21a) - comment only
- `app/src/services/followUps.ts:44-47`: `unitLabel` is the SERVER formatter
  (`app/src/lib/address.ts` formatAddress, `City, ST ZIP`) as spec 5.6 / 14.3
  mandate - not the dashboard's shortAddress (`City, ST, ZIP`). No TODO marker
  was filed (the adjudication accepted a comment fix only; formatter
  alignment is out of scope).

### ADV-1 (da67b0f1) - comment + PIN, behavior UNCHANGED
- `app/src/repos/listingSendsRepo.ts:106-113`: the `declined` field comment no
  longer says a superseded record "stays ... simply ineffective"; it says
  supersession is recomputed on every read from sentAt and the QUALIFYING
  tours, so a decline superseded only by a tour is effective again once that
  tour is canceled, no_show or closed not a fit.
- PIN: `app/test/listingSendOutcome.test.ts:104` - decline T1, tour created
  T2 > T1 -> interested; the same tour later canceled / no_show / closed
  not_a_fit (lastMarkedAt T3) -> not_interested. 4 cases, green on unchanged
  code. The PIN's own comment says it changes only with Cameron's call
  (raised in the handback with the reviewer's narrower alternative).

## Knowing rewrites (rewritten, never deleted)
- `listingSendOutcomeApi.test.ts:379` - the event-order pin, clear THEN
  create -> create THEN clear (ADV-3).
- `followUps.test.ts` - the fake's contacts read and the reject case moved to
  the projected read (ADV-2).
- `followUpsApi.test.ts:49` - the incomplete-batch spy moved from getManyByIds
  to getRecipientDisplaysByIds (ADV-2).
- `FollowUpView.test.tsx:83` - the concatenated textContent pin became
  accessible-name pins (ORCH-1).

## Test runs (final, after the last commit)
- app: listingSendOutcomeApi 33, listingSendsApi 25, followUps 14,
  followUpsApi 4, listingSendOutcome 42 - 5 files, 118 passed.
- dashboard: ContactDetail 132, FollowUpView 18, BroadcastsList 26 - 3 files,
  176 passed.
- `npm run typecheck` exit 0.
