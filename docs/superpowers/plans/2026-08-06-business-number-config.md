# Business Phone Number Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the positional `OUR_PHONE_NUMBERS` list with a singular
`BUSINESS_PHONE_NUMBER`, give "is this one of ours?" one named definition,
remove the broken press-0 team dial, surface the number read-only in the
dashboard, and correct the documentation that is wrong today.

**Architecture:** One config field replaces an array whose `[0]` was silently
special. One factory-built predicate replaces two inline copies of a
business-number-or-pool-number check. Press-0 is deleted rather than repaired.
The dashboard reads the number from two existing endpoints, never from an
independent lookup.

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB, Vitest, React +
React Router, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-06-business-number-config-design.md`
Read section 0 and section 5 before starting. The spec is authoritative; where
this plan and the spec disagree, STOP and ask.

## Global Constraints

- ASCII-ONLY on every added line (specs, plans, issues, comments, test names,
  log strings, seed strings). Verify: `tr -d '\11\12\15\40-\176' < FILE | wc -c`
  must print `0`. On a file that already contains non-ASCII, only ADDED lines
  must be ASCII.
- NEVER rewrite source files with PowerShell `Get-Content`/`-replace`/
  `Set-Content` (BOM-less UTF-8 read as ANSI produces mojibake). Use the Edit
  tool.
- Commit discipline: a gating bare `git status` READ as its OWN command before
  EVERY commit; stage EXPLICIT paths only, never `git add -A`; every commit
  carries a `Co-Authored-By:` trailer naming the authoring model.
- Gates run BARE, never piped: `npm run typecheck`, `npm test`,
  `timeout 1500 npm run e2e`. `npm run typecheck` is REQUIRED and SEPARATE -
  the test suites run through esbuild/tsx and strip types WITHOUT checking
  them, so green tests prove nothing about types.
- e2e runs ONLY from the worktree. `npm run e2e -- --flag` never reaches
  playwright (npm eats it); use the full suite from the worktree root, or a
  filtered run from the `e2e/` workspace dir.
- NO INFRA, EVER, in this plan: no terraform, no `secrets:push`, no SSM writes,
  no `deploy:*`, no edits to real `.env.<env>` files. Owed operator actions are
  RECORDED in the handback and RUNBOOK, never performed.
- New user-facing automated copy goes through the message catalog only.
- Do NOT run test suites while a live e2e session is running (shared DynamoDB).
- Known flakes - re-run the full suite before blaming your change, and report
  both runs: `tour-reminders-panel-e2e-flake`,
  `conversationdetail-members-mock-suite-flake`.

## Naming contract (used by every task)

- Env var: `BUSINESS_PHONE_NUMBER`
- Config field: `businessPhoneNumber: string | undefined`
- Predicate factory: `createOurNumberKind({ config, conversations })`
- Predicate call: `(number: string) => Promise<'business' | 'pool' | undefined>`
- API field on both `/api/settings` responses: `businessPhoneNumber`
- API field on `/api/system/flags`: `businessPhoneNumber`

Use these EXACT names. A later task depends on each of them.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `app/src/lib/config.ts` | parse/validate the singular value | 1 |
| `app/src/services/ourNumberKind.ts` (NEW) | the one "is this ours" definition | 4 |
| `app/src/routes/webhooks/twilio.ts` | SMS echo guard uses the predicate | 4 |
| `app/src/routes/webhooks/voice.ts` | voice echo guard + caller IDs; press-0 removal | 2, 4, 5 |
| `app/src/messages/catalog.ts` | whisper copy; delete `team_unreachable` | 5 |
| `app/src/routes/settings.ts` | expose the number on GET and PUT | 6 |
| `app/src/routes/system.ts` | expose the number on flags | 6 |
| `dashboard/src/routes/settings/NumbersSection.tsx` | "Our number" block, retitle, role-gated fetch | 7 |
| `dashboard/src/routes/settings/FlagPills.tsx` | System status row + caveat copy | 8 |
| `RUNBOOK.md`, `.env*.example`, `docs/issues/*` | documentation truth | 9 |

## Task order and independence

Tasks 1-3 are the rename and MUST land together (task 1 alone leaves the tree
red). Task 4 (predicate), Task 5 (press-0), and Tasks 6-8 (dashboard) are
independently mergeable after 1-3. Task 9 (docs) can land any time after 1-3.
If time runs short, stop AFTER a task, never inside one.

---

### Task 1: Singular config value

**Files:**
- Modify: `app/src/lib/config.ts:205-211` (type), `:1126-1150` (parse), `:1205`
- Test: `app/test/twilioSmsWebhook.test.ts:1055-1070`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig.businessPhoneNumber: string | undefined`. Every later
  task reads this field.

**Watch item:** blank means UNCONFIGURED, not invalid. `OUR_PHONE_NUMBERS=`
parses to `[]` today and four suites plus `scripts/dev.mjs` depend on that. A
blank `BUSINESS_PHONE_NUMBER` MUST NOT throw.

- [ ] **Step 1: Rewrite the config-parse test to describe the singular value**

Replace the whole `describe('config: OUR_PHONE_NUMBERS / MEDIA_BUCKET parsing')`
block's phone-number tests in `app/test/twilioSmsWebhook.test.ts` (the
multi-entry parse test at :1056-1062 and the default/fail-fast test that
follows) with:

```ts
describe('config: BUSINESS_PHONE_NUMBER parsing', () => {
  it('parses a single E.164 number with surrounding whitespace tolerated', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      BUSINESS_PHONE_NUMBER: '  +15550009999  ',
    } as NodeJS.ProcessEnv);
    expect(config.businessPhoneNumber).toBe('+15550009999');
  });

  it('is undefined when unset', () => {
    expect(
      loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).businessPhoneNumber,
    ).toBeUndefined();
  });

  it('treats a blank value as unconfigured and does NOT throw', () => {
    expect(
      loadConfig({ NODE_ENV: 'test', BUSINESS_PHONE_NUMBER: '   ' } as NodeJS.ProcessEnv)
        .businessPhoneNumber,
    ).toBeUndefined();
  });

  it('fails fast on a non-E.164 value', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', BUSINESS_PHONE_NUMBER: '555-0100' } as NodeJS.ProcessEnv),
    ).toThrow(/E\.164/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run test/twilioSmsWebhook.test.ts -t "BUSINESS_PHONE_NUMBER"`
Expected: FAIL - `businessPhoneNumber` is undefined on every case because the
field does not exist yet, so the first test fails on the expected value.

- [ ] **Step 3: Replace the type declaration**

In `app/src/lib/config.ts`, replace the `ourPhoneNumbers` declaration at
:205-211 with:

```ts
  /**
   * OUR one business phone number (E.164, from BUSINESS_PHONE_NUMBER).
   * Exactly one per environment: dev keeps the 404 number, prod uses the
   * ported 678 number, under separate Messaging Services (see
   * docs/superpowers/specs/2026-08-06-business-number-config-design.md).
   * It is the outbound SMS sender, the outbound voice caller ID, the public
   * flyer CTA number, and one half of the echo/author defense (the other half
   * is the dynamic relay pool - see services/ourNumberKind.ts).
   * `undefined` means unconfigured, which is legal outside prod+twilio.
   */
  businessPhoneNumber: string | undefined;
```

- [ ] **Step 4: Replace the parse and validation block**

Replace `app/src/lib/config.ts:1126-1150` (from the `// Comma-separated E.164
list` comment through the closing brace of the production fail-fast) with:

```ts
  // Exactly one E.164 business number; whitespace tolerated. Absent OR blank
  // means unconfigured (the echo defense then relies on the relay-pool arm
  // plus SID dedupe). Blank MUST NOT throw - `BUSINESS_PHONE_NUMBER=` is how
  // dev/test stacks say "no business number".
  const businessRaw = (env.BUSINESS_PHONE_NUMBER ?? '').trim();
  const businessPhoneNumber = businessRaw.length > 0 ? businessRaw : undefined;
  if (businessPhoneNumber !== undefined && !/^\+[1-9]\d{1,14}$/.test(businessPhoneNumber)) {
    // Fail fast on a malformed value: a silently-dropped business number
    // disables the echo/author defense AND leaves outbound sends unpinned.
    throw new Error(
      `BUSINESS_PHONE_NUMBER must be E.164 (+1...), got: ${businessPhoneNumber}`,
    );
  }
  // Echo defense #1 (doc 7.1) must be un-misconfigurable: a production stack
  // talking to real Twilio with no business number would silently run on
  // SID-dedupe alone AND let the Messaging Service pick the sender.
  if (messagingDriver === 'twilio' && nodeEnv === 'production' && businessPhoneNumber === undefined) {
    throw new Error(
      'BUSINESS_PHONE_NUMBER is required when MESSAGING_DRIVER=twilio and NODE_ENV=production - it ' +
        'is the echo/author defense and the pinned outbound sender. Hydrate from Parameter Store ' +
        '(npm run secrets:push). Refusing to start without it.',
    );
  }
```

NOTE ON ENCODING: `config.ts` already contains non-ASCII characters (section
signs in doc references). Your ADDED lines must be ASCII, but you must not
mangle the pre-existing ones - which is exactly what a PowerShell
`Get-Content`/`Set-Content` rewrite would do. Use the Edit tool only.

- [ ] **Step 5: Update the returned config object**

At `app/src/lib/config.ts:1205`, replace `ourPhoneNumbers,` with
`businessPhoneNumber,`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd app && npx vitest run test/twilioSmsWebhook.test.ts -t "BUSINESS_PHONE_NUMBER"`
Expected: PASS (4 tests). The rest of the repo is now RED - that is expected
and Task 2 fixes it. Do NOT commit yet.

---

### Task 2: Every `[0]` consumer reads the new field

**Files:**
- Modify: `app/src/app.ts:136`, `app/src/routes/contactTimeline.ts:351`,
  `app/src/routes/webhooks/voice.ts:295,303-309,1119`,
  `app/src/services/originateCall.ts:96`,
  `app/src/services/sendMessage.ts:327,338`,
  `app/src/routes/voiceApi.ts:248`,
  `app/src/adapters/messaging.ts:58` (JSDoc only),
  `app/src/routes/public.ts:161,175` (COMMENTS only)
- Test: `app/test/sendMessage.test.ts` (DELETE one test),
  `app/test/voiceReadiness.test.ts`, `app/test/helpers/twilioWebhookHarness.ts:2652`,
  and the env key in `broadcastApi`, `configRelayLiveProvisioning`,
  `contactTimeline`, `inbox.integration`, `messaging`, `messagingApiBaseUrl`,
  `missedCallAutoText`, `voiceOutbound`, `voiceTranscriptJobs`

**Interfaces:**
- Consumes: `config.businessPhoneNumber` (Task 1).
- Produces: a green `npm run typecheck`.

**Watch item:** `app/src/routes/webhooks/voice.ts:382` is a COMMENT, not code.
Update its wording; do NOT add a check there. Inbound routing is
pool-else-founder-triage and has no business-number gate today (voice.ts:373-390).

- [ ] **Step 1: Delete the multi-entry behavior test**

In `app/test/sendMessage.test.ts`, DELETE the whole test
`it('pins the FIRST entry when OUR_PHONE_NUMBERS lists several (the ported number goes first)', ...)`.
Do not adapt it - it asserts a behavior that ceases to exist, and adapting it
would preserve the appearance of coverage for a deleted code path.

Update the three surviving tests in that `describe('outbound sender pinning (1:1)')`
block to use the new env key, e.g.:

```ts
    const f = makeFakes({ env: { BUSINESS_PHONE_NUMBER: MAIN } });
```

and rename the first test to
`'pins `from` to the business number (BUSINESS_PHONE_NUMBER) on a 1:1 send'`.

- [ ] **Step 2: Run the suite to see the expected failures**

Run: `cd app && npx vitest run test/sendMessage.test.ts`
Expected: FAIL - the pinning tests fail because `sendMessage.ts` still reads
`config.ourPhoneNumbers[0]`, which no longer exists.

- [ ] **Step 3: Update the eight production reads**

Each is a mechanical substitution of `config.ourPhoneNumbers[0]` with
`config.businessPhoneNumber`. Exact sites:

```
app/src/app.ts:136                      contactNumber wiring
app/src/routes/contactTimeline.ts:351   thread "which side is us"
app/src/routes/webhooks/voice.ts:295    founder-bridge caller ID
app/src/routes/webhooks/voice.ts:1119   whisper-gate caller ID
app/src/services/originateCall.ts:96    outbound voice caller ID
app/src/services/sendMessage.ts:338     pinned 1:1 SMS sender
app/src/routes/voiceApi.ts:248          staff cell-verification sender
```

In `app/src/services/sendMessage.ts:327`, update the comment that names
`ourPhoneNumbers[0]` to name `businessPhoneNumber`.

In `app/src/adapters/messaging.ts:58`, update the JSDoc phrase
`the main business number, ourPhoneNumbers[0]` to
`the business number, config.businessPhoneNumber`.

In `app/src/routes/public.ts:161` and `:175`, update the COMMENT text only.

- [ ] **Step 4: Update the voice readiness log literal**

At `app/src/routes/webhooks/voice.ts:303-309`, the log line's literal
`'NOT configured (OUR_PHONE_NUMBERS[0])'` becomes
`'NOT configured (BUSINESS_PHONE_NUMBER)'`. This string is ASSERTED by
`app/test/voiceReadiness.test.ts` - update that assertion in the same step or
the suite goes red for the wrong reason.

- [ ] **Step 5: Update the test harness and every test env key**

`app/test/helpers/twilioWebhookHarness.ts:2652` - change
`OUR_PHONE_NUMBERS: OUR_NUMBER` to `BUSINESS_PHONE_NUMBER: OUR_NUMBER`.

Then grep and update the rest:

```bash
cd app && grep -rn "OUR_PHONE_NUMBERS\|ourPhoneNumbers" test/ src/
```

Every remaining hit is either an env key in a `loadConfig({...})` call (rename
the key) or a comment (reword). There must be ZERO hits when you are done.

- [ ] **Step 6: Run typecheck and the app suite**

Run: `npm run typecheck`
Expected: PASS. A remaining `ourPhoneNumbers` reference is a compile error -
that is the point of deleting the old symbol.

Run: `cd app && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit tasks 1 and 2 together**

```bash
git status
git add app/src/lib/config.ts app/src/app.ts app/src/routes/contactTimeline.ts app/src/routes/webhooks/voice.ts app/src/services/originateCall.ts app/src/services/sendMessage.ts app/src/routes/voiceApi.ts app/src/adapters/messaging.ts app/src/routes/public.ts app/test
git commit -m "refactor(config): OUR_PHONE_NUMBERS list becomes singular BUSINESS_PHONE_NUMBER"
```

(Run `git status` as its own command FIRST, and read it, before the add.)

---

### Task 3: Tooling, scripts and e2e fixtures

**Files:**
- Modify: `scripts/dev.mjs:214-223`, `scripts/e2e-session.mjs:147`,
  `scripts/poolNumbersAudit.mjs:16,19,22,42,184,201,226,227`,
  `e2e/fixtures/fakeTwilio.ts:32`, `e2e/scenarios/steps.ts:43` (comment)

**Interfaces:**
- Consumes: the `BUSINESS_PHONE_NUMBER` env name (Task 1).
- Produces: an e2e stack that boots on the new name.

**Watch item:** none of these files is typechecked. A missed one does not fail
the build - `e2e/fixtures/fakeTwilio.ts:32` in particular has a SILENT `??`
default and would keep "working" against a dead variable name. Grep, do not
trust the compiler.

- [ ] **Step 1: Force-set the mock number instead of appending**

In `scripts/dev.mjs`, replace the append block at :214-223 with:

```js
  // FORCE the fake's app-number as the business number in mock mode. Do NOT
  // preserve a real number from .env.dev: the app pins outbound `from` to the
  // business number, and fake-twilio treats any `from` that is not its own app
  // number as a relay POOL leg (fake-twilio/src/engine/engine.ts:294), so a
  // real number here registers a spurious relay group for every 1:1 send.
  childEnv.BUSINESS_PHONE_NUMBER = '+15550009999';
```

- [ ] **Step 2: Rename in the remaining scripts and fixtures**

```
scripts/e2e-session.mjs:147          OUR_PHONE_NUMBERS -> BUSINESS_PHONE_NUMBER
scripts/poolNumbersAudit.mjs         the env read at :184 and every mention in
                                     comments/output at :16,19,22,42,201,226,227
e2e/fixtures/fakeTwilio.ts:32        process.env.OUR_PHONE_NUMBERS?.split(',')[0]
                                     becomes process.env.BUSINESS_PHONE_NUMBER
e2e/scenarios/steps.ts:43            comment wording
```

For `poolNumbersAudit.mjs:184`, the value is now a single string, not a list -
build the `businessNumbers` set from the one value:

```js
    const configured = (entries.BUSINESS_PHONE_NUMBER ?? '').trim();
    const businessNumbers = new Set(configured.length > 0 ? [configured] : []);
```

and update the empty-case message at :201 to
`'(BUSINESS_PHONE_NUMBER is empty!)'` and the header at :226 to
`'Business (BUSINESS_PHONE_NUMBER - never pool, never touched):'`.

- [ ] **Step 3: Prove nothing references the old name**

Run: `grep -rn "OUR_PHONE_NUMBERS" --include="*.ts" --include="*.mjs" --include="*.tsx" app dashboard e2e scripts fake-twilio`
Expected: NO output. (Documentation is Task 9.)

- [ ] **Step 4: Run the full gates**

Run: `npm run typecheck`
Run: `npm test`
Run: `timeout 1500 npm run e2e`
Expected: all PASS. e2e proves the renamed env actually boots the stack.

- [ ] **Step 5: Commit**

```bash
git status
git add scripts/dev.mjs scripts/e2e-session.mjs scripts/poolNumbersAudit.mjs e2e/fixtures/fakeTwilio.ts e2e/scenarios/steps.ts
git commit -m "refactor(tooling): scripts and e2e fixtures read BUSINESS_PHONE_NUMBER"
```

---

### Task 4: One named "is this one of ours?" predicate

**Files:**
- Create: `app/src/services/ourNumberKind.ts`
- Create: `app/test/ourNumberKind.test.ts`
- Modify: `app/src/routes/webhooks/twilio.ts:278,870-882`,
  `app/src/routes/webhooks/voice.ts:291,362-370`

**Interfaces:**
- Consumes: `config.businessPhoneNumber` (Task 1);
  `ConversationsRepo.getByPoolNumber` (existing).
- Produces:
  ```ts
  export function createOurNumberKind(deps: {
    config: Pick<AppConfig, 'businessPhoneNumber'>;
    conversations: Pick<ConversationsRepo, 'getByPoolNumber'>;
  }): (number: string) => Promise<'business' | 'pool' | undefined>;
  ```

**Watch items:**
- Use `getByPoolNumber` (a single Query), NOT `getAllByPoolNumber` (which pages
  the whole partition). Both are truthy exactly when the GSI has any item
  (`conversationsRepo.ts:1380-1416`), and the voice guard runs on an
  inbound-CALL webhook where the paged read would be strictly worse.
- The FOUR existing echo-drop log lines must survive BYTE-IDENTICAL. That is
  why the predicate returns which arm matched instead of a boolean.
- This is de-duplication only. NO behavior change.

- [ ] **Step 1: Write the failing test**

Create `app/test/ourNumberKind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createOurNumberKind } from '../src/services/ourNumberKind.js';

const BUSINESS = '+15550009999';
const POOL = '+15550109001';

function make(poolNumbers: string[] = []) {
  return createOurNumberKind({
    config: { businessPhoneNumber: BUSINESS },
    conversations: {
      getByPoolNumber: async (n: string) =>
        poolNumbers.includes(n) ? ({ conversationId: 'conv-1' } as never) : undefined,
    },
  });
}

describe('ourNumberKind', () => {
  it("returns 'business' for the configured business number", async () => {
    await expect(make()(BUSINESS)).resolves.toBe('business');
  });

  it("returns 'pool' for a number fronting a relay group", async () => {
    await expect(make([POOL])(POOL)).resolves.toBe('pool');
  });

  it('returns undefined for a stranger', async () => {
    await expect(make([POOL])('+15550100001')).resolves.toBeUndefined();
  });

  it('checks the business number FIRST and never queries the repo for it', async () => {
    let queried = 0;
    const kind = createOurNumberKind({
      config: { businessPhoneNumber: BUSINESS },
      conversations: {
        getByPoolNumber: async () => {
          queried += 1;
          return undefined;
        },
      },
    });
    await expect(kind(BUSINESS)).resolves.toBe('business');
    expect(queried).toBe(0);
  });

  it('still resolves pool numbers when no business number is configured', async () => {
    const kind = createOurNumberKind({
      config: { businessPhoneNumber: undefined },
      conversations: {
        getByPoolNumber: async (n: string) =>
          n === POOL ? ({ conversationId: 'conv-1' } as never) : undefined,
      },
    });
    await expect(kind(POOL)).resolves.toBe('pool');
    await expect(kind(BUSINESS)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run test/ourNumberKind.test.ts`
Expected: FAIL - module `../src/services/ourNumberKind.js` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `app/src/services/ourNumberKind.ts`:

```ts
// The ONE definition of "is this phone number one of ours?" (spec
// docs/superpowers/specs/2026-08-06-business-number-config-design.md D3).
//
// Two arms, because we own numbers from two sources: the STATIC business
// number (config) and the DYNAMIC relay pool (bought at runtime, resolved
// through the byPoolNumber GSI). Both webhook echo/author defenses funnel
// through here so the definition cannot drift between the SMS and voice paths.
//
// Returns WHICH arm matched rather than a boolean: each caller logs a
// different drop line ("From is our number" vs "From is a pool number") and
// collapsing them would lose that distinction in production logs.
//
// Uses getByPoolNumber (a single Query) and NOT getAllByPoolNumber (which
// pages the whole partition). For a MEMBERSHIP test the two are equivalent -
// both are truthy exactly when the GSI holds any item - and the voice guard
// runs on an inbound-call webhook where paging would be wasted work.
import type { AppConfig } from '../lib/config.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';

export type OurNumberKind = 'business' | 'pool' | undefined;

export interface OurNumberKindDeps {
  config: Pick<AppConfig, 'businessPhoneNumber'>;
  conversations: Pick<ConversationsRepo, 'getByPoolNumber'>;
}

export function createOurNumberKind(
  deps: OurNumberKindDeps,
): (number: string) => Promise<OurNumberKind> {
  return async (number: string): Promise<OurNumberKind> => {
    if (deps.config.businessPhoneNumber !== undefined && number === deps.config.businessPhoneNumber) {
      return 'business';
    }
    return (await deps.conversations.getByPoolNumber(number)) ? 'pool' : undefined;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run test/ourNumberKind.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the SMS webhook**

In `app/src/routes/webhooks/twilio.ts`, replace the set build at :278
(`const ourNumbers = new Set(config.ourPhoneNumbers);` - already renamed in
Task 2) with:

```ts
  const ourNumberKind = createOurNumberKind({ config, conversations });
```

and replace the two-step guard at :870-882 with:

```ts
    const kind = await ourNumberKind(From);
    if (kind === 'business') {
      log.info({ providerSid: MessageSid }, /* EXISTING string from twilio.ts:871 */);
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
    if (kind === 'pool') {
      log.info({ providerSid: MessageSid }, /* EXISTING string from twilio.ts:879 */);
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
```

CRITICAL: both log strings contain an em dash and MUST stay BYTE-IDENTICAL.
This plan deliberately does NOT reproduce them (a plan is ASCII-only, so a copy
here would be wrong). CUT AND PASTE each string from the line it already lives
on. Do not retype it, and do not "fix" the dash.

- [ ] **Step 6: Wire the voice webhook**

In `app/src/routes/webhooks/voice.ts`, replace the set build at :291 the same
way, and replace the guard at :362-370 with:

```ts
    const kind = await ourNumberKind(From);
    if (kind === 'business') {
      log.info({ callSid: CallSid }, /* EXISTING string from voice.ts:363 */);
      sendTwiml(res, new VoiceResponse());
      return;
    }
    if (kind === 'pool') {
      log.info({ callSid: CallSid }, /* EXISTING string from voice.ts:368 */);
      sendTwiml(res, new VoiceResponse());
      return;
    }
```

Same rule as the SMS guard: cut and paste both strings from their current
lines. Em dashes, byte-identical.

Leave the ROUTING lookup at :375 (`conversations.getByPoolNumber(To)`) exactly
as it is - it resolves a conversation to bridge, not membership.

- [ ] **Step 7: Run the webhook suites and the gates**

Run: `cd app && npx vitest run test/twilioSmsWebhook.test.ts test/voiceWebhook.test.ts test/ourNumberKind.test.ts`
Expected: PASS.

Run: `npm run typecheck` then `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git status
git add app/src/services/ourNumberKind.ts app/test/ourNumberKind.test.ts app/src/routes/webhooks/twilio.ts app/src/routes/webhooks/voice.ts
git commit -m "refactor(webhooks): one named predicate for is-this-one-of-ours"
```

---

### Task 5: Remove press-0

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (the `digits === '0'` branch),
  `app/src/messages/catalog.ts:62-66,336-344,363-370`
- Modify: `app/test/voiceWebhook.test.ts:321`, `app/test/founderTriage.test.ts:455,483`
- Modify: `fake-twilio/src/engine/twimlInterpreter.ts:10,62` and its seven
  suites (see Step 5)
- Create: `docs/issues/press-0-team-escape-removed.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

**Watch items:**
- Removal is a REAL user-facing change: the relay whisper announces press-0 in
  audio.
- The mechanism in spec section 4 is UNVERIFIED. Do NOT write commit messages
  or issue text asserting that press-0 "is broken" as established fact. The
  grounds for removal are: unproven, untested, and repair is new logic on a
  live-call path days before a port.

- [ ] **Step 1: Update the gate test to the new expectation**

In `app/test/voiceWebhook.test.ts`, find the test at :321 whose name begins
`gate: Digits='0'` and currently asserts a `<Dial>` to the team. Replace it
with:

```ts
  it("gate: Digits='0' -> <Hangup> (the press-0 team escape was removed)", async () => {
    // Same fall-through as a timeout or any other key. See
    // docs/issues/press-0-team-escape-removed.md.
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, `/webhooks/twilio/voice/whisper-gate${gateQuery}`, {
      CallSid: 'CAcallee0001',
      Digits: '0',
    });
    const xml = res.text;
    expect(res.status).toBe(200);
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
  });
```

Match the harness call shape to the neighbouring tests in that describe block -
read them first; the exact helper signature is theirs, not invented here.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx vitest run test/voiceWebhook.test.ts -t "Digits='0'"`
Expected: FAIL - the response still contains `<Dial>`.

- [ ] **Step 3: Delete the press-0 branch**

In `app/src/routes/webhooks/voice.ts`, delete the entire
`if (digits === '0' && !isFounderLeg && !isOutboundLeg) { ... }` block. Digits
`'0'` then falls through to the existing final branch, which hangs up the
bridged leg. Delete the now-unused `teamNumbers`/`teamCallerId` locals with it.

- [ ] **Step 4: Update the catalog**

In `app/src/messages/catalog.ts`:
- `voice.whisper_relay` default becomes
  `'You have a Housing Choice call from {callerLabel}. Press 1 to accept.'`
  KEEP the id. It is now byte-identical to `voice.whisper_founder`; that is
  intentional - the two address different contexts and are independently
  editable.
- DELETE the whole `'voice.team_unreachable'` entry (:363-370) and its member
  in the id union (:66). It is deleted rather than marked `dead: true` because
  `dead` is for an unreachable code path KEPT for completeness (:94-95), and
  here the code path itself is gone.

- [ ] **Step 5: Fix the fake-twilio detector and its suites**

`fake-twilio/src/engine/twimlInterpreter.ts:62` computes
`sayContainsPress0: /press 0/i.test(say)`, which is now permanently false for
our TwiML.

DECISION: KEEP the detector and its type member at :10. It is a generic TwiML
parser, still correct for any future copy, and removing it would churn seven
suites for no behavior gain. Add one comment above :62:

```ts
    // NOTE: the app no longer emits "press 0" copy (the relay team escape was
    // removed 2026-08-06). Kept: this is a generic TwiML parser, not an
    // app-specific assertion.
```

Then run the fake-twilio suite and fix ONLY fixtures that assert our removed
copy, not the parser's own behavior:

Run: `cd fake-twilio && npx vitest run`
Expected: any failure is a fixture asserting the old whisper string. Update
those fixtures' expected text; do NOT weaken `twimlInterpreter.test.ts`'s own
parser tests, which legitimately feed it synthetic "press 0" TwiML.

- [ ] **Step 6: Resolve the vacuous assertions**

`app/test/founderTriage.test.ts:455` and `:483` assert
`not.toContain('reach the team')`. Once the copy is gone these can never fail.
Delete those two assertions (the tests around them still assert real behavior -
read them and keep the rest). A test that cannot fail is worse than no test.

- [ ] **Step 7: File the registry issue**

Create `docs/issues/press-0-team-escape-removed.md` from
`docs/issues/_TEMPLATE.md`, `type: decision`, `status: resolved`,
`resolved: 2026-08-06`. Record: what the affordance was (relay callee presses 0
to reach a human), the copy that advertised it, that NOTHING tested it reaching
anyone, the UNVERIFIED echo-guard mechanism clearly labelled as unverified and
needing a live dev call to confirm, and what re-adding would require (an
INTERNAL hand-off to founder triage rather than a PSTN round-trip, plus a
decision about how a masked relay member's identity appears in triage's
non-masked call record).

- [ ] **Step 8: Run the gates**

Run: `cd app && npx vitest run test/voiceWebhook.test.ts test/founderTriage.test.ts`
Run: `npm run typecheck` then `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git status
git add app/src/routes/webhooks/voice.ts app/src/messages/catalog.ts app/test/voiceWebhook.test.ts app/test/founderTriage.test.ts fake-twilio docs/issues/press-0-team-escape-removed.md
git commit -m "feat(voice): remove the press-0 team escape and the copy advertising it"
```

---

### Task 6: Expose the number on both existing endpoints

**Files:**
- Modify: `app/src/routes/settings.ts:158-161` (GET) and `:194` (PUT)
- Modify: `app/src/routes/system.ts` (the flags payload)
- Test: `app/test/systemStatus.service.test.ts:59`,
  `app/test/system.routes.test.ts:51,130,145`, and the settings route suite

**Interfaces:**
- Consumes: `config.businessPhoneNumber` (Task 1).
- Produces:
  - `GET /api/settings` -> `{ settings, welcomeTextDefault, businessPhoneNumber }`
  - `PUT /api/settings` -> the SAME three keys
  - `GET /api/system/flags` -> existing keys plus `businessPhoneNumber`

**Watch items:**
- THE PUT MUST CARRY IT TOO. `SettingsResponse` is shared by both calls and the
  dashboard re-sets its state from the PUT response; a GET-only field blanks
  the block the first time an admin saves quiet hours.
- `businessPhoneNumber` is env-sourced and immutable. `OrgSettingsPatch` MUST
  NOT accept it.
- TWO exact-shape `toEqual` assertions break BY DESIGN. Update them
  deliberately; do not loosen them to `toMatchObject` to make them pass.
- PII: this amends a stated posture. Our own business number is published on
  public flyers and is not a contact's phone. Neither route logs it.

- [ ] **Step 1: Write the failing route tests**

Add to `app/test/settings.test.ts`:

```ts
  it('GET returns the env-sourced business number alongside the settings', async () => {
    const res = await request(app).get('/api/settings').set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.businessPhoneNumber).toBe('+15550009999');
  });

  it('PUT returns the business number too (the dashboard re-reads it from the save response)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ patch: { quietHoursEnabled: false } });
    expect(res.status).toBe(200);
    expect(res.body.businessPhoneNumber).toBe('+15550009999');
  });
```

Match the existing suite's harness/cookie helpers - read the file first.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/<settings suite>.test.ts`
Expected: FAIL - `businessPhoneNumber` is undefined in both bodies.

- [ ] **Step 3: Add the field to both settings responses**

At `app/src/routes/settings.ts:158-161`:

```ts
  router.get('/', async (_req, res) => {
    const current = await settings.getOrgSettings();
    res.json({
      settings: current,
      welcomeTextDefault: WELCOME_SMS,
      // Env-sourced and READ-ONLY (never patchable), the same shape as
      // welcomeTextDefault above: the Settings UI shows the number this app
      // sends from without implying it can be edited here. `?? null` is
      // LOAD-BEARING - `undefined` is omitted entirely by JSON.stringify, so
      // the client would receive no key at all and the wire type would lie.
      businessPhoneNumber: config.businessPhoneNumber ?? null,
    });
  });
```

Apply the identical three-key shape, `?? null` included, to the PUT's response
at :194.

- [ ] **Step 4: Add the field to the flags payload**

In `app/src/routes/system.ts` (and the service behind it), add
`businessPhoneNumber: config.businessPhoneNumber ?? null` to the flags object,
and update the `SystemFlags` type. Same `?? null` reasoning as above.

- [ ] **Step 5: Update the two exact-shape assertions**

Add `businessPhoneNumber: <the harness value or undefined>` to the expected
object in `app/test/systemStatus.service.test.ts:59` and at
`app/test/system.routes.test.ts:51,130,145`. Keep them as `toEqual` - the
exact-shape assertion is deliberate and is what caught this.

- [ ] **Step 6: Run the tests and gates**

Run: `cd app && npx vitest run`
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git status
git add app/src/routes/settings.ts app/src/routes/system.ts app/test
git commit -m "feat(api): expose the business number read-only on settings and system flags"
```

---

### Task 7: "Our number" block, visible to every authenticated user

**Files:**
- Modify: `dashboard/src/routes/settings/NumbersSection.tsx` (block, retitle at
  :135, role-gated fetch at :89-94), `dashboard/src/routes/settings/settingsTabs.ts:25`,
  `dashboard/src/App.tsx:204-206`, `dashboard/src/api/types.ts:141-148`,
  `dashboard/src/api/endpoints.ts`
- Test: `dashboard/src/routes/settings/NumbersSection.test.tsx:369`,
  `dashboard/src/routes/settings/settingsTabs.test.ts:25-28,41`,
  `dashboard/src/routes/settings/SettingsPage.test.tsx:66`,
  `e2e/tests/dashboard-next/pool-numbers-admin.spec.ts:80,84,118-133`

**Interfaces:**
- Consumes: `GET /api/settings` -> `businessPhoneNumber` (Task 6).
- Produces: the retitled "Phone numbers" tab, visible to all roles.

**Watch items (this task's whole risk):**
- `NumbersSection` fetches `/api/pool-numbers` UNCONDITIONALLY in a mount
  effect (:89-94). Gating the TABLE is NOT gating the FETCH. A VA would fire an
  admin-only request and see the "Couldn't load" error alert. Gate the fetch on
  the viewer's role via `useAuth().isAdmin` (the pattern is in
  `AdminRoute.tsx:6,10`).
- `GET /api/pool-numbers` MUST STAY role-guarded on the server. UI gating is
  never the security boundary.
- `e2e/tests/dashboard-next/pool-numbers-admin.spec.ts:118-133` is a describe
  block asserting the exact VA-cannot-reach-this contract this task INVERTS. It
  must be REWRITTEN to the new contract (VA sees the tab and the number, VA does
  NOT see the pool table and fires NO admin request), not deleted.

- [ ] **Step 1: Write the failing component test**

`dashboard/src/routes/settings/NumbersSection.test.tsx` ALREADY has everything
you need: a `renderSection()` helper (:77), a module-level `viewerIsAdmin` flag
that drives a mocked `useAuth` (:23-32), a `listPoolNumbers` mock, and a
`beforeEach` that resets `viewerIsAdmin = true` (:88). Add:

```tsx
describe('NumbersSection - our number', () => {
  it('shows the business number to a NON-admin and never requests the pool inventory', async () => {
    viewerIsAdmin = false;
    getSettings.mockResolvedValue({ businessPhoneNumber: '+15550009999' });
    renderSection();
    expect(await screen.findByText('(555) 000-9999')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(listPoolNumbers).not.toHaveBeenCalled();
  });

  it('renders a Not configured state when no number is set', async () => {
    getSettings.mockResolvedValue({ businessPhoneNumber: null });
    renderSection();
    expect(await screen.findByText(/not configured/i)).toBeVisible();
  });
});
```

You must ADD a `getSettings` mock to that file's existing `vi.mock('../../api/index.js', ...)`
block (:11-21) in the same style as `listPoolNumbers`. Read that block first
and follow its shape exactly.

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run src/routes/settings/NumbersSection.test.tsx -t "NON-admin"`
Expected: FAIL - the block does not exist.

- [ ] **Step 3: Add the wire type and endpoint field**

In `dashboard/src/api/types.ts:141-148`, add
`businessPhoneNumber: string | null;` to `SettingsResponse` (shared by GET and
PUT - that is why Task 6 added it to both).

- [ ] **Step 4: Render the block and gate the fetch**

In `NumbersSection.tsx`:
- Retitle at :135 to `Phone numbers`.
- Render an "Our number" block ABOVE the pool table, for ALL roles, formatting
  via the existing `formatPhoneDisplay` helper already imported in that file.
  When the value is null, render an explicit "Not configured" state, never an
  empty element.
- Gate BOTH the pool table AND the mount-effect fetch at :89-94 on
  `isAdmin`. The effect must not call `listPoolNumbers` at all for a non-admin.

IMPORTANT: `NumbersSection.tsx` does NOT import `useAuth` today - the section
is guarded entirely by `AdminRoute` wrapping it, which is exactly why flipping
the tab exposes the ungated fetch. You are ADDING the auth dependency:
`useAuth()` from `../../app/AuthContext.js`, taking `isAdmin` (the same shape
`AdminRoute.tsx:6,10` uses). The test file already mocks that module, so no
test-harness work is needed for it.

- [ ] **Step 5: Flip the tab and update its tests**

`settingsTabs.ts:25` - `adminOnly: true` becomes `false` for the numbers tab,
and its label becomes `Phone numbers`. Update `settingsTabs.test.ts:25-28,41`,
`SettingsPage.test.tsx:66`, and `NumbersSection.test.tsx:369` for the new title
and visibility. Check `App.tsx:204-206` still guards the route correctly for
the new visibility.

- [ ] **Step 6: Rewrite the e2e contract**

In `e2e/tests/dashboard-next/pool-numbers-admin.spec.ts`, update the title pins
at :80,:84, and REWRITE the describe block at :118-133 to the new contract:
a VA reaches the tab, sees the business number, does NOT see the pool table,
and triggers no admin-only request. Use accessibility-first selectors per
`e2e/support/selectors.md`.

- [ ] **Step 7: Run the gates**

Run: `cd dashboard && npx vitest run`
Run: `npm run typecheck` then `npm test` then `timeout 1500 npm run e2e`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git status
git add dashboard/src e2e/tests/dashboard-next/pool-numbers-admin.spec.ts
git commit -m "feat(settings): show our business number to every authenticated user"
```

---

### Task 8: System status readiness row

**Files:**
- Modify: `dashboard/src/routes/settings/FlagPills.tsx:55-73`,
  `dashboard/src/routes/settings/useSystemStatus.ts`,
  `dashboard/src/api/types.ts:156-172`, `dashboard/src/api/endpoints.ts`
- Test: `dashboard/src/routes/settings/FlagPills.test.tsx`,
  `dashboard/src/routes/settings/SystemStatusSection.test.tsx`

**Interfaces:**
- Consumes: `GET /api/system/flags` -> `businessPhoneNumber` (Task 6).
- Produces: nothing later tasks depend on.

**Watch item:** `FlagPills` renders a FIXED `<Pill label state tone>` list with
NO slot for a sentence. The mandatory caveat copy does not drop into that list.
Render the number as a pill AND the caveat as a sibling paragraph beneath the
pill list - do not stuff a sentence into `state`.

- [ ] **Step 1: Write the failing test**

`dashboard/src/routes/settings/FlagPills.test.tsx` already has a `getSystemFlags`
mock (:10) and a `flags(overrides)` builder (:21). Extend `flags()` with the
new field, then add:

```tsx
  it('shows the configured sending number and says plainly what it does not prove', async () => {
    getSystemFlags.mockResolvedValue(flags({ businessPhoneNumber: '+16782842537' }));
    render(<FlagPills />);
    expect(await screen.findByText('(678) 284-2537')).toBeVisible();
    expect(
      screen.getByText(/must also be attached to the Messaging Service/i),
    ).toBeVisible();
  });

  it('renders a Not configured state rather than an empty pill', async () => {
    getSystemFlags.mockResolvedValue(flags({ businessPhoneNumber: null }));
    render(<FlagPills />);
    expect(await screen.findByText(/not configured/i)).toBeVisible();
  });
```

Follow the render call shape the neighbouring tests in that file already use.

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run src/routes/settings/FlagPills.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the wire type**

`dashboard/src/api/types.ts:156-172` - add
`businessPhoneNumber: string | null;` to `SystemFlags`.

- [ ] **Step 4: Render the pill and the caveat**

Add a `Sending from` pill (tone `info`) to the pill list, formatted with the
same phone helper the rest of Settings uses, plus a sibling paragraph beneath
the list:

```
Outbound texts and calls present this number. It must also be attached to the
Messaging Service and covered by the A2P campaign before sends succeed - this
row cannot check either.
```

That sentence is REQUIRED by the spec (D7). A row that implies more than it
checks is worse than no row.

- [ ] **Step 5: Run and commit**

Run: `cd dashboard && npx vitest run`
Run: `npm run typecheck`

```bash
git status
git add dashboard/src
git commit -m "feat(settings): show the configured sending number on System status"
```

---

### Task 9: Documentation truth

**Files:**
- Modify: `RUNBOOK.md:281,292,585,600-622,705,781`,
  `.env.dev.example:40-43`, `.env.prod.example:35-38`, `.env.example:7`
- Modify: `docs/issues/one-to-one-sender-not-pinned-to-ported-number.md`

**Interfaces:** none.

**Watch items:**
- Do NOT touch `docs/a2p/campaign-resubmission.md` or
  `docs/issues/ported-number-not-on-a2p-campaign.md`. They are operator-owned,
  in flight, and their assumptions hold per environment.
- RUNBOOK is OPERATIONAL only. Bugs and gaps go to `docs/issues/`.

- [ ] **Step 1: Fix the wrong definition**

`RUNBOOK.md:600` currently says the variable "must list EVERY number we own".
That is wrong - we own the relay pool numbers too, and putting one in this
variable breaks the pool-audit classifier and can make a pool number our
outbound caller ID. Replace that paragraph with a statement that
`BUSINESS_PHONE_NUMBER` is THE ONE business number for the environment, and
that relay pool numbers live in DynamoDB and must NEVER appear here.

- [ ] **Step 2: Delete the obsolete ORDER MATTERS section**

Delete `RUNBOOK.md:604-622` in full. A singular variable has no order to get
wrong. Replace it with the cutover note: dev keeps the 404 number, prod uses
the ported `+16782842537`, each in its own Messaging Service and A2P campaign;
the number must be attached to that environment's Messaging Service before it
can send.

- [ ] **Step 3: Add the go-live flags note**

In the same Twilio section, add: flipping `SMS_SENDING_ENABLED` (and
`RELAY_LIVE_PROVISIONING`) for go-live is an env edit plus `secrets:push` plus
a deploy. They are READ-ONLY in the dashboard - Settings > System status shows
their state but cannot change it.

- [ ] **Step 4: Rename in the remaining RUNBOOK mentions**

`:281,292,585,705,781` - rename the variable and fix any wording that implies a
list.

- [ ] **Step 5: Fix the .env examples**

`.env.dev.example:40-43` and `.env.prod.example:35-38`: replace the definition
(the current "the numbers in the Messaging Service's sender pool" is wrong - it
now describes the relay numbers too) with "the ONE business number for this
environment, E.164" plus the single-value key. `.env.example:7` needs the name
changed only.

- [ ] **Step 6: Close the pinning issue**

In `docs/issues/one-to-one-sender-not-pinned-to-ported-number.md` set
`status: resolved`, add `resolved: 2026-08-06`, and add a Resolution section
recording: the fix that landed on `main` (@db54d38d), and that the
single-Messaging-Service topology its text describes has since been replaced by
one Messaging Service and one A2P campaign PER ENVIRONMENT.

- [ ] **Step 7: Verify ASCII and no stale references**

```bash
tr -d '\11\12\15\40-\176' < RUNBOOK.md | wc -c
grep -rn "OUR_PHONE_NUMBERS" . --include="*.md" --include="*.example" | grep -v node_modules
```
The grep should return only intentional historical mentions, if any. The ASCII
check applies to lines you added.

- [ ] **Step 8: Commit**

```bash
git status
git add RUNBOOK.md .env.example .env.dev.example .env.prod.example docs/issues/one-to-one-sender-not-pinned-to-ported-number.md
git commit -m "docs: BUSINESS_PHONE_NUMBER is one business number per environment"
```

---

## Final verification

- [ ] `npm run typecheck` - BARE, expect exit 0
- [ ] `npm test` - BARE, expect exit 0
- [ ] `timeout 1500 npm run e2e` - BARE, from the worktree, expect exit 0
- [ ] `grep -rn "OUR_PHONE_NUMBERS\|ourPhoneNumbers" app dashboard e2e scripts fake-twilio --include="*.ts" --include="*.tsx" --include="*.mjs"` returns NOTHING
- [ ] Live self-QA per the profile: `npm run e2e:session`, dev-login, open
      Settings as a NON-admin and confirm the number renders and no admin
      request is fired; open System status as an admin and confirm the row and
      its caveat sentence.
- [ ] Handback records the owed operator actions: set `BUSINESS_PHONE_NUMBER`
      in `.env.dev` / `.env.prod`, `secrets:push`, deploy, then
      `secrets:prune` the orphaned `OUR_PHONE_NUMBERS` parameters. NONE of
      these are performed by the implementer.
