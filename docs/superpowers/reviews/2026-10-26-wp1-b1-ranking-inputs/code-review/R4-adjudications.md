# Code review R4 - adjudications (build orchestrator, 2026-10-27)

Reviewed head: aca3ccda (after fix wave FW3). Source: `R4-review.md` in this
directory (fresh reviewer; 0 MEDIUM, 1 LOW, 2 INFO; FW3-1 and FW3-2 REAL and
matching the ruling, FW3-3 REAL for the never-written suite only; one
challenge to the retry-guard weighing). The loop rule of R2-adjudications.md
applies.

## Fix wave FW4 (binding list; one child)

| FW | Source | Ruling | What |
|---|---|---|---|
| FW4-1 | R4-1 LOW, REGRESSION | FIX | Mirror FW3-3 in the `--baseline` comparison (`runComparison`): after both sides' git reads and BEFORE any driver is created or call made, a side whose commit is unknown (git failed) fails the run - "git could not read the commit of <root> - no certificate. Nothing was sent and no record written." - exit 1, no record; the dry run is unchanged. Tests through the injected git runner: the branch side refusing, then the baseline side refusing. |
| FW4-2 | R4-2 INFO (NOT A REGRESSION) + R4-3 INFO (doc-only) | FIX (comment only) | Rule 4's "Accepted costs" in apply.ts `filterNoteLines` gains: a retry of a run that hit the five-line cap appends the lines the cap kept out (at most another five; spec D4 puts the guard before the cap); and "same day" means the same month and day of ANY year (the `[Auto - <Mon D>]` prefix carries no year), so a flip back on an exact anniversary with identical words is dropped. No code change. |

## The challenge to the retry-guard weighing (R4 section 3)

ACCEPTED in substance, ruling unchanged. R4 is right that a later-date
verbatim repeat is not only "noise": the window is re-sent on every run, so a
model that re-emits an OLDER view word for word after the tenant changed
their mind writes a stale view as the newest line for that home - the mirror
image of R2-1. Text alone cannot tell that stale re-read from a genuine flip
back (R4 agrees). The ruling stands because it trusts the model's own
reconcile judgment - the model sees the Notes box, including the latest
line for the home, and the prompt tells it to omit what the notes already
say and to write a change of mind - where FW2's guard overrode a correct
judgment silently. The cost is restated plainly for Cameron below, and the
measurement R4 asks for (count guard drops on the run record) is FILED for
B2, which is the first reader of "the latest line for a home":
docs/issues/notes-guard-stale-reread-vs-flip-back.md.

## For Cameron (carried to the handback; supersedes R3's wording)

- The Notes retry guard (spec D4 "kept as is") is now a same-day guard for
  model lines and an any-date dedupe for apply's own system lines (R2-1, R3,
  R4). What that costs, plainly: (1) when the model re-emits an OLDER view
  of a home word for word on a later day (it re-reads the whole recent
  window every run), that stale view is written as the newest line for the
  home; (2) a model fact repeated word for word on a later day is written
  again; (3) a retry across UTC midnight appends its lines once more; (4) a
  retry of a run that hit the five-line cap appends the rest; (5) "same day"
  is month and day of any year. What it buys: a tenant's change of mind back
  to earlier words is never silently dropped (spec D5.2), which the old
  guard did. Neither failure's frequency is known yet - the B2 issue asks
  for a count.
