---
id: opt-out-writers-skip-number-thread
title: Three opt-out writers flag only the contact, not the number's thread, so a real STOP reads as a staff Do-Not-Contact
type: bug
severity: med
status: open
area: app/messaging
created: 2026-10-22
refs: app/src/routes/webhooks/twilio.ts:3953-4001, app/src/routes/webhooks/twilio.ts:3982-3995, app/src/routes/webhooks/twilio.ts:1232, app/src/services/groupReceipts.ts:300, app/src/services/groupReceipts.ts:301-318, app/src/lib/import/apply.ts:1232-1236, app/src/services/numberSuppression.ts:141-143, app/src/services/numberSuppression.ts:152-160, app/src/routes/public.ts:182-186, app/src/routes/public.ts:726-733, app/src/services/sendMessage.ts:512-515, app/src/routes/contacts.ts:2253-2301, dashboard/src/routes/contact/Timeline.tsx:97, dashboard/src/routes/contact/ContactActionsMenu.tsx:207
---

**Problem.** The app records an opt-out on two flags: the contact's
`sms_opt_out` and the number's own 1:1 thread's `sms_opt_out`. Only the
inbound STOP keyword path writes both, through `applyNumberSuppression`
(`app/src/routes/webhooks/twilio.ts:1232`,
`app/src/services/numberSuppression.ts:152-160`). Three other writers of a
real opt-out leave the thread flag unset:
- **The 1:1 21610 receipt arm** (`twilio.ts:3953-4001`). On the contact's
  primary number it sets only the contact flag (`:3982-3995`); on a
  secondary number it sets nothing at all, so the app keeps sending into
  Twilio's block.
- **The native-group 21610 receipt** (`app/src/services/groupReceipts.ts:300`).
  It returns early when `readNumberSuppression` already answers suppressed,
  which the contact flag alone makes true, so the member's 1:1 thread is
  never flagged.
- **The importer** (`app/src/lib/import/apply.ts:1232-1236`). A STOP in the
  imported history sets only the contact flag, again on every
  import:apply. Twilio never saw that STOP, so the app's flag is the
  person's only protection.

The staff Do-Not-Contact toggle (`app/src/routes/contacts.ts:2253-2301`)
also sets only the contact flag, by design. So the app cannot tell a real
opt-out from a staff mark, and staff copy treats every case as the staff
mark:
- **The sign-up pin** (flyer-leads FW-P3). It ends with
  " (marked Do-Not-Contact - texts stay off unless staff choose Allow SMS)"
  whenever only the contact flag is set (`app/src/routes/public.ts:182-186`,
  chosen at `:726-733`). For a 21610, Allow SMS earns another 21610 and a
  re-flag, and the remedy that works (the person texts START) is not shown.
  For an imported STOP, Allow SMS lifts a legal STOP, prompted by a public
  form anyone can submit, and the next import:apply sets it again.
  Cameron kept these words (2026-10-22, flyer-leads planner review P4,
  option (b): "File the problem note code change"); the fix belongs in the
  writers.
- **The composer's refusal copy**, older than flyer-leads
  (`dashboard/src/routes/contact/Timeline.tsx:97`): "Clear the opt-out from
  the ... menu to message them", for every cause. "Allow SMS (clear
  opt-out)" (`ContactActionsMenu.tsx:207`) clears only the contact flag,
  while the send gate refuses on either flag
  (`app/src/services/sendMessage.ts:512-515`). For a keyword STOP (both
  flags) that is a dead end, a safe one since Twilio blocks anyway. For an
  imported STOP it lifts a legal one.

**Also: a START clears only the thread it lands on**
(`numberSuppression.ts:152-160` writes one target). When a number has two
1:1 threads - an import run writes its own thread, with no phone claim,
beside a live one - the other thread keeps its flag after the person texts
START. `readNumberSuppression` and the sign-up pin's "any 1:1 thread" rule
(`isNumberThreadOptedOut`, `numberSuppression.ts:141-143`) then still read a
STOP, and the pin keeps telling staff the person must text START.

Traced from the flyer-leads FW-P3 report and planner review P4
(`P4-conformance.md` P4-F1 to P4-F3, `P4-adversarial.md` L1 and L3), in
`docs/superpowers/reviews/2026-10-21-flyer-leads/planner-review/`.

**Suggested fix.**
- Route the 1:1 21610 arm through `applyNumberSuppression`, as
  `groupReceipts.ts:301-318` already does, using the conversation it
  already reads at `twilio.ts:3959`. A secondary-number 21610 then flags
  that number's thread too.
- In `groupReceipts.ts`, write the member's 1:1 thread flag when only the
  contact flag answers suppressed, instead of returning early.
- In the importer, also set `sms_opt_out` on the person's imported 1:1
  thread when the history holds a STOP.
- Repair the rows the old 21610 arm already wrote: its
  `sms_opt_out_recorded` audit rows (`source: 'twilio_21610'`) carry the
  `conversationId`. Running that repair is Cameron's call.
- Then the sign-up pin gives these contacts the START note with no change
  to `public.ts`, and the composer copy and the Allow SMS item can tell a
  STOP (thread flag) from a staff mark (contact flag only) the same way.
- For the START gap: clear every 1:1 thread of the number on a START, or
  have the "any thread" rule ignore a flag older than the number's last
  START.
