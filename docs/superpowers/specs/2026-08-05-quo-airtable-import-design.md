# Quo + Airtable import (M1.6) - design

- Date: 2026-08-05
- Status: BUILT (2026-08-05/06). Both commands implemented, 77 import tests,
  full gates green, exercised end-to-end against the real export.
- Milestone: M1.6 "Data import" (PHASE1_KICKOFF_PROMPT.md)
- Hard deadline: **go-live 2026-08-10** - number port + cutover

## 1. Why

The founder (Sam) runs the business today across two systems:

- **Quo** - a shared-inbox SMS/voice tool on ONE number, `+16782842537`. This is
  the real operational corpus: every tenant, landlord and caseworker conversation.
- **Airtable** - a thin structured layer: a landlord list, a properties table, a
  tenants table, a tours table. Mostly empty, partly demo data.

On 2026-08-10 `+16782842537` ports to Twilio and this application becomes the
system of record. Both source systems get switched off. This document specifies
how their data gets in.

## 2. What is actually in the exports

Measured, not estimated (profiling scripts, 2026-08-05).

### 2.1 Quo (3 export jobs, 1 org, 1 user, 1 number)

| File | Rows | Notes |
| --- | --- | --- |
| `*_users.csv` | 1 | Sam, `samjjames26@gmail.com`, role owner |
| `*_phone_numbers.csv` | 1 | `+16782842537` |
| `*_contacts.csv` | 828 | -> **543 distinct phones** |
| `*_messages.csv` | 17,854 | 707 conversations, 2026-03-05 -> 2026-08-03 |
| `*_calls.csv` | 1,571 | 846 in / 725 out, 179 zero-duration |

Columns: contacts `id,userId,firstName,lastName,company,sharedWith,phone_number_1,email_1`;
messages `id,conversationId,body,sentAt,to,from,direction,createdAt`;
calls `id,conversationId,duration,to,from,direction,createdAt`.

### 2.2 Airtable

| Table | Rows | Usable? |
| --- | --- | --- |
| Landlord | 40 | -> 18 distinct phones. Has a `Quo Id` join column. |
| Properties | 10 | **26 of 38 columns are 100% empty.** |
| Tenants | 17 | Sparse but the richest structured data in either system. |
| Tours | 13 | **10 are seeded demo rows** (`+1404555xxxx`, all created 1/17/2026). Not imported. |

### 2.3 The founder's conventions are the schema

Sam encodes her data model in contact names. This is the single most valuable
finding in the exports:

- **`-Nbed` suffix = voucher bedroom size.** Present on 724 of 828 rows (88%).
  Distribution 1bed=147, 2bed=214, 3bed=232, 4bed=110, 5bed=21. Variants seen:
  `-3bed`, `- 2 Bed`, `-3 Bed`.
- **Handshake emoji prefix = landlord.** 19 in Quo, 13 in the Airtable landlord
  table. Corroborated independently across both systems.
- **`*` suffix** - 18 contacts. **Meaning unknown - founder question.**
- **`company` is not a company.** It holds a near-duplicate of the display name
  (`L'Oreal Cleveland-4bed`). Used only as a name fallback; never imported as an
  employer.

After merging on phone AND folding in the orphan numbers and Airtable rows, the
importer produces **629 people** (verified by running it):

| Class | Count |
| --- | --- |
| Tenant (`-Nbed`) | 478 |
| Unknown / unclassified | 110 |
| Landlord (handshake) | 22 |
| Partner (caseworker) | 19 |

629 = 542 distinct Quo phones + 86 numbers with traffic she never saved + 1
Airtable-only person. 264 duplicate Quo rows collapse away.

**12** phones carry conflicting bed sizes. An earlier hand-profile of the raw
export found only 4 because it read just the name fields; reading `company` too
(where Quo mirrors a near-duplicate name) surfaced 8 more. All 12 verified
genuine - no false positives.

### 2.4 Multi-party threads

123 of 707 conversations have 2-4 outside participants. **89 contain both a
handshake-landlord and a `-Nbed` tenant** - Sam running relay groups by hand.

| Set | Groups | Pool numbers if pre-connected |
| --- | --- | --- |
| All | 123 | 44 |
| Active <= 30d | 65 | 22 |
| Active <= 14d | 38 | 10 |

These are *carrier group MMS* today (inbound multi-`to` lists include Sam's own
number). **Twilio does not do carrier group messaging.** Post-port, a group text
must go through a `relay_group` fronted by a pool number, and members will see a
new number. This is a founder-visible behaviour change, not an implementation
detail.

### 2.5 What does not survive the export

- **All MMS media.** No media/URL column exists. 694 empty-body messages are
  almost certainly photo sends whose images are gone.
- **Call recordings and transcripts.** Only id/duration/to/from/direction.
- **Airtable Tours** - nothing real to import.
- **26 empty Properties columns** - the schema exists, the data never did.

### 2.6 Loose ends in the data

- **86 phone numbers have traffic but no contact row.** Real people Sam never
  saved. (A first hand-profile said 80; it under-counted because it took only one
  counterparty per message and so missed members of group threads.)
- **19 contacts have a phone but no traffic at all.**
- **2 malformed phones**: `+140428542854` (11 digits), `+7143055014` (non-US).
- **1 inbound STOP** across the whole corpus - must be honoured on import.
- Only **1 email address** in 828 contacts. Email is not a meaningful import channel.
- 2 contacts carry Sam's own number as their phone (self-contacts) - dropped.
- **3 rows cannot be imported at all** and the totals say so out loud: 2 messages
  Sam addressed to her own number, and 1 call from a withheld caller ID
  (`Anonymous` in the `from` column - this will recur in production). Import
  totals are short by exactly this much, and both CLIs print the reconciliation
  rather than leaving a short count looking like data loss.

### 2.7 Source-data defects found by building against the real files

These are properties of Quo's export, not of our code. They will be present again
in the 8/09 export, so they are recorded here rather than only in commit messages.

- **Lone CR characters inside message bodies.** The messages export is
  LF-terminated (22,035 LF, 155 CRLF) yet contains **18 bare CR** characters
  sitting inside unquoted bodies - trailing whitespace in what a tenant typed.
  A parser that treats a lone CR as a record terminator (the classic pre-OSX Mac
  reading) splits those records in half: 15 real messages were lost and each tail
  manufactured a phantom contact. `csv.ts` treats a lone CR as content. Quote
  balance was independently verified across the whole file - there is no
  desynchronization, so this was the only structural defect.
- **`company` mirrors the display name.** It is not an employer field. Reading it
  as a name variant is what raises voucher-size conflict detection from 4 to 12.
- **Junk in the Airtable `Quo Id` column** - two rows contain the literal string
  `Claratel`. Shape-checked (24-hex) before joining.
- **Withheld caller ID** arrives as the literal `Anonymous` in a call's `from`
  column, not as an empty value or a number.
- **Airtable column names carry trailing spaces and the founder's spelling**
  (`tenant type `, `caseworker organization `, `Eviction History `, and the value
  `Casewoker`). Matched verbatim; tidying them silently returns empty.

## 3. Design

### 3.1 Two commands, a human in the middle

```
Quo + Airtable exports
        |
        v
  npm run import:plan  ---------> review workbook (3 CSVs)
        ^                                |
        |                                v
   prior reviewed workbook        founder edits it
   (carry-forward)                       |
        |                                v
        +------------------------- reviewed workbook
                                         |
                                         v
                              npm run import:apply --> DynamoDB
```

`import:plan` reads the exports, performs every merge / parse / classification /
derivation, and emits a **review workbook**. It writes nothing to a database.

`import:apply` reads the reviewed workbook **plus** the raw exports and writes to
DynamoDB. Division of authority is absolute:

- **The workbook is authoritative** for every human-judgment field: name, type,
  status, voucher size, whether to import at all, which groups get connected.
- **The raw export is authoritative** for everything mechanical: message bodies,
  timestamps, directions, call durations, conversation membership.

This is why the founder never has to review 17,854 messages - she reviews ~150
decisions and the machine does the rest.

### 3.2 Idempotency: re-running IS the delta

Every source record has a stable external id (`ObjectId` for contacts, `CN...`
for conversations, `AC...` for messages and calls). Every write is an upsert on a
key **derived** from that id, so re-running the importer against the cutover
export converges to the same state. No watermark, no delta computation, no
duplicate detection, and no requirement to wipe the database first.

That last point matters operationally: a wipe means nobody may touch prod before
8/10 and a bug found *after* cutover cannot be fixed by re-running, because by
then real inbound traffic is landing in the same tables.

| Entity | Deterministic key | Rationale |
| --- | --- | --- |
| Contact | `uuidv5(E.164 phone, NS)` | Our `byPhone` GSI is one contact per number; 828 rows -> 543 people |
| Conversation (1:1) | `uuidv5('1to1:' + phone, NS)` | Our model has one 1:1 thread per phone (`byParticipantPhone`) |
| Conversation (group) | `uuidv5('group:' + sorted participants, NS)` | 133 phones appear in >1 Quo conversation; they fold into one |
| Message | `tsMsgId = <ISO ts>#<quo msg id>` | Quo id verbatim -> free dedupe |
| Call | `tsMsgId = <ISO ts>#<quo call id>` | same |
| Unit | `uuidv5('unit:' + normalized address, NS)` | Address is the only stable identity available |

Contacts and conversations cannot key on the Quo id because our schema forces the
merges. Messages and calls keep the Quo id verbatim, so those merges cost no
dedupe safety.

**Verification, not trust:** that Quo emits the same record ids on a second export
is an assumption. It is proven by re-exporting contacts this week and diffing ids
against the 2026-08-05 file. If ids turn out to be per-export, the fallback is a
content hash (`conversationId + createdAt + direction + body`) - one function,
not a redesign.

### 3.3 The review workbook

Three CSVs. No new dependency; opens in Excel, Google Sheets or Numbers.

**Excel corrupts phone numbers.** `+16782842537` in a CSV cell is read as a
formula and handed back as `16782842537`, silently destroying the join key. So:

- The join column is an **opaque `row_key`** (`HC-0001`, `GRP-0007`, `UNIT-0003`).
- `phone` is a **display column we never join on**.
- If the phone returned for a row_key disagrees with the one we issued, that is a
  flagged conflict for a human - never a silent trust of either value.

Rows are sorted so everything needing judgment is at the top, with a
`needs_your_input` column. Editable columns arrive pre-filled with our suggestion;
a read-only `why` column explains each one.

**`contacts.csv`** (543 rows)

| Column | Editable | Meaning |
| --- | --- | --- |
| `row_key` | no | Join key. Never edit. |
| `needs_your_input` | no | `YES` sorts to the top |
| `why` | no | Why we flagged it |
| `phone` | no | Display only |
| `name` | **yes** | Cleaned name, bed suffix and markers stripped |
| `type` | **yes** | `tenant` / `landlord` / `partner` / `unknown` |
| `voucher_beds` | **yes** | Parsed from the name |
| `status` | **yes** | Derived (3.4) |
| `drop` | **yes** | `Y` excludes the row entirely |
| `notes` | **yes** | Free text -> contact notes |
| `quo_names_seen` | no | Every raw name variant, pipe-joined |
| `last_contact`, `msg_count`, `call_count` | no | Evidence |

**`groups.csv`** (123 rows) - participants, message count, last activity,
composition, and one editable column: `connect_day_one` (`Y`/`N`, default `N`).

**`units.csv`** - the 10 Airtable properties plus addresses mined from the message
corpus, with a `source` column (`airtable` / `found-in-texts`) and a `send_count`.

**Carry-forward.** `import:plan --prior <reviewed.csv>` merges a previously
reviewed workbook, marking every row `unchanged` / `new` / `conflict`. Between
2026-08-05 and cutover this is expected to be 20-40 genuinely new people, so the
founder reviews a diff and not the corpus. This is what lets her review start
*before* the final export exists - the only way the work fits in five days.

### 3.4 Derived tenant status

Status is derived from last message activity and stamped
`status_source: 'import'`.

| Condition | Status |
| --- | --- |
| Last contact <= 30 days | `searching` |
| Last contact > 30 days | `on_hold` |
| No traffic at all | `needs_review` |

**The 30-day threshold is a placeholder and must be the founder's number.** It is
a single constant, changed and re-planned in seconds. Landlords default to
`active` (a handshake in her book means she is working with them); unclassified
contacts and the 80 orphans default to `unknown` / `needs_review`.

**Re-runs never revert a human.** On a second apply, the status is only rewritten
when the stored `status_source` is `import` — i.e. when WE wrote the value that is
there. Any other provenance (or none) means someone has since decided, and the
import defers.

This deliberately does NOT consult `SOURCE_PRECEDENCE`. An earlier draft of this
spec claimed `import` outranks `derived` there and that the rank would protect
manual edits; that is wrong. In `lib/statusModel.ts` the rank is provenance/audit
metadata only — `derived` is 0 and *every* non-derived source (`import`,
`automation`, `ai`, `manual`) is an equal 1 — so a precedence comparison is never
true and would have silently preserved nothing. Real gating in this codebase is
state-based (`isTenantOverrideStatus`). Caught by the integration test that sets a
status to `placed`/`manual` and re-applies.

### 3.5 Caseworkers

`ContactType` has no `caseworker` member - this is the open decision issue
`docs/issues/caseworker-contact-type.md`. The import does not resolve it. The 16
detected caseworkers map to **`partner`** with a `[Import 2026-08-05] Identified
as a caseworker` note, and the workbook's `type` column lets the founder correct
any of them. When that issue is decided, a re-run reclassifies them.

### 3.6 Relay groups: import all, connect none

`createRelayGroup` accepts an **optional** pool number. Without one the group is
created in the `connecting` state - full history and roster, no
`pool_number`/`participant_phone`, in the `relay_group#connecting` GSI partition.
It costs no Twilio number and no A2P registration.

So all 123 groups import as `connecting`, and the founder connects the ones she
needs on demand. `connect_day_one = Y` in the workbook pre-connects a group at
apply time, which requires an available pool number; if none is available the
group stays `connecting` and apply reports it rather than failing.

### 3.7 Consent and suppression

543 numbers are being loaded into a system that sends SMS. Consent basis is the
existing two-way conversation - every imported contact with inbound traffic has
demonstrably texted Sam first. Imported contacts get `consent_method: 'import'`
(the existing `ConsentMethod` seam, cf. `app/scripts/backfillConsentMethod.ts`).

The single inbound STOP in the corpus sets `sms_opt_out` on that contact. Contacts
with **no inbound traffic** (19 with no traffic, plus any outbound-only) do not
get an implied-consent stamp and are flagged in the workbook.

### 3.8 PII handling

The workbook contains 543 real people's names and phone numbers. It **must never
be written inside the repository** - the remote is Azure DevOps and a commit would
publish it.

- Default output path is outside the repo, next to the exports.
- `import:plan` **refuses** to write to a path inside the repo working tree.
- A `.gitignore` entry is a second line of defence, not the primary one.
- No export data, workbook, or generated fixture derived from real contacts is
  committed. Tests use synthetic fixtures only.

## 4. Module layout

```
app/src/lib/import/
  csv.ts            RFC4180 parse + serialize (quotes, embedded newlines, BOM)
  ids.ts            deterministic id derivation (3.2)
  names.ts          bed size, handshake, star, name cleanup
  quoSource.ts      load + normalize the 3 Quo files
  airtableSource.ts load + normalize the 4 Airtable files
  merge.ts          828 rows -> 543 people; conflict detection
  addresses.ts      mine + normalize addresses from message bodies
  threads.ts        conversation shapes; 1:1 vs group; participant sets
  status.ts         derived status (3.4)
  workbook.ts       read/write the 3 CSVs; carry-forward + conflict marking
  plan.ts           orchestrates plan
  apply.ts          orchestrates apply (idempotent upserts)
app/scripts/
  import-plan.ts    CLI: npm run import:plan
  import-apply.ts   CLI: npm run import:apply
```

`csv.ts` is a local parser rather than a dependency: the format is small, and the
export quirks (BOM, embedded newlines in message bodies - 4,180 of them) are
already understood and directly testable.

## 5. Error handling

- **Refuse to guess identity.** Anything unclassifiable becomes `unknown` /
  `needs_review` and appears at the top of the workbook. The import never records
  a guess as fact - the same rule auto-capture already follows.
- **Malformed phones** (2 known) are reported, not silently dropped or repaired.
- **Bed-size conflicts** (4 known) are flagged for the founder, never auto-resolved.
- **Plan is pure.** It writes one directory of CSVs and touches nothing else, so
  it can be run freely.
- **Apply is transactional per entity, not globally.** A failure mid-run leaves a
  partial but *consistent* state, and re-running converges. This is a direct
  consequence of 3.2 and is the reason no wipe is needed.
- **Apply refuses to run** against a workbook whose `row_key` set does not match
  the exports it was generated from, or where a `row_key`'s phone disagrees with
  the export's — her decisions would attach to the wrong people.
- **`drop` retracts, it does not merely skip.** If an earlier run already imported
  someone the founder later drops, skipping the write would leave the row behind
  and "drop" would quietly do nothing. So apply removes the contact, the 1:1
  thread and its messages — but ONLY items carrying this import's `imported_from`
  stamp. A thread holding any message the import did not create is KEPT and
  reported. Dropping a spreadsheet row must never be able to destroy live
  conversation history. Group threads are never dismantled (their history belongs
  to the other members too).
- Every skipped or flagged row is counted and printed. Silent truncation is the
  one failure mode that would read as success.

## 6. Testing

- Unit tests per module against **synthetic fixtures** (no real PII), covering the
  observed quirks: embedded newlines, BOM, multi-`to` rows, `- 2 Bed` spacing
  variants, the handshake prefix, conflicting bed sizes, orphan numbers.
- Idempotency test: apply twice over the same fixture, assert identical item counts
  and no duplicate messages.
- Carry-forward test: plan, edit, re-plan with `--prior`, assert edits survive and
  new rows are marked `new`.
- End-to-end exercise against a **hermetic local lane** (the e2e pattern -
  DynamoDB Local, per-worktree lane). Never against the dev or prod stack.

## 7. Sequencing to 2026-08-10

| When | What |
| --- | --- |
| 8/05 (done) | Spec, `import:plan`, `import:apply`, 77 tests, workbook v1 generated from the real export; full import rehearsed twice against a scratch DB (19,422 message items, zero duplicates) |
| 8/06 | Founder call. Confirm conventions, get her the workbook. Second Quo export requested (id-stability check). |
| 8/07-8/08 | She reviews. We fix whatever the call changed. |
| 8/09 | Final export. `import:plan --prior` -> she reviews the diff only. Full rehearsal: apply to **dev**, review in the real dashboard. |
| 8/10 | Number ports. `import:apply` against prod. Re-runnable if anything is wrong. |

The rehearsal on 8/09 is not optional. It is what makes the 8/10 run the second
time we have done this rather than the first.

## 8. Out of scope

- MMS media and call recordings (not in the export - 2.5).
- Airtable Tours (demo data - 2.2).
- Tenant<->unit matching, placements, tours. No placement history exists in either
  source; placements begin accruing after cutover.
- Resolving `caseworker-contact-type` (3.5).
- The number port itself, and A2P registration.

## 9. Open questions for the founder

Tracked in `docs/superpowers/specs/2026-08-05-founder-call-questions.md`.
