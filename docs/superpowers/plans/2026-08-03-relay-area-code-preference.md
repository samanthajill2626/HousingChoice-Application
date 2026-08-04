# Relay Area-Code Preference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-03-relay-area-code-preference-design.md`

**Goal:** Every relay pool number we BUY is searched with geographic preference
(property ZIP for tour/placement connect-when-ready buys, Atlanta-metro area
codes otherwise), falling back to today's any-US search - without changing the
reuse/spare assignment ladder or ever buying an extra number.

**Architecture:** One new config list (`relayPreferredAreaCodes`), a
`postalCode` search hint + `NumberUnavailableError` on the messaging adapter,
a hint-fallback ladder inside `warmOneNumber` (the single buy site), and the
property ZIP threaded route -> `ProvisionRelayInput` -> `RELAY_WARM_JOB`
payload -> `warmOneNumber`. Console driver + fake-twilio get deterministic
prefix markers so tests can assert which hint won.

**Tech Stack:** TypeScript (Node 24), Express, Vitest, Twilio SDK v6 (driver
pattern in `app/src/adapters/messaging.ts`), in-process jobs machinery
(`app/src/jobs/jobs.js`), fake-twilio mock server.

## Global Constraints

- ASCII only in all source, tests, docs, and log strings (verify a changed
  doc with `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> `0`).
- PII (project doc section 9): NEVER log a phone number or a ZIP VALUE; log
  hint TYPE (`postal` | `areaCode` | `bare`), counts, SIDs, event names only.
- Work in an isolated worktree under `w:\tmp` (never switch branches in the
  shared checkout). Branch name: `feat/relay-area-code-preference`.
- Commit discipline: run a bare `git status` as its OWN command before every
  commit; commit with explicit pathspecs (`git commit -m "..." -- <paths>`);
  never `git add -A`.
- Gates run BARE (never piped): `npm run typecheck`, `npm test`, `npm run e2e`
  (from the repo root; e2e only from the e2e workspace via the root script).
  `npm run typecheck` is REQUIRED - the runtime suites do not type-check.
- The default Atlanta list is exactly `404,470,678,770,943` everywhere it
  appears (config default, env examples, tests).
- Never merge to `main` - hand back the branch for review.

## File Structure

- `app/src/lib/config.ts` - add `relayPreferredAreaCodes: string[]` (parse + validate).
- `app/src/adapters/messaging.ts` - `NumberUnavailableError`, `postalCode` opt
  on `provisionPhoneNumber` (interface + Twilio driver + console driver).
- `app/src/adapters/recordingMessaging.ts` - passthrough signature update.
- `app/src/services/poolNumbers.ts` - hint ladder in `warmOneNumber`.
- `app/src/jobs/relayWarm.ts` - `postalCode` on `RelayWarmPayload`.
- `app/src/services/relayProvisioning.ts` - `postalCode` on
  `ProvisionRelayInput`, forwarded into the tier-3 warm-job payload.
- `app/src/lib/address.ts` - `zipFive()` helper.
- `app/src/routes/placements.ts`, `app/src/routes/tours.ts` - resolve unit ZIP.
- `fake-twilio/src/routes/voiceRest.ts` - `InPostalCode` filter parity.
- Tests: `app/test/configRelayAreaCodes.test.ts` (new),
  `app/test/messaging.test.ts`, `app/test/poolNumbers.test.ts`,
  `app/test/relayWarm.test.ts`, `app/test/relayProvisioningPostal.test.ts`
  (new), `app/test/placementsRelay.test.ts`, `app/test/toursApi.test.ts`,
  `fake-twilio/test/voiceRest.test.ts`.
- Docs: `.env.example`, `.env.dev.example`, `.env.prod.example`, `RUNBOOK.md`.

---

### Task 1: Config - `relayPreferredAreaCodes`

**Files:**
- Modify: `app/src/lib/config.ts` (AppConfig interface near line 126; parse
  block near the `relayWarmingMaxWaitMs` block ~line 688; return object ~line 1148)
- Create: `app/test/configRelayAreaCodes.test.ts`
- Modify: `.env.example` (after the RELAY_SPARE_BUFFER_TARGET block ~line 155),
  `.env.dev.example` (~line 119), `.env.prod.example` (~line 112)
- Modify: `RUNBOOK.md` (relay pool-numbers section - add the knob)

**Interfaces:**
- Produces: `AppConfig.relayPreferredAreaCodes: string[]` - defaults to
  `['404', '470', '678', '770', '943']` when `RELAY_PREFERRED_AREA_CODES` is
  unset; `[]` when set empty; throws on a non-3-digit entry. Later tasks read
  `config.relayPreferredAreaCodes`.

- [ ] **Step 1: Write the failing test**

Create `app/test/configRelayAreaCodes.test.ts` (mirrors
`configRelayLiveProvisioning.test.ts` style - `loadConfig` takes an env
object):

```ts
// app/test/configRelayAreaCodes.test.ts
//
// relayPreferredAreaCodes parsing (relay area-code preference):
//   unset            -> the Atlanta-metro default list
//   set (csv)        -> trimmed entries, empties dropped
//   set empty        -> [] (no preference - ladder degrades to bare search)
//   malformed entry  -> loud throw (fail-fast, like RELAY_SPARE_BUFFER_TARGET)
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' };

describe('relayPreferredAreaCodes resolution', () => {
  it('defaults to the Atlanta-metro list when unset', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.relayPreferredAreaCodes).toEqual(['404', '470', '678', '770', '943']);
  });

  it('parses a custom comma-separated list, trimming whitespace and dropping empties', () => {
    const cfg = loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: ' 912 , 229 ,, 478 ' });
    expect(cfg.relayPreferredAreaCodes).toEqual(['912', '229', '478']);
  });

  it('an explicitly EMPTY value means no preference ([])', () => {
    const cfg = loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '' });
    expect(cfg.relayPreferredAreaCodes).toEqual([]);
  });

  it('rejects a non-3-digit entry loudly (fail-fast on a typo)', () => {
    expect(() => loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '404,47a' })).toThrow(
      /RELAY_PREFERRED_AREA_CODES/,
    );
    expect(() => loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '4040' })).toThrow(
      /RELAY_PREFERRED_AREA_CODES/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run test/configRelayAreaCodes.test.ts`
Expected: FAIL - `relayPreferredAreaCodes` is not a property of AppConfig /
undefined.

- [ ] **Step 3: Implement**

In `app/src/lib/config.ts`:

(a) AppConfig interface, right after `relayWarmingMaxWaitMs: number;` (~line 126):

```ts
  /**
   * Preferred NANP area codes for relay pool-number PURCHASES (area-code
   * preference design 2026-08-03). warmOneNumber's search ladder tries each in
   * order (after any property-ZIP hint) before falling back to an unhinted US
   * search. Read from RELAY_PREFERRED_AREA_CODES (comma-separated 3-digit
   * codes); DEFAULT Atlanta metro 404,470,678,770,943. An EXPLICIT empty value
   * means no preference ([]). Fail-fast: a malformed entry refuses boot (a
   * typo must not silently degrade every purchase to the bare search).
   */
  relayPreferredAreaCodes: string[];
```

(b) Parse block, after the `relayWarmingMaxWaitMs` block (~line 700):

```ts
  // Preferred area codes for relay pool-number purchases (area-code preference
  // design 2026-08-03). Unset -> Atlanta-metro default. Explicit empty -> []
  // (no preference). Malformed entry -> throw (fail-fast, matching
  // RELAY_SPARE_BUFFER_TARGET's posture - a typo must not silently turn every
  // buy into the unhinted search).
  const RELAY_PREFERRED_AREA_CODES_DEFAULT = ['404', '470', '678', '770', '943'];
  let relayPreferredAreaCodes: string[];
  if (env.RELAY_PREFERRED_AREA_CODES === undefined) {
    relayPreferredAreaCodes = RELAY_PREFERRED_AREA_CODES_DEFAULT;
  } else {
    relayPreferredAreaCodes = env.RELAY_PREFERRED_AREA_CODES.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const code of relayPreferredAreaCodes) {
      if (!/^\d{3}$/.test(code)) {
        throw new Error(
          `RELAY_PREFERRED_AREA_CODES entries must be 3-digit NANP area codes, got: ${code}`,
        );
      }
    }
  }
```

(c) Return object: add `relayPreferredAreaCodes,` next to
`relayWarmingMaxWaitMs,` (~line 1148).

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run test/configRelayAreaCodes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Env examples + RUNBOOK**

In `.env.example`, after the `# RELAY_WARMING_MAX_WAIT=1800000` line (~155), add:

```
# Preferred area codes for relay pool-number PURCHASES. Comma-separated 3-digit
# NANP codes tried in order when buying (after any property-ZIP hint); DEFAULT
# is Atlanta metro. Explicit empty = no preference. APP-BEHAVIOR flag, NOT a
# secret and NOT Terraform-managed - deploy via secrets:push.
# RELAY_PREFERRED_AREA_CODES=404,470,678,770,943
```

Add the same block (same wording) to `.env.dev.example` after its
`# RELAY_WARMING_MAX_WAIT=1800000` line and to `.env.prod.example` after its
`# RELAY_WARMING_MAX_WAIT=1800000` line - commented out in all three (the
default is correct everywhere).

In `RUNBOOK.md`, find the relay pool-numbers / buying-strategy section and add
one bullet: `RELAY_PREFERRED_AREA_CODES` (default `404,470,678,770,943`) -
area codes tried in order for every pool-number purchase; connect-when-ready
buys try the property ZIP first; watch `relay_warm_hint_miss` /
`relay_number_warming.hintTier` for drift to `bare` (metro inventory dry at
Twilio). Verify RUNBOOK.md stays ASCII-clean.

- [ ] **Step 6: Commit**

Run `git status` (bare, own command), then:

```bash
git commit -m "feat(config): RELAY_PREFERRED_AREA_CODES for relay number purchases" -- app/src/lib/config.ts app/test/configRelayAreaCodes.test.ts .env.example .env.dev.example .env.prod.example RUNBOOK.md
```

---

### Task 2: Adapter - `NumberUnavailableError` + `postalCode` search hint

**Files:**
- Modify: `app/src/adapters/messaging.ts` (error classes ~line 302; interface
  `provisionPhoneNumber` ~line 143; Twilio driver ~line 607; console driver
  ~line 955)
- Modify: `app/src/adapters/recordingMessaging.ts:109` (passthrough signature)
- Test: `app/test/messaging.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 3 relies on these exact names):
  - `export class NumberUnavailableError extends VoiceCapabilityError` in
    `app/src/adapters/messaging.ts` - thrown ONLY when the availability
    SEARCH returns zero candidates.
  - `provisionPhoneNumber(opts: { voiceCapable: true; areaCode?: string; postalCode?: string })`
    - when both hints are set, `postalCode` wins.
  - Console driver fake-number prefixes: `+1<postalCode first 3>` when
    postalCode given, else `+1<areaCode>` (existing), else `+1555010`.

- [ ] **Step 1: Write the failing tests**

In `app/test/messaging.test.ts`, add a describe block (reuse the file's
existing imports/`createLogCapture`/`createLogger` helpers; import
`NumberUnavailableError` and `ConsoleMessagingDriver` from
`../src/adapters/messaging.js` alongside the existing imports):

```ts
describe('provisionPhoneNumber - geographic search hints', () => {
  /** Stub client capturing AvailablePhoneNumbers list params; scriptable inventory. */
  function makeProvisionClient(candidates: string[]) {
    const listCalls: Record<string, unknown>[] = [];
    const client = {
      messages: { create: async () => ({ sid: 'SM', status: 'queued', dateCreated: new Date() }) },
      availablePhoneNumbers: (_country: string) => ({
        local: {
          list: async (params: Record<string, unknown>) => {
            listCalls.push(params);
            return candidates.map((phoneNumber) => ({
              phoneNumber,
              capabilities: { sms: true, voice: true },
            }));
          },
        },
      }),
      incomingPhoneNumbers: Object.assign(
        (_sid: string) => ({ update: async () => ({}) }),
        {
          create: async (p: { phoneNumber: string }) => ({
            sid: 'PNstub',
            phoneNumber: p.phoneNumber,
            capabilities: { sms: true, voice: true },
          }),
          list: async () => [],
        },
      ),
    };
    return { client: client as never, listCalls };
  }

  function makeDriver(client: never) {
    return new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      client,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
  }

  it('twilio driver threads AreaCode into the availability search', async () => {
    const { client, listCalls } = makeProvisionClient(['+14045550100']);
    await makeDriver(client).provisionPhoneNumber({ voiceCapable: true, areaCode: '404' });
    expect(listCalls[0]).toMatchObject({ areaCode: 404 });
    expect(listCalls[0]).not.toHaveProperty('inPostalCode');
  });

  it('twilio driver threads inPostalCode into the availability search; postalCode wins over areaCode', async () => {
    const { client, listCalls } = makeProvisionClient(['+14045550100']);
    await makeDriver(client).provisionPhoneNumber({
      voiceCapable: true,
      areaCode: '404',
      postalCode: '30309',
    });
    expect(listCalls[0]).toMatchObject({ inPostalCode: '30309' });
    expect(listCalls[0]).not.toHaveProperty('areaCode');
  });

  it('twilio driver throws NumberUnavailableError (a VoiceCapabilityError subclass) when the SEARCH is empty', async () => {
    const { client } = makeProvisionClient([]);
    const attempt = makeDriver(client).provisionPhoneNumber({ voiceCapable: true, areaCode: '404' });
    await expect(attempt).rejects.toBeInstanceOf(NumberUnavailableError);
    await expect(
      makeDriver(makeProvisionClient([]).client).provisionPhoneNumber({ voiceCapable: true }),
    ).rejects.toBeInstanceOf(VoiceCapabilityError); // subclass keeps existing catches working
  });

  it('console driver marks the winning hint in the fake prefix (postal > areaCode > default)', async () => {
    const driver = new ConsoleMessagingDriver({
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const postal = await driver.provisionPhoneNumber({ voiceCapable: true, postalCode: '30309' });
    expect(postal.phoneNumber.startsWith('+1303')).toBe(true); // ZIP first-3 marker
    const area = await driver.provisionPhoneNumber({ voiceCapable: true, areaCode: '470' });
    expect(area.phoneNumber.startsWith('+1470')).toBe(true);
    const bare = await driver.provisionPhoneNumber({ voiceCapable: true });
    expect(bare.phoneNumber.startsWith('+1555010')).toBe(true);
  });
});
```

Note: if `ConsoleMessagingDriver`'s constructor deps differ (check its class
in `messaging.ts`), construct it the way existing console-driver tests in this
file do.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `app/`): `npx vitest run test/messaging.test.ts`
Expected: FAIL - `NumberUnavailableError` not exported; `postalCode` not in
the opts type.

- [ ] **Step 3: Implement**

In `app/src/adapters/messaging.ts`:

(a) After the `VoiceCapabilityError` class (~line 307):

```ts
/**
 * The phone-number AVAILABILITY SEARCH returned zero candidates for the given
 * hint (area code / postal code sold out at Twilio) - distinct from a
 * post-purchase capability failure so warmOneNumber's hint ladder can advance
 * to its next hint WITHOUT ever re-buying after a successful purchase.
 * Subclasses VoiceCapabilityError so every existing catch / 503 mapping keeps
 * working unchanged.
 */
export class NumberUnavailableError extends VoiceCapabilityError {}
```

(b) Interface (~line 143) - add `postalCode?: string;` under
`areaCode?: string;` with a comment `/** Twilio inPostalCode search - wins over areaCode when both are set. */`.

(c) Twilio driver `provisionPhoneNumber` (~line 607): same opts change; build
the search params so postalCode wins:

```ts
    const candidates = await available('US').local.list({
      voiceEnabled: true,
      smsEnabled: true,
      ...(opts.postalCode !== undefined
        ? { inPostalCode: opts.postalCode }
        : opts.areaCode !== undefined
          ? { areaCode: Number(opts.areaCode) }
          : {}),
      limit: 1,
    });
    const candidate = candidates[0];
    if (!candidate) {
      throw new NumberUnavailableError(
        'provisionPhoneNumber: no voice+sms-capable number available to purchase for this search',
      );
    }
```

(The rest of the method - purchase, capability verify (still plain
`VoiceCapabilityError`), webhook pre-wiring - is unchanged.)

(d) Console driver `provisionPhoneNumber` (~line 955): opts change plus:

```ts
    const prefix =
      opts.postalCode !== undefined
        ? `+1${opts.postalCode.slice(0, 3)}`
        : opts.areaCode !== undefined
          ? `+1${opts.areaCode}`
          : '+1555010';
```

(e) `app/src/adapters/recordingMessaging.ts:109` - widen the passthrough:

```ts
  provisionPhoneNumber(opts: {
    voiceCapable: true;
    areaCode?: string;
    postalCode?: string;
  }): Promise<ProvisionPhoneNumberResult> {
    return this.inner.provisionPhoneNumber(opts);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `app/`): `npx vitest run test/messaging.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

`git status` (bare), then:

```bash
git commit -m "feat(adapter): postalCode search hint + NumberUnavailableError on provisionPhoneNumber" -- app/src/adapters/messaging.ts app/src/adapters/recordingMessaging.ts app/test/messaging.test.ts
```

---

### Task 3: `warmOneNumber` hint ladder

**Files:**
- Modify: `app/src/services/poolNumbers.ts` (interface `warmOneNumber` ~line
  221; implementation ~line 648)
- Test: `app/test/poolNumbers.test.ts`

**Interfaces:**
- Consumes: `NumberUnavailableError` (Task 2), `config.relayPreferredAreaCodes`
  (Task 1), `adapter.provisionPhoneNumber({voiceCapable, areaCode?, postalCode?})`.
- Produces (Task 4 relies on this): `warmOneNumber(conversationId?: string, postalCode?: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `app/test/poolNumbers.test.ts`, extend `makeFakeAdapter` (~line 169) so
tests can script per-hint inventory and inspect received opts. Add to the
returned shape (keep everything existing):

```ts
// Inside makeFakeAdapter: capture opts and allow scripted per-hint misses.
// Extend the opts parameter of makeFakeAdapter to:
//   opts: { voice?: boolean; unavailableWhen?: (o: { areaCode?: string; postalCode?: string }) => boolean }
// and record every call:
const provisionCalls: { areaCode?: string; postalCode?: string }[] = [];
// ... expose `provisionCalls` on the returned adapter object, and change
// provisionPhoneNumber to:
async provisionPhoneNumber(o: {
  voiceCapable: true;
  areaCode?: string;
  postalCode?: string;
}): Promise<ProvisionPhoneNumberResult> {
  provisionCalls.push({ ...(o.areaCode !== undefined && { areaCode: o.areaCode }), ...(o.postalCode !== undefined && { postalCode: o.postalCode }) });
  if (opts.unavailableWhen?.(o)) {
    throw new NumberUnavailableError('scripted: none available for this hint');
  }
  provisions += 1;
  const seq = String(provisions).padStart(4, '0');
  return {
    phoneNumber: `+1555020${seq}`,
    capabilities: { sms: true, voice: opts.voice ?? true },
    sid: `PNtest-${seq}`,
  };
},
```

(Import `NumberUnavailableError` from `../src/adapters/messaging.js`.) Then add
a describe block (reuse the file's `makeFakeRepo`/`makeFakeConversations`/
`consoleConfig`/`logger` helpers; `consoleConfig()` has
`relayLiveProvisioning: true` via the console default):

```ts
describe('warmOneNumber - geographic hint ladder (area-code preference)', () => {
  afterEach(() => {
    _resetForTests();
  });

  const cfgWith = (codes: string[]) => ({ ...consoleConfig(), relayPreferredAreaCodes: codes });

  it('no postalCode: tries preferred area codes in order, buys on the first hit', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter({
      unavailableWhen: (o) => o.areaCode === '404', // first code sold out
    });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: cfgWith(['404', '470']),
    });

    await svc.warmOneNumber();
    expect(adapter.provisionCalls).toEqual([{ areaCode: '404' }, { areaCode: '470' }]);
    expect(adapter.provisions).toBe(1); // exactly one purchase
  });

  it('postalCode given: ZIP hint is tried FIRST, before any area code', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: cfgWith(['404']),
    });

    await svc.warmOneNumber('conv-1', '30309');
    expect(adapter.provisionCalls).toEqual([{ postalCode: '30309' }]);
  });

  it('all hints sold out: falls through to the bare search (no hint keys at all)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter({
      unavailableWhen: (o) => o.postalCode !== undefined || o.areaCode !== undefined,
    });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: cfgWith(['404', '470']),
    });

    await svc.warmOneNumber('conv-1', '30309');
    expect(adapter.provisionCalls).toEqual([
      { postalCode: '30309' }, { areaCode: '404' }, { areaCode: '470' }, {},
    ]);
    expect(adapter.provisions).toBe(1);
  });

  it('bare search ALSO unavailable: the final NumberUnavailableError propagates (still a loud failure)', async () => {
    const adapter = makeFakeAdapter({ unavailableWhen: () => true });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: makeFakeRepo(), conversationsRepo: makeFakeConversations(), logger, config: cfgWith(['404']),
    });
    await expect(svc.warmOneNumber()).rejects.toBeInstanceOf(NumberUnavailableError);
  });

  it('a NON-availability error aborts the ladder immediately - later hints are NEVER tried (no buy-and-leak)', async () => {
    const adapter = makeFakeAdapter();
    const boom = new Error('twilio 401: auth failure');
    adapter.provisionPhoneNumber = async () => {
      throw boom;
    };
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: makeFakeRepo(), conversationsRepo: makeFakeConversations(), logger, config: cfgWith(['404', '470']),
    });
    await expect(svc.warmOneNumber()).rejects.toBe(boom);
  });

  it('empty preferred list + no postalCode: exactly one bare search (today behavior)', async () => {
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: makeFakeRepo(), conversationsRepo: makeFakeConversations(), logger, config: cfgWith([]),
    });
    await svc.warmOneNumber();
    expect(adapter.provisionCalls).toEqual([{}]);
  });
});
```

Adjust the `provisionPhoneNumber` override in the non-availability-error test
if `makeFakeAdapter`'s return type makes direct assignment awkward - the
`unavailableWhen` seam can instead accept a thrown-error factory; keep the
assertion (`rejects.toBe(boom)`) identical.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `app/`): `npx vitest run test/poolNumbers.test.ts`
Expected: new tests FAIL (warmOneNumber takes no postalCode; single unhinted
call today); pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `app/src/services/poolNumbers.ts`:

(a) Interface (~line 221): change to
`warmOneNumber(conversationId?: string, postalCode?: string): Promise<void>;`
and extend the doc comment: the buy searches with a geographic-hint ladder -
`postalCode` (when given, e.g. a connect-when-ready buy for a tour/placement
group) then each `config.relayPreferredAreaCodes` entry then an unhinted
search; only a `NumberUnavailableError` advances the ladder.

(b) Implementation: change the signature to
`async warmOneNumber(conversationId, postalCode)`. Above the buy loop insert:

```ts
      // Geographic hint ladder (area-code preference design 2026-08-03):
      // property ZIP first (when the caller supplied one), then each preferred
      // area code, then the unhinted search (today's behavior, still loud on
      // total exhaustion). ONLY a NumberUnavailableError (search empty)
      // advances to the next hint - any other failure propagates immediately,
      // so a number that was successfully PURCHASED can never be followed by a
      // second purchase (no buy-and-leak). PII: log hint TYPE only, never the
      // ZIP or code value alongside a number.
      const hints: { areaCode?: string; postalCode?: string }[] = [
        ...(postalCode !== undefined ? [{ postalCode }] : []),
        ...config.relayPreferredAreaCodes.map((areaCode) => ({ areaCode })),
        {},
      ];
      const hintTierOf = (h: { areaCode?: string; postalCode?: string }): string =>
        h.postalCode !== undefined ? 'postal' : h.areaCode !== undefined ? 'areaCode' : 'bare';
      async function provisionWithHints(): Promise<{
        bought: ProvisionPhoneNumberResult;
        hintTier: string;
      }> {
        for (let i = 0; i < hints.length; i += 1) {
          const hint = hints[i]!;
          try {
            const bought = await adapter.provisionPhoneNumber({ voiceCapable: true, ...hint });
            return { bought, hintTier: hintTierOf(hint) };
          } catch (err) {
            if (err instanceof NumberUnavailableError && i < hints.length - 1) {
              log.info(
                { event: 'relay_warm_hint_miss', hintTier: hintTierOf(hint) },
                'relay warm: no number available for this search hint - trying the next',
              );
              continue;
            }
            throw err;
          }
        }
        throw new Error('unreachable: the hint ladder always ends with a bare attempt');
      }
```

Then inside the existing `for (let attempt = 1; ...)` loop replace
`const bought = await adapter.provisionPhoneNumber({ voiceCapable: true });`
with:

```ts
        const { bought, hintTier } = await provisionWithHints();
```

(keep the subsequent `bought.capabilities.voice` check and `createWarming`
block, renaming its references from the old variable if needed - the existing
code names it `bought`, so only the destructure line changes). Track the
winning `hintTier` in a variable visible to the final success log and change
that log line (~line 766) to:

```ts
      log.info(
        { event: 'relay_number_warming', hintTier: winningHintTier },
        'relay pool number bought and warming (awaiting A2P registration)',
      );
```

(declare `let winningHintTier = 'bare';` before the attempt loop and set it
from the destructure). Import `NumberUnavailableError` alongside the existing
`VoiceCapabilityError` import from `../adapters/messaging.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run (from `app/`): `npx vitest run test/poolNumbers.test.ts`
Expected: PASS (new + all pre-existing warm/ladder/retirement tests).

- [ ] **Step 5: Commit**

`git status` (bare), then:

```bash
git commit -m "feat(relay): geographic hint ladder in warmOneNumber (ZIP, preferred area codes, bare)" -- app/src/services/poolNumbers.ts app/test/poolNumbers.test.ts
```

---

### Task 4: Thread `postalCode` through the warm job + provisioning primitive

**Files:**
- Modify: `app/src/jobs/relayWarm.ts` (payload + parser + handler)
- Modify: `app/src/services/relayProvisioning.ts` (input + tier-3 enqueue ~line 115)
- Test: `app/test/relayWarm.test.ts` (extend), create
  `app/test/relayProvisioningPostal.test.ts`

**Interfaces:**
- Consumes: `warmOneNumber(conversationId?, postalCode?)` (Task 3),
  `RELAY_WARM_JOB` (existing).
- Produces (Task 5 relies on this): `ProvisionRelayInput.postalCode?: string` -
  forwarded ONLY into the tier-3 (`needs_connecting`) `RELAY_WARM_JOB` payload
  as `payload.postalCode`; `RelayWarmPayload.postalCode?: string`.

- [ ] **Step 1: Write the failing tests**

(a) In `app/test/relayWarm.test.ts`, add (mirroring the file's existing
parse/handler test style):

```ts
  it('parseRelayWarmPayload: a non-empty string postalCode is kept; missing/empty/non-string is dropped', () => {
    expect(parseRelayWarmPayload({ conversationId: 'c1', postalCode: '30309' })).toEqual({
      conversationId: 'c1',
      postalCode: '30309',
    });
    expect(parseRelayWarmPayload({ postalCode: '' })).toEqual({});
    expect(parseRelayWarmPayload({ postalCode: 30309 })).toEqual({});
    expect(parseRelayWarmPayload({})).toEqual({});
  });

  it('handler forwards postalCode to warmOneNumber', async () => {
    const calls: [string | undefined, string | undefined][] = [];
    // Build the fake PoolNumbersService the way this file's existing handler
    // test does, with warmOneNumber recording its arguments:
    //   async warmOneNumber(conversationId?: string, postalCode?: string) {
    //     calls.push([conversationId, postalCode]);
    //   },
    // then register + dispatch:
    registerRelayWarmJobHandler({ poolNumbersService: fake, logger });
    await dispatchJob(envelope(RELAY_WARM_JOB, { conversationId: 'c1', postalCode: '30309' }));
    expect(calls).toEqual([['c1', '30309']]);
  });
```

(Use the file's existing envelope/dispatch helpers verbatim - the second test
above names the pieces; wire it with whatever local helper the file already
uses to build a job envelope.)

(b) Create `app/test/relayProvisioningPostal.test.ts`:

```ts
// provisionRelayGroup postalCode threading (area-code preference): at a TIER-3
// needs_connecting result the property ZIP rides the RELAY_WARM_JOB payload
// (so retries keep the hint); at tiers 1/2 (assigned) it is ignored - no warm
// job is enqueued for the group at all. Uses the real in-process jobs
// machinery with a capturing handler.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests as _resetJobs,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  defineJobHandler,
} from '../src/jobs/jobs.js';
import { createLogger } from '../src/lib/logger.js';
import { RELAY_WARM_JOB, type PoolNumbersService } from '../src/services/poolNumbers.js';
import { provisionRelayGroup } from '../src/services/relayProvisioning.js';
import { createLogCapture } from './helpers/logCapture.js';

// Minimal fakes: only the members provisionRelayGroup actually touches.
const logger = createLogger({ destination: createLogCapture().stream });

function makeConversationsRepo() {
  let seq = 0;
  return {
    async createRelayGroup(input: Record<string, unknown>) {
      seq += 1;
      return {
        conversationId: `conv-${seq}`,
        type: 'relay_group',
        status: 'poolNumber' in input && input['poolNumber'] !== undefined ? 'open' : 'connecting',
        members: input['members'],
      } as never;
    },
  } as never;
}

const auditRepo = { async append() {} } as never;
const events = { emit() {} } as never;

function makePool(result: 'assigned' | 'needs_connecting'): PoolNumbersService {
  return {
    async provisionForGroup() {
      if (result === 'assigned') {
        return {
          kind: 'assigned',
          poolNumber: '+15550300001',
          record: { poolNumber: '+15550300001' } as never,
          provisioned: false,
        };
      }
      return { kind: 'needs_connecting' };
    },
    async noteGroupClosed() {},
    async burnMember() { return true; },
    async burnGroupRoster() { return true; },
    async retireEligible() { return []; },
    async onNumberRegistered() {},
    async warmOneNumber() {},
    async refillBufferIfNeeded() {},
    async flagStuckWarming() {},
    async flagStuckConnecting() {},
    async getRecord() { return undefined; },
    async clearConnectingEarmarks() {},
  };
}

describe('provisionRelayGroup - postalCode threading', () => {
  const captured: Record<string, unknown>[] = [];

  beforeEach(() => {
    _resetJobs();
    captured.length = 0;
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    configureOutboundQueue(new InProcessOutboundQueueAdapter());
    defineJobHandler(RELAY_WARM_JOB, (payload) => {
      captured.push(payload as Record<string, unknown>);
    });
    // Swallow the intro job if the assigned path enqueues it.
    defineJobHandler('relay.introduce', () => {});
  });

  afterEach(() => {
    _resetJobs();
  });

  const members = [{ phone: '+15550100001' }, { phone: '+15550100002' }] as never;

  it('tier-3: postalCode rides the RELAY_WARM_JOB payload', async () => {
    const conversation = await provisionRelayGroup(
      { conversationsRepo: makeConversationsRepo(), poolNumbersService: makePool('needs_connecting'), auditRepo, events, logger },
      { members, owner: { type: 'placement', id: 'p1' }, postalCode: '30309' },
    );
    expect(conversation.status).toBe('connecting');
    expect(captured).toEqual([{ conversationId: conversation.conversationId, postalCode: '30309' }]);
  });

  it('tier-3 without postalCode: payload carries only the conversationId', async () => {
    const c = await provisionRelayGroup(
      { conversationsRepo: makeConversationsRepo(), poolNumbersService: makePool('needs_connecting'), auditRepo, events, logger },
      { members, owner: { type: null } },
    );
    expect(captured).toEqual([{ conversationId: c.conversationId }]);
  });

  it('tiers 1/2 (assigned): postalCode is ignored - no warm job for the group', async () => {
    await provisionRelayGroup(
      { conversationsRepo: makeConversationsRepo(), poolNumbersService: makePool('assigned'), auditRepo, events, logger },
      { members, owner: { type: 'tour', id: 't1' }, postalCode: '30309' },
    );
    expect(captured).toEqual([]);
  });
});
```

Fix up the exact intro-job name (`RELAY_INTRO_JOB` from
`app/src/jobs/relayFanOut.ts` - import and use the constant instead of the
string literal) and the jobs reset/configure helper names to match what
`app/test/placementsRelay.test.ts` imports (same machinery, lines 10-19
there). If `provisionRelayGroup`'s assigned path awaits the intro enqueue and
the queue needs an explicit settle/drain (see `jobs.test.ts` `adapter.settle()`),
drain before asserting.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `app/`): `npx vitest run test/relayWarm.test.ts test/relayProvisioningPostal.test.ts`
Expected: FAIL - `postalCode` dropped by the parser / not on
`ProvisionRelayInput` (TS error) / payload lacks postalCode.

- [ ] **Step 3: Implement**

(a) `app/src/jobs/relayWarm.ts`:

- `RelayWarmPayload` gains:

```ts
  /**
   * Property ZIP hint for the buy (area-code preference): tier-3 buys for a
   * tour/placement group prefer numbers local to the unit. Absent for buffer
   * refills and standalone groups (Atlanta-default ladder). Riding the payload
   * keeps the hint across job retries.
   */
  postalCode?: string;
```

- `parseRelayWarmPayload`: same tolerance idiom as conversationId:

```ts
  const postalCode =
    typeof p.postalCode === 'string' && p.postalCode.length > 0 ? p.postalCode : undefined;
  return {
    ...(conversationId !== undefined && { conversationId }),
    ...(postalCode !== undefined && { postalCode }),
  };
```

- Handler: `await poolNumbers.warmOneNumber(payload.conversationId, payload.postalCode);`

(b) `app/src/services/relayProvisioning.ts`:

- `ProvisionRelayInput` gains:

```ts
  /**
   * Property ZIP (5 digits) for the pool-number buy when this group is owned
   * by a tour/placement (area-code preference). Used ONLY on the tier-3
   * connect-when-ready path (rides the warm-job payload); tiers 1/2 assign an
   * existing number and ignore it. Never required - absent means the
   * Atlanta-default ladder.
   */
  postalCode?: string;
```

- Destructure it (`const { members, tag, placementId, owner, actor, postalCode } = input;`)
  and change the tier-3 enqueue (~line 115) to:

```ts
      await enqueueImmediate(RELAY_WARM_JOB, {
        conversationId: conversation.conversationId,
        ...(postalCode !== undefined && { postalCode }),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `app/`): `npx vitest run test/relayWarm.test.ts test/relayProvisioningPostal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git status` (bare), then:

```bash
git commit -m "feat(relay): thread property ZIP through ProvisionRelayInput and the warm-job payload" -- app/src/jobs/relayWarm.ts app/src/services/relayProvisioning.ts app/test/relayWarm.test.ts app/test/relayProvisioningPostal.test.ts
```

---

### Task 5: Routes resolve the unit ZIP (`zipFive` helper)

**Files:**
- Modify: `app/src/lib/address.ts` (new helper at the bottom)
- Modify: `app/src/routes/placements.ts` (~line 999 provision call)
- Modify: `app/src/routes/tours.ts` (~line 840 provision call)
- Test: `app/test/placementsRelay.test.ts`, `app/test/toursApi.test.ts`
  (helper cases are covered through the route tests; if an
  `app/test/address.test.ts` exists, add the same four `zipFive` cases there
  directly)

**Interfaces:**
- Consumes: `ProvisionRelayInput.postalCode` (Task 4), `Address` (existing).
- Produces: `zipFive(a: Address | string | undefined): string | undefined` in
  `app/src/lib/address.ts` - leading 5 digits of a structured address's
  trimmed `zip`; `undefined` for legacy string addresses, missing zip, or a
  zip not starting with 5 digits.

- [ ] **Step 1: Write the failing tests**

(a) `app/test/placementsRelay.test.ts` - in `seedPlacement` (~line 132),
change the unit creation to carry an address:

```ts
  await world.unitsRepo.create({
    unitId: 'unit-1',
    landlordId: 'c-landlord',
    status: 'available',
    address: { line1: '123 Main St', city: 'Atlanta', state: 'GA', zip: '30309-1234' },
  });
```

Then add a test inside the existing describe (reuse the file's `world`/app
setup from its neighboring tests, plus `defineJobHandler` + `RELAY_WARM_JOB`
imports as in Task 4's test):

```ts
  it('tier-3 relay creation threads the unit ZIP (5 digits) into the warm-job payload', async () => {
    const placementId = await seedPlacement(world);
    const captured: Record<string, unknown>[] = [];
    defineJobHandler(RELAY_WARM_JOB, (payload) => {
      captured.push(payload as Record<string, unknown>);
    });
    // A pool service with NO number available now -> tier-3 connect-when-ready.
    const pool: PoolNumbersService = {
      ...makeFakePoolNumbers(),
      async provisionForGroup() {
        return { kind: 'needs_connecting' };
      },
    };
    const app = makeAppWith(pool); // build the app exactly as the neighboring tests do, injecting this pool service
    const res = await post(app, `/api/placements/${placementId}/relay`);
    expect(res.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ postalCode: '30309' }); // ZIP+4 truncated to 5
  });
```

(`makeAppWith` stands for however the surrounding tests construct the router/
app with an injected pool service - reuse that exact helper/pattern; do not
invent a new harness.)

(b) `app/test/toursApi.test.ts` - find the existing tour-relay
(`POST /api/tours/:tourId/relay`) tests; seed that suite's unit with the same
`address: { ..., zip: '30309-1234' }` and add the analogous test: fake pool
service returns `needs_connecting`, capture `RELAY_WARM_JOB`, POST the relay
route, assert `captured[0]` matches `{ postalCode: '30309' }`. Also add the
negative case in whichever file sets up faster (placement suite is fine):

```ts
  it('a unit with NO usable zip still creates the group - payload just omits postalCode', async () => {
    // seed with address: { city: 'Atlanta' } (no zip); otherwise identical to
    // the previous test; assert res.status 201 and
    // expect(captured[0]).not.toHaveProperty('postalCode');
  });
```

Write that negative case out fully (copy the previous test, change the seeded
address and the final assertion) - no shorthand in the actual test file.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `app/`): `npx vitest run test/placementsRelay.test.ts test/toursApi.test.ts`
Expected: new tests FAIL (no postalCode in payload); pre-existing PASS.

- [ ] **Step 3: Implement**

(a) `app/src/lib/address.ts`, after `formatAddress`:

```ts
/**
 * Leading 5-digit ZIP of a structured address, for geographic search hints
 * (relay pool-number buys). ZIP+4 truncates to the first 5; a legacy plain-
 * string address, missing/blank zip, or a zip not STARTING with 5 digits all
 * return undefined (the caller simply omits the hint - never an error).
 */
export function zipFive(a: Address | string | undefined): string | undefined {
  if (a === undefined || typeof a === 'string') return undefined;
  const match = a.zip?.trim().match(/^(\d{5})/);
  return match?.[1];
}
```

(b) `app/src/routes/placements.ts` - the unit is already loaded (~line 967).
Import `zipFive` from `../lib/address.js`; before the `provisionRelayGroup`
call add `const postalCode = zipFive(unit.address);` and extend the input
object (~line 1001):

```ts
        { members, placementId, ...(tag !== undefined && { tag }), ...(actor !== undefined && { actor }), ...(postalCode !== undefined && { postalCode }) },
```

(c) `app/src/routes/tours.ts` - import `zipFive`; after the members are
resolved and before the claim (~line 818), load the unit once for the hint
(the auto-resolve path fetched it internally but does not expose it):

```ts
    // Property-ZIP hint for a potential tier-3 buy (area-code preference).
    // Best-effort: a missing unit/address just means no hint - never a 4xx
    // (the roster resolution above already produced its own errors if the
    // unit truly matters).
    const unitForZip = await units.getById(tour.unitId);
    const postalCode = zipFive(unitForZip?.address);
```

and extend the provision input (~line 848):

```ts
        {
          members,
          owner: { type: 'tour', id: tourId },
          ...(actor !== undefined && { actor }),
          ...(postalCode !== undefined && { postalCode }),
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `app/`): `npx vitest run test/placementsRelay.test.ts test/toursApi.test.ts`
Expected: PASS (new + all pre-existing).

- [ ] **Step 5: Commit**

`git status` (bare), then:

```bash
git commit -m "feat(relay): tour/placement relay creation passes the unit ZIP as the buy hint" -- app/src/lib/address.ts app/src/routes/placements.ts app/src/routes/tours.ts app/test/placementsRelay.test.ts app/test/toursApi.test.ts
```

---

### Task 6: fake-twilio `InPostalCode` parity

**Files:**
- Modify: `fake-twilio/src/routes/voiceRest.ts` (`availableCandidates` ~line 53;
  the Local.json route ~line 100)
- Test: `fake-twilio/test/voiceRest.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (mirrors the real Twilio API the Task 2
  driver calls).
- Produces: `GET .../AvailablePhoneNumbers/US/Local.json?InPostalCode=30309`
  returns candidates prefixed `+1303019xxxx` (ZIP first-3 marker);
  `InPostalCode` wins over `AreaCode` when both are sent.

- [ ] **Step 1: Write the failing test**

In `fake-twilio/test/voiceRest.test.ts`, next to the existing AreaCode search
test (mirror its request/harness idiom exactly):

```ts
  it('AvailablePhoneNumbers honors InPostalCode (ZIP first-3 prefix marker), winning over AreaCode', async () => {
    const res = await request(app)
      .get('/2010-04-01/Accounts/ACfake/AvailablePhoneNumbers/US/Local.json')
      .query({ InPostalCode: '30309', AreaCode: '404', PageSize: 2 });
    expect(res.status).toBe(200);
    const numbers = res.body.available_phone_numbers.map(
      (n: { phone_number: string }) => n.phone_number,
    );
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) {
      expect(n.startsWith('+1303019')).toBe(true); // ZIP 30309 -> "303" segment
    }
  });
```

(Use the file's actual app/harness variable and account-sid literal from its
neighboring AreaCode test.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `fake-twilio/`): `npx vitest run test/voiceRest.test.ts`
Expected: new test FAILS (numbers come back `+1404019...` - AreaCode applied,
InPostalCode ignored).

- [ ] **Step 3: Implement**

In `fake-twilio/src/routes/voiceRest.ts`:

(a) `availableCandidates` (~line 53) - replace the areaCode parameter with a
single prefix-segment parameter:

```ts
function availableCandidates(registry: NumberRegistry, prefixSegment: string | undefined, want: number): string[] {
  const out: string[] = [];
  let n = 1;
  while (out.length < want && n < 10000) {
    const suffix = String(n).padStart(4, '0');
    const phone = prefixSegment !== undefined ? `+1${prefixSegment}019${suffix}` : `+1555019${suffix}`;
    if (!registry.isPool(phone)) out.push(phone);
    n += 1;
  }
  return out;
}
```

(update its doc comment: the segment comes from AreaCode, or the first 3
digits of InPostalCode - InPostalCode wins - so tests can assert which hint
threaded through).

(b) Route (~line 100-105):

```ts
    const q = req.query as Record<string, string | undefined>;
    const areaCode = typeof q['AreaCode'] === 'string' && q['AreaCode'].length > 0 ? q['AreaCode'] : undefined;
    const inPostalCode =
      typeof q['InPostalCode'] === 'string' && q['InPostalCode'].length > 0 ? q['InPostalCode'] : undefined;
    // InPostalCode wins over AreaCode (mirrors the app driver's precedence).
    const prefixSegment = inPostalCode !== undefined ? inPostalCode.slice(0, 3) : areaCode;
    const limit = Number(q['PageSize'] ?? q['Limit'] ?? 10);
    const want = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10) : 1;
    const numbers = availableCandidates(registry, prefixSegment, Math.max(want, 1));
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `fake-twilio/`): `npx vitest run`
Expected: PASS (new + all pre-existing fake-twilio tests, including
numberRegistry).

- [ ] **Step 5: Commit**

`git status` (bare), then:

```bash
git commit -m "feat(fake-twilio): InPostalCode filter parity on AvailablePhoneNumbers search" -- fake-twilio/src/routes/voiceRest.ts fake-twilio/test/voiceRest.test.ts
```

---

### Task 7: Sync main + full gates

**Files:** none new (merge resolution only, if any).

- [ ] **Step 1: Merge latest main** (ONE sync, per house rule): from the
  worktree run `git fetch` then `git merge main`. Resolve any conflicts
  keeping BOTH sides' intent. If conflicts are non-trivial, STOP and ask.

- [ ] **Step 2: `npm install`** if the merge brought dependency changes
  (check whether the merge touched `package-lock.json`).

- [ ] **Step 3: Run the full gates, BARE, each as its own command:**

```
npm run typecheck
npm test
npm run e2e
```

Expected: all three green (e2e needs Docker up). `npm run typecheck` is
REQUIRED even with green tests - the runtime suites strip types without
checking them.

- [ ] **Step 4: Commit any merge-resolution artifacts** (only if the merge
  created them; `git status` bare first, explicit pathspecs as always).

- [ ] **Step 5: Hand back** - report branch name, commit list, and gate
  output summaries. Do NOT merge into main.

---

## Verification checklist (for the reviewer)

- `RELAY_PREFERRED_AREA_CODES` unset -> config default is exactly
  `['404','470','678','770','943']`; explicit empty -> `[]`; `47a`/`4040`
  refuse boot.
- `warmOneNumber('conv','30309')` with all hints scripted unavailable calls
  the adapter with `{postalCode:'30309'}`, `{areaCode:'404'}`, ...,
  `{}` - in that order - and buys exactly once.
- A non-`NumberUnavailableError` failure at any rung stops the ladder with no
  further adapter calls.
- Placement + tour relay creation on a unit with `zip: '30309-1234'` puts
  `postalCode: '30309'` in the tier-3 warm-job payload; a ZIP-less unit still
  creates the group with no `postalCode` key.
- Buffer refills still enqueue `{}` (no ZIP inheritance).
- No log line anywhere contains a ZIP value or phone number alongside the new
  events (`relay_warm_hint_miss`, `hintTier`).
- All touched docs pass the ASCII check.
