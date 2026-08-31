---
id: e2e-image-viewer-scroll-flake
title: outbound-mms image-viewer scroll assertion fails intermittently under full-suite load
type: bug
severity: med
status: open
area: e2e
created: 2026-08-31
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:463
---

**Problem.** `outbound-mms.spec.ts:247` - "(a) attach + send an image: the fake
records media AND the timeline renders it" - fails intermittently on the scroll
assertion at line 463, which compares HARDCODED pixel offsets captured while the
image-viewer dialog is open.

Observed 2026-08-31 on a full `npm run e2e` (1 failed / 258 passed):

```
- Expected            + Received
  appFrame: { top: 20 }   appFrame: { top: 0 }
  timeline: { top: 509 }  timeline: { top: 421 }
```

The received scroll is LESS than expected on both axes, consistent with the
measurement racing the viewer's scroll lock rather than with a layout change.

**Attribution - this is NOT the tour-reminder-ladder branch.** The assertion was
introduced by `4ca47f50` ("test: verify image viewer on desktop and mobile"),
part of the `feat/mms-image-viewer` work that reached `main` shortly before.
Evidence it is main's, gathered on `feat/tour-reminder-ladder` @85e78de8:

- that branch's diff against `outbound-mms.spec.ts` is EMPTY, and it touches no
  viewer, modal, or scroll code;
- its only `Timeline.module.css` change is purely additive (one new
  `.scheduledBodyUnavailable` class used by scheduled cards);
- the assertion compares hardcoded offsets, so a content-height change from
  another branch would fail DETERMINISTICALLY - yet the same commit ran the full
  suite green twice;
- the spec passes 6/6 run in isolation.

**Do not treat this as a named flake to re-run past.** AGENTS.md's named-flake
re-run list is deliberately EMPTY. This is filed so the next person who sees it
has the attribution already done, not so it can be excused. Note also that
pass-alone / fail-in-suite is the signature of cross-spec process state, so
isolation passing is evidence about attribution, not proof of harmlessness.

**Suggested fix.** Stop asserting hardcoded pixel offsets. The intent is that
opening the viewer does not move the underlying page, which is a RELATIVE
property: capture scroll before opening and assert it is unchanged while open.
That removes the dependency on seed content height and on whatever the layout
happens to measure on a given run.

If the absolute values are kept, the assertion needs to wait on the viewer's
scroll lock having applied rather than measuring immediately after the dialog
appears.

Collecting a trace is the decisive artifact here. Note the trap named in
AGENTS.md: `retries: 0` with `trace: 'on-first-retry'` collects NOTHING, so a
gate failure currently carries no network or timing data. Do NOT reach for
`E2E_CHILD_LOG_DIR` - piping child stdout changes the very timings this symptom
depends on.
