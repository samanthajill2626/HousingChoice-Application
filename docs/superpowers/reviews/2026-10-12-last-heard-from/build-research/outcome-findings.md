# Build research - area `outcome` (plan S3 3.1-3.8, S5 5.1-5.5) - findings

Read-only live-tree check of plan v3 against the worktree at 25adc1ef (code
byte-identical to f6aba402), 2026-10-13. Byte-exact anchors, the full
importer lists and the invariant-surface tables are in the gitignored
reference `.superpowers/sdd/worklist-outcome.md`. This file lists only what
the plan gets wrong or misses. Severity: HIGH = a task cannot go green as
written; MEDIUM = contract drift a reviewer would flag; LOW = informational.

## F1 (HIGH) - Task 3.6: `IncompleteBatchReadError` cannot join a type-only import

Plan 3.6 says to add `IncompleteBatchReadError` "to the `contactsRepo.js`
import at `:9`" of `app/test/listingSendsApi.test.ts`. That line
(`listingSendsApi.test.ts:9`) is an `import type { ContactItem }` statement.
The rewritten `:427-447` case constructs the class as a VALUE (`new
IncompleteBatchReadError(1, 1)`), so appending it inside the type-only import
fails `npm run typecheck` (TS1361, the app test tsconfig is typechecked) and
throws a ReferenceError at runtime (esbuild erases type-only imports).

Fix: make line 9 a value import that keeps `ContactItem` as a type
specifier (`IncompleteBatchReadError` plus `type ContactItem`), the shape
`app/test/contactsBatchIncomplete.test.ts:33-37` already uses.

## F2 (HIGH) - Task 5.1: one SendRosterRow test can never pass

`SendRosterRow.test.tsx`, case "a partner row shows the Request a tour LINK
in place of Interested" (plan text line ~6294-6299): it asserts
`queryByRole('button', { name: /interested in/ })` is absent and, on the
next line, that the button "Mark Cora Reyes not interested in 12 Oak St" is
present. The regex is unanchored, so it matches that Not interested button;
the absence assertion fails against the plan's own GREEN component (which
correctly renders Not interested on a partner row, plan text ~6569-6579).

Fix: anchor the regex to the Interested name only, e.g. starting with
"Mark Cora Reyes interested in" - the form the other negative cases already
use (plan ~6307 and the 5.4 partner case ~7517).

## F3 (MEDIUM) - Task 5.1: empty `title` attribute vs contract N1

Plan N1 (section "Contract notes for the orchestrator", line ~4851-4853)
says an empty `title` from `formatHeardFrom` means NO title attribute and
"every consumer (S4, S5, S6, S7) spreads `title` only when it is
non-empty". The 5.1 `SendRosterRow` renders both date spans with an
unconditional `title={...}` (plan ~6539, ~6541). For a recipient never
heard from, `formatHeardFrom(undefined, now).title` is `''`, so the row
emits `title=""`. `OutcomeChip` in the same task does spread conditionally
(~6468). No test catches it. Fix: spread `title` only when non-empty on the
two date spans.

## F4 (LOW) - Task 3.3 imports two names only Task 3.6 uses

3.3 adds `import type { DeclineRecord, InterestedMode, ListingSendOutcome }`
to `app/src/repos/listingSendsRepo.ts` (after `:39`), but only
`DeclineRecord` is used until 3.6 adds `ListingSendRow`'s new members and
`ListingSendRowOptions`. The 3.3 commit therefore carries two unused
imports (`@typescript-eslint/no-unused-vars` error on that file), which
contradicts the plan's own rule in 3.6 ("Add each name in the task that
first uses it, so no commit carries an unused import"). Gate 5 at the end
is unaffected. Fix: import only `DeclineRecord` in 3.3; add the other two
in 3.6.

## F5 (LOW) - Plan-unlisted `declined` reset surface: the seed runner's full Put

Spec I2 / plan 3.3 header: "NO writer resets it except clearDeclined". The
seed runner writes listing_sends rows with a full `PutCommand`
(`app/src/lib/seed/index.ts:153`) from `app/src/lib/seed/cast.ts:1573-1576`
(2 rows) and `app/src/lib/seed/matrix.ts:1274-1298` (3 rows, full profile).
A NON-wiping re-seed of a local stack therefore drops a recorded `declined`
on those five seeded pairs (it already drops their share memory the same
way). `/__dev/reseed` wipes the tables first, so the e2e path is
unaffected. Dev data only; record it in the I2 surface list (or the 3.3
header comment) rather than change the seed. No other plan-unlisted writer
exists: no Delete/BatchWrite/TransactWrite on listing_sends anywhere in
app/src, app/scripts or e2e, and the importer, live/lean seeds and
performanceSeed never write the table.

## F6 (LOW) - Task 3.7 reads the pair's tours by unit, spec 5.4 says by tenant

Spec 5.4 step (1) reads `tours.listByTenant(contactId)` filtered to the
unit; the plan's route reads `tours.listByUnit(unitId)` filtered to the
tenant (plan ~4580) - and the re-projection reuses the same unit read. Both
are eventually consistent GSIs returning the same set for the pair, so the
outcome is identical; noted only so a reviewer does not read it as a
defect. Not changed by spec 14.

## F7 (LOW) - Task 3.4 undercounts the typed ContactsRepo fakes

3.4 says "the other three typed `ContactsRepo` literals" have a throwing
`getRecipientDisplaysByIds`; there are four - `app/test/audienceResolution.test.ts:123`
is also one (S1 1.1 already lists it for `touchLastHeardFrom`). Harmless:
an optional second parameter is assignment-compatible, so no edit is needed.

## F8 (LOW) - Line anchors are pre-slice in files earlier slices edit

The S3/S5 line numbers are correct AT THIS TREE (about 150 checked; only
`useListing.ts` LOADING is off by one - `:72`, not `:71` - and the
`ListingDetail.tsx` api import's "after `setUnitPhotoCover`" is not the
alphabetical slot), but S1 1.1 edits `contactsRepo.ts` and
`twilioWebhookHarness.ts`, S1 1.14 edits `dashboard/src/api/types.ts`, S4
4.5 edits `ContactDetail.tsx` / `ContactDetail.test.tsx`, and 5.1 edits the
three host files before 5.3/5.4 run. By then every cited line has moved
(estimated deltas in the reference, section 0). Builders must anchor on the
quoted text.

## Verified, no finding (for the reviewer)

- The byContact GSI projects ALL (`infra/modules/dynamodb/main.tf:57`,
  `app/src/lib/dynamoAdmin.ts:57`), so the contact listings-sent read sees
  `declined` with no extra read.
- A late carrier callback cannot supersede a decline: the ledger's `sentAt`
  is the latest counted ATTEMPT instant (`services/shareLedger.ts:112-120`),
  never a write instant.
- POST /api/tours' timeless create runs only `toursRepo.create`
  (`app/src/routes/tours.ts:367-415`), so the outcome route's direct create
  skips no side effect; I3's residual double-click race is the accepted one.
- No exhaustive switch or `Record` over `ActivityEventType` /
  `TimelineMilestoneType`; unit audit types are an open string end to end.
- `UnitsRouterDeps` / `ContactsRouterDeps` are constructed only in
  `app/src/routes/api.ts` (`:855`, `:958`); every route test goes through
  `makeWebhookHarness`, which already passes `activityEventsRepo`.
- `SendRosterRow` has exactly the three render sites the plan rewrites
  (`ListingDetail.tsx:1145`, `TenantFile.tsx:312`, `PartnerFile.tsx:174`).
- Every typed `ListingState` literal in `ListingDetail.test.tsx` spreads
  `READY`, so 5.2's single `READY` edit covers them.
