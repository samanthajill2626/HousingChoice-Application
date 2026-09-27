# Planner review - adjudications (independent review of the handback)

Branch `feat/voicemail-greeting` @e271acd2 (gates on de4df265). Reviewers:
conformance (`planner-review-conformance.md`, CONFORMS WITH DEVIATIONS, 0
MUST / 0 SHOULD / 11 NOTE) and plan-blind adversarial
(`planner-review-adversarial.md`, 0 MUST / 1 SHOULD / 13 NOTE), both opus,
parallel, independent. Planner gates: see `planner-review-verdict.md`.

## Adversarial

AD1 [SHOULD] A REPLACE whose settings-record write fails (after the single
PutObject succeeded) leaves the OLD record describing the NEW bytes, the
dashboard says "Couldn't upload the greeting" while callers already hear
the new file, and the player's `?v=<old uploadedAt>` URL caches the new
bytes under the old cache key - ACCEPT as a small fix wave (planner-owned).
The STATE is the one spec 4.3 accepts ("a stale display name/date, never a
broken call") and the reviewer confirms no call breaks; what is wrong is
the MESSAGE and two comments that describe only the first-upload case. Fix:
(1) the route's two comments name the replace case; (2) the dashboard maps
`greeting_record_failed` to "The file was stored, but its details couldn't
be saved. Reload the page to check what callers hear." and, on that code,
re-fetches the settings so the block shows the record the server holds;
(3) a route test pins the replace-with-failed-record state (500
`greeting_record_failed`, object = new bytes, record = old) and a block
test pins the message. No mechanism change; the cache-key residual is
bounded by the next successful upload and is named in the handback.

AD2 [NOTE] Sniff comment claims AAC-declared-as-MP3 is refused while an
ID3-prefixed body passes - ACCEPT (comment corrected; the gap itself is
already in `voicemail-greeting-format-normalization`).

AD3 [NOTE] Remove between HEAD and Twilio's fetch - already accepted in
spec 4.4 / section 1 and filed; no change.

AD4 [NOTE] No greeting LENGTH limit (5 MB = ~5.5 min of MP3 that every
caller sits through, billed) - DEFER to Cameron (a product decision the
mission block did not make; the handback names it). No change.

AD5 [NOTE] No overall upload memory cap (~10 MiB x concurrent uploads,
admin-only, 10/min) - accepted by spec 4.10 / assumption G; noted for the
handback. No change.

AD6 [NOTE] A persistent greeting failure only WARNs (alarms fire on
ERROR) - assumption F is the planner's reading; the trade-off (no warn
flood on the default state vs. no alarm on a broken greeting) goes to
Cameron in the handback. No change.

AD7 [NOTE] The uploader's email is shown to VAs - assumption B as built;
staff-facing, same org; noted for Cameron. No change.

AD8 [NOTE] Stored `s3Key` carries no information - accepted in spec 4.2
(kept for forward compatibility, pinned to the constant). No change.

AD9 [NOTE] The release-on-abort fix landed only on the recording route -
already filed (`media-serve-client-abort-leaves-body-open`). No change.

AD10 [NOTE] Sanitizer strips only C0 + DEL; the comment overstates -
ACCEPT the comment fix; the behavior is the build's declared fork 6 (spec
4.1 met). No change to behavior.

AD11 [NOTE] Message/cap duplicated between server and client; the server's
`message` field is unread - accepted (the client mirrors the server's
message verbatim by spec 4.7; a shared package would be new structure). No
change.

AD12 [NOTE] DELETE audits "removed" when nothing existed; a hung object
delete can report failure after the record was cleared - accepted
(idempotent 204 by spec 4.4; the audit line is harmless). No change.

AD13 [NOTE] No test through CloudFront (early 400 mid-upload; 30 s origin
timeout) - already the section 7 dev checks; handback carries them.

AD14 [NOTE] Versioned bucket keeps every greeting - assumption H; handback
carries it.

## Conformance

CF1-CF4 [NOTE] Forks 1, 3, 4, 5 declared and truthfully described - no
action.

CF5 [NOTE] The fixed-key defense (FW4) is a seventh fork missing from the
handback's list - ACCEPT (handback addendum, planner verdict).

CF6 [NOTE] `serveMediaObject` option shape differs cosmetically from spec
4.5 - accepted; no change.

CF7 [NOTE] Absent-Content-Type route test checks only the code - ACCEPT
(assert the exact message too).

CF8 [NOTE] Webhook test (e) does not pin its WARN wording - ACCEPT (pin
"failed or timed out").

CF9 [NOTE] Stale `settings.ts` line refs (+3) in
`voicemail-greeting-concurrent-writes-unserialized.md` - ACCEPT (re-point).

CF10 [NOTE] Gate 4 green rests on the second full run after a 1500 s cap
kill with one Chromium renderer crash in tours.spec.ts under a concurrent
lane - the planner's own independent e2e run is the tie-breaker (verdict).

CF11 [NOTE] Assumption G's spec text understates the ~2x peak - ACCEPT
(spec precision edit: "about twice the file, ~10 MiB at the cap").

## Fix wave (planner-owned, small, test-first where code changes)

- settings.ts comments (AD1); dashboard `greeting_record_failed` mapping +
  re-fetch + test (AD1); route test for replace-with-failed-record (AD1).
- voicemailGreeting.ts comments (AD2, AD10).
- routes test exact message (CF7); founderTriage (e) WARN wording (CF8).
- issue line refs (CF9); spec G text (CF11); handback addendum (CF5).
Then re-run the affected suites + typecheck + lint on the touched files; the
full gates already ran on de4df265 and the fix wave touches comments, one
dashboard message path and tests only.

## Adversarial re-review (r2, on 1f7e99b4; `planner-review-adversarial-r2.md`)

R2-1 [SHOULD] The AD1 message claimed "callers hear the new greeting", false
for a FIRST upload (no record -> the webhook stops at "absent" -> built-in
prompt) - ACCEPT (the planner shipped a claim its own adjudication had
avoided). Message now claims neither case: "The file was uploaded, but its
details couldn't be saved. Upload it again."; the route comment and the
constant's JSDoc state both cases truthfully.

R2-2 [NOTE] The re-fetch is unfenced (a Remove/Replace during it is
overwritten by the stale response) - ACCEPT: `upload` and `remove` abort the
in-flight load before acting (the hook's existing AbortController).

R2-3 [NOTE] The block test did not prove the re-fetch RENDERS - ACCEPT: the
second GET now answers a different record and the test asserts it renders.

R2-4 [NOTE] `serveMediaObject` serves the store's Content-Type verbatim -
accepted as-is: both writers canonicalize to fixed audio types (the
recording mirror `audio/mpeg`; the greeting route the normalized type), so no
attacker-controlled type reaches it; noted in the verdict for any future
caller.

R2-5 [NOTE] Records disagree (adjudicated wording vs shipped; verdict file
pending; the reviewer's own r1 NOTE count) - ACCEPT: wording fixed above;
the verdict is `planner-review-verdict.md` (this commit's successor); count
erratum noted.

R2-6 [NOTE] The perf ledger citation re-staled - ACCEPT (re-pointed to the
hook's current `load` span; `routes.test.ts` green).

R2-7 [NOTE] AD4 input for Cameron: the caller's own message is capped at
120 s while a greeting can run ~327 s at the 5 MB cap; decision 5 froze the
recording length, not the greeting's - carried to the verdict.

R2-8 [NOTE] AD6 restated correctly: the no-greeting default returns before
any WARN branch, so an alarm could never flood on it; the real choice is
alarm-or-not on a BROKEN greeting (a metric filter on the two WARN messages
would keep decision 3's WARN literal) - carried to the verdict.

R2-9 [NOTE] AD7: showing the uploader's EMAIL to VAs is assumption B's
addition, not decision 4's ask, and is the first VA-visible staff email in
the app - carried to the verdict as a one-line choice for Cameron (date
only vs date + email).

R2-10 [NOTE] The r1 fixes are real (targeted suites green in the reviewer's
own run); the (e) comment's AbortError claim held 20/20 but is unasserted -
left as is.

Outcome: R2-1, R2-2, R2-3, R2-6 fixed in the same planner fix wave (second
commit); no decision changed; the review is closed.
