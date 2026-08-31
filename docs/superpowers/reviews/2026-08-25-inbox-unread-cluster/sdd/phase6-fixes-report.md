# Phase-6 review fixes - implementer report

Branch: `feat/inbox-unread-cluster` (worktree `W:\tmp\inbox-unread-cluster`)
Base head at start: `bd22f07c`
Commits: 5e80767c (FIX 1), 4e40790a (FIX 2), f7b8e160 (FIX 4 + FIX 5). Tree clean after each.
Scope: FIX 1, FIX 2, FIX 4, FIX 5. `docs/superpowers/specs/**` untouched (FIX 3
is the orchestrator's).

---

## FIX 1 - the RED gate (`e2e/performance/routes.test.ts`)

`e2e/performance/routes.ts:409-416` (`inboxTerminal`) emits TWO empty
alternatives per inbox surface - the filter's own title plus
`'Nothing on this page yet'` - while the pin table in `routes.test.ts` still
listed one each. `npx vitest run performance/routes.test.ts` was red on
`registers each Inbox filter as an exact independently-ranked surface`.

Changed, per the founder ruling (all four, not just unknown):

- `e2e/performance/routes.test.ts:315` `inbox-all` ->
  `['No conversations yet', 'Nothing on this page yet']`
- `:321` `inbox-unread` -> `["You're all caught up", 'Nothing on this page yet']`
- `:327` `inbox-unknown` -> `['No unknown numbers', 'Nothing on this page yet']`
- `:333` `inbox-groups` -> `['No group texts yet', 'Nothing on this page yet']`

(Line numbers are pre-edit; a nine-line comment was added above the `it(...)`
recording the ruling and that `routes.ts` and this table move together.)

### `templates.ts` - checked, and it needs NOTHING

`e2e/performance/templates.ts` contains API ROUTE templates
(`'/api/inbox'`, `'/api/inbox/read'`, `'/api/inbox/unread-count'`,
`'/api/inbox/:contactId/read'`) - no terminal contracts and no empty-state
copy at all. Grep for the four empty titles returns zero hits in that file. The
"three files move together" trap is really `routes.ts` + `routes.test.ts` +
`cli.test.ts`; `cli.test.ts:228-244` builds `TerminalProofPage` fixtures from
`'No conversations yet'` and stays green because `terminal()` combines empty
alternatives with `'any'` (`routes.ts:180-205`), so ONE matching text is enough.
Confirmed by running the whole `performance/` directory (471 tests green).

---

## FIX 2 - silent triage row loss (`app/src/routes/inbox.ts`)

### The change

One predicate, at what is now `app/src/routes/inbox.ts:1962`:

```
- if (!retryFromMoved && keptContacts.length === 0) {
+ if (resume !== undefined && !retryFromMoved && keptContacts.length === 0) {
```

`resume` is the decoded cursor (`inbox.ts:1711`), so `resume !== undefined`
means "this request actually arrived carrying a cursor". The comment above the
guard was rewritten to state the corrected justification and the bounded shape
it produces: request one has no cursor and DEFERS (WARN, empty page carrying a
cursor minted AT the row - `retryFrom` starts at `{ block: 0 }` precisely so a
first-row failure still mints a real cursor); request two arrives WITH that
cursor and steps over (ERROR, row dropped, walk moves). Exactly one retry, then
guaranteed progress.

The deferral is not a dead end on the client: `Inbox.tsx` gates Load more on
`hasMore` alone and switches the empty copy to `emptyMoreCopy()` for exactly the
empty-page-with-a-cursor pairing.

### The pin I CHANGED, and why

`app/test/inboxUnknownTab.test.ts`, formerly
`'a thread read that fails AT THE PAGE HEAD is STEPPED OVER, not retried
forever'` (lines 529-571 pre-edit).

That test drove ONE request with NO cursor (`{ filter: 'unknown', limit: 25 }`,
no `cursor`) and asserted that the very first row was DROPPED - ERROR log, rows
`['c-h2','c-h3']`, `nextCursor: null`. That is the defect, pinned as the
contract: the cap's stated justification ("the previous request already re-read
this row") cannot hold on a request that had no predecessor. Leaving it would
have made the fix impossible to land.

I did not relax it - I extended it to the two-request shape it was really
describing, keeping every assertion it made and adding the request-one half:

- renamed to `'a thread read that fails AT THE PAGE HEAD is deferred ONCE, then
  STEPPED OVER - never retried forever'`;
- REQUEST ONE (no cursor): `rows` empty, `nextCursor` NOT null, the deferral
  WARN names `c-h1-broken`, and NO thread-read ERROR was logged;
- REQUEST TWO (carrying request one's cursor): the original assertions,
  unchanged - `rows` `['c-h2','c-h3']`, `nextCursor: null`, the ERROR names
  `c-h1-broken`, no deferral WARN, `drops.unknownThreadReadFailed === 1`.

The comment block records the rewrite, its date and its reason in place.

### The NEW test and its RED output

Added: `'a TRANSIENT failure on the FIRST row of page ONE is not silently
dropped: the walk still serves it'` - three queue rows, the participant-GSI
throwing for the FIRST one on request one only, then the whole cursor chain
driven against a healthy world; asserts the union of every page is
`['c-p1-broken','c-p2','c-p3']` with no duplicates and a terminating walk, then
asserts the deferral shape that buys it.

Mutation probe = delete `resume !== undefined` from the guard, then
`cd W:\tmp\inbox-unread-cluster\app && npx vitest run test/inboxUnknownTab.test.ts`:

```
EXIT=1
 Test Files  1 failed (1)
      Tests  2 failed | 15 passed (17)

 FAIL  test/inboxUnknownTab.test.ts > filter=unknown - the contact-side read >
       a TRANSIENT failure on the FIRST row of page ONE is not silently dropped: the walk still serves it
AssertionError: expected [ 'c-p2', 'c-p3' ] to deeply equal [ 'c-p1-broken', 'c-p2', 'c-p3' ]

- Expected
+ Received

  [
-   "c-p1-broken",
    "c-p2",
    "c-p3",
  ]

 FAIL  test/inboxUnknownTab.test.ts > filter=unknown - the contact-side read >
       a thread read that fails AT THE PAGE HEAD is deferred ONCE, then STEPPED OVER - never retried forever
AssertionError: expected [ { kind: 'contact', ...(10) }, ...(1) ] to deeply equal []
  (received c-h3 and c-h2 - request one served the rows BEHIND the failed one
   instead of deferring)
```

Guard restored; the same command then exits 0 with 17/17.

### DISPUTED / residual - the SECOND case the review named is NOT closed by this predicate

The review listed two reachable cases where the old justification is false, then
prescribed a single predicate. That predicate closes only the first.

- Case 1, fresh page-one load with no cursor: CLOSED by `resume !== undefined`.
- Case 2, the first row after every FILLED page: NOT closed. The page-full exit
  (`inbox.ts`, `keptContacts.length >= limit` -> `boundary = after`) mints a
  cursor too, so request two arrives with `resume !== undefined` and steps over
  its first row after ZERO retries. Silent loss survives there, at a smaller
  blast radius (needs a queue longer than one page and a fault landing on
  exactly the resumed row).

The predicate cannot separate the two, because the unknown cursor carries a
POSITION and nothing else - closing case 2 means the cursor carrying WHY it was
minted, which is a wire-shape change (`decodeUnknownCursor` validation, the
cursor-namespace pins, the cross-page cursor tests). I implemented the fix as
stated rather than widening scope unilaterally, and filed the residual with its
reachability conditions and the suggested fix:
`docs/issues/unknown-queue-page-head-drop-after-filled-page.md` (severity med),
referenced from the guard's comment so the next reader does not re-derive it.

---

## FIX 4 - incoherent empty state on the daily-driver tab

New third empty state rather than a second wrong sentence.

- `dashboard/src/routes/inbox/inboxFilters.ts` - added `emptyClearedCopy()`:
  title `'This page is clear'`, body `'Load more to keep looking.'`
- `dashboard/src/routes/inbox/Inbox.tsx` - the selection is now three-way:

```
const empty = inbox.hasMore
  ? (inbox.serverRowCount === 0 ? emptyMoreCopy() : emptyClearedCopy())
  : emptyCopy(filter);
```

Why this copy and not something stronger: a cursor is minted whenever a page
FILLS, including on a feed that ends at an exact multiple of the limit, so
"there are more unread behind this" is NOT something this state knows. It says
only what is certain - the page is done, and the server has not said the feed
is - and points at the affordance rendered beside it. That is the "do not swap
one false sentence for another" constraint taken literally; it is documented in
the function's docblock and pinned (see below).

The file's doctrine is preserved: every arm is gated on a SERVER quantity
(`serverRowCount`, `hasMore`), never on `rows`. `rows.length === 0` is not in
the predicate because the block that renders `empty` is already inside it. No
filter gate: off Unread `rows` is `base` unnarrowed, so `serverRowCount > 0`
with an empty list cannot arise, and the copy is worded to stay true if it ever
does.

Pins in `dashboard/src/routes/inbox/Inbox.test.tsx`:

- REWORKED `'a truncated page whose rows were all marked read is caught up, NOT
  an error'` -> `'... is NOT an error'`. Its fixture carries `hasMore: true`, so
  its `all caught up` assertion was the same incoherence. Everything the pin is
  NAMED for (no alert, no failure copy) is unchanged and unweakened; only the
  copy assertion moved, to `emptyClearedCopy().title`, plus an explicit
  `queryByText(/all caught up/i)).toBeNull()`.
- REWORKED `'says all caught up - NOT "stopped early" - after the operator
  clears a full unread page'` -> `'gets its OWN copy - neither "stopped early"
  nor "all caught up" - after the operator clears a full unread page'`. Same
  fixture; now asserts both lines of `emptyClearedCopy()`, the ABSENCE of
  `emptyMoreCopy().title` / `/stopped early/i` / `/all caught up/i`, and that
  Load more is still rendered.
- NEW `'selects the empty copy from the SERVER page, three ways'` - a table of
  the three server states, asserting the selected title is present and the other
  two are absent in each, plus that the three titles are distinct. This exists
  because collapsing two of the three is the mistake this state has attracted
  twice already (wave 1 merged "cleared" into "stopped early", wave 2 merged it
  into "all caught up").

Pins in `dashboard/src/routes/inbox/inboxFilters.test.ts`:

- NEW `'keeps the three empty-state titles distinct and non-empty'`.
- NEW `'the cleared-page copy claims nothing about what is behind the cursor'` -
  asserts the copy contains neither `caught up` nor `stopped early` and does
  point at `Load more`.

Mutation probe (restore the old two-way `empty` expression):

```
 FAIL  Inbox > a truncated page whose rows were all marked read is NOT an error
    -> Unable to find an element with the text: This page is clear
 FAIL  Inbox > gets its OWN copy - neither "stopped early" nor "all caught up" ...
    -> Unable to find an element with the text: This page is clear
 FAIL  Inbox > selects the empty copy from the SERVER page, three ways
    -> Unable to find an element with the text: This page is clear
```

### Note on the perf terminal contract

`'This page is clear'` was deliberately NOT added to `inboxTerminal`'s
alternatives. The profiler loads a surface cold and never marks a row read, so
`serverRowCount > 0` with an empty rendered list is unreachable during a
collection (there is no client narrowing without a mark-read). Adding it would
be dead weight in a contract whose whole job is to discriminate populated /
empty / contradictory. Flagging it here so the decision is visible rather than
silent.

---

## FIX 5 - false copy on the Unknown tab

### The four pin sites - and the correction to the review's claim

I looked for the four sites before editing. The SUBTITLE
`'Untriaged inbound numbers show up here.'` is pinned in exactly **one** live
place plus one historical plan document:

1. `dashboard/src/routes/inbox/inboxFilters.ts:48` - the source itself.
2. `docs/superpowers/plans/2026-06-17-inbox-frontend-plan.md:196` - a dated
   historical plan, not a pin (and out of scope).

No test, spec or e2e file asserts that sentence at all - so before this change
the body was UNPINNED, not over-pinned.

What IS pinned in four places is the TITLE `'No unknown numbers'`:

1. `dashboard/src/routes/inbox/inboxFilters.ts:48` (source)
2. `dashboard/src/routes/inbox/Inbox.test.tsx:434, 460, 467, 478` (four verbatim
   re-types in one file)
3. `e2e/performance/routes.ts:593` + `e2e/performance/routes.test.ts:327` (the
   perf route contract)
4. `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:127, 154`

I read the review's "pinned verbatim in four places" as being about that title,
which I was told not to change - so I changed the body, and applied the
one-source-of-truth instruction to the pins I could legitimately reduce.

### The copy

```
- body: 'Untriaged inbound numbers show up here.'
+ body: 'Contacts we have not identified yet show up here.'
```

It was false on THREE counts, not two, and the comment in the file says so with
its sources:

- a number with NO contact record cannot appear - the tab is a walk over
  contacts (`app/src/routes/inbox.ts`, the `filter === 'unknown'` branch);
  coverage class (e), "accepted as lost", those threads stay on All;
- a `team_member` cannot appear - class (c), excluded by ruling;
- "untriaged" is not the criterion either - an unknown contact already moved to
  `status: 'active'` IS on this tab (class f, "the DEFAULT for a created unknown
  contact"). What puts a row here is being UNIDENTIFIED, not unreviewed.

Source for the classes: `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`
section 3 (read only; not modified).

### Pinning reduced to one source of truth

- `Inbox.test.tsx` now imports `emptyClearedCopy`, `emptyCopy`, `emptyMoreCopy`
  from `./inboxFilters.js`. All four verbatim `'No unknown numbers'` became
  `emptyCopy('unknown').title`, and both verbatim `'Nothing on this page yet'`
  became `emptyMoreCopy().title`. Six re-typed sentences -> zero. The title's
  own value still lives in exactly one place and remains pinned verbatim where
  it must be: the cross-workspace perf contract and the e2e spec.
- The BODY is now pinned once, from its source, in two complementary ways:
  `inboxFilters.test.ts` `'the unknown filter promises only what the tab can
  show'` (asserts the sentence does not say "untriaged" and does say
  "identified" - a property test, not a transcription), and `Inbox.test.tsx`
  `'an empty ready page renders the honest empty copy...'` now also asserts
  `screen.getByText(emptyCopy('unknown').body)` so the rendered page and the
  module cannot drift.

Mutation probe (restore the old body):

```
 FAIL  inboxFilters > the unknown filter promises only what the tab can show
    -> expected 'Untriaged inbound numbers show up her...' not to match /untriaged/i
```

### TITLE - reported, not changed

I do not think the title needs to move. `'No unknown numbers'` is a statement
about the RENDERED LIST being empty, not a promise about the tab's contents, so
none of the three falsehoods above attach to it. No change proposed.

---

## Verify - all bare, exit codes read from each command

| command (cwd) | exit | result |
| --- | --- | --- |
| `npx vitest run performance/routes.test.ts` (`e2e`) - BEFORE | (red) | 1 failed / 23 passed - the reported gate |
| `npx vitest run performance/routes.test.ts` (`e2e`) | 0 | 24 passed (1 file) |
| `npx vitest run performance/` (`e2e`) | 0 | 471 passed (17 files) |
| `npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/unknownQueue.test.ts test/inboxApi.test.ts test/inboxFeed.test.ts` (`app`) | 0 | 151 passed (5 files) |
| `npx vitest run test/inbox.integration.test.ts` (`app`) | 0 | 11 passed (1 file) |
| `npx vitest run src/routes/inbox/` (`dashboard`) | 0 | 95 passed (4 files) |
| `npm run typecheck` (root) | 0 | app, dashboard, e2e, fake-twilio, fake-twilio-web - EVERY workspace line read, all clean |
| `npx eslint <7 touched ts/tsx files>` | 0 | no output, no errors |

`npm run e2e`, `npm run e2e:session`, the full `npm test`, and any server start
were NOT run, per instruction. `npm run issues` was run (regenerates the
gitignored index only); it reports one pre-existing warning unrelated to this
work - `perf-selfqa-route-contract-drift.md: unknown severity "medium"`.

ASCII: every added line across the diff and the new issue file was machine-checked
for non-ASCII - clean. `Inbox.tsx`'s pre-existing `'Loading...'` ellipsis and em
dashes were left untouched.

---

## Files changed

- `app/src/routes/inbox.ts` - FIX 2 predicate + comment
- `app/test/inboxUnknownTab.test.ts` - FIX 2 reworked pin + new regression test
- `dashboard/src/routes/inbox/Inbox.tsx` - FIX 4 three-way empty selection
- `dashboard/src/routes/inbox/Inbox.test.tsx` - FIX 4 pins, FIX 5 de-duplication
- `dashboard/src/routes/inbox/inboxFilters.ts` - FIX 4 `emptyClearedCopy`, FIX 5 body
- `dashboard/src/routes/inbox/inboxFilters.test.ts` - FIX 4 + FIX 5 pins
- `e2e/performance/routes.test.ts` - FIX 1 pin table
- `docs/issues/unknown-queue-page-head-drop-after-filled-page.md` - NEW, the
  FIX 2 residual

`docs/superpowers/specs/**` untouched.
