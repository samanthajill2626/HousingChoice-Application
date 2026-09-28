> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/self-qa-note.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Live self-QA (share-skip-fix Branch A)

Orchestrator-driven, 2026-09-25, hermetic e2e:session lane 15 at appCommit
d23a2d23 (the final fix-wave HEAD). The Playwright MCP browser build
(chrome-for-testing) is not installed in this environment - the client-plugin
gap e2e/README documents - so the UI EYEBALL was not run; verification was taken
at the DATA + presentation-logic boundary via the live app/dashboard API, and
the live-UI DOM layer is covered by the e2e suite (below). Installing a browser
mid-mission was judged out of scope.

## Sam #5 - a one-to-one share that reaches nobody (MEASURED live)

Created an available 1-BR / atlanta_housing unit, a NO-CONSENT 1-BR tenant, and
a one-to-one share (`body_template: [Address] [FlyerLink]`, sent by explicit
selection - the dashboard Send path) through the live proxy. `GET
/api/broadcasts/<id>/results` returned:
- status `sent`; stats `{ audience:1, sent:0, delivered:0, failed:0,
  skipped_opted_out:0, skipped_no_consent:1, skipped_other:0 }`;
- the recipient slot `{ status:'skipped', errorCode:'no_consent' }`.
- Outbound texts to that tenant in the fake-twilio thread store: 0 (the consent
  fence held - no text was attempted).
- presentShareLabel(status=sent, stats) computes "Not sent" (audience 1 =
  skipped 1) - D6.
- errorCode `no_consent` -> "No texting consent recorded" (D7,
  deliveryStatus.ts:953).
So the exact symptom Sam reported (a one-to-one share reading "Sent" with a bare
"Skipped") now reads "Not sent" with the real reason and sent nobody a text.

## Sam #4 - the one-to-one default text

The composer resolves `[Address] [FlyerLink]` client-side; covered by
resolveTemplate.test.ts (the constant -> `<one-line address> <flyer link>`) and
by the e2e DOM assertions (share-skip-fix.spec.ts and matching-entry-points.spec.ts
both assert the Message field equals `<addr> \S+/p/<unitId>?cta=text`). Not
re-measured here (pure client render, no server surface).

## Live-UI layer (the e2e suite is the eyeball)

`npm run e2e` = 278 passed (E2E-EXIT=0). The three share-skip-fix.spec.ts tests
drive the REAL dashboard + API + fake-twilio for exactly the Sam-facing states:
the composer default text (D8), a person's send reaching a switched-off
conversation (D4), the "Already sent" flag skipped-vs-sent-vs-failed and seeded
rows staying checked (D5), the "Not sent" header + list row (D6), and the skip
reason (D7). Cameron's prod apply (634 conversations switched on cleanly) is the
live confirmation of the ops half.

## Cleanup
Lane reseeded to the lean world and stopped; the four lane-15 ports free.
