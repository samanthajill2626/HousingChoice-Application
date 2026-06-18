---
id: remove-dead-relay-roster-alias
title: Delete the dead toRelayRosterEvent alias (zero callers)
type: debt
severity: low
status: open
area: app/events
created: 2026-06-18
refs: app/src/lib/events.ts:108
---

**Problem.** `toRelayRosterEvent` is a `@deprecated` thin alias for
`toConversationUpdatedEvent`, kept "so existing relay emit sites keep compiling." A
repo-wide check (2026-06-18) finds **zero call sites** — the only occurrence is its own
definition. It's dead code.

**Suggested fix.** Delete the exported function + its `@deprecated` JSDoc
(`app/src/lib/events.ts:108-114`). One-step removal — no call-site migration needed since
there are none. (Trivial enough to just do; tracked here per the request to graduate it.)

Graduated 2026-06-18 from a `@deprecated` JSDoc tag (non-TODO flag sweep).
