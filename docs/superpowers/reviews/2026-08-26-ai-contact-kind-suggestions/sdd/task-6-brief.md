### Task 6: Activate the four-kind extraction contract

**Files:**
- Modify: `app/src/services/extraction/schema.ts:119-128,242-251,420-429`
- Modify: `app/src/services/extraction/prompt.ts:14-29,50-90`
- Test: `app/test/extractionSchema.test.ts`
- Test: `app/test/extractionOps.test.ts`

**Interfaces:**
- Consumes: Task 1's `SuggestedContactKind` union and the completed extraction, PATCH, and dashboard consumers from Tasks 2-5.
- Produces: the exact schema enum `['tenant', 'landlord', 'property_manager', 'partner', 'none']`, an applicable parser for the four canonical kinds, preserved raw attempted-output diagnostics, and a prompt contract that classifies the current external contact only.
- Activation gate: do not begin this task until the focused checks for Tasks 2-5 pass. This is the first task allowed to make a real model response produce Partner or Property Manager.

- [ ] **Step 1: Add red parser, schema, and raw-operation tests**

Pin the nested enum, both newly applicable values, the `none` fold, unsupported applicable output, and unchanged raw diagnostics:

```ts
it('pins the complete staff-facing kind enum plus the none sentinel', () => {
  const typeSuggestion = (
    EXTRACTION_SCHEMA.properties as Record<string, Record<string, unknown>>
  )['typeSuggestion'];
  const properties = typeSuggestion?.['properties']
    as Record<string, Record<string, unknown>>;
  expect(properties['value']?.['enum']).toEqual([
    'tenant',
    'landlord',
    'property_manager',
    'partner',
    'none',
  ]);
});

it.each(['partner', 'property_manager'] as const)(
  'parses the canonical %s kind',
  (kind) => {
    const result = parseExtractionText(JSON.stringify({
      fields: {},
      typeSuggestion: { value: kind, reason: 'clear self-identification' },
    }));
    expect(result.typeSuggestion).toEqual({
      value: kind,
      reason: 'clear self-identification',
    });
  },
);

it('folds none and an unsupported kind to no applicable type suggestion', () => {
  const none = parseExtractionText(JSON.stringify({
    fields: {},
    typeSuggestion: { value: 'none', reason: '' },
  }));
  const unsupported = parseExtractionText(JSON.stringify({
    fields: {},
    typeSuggestion: { value: 'caseworker', reason: 'off enum' },
  }));
  expect(none.typeSuggestion).toBeUndefined();
  expect(unsupported.typeSuggestion).toBeUndefined();
});

it.each(['partner', 'property_manager'])(
  'retains %s as the attempted type operation',
  (kind) => {
    expect(parseExtractionOps(JSON.stringify({
      typeSuggestion: { value: kind, reason: 'stated role' },
    })).type).toEqual({ op: 'suggest', value: kind, reason: 'stated role' });
  },
);
```

Retain the existing off-enum `caseworker` assertion as `op: 'suggest'`; raw attempted output must not be rewritten into a decline.

- [ ] **Step 2: Add red prompt-contract tests**

Add explicit positive and negative phrases:

```ts
it('classifies the current external contact into four mutually exclusive kinds', () => {
  const sys = buildExtractionSystemPrompt();
  expect(sys).toContain('CURRENT external contact');
  const examples = [
    ['I am looking for a two-bedroom home for my family', 'Tenant'],
    ['I own three rental properties', 'Landlord'],
    ['I manage three properties for the owner', 'Property Manager'],
    ['I am her caseworker at Hope Atlanta', 'Partner'],
    ['My caseworker at Hope Atlanta told me to call', 'Tenant'],
    ['I am calling about a client', 'none'],
  ] as const;
  for (const [phrase, expected] of examples) {
    const line = sys.split('\n').find((candidate) => candidate.includes(phrase));
    expect(line, phrase).toBeDefined();
    expect(line).toContain(`-> ${expected}`);
  }
  const managerLine = sys.split('\n')
    .find((line) => line.includes('I manage three properties for the owner'));
  expect(managerLine).toContain('not Landlord and not Partner');
  const mentionedCaseworkerLine = sys.split('\n')
    .find((line) => line.includes('My caseworker at Hope Atlanta told me to call'));
  expect(mentionedCaseworkerLine).toContain(
    'mentioned caseworker is not the contact',
  );
  expect(sys).toContain('value "none"');
});

it('requires current-transcript evidence and preserves concise role notes', () => {
  const sys = buildExtractionSystemPrompt();
  expect(sys).toContain('current transcript');
  expect(sys).toContain('Identified as a caseworker at Hope Atlanta');
  expect(sys).toContain('Identified as property manager for Example Homes');
  expect(sys).toContain('never infer an organization');
  expect(sys).toContain('RECONCILE every noteLine against the profile notes');
});
```

- [ ] **Step 3: Run the focused tests and verify both intended red causes**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
```

Expected: FAIL because the live schema/parser still permit only Tenant and Landlord and because the prompt still has the old tenant-biased rule. The existing off-enum diagnostic assertion must remain green.

- [ ] **Step 4: Widen the structured schema and applicable parser**

Use the canonical union from Task 1:

```ts
const SUGGESTED_CONTACT_KINDS = [
  'tenant',
  'landlord',
  'property_manager',
  'partner',
] as const satisfies readonly SuggestedContactKind[];

function isSuggestedContactKind(value: unknown): value is SuggestedContactKind {
  return typeof value === 'string'
    && (SUGGESTED_CONTACT_KINDS as readonly string[]).includes(value);
}
```

Set the schema enum to the four values plus `none`. Parse only `isSuggestedContactKind(typeSuggestion.value)`. Keep `parseExtractionOps` stringly so every non-empty value except `none` remains an attempted suggestion for forensic review.

- [ ] **Step 5: Replace the prompt classification block**

Write an explicit rule block equivalent to:

```ts
const kindRules = [
  '- typeSuggestion is about the CURRENT external contact whose transcript lines use the existing "client" speaker label.',
  '- Use it only when CURRENT PROFILE.contactType is "unknown" and the current transcript clearly establishes exactly one kind.',
  '- Tenant: seeks housing for themselves or their household.',
  '- Landlord: owns or personally offers housing they control.',
  '- Property Manager: manages, leases, lists, or coordinates properties for an owner or landlord; working for a landlord is not Partner and does not make the contact Landlord.',
  '- Partner: works in an outside service, program, agency, inspection, or navigation role and is not the housing seeker, owner, or property manager.',
  '- A represented or mentioned person never determines this contact kind and their facts never belong on this profile.',
  '- Do not guess from an organization name or one ambiguous word such as "manager", "agent", or "client". When evidence overlaps or is unclear, emit value "none".',
  '- A clear Partner or Property Manager identification also adds one concise role or organization noteLine, using only stated facts and the existing note reconciliation rules.',
];
```

Include the six approved D3 examples verbatim in meaning, retain `client` and `speakerRoles` wire labels, remove the old caseworker suppression, and do not pin a literal prompt fingerprint. `extractionPromptFingerprint()` already hashes the prompt and schema bytes.

- [ ] **Step 6: Run focused contract tests and app typecheck**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both commands PASS. Confirm the optional-parameter-count test remains green and the prompt fingerprint derives a new value without a hard-coded expectation.

- [ ] **Step 7: Commit runtime activation**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/services/extraction/schema.ts app/src/services/extraction/prompt.ts app/test/extractionSchema.test.ts app/test/extractionOps.test.ts
git commit -m "feat: activate four AI contact kinds" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the commit contains only the runtime contract and its tests. Every persistence, route, and dashboard consumer is already present and green.

---

