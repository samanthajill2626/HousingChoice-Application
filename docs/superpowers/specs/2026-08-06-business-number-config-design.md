# Business phone number configuration - design

Date: 2026-08-06
Branch: feat/business-number-config
Status: DRAFT (spec review, revision 4 - post adversarial review round 3)

## 0. Decision provenance and superseded documents

The singular-number premise rests on an OPERATOR DECISION taken 2026-08-06:
after the port, the 404 number serves DEV and the ported 678 number serves
PROD, under SEPARATE Messaging Services and SEPARATE A2P campaigns.

A2P CAMPAIGN STRUCTURE IS NOT AFFECTED BY THIS CHANGE, and an earlier revision
of this spec was wrong to imply otherwise. The structure is ONE CAMPAIGN PER
ENVIRONMENT: dev has its campaign, prod gets its own (in process, tracked by
docs/issues/ported-number-not-on-a2p-campaign.md). Every DEV number lives in
the dev campaign; every PROD number lives in the prod campaign. That is not a
change of posture, and docs/a2p/campaign-resubmission.md is NOT superseded:
its section 9 rule - every number the app can send from must be attached to
THIS campaign's Messaging Service - holds unchanged, read per environment. The
A2P campaign work is operator-owned and OUT OF SCOPE here (N6).

Two documents, both app-owned, DO assume the older single-service topology and
are stale. THIS CHANGE OWNS RECONCILING THEM. A builder who reads them and
concludes this spec is wrong has read them in the wrong order.

- RUNBOOK.md:600-622 - the ORDER MATTERS section (added by fix/pin-sms-sender,
  merged @db54d38d) prescribes a two-entry PROD list. Correct under one
  Messaging Service; obsolete now, and a singular variable has no order to get
  wrong. DELETE the section.
- docs/issues/one-to-one-sender-not-pinned-to-ported-number.md - describes ONE
  Messaging Service holding both numbers plus every relay number. CLOSED by
  this change (D9); the Resolution records the split.

Neither docs/a2p/campaign-resubmission.md nor
docs/issues/ported-number-not-on-a2p-campaign.md is touched by this change.
They are operator-owned and their assumptions hold per environment (above).

If the split is ever reversed, plurality returns as a CONTAINED change: the
sender is one named field and "is this ours" is one named predicate (D3).

## 1. Problem

`OUR_PHONE_NUMBERS` answers three unrelated questions.

1. WHICH NUMBER DO WE PRESENT? `ourPhoneNumbers[0]` - and only `[0]` - is the
   outbound voice caller ID, the public flyer CTA, the thread "which side is
   us" marker, and (since fix/pin-sms-sender) the pinned 1:1 SMS sender.
   Primacy is encoded by ARRAY POSITION: appending, the natural operator
   action, silently changes nothing; prepending silently changes four
   outward-facing behaviors.
2. IS THIS ONE OF OURS? The echo/author defenses must recognise our own
   outbound projected back. The static list cannot answer alone - relay pool
   numbers are bought at runtime - so every call site pairs the list with a
   dynamic lookup, duplicated inline in two files with no shared name.
3. WHO DO WE RING ON PRESS-0? The whisper gate treats the list as "the team"
   and dials every entry (section 4).

RUNBOOK.md:600 states the variable "must list EVERY number we own". We own the
pool numbers too. Followed literally that breaks the pool-audit classifier
(scripts/poolNumbersAudit.mjs:19 defines pool as attached-and-NOT-in-the-list),
makes press-0 ring pool numbers, and - if a pool number landed first -
reintroduces the defect fix/pin-sms-sender just closed. .env.dev.example:40-42
and .env.prod.example:35-37 define it a DIFFERENT and also-wrong way ("the
numbers in the Messaging Service's sender pool"), which now describes the relay
numbers too. .env.example:7 only NAMES the variable; it needs the rename only.

## 2. What changed the answer

The plural modelled "we own several numbers". The section 0 decision retires
it: no environment has two business numbers.

An earlier draft justified this with "every test configures exactly one
number". THAT WAS FALSE. A second draft narrowed it to "no test exercises
multi-number BEHAVIOR". THAT WAS ALSO FALSE. Both are withdrawn. The two
multi-entry tests are:

- app/test/twilioSmsWebhook.test.ts:1056-1062 - a config-PARSE test
  (`' +15550009999 , +15550008888 '`). Tests the parser only. Rewritten for the
  singular parser (section 7).
- app/test/sendMessage.test.ts:555 - "pins the FIRST entry when several are
  listed", added by fix/pin-sms-sender. This DOES test multi-number behavior.
  It is DELETED, not adapted: it asserts a behavior that ceases to exist, and
  adapting it would preserve the appearance of coverage for a deleted path.

The justification therefore rests on the OPERATOR DECISION (section 0) alone,
not on an empirical claim about the test suite. That is sufficient and it is
honest; the two withdrawn claims were the planner over-reaching for support the
decision did not need.

## 3. Goals and non-goals

GOALS

- G1. Replace the positional convention with a singular, named value.
- G2. Give "is this one of ours?" a SINGLE named definition (D3).
- G3. Remove the press-0 team-dial conflation.
- G4. Make the number readable in the dashboard by any authenticated user, and
  visible beside the go-live flags, with an HONEST statement of what that
  display does and does not prove (D7).
- G5. Correct the documentation that is wrong today (section 0, section 8).

NON-GOALS (decided 2026-08-06)

- N1. The number stays an ENVIRONMENT VARIABLE. No `OrgSettings` move, no
  in-app edit path.
- N2. The A2P kill switches stay env vars and stay read-only. RUNBOOK gains an
  operational note so this is not rediscovered at go-live.
- N3. No compatibility shim; no production is running, so this is a clean break
  with a coordinated secrets change.
- N4. Re-adding a press-0 escape hatch. Recorded as a registry issue.
- N5. NO change to pool-number provisioning, lifecycle, or warm-spare
  promotion. D3 does not read or write the pool_numbers table (see D3).
- N6. NOT executing or closing the in-flight operator issues in section 0.

## 4. Press-0 removal

DECISION GROUNDS, in order of confidence:

1. The affordance is UNPROVEN. Nothing tests that pressing 0 reaches anyone:
   app/test/voiceWebhook.test.ts:321 asserts only that the TwiML contains
   `<Dial>` with the right `callerId`. It never exercises the resulting call.
   The test asserts the XML, not the outcome.
2. Repairing it correctly means an internal hand-off to founder triage - new
   logic on a live-call path four days before a number port.
3. It conflates "numbers we own" with "people we ring", the subject of this
   spec.

Those three stand alone. The following is ADDITIONAL and UNVERIFIED, and the
builder MUST NOT present it as established:

  Press-0 emits `<Dial callerId="BUSINESS"><Number>BUSINESS</Number></Dial>`.
  Twilio would place a call TO a number we own FROM a number we own, which
  re-enters POST /webhooks/twilio/voice, where the echo guard drops any call
  whose `From` is ours and answers with empty TwiML. IF Twilio routes a
  Dial-to-our-own-number back through our inbound webhook - standard behavior,
  NOT OBSERVED ON THIS STACK - the member reaches silence. Confirming needs a
  live dev call and is NOT a prerequisite for removal.

The catalog advertises this in audio (`voice.whisper_relay`), so removal is a
real user-facing change, not dead-code cleanup.

## 5. Decisions

D1. `OUR_PHONE_NUMBERS` (list) becomes `BUSINESS_PHONE_NUMBER` (single E.164).
    `AppConfig.ourPhoneNumbers: string[]` becomes
    `AppConfig.businessPhoneNumber: string | undefined`.

D2. Validation, including the empty case, which is load-bearing today:
    - ABSENT or EMPTY/whitespace-only -> `undefined` (unconfigured), preserving
      today's semantics exactly (config.ts:1130-1140 parses `=` to `[]`; four
      suites, scripts/dev.mjs:218 and a voiceOutbound `''` case depend on it).
      A blank value MUST NOT boot-fail.
    - Present, non-blank, not E.164 -> throw at boot (unchanged).
    - twilio driver + NODE_ENV=production + unconfigured -> throw (unchanged).
    - Unconfigured elsewhere degrades as today: `from` omitted, flyer
      contact_number null, originate returns `voice_not_configured`.

D3. ONE predicate answers "is this one of ours?", replacing the two inline
    pairings. It returns WHICH arm matched, not a bare boolean, because the
    four existing echo-drop log lines must survive byte-identical.

    WHERE IT LIVES AND WHAT IT TAKES (omitted from an earlier revision, which
    would have let two routers grow two helpers and defeat G2): a FACTORY
    beside the other messaging helpers, taking its dependencies explicitly so
    both webhook routers construct ONE instance from what they already hold -
    neither router gains a new dependency:

        createOurNumberKind({ config, conversations })
          -> (number: string) => Promise<'business' | 'pool' | undefined>

    POOL SOURCE IS `conversations` (the byPoolNumber GSI), UNCHANGED from
    today. An earlier revision switched this to `poolNumbersRepo` to "close a
    warm-spare gap". THAT WAS AN OVER-CORRECTION and is reverted:
    - A `warming` number MUST NEVER SEND and is excluded from listActive and
      burnClaim (poolNumbersRepo.ts:52-55), so it can never be the `From` of an
      outbound message. Both echo defenses test `From` ONLY
      (twilio.ts:870, voice.ts:362). Recognising warm spares therefore changes
      NO REACHABLE BEHAVIOR - it was a slogan, not a fix.
    - Worse, it would create TWO SOURCES OF TRUTH for "is this a pool number":
      membership from pool_numbers while ROUTING still resolves through
      conversations.getAllByPoolNumber (twilio.ts:890) and
      conversations.getByPoolNumber (voice.ts:375). The repo ships
      `pool:audit --reimport` precisely because those two can diverge.
    - Keeping the conversations source means the predicate needs NO new
      dependency in either webhook router and no harness rewiring.
    - The two existing repo calls are NOT semantically different as a
      MEMBERSHIP test: getByPoolNumber runs the same unfiltered byPoolNumber
      query and returns `items.find(open) ?? items[0]`
      (conversationsRepo.ts:1380-1394), so both are truthy exactly when the GSI
      has any item. There is ONE definition (G2).
    - USE THE SINGLE-QUERY READ (getByPoolNumber, conversationsRepo.ts:
      1380-1394), NOT getAllByPoolNumber, which pages the whole partition
      (:1401-1416). A membership test never needs page two. Standardising on
      the paged read would have made the VOICE echo guard - on an inbound-CALL
      webhook - strictly more expensive than today for no benefit; the SMS path
      gets slightly cheaper. There is no filter on the query, so a non-empty
      partition always yields items on page one.
    - NET BEHAVIOR CHANGE: none. Read COST changes (cheaper on the SMS path,
      unchanged on the voice path). An earlier revision claimed a flat "none",
      which was wrong: it had the voice guard adopting the paged read.

D4. Press-0 removed: the gate branch, the `voice.whisper_relay` clause, and the
    now-unreferenced `voice.team_unreachable` entry. Digits='0' falls through
    to the existing "any other key" branch (hang up the bridged leg) -
    identical to today's timeout path.
    - `voice.team_unreachable` is DELETED, not marked `dead: true`. The catalog
      reserves `dead` for an unreachable path KEPT FOR COMPLETENESS
      (catalog.ts:94-95); here the code path itself is removed.
    - After the clause is removed `voice.whisper_relay` becomes BYTE-IDENTICAL
      to `voice.whisper_founder`. KEEP BOTH IDS - different contexts,
      independently editable; collapsing couples two unrelated surfaces.

D5. `scripts/dev.mjs` mock mode FORCE-SETS `BUSINESS_PHONE_NUMBER` to the
    fake's app number (+15550009999) instead of appending (dev.mjs:214-223).
    This also fixes a defect introduced by fix/pin-sms-sender: with a populated
    `.env.dev` the append leaves `[0]` as the operator's REAL number, sends pin
    `from` to it, and fake-twilio treats any `from` that is not its own app
    number as a pool leg (fake-twilio/src/engine/engine.ts:294), registering a
    spurious relay group per 1:1 send. Dev-tooling only.

D6. `scripts/poolNumbersAudit.mjs` reads the singular variable; classification
    unchanged in meaning.

D7. Dashboard surfaces, both READ-ONLY:
    - "Our number" block on the EXISTING Settings section
      (dashboard/src/routes/settings/NumbersSection.tsx), retitled "Phone
      numbers". The TAB becomes visible to all roles (settingsTabs.ts:25
      `adminOnly: true` -> false); the block renders for everyone; the POOL
      TABLE stays admin-only.
    - CRITICAL, easy to get wrong: NumbersSection fetches `/api/pool-numbers`
      UNCONDITIONALLY in a mount effect (NumbersSection.tsx:89-94). Gating the
      TABLE is not gating the FETCH - a VA would fire an admin-only request and
      see the "Couldn't load" error alert. The fetch MUST be gated on the
      viewer's role, and `GET /api/pool-numbers` MUST stay role-guarded on the
      server.
    - A row in Settings > System status beside the go-live flags, admin-only as
      that section already is.
    - HONEST SCOPE (G4): both surfaces show the number THIS APP IS CONFIGURED
      TO SEND FROM. That is NOT proof a send will succeed - the number must
      also be attached to the Messaging Service and covered by the A2P campaign
      (section 10, operator work). The copy MUST say so. FlagPills renders a
      fixed `<Pill label state tone>` list (FlagPills.tsx:55-73) with no slot
      for a caveat sentence, so this row needs either a new element or an
      explicit design decision - it cannot be dropped into the pill list as-is.

D8. ONE server-side config value, two renderers.
    - `GET /api/settings` (routes/settings.ts:158) carries it. That route has
      NO role guard - only PUT requires admin (settings.ts:164) - so it already
      serves any authenticated user. It ALREADY returns a read-only sibling,
      `welcomeTextDefault` (settings.ts:160), which is the precedent: the shape
      becomes `{ settings, welcomeTextDefault, businessPhoneNumber }`. The
      number is env-sourced and immutable; `OrgSettingsPatch` MUST NOT accept
      it.
    - THE PUT MUST CARRY IT TOO, or the display breaks after any settings save.
      `SettingsResponse` (dashboard/src/api/types.ts:141-148) is SHARED by the
      GET and `putSettings`, and `useSettings.save()` (useSettings.ts:59-64)
      re-sets its state from the PUT response. If only the GET returns the
      number, the type lies and the block blanks the first time an admin saves
      quiet hours. `PUT /api/settings` (settings.ts:194) returns the same
      sibling.
    - The System status row reads the same resolved
      `config.businessPhoneNumber` via `GET /api/system/flags`. Two endpoints,
      one config field; neither performs an independent lookup, so they cannot
      disagree.
    - BREAKS A TEST BY DESIGN: app/test/systemStatus.service.test.ts:59 asserts
      `expect(flags).toEqual({...})`, an exact-shape match. Adding a field
      fails it. Update it deliberately.
    - PII: `SystemFlags` carries no phone number today, and that file's header
      (systemStatus.service.test.ts:3) encodes the posture being amended. This
      is a DELIBERATE, STATED amendment: doc section 9 treats a CONTACT's phone
      as PII; our own business number is published on public flyers and is not.
      Neither route logs the value.

D9. This change CLOSES docs/issues/one-to-one-sender-not-pinned-to-ported-
    number.md (still `status: open` on main): `status: resolved`,
    `resolved: 2026-08-06`, and a Resolution recording both the
    fix/pin-sms-sender fix and the section 0 split decision.

## 6. Surface map

A surface missing here is where the change silently breaks.

READS `[0]` TODAY (become `businessPhoneNumber`)

- app/src/app.ts:136 - flyer contactNumber wiring (the real read;
  public.ts:161,175 are COMMENTS needing text updates only)
- app/src/routes/contactTimeline.ts:351 - thread "which side is us"
- app/src/routes/webhooks/voice.ts:295 - founder-bridge caller ID
- app/src/routes/webhooks/voice.ts:303-309 - voice-readiness boot log, whose
  literal `'NOT configured (OUR_PHONE_NUMBERS[0])'` is ASSERTED by
  app/test/voiceReadiness.test.ts
- app/src/routes/webhooks/voice.ts:1119 - whisper-gate caller ID
- app/src/services/originateCall.ts:96 - outbound voice caller ID
- app/src/services/sendMessage.ts:338 - pinned 1:1 SMS sender
- app/src/routes/voiceApi.ts:248 - staff cell-verification SMS sender
- app/src/adapters/messaging.ts:58 - JSDoc naming `ourPhoneNumbers[0]`

READS THE WHOLE LIST TODAY (become `ourNumberKind`, D3)

- app/src/routes/webhooks/twilio.ts:278 (set build), :870 - inbound SMS echo
- app/src/routes/webhooks/voice.ts:291 (set build), :362 - inbound voice echo
- app/src/routes/webhooks/voice.ts:1215 - press-0 team dial (REMOVED, D4)

NOT A SURFACE - do not "fix": routes/webhooks/voice.ts:382 is a COMMENT.
Inbound voice routing is pool-else-founder-triage (voice.ts:373-390) with NO
business-number check. Adding `ourNumberKind` there would introduce a gate that
does not exist and change routing for unknown-`To` calls.

CONFIG: app/src/lib/config.ts:211 (type), 1130-1146, 1205

DASHBOARD (absent from earlier drafts entirely)

- dashboard/src/routes/settings/NumbersSection.tsx - the block, the retitle
  (:135), and the role-gated fetch (:89-94)
- dashboard/src/routes/settings/settingsTabs.ts:25 - the adminOnly flip, plus
  settingsTabs.test.ts:25-28,41
- dashboard/src/App.tsx:204-206 - route/guard wiring for the tab
- dashboard/src/routes/settings/FlagPills.tsx:55-73 + FlagPills.test.tsx,
  SystemStatusSection.tsx/.test.tsx, useSystemStatus.ts - the System status
  row, which D7 itself calls the hard part
- dashboard/src/api/types.ts:141-148 (`SettingsResponse`, shared GET+PUT) and
  :156-172 (SystemFlags); dashboard/src/api/endpoints.ts (both calls);
  dashboard/src/routes/settings/useSettings.ts:59-64 (the save() re-set)
- dashboard/src/routes/settings/NumbersSection.test.tsx:369 and
  SettingsPage.test.tsx:66 - assert the current title
- e2e/tests/dashboard-next/pool-numbers-admin.spec.ts - MUST BE REWRITTEN, not
  merely updated: :118-133 is a whole describe block asserting the exact
  VA-cannot-see-this contract D7 inverts, and :80,:84 pin the current title

FAKE-TWILIO

- fake-twilio/src/engine/twimlInterpreter.ts:10,62 - `sayContainsPress0` is
  permanently false after D4. Decide explicitly: keep (harmless, still correct
  for future copy) or remove with its type member. Do not leave it silently
  dead.
- fake-twilio/test: callEngine, callEngineRecording, callEngineStepApi,
  callEngineVoicemail, intelligenceRest, twimlInterpreter, voiceControl
- fake-twilio/src/engine/engine.ts:294 - the inference D5 depends on

TOOLING AND FIXTURES (NOT typechecked - see R1)

- scripts/dev.mjs:214-223 (D5), scripts/e2e-session.mjs:147,
  scripts/poolNumbersAudit.mjs:16,19,22,42,184,201,226,227 (D6)
- e2e/fixtures/fakeTwilio.ts:32 - raw `process.env` read with a SILENT
  `?? '+15550009999'` default: if missed it does not fail, it quietly keeps
  working against a stale name
- e2e/scenarios/steps.ts:43 (comment)

DOCS: RUNBOOK.md:281,292,585,600-622,705,781; .env.dev.example:40-43;
.env.prod.example:35-38; .env.example:7; the four documents in section 0

TESTS

- app/test: broadcastApi, configRelayLiveProvisioning, contactTimeline,
  helpers/twilioWebhookHarness, inbox.integration, messaging,
  messagingApiBaseUrl, missedCallAutoText, sendMessage, twilioSmsWebhook,
  voiceOutbound, voiceReadiness, voiceTranscriptJobs
- SYSTEM suites for D8, both EXACT-SHAPE `toEqual` asserts that adding a field
  breaks: app/test/systemStatus.service.test.ts:59 (and :3, the PII header
  being amended) and app/test/system.routes.test.ts:51,130,145
- PRESS-0 is pinned in two suites a variable name-grep does NOT find:
  voiceWebhook.test.ts:321 (Digits='0' expects `<Dial>`) and
  founderTriage.test.ts:455,483, whose `not.toContain('reach the team')`
  assertions go VACUOUS once the copy is deleted - rewrite or remove them
  rather than leaving assertions that can no longer fail.
- e2e: fixtures/fakeTwilio, scenarios/steps, public-pages,
  unknown-caller-triage, voice-outbound, voice-transcription,
  pool-numbers-admin

## 7. Testing

- Config: valid parses; blank/whitespace -> undefined and does NOT throw;
  non-E.164 throws; prod+twilio unconfigured throws. twilioSmsWebhook.test.ts:
  1056-1062 rewritten for the singular parser; sendMessage.test.ts:555 deleted.
- Each `[0]` behavior reads the new field, readiness log included.
- `ourNumberKind`: 'business' for the business number; 'pool' for a pool
  number; undefined for a stranger. Both echo defenses keep their drop behavior
  AND all four distinct log lines.
- Press-0: voiceWebhook.test.ts:321 asserts `<Hangup>`; a test asserts the
  relay whisper copy no longer mentions press 0; founderTriage's vacuous
  assertions resolved.
- Dashboard: the block renders for a NON-ADMIN session, the pool table does
  not, and NO admin-only request is fired for that viewer (D7). Accessibility
  -first selectors per e2e/support/selectors.md.
- e2e: the existing flyer assertion (welcome SMS `from` equals the advertised
  flyer number) must stay green.

## 8. Migration and operator impact

- Coordinated secrets change: set `BUSINESS_PHONE_NUMBER` in `.env.dev` /
  `.env.prod`, secrets:push, deploy. Approved 2026-08-06. NO infra action is
  taken by this change - the implementer never runs terraform, secrets:push or
  a deploy; owed ops go in the handback and RUNBOOK.
- Old `OUR_PHONE_NUMBERS` Parameter Store entries become orphans, reported by
  secrets:check, removable with secrets:prune.
- RUNBOOK gains: the corrected definition (the ONE business number, never pool
  numbers), the cutover note (prod = ported 678, dev keeps 404), deletion of
  ORDER MATTERS, and a note that flipping `SMS_SENDING_ENABLED` for go-live is
  an env + secrets:push + deploy operation, NOT a dashboard toggle.

## 9. Risks

- R1. A missed read surface silently changes outward-facing behavior. Deleting
  the old symbol makes missed TYPESCRIPT consumers a typecheck error - but that
  does NOT cover the three `.mjs` scripts, e2e/fixtures/fakeTwilio.ts:32
  (silent `??` default on a raw `process.env` read), any other raw
  `process.env.OUR_PHONE_NUMBERS` access, or documentation. Those are found by
  the section 6 map and a raw-string grep, not by the compiler.
- R2. Press-0 removal is user-facing on a live-call path. Mitigated by being a
  removal (fall-through to existing hangup), not new logic.
- R3. D7's tab flip widens a previously admin-only surface. The fetch-gating
  trap is the concrete risk; covered explicitly in D7 and section 7.
- R4. Deadline 2026-08-10. Independently mergeable order: config rename + docs;
  predicate; press-0; dashboard surfaces.

## 10. Out of scope

- Attaching the ported number to the Messaging Service, and the A2P campaign
  (operator, cutover day). D7 cannot verify either.
- Executing or closing the in-flight operator issues (N6, section 0).
- Moving any flag into `OrgSettings` (N2).
- Pool provisioning and lifecycle (N5).
