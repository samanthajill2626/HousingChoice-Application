---
id: public-signup-abuse-hardening
title: The public sign-up's 24-hour pin cap is not atomic, and anyone can add staff-visible noise - to a known phone's contact, or with made-up phones
type: security
severity: med
status: open
area: app
created: 2026-10-21
refs: app/src/routes/public.ts:637-673, app/src/repos/activityEventsRepo.ts:136-154, app/src/repos/activityEventsRepo.ts:214-245, app/src/app.ts:185-191, app/src/routes/public.ts:156-167, app/src/routes/public.ts:209-216, app/src/routes/public.ts:686-703, app/src/jobs/rosterActions.ts:236-237, app/src/jobs/rosterActions.ts:261-304, app/src/routes/public.ts:495-528, app/src/routes/public.ts:584, app/src/routes/today.ts:784-840, dashboard/src/routes/listing/listingFormat.ts:352, app/test/publicSignupLeads.test.ts:750-761, dashboard/src/routes/contact/Timeline.module.css:467-471, app/src/services/shareLedger.ts:50, app/src/services/shareLedger.ts:205-224, app/src/jobs/broadcastFanOut.ts:1270, app/src/services/shareAttemptOutcome.ts:188, app/scripts/repair-share-outcomes.ts
---

**Problem.** Since `feat/flyer-leads` (spec
`docs/superpowers/specs/2026-10-21-flyer-leads-design.md` D4-D7),
`POST /public/housing-fair` - the unauthenticated endpoint behind the flyer's
"Sign up" box and /join - writes into an EXISTING contact's records: a
`signed_up` pin in their thread, a bump plus unread mark on their 1:1
conversation and, for a flyer, a `flyer` entry on the properties-sent ledger
(and it leaves the same marks on every NEW contact it creates - "New phones",
under point 2). Before that branch an existing contact's sign-up wrote no pin,
no unread mark and no sent-list entry, but it was not a no-op either (main at
`0f6f29f9`, `app/src/routes/public.ts:376-411`): it created the contact's 1:1
thread when there was none - typed `tenant_1to1`, even for a landlord - and
TEXTED the tenant welcome to an existing contact who had never been welcomed,
then set the one-time welcome flag. The approved spec accepted a per-day
residual for this (D6.1, quoted under "What the spec accepted" below). This
issue is about hardening BEYOND that residual: code review round 1
(`docs/superpowers/reviews/2026-10-21-flyer-leads/code-review/R1-adversarial.md`
findings 1 and 2, P1 and P4; `R1-conformance.md` finding 1) found that the cap
is not exact under concurrency, and set out what the endpoint now lets an
anonymous caller do; round 2 (`R2-review.md` F4 and N2, same directory)
corrected what main did before and added the new-phone case; round 3
(`R3-review.md` findings 2 and 3, with round 2's P-a and P-c) corrected the
new-phone bound and added what a wrapping pin lets a typed name do, the
ledger contention in point 5 and the strip list's wider scope.

**1. The 24-hour cap is read-then-write, not atomic.** The repeat check
(`app/src/routes/public.ts:637-652`) is `activityEventsRepo.hasEventSince`, a
strongly consistent Query (AR12, `activityEventsRepo.ts:214-245`). The pin and
the bump (`public.ts:658-673`) are separate, unconditional writes after it, and
nothing ties the read to the write. So:
- a sign-up that starts after another's pin was written sees that pin and
  skips, so sequential sign-ups pin and bump once per source per 24 hours;
- two OVERLAPPING same-source requests can both read "no pin" before either
  writes, and each pins and each bumps. The window runs from one request's
  Query to its PutItem landing - about two DynamoDB round trips.

The only bound on a burst is then the per-IP `/public` limiter
(`app/src/app.ts:185-191`; `PUBLIC_RATE_LIMIT_MAX`, default 5 requests per
60 s per client IP, `app/src/lib/config.ts:1008-1014`): up to 5 overlapping
posts per IP per minute, times however many IPs the caller has. The flyer page
disables its button while a submit is pending, so this takes an API caller or
two devices. Each extra overlapping request costs one more pin and one more
`unread_count` on a thread that is unread anyway: no text, no data loss. But
the cap is also the fence the spec relies on so that made-up unitIds cannot
multiply pins (they all share the one "no property" source), and concurrency
gets past it.

Reproduction (proof A, adversarial R1; harness world fakes, as in
`app/test/publicSignupLeads.test.ts` - `makeWebhookHarness` with
`PUBLIC_RATE_LIMIT_MAX` raised so no case is rate limited):
1. Seed an existing tenant on the sign-up phone, its open 1:1 thread
   (`conv-1`, `unread_count` 0) and a shareable unit (`status: 'available'`).
2. Wrap `world.activityEventsRepo.hasEventSince` so the original is CALLED
   first (its answer computed at call time, as the Query is evaluated) and the
   answer is returned about 25 ms later (one round trip).
3. Send two `POST /public/housing-fair` for that phone and unitId
   (`smsConsent: true`) in `Promise.all`.
4. Observed: both answer 200 `{ ok: true }`; two `signed_up` pins with the same
   unit ref; `world.unreadIncrements` is `['conv-1', 'conv-1']`; the thread's
   `unread_count` is 2.
5. Control: the same two posts sent one after the other give one pin and one
   bump.

The conformance reviewer reproduced the same shape on /join (the "no property"
source) and on the flyer with a 150 ms delay.

**2. What an anonymous caller who knows a phone can do** (adversarial R1
finding 2), plainly.

It can NOT:
- make the app text anyone new: an existing contact is never welcomed now
  (spec D5), and a phone with no holder gets the same one welcome as before
  the branch (that spend is
  [`public-welcome-text-global-cap`](public-welcome-text-global-cap.md)) -
  though not the same noise around it ("New phones", below);
- clear a current decline: the flyer entry is refused while the pair holds one
  (`app/src/services/shareLedger.ts` applyFlyerShareEntry);
- learn anything from the answer, which is always `{ ok: true }` (but see 4
  for latency);
- touch a relay group or a `group_text` thread (the 1:1-only guard in
  `markSignupUnread`, `public.ts:382-385`).

It CAN, per request, on ANY live contact of any type (tenant, landlord,
partner, team member, unknown):
- (a) put a staff-visible, system-looking pin in the contact's thread whose
  name is text of its choosing: "Signed up from the flyer for `<address>` as
  `<typed first last>`" (`public.ts:156-167`). The names are only trimmed and
  length-capped (`public.ts:209-216`, 100 characters per part), so interior
  newlines, other C0/C1 control characters and bidi overrides are kept: an
  impersonation channel into staff UI (for example "... as Tia Moss - please
  cancel my tour"). React escapes the label, so this is spoofing, not script
  injection. Since the pin WRAPS (code review round 2 F1) the typed text can
  also lay itself out: interior spacing characters (U+2000 to U+200A, U+3000)
  survive `trim()` and do not collapse in the pin, so a run of them pushes
  what follows onto a line of its own - "Moss" plus 40 em spaces (U+2003) plus
  "STAFF NOTE: tour cancelled - do not call", 84 characters, rendered that
  note as the pin's third line (round 3). Forced breaks do not work: LF,
  U+2028, U+2029, U+0085, VT and FF each render on one line. And a stack of
  combining marks ("T" plus 60 marks) inks far above and below its line: since
  round 3 the pin clips ink to its own box (`overflow: hidden` on `.pill`,
  `dashboard/src/routes/contact/Timeline.module.css:467-471`), so the stack
  smears only inside the pin, over its own label, not over the neighboring
  messages. Not a new class - an inbound text's bubble is unclipped too
  (`.bubble` / `.body`, `Timeline.module.css:220-256`) - but the form makes it
  anonymous and free.
- (b) bump the contact's 1:1 thread to the top of the inbox and mark it unread
  (the touch also sets `status` to open), creating the thread when the contact
  has none (`public.ts:584`). Creating it is not new: main created one too,
  typed `tenant_1to1` even for a landlord, and texted the welcome into it when
  the contact had never been welcomed. New is that the thread is correctly
  typed (`conversationTypeFor`), bumped and unread, and that no text goes with
  it. That also puts the contact on Today: under Unreplied, or under Needs you
  now as a "New unknown contact" for an unknown contact
  (`app/src/routes/today.ts:784-840`).
- (c) for a tenant or unknown contact and a shareable unit, rewrite the pair's
  properties-sent state on EVERY request, outside the 24-hour cap
  (`public.ts:686-703`): `sentAt` moves to now, a Replied or No reply yet pair
  reads Signed up, files under Interested on the property's Sent to card and
  leaves Follow up. No writer removes a share entry, so staff's only remedy is
  a decline, which later sign-ups then respect.
- (d) multiply (a) and (b) by every shareable unitId it knows - each is its own
  24-hour source, and unitIds ride every Matching text's flyer link - and get
  past the cap altogether with overlapping requests (point 1).

**New phones** (code review round 2, N2). A phone with NO holder - any made-up
number - still creates a tenant and gets the one welcome, as before the
branch. But before the branch it left only a READ thread whose preview is our
welcome; now each such sign-up ALSO leaves:
- an unread row on top of the inbox: the pin and the unread mark run after the
  welcome (`public.ts:654-673`; Cameron's D6 call that a new sign-up shows as
  unread, pinned by `app/test/publicSignupLeads.test.ts:750-761`);
- a Today row under Unreplied (`app/src/routes/today.ts:809-841`), which a read
  thread never made;
- for a shareable unit's flyer, a "Signed up" row filed under Interested on
  that property's Sent to card (`public.ts:686-703`;
  `dashboard/src/routes/listing/listingFormat.ts:352`).

Today the only bound on this noise is the per-IP `/public` limiter
(`app/src/app.ts:185-191`). [`public-welcome-text-global-cap`](public-welcome-text-global-cap.md),
as filed, would not bound it: past its ceiling it holds back only the
welcome, while "the sign-up is still captured (the lead is not lost)" - so the
contact, the pin, the unread mark, the Today row and the Sent to row all still
land (round 3, `R3-review.md` finding 2). Bounding it takes the new-contacts
ceiling under Suggested fix. A per-phone limit cannot bound it either, since
each made-up phone is used once.

**3. A pin flood can block a deferred relay-group add** (adversarial R1 P1,
not reproduced). The roster job's removal-history scan
(`app/src/jobs/rosterActions.ts:261-304`) reads at most 250 of the contact's
newest activity events (`REMOVAL_SCAN_PAGE_SIZE` 25 times
`REMOVAL_SCAN_MAX_PAGES` 10, `rosterActions.ts:236-237`), and REFUSES a pending
add when it hits that cap before reaching the add's creation instant (WARN
"removal-history scan hit the page cap without reaching the row - refusing the
add"). A caller who writes 250 `signed_up` pins on one contact inside a
deferral window (up to about 11 hours) would block a staff-confirmed relay add.
It needs many shareable unitIds, many IPs, or point 1's overlapping bursts.

**4. Response latency tells a deleted holder from a live one** (adversarial R1
P4, not reproduced). The deleted path (`public.ts:495-528`) answers after the
phone lookup and one audit write; a live holder's path runs about six more
DynamoDB operations (the thread, the roster link, the repeat read, the pin, the
touch and increment, the ledger, the audit); a new phone also waits on the
provider send. So the constant `{ ok: true }` does not hide which kind of phone
was posted. Existing-vs-new was already distinguishable before the branch (the
welcome send); the deleted-vs-live split is new, and low-value.

**5. A burst timed with a Matching blast can cost the blast its ledger
entry** (code review round 2 P-a, not reproduced). Every write to a pair's
properties-sent row - a broadcast's entry (`applyShareLedgerEntry`, from the
fan-out at `app/src/jobs/broadcastFanOut.ts:1270` and the delivery outcome at
`app/src/services/shareAttemptOutcome.ts:188`) and the flyer's
(`applyFlyerShareEntry`, `public.ts:696`) - runs one read-modify-write loop
conditioned on the row's token (`applyLedgerLoop`,
`app/src/services/shareLedger.ts:205-224`): a lost condition re-reads and
re-applies at most `MAX_REAPPLY` (3) times (`shareLedger.ts:50`), then logs
ONE ERROR and answers `'lost'`. Flyer sign-ups for the same unit and phone
from several IPs, overlapping a Matching blast's entry write for that pair,
can move the token on every round and exhaust the broadcast's re-reads: its
entry is lost, with that ERROR line, until the repair script
(`app/scripts/repair-share-outcomes.ts`) runs. The per-IP limiter bounds this
only per IP. A flyer entry can be lost the same way, and the repair never
heals one (it walks broadcast slots only) - but the next sign-up writes a
fresh one.

**What the spec accepted.** Spec D6.1 accepts, as a stated residual, that
someone who knows a phone number can plant at most one pin a day per shareable
property plus one "no property" pin, each carrying a typed name of their
choosing (100 characters per part), with the endpoint's per-IP rate limit
applying; and that the cap governs the pin and the bump only, while the flyer's
sent-list entry (D7) is written on every sign-up it applies to. The round 1
adjudication
(`docs/superpowers/reviews/2026-10-21-flyer-leads/code-review/adjudications.md`,
rows A1 / C1, A2, P1 and P4) kept the build as specified, corrected the
comments that claimed "at most once", and filed this issue for the hardening
beyond that residual.

**Suggested fix.**
- A conditional claim per contact and source: one item keyed by
  (contactId, source), written with a condition such as
  `attribute_not_exists(<key>) OR claimed_at < :since` and
  `SET claimed_at = :now`; only the winner records the pin and the bump. This
  is a new mechanism (spec D6.1 names `hasEventSince` as the check), so it is
  its own change, with proof A as its concurrency pin test.
- A per-phone limit on the existing-contact branch, independent of the IP.
- For made-up phones ("New phones", under point 2), a global ceiling on new
  contacts per window - the shape
  [`public-welcome-text-global-cap`](public-welcome-text-global-cap.md)
  proposes for the welcome spend - since a per-phone limit never sees the same
  made-up phone twice.
- Normalize the typed names in `parseHousingFairBody` (`public.ts:197`)
  BEFORE its non-empty and length checks (`public.ts:209-216`):
  - strip C0/C1 control and bidi characters;
  - drop format (Cf) characters - zero-width ones such as U+200B, U+200C,
    U+200D and U+2060 survive `.trim()`, so a first and a last name of
    nothing but them pass the non-empty checks and the pin reads "... as"
    with nothing visible after it (round 2 P-c);
  - collapse every run of whitespace to one U+0020 (JS `\s` covers U+00A0,
    U+2000 to U+200A, U+2028 / U+2029, U+3000 and U+FEFF), which ends the
    line-layout trick in point 2 (a);
  - cap the combining marks per base character (the stack in point 2 (a); the
    pin now contains its ink, but inside the pin it still smears over the
    label).
- Quote the typed name in the pin as untrusted data (for example
  `... (name on the form: "...")`). A copy call for Cameron: the current pin
  wording is his accepted copy, so the build did not change it.
