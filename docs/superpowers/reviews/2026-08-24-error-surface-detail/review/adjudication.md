# Adjudication - error-surface-detail review round 1 (orchestrator, 2026-08-25)

Inputs: spec-conformance-report.md (1 SHOULD-FIX, 6 CONSIDER, 2 discrepancy notes) and
adversarial-report.md (0 MUST-FIX, 4 SHOULD-FIX, 7 CONSIDER, 4 NIT). Verdicts below;
FIX-WAVE items are numbered FW1-FW10.

## Accepted -> fix wave

- FW1 (adv S2 + spec F3, CONFIRMED with measured numbers): enforceBound does not
  guarantee the 64KB bound it names (200x2000-char fields -> 104,291 bytes with
  flag=true). The bound is a stated spec contract ("RESPONSE SIZE BOUND: 64 KB").
  FIX: make it converge - after the longest-first 512 pass, if still over, keep
  shrinking (halve the per-field cap and re-pass, and as a last resort drop the
  longest remaining fields) until Buffer.byteLength(JSON.stringify(fields)) <=
  RESPONSE_BOUND_BYTES. Flag semantics unchanged (true whenever anything was trimmed
  or dropped). Extend the adapter test: a many-field case (e.g. 200 x 2000 chars)
  asserting the FINAL serialized byteLength <= RESPONSE_BOUND_BYTES and
  responseTruncated true. Also add two comment lines (adv C6): the function trims in
  place on purpose (single caller), and rawText rides OUTSIDE this budget by design
  (its own RAW_TEXT_CAP), so the true response ceiling is bound + 4000.
- FW2 (adv S3 part 2): bare `err` is admitted unconditionally. The scalar-err clause
  exists for six call sites logging STRING errs; a JSON-OBJECT string under bare `err`
  (possible if flattening ever fails/limits) would carry the whole vendor nest past the
  allowlist. FIX in getLogRecord/isAllowedKey: keep bare `err` ONLY when its value does
  not parse to a JSON object (JSON.parse try -> typeof object && !null -> drop).
  Test: bare err = '{"config":{"headers":{"Authorization":"Basic x"}}}' is DROPPED
  (and JSON.stringify(out) does not contain Authorization); bare err = 'Insights query
  failed' still KEPT. Docblock: state the allowlist's scope honestly - it closes the
  err.* subtree plus object-valued bare err; NON-err fields pass through BY DESIGN
  (app-authored, the point of the detail view; write-time redaction plus call-site
  discipline own that tier - adv swept all log.error/warn/fatal sites: zero live
  object-valued non-err error keys today).
- FW3 (adv S1, code change REJECTED - see below - but the documentation half ACCEPTED):
  strengthen the queryTrace boundary comment to cite WHERE the inclusivity was
  measured: the design spike, 2026-08-24, real AWS account - a query with
  startTime == endTime == floor(eventMs/1000) returned that second's mid-second
  events (recorded in docs/superpowers/plans/2026-08-24-error-surface-detail.md
  "Verified facts you do not need to re-derive" and spec section 3). Add one line
  noting queryInsights' ceil'd live endTime is also correct under inclusivity (it
  merely includes the current partial second); the two paths do not disagree.
- FW4 (adv C1): React row key `ev.ref` can collide: one log event matched by BOTH the
  pino query and a V8-OOM query survives dedup twice (same ref, different message
  after the OOM relabel) -> duplicate keys -> expander/detail state misbinding. Also
  ptr defaults to '' when @ptr were ever absent. FIX in RecentErrors.tsx: key =
  `${ev.ref}|${ev.timestamp}|${ev.message}` with a comment (ref stays the leading
  identity - stable and unique per event; timestamp+message only disambiguate the
  known relabel double-match and the degenerate empty-ptr case). Test: two events
  sharing ref/timestamp with different messages render two rows with independent
  expanders. The SERVICE dedup key stays as adjudicated by the spec (ref leads, old
  components retained).
- FW5 (adv C2): useErrorDetail/useErrorTrace never abort on unmount, and the hook
  file's docs overclaim. FIX: add a mount-scoped cleanup effect in BOTH hooks
  (useEffect(() => () => { abortRef.current?.abort(); }, [])), matching the three
  sibling hooks; correct the header claim at :13-16 (now true) and REWRITE :248-250
  (each ROW owns its own hook instance, so a new load supersedes the PREVIOUS LOAD OF
  THAT INSTANCE - not "a second row supersedes the first"). Tests: ErrorTrace - capture
  the AbortSignal passed to the mocked getSystemTrace, unmount before resolve, assert
  signal.aborted === true. useErrorDetail - same via renderHook (or an equivalent
  component-level unmount).
- FW6 (spec F1): the spec-named `(unrouted)`-on-URIError test does not exist. FIX: add
  to app/test/expressErrorHandler.test.ts - handler(new URIError('bad'), unrouted req,
  fakeRes(false)) -> lines[0].msg starts with the malformed-URI string AND contains
  '(unrouted)'.
- FW7 (spec F5 + adv S4 title half): two stale test titles. RecentErrors.test.tsx:86
  'renders timestamp + level + message + correlationId ONLY' -> drop the ONLY claim
  (e.g. 'renders timestamp + level + message + correlationId'). systemStatus.service
  .test.ts:424 'deduplicates OOM events that have the same timestamp+label' -> rename
  to name the REAL mechanism now guarding it (the same log event returned by both the
  pino and OOM queries shares one ref and collapses), + one comment line. No behavior
  change - the fixture (shared PTR-8) models reality correctly per measured fact 9.
- FW8 (adv C7): routeLabel docblock gains the baseUrl invariant sentence: safe because
  every router in app/src mounts on a LITERAL prefix (swept; zero parameterised
  mounts); a parameterised mount would substitute concrete values into baseUrl and
  reintroduce ids into msg - keep mounts literal or template the baseUrl here first.
- FW9 (adv C4 comment half): in getLogRecord, next to record['@log'], cite the spike
  measurement (spec section 3 fact 6: a real GetLogRecord response carried @log,
  @logStream, @ingestionTime) so the fail-closed dependency on @log presence is
  auditably grounded, and note it fails CLOSED (out_of_scope) if AWS ever omitted it.
- FW10 (adv C3): FILE as docs/issues/system-trace-insights-spend-unmetered.md
  (type improvement, severity low, area app): each trace click = two StartQuery
  executions over a 35-min bracket x two groups, unmetered; /errors was already a
  3-query click; requireRole admin is the only gate; session cookie sameSite:lax so a
  top-level cross-site GET can trigger it; response unreadable cross-origin (no authz
  break); suggested cheap guards (per-session cooldown or narrower default bracket).
  Then npm run issues (INDEX.md stays unstaged).

## Rejected / no action (with grounds)

- adv S1 code change (overlap + ptr-dedup): REJECTED. The one-second-hole reading is
  refuted by the spike's direct measurement (startTime==endTime==floor returned
  mid-second events; plan Verified facts + spec section 3, 2026-08-24, real account),
  and the overlap design was explicitly adjudicated AGAINST in the spec (S5: ceil
  overlap returns the failure line from both queries and renders it twice). The
  reviewer was plan-blind by mandate and flagged exactly the right question; the
  answer lives in evidence it could not see. FW3 makes that evidence findable.
- adv S3 part 1 (non-err passthrough): works as specified (spec S4: non-err fields
  PASS THROUGH - app-authored, the point of the view). Adv's own sweep found ZERO live
  object-valued error logs outside err. Docblock scope clarified in FW2.
- adv S4 behavior half (same-instant identical lines now occupy N slots): the spec
  adjudicated the key change ("the key becomes effectively ref alone ... do not design
  around the old components being reached"). N distinct log events are N events.
- adv C5 (same-ms anchor markers; anchor-by-ptr): cosmetic; the plan pinned
  timestamp-equality marking; an @ptr-on-trace-rows change grows the seam + mirror +
  fakes for a nit. Noted in the handback as a possible follow-up. The zero-marker
  branch of the argument falls with S1.
- adv N1/N2/N3/N4, spec F2 (coercion by construction + typed seam), F4 (spec-verbatim
  metadata denylist), F6 (trace source raw value unreachable for 'system'), F7
  (pre-existing coverage suffices): no action; carried to the handback notes.
- spec D1 (decision record vs spec on errMessage): shipped follows the CURRENT spec
  (amended after the decision record); flagged to the human in the handback so the
  decision record can be annotated.
- spec D2 (ladder's message rung): plan-pinned, preserves pre-existing alias behavior.

## PLANNER RULING (2026-08-25, supersedes the above where they differ) - FINAL WAVE LIST

The planner reviewed both reports independently and ruled. Deltas from my draft:
adv C5 anchor-by-ptr is IN (planner F7); the C3 spend issue is OUT entirely (planner
is taking it to the human - do not fix AND do not file); the RecentErrors.test.tsx:86
title rename is OUT (planner D2 leave); planner F3 wants the dedup test REWORKED with
distinct refs and a stated decision, not merely renamed; planner F8 adds a decision-
record AJ71 annotation; planner F9 adds the at-validation tightening; R1/R2 supply
real measurements to embed in comments (in the wave brief).

FINAL WAVE: FW-A enforceBound convergence + many-field test (F1). FW-B bare-err
JSON-object guard + honest docblock scope + tests (F6). FW-C URIError (unrouted) test
(F2). FW-D dedup test rework: same ref collapses / distinct refs survive, renamed,
choice stated in commit message (F3). FW-E composite row key ref|timestamp|message +
test (F4). FW-F hook unmount aborts + docblock truth + abort tests (F5). FW-G @ptr on
trace rows end-to-end: fields clause, TraceLineView.ref, dashboard mirror, ErrorTrace
anchorRef prop, ref-based anchor marker, li key (F7). FW-H tighten `at` to ISO shape +
test (F9). FW-I trace boundary comment embeds the real measurement + ceil/floor
non-contradiction note (R1). FW-J @log-presence measurement comment + deliberate
host-metadata pass-through note (R2). FW-K routeLabel baseUrl invariant sentence (R3).
FW-L decision record AJ71 superseding note (F8).

One wave, one FRESH implementer, 3 commits (app backend / dashboard+trace-ref / docs).
Affected gates after: app adapter/service/routes/expressErrorHandler tests, dashboard
settings tests, root typecheck. Full suites re-run post-sync regardless.
