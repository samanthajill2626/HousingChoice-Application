---
id: roster-quiet-hours-e2e-timezone-skew
title: roster-quiet-hours e2e window sits on a knife edge - observed dueAt implies a non-NY zone
type: bug
severity: low
status: resolved
area: e2e
created: 2026-08-05
resolved: 2026-08-21
refs: e2e/tests/roster-quiet-hours.spec.ts:83,app/src/lib/quietHours.ts:39,app/src/repos/settingsRepo.ts:85
---

**Problem.** The spec freezes a quiet window with `windowAroundNow()` - HH:MM
strings formatted in `America/New_York` (`ORG_TZ`, matching the settingsRepo
default) around a +/-2h band, wide enough that the whole test runs inside it.
During the 2026-08-05 S6 gate runs, the server-computed `dueAt` for those
deferrals landed ~2h later than the NY reading of the stored window end
(e.g. window end `17:0x` NY -> expected `21:0xZ`, observed `23:0xZ`; a later
session-lane repro with a `23:58` end produced the NY-consistent `03:58Z`).
Both deferrals still fired (the runs failed for an unrelated, since-fixed GET
bug), but if the effective evaluation zone can skew ~2h against the helper's
zone, `now` sits near the window's effective END edge - and a slow run or a
larger skew could flip `isQuietTime` mid-test, turning a deferral flow into an
immediate send and failing the spec for a reason that has nothing to do with
the feature.

Unverified: where the skew comes from. `resolveQuietHoursTimezone` just
returns `settings.timezone`, whose default is `America/New_York`; nothing in
this spec writes `timezone`. Candidates: another spec's settings write racing
in the full-suite run (does not explain the solo-run instants), a stale
settings row in the lane, or an HH:MM->instant conversion detail in
`clampOutOfQuietHours` for windows read on the wrong side of midnight in some
zone.

**Suggested fix.** Make the spec zone-proof rather than chase the skew: have
`putQuietHours` pin `timezone` explicitly in the same PUT (if the settings API
accepts it), or assert the effective zone by reading back the settings and
computing the window in THAT zone; widen the band if needed. Add a one-line
log of the stored window + the first `dueAt` so a future skew is visible in
the run log.

**Resolution (2026-08-21, `fix/test-suite-hardening`).** `windowAroundNow()` now
sends `timezone: ORG_TZ` in the same settings PUT as the HH:MM window.

Took the first of the suggested options - pin the zone rather than chase the
skew. The spec formatted its window in `ORG_TZ` while the SERVER evaluated those
strings in `settings.timezone`, and nothing here ever wrote that field, so the
two only agreed BY DEFAULT. Writing it removes the assumption entirely, which is
worth more than identifying the original ~2h skew (never established; the
candidates were a stale lane settings row or another spec's write racing in, and
neither is reachable now that the value is pinned per run).

Deliberately did NOT add the suggested `dueAt` debug log: with the zone pinned
there is no skew left for it to surface, and an unconditional log line in a spec
is noise the next reader has to explain away.

Verified: 2 passed. As with any intermittent, a green run is not proof - but the
mechanism the evidence implicated (window written in one zone, evaluated in
another) is now impossible rather than unlikely.
