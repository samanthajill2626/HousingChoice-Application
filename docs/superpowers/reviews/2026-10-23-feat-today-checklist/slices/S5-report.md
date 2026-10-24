# S5 slice report - the dashboard Today page (today-checklist, tracker #31)

Branch feat/today-checklist. S5_BASE = a2a49b64 (the S4 report commit).
Commits, in order: 621038fc (S5.1), ceee2604 (S5.2), 9d7abc56 (S5.3),
ca7dfbff (S5.4), 8d38b1a8 (S5.5), a62f7cfa (S5.6), then this report. No
S5.7 fix commit (the re-grep found no missed reader). Line numbers below are
at a62f7cfa.

## Where the tree and the plan differed

- No code divergence. Every quoted anchor in S5.1-S5.6 matched the tree;
  the lines the plan writes as [U+2014] / [U+2192] / [U+00A7] were copied
  from a Read. No server (app/), e2e, seed or dashboard api-client file was
  touched (`git diff --stat a2a49b64 HEAD -- dashboard/src/api` = types.ts
  only), so S5 adds no POST/PUT/PATCH/DELETE client function and
  e2e/performance/mutationCatalog.ts is unaffected.
- WL-13 (worklist wins over S5.6 Step 2): observed on the old page,
  `Today.test.tsx` = 20 failed | 23 passed. "no At a glance section when
  both of its parts are empty" was GREEN (a pin of the new rule); "a failed
  section load says so in the section and leaves the rest of Today alone"
  was RED (`Unable to find an accessible element with the role "link" and
  name /James Porter/` - the old GROUP_META rendered no identify group).
  Every other prediction held.
- WL-14: lint reported exactly the one expected pre-existing error (below,
  with its baseline). Nothing else.
- WL-15: the re-grep hit at dashboard/src/routes/today/buildToday.test.ts:378
  is the S5.4 1f comment; it records the removal.
- S5.3 Step 2, observed detail (not a divergence): in "labels EVERY Past
  row (no cap) ..." the first failing assertion is the row order (5 rows
  t0..t4, the cap); the getContact-count assertion after it is never reached.

## Watch items

- WI10 `TODAY_PAST_TOURS_CAP`: its one production reader was the labeling
  walk in useTodayPastTours.ts (the old `while (kept.length <
  TODAY_PAST_TOURS_CAP ...)` loop); S5.3 labels every row, so the constant
  (useTours.ts) and its pin ("caps Today at five rows", useTours.test.ts)
  were removed in 9d7abc56. The 5-row limit is TODAY_SECTION_LIMIT
  (dashboard/src/routes/today/TodaySection.tsx:20), pinned by "the limit is
  five rows (spec 2.1)" in TodaySection.test.tsx. S5.3 Step 4 grep
  (`git grep -n TODAY_PAST_TOURS_CAP -- dashboard`), full output:
  `dashboard/src/routes/tours/useTours.test.ts:320:// useTodayPastTours.test.tsx pins that end to end. TODAY_PAST_TOURS_CAP is`
  (the comment recording the removal).
- WI11 the fallback: buildTodayFromSources runs only when getToday throws
  ApiError with status 404 (dashboard/src/routes/today/useToday.ts:86, `if
  (!(err instanceof ApiError) || err.status !== 404) throw err;`); any other
  failure is the page's error state. A fallback load returns `source:
  'fallback'`, quietShares `{ status: 'unavailable' }`, toursToBookStatus
  'unavailable' and generatedAt = its own now (useToday.ts:105-112). The
  page sets `anyUnavailable` when `fallback` or either section is
  unavailable or past tours errored (dashboard/src/routes/today/Today.tsx:428-429),
  and allCaughtUp requires `!anyUnavailable` (Today.tsx:434), so the
  fallback never shows "All caught up". Pinned by useToday.test.tsx:249 "a
  fallback load has both sections unavailable (it computes neither)" and
  Today.test.tsx:516 "the fallback shows one line instead of an error per
  section, and never All caught up".

## Contradictions C1-C7 (plan section 9) - how each landed

- C1: `isOffRangePastTour(t, now)` exported (dashboard/src/routes/tours/useTours.ts:227);
  selectOffRangeTours calls it (:254), its pins unchanged and green; Today
  partitions with it in `orderForToday` (dashboard/src/routes/today/useTodayPastTours.ts:146).
  The accepted midnight edge (evaluated at label time) stands.
- C2 [PR102]: headings carry NO count. The 2026-08-03 bare-label pins are
  kept byte-for-byte at Today.test.tsx:202-205 (the comment line with its
  [U+2014] survived - the S5.6 Step 5 grep printed 1) and the relay case's
  "no count chip" comment is kept. No `.count` style. The count shows only
  in "Show all N".
- C3: TodaySection takes `level` (TodaySection.tsx:32); "At a glance" is the
  h2 (Today.tsx:355), "Tours today" an h3 under it (:357), the AI part a
  disclosure button whose opened list is the shared LimitedList (:383).
- C4 [PR66]: useToday exposes `generatedAt` (the server's; the fallback's
  own now); Quiet shares counts "N days" from it (QuietSharesSection `now`
  prop, Today.tsx:476), so render stays pure.
- C5 [PR67]: the Past-tab link rule is unchanged (`past.total >
  past.rows.length`, Today.tsx:297); with every row labeled it reads "Open
  the Past tab" unless Today skipped a deleted tenant's tours.
- C6 [PR68]: the spec's copy is used everywhere (AI line, "At a glance",
  the quiet-shares help line); the mockup's layout is followed, not its
  count chip.
- C7 [PR80]: WI10's ruling is PR35 as amended by PR63 (recorded above).

## Other records

- The spinner rule changed shape: it spins only while past tours settle AND
  nothing else would render (checklist and At a glance empty, nothing
  unavailable) - `settling`, Today.tsx:437. "All caught up" itself still
  waits for past tours (Today.tsx:434, spec 2.3).
- The fallback keeps its own Identify copy `'New inbound [U+2014] untriaged'`
  with `attention: true` (dashboard/src/routes/today/buildToday.ts:276-278),
  unchanged per PR36 (the line was not re-indented); the server's identify
  rows read "New unknown contact".
- Removed as dead after Unreplied (S5.4): `CONTACT_TYPE_LABELS` and
  `ONE_TO_ONE` in buildToday.ts (no other reader) and its `ConversationType`
  import. `'unreplied'` left the dashboard union and GROUP_ORDER in S5.6
  (buildToday.ts:43-50); `git grep -n "'unreplied'" -- dashboard` = no hits.
- Today.test.tsx fate table: plan section 9, Task S5.6 Step 1 (applied as
  written; WL-13 above for the two RED-list corrections).
- Pre-existing test noise, not S5's: the act() warning printed by
  useTodayPastTours.test.tsx "debounces: events 200ms apart reload once ..."
  (fake timers) appears in the S5.1 run too, before any S5.3 edit.

## Deliberate test changes (each named; no assertion weakened)

- S5.3 useTodayPastTours.test.tsx: header comment rewritten; `serveTours`
  gains a `toured` argument (default []); "lists the Past rows - no-shows
  included - most recent first ..." re-written as "... OLDEST first ..."
  (['old', 'ns', 'new']); "shows at most five rows and reports the Past tab
  count ..." re-written as "labels EVERY Past row (no cap) and reports the
  Past tab count" (7 rows oldest first, 7 tenant and 7 unit reads); "skips a
  soft-deleted tenant and keeps walking to fill the section" re-written as
  "skips a soft-deleted tenant" (6 rows oldest first); NEW "orders in-range
  rows oldest first (ties by tourId), then the off-range rows in the loader
  order"; the reload case's expected order ['c', 'a', 'b'] -> ['b', 'a', 'c'].
- S5.3 useTours.test.ts: the TODAY_PAST_TOURS_CAP import and its pin "caps
  Today at five rows" removed (WI10); a comment records it.
- S5.4 buildToday.test.ts: "treats an untriaged unknown_1to1 as
  needs_you_now ..." retitled "puts an unknown_1to1 in identify (spec
  2026-10-23 3.1) ..." and now also asserts no needs_you_now row; "falls
  back to the Unknown list ..." reads the identify group; INVERTED "puts an
  unread triaged 1:1 in unreplied ..." and "routes an unread partner_1to1
  ... (n8)" into four "emits no row for an unread <type> thread (the Inbox
  carries it)" cases (tenant_1to1, landlord_1to1, partner_1to1,
  relay_group); "returns groups in canonical order ..." gains an
  unknown_1to1 thread and expects [needs_you_now, identify, tours_today,
  follow_ups]; the group-text comment drops ONE_TO_ONE; "still surfaces the
  1:1 threads beside it" -> "still surfaces the unknown 1:1 thread beside
  it" (fixture tenant_1to1 -> unknown_1to1, asserts [group, refId]).
- S5.4 useToday.test.tsx: the Probe gains quiet / ttb / generated spans
  (printing `missing` when unset); four cases appended. The eight existing
  cases are unchanged (one title still says "leaves Needs you now"; its
  assertions are group-agnostic).
- S5.6 Today.test.tsx: re-written whole per the plan's fate table.

## Gates run in S5 (fast gates only, as briefed)

- Per task: dashboard typecheck via the bare root `npm run typecheck`, exit 0
  after every commit (5 workspaces: app, dashboard, e2e, fake-twilio,
  fake-twilio-web); S5.7 Step 2 again exit 0.
- S5.7 Step 1 re-grep, command
  `git grep -n -i -E "unreplied|Follow-ups due|AI suggestions to review|What needs you, across|TODAY_PAST_TOURS_CAP|PAST_TOURS_AFTER|GROUP_META" -- dashboard`,
  full output (every hit records a removal; no production reader):
  - dashboard/src/routes/today/Today.test.tsx:209 (comment) and :210 (the
    `/Unreplied|Follow-ups/` heading absence assertion)
  - dashboard/src/routes/today/Today.test.tsx:350 (the old subtitle's
    absence assertion)
  - dashboard/src/routes/today/buildToday.test.ts:202 and :204 (the
    inversion comment)
  - dashboard/src/routes/today/buildToday.test.ts:378 (the S5.4 1f comment,
    WL-15)
  - dashboard/src/routes/tours/useTours.test.ts:320 (the cap's removal
    comment)
- S5.7 Step 3, `cd dashboard; npx vitest run` once: exit 0; Test Files 268
  passed (268); Tests 5544 passed (5544); 61.83s.
- S5.7 Step 4, eslint on the 17 .ts/.tsx files S5 touched (the command in
  plan S5.7 Step 4): exit 1, exactly ONE error,
  `dashboard/src/routes/tours/useTours.ts:128:5 react-hooks/set-state-in-effect`
  (useClosedTours' synchronous `setState({ status: 'loading', closed: [] })`).
  PRE-EXISTING, by baseline: the merge-base copy (`git show
  970a29b9:dashboard/src/routes/tours/useTours.ts`, linted through `npx
  eslint --stdin --stdin-filename dashboard/src/routes/tours/useTours.ts`
  with the unchanged eslint.config.mjs) reports the identical error at
  128:5; every S5 hunk in that file is below line 217. Left as is (WL-14).
  The new files (TodaySection, QuietShares and their tests) are clean; the
  conditional seed in QuietSharesSection (QuietShares.tsx:150-156) is not
  flagged.
- S5.7 Step 5 ASCII sweep over every line S5 added (`git diff -U0
  a2a49b64 HEAD -- dashboard`): 0. The new files are ASCII throughout;
  Today.test.tsx keeps exactly one non-ASCII line, the pinned 2026-08-03
  comment (:203). No six-character `\u` escape in dashboard/src/routes/today;
  the ones in tourTime.ts:81 and tourTime.test.ts survived.
- Not run (briefed): root `npm test`, `npm run e2e`, `npm run smoke`, any
  e2e session or dev server.

## As built - the names S7's e2e will select

- h2 headings (exact text, no count): "Needs you now", "Identify these
  contacts", "Past tours needing an outcome", "Tours to book", "Quiet
  shares", "Relay groups to close", "Placements", "At a glance". "Tours
  today" is an h3 inside the At a glance `<section>` (it still
  substring-matches "Today"). A section that failed to load keeps its
  heading.
- Lists (aria-label = heading text): 'Needs you now', 'Identify these
  contacts', 'Past tours needing an outcome', 'Tours to book', 'Quiet
  shares', 'Relay groups to close', 'Placements', 'Tours today'; 'AI
  suggestions' exists only after the AI line is opened; each open property
  has a list 'People waiting on <unitLabel>'.
- Help lines (plain `<p>` under the heading): Identify "We don't know yet
  who these are. Call each one; after about a week with no contact, mark
  them Inactive."; Tours to book "Said yes to a property; the tour has no
  date yet. Oldest first."; Quiet shares "Properties sent in the last 14
  days. Replied and then went quiet for 2+ days, or never replied in 5+
  days. A message or call from either side restarts the clock; sending
  another property does not." No other section has a `<p>` unless it
  errors.
- Show all: a button under the list (inside the same footer div as the
  Past-tab link), name "Show all N" (Quiet shares "Show all N properties"),
  then "Show fewer"; aria-expanded false/true; aria-controls = the list id.
  Shown only above 5 rows. Two sections can both show "Show all 6": scope
  to the section.
- Quiet shares: each property line is a button named "<unitLabel>,
  <summary>" (aria-label; e.g. "12 Oak St, 2 people: 1 replied, then quiet
  - 1 never replied"; "1 person: 1 never replied"), aria-expanded, and
  aria-controls only while open. First property open on first arrival.
  Person rows are links named "<name>, <quiet text>" or "<name>,
  Caseworker, <quiet text>" (quiet text "Replied, then quiet N days" / "No
  reply in N days", "1 day" singular) to /contacts/<contactId>; visible tags
  "Replied" / "No reply yet". Truncated: "Showing the first 100
  properties".
- AI line: one button named "AI suggestions for N contacts" ("for 1
  contact"), aria-expanded; its visible Show/Hide word is aria-hidden. No AI
  line at all when there are none.
- Tours today: compact row links named "Tour for <who> at <unitLabel>,
  <time>" (e.g. "Tour for Dana Ruiz at 1458 Maple Ridge Dr SW, 10:00 AM");
  without unitLabel "Tour for <who>, <time>"; with neither "Tour for <who>".
- Tours to book: an ordinary row link (name from its content: who, the
  property, the age text "Requested ..."), href /tours/<tourId>, router
  state { back: '/' }.
- "All caught up" (with "Nothing needs you right now.") only when the seven
  checklist sections are empty, past tours settled, nothing unavailable and
  the load is not the fallback; At a glance still renders below it.
- Unavailable: a role="alert" paragraph "We couldn't load tours to book." /
  "We couldn't load quiet shares." under the bare heading. Fallback: ONE
  plain paragraph (no role) "Some sections can't load right now." and no
  per-section alert. Past tours load error (unchanged): alert "We couldn't
  load past tours. Open the Past tab".
- Past-tab link: "See all N on the Past tab" when the Past tab holds more
  than Today lists, else "Open the Past tab" (href /tours/past).
- Subtitle: "Clear every section above the line and today's checklist is
  done. New messages are in the Inbox."

## Risks for S7's live QA

- A Quiet shares property line with a long address and summary wraps
  (`.propLine` is flex-wrap; `.propAddr` flex-basis 16rem).
- The AI line is a full-width button; check its width on a wide pane.
- The Show all button beside the Past tab link wraps on a narrow pane
  (`.listFooter` is flex-wrap).
- Quiet shares open state is page state per mount: navigating away and back
  re-seeds (first property open), by design (spec 6.3).
