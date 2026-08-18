---
id: founder-message-template-updates-owed
title: Founder's message-template rewrite (2026-08) - items that could not be applied as text-only edits
type: improvement
severity: med
status: open
area: app
created: 2026-08-17
refs: app/src/messages/catalog.ts, app/src/lib/smsCompliance.ts, app/src/messages/tourCopy.ts, app/src/jobs/relayFanOut.ts, app/src/routes/webhooks/voice.ts, app/src/routes/settings.ts
---

**Problem.** The founder returned an edited copy of the message-template export
(`HousingChoice-Message-Templates.txt`, 2026-08-17) with new wording for most
automated messages. Four categories of her edits could not be applied as a
plain catalog-default text swap and are tracked here so they are not lost.

1. **`missed_call.autotext` dropped the required STOP language.** Her new text
   ("Hey, this is Sam. Sorry I missed your call! ...") has no opt-out line.
   `missed_call.autotext` is `requiresOptOut: true` and its default is pinned
   verbatim against the filed A2P copy
   (`app/test/messages/catalog.test.ts`, `app/test/smsCompliance.test.ts`), and
   the live Settings override path (`app/src/routes/settings.ts` `parsePatch`)
   already rejects any `missedCallAutoText`/`welcomeText` write that fails
   `templateHasOptOutLanguage` (`missing_opt_out_language` error). Her wording
   cannot be saved through the built Settings UI until it keeps a STOP line -
   she needs to fold "Reply STOP to opt out." back into her draft before
   entering it there.

2. **`relay.intro` and `relay.member_added` need tokens that don't exist yet,
   and also dropped STOP language.** Her rewrites reference `{tenant first
   name}`, `{property address without city, state, zip}`, `{landlord first
   name}`, and a role tag - none of which `composeIntroBody` /
   `composeMemberAddedBody` (`app/src/jobs/relayFanOut.ts`) thread today; each
   only receives a computed `{members}` (and `{joined}`) sentence. Both
   entries are also asserted byte-for-byte in
   `app/test/messages/catalog.test.ts` ("compliance copy references
   smsCompliance.ts constants verbatim") because `relay.intro` is a
   first-contact message that must carry brand + trailing opt-out (the A2P
   floor - see the catalog.ts comment above the entry). Left unchanged
   pending the token plumbing below; whatever she resubmits still needs to
   end with the opt-out line.

3. **Tour-reminder personalization needs new composer plumbing.** Most of her
   tour-reminder rewrites reference `{tenant first name}` and/or `{landlord}`,
   neither of which `composeTourReminderBody`
   (`app/src/messages/tourCopy.ts`) accepts - it is the ONE composer for every
   tour-reminder body (enforced by `app/test/tourCopyCallSites.test.ts`) and
   currently only threads `when`/`time`/`where`. Adding a name means changing
   its signature and updating every one of its ~6 call sites, not a
   catalog.ts text edit. Separately, her `tour.confirmation_no_address` and
   `tour.day_before_no_address` rewrites re-add `{where}`/`{Property Address}`
   to the *no-address* twins, which is exactly the split those twins exist to
   avoid (see the token-contract comment atop the tour-reminder block in
   catalog.ts, spec D7). And `tour.no_show_checkin` is deliberately
   token-free today ("when you are not certain someone no-showed, vaguer
   wording is kinder" - spec D2); her rewrite adds a name, which is a product
   call to revisit D2, not just a wiring gap. All of these were left
   unchanged. A companion doc (`HousingChoice-Message-Templates-Available-Tokens.md`,
   sent back to the founder) lists exactly which tokens ARE live for each
   tour-reminder slot today so she can resubmit within that constraint, or
   flag which ones are worth the plumbing work.

4. **Voice `voicemail_prompt` and `voicemail_thanks` were left unchanged.**
   Her rewrite gives both the same generic "please text us your name..."
   line as the other voice fallbacks. But per `routes/webhooks/voice.ts`
   (~line 1408), `voicemail_prompt` is the `<Say>` immediately before
   `<Record>` starts (i.e., it needs to say something like "leave a message
   after the tone"), and `voicemail_thanks` (~line 1427, 1631) plays *after*
   the caller has already left (or attempted) a voicemail. Applying her
   generic line to both would tell a caller to text us right before recording
   them, and thank them for a voicemail with the same "please text us"
   prompt. Likely an unintentional copy/paste across the form fields -
   needs distinct wording from her before either changes.

**What WAS applied** (2026-08-17, `fix/message-template-founder-updates`):
`nudge.rta_window_closing`, `voice.greeting_no_holder`, `voice.self_call`,
`voice.missed_call_goodbye` - all text-only, no new tokens, not pinned by any
compliance test. `welcome.sms` was NOT changed in code: her rewrite is
compliant (keeps STOP, only uses the already-declared `{firstName}` var) but
`WELCOME_SMS` is filed A2P campaign copy pinned verbatim in
`smsCompliance.test.ts`/`catalog.test.ts` - it should be entered as an
operator **override** via Settings > Templates (`welcomeText`), which leaves
the filed default untouched, rather than edited in code. She should spell the
placeholder exactly `{firstName}` when she enters it (her draft wrote
`{Tenant First name}`, which the resolver will not interpolate).

**Suggested fix.** Handle as three follow-ups: (a) get corrected wording with
STOP language for `missed_call.autotext` and relay's two entries; (b) a small
change adding `firstName`/`landlordFirstName` (names TBD) to
`composeTourReminderBody` and its call sites, once the founder confirms which
tour-reminder slots are worth personalizing given the no-address-twin and
spec-D2 constraints; (c) get real, distinct copy for `voicemail_prompt` and
`voicemail_thanks`.
