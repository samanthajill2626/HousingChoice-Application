# Final adversarial review

Verdict: **FAIL (static review).** The successful-path classification races are carefully fenced, but two live mutation/read surfaces still permit a stale type suggestion to survive a committed classification and continue polluting the operator queue. No commands beyond static source inspection and `git diff --check 3c2962a4..49146fba` were run, per the recovery constraint; diff-check exited 0.

## Must-fix

### M1. The classification fence is enforced only by best-effort deletion; authoritative readers still publish stale type suggestions

Locations:

- `app/src/routes/contacts.ts:1540`, `1586-1661`
- `app/src/services/extraction/apply.ts:739-777`
- `app/src/routes/suggestions.ts:93-106`
- `app/src/routes/today.ts:942-970`

The contact classification commits first at `contacts.ts:1540`. Every subsequent type-suggestion read/delete is explicitly best-effort: a read failure, transaction failure, contact-revision churn, or four identity misses stops the drain and still returns the successful contact PATCH. The extraction-side reconciliation likewise catches any failure and reports the new row as `pending` (`apply.ts:767-777`). There is no durable retry for either path.

Both readers then treat mere suggestion-row presence as authoritative. The contact endpoint returns every `listSuggestionsByContact` row without comparing a type row's `contactClassificationRevision` to the current contact (`suggestions.ts:106`), and Today counts every `byPending` row before reading only deletion state/label (`today.ts:950-969`).

Concrete interleaving:

1. A revision-0 unknown contact has a pending type suggestion.
2. A human classification PATCH commits the contact at revision 1.
3. The fenced delete gets a transient DynamoDB error (or the bounded drain exhausts under replacements); the route logs and returns 200.
4. The unchanged suggestion remains in `byPending` forever. Today advertises an AI-suggestion task for a now-classified contact, the contact suggestions API returns the stale row, the row can consume the bounded Today query ahead of valid work, and its AI-run verdict can remain `pending` even though no valid presentation remains.

The CAS protocol prevents deleting a newer row when the delete succeeds; it does not make a failed cleanup authoritative. A reader-side stale check/suppression (with durable cleanup/verdict reconciliation), or a classification write protocol that durably owns both state transitions, is needed before this invariant is closed.

### M2. The production import writer changes contact type outside the new revision protocol and never reconciles existing suggestions

Locations:

- `app/src/lib/import/apply.ts:937-984`, `1043-1050`
- `app/src/repos/contactsRepo.ts:1166-1206`
- `package.json:32-35`

`contactsRepo.update` is the only production primitive that increments `classification_revision`, but `import:apply` directly sends an `UpdateCommand` with `#type = :type`. It neither increments the revision nor deletes/reconciles a pending type suggestion. This is a reachable operational writer, including the explicit `import:apply:prod` command, rather than a test/seed-only seam.

Concrete interleaving:

1. An unknown contact at logical revision 0 receives a revision-0 type suggestion.
2. `import:apply:prod` upserts that same contact as tenant or landlord.
3. The contact is now classified but still logically revision 0, and the old suggestion remains pending; no extraction-side post-put reconciliation runs because the row predates the import.
4. The unconditional readers in M1 keep the false Today work item and pending AI verdict. A later import/reclassification back to unknown can make that old recommendation visible again with no epoch distinction.

All contact type/role writers must participate in the same monotonic classification protocol, or readers need an independent authoritative validity rule. Cover the import writer with a regression that begins from an existing pending type row.

## Plausible / hardening

### P1. The pressure-written type correction makes two suggestion fakes compile while leaving them on the legacy identity path

Locations:

- `app/test/extractionApply.test.ts:56-64`
- `app/test/extractionJob.test.ts:176-188`
- production contrast: `app/src/repos/extractionRepo.ts:570-579`

The latest `49146fba` annotations correctly preserve `SuggestionItem`/`PutSuggestionResult` types, but both default fake writers still omit `revision`. Production `putSuggestion` always stamps a random immutable revision. Therefore many apply/job tests exercise the legacy `createdAt + runId` identity path, not the production revision path that the new CAS protocol normally uses. The faithful webhook harness does stamp a UUID, and repo integration tests cover the real condition, so this is not by itself a demonstrated runtime defect; it is a test-fidelity gap likely to hide future identity regressions. Default fake rows should carry a deterministic non-empty revision, with explicitly named legacy tests omitting it.

## Attacked and not broken

- The four-kind mapping is internally consistent: server parsing accepts only `tenant | landlord | property_manager | partner`; dashboard triage maps Property Manager to `{ type: 'landlord', role: 'Property Manager' }`; verdict comparison reconstructs that exact persisted kind.
- The successful-path human-vs-extraction races are well defended. Contact classification increments its revision atomically with type/role; type deletion checks both the exact suggestion identity and contact revision in one transaction; replacement rows are reread rather than blindly deleted.
- Concurrent human classifications converge on the final committed revision: an older request stops on `contact_revision_changed`, while the later classification can delete and judge the pre-existing suggestion. No concrete interleaving found that lets the earlier writer delete a later-epoch suggestion.
- Generic suggestion acceptance still rejects `target=type` (`suggestionResolution.ts:203`), so a stale type row cannot silently auto-apply a classification through the ordinary accept endpoint.
- The dismissal writer fence remains transactional, and the expanded type vocabulary does not bypass normalized-value tombstones.
- Prompt/schema handling remains bounded and structured: unsupported type strings fold out before apply, reasons remain clamped, and the changed logging carries IDs/kinds rather than transcript bodies, phone numbers, or raw prompts. No new raw-data/privacy exposure was found in the feature diff.
- `git diff --check 3c2962a4..49146fba` produced no output and exited 0.
