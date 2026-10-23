# Build research - s1-writers findings (plan section 5, S1 + S3.4 Steps 2-5)

Reader: s1-writers. Tree: worktree W:\tmp\unknown-inactive, code = main
@916258ae. Scope: plan section 5 (S1.1-S1.6) and S3.4 Steps 2-5 as applied
inside S1.1 step 1f (AR17). Counts: BLOCKER 0, MAJOR 1, MINOR 5.

Everything not listed here checked out against the live tree: every S1
anchor exists and is unique where an Edit needs it (replace_all counts 5/5),
every helper/fixture/import the test code uses exists with that shape, the
RED lists match what the current code does, every commit is green and
typechecks (no other importer of NON_TENANT_STATUSES; UnknownQueueStatus is
the only derived alias), and no other app test goes red after S1 (AR18 list
in the reference file).

## 1. MAJOR - S1.3 Step 1/2: the label tests cannot tell the NEW type from the STORED type

Plan location: S1.3 Step 1, the three tests "labels the milestone with the
NEW type: an unknown re-typed to partner ...", "(PIN) labels a tenant
re-typed to landlord ..." and "labels an Inactive tenant re-typed to unknown
..."; S1.3 Step 2's RED reason for the unknown -> partner label.

What the tree holds: the harness getById returns the LIVE array object
(app/test/helpers/twilioWebhookHarness.ts:2280-2282) and update mutates that
object in place (:2455-2458). In the PATCH handler the write
(app/src/routes/contacts.ts:1930-1934) runs before the milestone label
(:2129-2135), so in the harness `stored.type` is ALREADY the new type when
the label is built. Production's repo returns a copy, so there `stored.type`
is the pre-write type.

Consequence: an implementation that labels by `statusLabelFor(stored.type,
...)` - the minimal-looking edit, and exactly the production defect D4.5
exists to fix - passes all three label tests in the harness (unknown ->
partner reads "Active" off the live `partner`; tenant -> landlord reads
"Interested"; tenant -> unknown reads "Needs review", which both maps hold).
So spec test 3 "Timeline label uses the new type" is not pinned. The plan's
note that the unknown -> partner case is "the RED for label-by-new-type" is
wrong: it is red today only because the old picker falls back to
TENANT_STATUS_LABELS (which has no `active`) for the live `partner` type, and
Step 2's stated reason ("the stored type `unknown` picked the TENANT map")
is not what the harness does.

Correction: in the unknown -> partner and tenant -> landlord label tests,
make the route's reads copies before the PATCH, with the pattern this file
already uses (snapshotReads, app/test/contactTriage.test.ts:728-732; `vi` is
imported at :9):
`const get = world.contactsRepo.getById.bind(world.contactsRepo);`
`vi.spyOn(world.contactsRepo, 'getById').mockImplementation(async (id, opts) => structuredClone(await get(id, opts)));`
Then:
- tenant -> landlord becomes a real RED (old code: the copy's type is
  `tenant`, TENANT map, label "Status -> interested"). Drop its "(PIN)"
  prefix and its harness-only comment; add it to Step 2's RED list.
- unknown -> partner stays RED, now for the right reason (pre-write copy type
  `unknown`; old picker uses TENANT_STATUS_LABELS, no `active`); a
  `statusLabelFor(stored.type, ...)` implementation also stays red (UNKNOWN
  map has no `active`). Restate Step 2's reason accordingly.
- The Inactive tenant -> unknown case cannot discriminate either way (both
  maps label needs_review); leave it as is.
The prescribed 3e code (`isContactType(newType) ? newType : stored.type`)
passes all three with copy reads.

## 2. MINOR - S1.1 step 1f (S3.4 Step 2): one stale `active`-block comment left in unknownQueue.test.ts

What the tree holds: app/test/unknownQueue.test.ts:199-200 "... plus" /
"the empty `active` block: 4 examined rows charged, none returned." Step 2's
Edits C and D fix only :123 and :150, and AR17 makes S1.1 the only editor of
this file, so nothing else will.

Correction: add an Edit replacing

```ts
    // the empty `active` block: 4 examined rows charged, none returned.
```

with

```ts
    // the empty `inactive` block: 4 examined rows charged, none returned.
```

(ASCII-only file; the assertion `read.scanned === 4` is unchanged).

## 3. MINOR - S1.5 Step 3: history.ts keeps a comment the new code contradicts

What the tree holds: app/src/lib/seed/history.ts:215
"// Non-tenant/non-landlord contacts (team_member/unknown): needs_review [U+2192] active."
The plan keeps it on purpose (non-ASCII line), but after the edit it sits
directly above `UNKNOWN_LINEAR = ['needs_review']` and states the opposite
(an unknown contact has no active).

Correction: the slice's own rule allows replacing a non-ASCII line WHOLE.
Put line 215 (copied from a Read) at the top of the first history.ts Edit's
old text and replace it with an ASCII line, e.g.
`// Non-tenant/non-landlord contacts (partner/team_member/unknown):`
followed by the four new comment lines the plan already adds.

## 4. MINOR - S1.2 Step 3: the create-default header comment now contradicts the unknown arm

What the tree holds: app/src/routes/contacts.ts:990 (ASCII)
"// A manual create asserts identity (past the front door, not needs_review)."
After S1.2 an unknown create lands needs_review, the front door.

Correction: add an Edit replacing line 990 with e.g.
`// A manual create of a known type asserts identity (past the front door, not`
`// needs_review); an unknown create does not (see the unknown arm below).`

## 5. MINOR - Cross-slice notes: a stale fake-suite comment that no slice owns

What the tree holds: app/test/contactsPartitionFake.test.ts:97-99 "Within
type='unknown' the legal statuses are 'needs_review' and 'active', and
'active' < 'needs_review' ...". It is false after S1.1. Plan line 434 lists it
under "S3 leftovers", but no S3 task edits it (the plan names the file only
there and in S1.1's GREEN command).

Correction: either S1.1 adds a one-line Edit beside step 3h (ASCII-only
file; the sort pin itself stays valid because both 'active' and 'inactive'
sort before 'needs_review'), or the S1 report records it as unowned.

## 6. MINOR - Outside every slice: audienceResolution.ts states the old partner list

What the tree holds: app/src/services/audienceResolution.ts:84-85 "(a
partner's needs_review | active is not a tenant status)". D1 gives partner
`inactive` too; W5 keeps the file unchanged and no slice edits the comment.

Correction: record it in the S1 report for the planner (a one-line comment
edit if the planner allows touching the file; behavior is unaffected).
