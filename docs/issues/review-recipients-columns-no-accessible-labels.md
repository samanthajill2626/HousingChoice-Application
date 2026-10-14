---
id: review-recipients-columns-no-accessible-labels
title: Review recipients column header is aria-hidden, so the status, authority and last-heard cells have no accessible column label
type: improvement
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-13
refs: dashboard/src/routes/broadcasts/RecipientPreview.tsx:508
---

**Problem.** At 768px and wider, Matching's Review recipients step shows four
columns (Name, Status, Housing authority, Last heard from) under a header row
rendered outside the `<ul aria-label="Candidate recipients">` and marked
`aria-hidden` (`RecipientPreview.tsx:508`). Each row is one `<li>`, so a
screen reader reads a row's cells as bare values ("Searching", "Atlanta
Housing Authority", "Yesterday") with no column name. The row checkbox's
accessible name carries the identity and the tags, which is what selection
keys on today, so the step is usable; the extra columns are just unlabeled.
Found by the planner's conformance review of `feat/last-heard-from`
(2026-10-13).

**Suggested fix.** Give each cell a visually hidden label prefix (the narrow
layout already shows "Last heard from" via CSS `::before`, which assistive
tech may or may not announce), or move to `role="table"` / `role="row"` /
`role="cell"` with `role="columnheader"` on the header - the latter changes
the e2e row selectors (every row is a `listitem` today).
