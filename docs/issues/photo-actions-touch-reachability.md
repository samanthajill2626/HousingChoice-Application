---
id: photo-actions-touch-reachability
title: Photo thumbnail actions (Make cover / Remove) are unreachable on pure touch devices
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-15
refs: dashboard/src/routes/listing/ListingDetail.tsx
---

**Problem.** Found during unit-photos slice-3 QA (2026-07-15). The per-thumbnail
"Make cover" and "Remove" actions on the property Photos gallery reveal on
:hover / :focus-within (the spec-mandated desktop interaction). On a pure touch
device there is no hover, and the action overlay covers the thumbnail while
hidden, so the actions cannot be reached by tap alone. Keyboard users are fine
(focus reveals via :focus-within); desktop mouse users are fine. The dashboard
is a desktop-staff surface today, so this is a tracked gap, not a defect.

**Suggested fix.** When mobile/touch support for the property page becomes a
target: reveal actions on first tap of the thumbnail (tap-to-toggle), or render
the actions persistently at small viewports / on (hover: none) media queries.
Pair with the broader dashboard-mobile pass rather than one-off styling.
