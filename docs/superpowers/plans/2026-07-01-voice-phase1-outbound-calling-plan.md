<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Voice Phase 1 — outbound masked calling: implementation plan

Executes `docs/superpowers/specs/2026-07-01-voice-phase1-outbound-calling-design.md`
(the source of truth — read it). Shared interfaces: `.superpowers/sdd/interfaces.md`.
Data model (spec §4) and the cell-verification lib (spec §7 lib) are already built and
committed — do NOT rebuild them; build on them.

## Global Constraints (bind every task)

- **PII (spec §9):** NEVER put a raw navigator or target phone number into a log line,
  a TwiML URL, a query param, or a STORED call label. Resolve phones server-side from
  opaque ids (conversationId / contactId / a generated opaque callId). Stored
  `callPartyLabel` is a masked role/name only. Recording/transcript content never appears
  in logs.
- **Masking:** the target sees the business number (`config.ourPhoneNumbers[0]`) — ALWAYS,
  Phase 1. The navigator's real cell is never exposed to the target, never used as caller ID.
- **Verified-cell-before-dial invariant:** a cell with no `cell_verified_at` is NEVER dialed
  — not for outbound (navigator leg), not for inbound (holder). A missing/unverified cell
  degrades gracefully (409 for originate; "text us" fallback for inbound) — never a 5xx, never a leak.
- **Single-holder invariant:** at most one user has `inbound_voice_line === true`. Assignment
  goes through `assignInboundVoiceLine` (clears all others atomically).
- **Compliance:** recording is intentional + legal (Georgia one-party) — no disclosure prompt.
  `voice_opt_out` is our company do-not-call; honored on EVERY originate path (route + UI).
  Do NOT blanket-block cold calls.
- **Reuse, don't reinvent:** the outbound bridge generalizes the inbound founder-bridge —
  reuse the whisper prompt, press-1 gate, `/voice/status`, `/voice/recording`,
  `/voice/transcription`, and the masked-label + `authorForContact` helpers. The recording &
  transcription callbacks gate on `masked===false`; outbound entries are `masked:false` so they
  record exactly like the founder bridge.
- **Terminology:** unit/property/home; placement; navigator = staff user.
- **TDD:** write a failing test first, then implement. Typecheck must stay green
  (`npm run typecheck`). Follow existing test patterns (repo integration tests use DynamoDB Local;
  app route tests build the app with the fake/console adapter; e2e uses the fake-twilio harness).
- **Commit discipline:** stage EXPLICIT paths (never `git add -A`); commit trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. NEVER run deploy:*,
  secrets:push, terraform apply; never touch real `.env.*` or `.docx`. Do NOT merge.

---

## Task 1: Outbound originate service + route (spec §5 steps 1–4)

**Goal:** the first caller of `initiateCall`. An authenticated navigator places a masked
outbound call to a contact. Rings the navigator's verified cell first (the bridge webhook in
Task 2 handles the answer). Persist a `call` timeline entry.

**Build:**
- A service `app/src/services/outboundCall.ts` (or a well-named module) `placeOutboundCall({
  navigatorUserId, contactId, deps })` and a route `POST /api/contacts/:contactId/call`
  (authenticated; mount inside `createApiRouter` — either extend the contacts router or a new
  `createOutboundVoiceRouter`). Session `req.user.userId` = the calling navigator.

**Flow (exact, ordered — guards BEFORE any call is placed):**
1. Load the navigator via `usersRepo.findById(req.user.userId)`. If `!cell` OR
   `!cell_verified_at` → respond `409` with body `{ code: 'cell_not_verified' }`. NO call placed.
2. Load the target contact via `contactsRepo`. If `contact.voice_opt_out === true` → respond
   `409` with body `{ code: 'contact_voice_opted_out' }`. NO call placed. (Also 404 if no such
   contact / no phone.)
3. Resolve the contact's `conversationId` (the opaque key the bridge will use). Build
   `twimlUrl = ${baseUrl}/webhooks/twilio/voice/outbound-bridge?conversationId=<id>` — opaque id
   ONLY, never the target phone.
4. `initiateCall({ to: <navigator.cell>, from: config.ourPhoneNumbers[0], twimlUrl,
   idempotencyKey })`. Capture the returned `callSid`.
5. Persist the call entry: `messages.append({ type:'call', direction:'outbound',
   providerSid: callSid, masked:false, callStatus:'ringing', author:'team_member' (the navigator),
   callPartyLabel: <masked target label — role/name via the existing masked-label helper, NEVER raw
   phone>, startedAt: now, ... })`. Idempotent on `callSid`.
6. Respond `200`/`202` `{ callSid }`.

**Notes / exact values:**
- Caller ID is ALWAYS `config.ourPhoneNumbers[0]`. If it is undefined, respond `409`/`503`
  `{ code: 'voice_unavailable' }` (never dial with an empty caller ID) — mirror the inbound
  "no business number" fallback intent.
- If `messagesRepo`'s call `direction` union is inbound-only, extend it to allow `'outbound'`
  (SMS entries already use 'outbound' — keep the union consistent).
- No raw phone in any log; log opaque ids + masked labels only.

**Tests:** app-route/integration tests with the console/fake adapter and repo fakes/DynamoDB Local:
(a) success → `initiateCall` called with `to`=navigator cell, `from`=business number, an
outbound-bridge twimlUrl containing conversationId and NO phone; a `call` entry persisted
(direction outbound, masked label, providerSid=callSid). (b) unverified/absent navigator cell →
`409 cell_not_verified`, `initiateCall` NOT called, NO entry. (c) `voice_opt_out` contact →
`409 contact_voice_opted_out`, `initiateCall` NOT called. Assert the twimlUrl and stored label
contain no raw phone digits.

---

## Task 2: Outbound-bridge TwiML webhook (spec §5 — reuse whisper/gate, then dial target)

**Goal:** the answer URL for the originated navigator call. On the navigator answering, whisper +
press-1 gate (block their carrier voicemail from auto-accepting), then `<Dial>` the target with the
business caller ID, recording, and status action — reusing the inbound machinery.

**Build:** `POST /webhooks/twilio/voice/outbound-bridge` in `app/src/routes/webhooks/voice.ts`
(under `twilioSignatureMiddleware`, alongside the inbound routes).

**Flow:**
1. Read the opaque `conversationId` from the query (NEVER a raw target phone). Resolve the target
   contact + phone server-side from it. If it cannot resolve → safe hangup TwiML (masked message),
   never a 5xx, never a leak.
2. Whisper + press-1 gate: reuse `/voice/whisper` + `/voice/whisper-gate` semantics. Prompt is
   "Calling <masked contact label> — press 1 to connect." Factor the shared whisper prompt/gather
   so inbound and outbound share it; the outbound gate branch, on press-1, must emit the `<Dial>`
   to the target (inbound's gate returns `<Pause>` because its `<Dial>` lives in the parent TwiML —
   outbound is inverted, so the gate is where the dial happens). Use an explicit leg marker (e.g.
   `leg=outbound`) to select the dial-on-accept branch; keep it a distinct, well-named branch —
   do NOT weaken the inbound founder branch.
3. On press-1: `<Dial callerId=config.ourPhoneNumbers[0] record="record-from-answer-dual"
   recordingStatusCallback=${baseUrl}/webhooks/twilio/voice/recording
   recordingStatusCallbackEvent=['completed'] answerOnBridge=true
   action=${baseUrl}/webhooks/twilio/voice/status method=POST>` then `.number(<target phone>)`.
4. Recording, transcription, and status reuse the EXISTING `/voice/recording`,
   `/voice/transcription`, `/voice/status` handlers unchanged — outbound entries are `masked:false`
   so recording/transcription apply. Confirm `/voice/status` correctly stamps answered/missed/duration
   for the outbound entry (entry keyed by `providerSid` = the navigator call's CallSid = the parent).

**Constraint:** every URL emitted (whisper, gate, status, recording) carries opaque ids only. The
target phone appears ONLY inside the `<Dial>.number()` TwiML body sent to Twilio — never in a URL,
log, or stored label.

**Tests:** unit-render the outbound-bridge TwiML: resolves target from conversationId; whisper
prompt uses the masked label; press-1 gate emits `<Dial>` with `callerId` = business number,
`record='record-from-answer-dual'`, recording + status callbacks, `answerOnBridge=true`, and the
target phone in `.number()`. Assert NO raw phone in any callback URL or the whisper text. A
non-press / timeout does NOT bridge. Unresolvable conversationId → safe hangup, no throw.

---

## Task 3: Inbound rings the inbound-voice-line holder (spec §6 — replaces FOUNDER_CELL)

**Goal:** `handleFounderTriage` dials the `inbound_voice_line` holder's VERIFIED cell (and pushes
to that holder) instead of `config.founderCell`. Otherwise inbound is unchanged.

**Build (in `app/src/routes/webhooks/voice.ts`):**
- Replace the `config.founderCell` read in `handleFounderTriage` with:
  `const holder = await usersRepo.getInboundVoiceLineHolder();` then use `holder.cell` ONLY when
  `holder?.cell_verified_at` is set. That verified cell is the dial target AND the pre-ring push
  target (push to the holder user's devices — spec §6 says the push target is the holder).
- If no holder, or the holder's cell is unverified/absent → today's "text us" fallback path
  (the existing `~L451–456` masked greeting + hangup). Never a 5xx, never a leak.
- `config.founderCell` stays ONLY as a deprecated seed fallback (seedData/migration may seed the
  founder user's cell + the flag from it). Do not otherwise read it for routing.

**Tests:** inbound with a verified holder rings `holder.cell` (assert the dialed number = holder
cell, NOT `config.founderCell`); with no holder → "text us" fallback (no dial, no 5xx); with a
holder whose cell is unverified → fallback. Reuse the fake-twilio inbound harness / existing
founder-triage test setup.

---

## Task 4: Cell verification API (spec §7 — self-service set + verify)

**Goal:** a navigator attaches and verifies their own cell; `cell_verified_at` is stamped on
success. Backs the Settings "My cell" UI (Task 8).

**Build (authenticated `/api` routes, operate on `req.user.userId` — self-service, no admin):**
- `POST /api/me/cell/start` body `{ cell }`: validate E.164; `const code =
  generateCellVerifyCode(); await usersRepo.startCellVerification(userId, cell,
  hashCellVerifyCode(code), new Date(now + CELL_VERIFY_TTL_MS).toISOString());` then send the code
  via `adapter.sendMessage({ to: cell, body: renderCellVerifySms(code), idempotencyKey })`. Respond
  `200 { pending: true }`. NEVER return or log the code.
- `POST /api/me/cell/verify` body `{ code }`: `const r = await
  usersRepo.confirmCellVerification(userId, hashCellVerifyCode(code), now);` on `r.ok` → `200
  { cell: r.cell, cell_verified_at: r.cell_verified_at }`; else `400 { code: r.reason }`
  (`no_pending|expired|mismatch|too_many_attempts`).
- Ensure the "me" payload (`/auth/me` or the settings "me" endpoint the dashboard reads) returns
  `cell` + `cell_verified_at` + `inbound_voice_line` (types already declared in `dashboard/src/api/types.ts`).

**Tests:** `start` stores pending (hash, not plaintext) and an SMS with the code appears in the
dev outbox / fake adapter (assert the code is NOT logged); `verify` happy path stamps
`cell_verified_at` and returns it; wrong code → `400 mismatch`; expired → `400 expired`; >5
attempts → `400 too_many_attempts`. Invalid E.164 to `start` → `400`.

---

## Task 5: Inbound-voice-line assignment API + team serializer (spec §6 admin)

**Goal:** an admin assigns the single inbound-voice-line holder; the team list exposes each user's
cell + verification + holder flag. Single-holder invariant enforced.

**Build:**
- Admin route (in the admin-users router) `POST /api/users/:id/inbound-voice-line` (or a PATCH on
  the user) `requireRole('admin')` → `await usersRepo.assignInboundVoiceLine(id)` (clears all
  others). A companion clear (`DELETE` / `{ inbound_voice_line:false }`) → `clearInboundVoiceLine(id)`.
  Non-admin → `403`.
- Ensure `GET /api/users` (`AdminUserView`) serializes `cell`, `cell_verified_at`,
  `inbound_voice_line` for each user (fields already in the dashboard type).

**Tests:** assign to user B when user A held it → B holds, A cleared (single-holder); non-admin →
`403`; `GET /api/users` includes cell/cell_verified_at/inbound_voice_line. Reassign is idempotent.

---

## Task 6: voice_opt_out staff toggle API + contact serializer (spec §8)

**Goal:** staff set/clear a contact's company do-not-call. Honored by the originate route (Task 1)
and the CallMenu (Task 7). Independent of `sms_opt_out`.

**Build:**
- Extend the existing contact-flag endpoint (the one that sets `sms_opt_out`) to accept
  `voice_opt_out` via `contactsRepo.setFlag`/`clearFlag`, OR add a dedicated toggle if no generic
  flag route exists. Authenticated staff (match the existing flag route's gating).
- Ensure the contact detail serializer (`GET /api/contacts/:id`) returns `voice_opt_out` so the
  dashboard can render the toggle + disable the call control.

**Tests:** set `voice_opt_out` persists and clears; `GET /api/contacts/:id` reflects it;
independence from `sms_opt_out` (toggling one does not change the other).

---

## Task 7: CallMenu — POST to originate route (spec §5)

**Goal:** the dashboard "📞 Call" control places a masked call instead of a `tel:` device dial.

**Build (`dashboard/src/routes/contact/CallMenu.tsx`):**
- Replace the `tel:` link with a control that POSTs `/api/contacts/:contactId/call` via the api
  client (`request`). On `200` show a "calling — answer your cell" affordance.
- When `contact.voice_opt_out` → render the control DISABLED with a "Do not call" note (do not POST).
- When the navigator has no verified cell (either known from the `me` payload, or a `409
  cell_not_verified` response) → prompt to set a cell with a deep-link to Settings (do not dial).
- Accessibility-first: `getByRole`/`getByLabel`-friendly markup (button with an accessible name;
  disabled state announced).

**Tests (e2e, accessibility-first selectors):** clicking Call POSTs the originate route (assert via
fake-twilio that a call was placed / the app route hit); disabled + noted for a `voice_opt_out`
contact; a navigator with no verified cell sees the set-a-cell prompt (Settings deep-link), no call
placed.

---

## Task 8: Settings — My cell + Team page + contact voice_opt_out UI (spec §6/§7/§8)

**Goal:** the front-end for verification, the inbound-line badge/assignment, and the do-not-call toggle.

**Build (`dashboard/src/routes/settings/` + contact actions):**
- **My cell** (self-service): a field to set the cell → calls `POST /api/me/cell/start`; a code
  entry → `POST /api/me/cell/verify`; shows verification state (verified / pending / none).
- **Team page:** list users with cell + verification state; the holder shows an **"Inbound voice
  line"** badge. An admin can assign the holder (calls Task 5) — reassigning MOVES the badge
  (single holder visible). Non-admins see state read-only.
- **Contact voice_opt_out toggle:** in the contact detail/actions, a "Do not call" toggle wired to
  Task 6. (Placement of the toggle is contact-detail, not global settings.)
- Accessibility-first markup throughout.

**Tests (e2e, accessibility-first):** set + verify a cell → verified state shown and
`cell_verified_at` stamped; Team page shows exactly one "Inbound voice line" badge and reassigning
moves it (single-holder); the contact do-not-call toggle round-trips and disables the Call control.

---

## Task 9: Consolidated outbound e2e + PII assertions (spec §9)

**Goal:** the full §9 acceptance list against the fake-twilio Voice harness, in one spec suite
(complements the per-task tests).

**Build (`e2e/tests/…`, using `e2e/fixtures/fakeVoice.ts` + voiceControl):**
- Originate: a navigator with a verified cell places a call → the navigator's cell rings → on
  accept (press '1') bridges to the target with the business caller ID → a `call` entry is
  persisted → recording + transcription callbacks stamp the entry.
- Guards: no verified cell → `409 cell_not_verified` (no call placed); `voice_opt_out` contact →
  `409 contact_voice_opted_out` (no call placed).
- Verification: an unverified cell is never dialed; the verify flow stamps `cell_verified_at`.
- Inbound: rings the inbound-voice-line holder's cell (not `FOUNDER_CELL`); no holder → "text us"
  fallback.
- Team page: cell + verification shown; a single inbound-voice-line badge; reassigning moves it.
- PII: assert no raw navigator/target phone appears in stored call labels, TwiML URLs, or logs
  (inspect the persisted entry's `callPartyLabel` and any captured request URLs).

**Tests:** the above ARE the tests. Accessibility-first selectors for any UI steps. Green run required.
