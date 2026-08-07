---
id: founder-whisper-copy-unguarded-after-press-0-removal
title: voice.whisper_founder lost its only press-0 assertion, so a re-added team-escape clause on the founder leg would ship untested
type: debt
severity: low
status: open
area: app/voice
created: 2026-08-06
refs: app/test/founderTriage.test.ts:455, app/test/voiceWebhook.test.ts:304, app/src/messages/catalog.ts
---

**Problem.** Removing the press-0 escape (2026-08-06) left the two whisper
catalog entries, `voice.whisper_founder` and `voice.whisper_relay`, with
byte-identical copy but SEPARATE ids - kept apart deliberately, because they
address different contexts and are independently editable.

Only ONE of them is now guarded against the clause coming back:

- `voice.whisper_relay` IS guarded. `voiceWebhook.test.ts:304` asserts
  `expect(xml.toLowerCase()).not.toContain('press 0')` on the relay whisper
  response, and that assertion is genuinely able to fail - the same test asserts
  `toContain('Press 1')` two lines above, proving the catalog copy really does
  flow into that XML.
- `voice.whisper_founder` is NOT. Its only negative assertion,
  `expect(xml).not.toContain('reach the team')` (formerly
  `founderTriage.test.ts:467`), was deleted during the build. The test that
  remains (`:455`) asserts the positive content only ("announces the caller +
  press 1 to accept").

So re-adding a team-escape clause to the FOUNDER entry would ship green.

**The deletion was correct, and was instructed.** Once the clause was gone from
every catalog entry, that negative assertion could no longer fail - a vacuous
test, which this codebase treats as worse than no test. The plan explicitly
ordered its removal. The gap is a second-order consequence nobody costed: the
assertion was doing double duty, and only its vacuous half was noticed.

Found by the plan-blind adversarial reviewer during the pre-merge review of
`feat/business-number-config` (merged @25944207).

**Suggested fix.** Do NOT restore the negative assertion - it would be vacuous
again. Assert the founder whisper's copy POSITIVELY instead, so any drift in
that entry (a re-added clause, an edit, a wrong id) fails:

    expect(xml).toContain('You have a Housing Choice call from');
    expect(xml).toContain('Press 1 to accept.');
    expect(xml.toLowerCase()).not.toContain('press 0');

The final line is only non-vacuous BECAUSE the two above prove the founder
copy reaches this XML - keep them together.
