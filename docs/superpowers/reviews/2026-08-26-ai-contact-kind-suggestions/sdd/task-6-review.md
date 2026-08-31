# Task 6 runtime activation review

Verdict: **FAIL**. Two prompt-contract findings are must-fix before S6 can be
accepted. The schema/parser/raw-audit activation and ordering checks otherwise
hold.

## Findings

### 1. HIGH - The prompt still defines every external contact as a housing seeker

The approved D3 contract explicitly says the prompt must stop defining every
contact as a person seeking housing
(`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:111-114`).
The live prompt still opens with exactly that tenant-biased definition:

```text
app/src/services/extraction/prompt.ts:14-17
You extract facts about the CLIENT ... a client (a
person seeking housing help).
```

The later current-contact rules at `prompt.ts:65-79` do not remove the earlier
contradictory role definition. This is the first framing the model receives, and
it tells the model that an Unknown owner, property manager, or outside partner is
already a housing seeker before asking it to choose among the four exclusive
kinds. That is the precise Tenant bias D3 required S6 to remove, so runtime
activation can systematically misclassify the three non-Tenant kinds even though
the structured output is valid.

The new contract test does not catch the regression: it only requires the later
substring `CURRENT external contact`
(`app/test/extractionSchema.test.ts:360-362`) and has no assertion that the old
`person seeking housing help` definition is absent.

Required correction: make the opening CLIENT definition neutral and identify
`client` only as the existing wire label for the current external contact. Add a
negative regression assertion for the removed housing-seeker definition in
addition to the positive neutral-framing assertion.

### 2. MEDIUM - The caseworker-mention example turns conditional Tenant evidence into an unconditional classification

The approved example is conditional: the speaker is Tenant **when the speaker is
seeking housing for themselves**; the mentioned caseworker is not the contact
(`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:134-135`).
D4 separately requires the current transcript to establish the selected kind and
requires `none` for insufficient or ambiguous evidence
(`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:140-154`).

The shipped prompt instead says:

```text
app/src/services/extraction/prompt.ts:88
"My caseworker at Hope Atlanta told me to call" -> Tenant
```

That sentence proves that the mentioned caseworker is not the current contact,
but by itself it does not prove that the caller seeks housing for themselves or
their household. The unconditional arrow can classify a caller as Tenant from a
third-person relationship alone. The new test repeats and therefore pins the
weakened meaning at `app/test/extractionSchema.test.ts:363-381` instead of pinning
the approved qualification.

Required correction: preserve the approved condition in the example, making
clear that other current-transcript evidence must establish that the speaker is
seeking housing for themselves; without that evidence this sentence alone yields
`none`. Update the test to require that qualification rather than only the
unconditional `-> Tenant` text.

## Mandatory attacks that held

- **Exact schema enum/order:** `app/src/services/extraction/schema.ts:132-140`
  is exactly `tenant`, `landlord`, `property_manager`, `partner`, `none`; the
  exact-order test is at `app/test/extractionSchema.test.ts:62-76`.
- **Applicable-versus-diagnostic separation:** the sole backend wire union remains
  in `app/src/adapters/extraction.ts:73-77`; schema imports it and its allowlist at
  `schema.ts:42-52` admits only the four canonical values. `parseExtractionText`
  at `schema.ts:246-257` therefore preserves Tenant/Landlord behavior, activates
  Partner/Property Manager, and folds `none` plus every off-enum value to absent.
  There is no second backend union. The dashboard's separate boundary union
  predates S6 and is the approved client boundary, not a second extraction union.
- **Raw attempted output:** `parseExtractionOps` remains stringly at
  `schema.ts:420-430`: every nonempty string other than exact `none` is retained
  unchanged as a `suggest` value, including off-enum `caseworker`; the focused
  tests cover both new canonical values and the off-enum diagnostic at
  `app/test/extractionOps.test.ts:71-83`.
- **Four-way distinctions:** aside from the two findings above, the prompt keeps
  `client` and `speakerRoles` wire terms, makes Property Manager distinct from
  Landlord and Partner, makes Partner distinct from seeker/owner/manager, rejects
  organization and ambiguous-word guessing, includes all six D3 phrases, and
  retains concise stated-fact note guidance plus full existing note
  reconciliation (`prompt.ts:65-110`).
- **Fingerprint:** `extractionPromptFingerprint()` is still derived from the live
  prompt plus serialized schema at `prompt.ts:123-138`; its test recomputes those
  bytes rather than pinning a literal fingerprint
  (`app/test/extractionSchema.test.ts:345-357`).
- **Consumer-before-activation order:** `git merge-base --is-ancestor d4fb6f2c
  cddac44d` exited 0. The activation commit directly follows the completed S5
  consumer commit, and `git diff --name-only d4fb6f2c..cddac44d` contains only the
  two runtime contract files and their two tests. The mission ledger records the
  S2-S5 focused-gate precondition satisfied before S6 dispatch at
  `.superpowers/sdd/progress.md:102-114`.
- **Scope/unintended effects:** no persistence, route, dashboard, seed, import,
  migration, configuration, feature-flag, infra, or deployment file is in this
  slice. Existing exact Tenant and Landlord parser applicability remains intact.
  The two prompt findings prevent a clean compatibility verdict at model-runtime
  level, but no separate Tenant/Landlord parser regression was found.

## Evidence and constraints

- Static `git diff --check d4fb6f2c..cddac44d`: exit 0.
- Commit/scope independently verified at
  `cddac44d689f3cab1c857c6e512cfa9408023687` on
  `feat/ai-contact-kind-suggestions`.
- Per the exhausted recovery constraint, this review did not invoke Vite or
  Vitest. The permitted-path evidence recorded in `task-6-report.md` is:
  red `1 failed | 1 passed`, `5 failed | 42 passed`, exit 1; green `2 passed`,
  `47 passed`, exit 0; app typecheck exit 0; touched-file ESLint exit 0. Those
  tests are green but, as shown above, their prompt assertions do not cover the
  two approved semantic requirements that failed static review.
