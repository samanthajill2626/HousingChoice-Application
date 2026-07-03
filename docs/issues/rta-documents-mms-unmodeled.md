---
id: rta-documents-mms-unmodeled
title: The RTA-documents MMS inbound (diagram arrow) has no code path and no test
type: debt
severity: med
status: open
area: app
created: 2026-07-03
refs: documentation/post-tour-application-sequence.mermaid, e2e/tests/scenarios/post-tour-application.spec.ts, e2e/tests/scenarios/tours.spec.ts
---

**Problem.** The Post-Tour & Application sequence diagram models the RTA collection as a
real inbound: `T->>A: RTA documents (photos or files, MMS)` → Team reviews → stage moves
`Collect RTA → Review RTA`. Nothing in the app or the e2e suite models that inbound — the
scenario spec collapses the arrow into bare `teamMovesPlacementTo('Collect RTA')` /
`teamMovesPlacementTo('Review RTA')` stage moves with no documents anywhere. The diagram
is the source of truth, so this is documented drift: the stage walk is proven, the
document flow is not.

**Build path exists.** Inbound MMS works end-to-end today: the fake-twilio serves canned
raster images and the tours suite's self-guided ID gate proves tenant-photo-in →
Team-reviews → gated action. The RTA-documents flow is the same shape (tenant sends
photos/files to the 1:1; Team eyeballs them; media already lands on the contact's media
surface). What's missing is only the sequence-level modeling: an e2e verb
(`tenantSendsRtaDocuments` or similar, mirroring the ID-gate verb) + assertions that the
documents are visible to Team before the Review-RTA move — and any product affordance the
founder wants for attaching RTA docs to the PLACEMENT rather than just the contact thread
(related: `inbound-media-attach-to-unit` raises the same attach-to-entity question for
units).

**Suggested fix.** When Approval & Move-in (or an RTA-focused wave) is built: add the
MMS-inbound verb to the collect→review segment of `post-tour-application.spec.ts`,
asserting the rendered media in the conversation thread, and decide whether RTA documents
need a placement-level attachment surface or the contact thread suffices for Phase 1.
