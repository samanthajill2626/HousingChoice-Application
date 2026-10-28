# Code review R2 - adjudications (build orchestrator, 2026-10-27)

Reviewed head: 0f271f74 (after fix wave FW1). Source: `R2-review.md` in this
directory (fresh reviewer; 1 MEDIUM, 2 LOW, all class REGRESSION; 15 of 16 FW
items REAL, FW-11 PLAUSIBLE ONLY; two adjudication challenges).

Loop rule (from here to handback): a finding classed REGRESSION - B1 breaking
its own spec behavior, or a fix wave introducing a defect - is fixed in the
next wave; NOT A REGRESSION (pre-existing, outside B1, polish) is filed as an
issue or recorded. Each wave gets a fresh reviewer on its diff.

## Fix wave FW2 (binding list; one child)

| FW | Source | Ruling | What |
|---|---|---|---|
| FW2-1 | R2-1 MEDIUM | FIX (my call; named for Cameron) | The Notes retry guard in `filterNoteLines` compares WHOLE lines, not substrings: a candidate is dropped when an existing Notes line - with a leading `[Auto - <Mon D>] ` prefix removed, both sides trimmed - EQUALS it. Retry idempotency (same or a later date) and verbatim-repeat dedupe are kept; a line that is merely CONTAINED in a longer line (a label that ends another label, "12 Oak St" inside "112 Oak St"; a shorter feedback inside a longer one) is no longer dropped. The prompt's change-of-mind bullet asks the model to SAY the view changed ("now likes it", "back on the fence"), because a line identical to an earlier one is not written again. Tests: the two R2-1 reproductions append; an identical earlier line (any date) and a same-run retry are dropped; a candidate contained in a staff prose line appends (the accepted trade-off); the prompt wording pinned. Update the existing guard tests only with a stated reason. |
| FW2-2 | R2-2 LOW | FIX (docs) | FW-11's code stays as defense in depth (it covers a form or test that skips native validation), but its comment and e2e/support/selectors.md:60 say what a browser does: the edit form has no `noValidate`, so native validation refuses an unparseable portion entry with the browser's own message ("Please enter a number.") before Save runs; the form's `role="alert"` with the server's copy covers parseable bad values (12.5, -5, 20001). |
| FW2-3 | R2-3 LOW | FIX | The probe's git checks certify the MEASURED code only: the dirty flag and FW-6's before/after comparison look at `app/src` and `app/scripts` (pathspecs on `git status --porcelain --untracked-files=no` and, when the commit moved, `git diff --quiet <before> <after>`), so appending to or committing the gate record - or any other docs - neither marks the run dirty nor fails it. Same scope for each `--baseline` side. Tests through the injected git dep. |

## Adjudication challenges

- CONF-1 / FW-11 ruled MUST-FIX on a jsdom-only reproduction: ACCEPTED. In a
  browser the data-loss path is unreachable (no `noValidate`: native
  validation blocks the submit). FW-11 stays as harmless defense in depth
  with corrected docs (FW2-2). The issue the orchestrator filed from the same
  premise, `number-input-unparseable-entry-silently-ignored`, is closed
  `wontfix` (the property and contact forms set no `noValidate` either).
- FW-9 gives a CONTROL case a planted fact, against spec D7 ("Control cases
  plant none"): ACCEPTED as a challenge, NOT reverted. The case's message
  carries an excluded fact by design (the therapist who wrote the
  assistance-animal letter), and telling the grader "none" would bias it on
  the one boundary the case exists to test. Listed as a spec deviation for
  Cameron's sign-off (handback and the gate-run sheet). The planted fact
  prints in the record and is not hashed (PR51 decision 13), so a reader of
  the record sees it.
- All other R1 rulings upheld by R2 against the spec text (ADV-4, ADV-5,
  ADV-6, ADV-7 retry part, ADV-13, ADV-14).

## For Cameron (carried to the handback)

- FW2-1 changes the "verbatim retry guard" spec D4 keeps "as is" from a
  substring test to a whole-line test, because the substring form silently
  drops feedback D5.2 requires (a label ending another label; a change of
  mind contained in earlier wording). Both of the guard's stated purposes -
  a retried run appends nothing, a verbatim repeat is not written twice -
  hold. One case stays: a flip back to EXACTLY an earlier line's words is
  still dropped; the prompt now asks the model to word a change of mind as
  a change.
