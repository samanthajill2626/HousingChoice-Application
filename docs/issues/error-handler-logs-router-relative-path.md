---
id: error-handler-logs-router-relative-path
title: The app error handler's log message names only the router's leaf route (GET /list), not the mounted path
type: debt
severity: low
status: open
area: app/observability
created: 2026-10-06
refs: app/src/lib/errors.ts:155, app/src/lib/errors.ts:198, app/src/app.ts:300, app/test/expressErrorHandler.test.ts:46, app/test/toursApi.test.ts:5924
---

**Problem.** The Express error handler's three log messages
(`app/src/lib/errors.ts:179`, `:191`, `:198`) name the failed request with
`routeLabel(req)` (`errors.ts:155-159`), which returns
`${req.baseUrl}${req.route.path}`; its docblock says the mount-relative
`req.route.path` is prefixed with `req.baseUrl` (`:144`). In the running app
that prefix is always empty. The handler is mounted LAST, at the app level
(`app/src/app.ts:300`), and Express (5.2.1) restores `req.baseUrl` to the
parent's value as an error unwinds out of each router, so when the error
reaches the handler `baseUrl` is '' and the label is the router's LEAF
template. Observed on feat/tour-list (slice C, S7): a 500 from
`GET /api/tours/list` logs "unhandled error while handling request: GET /list"
- pinned, with a comment, by case 9 of the `GET /api/tours/list` route tests
(`app/test/toursApi.test.ts:5924`).

It is not specific to tours; it holds for every router mounted under a
prefix. By the same mechanism the phone-bearing contact route the docblock
cites would log `DELETE /:contactId/phones/:phone`, and leaf templates such as
`/`, `/list` or `/:tourId` repeat across routers, so the message - the field
operators grep and group by - cannot say which API failed. The structured
`path` field (masked) still carries the full path, so nothing is lost, only
misfiled. The unit test that pins the prefixed label
(`app/test/expressErrorHandler.test.ts:46-66`) passes because it hand-builds a
`req` with `baseUrl: '/api/contacts'`, a shape the app-level handler never
receives; and the docblock's parameterised-mount invariant (`:148-153`)
guards a leak that cannot happen today for the same reason. Pre-existing on
main; feat/tour-list did not change `errors.ts`.

**Suggested fix.** Capture the label while `baseUrl` still holds the mount:
for example a small error-handling middleware at the end of the API router
(and each other prefixed router) that records `req.baseUrl + req.route.path`
on the request or `res.locals` and calls `next(err)`, with `routeLabel`
preferring that record. Then re-check the parameterised-mount invariant once
the prefix is real again, and replace the hand-built `req` test with one that
throws from a route inside a mounted router (through the real app), so the
test sees what production sees.
