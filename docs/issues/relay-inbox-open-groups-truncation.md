---
id: relay-inbox-open-groups-truncation
title: Inbox silently drops open relay groups beyond the listRelayGroups 2000-eval walk
type: debt
severity: low
status: open
area: app
created: 2026-07-04
refs: app/src/routes/inbox.ts, app/src/repos/conversationsRepo.ts
---

**Problem.** `GET /api/inbox` merges relay-group rows first-page-only via
`conversations.listRelayGroups('open')`, which walks at most
`RELAY_LIST_PAGE_LIMIT (100) × RELAY_LIST_MAX_PAGES (20) = 2000` GSI evaluations and
returns `truncated: true` past that. When truncated, `inbox.ts` only `log.warn`s —
the omitted open relay groups appear on **no** inbox page (relay rows are page-1-only
by design, so they never fall through to page 2+). The spec §7 says the `truncated`
flag is "surfaced rather than silently dropped," but surfacing today is a server log
line, not anything the operator sees. Requires 2000+ **open** relay groups
simultaneously, so effectively unreachable near-term — filed so it isn't forgotten if
relay-group volume grows.

**Suggested fix.** If relay volume approaches the cap: paginate relay rows into the
inbox cursor (a compound cursor) instead of page-1-only, or add an operator-visible
"more groups not shown" affordance when `truncated`. Surfaced by the adversarial
review of feat/relay-group-view (2026-07-04).
