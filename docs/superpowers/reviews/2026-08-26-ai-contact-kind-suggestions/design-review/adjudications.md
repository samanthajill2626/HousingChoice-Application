# AI contact-kind suggestions design review adjudications

## Round 1

### Reviewer A

1. ACCEPT - Raw AI-run panes violate the unqualified no-raw-value guarantee.
   Evidence confirmed in `AiRunDetail.tsx`: the decision ledger, raw model text,
   and parsed result are separate renderers. The spec now humanizes only the
   decision ledger and explicitly preserves forensic payloads verbatim.
2. ACCEPT - Edit contact is a second classification and AI-resolution surface.
   Evidence confirmed in `UnknownFile.tsx`, `ContactEditForm.tsx`, KindPicker, and
   the shared contact PATCH route. The spec now enumerates and tests both UI entry
   points while retaining the shared backend owner.
3. ACCEPT - Semantic role-note deduplication was overstated. Evidence confirmed in
   `apply.ts`: the application only removes exact repeated text. The spec now
   describes prompt reconciliation plus exact-line filtering and makes semantic
   paraphrase deduplication an explicit non-goal.
4. ACCEPT - `services/extraction/ops.ts` does not exist. The surface is corrected
   to `parseExtractionOps` in `schema.ts`.

### Reviewer B

1. ACCEPT - Full-kind derivation could falsely accept a role-bearing custom kind
   as a plain canonical kind. `displayKind` confirms a non-empty role is the
   staff-facing kind. The spec now requires an absent/empty role for plain Tenant,
   Landlord, or Partner and treats every other custom role as unsupported.
2. ACCEPT - Same audit-renderer contradiction as Reviewer A finding 1. Resolved by
   the same narrowed display contract; raw forensic panes stay exact.
3. ACCEPT - Current-contact and note-only provenance were stated as server
   guarantees even though they are model semantics. The spec now distinguishes
   prompt-contract behavior from application-enforced constraints and defines
   forward-only as no scan, migration, scheduled pass, or other backfill.

### Counts

- ACCEPT: 7 findings (6 unique issues after combining the duplicate audit finding)
- REJECT: 0
- DEFER: 0

## Round 2

### Reviewer A

1. ACCEPT - A replacement type suggestion can be stranded after classification.
   The route's generic identity fence intentionally leaves replacements pending,
   but type has no renderer after the Unknown file disappears and generic accept
   refuses it. The spec now defines a type-specific two-sided protocol: the
   extraction writer validates its exact put against a post-write live contact
   read, and the classification writer performs a bounded read/CAS drain after
   the contact write. Racing replacements receive a terminal human-superseded
   verdict; other targets retain their current policy.

### Reviewer B

No material findings. Reviewer B explicitly attacked full-kind roles, both UI
writers, audit panes, prompt versus server guarantees, and downstream contracts.

### Counts

- ACCEPT: 1
- REJECT: 0
- DEFER: 0

## Plan review round 4

### Reviewer A

1. ACCEPT - The new drain snippet redeclared the existing route-scoped
   `verdictAt` constant retained by generic cleanup. Task 4 now explicitly
   keeps one post-write clock and shares it across the generic loop and type
   drain.

### Counts

- ACCEPT: 1 precision finding
- REJECT: 0
- DEFER: 0

Plan review converged at the four-round hard cap. Round 4 changed no design
decision; it removed one literal implementation contradiction, and all
re-attacked ownership, activation, role, race, audit, and TDD surfaces held.

## Round 3

### Reviewer A

1. ACCEPT - A classification drain can delete and marker-stamp an in-flight
   extraction before that extraction finalizes. If extraction then reports the
   decision as dropped, `putRun` will not merge the terminal marker. The spec now
   permits a dropped outcome only when extraction's own guarded delete commits;
   an absent or replaced row preserves pending so marker/displacement verdict
   ownership survives finalization.

### Reviewer B

1. ACCEPT - A delayed route drain is not fenced against a later retype to Unknown
   or another kind edit. The spec now adds a monotonic contact classification
   revision, stamps type suggestions with their source revision, increments the
   revision on every `type` or `role` PATCH, and requires a cross-table conditional
   transaction for deletion. An older route cannot delete or judge a later
   revision's row.

### Counts

- ACCEPT: 2
- REJECT: 0
- DEFER: 0

## Plan review round 3

### Reviewer A

1. ACCEPT - Task 4 called an undefined verdict helper and did not state what a
   legacy suggestion without `runId` does. The drain now inlines the existing
   guarded `aiRuns.setVerdict` contract: no run id means safe deletion with no
   stamp; otherwise target `type`, expected pending verdict, exact suggestion
   `createdAt`, route actor/time, and best-effort logging are required. Focused
   tests now cover both the no-run row and marker-safe options.

### Counts

- ACCEPT: 1
- REJECT: 0
- DEFER: 0

## Round 4

### Reviewer A

1. REJECT - A request that starts earlier but commits its contact update after a
   second request is not an older stored classification under the current product
   contract; contact edits are deliberately last-commit-wins. Its new revision is
   therefore authoritative and may supersede an AI suggestion that appeared while
   the request was in flight. Adding request-start optimistic concurrency to every
   type/role update would widen this feature into a separate contact-edit conflict
   policy. The spec now states this boundary and narrows the invariant to committed
   revision order.

### Reviewer B

1. ACCEPT - Logical legacy revision zero needs an explicit physical DynamoDB
   predicate. The spec now requires
   `attribute_not_exists(classification_revision) OR classification_revision = 0`
   and a real two-table integration test for classified cleanup and unchanged
   Unknown retention without migration.
2. ACCEPT - Section 5.2 collapsed newer-Unknown cleanup into
   `type_already_classified`. It now repeats D11's two-way rule and uses
   `type_classification_changed` for a newer Unknown epoch.

### Counts

- ACCEPT: 2 (precision changes; no design decision changed)
- REJECT: 1
- DEFER: 0

Review converged at the four-round hard cap: round 4 changed no design decision.

## Plan review round 1

### Reviewer A

1. ACCEPT - The empty pre-write snapshot path could return without any
   post-write consistent read, stranding a type row published during the contact
   update. Task 4 now requires that read whenever the snapshot is absent or
   unavailable, and forces a fresh read after each guarded delete attempt.
2. ACCEPT - The new pre-write suggestion read was not best-effort. Task 4 now
   catches and logs that read, continues the contact PATCH, and still attempts
   the post-write drain. Drain reads and deletes are likewise explicitly
   log-and-stop after the contact commit.
3. ACCEPT - The original task order activated the production schema and prompt
   before the route and dashboard could honor the two new values. Task 1 is now
   compile-time type scaffolding only. Runtime schema, parser, and prompt
   activation moved to Task 6, after the persistence, route, and UI consumers
   are implemented and green.

### Reviewer B

1. ACCEPT - Trimming the stored role before comparison would falsely classify
   a custom role such as ` Property Manager` as the exact preset. The backend
   resolver now compares the raw persisted string exactly and the truth table
   includes leading whitespace, trailing whitespace, and whitespace-only roles
   as unsupported.
2. ACCEPT - Same empty pre-write snapshot gap as Reviewer A finding 1. Resolved
   by the same mandatory post-write consistent read and bounded reread loop.
3. ACCEPT - The e2e task claimed an impossible pre-implementation red run even
   though it followed all implementation tasks. It is now explicitly a
   post-implementation acceptance/regression proof; the earlier backend and
   dashboard slices own the real red/green tests.

### Counts

- ACCEPT: 6 findings (5 unique issues after combining the duplicate empty-snapshot finding)
- REJECT: 0
- DEFER: 0

## Plan review round 2

### Reviewer A

1. ACCEPT - Task 4 used an undefined guarded-delete result name and called an
   undefined suggestion identity helper at the verdict boundary. Task 2 now
   exports one `GuardedTypeDeleteResult` and one revision-first,
   legacy-exact `sameSuggestionIdentity` policy with focused tests; Task 4
   consumes those exact contracts.
2. ACCEPT - The prompt assertions did not pin the approved direct Tenant
   example or pair every D3 phrase with its outcome. Task 6 now checks all six
   example lines against Tenant, Landlord, Property Manager, Partner, Tenant,
   and `none`, plus the two required disambiguation clauses.

### Counts

- ACCEPT: 2
- REJECT: 0
- DEFER: 0
