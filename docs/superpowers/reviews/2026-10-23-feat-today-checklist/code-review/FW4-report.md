# FW4 report - feat/today-checklist (tracker #31), fix wave 4

Implementer: the FW4 child (Claude Opus 5.5), 2026-10-25. Scope: exactly
FW4-1 and the R4-2 filing of `R4-adjudications.md`. Base ded02c99.
Commits: 838425f3 (FW4-1), 299f79d5 (R4-2 issue file), then this report.
Strict TDD for FW4-1: the new tests ran RED first, for the reason below; the
one expectation added after GREEN was proven able to fail by a temporary
mutation, run once and reverted. Dashboard only; no app, seed or dependency
change.

## FW4-1 (R4-1) - each row of a Today list has its own React key

Changed `dashboard/src/routes/today/Today.tsx`:
- NEW `rowKeysOf(rows)` (:97-117, beside `rowKey` :93-95). Per render, from
  the list's own order: a row's key is `refType:refId`, and a repeat takes
  the first free occurrence suffix - `#2` on the second, `#3` on the third.
  It returns `(item) => keys.get(item) ?? rowKey(item)` over a Map keyed by
  the row object (LimitedList slices the same objects). Exported for its
  unit cases.
- The three TodayItem lists use it in place of `rowKey`: ItemsSection
  (:172 - Needs you now, Identify these contacts, Tours to book,
  Placements), Tours today (:421), the AI line (:449).
- Untouched: TodayItem, every refId, link (`hrefFor`), row text and row
  order; `buildToday.ts` and its tests (FW3-3's output and
  buildToday.test.ts:244-272 stand); `TodaySection.tsx` (LimitedList and its
  Fragment key); the lifted expansion Set (`expansionOf` / `collapseList`,
  keyed by label); the Past tours (tourId), Relay groups (conversationId)
  and Quiet shares keys.

Tests (`Today.test.tsx`, two new describes; no existing case, fixture or
mock edited; imports gain the `ConversationSummary` type,
`buildTodayFromSources` and `rowKeysOf`):
- :983 "Today - fallback Identify rows that link the same place (fix wave
  4)": mocked useToday, rows from the REAL `buildTodayFromSources`,
  `rerender` for the refetch.
  - :1025 fallback [Al (contact id), Xena, Yuri (unlinked email threads,
    both linking /contacts/unknown?phone=)], then a fallback refetch without
    Al -> exactly Xena, Yuri. The two links are asserted (:1030).
  - :1041 the same first load, then a server load (Bea, Cal) -> exactly
    Bea, Cal.
- :1066 "rowKeysOf - one React key per row of a Today list (fix wave 4)":
  - :1067 distinct rows keep their plain keys (one refId under two refTypes
    included).
  - :1077 repeats get `#2`, `#3` in list order; the rows are not mutated; a
    list's own order decides (a list without the first repeat starts the
    next one plain); a suffix another row's refId already reads moves on
    (:1095-1101).

RED (before the source edit): Today.test.tsx 4 failed | 50 passed (54).
- "expected [ 'Xena Mail', 'Xena Mail', ...(1) ] to deeply equal [ 'Xena
  Mail', 'Yuri Mail' ]" (:1038) and "expected [ 'Xena Mail', 'Bea Server',
  ...(1) ] to deeply equal [ 'Bea Server', 'Cal Server' ]" (:1058) - R4's
  ghost rows verbatim, reached after the preconditions passed (the first
  render listed Al, Xena, Yuri; both unlinked rows link
  /contacts/unknown?phone=). React logged "Encountered two children with the
  same key, `contact:unknown?phone=`" 3 times.
- The two unit cases: "rowKeysOf is not a function" (not yet written).

GREEN: Today.test.tsx 54 passed, 0 duplicate-key warnings; the today dir 8
files / 146 passed (FW3: 142; +4).

Mutation proof for the taken-suffix expectation (:1095-1101, added after
GREEN): the derivation swapped to a plain per-key counter (`#n` on the n-th
repeat) failed only that case - 1 failed | 53 passed, received
`contact:unknown?phone=#2` twice where `#3` was expected - while the
ghost-row probes stayed green. Reverted, the diff re-read, the today dir
re-run: 8 files / 146 passed.

## R4-2 - filed, not fixed

NEW `docs/issues/today-past-tours-labeling-settle-window.md`: type bug,
severity low, status open, area dashboard, created 2026-10-25; refs
useTours.ts:328, useTodayPastTours.ts:167-178 and :199, Today.tsx:529-536
(allCaughtUp). Problem and Suggested fix as adjudicated; template comments
removed; 0 non-ASCII bytes.

## Gates

After the FW4-1 commit (838425f3):
- `npm run typecheck` (root, bare): exit 0, all 5 workspaces.
- Dashboard (`cd dashboard; npx vitest run`): exit 0; Test Files 270 passed
  (270); Tests 5573 passed (5573); 61.81 s. FW3: 270 / 5569 (+4 cases).
- eslint on the 2 .ts/.tsx files FW4 touched (Today.tsx, Today.test.tsx):
  exit 0, no output.
- ASCII: 0 non-ASCII bytes on every added line and in the new issue file;
  no `\u` in any touched file.

After the issue commit (299f79d5, the last code-or-docs commit before this
report):
- `npm run issues` (bare): exit 0, no warnings; "[issues] 440 open, 214
  closed, 654 total" and "open by severity: 7 high, 149 med, 284 low"
  (baseline 439 / 214 / 653, 283 low). INDEX.md is gitignored, not
  committed.
- e2e: `run-spec.sh fw4` (cold boot, lane 12, fresh dashboard build of the
  clean tree at 299f79d5; today-checklist, unknown-caller-triage,
  unknown-inactive): exit 0, "7 passed (35.7s)". Then `npm run e2e:stop`
  exit 0 ("no running session found"); no listener on 10201 / 10211 /
  10221 / 10231; no session.pid.
- Not run (no app change, not asked): the app workspace, `npm run smoke`,
  the full `npm run e2e`.

## Found that the adjudication did not cover

1. Reach of the key change. R4 sketched it for ItemsSection; Tours today
   and the AI line keyed by `rowKey` too, so all three call sites use
   `rowKeysOf` ("the Today item lists"). No source emits a repeated
   refType:refId in those two lists today (server: one row per tour and per
   contact; the fallback: one per Tour entity and no AI rows), so no page
   test drives them; the derivation they share is unit-pinned.
2. The suffix. A plain per-key counter (R4's "#<n> on the n-th repeat")
   would hand out a key that a real refId ending in "#2" already holds; the
   derivation takes the first FREE suffix, so no two keys of a list meet.
   Output is identical whenever no refId carries a '#', which is every
   refId today (generated `contact-` / `conv-` / `placement-` / `tour-` +
   UUID ids; the fallback's phone filter is URI-encoded). Pinned by one
   expectation (mutation proof above).
3. A limit of the Map-by-object form (R4's sketch): one row OBJECT listed
   twice in one list would still share a key. Neither source produces that
   (server rows are parsed JSON; buildToday pushes each literal once, the
   kept contact row included). Not pinned.
4. R4-review cites Today.tsx:507-514 for allCaughtUp; FW4-1 added 22 lines
   above it, so the filed issue cites :529-536.
5. Outside this mission: the full dashboard run logs one other
   "Encountered two children with the same key, `1`", from
   src/routes/contact/RelationshipsEditor.test.tsx ("Remove works correctly
   when there are multiple rows"). That file is not in this branch's diff
   (pre-existing on main). Not filed (FW4 files R4-2 only).

## State left

Tree clean at this report's commit; no e2e lane, session or background
command alive.
