# Code review round 3 - adjudications (orchestrator, 2026-09-01) - TERMINAL

Reviewed: fix wave 2 (@4d928b46 + @ee873111). Reviewers continued from rounds 1-2
(A = `r3-conformance.md`, B = `r3-adversarial.md`; B's turn was cut by an API connection
error mid-review and resumed - its report was already on disk and it verified it).
Totals: BLOCKING 0, MUST-FIX 0, SHOULD 2, NOTE 6. Every round-2 item is CLOSED by both
reviewers; reviewer A WITHDREW its dry-run exit-code disagreement (the RUNBOOK sentence it
contradicted was deleted in the same wave). Reviewer B does not contest the NOTE-3
RECORD.

Empirical: full e2e on @ee873111 = 262 passed, EXIT=0 (the placement walk now green).

## Applied by the orchestrator in the closing polish commit (no fix wave)

| id | finding | ruling |
|---|---|---|
| A S-R3 | `build/fix-wave-2.md:70` carried a Unicode ellipsis; the wave reports' ASCII checks ran a BARE `git diff` (unstaged = nothing on a clean tree) - the same trap AGENTS.md documents for gate 5 | FIXED (character replaced). Orchestrator re-audited as a RANGE diff `ec32170a...HEAD`: that character was the ONLY non-ASCII added line on the whole branch; code and copy are clean. |
| B S-R3-1 | The placement e2e's leg assertions loop two hardcoded minted phones; the "these are every member" completeness claim rested on a prose comment | FIXED: the walk now also reads `GET <ownerPath>/roster` and asserts the members' `phoneLast4` set equals the minted numbers' last-4 set (that field IS served), so a third member fails loudly. |
| B NOTE | R2-S2 generalized the sweep's population B to `DISCONTINUED_REMINDER_KINDS` but the script header (`:22`) and `RUNBOOK.md:292` still said "every pending `confirmation`" | FIXED (both prose sites now say "every pending rung of a DISCONTINUED kind - today only `confirmation`"). |

## RECORD

| id | finding | ruling |
|---|---|---|
| B NOTE | `overdue` is the one remaining `'upcoming'` predicate that still counts a discontinued rung | RECORD - harmless by construction (the chip order test pins "No longer sent" over "Overdue") and spec 8.1 asked for the flag to be a plain derived boolean. |
| A NOTE | The sweep's dry run structurally cannot exercise the WRITE failure class (permissions / wrong prefix surface only mid-apply) | RECORD; carried to the handback's operator notes. |
| A NOTE | A quiet-hours-deferred relay open discards an operator-edited `intro_body` (`routes/tours.ts:1391-1406`) - pre-existing, now load-bearing for a comment on this branch | RECORD; filed as a handback observation (not this mission's scope). |
| A NOTE | The plan/write split probed both ways: a row-local WRITE failure needs a malformed `reminderId`, impossible for the table's hash key; a systemic PLAN failure still trips the `failed > 0` exit-1 rule | RECORD - closes the R2-M1 reasoning. |

Review is TERMINAL after this round: no open BLOCKING / MUST-FIX / SHOULD.
