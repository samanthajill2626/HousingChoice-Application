# R3 adjudications - feat/today-checklist (tracker #31)

Adjudicated by the build orchestrator, 2026-10-25, on `R3-review.md`
(fresh reviewer, HEAD 03f9727f; HIGH 0, MEDIUM 0, LOW 1, INFO 2; nothing
loses, duplicates, strands or misdirects a send). R3 found FW2-1, FW2-2 and
FW2-3 real (each with a remark below) and agreed with every earlier
no-change ruling.

## Fix wave 3 (one child, fresh) - small, contained

- FW3-1 (R3-1, LOW, CONFIRMED). "All caught up" shows while a past-tours
  RELOAD has failed if that section's last good load listed nothing: the
  page never reads `past.reloadFailed`, and an empty Past section returns
  before its "Could not refresh" note. Pre-existing shape on main, but this
  mission owns the "All caught up" rule (spec 2.3: "A section that failed to
  load is not empty: it shows its own error, and the page does not claim
  All caught up") and FW1-1 already applied it to Today's own refetch.
  Fix: `allCaughtUp` also requires `!past.reloadFailed`; the past-tours
  section renders its heading and its existing reload note when
  `reloadFailed` is set even with no rows. Tests: R3's probe (mocked hooks)
  plus the real-hooks case; the existing rows-plus-note case unchanged.
- FW3-2 (R3-3, INFO, CONFIRMED; a side effect of FW2-2). The AI line now
  remembers its "Show all" across close and reopen (the lifted expansion
  Set is never cleared for it). Ruling: spec 2.4 "Opening it shows the rows
  with the same 5-row limit and Show all" - each OPENING starts at the first
  5 rows, as before FW2-2. Closing and reopening is a viewer action, not a
  refetch, so FW2-2's survival rule does not apply. Fix: closing the AI line
  clears its expansion entry. Test: R3's probe.
- FW3-3 (R3-2, INFO, CONFIRMED; FW2-3's pick rule). The 404 fallback's
  one-row-per-contact de-dupe keeps the FIRST thread, so the only row can be
  blank (an email thread with no display name first) - R2-1's shape again -
  and keys by refId, so two different people whose email threads carry
  neither a contact id nor a phone (`unknown?phone=`) collapse into one row.
  The fallback is effectively dead in prod, but the fix is small and keeps
  the two paths' rules alike: de-dupe only rows that carry a real contact
  id, and when collapsing prefer the thread whose label is not blank
  (FW2-1's merge reasoning). Copy and unread rule unchanged (spec 3.1).
  Test: R3's two probes.

## Not changed

- R3's FW2-1 remark (a resolved owner with no name, on an email thread with
  no display name, still reads '' when the triage read does not return that
  contact because it is past the triage partition's 100 cap): pre-existing
  and bounded by spec 5.2's caps (prod holds 8). Handback note.
- R3's handback note that FW1 / FW2 ran e2e subsets, not gate 4: the full
  `npm run e2e` runs in S8 on the final commit (and ran green at c7705789).

## Loop rule after this wave

FW3 gets one fresh, focused re-review of its own diff (R4). Any R4 LOW or
INFO that is not a regression introduced by FW3 is FILED as a
docs/issues entry, not fixed, so the review loop closes.
