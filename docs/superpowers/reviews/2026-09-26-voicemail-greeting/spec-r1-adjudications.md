# Spec review R1 - adjudications (planner)

Spec: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md`
DRAFT 1 @7cb62edc -> DRAFT 2 (this round's edits)
Reviewers: A (`spec-r1-reviewer-a.md`), B (`spec-r1-reviewer-b.md`), both
opus, same brief, independent.
Ruling vocabulary: ACCEPT (spec edited) / REJECT (with reason) / DEFER
(issue filed or handback note). "Decision changed" is the planner's call,
assigned after the ruling, and drives the round loop (not reviewer severity).

## Reviewer A

A1 [HIGH] Webhook fallback has no time bound - ACCEPT. Decision changed:
YES (a new mechanism). Verified: `mediaStore.ts` builds `S3Client` with no
request handler options; the harness `head` has no abort seam; `/status` did
not read settings before this feature. Spec 4.6 now bounds the WHOLE
greeting lookup (GetItem + HEAD + presign) with `VOICEMAIL_GREETING_LOOKUP_
BUDGET_MS = 2500` via a `withTimeout` race; a timeout is a failure (WARN +
`<Say>`); the timed-out promise is fire-and-forget with a swallowed
rejection. Test (d) split into (d) head throws and (e) head never settles.

A2 [MEDIUM] "Never buffer the whole file" undeliverable via lib-storage;
atomicity rationale wrong; departs from the 2026-07-15 direct-upload
decision - ACCEPT the restatement, REJECT the switch to presigned POST.
Verified lib-storage `MIN_PART_SIZE = 5 MiB` and the single-PutObject path
for a body <= partSize. Decision 2 ("stream the upload to the media store")
is given and names the through-app route; the 2026-07-15 decision was about
20 MB photos uploaded in batches from a phone on the single EC2 instance,
not a <= 5 MB file uploaded a handful of times a year by an admin. The spec
now says exactly what happens (the route holds no buffer; lib-storage holds
at most one 5 MiB part, which at this cap is the whole file, and sends ONE
PutObject only after the gate ends cleanly - that single PUT is what makes
the replace atomic), and records the departure and its reason. Handback
flags the interpretation of "never buffer the whole file" as "no app-level
buffer" (the repo's existing "streams only" posture for recordings uses the
same put). Decision changed: NO (mechanism unchanged, prose corrected).
The CloudFront `origin_read_timeout` question is carried as a known risk in
the handback (UNVERIFIED by both of us; only a dev call can settle it).

A3 [MEDIUM] File name in the query string is exported on OTel spans -
ACCEPT. Verified `otel.ts` rebuilds `http.url` from `req.url` including the
query; CloudFront forwards viewer headers (`Managed-AllViewerExceptHost
Header`); `requestLogger` logs an allowlist that excludes custom headers.
The name now rides `X-Greeting-File-Name` (URI-encoded so the header value
is always ASCII; the server decodes). Decision changed: NO (transport of a
display string).

A4 [MEDIUM] Empty `file.type` contradiction - ACCEPT. The client now infers
`audio/mpeg` / `audio/wav` from a `.mp3` / `.wav` extension when
`file.type` is empty, and sends that; the server rule is unchanged (an
absent or unknown Content-Type is refused with the given message). Route
test added for an absent Content-Type. Decision changed: NO.

A5 [MEDIUM] `VoiceSection.test.tsx` and `voice-outbound.spec.ts:690` are
unenumerated surfaces - ACCEPT. Verified the four singular
`findByRole('alert')` assertions and the unmocked `getSettings`. Spec 4.7
now defines the block's LOAD-failure rendering as `role="status"` text with
a Retry button (never an alert - alerts are for user-action failures inside
the block), and section 5 requires `VoiceSection.test.tsx` to mock
`getSettings` (no greeting) and names the e2e zero-alert assertion as a
surface to keep green. Decision changed: NO.

A6 [MEDIUM] fake-twilio classification is order-blind - ACCEPT. Verified
the thanks `<Say>` follows every `<Record>` and `fast-xml-parser` is used
without `preserveOrder`. The field is now "the verb IMMEDIATELY BEFORE
`<Record>`" parsed from an ordered parse; unit-pinned with Say+Record+Say,
Play+Record+Say and Record+Say documents. Decision changed: NO (test
observability only).

A7 [MEDIUM] "No greeting set" WARN contradiction - ACCEPT (clarified). The
spec adopts: no log line when no greeting is set (the default state of every
org; a WARN per missed call there is the exact warn-flood class the C3
log-hygiene mission removed); WARN when a greeting IS set and cannot be
played (object missing, store unconfigured, lookup failed or timed out).
This is an INTERPRETATION of decision 3's list and is flagged in the
handback as a question the planner would have asked. Decision changed: NO
(the fallback behavior is identical; only the log line differs).

A8 [LOW] Versioned bucket: Remove/Replace never delete the audio - ACCEPT
as a stated fact. Verified `infra/modules/s3_media/main.tf` versioning
Enabled, no lifecycle rule. Spec 4.4 now says Remove writes a delete marker
and prior versions persist until an operator adds a lifecycle rule (an
infra change, out of this mission; handback names it). Decision changed:
NO.

A9 [LOW] Partial-failure states - ACCEPT. Both named in 4.3/4.4; the audit
append on both new routes is best-effort (ERROR log, never a 500 after the
record is live). Decision changed: NO.

A10 [LOW] Stored `s3Key` is a second source of truth - ACCEPT. The
projection now requires `s3Key === VOICEMAIL_GREETING_S3_KEY`; anything
else projects as absent (pinned by a repo test). Decision changed: NO.

A11 [LOW] `req.pipe` vs `stream.pipeline`; drain; abort classification -
ACCEPT. 4.3 now uses `pipeline(req, gate, cb)` wired BEFORE `put` (same
tick), classifies a client abort as a WARN with no response, drains a
KNOWN-length refused body (bounded) and destroys the request for a chunked
over-cap body, and references `docs/issues/mms-upload-endpoint-hardening.md`.
Decision changed: NO.

A12 [LOW] Dashboard direct fetch / `noteServerDate` / patchable mirror -
ACCEPT. `client.ts` gets an ADDITIVE `rawBody` + `headers` option on
`RequestOptions` (JSON path byte-identical), so the upload reuses the error
shaping and `noteServerDate`; `SettingsPatch` on both sides `Omit`s
`voicemailGreeting`. Decision changed: NO.

A13 [LOW] Test-fake misdescriptions - ACCEPT. Section 5 now names the
harness seams to add (`mediaHeads`, `mediaPresigns` recorders;
`failMediaHeads`, `hangMediaHeads` sets) and the correct file/harness for
the projection tests (`settings.test.ts`, stubbed DocumentClient).
Decision changed: NO.

A14 [LOW] Sniff accepts ADTS AAC; Twilio `<Play>` failure behavior
UNVERIFIED; "played" log wording - ACCEPT all three: the MP3 rule requires
non-zero layer bits; the log line is "voicemail greeting offered"; the
Twilio-side behavior on an unplayable file is recorded as a known risk to
verify on dev (handback). Decision changed: NO.

A15 [LOW] `req.query.name` shape; surrogate split - ACCEPT (moot for the
query with A3; the header value is decoded, non-string coerced to undefined,
capped by code points). Decision changed: NO.

Round 1 result for A: decision changed by A1 only (a new time bound).

## Reviewer B

B1 [HIGH] No time bound on the greeting lookup - ACCEPT, same as A1
(already folded in). Decision changed: YES (counted once).

B2 [HIGH] E2E step 5 uses `documentElement.scrollWidth`, which
`e2e/support/viewport.guard.test.ts` fails in gate 2 - ACCEPT. Verified the
guard and the helpers (`expectNoHorizontalOverflow`, `expectNoHorizontal
OverflowIn`, `NARROW_360`, `WIDE_RESTORE` in `e2e/support/viewport.ts`).
Section 5 step 5 now uses `NARROW_360` + `expectNoHorizontalOverflow(page,
'/settings/voice')` and `expectNoHorizontalOverflowIn(dialog, ...)` on the
Remove dialog, restoring `WIDE_RESTORE` after. Decision changed: NO (test
mechanics), but it would have turned gate 2 red.

B3 [MEDIUM] lib-storage buffers the whole <= 5 MiB body - ACCEPT, same as
A2 (restated honestly; through-app route kept; "previous object
byte-identical after a refused upload" added to the route tests).

B4 [MEDIUM] Fallback guarantee overstated (unplayable-but-present audio;
ADTS AAC passes the sniff; HEAD-to-fetch race after Remove) - ACCEPT.
Section 1 now says the fallback covers LOOKUP-TIME failures; the residual
(present but unplayable, or removed between HEAD and Twilio's fetch) is
named as an accepted gap with the Twilio-side behavior UNVERIFIED and
carried to the handback as a dev check; the sniff requires non-zero layer
bits and an ADTS test is added. Decision changed: NO.

B5 [MEDIUM] Dashboard mutation catalog (gate 2) and the perf route contract
are unenumerated surfaces - ACCEPT. Verified `DASHBOARD_MUTATION_CATALOG`
(count pinned at 108), the scanner's literal-path rule, `VOICE_GETS =
[/api/users/me]` and `routes.test.ts` line 112. Spec 4.9 now lists: two
catalog entries (`uploadVoicemailGreeting` `request:PUT
/api/settings/voicemail-greeting`, `removeVoicemailGreeting` `request:DELETE
/api/settings/voicemail-greeting`), the count bump to 110, the literal-URL
rule (no query in the URL - the file name is a header per A3/B7), and
`VOICE_GETS` gaining `required('/api/settings')` with the routes test
updated. Decision changed: NO, but gate 2 would have gone red.

B6 [MEDIUM] `useAuth` throws without a provider; the existing VoiceSection
suite breaks - ACCEPT (with A5). The block uses `useOptionalAuth()` (admin
= `auth?.isAdmin === true`), mounts OUTSIDE the `useMe` loading/error
ternary (a `/users/me` failure never hides the greeting), and the existing
suite mocks `getSettings`. Decision changed: NO.

B7 [LOW] File name in the query string reaches trace attributes - ACCEPT,
same as A3 (header).

B8 [LOW] Empty `file.type` dead path - ACCEPT, same as A4.

B9 [LOW] Three patch types need explicit handling - ACCEPT (extends A12):
`OrgSettingsPatch` in the repo becomes `Partial<Omit<OrgSettings,
'welcomeText' | 'voicemailGreeting'>> & { welcomeText?: string | null;
voicemailGreeting?: VoicemailGreeting | null }`; the route-local
`SettingsPatch` in settings.ts and the dashboard `SettingsPatch` both Omit
`voicemailGreeting`.

B10 [LOW] fake-twilio order-blind - ACCEPT, same as A6.

B11 [LOW] Upload/Remove interleave end states; surface "greeting file
missing" - ACCEPT. 4.3/4.4 describe the real end states; the dashboard
player's `onError` renders "The greeting file is missing or can't be
played. Upload it again." (a status line, not an alert) so the state is
visible rather than a silent player. Decision changed: NO.

B12 [LOW] Versioned bucket - ACCEPT, same as A8.

B13 [LOW] Unbounded drain; client abort as ERROR - ACCEPT (with A11): every
refusal answers with `Connection: close` and no explicit drain; a client
abort is a WARN with no response.

B14 [LOW] Factual inaccuracies (harness recorders, full reseed puts cast
media, the `useSettings` reason, three more readers) - ACCEPT; all four
corrected in the spec. The `useSettings` decision stands for a different
reason: the hook is written for the Templates section's save flow and its
`save` would have to learn a non-JSON path; a small dedicated hook is
cheaper to read than a shared one with a special case.

B15 [LOW] Direct fetch skips `noteServerDate` - ACCEPT, same as A12
(additive `rawBody` option on `requestWithStatus`).

B16 [LOW] Replace-without-confirmation is an unflagged reading of decision 4
- ACCEPT: assumption E added; the handback surfaces it.

## Round 1 outcome

Accepted: A1-A15 (A2 partially: restatement accepted, presigned-POST switch
rejected), B1-B16. Rejected: the A2 alternative mechanism (decision 2 is
given). Deferred: none. Decisions changed: ONE (A1/B1, the lookup time
bound). Round 2 follows (a decision changed), continuing reviewer B with
the re-review charge and A's report path.
