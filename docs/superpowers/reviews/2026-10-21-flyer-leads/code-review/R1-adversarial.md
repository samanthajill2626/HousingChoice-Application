# R1 adversarial code review - feat/flyer-leads

- Branch: `feat/flyer-leads` (worktree `W:\tmp\flyer-leads`), HEAD `3ee55f93`, merge-base `0f6f29f9`.
- Input: `.superpowers/review/flyer-leads-diff-R1.txt` plus the live tree. PLAN-BLIND: nothing under
  `docs/superpowers/` was opened (only the existence of this report's own path was tested).
- Gates observed (read-only): battery-1 finished 20:32 - `npm test` EXIT 0, `npm run e2e` 371 passed (15.8m).
- Proofs: after `battery-1.end` existed, one throwaway file `app/test/zz-review-flyer-leads.test.ts`
  (harness fakes only) was run three times (`npx vitest run test/zz-review-flyer-leads.test.ts`; its
  globalSetup/teardown created and dropped its own DynamoDB Local tables, key `hctest5pkumz`) and then
  DELETED. Final run: 5/5 proofs green (A, B, C, D below plus a sequential control). No existing file
  was edited.

Severity counts: BLOCKER 0, HIGH 0, MEDIUM 4, LOW 5, plus 8 PLAUSIBLE / INFO.

---

## CONFIRMED findings

### 1. MEDIUM - The 24-hour pin/bump cap is read-then-write, not atomic: concurrent sign-ups both pin and both bump

- Evidence: `app/src/routes/public.ts:612-647` - one clock read, `activity.hasEventSince(...)` (the
  repeat check), then `activity.record(...)` and `markSignupUnread(...)`. Nothing ties the read to the
  write. The header comment promises "at most once per contact per source ... per 24 hours"
  (`public.ts:30`) and the repo docstring says "two quick sign-ups must see each other's pin"
  (`app/src/repos/activityEventsRepo.ts:142`, AR12) - ConsistentRead only makes that true for
  SEQUENTIAL requests.
- Interleaving: request A evaluates `hasEventSince` -> false; request B evaluates it -> false (A has
  not written yet); A records its pin and bumps; B records its pin and bumps. The window is the time
  between A's Query evaluation and A's PutItem landing (about two DynamoDB round trips).
- Reproduction (proof A): existing tenant + open 1:1 thread + shareable unit; `hasEventSince` wrapped
  so the Query is EVALUATED first and the answer returns 25 ms later (a round trip); two
  `POST /public/housing-fair` in `Promise.all`. Result: both 200, 2 `signed_up` pins,
  `unreadIncrements = ['conv-1','conv-1']`, `unread_count = 2`. Control: the same two posts run
  sequentially give 1 pin.
- Impact: duplicate pins and unread bumps (no text). More importantly the cap is the design's abuse
  fence ("so made-up unitIds cannot multiply pins") and any scripted caller defeats it: 5 parallel
  posts per IP per minute, N IPs.
- Fix: make check-and-claim ONE conditional write - e.g. a claim item keyed `(contactId, source)` with
  `ConditionExpression: attribute_not_exists(pk) OR claimed_at < :since`, SET `claimed_at = :now`;
  only the winner records the pin and bumps. Add a concurrency pin test (the proof above is a
  template).

### 2. MEDIUM - The public sign-up is now an unauthenticated WRITE path into existing records (security charter answer)

Before this branch an existing contact's sign-up wrote nothing to it except a one-time welcome flag.
Now an anonymous caller who knows (or guesses) a phone number - and, for (c), any shareable unitId,
which rides every Matching text's `[FlyerLink]` - can, per request (fence: 5/min per IP):

- (a) Put attacker-chosen text into a staff-visible, system-looking milestone on ANY live contact of
  ANY type (tenant, landlord, partner/caseworker, team_member, unknown):
  `Signed up from the flyer for <address> as <typed first last>` (`public.ts:143-158`, `:636-641`).
  The name is only trimmed (`public.ts:196-203`): up to 2x100 characters, C0/C1 controls and bidi
  overrides kept. This is an impersonation channel ("... as Tia Moss - please cancel my tour").
- (b) Re-open/bump that contact's 1:1 thread to the top of the inbox and mark it unread
  (`touchLastActivity` writes `status = 'open'` and `last_activity_at`, then `incrementUnread`,
  `public.ts:368-389`), CREATING an empty thread when none exists (a landlord/partner gets a
  `landlord_1to1`/`partner_1to1` thread - pinned by the branch's own test "an existing landlord with
  no thread"), which also puts the contact on Today ("Unreplied", or "Needs you now - New unknown
  contact" for `unknown_1to1`, `app/src/routes/today.ts:784-842`).
- (c) For a tenant/unknown contact and a shareable unit, rewrite the pair's properties-sent state on
  EVERY request - the ledger write is deliberately outside the 24 h cap (`public.ts:661-680`):
  `sentAt` moves to now, a "Replied" or "No reply yet" pair becomes "Signed up", files under
  "Interested" on the property card (`dashboard/src/routes/listing/listingFormat.ts:352`) and leaves
  Follow up (`isWaiting`). Pinned as intended by `publicSignupLeads.test.ts` ("a pair already sent,
  with a reply, reads signed_up") and `followUps.test.ts` (D8). Staff have no way to remove a flyer
  entry.
- (d) Multiply (a)/(b) by every shareable unit whose id is known (each unit is its own 24 h source)
  and bypass the cap entirely by concurrency (finding 1).

Checked and NOT possible: texting anyone new beyond the pre-existing new-contact welcome (existing
contacts are no longer texted at all - an improvement); clearing a CURRENT decline (the veto);
learning anything from the answer (`{ ok: true }` always; see P4 for latency); touching a relay group
(the OR-14 guard, `public.ts:369`); a `group_text` thread (never returned by
`createOrGetByParticipantPhone`: its status is `group_open` and it has no phone claim).

- Severity rationale: no data loss and no text, but a qualitative widening of what the public form
  can do to existing records, with a spoofing channel into staff UI.
- Fix options: a per-PHONE (or per-contact) limiter on the existing-contact branch, independent of the
  IP; put the ledger write under the same source window (or skip it when the pair already has a
  counted entry inside the window); render the typed name as quoted, untrusted data
  (`... (name on the form: "...")`) and strip control and bidi characters in `parseHousingFairBody`;
  longer term, a confirmation step (text a link) before a sign-up touches an existing record.

### 3. MEDIUM - An existing contact with no recorded consent keeps none: the form's opt-in is dropped, yet the sign-up invites a reply the consent gate refuses, and every blast skips them

- Evidence: `public.ts:467` ("never changed by a sign-up (no ... consent ...)") and `:692`
  (`consentVersion` is "evidence only, never stamped on an existing contact"). Downstream:
  `app/src/services/sendMessage.ts:551` (a human send to a contact with no `consent_method` throws
  `contact_no_consent`, HTTP 409), `app/src/jobs/broadcastFanOut.ts:276-280` (no consent -> skipped
  `no_consent`, NO send), `app/src/lib/blastAudienceRules.ts:181-182` (`checkedByDefault` requires
  `hasConsent`, seeds included), tour reminders and placement nudges refuse `no_consent` too.
- Reproduction (proof C): existing tenant WITHOUT `consent_method` + thread; flyer sign-up with
  `smsConsent: true` -> 200, thread `unread_count` 1, `consent_method` still undefined; a staff send
  (`automated: false`) through the real send service wired to the world fakes rejects with
  `code: 'contact_no_consent'`.
- Impact: the flyer now promises "We'll text you about this home and others that fit your voucher",
  but for this class of contact (staff-created leads without recorded consent, group-detection stubs,
  imports) no Matching text, tour reminder or nudge will ever be sent, and the first staff reply the
  unread mark invites hits the consent modal - while the person's actual documented opt-in (web form,
  version, instant) exists only in the audit row. Same shape for an opted-out contact: the fresh
  opt-in is silently ignored (conservative, but the visitor is told they will be texted).
- Fix (product call; D4 made it deliberately): on an existing contact with NO `consent_method`,
  record the form's consent (`web_form`, `consent_at` = sign-up instant, `consent_version`) - an
  additive, consent-only exception that never overwrites an existing consent or opt-out - or at least
  say "consented on the form" in the pin and preselect `web_form` in the consent modal. Pin whichever
  is chosen with a test.

### 4. MEDIUM - "Staff only - never leaves the dashboard." is now false for Rent

- Evidence: D2 re-tags Rent min/Rent max `staff_only` (`app/src/lib/requirements.ts:540-541`,
  `dashboard/src/routes/listing/requirements.ts:264-265`); the property forms' legend says
  `Staff only - never leaves the dashboard.` (`dashboard/src/routes/listing/FlyerTag.tsx:36`, rendered
  by `UnitCreateForm.tsx:416` and `ListingEditForm.tsx:305`); the Matching composer's DEFAULT body is
  `... is available for [Rent]/mo ...` (`dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31`),
  resolved with the unit's rent into every new blast (`BroadcastComposer.tsx:447`). The GLOSSARY
  admits "Rent still reaches tenants in one place: the [Rent] merge field"; the form tells staff the
  opposite.
- Impact: the tag is the privacy promise staff use to decide what to type into a field; for Rent it is
  wrong by default. Before this branch Rent was tagged On flyer, so the legend was not contradicted.
- Fix: reword the staff-only legend to what the tag means ("Staff only - not on the public flyer"), or
  give Rent its own hint ("Not on the flyer - the [Rent] merge field still texts it"); pin it in the
  two form tests.

### 5. LOW - A sign-up landing between the outcome route's `at` stamp and its decline write supersedes the staff decline at birth

- Evidence: `app/src/routes/units.ts:1596` stamps `at`; `:1689-1690` calls `setDeclined` with no
  token or sentAt condition; `effectiveDecline` treats `declined.at < sentAt` as superseded
  (`app/src/lib/listingSendOutcome.ts:48-61`). O1's token stamping covers only the OTHER order (a
  decline landing between the flyer's read and write).
- Interleaving: staff click -> route reads the row (`units.ts:1572`) and stamps `at = T`; a public
  sign-up computes `nowIso = T + 3 ms`, reads the row (no decline yet), writes the flyer entry
  (`sentAt = T + 3 ms`); the route's `setDeclined(at = T)` lands; the re-projection derives
  `signed_up`. Clock skew between app instances widens the window.
- Reproduction (proof B): `setDeclined` spied to run a sign-up (5 ms later) before the real write ->
  route answers 200 with `row.outcome === 'signed_up'`; the stored row holds BOTH the staff decline and
  the flyer entry.
- Impact: the staff "Not interested" visibly fails once (a second click works); the design rule "a
  public request never undoes a staff decision" does not hold in this order.
- Fix: condition `setDeclined` on the `shares_op` token the route read at `units.ts:1572`; on a lost
  condition re-read and re-stamp `at` (or answer the current row).

### 6. LOW - The flyer veto ignores tours, so a decline the outcome itself treats as superseded still refuses the entry

- Evidence: `app/src/services/shareLedger.ts:267` - `veto: (row) => effectiveDecline(row ?? {}, undefined)`;
  every outcome reader passes the pair's tour activity for a tenant (`units.ts:279-285`,
  `contacts.ts:1324-1330`).
- Reproduction (proof D): send 10-01, decline 10-02, tour created 10-03 (the pair reads
  `interested`); sign-up -> audit/log `sentSkipped: 'declined'`; tour later canceled -> the pair
  reads `no_reply` (with the entry it would read `signed_up`), so the lead's sign-up is lost from the
  card and the pair can reappear on Follow up as waiting.
- Fix: read the pair's tours in the sign-up path and pass `deriveTourActivityAt`, or state the
  consequence in the veto docstring and GLOSSARY (today only "tours are not consulted" is stated).

### 7. LOW - Flyer-created ledger rows are stamped `via: 'broadcast'`

- Evidence: `app/src/repos/listingSendsRepo.ts:337` - `#via = if_not_exists(#via, :via)` with
  `:via = 'broadcast'` on the first write of ANY share kind, so a row created by
  `applyFlyerShareEntry` stores and serves `via: 'broadcast'`; the type doc says "How the property
  reached the tenant" and the GLOSSARY says the flyer entry "is not a send ... it has no broadcast".
  No reader branches on `via` today (grep of app/src and dashboard/src), so it is latent.
- Fix: let `ShareMemoryWrite` carry the first-write `via` (or a `'flyer'` value), or drop `via` from
  the wire.

### 8. LOW - A flyer entry relabels failed "Property sent" pins (documented residual, still staff-visible misinformation)

- Evidence: `app/src/routes/contactTimeline.ts:731` - a pin with no share id, or whose share's entry
  write was dropped, reads the PAIR; a flyer entry makes the pair count, so a text that FAILED now
  reads "Property sent". Pinned as intended by `contactTimeline.test.ts` ("flyer-leads D7 residual").
- Fix: for the pair-read rung, count only non-flyer entries (a `latestCountedShareKey` variant that
  skips `FLYER_SHARE_KEY`).

### 9. LOW - Comments that overclaim (maintainability traps)

- `public.ts:30` and the D6 docstrings ("at most once per contact per source per 24 hours") and
  `activityEventsRepo.ts:142` (AR12) - false under concurrency (finding 1).
- `public.ts:463-470`: "findByPhone stays the ONE lookup - the same routing read the inbox, the unread
  feed and a staff reply's gates use - so the thread pin, the unread mark and those gates always judge
  the SAME contact". Today attributes a 1:1 thread by `participants[0].contactId`
  (`today.ts:1102-1105`) and `setParticipantsIfAbsent` never relinks, so for a thread whose roster
  names an earlier holder of the number (a phone moved between contacts, a legacy shared phone) the pin
  lands on the findByPhone holder while Today shows the unread row as the roster contact.
- `shareLedger.ts` `ledgerEntryCounts` docstring: latestCountedShareKey "counts exactly these
  entries" - they differ on a non-string `countedAt` (`!== undefined` vs `typeof === 'string'`, e.g.
  `null`), so the repair census and the summary would disagree on such a row (corrupt data only;
  `ledgerEntryFor` never writes one).

---

## PLAUSIBLE (not reproduced)

- P1. Pin floods can block a deferred roster add: `app/src/jobs/rosterActions.ts:236-300` scans at most
  250 of the contact's newest activity events and REFUSES a pending add when the cap is hit. With the
  amplifiers in findings 1-2 an anonymous caller could write 250 `signed_up` pins inside a deferral
  window (about 11 h) and block a staff-confirmed relay add (it WARNs). Needs many IPs or unitIds.
- P2. Tie-break nondeterminism: `latestCountedShareKey` keeps the first entry in `Object.entries` order
  on equal `countedAt`, but DynamoDB does not guarantee map key order, so the write-time summarize
  (`broadcastId`) and a later read-time outcome (`signed_up` vs `no_reply`) can disagree on an
  exact-millisecond tie between a sign-up and a broadcast attempt to the same pair. Very unlikely
  (Twilio instants are whole seconds).
- P3. Pre-existing race the branch now leans on: `findByPhone` is a GSI read, so a person who
  re-submits inside the index lag after a NEW-contact create gets a duplicate contact and a second
  welcome text; D5's "a new contact whose welcome fails is not re-welcomed by a later sign-up" assumes
  the GSI has caught up.
- P4. Latency oracle: the deleted path returns after 2 DB operations, the existing path after about 6,
  the new path after a provider send - response time distinguishes deleted / existing / unknown phones
  despite the constant `{ ok: true }` (the deleted-vs-live split is new).
- P5. The welcome's touch uses Twilio's `providerTs` (`sendMessage.ts:708`); the mark's touch uses the
  local clock read after it. If the provider clock runs ahead, `last_activity_at` steps back slightly.
  Cosmetic.
- P6 (INFO, pre-existing). `phoneMarker` (`public.ts:105-106`) is the first 40 bits of an unsalted
  SHA-256 of the E.164 number; the NANP space (about 2^33) is enumerable, so each "hashed marker" log
  line - now including every step-failure line - is effectively reversible to the phone.
- P7 (INFO). A sign-up raises no push (the inbound path does, `routes/webhooks/twilio.ts:729`), and the
  property Activity card records nothing for it (only the `contacts#` audit) - staff away from the
  inbox are not told.
- P8 (INFO). `FollowUpView`: an Undo answered `signed_up` shows "No reply yet, N days" for the session
  (pinned as intended) - a stale label after a mid-session sign-up.

---

## Swept and clean

- `signed_up` outcome: every app caller of `deriveListingSendOutcome` passes the full stored row with
  `shares` (`units.ts:259/279`, `contacts.ts:1324`, `broadcasts.ts:612`, `followUps.ts:168`); no other
  app switch on the outcome union; dashboard `OutcomeChip`, `SendRosterRow`, `groupSendRows`,
  `FollowUpView` and the Timeline green pin + unit deep link all handle it; `isWaiting` excludes it.
- Matching composer: `alreadySent` comes from broadcast slots (`priorRecipientKeys`), never the
  ledger, so a flyer entry unchecks nobody; `effectiveDeclines` semantics unchanged.
- Repair script: walks broadcast slots only, forecasts through `ledgerWouldChange`/`summarize`
  (flyer-aware; branch test); `broadcastId`s are minted `bcast-<uuid>` server-side, so no collision
  with the `flyer`/`individual` keys.
- Decline writers stamping `shares_op`: `putShareMemory` (via `shareLedger`) is the only token
  reader; the dev fixture writes with `token: undefined` after a create-only check; a legacy row that
  gains a token from a decline is read before the ledger writes; fake parity added to the integration
  script.
- `hasEventSince`: base-table key-range Query, ConsistentRead on every page, `queryAll` to the end,
  type + ref filter; `record()` puts the given `at` in the SK, so the window edge is right; fake parity
  script added.
- Unread mark: event built from the ALL_NEW touch image with the increment's count (the fake's
  touch returns the live object, but the "count incrementUnread RETURNS" test pins the replacement);
  inbox picks up a brand-new thread through its debounced head read on any `conversation.updated`.
- Welcome: new contacts only; a relay pool number hits `RelaySendNotSupportedError` (caught); the
  kill switch takes the refused path.
- `toUnitFlyer`: the ten keys are absent; the parity walk now fails in both directions; no other public
  surface reads them (merge fields: `[Rent]` only - finding 4); the old-bundle argument holds
  (express.static / sendFile send `max-age=0`, the service worker has no fetch handler).
- AR13 `recipientLabelOf`: the real `RECIPIENT_PROJECTION` includes `phone`, matching the fake; the
  contact listings-sent read never carries `tenantName`.
- Subzone (D9): read only by `similarUnits.ts`, so there is no second matcher to drift.
- Type changes: `listing_sends` never block one (`contactHoldings.ts`), so a flyer entry on an unknown
  contact cannot wedge triage.
- PII: the new log lines carry marker/step/ids/enums only; pin labels are never logged
  (`record()` logs type and refs); the public answer is constant.
- ASCII: no non-ASCII character in any added line.
