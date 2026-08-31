# Final adversarial review adjudication

Base reviewed: `3c2962a4..49146fba`.

## M1 - not confirmed; intentional bounded best-effort boundary

The static interleaving is physically possible after an unrecoverable repository
failure, but it asks for a durability/reader-suppression guarantee outside the
approved contract. D11 expressly makes both writer protocols bounded and
best-effort: the stale-row invariant is stated only "when the required reads,
conditional transactions, and verdict writes succeed" (spec lines 332-337), and
repository failures must log-and-continue rather than fail a successful PATCH
(lines 347-353). The implementation has the required bounded four-attempt route
drain and extraction re-read/delete protocol. Adding an authoritative reader
filter plus durable cleanup would widen the feature past its specified
best-effort race cleanup and require a new operational retry policy.

## M2 - rejected; explicit forward-only scope exclusion

The import writer is reachable, but the live-tree worklist deliberately records
`app/src/lib/import/apply.ts` among writers that remain revision-absent and says
"No seed, import, capture, migration, or backfill change" (worklist S2 lines
35-36). The approved plan's final review scope repeats forward-only behavior with
no import mutation. Contact PATCH is the only classification writer this feature
changes. Changing `import:apply:prod` would violate that approved boundary and
needs a separate feature.

## P1 - recorded as non-blocking test-fidelity hardening

The default apply/job fakes exercise the documented legacy createdAt/runId path,
while repo integration and webhook harness coverage exercise production revision
identity. Making every default fake stamp a revision is useful future hardening,
but no production defect or untested required interleaving was shown. It is not
changed in this fix wave.

## Outcome

No code change is authorized by the approved contract. A fresh adjudication
review must challenge these conclusions before final closure.
