# Reader C - RELAY side: catalog, interpolate, fan-out, previews (plan Tasks 1, 13, 14)

Common brief: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\research-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\research-C-relay.md`

Files: `app/src/messages/resolve.ts`, `app/src/messages/catalog.ts`,
`app/test/messages/resolve.test.ts`, `app/test/messages/catalog.test.ts`,
`app/src/jobs/relayFanOut.ts`, `app/src/services/rosterEdits.ts`,
`app/src/services/relayAnnouncements.ts`, `app/src/repos/conversationsRepo.ts`
(`getOwner`, participants shape, `relayMemberKey`), `app/src/lib/tourContacts.ts`,
`app/src/lib/address.ts` (`formatStreet`), `app/src/lib/localTime.ts`,
`app/src/lib/quietHours*.ts` (`resolveQuietHoursTimezone`), `app/src/repos/unitsRepo.ts`
(`UnitContact.role`), preview routes (grep `buildOpenPreview|buildAddPreview|buildStandaloneOpenPreview`),
tests `app/test/relayFanOut.test.ts`, `toursApi.test.ts`, `placementsApi.test.ts`,
`relayGroupPreview.test.ts`, `relayApi.test.ts`; e2e `e2e/scenarios/steps.ts`
(intro/member-added assertions), `e2e/tests/tour-roster.spec.ts`,
`e2e/tests/relay-group-view.spec.ts`, `e2e/tests/roster-quiet-hours.spec.ts`.

Deliver:
1. `interpolate` current body byte-exact + docblock; `resolveMessage` signature;
   the strict/override split; existing tests in `resolve.test.ts` (list cases).
   Confirm the token charset actually used by every catalog `vars` entry (the plan
   wants a structural test iterating `MESSAGE_CATALOG` - name the export).
2. Catalog: `MessageId` union byte-exact; the two relay entries (`relay.intro`,
   `relay.member_added`) with their full docblocks and `vars`; catalog tests that
   pin them (`:35-41`, `:43-52`, `:62-69` per plan - true lines + what each
   asserts); the housing-authority removal comment.
3. `relayFanOut.ts`: `composeConnectionSentence` (full body), `ANONYMOUS_JOINED_LABEL`,
   `composeIntroBody`, `composeMemberAddedBody`, the intro job handler (edited-body
   precedence check, roster shape, `persist:false` usage, dep wiring/lazy pattern),
   the member-added job handler (payload shape - what identifies the added member),
   every importer of each of these symbols app-wide (grep).
4. `rosterEdits.ts`: `RosterResolutionDeps`, `RosterOwner`, `buildOpenPreview`,
   `buildOpenPreviewFromParts` / `OpenPreviewParts`, `buildAddPreview` + docblock,
   `buildStandaloneOpenPreview`; ALL call sites of each (routes) with how deps are
   constructed there.
5. `relayAnnouncements.ts`: `RelayAnnouncementInput`, the roster loop, where `body`
   is persisted / sent / used by `touchLastActivity`, `persist:false` semantics.
6. `getOwner(conv)` return shape byte-exact; tours/placements repo getters (`get`
   vs `getById`), `tenantId`/`unitId`/`scheduledAt` fields on `TourItem` and
   `PlacementItem`; `resolveTourContactNames` signature + what it needs;
   `formatStreet`, `formatLocalDate`, `formatLocalTime`, `resolveQuietHoursTimezone`
   signatures.
7. THE RELAY TRIPWIRE INVENTORY (spec 10a.2 floor + everything else): every test
   or e2e site asserting relay intro / member_added composed copy or the
   `{members}` literal or `You're now connected with` or `joined this group chat`
   - file:line, quoted expectation, and which task (13 or 14) breaks it. Include
   `relay-group-view.spec.ts` nameless-joiner case and `roster-quiet-hours.spec.ts`.
8. Flag: does `relay.member_added` currently declare `['joined','members']`
   (the plan's Task 1 probe depends on it)? Does `resolveMessage` accept an
   overrides third arg as the plan's Task 1 tests assume?
