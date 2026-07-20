---
id: tourdetail-composer-footer-suite-flake
title: TourDetail composer-footer roster test flakes in-suite (pass-alone, pass-on-rerun)
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-20
refs: dashboard/src/routes/tours/TourDetail.test.tsx
---

**Problem.** One intermittent full-suite failure observed during the
address-extraction planner review, on a tree whose dashboard/src/routes/tours/
files were byte-identical to main (so main-side, not branch-induced):

    FAIL src/routes/tours/TourDetail.test.tsx
      > TourDetail - three-channel switcher
      > composer footer: the group tab names the WHOLE roster; 1:1 tabs show the reply number
    Expected element to have text content:
      Reply sends to everyone in this group text (Ann, Marcus)
    Received:
      Reply sends to everyone in this group text

The roster names arrive asynchronously and the footer occasionally renders
before they do under full-suite load.

**Evidence (2026-07-20, worktree w:/tmp/extraction-address @2f7df05):**
- Full `npm test` run 1 (on 2946ae9): PASS. Run 2 (on 2f7df05, app-only
  delta): FAIL as above. Dashboard workspace re-run: FAIL again. Solo run of
  the file: 51/51 PASS. Third full dashboard workspace run: 127/127 PASS.
- Same pass-alone/fail-in-suite signature as
  [[conversationdetail-members-mock-suite-flake]] (also a members/roster
  fetch racing a render assertion under suite load).

**Suggested fix.** Make the assertion await the roster-loaded state (findBy /
waitFor on the parenthesized names) instead of asserting text content on the
already-rendered footer, or pin the members mock to resolve before render like
the spec's other tabs do.
