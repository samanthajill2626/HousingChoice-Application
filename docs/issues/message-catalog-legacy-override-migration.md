---
id: message-catalog-legacy-override-migration
title: Migrate legacy OrgSettings message fields onto the generic message-override map
type: improvement
severity: low
status: open
area: app
created: 2026-07-03
refs: app/src/messages/catalog.ts, app/src/messages/resolve.ts, app/src/repos/settingsRepo.ts, dashboard/src/routes/settings/TemplatesSection.tsx
---

**Problem.** The message catalog (`app/src/messages/`, added 2026-07-03) made
every automated message resolve through one registry + resolver, and the
resolver already *accepts* a generic `Partial<Record<MessageId, string>>`
override map. But to honor "no new editable Settings fields in that pass," the
generic `messageOverrides` storage field was deliberately **not** added. Today
`settingsToOverrides()` maps only the legacy three editable messages
(`welcomeText → welcome.sms`, `missedCallAutoText → missed_call.autotext`; and
`quickReplies` still lives as its own list-typed field). So the newly-centralized
messages (tour reminders, placement nudges, relay intro, voice, verification)
resolve to their catalog defaults with **no override path yet**.

The moment we want to make the *next* message operator-editable, we should stop
extending the one-named-field-per-message pattern and switch to the generic map.

**Suggested fix.** When adding the next settings-editable message:

1. Add `messageOverrides?: Partial<Record<MessageId, string>>` to `OrgSettings`
   (repo + `dashboard/src/api/types.ts` wire types).
2. Add a validated writer in `settings.ts parsePatch`: per-message enforce the
   catalog entry's `requiresOptOut` (via `templateHasOptOutLanguage`) and
   `maxChars`; reject overrides for `editable: false` (compliance-locked/voice/
   transactional) ids.
3. Build a **generic** Templates UI that iterates `MESSAGE_CATALOG` filtered to
   `editable: true` and renders one field per entry (default shown as
   placeholder) — replacing the hand-wired per-field blocks in
   `TemplatesSection.tsx`.
4. Migrate `welcomeText` / `missedCallAutoText` (and consider `quickReplies`)
   **into** `messageOverrides` with a one-time data migration of the singleton
   `org` settings item, then retire the legacy named fields.
5. Spread `messageOverrides` into `settingsToOverrides()` — the single place the
   adapter reads.

Natural companion: the shared-package extraction in
[[consent-copy-cross-stack-drift]] — the generic Templates UI needs to read the
catalog on the dashboard side, which is exactly when a shared module earns its
keep.
