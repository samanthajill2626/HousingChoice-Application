# Planner review - adversarial round 2 (plan-blind), feat/today-checklist

Reviewer: the same independent adversarial reviewer, continued. Read: the fix
diff 4508f61f..8c833d33 (48a6c8f2 PFW1-1, f941b098 PFW1-2, 0826ba2b PFW1-3),
planner-review/adjudications.md (the one permitted file under
docs/superpowers/), and the surrounding code again. Not read: the fixer's
report, the spec edit, anything else under docs/superpowers/. Read-only; no
test, build or npm command was run.

## Counts (round 2, new findings only)

- blocking: 0
- high: 0
- medium: 0
- low: 1
- info: 3

## New findings

### ADV-8 - low - PFW1-1 makes "All caught up" PERMANENTLY unreachable once an org has more than 100 available properties

- dashboard/src/routes/today/Today.tsx (`quietTruncated`, used in
  `allCaughtUp`); dashboard/src/routes/today/QuietShares.tsx (the
  `properties.length === 0 && !quiet.truncated` early return);
  app/src/services/followUps.ts:155 (FOLLOW_UPS_UNIT_CAP = 100, fixed).
- What: `truncated` is not an occasional state - it is true on EVERY load
  while more than 100 non-deleted available properties exist, because the
  walk always stops at 100. Before PFW1-1 that produced a rare false "All
  caught up"; after it, an org past 100 available properties can never see
  "All caught up" again, and an empty Quiet shares section (heading, help line,
  note) is shown on every load, forever, even when nobody anywhere is quiet.
  The fix is the right local call (an unknown state is not "done"), but it
  converts a scale limit into a permanent UX state with no tracking: neither
  docs/issues/today-quiet-shares-read-cost.md nor any other issue says the cap
  must move before the org reaches 100 available properties.
- Scenario: the org lists its 101st available property. From that load on,
  Sam's daily checklist can never reach "done"; the page always carries a
  Quiet shares section with only "Only the first 100 available properties were
  checked." under it.
- Confidence: CONFIRMED by code trace (the cap is a constant, the walk is
  deterministic). Prod holds tens today, hence low.
- Suggested handling: no code change in this branch; file (or extend the cost
  issue with) a trigger: "before 100 available properties, page the core past
  100 or raise the cap - PFW1-1 withholds All caught up on every truncated
  load". Same note covers the Follow up tab (ADV-10).

### ADV-9 - info - `settling` ignores the truncated note, so a spinner can sit above a rendered Quiet shares section

- dashboard/src/routes/today/Today.tsx (`settling` =
  `status === 'ready' && queueEmpty && glanceEmpty && !anyUnavailable &&
  past.status === 'idle'`).
- What: `queueEmpty` counts quiet PROPERTY LINES, so a truncated-empty read is
  "empty" to `settling`, while QuietSharesSection now renders its heading and
  note. While past tours are still labeling (`past.status === 'idle'`), the
  page shows the centered spinner AND the Quiet shares section together. The
  spinner's documented purpose is "a page with nothing else to show"; there is
  now something to show. Cosmetic and brief (until past tours settle). The
  fixer flagged this; I confirm it.
- Fix (one term, optional): add `&& !quietTruncated` to `settling`.
- Confidence: CONFIRMED by code trace.

### ADV-10 - info - the Follow up tab has the same empty-before-note shape (pre-existing)

- dashboard/src/routes/broadcasts/FollowUpView.tsx:221-227 returns "Nothing
  waiting on a reply." before the truncated note at :231-233.
- What: with more than 100 available properties and no waiting row among the
  first 100, the tab claims nothing is waiting with no word that 100+
  properties were skipped - ADV-1's defect on the sibling surface. It predates
  the branch and the tab is meant to stay byte-for-byte unchanged here, so
  leaving it is right; it should be filed, not lost. The fixer flagged it; I
  confirm it.
- Confidence: CONFIRMED by code trace; pre-existing.

### ADV-11 - info - the perf contract's Today terminal cannot see the new truncated-empty state

- e2e/performance/routes.ts:405-416 (TODAY_TERMINAL: the seven section lists,
  or the "All caught up" text, or an error alert).
- What: a truncated-empty Quiet shares section has no list and, after
  PFW1-1, the page never shows "All caught up", so a Today sample whose
  OTHER sections are all empty in a world with more than 100 available
  properties reads `unknown` (a misattributed ready timeout). The perf seed's
  base is 16 units (app/src/lib/seed/performance.ts:40); only a scaled run past
  100 available units with every other section empty can hit it - unlikely,
  since such a world also seeds placements and tours. The fixer flagged this;
  I confirm it and rate it info.
- Fix (cheap, optional): add the note as a ready alternative, e.g. a
  `locator('status', 'Only the first 100 available properties were checked.')`
  in TODAY_TERMINAL's second list.
- Confidence: CONFIRMED by code trace; reachability PLAUSIBLE only at scale.

## The fixes, reviewed cold

- PFW1-1 (QuietShares.tsx, Today.tsx): correct for what it claims. The early
  return now only hides an empty AND complete read; the list renders only with
  lines (no empty `<ul aria-label>`), the note is a `role="status"` line in
  the Follow up tab's markup, the hooks stay above every return (seeding is
  unaffected - `first` is undefined on an empty read), and `allCaughtUp`
  requires `!quietTruncated`. `quietTruncated` is false on the fallback
  (`quietShares` is unavailable there), so the fallback path is unchanged.
  The copy is accurate ("checked", not "showing"). Residue: ADV-8, ADV-9,
  ADV-11 above.
- PFW1-2 (sendEmailMessage.ts): correct. The stamp now runs after (a) alias,
  (b) queued->sent, (c) parked events and (d) lastSeen + the sent emit; no
  `return` or rethrow sits between SES acceptance and the stamp (every step is
  try/catch or `.catch`), so a sent mail still always stamps, never fails, and
  `contact.updated` stays the last event. The two new tests pin the order with
  `invocationCallOrder` against the real call sites and pin the all-steps-fail
  case - not vacuous.
- PFW1-3 (docs): both additions are accurate against the code
  (useContact.ts ~75 / ContactCommsPane.tsx:109; useToday fetchNow abort and
  the sequential tours_to_book loop).

## Adjudications contested

- ADV-2 NO CHANGE - concede: a recorded owner ruling (acceptance, not
  delivery) answers it.
- ADV-3 NO CHANGE - concede: fail-open is the safer error for a must-do list
  and the contact page shows the type before anyone acts.
- ADV-5, ADV-6 NO CHANGE - concede (tracked / pre-existing).

## Fresh sweep - what else I re-checked this round, nothing new found

- Every live stamp site again (sendMessage W1/W2, email W3 after the move,
  relay W4/W7, groupSend W5, voice W6): no new await before a provider call,
  no throw path after acceptance.
- The Retry route's W2 / systemCopy expressions against retrySend and
  sendReconcile adoptRetry: consistent.
- The Interested-route and tours-route `tour.updated` emits: every consumer
  outside Today filters by tourId; a failed later write cannot double-create
  (the `existing` check).
- RECIPIENT_PROJECTION now carries `last_reached_out_at` to every recipients
  read, so the attribute reaches the staff dashboard on those payloads
  despite "never displayed" - staff-only data, no exposure concern, no action.
