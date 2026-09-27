# Plan review R2 - adjudications (planner)

Plan DRAFT 2 @87b2f676 -> DRAFT 3. Reviewer A continued
(`plan-r2-reviewer-a.md`), re-review charge, with B's report and the
round-1 adjudications in hand. Every runtime claim was probed on this
machine.

R2-1 [BLOCKING] Test (e2) hangs: the never-settling `getOrgSettings` is
first awaited by `sendMissedCallPush` inside `onFounderBridgeMissed`, which
`/status` awaits BEFORE any TwiML on the first delivery - ACCEPT (the
planner missed its own section-2 correction). (e2) now posts the miss
summary once normally (push + auto-text settle), THEN installs the hanging
read, THEN posts the SAME summary again: a redelivered summary skips
`onFounderBridgeMissed` (the transitioned gate) and reaches only the
greeting lookup, which `withTimeout` must bound (the reviewer measured the
redelivery answering in 4 ms). Decision changed: NO.

R2-2 [MEDIUM] Spec 4.3 wrongly says a dev-stack call cannot settle the
production refusal behavior; dev fronts with the same CloudFront -> origin
path - ACCEPT. Sentence corrected; a 3-4 MB renamed-M4A upload joins the
section 7 dev check and handback item 5 (it settles Review Focus 1 for the
deployed path).

R2-3 [LOW] A stale upload error renders inside the Remove dialog - ACCEPT.
The hook exposes `clearError()`; the block calls it when opening the dialog
and when a new file is chosen; a test pins that a prior reject message is
not shown in the dialog.

R2-4 [LOW] The route's block comment still describes destroy-after-flush -
ACCEPT, rewritten to match the drain.

R2-5 [LOW] Each supertest keep-alive refusal costs ~6 s (supertest's server
close waits out the draining keep-alive connection) - ACCEPT. The four
large-body cases use a raw `rawPut(app, ...)` helper on `app.listen(0)`
with its own keep-alive `http.Agent`, destroyed before `server.close()`, so
teardown is immediate; `keepAlive()` stays on the small-body supertest
requests (harmless).

R2-6 [LOW] The MIME aliases are untested - ACCEPT (`greetingContentTypeFor`
unit cases added to the block test file).

R2-7 [LOW] The chunked drain is capped by Node's default 300 s
`requestTimeout` - ACCEPT; spec 4.3 and handback item 4 say so (and warn
never to set `requestTimeout: 0`).

R2-8 [LOW] Stale file maps - ACCEPT (top map + Task 7 header updated).

R2-9 [LOW] Unused `no-control-regex` directive - ACCEPT (removed; the
builder re-adds it only if eslint reports the rule).

Rulings contested: drain-not-destroy DEFENDED by the reviewer (with the
300 s bound); Vite-proxy-as-local-only DEFENDED, its "dev cannot verify"
corollary CONCEDED by the planner (R2-2); VOICE_TERMINAL left alone
CONCEDED by the reviewer.

## Round 2 outcome

Accepted: R2-1 to R2-9. Rejected: none. Decisions changed: NONE - a test
ordering fix, wording, a faster harness helper, two more tests. TERMINAL
round; the plan is DRAFT 3 and goes to the mission block.
