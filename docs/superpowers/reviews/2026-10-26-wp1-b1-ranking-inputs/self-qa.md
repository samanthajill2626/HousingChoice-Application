# Live self-QA - WP1 B1 Ranking inputs (build orchestrator, 2026-10-27)

Hermetic `npm run e2e:session` on lane 3 (app :9301, dashboard :9311, fake
driver), driven with the project Playwright MCP (bundled Chromium 155) plus
a Node helper that posts a Twilio-signed inbound SMS (the
e2e/fixtures/fakeTwilio.ts postInboundSms mechanism) so the fake extraction
driver reads an `EXTRACT:` payload. Sessions: head fa9552d4 (checks 1-4), then
fdae5623 after the one fix (check 5 re-run). Every value below was MEASURED
in the browser (getBoundingClientRect / scrollWidth vs clientWidth /
computed style / request bodies), not eyeballed. Screenshots in the
worktree's gitignored `.playwright-mcp/b1-qa-*.png`.

## Found and fixed

- SQA-1 (LOW, B1 defect, FIXED fdae5623): the AI run detail's "Notes lines"
  region lists "Properties sent fingerprint: <64 hex>" - one unbroken token -
  and the region had no wrap rule, so in the narrow detail column the text
  spilled past its card and the column scrolled sideways: region
  scrollWidth - clientWidth = 197 / 177 / 220 / 113 px at 360 / 380 / 1024 /
  1280 px (0 at 600, where the column is wider). Unit tests run css:false,
  and five code-review rounds read this code without seeing it. Fix:
  `.countList { overflow-wrap: anywhere; }` (as `.detailHeader p` already
  has). Pins: a CSS source pin in AiRunsSection.test.tsx (RED before: no
  overflow-wrap) and an e2e geometry assertion in the run-detail case of
  conversation-fact-extraction.spec.ts (RED before: spill 110 px at the
  e2e viewport; GREEN after: 16/16). Re-measured after the fix: spill 0 at
  360, 380, 600, 1024, 1280 and 1440 px; no page overflow; the only
  horizontal scrollers left are the decision tables' own pre-existing
  `tableWrap` scroll areas.

## Checked, no finding

1. Tenant matching inputs, staff path (fresh tenant):
   - The Eligibility intake card shows the four rows, labels exact, BLANK
     (em dash) when unset; 9 rows in all.
   - Edit form: area preference sent TRIMMED (leading and trailing spaces
     typed); portion sent as the number 1200; the textarea's line breaks
     kept. Portion control: type=number, step=any, no min/max,
     inputmode=numeric; no maxlength on any text control (FW-12).
   - Rows after save: the portion reads "$1,200 / month"; the free-text rows
     render with `.vProse` (white-space pre-wrap, overflow-wrap anywhere):
     line breaks shown, a 128-character unbroken URL and a 158-character
     unbroken token wrap inside the card.
   - Geometry: no page overflow and no card or row horizontal scroll at 360,
     380, 600 (Profile view of the two-pane shell), 1024, 1280 and 1440 px;
     every value's right edge inside the card.
   - "1e" typed into the portion (real typing): value "", badInput true,
     the browser's own "Please enter a number."; Save sends NO PATCH, no
     role=alert - native validation refuses first (confirms R2-2 / FW2-2).
   - "12.5": role=alert "Maximum tenant portion must be a whole dollar
     amount from 0 to 20000.", no PATCH. A 501-character area preference:
     role=alert "Area preference must be 500 characters or fewer.", no PATCH.
   - Clearing area preference: PATCH `{"area_preference":null}`, 200; the
     row is BLANK; GET /api/contacts/:id has no area_preference key.
2. Priority (fresh property, Available):
   - Property details row "Priority No"; no header pill.
   - Edit form checkbox named exactly "Priority", described "Staff only";
     check -> PATCH `{"priority":true}` 200 -> row "Yes" and an amber
     "Priority" pill beside the status (background rgb(180, 83, 9) =
     #b45309 with white text, about 5:1); pill inside the header at 360-1440
     px, no page overflow, wraps under the title at <= 600 px.
   - While ON: GET /public/units/:id/flyer 200 with no `priority` key
     anywhere; the public flyer page (h1 = the street line) has no
     "Priority" text.
   - Uncheck -> PATCH `{"priority":false}` 200 -> row "No", pill gone, API
     priority false.
   - New property form: the "Priority" checkbox, "Staff only", unchecked, in
     DOM order Video URL, Same-day RTA, Priority, No evictions while on the
     program.
3. Extraction end to end (fake driver; a listed send of a property with
   line 2 two days back):
   - Run 1 - area preference write on the EMPTY field, a portion suggest
     "$950", four noteLines (a feedback line copying the label
     "251144 Peachtree Industrial Boulevard Northeast Apt 1204, Chamblee",
     a matching fact, a 0.4 line, a line naming an unsent street): tick
     processed 1, failed 0. Area preference "Decatur" with the Auto badge
     and `_source`; the chip "AI heard "$950 / month""; the Notes box got 3
     `[Auto - Oct 27]` lines, not the 0.4 line.
   - Run detail (founder): "3 appended", "1 below the confidence floor",
     "0 withheld by the unknown-speaker rule", "Feedback lines: 1",
     "Unlabeled address lines: 1", the 64-hex fingerprint; decision rows
     area_preference wrote / auto applied, max_tenant_portion $950 vs 1200
     suggested / pending, the other two absent.
   - Run 2 - writes on the now-FILLED area preference ("Marietta") and
     preferences and constraints: both dropped, reason "Field already
     filled" in the run detail; the stored values unchanged; a labeled
     change-of-mind feedback line ("...: now likes it - ...") appended;
     "1 appended", "Feedback lines: 1".
   - Accepting the portion chip: POST .../suggestions/max_tenant_portion/accept
     200; the row reads "$950 / month" with the Auto badge; stored as the
     number 950; the chip is gone.
4. Console: only the two 401s of /auth/me before the dev login; no React
   error or warning from B1 screens.

## Not B1 (recorded, not filed)

- With an artificial 38-character single-word surname, the contact page
  header does not wrap the name at 380 px and the main pane scrolls 17 px
  sideways. Pre-existing header behavior, untouched by B1; a real name of
  that length has spaces.
