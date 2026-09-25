# Spec review r4 - retry send window, DRAFT 4 (reviewer B, final round)

Reviewer: adversarial spec reviewer B, round 4 (the last the cap allows),
2026-09-25.

Spec under review: `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`
at `feat/retry-send-window` @`3b43a4a3` (DRAFT 4), diffed against `613752d1`.
Also read: `spec-review-r3-adjudications.md` and the corrected
`docs/issues/manual-retry-double-send-residual-windows.md`. I confirmed the
throttle issue is withdrawn: it existed only at `613752d1` and never reached
`main`. Concurrent heads: `feat/share-skip-fix` @`3a6a1a06` (v5, unchanged), and
`feat/send-outcome-reconcile` @`922675db` - revision 5, "design review closed at
the cap". The spec still cites revision 4 @`bf2c5bf2`.

Method. Every claim about code cites a `file:line` read this round. Read-only;
only read-only git commands were run.

## Verdict: STOP - precision only

No finding below changes what gets built, adds or removes a surface beyond those
D4 and D8 already require, or moves an invariant. R4-5 only names exceptions
section 1 already has elsewhere in the spec. Each finding is a sentence or a
list entry the planner can fold in before the spec goes to Cameron.

| # | sev | finding |
| --- | --- | --- |
| R4-1 | LOW | D4's bounded-acquire timeout has no stated way out of `sendOneRelayLeg` (today it would strand the rung), and reconcile revision 5 calls that acquire "best-effort" |
| R4-2 | LOW | D8's server-clock estimate is implementable, but its parenthetical leaves three traps: headers discarded, a body field stale on 304, and the ticker's arming predicate |
| R4-3 | LOW | "`relay` wins" plus `rosterKind` defaulting to `'relay'` on the contact page is a latent trap for every one-to-one promise |
| R4-4 | LOW | The residual lists omit D3a's fail-open without a stamp, the same unguarded wait as a lost stamp |
| R4-5 | LOW | Section 1 now states both bounds with no exception, but D5's fail-open and section 9's pending-reconcile copy are exceptions |
| R4-6 | LOW | D3 step 2 is implementable as written; two precision gaps: gate order, and read-failure severity |
| R4-7 | LOW | Section 7's copy list omits the one visible change the round accepted, the loss of "Not retried - ..." on late human-action declines |

---

# Part 1 - findings

## R4-1 [LOW] The bounded-acquire timeout has no stated way out, and reconcile calls the acquire best-effort

**Today, at that call site.** Today a `TokenBucketBusyError` from
`acquire(1, { timeoutMs })` would STRAND the rung, not close it:

- The acquire (`app/src/jobs/relayFanOut.ts:1360`) sits outside the unit's only
  try, which wraps the provider call alone (`:1385-1390`).
- The unit's contract lets every unclassified error throw out ("A send error
  that is neither a refusal, nor 30007, nor transient still THROWS out of here",
  `:1246-1248`).
- The retry job has no catch around the call (`relayRetryLeg.ts:575-598`), and
  its execution marker is already set (`:350-359`). The throw fails the job, the
  SQS redelivery no-ops as a duplicate, and the rung stays `queued`.
- The join then shows `Retrying` and later "not confirmed"
  (`relayRetryJoin.ts:370-403`) for a rung that will never send - the false
  promise this branch exists to remove.

D4's "a timeout sends nothing, and the job closes the rung" is the right
decision, but it needs its path named:

- A distinct unit outcome, or a job-side catch of `TokenBucketBusyError`.
- Closed through `refuseGate`: nothing was attempted, since the `attempted`
  aggregation write (`:1380-1382`) comes after the acquire.
- Never mapped to `transient`. That branch calls `claimFanoutPass`
  (`relayRetryLeg.ts:622-626`) and assumes a provider refusal. It would still
  converge through the re-check at `:643-646`, one pass later and misattributed.

**Coupling.** Reconcile revision 5's phase table says "The token acquire ... [is]
best-effort and stay[s] so" (reconcile spec line 231), and PREPARE failures
defer as `retryable` (line 229). That wording predates a bounded acquire: today
the acquire cannot fail. Merged naively, either reading re-opens a send past the
window, which section 1 now forbids without exception. Add a section 5
requirement: for the retry rung, a deadline timeout is terminal - nothing is
sent and the rung closes `retry_window_closed` - whatever phase model
`sendOneRelayLeg` adopts. Also update the citation to revision 5. Test intention
3 catches a regression only if it is re-run after the merge.

## R4-2 [LOW] The server-clock estimate is implementable; three traps the parenthetical leaves open

1. **The client discards headers.** `requestWithStatus` returns only `{ status,
   body }` (`dashboard/src/api/client.ts:92-126`). Its `fetch` is same-origin
   (`credentials: 'same-origin'`, `:106-112`), so `Date` is readable, but the
   `Date` route needs a client change. Section 4 lists no such surface.
2. **A body field is stale on 304.** Nothing in `app/src` changes Express's
   default weak ETag. API JSON carries no `Cache-Control` (the only writes are
   `app.ts:197`, `api.ts:2307`, `:2403`, `:2523`, `appIdentity.ts` and
   `unitMediaServe.ts`). So a revalidated timeline response returns the CACHED
   body, and a `serverNow` field inside it is as old as the original 200. Only
   the headers are refreshed from the 304. The field option needs
   `Cache-Control: no-store` on the timeline route; the `Date` option does not.
3. **The ticker must read the same clock.** Its run condition has to read the
   same server-clock estimate as the bubble - the file's own rule: "a PREDICATE
   over the presenter's own two functions, never a shape test"
   (`Timeline.tsx:768-775`). On a fast browser clock, an arming predicate on the
   browser clock disarms while the bubble, on the server clock, is still live.
   The bubble clock then freezes, and the promise never expires on screen.

With those in place, "measured on the server's clock" is honest. The error is the
`Date` header's one-second resolution plus one tick, and a hidden tab renders
nothing and is bumped on focus (`Timeline.tsx:2105-2127`). UNVERIFIED: whether
CloudFront ever caches an `/api` response, which would age `Date` too.

## R4-3 [LOW] "relay wins" plus a relay default rosterKind is a trap for every one-to-one promise

`relay` now beats `retryScheduled`. On the one-to-one contact page, `rosterKind`
defaults to `'relay'` (`Timeline.tsx:1790`, `:906`); `ContactCommsPane` passes
none (`ContactCommsPane.tsx:319-349`). Any path that derives `relay` from
`rosterKind` for a one-to-one bubble therefore silently removes every promise.
Today the message chip deliberately omits `relay` ("DELIBERATELY no `relay` flag
here ...", `Timeline.tsx:973-980`), and that is the very comment D12 rewrites.
The spec should:

- state that the one-to-one chip never passes `relay`;
- keep that rationale in the rewritten comment;
- render test intention 7's promise case with the DEFAULT `rosterKind`, as the
  existing guard test does (`Timeline.delivery.test.tsx:575-593`).

## R4-4 [LOW] The residual lists omit D3a's fail-open without a stamp

D3a now schedules WITHOUT stamping when a conversation or contact read fails (the
R3-6 choice). For that whole 60-240 s wait there is no promise, no hidden button
and no 409, while the automatic retry is still coming: the same unguarded window
as a lost stamp, from a different cause. Section 9 and
`manual-retry-double-send-residual-windows` (its gap 2) should name it. The
choice itself is defensible; it is only unlisted.

## R4-5 [LOW] Section 1 states both bounds with no exception

- The send bound. Section 1 removed "the one allowance". But D5 still skips the
  window check for a missing or unparseable origin and for rungs claimed before
  the deploy, and with no origin D4's acquire deadline does not exist, so the
  acquire stays unbounded there.
- The promise bound. It has section 9's accepted pending-reconcile exception.

Name both in section 1, so that a test written from section 1 is writable. This
names existing exceptions; it moves nothing.

## R4-6 [LOW] D3 step 2 is implementable as written; two precision gaps

**Verified implementable with what the claim already has.** `twilio.ts` imports
`relayMemberKey` (`:75`), `isMemberSuppressed` (`:84`, already used at `:929`),
`normalizeToE164` (`:113`) and `relayRetryDigest` (`:142`), and holds the
`contacts` and `conversations` repos (`:530`). The claim computes `toE164`
(`:2720-2723`), `rootTsMsgId` (`:2760-2763`) and `destDigest` (`:2768`). The
job's number check is the same digest comparison
(`relayRetryLeg.ts:538-539`).

**Gaps.**

- (a) The preview must run the gates in the job's order - group, roster, number,
  opt-out (`relayRetryLeg.ts:491-555`) - for "that gate's code" to be
  deterministic when two apply.
- (b) A read failure on this path is `claim_failed`: ERROR, a 5xx and a Twilio
  redelivery (`twilio.ts:3000-3007`, `:3176-3198`). It is not the WARN that D9's
  "a failed read (D3a, D5)" suggests. Say so.

## R4-7 [LOW] Section 7's copy list omits the round's one visible change

A late 30003 used to claim a rung that the job then refused - after a group
closed, a member was removed, a number changed or the member opted out. The leg
read "Not retried - group closed", "... no longer in this group", "... number
changed since" or "... opted out" (`deliveryStatus.ts:931-934`). Under D3 step 2
it reads plain "Phone unreachable (error 30003)", because no rung exists to
carry the code. The adjudication accepted this as consistent with the ruling,
which is defensible. It is still a change to what staff read, so it belongs in
section 7's copy list for Cameron.

---

# Part 2 - contesting the adjudications

Nothing left to contest in substance. All eleven round-3 findings were accepted
with my remedy or a stronger one. R2-8's full remedy was taken (D3 step 2). The
throttle allowance is closed rather than filed. The skew bound was replaced by
the server-clock anchor. The R3-6 choice (fail open without a stamp) is
defensible; only its residual is unlisted (R4-4).

# Part 3 - the coordinator's questions, answered cold

- **(a) Can the claim compute the number-changed digest and the suppression the
  way the job does?** Yes. Every helper and repo is already imported and in
  scope, and the digest comparison is identical (R4-6).
- **(b) What does `TokenBucketBusyError` do today at that call site, and does
  closing on it collide with the transient ladder?** Today it escapes uncaught
  and strands the rung. There is no collision with the transient ladder if the
  timeout closes directly through `refuseGate`. The collision risk is with
  reconcile's "best-effort" acquire (R4-1).
- **(c) Is the server-clock estimate implementable, and is "measured on the
  server's clock" honest?** Yes, with a client change for headers, `no-store` if
  a body field is chosen, and one shared predicate for bubble and ticker. It is
  honest to one tick plus one second (R4-2).
- **(d) `relay` over `retryScheduled`.** Correct for relay legs. The trap is on
  the one-to-one page's default `rosterKind` (R4-3).
- **(e) The no-tail fallback.** Sound. "Not retried - message too old" joins its
  family (`deliveryStatus.ts:931-934`) without a tail. The join's
  no-display-code rule (`relayRetryJoin.ts:410-413`) keeps it off every current
  surface, and test intention 7 pins its presence.
- **(f) The `gate_refused` WARN-set change, and anything else producing
  `gate_refused` at the claim?** Contained. `isTerminalRelayLegFailure` is
  module-private with one call site (`twilio.ts:3089`). The claim returns no
  `gate_refused` today. The job's own `gate_refused` lines are logged directly
  (`relayRetryLeg.ts:502`, and the send-time ERROR at `:692`) and do not pass
  through the function, so Cameron's "send-time refusal stays ERROR" is
  untouched.
- **The corrected issue file.** Gap 1 is now server-side, and the suggested fix
  names reconcile's send-attempt record. It still misses the fail-open window
  (R4-4).
- **Reconcile revision 5.** Section 5's requirements are mechanism-agnostic and
  still hold, except the acquire classification (R4-1).
