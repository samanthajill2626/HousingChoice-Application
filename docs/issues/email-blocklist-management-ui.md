---
id: email-blocklist-management-ui
title: Surface the email sender blocklist in the dashboard (view + undo)
type: improvement
severity: med
status: open
area: dashboard
created: 2026-07-21
refs: app/src/routes/unmatchedEmail.ts, app/src/repos/unmatchedEmailRepo.ts
---

**Problem.** The `/spam` triage action blocklists a sender (`putBlock` on the
parsed, attacker-controlled, spoofable From), after which that address's inbound
mail arrives `status:'dismissed'` and is invisible to every feed (B2 tier 3). The
fix wave added a repair route -- `DELETE /api/unmatched-email/block/:address`
(adv M4) -- so a mis-click (or a spoofed-From block of a real sender) is now
reversible, but there is still NO dashboard surface: staff cannot SEE which
addresses are blocked, and there is no in-UI undo. A spoofed legitimate address
that gets blocked stays silently dropped until someone calls the new route by
hand. There is also no list endpoint (blocklist pointer rows are `block#<address>`
items with no `status`, so they never index in the `byStatus` GSI).

**Suggested fix.** (1) A read surface: either a dedicated `listBlocks()` on the
repo (a query/scan of the `block#` prefix, or a small GSI) + a `GET` route, or a
lightweight admin panel. (2) A dashboard "Blocked senders" view with an Unblock
button that calls the DELETE route. (3) Consider blocking on a VERIFIED identity
(DKIM-aligned domain) rather than the raw spoofable From, so a spoof cannot get a
real sender permanently dropped in the first place. Until (1)-(3) land, the DELETE
route is the manual escape hatch.
