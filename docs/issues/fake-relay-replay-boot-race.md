---
id: fake-relay-replay-boot-race
title: "Relay intro-replay: dev.mjs health-gates the app but not the fake; route swallows truncated + lacks per-group isolation"
type: improvement
severity: low
status: open
area: app
created: 2026-07-07
refs: scripts/dev.mjs:527, app/src/routes/dev.ts:394
---

**Problem (review finding, 2026-07-07 — dev-only path, self-healing).** The
`--mock --seeded` boot replay polls only the APP (`/__dev/ping`) before POSTing
`/__dev/relay/replay-intros`, but the intro legs are dispatched in-process in
the app and delivered to the FAKE on :8889 — which `concurrently` starts in
parallel and which is never health-checked. If the app becomes healthy a beat
before the fake binds, intro legs hit `ECONNREFUSED`, are caught per-member
("intro send failed for a member — continuing"), and are lost — the fake infers
a partial roster (legs are ~1/s apart, so member 1 can fail while member 2
succeeds) or no group at all, while dev.mjs still logs `replayed=1` (the
success signal measures ENQUEUE, not delivery). Narrow window in practice (the
app usually boots slower than the small fake) and self-heals on the group's
next live traffic.

Two smaller nits in the same route (`dev.ts:394-409`):
- `listRelayGroups('open')` destructures `{items}` and drops the `truncated`
  flag the repo contract says callers must surface (moot until >2000 open
  groups, but silent).
- The replay loop has no per-group try/catch — one group's inline-dispatch
  throw aborts the remaining groups AND 500s the POST.

**Suggested fix.** In dev.mjs, poll a fake health endpoint (e.g.
`GET /control/personas` returning 200) alongside `/__dev/ping` before POSTing.
In the route: per-group try/catch (count `failed` in the response alongside
`replayed`/`skipped`) and log/surface `truncated`.
