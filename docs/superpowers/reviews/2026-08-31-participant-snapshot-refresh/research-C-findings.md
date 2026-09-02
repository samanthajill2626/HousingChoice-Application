# research-C findings - Tasks 7, 8, 9, 10 vs the live tree

Read-only verification against `W:\tmp\participant-snapshot-refresh` @ `e6599b4f`.
`git diff --name-only b702a81c HEAD` returns only 7 `docs/superpowers/` paths, so
the code tree is byte-identical to `b702a81c` and every plan line number is
directly comparable.

Reference quotations: `.superpowers/sdd/research-C-reference.md` (run state, not
committed by this pass).

Severity key: BLOCKING = the builder stops or the test cannot run/compile;
HIGH = a plan expectation value or measured claim is wrong; MED/LOW otherwise.

---

## 1. BLOCKING - Task 7 Step 1's inboundMessagePush RED test dereferences a thread that does not exist yet

Plan `2026-09-01-participant-snapshot-refresh.md:1134-1145`.

The snippet's first statement is
`const thread = world.conversations.get(GROUP_ID)!;` followed by
`thread.participants = ...`, BEFORE any `signedTwilioPost`.

- `app/test/inboundMessagePush.test.ts:156-174` builds a FRESH
  `world = createFakeWorld()` in `beforeEach` and seeds NO conversations. The
  `'inbound message push - native group text'` describe (`:494-528`) adds no
  `beforeEach` of its own.
- The `GROUP_ID` thread is CREATED by the inbound itself:
  `app/src/routes/webhooks/twilio.ts:1526-1541` (not found -> `resolveGroupMembers`
  -> `createGroupTextThread`). The sibling test at `:495-509` proves this - it
  reads `world.conversations.get(GROUP_ID)!` only AFTER its post.

So the map lookup returns `undefined` and the test dies with a TypeError before
reaching the assertion. It would look "RED" for the wrong reason and could never
go green.

The obvious repair - post once to create the thread, then mutate, then post
again - ALSO fails: `soleMessagePayload` (`:66-72`) asserts
`world.pushBroadcasts` has length exactly 1, and each accepted inbound emits one
push.

Correct shape: seed the row directly before the single post, as a `group_text`
in `group_open` status with the stale roster, so twilio.ts's branch (b)
(`:1545-1549`) adopts it without refreshing any name. The fake's own writer
(`app/test/helpers/twilioWebhookHarness.ts:916-932`) is the shape to copy;
`app/test/inboundMessagePush.test.ts:97-118` (`seedGroup`) is the local
precedent, but it writes `type: 'relay_group'` and must NOT be reused as-is -
a relay_group at a derived group id falls into twilio.ts's `group_id_wrong_shape`
error branch (`:1585-1593`) and the message is filed 1:1 instead.

Also note the roster must keep `contactId: 'c-ana'` on the SENDER row for the
test's premise to hold, and the sender's phone is `SENDER` = `TENANT_PHONE`
(`:48`).

## 2. HIGH - Task 10 Step 3 prescribes `status: closed`, which is not a legal status

Plan `:1578-1584`.

`scripts/issues.mjs:18` defines
`STATUSES = ['open', 'in-progress', 'deferred', 'resolved', 'wontfix']`, and
`docs/issues/_TEMPLATE.md:17` documents the same five. `closed` is not among
them. `scripts/issues.mjs:52` pushes
`unknown status "closed"` for every such file; the run still exits 0
(no `process.exit` after `:93`), so this is a silent schema violation that the
INDEX will advertise as a warning on every future `npm run issues`.

The plan uses `closed` four times:
`today-shows-phone-instead-of-name`, `group-roster-name-snapshot-never-refreshed`,
`relay-stale-participant-phone`, and `today-contact-hydration-fan-out`.

Correct values: `resolved` for the first three; `wontfix` for
`today-contact-hydration-fan-out` (its own body says "CLOSE THIS as wontfix").

Related omission: `_TEMPLATE.md:25` requires a `resolved: YYYY-MM-DD` frontmatter
field to be ADDED when an issue is closed. The plan never mentions it, so all
four stamps would land without it.

## 3. HIGH - Task 8 Step 5's lane run omits the per-lane AWS access key, which silently reads an EMPTY database

Plan `:1453`: "run the script ONCE against that lane the way its header comment
documents (the lane's `DYNAMODB_ENDPOINT` and table prefix come from
`scripts/e2e-session.mjs`'s output)". Endpoint + prefix are NOT sufficient.

`e2e/README.md:454-460` and `scripts/e2e-session.mjs:115-127`: the shared
DynamoDB Local container runs WITHOUT `-sharedDb`, so the store is keyed by
`(accessKeyId, region)`. The lane's key is `hclane<L>`
(`e2e/support/lane.mjs:167`), forced with no fallback precisely because "an
ambient shell AWS_ACCESS_KEY_ID would silently merge every lane back into ONE
database".

The script sets no credentials (`app/scripts/measure-unread-contact-coverage.ts:80-83`
constructs the client with region + endpoint only), so it inherits the shell's.
Run under any other key and the audit reads a DIFFERENT database: zero rosters,
zero drift, `NOT RETURNED 0` - which is exactly the "both blocks print, exit 0"
success signature the plan tells the builder to record. This is a
plausible-but-false result, not a visible failure.

The run needs all four, plus `--confirm`:

```
DYNAMODB_ENDPOINT=http://localhost:8000 TABLE_PREFIX=hc-local-<L>- \
AWS_ACCESS_KEY_ID=hclane<L> AWS_SECRET_ACCESS_KEY=local \
npx tsx app/scripts/measure-unread-contact-coverage.ts --confirm --audit-denorm
```

`<L>` and the key are in `e2e/.artifacts/lane.json` (`accessKeyId`,
`tablePrefix`). `AWS_REGION` may be omitted - the script defaults to `us-east-1`
(`:81`), matching the lane.

## 4. HIGH - Task 8 Step 5 never passes `--confirm`, and the script hard-exits 2 without it

Plan `:1453` describes the run only as "run the script ONCE against that lane the
way its header comment documents". `app/scripts/measure-unread-contact-coverage.ts:41-57`
refuses and `process.exit(2)` unless `argv` includes `--confirm`; `:75-78` exits 2
unless `TABLE_PREFIX` is a non-empty string. `--audit-denorm` alone gets exit 2.
Loud, not silent - but the plan should name the full argv so the builder does not
read exit 2 as a code defect.

## 5. HIGH - Task 10 Step 2's measurement contradicts the issue's own stated rule, and the "N < 30" threshold is invented

Plan `:1576` measures `N` by wrapping `world.contactsRepo.getById` inside
`app/test/todayApi.test.ts`; `:1584` then closes the issue "per the issue's own
rule" if `N < 30`.

`docs/issues/today-contact-hydration-fan-out.md:19-25` says something different:

- measure "a real Today payload (against the imported dataset, not `lean`)";
- "`npm run perf:pages` is the sanctioned profiler";
- "If N is small, CLOSE THIS as wontfix and say so" - no number is given
  anywhere in the file.

A Vitest fake-world count measures the FIXTURES a test file happens to seed, not
the production fan-out the issue asks about, and the largest-seeding test in
`todayApi.test.ts` (`:901-969`) deliberately seeds 101 DELETED contacts, so its N
is not representative in either direction. The proposed resolution text would
also assert a rule the issue does not contain.

Either measure the way the issue prescribes, or state plainly in the resolution
that N was measured in the unit harness, is a fixture count, and name the number
- but do not attribute the 30 threshold to the issue.

Mechanically the wrap itself is fine: `FakeWorld.contactsRepo` exists
(`app/test/helpers/twilioWebhookHarness.ts:286`) and `todayApi.test.ts:29-37`
holds a `world`.

## 6. MED - Task 9 Step 3's fallback points at a form `e2e/README.md` documents but that does not work

Plan `:1557`: "If the root script does not forward `--grep`, run the single spec
the way `e2e/README.md` documents." The README's documented form
(`e2e/README.md:54`) IS the broken one:
`npm run e2e -- --grep "<name>"`. Root `package.json:41` is
`npm run e2e -w @housingchoice/e2e`, so the appended `--grep` is consumed by the
INNER npm as a config option and never reaches `playwright test`. The repo has
recorded this twice already:
`docs/superpowers/plans/2026-08-27-mms-image-viewer.md:1469` and
`docs/superpowers/plans/2026-08-16-manual-extraction-trigger.md:1797`.

Working form (used and reported green at
`docs/superpowers/reviews/2026-08-27-mms-image-viewer/sdd/slice8-e2e.md:32` and
`documentation/sequence-diagram-to-test.md:76`), still inside the e2e workspace
as AGENTS.md requires:

```
npm run e2e -w @housingchoice/e2e -- --grep "renaming a contact"
```

`e2e/playwright.config.ts:118` has `testDir: './tests'` and no `testMatch`, so
the new `e2e/tests/scenarios/participant-names.spec.ts` needs no config change.

## 7. MED - Task 10 leaves "Six" in the consolidate issue's title and refs while rewriting the body to thirteen

Plan `:1583` replaces only the "six copies" PARAGRAPH. But
`docs/issues/consolidate-contact-display-name-helpers.md:3` is
`title: Six private copies of the contact firstName/lastName join - ...` and
`:9` is a `refs:` list of exactly those six files. The title is what
`scripts/issues.mjs:66` renders into the INDEX table, so the corrected census
would be invisible where anyone triaging actually looks. Update the title and
`refs` in the same edit.

## 8. MED - the `voice.ts` docblock the plan writes contradicts a neighbouring comment it does not touch

`app/src/routes/webhooks/voice.ts:123-128` states that `maskedPartyLabel` "stays
local (it labels a roster MEMBER by its cached display name, a relay-only
concern)". After Task 7 the function is contact-first and no longer labels by the
cached name. The plan's Files list names only `:109-121`. Either amend `:123-128`
in the same commit or the file ships two comments that disagree about the same
function.

## 9. LOW - the `call_party_label` persist anchor is off by one site

Plan `:1082` cites "`the persisted call_party_label (voice.ts:985-986)`".
`:983-986` COMPUTES `calleeLabel` (two `maskedPartyLabel` calls). The persist is
`callPartyLabel: calleeLabel` at `:1011`, inside the `messages.append({...})` at
`:999-1012`. The plan's change lands correctly either way; only the citation is
imprecise.

## 10. LOW - two anchor lines are one or two off

- `teamTriagesUnknownToTenant` is declared at `e2e/scenarios/steps.ts:710`, not
  `:711` (`:711` is its `t: Tenant` parameter). JSDoc at `:704-709`.
- Plan `:1077` lists `app/test/inboundMessagePush.test.ts:495-524` as the target
  region; the describe actually spans `:494-528` and the named test
  `'uses roster NAMES once the members are known contacts'` is `:511-527`.
  Plan `:1131` gets the describe opener right (`:494`).

`contactId()` at `:3531`, `auditDenorm` at `:473`, the `:510` group skip, the
`:785` skip inside `auditTabVsPartition` (`:763`), `twilio.ts:301-316`,
`voice.ts:109-121`, `:991`, `:1044`, `:1307`, `ConversationDetail.tsx:87`,
`:212`, `:406`, and `tours.spec.ts:98-104` all MATCH exactly.

## 11. LOW - the spec's `seed/performance.ts` path does not exist

Spec `2026-08-31-participant-snapshot-refresh-design.md:177` cites
`seed/performance.ts:842`, `:857-858`, `:890`. Under the spec's own
`app/src/`-relative convention that resolves to `app/src/seed/performance.ts`,
which does not exist. The real file is `app/src/lib/seed/performance.ts`; all
three line numbers are correct there.

Worth recording alongside it: `:890` is
`` name: `Synthetic ${contact.type}` `` - a TEMPLATE literal that produces
"Synthetic tenant"/"Synthetic landlord" at runtime on native group-text rosters.
A literal-string grep can never find it, so "the grep returns nothing" does not
mean those strings are absent from the seeded `full` world - which is the world
Task 8's group audit will count.

---

## Verified with no delta (no action)

- `pushSenderLabel` docblock + body byte-for-byte at `twilio.ts:301-316`; both
  call sites (`:728`, `:1814`) already hold `senderContact`, so the "0 reads
  added" claim holds. `ContactItem` (`:41`), `formatPhoneForDisplay` (`:94`) and
  `contactDisplayName` (`:97`) are already imported - no import edit needed.
- `contactShortName` (`lib/voiceMasking.ts:46-53`) masks a hyphenated surname to
  its first character, so `shortNameFromFull('  Ada   Lovelace-Byron ')` ->
  `'Ada L.'` as the plan asserts, and a single token passes through unchanged.
  `contactShortName` is already imported into voice.ts at `:82`.
- `app/test/voiceMasking.test.ts` does NOT exist (the plan's "create if absent"
  is correct). `founderTriage.test.ts` and `voiceOutbound.test.ts` both exist.
- `seedRelay(world, overrides: Partial<ConversationItem>)` accepts
  `{ participants: [...] }`. Default roster: `c-alice`/`c-bob` with names
  `'Alice'`/`'Bob'`. `inboundVoiceParams()` is `From: ALICE, To: POOL`.
- The existing `call_party_label` pin `'Bob'` (`voiceWebhook.test.ts:113`) and
  the two `'Alice: is the unit available?'` push pins
  (`inboundMessagePush.test.ts:361`, `:410`) all survive the precedence flip -
  none of those tests seeds the matching contact.
- Relay membership is by PHONE (`voice.ts:884`), so the plan's RED test 2 roster
  with `contactId: ''` still bridges, and both `getById` calls are skipped.
- The whisper URL puts `callerLabel` FIRST (`voice.ts:1044`), so
  `res.text` can be asserted with `toContain('callerLabel=Alice%20A.')`
  (XML escaping touches only `&`).
- `world.contacts.push({ contactId, type, phone, firstName, lastName })` with no
  `status` is type-valid: `status` is optional and `ContactItem` carries
  `[key: string]: unknown` (`contactsRepo.ts:110`, `:292`).
- `listGroupTexts(opts?: { cursor?; limit? }) -> { items; nextCursor?; truncated }`
  (`conversationsRepo.ts:948-951`) and
  `listRelayGroups(status: 'open'|'closed'|'connecting') -> { items; truncated }`
  (`:805-807`) match `collectGroupRosters` exactly.
- `--audit-denorm` dispatch at `:963-966`; module-level `conversations`/`contacts`
  repos at `:90-91`.
- `expectGroupOnContactFile(other, contactId?)` DOES assert the other party's
  name on the opened card (`^With .*${displayNameOf(other)}`) plus the row's
  `href`, so `(renamed, ownerId)` is the right call.
- `openActiveContact` uses `this.activeContactId` first; nothing between
  `teamCreatesTenant` (`steps.ts:767`) and the rename reassigns it, so the plan's
  landlord-then-tenant ordering correctly leaves the TENANT active.
- `tenantTexts` sends to `APP_NUMBER` (`+15550009999`, the business number), so it
  does produce an unread 1:1 for Today's Unreplied list.
- `Contact` requires all four of `phone`/`name`/`firstName`/`lastName`; the plan's
  `renamed` literal supplies all four. Note `freshContact`'s `name` is NOT
  `firstName + ' ' + lastName` (`steps.ts:93`) - the plan correctly hand-builds
  `renamed.name` instead of reusing `tenant.name`.
- `teamCreatesTourFromInterest` kinds are `'Self-guided' | 'Landlord-led' |
  'PM team'`; `teamOpensTourGroup()` defaults to the `'naked'` variant.
- `expectTodayReady`, `useScenarioBudget`, the `NEXT` env convention, and
  `tours.spec.ts:98-104` as the `new Scenario(page, request)` precedent all match.
- `ConversationDetail.tsx` `identityFacts` is built from the `/members` roster
  (`:386-393`), rendered at `:406`; `^With .*<name>` matches that leaf div only.
  Path is `dashboard/src/routes/conversation/` (singular), not `conversations/`.
- Today renders `who` as `<span className={styles.who}>{item.who}</span>`
  (`Today.tsx:64`) inside a Link inside an li, so `getByText(name).first()` works.
- The fixture grep is correct: "Synthetic tenant" / "Synthetic participant" /
  "Synthetic landlord" appear NOWHERE in `app/test`, `e2e` or `app/scripts`.
