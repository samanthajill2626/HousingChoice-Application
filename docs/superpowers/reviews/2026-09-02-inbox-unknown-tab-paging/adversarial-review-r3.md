# Adversarial review R3 - feat/inbox-unknown-tab-paging

Scope: the working tree of `W:\tmp\inbox-unknown-tab-paging`, uncommitted on
top of `5de0bc90` - both fix waves (`git diff HEAD`, seven files). The R2 wave
is the new material, and its one behavioural change (`dropped(
'unknownThreadReadFailed')` moving from `resolveOpenThreads` to the page-head
step-over) was traced cold against every request shape. R2 adjudications read;
all five accepted, so there is nothing left for me to contest - see the
adjudication section.

Read-only: nothing was edited, staged or committed, no suite was run, no server
was started. All line numbers are as the working tree stands now.

Four new findings, none BLOCKING or HIGH. The behavioural change itself is
CORRECT; two of the four are the documentation it did not carry with it.

---

## 1. [MEDIUM] The R2 wave narrowed `unknownThreadReadFailed` into an incident signal and left the `drops` map-level contract saying the opposite

**What is wrong.** `app/src/routes/inbox.ts:816-819` is the docblock that owns
the `drops` map for the whole route:

> "`drops` is a NORMAL-TRAFFIC field, not an exception field: `dupContact` fires
> for every extra thread of a multi-number contact on the same page. Its absence
> means nothing was dropped; its presence means nothing is wrong."

Before the wave that was defensible for `unknownThreadReadFailed`: the key fired
on every thread-read failure, and most of those were benign deferrals. After the
wave the key fires at exactly one site (`:2060`), inside the page-head step-over,
directly beneath a `log.error` that says "the row is DROPPED and the walk steps
over it" (`:2054-2057`). Every occurrence now means a triage row was permanently
discarded from that walk. "Its presence means nothing is wrong" is materially
false for the one key whose semantics this wave changed, and the wave did not
touch the docblock.

Second half, same root: the unknown branch's own accounting no longer
reconciles. A page-one deferral now logs `queueRows: 1, count: 0,
threadReadFailures: 1` and NO `drops` object at all (the map is emitted only
when non-empty, `:2264`). "One contact consumed, zero rows returned, nothing
dropped" is a shape a reader will try to balance, and the docblock's explicit
"do not do this arithmetic" bullet (`:807-815`) is scoped to `rawScanned` /
`count` / `drops` on the `all` pager - it says nothing about `queueRows`. The
answer is `threadReadFailures`, which the bullet at `:797-806` lists but does not
connect to the gap.

**Evidence.** `app/src/routes/inbox.ts:816-819` (the contract), `:2060` (the
sole remaining call site), `:2054-2057` (the `log.error` it sits inside),
`:2264` (`drops` emitted only when non-empty), `:807-815` (the no-arithmetic
bullet, `all`-scoped), `:797-806` (the unknown branch's field list).
`app/test/inboxUnknownTab.test.ts:486-495` pins exactly this shape: a deferral
page with NO `drops` key at all.

**What it implies.** The accounting docblock is the live contract for these
fields - it is the thing a future log-alarm author or an operator triaging an
empty Unknown tab reads. It now tells them the whole `drops` map is normal
traffic, at the moment when one of its keys became the only summary-line signal
that a triage row was lost. That is the inverse of the failure this branch was
convened to remove.

**Suggested fix.** Two sentences in the docblock: carve
`unknownThreadReadFailed` out of the normal-traffic bullet ("one exception: this
key fires only at the unknown-queue step-over, always alongside a `log.error`,
and always means a row was discarded"), and add `threadReadFailures` to the
unknown-branch bullet as the field that closes the `queueRows` / `count` /
`drops` gap on a deferral page.

---

## 2. [MEDIUM] The newly-enumerated churn case (2) says "and is KEPT". `retryFromMoved` is set by any CONSUMED row, and the reachable case is a row this partition is documented to contain: a threadless stub

**What is wrong.** The R2 wave added a two-case enumeration to the guard comment.
Case (2), at `app/src/routes/inbox.ts:2032-2036`, reads: "if a new row sorts in
AHEAD of the deferred one and is KEPT, `retryFromMoved` is true by the time the
deferred row fails again, so it is deferred a SECOND time".

`retryFromMoved` is not set by keeping. It is set by CONSUMING, on five separate
paths - `unknownQueueRetyped` (`:1933-1935`), the within-request `emitted` dup
(`:1976`), `unknownNoOpenThread` (`:2087-2089`), the kept-row path (`:2118`),
and the block roll-over (`:2141`). Any of the first three produces the identical
second deferral without the row ever being kept.

The reachable one is `unknownNoOpenThread`. That is not a hypothetical: the
comment 45 lines below it names its population - "threadless group-detection
stubs (class a ... ) and contacts whose only thread is relay or closed (class
b)" (`:2085-2086`) - and those are `type='unknown'` contacts in this exact
partition, i.e. rows the queue reads and discards routinely. So a stub sorting
in ahead of the deferred row is a plainer route to the second deferral than the
kept row the comment names, and the enumeration understates its own reachability
by describing the rarer case.

**Evidence.** `app/src/routes/inbox.ts:2032-2036` (the claim), `:1933-1935`,
`:1976`, `:2087-2089`, `:2118`, `:2141` (every `retryFromMoved = true`),
`:2085-2086` (the class a / class b population of the `unknownNoOpenThread`
path), `:2049-2053` (the guard, whose `!retryFromMoved` clause is what all of
this feeds).

**What it implies.** This is the third round on this one paragraph, and the
sentence is still narrower than the code beneath it. Anyone stress-testing the
retry bound from the comment will construct a kept row, find the second
deferral, and conclude the enumeration is complete - while the commonest trigger
(a row the queue drops for having no open thread) is not mentioned. The
behaviour is safe in every case; the contract statement is what is wrong, again.

**Suggested fix.** s/and is KEPT/and is CONSUMED - kept, or dropped for being
retyped or having no open thread/ in case (2).

---

## 3. [LOW] The rewritten WARN comment says the `threadReadFailures` field "names the row". It is a bare integer.

**What is wrong.** `app/src/routes/inbox.ts:2069-2072`: "The WARN and the
`threadReadFailures` field name the row, so the pause is diagnosable from the
log line the very first time it happens - and `drops` stays silent, because
nothing was dropped."

`threadReadFailures` is declared `let threadReadFailures = 0` (`:1774`) and ships
as a count (`:2263`, `...(threadReadFailures > 0 && { threadReadFailures })`).
It names nothing. Only the WARN carries the `contactId` (`:2074`). The wave
substituted the field name into a sentence whose claim was already loose about
the old counter and did not fix the claim - and the substitution makes it
strictly worse, because the old key at least appeared on the deferral line as a
per-reason entry while the new field is an aggregate.

**Evidence.** `app/src/routes/inbox.ts:2069-2072` (the claim), `:1774` and
`:2263` (the field is an integer count), `:2073-2076` (the WARN, which does
carry `contactId`).

**What it implies.** Small, but it is a diagnosis instruction in the one comment
an operator reaches for when the Unknown tab visibly pauses. Told that a summary
field names the row, they will look for a contactId that is not there.

**Suggested fix.** "The WARN names the row and the `threadReadFailures` field
counts it, so the pause is diagnosable..."

---

## 4. [LOW] The namespace definition says `d` is "present ONLY on a cursor a thread-read deferral minted"; the same wave's decoder comment says a forged `d` is honoured on any cursor

**What is wrong.** The R2 wave rewrote both ends of the `d` documentation and
gave them different strictness:

- `app/src/routes/inbox.ts:328-330` (the namespace DEFINITION, the paragraph a
  reader goes to for the wire shape): "`d` (2026-09-02) is present ONLY on a
  cursor a thread-read deferral minted, naming the contactId the next request
  re-reads first - the one field that can license stepping over a row".
- `app/src/routes/inbox.ts:442-448` (the decoder, 110 lines below): "the cursor
  is unsigned, so a well-formed forged `d` paired with the matching position IS
  honoured ... and nothing a forged POSITION (`b`/`k`) could not already skip
  outright".

The first sentence is true of the ENCODE direction only and is stated as a
property of the namespace, unqualified. It is the wire shape the DECODER faces
that matters for anyone reasoning about what an incoming cursor can carry, and
there the invariant is deliberately not enforced. The trailing clause has the
same shape: "the one field that can license stepping over a row" is precise
about the step-over branch but reads as "the one field that can cause a row to
be skipped", which the decoder comment explicitly denies of the position.

**Evidence.** `app/src/routes/inbox.ts:328-330` and `:442-448`;
`:2049-2053` (the step-over reads whatever `d` the decoder returned, with no
provenance check available to it).

**What it implies.** Same class as R2-1, which the wave was written to close: the
definition site and the enforcement site disagree, and this time the disagreement
was introduced by the fix rather than inherited. A reader who takes the
definition at face value will believe `d` cannot arrive except from a deferral.

**Suggested fix.** "...is present only on a cursor a thread-read deferral
MINTED (the decoder does not and cannot verify that - see decodeUnknownCursor)".

---

## Adjudication responses

Nothing to contest. All five R2 findings were accepted, and my two R1
concessions (finding 3's encoder asymmetry, and the positional-match alternative
to finding 2) were mine to make and stand as made. I note that the R1
adjudications file now carries the one clause I contested - that a 400 on this
path is not loud - and that the concession does not change the R1-3 verdict,
which rests on reachability and is correct.

---

## Verified OK

### The behavioural change (R2-5), traced cold across every request shape

`dropped('unknownThreadReadFailed')` is now called at exactly one site,
`app/src/routes/inbox.ts:2060`, inside the page-head step-over;
`threadReadFailures += 1` stays in the helper at `:1814` and fires on every
failure. Every shape:

| request shape | `threadReadFailures` | `drops.unknownThreadReadFailed` | log |
| --- | --- | --- | --- |
| deferral, page head (no matching `d`) | 1 | absent | WARN |
| deferral, mid-page (rows kept ahead) | 1 | absent | WARN |
| step-over (`d` matches, nothing kept) | 1 | 1 | ERROR |
| step-over then a later deferral, same request | 2 | 1 | ERROR + WARN |
| no failure | absent | absent | - |

- **The step-over cannot fire twice in one request**, so the key is bounded at 1
  per request: the guard requires `!retryFromMoved` (`:2051`) and the step-over
  body sets `retryFromMoved = true` (`:2062`) before `continue`. This also makes
  the decoder comment's new "the step-over fires at most once per request" claim
  (`:443-445`) TRUE.
- **Deferrals stayed diagnosable.** `threadReadFailures` is a top-level field on
  the same `inbox feed assembled` line (`:2263`) and is emitted whenever > 0, and
  the WARN carries the `contactId` (`:2073-2076`). Nothing became invisible.
- **No genuine drop became invisible.** The step-over is the only path that
  discards a row on a thread-read failure, and it is the path that now counts.
- **The count is now MORE informative, not less**: deferrals =
  `threadReadFailures - drops.unknownThreadReadFailed`, which was underivable
  before.
- **The change repairs a contract violation it did not cause.** `:818`, "its
  absence means nothing was dropped", was false before the wave for every
  deferral page; it is now true. (The other half of that same bullet is finding
  1.)

### Nothing anywhere depended on the old, deferral-inclusive count

Repo-wide grep for `unknownThreadReadFailed` and `threadReadFailures` (whole
worktree, no glob filter, `.tf` / `.md` / `RUNBOOK.md` included):

- **Production code:** `inbox.ts` only - `:1774`, `:1814`, `:2060`, `:2263`,
  plus three comment mentions. No other module reads either field.
- **Tests:** three assertion sites. `app/test/inboxUnknownTab.test.ts:486-495`
  (the mid-page deferral pin, UPDATED by this wave), `:613` (the page-head
  step-over pin - a genuine DROP, so `drops: { unknownThreadReadFailed: 1 }` is
  still right and correctly left alone), and `:971`
  (`drops: { unknownQueueRetyped: 1 }`, a different key). The other four
  `inbox feed assembled` assertions in the unknown suite (`:395`, `:485`,
  `:612`, `:908`, `:970`) and the two in `inboxFeed.test.ts` (`:337`, `:378`,
  `:2250`, whose only `drops` pin is `{ notNewestConv: 2 }` on the `all` branch)
  are untouched by the change. Every one uses `toMatchObject` or optional
  chaining, so none breaks on an absent key.
- **Dashboard:** zero hits. No client reads server log fields.
- **e2e:** zero hits. No spec asserts on `drops` or on either field.
- **RUNBOOK.md:** zero hits for either field. Its ten `drops` matches are all
  about GSI drops, push-endpoint drops and message-age drops - unrelated.
- **Infrastructure:** zero hits. There is no CloudWatch metric filter, alarm or
  log query keyed on either name.
- **docs/:** the only hits are (a) HISTORICAL-RECORD documents - the plan
  `docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md`
  (banner at line 1; it quotes the old `dropped()` placement at `:1779` and
  lists the drop reasons at `:2659`) and five 2026-08-25 mission review reports
  - all frozen point-in-time records that this repo's own convention says must
  NOT be updated; and (b) `docs/issues/inbox-read-accounting-gaps.md`, which
  mentions `drops` generically at `:12` and `:38` and makes no claim about this
  key. No live doc owed an edit. (Finding 1 is a CODE docblock, not a doc file.)

### The updated test is a real pin, not a rubber stamp

`app/test/inboxUnknownTab.test.ts:455-496` is a mid-page DEFERRAL (a kept row
`c-q1-ok` ahead, `c-q2-broken` failing, WARN not ERROR - confirmed by
`failLine` at `:477-478`). It now asserts the key is absent (`:486`), that
`threadReadFailures` is 1 (`:487`), and - stronger than asked - that the `drops`
object is absent entirely (`:495`). Restoring `dropped()` to the helper turns
`:486` and `:495` RED. The `threadReadFailures` assertion also anchors the
optional-chaining assertions: if the log line were never emitted, `assembled`
would be undefined and `:486`/`:494`/`:495` would pass vacuously while `:487`
fails. Correctly built.

### The rest of the R2 wave's rewritten prose, checked against the code beside it

- `app/src/routes/inbox.ts:442-448` (forged-`d` bound) - all four claims TRUE:
  unsigned encode (`:376`), forged `d` honoured with the matching position
  (`:2050`), at most once per request (`:2051` + `:2062`), and a forged position
  `b`/`k` skips outright - which it does, since the position alone determines
  which rows the Query returns (`unknownQueue.ts:342-375`). The R2-4 wording is
  fully closed.
- `app/src/routes/inbox.ts:326-334` (namespace paragraph) - `d` is now
  enumerated at the definition site, which closes R2-1's principal half. The
  three cross-references (`:315`, `:530`, `:763`) and
  `app/test/inboxApi.test.ts:273` now all read `{q,b,k,d}`. Qualification gap is
  finding 4.
- `app/src/routes/inbox.ts:2023-2027` (the retry bound) - "AT LEAST one retry
  per row, from ANY page - exactly one when nothing has moved under the cursor"
  is TRUE: with a static queue the deferred row is the first row the next
  request consumes, so `!retryFromMoved` holds and the step-over fires on the
  second failure. R2-2's principal half is closed; the enumeration's scope is
  finding 2.
- `app/src/routes/inbox.ts:2028-2032` (churn case 1) - TRUE: a different head
  row failing leaves `retryFromMoved` false and nothing kept, so
  `boundary = retryFrom` is the SAME position the client sent (`:2077`) and
  `deferredContactId` is re-stamped to the new row (`:2078`).
- `app/src/routes/inbox.ts:1793-1805` (`resolveOpenThreads` docblock) - accurate:
  the helper now owns only the failure tally, `threadReadFailures` is genuinely a
  top-level log field (`:2263`), and "a deferral discards nothing - the row is
  re-read next request" matches `boundary = retryFrom` at `:2077`.
- `docs/issues/unknown-queue-page-head-drop-after-filled-page.md:22-27` - the
  Resolution now carries the conditional claim and points at the guard comment.
  Its summary of the churn cases ("a new contact sorting into or ahead of the
  head between requests") is actually BROADER and more accurate than the code
  comment it defers to, which is finding 2.
- `dashboard/src/api/paging.ts:33-39`, `docs/issues/inbox-filter-tabs-full-walk.md`
  and `docs/issues/inbox-parselimit-empty-one-row.md` are unchanged since R2 and
  were verified there; re-confirmed present and unaltered in this diff.

### Fresh sweep of the whole branch (third pass) - no new behavioural defect

- **No thread-read failure can now go entirely unlogged.** The
  `open === undefined` branch (`:1980`) always reaches either the ERROR
  (`:2054`) or the WARN (`:2073`); there is no early exit between the helper's
  `threadReadFailures += 1` and one of them.
- **`dropped` is still referenced from four sites in this scope** (`:1933`,
  `:2060`, `:2087`, `:2201`), so removing the helper call introduces no
  unused-binding lint risk.
- **`d` is still never paired with a boundary the deferral did not mint**:
  `deferredContactId` is assigned only at `:2078`, between
  `boundary = retryFrom` (`:2077`) and `threadReadStopped = true; break`
  (`:2079-2080`), which the outer loop honours at `:2120`.
- **`!retryFromMoved` still means "first consumed row of this request"**:
  `readUnknownQueue` returns early only on rows >= want, budget spent, or blocks
  exhausted (`unknownQueue.ts:342-347`), so the outer fill loop can only
  re-enter after consuming a full `want` rows - every one of which sets the
  flag.
- **No double-serve and no new row loss** - re-verified for all four boundary
  sources (deferral `:2077`, page-full `:2113`, roll-over/exhaust `:2127`,
  budget stop `:2159`).
- **Every added line in the full working diff is ASCII** (checked mechanically
  over `git diff HEAD`).
- **The diff's only executable change is the moved `dropped()` call.**
  Everything else in `app/src` and `dashboard/src` is comment text; the two test
  files change assertions and comments only. Confirmed by reading the whole of
  `git diff HEAD`.

### UNVERIFIED (not attempted, per the read-only brief)

- No suite was executed. Every RED/GREEN and pass/fail statement here is a code
  reading, including the claim that restoring `dropped()` to the helper turns
  `inboxUnknownTab.test.ts:486` and `:495` red.
- `npm run typecheck` and gate-5 `eslint` were not run. The moved `dropped()`
  call is type-identical at both sites, so neither should newly fail on it.
- Finding 2's `unknownNoOpenThread` route to a second deferral is argued from the
  index ordering and the documented class-a population, not measured against a
  real byTypeStatus index.
