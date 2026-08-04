---
id: quiet-hours-dst-gap-window-end-clamp
title: clampOutOfQuietHours lands inside the window when the window END falls in the DST spring-forward gap
type: bug
severity: low
status: open
area: app
created: 2026-08-03
refs: app/src/lib/quietHours.ts
---

**Problem.** `clampOutOfQuietHours` clamps an in-window instant to the end of
the window via `utcMsForLocal`'s two-pass offset correction. When the
configured window END is a wall-clock time that does not exist on the DST
spring-forward night (e.g. `quietHoursEnd: "02:30"` on the night 02:00 jumps
to 03:00), the two-pass correction cannot converge on a nonexistent local
time and the returned instant can still be inside the quiet window. An
adversarial-review sweep found 782 violating (window, instant) pairs across a
two-year scan - every one of them a window ending at `02:30` on a
spring-forward night. The default window (`21:00-08:00`) is clean across the
whole sweep.

Impact is DISPLAY-ONLY by design: the spec
(`docs/superpowers/specs/2026-08-03-quiet-hours-design.md` section 6) names
the pre-claim fire-time backstop as "the guarantee that a DST edge-case
miscomputation in clamping can never actually send inside the window", and
the module header documents the same tradeoff. So a mis-clamped row shows a
wrong dueAt in the dashboard for one night a year under an exotic
admin-configured window, then defers at fire time and sends after real
quiet-end. No message can send inside the window.

**Suggested fix.** After computing the clamp target, if the result still
satisfies `isQuietTime`, advance the local target day/time across the DST gap
(e.g. re-materialize at the window end plus one hour, or walk forward in
30-minute steps until outside) - bounded loop, pure-function change, covered
by a spring-forward test with `end: "02:30"`. Alternatively reject window
ends between 02:00 and 03:00 at validation time, which trades a tiny config
surface for deleting the edge entirely.
