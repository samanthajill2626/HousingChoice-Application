---
id: send-reconcile-hosted-dev-checks
title: Checks owed at the first hosted-dev run of send.reconcile - whether unsent messages are listed, the list's order and paging, the Messaging Service settings that rewrite bodies, and the MMS media count (a possible double text rides on the first)
type: bug
severity: med
status: open
area: app/messaging
created: 2026-09-27
updated: 2026-09-27
refs: docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md, app/src/jobs/sendReconcile.ts:765, app/src/jobs/sendReconcile.ts:801, app/src/jobs/sendReconcile.ts:892, app/src/adapters/messaging.ts:1131, app/src/lib/sendOutcome.ts:48, app/src/lib/sendFingerprint.ts:10, app/src/jobs/sendReconcile.ts:552, app/src/adapters/messaging.ts:624, fake-twilio/src/routes/rest.ts:83
---

**Problem.** The `send.reconcile` job (`feat/send-outcome-reconcile`)
decides whether an ambiguous send went out by LISTING the provider's messages
from the attempt's sender to the recipient (spec D13, D17; `lookup`,
`app/src/jobs/sendReconcile.ts:765-907`; the Twilio driver's `listMessages`,
`app/src/adapters/messaging.ts:1131-1157`). Several facts that walk depends on
were checked only against the hermetic fake and one dev spike, never against
real Twilio in a hosted environment. Spec Sec 10 owes some of them at the
first hosted-dev run; the code review added more (round 1 conformance D-4 and
D-6, round 2 R2C-2, carried by rounds 3 and 4). One checklist:

1. **Are queued / accepted messages listed at all, and where do rows with no
   `date_sent` sort?** (round 2 R2C-2.) The 2026-09-24 spike
   (`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/spike-twilio-idempotency-output.txt`)
   listed To+From right after a create: the just-created message (status
   `accepted`, no `date_sent`) was ABSENT (step [B1]), and 2 s later it was
   present, already `sent` with a `date_sent` (step [B3]). That fits "list
   lag" (the spec's reading) and fits equally "a message is listed only once
   it has a `date_sent`". If the second reading holds, a message held in
   Twilio's queue past the last check (+240 s) is invisible at all three
   checks, is ruled `never_sent` and re-driven, and the recipient gets two
   texts when the queued one goes out. The complete-walk rule (below) does
   not help: the row is on no page. **This is the possible double text, and
   the reason this issue is `med`.**
2. **The list's sort key, paging and page size.** Twilio documents the list
   as sorted by DateSent; the lookup's early stop assumes newest-first by
   creation time (the order is marked UNVERIFIED in the code,
   `sendReconcile.ts:801-817`). After FW4-1 (commit `610e46ba`) and FW5-1
   (`4e7a8154`) the order only prices the walk: the early stop runs only on
   the checks BEFORE the last and only saves their cost (gated `!last` at
   `:852`); `never_sent` needs a COMPLETE walk at the last check
   (`:892-906`); a walk cut at the page bound or ended by a list error judges
   what it read and never rules `never_sent`. So a wrong order now costs a
   later adoption (at +240 s rather than +5 s or +30 s), not a re-send - the
   remaining truth of FW1 residue 5, whose early-stop half FW4-1 superseded.
   Still to see against real Twilio: the sort key; paging by the next-page
   URL (`messaging.ts:1139-1141`, `messages.getPage`); and the page size.
   The driver asks for 1000 (`RECONCILE_LIST_PAGE_SIZE`,
   `app/src/lib/sendOutcome.ts:48`) and logs a WARN "twilio messages list:
   provider page size differs from the requested one" when the provider
   answers another size (`messaging.ts:1142-1150`). The bound is 5 pages
   (`sendOutcome.ts:49`), so a smaller real page size makes the page-bound
   close (see [send-reconcile-job-residues](./send-reconcile-job-residues.md),
   Addendum 2026-09-27, item 12) reachable sooner.
3. **Is Smart Encoding on in the PROD Messaging Service?** The dev service
   has it on (the spike's read-only settings GET,
   `research/spike-twilio-service-settings-output.txt`:
   `smart_encoding=true`). The match does not depend on it - the body is
   normalized to NFKC letters and digits only
   (`app/src/lib/sendFingerprint.ts:9-13`) - but spec Sec 10 asks the record
   to say.
4. **Link shortening and Advanced Opt-Out on the Messaging Service** (round 1
   conformance D-4). Either can rewrite the stored body. The body hash then
   never matches, every candidate is unmatched, and the last check closes
   `unresolved` / `unidentified_candidate` - safe (never `never_sent`), but no
   ambiguous send would ever be ADOPTED: each would read "Not confirmed". The
   round-1 conformance review notes that every share body carries a URL, so
   link shortening would hit every broadcast reconcile.

**What the run should do.** Send to a test number from the hosted-dev stack
and list To+From at once, at about +2 s and at about +30 s (item 1); list a
recipient with more than one page of history - or request a small page size
from a script - to see the order, the next-page paging and the page size
(item 2); and read the Messaging Service settings, dev and prod, for Smart
Encoding, link shortening and Advanced Opt-Out (items 3 and 4). The prod read
is the human's to run or authorize.

**If item 1 finds unsent messages unlisted.** No fix was designed. It would
reopen D13's timing: for example a last check late enough that a queued
message has left the queue, or no `never_sent` while the provider could still
be holding one.

**Why it was not done on the branch.** Every item needs real Twilio in a
hosted environment; spec Sec 10 places them after merge, at the first
hosted-dev run, and agents do not act against hosted or live stacks without
the human's request.

**Related.** [send-reconcile-job-residues](./send-reconcile-job-residues.md),
[send-attempt-rearm-residues](./send-attempt-rearm-residues.md) (the other
double-text windows), [send-attempt-sweeper](./send-attempt-sweeper.md).

## Addendum 2026-09-27 - planner post-build review: the media half of the fingerprint

Found by the planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), conformance finding P-5
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/conformance.md`).
Anchors at HEAD `91a66577`.

5. **Does Twilio report an outbound MMS's media count as submitted, and is
   the MMS Converter on?** Items 3 and 4 check the BODY half of the D13
   fingerprint. The match also requires the provider's media count to equal
   the attempt's (`matches`, `app/src/jobs/sendReconcile.ts:552-554`); the
   driver reads it from the listed or fetched message's `num_media`
   (`app/src/adapters/messaging.ts:624-631`). Two things could break that for
   every outbound MMS: Twilio's listed/fetched `num_media` differing from the
   number of media URLs submitted, and the Messaging Service's MMS Converter
   (which can deliver media as a link in the body - changing both the body
   and the media count). Either would leave every relay photo leg unmatched:
   `unresolved`, "Not confirmed", never adopted - the safe direction, never
   a re-send. No test can see it: the fake stores
   `num_media = mediaUrls.length` (`fake-twilio/src/routes/rest.ts:83`).
   **What the run should add:** send an MMS with a known number of media
   URLs from the hosted-dev stack, list and fetch it, and compare `num_media`;
   and read the MMS Converter setting on the dev and prod Messaging Services
   alongside items 3 and 4 (the prod read is the human's to run or
   authorize). Broadcasts carry no media today, so this is relay-only until
   [broadcast-mms](./broadcast-mms.md) lands (see also
   [send-attempt-facts-dead-and-duplicated](./send-attempt-facts-dead-and-duplicated.md),
   item 2). Not a double text: an unmatched candidate withholds `never_sent`.
