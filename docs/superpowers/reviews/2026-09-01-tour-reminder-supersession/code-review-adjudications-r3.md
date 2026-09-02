# Code-review adjudications - phase 4, round 3 (closing)

Adversarial round 3: 10/10 round-2 items CLOSED, all three fix-wave-2
deviations judged SOUND, the transactional sweep walked across four
interleavings and held; 1 MAJOR + 3 NOTE raised. Conformance round 3: R2-1/2/3
CLOSED (probe-verified at this commit), amended acceptance 8 DELIVERED and
stronger than its words, census complete, IAM `dynamodb:ConditionCheckItem`
already granted (no Terraform owed); 1 docs-only NOTE.

## Verdicts

- **Adversarial R3-1 (MAJOR - "the positional cancellation decode has no test
  of any kind"): REJECTED on evidence.** `app/test/tourReminders.test.ts:716-745`
  and `:747-798` run against DynamoDB Local through an injected doc wrapper that
  FORWARDS to the real client, so the decode receives REAL
  `TransactionCanceledException` payloads: the pointer-moved case exercises the
  reason[0] branch (a misread would either keep deleting - failing the
  2-survivors assertion - or log at error - failing the zero-error assertion),
  and the claim-mid-sweep case exercises reason[1] (a misread would abort the
  batch and the canceled/skipped rows would survive, failing their absence
  assertions). Both silent-opposite failure modes are pinned behaviorally. The
  reviewer grepped for the exception class name in tests; it is absent because
  the tests drive the real exception rather than mocking it - stronger, not
  missing. No action.
- **Adversarial R3-2/3/4 (NOTE): ACCEPT-RECORD.** The GSI-backed candidate list
  makes the sweep safe-not-complete (a truncated page's rows stay refused, next
  sweep collects); the arm-to-CAS crash window leaves two generations of
  refused debris instead of one (same repair path); the
  `conversionClaimedAt ?? updatedAt` fallback keeps NEW-2 behavior only for
  pre-deploy claims, a draining set.
- **Conformance R3-1 (NOTE, docs): ACCEPT-FIX (one sentence, committed with
  this file).** Amended 3.2 step 4 read as a won/lost dichotomy; the third cell
  (`ladderId === null` - no CAS attempted, sweep against the rotation) is now
  named so the dichotomy cannot be read as exhaustive.
- **Conformance's recorded judgement call** (a conversion-in-flight rung stays
  eligible for `next`): AGREED - temporary state, the estimate resumes when the
  claim resolves.
- **R2-4** stays ACCEPT-RECORD (unreachable echo copy).

## Where phase 4 ends

Three review rounds, two fix waves, 40 findings total; every BLOCKING and MAJOR
either fixed and probe-verified closed or refuted with cited evidence. No open
must-fix. Remaining recorded residues are all named above or in rounds 1-2.
