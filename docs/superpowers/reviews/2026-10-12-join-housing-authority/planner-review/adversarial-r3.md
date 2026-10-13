# Adversarial review, round 3 - feat/join-housing-authority

Reviewer: the same plan-blind adversarial reviewer as rounds 1 and 2. This round covers:
- fix wave 2: `git diff 0eb44652 61d96320`, the backfill script, its test and RUNBOOK;
- the main merge at 0a36e677, which brought in fix/caseworker-integrity and
  fix/public-rate-limit-key;
- the round-2 adjudications.

Read-only: no suite, script, database or network was touched. Unless marked
otherwise, line numbers refer to the merged tip 0a36e677. The backfill script
was read with `git show 0a36e677:app/scripts/backfill-join-housing-authority.ts`.

## Result: an empty round

No BLOCKING, HIGH, MEDIUM or LOW finding. The two INFO notes at the end need no
change.

---

## 1. Where this branch meets the two merged branches

**No contact-repo seam changed.** The merge does not touch
app/src/repos/contactsRepo.ts, extractionRepo.ts, routes/public.ts or
services/publicOrgList.ts (`git diff 61d96320 0a36e677 --stat` on those paths
is empty).
- The backfill's guarded write is unchanged: contactsRepo.update with
  `expect` [housingAuthority absent, type = tenant] plus `notDeleted`.
- So are the public create and the pending-suggestion and dismissal reads.

**The contact-type guards agree with this branch.** I1 (tenant facts only on a
contact typed `tenant`) is what both writers already do:
- The /join create writes a housing authority only on a NEW contact, which it
  creates typed `tenant` (public.ts:340-371). An existing contact is never
  written.
- The backfill conditions its write on `type = tenant` (backfill :757-770).

I2 (the tenant of an open tour or placement must be typed tenant,
contactTypeGuards.ts:66-77) is met by every /join contact. The tenant-status
derivation now skips non-tenants (services/statusTransition.ts, the new
`contact.type !== 'tenant'` early return). A /join contact starts at
`onboarding` as a tenant, so derivation still runs for it.

**The suggestion-resolution changes leave the backfill's reads valid.**
- The new fence adds `classification_revision` to the guard of every
  tenant-only accept (suggestionResolution.ts, withClassificationFence;
  TENANT_ONLY_TARGETS includes housingAuthority, runTypes.ts).
- contactsRepo.update bumps classification_revision only on a type or role
  change (contactsRepo.ts:1468-1470 and 1494-1502 in the round-1 numbering;
  file unchanged by the merge). Neither the /join create nor the backfill's
  housingAuthority write moves it, so neither can turn a staff accept into a
  reclassification refusal.
- A staff accept that commits after the backfill wrote still ends
  `superseded_by_human_edit`, as before. FW2-3 covers that window except the
  accepted fw2 L1 edge.
- The record the backfill reads is unchanged. `get` is still one consistent
  GetItem of `resolve#<contactId>#<target>` (suggestionResolutionRepo.ts:586-593),
  and its state is still `active` or `completed`.
- The new `superseded_by_reclassification` outcome is stored exactly like a
  human-edit refusal (suggestionResolutionRepo.ts:161-168), so it is never
  `active` for longer than any other refusal.
- The dismissal key is identical on both sides: the resolution repo writes
  `dism#<contactId>#<target>#<normalized>` (:267) and extractionRepo.hasDismissal
  reads the same format (extractionRepo.ts:271, 739-743).

**The audit-history rule is still complete.**
- The merged conversion is a refactor onto contactHoldings.ts; its
  `contact_updated` payload shape is unchanged.
- The contacts PATCH gains a type-change refusal that runs before any write and
  appends nothing (routes/contacts.ts, typeChangeRefusals block).
- No new contact audit event type and no new housingAuthority writer arrived.

**The rate-limit key.**
- The list read's limiter passes `keyOf: deps.rateLimitKeyOf`, which is
  undefined in production (public.ts:497). createRateLimit falls back to the
  default resolver (`opts.keyOf ?? clientIpOf`), so the list read now keys on
  CloudFront-Viewer-Address, with the socket address as the fallback
  (rateLimit.ts, clientIpOf). It no longer reads X-Forwarded-For.
- None of this branch's tests or e2e specs sends X-Forwarded-For; only
  app/test/rateLimitClientKey.test.ts does. The publicIntake limiter tests use
  the socket key, which is what they used before too.
- The merge changed no infra, Vite or e2e-session file, and touched no
  rate-limit comment this branch wrote. All of them still say "per-IP", which
  remains true of the viewer address.

The merged harness still hands `world.orgListRepo` to the public routers
(twilioWebhookHarness.ts:5439, 5534).

## 2. Fix wave 2, reviewed cold

**FW2-1: exclusions first.** In --apply, every exclusion is recorded before
every housing authority write.
- The only write path for a housing authority is writeOne, called at :962
  inside the second loop (:933 onward).
- The exclusion pass (:911-930) runs to completion before that loop. When any
  append failed, it sets `report.stopped` (:922) and returns before the loop.
- The typo refusal (:886-) runs BEFORE the exclusion pass, so a refused run
  records nothing.
- recordExclusion appends even when its history read fails, so a read outage
  cannot skip an exclusion silently.

So no run, whether it completes, stops or is killed, can write a target while
an exclusion it owes is unrecorded. The stop is conservative: it writes nothing
and exits 1. A run only stops when an append throws, so it never stops a run it
should not.

**FW2-2: a dismissed Atlanta suggestion.** atlantaDismissalKeys (:245) builds
its keys from the name plus the entry's spellings that resolve to that entry
alone, both normalized with normalizeSuggestionValue. That is the AI suggest
path's own key set (apply.ts:252-290 and 831-850, minus the model text, which
has no counterpart here). Two checks:
- The keys come from the list the run read (:877). That list is the one
  checkBackfillList proved names Atlanta Housing Authority, so the entry lookup
  cannot miss.
- "AHA", shared with Augusta, is excluded, per ruling B-3.

The RUNBOOK's "five on the starting list" count is right: the name plus
"Atlanta Housing", "Housing Authority of the City of Atlanta", "Atlanta (AHA)"
and "Atlanta, aha, Atlanta housing" (orgStartingList.ts, the first entry).

**FW2-3: an active resolution record.** The read order is resolution, then
pending suggestion, then dismissal (:722-728). This closes the
claim-to-completion gap that round 2 found (finding 3). The remaining window
is the accepted fw2 L1 edge.

**FW2-4: wording.** The post-write audit warning now says "may not have been
written", in the code and in the RUNBOOK.

## 3. Are the fixes correct, or only plausible?

They are correct. What decided it for each one:
- **FW2-1:** the ordering is structural (two loops, the second unreachable
  after a stop), not a convention.
- **FW2-2:** the key format and normalization match how dismissals are
  written.
- **FW2-3:** it reads the one record a claim creates in the same transaction
  that deletes the suggestion row (suggestionResolutionRepo.ts:668-692).

Nothing in the merge invalidates any of the three.

## INFO (no change requested)

- **hasDismissal is an eventually consistent GetItem** (extractionRepo.ts:739-743),
  while the other two new reads are consistent. A dismissal finishes its
  journal only after the tombstone is durable, and the journal stays `active`
  (and so is caught by FW2-3) until then. In practice the tombstone is visible
  long before a later run reads it.
- **IPv6 viewers are now keyed by /64.** Devices on one IPv6 venue Wi-Fi share
  one bucket, exactly as IPv4 NAT already did. This is round-1 A11 (the owner
  accepted the shared limit); noted only because the key change arrived with
  the merge.
