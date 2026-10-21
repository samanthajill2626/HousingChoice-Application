# Plan review R1 - reviewer B (adversarial)

Plan: `docs/superpowers/plans/2026-10-21-flyer-leads-plan.md` (v1, commit d5684bbe)
Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md` (rev 6)
Worktree read at: feat/flyer-leads @d5684bbe. Read-only: nothing was run in
the worktree; every claim below cites a file:line read on this tree.

## Summary

No BLOCKING finding. The plan is unusually well anchored: I spot-checked 40
quoted anchors across S2, S3, S4, S5 and S6 (`grep -cF`), and every one exists
exactly once (one apparent miss was the 2-space list indent of a nested code
block - finding 6). Every spec decision D1-D10, every section 4 surface and
every section 5 test bullet maps to a task (coverage table at the end). The
findings are one unenumerated renderer, one records-process gap, and a set of
smaller literal-execution hazards.

---

## 1. [MEDIUM] The property "Sent to" card names an unnamed unknown contact's flyer row by its raw contactId

**What is wrong.** D7 makes `unknown` contacts a NEW population on the
listing-send ledger ("An `unknown` contact's entry shows on the property's
Sent to card at once"). Before this change no writer put an unknown contact on
`listing_sends` (broadcast audiences are tenants / partners / seeds), so the
Sent to renderer's name fallback was only ever reached for a MISSING contact.
An auto-captured unknown contact usually has no name - the spec says so itself
in D6.2 ("an auto-captured `unknown` contact has no other name"). The plan
enumerates the unknown row's actions and grouping (S5 Task 5.2 unknown case,
Task 5.3, S5 E) but never how it is NAMED.

**Evidence.**
- `app/src/routes/units.ts:183-194` `displayNameOfContact` returns undefined
  when first and last are blank; `:264-269` sets `tenantName` only when defined.
- `dashboard/src/routes/listing/ListingDetail.tsx:1343`
  `const name = row.tenantName ?? row.contactId;` - used as the row identity
  AND interpolated into the action aria-labels (`Mark <name> not interested in
  <address>`, `Card.tsx` aria-labels, plan B18).
- S5 Task 5.2's unknown-row test uses a NAMED fixture (`Tia Moss`), so no test
  can see it; S6 has no unknown-contact case on the property page.

**What it implies.** In production, every nameless unknown who signs up from
a flyer appears on the property's Sent to card (under Interested - an unknown
with a phone is eligible, `listingSendOutcome.ts:95-108`) as
`contact-xxxxxxxx`, with screen-reader action names like "Mark contact-xxxxxxxx
not interested in 12 Oak St". A reader that disagrees with the new population.

**Smallest fix.** Have S5 (or S3 on the wire) decide the label and pin it: the
recipient projection already carries `phone` (`contactsRepo.ts:381-387`
`ContactDisplayItem.phone`), so either fall back to the formatted phone for an
unnamed contact in `projectRecipientRow`, or render a staff label such as
"Unknown contact" in the dashboard when `tenantName` is absent and the row is
not `recipientMissing`. Add one Task 5.3 case with a nameless unknown row. If
the planner prefers no change, record it in section 3.2 as an accepted
residual so the build reviewer does not re-raise it.

---

## 2. [MEDIUM] Slice reports have no defined, committed home

**What is wrong.** Several slices tell the builder to record facts "in the
slice report" (plan line 59 ground rule on D10; S1 exit check 5, line 1546;
S2 exit check 3, line 3371; S5 exit check 3, line 8362; S6 Task 6.1, line
8767), and AR4/AR10 assume such reports exist. Sections 0-4 never say where a
slice report is written, what it is named, or that it is committed. Only S6's
two records (`S6-mutation-check.md`, `S6-gates.md`) get explicit paths.

**Evidence.** AGENTS.md "Mission reasoning is version-controlled":
slice/fix-wave reports go to `docs/superpowers/reviews/YYYY-MM-DD-<branch>/`
and are committed AS PRODUCED, never left in the gitignored `.superpowers/`
(the 2026-08-21 sweep that destroyed 16 worktrees' history). The plan's own
gate logs go to `.superpowers/sdd/gates/` (S6 C1), which is the natural place
a builder would also drop a report.

**What it implies.** The expected-red windows (S1 A.1), the pre-existing lint
errors per slice, and the D10 untrimmed-path reports can end up only in a
gitignored folder or only in transcript scrollback - exactly the records the
next reviewer needs.

**Smallest fix.** One bullet in plan section 0: "Each slice writes
`docs/superpowers/reviews/2026-10-21-flyer-leads/build/S<n>-report.md` (ASCII)
and commits it with the slice's last task (explicit path); gate LOGS may stay
in `.superpowers/sdd/gates/`, reports may not."

---

## 3. [LOW] Stale build-order text, including one concrete exit-check expectation, contradicts AR4

**What is wrong.** Plan section 3 / AR4 fix the order S1 -> S2 -> S3 -> S4 ->
S5 -> S6 and say contradicting slice text is superseded. Three places still
state the old order, and one of them is an executable pass/fail check.

**Evidence.**
- S1 intro (plan line 495-496): "Build it first (plan section 3: S1 -> S3 ->
  S4 -> S2 -> S5 -> S6)".
- S2 exit check 6 (plan line 3377-3378): "clean; six S2 commits on top of the
  S1 (and, by build order, S3/S4) commits" - under AR4, S3/S4 do not exist yet
  when S2's exit check runs, so a literal builder reading `git log` sees the
  "expected" state violated.
- S6 intro (plan line 8437-8438): "S1 -> S3 -> S4 -> S2 -> S5 -> S6".

**Smallest fix.** Edit the three lines to the AR4 order; S2 exit check 6 reads
"six S2 commits directly on top of the two S1 commits".

---

## 4. [LOW] The deleted-path audit breaks the spec's "sentSkipped is absent only when an entry was written" rule

**What is wrong.** Spec D6 defines `sentSkipped` as "why no entry was written
... absent when one was written". Plan 2.6 (and Task 4.5 Step 3b) make the
deleted path write `sentRecorded: false` with NO `sentSkipped`. That is the
one event shape where `sentSkipped` is absent and nothing was written.

**Evidence.** Plan 2.6 ("for the deleted path `sentSkipped` is absent and
`sentRecorded: false`"); Task 4.5 Step 1a deleted-holder payload; spec D6
audit field list.

**What it implies.** Any later reader (a lead report, an ops query) that keys
on "no sentSkipped = an entry was written" misreads every deleted-holder
sign-up. `deletedContact: true` disambiguates, but only for a reader that
knows to check it first.

**Smallest fix.** An AR ruling that records the deleted path as the single
documented exception (and a sentence in the route comment, Task 4.5 Step 3a),
or give it an explicit reason value (for example `sentSkipped: 'deleted'`,
the same kind of precision addition AR2 made for `refused`).

---

## 5. [LOW] `consentVersion` records the server constant, not "the disclosure version the form showed"

**What is wrong.** Spec D6: `consentVersion` is "the disclosure version the
form showed". Plan 2.6 / Task 4.5 bind it to `CONSENT_VERSION`
(`app/src/lib/smsCompliance.ts:91`), the server's current constant. The public
form does not post its version (`public.ts:121-199` parser has no such field).

**What it implies.** A flyer or /join tab opened before a disclosure-copy bump
and submitted after the deploy is audited under the NEW version although the
person saw the old copy - the one case where the field matters as evidence.
(The create path already stamps the constant the same way, so this is
pre-existing in kind, but D6 introduces the audit field as evidence.)

**Smallest fix.** Either state it as a residual in plan section 3.2 ("the
version the deployed server holds"), or have the form post its version and
record that. The residual is enough for this mission.

---

## 6. [LOW] Code blocks nested in list items carry the list's 2-space indent

**What is wrong.** Many anchor / replacement blocks sit inside "- Replace ..."
bullets, so every line of the fenced block is indented two extra spaces in the
raw markdown. A builder that copies the raw block as an Edit `old_string`
gets no match; one that copies it as `new_string` mis-indents the code or
comment by two spaces.

**Evidence.** Task 3.4 Step 3 anchor shows `    row: { declined?: DeclineRecord; sentAt?: string };`
but the file holds it with 2 spaces (`app/src/lib/listingSendOutcome.ts:67`);
same shape in Task 3.2 Step 3a (the NO-RESET comment lines are column 0 in
`listingSendsRepo.ts:18-21` but indented in the plan), Task 3.1 Step 3b, Task
4.1 Step 3a.

**Smallest fix.** One sentence in plan section 0: "A code block nested under a
list bullet carries the bullet's 2-space indent; strip it before using the
block as an anchor or as replacement text."

---

## 7. [LOW] Task 1.1 Step 3e miscounts the UnitFlyer lines it deletes

**What is wrong.** "Delete the 16 lines from `/** The Pets item's details
text...` through `lease_terms: string | null;`". The range is 17 lines
(`app/src/lib/unitFields.ts:406-422`: a 2-line pets doc, then 7 one-line doc +
field pairs, then `lease_terms`). The from/through anchors are correct, so the
count is the only defect, but a careful builder that cross-checks the count
stops.

**Smallest fix.** Say 17, or drop the number.

---

## 8. [LOW] S3 and S5 commit with `git commit -F <message file>` and never say where that file lives

**What is wrong.** S3 C (plan line 3599) and S5 C (line 7637) commit with a
message FILE; S3 gives no location (S5 says "a scratch file"). Written inside
the worktree, the file shows in the bare `git status` that the same step
requires to list only the task's paths, and an explicit-path `git add` of a
directory could stage it.

**Smallest fix.** Use the heredoc form S2 uses (`git commit -F - <<'EOF'`) or
name the scratchpad directory explicitly.

---

## 9. [LOW] AR5 is still "PENDING CAMERON" inside the binding section, with no task for the "fix here" branch

**What is wrong.** AR5 rules the untrimmed `validateUnitBody` plain-string
fields out of scope "until he answers" and offers two outcomes: fix here, or
file `docs/issues/unit-plain-string-fields-untrimmed.md`. Neither branch has a
task: no issue-file task, and no scoped fix task.

**What it implies.** If Cameron answers "file it", a builder has no task to
write the issue and the D10 report evaporates; if he answers "fix here", the
plan needs an unplanned amendment mid-build (and `unitFields.test.ts:540`'s
PIN flips).

**Smallest fix.** Add the issue-file step to S1 now (the default if no answer
arrives), and state that a "fix here" answer is a plan amendment before launch.

---

## Verified - no finding (for the record)

- O1: the only writers of `listing_sends` are `putShareMemory` (via the ledger
  and the create-only dev fixture `routes/dev.ts:1452-1466`) and the two
  decline writers (`routes/units.ts:1656,1671,1700`); no reader treats
  `shares_op` presence as meaning anything (`grep shares_op app/src
  app/scripts`); the existing repo/outcome tests that compare rows after a
  decline either read the token AFTER it (`listingSendsRepo.integration.test.ts:227`)
  or involve no decline write (`listingSendOutcomeApi.test.ts:402`).
- The five `deriveListingSendOutcome` callers pass the full stored row
  (`units.ts:236-270`, `contacts.ts:1304-1336`, `followUps.ts:139-170`,
  `broadcasts.ts:596-619`); no app-side switch over the outcome union.
- Dashboard outcome readers are exactly Card.tsx, listingFormat.ts and
  FollowUpView.tsx (`grep '\.outcome\b' dashboard/src/routes`).
- `conversation.updated` has one listener, the SSE route (`routes/api.ts:2757`);
  production `appEvents` is the bus both routers default to (`app.ts:154`).
- The inbox lists a 1:1 thread with no message rows (no drop reason for it,
  `routes/inbox.ts:1140-1247`; preview falls back, `:679-681`), so S6 test 3's
  new landlord thread is listable.
- Automated sends skip the JIT consent gate (`sendMessage.ts:537-547`) and new
  1:1 threads are `ai_mode: 'auto'` (`conversationsRepo.ts:1298`), so the S6
  mutation (welcome guard -> `true`) does produce outbounds on BOTH existing
  contacts: "2 failed, 2 passed" holds.
- `queryAll` rethrows (`lib/dynamoPaging.ts:29-60`), so `hasEventSince`'s
  "throws on a DynamoDB error" and the handler's fail-open are both real.
- CloudFront's default behavior uses CachingDisabled
  (`infra/modules/cloudfront/main.tf:166,209`) and the service worker is
  push-only with no precache (`dashboard/src/main.tsx:22-37`), so spec D1's
  old-bundle argument that Task 1.1 copies into the comment is true.
- Every test file named in a plan command exists.

## Coverage walk (spec -> task)

| Spec item | Task |
|---|---|
| D1 projection, payload test, comment | 1.1 |
| D1 PublicFlyer | 2.3 |
| D2 tag tables app / mirror / note gate / form props / landlord form | 1.1, 2.1, 2.2 |
| D3 heading, fallbacks, area line, highlight, facts, authority, rows, sign-up copy, 320px | 2.3-2.6, 6.2 |
| D4 lookup, deleted path, no write to existing | 4.2, 4.5 |
| D5 welcome for new only | 4.2 (+6.2 mutation) |
| D6 repeat check, pin, unread mark, best-effort, audit | 4.1, 4.3, 4.5 |
| D7 flyer entry, decline refusal, O1, residuals | 3.1-3.3, 4.4 |
| D8 outcome, callers, renderers, blast default | 3.4, 5.1-5.3 |
| D9 subzone | 1.2 |
| D10 whitespace | 2.4 (+ AR5, finding 9) |
| Section 4 docs | 6.3, 6.4 |
| Section 5 e2e | 6.1, 6.2 |
