<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-09-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` (merge `7be40139`) and its feature branch + worktree were deleted during worktree
> cleanup. **This file is NOT current documentation, and the live code may have drifted from
> it. Do not treat it as authoritative guidance on how the system should be built or how it
> behaves today.** For current truth read the code and the living docs (e.g. `RUNBOOK.md`,
> `e2e/README.md`, `AGENTS.md`). The mission's review record - reviews, adjudications, slice
> reports, merged worklist and handback - is preserved at
> `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/`.

# Participant names: resolve on read

Branch `feat/participant-snapshot-refresh`, worktree `W:\tmp\participant-snapshot-refresh`.
Bundle M1. Base: `main` @f27aabbf (phase-b merged). Line numbers are as of
`b702a81c`; re-derive by symbol if `main` moves.

Design history (six revisions, four reviews, two fresh reviews) is in
`docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/`. This
document carries only the decisions.

## 1. Problem

A conversation row stores a copy of each participant's name at write time -
`participant_display_name` (1:1) and `participants[].name` (group roster) -
and nothing keeps it current. Measured 2026-08-25 in prod: 579 of 684 open 1:1
threads carry no name while the contact has one.

Founder-observed symptoms, both closed by this branch:

1. Today shows a phone number where it should show a person.
2. Renaming a contact does not change group titles or member chips.

## 2. Decisions (Cameron, 2026-08-31)

1. **Resolve on read.** Every display surface takes the name from the contact
   record when it renders.
2. **The chain:** live contact name -> stored snapshot -> formatted phone.
3. **Batch.** One `getDisplaysByIds` per page. Never one read per member.
   Never a `findByPhone` on a request path.
4. **No unnecessary reads.** A surface that already holds the contact adds
   nothing. A surface whose client already fetches a resolved roster is not
   hydrated again.
5. **Phone numbers: no code change.** Correcting a number is remove-and-re-add.
   `participants[].phone` is never touched.
6. **Outbound message content is out.** Relay intro / member-added bodies were
   rewritten by phase-b (naked/tour/placement variants); no issue is filed.

## 3. Scope

### In

| # | surface | file:line | reads added |
|---|---|---|---|
| S1 | Today `who` | `routes/today.ts:1075` | 0 - contact already memoized by the deleted-check at `:743` |
| S1 | Today relay close-nag member names | `routes/today.ts:1000` | 1 batch over `listRelayGroups('open')` |
| S2 | Inbox group rows | `routes/inbox.ts:1190` (`groupRowFor`), called `:1237`, `:2358` | 1 batch per page |
| S2 | Inbox relay rows | `routes/inbox.ts:1154` (`relayRowFor`), called `:1418`, `:2293` | 1 batch per page. `filter=all` pays TWO (relay partition at `:2293`, group partition at `:2358` - separate reads ~50 lines apart). `filter=unread` pays one batch per multi-party row at `:1418`, beside the point read that loop already does per row |
| S2 | Contact page group cards | `routes/contacts.ts:1204`, `:1294` | 1 batch per card, ids collected AFTER the membership filter |
| S2 | Relay members panel | `routes/relayGroups.ts:469-505` | FEWER - replaces per-member `getById` with one batch; stops deleting the stored name at `:489` |
| S2 | `GET /calls/:callId` passthrough | `routes/api.ts:2185`, feeds QuickReply | 1 batch over one roster |
| S3 | People card (`describeRoster`) | `lib/rosterResolution.ts:564` | 0 - flip the precedence; contact already read |
| S4 | Push sender label | `routes/webhooks/twilio.ts:307` | 0 - contact already in hand; flip precedence |
| S4 | Voice masked party label | `routes/webhooks/voice.ts:116` | 0 - contact already in hand; flip precedence, stays masked. The same label is the SPOKEN whisper's caller name (`:1044` -> `/whisper`), so it moves too |
| S5 | Drift audit, group rosters | `scripts/measure-unread-contact-coverage.ts:510` (`auditDenorm`) | offline script |

Net request-path cost: one batch read on the contact page; one on the inbox
page for `groups`, two for `all`, one per multi-party row for `unread`; and one
existing route gets cheaper.

### Out, and why

- **Thread header `GET /conversations/:id`** (`routes/api.ts:2004`). Every
  view that fetches it also fetches `/members` or `/group-members` on the same
  mount (`ConversationDetail.tsx:87` + `:212`), which already resolve names.
  Redundant. Known residue: the close-group confirm dialogs at
  `PlacementDetail.tsx:370` and `TourDetail.tsx:451` read this route alone and
  may show a stale name. Accepted.
- **Group push titles** (`twilio.ts` `groupThreadLabel` / `relayThreadLabel`
  calls). They are computed on the webhook ack path with no contact in hand;
  hydrating them adds an awaited read there. Accepted stale.
- **`GET /group-members`** (`routes/api.ts:2020`). Already resolves by phone
  and writes back (`:2102`). Left exactly as is.
- **Bare-phone relay members** (`relayGroups.ts:483`). No contact to resolve.
  They keep their stored name, else the client shows the number.
- **`groupSend.ts:253` refusal strings, `relayGroupDuplicates.ts:68`,
  `poolNumbersAdmin.ts` admin label.** Staff-only strings on non-hot paths.
  Filed as one issue, not fixed.
- **Client code.** Nothing changes. Every dashboard reader consumes
  server-computed values or a hydrated passthrough. One exception, S1 below.
- **`participants[].contactId` ownership** (M8), `lib/unreadFeed.ts` and the
  Unknown-tab walk (M6), `jobs/tourReminders.ts` (verified: reads no name).
- **The existing writers** of both fields all stay. They only make the
  snapshot fresher.

## 4. Mechanism

New module `app/src/lib/participantNames.ts`:

```
collectRosterContactIds(convs): string[]
withLiveNames(participants, resolved: ReadonlyMap<string, ContactDisplayItem>): ConversationParticipant[]
hydrateConversationRosters(convs, contacts: Pick<ContactsRepo,'getDisplaysByIds'>, log): Promise<T[]>
```

`withLiveNames` per member: if `contactId` is non-empty and the map holds a
non-deleted contact with a non-empty `contactDisplayName`, use it; otherwise
keep `p.name`. `phone` untouched, input not mutated. A bare-phone member is
returned as-is.

`hydrateConversationRosters` never rejects. `getDisplaysByIds` returns a SHORT
map on throttle (`contactsRepo.ts:597`, projection at `:856` includes
`deleted_at`); unresolved members keep their stored names. `requireComplete` is
not used anywhere - every consumer here is a label.

`contactDisplayName` (`lib/contactName.ts:67`) is widened to accept
`ContactDisplayItem`; its "push-copy sites only / do not re-point" docblock is
rewritten to describe the new contract. No other private name helper is
re-pointed - `routes/inbox.ts` and `routes/today.ts` keep their own, which
differ from the canonical one (an extra `contact.name` rung; outer-vs-part
trimming).

Known limit: the chain cannot tell "read failed" from "contact has no name",
so a deliberately cleared name keeps showing the stored one. Stated, not fixed.

## 5. Slices

**S1 Today.** `whoOfConversation(conv, contact)`:
`nameFromContact(contact) ?? non-empty participant_display_name ??
formatPhoneForDisplay(participant_phone) ?? ''`. Uses the file's own
`nameFromContact` (`:222`) so Unreplied and Follow-ups share one rule. The
contact comes from `getContact` (`:357`), already populated at `:743`. Pin the
`getById` call count unchanged. Client: `buildToday.ts:106` (the offline
fallback) gets a non-empty guard on its bare `??`; nothing else.

**S2 Rosters.** Collect ids -> one batch -> `withLiveNames` -> existing label
functions unchanged. `groupRowFor` takes the map as a second argument.
`relayGroups.ts:469-505`: replace the `Promise.all` of `getById` with the batch
and delete the `delete memberWithoutStoredName.name` line; rewrite its comment
to state the three-rung chain. `contacts.ts`: filter to this contact's groups
first, then collect ids.

**S3 People card.** `rosterResolution.ts:564`: contact name first, stored
name second. The `removed` guard at `:541` is untouched. This changes the
RECIPIENT names in `rosterEdits.ts` previews (`buildOpenPreview :545`,
`buildAddPreview :719`, which take a full `RosterOwner`); update those pins'
recipient expectations only, never the body strings phase-b landed. Amend
`rosterEdits.ts:425-441`, which says recipients carry "backfilled" names.

**S4 Push and voice.** `pushSenderLabel` (`twilio.ts:307`): contact first,
roster name second; rewrite the docblock at `:301-306`. `maskedPartyLabel`
(`voice.ts:116`): `contactShortName(contact)` first, then the stored name put
through the same "First L." transform, then the existing role / "the other
party" rungs; rewrite the docblock at `:109-115`. The output is persisted as
`call_party_label` AND spoken to the callee as the whisper's caller name
(`:1044`), so it must never be an unmasked full name; the whisper therefore
says "Bob B." where it used to say "Bob Builder". Pin both.

**S5 Audit.** `measure-unread-contact-coverage.ts`: the `--audit-denorm` walk
skips groups at `:510` and reads `status:'open'` only, which never returns a
`group_text` (status `group_open`) or a closed relay. Add a group pass sourced
from `listGroupTexts` + `listRelayGroups('open'|'connecting'|'closed')`
reporting counts only: rosters, members with a contactId, stored name missing
while the contact has one, stored name differs, dangling contactId, no
contactId, soft-deleted contact (skipped), and the requested-vs-returned id
delta (a short map on throttle must not read as dangling ids). Run ONCE at
handback against a seeded lane and record the numbers: this branch changes no
stored data, so the audit sizes the stale population the read path now masks -
there is no before/after.

## 6. Tests

TDD, red before green.

- `participantNames.test.ts`: live wins; stored on map miss; stored on empty
  live name; deleted contact ignored; bare-phone untouched; phone untouched;
  input not mutated; partial map leaves the rest on stored names.
- Today: renamed contact renders new name; unreadable contact renders stored;
  unlinked renders phone; `getById` count unchanged.
- Inbox, contact cards, relay members, calls passthrough: renamed contact
  renders; assert UNIQUE ID count passed to `getDisplaysByIds`, not call count.
- `describeRoster`: contact beats stale stored name; `removed_contact` keeps
  stored. Preview pins: recipient names updated, body strings byte-identical
  to `main`.
- `pushSenderLabel` / `maskedPartyLabel`: contact first; masked label never a
  full name; persisted `call_party_label` pinned.
- Audit: group pass counts a seeded stale roster from both sources.
- Fixtures: `seed/performance.ts:842`, `:857-858`, `:890` bake synthetic
  names against real contacts; update assertions that depend on them (find
  them by grepping the strings - if none, say so).
- E2E: rename a contact on a relay group and an unread 1:1; assert Today's
  row, the group thread header after reload, and the contact page's group
  card all show the new name. Accessibility-first selectors.

## 7. Issues

Close `today-shows-phone-instead-of-name`,
`group-roster-name-snapshot-never-refreshed` (stamp names the push-title and
close-dialog residue), `relay-stale-participant-phone` (documented
remove-and-re-add). Update `consolidate-contact-display-name-helpers` with the
corrected census (13 copies, not 6; `inbox.ts` has an extra rung;
`voiceMasking.ts` is a different rule) and leave it open. For
`today-contact-hydration-fan-out`, record the distinct-`getById` count from the
S1 test and close wontfix if small. File one issue for the staff-only stale
readers listed in section 3. Run `npm run issues`.

Note for M3: no phone source changed; roster sends address
`participants[].phone`.

## 8. Gates

`npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`,
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` -
all bare, from the worktree. Sync `main` once more before handback if it has
moved.
