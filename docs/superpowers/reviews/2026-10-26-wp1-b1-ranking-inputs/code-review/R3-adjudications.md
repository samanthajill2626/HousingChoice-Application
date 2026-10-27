# Code review R3 - adjudications (build orchestrator, 2026-10-27)

Reviewed head: 28450c2d (after fix wave FW2). Source: `R3-review.md` in this
directory (fresh reviewer; 1 MEDIUM, 3 LOW, 1 INFO; 4 REGRESSION, 1 NOT A
REGRESSION; FW2-1 real for the label-suffix half only, FW2-2 and FW2-3 real;
two adjudication challenges). The loop rule of R2-adjudications.md applies.

## The retry guard, decided (R2-1, R3-3, R3-4 and R3's challenge)

FW2-1 kept date-agnostic dedupe of verbatim lines. R3 shows its residual is
not an odd case but the expected output of the prompt's own wording: a
tenant who wavers twice produces the same change-of-mind phrase again, and
the newest view of the home is silently dropped. The guard's documented
purpose (adversarial F1, the comment above rule 4) is ONE thing: a
complete() failure re-arms the SAME due row and the retry re-extracts the
same transcript minutes later. Spec D5.2 requires "a CHANGE of mind is a new
line"; spec D5.3 adds "no new filter". Weighing the two failure modes - a
duplicate line (noise, no wrong meaning; a repeated "on the fence" is a true
reaffirmation) against a lost change of mind (the box, and B2's ranker, read
a stale view of a home) - meaning wins. Decision (my call, named for
Cameron):

- MODEL lines: dropped only when the line as this run would write it -
  `${prefix} ${line}`, after stripping any leading `[Auto - <date>]` the model
  copied into its text - equals a run of whole existing lines. The prefix
  carries the run's date, so this is exactly the F1 retry (same day). A line
  equal to one from an EARLIER date is written again.
- SYSTEM lines (apply's own deterministic text, e.g. "Mentioned number X
  which belongs to another contact"): dropped when equal, whole line, prefix
  stripped, to any existing line of any date - they carry no meaning change
  and would otherwise repeat on every run.
- Accepted costs, recorded: a retry that crosses UTC midnight appends its
  lines once more; a model line repeated verbatim on a later date (the model
  ignoring the reconcile rule) is written again; two runs on the SAME day
  that flip back to the same words drop the second (rare: three runs in a
  day with identical wording).

## Fix wave FW3 (binding list; one child)

| FW | Source | Ruling | What |
|---|---|---|---|
| FW3-1 | R3-3, R3-4, R3 challenge (supersedes FW2-1's guard rule) | FIX | Implement the guard decided above in `filterNoteLines` (apply.ts): model lines compared as this run would write them (same-date retry only), system lines compared prefix-stripped against any date, a model-supplied leading `[Auto - <date>]` stripped from the candidate BEFORE the comparison AND before the write (never a double prefix). Keep the multi-line handling (a line spanning lines matches a run of whole lines). Tests: R2-1's exact-words flip back across dates appends; R3-3's two second-oscillation cases append; a same-day retry (identical lines, same prefix) is dropped; a same-day re-emission is dropped (documented); a cross-date verbatim model repeat appends (documented cost); a system line repeated on a later date is dropped; a model line carrying an old prefix is written with ONE prefix and a same-day echo of it is dropped; FW2's 12/112 and contained-wording pins stay green. Update FW2's "identical earlier line (any date) is dropped" pin with the stated reason (this ruling). Update every doc comment and RUNBOOK sentence that describes the guard. |
| FW3-2 | R3-1 MEDIUM | FIX (prompt) | The change-of-mind guidance NAMES the property: examples carry a label ("123 Main St, Decatur: now likes it", "123 Main St, Decatur: back on the fence"), and the bullet says a change of mind still copies the property's label - the one repetition the reconcile rule allows. Remove the FW2-1 sentence about identical lines never being written again (no longer true). Pin the new wording; keep every phrase an existing prompt test asserts on one line; ASCII. |
| FW3-3 | R3-2 LOW | FIX | A never-written run whose BEFORE git read is unknown (git failed) FAILS: "git could not read the commit - no certificate"; an unknown AFTER read already counts as a change (keep). Test through the injected git runner. |

## Recorded, not fixed

- R3-5 (INFO, NOT A REGRESSION): a model line holding a line break is written
  with the prefix on its first physical line only (as main did). FILED by the
  orchestrator as an issue for B2 (collapse CR/LF in a model line before the
  guard and the write).
- R3 challenge to FW2-3's scope (manifests not counted on the measured side;
  app/scripts counted on the baseline side, which it never runs): accepted
  as accurate, NOT changed - the "(tracked files modified)" label is
  informational, every module loads once at the start, and the commit line
  is the certificate. Recorded for the gate-run sheet: run the gate from a
  checkout with a clean lockfile.

## For Cameron (carried to the handback)

- The "verbatim retry guard" spec D4 keeps "as is" is now a same-day retry
  guard for model lines (and a dedupe for apply's own system lines), because
  the date-agnostic form silently drops a tenant's change of mind back to
  earlier words (R2-1, R3-3), which spec D5.2 requires to be written. Costs
  above. Spec text deviation: D4 "Kept as is: ... the verbatim retry guard".
