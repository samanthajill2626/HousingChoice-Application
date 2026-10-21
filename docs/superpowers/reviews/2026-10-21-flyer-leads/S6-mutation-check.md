# S6 mutation check - e2e/tests/dashboard-next/flyer-leads.spec.ts

Date: 2026-10-21. Branch tip: 93b02a36 (the spec itself uncommitted until
this record's commit).

Mutation (scratch, reverted in the same task): app/src/routes/public.ts - the
condition guarding the welcome send (D5: only a contact this request created)
replaced by `true`, so an existing contact is welcomed again. The scratch
diff was that one line (public.ts:575 `if (isNew) {` -> `if (true) {`).
C2 before the run: no live session pid, lane 13 ports 10301 / 10311 / 10321 /
10331 free, so Playwright cold-booted a stack on the mutated source (B28).

RED: npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/flyer-leads.spec.ts
exit 1 (EXIT:1, `npm error code 1`); 2 passed, 2 failed
(log .superpowers/sdd/gates/s6-flyer-leads-mutation.log).
- an existing tenant signs up from the flyer: no text, the open inbox row
  turns unread live, the pin, and a Signed up row on Properties sent:
  flyer-leads.spec.ts:469 - Expected length: 0, Received length: 1 (the
  welcome body, "Welcome to HousingChoice! ...")
- an existing landlord on /join: the join pin and an unread inbox row, no
  text, and the contact unchanged: flyer-leads.spec.ts:553 - Expected
  length: 0, Received length: 1 (the same welcome body)
The layout and new-contact tests passed. Both failures are the first
assertion after the sign-up that can see a text; nothing failed earlier.

Restored: git restore -- app/src/routes/public.ts; `git status --short -- app/src/routes/public.ts`
printed nothing and the diff is empty; the stack was down (no live launcher,
the four lane ports free) before the next boot.

GREEN: the same command on the restored source, four consecutive runs, each
4 passed:
- s6-flyer-leads-green.log: 4 passed (14.9s); its EXIT line is missing. Most
  likely a later write from the same run overwrote it: when the shell had
  already exited, that run's launcher pid and two lane ports were still up,
  and they were gone a minute later. No `npm error` line, no failure line.
- s6-flyer-leads-green-2.log: 4 passed (14.0s), EXIT:0.
- s6-flyer-leads-green-3.log: 4 passed (14.0s), EXIT:0.
- s6-flyer-leads-green-4.log: 4 passed (14.0s), EXIT:0.
A pre-mutation sanity run (s6-flyer-leads-precheck.log) was also 4 passed,
EXIT:0. The live no-reload inbox assertion (worklist OR-24) held in all five
passing runs, so the reload fallback was not needed.
