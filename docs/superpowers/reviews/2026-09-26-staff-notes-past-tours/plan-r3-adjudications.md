# Plan review round 3 - adjudications (TERMINAL round)

Plan: v6 @b6e08711 -> v7, APPROVED FOR BUILD (this round).
Reviewer: A continued (`plan-r3-reviewer-a.md`, 3 findings, all LOW; the v6
dashboard delta rebuilt in a scratchpad, typechecked at 0 errors, linted
clean under recommended-latest with both relevant rules proven live by
injection).
Planner: Fable, overnight unattended run.

Stop rule: round 3 changed nothing about how any task is built - the three
findings are precision edits - so this is the terminal plan round (3 of the
4-round cap used).

| # | finding | ruling |
|---|---|---|
| R3-1 | the plan header still described the v5 keyed remount | ACCEPT. Header now describes the Past-only child. |
| R3-2 (CONTEST of R2-2's leftover) | `bulkBusyRef` in the child unmounts mid-batch, so Past -> Active -> Past could start a second batch | ACCEPT. The ref is owned by `ToursPage` (which survives a tab switch) and passed to the child as a prop; read and written only in event handlers, so it stays clean under `react-hooks/refs`. |
| R3-3 | the Past query starts after the lookups land instead of alongside them | ACCEPT AS A NOTE, no change: the Closed tab has the same ordering today, and the optional fix adds a prop and a compound spinner condition for a first-paint gain of one request's latency. The builder records it in the slice report. |

Plan review closed. The mission block cites plan v7 and rounds R1-R3.
