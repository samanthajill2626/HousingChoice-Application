# Plan review R2 - reviewer A (caseworkers, branch B)

Plan: docs/superpowers/plans/2026-10-07-caseworkers.md @5af82883 (19294
lines). Read with: R1-fix-report.md, R1-reviewer-b.md, adjudications.md.
All work done by me; nothing delegated.

## Coverage

- Changed text, reviewed cold against HEAD:
  - A2: plan 3.2, Tasks 1.1, 1.2 and 1.4. lib/orgNames.ts has no imports
    (grep `^import` prints nothing), so the mirror test pulls in two app
    files.
  - Section 0's glyph legend and its "e2e pins move with their copy" rule.
  - The moved pins:
    - Task 6.5 step 4 (landlord-activity.spec.ts:122 verified).
    - Tasks 9.1, 9.3 and 9.4, by their file:line list against the old
      handoff table.
    - Task 10.4's stale-wording grep: it prints 26 lines at HEAD, as the
      plan says.
  - The Checkpoint after S9.
  - Task 10.14, line by line against AGENTS.md "Required completion gates".
  - Task 10.8a (org-lists.spec.ts anchors at :31-42, :54-58, :94, :493,
    :600, :604 and :747-751 verified).
  - Tasks 10.1 and 10.2 as verifications, against Task 8.13's text.
  - Task 10.7's `?phone=` lookup (contacts.ts:992-1001).
  - Task 8.9 GREEN (d), the scoped conversation-fact-extraction assertion:
    Card.tsx:20 is the only `<section>` on the contact page, so the
    `section`/`has` locator is unambiguous.
  - The 9.6 fix (renderPartner and header).
  - The 8.3 fix (`isCaseworkerContact` placement, the "without a type"
    sentences, B8's alreadyCaseworker branch).
  - Task 10.10 step 4 (GLOSSARY.md:120 anchor exists).
- Not reviewed in R1, now read in full:
  - Tasks 8.1, 8.2, 8.4, 8.6 and 8.11.
  - Task 6.1's GREEN.
  - Task 8.3's whole dialog implementation. Its refusal links resolve:
    App.tsx:160 `placements/:placementId`, App.tsx:253 `tours/:tourId`.
- Checked and clean:
  - The mutation-catalog fingerprint includes the enclosing symbol
    (mutationCatalog.ts:32), so two POSTs to one path stay distinct.
  - The keyboard Tab budget in environment-identity.spec.ts:56: 24 tabs
    against about 11 stops between Tenants and Account.
  - No other e2e spec pins the share wording: grep of
    retry-send-adoption, send-outcome-reconcile, flows/* and tour-roster.
  - csrfOrigin (app.ts:216) admits the RUNBOOK's same-origin console fetch.

## F1 [HIGH] S3's Step 0 still greps contactKinds.ts for the CASEWORKER_ROLE definition that A2 moved out

What: the A2 fix moved `export const CASEWORKER_ROLE = 'Caseworker';` into
app/src/lib/caseworkers.ts (plan 3.2 at plan:166-170; Task 1.1 GREEN at
plan:~600-630). contactKinds.ts now holds `import { CASEWORKER_ROLE } from
'../../lib/caseworkers.js';` plus `export { CASEWORKER_ROLE };`.

S3's Step 0, item 1 (plan:3131) is unchanged. It runs `grep -n "export const
CASEWORKER_ROLE = 'Caseworker';" .../app/src/services/extraction/contactKinds.ts`
and expects one line. After Task 1.1 it prints nothing. Step 0 applies to
EVERY S3 task and says "any mismatch: STOP and report". S4's Step 0
(plan:5318) inherits it: "S1 and S2's items from S3's Step 0 hold".

Implies: a literal builder halts at Task 3.1 and at every S3/S4 task, on
correct code. This is fix-pass fallout: A2 was applied to S1 and plan 3.2
but not propagated to the verification greps.

Fix: point item 1 at lib/caseworkers.ts. Optionally also grep contactKinds.ts
for `export { CASEWORKER_ROLE };`.

## F2 [LOW] Task 8.1's dashboard CaseworkerPreview doc still defines leftOther the old way

What: plan:10755 (Task 8.1 GREEN (a), types.ts mirror) documents leftOther
as "typed for another identity, or type-less". Plan 3.2 and the service
(Task 3.4: a typed row whose participant is another contact counts in
leftShared) say "type-less rows only (R1-F15)". The A15/B2 fix corrected
the sentence and the test, but not this comment.

Implies: the mirror's doc misdescribes the wire it mirrors. No behavior
change.

## F3 [LOW] Section 0's glyph fallback cannot do what it says

What: plan:59-61 says that if the Edit tool cannot match, "take a unique
ASCII substring of the line as the old_string and replace the whole line
around it". An Edit replaces only its old_string, so an ASCII-substring
edit leaves the glyph on the line. That contradicts the same rule's
"write the REPLACEMENT in ASCII" and the plan's "a touched line becomes
ASCII" (e.g. Task 9.5's empty state, "the WHOLE two lines become ASCII").

Implies: if the primary path (copying the real character from the Read
output) fails, the fallback silently leaves non-ASCII on a touched line.
The ASCII diff checks would catch it, so the cost is a confused builder,
not a shipped defect. Say instead: widen the old_string to the whole line,
copied from the Read output.

## Adjudications contested

- Open question 3 (REJECT): I agree, with one more reason. B's only
  inbound-created unknown (Task 10.7) is converted to a partner in the same
  test, so it leaves the unknown partition. caseworkers.spec.ts's beforeAll
  reseed (Task 10.5) runs before tests/flows/conversation-fact-extraction.spec.ts
  in a `workers: 1` run (playwright.config.ts:140-141), so it SHRINKS that
  spec's page-1 scan set. B makes the pre-existing risk smaller, not
  larger.
- B8: I accept it, and note why it is low-stakes. The hidden-picker branch
  is reachable only by a race. Every entry point excludes an existing
  caseworker:
  - the Possible list (isCaseworker filter, Task 3.8);
  - More actions (`!isCaseworkerContact`, Task 8.8);
  - the Unknown card (unknown contacts only).
- No other ruling contested. The A13, A14, A5/A6 and A16 fixes are correct
  as written:
  - 8.13's `'/contacts/caseworkers',` lands once in routes.test.ts, matching
    10.1's exactly-one-line grep.
  - 8.13's contact-create edit text matches 10.2's grep.

## Fixes judged correct (not merely plausible)

- A2's leaf move: correct apart from F1.
- A3's pin moves: complete. The Task 10.4 grep set equals the moved edits.
- B10/Task 10.14 gate 5 is equivalent to AGENTS.md's command:
  - `git merge-base main HEAD` followed by `"$BASE"...HEAD` yields the same
    diff as `main...HEAD`;
  - the extension filter is identical;
  - the empty-list case STOPs and never runs a bare `npx eslint`;
  - attribution is by baseline;
  - the gates run bare, with the e2e gate under an outer timeout as
    AGENTS.md allows.
- A11 and A7: correct.

Does anything here change WHAT gets built: no.
