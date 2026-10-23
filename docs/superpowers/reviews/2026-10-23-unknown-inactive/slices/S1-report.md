# S1 slice report - backend status model and contact writers (tracker #30)

Branch feat/unknown-inactive. Commits: e7724e4e (S1.1), 81ca584a (S1.2),
a2878e2c (S1.3), fa07bb2b (S1.4), 2bea6c66 (S1.5), 275c2911 (S1.6 sweep
fix), 66a850cf (S1.6 spelling fix).
Every task went RED for the plan's stated reason (OR-2's restated reasons for
S1.3), then GREEN. Typecheck exit 0 after every task that touched a type,
export or import. S1.6 whole app workspace: 526/526 files, 11113 passed,
1 skipped (baseline 11046 + 67 new), no `[dynamoAdmin]` line.

## Required records (plan S1.6 Step 5)

C1 - unmatched email cannot create an unknown contact.
`CREATE_CONTACT_TYPES = ['tenant', 'landlord', 'partner']`
(app/src/routes/unmatchedEmail.ts:73), refused by the type check at :437-443,
pinned by app/test/unmatchedEmailRoutes.test.ts:583-590 (`{ name: 'Sam',
type: 'unknown' }` -> 400). The `: 'active'` arm (:464) is the partner
default. S1.2 changed the comment only (:455-461, AR23).

C2 - routes/contacts.ts held a LITERAL U+2192 in the PATCH milestone label
(main @916258ae :2135). It is now `const STATUS_ARROW =
String.fromCharCode(0x2192);` (app/src/routes/contacts.ts:431), used once at
:2162; same rendered text, ASCII source (AR22). services/statusTransition.ts
keeps its two six-character U+2192 escapes in source (:171, :278;
`grep -c 'u2192'` prints 2).

C3 - S3.4 Steps 2-5 ran inside S1.1 (AR17), on the original text:
unknownQueue.test.ts (Edits A-E, five fixture flips, plus OR-8),
inboxUnknownTab.test.ts (Edits A-F, five `queueContact` flips, the two
pre-deploy cursor pins), inboxUnknownParity.test.ts (class f is now
(unknown, inactive)), inbox.integration.test.ts (reviewed rows seeded
`inactive`). Kept as written, per the plan: unknownQueue.test.ts:55 and :79
(pre-rework history) and the tamper case inboxUnknownTab.test.ts:323 (still
contradicts block 0). S3 makes no edit in those four files. S3 still owns:
the unknownQueue.ts header (~48-72) and docblock line :172 ("`active` block's
first Query") - S3.4 Step 6 - and every inbox.ts comment (e.g. :1818
"(unknown, active)", the flip comments, the 2026-08-26 ruling comment).

AR19 - e2e/tests/dashboard-next/ai-run-log.spec.ts: `createUnknown`
(:66-71) posts `{ firstName, type: "unknown" }` with no status, and
`createContact` asserts only `res.ok()` (:55). Its one caller (:336) PATCHes
the contact to tenant (:338-341), which auto-advances to onboarding from
needs_review now exactly as it did from active (unknown != tenant, so the new
same-type guard does not apply). The assertions (:341 PATCH ok, :344 tick
counters, :346-349 skip view) read no status. Nothing depends on it.

W6 - check-only, no edit. lean.ts: one partner `active` (:170-171), no
unknown or team_member. cast.ts: one unknown `needs_review` (:151-155,
unknown-texter). live.ts (:141, :158, :173) and matrix.ts (:463, :859):
tenants and landlords only. No seed holds an Inactive non-tenant or an
(unknown, active); the only offender was performance.ts (perf-contact-00298),
fixed in 2bea6c66. history.ts runs for the full profile only and its
full-world output is unchanged (the lean partner keeps needs_review ->
active, the cast unknown keeps no trail), so lean stays byte-stable.

D6 path table, (unknown, active):

| Path | Response | Pinned by |
|---|---|---|
| status-only PATCH | 400 `status must be one of: needs_review, inactive` | contactTriage.test.ts "400s a status-only PATCH of active on an unknown contact..." |
| type+status PATCH | 400, same text | contactTriage.test.ts "400s {type: unknown, status: active}..." |
| explicit create | 400, same text, nothing written | contactsCrud.test.ts "400s a create of (unknown, active)..." |
| list read | 400, same text | contactsCrud.test.ts "400s a list read of type=unknown&status=active" |
| transition route | 400 `toStatus must be one of: needs_review, inactive` | transitionRoutes.test.ts "REJECTS active for an unknown contact..." |
| AI status accept | 409 `suggestion_contact_not_tenant`, chip kept (unchanged, suggestionResolution.ts:819-826) | suggestionReclassification.test.ts (PIN) |
| import | needs_review plus a "not a legal unknown status" warning | importApply.integration.test.ts "a row retyped to unknown never stores active..." |
| unmatched email | N/A (C1) | unmatchedEmailRoutes.test.ts:583-590 |

Step 1 sweep: `git grep NON_TENANT_STATUSES -- app` prints nothing (no
extra consumer). The `'active'` grep found one stale comment the plan did
not list: parseCreateBody's docblock (app/src/routes/contacts.ts:853-861)
still said every create that is not a tenant or landlord defaults to active.
I corrected it in 275c2911 (comment only, an S1 file, the same kind of fix as
OR-10). Every other hit is a landlord/partner/team_member arm, the
unmatched-email partner default, or the conversion's partner write.

Step 3: no red file, so (AR18) no other (unknown, active) fixture needed a
change; followUps.test.ts, listingSendsApi.test.ts and
unitsApiActivity.test.ts are untouched.

Untrimmed input paths: none new (status values are fixed keys, D10).

## WORKLIST items applied

- OR-2 (S1.3): the unknown -> partner and tenant -> landlord label tests copy
  the repo's reads through a local `copyReads` helper
  (app/test/contactTriage.test.ts:1117). It has the same body as
  `snapshotReads` (:729-733), which is scoped inside another describe and
  cannot be reached from the new one at the end of the file. tenant ->
  landlord dropped its "(PIN)" prefix and harness-only comment. Both were RED
  for the restated reasons: unknown -> partner read `Status -> active` (the
  pre-write copy is `unknown`, and the old picker fell back to
  TENANT_STATUS_LABELS, which has no `active`); tenant -> landlord read
  `Status -> interested` (TENANT map). A `statusLabelFor(stored.type, ...)`
  implementation fails both, so spec test 3's label rule is now pinned. The
  Inactive tenant -> unknown case is unchanged.
- OR-8 (S1.1): unknownQueue.test.ts:200 now says "the empty `inactive` block".
- OR-9 (S1.5): app/src/lib/seed/history.ts:215, a non-ASCII line, was
  replaced whole by `// Non-tenant/non-landlord contacts
  (partner/team_member/unknown):`, followed by the plan's four comment lines.
- OR-10 (S1.2): the create-default header (app/src/routes/contacts.ts:994-995)
  now limits "asserts identity" to a known type.
- OR-11 (S1.1): app/test/contactsPartitionFake.test.ts:96-103 names
  `needs_review` and `inactive` and says why the `active` seed pin stays valid.
  That file was added to S1.1's commit (it is not in the plan's add list).
- OR-20: every committed file's added lines are ASCII against 916258ae (each
  printed 0). The slice-wide `git diff -U0 916258ae -- app` check prints 0.
- OR-22: I read a bare `git status` before every `git add`. At no commit was
  anything staged that I had not staged.
- OR-15 / American spelling (rules file): the plan's S1.3/S1.4 comment text
  spells "labelled". The four added comment lines now say "labeled"
  (66a850cf: contacts.ts:2155, caseworkerConversion.ts:411,
  contactTriage.test.ts:1086 and :1113). S1.3's commit message keeps the
  plan's wording; I did not amend history.

## Rulings honored

AR10/AR11: auto-advance guard app/src/routes/contacts.ts:1742; normalize
guard plus the Inactive first step at :1773-1776. AR16: S1.3 adds no
stored-type snapshot (the label type is `isContactType(newType) ? newType :
stored.type`, :2157), so there is no `priorType`; S2.5 declares it. AR24: the
`'contact triaged'` log call (:2168-2171) is unchanged. S1 adds no emit.
statusModel.ts stays import-free.

## For later slices and the planner

1. app/src/routes/statusTransition.ts:263-268 (S2's file) still says the
   route allows "else needs_review|active". No slice text edits it. Lines
   :265-266 carry an em dash and a section sign, so a fix replaces those lines
   whole. Left for S2.
2. docs/issues/unknown-queue-cap-starves-needs-review.md (resolved): its
   reopen trigger (:131-138) counts `(unknown, active)` rows, which this
   branch makes structurally 0; the reviewed-but-untyped class is now
   (unknown, inactive). This is a planner call; I made no edit (AR14).
   app/scripts/measure-unread-contact-coverage.ts:676-682 still prints the
   partition's per-status counts.
3. WORKLIST section D record (invariant-sweep 3). The importer keeps a
   preserved status while it re-types. `preserveStatus`
   (app/src/lib/import/apply.ts:1142-1146; base :1150-1154) skips the status
   SET (:1218-1223; base :1226-1231), while `!manualType` still sets `#type`
   (:1165-1166; base :1173-1174). A re-import can therefore still store
   (landlord, inactive) or (unknown, active). Spec section 3 scopes the
   importer gap out, and no issue names this pair shape. Planner call:
   whether to append it to docs/issues/import-bypasses-contact-type-rules.md.
