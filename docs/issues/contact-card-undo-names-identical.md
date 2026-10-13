---
id: contact-card-undo-names-identical
title: Undo buttons on a contact's Properties sent rows share one accessible name
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-13
refs: dashboard/src/routes/contact/Card.tsx
---

**Problem.** On a contact page every Properties sent row belongs to the same
contact, so each row's Undo button is named "Undo not interested for <contact
name>" (the copy table's exact string, pinned by e2e) - a screen-reader user
cannot tell which property's decline it undoes. The Interested / Not interested
buttons carry the property's address and are distinct (code review round 2,
A R2-4).

**Suggested fix.** Add the property's address to the Undo name on the contact
cards (e.g. "Undo not interested for <name> at <address>") and update the e2e
specs that select it.
