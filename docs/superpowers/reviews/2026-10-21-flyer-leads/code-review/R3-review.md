# R3 code review - feat/flyer-leads (fix wave 2)

- Reviewer: round 3, fresh, single reviewer. Branch `feat/flyer-leads`
  (worktree `W:\tmp\flyer-leads`), HEAD `fb3dfae0`; merge base main
  `0f6f29f9`. Under review: FW2 `a29e52aa`, `8ea3ebdb`, `41b6f83a`,
  `86fdf53b`, `a3d5cf21` (diff package
  `.superpowers/review/flyer-leads-fixdiff-R3.txt`), read cold, then the
  surfaces it touched in the live tree, then the Round 2 adjudications.
- Inputs: the FW2 diff; `R2-review.md`, `adjudications.md` "Round 2",
  `FW2-report.md` (this directory); the two `fw2-pins-final-*.png`
  screenshots; the live tree; `AGENTS.md`; main `0f6f29f9` for "before".
- Proofs (nothing created or edited in the worktree except this file; no test
  file added; no e2e run or session started; ports 5174 / 8080 untouched;
  read-only until `.superpowers/sdd/gates/battery-2.end` existed, 23:17:53):
  1. Gate battery 2 ran on `fb3dfae0` (logs under `.superpowers/sdd/gates/`):
     typecheck `EXIT:0`; npm test `EXIT:0` (app 526 files / 11024 passed + 1
     skipped, dashboard 265 / 5389, e2e 22 / 508, fake-twilio 34 / 275,
     fake-twilio-web 13 / 111; no `[dynamoAdmin]` line); smoke `EXIT:0`; e2e
     `EXIT:0`, 371 passed in 16.5m, no flaky, `flyer-leads.spec.ts` 4/4;
     gate 5 `lint-head-2.norm` identical to `lint-base-2.norm` (the 3
     pre-existing `react-hooks/set-state-in-effect` errors, Timeline.tsx x1,
     FlyerPage.tsx x2), 0 new. R2 N5 is closed.
  2. A Chromium layout probe through the project Playwright MCP (bundled
     Chrome 155) on an `about:blank` page carrying HEAD's `.stream`, `.day`,
     `.evt`, `.pill` and `.pillText` rules with the tokens resolved (no app,
     no lane, no port). Basis of findings 1, 3 and 5 and of the one-line pin
     sweep. The MCP saved its own page snapshot under the MAIN checkout's
     gitignored `.playwright-mcp/` (as FW2's sessions did), not the worktree.
  3. A node replay of the ten `Timeline.styles.test.ts` regexes against the
     HEAD CSS and in-memory mutations (script in my session scratchpad,
     outside the repo). Basis of finding 1.
  4. ASCII: 0 non-ASCII bytes in the lines FW2 adds (records excluded); this
     file is ASCII.

| Section | BLOCKER | HIGH | MEDIUM | LOW | INFO |
|---|---|---|---|---|---|
| Findings | 0 | 0 | 0 | 4 | 1 |
| Adjudication challenges | 1 (missing rows), plus 2 closure notes | | | | |

---

## Findings

### 1. LOW - The new e2e "whole label visible" check and the styles pins both pass on two plausible edits that hide the typed name again

- Evidence: `expectWholePinLabelVisible`
  (`e2e/tests/dashboard-next/flyer-leads.spec.ts:276-289`) measures the
  label span's OWN overflow (`label.scrollWidth - label.clientWidth`, `:285`)
  and the PIN's box (the `<a>`) against the nearest clipping ancestor
  (`:280-285`). It never compares the label's box with the pin's box, never
  reads the stream's scroll width, and reads nothing vertical. The styles
  pins (`dashboard/src/routes/contact/Timeline.styles.test.ts:44-49`) check
  `white-space` on `.pill` only and say nothing about the pin's height or
  overflow.
- Reproduction (probe 2, the e2e test's own label; 592 px = the stream at the
  1280x720 pane, 351 px = a phone):

  | `.pill` / `.pillText` CSS | helper cut / side | helper passes | on screen |
  |---|---|---|---|
  | HEAD | 0 / 24 | yes | 2 lines (592), 3 lines (351); the stream does not scroll sideways - correct |
  | QA-1 ellipsis (control) | 161 / 24 (592), 402 / 24 (351) | no | the RED FW2 proved (`fw2-e2e-red.log:566-594`) |
  | mutA: `white-space: nowrap` added to `.pillText` | 0 / 24 | YES | the label runs 148 px (592) / 389 px (351) past the pin's right edge; the stream scrolls sideways 124 / 365 px; the typed name is off screen |
  | mutB: `max-height: 24px; overflow: hidden` added to `.pill` | 0 / 24 | YES | a 22 px window (the 24 px pin) centered over a 36 / 54 px label: it cuts through lines 1 and 2 (592) or shows only line 2 of 3 (351); the typed name, at the end, is unreadable or hidden |

  Probe 3: all ten styles-pin regexes pass on mutA and mutB and fail on the
  QA-1 control. The rest of that e2e test passes on both by construction: the
  stream is `overflow: auto`, so the pane keeps its column ((i)) and nothing
  covers Send ((ii)).
- Impact: the pins catch the regression they were written against, but not a
  nowrap moved onto the label or a one-line height cap - both natural
  "keep pins tidy" edits, and each brings F1 back with every check green.
- Fix: in the helper, assert the label's border box lies inside the pin's box
  on all four sides (1 px tolerance) and that the stream does not scroll
  sideways (`expectNoHorizontalOverflowIn(stream, ...)`, already imported at
  `:55`). Optionally pin that `.pillText` sets no `white-space` and `.pill`
  no `height` / `max-height`. Nit, same file: the styles test header
  (`Timeline.styles.test.ts:1-5`) still says the e2e measures 1280x720 only.

### 2. LOW - The hardening issue names `public-welcome-text-global-cap` as the bound on new-phone noise; as filed, that cap keeps capturing the sign-up

- Evidence: `docs/issues/public-signup-abuse-hardening.md:132-134`: "The bound
  is the welcome spend's: the per-IP limiter and
  public-welcome-text-global-cap". That issue's own fix
  (`docs/issues/public-welcome-text-global-cap.md:27-30`): over the ceiling
  "the sign-up is still captured (the lead is not lost) but the welcome is
  held or skipped". So past that ceiling the made-up phone's contact, its
  pin and unread mark (`app/src/routes/public.ts:654-673`), its Today row and
  its Sent to row (`:686-703`) all still land. Today the only bound is the
  per-IP limiter (`app/src/app.ts:185-191`). The same hardening issue's
  Suggested fix (`:176-180`) proposes a separate new-contacts ceiling, which
  `:132` contradicts.
- Impact: someone who builds the welcome cap can believe the new-phone vector
  (R2 N2) is bounded by it.
- Fix: reword `:132-134`, e.g. "Today the only bound is the per-IP limiter.
  public-welcome-text-global-cap, as filed, caps the welcome spend but keeps
  capturing the sign-up past its ceiling, so it would not bound this noise -
  see the new-contacts ceiling under Suggested fix." Optional while there:
  that issue's refs `app.ts:165` and `rateLimit.ts:81` are stale (R2 F5;
  the limiter is `app/src/app.ts:185-191`).

### 3. LOW - Wrapping gives a typed name two shapes the hardening issue's strip list does not name: lines laid out with space separators, and unclipped combining marks

- Evidence: the typed names are only trimmed and length-capped
  (`app/src/routes/public.ts:209-216`) and printed verbatim in the pin
  (`:156-167`). The hardening issue's strip item names "C0/C1 control and
  bidi characters" only (`docs/issues/public-signup-abuse-hardening.md:181-182`);
  R2's P-c (format characters) was not added either.
- (a) Interior space separators (U+2000 to U+200A, U+3000) survive `trim()`
  and do not collapse under the new `white-space: normal`. Probe 2: a typed
  last name of "Moss" + 40 x U+2003 + "STAFF NOTE: tour cancelled - do not
  call" (84 characters, under the 100 cap) renders at the 1280 pane (592 px)
  as three centered lines, the third reading exactly "STAFF NOTE: tour
  cancelled - do not call" - a line of its own inside a green system pin.
  Under QA-1 that text sat behind the ellipsis. R2 F2's multi-line spoof came
  through the `title`, which FW2 removed; the wrap reopens a weaker form of
  it. Forced-break characters do NOT break: U+2028, U+2029, U+0085, VT, FF
  and LF each render on one 24 px line under both the FW2 and the QA-1 CSS
  (probe 2), so there is no newline vector.
- (b) FW2 dropped `overflow: hidden` from `.pillText`
  (`dashboard/src/routes/contact/Timeline.module.css:481-485`; main had it,
  `0f6f29f9:dashboard/src/routes/contact/Timeline.module.css:462-465`), and
  that rule also clipped the label's glyph ink to its line box. Probe 2: "T"
  + 60 combining marks + "ia" (63 characters) inks 85 px above the baseline
  and 50 px below at 12 px, against an 18 px line box, so it now paints over
  the neighboring messages in the stream. Not a new class - an inbound SMS
  body is unclipped too (`.bubble` / `.body`, `Timeline.module.css:220-256`) -
  but the public form makes it anonymous and free.
- Fix (doc, in the issue FW2 already edits): extend the strip item - collapse
  every run of Unicode whitespace in a typed name to one U+0020 (JS `\s`
  covers U+00A0, U+2000 to U+200A, U+2028 / U+2029, U+3000, U+FEFF), drop Cf
  format characters (R2 P-c), and cap combining marks per base character.
  Optional CSS one-liner: `.pill { overflow: hidden }` with NO height cap
  restores main's ink clip without cutting a wrapped line (the pin grows with
  its lines; an element's own overflow never clips its focus outline) - but
  pair it with finding 1's four-side check, or a later `max-height` on that
  rule hides lines silently (mutB).

### 4. LOW - The new A3 issue dates the consent gap to this branch; main never stamped consent on an existing contact either

- Evidence: `docs/issues/consent-capture-ignores-signup-web-form.md:12-15`:
  "Since `feat/flyer-leads` (spec ... D4), a public sign-up ... never changes
  an EXISTING contact, consent included." Main's existing-contact path read
  only `housing_fair_welcomed` (`0f6f29f9:app/src/routes/public.ts:324-329`)
  and its only write to that contact was `housing_fair_welcomed: true`
  (`:399`) - never a consent field. The no-change rule is "the #14 rule, D6
  of 2026-10-12-join-housing-authority-design.md"
  (`docs/superpowers/specs/2026-10-21-flyer-leads-design.md:238-240`). The
  issue says so itself at `:64` ("main never stamped consent on an existing
  contact either").
- Impact: in triage the opening reads as a regression introduced by this
  branch; it is a pre-existing gap the branch makes more visible (the pin and
  unread mark now prompt a reply).
- Fix: one clause, e.g. "As before this branch (the #14 rule) and still under
  flyer-leads D4, a public sign-up never stamps consent on an EXISTING
  contact ...".

### 5. INFO - The pin's radius is a fixed 12 px while its height follows the root font size

- `.pill` `border-radius: var(--radius-lg)` (`Timeline.module.css:450`) is
  px; the pin's height is `--fs-xs` (rem) x 1.5 plus 6 px. Probe 2, one-line
  pin at a root font of 16 / 18 / 20 / 24 px: 24 / 26.3 / 28.5 / 33 px tall,
  so its round ends gain flat runs of 0 / 2.3 / 4.5 / 9 px. `--radius-pill`
  (main, QA-1) kept a capsule at any size. Reaches staff who raise Chrome's
  default font size (zoom scales both and is unaffected).
- Fix (optional): `border-radius: calc(0.75em + 3px)` on `.pill` - half a
  one-line pin at any font size (12 px at the default, so the styles pin's
  value moves with it), and still clear of the text on a wrapped pin.

---

## Adjudication challenges

| Row | Counter-evidence | What I would rule |
|---|---|---|
| (missing) R2 P-a, P-b, P-c, P-d | `adjudications.md` "Round 2" (`:65-104`) carries rows for N1-N5, F1-F5 and OR-26b only; R2's four PLAUSIBLE items (`R2-review.md:253-271`) have no disposition, while Round 1 gave every PLAUSIBLE item a row (P1-P8, `:48-52`). FW2-report "Not in FW2's list" does not name them either, so they can drop out of the handback. | P-d: CLOSED by FW2 (no `title` on either pin variant, `Timeline.tsx:493-511`). P-c: FOLD into the hardening issue's strip item (finding 3). P-a (ledger token contention past `MAX_REAPPLY`) and P-b (byPhone GSI lag on the new deleted path): an ACCEPT or FILE row each. |

Closure notes (no change of ruling):
- F2 (FIX): closed for the `title`; the wrap reopens a weaker multi-line form
  through space separators (finding 3a). Record it as a residual in the
  hardening issue rather than reopen F2.
- N2 (DOC): agreed; the DOC landed with one inaccurate sentence (finding 2).

No disagreement with N1 (label FIX, words to OR-26b), N3 ACCEPT (no reader
uses `last_activity_at` as a watermark: the `<` / `>` readers are the guarded
late writers `broadcastFanOut.ts:1486`, `sendReconcile.ts:973`, `:1090` and
the "best thread" picks `inbox.ts:950`, `:2874` - an ordering among
threads touched within the same tens of ms), N4, N5, F1, F3, F4, F5 ACCEPT or
OR-26b CAMERON: their citations check out.

---

## Round 2 closure check

- N1 label - CLOSED: `nameOf` (`app/src/services/followUps.ts:92-98`) is
  AR13's `recipientLabelOf` rule (`app/src/routes/units.ts:207-213`); pinned
  by `app/test/followUps.test.ts:187`, `:208`, `:393` (RED in
  `fw2-n1-red.log`). N1 words - OPEN, CAMERON (OR-26b).
- N2 - CLOSED with finding 2.
- N3 - ACCEPT stands.
- N4 - CLOSED: `FlyerPage.module.css:63-69`, pin
  `FlyerPage.styles.test.ts:34-36` (RED in `fw2-n4-red.log`).
- N5 - CLOSED: battery 2 on `fb3dfae0` (proof 1).
- F1 - CLOSED: the label wraps at every width (probe 2; the two FW2
  screenshots agree), e2e RED -> GREEN; residuals findings 1 and 5.
- F2 - CLOSED for the `title`; residual finding 3a.
- F3 - CLOSED: the corrected race text checks out line by line (below).
- F4 - CLOSED: the hardening text matches main (below).
- F5 - ACCEPT stands.
- A3 FILE - CLOSED with finding 4.

---

## Swept and clean

**(a) The milestone pin CSS, every host.**
- `.evt`, `.pill` and `.pillText` are rendered only by `MilestonePin`
  (`dashboard/src/routes/contact/Timeline.tsx:493-511`). The module's other
  importer, `ScheduledCard.tsx:10`, uses only `scheduled*` classes; no CSS
  `composes:` reaches them; other components' `.pill` classes are their own
  modules.
- Hosts of `Timeline`: `ContactCommsPane` - the contact page and the tour and
  placement pages' 1:1 tabs (`ContactCommsTab`), the person feed, so
  `signed_up` pins appear there; `TourConversation`'s Group tab (this tour's
  milestones, `TourConversation.tsx:91-100`, labels from `TourDetail.tsx:264`);
  `ConversationDetail` (relay), `GroupTextView` and `PlacementConversation`'s
  group transcript render no milestones (`useRelayThread` / `useGroupThread`
  items are messages, calls and scheduled; `PlacementConversation.tsx:38-39`).
- One-line pins (probe 2): a 0.25 px sweep around the fit point for four real
  labels ("Placement opened - 1450 Joseph Blvd", "Signed up on the join page
  as Ann Lee", "Now also texting from (470) 555-0148", "Tour scheduled")
  found no width that fits the pin yet wraps it; a one-line pin is 24 px
  tall with a 12 px radius (a capsule at the default font) and keeps both
  side rules (157 px each for the /join pin at 592).
- Wrapped pins: the row minus the two 8 px gaps, side rules at 0 width (as
  under QA-1), lines centered, corners clear of the text (13 px text inset;
  the 12 px curve is 4 px in at the first line's 3 px depth). With an
  anywhere-break min-content a pin can no longer widen any flex ancestor at
  all, which is stronger than QA-1's `min-width: 0` alone.
- Focus outline on a wrapped link pin: `a.pill` is a flex item of `.evt`, so
  it is blockified into one box: one rounded outline 4 px out, inside the
  12 px of `.evt` padding plus gap and the stream's padding - not clipped.
- RTL and long words: `overflow-wrap: anywhere` breaks between grapheme
  clusters only where no other break exists; `text-align: center` is
  direction-neutral; LF collapses under `white-space: normal` and no
  forced-break character breaks (probe 2).
- `title` removed from both variants (`Timeline.tsx:503-507`); the accessible
  name is unchanged (`Timeline.test.tsx:485`); no e2e `getByTitle` targets a
  pin (`contacts-list-facets.spec.ts:130`, `email-triage.spec.ts:184,222`).

**(b) Every reader of `FollowUpItem.name`.** Only `FollowUpView`: the row
link's text (`FollowUpView.tsx:112-114`) and five aria-labels (`:136`, `:151`,
`:160`, `:179`, `:190`). Order is server-side by waitingSince, unitId,
contactId (`followUps.ts:203-208`), never the name; groups and resolutions
key on unitId / contactId (`useFollowUps.ts:32`); the route logs counts only
(`app/src/routes/broadcasts.ts:1410-1414`); there is no search, export or
CSV on the tab; `useFollowUpCounts` reads `byUnit` only; Today's
"follow_ups" group is placements, not this type (`buildToday.ts:197-220`).
Every e2e that reads a Follow up row uses a named contact
(`follow-up-tab.spec.ts:36-51`), as does `followUpsApi.test.ts:22`. The
server and dashboard formatters agree (`app/src/lib/phone.ts:73-77`,
`dashboard/src/lib/phone.ts:79-83`: the same NANP regex, non-NANP passed
through). `?? phone` (`followUps.ts:96`) is unreachable for a non-empty
string - harmless, mirrors `units.ts:212`. The changed and new expectations
are exact name lists in order and cannot pass vacuously.

**(c) The flyer `.area`.** `overflow-wrap: anywhere` on the only `.area` use
(`FlyerPage.tsx:330`), a `<p>` stretched across the `.headingGroup` column;
the styles pin is line-anchored and comment-stripped, so `.area` cannot match
another rule.

**(d) The tests.**
- The e2e failed RED for the right reason (`fw2-e2e-red.log:566-594`: cut 161
  at 1280x720 and 442 at 360; the precondition, the QA-1 checks and the
  stream bounds held) and is GREEN in battery 2.
- The one-line precondition is hard, throws if the canvas did not take the
  label's font, and measures a 121-character label against the 593 px column.
- The viewport switch: the stacked layout is CSS only (the
  `twoPaneShell.module.css:132` media query; `useTwoPaneNarrow`,
  `twoPaneShell.ts:34`, only gates side effects), so the 360 measurement
  reads the stacked layout at once. Every assertion after the
  `WIDE_RESTORE` (1280x900) is layout-insensitive - text, visibility, chips,
  buttons, API reads - and `setViewportSize` is per page, so the later tests
  start at the default 1280x720. Nothing later measures something different
  than intended.
- `Timeline.test.tsx:485-497`'s no-title and full-text checks are exact; the
  styles pins fail on the QA-1 control (probe 3) - only finding 1's two
  shapes slip past them.

**(e) The issue files.** Frontmatter valid per `docs/issues/README.md` (`id`
equals the filename; `type`, `severity` and `status` in the taxonomy) in all
three. Every frontmatter and body ref re-read against the live tree and main:
- Decline race: one app process (`app/src/lib/events.ts:5-6`); nothing is
  awaited between `at` (`units.ts:1596`) and `setDeclined` (`:1690`); after its
  clock reading (`public.ts:637`) a sign-up still runs `hasEventSince`
  (`:643`), the pin and mark when not a repeat (`:661-672`) and
  `applyFlyerShareEntry` (`:696`); the client sets no retry policy
  (`app/src/lib/dynamo.ts:61-79`). The corrected "What it takes" is right.
- Hardening: main's existing-contact path (`0f6f29f9:public.ts:324-329`,
  `:378` `tenant_1to1`, `:381-411` the welcome and the flag) matches the new
  text; the new-phone bullets match `public.ts:654-673`, `today.ts:809-841`
  and `listingFormat.ts:352`, pinned by `publicSignupLeads.test.ts:750-761`;
  `public.ts:584` is the typed thread create. Exception: finding 2.
- A3: all twelve refs land (ConsentCaptureModal `:28-109`, the mount
  `ContactCommsPane.tsx:369-371`, `ConsentFields.tsx:57-62`,
  `consentCopy.ts:46-52`, `applyConsentFields` `contacts.ts:325-371`, the
  consent gate `public.ts:205`, the audit `:718-731`, `smsCompliance.ts:66-91`
  and `:101`, `sendMessage.ts:551`, `broadcastFanOut.ts:276-283`,
  `groupMembers.ts:100-125`); the spec quotes (`design.md:241-246`,
  `:249-251`) are verbatim; tour reminders and placement nudges do refuse
  `no_consent` (`tourReminders.ts:1933`, `placementNudges.ts:830`). Exception:
  finding 4.
