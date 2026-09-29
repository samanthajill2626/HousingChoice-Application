# Hosted-dev provider checks - 2026-09-28

Status: COMPLETE for the requested provider checklist;
`send-reconcile-hosted-dev-checks` is RESOLVED. Cameron confirmed the feature
is deployed on 2026-09-28. The observation limits below remain part of the
record. No branch or worktree was retired by this run.

## Scope and method

The human authorized these checks, read-only dev/prod settings access, and test
messages to their supplied number (suffix 7727). The agent sent one SMS through
the signed-in hosted-dev contact composer. After the human took over attachment
selection, they sent an MMS before observation started and explicitly prepared
and sent a second MMS while the observer was running. The observer captured a
baseline of 43 SIDs and excluded them, so the earlier MMS could not be mistaken
for the observed send. No settings, infrastructure, or deployments changed.

AWS identity was verified as account `938565869261`, profile `housingchoice`,
region `us-east-1`. Deployed SSM Twilio account/service identifiers matched the
local environment identifiers. Only the dev business sender and the authorized
test recipient were used for message-list queries. Production access was
limited to settings reads. Credentials and unrelated message bodies are not
included in this record.

Diagnostic scripts and metadata are locally retained under
`.superpowers/hosted-dev-checks-20260928/`: `read-checks.mjs` / `read-checks.json`,
`observe-message.mjs` / `sms-observations.json` /
`mms-observations-1790642283809.json`, and `link-settings.mjs` /
`link-settings.json`. The observer now excludes a pre-send baseline and saves
each successful observation. Syntax validation and each executed script exited
0. No application source changed; application completion gates were not run
for this verification lane.

## Findings against the checklist

1. **Queued visibility/null-date placement: PASS for the observed MMS.** An
   observer was running before the second MMS send. It requested To+From pages
   of 1000, initially every 250 ms plus request latency. The new MMS appeared
   in nine list samples as `queued`, with `date_sent=null`, at index 0 ahead
   of older sent messages. Direct fetches also captured queued/null-date
   states. This disproves the concern that messages are listed only once
   sent. The SMS alone had not answered that question: it first appeared
   already sent. This run did not capture `accepted`, establish a maximum
   indexing delay, or force a queue lasting past +240 seconds. The service
   validity period is 36000 seconds in both environments.
2. **Paging/page size: PASS for the tested calls; exact sort key remains
   unproven.** Requesting 1000 returned `page_size=1000`, 41 historical rows,
   and no next page. Requesting 2 returned 2 rows and `page_size=2`; following
   `nextPageUrl` with the SDK's `messages.getPage` returned the next 2 rows,
   with no duplicate SID across those pages. The 41-row sample was descending
   by both `date_sent` and `date_created`, so it cannot distinguish those sort
   keys. That historical sample had no null-date row; the later live MMS
   established index-0 placement for one queued/null-date message.
3. **Smart Encoding: PASS.** Read-only service GETs returned
   `smart_encoding=true` in dev and production. The dev Console also showed
   Smart encoding checked. This SMS used ASCII; the earlier Smart Encoding
   transformation spike remains the evidence for Unicode normalization.
4. **Body rewriting/settings: observed SMS and MMS bodies match.** The
   exact stored body, URL, and NFKC letters/digits SHA-256 fingerprint matched
   the submitted bodies in every listed/fetched sample of both observed tests.
   Link-shortening domain-association GETs returned HTTP 404 / Twilio 20404
   for both services; no association was returned. Both current `main` and
   the recorded dev deployment's adapter omit `shortenUrls` from message
   creation. Twilio's documentation requires `ShortenUrls=true` to request
   shortening. No production message was sent to verify body behavior there.

   The signed-in Console's Opt-out pages showed custom keyword/reply
   configurations for both services, including HousingChoice welcome/help
   replies and the dev-only `HC DEV: ` prefix. Those pages did not expose a
   separate Advanced Opt-Out enable/disable flag, so this record verifies the
   visible configuration rather than inventing a flag from an absent API field.
   No keyword canary was sent; the ordinary SMS does not prove keyword handling.

   Observed configuration drift: dev displayed STOP; START/UNSTOP; HELP.
   Production displayed CANCEL/END/OPTOUT/QUIT/REVOKE/STOP/STOPALL/UNSUBSCRIBE;
   START/UNSTOP/YES; HELP/INFO. This differs from the runbook's historical
   statement that the services are consistent. No corrective change was made.
5. **MMS Converter setting and eventual media count: PASS, with a transient
   media-count caveat.** Both services returned `mms_converter=true`; the dev
   Console showed it checked. The human sent the prepared single-image MMS.
   The first four positive list samples reported `num_media=0`; later samples
   reported 1 while still queued, and it stayed 1 through delivery in both
   list and fetch. The body and fingerprint always matched. The count became
   1 about 1.76 seconds after first visibility, before the configured first
   reconcile check at +5 seconds for this sample. This is not a guarantee of
   media hydration timing. No converter fallback to an SMS body link occurred
   for this recipient; recipients requiring conversion were not tested.

   Current code requires the media count as well as the body fingerprint
   (`sendReconcile.ts:698`). An in-window candidate whose media count has not
   hydrated remains unmatched: early checks continue; the final check closes
   `unresolved/unidentified_candidate`, never `never_sent`
   (`sendReconcile.ts:1254-1299`). Thus a visible transient zero can postpone
   adoption; it is not permission to resend. This is a code reading, not a
   live ambiguous-send job execution.

## SMS evidence

- Submitted body: `HC-CHECK-20260928-SMS. No action needed. https://dev.app.housingchoice.org/`
- Provider SID: `SM008b3b0dd7a22bff15196c42f320c0b0`.
- Provider creation and sent timestamps: `2026-09-29T00:26:48Z` (September 28,
  8:26:48 PM Eastern). Provider timestamps have one-second precision.
- First positive list response completed at `00:26:48.095Z`: `sent`, index 0,
  `num_media=0`, body/fingerprint match. The following direct fetch said
  `delivered`.
- List response at `00:26:50.230Z`: `delivered`, same body/fingerprint/media.
- List response at `00:27:18.619Z`: `delivered`, same body/fingerprint/media.
- Hosted-dev UI displayed Delivered. These observations establish provider
  and app receipt status, not an independent handset inspection.
- 100 list observations total, 22 positive; no provider error was recorded.

## MMS evidence

- Submitted body: `HC-CHECK-20260928-MMS. No action needed. https://dev.app.housingchoice.org/`
- Earlier, unobserved-at-send MMS: `MM682ced5a549aeb1849e764885bd0b3d5`, created
  `00:36:31Z`, sent `00:36:36Z`; baseline list read said delivered, one media,
  exact body/fingerprint match. It was excluded from the new-message observer.
- Observed MMS: `MMc9bece715325554d8f15469a36b3b950`.
- Observer ready: `2026-09-29T00:38:03.809Z` (September 28 Eastern).
- First positive list response: `00:38:32.509Z`, queued, `date_sent=null`,
  `num_media=0`, index 0. Direct fetch also said queued/null-date/zero media.
- First list sample with one media: `00:38:34.265Z`, still queued/null-date;
  the corresponding fetch also reported one media and queued/null-date.
- Direct fetch also captured `sending` with a null sent date. The list lagged
  subsequent fetch status changes briefly.
- Provider creation/sent times: `00:38:33Z` / `00:38:37Z`. These second-precision
  provider times are slightly ahead of local observation timestamps; do not
  infer sub-second queue latency by subtracting the two clocks.
- List said delivered at `00:38:40.808Z`; final list/fetch sample at
  `00:39:02.682Z` still said delivered, one media, exact body/fingerprint match.
- 96 list observations, 22 positive; nine positive samples queued, four with
  zero media. Every positive row was index 0; every listed/fetched body matched.
  No provider error was recorded. The observer completed with exit 0.

## Deployment record and operator confirmation

The recorded deployed tags read from SSM were:

| Environment | Recorded tag |
| --- | --- |
| Dev | `dev-2c086367-20260927180131` |
| Production | `dev-185545f0-20260910144226` |

Neither referenced Git commit contains `app/src/jobs/sendReconcile.ts`.
`4478c3ff` is not an ancestor of `2c086367`. These are deployment records, not
a direct inspection of running containers. Cameron subsequently confirmed,
"That is deployed," in response to the deployment question. Deployment is
therefore recorded as operator-confirmed; this run does not claim to have
independently inspected the running version or reconciled the older SSM tags.
The provider checks did not execute an ambiguous-send reconciliation job;
that was not an additional requirement of the original checklist.

## Closure and observation limits

- No further routine SMS/MMS send is needed for these samples: queued
  visibility, observed null-date placement, and eventual MMS media/body
  matching were captured. Exact global ordering, accepted-state visibility,
  and a maximum indexing/media-hydration delay remain unproven; the observations
  should not be presented as provider guarantees about prolonged queues.
- The final complete-walk rule does not depend on proving a global sort order.
  Queued/null-date visibility directly answered the specific concern that the
  provider lists only sent messages. The transient media-count mismatch was
  recorded with the existing safe handling rather than treated as a failed send.
- Custom opt-out configuration was inspected in both Consoles, and the test
  SMS/MMS bodies matched. A separate enabled flag was not exposed. This record
  does not claim a keyword canary or broader opt-out compliance verification.
- Deployment is operator-confirmed. No deployment was performed by the agent.
  No additional live job fault injection or manual test message is owed by
  this provider-check issue.

## Primary references

- [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource)
- [Twilio Messaging Service resource](https://www.twilio.com/docs/messaging/api/service-resource)
- [Twilio link shortening](https://www.twilio.com/docs/messaging/features/link-shortening)
- [Twilio Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out)
