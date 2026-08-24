---
id: phone-key-discriminator-defined-in-three-places
title: The phone# delivery-key discriminator is now defined in three places
type: debt
severity: low
status: open
area: dashboard
created: 2026-08-24
refs: dashboard/src/lib/recipientLabel.ts:82, dashboard/src/routes/broadcasts/broadcastFormat.ts:116, app/src/services/groupReceipts.ts:285
---

**Problem.** A recipients-map key is either a bare contactId or `phone#<E164>`,
and the rule for telling them apart is written out three times, in three
different modules, across both workspaces:

- `app/src/services/groupReceipts.ts:285` - inside `recordSuppression`:
  `const phone = memberKey.startsWith('phone#') ? memberKey.slice('phone#'.length) : undefined;`
  (an unkeyed member skips suppression bookkeeping with a warn at `:287-291`).
- `dashboard/src/routes/broadcasts/broadcastFormat.ts:116` - `splitContactKey`,
  which returns `{ phone }` or `{ contactId }` so a broadcast results row can
  link or render link-less.
- `dashboard/src/lib/recipientLabel.ts:82` - `phoneFromRecipientKey`, added by
  `feat/per-recipient-delivery` (2026-08-24) for the per-recipient delivery rows.

Three copies of one wire-format rule is three places to drift. The hazard is not
hypothetical: `recipientLabel.ts:72-75` records that
`RosterMemberView.memberKey` (the tour/placement PeopleCard key space) uses
`phone:` with a COLON, so the hash is load-bearing and a `startsWith('phone')`
in any one copy would silently span two key spaces.

**Why it was not unified in that branch.** Unifying would edit
`broadcastFormat.ts`, which `feat/per-recipient-delivery` deliberately froze to a
ZERO-LINE diff so the broadcast delivery badges provably did not move (it is a
stated definition-of-done item for that branch). So the collapse is a separate,
reviewable change with its own broadcast regression evidence, not a drive-by.
Per orchestrator adjudication A4.

The new definition already carries a MIRROR comment naming the other two
(`recipientLabel.ts:76-80`), so a reader of any one copy can find the rest.

**Suggested fix.** Pick one home per workspace and delete the duplicates:

- Dashboard: have `broadcastFormat.splitContactKey` call
  `phoneFromRecipientKey` from `dashboard/src/lib/recipientLabel.ts` (or lift the
  split into a smaller shared leaf both import). Requires re-running the
  broadcasts suites and confirming the badge rows are unchanged, which is the
  evidence the freeze existed to protect.
- App: leave `groupReceipts.ts:285` as its own copy only if the two workspaces
  genuinely cannot share a module; otherwise move the split beside the key
  BUILDER (`relayMemberKey`, `app/src/repos/messagesRepo.ts:156`) so the writer
  and the reader of the format sit together.

Whichever way it lands, delete the mirror comment at `recipientLabel.ts:76-80`
in the same change so it cannot outlive the duplication it documents.
