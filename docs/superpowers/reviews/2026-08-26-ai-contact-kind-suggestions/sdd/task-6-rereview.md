# Task 6 prompt-contract fix rereview

Verdict: **FAIL**. The two reported prompt-contract defects are corrected and
their regression assertions are load-bearing, but a separate approved-example
qualification was missed by the first pass. One MEDIUM must-fix remains.

## Finding

### MEDIUM - The represented-client example can suppress a clearly established Partner

The approved sixth D3 example is conditional: `"I am calling about a client"`
produces no suggestion only **without a clear outside role**
(`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:133-136`).
D4 also says a clear outside service/program/navigation role is Partner and that
`none` is for evidence that overlaps or does not establish the distinction
(`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:138-154`).

The live prompt drops that condition:

```text
app/src/services/extraction/prompt.ts:90
"I am calling about a client" -> none.
```

That unconditional arrow conflicts with the exact Partner rule at
`app/src/services/extraction/prompt.ts:75-80`. A current contact who says both
`"I am her caseworker"` and `"I am calling about a client"` has clearly
established Partner, but the sixth example simultaneously directs `none`. This
weakens a common Partner case and is not equivalent in meaning to the approved
example.

The prompt-contract test pins the weakened version rather than the approved
qualification: `app/test/extractionSchema.test.ts:365-375` expects only that the
line contains `-> none`. It never requires `without a clear outside role` (or an
equivalent sentence-alone qualification), so removing the approved condition is
green by construction.

Required correction: make the example conditional, for example:

```text
"I am calling about a client" -> none unless other current-transcript evidence
clearly establishes an outside service/program/navigation role.
```

Pin that qualification on the same example line. A focused prompt-contract test
should fail if the line reverts to unconditional `-> none` while the four exact
kind rules remain unchanged.

## Repaired attacks that held

1. **Neutral current-contact framing - PASS.** The opening now defines `client`
   only as the existing wire label for the CURRENT external contact and explicitly
   says that label does not assign a housing-related role
   (`app/src/services/extraction/prompt.ts:14-18`). The old `person seeking housing
   help` premise is absent from the live prompt. The positive wire-label assertion
   and negative exact-regression assertion at
   `app/test/extractionSchema.test.ts:360-364` both fail under a revert of the
   repaired opening, so this is not a free-floating substring check.

2. **Mentioned-caseworker qualification - PASS.** The example now permits Tenant
   only when other current-transcript evidence establishes that the caller seeks
   housing for themselves or their household, says the mentioned caseworker is not
   the contact, and maps the sentence alone to `none`
   (`app/src/services/extraction/prompt.ts:89`). The three same-line assertions at
   `app/test/extractionSchema.test.ts:380-386` make each semantic clause
   load-bearing and do not retain the former unconditional-Tenant assertion.

3. **Exact four-kind criteria and the other five examples - PASS.** Tenant,
   Landlord, Property Manager, and Partner remain mutually exclusive and
   evidence-based at `app/src/services/extraction/prompt.ts:66-83`. The Tenant,
   owner, manager, self-identified caseworker, and mentioned-caseworker examples
   still match D3/D4. Only the represented-client example above fails the approved
   meaning.

4. **Fix-scope test quality - PASS for the two fixes; PARTIAL for the complete
   six-example contract.** Reverting either repaired prompt passage breaks its new
   assertions. The remaining gap is the pre-existing sixth-example test, which
   asserts only the weakened result token and misses the required condition.

## Evidence and constraints

- `git diff --check cddac44d..4072e978`: exit 0.
- Static review was against clean `4072e978` on
  `feat/ai-contact-kind-suggestions`.
- Per the exhausted recovery constraint, no Vite or Vitest command was invoked.
- Prior permitted focused evidence from `task-6-fix-report.md`: red `1 failed | 1
  passed` / `1 failed | 46 passed`, exit 1; green `2 passed` / `47 passed`, exit
  0; app typecheck exit 0; touched-file ESLint exit 0. That evidence proves the two
  repaired assertions ran, but it cannot cover the sixth-example qualification
  that the test does not assert.
