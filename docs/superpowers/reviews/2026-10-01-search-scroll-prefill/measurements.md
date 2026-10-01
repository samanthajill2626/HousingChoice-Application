# Two intermittent e2e failures - measurements (2026-10-01)

Machine: the new Windows 11 PC. Every run is `npm run e2e -w e2e -- --grep ...`
(a hermetic lane that reseeds at startup). Root causes: `diagnosis.md` beside
this file.

## contact-create.spec.ts:157 ("editing a contact can LINK ...")

| Tree | How | Result |
| --- | --- | --- |
| main @8c7921ea | 6 separate standalone runs | P P P F P P |
| main @8c7921ea | instrumented copy, `--repeat-each 15` | 14 P, 1 F (late scroll dismissed the list) |
| main @8c7921ea | real spec, `--repeat-each 40` (test timeout 20s) | 36 P, 4 F - all four the same "no Marcus Bell option" wait |
| fix/search-scroll-prefill (component fix) | real spec, `--repeat-each 40` | 40 P, 0 F |

At the main rate (4 in 40), 40 clean repeats by chance is about 0.9^40 = 1.5%.

The 2026-09-30 history (main, alone, P F F F in one worktree) is in
`docs/superpowers/reviews/2026-09-30-today-past-tours/gate-runs.md`.

## a2p-compliance.spec.ts:323 (re-include step)

| Tree | How | Result |
| --- | --- | --- |
| main, full suites 2026-09-30 | 7 full runs | 2 F at the re-include exact-value check |
| main @8c7921ea | forced interleave (prefill committed between fill's select and insertText) | 3 of 3 produce prefill + typed text, the exact failing shape |
| main @8c7921ea | control: wait for the prefill, then fill | 3 of 3 replace it |
| main @8c7921ea | forced interleave of the SECOND write (draft POST held; its `?cta=text` re-seed committed between select and insertText) | 3 of 3 end `?cta=text` + typed text |
| fix/search-scroll-prefill (spec waits for `?cta=text`) | real test alone, `--repeat-each 10` | 10 P, 0 F |

The standalone failure rate on main was never measured (the two sightings were
in full suites), so the 10 clean repeats show the new wait is always satisfied
rather than proving the race gone; the forced interleaves are the proof that
both writes are hazards, and the wait is ordered after both.
