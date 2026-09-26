---
id: ai-mode-switch-gates-all-automation
title: The per-conversation AI switch (ai_mode) gates every automated text, not just the AI - redesign it in WP2
type: debt
severity: med
status: deferred
area: app/messaging
created: 2026-09-24
updated: 2026-09-26
refs: app/src/services/sendMessage.ts, app/src/services/scheduledSendSuppression.ts, app/src/lib/import/apply.ts, app/src/jobs/retrySend.ts, app/src/services/oneToOneRetryDecision.ts
---

**Problem.** The architecture doc (section 6, "AI Conversation Layer") defines
`ai_mode` as an AI-only control: `auto` means the assistant replies on its own,
`manual` means the assistant stays silent, keeps listening, and posts a suggested
reply a teammate can send, with Manual as the intended AI default. The same doc
designed the per-conversation circuit breaker to flip a runaway conversation to
Manual. It says nothing about stopping system texts.

The build went further. The one-to-one send wrapper refuses EVERY send marked
automated when the conversation is `manual`, so the switch silently stops: tour
reminders (one-to-one route), the missed-call auto-text, the public sign-up
welcome, the 30003 automatic retry, and (until the share-skip-fix branch)
staff-created property sends. Placement nudges are NOT among them: every nudge
kind is held for manual sending and "Send now" is a person's send, so the
switch never stops one (corrected 2026-09-25 with the share-skip-fix spec). There is no UI or API for the switch; after
creation only the breaker writes it.

The Quo import created every conversation `manual`, so for weeks every imported
contact silently lost all of the above (found via Sam's improvements list item #5,
2026-09-24).

**Cameron's rule (2026-09-24, verbatim, the requirement for the redesign):**

> It sounds like the ai_mode switch is either mislabeled or not functioning as we
> wanted. If it's blocking self-guided tour reminders, missed call texts, and
> especially automatic retries of failed texts, that's not what the description of
> this mode was supposed to be for. As far as I understand, it's supposed to make
> sure that no AI model can have conversations here. Not that automated messages
> can't be applied. Those are two different things.
>
> Things like automatic retries of failed texts, that's not automated or
> AI-related. That's a thing that should go off either way. If somebody sends a
> message, I want it to be retried until it's exhausted or fails.

**Interim state (after the share-skip-fix branch).** Every one-to-one conversation
is switched to `auto` by a one-time operator script; the import creates new
one-to-one conversations `auto`; property sends staff create through the
dashboard are sent as a person's send and never read the switch. The switch therefore only turns off when the
breaker trips, and the script's single-conversation mode (RUNBOOK: "a conversation
tripped the breaker") is the only way back. Relay groups and native group texts
stay hard-coded `manual`; this is inert today because their send paths never read
the switch.

**What Work Package 2 must deliver (Amendment No. 1, conversation layer):**

1. The switch controls ONLY whether the AI may reply in a conversation.
2. System texts never read it: tour reminders, placement nudges, the missed-call
   text, the welcome text, automatic retries, and property sends staff create.
3. A retry follows the original sender: a message a person sent is retried to
   exhaustion regardless of any AI or automation setting.
   **Delivered for the one-to-one 30003 retry (2026-09-26,
   `feat/retry-send-window`, spec D14).** Every one-to-one send now records on
   its message row whether it was automated (`automated`, true or false) and,
   when the caller named a recipient, that contact (`recipient_contact_id`).
   The automatic retry is sent with the original's flag and recipient, and the
   status webhook judges whether to schedule it the same way: a person's text
   is retried as a person's send - manual mode and the breaker do not apply,
   the consent gate does - to exhaustion inside the 15-minute retry window
   (Cameron's ruling, same branch), and an automated original is retried
   automated and breaker-metered, as before. The manual Retry route passes the
   recorded recipient too. A text sent before that deploy carries no flag and
   is retried as before (automated, recipient by phone). Everything else here
   stays Work Package 2's - including, under item 2, the automatic retry of an
   AUTOMATED original (a tour reminder, the missed-call text), which still
   stops on a manual-mode thread.
4. The runaway breaker gets its own stop, separate from the AI switch, with a
   visible resume action.
5. A visible per-conversation control for the AI switch.
6. Decide whether the engine may speak in relay_group and group_text threads.
7. Do NOT read today's `ai_mode = auto` as permission for the engine to reply: the
   share-skip-fix script set `auto` on every one-to-one conversation to restore
   system texts, not to opt anyone into AI replies.
8. Engine-created property sends (Work Package 3, automated sharing to "wants to
   tour") must be created by the engine's own path, never the dashboard's draft
   route. That route records at creation that a send is a person's send, and the
   send job treats any send without that record as automated (share-skip-fix
   D4); an engine send created through the dashboard route would bypass the
   switch and the breaker.

Related: [reminder-state-sent-overstates-delivery](./reminder-state-sent-overstates-delivery.md),
[placement-nudge-suppression-opt-out-parity](./placement-nudge-suppression-opt-out-parity.md).
