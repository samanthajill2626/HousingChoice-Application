# fix/public-rate-limit-key - gates and live checks (2026-10-12)

Small-fix lane (security bug, Cameron's go). Branch cut from main @5c0d3f6a; main had
not advanced at handback (local main ahead of both remotes), so no sync was needed.
Fix commit 2e1b44ab; issue filing 68961f85.

## Decision trail

- Key: Cameron chose `CloudFront-Viewer-Address` (option B) over the last
  X-Forwarded-For entry, on condition it was proven first. Plus IPv6 /64 grouping.
- Proof, on two throwaway CloudFront distributions with the same
  `Managed-AllViewerExceptHostHeader` policy and an httpbin.org echo origin (created
  and deleted 2026-10-12 in the HousingChoice account, Cameron's go): see the
  Resolution in `docs/issues/public-rate-limit-key-spoofable-xff.md`. Every forged
  `CloudFront-Viewer-Address` arrived as the real viewer address; a forged
  `X-Forwarded-For` arrived with the real viewer appended after it.
- Live config (read-only `list-distributions`): hc-dev-app and hc-prod-app attach that
  policy to `/public/*`; no CloudFront Function, Lambda@Edge or WAF. No Terraform owed.
- The global welcome-text ceiling was filed as a very low item
  (`docs/issues/public-welcome-text-global-cap.md`), Cameron's request.

## Gates (worktree W:\tmp\public-rate-limit-key @68961f85)

| Gate | Result |
| --- | --- |
| 1 `npm run typecheck` | exit 0 |
| 2 `npm test` | exit 0 - app 438 files / 9163 passed (1 skipped), dashboard 234 / 4384, e2e 22 / 503, fake-twilio 34 / 275, fake-twilio-web 13 / 111; no `[dynamoAdmin]` line |
| 3 `npm run smoke` | exit 0 - 1649 import specifiers across 286 emitted files resolve |
| 4 `npm run e2e` | exit 0 - 339 passed (22.4m) |
| 5 `npx eslint <main...HEAD .ts files>` | exit 0 - rateLimit.ts, requestLogger.ts, rateLimitClientKey.test.ts |

Red check: with the old first-entry resolver temporarily restored, 4 of the 15 new
cases fail (both X-Forwarded-For unit cases and both route-level rotation cases);
restored before gate 2.

## Live QA (hermetic e2e:session, lane 14, PUBLIC_RATE_LIMIT_MAX=5, via the Vite proxy)

| Scenario | Statuses |
| --- | --- |
| Rotating forged X-Forwarded-For, no viewer header (socket key) | 200 x5, 429, 429 |
| One viewer `192.0.2.10` with rotating forged XFF, x6 | 200 x5, 429 |
| A second viewer `192.0.2.11` | 200 |
| IPv6 rotating inside `2001:db8:9:9::/64`, x6 | 200 x5, 429 |
| Another /64 `2001:db8:9:a::1` | 200 |

Session stopped; lane 14 ports free and tables dropped.
