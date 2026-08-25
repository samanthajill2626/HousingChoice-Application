# The Unknown inbox tab's unbounded walk (C1 anchor) - design

Status: **DRAFT.** Not reviewed, not gated. Written 2026-08-25 after the
measurement that raised
[`inbox-filter-tabs-full-walk`](../../issues/inbox-filter-tabs-full-walk.md)
from `medium` to `high`.

Branch: `feat/inbox-unread-cluster`, cut from `main` @88ac7b36.

## 1. The measurement, first

Every claim in this document that could have been measured, was. That ordering
is deliberate: this cluster has now produced two confident, wrong cost readings
in opposite directions, and the only thing that settled either was a number.

One Unknown-tab page render, taken by replicating the pager exactly
(`app/scripts/measure-unread-contact-coverage.ts --audit-unknown-page`):

| env | open conversations | scanned | contact lookups PAID | matching rows | outcome |
| --- | --- | --- | --- | --- | --- |
| dev | 637 | 637 | 637 | 13 | partition EXHAUSTED before filling |
| prod | 693 | 693 | 693 | 17 | partition EXHAUSTED before filling |

**The partition is exhausted on every render**, and `useInbox` re-issues the
request on every debounced `conversation.updated` while an operator sits on the
tab. This is the steady state, not a bad day.

**The cost inverts with triage quality.** The pager breaks when the page FILLS
(`inbox.ts`, `if (rows.length === limit) ... break pager`), so a backlogged tab
is cheap - 30 rows, ~30 lookups - and a CLEARED tab is expensive, because it
scans everything to find almost nothing. Keeping the queue at 17 is exactly what
makes this read cost 693. Two consequences worth stating plainly:

- It gets WORSE as the team gets better. No amount of operational discipline
  relieves it; discipline is what causes it.
- **No test with a healthy backlog can see it.** Any fixture that fills a page
  measures the cheap path. A regression test for this must starve the filter.

## 1a. The drift audit, and it SHRANK this design

Run on both environments 2026-08-25 (`--audit-denorm`):

| | dev | prod |
| --- | --- | --- |
| open 1:1 threads | 636 | 684 |
| contact resolved | 636 | 684 |
| **type: stale "unknown"** | **621** | **619** |
| type: missing triage (contact is `unknown`) | **0** | **0** |
| type: team_member | **0** | **0** |
| name: drifted | 0 | 2 |
| name: missing but known | 592 | 579 |

Three findings, and two of them REMOVE work from this design.

**1. The name denormalization is LATENT, not live - do not fix it.** The
planner claimed a stale name is "rendered to an operator as if current". That
was WRONG and is retracted. The inbox row's name comes from
`nameFromContact(contact)` on the hydrated contact; `participant_display_name`
appears in the dashboard only in type definitions and tests, and no component
renders it. So the ~580 threads with a missing denormalized name cost nothing
today. By this cluster's own rule - do not build for a cost nobody is paying -
the name is OUT OF SCOPE, and the fan-out does not need to carry it.

That also simplifies Option A: only `type` needs to become trustworthy. The
name stays exactly as unreliable as it is now, harmlessly, and no read is
allowed to start trusting it without its own measurement.

**READ THAT AS NARROWLY AS IT IS WRITTEN - it is about ONE field.** The founder
pushed back on "nothing reads the name" from lived experience (renaming a
contact does not update GROUP titles), and he was right. There is a SECOND
denormalized name, `participants[].name` on the roster, and it is a different
field with the opposite exposure: it is rendered in group titles and member
chips, and it reaches OUTBOUND MESSAGE CONTENT through `relayFanOut`'s intro
body and sender prefix. Nothing refreshes it on rename either.

| field | drift | rendered? | in scope here? |
| --- | --- | --- | --- |
| `participant_display_name` (1:1) | ~580 missing | NO | no - costless |
| `participants[].name` (group roster) | UNMEASURED | **YES, incl. outbound** | no - its own issue |

Filed as
[`group-roster-name-snapshot-never-refreshed`](../../issues/group-roster-name-snapshot-never-refreshed.md)
at `high`. It is out of scope for THIS design, but not because it is harmless -
because it is a separate defect on a separate field with a separate fix. The
drift audit never saw it: it walks 1:1 threads and skips group rows entirely,
which is a gap in the instrument, not evidence of health.

**2. Hole 3 has never fired.** Zero rows in either environment have a contact
typed `unknown` or `team_member` with a thread claiming a resolved identity. So
the demotion hole is REACHABLE (verified through the API) but has never
happened. Consequences: the bidirectional flip is a FORWARD GUARD, not a repair
of existing data; the backfill does not need to handle that direction; and the
open `team_member` sub-question in section 6 needs no answer to proceed, because
its bucket is empty. Keep the count in the drift detector so it stays empty.

**3. The pre-filter would miss nothing today.** That is the same fact read from
the safety side, and it is the strongest argument for Option A: switching the
Unknown tab to a `conv.type` pre-filter, AFTER the backfill, would not hide a
single row that currently appears.

The 621/619 stale-unknown rows confirm the ~610 estimate derived independently
from the walk measurement. The backfill is real, and it is a `type`-only
backfill.

## 2. Root cause, and it is a correctness bug

Of ~627 open `unknown_1to1` conversations in prod, only **17** actually need
triage. So roughly **610 threads carry a conversation type that says "unknown"
while their contact was typed long ago.**

That is why the walk is expensive: `conv.type` cannot serve as a cheap
pre-filter when 90% of the partition wrongly claims to be unknown. The pager is
forced to hydrate a contact per conversation to compute `needsTriage`, which is
`roleFromContact(contact) === 'unknown'` - a fact that lives on the CONTACT, not
on the thread.

**A retype path DOES exist** - `conversationsRepo.setConversationType` /
`applyTriage`, driven from the contact-update route. It gathers a contact's
linked threads and flips `unknown_1to1` to the resolved type. The 610 stale rows
are its HOLES, not its absence. Verified holes:

1. **Only the SCALAR PRIMARY phone is followed.** The fan-out reads
   `updated.phone` and queries `findByParticipantPhone` on that one value.
   Threads on a contact's non-primary numbers are never found, so they never
   flip.
2. **Contact CREATE does not fan out at all.** `POST /api/contacts` returns 409
   on an existing phone and otherwise creates the contact; it never touches
   linked threads. So a contact created already-typed, on a phone that already
   has an unknown thread, leaves that thread `unknown_1to1` forever.
3. **Demotion never flips back, and this one fails the OTHER way.**
   `conversationTypeFor` returns `undefined` for `team_member` and `unknown`, so
   `flipType` is false and no write happens. A contact demoted to `unknown`
   leaves its thread typed `tenant_1to1` - meaning a thread that SHOULD need
   triage is invisible to a `conv.type` pre-filter. That is a correctness hole,
   not just a cost one, and it is the reason the pre-filter cannot simply be
   switched on today.
4. **The importer writes `type` unconditionally** on the 1:1 path
   (`import/apply.ts`), so a re-import can reset a resolved thread's type.

**This must be swept properly at build time, not inherited from this list.**
Sections 7 of the C1 spec got its enumeration wrong three times in three drafts,
by three different methods. Treat the four above as confirmed EXAMPLES and the
sweep as unfinished.

## 3. Options

### Option A - complete the retype fan-out, then pre-filter on `conv.type` (RECOMMENDED)

Make `conv.type` trustworthy, then let the pager skip non-matching rows without
hydrating a contact. Cost falls from ~693 lookups to ~17: the walk still pages
the partition (about 7 Queries of 100) but pays a contact read only for rows it
will actually return.

Requires:

- Close every hole in section 2, **bidirectionally** - a demotion must flip a
  thread back to `unknown_1to1`, which is new behaviour, not a repair.
- A backfill for the ~610 stale rows.
- The pager pre-filters on `conv.type`, and `needsTriage` remains derived from
  the CONTACT for the rows it does return, so the displayed value never depends
  on the denormalization being right.

Why this over B: it reuses a field and a fan-out that already exist, and it
fixes a live correctness bug (hole 3) as a side effect rather than leaving it
filed. It adds no index and no new attribute.

### Option B - a sparse `needs_triage` flag with its own GSI

The `byUnread` shape: one Query returns the 17 rows directly, and cost stops
scaling with the open partition entirely. Strictly better performance.

Rejected as the FIRST move, not on merit: it carries the same maintenance
burden as A (every contact-type change must fan out) PLUS a new attribute, a new
index, and a second backfill - and A already reduces the cost by ~40x. If A
lands and the partition later grows enough that scanning it is itself the
problem, B is the follow-up, and A's completed fan-out is exactly the
groundwork B needs.

### Option C - budget + cursor + `truncated` on the unknown pager

Bounds the damage with no schema change, and was the earlier proposal. It is not
a fix on these numbers: a budget would return a handful of rows plus a cursor,
making an operator page repeatedly through a tab that holds 17 rows. Worth
keeping as a SAFETY NET under A - an unbounded read should not exist even when
it is cheap - but it does not solve the problem.

### Option D - batch the contact reads

The `contactId` read-through cut from the badge work. It would turn ~693 serial
Queries into ~7 BatchGets. Genuinely applicable here, unlike on the badge - but
it optimises hydrating rows we then throw away. A is better: do not read them at
all. Noted because the cut of the badge work removed this mechanism, and someone
will otherwise re-propose it.

## 4. The invariant, and what it costs to trust it

**Today `conv.type` is stale-but-harmless.** Nothing pre-filters on it, so its
drift shows up nowhere. Option A makes it LOAD-BEARING for what an operator
sees, which is exactly the objection a reviewer raised against indexing it. The
objection is right, and the answer is not to wave it off:

- Every writer of `contact.type` must fan out to linked threads. Enumerate them
  by sweep: the contact update route, contact create, the importer, contact
  capture, soft-delete and restore, and any job or seam that retypes. **Read the
  code; do not reuse this sentence as the list.**
- Every writer of `conv.type` must be consistent with it - including the
  importer's unconditional write.
- The fan-out must follow ALL of a contact's phones and emails, not the scalar
  primary.
- A row the pre-filter skips is INVISIBLE. A miss is silent, which is the worst
  failure shape available here.

**Drift detection is not optional, and the instrument already exists.**
`--audit-unknown-page` reports scanned-versus-matched; a healthy system after
this change shows those converging. Re-run it after the backfill and
periodically. That is the cheapest possible guard against the denormalization
rotting again, and it is the same script that found the problem.

## 5. Testing

- **The regression test must STARVE the filter.** A fixture that fills a page
  exercises the cheap path and proves nothing. Stage many open conversations
  with few matches and assert on the number of contact reads.
- Mutation-probe every check: reintroduce each hole in section 2 and watch the
  corresponding test fail. A hole that cannot be made to fail is not covered.
- Assert the BIDIRECTIONAL flip explicitly - demotion to `unknown` restoring
  `unknown_1to1` is new behaviour and the only one with no existing precedent.
- Pin the pre-filter's honesty: a row whose `conv.type` disagrees with its
  contact must still render the CONTACT's role, so a stale row is at worst
  missing, never mislabelled.
- Five gates bare from the worktree: typecheck, test, smoke, e2e, and `npx
  eslint` on the branch's own touched files.

## 6. Human rulings, 2026-08-25

**Q1 - a thread whose contact goes back to UNKNOWN returns to triage. RULED
YES.** With an important narrowing from the human: "demoted" means going back to
`unknown` specifically. It does NOT mean tenant -> landlord (a re-resolution,
which should retype the thread to the new identity) or tenant -> team_member.

VERIFIED reachable, so this is a live bug and not a hypothetical: the API
accepts `type: 'unknown'`, and `routes/contacts.ts` explicitly resets the status
to `needs_review` when it does. A contact can therefore be flagged for review
while its thread stays typed `tenant_1to1` and never appears in the Unknown tab.

**STILL OPEN, and split out because the ruling does not cover it:**
`conversationTypeFor` maps `team_member` to no 1:1 type exactly as it maps
`unknown`, so the naive reading would drag team-member threads into triage too.
A team member is a KNOWN person and almost certainly does not belong in a triage
queue. `--audit-denorm` now counts these separately rather than hiding them
inside one number - decide it on that count.

**Q2 - backfill CONFIRMED needed.** Still an operator action under the repo's
infrastructure rules: explicit go, dry-run first, and the numbers from
`--audit-denorm` should size it before anyone writes it.

**Q3 - `unknown_1to1` means BOTH** "we do not know who this is" AND "this thread
predates knowing", because a large share of these were imported. RULED by the
human.

Consequence for the permissive readers, which is now a narrower risk than
feared: tour reminders, placement nudges and the contact timeline all match
`tenant_1to1 || unknown_1to1`, so retyping a stale thread to `tenant_1to1` keeps
matching them. The behaviour only changes where a stale `unknown_1to1` is
retyped to `landlord_1to1` or `partner_1to1` - and there the change is arguably
a FIX (a landlord thread should not be collecting tenant tour reminders).
Verify, do not assume; but this is no longer the most likely regression.

## 6a. The sync problem, measured

The human's framing was right in principle: if contact data is copied onto the
conversation to make reads fast, all of it has to stay in sync, and it has not
been. THREE fields ride the same fan-out - `type`,
`participant_display_name`, and the `participants[].contactId` link.

**But the measurement narrowed which of them MATTERS**, and that is the point of
having taken it (section 1a):

| field | drift | does anything pay for it? |
| --- | --- | --- |
| `type` | 621 dev / 619 prod | YES - the Unknown-tab walk. This is the work. |
| `participant_display_name` | ~580 missing | NO - nothing renders it. Out of scope. |
| `participants[].contactId` | 0 dev / 2 prod unusable | NO - effectively clean. |

The rule this cluster keeps re-learning applies to the fix as much as to the
defect: sync the field a read depends on, and leave the ones nothing reads
alone. Making all three "correct" would be tidiness bought with invariant
surface - and invariant surface is what produced this review's only blocking
finding.

If a future read wants to trust the name, it measures first and closes the
fan-out then.

## 7. Out of scope

- Option B's sparse index, unless A proves insufficient after measurement.
- The badge read-through, deferred separately on its own measurement.
- The rest of the C1 generator-contract slice, which is independent of this and
  can proceed in parallel.
