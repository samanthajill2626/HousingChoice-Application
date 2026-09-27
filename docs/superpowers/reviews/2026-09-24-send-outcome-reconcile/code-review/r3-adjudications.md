# Code review round 3 - adjudications and the FW5 list

Orchestrator adjudication of `r3-review.md` (NEW-1, D-2 and three challenges)
over FW4 (c8193fc2..4eef5efa). Before these rulings the gates at 80fe74c1
(code = 4eef5efa) read: typecheck 0 (0 `error TS`); smoke 0 (1481 specifiers /
259 files); lint gate 5 with 0 new errors; `npm test` 0 (app 383 files 7672
passed / 1 skipped; dashboard 204/3403; e2e-unit 21/499; fake-twilio 34/268;
fake-twilio/web 13/111; 0 `[dynamoAdmin]`); the e2e was still running.

Load-bearing claims re-checked in the source: the list call's catch returns
the error verdict straight away, before the judge loop, at every page
(sendReconcile.ts:830-833 against :852-874); the known arms' `slotWritten`
covers the slot write AND the stats bump in one guardWrite
(broadcastFanOut.ts:696-703); the spec lists "page bound exceeded" among the
`unresolved` causes (spec D16) and asks the first hosted-dev run to check the
walk's order and page bound (spec Sec 10).

## 1. FIX - FW5 (one implementer)

### FW5-1 (NEW-1): a list error mid-walk judges what was read

FIX. The mechanism is confirmed; it is the "return before judging" FW4-1 rule
(b) removed for the page bound, still standing for a list error, and FW4-1's
longer last-check walk made it reachable - a text that went out, and that the
provider listed on page 1, closes "Not confirmed" when page 2 fails. The fix
is the same principle, applied once more, and adds no machinery.

Binding semantics for `lookup()`: a failed list call (at any page, at any
check) ends the walk and falls into the judge loop over the candidates already
read; an adoptable one is adopted exactly as today. When nothing is adopted,
the check returns exactly today's error verdict - before the last check
`continue` / `provider_error` with the error; at the last check `unresolved` /
`provider_unreachable` with the error - ahead of every other outcome (the
error is why the walk is incomplete). A walk that met a list error never rules
never_sent. A failure on page 1 therefore behaves exactly as today (nothing
read, nothing to judge).

Tests (each failing first on 4eef5efa, the failing line quoted): the
reviewer's scenario (page 1 holds the orphan with a next page; the page-2 call
throws at the last check - adopted, not provider_unreachable); a page-2 error
at the last check with nothing adoptable - unresolved provider_unreachable,
never never_sent or page_bound; a page-2 error at check 0 with the orphan on
page 1 - adopted at check 0; a page-1 error keeps today's verdicts (existing
pins may hold it - name them).

### FW5-2 (D-2): the carry line says what failed

FIX, log text only. The known arms' guardWrite covers the slot write and the
stats bump, so the carry WARN at broadcastFanOut.ts:752-760 names both: the
rejection's slot or stats write failed, and the recipient is carried with the
attempt still open. Gating an outcome line on the slot write alone would split
that guardWrite - a write-structure change, left with R2C-5's residue. Update
the pins that match the old text.

## 2. The challenges

- The FW4-1 cost claim ("without adding a failure point"): ACCEPTED as a
  correction - each added list call was a new way to discard what had been
  read. FW5-1 restores the claim: after it, an added call can only ADD
  evidence. R2C-1's lighter alternative (keep the last-check early stop and
  rule unresolved when it fires) is declined: it closes a queued orphan on page
  2 "Not confirmed" instead of adopting it, and it makes never_sent unreachable
  for nearly every recipient with more than one page of history.
- Rule (c)'s verdict cost: NOT a behavior change against the spec or main. The
  spec lists "page bound exceeded" as an `unresolved` cause (D16), and at
  83308e15 every walk past the bound closed page_bound; only the unmerged
  interim af848977 (FW1-6's early stop) reached never_sent for such a
  recipient - the F-1 hazard FW4-1 removed. The handback nevertheless states it
  plainly for the human's eye: a genuinely lost send to a recipient with more
  than 5000 messages from one sender closes "Not confirmed" and is not re-sent
  automatically; the first hosted-dev run checks the walk's order and bound
  (spec Sec 10).
- FW4-2's gate on the combined guardWrite: kept; FW5-2 makes its log line
  true. R2C-5 stays RESIDUE (the reviewer agrees; zz-r3-2 shows it harmless to
  the user today).

## 3. Verdicts

FW4-1: REAL as ruled; its one hole is FW5-1. FW4-2: REAL for the slot-throw
case; its one false line is FW5-2. No other disagreement: N-1, A-1, F-3,
R2C-5, R2C-6 and R2C-7 stay RESIDUE; R2C-2 stays a NOTE.
