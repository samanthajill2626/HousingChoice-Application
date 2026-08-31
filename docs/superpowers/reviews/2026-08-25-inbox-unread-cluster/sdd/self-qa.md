# Phase 5 - live self-QA (orchestrator-driven, not delegated)

Lane 15, hermetic `npm run e2e:session`, lean seed, real DynamoDB Local +
MinIO. app :10501, dashboard :10511, fake-twilio :10521. Lane stopped and its
tables dropped afterwards. The human's live ports (:5174 / :8080) were never
touched.

Artifacts: `.playwright-mcp/selfqa-unknown-tab-populated.png` and
`.playwright-mcp/selfqa-unknown-tab-empty.png` (they land in the SHARED main
checkout's `.playwright-mcp/`, which is where the project MCP server's cwd
points; that directory is gitignored).

## 1. The empty queue is a normal page, not a failure (requirement 5)

Lean seeds three contacts - tenant, landlord, partner - and ZERO unknown, so the
tab starts genuinely empty.

    GET /api/inbox?filter=unknown&limit=30
    -> {"rows":[],"nextCursor":null}

Top-level keys are exactly `rows` and `nextCursor`. **No `truncated` key.** That
is the server half of requirement 5 proven against the real index rather than a
fake, and it is what keeps the dashboard's non-filter-gated
`serverEndedEarlyEmpty` banner off a cleared queue.

Visually (`selfqa-unknown-tab-empty.png`): the Unknown tab renders
**"No unknown numbers / Untriaged inbound numbers show up here."** No alert, no
"We couldn't load your inbox." The honest empty state.

## 2. A foreign cursor is rejected, not silently mis-Queried

    GET /api/inbox?filter=unknown&limit=30&cursor=<base64url {"idx":0}>  -> 400

## 3. The cost is on the operator's log, unconditionally

Empty queue:

    {"filter":"unknown","count":0,"queueContacts":0,"queuePages":1,"sweepScanned":0,
     "msg":"inbox feed assembled"}

Populated queue (two captured callers, two unread threads):

    {"filter":"unknown","count":2,"queueContacts":2,"queuePages":1,"sweepScanned":2,
     "msg":"inbox feed assembled"}

ONE partition Query in both cases (`queuePages: 1`), and `sweepScanned` tracks
the visible unread set exactly as designed. Zero WARNs fired at this size -
grepped for all three of the branch's WARN strings, count 0 - so the truncation
signals are not crying wolf on a healthy queue.

## 4. Two missed calls become two triage rows

Two inbound calls from fresh numbers through fake-twilio, each minting an
`(unknown, needs_review)` contact plus its 1:1 thread:

    contact ... +15557770102 needsTriage=true role=unknown unread=2
    contact ... +15557770101 needsTriage=true role=unknown unread=2

Newest displayed activity first. Visually
(`selfqa-unknown-tab-populated.png`): both rows, each with a "Needs triage"
chip and an unread count of 2.

## 5. THE MEASURED CHECK - class (f) live, plus two review findings reproduced

This is the one automated tests could not settle, because every unit test here
runs against a fake index. A status-only triage PATCH on one of the two
captured callers:

    PATCH /api/contacts/<id>  {"status":"active"}   -> 200
    response body: ..."type":"unknown","status":"active"

Three things fall out of that single step, all against the REAL byTypeStatus
index:

- **Class (f) is live and correct.** The `(type=unknown, status=active)` contact
  is STILL on the Unknown tab (rows: 2, both callers). This is the class the
  design widened the query to catch, and the old narrowed read would have
  dropped it. Confirmed visually too - `(555) 777-0101` is the patched one and
  it is on screen.
- **Adversarial finding MED-3 REPRODUCED.** The PATCH returned 200 with
  `type: "unknown"` intact, so a status-only triage does NOT remove a contact
  from the partition. The claim "triage retypes the contact out of the
  partition" - which was the justification for shipping no cursor - was false,
  and the fix wave's correction is now proven rather than argued.
- **Adversarial finding HIGH-1 REPRODUCED on real data.** Listing the raw
  partition afterwards returns:

        active        +15557770101
        needs_review  +15557770102

  `active` FIRST. That is the ascending sort on the `status` range key, on the
  real index, not the fake. It confirms that `UNKNOWN_QUEUE_MAX_ROWS` cuts
  status-first and starves `needs_review` - and that the two findings compound,
  because the status-only PATCH is what manufactures `active` rows and it
  promotes them to the front of the read.

## Verdict

Every live state the spec cares about behaves as specified, and the two
sharpest review findings reproduce against production-shaped infrastructure.
Nothing found in self-QA that the review had not already surfaced.
