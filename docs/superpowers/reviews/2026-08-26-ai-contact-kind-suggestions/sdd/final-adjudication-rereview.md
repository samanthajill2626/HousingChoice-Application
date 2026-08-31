# Final adjudication re-review

Base reviewed: `3c2962a4..49146fba`.

Verdict: **PASS.** CONCUR with the controller on M1, M2, and P1. The original
interleavings are physically possible, but M1 asks for durability beyond D11's
explicit bounded best-effort contract and M2 asks to mutate an import surface the
approved spec, worklist, and plan deliberately leave unchanged. P1 demonstrates a
test-fidelity gap, not production risk. The `49146fba` correction introduces no new
defect found by cold static review.

## M1 - CONCUR: outside D11's bounded best-effort invariant

The original review correctly identifies the live failure behavior: the contact
write commits at `app/src/routes/contacts.ts:1540`; the route's later consistent
reads and guarded deletes log and stop on repository failure at `:1591-1661`; the
extraction writer likewise returns its row to pending after reconciliation failure
at `app/src/services/extraction/apply.ts:733-777`. The ordinary readers do not add
an independent validity check: `app/src/routes/suggestions.ts:93-106` lists the
rows directly, and `app/src/routes/today.ts:942-972` groups every pending row before
checking only contact deletion/label state. Thus the described stale-row outcome is
physically possible after a failed or exhausted cleanup.

That outcome is not a violation of the approved D11 contract. D11 scopes the
revision increment to a contact PATCH carrying `type` or `role` (spec `:292-295`),
requires the route to perform a bounded drain (`:309-317`), and states the
no-stale-row invariant only when the required reads, conditional transactions, and
verdict writes succeed (`:332-337`). It then expressly preserves pending on
`suggestion_changed_or_absent`, requires only an in-bound retry, and retains the
best-effort log-and-continue boundary for repository failures (`:347-353`). The
acceptance criterion repeats the same success precondition at `:643-646`.

The plan is equally explicit: repository failures after a successful PATCH remain
best-effort (`plan:28`); the route makes exactly four attempts, stops on read/delete
errors, and merely warns when the bound is exhausted (`plan:1056-1118`). The live
implementation follows that protocol. Adding reader-side suppression, a durable
cleanup queue, or unbounded/polled retry would strengthen reliability, but would be
a new contract and operational policy rather than a correction required by D11.

## M2 - CONCUR: import is deliberately excluded from this revision protocol

The original review also correctly proves reachability: `import:apply:prod` is a
real command (`package.json:32-35`), and `app/src/lib/import/apply.ts:937-984,
1043-1050` directly writes `#type = :type` without incrementing
`classification_revision` or reconciling a pending type suggestion. That is a real
cross-feature operational risk if this import is run against contacts with pending
AI type suggestions.

It is nevertheless not a required mutation surface for this approved mission. D11
defines the writer as the contact PATCH (`spec:292-295,309-317`), while the approved
operational section says import classification remains authoritative and is not
rerun (`spec:477-484`). Acceptance requires existing seeds/imports to remain
unchanged (`spec:638-639`). The live-tree worklist expressly classifies import as a
revision-absent writer and says, "No seed, import, capture, migration, or backfill
change" (`worklist:35-36`). The plan makes "No ... import change" a global
constraint (`plan:21`) and asks final review to prove no import mutation
(`plan:1957`). Changing the production import writer here would violate, not satisfy,
that approved forward-only boundary. The hazard may justify separately approved
follow-up work, but it is not a merge blocker for this branch.

## P1 - CONCUR: no demonstrated production risk

Production `putSuggestion` assigns an immutable UUID revision at
`app/src/repos/extractionRepo.ts:568-590`. The production-like webhook harness also
stamps a UUID (`app/test/helpers/twilioWebhookHarness.ts:3249-3266`), and repository
unit/integration tests directly cover revision-first identity and the guarded
transaction. The two default apply/job fakes at
`app/test/extractionApply.test.ts:60-73` and
`app/test/extractionJob.test.ts:175-188` omit the optional revision and therefore
exercise the supported legacy identity fallback more often than production does.
That can reduce future regression sensitivity, but no current production failure or
required untested interleaving is demonstrated. P1 remains non-blocking hardening.

## Cold scan of `49146fba`

No newly introduced defect found. The commit changes only test typing:

- `extractionApply.test.ts` and `extractionJob.test.ts` annotate fake rows as
  `SuggestionItem` and returns as `PutSuggestionResult`; runtime construction and
  storage behavior are unchanged.
- `twilioWebhookHarness.ts` changes the delete-hook parameter from the larger
  `SuggestionItem` to `SuggestionIdentity`, exactly matching the production
  `ExtractionRepo.deleteTypeSuggestionIfCurrentAtContactRevision` contract at
  `app/src/repos/extractionRepo.ts:126-129,244-247`. Existing hook consumers use the
  boundary for synchronization and do not require fields removed by the narrowing.

`git diff --check 3c2962a4..49146fba` produced no output and exited `0`.

No Vite, Vitest, browser, E2E, or background command was run, per the recovery 2/2
constraint.
