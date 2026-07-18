---
id: relay-open-keyword-phantom-1to1
title: Open-path relay keyword mints an empty 1:1 conversation - phantom inbox row + false triage for contactless members
type: bug
severity: low
status: open
area: app
created: 2026-07-17
refs: app/src/routes/webhooks/twilio.ts:456, app/src/routes/inbox.ts:375
---

**Problem.** When a relay-group member texts a bare keyword (STOP/HELP/START)
to their pool number, the open-path handler resolves the sender's 1:1
conversation via `createOrGetByParticipantPhone` so the shared keyword seam
can record the per-phone `sms_opt_out` flag (the compliance substance - see
the relay-open-path-stop design, sec 3.2/3.3). The keyword message itself
stays on the RELAY thread for the audit trail, so when the sender had no
prior 1:1 the minted conversation contains ZERO messages. Consequences in
the staff inbox aggregator:

- a phantom row with an empty preview for that phone, and
- for a CONTACTLESS roster member ({phone, name} with no contact record),
  the row surfaces as an "unknown" needing triage - a false triage prompt
  for a person who is actually a named roster member.

Found by the adversarial review of feat/relay-open-path-stop (repro drove
`aggregateInbox` directly). Narrow blast radius: only a keyword to a pool
number from a phone with NO pre-existing 1:1. Compliance is unaffected
(flags are correct; suppression works).

**Suggested fix.** Product decision needed - candidates, none obviously
right, which is why this was filed instead of fixed in-branch:

1. Inbox aggregator skips conversations with no messages (inbox-wide
   behavior change; may hide other intentional empty threads).
2. The keyword branch also persists the keyword message into the 1:1
   (double-persist of one MessageSid across two threads: dedupe + duplicate
   display risks; the closed-intercept path deliberately writes to exactly
   one thread).
3. Fork the seam: only mint the 1:1 when a flag write is required
   (opt_out/opt_in) and skip it for HELP (forks the one-seam design the
   feature exists to preserve, and opt-in/opt-out still mint).
4. Accept + triage affordance: teach the unknown-triage surface to
   recognize "phone is on a relay roster" and label it instead of
   prompting triage.
