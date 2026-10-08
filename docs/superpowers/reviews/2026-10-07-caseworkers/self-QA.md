# Parent live self-QA - Caseworkers branch B

Date: 2026-10-08. Driver: parent GPT-6, personally operated Playwright and viewed
the screenshots. Implementation e0da8da3; live appCommit31ed2fee (records-only
changes after implementation). Performed after the final full browser gate drained.
No other suite or interactive lane ran concurrently in this worktree.

## Harness and scope

The parent started npm run e2e:session in W:/tmp/caseworkers, read its readiness
record and checked /__dev/ping through http://127.0.0.1:10311. Ping confirmed
dev:true, lane13, tablePrefix hc-local-13-, appCommit31ed2fee and the configured
fake Twilio endpoint. The fake provider was http://127.0.0.1:10321; the property
link origin was http://127.0.0.1:10331. The human's ports5174/8080 were never used.
Signed in through Continue as dev user (va@example.com), then the documented
founder@example.com admin fixture for Settings. No real message was sent.

All changed contacts, organization entries and the sent property were run-unique,
stamp7049314. Seeded Tasha and Marcus were preview/Cancel only. The fresh property
used the fixture landlord, as the approved harness does; no seed classification
or dismissal was changed. The share recipient was a separate fresh partner with
consent and no conversation pre-opened before the send.

## Personally observed behavior

- New contact: all six KindPicker choices rendered. Selected Caseworker, entered
  a long name, and created through the UI. API read confirmed type partner and
  exact role Caseworker, with no organization. The create form had no Organization
  input. Added an agency fixture, reopened the editor and selected it through the
  Organization picker; the stored name matched exactly.
- Existing tenant edit: five choices, with Other spanning both columns at phone
  width. Cancel left the contact unchanged.
- Tenant conversion: created an own tenant with authority, long agency name,
  Staff notes and a tenant_1to1 conversation. Ordinary detail mount issued zero
  preview/Possible reads. Opening the dialog issued the preview (development
  StrictMode produced one aborted request and one200). The dialog named both
  removals, one conversation and the carried agency. Confirm sent exactly
  {"action":"make"} (MCP network request2024); untouched organization was omitted.
  Result: partner/Caseworker, authority absent, agency empty, organization carried
  exactly, Staff notes unchanged, conversation partner_1to1.
- Unknown conversion: used Mark as Caseworker on an own unknown, confirmed and
  read back partner. The aggregate browser suite separately proves inbound
  capture and AI suggestion acceptance.
- Refusals: Tasha's open placement and Marcus's two properties rendered linked
  reasons, and Make caseworker was disabled. Canceled both dialogs.
- Caseworkers list: the converted contact and long-name new contact appeared
  with their organization. Clicking its chip produced the normalized org query
  parameter. Own role-empty partner appeared in Possible; Cancel preserved it,
  and Hide removed only that own row. Seeded Renee remained visible.
- Settings: three list segments remained. Opening an off-list organization value
  focused its heading. It offered no Move/Split. Add as new was disabled with
  neither Kind selected and enabled only after choosing Housing authority; the
  resulting entry had that kind. Use normalized two own values to an agency and
  a housing authority. Waited for the asynchronous rewrites before final reads;
  both exact canonical stored names were confirmed.
- Usage: agency organization3/inUse.active3/kindLocked.active0; new authority
  organization1/inUse.active1/kindLocked.active0. Change kind remained available.
  Delete opened a dialog explaining one organization use; its destructive
  confirmation was disabled. Canceled. At375px the selected panel alone showed;
  Back to Housing authorities returned to the list.
- Partner share: from a fresh consented partner's Properties sent card, Send
  opened a seeded composer; selected a fresh Available property. Review recipients
  showed one checked named recipient and neutral copy. Sent through the UI.
  Fake /control/threads confirmed exactly one outbound containing the property
  link. Only afterward resolved the conversation: partner_1to1. Results were
  status sent, audience1, delivered1, failed0, unconfirmed0, queued0, retry_pending0.
  The partner's Properties sent card listed the property; its Sent to card labelled
  the recipient Caseworker.

## Measurements and screenshots viewed

Desktop1280x900; phone375x812. Document scrollWidth equalled375 on every measured
phone state. These are real DOM boxes, not appearance-only assertions.

| State | Measurement |
| --- | --- |
| Create picker | Six buttons in two columns; each153px wide; rightmost341px; every button scrollWidth equals clientWidth. Desktop dialog480px wide. |
| Existing edit picker | Four buttons145.5px wide in two columns; final Other292px across both; rightmost326px. |
| Conversion dialog | x16,width343,height455.5; long organization wraps within its chip. |
| Settings panel | x25,width310; list hidden on phone; internal vertical scrolling reaches Kind and confirmation. |
| Share review | document/client width375; named recipient and Send control fit. |
| Caseworkers list | main scrollWidth360; long-name row x24,width312; organization chip rightmost336px, scrollWidth equals clientWidth. Name truncation remains readable through the linked detail; organization wraps. |

Personally viewed files, copied into this worktree's ignored .playwright-mcp/:
caseworkers-selfqa-create-375.png,
caseworkers-selfqa-edit-375.png,
caseworkers-selfqa-convert-ready-375.png,
caseworkers-selfqa-list-desktop.png,
caseworkers-selfqa-settings-add-375.png,
caseworkers-selfqa-settings-kind-375.png,
caseworkers-selfqa-share-375.png,
caseworkers-selfqa-sent-to-desktop.png,
caseworkers-selfqa-list-375.png.

The MCP filesystem permits screenshots under the shared checkout's
W:/AI Projects/Housing Choice/HC Application/.playwright-mcp/ only, so they were
initially written there. The attempted worktree screenshot path was rejected
before writing; the allowed artifact directory was used and owned files copied
to W:/tmp/caseworkers/.playwright-mcp/. No browser process was killed or replaced.

## Network boundary, observations and limits

The recorded ordinary contact mount had no /caseworker-review/preview or
/contacts/possible-caseworkers request. Preview began only with an open dialog;
Possible reads were observed on the Caseworkers page. The partner detail used the
existing contact, suggestions, user, timeline, placements, units, listings-sent,
relay/group, contact-index, media, unread and event slices; it introduced neither
preview nor Possible fetching. Unique paths are in SELFQA-evidence.json.
Automated profiler/mutation pins and detail tests passed in the full gates; those
pins, together with observed request paths, support the no-new-detail-GET claim.

The synchronous busy/race cases remain covered by the committed focused tests and
full gates; no artificially held network response was used during this walkthrough.
This manual pass does not claim to reproduce every concurrency interleaving.

There were two expected initial unauthenticated /auth/me401 probes and one
post-send DELETE409. The latter was the unchanged best-effort pristine-draft
cleanup in useComposerDraft.ts:137-147; the server refuses deletion once sent.
The send remained delivered and no sent record was deleted. No source fix follows.

QA operation corrections: an organization created via API after its editor had
already loaded required reopening that editor; the chip selector includes its
count, so the exact-name selector was corrected; a non-empty-role partner is not
the role_mentions candidate type (that signal applies to tenants/landlords), so
the dismissal fixture used the explicit partner_no_role case. A diagnostic GET
to a nonexistent broadcast detail URL returned HTML; the documented /results
endpoint then confirmed sent/delivered. These are disclosed harness/selector
corrections, not product failures or silently accepted assertions.

The full-gate blank-document failure remains unexplained and filed separately;
this live pass does not close it. The baseline C6 picker proposal remains unapplied.

## Evidence and teardown

Raw measurements, fixture identities and request paths:
.superpowers/sdd/SELFQA-evidence.json.
Session output: .superpowers/sdd/SELFQA-session.log.
No source files changed during QA.

npm run e2e:stop returned EXIT0, stopped owned launcher49740 and children,
dropped only lane13 fixture tables and released its lease. The deliberately
stopped long-lived launcher session returned EXIT1; it is not a test-gate result.
Parent confirmed no listeners on10301/10311/10321/10331 and drained the command.
Shared DynamoDB/MinIO containers and all other worktrees were left running.
