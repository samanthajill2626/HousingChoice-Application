# Share skips, "Already sent", and the one-to-one share message - design

Date: 2026-09-24. Branch: `feat/share-skip-fix`. Source: Sam's improvements list
(2026-09-24) items #5 and #4, under Amendment No. 2 (support). Diagnosis record:
`docs/superpowers/reviews/2026-09-24-share-skip-fix/diagnosis.md`.

This is a TOP-LEVEL spec: it fixes behavior, rules, invariants and the surfaces
they reach. Mechanics (data shapes, function names, file-level tasks, test code)
belong to the implementation plan.

Vocabulary (GLOSSARY): staff-facing copy says "property", tenant-facing says
"home", code says `unit`. A "share" is a broadcast; a "one-to-one share" is a
broadcast with exactly one seeded recipient started from that tenant's file; a
"blast" is a filter-audience broadcast. "The switch" is the per-conversation
`ai_mode` field (`auto` | `manual`). "Counted" is defined in D5.

---

## 1. Problem

What Sam sees:

- #5: a one-to-one share often ends "Skipped", on every retry, for particular
  tenants, although the property is available, the tenant is Searching and consent
  is recorded. Typed messages to the same tenants go through. Afterwards the
  recipient review marks the tenant "Already sent", so Sam pastes the flyer link by
  hand.
- #4: mid-conversation she wants the share to be just the address and the link.

What happens today (verify each claim in the code; the diagnosis confirmed the
first four in production for the tenant Sam named):

1. The broadcast send job sends every recipient through the one-to-one send
   wrapper marked AUTOMATED, even when a staff member clicked Send.
2. The send wrapper refuses an automated send when the conversation's switch is
   `manual` (reason `manual_mode`). A person's send skips that check and is never
   counted by the circuit breaker. Every send still passes the kill switch, the
   opt-out gate and the deleted-contact gate; a person's send also passes the
   just-in-time consent gate.
3. The Quo import creates conversations with the switch `manual` (only when the
   row has no value yet). Nothing turns a switch back on: there is no UI or API,
   and after creation only the breaker writes it (to `manual`, with a
   `mode_changed` audit event, reason `breaker_trip`).
4. The same refusal silently stops every other automated one-to-one text for those
   contacts: tour reminders (one-to-one route), placement nudges, the missed-call
   auto-text, the public sign-up welcome and the 30003 automatic retry.
5. The fan-out records a refusal on the recipient slot as `skipped` with the
   refusal code, but a skip for opt-out or unreachable at its own first fence
   records NO code. Derived stats count every skipped slot except `no_consent`
   as `skipped_opted_out`. The results page shows only "Skipped".
6. A finished share is marked `sent` unless every recipient FAILED; an all-skipped
   share reads "Sent".
7. "Already sent" is the union of recipient keys of every sending/sent share of
   that property, whatever happened to each recipient. Skipped and failed count.
8. The listing-send ledger ("Properties sent" on a contact, "Sent to tenants" on a
   property) gets a row when the carrier accepts a unit-targeted share's text and
   is never updated when delivery later fails.
9. When a unit-targeted share finishes, the property's audit trail records the
   TOTAL recipient count, rendered as "Sent to N tenants" on the property's
   Activity card and on the owning landlord's timeline. Skipped and failed count.
10. Every share - one tenant or fifty - starts from the same default message:
    greeting with first name, bedrooms, address, rent, flyer link.

The switch was designed (architecture doc section 6) as an AI-only control: `auto`
= the assistant replies itself; `manual` = the assistant stays silent and suggests
replies. The build made it gate all automation instead. Cameron decided
(2026-09-24) to fix the harm now and defer the redesign to Work Package 2, filed as
`docs/issues/ai-mode-switch-gates-all-automation.md` with his rule verbatim.

## 2. Goals and non-goals

Goals:

- G1. A share a staff member starts reaches the tenant regardless of the switch.
- G2. Every one-to-one conversation has the switch on, so reminders, nudges,
  missed-call texts, welcome texts and retries work again for imported contacts;
  the import no longer creates switched-off one-to-one conversations.
- G3. One rule decides whether a property counts as sent to a tenant, and every
  surface that says so follows it.
- G4. Every skipped or failed recipient shows its real reason; counts stop
  mislabeling skips as opt-outs.
- G5. A one-to-one share defaults to the full address and the flyer link.
- G6. A breaker trip has a documented, scripted way back.

Non-goals (do not build; each is filed or owned elsewhere):

- The switch redesign: AI-only meaning, a separate breaker stop, retries that
  follow the original sender, a visible per-conversation control, the engine in
  group threads (WP2 issue above).
- Any UI or API that turns the switch on or off.
- Any change to the breaker's cap or behavior, or to which failures retry and how
  often.
- The switch value on relay_group and group_text threads (stays `manual`; inert).
- Which tenants a blast targets (Sam's #6, awaiting her answers).
- The tenant timeline's "Property sent" milestone after a delivery fails (D10).

## 3. Decisions

### D1. Census (read-only operator script)

Reports, counts only, no names, phones or message bodies:

- All conversation rows by type and switch state (claim/pointer items excluded).
- Switched-off conversations by cause: imported (import stamp), breaker trip (a
  `mode_changed` audit event with reason `breaker_trip`), group thread
  (relay_group/group_text, off by design), other.
- Breaker-tripped conversations listed individually (conversation id, type, trip
  time) for Cameron's review.
- Not-yet-sent scheduled texts (tour-reminder rungs, placement nudges) whose
  recipient's one-to-one conversation is switched off: these start sending once D2
  runs.
- Listing-send ledger rows whose share has since failed (sizes the D6 repair).
- Import-created one-to-one conversations missing the one-conversation-per-phone
  claim record (for the D10 issue).

### D2. Fix script: switch every one-to-one conversation on

- Dry run is the default and writes nothing; applying requires an explicit flag.
- Touches only one-to-one conversation types (tenant, landlord, partner,
  unknown-number) whose switch is `manual`. Never relay_group or group_text.
- Bulk mode excludes conversations with a breaker trip on record unless an
  explicit flag includes them; Cameron reviews the D1 list first.
- Single-conversation mode switches one named conversation on (the breaker resume
  path); it refuses a group thread or an unknown id.
- Every write is conditional on the row still being a one-to-one conversation with
  the switch off, so a re-run or a concurrent change is safe.
- Every switch it turns on gets a `mode_changed` audit event (manual to auto) whose
  reason distinguishes a bulk enable from a single resume.
- Output: counts by type (and, for single mode, the one id).
- Target safety: follows the repo's ops-script posture (explicit table prefix, the
  resolved target logged before the first read) and, when pointed at real AWS,
  refuses to run unless the account is 938565869261.
- Only Cameron runs it against dev or prod (or gives an explicit go per run).

### D3. Import default

The import creates NEW one-to-one conversations with the switch `auto`. Group
rows keep `manual`. A re-run never changes an existing conversation's switch
(D2 handles existing rows).

### D4. Staff-started shares are a person's sends

- The send job decides per share from its recorded creator: a staff user account
  (the identity the authenticated dashboard request stamps) means every recipient
  is sent as a person's send; the switch and the breaker do not apply.
- Every other creator - missing, `unknown`, or any future engine identity - is
  automated, exactly as today. Unrecognized means automated (the safe direction).
- Kill switch, opt-out, deleted contact and consent still refuse, for staff shares
  and blasts alike.
- WP3's engine-sent shares must be created under a non-user identity so they stay
  automated (recorded in the WP2/WP3 issue text; nothing to build now).

### D5. One "counted as sent" rule

A recipient of a share counts as sent while their slot is `queued` (waiting on our
side, including a rate-limit retry wait), `sent` (handed to the carrier, confirmed
or not) or `delivered`. `skipped` and `failed` never count. A draft never counts.

Every surface that tells staff a property was sent to a tenant follows it:

- (a) The recipient review list: the "Already sent" tag, the default-unchecked
  state and "Select all" skipping, including tenants added by hand. A tenant whose
  earlier share of the property was skipped or failed is NOT already sent.
- (b) "Properties sent" on a contact and "Sent to tenants" on a property (via D6).
- (c) The property activity entry for a finished share: N counts only counted
  recipients; when N is 0 the entry says nothing was sent. It must be right for
  shares already on record (the tenant Sam named has four).

The rule is computed from stored outcomes, so it corrects history as soon as it
ships. Because `queued` and `sent` count, a second share of the same property
started while the first is still going out shows those tenants as already sent.

### D6. The listing-send ledger follows the rule

- A property-tenant pair counts as sent while at least one share of that property
  to that tenant is counted (D5).
- A delivery failure un-counts the pair unless another share of it still counts
  (an earlier delivered share keeps it counted).
- A later counted share re-counts it.
- A failure reported before the ledger row is written must still un-count it: the
  order of the carrier callback and the ledger write must not matter.
- "Properties sent", "Sent to tenants" and any future matching read show only
  counted pairs, and stay a direct lookup (no per-row join), because Amendment
  No. 1's matching will read this at scale.
- Rows already on record whose share failed are brought in line by a dry-run-first
  repair pass run on Cameron's go after deploy (D1 counts them first).

### D7. Real reasons and honest counts

- Every skipped or failed recipient carries a recorded reason. The first-fence
  skips that record none today get distinct reasons for opted out and unreachable.
- The results page shows each reason in plain words (staff-facing copy lives with
  the dashboard's existing reason wording, not the message catalog):

  | Reason | Shown as |
  |---|---|
  | switch off (`manual_mode`; history and future engine shares) | Automatic texts were off for this conversation |
  | opted out | Opted out (texted STOP) |
  | unreachable | Number can't receive texts |
  | no consent (either consent code) | No texting consent recorded |
  | deleted contact | Contact was deleted |
  | no contact or phone | No phone number on file |
  | breaker | Stopped by the automatic-text safety limit |
  | kill switch | Texting is turned off |
  | rate-limit cap / could not schedule | the existing wording for those two codes |
  | carrier failure | the existing carrier-code wording, else "Delivery failed (error N)" |
  | a skip recorded before this change with no reason | Opted out or number unreachable |
  | any other code | Not sent (code) |

- Counts: "opted out" counts only opt-outs (and reason-less legacy skips); "no
  consent" counts both consent codes; every other skip is counted separately. The
  Skipped total on the results page is unchanged.
- A finished share where no recipient counts reads "Not sent" instead of "Sent"
  on its results page and in the share list. Presentation only: the stored
  lifecycle status and the list's status tabs are unchanged.

### D8. One-to-one share default message (#4)

- In one-recipient mode the composer pre-fills exactly: the property's full
  one-line address (street, city, state, ZIP - the same format the server renders),
  one space, the flyer link. No name, greeting, bedrooms or rent. This matches
  Sam's screenshot.
- Blasts keep today's default. Switching a one-to-one share to filters keeps
  today's reset-to-blast-default behavior.
- No new words are introduced, so nothing is added to the message catalog.

### D9. RUNBOOK: "a conversation tripped the breaker"

How to see why (the alarm log line, the conversation's `mode_changed` event, the
automated sends that preceded it), and how to switch it back on with D2's
single-conversation mode once the cause is understood. Also: how to run D1 and D2
against dev and prod.

### D10. Issues filed by this branch

- `ai-mode-switch-gates-all-automation` (WP2; filed with this spec).
- The tenant timeline's "Property sent" milestone still reads sent after a later
  delivery failure (the failed message bubble on the same timeline shows the
  truth; deferred).
- Import-created conversations lack the one-conversation-per-phone claim record
  (low risk; D1 sizes it).

## 4. Invariants

- I1. Kill switch, opt-out, deleted contact and consent refuse every share,
  whoever started it.
- I2. A share not started by a staff user account is automated (switch and breaker
  apply).
- I3. One definition of "counted as sent" (D5); no surface counts a skipped or
  failed send as sent.
- I4. A second share of a property never re-proposes a tenant whose text is still
  queued or on its way.
- I5. Nothing in this branch turns a switch OFF; only the existing breaker does.
- I6. D2 only ever turns switches on, only on one-to-one conversations, and audits
  every change.
- I7. Production is written only by Cameron-run operator scripts on his explicit
  go (D2, the D6 repair); no infrastructure, index or dependency changes.

## 5. Surfaces (writers and readers the plan must cover)

- The switch. Writers: phone/email conversation creation (auto, unchanged); the
  import (D3); relay group creation and group-text creation/conversion (manual,
  unchanged); the breaker (manual, unchanged); D2 (new); seed fixtures. Readers:
  the send wrapper; the scheduled-send suppression previews (tour reminders panel,
  contact timeline scheduled cards). Readers need no change: after D2 they report
  the new state.
- Share creator. Writers: the draft-create route; seed fixtures (their creators
  must resolve as staff where a test sends them); the future engine. Readers: the
  send job (D4); the share list.
- Recipient outcome (slot status + reason). Writers: the send route (queued), the
  fan-out (sent/skipped/failed, transient deferrals, ladder closes), the delivery
  callback rollup (delivered/failed, carrier-sent marker). Readers: results rows
  and chips, share list stats, derived stats, "already sent" (D5a), the property
  activity count (D5c), finalize, the ledger (D6).
- Ledger. Writers: the fan-out on acceptance, the delivery rollup (D6), the D6
  repair, seed fixtures. Readers: "Properties sent", "Sent to tenants" (and their
  tour-chip join), future matching.
- Property activity entry. Writer: fan-out finalize. Readers: the property
  Activity card and the landlord timeline's property interleave.
- One-to-one default text: the composer's one-recipient mode and the message
  editor's placeholder in that mode.

## 6. Sequencing and rollout

1. Slice 1 - D1, D2, D3, D9, with hermetic tests - is reviewed on its own and
   handed to Cameron before the rest is done. He runs D1, then D2 dry run, then D2
   apply, each on his go. Running it before the rest ships is safe: it only turns
   switches on, and one-to-one shares work for switched-on conversations today.
2. D4-D8 and the D10 filings follow in the same worktree; one whole-branch review
   at the end.
3. After Cameron merges and deploys: the D6 repair pass, dry run first, on his go.

## 7. Testing and acceptance

- Hermetic tests for every decision. For D2: the dry run writes nothing; apply
  switches on only one-to-one `manual` rows; breaker-tripped rows are skipped
  unless included; single mode refuses group threads; a re-run changes nothing;
  every change is audited; a real-AWS run on the wrong account refuses.
- End to end (Playwright harness): a staff one-to-one share to a tenant whose
  conversation is switched off is delivered; a tenant whose earlier share was
  skipped or failed is not "Already sent" while one whose share is queued, sent or
  delivered is; skipped/failed rows show their reasons; an all-skipped share reads
  "Not sent"; the one-to-one default text; the property activity count; "Properties
  sent" drops a failed delivery. The lean seed world needs a switched-off
  one-to-one tenant conversation - a deliberate, reviewed change to that world.
- All five completion gates from AGENTS.md.
- Handback reports: the D1 numbers, the diagnosed cause (done), what D2 changed or
  would change, and every issue filed.

## 8. Risks and accepted tradeoffs

- D2 releases pending automated texts for previously switched-off conversations.
  Intended; D1 counts them before Cameron applies.
- A breaker trip that lands while the bulk run is in progress may be switched back
  on by that run; the breaker re-trips on the next capped minute. Bounded, accepted.
- After D2, `auto` does not mean "the AI may reply" (WP2 must not read it so).
- Staff shares are no longer breaker-metered. A share sends at most one text per
  recipient conversation, so the breaker could only matter for more than ten
  shares to one tenant within a minute; the per-user share rate limit still
  applies.

## 9. For Cameron at the spec gate

- Beyond the approved outline, included as small consistency fixes: D5(c) (the
  property activity count) and the "Not sent" label in D7. Confirm or cut.
- Deferred with an issue rather than built: the tenant timeline "Property sent"
  milestone after a failed delivery (D10).
- The plain-word reason copy in D7.

## Appendix A. Where these live today (orientation, not instructions)

- Send job: `app/src/jobs/broadcastFanOut.ts`. Send wrapper and breaker:
  `app/src/services/sendMessage.ts`. Suppression preview:
  `app/src/services/scheduledSendSuppression.ts`.
- Share routes (draft, preview/"already sent", send, results):
  `app/src/routes/broadcasts.ts`; storage and derived stats:
  `app/src/repos/broadcastsRepo.ts`; delivery rollup:
  `app/src/routes/webhooks/twilio.ts`.
- Ledger: `app/src/repos/listingSendsRepo.ts`, read by `app/src/routes/units.ts`
  and `app/src/routes/contacts.ts`.
- Property activity count: written in the send job's finalize; rendered by
  `dashboard/src/routes/listing/listingFormat.ts` and the landlord interleave in
  `app/src/routes/contactTimeline.ts`.
- Import: `app/src/lib/import/apply.ts`. Conversation creation and the switch:
  `app/src/repos/conversationsRepo.ts`.
- Composer and review: `dashboard/src/routes/broadcasts/` (`BroadcastComposer.tsx`,
  `resolveTemplate.ts`, `RecipientPreview.tsx`, `BroadcastResults.tsx`,
  `broadcastFormat.ts`, `StatChips.tsx`); reason wording:
  `dashboard/src/routes/contact/deliveryStatus.ts`.
- Ops-script precedents: `app/scripts/` (for example
  `retire-paused-tour-reminders.ts`, `measure-unread-contact-coverage.ts`).
