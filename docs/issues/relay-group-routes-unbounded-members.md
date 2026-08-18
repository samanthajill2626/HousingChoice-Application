---
id: relay-group-routes-unbounded-members
title: The relay-group create and preview routes accept an unbounded members array
type: debt
severity: med
status: open
area: app/relay
created: 2026-08-17
updated: 2026-08-17
refs: app/src/routes/relayGroups.ts:270-296, app/src/routes/relayGroups.ts:301-321, app/src/services/rosterEdits.ts:495-531, app/src/lib/relayMembers.ts:63-79
---

**Problem.** `POST /api/relay-groups/preview` and `POST /api/relay-groups` both
validate every member and reject an empty array, but neither caps the array
LENGTH (`relayGroups.ts:270-284` and `:304-321`). `app.ts:94` mounts
`express.json()` with the default 100 kB body limit, so roughly 3,000
`{"phone":"+15550100001"}` entries fit in one request.

The preview then loops SERIALLY over the de-duped list
(`rosterEdits.ts:515-530`), awaiting per member: `resolveMemberName` (one
`contacts.getById`) and `isMemberSuppressed` (one `contacts.getById` /
`findByPhone` PLUS a `conversations.findByParticipantPhone` GSI query). That is
2-3 sequential repo reads per member - thousands of round trips inside one
request handler, with no audit row and no rate limit. The create route shares
the unbounded shape; it at least provisions a number and writes an audit row,
which makes it self-limiting and traceable in a way a read-only preview is not.
Authenticated staff only, same trust boundary as the create, which is why this
is debt rather than a security issue.

The codebase already has the precedent both routes are missing:
`MAX_SENDABLE_GROUP_MEMBERS` (`services/groupSend.ts:89`, enforced at `:303`,
answering `group_too_many_members`) and `MAX_RAIL_MEMBERS`
(`services/groupRail.ts:185`, enforced at `:318`).

**And the preview leaves no trace (added 2026-08-17, re-review R10).** The
preview handler (`relayGroups.ts:270-297`) calls no `mergeContext` and logs
nothing at all, while the create, close, reopen and close-nag routes on the same
router all log. So the one route that will do thousands of sequential repo reads
on a hostile body is the one route an amplification event would leave no record
of - no contactId in the correlation context, no served line, nothing to
reconstruct afterwards. One `mergeContext` plus a served line carrying the member
count belongs in the same change as the cap.

**`name` is uncapped too (added 2026-08-17, re-review R10).** `parseRelayMember`
(`app/src/lib/relayMembers.ts:63-79`) validates the phone and the contactId but
bounds neither the array nor the `name` string. On the PREVIEW that name is only
composed into a body nobody sends; on the CREATE the same client-supplied string
is composed into the outbound intro, so an unbounded name is unbounded outbound
SMS content (segments billed per member). Cap it alongside the array.

**Suggested fix.** Add one cap and apply it to BOTH routes in the same change,
so the preview and the create keep answering the same question - a preview that
accepts a roster the create would refuse is a new lie, and the reverse strands
the confirm dialog. Follow the existing constants' shape (an exported max plus a
typed refusal the dashboard can map). Consider a batched read in the preview
loop separately; the cap is the part that bounds the blast radius.
