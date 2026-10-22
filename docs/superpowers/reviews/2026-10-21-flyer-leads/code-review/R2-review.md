# R2 code review - feat/flyer-leads

- Reviewer: round 2, fresh (single reviewer). Branch `feat/flyer-leads`
  (worktree `W:\tmp\flyer-leads`), HEAD `ce4c33d5`; merge base main
  `0f6f29f9`. Fix wave under review: FW1 `3f150137` + `ee2d18fe`, FW-QA
  `a150db6b`.
- Inputs: `.superpowers/review/flyer-leads-diff-R2.txt`,
  `.superpowers/review/flyer-leads-fixdiff-R2.txt`, the round-1 records in this
  directory plus `../self-qa.md`, the live tree. The spec was opened only to
  check the adjudications' citations.
- Proofs (all throwaway; the tree was clean afterwards, no existing file
  edited, no e2e suite or session started, ports 5174 / 8080 untouched):
  1. `app/test/zz-review-r2-touch-backwards.test.ts` (harness fakes; its
     globalSetup created and dropped its own DynamoDB Local tables, key
     `hctest5pkumz`): 1/1 green, then DELETED. Basis of N3.
  2. A Chromium layout measurement through the project Playwright MCP on an
     inline `about:blank` page carrying the post-fix pin rules (no app, no
     lane, no port). Basis of F1.
  3. Gate 5 re-run at HEAD: `npx eslint` on the branch's 68 TS/TSX files ->
     EXIT 1 with the same 3 baseline errors (`react-hooks/set-state-in-effect`
     at `Timeline.tsx:1626`, `FlyerPage.tsx:212`, `FlyerPage.tsx:230`; normalized
     identical to `.superpowers/sdd/gates/lint-base-1.norm`), 0 new.
  4. ASCII: no non-ASCII byte in any line the branch adds (records included).

| Section | BLOCKER | HIGH | MEDIUM | LOW | INFO |
|---|---|---|---|---|---|
| NEW (round 1 missed) | 0 | 0 | 1 | 2 | 2 |
| FIX-WAVE | 0 | 0 | 1 | 3 | 1 |
| ADJUDICATION challenges | 5 rows (1 missing row, 4 corrections) | | | | |
| PLAUSIBLE | 4 | | | | |

---

## NEW findings (round 1 missed)

### N1. MEDIUM - Follow up says "Sent <date>" for a home that was never texted (OR-26b's second surface)

- Evidence: OR-12 deliberately lists a flyer-latest pair on Follow up once the
  person replies and goes quiet (worklist OR-12; `app/src/lib/listingSendOutcome.ts:87`
  replied outranks signed_up). The item's `sentAt` is the pair's `sentAt`
  (`app/src/services/followUps.ts:185`), which the flyer entry moved to the
  SIGN-UP instant, and `dashboard/src/routes/broadcasts/FollowUpView.tsx:118-119`
  renders it as `Sent <date>` beside "Replied, quiet N days" (`:34-36`).
  OR-26b (worklist.md:241-246) names only the roster row (`Card.tsx:351`);
  Follow up is a separate component nobody listed.
- Reproduction: the branch's own pin `app/test/followUps.test.ts:356-384`
  builds exactly this item - a pair whose ONLY entry is a flyer sign-up
  (`seedFlyerSignUp`, no broadcast), an unknown contact heard from after it ->
  `{ sentAt: <sign-up instant>, outcome: 'replied', name: '+15550100077' }`.
  Rendered, that row reads "Sent <sign-up date> - Last heard from <date>,
  Replied, quiet 1 day" for a property the app never sent.
- Impact: Follow up is the chase list; its words drive what staff text next
  ("following up on the home I sent you"). Reachable whenever a flyer lead
  texts in after signing up and then goes quiet - a common sequence. Same
  file, smaller: `nameOf` (`followUps.ts:87-91`) labels a nameless contact by
  its RAW E.164 (`+15550100077`), while AR13 labels the same contact
  `(555) 010-0077` on the property's Sent to card (`routes/units.ts:207-213`).
- Fix: put FollowUpView into the OR-26b decision (both read the latest
  counted entry's kind - a wire flag from `latestCountedShareKey` - and say
  "Signed up from the flyer <date>" whatever the outcome); use
  `formatPhoneForDisplay` in `nameOf`, or accept and name it in the handback.

### N2. LOW - New-phone sign-ups are now an anonymous inbox / Today / Sent-to noise vector; the hardening issue presents new phones as unchanged

- Evidence: a phone with no holder creates a tenant, sends the welcome, and
  then - new on this branch - pins and marks the thread unread
  (`app/src/routes/public.ts:654-673`, Cameron's D6 call) and, for a shareable
  unitId, writes the flyer entry (`:686-703`), so the junk contact files under
  Interested on that property's Sent to card (`dashboard/src/routes/listing/listingFormat.ts:352`)
  and lands on Today under Unreplied (`app/src/routes/today.ts:784-842`).
  Pinned as intended by `app/test/publicSignupLeads.test.ts:750-761`.
- Delta from main: before, a fake new phone cost one welcome text and left a
  READ thread whose preview is our welcome; now each fake phone is also an
  unread row on top of the inbox, a Today row and a "Signed up" lead on the
  property. `docs/issues/public-signup-abuse-hardening.md:72-75` lists the
  new-phone case under "can NOT" ("gets the same one welcome as before the
  branch") and its whole "CAN" list is about EXISTING contacts.
- Bound: the welcome spend and the per-IP limiter, as before
  (`public-welcome-text-global-cap`).
- Fix: add a "new phones" paragraph to the hardening issue; the per-phone /
  global-ceiling ideas there cover it.

### N3. LOW - The sign-up's unread touch can step a thread's `last_activity_at` backwards (demonstrated)

- Evidence: AR3's ONE clock reading is taken at `public.ts:637`, then
  `hasEventSince` (`:643`) and the pin write (`:661`) run, and only then the
  touch writes `last_activity_at = <that reading>` unconditionally
  (`markSignupUnread`, `:389`; the real `touchLastActivity` is a plain SET,
  `app/src/repos/conversationsRepo.ts:1626-1655`). Any activity landing in
  those two round trips is overwritten with an older instant. The repo
  guards exactly this for its other late writers ("never moves the inbox
  backwards", `app/src/jobs/broadcastFanOut.ts:1477-1488`,
  `app/src/jobs/sendReconcile.ts:973`).
- Reproduction (throwaway, run, deleted): existing tenant + open thread; the
  pin write is spied to land an inbound touch 40 ms after the sign-up's clock
  reading; after the post, the thread keeps the inbound's preview but
  `last_activity_at` is back at the sign-up instant (T0 < T0+40ms).
- Impact: cosmetic - inbox / Today order off by the sign-up's own latency
  (tens of ms). The inbound path's own touch is unguarded too, so the class
  is shared; this one is reached without any second race.
- Fix: read the instant for the touch at the touch, or a guarded touch
  (`last_activity_at < :ts`); or record it as accepted.

### N4. INFO - The flyer's area line has no `overflow-wrap`

- `dashboard/src/routes/public/FlyerPage.module.css:63-66` (`.area`) - the
  heading link (`:43-47`) and the `.title` fallback (`:20-26`) wrap anywhere,
  the area line under an address heading does not, so a long unbroken area
  token overflows the card at 320 px. Areas are short in practice (self-QA
  measured no overflow with a normal area).

### N5. INFO - The completion gates have not run on HEAD

- Battery 1 ran on `3ee55f93`. After FW1 (comments, docs, one test title) and
  FW-QA (CSS, `title`, tests) only subsets ran (FWQA-report "Runs": unit,
  three e2e specs, typecheck, eslint, the dashboard suite). The full
  `npm test`, `npm run smoke` and `npm run e2e` must run on the final HEAD
  before the handback. Gate 5 is clean at HEAD (proof 3 above).

---

## FIX-WAVE findings

### F1. MEDIUM - The QA-1 fix ellipsizes the END of the pin - the typed name - first; on touch it is unrecoverable

- Evidence: the label puts the name LAST ("Signed up from the flyer for
  <address> as <First Last>", `app/src/routes/public.ts:163-166`), and the fix
  clips at the end (`dashboard/src/routes/contact/Timeline.module.css:454-455`
  with `.pillText`'s `text-overflow: ellipsis`, `:471-474`). The `title`
  (`Timeline.tsx:502,506`) is hover-only. FWQA-report.md:92-95 says "A link pin
  still leads to the property" - but the property page does not show the
  typed name either, so a link pin loses it on touch too. The pin is the ONLY
  place the typed name is stored (D4: no rename; the audit carries no name),
  and for an auto-captured unknown contact it is the only name staff have.
- Reproduction (Chromium measurement, post-fix rules, 12 px system-ui): visible
  text per pane width.

  | Pane (viewport) | Label | Visible | Typed name shown |
  |---|---|---|---|
  | 593 px (1280) | the e2e pin, 121 chars | "...GA 30314 as Typed739688 ..." | 12 of 40 chars |
  | 593 px (1280) | self-QA worst-case address, 138 chars | "...Building C 1234 Apartm..." | 0 of 13 |
  | 443 px (1024) | "...12 Oak St, Atlanta, GA 30303 as Keisha Jones", 73 chars | "...GA 30303 as Keisha ..." | 7 of 12 |
  | 351 px (phone) | any of the three flyer pins | the first 50-51 chars | 0 |

  At phone width the fixed prefix plus the address use the whole row, so NO
  flyer pin shows who signed up. Even the branch's own e2e scenario at the
  suite's 1280x720 shows only "Typed739688" of the 40-character name (the
  spec passes because it matches the DOM text, not what is visible).
- Fix: let a pin that does not fit WRAP instead of clipping (`.pill`
  `white-space: normal` plus `overflow-wrap: anywhere` and a smaller radius
  when multi-line - short pins still render on one line), or move the name
  ahead of the address (pin copy is Cameron's). Pin it in e2e with "the label
  span's clientWidth is not less than its scrollWidth" at 1280 and at 375.
  The QA-1 geometry assertions stay valid either way.

### F2. LOW - `title` on every milestone pin, carrying typed control characters

- `Timeline.tsx:502,506` set `title` on EVERY pin in every host (contact,
  tour, placement, relay), so every short, fully visible pin also gets a
  redundant native tooltip. And the pin label keeps interior newlines and
  other control characters from an API caller (`public.ts:209-210` trims the
  ends only): the pill text collapses a newline (`.pill` nowrap), but a
  native tooltip renders it as a line break, so the fix gives the spoofing
  channel of R1-adversarial finding 2(a) a multi-line form ("Tia Moss" /
  "Staff note: cancel the tour"). React escapes it - spoofing, not injection.
- Fix: drop `title` if F1 wraps; otherwise set it from a whitespace-collapsed
  label, and keep the hardening issue's strip-control-characters item.

### F3. LOW - `docs/issues/flyer-signup-decline-click-race.md` misstates the race window

- `:49` says "The window is the route's own read-to-write latency" and `:37`
  "Clock skew between app instances widens the window". There is ONE app
  process (`app/src/lib/events.ts:5-6`), so no inter-instance skew exists
  today. On one clock the order needs the sign-up to read its clock AFTER the
  route's `at` (`app/src/routes/units.ts:1596`) and still land its flyer write
  BEFORE the route's single `setDeclined` (`:1690`) - but after its clock
  reading the sign-up still runs `hasEventSince`, `getByKeyConsistent` and
  `putShareMemory` (2.5 round trips; 5.5 when it also pins and marks), while
  the route sends one write. So it takes a slow or SDK-retried `setDeclined`
  (DynamoDB tail latency), not ordinary latency. Proof B reproduces it only
  by running the sign-up inside the `setDeclined` spy.
- Effect: none on the ruling (low, FILE is right - see the A5 challenge); the
  text should say what actually triggers it so nobody chases skew or
  prioritizes it as an everyday race.

### F4. LOW - `docs/issues/public-signup-abuse-hardening.md`: two statements are inaccurate

- `:18-19` "Before that branch an existing contact's sign-up wrote nothing to
  it except a one-time welcome flag" - main ALSO created a thread when there
  was none (typed `tenant_1to1` even for a landlord) and TEXTED the welcome to
  a never-welcomed existing contact (`git show main:app/src/routes/public.ts`,
  steps 2-3). So (b)'s "CREATING an empty, correctly typed thread" (`:94`) is
  not new; what is new is that the thread is correctly typed, bumped and marked
  unread, while the text is gone.
- The new-phone omission (N2).

### F5. INFO - Refreshed refs in the two older issue files

- `docs/issues/deleted-contact-web-signup-silent.md:29,33` re-point Point 3 (a
  statement the update says "no longer holds") at `public.ts:599-603` /
  `:609-619` - the NEW-contact welcome a deleted holder never reaches. The
  "Net" paragraph's last sentence ("introduced by the send gate - ... the
  public flow's handling of it is not", `:44-45`) no longer describes the
  mechanism either: the deleted path never reaches the gate now. The update
  says that sentence still stands.
- `docs/issues/public-welcome-text-global-cap.md:9-10` was re-stamped
  `updated: 2026-10-21` with two refs FW1 knew were stale (`app.ts:165` -> now
  `app/src/app.ts:185-191`; `rateLimit.ts:81` -> now `:90`). Cheap to refresh
  while the file is open.

Fix-wave code that is sound (details under "Swept and clean"): the `.comms` /
`.pill` CSS, the e2e geometry check, the styles pins, and the FW1 comment
rewrites.

---

## ADJUDICATION challenges

| Row | Counter-evidence | What I would rule |
|---|---|---|
| (missing) OR-26b | The worklist has TWO Cameron items (`build-research/worklist.md:228-246`: OR-26 and OR-26b), and R1-conformance F7 names both, but `adjudications.md` carries only OR-26 (row A4 / C7). With no row and no `docs/issues` entry, OR-26b (a flyer-latest pair whose decline, tour or reply outranks it reads "Sent <sign-up date>") can drop out of the handback. N1 adds its second surface (Follow up). | CAMERON, as a new row covering the roster row (`Card.tsx:351`) AND Follow up (`FollowUpView.tsx:118-119`). |
| A5 / C2 | The reason given ("the window is the route's own read-to-write latency") is not what makes it reachable: on the single app process it needs a slow or retried `setDeclined` (F3). | FILE (low) stands, on the corrected reason; fix the issue text. |
| A3 | The citation is real and covers the case (spec D4, design.md:241-246: "An existing contact with no recorded consent keeps none", plus the ConsentCaptureModal residual). But the follow-up (offer or preselect `web_form` for a contact who signed up) lives only in "the handback" - no `docs/issues` entry. | ACCEPT + FILE a small improvement issue, so the A2P gap reaches the registry where work is triaged. |
| A1 / C1 | Agree with DOC + FILE (a claim per contact and source is a new mechanism). But the approved spec still states the residual as "at most one pin a day per shareable property" (design.md:306-311); FW1 corrected the code comments, GLOSSARY and selectors, not that sentence. | DOC + FILE stands; name the deviation from the spec's stated bound in the handback (the spec is not edited after approval). |
| QA-1 (self-qa.md:76, "fixed") | The fix trades the Send blowout for losing the typed name (F1); FWQA-report.md:92-95 records only "a cut PLAIN pin ... at phone width", which understates it (every flyer pin on a phone, link pins included, and long pins at 1024 / 1280). | Keep QA-1 closed for the Send button; open F1 as a MEDIUM residual (fix it or put it in front of Cameron in the handback). |

No disagreement with A2, A4 / C7 (CAMERON is right: the legend line is a privacy promise and the fix is copy), A6, A7, A8, A9, C3-C10 or P1-P8: their spec citations check out (D6.1 :306-311; D7 :427-434, :456-458, "via is untouched" :408-410).

---

## Round-1 closure check

- A1 / C1 - CLOSED (DOC + FILE): every "at most once" / "see each other" claim is gone or qualified (`public.ts` header :27-44, :120-128, (3a) :622-636; `activityEventsRepo.ts:136-154, :218-223`; the AR12 test header; GLOSSARY; selectors.md:52); the issue is filed with proof A.
- A2 - CLOSED (FILE): `public-signup-abuse-hardening.md` (see F4, N2).
- A3 - ACCEPT stands (see challenge).
- A4 / C7 - OPEN, CAMERON (unchanged by design).
- A5 / C2 - CLOSED (FILE): `flyer-signup-decline-click-race.md` (see F3).
- A6 - CLOSED (DOC): `shareLedger.ts:265-268`.
- A7 - CLOSED (DOC): `shareLedger.ts:271-274`.
- A8 - ACCEPT stands (`contactTimeline.ts:731-732` reads the pair only for pins with no share id or no entry).
- A9 - CLOSED: the three comments are true now (findByPhone readers `inbox.ts:915`, `unreadFeed.ts:539`, `sendMessage.ts:493`; Today `today.ts:1102`; `ledgerEntryCounts` census at `repair-share-outcomes.ts:829`).
- C3 - CLOSED: `shareLedger.ts:7-11`.
- C4 - CLOSED: selectors.md:52 has the line2 form.
- C5 - CLOSED for the public.ts refs and the sentence naming (F5 nits remain).
- C6 - CLOSED: `FlyerPage.tsx:164-168` (trimJsonBody is deep: `app/src/middleware/trimStrings.ts:43-50`) and the test title.
- C8, C9, C10 - ACCEPT stands.
- P1, P4 - CLOSED (FILE): hardening issue points 3 and 4, refs verified.
- P2, P3, P5-P8 - ACCEPT stands.
- QA-1 - CLOSED for Send (RED -> GREEN proven, `fwqa-e2e-red.log:616-648`); residual F1.

---

## PLAUSIBLE (not reproduced)

- P-a. Ledger token contention: a deliberate multi-IP burst of same-pair
  flyer sign-ups timed with a Matching blast can exhaust the BROADCAST entry
  write's re-read bound (`MAX_REAPPLY` 3, `app/src/services/shareLedger.ts:50`,
  loop `:210-223`) -> 'lost' plus ERROR, healed only when the repair script
  runs. Needs concurrency the per-IP limiter only bounds per IP.
- P-b. GSI lag on the new deleted path: `findByPhone` returns the byPhone GSI
  image (`contactsRepo.ts` findByPhone), so a sign-up inside the lag after a
  soft-delete takes the LIVE path (pin, mark, entry on a just-deleted
  contact), and after a restore takes the deleted path (the sign-up is
  dropped to an audit row). The deleted path is new (D4).
- P-c. Zero-width and other format characters survive `.trim()`
  (`public.ts:209-210`): a blank-looking typed name passes the non-empty check
  and pins "... as" followed by nothing visible. The hardening issue's strip
  list names control and bidi characters; it should name format (Cf)
  characters too.
- P-d. A link pin's `title` equals its accessible name, so a screen reader may
  announce it twice as name plus description (engine-dependent).

---

## Swept and clean

- Every `ListingSendOutcome` reader, app and dashboard: `Card.tsx` chip, words
  and actions; `groupSendRows`; `FollowUpView` (never served signed_up;
  P8 Undo pinned); `broadcasts.ts:595-622` (not_interested only);
  `followUps.ts` isWaiting; units, contacts and outcome-route projections all
  pass the stored row with `shares`.
- `signed_up` activity events: the only writer is `public.ts`; readers are the
  timeline merge (`contactTimeline.ts:1376-1389`), `milestoneVariant` /
  `milestoneHref`, the roster removal scan (P1, filed), `hasEventSince`. No AI
  prompt reads activity labels (`services/extraction/*`); `record()` logs no
  label.
- `conversation.updated`: the only server listener is the SSE route
  (`api.ts:2757`); one app process (`lib/events.ts:5-6`), so OR-24's "live"
  holds in production. No AI auto-reply reads `ai_mode` beyond the
  automated-send gate.
- `listing_sends` writers: `putShareMemory` only through the share ledger;
  the repair script writes through `applyShareLedgerEntry` keyed by
  broadcastId, so it keeps the `flyer` entry; dev route and seeds unaffected.
  The flyer write REMOVEs the row's `broadcastId`, which only the wire and the
  legacy seed read (no dashboard reader); `shares` never reaches the wire.
  `summarize`'s tie-break and order are main's (strict `>`), stricter only on
  a non-string `countedAt`.
- Staff-only keys: the only outbound reader is `[Rent]` (`mergeFields.ts:36-37`,
  `resolveTemplate.ts:31`) - A4. No other merge field, AI path or public
  surface reads rent, deposit, pets, accessibility or lease terms.
- Subzone (D9): `similarUnits.ts` is the only comparison.
- byPhone GSI projection is ALL (`dynamoAdmin.ts:56-57`), so the deleted and
  type checks read whole items.
- The QA-1 CSS on every `.comms` host: ContactDetail and the relay view (the
  shell's `.left` row), TourDetail / PlacementConversation (`.channelPane` has
  a single child), GroupTextView (already min-width 0). `min-width: 0` only
  lets the pane shrink; nothing that fitted before moves.
- The e2e geometry check (`flyer-leads.spec.ts:496-524`): it failed RED on all
  three symptoms (`fwqa-e2e-red.log:616-648`), cannot pass vacuously (a HARD
  precondition that the label is wider than the column, plus a hit test that
  must land on Send), and the column is the shell's `.left` (the comms pane
  renders as a fragment child, `ContactCommsPane.tsx` return). `expect.soft`
  still fails the test at the end and keeps the clean-up at `:555` running.
  No e2e `getByTitle` locator can collide with a pin title (3 uses, none a
  pin label).
- `Timeline.styles.test.ts` / `FlyerPage.styles.test.ts`: comment-stripped,
  line-anchored rule matching; `css: false` confirmed (`dashboard/vite.config.ts:147`).
- FW1 comment rewrites are true (see A9 / C3 / C6 lines above).
- The two new issue files: frontmatter valid (`docs/issues/_TEMPLATE.md`
  types), every `refs:` line range matches the live tree.
- Repaired e2e specs keep their coverage (the O1 "No pets" check moved to the
  property page, `property-requirements.spec.ts:474-490`); no spec or
  scenario still drives the old flyer copy.
- `uniquePhone()` cannot mint a number the app rejects (`normalizeToE164`
  checks shape only, `app/src/lib/phone.ts`).
- Roster row and property Sent to card geometry: `.sendRowLine` wraps and the
  dates are inline text (`Card.module.css:253-265`); the flyer at 320 / 375
  was measured by self-QA; the tokens the flyer uses exist and there is no
  dark theme to contrast against.
- Fakes vs real repos: `hasEventSince`, the decline writers' token and
  `putShareMemory` are held by the parity script
  (`twilioWebhookHarnessRepoAdditions.integration.test.ts`); the one known
  divergence (the fake reuses only OPEN threads) is stubbed and named in
  `publicSignupLeads.test.ts:237-256`.
