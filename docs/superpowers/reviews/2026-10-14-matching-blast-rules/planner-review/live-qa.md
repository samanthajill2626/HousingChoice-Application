# Planner live QA - hermetic lane (2026-10-19)

Tree: dc073cc7 (last code commit 4f608a40). Lane 10 via `npm run e2e:session`,
driven through the project Playwright MCP, dev-login as va@example.com.
Fixtures through the real routes with the build's
`.superpowers/selfqa/setup.mjs` (fresh stamp 440567: authorities Wren, Finch
and a 99-character name; properties Qarule Ave (all three, Available),
Qarule Second St (Finch, Available), Qarule Tour Ct (Wren, Setup, carries the
tours); 11 tenants), plus one caseworker (partner, active, consent, voucher
size 2, housing authority Wren) created by the planner. Lane stopped
afterwards (`e2e:stop` exit 0). Screenshots: `.playwright-mcp/planner-qa-*.png`
in the main checkout (gitignored).

Focus: the conversation checklist items a test cannot show as well as a
screen (see `adjudications.md`).

| # | Scenario | Result |
|---|---|---|
| L1 | Matching > Send a property: the picker lists only Available properties | PASS - Qarule Ave and Qarule Second St; the Setup property is absent (C5) |
| L2 | Pick Qarule Ave: the housing authority filter prefills | PASS - all three authorities as chips; the first draft create carries `housing_authorities` [Wren, Finch, Long] and `bedroomSize` 2 (C6) |
| L3 | Caption | PASS - all three D8 sentences, verbatim (C14) |
| L4 | Reach equals the rows that start checked | PASS - "Reaches 4 recipients"; review shows exactly 4 checked; "Send to 4 recipients" (C15) |
| L5 | Who is listed | PASS - listed: Searching/Onboarding tenants of the three authorities; NOT listed: Placing, Needs review, the no-authority tenant, and the caseworker of the same authority (C1, C11, C14) |
| L6 | Hold labels, visible and accessible | PASS - "Tour Oct 24" (upcoming), "Toured Oct 16, needs outcome", "Tour requested Oct 19, no date yet" (C18, character-exact); names `... - tour requested oct 19, no date yet`; all unchecked; the Not a fit tenant is checked (C2, C3, C8) |
| L7 | No-consent held tenant | PASS - "... - consent not recorded", unchecked |
| L8 | Select all | PASS - after Deselect all + Select all, exactly the 4 default rows; held rows stay unchecked (C7) |
| L9 | A deliberate send to a held tenant | PASS - checking the requested-tour tenant by hand -> "Send to 5 recipients"; the send body lists 5 ids; results page shows 5 recipients incl. that tenant (C4, intent "nothing stops you") |
| L10 | Tenant page "Send a property" for a tenant with an upcoming tour | PASS - `?contactId=` entry, Available-only picker, the review shows that tenant CHECKED with "Tour Oct 24"; "Send to 1 recipient" (C4) |
| L11 | Already sent after L9 | PASS - reopening Qarule Ave reaches 0: every earlier recipient is now "already sent" |
| L12 | AR44 hold on the `?unitId=` entry with GET /api/organizations failing | PASS - alert "Couldn't load the organization list, so housing authorities can't be filled in from the property yet." with Try again; Preview disabled; "Estimating reach..."; ZERO draft creates; a failing Try again keeps the hold (still zero creates); a succeeding Try again fills all three chips, enables Preview, and the draft carries the three authorities (Cameron 2026-10-19) |

Console: one error, a 409 on DELETE of the just-sent draft - the composer's
unmount cleanup racing the send; pre-existing and documented as harmless in
`useComposerDraft.ts` (the DELETE route is draft-guarded). Plus the routed
500s of L12 (intended).

Observed, already filed (pre-existing): at a ~930 px window the review list
scrolls sideways on the 99-character authority name
(`review-recipients-narrow-authority-overflow`).
