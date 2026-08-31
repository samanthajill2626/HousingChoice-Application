# HANDBACK - Inbound media content-type fidelity

MERGE-READY @e3a97e77 on feat/media-content-type-fidelity (W:\tmp\media-content-type-fidelity),
0 behind main (main unmoved @3c2962a4 since cut - sync verified no-op, no merge
commit needed), UNMERGED (human gate).

## Work map

- T1 lib/mediaTypes.ts - SHIPPED @c8821708. DECLARABLE set (21 types), emission
  map, ACCEPTED-extension set, resolveMediaTier (essence match, canonical out),
  normalizeStoredMediaType rewired. isInlineMediaType untouched (set + exact
  match) - pinned by test.
- T2 lib/mediaFilename.ts - SHIPPED @17ab93cd (+hardened @f4b0cf19: Windows
  reserved device names, BiDi control strip, surrogate-safe cap).
- T3 serve route - SHIPPED @8427542a. Three tiers on the OBJECT's type;
  nosniff+CSP all tiers; Content-Length/Cache-Control preserved; log carries
  tier, never filename. Deviation: replaced the stale 8-line XSS comment
  (asserted everything-non-inline-is-octet-stream, now false) with the plan's
  superseding one.
- T4 dashboard - SHIPPED @22ae6981. Both galleries branch on the mirrored
  renderable set; tier-based fallback labels; all FIVE protected assertions
  unchanged at original lines (Timeline.test.tsx:552,:555;
  Timeline.email.test.tsx:87,:88,:107) + files.test.tsx:328. Deviation
  (forced): mmsWith is an arrow, not a function declaration - hoisting
  discards const union-narrowing; caught by typecheck, invisible to vitest.
- T5 adapters - SHIPPED @ff7e4d73. getMediaContentType (404/20404 tolerant -
  code string-tolerance added @272930c0), setContentType (same-key CopyObject,
  MetadataDirective REPLACE - first CopyObjectCommand in the repo),
  CreateMediaStoreDeps.credentials passthrough (typed S3ClientConfig
  ['credentials'], applied last so an explicit credential can never be
  silently dropped). EIGHT MessagingAdapter implementers stubbed (research
  corrected the plan's "four").
- T6 backfill script - SHIPPED @9102f63c, hardened @6fd52655 + @272930c0.
  Index from s3Key; write order S3 -> pointers -> row (row LAST, try/catch
  continue); re-read + merge-by-s3Key before the row write (closes the
  lost-update race vs the deferred mirror job to a millisecond window);
  dry-run stages the histogram, writes nothing; string-tolerant 429 retry
  1s/2s/4s; foreign-account rows (Quo imports) skip+count with an all-foreign
  wrong-credentials backstop; partial report logged on any abort; start line
  logs table/bucket/appEnv/SID-prefix. DEVIATIONS FROM PLAN, both deliberate
  and recorded: (1) the misconfig guard checks config.messagingDriver ===
  'twilio', NOT the plan's fields-present predicate - the live factory selects
  on the driver string, and fields-present would pass a console-driver shell
  straight into the silent-green catastrophe the guard exists to stop
  (worklist C1; the mission's watch item about R3's least-reviewed prose was
  exactly right); (2) TWILIO_API_BASE_URL and MEDIA_S3_ENDPOINT are refused
  outright (each redirects one of the two live systems; the S3 one would
  repair a local MinIO while clearing the real re-scan predicate -
  permanent silent split).
- T7 fake-twilio + e2e - SHIPPED @dc3ed0e5 (+discriminators @e3a97e77:
  link.locator('img') count 0 - both gallery branches carry the SAME
  accessible name, so the name locator alone passes on the broken-<img>
  regression; body BEGIN:VCARD - the fake's SPA fallback 200s a missing
  canned asset and the mirror types from the webhook param, so headers alone
  cannot tell a real round trip). Adjudicated spec deviation: .vcf instead of
  .mp4 (reviewable ASCII, identical declarable tier).
- T8 docs - SHIPPED @8842bdfb (+corrections @e3a97e77). RUNBOOK backfill
  procedure with deploy-first ordering and the COMPLETE operator env
  (loadConfig hard-requires six TWILIO_* vars + TWILIO_EVENTS_WEBHOOK_SECRET;
  the plan's five-var list would have killed the operator's first command);
  stored-XSS issue amended covering FOUR contradicted claims (the plan named
  three; the write-side "at rest" claim was the fourth).

## Gates on the FINAL commit e3a97e77 (bare, from the worktree, quiet tree)

1. npm run typecheck - EXIT 0 (all workspaces)
2. npm test - EXIT 0: app "Test Files 339 passed | 1 skipped (340) / Tests
   6068 passed | 9 skipped"; dashboard "177 passed / 2732"; e2e-ws "19 / 492";
   fake-twilio "34 / 240"; fake-twilio-web "13 / 111"
3. npm run smoke - EXIT 0 ("smoke-dist: OK - 1343 import specifier(s) across
   236 emitted file(s)")
4. npm run e2e - EXIT 0: "255 passed (20.2m)" (suite includes the new
   inbound-media-type.spec.ts)
5. npx eslint <34 branch files> - EXIT 1 with exactly TWO findings, BOTH
   baseline-proven pre-existing at merge base 3c2962a4:
   Timeline.tsx:1229 react-hooks/set-state-in-effect error (base :1221) and
   messaging.test.ts:447 unused-disable warning (base :446). NO NEW lint
   errors = gate PASS. Named so the next person does not re-diagnose them.

MID-MISSION FLAKE, both runs recorded per AGENTS.md: the first npm test run
failed EXIT 1 on ONE file - performanceSeed.integration.test.ts, a 600s
timeout with zero assertion failures in a file this branch never touched.
Clean-key discriminator (cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest
run): EXIT 0, "339 passed | 1 skipped", 139s. ENVIRONMENTAL per the
npm-test-dynamodb-local-contention protocol; the final battery then passed
outright with no key override.

## Commits (build phase; 10 design-phase docs commits precede)

c8821708 T1, 17ab93cd T2, 8427542a T3, 22ae6981 T4, ff7e4d73 T5, 9102f63c T6,
dc3ed0e5 T7, 8842bdfb T8, 6fd52655 + f4b0cf19 + b31281a1 fix wave 1,
272930c0 + e3a97e77 fix wave 2. Net vs base: 42 files, +6394/-56.

## Review

Spec-conformance (plan-aware): 8/8 CONFORM, five nits, zero unexplained
deviations. Adversarial (PLAN-BLIND per standing mandate): M1 wrong-account
silent-green backfill, M2 unpinned dashboard mirror, P1 backfill lost-update
race (concrete interleaving), P2 office-doc double-click, P3 relay-issue
overclaim, N1-N10. Fresh re-reviewer of wave 1 (resume ban honored): NF1
vacuous e2e locator, NF2 SPA-fallback hole, NF3 incomplete RUNBOOK env, NF4
false "different accounts" claim (dev+prod share ONE Twilio account -
verified; it reshaped M1's guard into foreign-row skip + backstop), plus the
MEDIA_S3_ENDPOINT twin. All must-fixes fixed; wave-2 delta verified by MY OWN
line-by-line read in lieu of a third reviewer (proportionality; recorded).
ADJUDICATED NO-CHANGE: P2 - spec decision D1 locked text/csv/docx/xlsx into
the declarable tier, so dropping them would deviate from the approved spec;
tracked as docs/issues/declarable-office-doc-types-double-click.md and NAMED
HERE for the human to own. N10 (e2e covers declarable only) - unit coverage
exists. MediaGallery announcing raw MIME as a tile's accessible name -
pre-existing pattern, population widened, noted not changed.

## Self-QA (live, lane 2, driven by the orchestrator)

Inbound vCard MMS from seeded Tasha -> thread renders paperclip +
"Contact card - Attachment 1" as an <a> with ZERO imgs; fetch of its href:
200, content-type text/vcard, content-disposition attachment;
filename="attachment-1.vcf", nosniff + CSP present, body BEGIN:VCARD (78
bytes). Inline regression: room.png renders a real decoded <img>
(naturalWidth 320) served inline; filename="attachment-1.png". "Media from
comms" gallery: image tile carries an <img>; the vCard tile is a glyph-only
file tile title="text/vcard" - proving the POINTER-ROW write path stores the
true type at runtime. Screenshot + all reports preserved at
W:\tmp\handbacks\media-content-type-fidelity\ (the worktree's .superpowers/
is gitignored and dies with it).

## Issues filed / touched

- FILED: declarable-office-doc-types-double-click (low; P2 residual for human)
- FILED: timeline-filename-bidi-display (low; pre-existing label surface)
- CORRECTED: relay-forwards-undeliverable-media - now states BOTH possible
  post-branch outcomes (the forwarded leg may now SUCCEED for Twilio-accepted
  types, colliding with mms-forward-received-media's privacy parking) and its
  refs point at real lines; a dev observation step is in the RUNBOOK sequence.
- AMENDED: media-serve-stored-xss (four claims + current anchors).

## Post-merge obligations (LOUDLY)

npx tsx app/scripts/backfill-media-content-types.ts - HUMAN-RUN, per
environment, AFTER that environment's deploy, --dry-run first, dev fully
through before prod. RUNBOOK.md:262-282 has the procedure, the complete env
list, and the deploy-first rationale (running against an old dashboard bundle
reproduces the broken-HEIC regression for the whole window). Until the
backfill runs in an environment, HISTORICAL inbound media there stays on the
opaque tier (new media is correct on arrival). One observation step: after
the dev deploy, send a non-image MMS into a dev relay group and observe the
forwarded leg before deploying prod. NO terraform, NO secrets, NO SSM, NO
deploys were run by this mission.

## Open questions / sub-threshold notes (not blocking, your eye)

- P2 residual is yours: spec D1 deliberately admits csv/docx/xlsx as typed
  downloads; the issue file frames the accept-or-drop choice.
- The declarable tier hands Twilio truthful types on relay forwards; outcome
  is vendor-decided (see the corrected issue + RUNBOOK observation step).
- Two pre-existing lint findings named in gate 5 above.
- performanceSeed environmental timeout signature recurred once mid-mission;
  the container-level database-count axis (per project memory) is the standing
  suspect; nothing owed by this branch.

Branch left at e3a97e77. Ledger STATUS: DONE.
