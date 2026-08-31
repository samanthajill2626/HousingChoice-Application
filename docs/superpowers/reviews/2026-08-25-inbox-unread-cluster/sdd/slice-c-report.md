# Slice C (T5) - THE FLIP - implementer report

Commit: **66989d6fc7ee70df7d6523ccca63efea70daeef3**
(`feat(inbox): filter=unknown reads the contact triage partition, not the
open-partition walk`, trailer `Co-Authored-By: Claude Opus 5`)

Five paths staged explicitly, exactly as the plan's Step 13 names them:
`app/src/routes/inbox.ts`, `app/test/inboxUnknownTab.test.ts`,
`app/test/inboxUnknownParity.test.ts`, `app/test/inboxFeed.test.ts`,
`app/test/inboxApi.test.ts`. 5 files changed, 916 insertions, 57 deletions.
Bare `git status` read before staging: clean tree apart from these five, no
merge in progress.

---

## 1. The RED run (before any production code)

`cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/inboxUnknownTab.test.ts`

```
 Test Files  1 failed (1)
      Tests  10 failed | 2 passed (12)
```

Per-test, verbatim:

```
 x costs one partition Query, never the open-partition walk: ...
   -> expected +0 to be 1 // Object.is equality        (calls.listByType)
 x a cap-cut queue: single page, no truncated key, WARNed ...
   -> expected [ 'c-u3', 'c-u2', 'c-u1', 'c-u0' ] to deeply equal [ 'c-u1', 'c-u0' ]
 x windows the sorted result to the request limit and WARNs ...
   -> expected false to be true // Object.is equality
 x rejects any cursor: the unknown feed mints none ...
   -> promise resolved "{ rows: [], nextCursor: null }" instead of rejecting
 x requirement 4: a THROWN thread read withholds ONE row loudly ...
   -> expected [ 'c-broken', 'c-ok' ] to deeply equal [ 'c-ok' ]
 v class b: a contact whose only threads are closed or relay_group yields no row
 x class d via byUnread: ... -> expected [...] to have a length of 1 but got 2
 x a CAPPED sweep is a floor and says so ...
   -> expected [ { kind: 'contact', ...(11) } ] to deeply equal []
 x a failed triage-partition Query is LOUD ...
   -> promise resolved "{ rows: [], nextCursor: null }" instead of rejecting
 x THE READ THAT SHIPS: ... -> expected +0 to be 1 (calls.listByType)
 v sorts partition rows and resurfaced rows together, newest displayed activity first
 x the live type re-check drops a stale-index row ...
   -> expected [ { kind: 'unknown', ...(9) } ] to deeply equal []
```

**It failed for the RIGHT reason.** The cost test reported `listByType: 0`
(expected 1) because the old pager still served the filter; the cursor test
resolved `{ rows: [], nextCursor: null }` instead of rejecting. No fixture
TypeError anywhere - the 12 tests all constructed and ran. The two that passed
green-on-red are honest: class (b) and the newest-first sort produce the same
answer under both readers, which is exactly what a parity-preserving class
should do.

## 2. The GREEN run

`cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts
test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts
test/unknownQueue.test.ts test/contactsPartitionFake.test.ts`

Per-file counts (final run, after the typecheck fix in section 5):

| file | tests | result |
| --- | --- | --- |
| test/unknownQueue.test.ts | 8 | passed |
| test/contactsPartitionFake.test.ts | 7 | passed |
| test/inboxUnknownParity.test.ts | 7 | passed |
| test/inboxUnknownTab.test.ts | 12 | passed |
| test/inboxGroups.test.ts | 18 | passed |
| test/inboxFeed.test.ts | 62 | passed |
| test/inboxApi.test.ts | 53 | passed |
| **total** | **167** | **7 files passed, 167 passed** |

No skips, no retries. `inboxGroups.test.ts` took NO edit and is green - its
`calls.groupLimits` pin proves the group partition stays untouched under
`filter=unknown`.

**Every parity pin other than the two `// FLIP:` ones passed byte-identical.**
Nothing in `inboxUnknownParity.test.ts` moved except those two, and no pin was
repinned to whatever the code happened to do.

## 3. Typecheck

`cd W:\tmp\inbox-unread-cluster` then `npm run typecheck` -> **EXIT=0** (all
five workspaces: app x3 tsconfigs, dashboard, e2e, fake-twilio,
fake-twilio-web).

First attempt exited 2 on ONE real finding - see section 5.

Additionally (not required, run as a cheap orphan-import check):
`npx eslint` on the five touched files -> **exit 0**.

ASCII check: every ADDED line in the four modified files, and the whole of the
new test file, verified free of non-ASCII bytes
(`LC_ALL=C grep '[^ -~]'`, no matches). The pre-existing non-ASCII in
`inbox.ts` (the em-dash / arrow lines the research file flagged) was not
retyped.

## 4. The EIGHT comment sites, post-edit line numbers

All located by CONTENT, not by the pre-edit line numbers, as instructed.

| # | post-edit line | site | what changed |
| --- | --- | --- | --- |
| (a) | **629** | read-accounting SCOPE bullet | "filters `all` and `unknown`" -> filter `all` only; added a second bullet naming the unknown branch's OWN fields (`queueContacts`/`queuePages`/`threadReadFailures`/`sweepScanned`/`resurfaceTruncated`/`resurfaceCapped`) and stating that `drops` IS shared while `rawScanned`/`rawQueries` stay zero there. |
| (b) | **744** | `passesFilter` `case 'unknown':` | Gained the SAME keep-comment shape the `'unread'` arm above it carries: unreachable since the 2026-08-25 contact-side read, NOT removable because the switch is exhaustive with no `default:`. |
| (c1) | **884** | `rowForConversation` header | "THE OPEN-PARTITION PATH ONLY (filters `all` and `unknown`)" -> `filter=all` ALONE, naming both the unread branch and the new unknown branch as the reasons BOTH sets of arms below are unreachable. |
| (c2) | **957-962** | the `unknownFilterRole` guard | Marked DEAD ARM in the same wording the two `filter === 'unread'` arms use, plus an explicit FOR THE LOG READER paragraph: `unknownFilterRole` is the counter's only site in the file, so its absence means the arm is dead, not that nothing was rejected - the equivalent rejection is now `unknownQueueRetyped`. |
| (d1) | **1889** | relay-merge drop comment | Rewritten: the arm USED to reject every relay row under `unknown`; that filter now returns before the merge, so `filteredRelay` can no longer fire under it. The counter now guards FUTURE filters reaching the merge; read its absence as "no information". |
| (d2) | **1923-1933** | group-source gate | The `filter !== 'unknown'` TERM had to be DELETED, not kept - see section 5. The comment now records why (TS2367, narrowed to `'all'`) and tells a future filter's author to decide its group posture at that line. |
| (e) | **364** | `decodeUnreadCursor`'s "a cursor minted under `all`/`unknown`" | Now names `all` and `groups` only, and states outright that `unknown` MINTS NO CURSOR since 2026-08-25 and rejects every cursor before any decode runs. |
| (f) | **844** | `buildContactRow`'s "exactly like a no-contact number" | Kept the `needsTriage`-off-the-ROLE rationale (still true, and still what `all`/`unread` rows render from) but retired the EQUIVALENCE: added a paragraph saying the two are no longer equivalent on the unknown TAB (class e), with an explicit "do not read this comment as 'a contactless number appears under filter=unknown'". |
| (g) | **991** | "NOT dead - it still runs for `all` and `unknown`" | -> runs for `all` only, with a parenthetical that the equivalent guard now lives in the unknown branch's resurfacing loop. |
| (h) | **1944** | `filteredGroup` keep-comment | Both stale claims fixed: `unknown` no longer "gated out above" (it returns from its own branch earlier), and `filteredRelay` no longer "catches on `unknown` today" - the comment now says BOTH counters are dead for the same reason and both absences read as "no information". |

(Nine rows because site (c) and site (d) are each two locations, as the
worklist describes them.)

The new branch itself opens at **inbox.ts:1528** (`if (filter === 'unknown') {`),
inserted immediately after the unread branch's closing `}` and before
`const rows: InboxRow[] = [];`, exactly as binding correction 1 specified.

## 5. Deviations from the plan's literal code

**ONE, and it was forced by the compiler.**

The plan's Step 6 item 4 says of the group-source gate
(`if (startKey === undefined && filter !== 'unknown')`): "the gate is now
belt-and-braces behind the branch's early return - keep it, but say that."

**It cannot be kept.** With `groups`, `unread` and now `unknown` all returning
from their own branches above that line, TypeScript's control-flow analysis
narrows `filter` to the literal `'all'`, and the first typecheck failed:

```
src/routes/inbox.ts(1929,33): error TS2367: This comparison appears to be
unintentional because the types '"all"' and '"unknown"' have no overlap.
```

Resolution: dropped the `&& filter !== 'unknown'` term, leaving
`if (startKey === undefined) {`, and replaced the comment with a record of WHY
the term is gone plus an instruction for whoever adds the next filter. This is
behaviour-identical - `filter` could only be `'all'` at that line at runtime
too, because the unknown branch returns unconditionally - and it is the same
discipline the plan already applies to `moreChunks` in its Out-of-scope note
(a construct whose only justification is removed must be removed, not left to
fail a gate).

Note WHY the sibling dead arms do NOT hit this: `passesFilter` (line 735) and
`rowForConversation` (line 888) are closures DECLARED before the unknown
branch, so their bodies see the undeclared-narrowed `InboxFilter` union and
their `case 'unknown':` / `filter === 'unknown'` arms typecheck fine. Only
straight-line code AFTER the branch is narrowed. That asymmetry is worth
knowing before anyone tries to "clean up" the remaining arms.

Everything else - the branch body, the seams, the cursor gate, the four
rewritten/added tests, the two parity pins - is the plan's code verbatim, with
two trivial comment-only trims: the branch's two "inbox.ts:1351" / "inbox.ts:1434"
line citations were dropped in favour of naming the convention, since the flip
itself moves those line numbers and a stale self-citation is the exact failure
mode this commit's comment work exists to prevent.

## 6. Disposition of all FIVE `filter: 'unknown'` sites in inboxFeed.test.ts

Pre-edit lines 407, 433, 539, 610, 739; post-edit they sit at 421, 447, 553,
624 and 757 (the file grew by the fixture comments).

| pre-edit | test | disposition | result |
| --- | --- | --- | --- |
| **407** | "a partner CONTACT -> role:partner, needsTriage:false (A2 parity)" - asserts `unknown.rows` has length 0 | **NO EDIT**, as the plan predicted. A resolved partner is not in the `unknown` partition under either reader. | green |
| **433** | "a type=unknown CONTACT ... appears under the unknown filter" (the Alexis `c-unk` test) | **FIXTURE COMPLETED**: added `status: 'needs_review'` to the contact literal, with a comment naming the GSI-sparseness rule. Its two assertions (`length 1`, `contactId === 'c-unk'`) are UNCHANGED and pass. | green |
| **539** | "relay filter matrix: in all+unread; NEVER in unknown" | **FIXTURE COMPLETED**: the seed's `c-unk` gained `status: 'needs_review'`. Its pins (`every kind !== 'relay_group'`, `phone === ['+14049824978']`) are UNCHANGED and pass - the contact is type unknown AND now indexed. | green |
| **610** | "filter unread keeps only unreadCount>0; unknown keeps only needsTriage" | **REWRITTEN** (plan Step 9): the unread half untouched; the unknown half now pins `unknown.rows` -> `[]` (class e - the conversation is contactless) plus a new `all`-tab assertion proving the row stays reachable. | green |
| **739** | "rejects a resolved non-unknown contact before conversation and message hydration" | **REWRITTEN** into the new cost pin, "filter=unknown never walks the open partition: a tenant world costs one listByType and nothing per-conversation". `unread_count` dropped 1 -> 0 deliberately (an unread thread would put a `findByPhone` back for a sweep-related reason). Whole-object `calls` literal repinned to `queryUnreadPage: 1, findByPhone: 0, findByParticipantPhone: 0, listByConversation: 0, getPlacementById: 0, listByType: 1, listByLastActivity: 0` - and the run confirmed `queryUnreadPage: 1` exactly as the plan's note predicted. | green |

None of 407/433/539 went red for any reason other than the two documented
fixture completions, so there is NO coverage regression hiding among them.

## 7. Watch items - how each was handled

- **`capped` masks `truncated`.** The branch reads
  `if (collected.truncated || collected.capped)`. The sweep's `maxRows` is
  pinned to `sweepBudget`, NOT to `BADGE_COUNT_CAP` - deliberately, and the
  comment says why. The probe (`unknownSweepBudget: 2`) is green and would go
  red if `|| capped` were dropped: verified by the red run, where that test
  failed on row content before the branch existed.
- **No `excludeOrigin`, no `status` narrowing.** The collector (slice B) passes
  neither; the branch does not add them. The class (a) and class (f) parity
  pins both survive byte-identical, and `unknownQueue.test.ts`'s mutation
  probes (`calls[0].status`/`excludeOrigin`/`deleted` all `toBeUndefined()`)
  are green against a fake that honours all three options.
- **Never the wire `truncated` flag.** The branch returns
  `{ rows: windowed, nextCursor: null }` and nothing else. Pinned by
  `expect('truncated' in page).toBe(false)` and
  `expect('groupsTruncated' in page).toBe(false)` in the cap-cut test.
- **Exactly TWO parity pins changed** (class e -> `[]`, class c -> `[]`), both
  at their `// FLIP:` markers, both renamed to state the decision rather than
  the pending amendment. The other five are untouched and green.
- **No test asserts on a tripwire warn.** `warnUnreadScanned` and
  `warnDeletedProbes` are CALLED by the branch (per the plan) but nothing pins
  their output. Every warn assertion in the new file matches a plain
  `log.warn` string from the branch or the collector
  ("untriaged contacts still behind it", "could not show every triage row",
  "thread read FAILED", "resurfacing sweep stopped early").

## 8. Surprises

1. **The TS2367 on the group-source gate** (section 5). This is the one thing
   the plan asserted that the compiler refused, and it is worth propagating:
   the flip converts `filter` into a literal type for ALL straight-line code
   after the branch. Any future "keep it, but say that" instruction about a
   `filter === ...` comparison BELOW line 1528 will hit the same wall, while
   the same comparison inside a closure declared ABOVE it will not.
2. **`filteredRelay` became dead in the same stroke as `filteredGroup`.** The
   `filteredGroup` keep-comment used `filteredRelay`'s liveness under `unknown`
   as its worked example of why a dead counter is worth keeping. That example
   is now gone, so the comment had to be rebuilt rather than patched - it now
   states both are dead for one shared reason. Site (h) was the harder of the
   four the plan missed, for exactly this reason.
3. **Two of the twelve new tests passed BEFORE the branch existed** (class b,
   and the newest-first sort). Not a problem - both are parity classes whose
   answer the redesign preserves - but a reviewer skimming "10 failed" should
   know the other two were not vacuous: both fail if the branch mis-sorts or
   admits closed/relay threads.
4. **`app/scripts/profile-inbox.ts`** was checked and left alone, per binding
   correction 6. Its `unknown-page` case passes no cursor and uses real repos,
   so the 400 posture and the `listByType` dependency are both safe; only its
   saved trace SHAPE changes, which is the point of the branch.
5. The commit's diff is 916 insertions against 57 deletions - the branch is
   about 230 lines of it, and the rest is the new test file. The comment
   retirements account for roughly 60 added lines on their own, which is the
   cost of treating this file's comments as its design record.

## 9. What this slice did NOT touch

`app/test/helpers/twilioWebhookHarness.ts` (frozen, including its misleading
`:1692-1696` comment), `app/test/helpers/contactsPartitionFake.ts`,
`app/src/lib/unknownQueue.ts`, `dashboard/**`, `e2e/**`,
`app/test/inboxGroups.test.ts` (run, not edited),
`app/test/inbox.integration.test.ts` and
`app/test/performanceSeed.integration.test.ts` (Task 6's scope - both still
carry pre-flip expectations and are EXPECTED to be red until that slice lands).
