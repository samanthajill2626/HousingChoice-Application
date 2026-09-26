# Code review round 3 - adjudications and the fix-wave-3 charter

Date: 2026-09-26. Branch `feat/inbox-rows-timestamps`, reviewed @6024b619 by a
fresh reviewer (`code-review-r3.md`) who measured every row shape at eight
widths (360-1440) with the shipped CSS inlined in a real Chromium.

Adjudicator: the build orchestrator.

| # | Sev | Decision | Rationale |
|---|---|---|---|
| R3-1 | MUST-FIX | FIX | Wave 2's `.tag` / `.deletedTag` rule (`min-width: 0; flex-shrink: 100`) does not ellipsize a short tag, it BLANKS it: the tag absorbs ~99% of the head's shortfall until its content box hits 0, so the relay Closed tag is an 18 px box below ~1140 px and the Deleted chip and stage labels are blank at 768 and on phones with ordinary names. The wave-2 adjudication's "confined to long-tag rows" was wrong. ONE RULE for chips now, with a floor: (a) short fixed-vocabulary state markers stay RIGID as on `main` - the channel chip (`.channel`), the relay Closed tag (`.tag`) and the Deleted chip (`.deletedTag`); (b) the two chips whose meaning survives truncation yield BEFORE the name with a `min-width: 4em` floor (`overflow: hidden; text-overflow: ellipsis; flex-shrink: 100`): the placement tag, moved to its own class `.placementTag` (composed with the tag look) and carrying `title={label}` so the full stage label is recoverable, and the Needs triage chip (`.triage`). Measured by the reviewer: with the floor no tag falls below 30 px of text; placement-only yielding keeps Closed and Deleted whole at every width; the triage chip yielding gives the unknown number 99/108 px at 360 and 107/108 at 390 and 768 (the chip shows "Nee..." / "Needs t...", still amber beside the amber dot). |
| R2-6 | (reopened) | DECIDED | The unknown row's number - its only per-row identity - was cut to the area code on EVERY unread unknown row at 360 ("(555) ...", 59/108 px) and to "(555) 1..." at 768 with a Windows scrollbar. That is not an edge case, so the Needs triage chip yields first (R3-1 b). This deviates from spec 5.4's letter ("Chips and tags ... never shrink") for the triage chip and is FLAGGED in the handback with the numbers; reverting it is one CSS line (`.triage { flex-shrink: 0; min-width: auto }`). Sam's mockup could not show this overflow case; the drawn one-line and two-line layouts are unchanged. |
| R3-2 | NOTE | FIX (text) | Spec 5.4: the count and the time always keep their room and the PREVIEW absorbs the overflow; name the Closed tag and the new rule with its floor; the Status line cites the round-2 and round-3 adjudications (the row CSS Sam approved changed under R2-1/R2-2/R3-1); 7.3 test 4 describes the 304-character pin. |
| R3-3 | NOTE | FIX (record) | `fix-wave-2-report.md` said "NOTHING COMMITTED": an addendum records the three hashes, that the orchestrator committed them after the classifier denial, and the gate runs it made (dashboard suite exit 0, 198 files / 3272+ tests; typecheck exit 0). Written by the orchestrator in this round. |
| R3-4 | NOTE | FIX (trivial) | Gate the `<ul>` on `listShown` itself so the scroll-root effect's key cannot drift from the element it waits for. |

Pins for wave 3: a source-reading `InboxRow.styles.test.ts` (the pattern of
`Inbox.styles.test.ts`) asserting `.head { flex: 0 0 auto }` and
`max-width: 45%`, `.time { min-width: 5rem }`, the `767.98px` query, that
`.placementTag` and `.triage` carry `min-width: 4em` and `flex-shrink: 100`,
and that `.tag`, `.deletedTag` and `.channel` carry NO `flex-shrink`; plus an
`InboxRow.test.tsx` case that the placement tag renders its full label as
`title`. Geometry is proven in the live self-QA at 360 / 768 / 1280 on the
FULL seed profile (closed relay, Deleted row, placement tags) - the lean world
cannot mint those rows.

## Wave 3 scope summary

`InboxRow.module.css`, `InboxRow.tsx` (the placement tag's class and title),
`InboxRow.test.tsx`, new `InboxRow.styles.test.ts`, `Inbox.tsx` (`<ul>` on
`listShown`), the spec (5.4, Status, 7.3). One commit plus its report. The
diff is small enough that the orchestrator reads it itself before the final
gates; the live self-QA measures the result.

## Addendum (orchestrator, 2026-09-26) - the live self-QA's finding (SQ-1)

Measuring the shipped chip rule on lane 16 (full profile) showed the one
thing the round-3 harness could not: with the Needs triage chip yielding at
`flex-shrink: 100`, the phone-named stub row's number still lost its LAST
DIGIT to the ellipsis at 360 and 768 (a ~1% share of the shortfall, a
sub-pixel overflow). Fixed on the same tree as a rigid `.numberName`
(`flex-shrink: 0`) for a name matching the formatted-number shape, pinned in
both row test files, spec 5.4 amended, re-measured live (108/108 px, last
glyph visible, the chip at 47-58 px). See `self-qa.md`.
