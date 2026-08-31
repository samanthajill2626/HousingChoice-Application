# Task 7 cold review - Partner / Property Manager hermetic E2E

## Verdict

NOT PASS. One must-fix documentation finding remains. The E2E proof itself conforms to Task 7 based on static inspection plus the recorded focused-run artifact; no test or server command was run during this review.

## Findings

### Important / must-fix - the resolved issue still states the pre-fix limitations and decision as current

Evidence:

- `docs/issues/caseworker-contact-type.md:6-10` marks the issue resolved on 2026-08-26, and `:87-94` records the forward-only resolution.
- The same document then says, in present tense, that extraction "still cannot reach `partner`" (`:23-31`), that the prompt forbids it, the schema exposes only Tenant/Landlord, the adapter accepts only those two values, and the Unknown card has only two actions (`:33-44`). Those statements are false in the current tree: `buildExtractionSystemPrompt` defines Partner and Property Manager at `app/src/services/extraction/prompt.ts:66-91`; the schema enum is the five-value enum at `app/src/services/extraction/schema.ts:132-138`; `SuggestedContactKind` is the four-value union at `app/src/adapters/extraction.ts:73-82`; and `UnknownFile` renders all four actions at `dashboard/src/routes/contact/UnknownFile.tsx:86-130`.
- `docs/issues/caseworker-contact-type.md:58-70` still presents the now-shipped work as a future "Suggested fix", while `:72-80` says there is a "remaining decision" and explicitly explains "why this is still `type: decision`". That contradicts the resolved frontmatter and makes the issue read as simultaneously open and closed.
- The frontmatter refs at `docs/issues/caseworker-contact-type.md:11` also retain old line anchors: for example, `prompt.ts:65` is now the status-advance instruction and `schema.ts:124` no longer identifies the type enum. Task 7 explicitly required stale references to move when new symbols made the old references misleading (`task-7-brief.md:141`).

Safe, history-preserving revision:

1. Keep the 2026-08-18 analysis and related issue links, but label it explicitly as a historical pre-resolution snapshot. A concise dated notice immediately after the existing REFRESHED paragraph should say that the body through the related-links paragraph describes the 2026-08-18 state and that current behavior is in Resolution.
2. Rename the misleading labels without deleting history: `Problem` -> `Historical problem as of 2026-08-18`; `Four places pin it shut` -> `Four places pinned it shut then`; `NOT blocked` -> `What was not blocked then`; `Suggested fix` -> `Suggested fix at the time`; `The remaining decision` -> `Decision that remained at the time and was resolved on 2026-08-26`. Convert the nearby present-tense framing to past tense where needed.
3. Replace stale line-number refs with current relevant anchors or stable symbol names. Current anchors are prompt `:66`, schema `:132`, adapter `:73`, and UnknownFile `:86`; stable symbols (`buildExtractionSystemPrompt`, `EXTRACTION_SCHEMA.properties.typeSuggestion`, `SuggestedContactKind`, `UnknownFile`) preserve history better than assertions about today's exact line contents.

This is not a request to rewrite or erase the issue history. It is the minimum change needed to stop a resolved issue from asserting obsolete behavior as current.

## Mandatory attack results that held

- **Hermetic real flow:** The tests use `sendExtractSms` to post a real signed inbound SMS and `extractionTick` to drive the hermetic-only synchronous job seam (`e2e/fixtures/extraction.ts:4-61`), then exercise the real ContactDetail UI and authenticated contact/conversation APIs (`conversation-fact-extraction.spec.ts:322-356,366-401`). The recorded command is the e2e-workspace command, not root Playwright, and the report records hermetic lane 2. Config resolves a positive lane and assigns `E2E_DASHBOARD_URL` before test import (`e2e/playwright.config.ts:53-90`), so the file's lane-0 fallback was not used by the recorded run.
- **Partner shape:** The flow proves exact suggestion label, all four accessible action names, the real `Mark as Partner` action, `type=partner`, `status=active`, absent role, the requested note, `partner_1to1`, and phone-specific Today cleanup (`conversation-fact-extraction.spec.ts:315-356`).
- **Property Manager shape:** The flow proves exact spaced suggestion label, the real `Mark as Property Manager` action, `type=landlord`, exact role `Property Manager`, `status=interested`, the requested note, `landlord_1to1`, and phone-specific Today cleanup (`conversation-fact-extraction.spec.ts:359-401`). The conversation assertion cannot silently manufacture a corrected replacement thread: `createOrGetByParticipantPhone` returns the existing open phone conversation unchanged (`app/src/repos/conversationsRepo.ts:1220-1232`), so the asserted type reflects the triage propagation.
- **Accessibility and determinism:** UI interactions use heading/text/role/name locators; the Needs-triage CSS section locator is scoped by its accessible heading rather than a test id. Today navigation uses shared exact-heading readiness (`e2e/support/today.ts:43-46`) and then checks only the fresh contact's formatted phone, so unrelated queue items cannot satisfy or fail the cleanup assertion. The file runs with one worker and uses a fresh phone per scenario; retry-on-failed-classification remains component-test scope from Task 5 and is not weakened by this Task 7 diff.
- **Recorded acceptance evidence:** `task-7-report.md:17-24` records exit 0, `12 passed (31.2s)`, and structured counts `expected=12`, `unexpected=0`, `flaky=0`, `skipped=0`. Static reading of the retained `e2e/.artifacts/results.json` agrees and marks both new specs `ok=true`. This review did not rerun it, per the exhausted recovery budget.
- **Issue mechanics:** Frontmatter status/dates and the no-backfill Resolution language are correct (`caseworker-contact-type.md:6-10,87-94`). Commit `94caf95c` contains only the E2E spec and issue file; `docs/issues/INDEX.md` is not tracked or in the commit. `task-7-report.md:53-56` records `npm run issues` exit 0 and the resolved index entry, with the unrelated pre-existing severity warning disclosed.

