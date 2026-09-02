# Live self-QA - participant names resolve on read (2026-09-01)

Driven by the build orchestrator on the hermetic e2e session, lane 12
(app :10201, dashboard :10211, fake-twilio :10221), reseeded with the FULL
profile (`POST /__dev/reseed?profile=full`). Founder dev-login. No live/dev
environment touched. Screenshots and page snapshots are run state under
`.playwright-mcp/` (gitignored): selfqa-today-before.png,
selfqa-group-header-after.png, selfqa-owner-card-after.png,
selfqa-today-after.png, selfqa-inbox-after.png.

## The walk

One rename, five surfaces, one measurement. Renamed tenant
`tenant-mx-searching-standalone-01` via the contact page's Edit form:
"Terrence Grant" -> "Terry Grant-Renamed" (both name parts changed on
purpose - first-token labels and full-name labels both had to move).

| surface (slice) | before | after the rename (observed live) |
|---|---|---|
| Today close-nag memberNames (T2) | "Relay group for Terrence Grant & Marcus Bell is still open - close it?" | "Terry Grant-Renamed" renders in the nag line on `/` |
| Relay thread header facts line (T5 via /members) | "With Terrence Grant & Marcus Bell" | "With Terry Grant-Renamed & Marcus Bell" on a fresh load of /conversations/conv-mx-relay-01 |
| Relay members panel (T5) | stored snapshot | "Terry Grant-Renamed" linked to the contact, beside the STORED phone (555) 020-0205; reply-to line reads "(Terry Grant-Renamed, Marcus Bell)" |
| Other member's contact file card (T4) | "With Terrence Grant" | "With Terry Grant-Renamed" on /contacts/contact-landlord-0001's Relay groups card |
| Inbox relay row title (T3) | stored snapshot | "With Terry Grant-Renamed" on /inbox |

`participants[].phone` untouched throughout - the members panel and reply-to
line kept the stored numbers, which is the M3 boundary this branch promises
not to cross.

## The measurement (T8 audit, both runs recorded)

Invocation (from the worktree root; the lane KEY selects the DynamoDB Local
database - the default key would read an empty store and print plausible
zeros):

    DYNAMODB_ENDPOINT=http://localhost:8000 TABLE_PREFIX=hc-local-12-
    AWS_ACCESS_KEY_ID=hclane12 AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1
    npx tsx app/scripts/measure-unread-contact-coverage.ts --audit-denorm --confirm

Run 1 - fresh full-profile lane (exit 0):

    rosters walked 10, members 22, with contactId 22
    name MISSING known 0 / name DIFFERS 0 / name only STORED 0
    soft-deleted 0 / dangling 0 / no contactId 0
    ids requested 12, returned 12, NOT RETURNED 0

  1:1 block: 11 open threads, contact resolved 11, display-name drifted 0,
  missing-but-known 1 (that one thread now renders its contact's name via
  whoOfConversation - the read path masking exactly this population).

Run 2 - after the UI rename (exit 0):

    name DIFFERS 0 -> 2   (the renamed contact's stored name on
                           conv-mx-relay-01 and conv-mx-relay-02)
    every other counter unchanged; NOT RETURNED 0

The delta is the point: the audit SEES real drift the moment it exists, and
every surface above rendered the live name over that drifted snapshot at the
same instant. A fresh seed shows zero drift because writers copy the contact
name at creation - drift is created by renames afterward, which is what the
founder reported and what run 2 reproduces.

Note for interpreting future runs: a fresh lane's zero-drift baseline means
the earlier expectation of built-in synthetic-name drift applies to the PERF
world (`lib/seed/performance.ts`), not the `full` dev profile.

## Not walked live, and why

- The spoken whisper and persisted call_party_label (T7): needs a real voice
  leg; pinned by unit tests (voiceWebhook) including the deleted-contact and
  masked-stored-name cases. The audible change (whisper says "Bob B." where
  it used to say the stored full name) is flagged in the handback.
- Push notification body prefix (T7): no push subscriber in the lane browser;
  pinned by inboundMessagePush tests on both group and relay arms.
- Deleted-contact fallbacks: unit-pinned (wave 1); not manufactured live.
- The e2e scenario (T9) covers the rename flow end-to-end in the same harness
  and runs in the gate battery.

Verdict: every founder-reported symptom is closed on live data; the read
budget held (no per-member reads observed in server logs during the walk);
no surface showed the old name after its own reload.
