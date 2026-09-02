---
id: unread-budget-truncation-has-no-forward-path
title: The nav badge renders a budget-truncated zero as no badge at all, indistinguishable from caught up (forward-path half fixed)
type: bug
severity: low
status: open
area: app/inbox
created: 2026-08-16
updated: 2026-08-25
refs: app/src/lib/unreadFeed.ts:708, app/src/routes/inbox.ts:1680, dashboard/src/app/UnreadContext.tsx:118, dashboard/src/app/NavContents.tsx:43, e2e/tests/dashboard-next/inbox-nav-badge.spec.ts:57
---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces exactly as filed - the server still emits
`{unreadCount: 0, capped: false, truncated: true}` and the client still drops
that field - but the severity, the depth-cap cross-reference and the shape of
the remaining fix were all stale, and are corrected IN PLACE below.

RETITLED in the same pass. The old title, "A truncated unread badge renders
nothing (half fixed - the page now pages)", led with the half that is CLOSED and
buried the half that is open, which is the exact failure this re-adjudication
exists to stop - a stale issue TITLE is load-bearing, because every triage pass
reads titles first. The `id`,
filename and slug are UNCHANGED, so every inbound link still resolves.

This issue is now ONE SLICE with
[`unread-fill-loop-query-amplification`](./unread-fill-loop-query-amplification.md),
[`inbox-truncated-flag-two-meanings`](./inbox-truncated-flag-two-meanings.md) and
[`unread-load-more-empty-on-exact-multiple`](./unread-load-more-empty-on-exact-multiple.md),
because all four are the same flag contract - `capped` / `scanExhausted` /
`truncated` / `consumedAll` - in `app/src/lib/unreadFeed.ts`.

**HALF RESOLVED 2026-08-16** (review fix wave 1, conformance C1; spec 4.5 step 2
amended). Half 1 below - the missing forward path - is FIXED: a truncated page
that HAS rows now mints its cursor from the `scanPosition` it already paid for,
so Load more advances past the truncation point. An EMPTY truncated page still
returns null, which is the invariant the client's empty-state gating rests on.

Half 2 - the silent-zero badge - REMAINS OPEN and is what this issue now tracks.
Rendering an indeterminate badge is out of v1's scope, so the interim measure is
server-side only: `countUnreadRows` logs a rate-limited WARN
(`unread_badge_truncated_zero`) when it answers 0 with the walk stopped early,
which makes the state observable but still leaves the OPERATOR looking at a
blank nav item.

**SEVERITY: `low` (re-adjudicated 2026-08-25). The `med` rating was premised on
a cheapness the code no longer has.** The history, because the rating flapped
twice and the reasoning is the useful part:

- Fix wave 1 dropped it to `low` while simultaneously making the state FAR
  cheaper to reach - its deleted-probe bound stopped the whole WALK after 26
  probes, so 27 hidden deleted threads (not ~2000 invisible residents) produced
  a zero badge AND a page of zero rows with a null cursor.
- Fix wave 2 (adversarial r2 finding 2) restored `med` on exactly that
  cheapness - and, in the same wave, REMOVED it: the bound now stops the
  probing, never the walk (`app/src/lib/unreadFeed.ts:678-682`, "NOTHING ELSE
  STOPS THIS LOOP").
- Fix wave 3 removed the remainder, by ruling that skipped-but-unprobed threads
  do not force the flag (`app/src/lib/unreadFeed.ts:696-708`).

So the 27-hidden world now answers its true visible count with `truncated`
ABSENT, and the ONLY reachable production path back to a silent zero is the
raw-scan budget - roughly 2000 budget-consuming rows ahead of the first visible
one, which this file already calls "not an everyday state" below. That is a
`low`, and it matches the rating of its true sibling
[`seen-set-max-equals-max-inbox-limit`](./seen-set-max-equals-max-inbox-limit.md).
Two further reasons `low` is honest: the state IS instrumented server-side
(`warnTruncatedZeroCount`, `app/src/lib/unreadFeed.ts:176-185`), and the
operator is not locked out - the unread PAGE, unlike the badge, renders a
truncated non-empty page's notice and mints a forward cursor
(`app/src/routes/inbox.ts:1392-1403`,
`dashboard/src/routes/inbox/Inbox.tsx:160-166`). Not closed, though: the defect
is real, reachable, and pinned by a passing test that documents it as a known
gap (`app/test/inboxFeed.test.ts:1690`).

**The corrected mechanism (fix wave 2).** The probe bound now counts only WASTED
probes and stops the PROBING, never the WALK: past the bound a deleted-contact
thread is treated as hidden without a read, and live contacts, unknowns, groups
and relay threads behind the wall are still counted and still emitted. So the
27-hidden world answers 5 (its true visible count) and the page returns those 5
rows.

**A DRAINED STREAM IS A NATURAL END (fix wave 3, adversarial r3 finding 2).**
Wave 2 additionally made those skipped threads force `truncated` even when the
walk then drained its supply, and wave 2's own note called what remained "the
genuinely-zero case". That understated it: an org whose index holds nothing but
hidden residue and is otherwise CAUGHT UP got a zero badge marked as a floor and
an empty page marked truncated, which is the client's inbox FAILURE state
(`serverRowCount === 0 && truncated`) - permanently, over a deterministic prefix
whose Retry reproduces it. That is the steady state of any org past ~26 hidden
residents, and residue accrues by design. The rule now: skipped-but-unprobed
threads do NOT make a drained walk an early end. The assumption past the bound is
"hidden", which is exactly what an empty page means, and a hidden row is one no
reader would have shown. `truncated` is back to naming an EARLY end only - on
the PAGE that is the raw-scan budget, the depth cap, or a lag-drop the request
could not deliver; on the BADGE it is the raw-scan budget and nothing else (see
the flag contract below).

**THE FLAG CONTRACT, verified 2026-08-25 - the three exits are MUTUALLY
EXCLUSIVE BY CONSTRUCTION.** `collectUnreadRows` derives all of them from two
booleans (`app/src/lib/unreadFeed.ts:695`, `:708`, `:709`):

```
    consumedAll: !capped && state.scanExhausted,
    truncated: !capped && !state.scanExhausted,
    capped,
```

| exit | trigger | capped | truncated | consumedAll |
|---|---|---|---|---|
| row cap | `candidates.length >= maxRows` (line 674) | true | false | false |
| drained supply | a page with no LEK, fully consumed (line 391) | false | false | true |
| budget expiry | the loop head at line 345 stops | false | true | false |

Three facts follow, and each retires a remedy someone would otherwise propose:

- **`capped` MASKS `truncated`.** A capped result reports `truncated: false`
  even when the walk would also have ended early. Harmless for the silent ZERO
  (which needs zero candidates, hence `capped: false`), but a marker keyed on
  `truncated` can never render beside a "99+".
- **REPORTING `scanExhausted` INDEPENDENTLY OF `capped` IS A NO-OP.** On the cap
  break the consumer stops mid-page, so the generator is suspended at its
  `yield` and line 391 never runs: `scanExhausted` is ALWAYS false on a capped
  exit and structurally cannot be otherwise. The iterator says so itself
  (`app/src/lib/unreadFeed.ts:388-390`): "a consumer that stopped mid-page
  leaves the generator suspended at its `yield`, and 'the stream ended' is
  precisely what such a consumer does NOT know." Exposing the raw boolean
  therefore adds no information the pair does not already carry. A peer
  adjudicating
  [`unread-load-more-empty-on-exact-multiple`](./unread-load-more-empty-on-exact-multiple.md)
  reached the same conclusion from the other side, which is part of why the four
  issues are now one slice.
- **THE DEPTH-CAP ARM CANNOT REACH THE BADGE.** `countUnreadRows` makes ONE
  collect with no cursor, no `startAfter` and no seen-set
  (`app/src/routes/inbox.ts:1680-1686`), so `seen.size > SEEN_SET_MAX`
  (`app/src/routes/inbox.ts:1386`) is unreachable on this path. The badge's
  `truncated` has EXACTLY ONE meaning. That is the opposite of the PAGE flag,
  whose two meanings are
  [`inbox-truncated-flag-two-meanings`](./inbox-truncated-flag-two-meanings.md).

WHAT THIS ISSUE STILL TRACKS, therefore, is the ORIGINAL silent zero: a badge
that answers 0 because its WALK STOPPED EARLY (the budget case reproduced below)
renders as no badge at all, indistinguishable from caught up. The server-side
`unread_badge_truncated_zero` WARN - which now also carries the skipped depth -
is the only place that state is observable; the UI affordance is the fix. The
residue cleanup (delete-time reset + backfill rule 3) remains the prevention for
the wall itself, and the deleted-probe tripwire (wasted + skipped) is what
reports it.

**Problem.** Filed from the plan-blind adversarial review of
`feat/inbox-unread-index` (finding 1, CONFIRMED - reproduced against the real
`aggregateInbox` / `countUnreadRows` through the `unreadWalkLimit` seam). Two
halves, one cause: when the request's raw-scan budget (`UNREAD_WALK_LIMIT`,
2000) expires before the unread page fills, the feed reports the early end and
then throws away everything needed to get past it.

1. NO FORWARD PATH - FIXED, see the note above. The cursor block set
   `truncated = true` and left
   `unreadCursor = null` even though `scanPosition` WAS known at that moment.
   The position was deliberately discarded, so Retry re-ran the same
   deterministic prefix with a fresh budget and produced the identical answer.
   Every row behind the truncation point was unreachable through the API until
   the index itself was cleaned.
2. SILENT-ZERO BADGE - STILL TRUE ON 2026-08-25, re-verified line by line.
   `countUnreadRows` returns `{unreadCount: 0, capped: false, truncated: true}`
   (`app/src/routes/inbox.ts:1722-1726`), but `UnreadContext` reads only
   `count.unreadCount` and `count.capped`
   (`dashboard/src/app/UnreadContext.tsx:118-122`) - the word `truncated` still
   appears in that file exactly once, in a comment at line 126 - and
   `NavContents` renders a badge only when `unread > 0`
   (`dashboard/src/app/NavContents.tsx:43-48`). The operator sees NO badge:
   visually identical to "all caught up", while unread work exists.
   (`InboxUnreadCount.truncated` is a wire field with a documented client
   contract that no client implements - adversarial 7, the same mechanism seen
   from the contract side; the contract is written out in
   `dashboard/src/api/types.ts:2827-2839`.) Nothing on the client has moved
   since this was filed: `UnreadContext.tsx` was last touched by `af0a1613`
   (2026-08-16, the filing day) and `NavContents.tsx` by `d029678c`
   (2026-08-19), a CSS geometry fix that does not touch the badge gate. The
   server shape is pinned by a passing test, `app/test/inboxFeed.test.ts:1690`.

Reproduction (verbatim from the reviewer):

```
world: 10 index rows flagged unread with status 'closed'  (invisible residents)
       + 1 genuinely unread OPEN thread, OLDER, so it sits behind them
budget: unreadWalkLimit = 5

GET /api/inbox/unread-count -> {"unreadCount":0,"capped":false,"truncated":true}
   -> nav badge renders NOTHING

GET /api/inbox?filter=unread
   page 0: rows=(none) cursor=null truncated=true
   -> Inbox.tsx renders the inbox failure state + Retry, forever;
      the real unread row is unreachable through the API.
```

At the production budget this needs roughly 2000 budget-consuming rows ahead of
the first visible one (`UNREAD_WALK_LIMIT = 2000`,
`app/src/lib/unreadFeed.ts:46`), so it is not an everyday state. FOUR classes
consume budget and emit nothing, not the two originally listed:

1. Rows failing `isUnreadVisible` (`app/src/lib/unreadFeed.ts:309-317`) - closed
   1:1, closed relay group, a group text off `GROUP_TEXT_STATUS`,
   `unread_count <= 0`, or a pointer-partition row.
2. Deleted-contact threads whose resurfacing probe answers "still hidden"
   (`app/src/lib/unreadFeed.ts:568-593`).
3. Deleted-contact threads SKIPPED past the wasted-probe bound
   (`app/src/lib/unreadFeed.ts:569-572`).
4. A CONTACTLESS EMAIL THREAD (added 2026-08-25 - this class was missing). It is
   visible, resolves to no contact, has no `participant_phone`, and returns
   without emitting a row (`app/src/lib/unreadFeed.ts:612-615`): "A contactless
   EMAIL thread has no identity to render ... skip rather than emit a phantom
   unknown row."

The accrual paths named for classes 1-3 are
[`inbound-reflags-closed-relay-group`](./inbound-reflags-closed-relay-group.md)
and the mark-read half of
[`mark-read-fanout-stale-gsi-skip`](./mark-read-fanout-stale-gsi-skip.md) - both
still open; the delete-side accrual was closed in the fix wave.

One more exit exists beyond the three in the flag contract above, and it would
produce a silent zero at `scanned: 0` - an empty page returned WITH a
`LastEvaluatedKey`
(`app/src/lib/unreadFeed.ts:355-363`, which returns without setting
`scanExhausted`). It is DEFENSIVE ONLY and not a production path:
`queryUnreadPage` applies no `FilterExpression`
(`app/src/repos/conversationsRepo.ts:1727-1750`), so an unfiltered Query cannot
return that page. The remark at `app/src/routes/inbox.ts:1370-1371` that this
shape "gets here in production" is therefore inaccurate; it belongs to the PAGE
branch and is recorded here only so the next reader does not build on it.

NOT IN SCOPE HERE: that Retry is ineffective on a truncated page was a KNOWN,
accepted design decision (review round 4 - spec 4.5 step 3 says in as many words
that "the point of this state is not lying, not guaranteed recovery"). This
issue is about the missing forward path and the silent-zero badge, not about
re-litigating that ruling.

**Suggested fix (rewritten 2026-08-25 to the shape verified against the code).**
The cursor half is done as described (mint from the known `scanPosition`, keep
`truncated` as the early-end signal). WHAT IS LEFT is CLIENT-SIDE ONLY - no
route, no wire and no request shape changes, because the field is already
emitted and already typed on both sides:

1. Carry `truncated` from the fetch into provider state and out through
   `UnreadValue` (`dashboard/src/app/UnreadContext.tsx:118-122` and the memo at
   `:302-305`). ADD IT TO THE MEMO DEPENDENCY ARRAY - omitting it yields a
   permanently stale marker.
2. Render an indeterminate marker in `NavContents` when the count is zero AND
   truncated, so that state stops looking exactly like "all caught up".

Three constraints a builder must respect, all verified:

- **DO NOT DISTURB THE OPTIMISTIC LAYER.** The clear-expiry rule
  (`dashboard/src/app/UnreadContext.tsx:122-127`) and the displayed-count
  suppression (`:297-298`) must keep treating `truncated` as non-participating;
  that behaviour is pinned by
  `dashboard/src/app/UnreadContext.test.tsx:216-223` ("still decrements when the
  count is TRUNCATED but not capped").
- **THE MARKER MUST NOT BE A SECOND SIBLING SPAN NAMED "unread" - LOAD-BEARING
  COLLATERAL.** The badge's accessible name is `${badge} unread`
  (`dashboard/src/app/NavContents.tsx:66`), and the e2e nav-badge locator matches
  ANY following sibling span whose `aria-label` contains that word:
  `following-sibling::span[contains(@aria-label, "unread")]`
  (`e2e/tests/dashboard-next/inbox-nav-badge.spec.ts:57`, and again in the
  geometry helper at `:178`; the Email side-door uses the same shape at
  `e2e/tests/flows/email-triage.spec.ts:60`). Adding one blindly makes that
  locator strict-mode-ambiguous and breaks the whole spec file, including the
  polled geometry assertions that
  [`inbox-nav-badge-geometry-measured-mid-animation`](./inbox-nav-badge-geometry-measured-mid-animation.md)
  rebuilt. That spec's stated invariant - `inbox-nav-badge.spec.ts:10`, "the
  badge renders the unread ROW count, and it is ABSENT - never a '0'" - is also
  what the marker changes, so the spec must be AMENDED in the same change rather
  than merely kept green.
- **SCOPE: this closes the budget-arm silent zero and nothing else.** A marker
  keyed on `truncated` is structurally blind to the sibling silent undercount in
  the round-4 addendum below, which reports its floor with `truncated` ABSENT by
  deliberate design (`app/src/lib/unreadFeed.ts:696-708`). That gap needs the
  wire-level "some rows could not be checked" affordance the addendum names, and
  is not this issue.

The depth-cap cross-reference that stood here was MISLEADING and has been
removed: it describes the PAGE, and the badge has no cursor and no seen-set, so
that arm can never be the badge's truncation cause (see the flag contract
above). [`seen-set-max-equals-max-inbox-limit`](./seen-set-max-equals-max-inbox-limit.md)
remains a real issue - just not a constraint on this fix.

**Round-4 addendum (2026-08-16, planner).** Two more facts about the residue
wall belong here rather than in code, because every code-side bound tried
against the wall was wrong at some threshold:

- SILENT UNDERCOUNT INSIDE THE WALL (adversarial r4 finding 2 / conformance r4
  finding 1). Past UNREAD_DELETED_PROBE_WARN wasted probes in one request,
  further deleted-contact threads are SKIPPED WITHOUT PROBING and assumed hidden.
  A resurface-eligible thread sitting behind that many confirmed-hidden ones is
  therefore not counted, and because a DRAINED stream is a natural end (fix wave
  3, adversarial r3 finding 2 - the alternative rendered a permanent false error
  banner on a caught-up org), the badge and page report the floor with
  `truncated` ABSENT. Reproduced: truth 20, badge 10, page 10 rows, no flag.
  This is a knowing trade: the wall is a pathological state (the delete-time
  reset, the relay-close reset, and backfill rules 2-3 exist to stop it forming),
  and the operator-facing signal is the rate-limited deleted-probe WARN whose
  payload now names attempted vs skipped. A wire-level "some rows could not be
  checked" affordance is the durable fix and is out of v1 scope.
- EXTRA POINT READ PER AUTHORITATIVE DROP (adversarial r4 finding 4). The lag
  discriminator issues one base-table GetItem per hydration drop (600 in a
  600-drop shape). It replaced a membership predicate that could not see the
  dominant lag shape at all; the read is bounded by the page and its cost is
  named in spec 4.4 (fix wave 3). Batching stays with
  contacts-batchget-amplified-reads.
