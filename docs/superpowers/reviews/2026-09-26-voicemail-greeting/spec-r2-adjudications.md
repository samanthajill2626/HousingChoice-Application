# Spec review R2 - adjudications (planner)

Spec: DRAFT 2 @e91e3ffc -> DRAFT 3 (this round's edits)
Reviewer: B continued (`spec-r2-reviewer-b.md`), re-review charge, with A's
round-1 report and the round-1 adjudications in hand.

R2-1 [HIGH] DRAFT 2's refusal wiring (`pipeline(req, gate)` + `Connection:
close`) destroys the socket before the 400/413 reaches the client - ACCEPT.
The reviewer ran both postures on Node 24.14.1: the DRAFT 2 wiring gave
ECONNRESET/ECANCELED on every body over the in-flight window; the round-1
posture (`req.pipe(gate)` + `req.resume()`) delivered every 400/413. This
was MY round-1 edit (A11/B13) and it was wrong; the planner takes the
defect. DRAFT 3 4.3: `req.pipe(gate)` with explicit error wiring, the gate
never destroys `req`; on a refusal the route unpipes, `req.resume()`s
(bounded: step 3 already refused any declared length over 5 MiB, so a
known-length refused body drains at most 5 MiB), and answers normally. The
ONE unbounded case, a chunked body over the cap (a shape browsers never
send for a Blob), answers 413 and destroys the request after the response
flushes. `Connection: close` is gone everywhere. Route tests use bodies of
3 MiB and more so a small body cannot hide the defect; the
`mms-upload-endpoint-hardening` issue is referenced. Decision changed: NO
(wiring inside decision 2).

R2-2 [MEDIUM] `req.destroyed / req.aborted` is true after every gate
refusal under that wiring - ACCEPT. Classification is by the ERROR alone:
`GreetingRejectedError` first; a client abort is an error the route itself
captured from `req`'s 'error' / 'aborted' events and wrapped
(`GreetingClientAbortedError`) before destroying the gate; the request's
state flags are never consulted. Route test: a sniff refusal is answered
400 and is NOT logged as `client_aborted`. Decision changed: NO.

R2-3 [MEDIUM] The 4.6 "settled flag" contradicts the helper signature and
the late side effects are the LOGS - ACCEPT. DRAFT 3: the lookup closure
returns a RESULT (`play`+url / `absent` / `no_store` / `missing`) and never
touches `reply` or the logger; the CALLER, only when the race resolves in
time, emits `<Play>` and writes the one INFO or WARN. A late resolution has
nothing to append and nothing to log. `withTimeout(promise, ms, label)` is
a plain race (no flag). Test (e) asserts on the log capture: exactly one
WARN (the timeout) and no `offered` line after the abandoned HEAD resolves.
Decision changed: NO.

R2-4 [LOW] The abandoned HEAD keeps a pooled socket - ACCEPT. Additive
`MediaStore.head(key, opts?: { signal?: AbortSignal })`; the S3 store
passes `{ abortSignal }` to `client.send`; the webhook hands it
`AbortSignal.timeout(budget)`. The DynamoDB read rides the shared document
client and is left alone. The harness fake's `hangMediaHeads` seam rejects
on the signal's abort, modeling the real client. Decision changed: NO.

R2-5 [LOW] `rawBody` must not add a second `fetch` to `requestWithStatus`
- ACCEPT. Exactly one `fetch(buildUrl(path, query), {...})`; the body
expression is `payload ?? rawBody`. Added to the 4.9 gate-2 table.

R2-6 [LOW] Pin that the gate never forwards more than `maxBytes` - ACCEPT.
The gate compares the running count BEFORE pushing the chunk that crosses
the cap (spec 4.1 now says so); the gate test asserts downstream received
at most `maxBytes`; the route test asserts zero recorded puts after a
refused upload.

R2-7 [LOW] `preload="none"` never fires `onError` at load - ACCEPT. The
player uses `preload="metadata"` (one bounded ranged request per Voice-tab
view when a greeting is set), so a missing object surfaces at load.

R2-8 [LOW] Section 2 wrongly said `/status` reads no settings today -
ACCEPT (prose corrected: `sendMissedCallPush` reads them on the first
delivery). The greeting helper stays self-contained (one extra GetItem on
the miss path, defended and budgeted); threading the already-read settings
through `onFounderBridgeMissed` is noted as optional, not required.

R2-9 [LOW] Contest of assumption G (a literal streamed-PutObject mechanism
exists) - PARTIALLY ACCEPT. The reviewer is right that option (b) was not
ruled on and that lib-storage's part buffer is app-process heap. G is
rewritten: decision 2's "never buffer the whole file" CAN be delivered
literally through the app (a streamed `PutObjectCommand` with an explicit
`ContentLength` behind an additive adapter method); it is DECLINED for
this build because it needs a new adapter path whose behavior against the
local MinIO's default streamed-checksum handling is UNVERIFIED, for a gain
of at most 5 MiB of transient heap on an admin-only, 10/min route. The
handback says so in those words. Mechanism unchanged.

Concessions received: A2 (presigned POST), E, F, H.

## Round 2 outcome

Accepted: R2-1 to R2-8; R2-9 partially (wording). Rejected: none outright.
Decisions changed: NONE - every accepted item corrects a mechanism inside
a given decision (refusal wiring, result-returning lookup, abort signal,
player preload). Per the stop rule this is the TERMINAL round: the edits
are folded into DRAFT 3 and no round 3 is run. The DRAFT 3 refusal wiring
is the exact posture the reviewer's Node 24 probe already exercised
(right-hand column of its table).
