# Slice S2 report - settings record (plan Task 2)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context).
Scope held to the five named files; nothing else staged.

## Commit

- `6f020587` feat(voicemail-greeting): settings record - VoicemailGreeting map,
  fixed-key projection, null-REMOVE patch; PUT /api/settings ignores it

## Gates (run bare from the worktree)

- RED `Tests  1 failed | 42 passed (43)`: only `projects a well-formed map`
  (`expected undefined to deeply equal { ...(7) }` - nothing projected it);
  the malformed, REMOVE and parsePatch cases already passed, per the plan.
- GREEN `Test Files  2 passed (2)`, `Tests  43 passed (43)`. `npm run
  typecheck` exit 0. `npx eslint` on the five files: exit 0, no findings.
  ASCII: 0 non-ASCII bytes in the new file and in the 127 added lines.
- RED cannot show the malformed rows or the pin bite, so 4 mutation probes
  (each reverted, diff re-read) all went red: fixed-key check off (the
  `recordings/CA1/RE1` row), `raw === null` off (the `null` row THROWS), `< 0`
  off (the `-1` row), parsePatch forwarding the key (the routes pin).

## Divergences (else identical to plan Task 2 code)

1. Malformed table +6 rows: MISSING contentType (spec 5 names it; the plan had
   only a wrong value), non-string fileName, `sizeBytes: -1`, missing
   uploadedByUserId, null uploadedByEmail, raw `null` (a DynamoDB NULL). Every
   spec 4.2 ALL-of clause a stored item can reach is pinned (not isFinite).
2. `toOrgSettings`: the IIFE became a local `const voicemailGreeting` + the
   function's own `...(cond && {...})` idiom. Same output and key order.
3. Two now-false "(today only welcomeText)" comments in settingsRepo.ts (the
   `putOrgSettings` JSDoc and body) name both nullable fields.

## Worth an eye (not blocking)

1. The pin bites ONLY because the fake learned the field: the old fake's
   hand-enumerated merge dropped unknown keys, so pre-S2 it passed vacuously.
2. N7 holds: the fake returns `{ ...settings }` unprojected; the foreign-key
   rejection is pinned only in settings.test.ts.
3. `SettingsPatch`'s "only the greeting routes below write it" is a forward
   reference S4 makes true. `test/helpers/settingsStub.ts` (a second settings
   fake) is read-only and needs no change.
