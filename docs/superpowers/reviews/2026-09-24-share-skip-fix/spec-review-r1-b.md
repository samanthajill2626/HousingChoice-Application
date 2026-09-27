# Spec review r1-b - share-skip-fix design (adversarial, read-only)

Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` at 2ae02544.
Scope: top-level spec. Findings are limited to wrong current-behavior claims,
wrong / missing / ambiguous / contradictory decisions, guarantees the stated
mechanism cannot deliver, and writers or readers the spec never accounts for.
No implementation steps are proposed. Code is cited by file:line (paths under
`app/src/` and `dashboard/src/` unless stated).

---

## F1 [HIGH] D5/D6 treat a `failed` share slot as final, but the system retries failed share texts outside the share

**What is wrong.** D5 says "`skipped` and `failed` never count". D6 says "A
delivery failure un-counts the pair unless another share of it still counts".
D7 says a finished share where no recipient counts reads "Not sent". All three
assume a `failed` slot is the recipient's final outcome. It often is not:

- A 30003 (handset unreachable) callback on a share text does two things on the
  same request. The rollup flips the share slot to `failed`
  (routes/webhooks/twilio.ts:3303-3328, 3576-3581, 3653-3662). The 30003 branch
  then schedules an automatic retry (twilio.ts:3343-3369).
- The retry re-sends the original body through the send wrapper WITHOUT
  `broadcastId` (jobs/retrySend.ts:200-207). The rollup only runs for messages
  stamped with `broadcast_id` (twilio.ts:3312), so the retry's delivery never
  reaches the slot. The slot stays `failed` forever.
- The manual path is the same. The results page sends staff to "open
  conversation to retry" a failed recipient
  (routes/broadcasts/BroadcastResults.tsx:63-67). The conversation Retry route
  re-sends without `broadcastId` (routes/api.ts:1642-1652).
- The codebase already treats this failure as not final elsewhere:
  - Relay legs show "Retrying" and "Delivered on retry", and deliberately offer
    no Retry action while a retry is in flight "to prevent the double-send"
    (routes/contact/deliveryStatus.ts:702-744).
  - One-to-one bubbles collapse a failed message once its retry supersedes it,
    via `retry_of` (services/sendMessage.ts:234-240).

**Consequences of the spec as written:**

- (a) The tenant is not "Already sent" and is pre-checked on the next share of
  the property. That is the double-send the relay design exists to prevent.
- (b) D6 un-counts a ledger pair that exists today. The fan-out writes the row on
  acceptance (jobs/broadcastFanOut.ts:475-489) and nothing removes it now.
  "Properties sent" and "Sent to tenants" would lose a property the tenant
  actually received. That is a regression, not a fix.
- (c) The D6 repair pass is a destructive production write. It would remove
  these rows from history. D1's count of "ledger rows whose share has since
  failed" also overstates the repair.
- (d) D5(c) undercounts, and a one-recipient share reads "Not sent" even though
  the text was delivered.
- (e) I4 ("never re-proposes a tenant whose text is still queued or on its way")
  breaks during the retry chain. The retries run at 60s, 120s and 240s, up to 3
  of them (retrySend.ts:36-42). The slot already reads `failed` while a retry is
  scheduled.
- D2 makes this path common. Today the 30003 retry is refused as `manual_mode`
  on every imported conversation (section 1 claim 4). After D2, those retries run.

**Implies.** The spec must decide how a retried share recipient counts, and
apply that decision to D5(a)-(c), D6 (including the repair and D1's sizing) and
D7. Examples: a failed slot whose message has a delivered retry counts, or a
failure that scheduled an automatic retry does not un-count until the chain
ends. The non-goal "which failures retry" does not excuse the counting rule from
accounting for retries that already happen.

---

## F2 [MEDIUM] D5 counts `queued` unconditionally, which makes shares that will never send permanent "Already sent"

**What is wrong.** D5 counts a slot while it is `queued`. Its only share-level
exclusion is "A draft never counts". Two existing paths leave slots `queued`
permanently:

- **Send-route enqueue failure.** `markSending` sets every slot to `queued`
  (repos/broadcastsRepo.ts:552-578; routes/broadcasts.ts:268-277, 733-736). When
  the enqueue then fails, the share is marked `failed` and no job ever runs
  (broadcasts.ts:756-770).
  - Today `priorRecipientContactIds` skips `failed` shares
    (broadcastsRepo.ts:537), so these tenants are not flagged.
  - A literal D5 build flags every one of them "Already sent" for that property,
    forever, and I4 treats them as "still queued".
- **The stuck throw path.** A non-refusal throw leaves that recipient and every
  later key `queued`, in a share that is never finalized
  (broadcastFanOut.ts:553-564). These count today and still count under D5.
  This part is pre-existing, but D5 now defines such slots as "waiting on our
  side".

**Implies.** Add a share-level condition, for example that `queued` counts only
while the share is `sending`. At minimum, say explicitly that the `queued` slots
of a `failed` share do not count.

---

## F3 [MEDIUM] D5(c) "right for shares already on record" needs a per-row read join the spec does not acknowledge

**What is wrong.**

- The count exists only in the audit row. Finalize writes `tenantCount` as the
  total recipient count (broadcastFanOut.ts:679-685).
- The audit repo is append-only: it has `append` and `listByEntity`, and nothing
  that updates or deletes (repos/auditRepo.ts:36-52).
- I7 allows production writes only by D2 and the D6 repair, so history cannot be
  rewritten.
- The only mechanism left is a read-time join: for every `broadcast_sent` row,
  load the share and recount its slots. That join is needed on two routes:
  - The property Activity route (routes/units.ts:1253, projection at
    units.ts:209). Its label is composed client-side
    (routes/listing/listingFormat.ts:130-136).
  - The landlord timeline. It already fans out to up to 25 owned units, times
    limit+1 audit rows each, per page (routes/contactTimeline.ts:276,
    1294-1315). Its label is composed server-side (contactTimeline.ts:670-678).
- Each share item carries its whole recipients map, up to 1500 slots
  (broadcastsRepo.ts:56-67).
- For the parallel surface, D6 forbids exactly this shape ("stay a direct lookup
  (no per-row join)").

**Implies.** Two builders will diverge:

- one adds the read-time join on both routes;
- one adds a third production repair, which I7 forbids;
- one fixes only future entries, which violates "must be right for shares
  already on record".

The spec should pick one, and either accept the landlord-timeline read cost or
carve history out of D5(c).

---

## F4 [MEDIUM] D7's opted-out row asserts a cause the data cannot support, and collides with existing shared wording for the same code

**What is wrong.**

- **The copy claims a cause.** "Opted out (texted STOP)" is false for several
  opt-out sources. `sms_opt_out` is also set by:
  - the Quo import (lib/import/apply.ts:1029-1033);
  - staff "Do Not Contact" (routes/contacts.ts:1941-1976; its milestone reads
    "Marked Do Not Contact");
  - carrier 21610 suppression (twilio.ts:3498-3505).

  Showing "texted STOP" for a contact staff marked Do Not Contact is
  misinformation. G4 promises the "real reason".
- **The code already has shared wording.** The send wrapper refuses an opt-out
  with code `contact_opted_out` (sendMessage.ts:101-106, 308-318), and the
  fan-out records that code on the slot (broadcastFanOut.ts:495). That code
  already has an entry in the one shared reason map D7 says to extend:
  "Everyone here has opted out - nothing was sent"
  (deliveryStatus.ts:913-914).
  - That wording exists for the group-send aggregate (deliveryStatus.ts:884-891).
  - The map is shared: relay, group and broadcast surfaces all go through
    `deliveryReason` (deliveryStatus.ts:896-911, 952-976).
  - Changing the entry regresses group chips. Reusing it puts a whole-group
    sentence on one recipient's row.
- **Minor, same table.** `no_contact` becomes "No phone number on file". The
  fan-out also writes `no_contact` when the contact record does not exist at all
  (broadcastFanOut.ts:366-368, 636-644).

**Implies.** Use neutral copy, for example "Opted out of texts". Decide per
surface how `contact_opted_out` renders.

---

## F5 [LOW] D5 counts queued, but the ledger has no writer before acceptance, so G3/I3 do not hold for surface (b)

**What is wrong.**

- D6 says a pair "counts as sent while at least one share ... is counted (D5)",
  and D5 counts `queued`.
- Section 5 lists the ledger writers as the fan-out on acceptance, the rollup,
  the repair and seeds. None writes at send time. The row is written only after
  the provider accepts the text and the pacing token is taken
  (broadcastFanOut.ts:417-489).
- Pacing is about one send per second on a shared bucket
  (broadcastFanOut.ts:443-446), so a large blast keeps slots `queued` for many
  minutes. During that time D5(a) says "Already sent", while "Sent to tenants"
  and "Properties sent" do not list the pair.

**Implies.** Either state that surface (b) lags `queued` by design and qualify
G3/I3, or add a send-time writer to section 5.

---

## F6 [LOW] D7 "Counts" names no surface that displays the counts, so it has no observable acceptance

**What is wrong.**

- No staff surface shows skip counts by reason:
  - StatChips folds both skip fields into one "Skipped" chip
    (routes/broadcasts/StatChips.tsx:34).
  - The list shows only delivered/total (BroadcastsList.tsx:151).
- Staff never see `skipped_opted_out` labeled as "opted out". G4's "mislabeling"
  exists only in the wire field name and in one log line.
- That log line is a reader the spec does not list. Finalize logs
  `skipped: stats.skipped_opted_out` (broadcastFanOut.ts:698). It already omits
  no-consent skips and would also omit any new bucket.
- StatChips documents that its buckets sum to Recipients (StatChips.tsx:4-6). A
  new "other skipped" bucket must be added into the Skipped chip, or the row
  stops balancing. D7's "Skipped total unchanged" depends on that.

**Implies.** Either name the surface that shows per-reason counts, or reduce the
decision to "the Skipped total and the finalize log include every skip".

---

## F7 [LOW] D4's "staff user account" test is unspecified and leaves two product questions open

**What is wrong.**

- **No predicate exists, and ids differ by environment.** Production users are
  `usr_<hash>` (repos/usersRepo.ts:188-194). Seeded and dev-login users are
  `user-0001` and `user-0002` (lib/seed/lean.ts:44-45; routes/dev.ts:286-313;
  lib/seed/matrix.ts:1207, 1235). A shape test breaks e2e. A users-table lookup
  is the other reading.
- **Removed team members.** Under a lookup, a draft created by a since-removed
  team member silently becomes an automated send when a colleague sends it.
  Drafts are team-wide and resumable, and the remove-team-member spec treats
  `created_by` as "plain attribution".
- **Creator versus sender.** D4 keys on the draft creator, but G1 says "a share
  a staff member starts". The send route knows who pressed Send
  (broadcasts.ts:584), but stores that only in an audit row
  (broadcasts.ts:772-775). The two are identical today. They diverge for any
  draft that a staff member sends but someone or something else created.

**Implies.** State the recognition rule. Decide how removed members' drafts
behave, and whether the creator or the sender decides.

---

## F8 [LOW] D4 says the WP3 requirement is "recorded in the WP2/WP3 issue text"; it is not

**What is wrong.** A full-text search of
`docs/issues/ai-mode-switch-gates-all-automation.md` finds no mention of WP3, the
creator or identity. D10 files no WP3 issue either.

**Implies.** Add the requirement to the filed issue under D10, or drop the claim.

---

## F9 [LOW] I3 contradicts the D10 deferral

**What is wrong.** I3 says "no surface counts a skipped or failed send as sent".
The tenant timeline's "Property sent" milestone is written on acceptance
(broadcastFanOut.ts:448-467). Per D10 it still reads sent after a delivery
failure. The spec knowingly keeps a surface that violates its own invariant.

**Implies.** Give I3 an explicit carve-out, or the final review will flag the
branch against its own invariant.

---

## F10 [LOW] I4's "never re-proposes" promises more than the mechanism delivers

**What is wrong.**

- **Seeded rows.** In the one-to-one flow this spec is about, seeded rows start
  checked even when "Already sent" (routes/broadcasts/RecipientPreview.tsx:76-79).
  D5(a) is silent on that exception. A builder who follows I4 literally unchecks
  the only row. That triggers the one-to-one Send block and the message "This
  message was written for ..." (RecipientPreview.tsx:119-124, 455-461).
- **Preview-time hint only.** The flag is computed when the preview loads, from
  an eventually consistent index, and the send route never enforces it
  (broadcasts.ts:516-519, 619-620).

**Implies.** Reword I4 to match what D5(a) delivers, and say whether the seeded
exception stays.

---

## F11 [LOW] D2's one-to-one allowlist disagrees with the codebase's own one-to-one rule

**What is wrong.**

- D2 touches only four types: tenant, landlord, partner and unknown-number.
- The repo defines one-to-one negatively: anything that is not `relay_group` or
  `group_text`, including legacy rows with no `type` (lib/unreadFeed.ts:295-297;
  repos/conversationsRepo.ts:86-91, 1737-1740).
- D2 would skip a typeless `manual` row, and G2 ("every one-to-one conversation
  has the switch on") would fail silently.
- Whether such rows exist in production is UNVERIFIED.

**Implies.** D1 should report typeless rows so any gap is visible.

---

## F12 [LOW] Slice 1 sequencing lets a re-run import recreate switched-off conversations before merge

**What is wrong.**

- Section 6 has D2 applied to production before the branch merges, but D3 exists
  only on the branch.
- The import is a supported, re-runnable operator script
  (app/scripts/import-apply.ts:1-8; lib/import/apply.ts:1172-1175). On `main` it
  still creates new one-to-one rows as `manual` (apply.ts:1093, 1107).
- Any import re-run from `main` between D2 apply and deploy recreates the
  problem for newly imported phones.

**Implies.** Say "run imports only from this branch until merge", or "re-run D2
after any import that happens before merge".

---

## F13 [LOW] D7's "every skipped or failed recipient carries a recorded reason" cannot hold for carrier failures without a code

**What is wrong.**

- Twilio `canceled` and `failed` statuses both map to `failed`
  (adapters/messaging.ts:567-569), and such callbacks can arrive with no
  ErrorCode (twilio.ts:3330-3337).
- The rollup copies `errorCode` only when one is present (twilio.ts:3653-3662).
- The D7 table has no row for a failed slot with no code. Its "no reason" row
  covers legacy skips only.

---

## F14 [LOW] The new nouns "share" and "blast" diverge from the GLOSSARY

**What is wrong.**

- The GLOSSARY calls one item a "send" or "property send", and records "Share
  Properties" as drifted copy (documentation/GLOSSARY.md:117-124).
- AGENTS.md requires a GLOSSARY update in the same change whenever a domain noun
  is added.

**Implies.** Risk that "share" and "blast" leak into the D9 RUNBOOK text, issue
text and UI copy.

---

## Section 1 claims - verification

1. VERIFIED. The fan-out sends every recipient `automated: true`
   (broadcastFanOut.ts:417-423).
2. VERIFIED. All gates are in sendMessage.ts:
   - kill switch: 286-289;
   - opt-out, conversation or contact: 304-318;
   - deleted contact: 320-327;
   - just-in-time consent, only when `automated === false`: 329-344;
   - `manual_mode` and the breaker, automated sends only: 346-367.
3. VERIFIED.
   - The import writes `ai_mode = if_not_exists(ai_mode, 'manual')` and types
     one-to-one rows `unknown_1to1` (apply.ts:1087-1107).
   - `setMode` (conversationsRepo.ts:1832-1837) has one caller, the breaker
     (sendMessage.ts:352-358).
   - Creation writes `auto` at conversationsRepo.ts:1273 and 1383, and `manual`
     at 1941 and 2385.
   - No dashboard code reads or writes the switch.
4. VERIFIED. `automated: true` at:
   - tourReminders.ts:1440 (tenant_1to1 route);
   - placementNudges.ts:676;
   - missedCallAutoText.ts:242;
   - public.ts:300 (welcome text);
   - retrySend.ts:205 (30003 retry).

   Refused reminder and nudge rungs are consumed at claim
   (tourReminders.ts:1421-1466; placementNudges.ts:660-700), so D2 releases only
   future rungs. That matches D1's wording.
5. VERIFIED.
   - First-fence skips record no code; refusals record `err.code`
     (broadcastFanOut.ts:381-390 versus 495).
   - Derived stats count every non-`no_consent` skip as opted out
     (broadcastsRepo.ts:249-252).
   - Skipped rows show "Skipped" with no reason (broadcastFormat.ts:98-100;
     DeliveryBadge.tsx:30-31).
6. VERIFIED. Finalize marks `sent` unless every recipient failed
   (broadcastFanOut.ts:690-693); the label comes from broadcastFormat.ts:66-71.
7. VERIFIED. "Already sent" is the union of keys over `sent` and `sending`
   shares, whatever each slot's outcome (broadcastsRepo.ts:524-550; broadcasts.ts
   516-519, 542-544, 564).
8. VERIFIED. The ledger row is written at broadcastFanOut.ts:475-489. The rollup
   (twilio.ts:3557-3688) never touches listing_sends.
9. VERIFIED. broadcastFanOut.ts:679-685; listingFormat.ts:130-136;
   contactTimeline.ts:670-678.
10. VERIFIED. resolveTemplate.ts:24-25 is used by both prefills
    (BroadcastComposer.tsx:186-214); the editor placeholder is at
    MessageEditor.tsx:84.

Other claims checked:

- **Section 5, switch readers "need no change": VERIFIED.** The readers are
  contactTimeline.ts:883 and tourReminders.ts:1034. The placement nudges route
  passes `undefined` (routes/placementNudges.ts:399-401).
- **Section 8 numbers: VERIFIED.** The breaker default is 10 per minute
  (lib/config.ts:991). The share send limit is 5 per minute per user
  (config.ts:1030; broadcasts.ts:577-583).
- **Section 5, ledger writers: VERIFIED complete for production.** The fan-out is
  the only production writer. `via: 'individual'` rows come only from seeds
  (lib/seed/cast.ts:676, 699; matrix.ts:1270, 1277); routes/units.ts:929-932
  confirms there is no individual-send route. D6 does not say how such
  share-less rows count, which is a seed-world concern only.
- **Section 1 prose, architecture doc section 6 meaning of the switch:
  UNVERIFIED.** The source is a .docx
  (documentation/HousingChoice_Architecture_and_Build_Plan.docx).
- **D8, "This matches Sam's screenshot": UNVERIFIED.** There is no screenshot in
  the repo.
