# Spec review r3 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
at `bfec445a` (revision 3). Inputs: `adjudications.md` (round 2: 16 of 16
accepted) and the diff `28243656..bfec445a`. Read and grep only; no suite run.
Spec citations are `spec:<line>` at `bfec445a`. Anything unproven is marked
UNVERIFIED.

Ordered by severity. Findings 1-4 are defects introduced by, or left by, the
round-2 changes; 5-7 are smaller.

---

## 1. [HIGH] Read literally, D4's COMPOUND test makes every value that contains a shared spelling (AHA, MHA) compound - including "Atlanta (AHA)", the value the cleanup must map

**What is wrong.** D4 (spec:261-264): "A value is COMPOUND when its normalized
text contains, as whole words, the normalized names or spellings of two or
more different entries ... Compound values are never stored as spellings and
never resolve to one entry." Appendix A deliberately gives "AHA" to two
entries (Atlanta, Augusta) and "MHA" to two (Marietta, Macon) (spec:828-838).
So any text containing the word "aha" or "mha" contains a spelling of two
different entries:

- "aha" (normalized bare "AHA") - compound, while Appendix A says a bare "AHA"
  "is ambiguous by design" (spec:862-863);
- "atlanta aha" ("Atlanta (AHA)", an Appendix A spelling of Atlanta) -
  compound, while Appendix A says the old canonical "Atlanta (AHA)"
  "resolve[s] to one entry ... so the cleanup maps them automatically"
  (spec:858-862);
- "atlanta aha atlanta housing" ("Atlanta, aha, Atlanta housing", the raw
  Airtable value the alias map calls out as x450,
  `app/src/lib/housingAuthority.ts:27-28,35`) - compound;
- any "Marietta Housing Authority (MHA)" or "Atlanta Housing (AHA)" form -
  compound.

D4 gives no precedence between "equals a spelling, so match" (spec:249-253)
and "compound, so never resolve" (spec:263-264).

**What it implies.** A builder who implements the definition as written, with
compound winning, makes the cleanup leave the old canonical Atlanta value
unmapped. That is the largest authority group in the data (the prod count is
UNVERIFIED; the drift issue records that coverage is unmeasured). The same
build stops the importer resolving the raw Atlanta spelling, refuses any
admin spelling edit that contains AHA or MHA (D12, spec:448-452), makes
merges and renames skip such spellings, and labels the bare "AHA" row
"compound" instead of "several candidates". The server's accept rule allows a
`value` only from "the text's ambiguity candidates" (spec:350-354). If a
compound "AHA" has no candidates, staff cannot accept the AI's "AHA"
suggestion as Atlanta at all.

A second fragility: D12 checks only whether a NEW spelling is itself compound.
One generic spelling (say "Housing Authority" added to any entry) makes every
value that contains a name plus that spelling compound.

Fix the definition:
- exact name/spelling equality is decided first and is never compound;
- a single shared-spelling span is ambiguity, not two entries;
- compound needs two or more NON-overlapping spans matching different entries,
  with spans belonging to a longer match of one entry discounted;
- adding a spelling is refused when it would turn existing names or spellings
  compound.
Add test cases for the Appendix A rows.

---

## 2. [MEDIUM] D12's new "skip a spelling another entry already carries" contradicts D11's "shared spellings stay shared", so a merge turns an ambiguous abbreviation into an automatic one

**What is wrong.** D11: merge moves the merged entry's spellings onto the
target, "spellings shared with other entries stay shared" (spec:435-437). D12
(new): automatic additions, merge included, "never create a same-kind share
silently: a spelling another entry already carries is skipped too"
(spec:453-457).

**What it implies.** Merge Augusta Housing Authority into a target that is NOT
Atlanta. Under D12, "AHA" is skipped on the target (Atlanta carries it), and
the merged entry is removed. "AHA" then has exactly one carrier - Atlanta - so
D4 resolves it automatically. From then on every writer applies it:
- the D5 PATCH, the AI's direct writes, the importer, and a re-run of the
  cleanup map "AHA" to Atlanta, Augusta tenants included;
- this breaks the glossary's promise that a shared spelling "is never applied
  automatically" (spec:191-194).
The merge result does name the skip, but nothing tells the admin that the
abbreviation now applies automatically. Merge must keep the share on the
target (it replaces the merged carrier; it does not create a new share), and
D12's skip rule must exempt it.

---

## 3. [MEDIUM] The cleanup takes the D11 lock, but D11's "Run again" assumes the lock holder is a re-enqueueable job

**What is wrong.** The cleanup apply sets `lastRewrite` to `running` with
action `cleanup`, heartbeats it, and finishes `done` or `failed` (spec:706-709;
5.1 adds the action). D11 offers "Run again" on any `failed` rewrite, or any
`running` one with a heartbeat over 15 minutes old, and "re-enqueues the same
definition" (spec:421-423). The cleanup is an operator CLI run with stage
resolution and the operator's credentials (`app/scripts/lib/stageClient.ts`).
No job can run it.

**What it implies.**
- If the CLI dies mid-apply (killed, network loss, expired credentials), it
  cannot write `failed`. Every admin rewrite is then blocked for 15 minutes.
- After that, the Settings page offers "Run again" for a definition no job
  handler can execute. Its abort path (PARTIAL report, exit 1, spec:703-705)
  also does not say it releases the lock.
- The fix: no "Run again" for action `cleanup` (the page says to re-run the
  script); the script releases the lock (`failed`) in its abort handler; and
  RUNBOOK names the 15-minute wait after a hard kill.

---

## 4. [MEDIUM] Compound values (the spec's own "DCA HUD-VASH") have no settling action that keeps both halves

**What is wrong.** Revision 1's cleanup had a `split: <authority> + <agency>`
decision (`git show e78345f6`, spec line 471). Revision 2 removed the
decisions file (T3). Leftovers are now settled only with the D10 actions
(spec:395-409):
- Use <name> keeps one half;
- the two Move actions need a value that "match[es]" one entry, which a
  compound value never does (D4: compound "never resolve[s] to one entry");
- Add as new and Clear do not keep both halves either.
The section shows "compound" as a resolution (spec:381) but offers no action
for it. The founder's taxonomy says a tenant can hold both ("HUD VASH AND
DCA", `docs/issues/housing-authority-free-text-drift.md`, founder
clarification).

**What it implies.**
- Tenants can be fixed one at a time on their edit form.
- Non-tenant and deleted holders - the rows D10 says are settled "with the
  value-level actions" (spec:386-388) - can only lose the agency half.
- Add a Split action (authority half to housingAuthority, agency half to
  agency where absent or `''`, conflicts left), or state that compound holders
  outside tenants lose the second half.

---

## 5. [LOW] (B) `type_source: 'manual'` is stamped on every staff type change, so the importer stops updating every contact staff ever triaged

D21 stamps `type_source: 'manual'` on "Staff type changes" (spec:545). The
sentence is not limited to tenant/landlord/partner changes as the thread rule
before it is, and the contacts PATCH is also the triage path
(`app/src/routes/contacts.ts:532-537,1460-1499`). For such contacts the
importer then writes none of type, status, housing authority or agency
(spec:545-549). So after branch B ships, a re-import no longer fills the
authority (D9) or applies the founder's workbook status for ANY contact staff
triaged, including those where staff and import agree. Scope the skip to a
disagreement (stored type differs from the importer's type), or say that
triage from `unknown` does not stamp.

## 6. [LOW] Nothing can create a "Not on the list" value after the deploy, and the spec names no e2e fixture for the new section

D5 refuses off-list writes from every route (spec:266-282), and seeds use list
names (spec 7). AGENTS.md requires e2e coverage for the "Not on the list"
section, "Show records" and the six admin actions, but a lane can only get an
off-list value through a seed or a dev-only seam the spec does not name. If
the values are seeded into the shared lean world, a spec that settles one
(Use, Clear, Move) mutates the lane for every later spec: the pass-alone /
fail-in-suite shape. Name a run-unique fixture seam (dev-only, like the other
`/__dev` fixtures, `app/src/routes/dev.ts:889`).

## 7. [LOW] The 16,000-character list-block budget says nothing for when names alone exceed it

D8 drops spellings first when the block is over budget (spec:324-326). D13
allows names of up to 120 characters, about 300 entries (spec:462-466). That
is about 36,000 characters of names alone - past the budget with no rule for
what goes next. Specify the next step (truncate the agency names, then refuse
to grow), or bound entries.

---

## Adjudication contest

None. Round 2 accepted all 16 findings; T20 stays conceded.

## Fix checks (round 2)

Correct as written: R2-1 (per-kind "on the list", D3/D7/D10/I1), R2-2 (record
list, visible to all - the Deleted contacts view is already open to every user,
`dashboard/src/routes/contacts/ContactsList.tsx:52`), R2-6, R2-7, R2-8, R2-9,
R2-11, R2-13, R2-14, R2-15, R2-16.

Correct but undermined elsewhere: R2-3 (finding 1, via the compound
classification of "AHA"), R2-4 (finding 5), R2-10 (finding 7).

The fix introduced the defect: R2-5 (findings 1 and 2), R2-12 (finding 3).
