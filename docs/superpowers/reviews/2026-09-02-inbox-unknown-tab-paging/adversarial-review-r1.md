# Adversarial review R1 - feat/inbox-unknown-tab-paging (5de0bc90)

Scope: the branch's single commit against `main`
(`git diff main...HEAD`), read with no spec, plan or handback. Read-only
review: nothing was edited, staged or committed, no suite was run, no server
was started. Anything I could not establish by reading a file is marked
UNVERIFIED.

Files under review: `app/src/routes/inbox.ts`, `app/src/routes/aiRuns.ts`,
`app/test/inboxApi.test.ts`, `app/test/inboxUnknownTab.test.ts`, and six files
under `docs/issues/`.

No BLOCKING and no HIGH findings. Seven findings follow, ordered by severity.

---

## 1. [MEDIUM] Two test comments still name the DELETED predicate as the rule, and one mutation probe cites code text that no longer exists

**What is wrong.** The commit replaces the page-head step-over predicate
`resume !== undefined` with `resume?.deferredContactId === contact.contactId`,
and the production comment says so explicitly. The diff is
insertion-only in `app/test/inboxUnknownTab.test.ts` (109 added, 0 deleted -
`git show --stat HEAD`), so the two older comments that state the OLD predicate
as the contract were left standing:

- `app/test/inboxUnknownTab.test.ts:551` - "So the retry is capped at ONE. THE
  CAP NOW REQUIRES A CURSOR" - the cap no longer requires a cursor, it requires
  a cursor that a DEFERRAL minted, naming this row. As written it is exactly the
  claim the commit was filed to remove.
- `app/test/inboxUnknownTab.test.ts:615` - "THE MUTATION PROBE: delete
  `resume !== undefined` from the page-head guard in app/src/routes/inbox.ts".
  That string does not appear in the guard any more
  (`app/src/routes/inbox.ts:2017-2021`); the only occurrence left in source is
  inside the historical narrative at `app/src/routes/inbox.ts:1987`. A reader
  following the probe literally finds nothing to delete.

**Evidence.** `app/src/routes/inbox.ts:2017-2021` (the new guard);
`app/src/routes/inbox.ts:1987` (the comment recording the old one);
`app/test/inboxUnknownTab.test.ts:551`, `:615`; `git show --stat HEAD` (test
file is 109 insertions, no deletions).

**What it implies.** In a repo whose comments are treated as the specification -
the new production comment at `inbox.ts:1978-2013` is a full paragraph of
exactly that kind - a test comment that names a removed predicate is a false
record 60 lines above the test that proves it false. The next person to touch
this guard has two mutually contradicting statements of the rule in the same
file, and the wrong one is the one attached to the older, more authoritative-
looking pin.

**Suggested fix.** Rewrite `:551` to "THE CAP REQUIRES A DEFERRAL CURSOR NAMING
THIS ROW" and restate `:615`'s probe as "replace the guard's first clause with
`resume !== undefined`" (which is what actually reproduces the old behaviour).

---

## 2. [MEDIUM] The step-over's termination guarantee is now conditional on the head row's identity being stable across two requests; the new comment states it unconditionally, and no test can reach the counter-case

**What is wrong.** `app/src/routes/inbox.ts:2003-2007` asserts "Exactly one
retry per row, then guaranteed progress, from ANY page - which is also why the
walk still terminates on a permanently failing row." That is true only while the
row at the resume position is the same contact on two consecutive requests.

Trace: a deferral mints `boundary = retryFrom` and `d = contact.contactId`
(`inbox.ts:2041-2042`). `retryFrom` is the position that RE-READS the failing
row, so when the page head fails and nothing was kept, the minted cursor's
POSITION is byte-identical to the one the client sent - only `d` changes
(`encodeUnknownCursor`, `inbox.ts:366-374`). Positional progress therefore
happens on the NEXT request, and only if that request's head row is the contact
`d` names. If it is a different contact and that read also fails, the request
defers again at the same position with a new `d`, and so on. Under the OLD
predicate any cursor licensed the step-over, so the position advanced by at
least one row on every cursor-bearing request unconditionally.

Reachability, stated honestly: it needs the head row's identity to change
between EVERY pair of consecutive requests while thread reads keep failing -
e.g. a new `type='unknown'` contact whose `contactId` sorts before the deferred
one inside the same status block (the block's order is `status` then the table
key, `app/test/helpers/contactsPartitionFake.ts:19-24`), or an operator status
flip moving the head row out of the block (the shape
`inbox.ts:1929-1950` already documents as the common triage action), during a
participant-GSI outage. It is narrow, and `useInbox`'s first-page refetch on an
inbound message resets the cursor anyway
(`dashboard/src/routes/inbox/useInbox.ts:283-311`). But the comment's claim is
unconditional and the code does not support it.

The two new tests cannot see this: the fake partition
(`app/test/helpers/contactsPartitionFake.ts`) is re-read from a static seed
array on every call, so no test in the suite can change the queue between two
`aggregateInbox` calls.

**Evidence.** `app/src/routes/inbox.ts:2003-2007` (the claim),
`:2017-2021` (the guard), `:2041-2042` (deferral mints boundary + `d`),
`:1839-1851` (`retryFrom` is the re-read position),
`app/src/routes/inbox.ts:366-374` (encoder);
`app/test/helpers/contactsPartitionFake.ts:105-122` (static, order by
`(status, contactId)`).

**What it implies.** The stated invariant ("guaranteed progress, from ANY page")
is stronger than the code. Anyone reasoning from that sentence in a future
change - for example, deleting the `!retryFromMoved` clause as "implied" - will
be reasoning from a false premise.

**Suggested fix.** Weaken the comment to name the actual condition ("progress
whenever the same row is at the head on two consecutive requests"), or make the
step-over fire on a positional match rather than an identity match - i.e. license
it when the cursor carries `d` AND `retryFrom` still equals `resume.position`,
regardless of which contact is failing.

---

## 3. [LOW] `encodeUnknownCursor` can mint a cursor `decodeUnknownCursor` refuses

**What is wrong.** The encoder gates on `deferredContactId !== undefined`
(`app/src/routes/inbox.ts:371`), so an empty-string contactId is encoded as
`d: ""`. The decoder rejects `d === ''` with a 400
(`app/src/routes/inbox.ts:440-442`). The server would therefore 400 a cursor it
minted itself, stranding the walk at that row with no client-side recovery
except restarting the tab.

**Evidence.** `app/src/routes/inbox.ts:367-372` (encoder spread),
`app/src/routes/inbox.ts:440-442` (decoder rejection).

**What it implies.** Only reachable if a `ContactItem` with `contactId: ''`
reaches the queue, which the repo should never produce - so the practical risk
is nil. It is still an encoder/decoder asymmetry in a module whose other three
fields are symmetric by construction, and the review brief asked for exactly
this check.

**Suggested fix.** Gate the spread on
`deferredContactId !== undefined && deferredContactId !== ''`, or assert
non-empty at the assignment site (`app/src/routes/inbox.ts:2042`).

---

## 4. [LOW] A well-formed but FORGED `d` licenses dropping a row that the server never retried; the decoder's comment reads as if the validation closed that

**What is wrong.** `app/src/routes/inbox.ts:437-439` says `d` "LICENSES a row
drop, so a malformed one is refused rather than silently ignored." The check
only refuses a malformed SHAPE. A well-formed forged `d` naming any contactId is
accepted, and the cursor is unsigned base64url of plain JSON
(`inbox.ts:373`), so nothing distinguishes a server-minted `d` from a
hand-written one. A client that pairs a forged `d` with the matching position
gets that row stepped over on its FIRST thread-read failure, with zero retries -
the precise defect this commit exists to remove, re-openable by the caller.

**Evidence.** `app/src/routes/inbox.ts:373` (unsigned encode),
`:437-442` (shape-only validation), `:2017-2021` (the guard trusts `d`).

**What it implies.** Consequence is small: the forger only harms their own
session's page, and the drop still requires a genuine participant-GSI failure on
that row. But the comment overstates what the check buys, and this endpoint's
other cursor validation carries an explicit "THIS IS ROBUSTNESS, NOT A SECURITY
FIX" paragraph (`inbox.ts:407-419`) precisely so nobody misreads the posture.

**Suggested fix.** Extend that same disclaimer to `d`: state that the shape
check buys a 400 instead of a silent no-op, and that a forged `d` can only cost
the forger one un-retried row on their own walk.

---

## 5. [LOW] `inbox-filter-tabs-full-walk.md`'s resolution says the Unknown tab "never consults `conv.type`". It does.

**What is wrong.** The new resolution block claims the shipping read "never
touches the open-conversation partition and never consults `conv.type`". The
second half is false: the unknown branch's `resolveOpenThreads` filters
`c.status === 'open' && c.type !== 'relay_group'`
(`app/src/routes/inbox.ts:1795`), and that predicate is load-bearing - a contact
whose only open thread is a relay group yields NO row, which the same reader
documents as coverage class b (`app/src/routes/inbox.ts:2047-2050`).

**Evidence.** `docs/issues/inbox-filter-tabs-full-walk.md`, resolution paragraph
("It never touches the open-conversation partition and never consults
`conv.type`"); `app/src/routes/inbox.ts:1795`;
`app/src/routes/inbox.ts:2047-2050`.

**What it implies.** The intended claim - that the tab no longer decides
membership from a stale `unknown_1to1` `conv.type` - is correct and is the point
of the paragraph. As written, a reader auditing the branch will grep
`conv.type` in the unknown branch, find it, and have to re-derive which half of
the sentence is true. That is the same prose-outlives-code trap this very file
records two paragraphs earlier.

**Suggested fix.** Reword to "never uses `conv.type` to decide QUEUE MEMBERSHIP
(the stale-`unknown_1to1` drift measured below); it still reads it to exclude
relay-group threads from a contact's open set."

---

## 6. [LOW, PRE-EXISTING] `inbox-parselimit-empty-one-row.md` is re-stamped resolved but still locates `parseLimit` at "lines 1731-1737"

**What is wrong.** The body's Problem paragraph says "`parseLimit` in
`app/src/routes/inbox.ts` (lines 1731-1737)". The function is at
`app/src/routes/inbox.ts:2550` on this branch and was at `:2501` on `main`
(`git show main:app/src/routes/inbox.ts | grep -n "function parseLimit"`), so
the locator was already ~770 lines stale before this diff.

**Evidence.** `docs/issues/inbox-parselimit-empty-one-row.md` (Problem
paragraph); `app/src/routes/inbox.ts:2550`; `main:app/src/routes/inbox.ts:2501`.

**What it implies.** PRE-EXISTING - the diff did not introduce it. But the diff
DID re-stamp this file `status: resolved` and rewrite its frontmatter, and a
closed issue is the artifact a future reader trusts most. Leaving a locator that
points into the middle of the unknown-queue branch is the cheapest possible
thing to have fixed while already editing the file.

**Suggested fix.** Drop the parenthetical line range, or replace it with the
function name alone (line numbers in this file have moved three times).

---

## 7. [LOW, PRE-EXISTING] `?limit=0` on `/api/inbox` now answers 200 + default page while seven sibling routes answer 400; `dashboard/src/api/paging.ts` documents the 400 as the repo convention

**What is wrong.** After this change `/api/inbox?limit=0`, `?limit=-5` and
`?limit=` all serve a 25-row page. The other seven `parseLimit` copies return
`undefined` for the same inputs, which the routes turn into a 400:
`app/src/routes/api.ts:449-455`, `broadcasts.ts:157-163`,
`contacts.ts:374-380`, `contactTimeline.ts:339-345`, `placements.ts:189-195`,
`units.ts:240-246`, `unmatchedEmail.ts:143-149` (pinned at
`app/test/unitsApi.test.ts:268` and `app/test/placementsApi.test.ts:144`).
`dashboard/src/api/paging.ts:33-37` states the convention as repo-wide: "routes
accept 1..100 and 400 anything outside that (`parseLimit`) rather than
clamping".

**Evidence.** `app/src/routes/inbox.ts:2550-2555`; the seven route files above;
`dashboard/src/api/paging.ts:33-37`.

**What it implies.** The split is deliberate and documented in
`docs/issues/inbox-parselimit-empty-one-row.md`, and the change actually REDUCES
the number of distinct behaviours (inbox used to floor to 1, a third variant).
So this is not a defect. It is worth naming because `paging.ts`'s comment is now
the only place in the repo that states a limit convention as universal, and it
is wrong for two of the nine routes - a future reader syncing the copies "back
to the convention" would re-open the closed issue.

**Suggested fix.** One sentence in `dashboard/src/api/paging.ts:33-37` noting
that `/api/inbox` and `/api/ai-runs` fall back to the default rather than 400ing.

---

## Verified OK

Correctness of the new code, traced by hand against the reader loop
(`app/src/routes/inbox.ts:1755-2245`) and `readUnknownQueue`
(`app/src/lib/unknownQueue.ts:311-380`):

- **Page one, no cursor.** `resume` undefined, so `resume?.deferredContactId` is
  undefined and can never equal a real `contactId` - the step-over cannot fire on
  a fresh load. Deferral mints `{ block: 0 }` + `d`, i.e. a real cursor
  (`inbox.ts:1851`, `:366-374`).
- **Cursor from a FULL page.** `boundary = after` at `inbox.ts:2077` with
  `deferredContactId` still undefined, so the emitted cursor carries no `d` and
  the next request's head row is DEFERRED, not dropped. This is the commit's
  stated fix and it holds.
- **Cursor from a block roll-over.** `boundary = read.next` at `:2091`, again
  with no `d`. Same outcome.
- **Cursor from a deferral.** Position is `retryFrom`, which is `after` of the
  previous consumed row (or the request's own resume point), so the deferred row
  is the next row the reader returns; `d` matches; the step-over fires exactly
  once and `retryFrom` advances (`:2026-2028`).
- **Permanently failing row.** Deferred once, stepped over on the second
  failure, walk continues and terminates - verified against a static queue for
  a row at page one, mid-page, after a fill, and after a roll-over. (The one
  exception is finding 2.)
- **Two adjacent permanently failing rows.** Request N defers X; request N+1
  steps over X then defers Y (`d` is re-stamped at `:2042`); request N+2 steps
  over Y. Position advances every request. No spin.
- **`deferredContactId` cannot go stale.** It is written only at `:2042`,
  immediately followed by `threadReadStopped = true; break` (`:2043-2044`), and
  the outer loop breaks on that flag at `:2084` - so `boundary` can never be
  overwritten after `d` is set, and `d` can never be attached to a page-full or
  roll-over boundary.
- **No new row loss.** The step-over now fires strictly LESS often than before,
  and the deferral path consumes nothing, so no path drops a row that the old
  code kept.
- **No double-serve.** A deferral's boundary is at-or-before the failing row and
  strictly after every row kept on that page, so rows already emitted cannot be
  re-emitted. `keptContacts.length === 0` really is implied by `!retryFromMoved`
  (a kept row either advances `retryFrom` at `:2081-2082` or fills and breaks at
  `:2063-2078`).
- **`!retryFromMoved` means "first consumed row of this request".** The outer
  fill loop only re-enters after consuming every row of a read, and every such
  path sets `retryFromMoved = true` (`:1919`, `:1960`, `:2053`, `:2082`,
  `:2105`), so there is no re-entry with the flag still false.
- **Exactly `n * limit` rows.** Unchanged by this diff: the last page fills at
  its last row and mints a cursor, costing one empty round trip
  (`inbox.ts:2063-2078`, pinned at
  `app/test/inbox.integration.test.ts:522-531`).
- **Scan-budget stop.** `budgetStopped` path at `:2106-2125` sets `boundary` but
  not `deferredContactId`, so a budget-stopped cursor carries no `d`. Correct.
- **Decoder vs encoder, and vs a hand-crafted cursor.** `d` is checked before
  `k` and after `b`; `d: 7`, `d: null`, `d: {}`, `d: []` and `d: ''` all 400
  (`:440-442`). `d` never reaches DynamoDB, so no new 500-where-400-was-promised
  path exists. The namespace tag is unchanged, so a `d`-bearing cursor replayed
  under `all` / `groups` / `unread` is still rejected on `q`
  (`inbox.ts:1755-1758` and the `q` guard in `decodeCursor` at `:319-321`).

`parseLimit`:

- `''`, `' '`, `'0'`, `'-5'` -> `DEFAULT_INBOX_LIMIT` (25); `'1'` -> 1; `'1000'`
  -> clamped to `MAX_INBOX_LIMIT` (100), not a 400; `'abc'`, `'1.5'`,
  `'Infinity'`, a repeated `?limit=` (array) -> default. `'0x10'` -> 16 and
  `'1e3'` -> 100, unchanged from `main` (`inbox.ts:2550-2555`).
- The route never passes 0 downstream, so `readUnknownQueue`'s `want < 1` throw
  (`app/src/lib/unknownQueue.ts:326-328`) and the repo's `opts.limit ?? DEFAULT`
  remain unreachable from HTTP - the comment at
  `app/src/lib/unknownQueue.ts:299` ("parseLimit clamps to 1..100") is still
  true.
- The `aiRuns.ts` comment rewrite is accurate: the two predicates are now the
  same shape (`app/src/routes/aiRuns.ts:75-86` vs
  `app/src/routes/inbox.ts:2551-2554`).

Unenumerated surfaces (grepped repo-wide):

- Only `app/src/routes/inbox.ts` encodes or decodes the unknown cursor; nothing
  in `dashboard/` or `e2e/` inspects its bytes. `useInbox` round-trips
  `nextCursor` opaquely and re-sets state from it
  (`dashboard/src/routes/inbox/useInbox.ts:240`, `:344`, `:546`), so a cursor
  that differs only in `d` is a new string and Load more stays live.
- `dashboard/src/routes/inbox/Inbox.tsx:64`, `:284` gate the empty copy and Load
  more the way the new comment claims (`hasMore` alone; `emptyMoreCopy()` for
  `serverRowCount === 0 && hasMore`), so the more-frequent empty-page-with-cursor
  state renders correctly.
- `e2e/performance/routes.ts:292` pins `/api/inbox` with query keys
  `['filter','limit']` only - no limit VALUE and no cursor shape. `redact.ts:133`
  redacts cursor values generically. Nothing in `e2e/` breaks.
- No existing test pins `?limit=0` -> one row on `/api/inbox`;
  `app/test/inbox.integration.test.ts:347` uses `limit=1`, which is unchanged.
- `app/scripts/profile-inbox.ts` reads only `page.nextCursor !== null` (`:156`).

Tests:

- Both new `inboxUnknownTab.test.ts` cases go RED on reverting the guard to
  `resume !== undefined`: request two would step over `c-f3-flaky` / `c-g3-broken`
  and return `[c-f4]` / `[c-g4]`, failing `expect(second.rows).toEqual([])` in
  each. The second case also guards the encoder: if `d` were never emitted, the
  step-over could never fire and `third.rows` would be `[]` rather than
  `['c-g4']`.
- All four new `inboxApi.test.ts` `?limit=` rows go RED on the old `Math.max(1, n)`
  (each would serve 1 row, not 3). `makeWebhookHarness()` builds an EMPTY world
  (`app/test/helpers/twilioWebhookHarness.ts:4223`, `createFakeWorld` at `:414`,
  which seeds no contacts or conversations), so the 3-row expectations are sound.
- The two new tamper rows (`d: 7`, `d: ''`) go RED if the `d` validation is
  removed. The honest-`d` round trip pins that a valid `d` is not itself a 400.
- The pre-existing page-head and roll-over pins still pass under the new
  predicate (traced: `c-h1-broken` defers with `d` then matches; the `c-r3-broken`
  roll-over walk costs one extra page and stays inside its 8-page guard).
- `app/test/helpers/contactsPartitionFake.ts` models the byTypeStatus index
  closely enough for these assertions: sparse index (`:109`), key-condition
  narrowing (`:110-111`), range-key sort (`:117-122`), Limit BEFORE the
  FilterExpression (`:180-183`), LEK on limit-reached rather than
  rows-remaining (`:188`), and POSITIONAL resume (`:167-172`). Its one invented
  property - the `contactId` tie-break - is documented at `:26-49` and the new
  tests only need a deterministic order, not that specific one. Its real
  limitation for this diff is that it is static (see finding 2).

Repo rules:

- Every added line in the diff is ASCII (checked mechanically over
  `git diff main...HEAD`, all `+` lines).
- The commit touches 10 files, all germane; the message carries a
  `Co-Authored-By` trailer naming the model. `docs/issues/INDEX.md` is not in the
  commit (correct - it is gitignored and derived).
- All frontmatter fields used in the six issue files are in the schema at
  `docs/issues/README.md:41-58` ("Frontmatter schema": `id title type severity
  status area created updated resolved refs`), with valid
  `type` / `severity` / `status` values, and
  `resolved:` set wherever `status: resolved`.
- Every cross-link in the new and re-stamped issue files resolves:
  `inbox-all-tab-open-partition-safety-net.md`,
  `staff-thread-needs-triage-chip-all-unread.md`,
  `unknown-queue-page-head-drop-after-filled-page.md`,
  `unknown-queue-status-flip-duplicates-across-pages.md`,
  `denormalize-contact-last-activity-for-ordered-paging.md`, and
  `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md` all exist.
- Doc claims spot-checked against code and found CORRECT: `roleFromContact`
  returns `'unknown'` for any non-tenant/landlord/partner type
  (`app/src/routes/inbox.ts:574-581`); `needsTriage: role === 'unknown'`
  (`:1027`); the "Needs triage" chip
  (`dashboard/src/routes/inbox/InboxRow.tsx:106`); the `role` union on the wire
  (`dashboard/src/api/types.ts:3035`); the `team_member` seed note
  (`app/src/lib/seed/lean.ts:156-160`); no existing `filter=all` +
  `team_member` + `needsTriage:false` pin (the only `team_member` inbox pin is
  `app/test/inboxUnknownParity.test.ts:185-194`, which covers `filter=unknown`);
  the `all` pager breaking only on fill or exhaustion and never setting the wire
  `truncated` flag (`app/src/routes/inbox.ts:2258-2311`); the `moreChunks`
  binding and its single reader (`:2265`, `:2306`); the three referenced commits
  (`66989d6f`, `1467832b`, `1ceb2e52`) exist with the quoted subjects; the audit
  flags `--audit-triage-partition`, `--no-status-narrow`, `--audit-unknown-page`,
  `--audit-tab-vs-partition` all exist in
  `app/scripts/measure-unread-contact-coverage.ts:1002-1017`; "the other seven
  `parseLimit` copies (400 on an empty value)" is exactly right - seven copies,
  all 400 on `''`.

UNVERIFIED (not attempted, per the read-only brief):

- No suite was executed. Every RED/GREEN statement above is a code reading, not
  a run. In particular `?limit=1` and `?limit=1000` against the webhook harness's
  `listByLastActivity` fake were not executed end to end.
- `npm run typecheck` and gate-5 `eslint` were not run. The one construct I would
  want a compiler for is the narrowing of `payload.d` from `unknown` to
  `string | undefined` after the compound throw at `inbox.ts:437-439`; I believe
  TypeScript narrows it, but I did not prove it.
- The hermetic lane-8 audit numbers quoted in
  `docs/issues/inbox-filter-tabs-full-walk.md` (lean 0 rows / 1 Query; full 1
  row / 1 Query; the retired walk's 11-for-1) cannot be checked without running
  the measurement script against a lane, which this review did not do.
