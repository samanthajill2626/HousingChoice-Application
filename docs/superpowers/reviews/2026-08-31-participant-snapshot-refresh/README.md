# Mission record - participant names: resolve on read, M1 (`feat/participant-snapshot-refresh`)

**This record was committed by the mission itself** - four research findings
files and their adjudications, four spec review rounds, two plan reviews, two
code review rounds with adjudications, the design-review sub-directory, ten slice
reports, the fix wave and wave 2, the self-QA, the handback, and the planner's
own cold review round. Only `worklist.md` and this README were added on
2026-09-02 when the branch was retired.

Merged to `main` as `7be40139` (branch tip `63e2376e`). The design and plan are
frozen at
[`2026-08-31-participant-snapshot-refresh-design.md`](../../specs/2026-08-31-participant-snapshot-refresh-design.md)
and [`2026-09-01-participant-snapshot-refresh.md`](../../plans/2026-09-01-participant-snapshot-refresh.md).
For current truth read the code.

## What shipped

Every staff surface now resolves a participant name at READ time down one chain -
live contact name (non-deleted, non-empty) -> stored snapshot -> formatted phone -
using ONE `contactsRepo.getDisplaysByIds` batch per page. Eleven slices: the
`lib/participantNames.ts` helper and a widened `contactDisplayName` (T1), Today
plus close-nag (T2), four inbox row sites (T3), contact cards (T4), the relay
members panel and `GET /calls/:callId` (T5), `describeRoster` precedence (T6),
push and masked-party labels (T7), a `--audit-denorm` group pass with a drift
tally (T8), an e2e rename scenario (T9), and the issue stamps (T10).

**No phone source changed anywhere.** Roster sends still address
`participants[].phone`, and the members panel renders the STORED phone beside the
resolved name. That is the standing note for bundle M3.

## Things a later reader would otherwise re-litigate

- **T5 REVERSED a 2026-07 ruling.** Two `relayApi.test.ts` pins were retitled from
  "drops the creation-time name..." to "keeps the creation-time name... (M1 ruling
  2026-08-31)". Commit `871ebefd` names the reversal in its body.
- **`relayGroups.ts:60 'resolveMessage' is defined but never used` is
  PRE-EXISTING at `main`**, baselined via `git show main:... | eslint --stdin`.
  Do not re-diagnose it as this branch's.
- **Two spec deviations were pre-ratified by Cameron** (2026-09-01, via the
  planner): `today-contact-hydration-fan-out` stays OPEN rather than being
  wontfixed on a 1-contact harness number, and `GET /api/conversations` (Today's
  offline-fallback source) stays unhydrated per the spec's own decision 4.
- **The whisper now speaks "Bob B."** where it used to speak a stored full name -
  an audible change, accepted by spec S4.

## Still open, deliberately

`consolidate-contact-display-name-helpers`, `staff-only-roster-name-readers-stale`
(filed BY this mission), and `today-contact-hydration-fan-out` - which closes only
on Cameron's imported-dataset `npm run perf:pages` run, a human-only target.
Resolved by the work: `group-roster-name-snapshot-never-refreshed`,
`today-shows-phone-instead-of-name`, `relay-stale-participant-phone`.

Two open questions in [`handback.md`](handback.md) are still Cameron's: the
`relayFanOut.ts:774` sender prefix (ruled no-new-issue; reopen only if a stale
relayed name is observed) and the tag-vs-hydrated-names precedence, pinned as
designed and a one-line change in `relayThreadLabel` if he wants the tag to win.

**The handback's third owed item is now VOID.** It asks for two one-line edits to
`docs/issues/_CLUSTERS.md:82`/`:84`; that file was RETIRED and deleted on
2026-09-02 (`a4e0b64b`). Nothing to edit - do not recreate it.

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `sdd/research-{A,B,C,D}-reference.md` and `sdd/plan-review-B-reference.md`.
  **The mission split these itself at authorship**, naming the halves
  `-findings` (tracked here) and `-reference` (left in ignored space).
- `.superpowers/review/diff-*.md` and `sdd/relayGroups.main.ts` - a raw diff pair
  and a baseline source copy. Git regenerates both.
- `sdd/gate*.log`, `planner/gate*.log`, `punchlist-*.log`, `audit-lane*.txt` -
  captured gate output. The verdicts, with quoted counts, are in the handback.
- `sdd/*-commit-msg.txt` - commit-message scratch, already in the git log.
- `sdd/progress.md`, `heartbeat.log`, `session.log`, `live.log` - run state.
- `sdd/handback.md` was byte-identical to the tracked copy; nothing was
  overwritten.
