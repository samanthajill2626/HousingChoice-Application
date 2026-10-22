# P2 - spec conformance re-review, feat/flyer-leads (fix wave FW-P1)

Reviewer: the P1 conformance reviewer, re-run on 33e392aa. Scope:
- the whole changed state, with a fresh sweep;
- the fix wave `git diff c860883b..33e392aa`: app/src/routes/public.ts,
  app/src/routes/units.ts, dashboard/src/routes/public/FlyerPage.tsx and their
  tests;
- two docs/issues files;
- the spec amendments (the section 4 Activity card line and three new
  section 7 bullets).

Inputs read: the spec at 33e392aa, the code, the tests, the issue files and
`planner-review/adjudications.md`. Not read: the plan, and every other review
record (P1-adversarial.md, FW-P1-report.md and handback.md included). I ran
nothing: `planner.end` did not exist during this pass, and no finding needed a
probe. The battery's typecheck, npm test and smoke had already exited 0 on
33e392aa (`.superpowers/sdd/gates/planner-*.exit`); e2e was still running.

## Summary

Conformance table: 14 items.

| Verdict | Count |
|---|---|
| CONFORMS | 10 |
| PARTIAL | 3 |
| MISSING | 0 |
| DEVIATES | 1 |

Findings: 5.

| Severity | Count |
|---|---|
| BLOCKING | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 1 (P2-F1) |
| INFO | 4 (P2-F2 to P2-F5) |

The two code fixes are correct and narrow:
- C-F1: both `housing_fair_signup` appends are guarded, they log
  `{ marker, step: 'audit', err }` and the answer stays `{ ok: true }`.
- A-L2: the Activity card's `contactName` goes through `recipientLabelOf`.

Each has a test that pins it. The one new LOW comes from the fix wave
itself. It shifted public.ts by 12 to 26 lines and units.ts by 4 lines, and
left about 30 line citations stale across five docs/issues files. The two
issue files it edited now mix the old and the new numbering. The fresh sweep
found no new code defect. It checked:
- every reader of the Activity `contactName`;
- every remaining unguarded step after the create;
- the Today / inbox / contact-page reactions to the bump;
- the consent copy (it promises no welcome text);
- the /join copy;
- any other staff-only field reaching tenants (only `[Rent]` does, already
  A-M1).

## Conformance table

| # | Item | Verdict | Code file:line | Test file:line | Note |
|---|---|---|---|---|---|
| 1 | C-F1: the live-path audit is best-effort - a throw is logged (ERROR, marker, step audit, no PII) and the answer stays `{ ok: true }` after the pin, the bump and the flyer entry | CONFORMS | app/src/routes/public.ts:743-760 | app/test/publicSignupLeads.test.ts:974; app/test/publicIntake.test.ts:146-158 | the harness hook throws before recording (twilioWebhookHarness.ts:2652-2656) |
| 2 | C-F1: the deleted-path audit is best-effort | CONFORMS | public.ts:509-529 | publicSignupLeads.test.ts:1000 | the deleted path still writes nothing else |
| 3 | C-F1: the header and step comments name the best-effort and the unguarded steps | CONFORMS | public.ts:40-46,135-143,602-604 | - | the header lists "the create"; the spec bullet does not (P2-F2) |
| 4 | A-L2: the Activity card labels a contact name, else `formatPhoneForDisplay(phone) ?? phone`, else absent | CONFORMS | app/src/routes/units.ts:207-218,2265-2281 | app/test/unitsApiActivity.test.ts:427,442,455 | the real `getDisplaysByIds` projects `#phone` (contactsRepo.ts:1079); the dashboard reader is listingFormat.ts:226 |
| 5 | A-I2: the heading comment names the suffix it sits beside | CONFORMS | dashboard/src/routes/public/FlyerPage.tsx:315-319 | - | see P2-F3 for the spec's version of the same claim |
| 6 | Spec section 4 Activity card line: no new row from a sign-up; label per AR13 | CONFORMS | public.ts (no unit audit written); units.ts:2276 | unitsApiActivity.test.ts:416 | wording note in P2-F4 |
| 7 | Spec section 7 bullet: the decline-click race | PARTIAL | units.ts:1600,1694; shareLedger.ts:276-296 | - | P2-F5: D7's body sentence stays absolute, and the bullet omits the stray "Not interested" rows |
| 8 | Spec section 7 bullet: D7 / AR13 on the Activity card | CONFORMS | units.ts:2276 | unitsApiActivity.test.ts:416 | wording note in P2-F4 |
| 9 | Spec section 7 bullet: D6.4, the audit best-effort and what still is not | PARTIAL | public.ts:509-529,605-606,743-760 | publicSignupLeads.test.ts:970 | P2-F2 |
| 10 | Spec D3 (unchanged): the suffix is kept "for WCAG 2.5.3 and the new-tab disclosure" | DEVIATES | FlyerPage.tsx:315-325 | - | P2-F3 (INFO): the suffix discloses no new tab, and the fixed comment now says so |
| 11 | Issue files: line citations point at the code they describe | PARTIAL | docs/issues/*.md (5 files) | - | P2-F1 (LOW) |
| 12 | A-M2 filing: the Today crowd-out facts | CONFORMS | today.ts:182,752,754; config.ts:1008-1014; public.ts:562,662,675-694 | - | every cited line checked at HEAD |
| 13 | A-L1 / A-L3 filing: the opted-out re-sign-up, and the crash before the welcome | CONFORMS | sendMessage.ts:123,513; smsCompliance.ts:133,239-245,262-266; FlyerPage.tsx:251,431,440; HousingFairIntake.tsx:163; main 0f6f29f9 public.ts:329,384 | - | every cited line checked |
| 14 | Re-sweep: readers of the changed Activity `contactName` | CONFORMS | dashboard/src/routes/listing/listingFormat.ts:224-252 | - | renders `${who} not interested` etc.; a formatted phone reads fine; two stale comments (P2-F4) |

## Findings

### P2-F1 - LOW - the fix wave left ~30 public.ts / units.ts line citations stale in docs/issues, mixing two numberings in the files it edited

AGENTS.md makes docs/issues the in-repo tracker, and each issue's `refs:` and
body cite `file:line` as the evidence the next engineer follows. At c860883b
every citation below was correct (checked against `git show
c860883b:app/src/routes/public.ts`). The fix wave added comment lines and
try blocks: public.ts moved +12 lines from the parser on, +21 around the
repeat check and +26 at the audit; units.ts moved +4 from line ~207 on. The
fix wave refreshed only the citations in the paragraphs it wrote.

Stale at HEAD, with what each now points at:
- `consent-capture-ignores-signup-web-form.md`:
  - frontmatter and body line 42, `public.ts:718-731` "the
    housing_fair_signup audit event": now the ledger branch's comment; the
    audit is at 743-760;
  - frontmatter and line 23, `public.ts:205` "the server refuses a body
    without smsConsent": now a doc-comment line; the check is at 217.
  The same file's new paragraphs cite the NEW numbering (`:551`, `:562-593`,
  `:605-606`, `:629`), so one file uses both.
- `public-signup-abuse-hardening.md`:
  - frontmatter `public.ts:637-673`, `:156-167`, `:209-216`, `:495-528`,
    `:584`, `:686-703`;
  - body lines 21, 37, 39, 91, 97-98, 118, 127, 140, 145, 203, 216, 257-258,
    including `public.ts:197` "parseHousingFairBody", which is now at 209.
  Its new Today paragraph cites the new `:562`, `:662`, `:675-694`.
- `flyer-signup-decline-click-race.md`:
  - body lines 57-62: "the sign-up must take its instant (`public.ts:637`)"
    now lands in the welcome's error catch (the clock read is at 658);
    `:643` hasEventSince is now 664; `:696` applyFlyerShareEntry is now 717;
  - frontmatter `public.ts:637-703`;
  - every `units.ts` cite: `:1560`, `:1572`, `:1596`, `:1688-1702`, `:1690`
    and `:1742-1762` are each 4 short (the outcome route is now at 1564,
    `at` at 1600, setDeclined at 1694).
- `deleted-contact-web-signup-silent.md`: `public.ts:489-528`, `:489`, `:496`
  and `:572-574` to `:609-619`. The deleted path now starts at 509 and its
  audit is at 511.
- `public-welcome-text-global-cap.md`: `public.ts:593-603`. The welcome is
  now at 614.

Scenario: someone picks up the click-race issue's "Suggested fix" and follows
its "What it takes" walk-through by line. Every public.ts step lands 21
lines early, in the welcome's catch. Every units.ts step lands 4 lines early.
In the consent issue, "the evidence ... sits on the audit event
(`public.ts:718-731`)" lands on the flyer-entry comment.

Severity LOW: docs only, and the symbols named beside most citations still
find the code. Fix: re-point the citations in the five files to 33e392aa, or
cite symbols (`applyFlyerShareEntry`, the `(1a) deleted path` comment)
instead of lines that move with every edit.

### P2-F2 - INFO - the new D6.4 bullet's "not best-effort" list omits the create and over-states the retry consequence

Spec section 7, the new bullet: "Still NOT best-effort, as before this
feature: the reads that route the request and the thread get-or-create and
link. A throw there is the generic 500, and a NEW contact's retry then takes
the existing path and is never welcomed".

Code: the public.ts header (40-46) names one more unguarded write: "the
reads before the steps (the authority list, the unit, the phone lookup), the
create, and the thread get-or-create and link". `contacts.create`
(public.ts:562) is the missing item.

The "never welcomed" consequence also follows only from a throw AFTER the
create: a throw in the thread step, or in the create's own write if it lands
before the call throws. A throw in "the reads that route the request" happens
before any contact exists, so the retry creates the contact and welcomes it.

Scenario: a reader trusting the bullet expects a `findByPhone` timeout to
cost the welcome. It does not. A reader who thinks no write fails loudly
before the thread step has missed the create.

Fix: one sentence in the bullet - "the routing reads, the create, and the
thread get-or-create and link; a throw after the create (the thread step) is
what leaves a new contact unwelcomed on the retry."

### P2-F3 - INFO - spec D3 still says the suffix carries "the new-tab disclosure"; the code comment now correctly says it does not

Spec D3 (FlyerPage heading, design line 151): "The link keeps the sr-only
' - open in Google Maps' suffix ... for WCAG 2.5.3 and the new-tab
disclosure."

Code: the suffix is " - open in Google Maps" (FlyerPage.tsx:325) on a
`target="_blank"` link. The A-I2 fix rewrote the comment (FlyerPage.tsx:318)
to say the suffix "names the destination", which is accurate.

Nothing tells a screen-reader user the link opens a new tab. The old Address
row had the same gap, so this is pre-existing behavior; only the spec's
claim is wrong. The adjudication keeps the words because e2e pins the
accessible name with `/open in Google Maps$/`. Fix: amend D3 to drop "and
the new-tab disclosure", or record the disclosure as a known gap (WCAG
G201 / 3.2.5, advisory at AA).

### P2-F4 - INFO - the AR13 wording and two dashboard comments trail the code

1. Spec section 4 says "a nameless contact reads as its formatted phone",
   and the new section 7 bullet says "name, else the formatted phone". The
   code is `formatPhoneForDisplay(phone) ?? phone` (units.ts:211-217): a
   non-NANP phone shows as stored (pinned by unitsApiActivity.test.ts:427).
   A contact with neither a name nor a phone still shows its raw contactId
   on the Sent to card and the Activity card. That is unreachable through a
   sign-up, which needs a phone, but it contradicts AR13's "never by its raw
   contactId".
2. dashboard/src/routes/listing/listingFormat.ts:225 still reads "by best
   display form: resolved name -> id", and dashboard/src/api/types.ts:3395
   still documents `contactName` as a "Server-resolved display name ...
   absent when unknown". Since A-L2 it is the name, else the phone, else
   absent.
3. The spec now names the AR13 label on the Sent to card and the Activity
   card, but not on Follow up (followUps.ts:92-98, accepted as C-F8). That
   is three surfaces under one rule, with two of them named.

No behavior is wrong. These are a reader's traps only.

### P2-F5 - INFO - D7's absolute sentence stands, and the race bullet leaves out the stray "Not interested" rows

Spec D7 body (design line 426), unchanged: "It also means a public request
can never undo a staff decision." The new section 7 bullet records the
exception but does not point back to that sentence. Section 7 calls its
items "precision amendments ... inside an approved decision", so the body
still asserts a guarantee the code does not give in one ordering.

The bullet also omits a visible side effect the issue records: the outcome
route still writes its "Not interested in <address>" contact-timeline event
and the property Activity row (units.ts:1699-1706). After the race the
contact's timeline says Not interested while the pair reads Signed up, and
the Activity card now shows that row under the contact's formatted phone
(A-L2).

Fix: add "(except the decline-click race, section 7)" to the D7 sentence,
and "the click's Not interested timeline and Activity rows remain" to the
bullet.

## Contesting the adjudications

| Row | Ruling | My position |
|---|---|---|
| C-F1 | FIX; the thread step stays unguarded | Concede. The rejection reason ("guarding it changes the welcome path") holds only for a new contact. For an existing contact the thread step precedes every write, so the 500 loses nothing. The spec now carves the step out explicitly (section 7), so the code conforms. |
| C-F2 | DOC | Closed by the section 7 bullet, with P2-F5's two precision gaps. |
| C-F3 | ACCEPT | Concede the code. The D7 residual text ("its old 'Property text failed' pin reads 'Property sent'") still over-states the case: only an id-less or entry-less pin flips (contactTimeline.ts:731-732). It is harmless, and a one-word "legacy" would match A-L4's own wording. |
| C-F4 | ACCEPT | Concede. |
| C-F5 | ACCEPT | Concede. |
| C-F6 | ACCEPT | Concede. The guard is recorded as OR-14 in the build's records rather than the spec, which is the build's choice. |
| C-F7 | ACCEPT | Concede (my finding agreed it is correct). |
| C-F8 | ACCEPT | Concede. |
| A-M1 | CAMERON | Agree. The sweep confirms `[Rent]` is the ONLY merge field that reads a newly staff-only field (resolveTemplate.ts:76-93), and no AI or catalog path reads deposit, pets, lease terms or accessibility. So the "Staff only - never leaves the dashboard" legend (FlyerTag.tsx:36) is false for rent alone. |
| A-M2, A-L1, A-L3 | FILE | Agree; the filed text is accurate at HEAD (rows 12-13), apart from the older citations in the same files (P2-F1). |
| A-L2 | FIX | Correct and pinned (row 4). |
| A-L4, A-I1, A-I3, A-I4 | ACCEPT | Agree. |
| A-I2 | DOC | Correct for the code comment. The spec keeps the same false claim (P2-F3). |

## Are the fixes correct?

- **C-F1:**
  - Both appends sit in their own try blocks. The catch logs and execution
    falls through to the `housing-fair signup captured` line and
    `res.json({ ok: true })` (public.ts:509-546 and 743-780).
  - No other statement moved, so the order of the pin, the mark, the
    ledger and the audit is unchanged.
  - The PII test now includes the audit step (publicIntake.test.ts:152,
    158). The new main-path test proves the pin, the increment, the ONE
    event and the flyer entry still land when the audit fails.
  - Correct.
- **A-L2:**
  - `recipientLabelOf` was widened from `RecipientDisplay` to its base
    `ContactDisplayItem` (contactsRepo.ts:381-387, which carries `phone`).
    The Sent to caller still type-checks (typecheck EXIT:0 on 33e392aa).
  - The enrichment keeps its best-effort catch, and a missing contact still
    leaves `contactName` absent.
  - Correct.
- **A-I2:** a comment only. Correct.
