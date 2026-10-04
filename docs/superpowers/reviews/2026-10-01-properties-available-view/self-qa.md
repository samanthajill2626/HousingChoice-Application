# Live self-QA - properties available view

Commit under test: c9eba3cd (the final gated commit). Hermetic lane 7 via
`npm run e2e:session` from `W:\tmp\properties-available-view`, confirmed by
`GET /__dev/ping` (`dev: true`, `tablePrefix: hc-local-7-`, `appCommit: c9eba3cd`),
then `POST /__dev/reseed?profile=full` (the demo world). Driven with the project
Playwright MCP (isolated browser), dev login as the seeded VA. Screenshots (gitignored):
`.playwright-mcp/properties-available-01-desktop-default.png`,
`-02-desktop-2br.png`, `-03-phone-360.png`, in both the main checkout and the worktree.
Session stopped with `npm run e2e:stop` (lane 7 tables dropped, lease released).

| Check | Result |
|---|---|
| `/listings` opens on Available, bare URL | PASS - Status reads Available; 13 rows |
| Summary: All row, per-authority rows, zero cells plain text, count hrefs | PASS - All 13 / 3; atlanta_housing 6 / 1, cobb_housing 2 / 0, dekalb_housing 1 / 1, fulton_housing 1 / 0, ga_dca 2 / 1, gwinnett_housing 1 / 0; links such as `/listings?status=setup&ha=atlanta+housing`; the All row's count equals the rows shown |
| Stored spellings, no prettifier | PASS - chips and rows read `atlanta_housing`, `ga_dca`, ... (demo seed slugs, as accepted) |
| 2-BR voucher chip | PASS - URL `?voucher=2`; the one property storing `voucher_size_accepted: [2, 3]` matches (the list shape works live); summary narrows to All 1 / 0; the line "15 properties have no voucher size recorded and are not counted." appears |
| Phone width 360x800 | PASS - no sideways overflow (document 0px, main 0px); table, chips and rows wrap |
| Console on the Properties page | PASS - info only (React DevTools notice); the login page's two 401s on `/auth/me` are the signed-out probe |

Observations (no action taken):

- At 360px the demo world's long slug spellings break mid-word in the narrow
  authority column (`atlanta_housi` / `ng`). Real names with spaces wrap at the
  spaces; the slugs go away with tracker #2's seed cleanup.
- The demo world shows the data gap the not-counted line was built for: 15 of the
  16 Available/Coming soon properties record no voucher size.
