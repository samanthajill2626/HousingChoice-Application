---
id: signed-up-row-sent-words
title: A pair whose latest share entry is a flyer sign-up reads "Sent <sign-up date>" once a reply, tour or decline outranks Signed up, for a property the app may never have texted
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-22
refs: dashboard/src/routes/contact/Card.tsx:349-351, dashboard/src/routes/contact/Card.tsx:371, dashboard/src/routes/broadcasts/FollowUpView.tsx:68, dashboard/src/routes/broadcasts/FollowUpView.tsx:119, dashboard/src/routes/contact/TenantFile.tsx:339, dashboard/src/routes/contact/PartnerFile.tsx:197, dashboard/src/routes/listing/ListingDetail.tsx:1345, app/src/lib/listingSendOutcome.ts:83-88, app/src/lib/listingSendOutcome.ts:130, app/src/services/followUps.ts:183, app/src/services/shareLedger.ts:136-137, app/src/services/shareLedger.ts:271-274, app/src/lib/shareLedgerKeys.ts:37-47, app/src/repos/listingSendsRepo.ts:135, app/src/repos/listingSendsRepo.ts:259, app/src/services/followUps.ts:44, dashboard/src/api/types.ts:3157, dashboard/src/api/types.ts:3728
---

**Problem.** A flyer sign-up writes a `flyer` entry on the pair's
properties-sent ledger, counted at the sign-up instant (spec
`docs/superpowers/specs/2026-10-21-flyer-leads-design.md` D7). Whenever that
entry is the pair's LATEST counted one, the row's `sentAt` is the sign-up
instant (`summarize`, `app/src/services/shareLedger.ts:136-137`, on the one
rule `latestCountedShareKey`, `app/src/lib/shareLedgerKeys.ts:37-47`). Spec
D8 gives such a pair its own words only while its outcome is `signed_up`:
"Signed up from the flyer <date>" in place of "Sent <date>". The words are
keyed on the OUTCOME, not on the entry (`sentWords`,
`dashboard/src/routes/contact/Card.tsx:351`, rendered at `:371`), and the
outcome ladder ranks a decline, a tour and a reply ABOVE `signed_up`
(`deriveListingSendOutcome`, `app/src/lib/listingSendOutcome.ts:83-88`). So
once the person texts in (Replied), staff record a tour (Interested) or staff
click Not interested, the same row reads "Sent <sign-up date>":
- on the send roster row (`SendRosterRow` in `Card.tsx`), which renders both
  the contact page's Properties sent card
  (`dashboard/src/routes/contact/TenantFile.tsx:339`,
  `dashboard/src/routes/contact/PartnerFile.tsx:197`) and the property page's
  Sent to card (`dashboard/src/routes/listing/ListingDetail.tsx:1345`);
- on Matching's Follow up tab, which always says "Sent <date>"
  (`dashboard/src/routes/broadcasts/FollowUpView.tsx:68`, `:119`). A Replied
  pair is listed there once quiet (`isWaiting` keeps `replied`,
  `app/src/lib/listingSendOutcome.ts:130`, read at
  `app/src/services/followUps.ts:183`), so a flyer-only pair is chased as if
  the property had been sent. Interested and Not interested rows never wait,
  so Follow up shows this for Replied rows only.

Two shapes (planner review P2, `P2-adversarial.md` N1, in
`docs/superpowers/reviews/2026-10-21-flyer-leads/planner-review/`):
- Never sent: a tenant or unknown contact signs up on the flyer of a property
  staff never sent them, then texts in. The pair reads Replied and, after the
  quiet period, Follow up lists it as "Sent Oct 22 - Last heard from Oct 23"
  for a property the app never texted them; the Sent to card and the contact
  page read the same "Sent Oct 22".
- Wrong date: the property was blasted to them on Oct 1, they signed up on
  Oct 20, then replied (or staff marked Interested or Not interested). The row
  reads "Sent Oct 20" - the sign-up - not the Oct 1 send.

Decided (Cameron, 2026-10-22, at the planner's verdict): keep as built and
file it. The words are wrong on an uncommon path, and the follow-up staff
take is still the right one. Recorded as build worklist OR-26b (code review
R5 F4) and planner review N1.

**Suggested fix.** Put the latest counted entry's key on the wire and key the
words on it instead of on the outcome. The server holds the stored `shares`
wherever it projects a row and already has the one rule
(`latestCountedShareKey`), so the wire row (`ListingSendRow`,
`app/src/repos/listingSendsRepo.ts:135`, built by `toListingSendRow` at
`:259`; mirror `dashboard/src/api/types.ts:3157`) and the Follow up item
(`FollowUpItem`, `app/src/services/followUps.ts:44`; mirror
`dashboard/src/api/types.ts:3728`) could carry, for example, `sentVia:
'flyer'`. `Card.tsx:351` and `FollowUpView.tsx:119` then read "Signed up from
the flyer <date>" whenever it is set, whatever the outcome. The existing
`via` field cannot carry it: a row the flyer entry created reads
`via: 'broadcast'` (putShareMemory's first-write value,
`app/src/services/shareLedger.ts:271-274`), and an older row keeps whatever
its first share wrote. A server and dashboard change, so it takes the full
gates.
