# Slice 9 report - Task 15 (docs closure + founder-handback-items.md)

Status: COMPLETE. One commit, docs only plus the single TODO marker line.

## Per deliverable

1. **SHIPPED** - `app/src/messages/tourCopy.ts` `reminderNamesUsed` docblock:
   `TODO(tour-reminder-ladder-phase-b)` -> `TODO(tour-copy-where-token-declared-not-passed)`.
   One-line diff; comment text otherwise byte-unchanged. This was the ONLY
   `tour-reminder-ladder-phase-b` marker in the tree (report D 6.4 confirmed).
2. **SHIPPED** - `docs/issues/tour-reminder-ladder-phase-b.md`: frontmatter
   `status: open` -> `resolved`, `resolved: 2026-08-31` inserted between
   `created:` and `refs:`, and the Phase B spec + plan paths appended to `refs:`.
   A `**Resolution (2026-08-31).**` paragraph plus a nine-row list appended at
   the END; the historical body above it is untouched (`git diff` shows pure
   additions apart from the two frontmatter lines). Dispositions copied from
   spec section 12's table, each citing the discharging section: 1->s4 (with
   s4.3 tokens and s4.4 shape), 2->s3.1+s5, 3->s10, 4->s6 (+6.1a), 5->s6,
   6->s4.5, 7->s7, 8->ASSESSED/NOT FIXED/DROPPED-not filed (s12, Cameron's
   ruling quoted in substance, `supersededInBatch` deliberately unchanged),
   9->RE-DEFERRED (s12) with the TODO re-point recorded. Closing line points at
   the founder-handback artifact.
3. **SHIPPED** - `docs/issues/placement-nudge-overdue-invisible-on-card.md`
   STAYS OPEN; a dated paragraph appended recording the two surfaces spec 8.2
   excludes from the tour `overdue` flag and assigns to this item:
   `routes/contactTimeline.ts` (upcoming bucket, `TimelineScheduled`) and
   `routes/relayGroups.ts` (GET `/api/conversations/:id/scheduled`), both
   rendering through `dashboard/src/routes/contact/ScheduledCard.tsx` whose
   `fireTimeLabel` still returns the literal `sending shortly` for a past `at`.
   Ruling R3 / research D8: the spec claimed this record already existed; it did
   not, and the paragraph says so in its closing line. I verified the
   `sending shortly` claim against the live file rather than trusting the
   worklist: `ScheduledCard.tsx:45-50` still returns it for `at <= now`, and
   `scheduledLabel` short-circuits ahead of it only for `discontinued` /
   `paused` - noted in the paragraph as the pattern to follow.
4. **SHIPPED (NEW, committed)** -
   `docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/founder-handback-items.md`.
   Spec section 15's five items VERBATIM (item 2's SEQUENCING line included),
   with a one-line pointer above them saying items 1-5 are quoted from spec
   section 15. Verbatim-ness was proved MECHANICALLY, not by eye: `diff` of spec
   lines 1216-1235 against the file's lines 10-29 exits 0. Then
   `## Added during the build` with the three build-found items, numbered 6-8 so
   the artifact has one continuous numbering a reader can cite (the brief did
   not number them; this is the only cosmetic liberty taken).
5. **RAN** - `npm run issues` from the worktree root. `docs/issues/INDEX.md` is
   gitignored (`.gitignore:62`, confirmed with `git check-ignore -v`) and does
   not appear in `git status`; NOT committed.

## Commands run

| command | exit | result |
|---|---|---|
| `cd app && npx vitest run test/tourCopy.test.ts` | 0 | 1 file, 27 tests passed |
| `npm run typecheck` (worktree root) | 0 | clean |
| `npx eslint app/src/messages/tourCopy.ts` | 0 | zero output, no baseline comparison needed |
| `npm run issues` | 0 | 273 open, 158 closed, 431 total |

Logs: `.superpowers/sdd/logs/slice9-{tourCopy,typecheck,eslint,issues}.log`
(gate commands run bare and redirected, never piped).

ASCII check: `[^\x00-\x7F]` over all four touched files - no matches. All four
files are fully ASCII, not merely their added lines.

`git status` before commit showed EXACTLY the three modified files + the one new
file, nothing else. `.git/MERGE_HEAD` absent.

## Divergences from plan / worklist

- None material. The brief's deliverable list is a superset of plan Task 15
  steps 1-3 and I followed the brief. The only liberty: numbering the three
  build-found handback items 6-8 rather than restarting at 1.

## Open worries (not blocking, your eye)

- `npm run issues` emits one pre-existing warning unrelated to this branch:
  `perf-selfqa-route-contract-drift.md: unknown severity "medium"` (the schema
  wants `med`). Present before this slice; I did not touch that file.
- The ledger's resolution list asserts what the other slices BUILT. I did not
  re-verify each claim against the shipped code - I copied spec section 12's
  dispositions as the brief directs. If any slice deviated from its spec section
  and reported it, the corresponding row here would inherit that deviation.
  Worth one pass by whoever holds the full slice-report set.
- Item 8's row says `supersededInBatch` stays as-is "deliberately". That is the
  spec's ruling, but it means the ledger closes with a live (if
  disaster-recovery-only) predicate defect recorded ONLY inside a resolved
  issue's body. If anyone later wants it findable, it needs its own file - which
  Cameron's ruling explicitly refuses. Recorded here so the refusal is not
  re-litigated by accident.
