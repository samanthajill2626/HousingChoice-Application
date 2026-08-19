---
id: relay-duplicate-via-reopen
title: Reopening a closed group beside a live one with the same members does not warn
type: improvement
severity: low
status: open
area: app
created: 2026-08-18
refs: app/src/routes/relayGroups.ts:541, dashboard/src/routes/conversation/ConversationDetail.tsx:680
---

**Problem.** Reopening a closed `{A, B}` while a live `{A, B}` already exists
produces two live threads for one set of people - the exact state the duplicate
warning exists to flag - and nothing warns, because detection runs in the OPEN
preview only (spec D7) and reopen is not that path.

The reason this was deferred rather than built is narrower than it first looks,
and the record is worth keeping straight because an earlier draft got it wrong.
The deferral was originally justified by saying reopen has "no preview and no
dialog". The dialog half is FALSE: there is a "Reopen group?" confirm modal at
`dashboard/src/routes/conversation/ConversationDetail.tsx:680-710`, with body
copy about keeping the same number, and it would render a warning block fine.

What reopen actually lacks is a PREVIEW ENDPOINT. Nothing on that path builds a
`RosterPreview` or calls the detector, so wiring the warning means giving the
reopen route a server-side preview call it has never had, and then rendering
into the modal that already exists.

That makes this a better follow-up candidate than the original framing implied -
the missing piece is one endpoint, not a whole surface.

**Suggested fix.** Add a preview call to the reopen route that runs
`findOpenGroupWithSamePhones` over the closed group's own participants, return
`duplicateOf` on the reopen preview payload, and render the existing warning
block in the "Reopen group?" modal. Nothing refuses here either - reopen stays
allowed, exactly as the open path does.

One trap to avoid, recorded from the design review: an idempotent reopen RETRY
must not match ITSELF. A group that is already open is in the scanned partition,
so a naive check would warn the operator about the very group they are
reopening. Exclude the subject conversation by id.
