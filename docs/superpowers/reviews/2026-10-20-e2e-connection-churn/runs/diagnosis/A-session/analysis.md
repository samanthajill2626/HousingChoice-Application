window: 151 s, 149 series rows; endpoint records in window: 6491 connections paired
peak TIME_WAIT (whole machine): 5305; loopback TW at that moment: 4544

## OS view: connections per hop (paired endpoints, both closer sides)
| hop (client -> service) | connections | per min | closed by client | closed by server | no TW seen | peak TW client-side | peak TW server-side |
|---|---|---|---|---|---|---|---|
| chromium -> vite | 3466 | 1373.8 | 2709 | 0 | 757 | 2600 | 1 |
| vite -> app | 2315 | 917.6 | 1727 | 0 | 588 | 1884 | 0 |
| ? -> app | 418 | 165.7 | 418 | 0 | 0 | 1884 | 0 |
| ? -> vite | 242 | 95.9 | 242 | 0 | 0 | 2600 | 1 |
| app -> dynamodb | 22 | 8.7 | 0 | 22 | 0 | 5 | 11 |
| app -> fake-twilio | 11 | 4.4 | 11 | 0 | 0 | 10 | 0 |
| worker -> dynamodb | 4 | 1.6 | 0 | 0 | 4 | 5 | 11 |
| playwright -> vite | 3 | 1.2 | 2 | 1 | 0 | 2600 | 1 |
| node.exe -> vite | 2 | 0.8 | 0 | 0 | 2 | 2600 | 1 |
| node.exe -> fake-twilio | 2 | 0.8 | 0 | 0 | 2 | 10 | 0 |
| fake-twilio -> app | 2 | 0.8 | 2 | 0 | 0 | 1884 | 0 |
| worker -> app | 1 | 0.4 | 1 | 0 | 0 | 1884 | 0 |
| playwright -> app | 1 | 0.4 | 1 | 0 | 0 | 1884 | 0 |
| playwright -> fake-twilio | 1 | 0.4 | 1 | 0 | 0 | 10 | 0 |
| app -> minio | 1 | 0.4 | 0 | 1 | 0 | 3 | 1 |

Peak TIME_WAIT by service port (over the whole window, not simultaneous):
- app :9401 - client-side 1884, server-side 0
- vite :9411 - client-side 2600, server-side 1
- fake-twilio :9421 - client-side 10, server-side 0
- publicBase :9431 - client-side 0, server-side 0
- dynamodb :8000 - client-side 5, server-side 11
- minio :9000 - client-side 3, server-side 1

## Hook view: outbound connections opened, by process and destination
| process -> service | opened | requests | reqs/conn | closed locally (destroy) | closed locally (end) | closed by peer | conns whose last request was aborted |
|---|---|---|---|---|---|---|---|
| vite -> app | 2834 | 9271 | 3.3 | 2829 | 0 | 0 | 2175 |
| app -> dynamodb | 22 | 30264 | 1375.6 | 10 | 0 | 0 | 0 |
| app -> :undefined | 10 | 39 | 3.9 | 10 | 0 | 0 | 0 |
| worker -> dynamodb | 4 | 155 | 38.8 | 1 | 0 | 0 | 1 |
| playwright -> vite | 3 | 1 | 0.3 | 3 | 0 | 0 | 0 |
| fake-twilio -> app | 2 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| playwright -> vite | 1 | 15 | 15.0 | 0 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 4 | 4.0 | 0 | 0 | 0 | 0 |
| app -> fake-twilio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| app -> minio | 1 | 1 | 1.0 | 1 | 0 | 0 | 0 |
| playwright -> vite | 1 | 141 | 141.0 | 0 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 54 | 54.0 | 0 | 0 | 0 | 0 |
| playwright -> app | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| worker -> app | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 |

Top first-request paths of FRESH outbound connections (what made the process open a new socket):
- 658 x vite -> app | (no http request)
- 191 x vite -> app | GET /api/contacts/contact-:id
- 174 x vite -> app | GET /api/placements/placement-:id/history?…
- 140 x vite -> app | GET /api/units/unit-:id
- 135 x vite -> app | GET /api/contacts?…
- 112 x vite -> app | GET /api/conversations/conv-:id/members
- 108 x vite -> app | GET /api/placements/placement-:id/nudges
- 99 x vite -> app | GET /api/placements?…
- 96 x vite -> app | GET /api/contacts/contact-:id/listings-sent
- 92 x vite -> app | GET /api/units?…
- 83 x vite -> app | POST /api/placements/placement-:id/transition
- 81 x vite -> app | GET /api/contacts/contact-:id/relay-groups
- 74 x vite -> app | GET /auth/me
- 74 x vite -> app | GET /api/unread-counts?…
- 59 x vite -> app | GET /api/contacts/contact-:id/timeline
- 57 x vite -> app | GET /app-identity/config.json
- 56 x vite -> app | POST /api/inbox/contact-:id/read
- 44 x vite -> app | GET /api/tours/tour-:id/reminders
- 44 x vite -> app | GET /api/inbox/unread-count
- 43 x vite -> app | GET /api/users/me
- 41 x vite -> app | GET /api/placements/placement-:id
- 40 x vite -> app | GET /api/unmatched-email?…
- 37 x vite -> app | GET /api/conversations/conv-:id
- 36 x vite -> app | GET /api/events
- 35 x vite -> app | GET /api/contacts/contact-:id/group-threads
- 34 x vite -> app | GET /api/tours/tour-:id/activity?…
- 28 x vite -> app | GET /api/contacts/contact-:id/suggestions
- 23 x vite -> app | GET /api/unread-counts
- 22 x vite -> app | PATCH /api/tours/tour-:id
- 18 x vite -> app | GET /api/tours/tour-:id/roster
- 17 x vite -> app | GET /api/contacts/contact-:id/media?…
- 14 x vite -> app | GET /api/tours/tour-:id
- 14 x app -> dynamodb | POST / [Query]
- 13 x vite -> app | GET /api/conversations/conv-:id/scheduled
- 11 x vite -> app | GET /api/tours/tour-:id/roster/preview-open
- 10 x vite -> app | GET /api/contacts/vocabulary
- 7 x vite -> app | GET /api/tours?…
- 7 x vite -> app | GET /api/conversations/conv-:id/messages?…
- 7 x app -> :undefined | POST /:n-04-01/Accounts/:tok/Messages.json
- 5 x vite -> app | GET /api/placements/placement-:id/roster

Outbound connections destroyed with an unfinished request (aborted in flight), by path:
- 186 x vite -> app | GET /api/events
- 135 x vite -> app | GET /api/placements/placement-:id/roster
- 129 x vite -> app | GET /api/contacts/contact-:id/relay-groups
- 125 x vite -> app | GET /api/placements/placement-:id/history?…
- 123 x vite -> app | GET /api/conversations/conv-:id/members
- 114 x vite -> app | GET /api/contacts/contact-:id/timeline
- 114 x vite -> app | GET /api/conversations/conv-:id/scheduled
- 110 x vite -> app | GET /api/conversations/conv-:id/messages?…
- 105 x vite -> app | GET /api/placements/placement-:id/nudges
- 103 x vite -> app | GET /api/placements/placement-:id
- 101 x vite -> app | GET /api/inbox/unread-count
- 99 x vite -> app | GET /api/contacts/contact-:id/listings-sent
- 89 x vite -> app | GET /api/contacts/contact-:id/group-threads
- 82 x vite -> app | GET /api/conversations/conv-:id
- 81 x vite -> app | GET /api/contacts?…
- 60 x vite -> app | GET /api/tours/tour-:id/roster
- 51 x vite -> app | GET /api/users/me
- 48 x vite -> app | GET /api/unmatched-email?…
- 47 x vite -> app | GET /api/tours/tour-:id/reminders
- 43 x vite -> app | GET /api/placements?…
- 42 x vite -> app | GET /api/contacts/contact-:id/suggestions
- 37 x vite -> app | GET /api/tours/tour-:id
- 32 x vite -> app | GET /api/today?…
- 29 x vite -> app | GET /api/unread-counts?…
- 24 x vite -> app | GET /api/units?…

## Hook view: inbound connections accepted, by server process
| server (port) | accepted | requests | reqs/conn | closed by peer | closed by server (destroy) | closed by server (end) | zero-request conns |
|---|---|---|---|---|---|---|---|
| vite (:9411) | 3732 | 138900 | 37.2 | 0 | 89 | 3643 | 342 |
| app (:9401) | 2846 | 12214 | 4.3 | 0 | 698 | 2141 | 8 |
| fake-twilio (:9421) | 14 | 112 | 8.0 | 0 | 2 | 12 | 0 |

Top first-request paths of ACCEPTED connections:
- 390 x app (:9401) | GET /api/unmatched-email?… (Connection: keep-alive)
- 342 x vite (:9411) | (no http request)
- 313 x app (:9401) | GET /api/contacts?… (Connection: keep-alive)
- 312 x vite (:9411) | GET /api/contacts?… (Connection: keep-alive)
- 266 x app (:9401) | GET /api/inbox/unread-count (Connection: keep-alive)
- 208 x vite (:9411) | GET /src/routes/contacts/CaseworkersList.tsx (Connection: keep-alive)
- 201 x vite (:9411) | GET /api/unmatched-email?… (Connection: keep-alive)
- 177 x vite (:9411) | GET /api/inbox/unread-count (Connection: keep-alive)
- 168 x vite (:9411) | GET /api/events (Connection: keep-alive)
- 162 x vite (:9411) | GET /api/conversations/conv-:id/members (Connection: keep-alive)
- 158 x app (:9401) | GET /api/conversations/conv-:id/members (Connection: keep-alive)
- 152 x vite (:9411) | GET /api/conversations/conv-:id/messages?… (Connection: keep-alive)
- 152 x vite (:9411) | GET /api/conversations/conv-:id/scheduled (Connection: keep-alive)
- 149 x vite (:9411) | GET /api/conversations/conv-:id (Connection: keep-alive)
- 135 x app (:9401) | GET /api/events (Connection: keep-alive)
- 135 x app (:9401) | GET /api/conversations/conv-:id (Connection: keep-alive)
- 122 x app (:9401) | GET /api/placements/placement-:id/roster (Connection: keep-alive)
- 117 x app (:9401) | GET /api/placements/placement-:id (Connection: keep-alive)
- 116 x app (:9401) | GET /api/placements/placement-:id/nudges (Connection: keep-alive)
- 115 x vite (:9411) | GET /api/placements/placement-:id/roster (Connection: keep-alive)
- 111 x app (:9401) | GET /api/conversations/conv-:id/scheduled (Connection: keep-alive)
- 105 x app (:9401) | GET /api/units?… (Connection: keep-alive)
- 104 x vite (:9411) | GET /api/placements/placement-:id (Connection: keep-alive)
- 102 x vite (:9411) | GET /src/routes/today/Today.tsx (Connection: keep-alive)
- 101 x app (:9401) | GET /api/conversations/conv-:id/messages?… (Connection: keep-alive)
- 99 x vite (:9411) | GET /api/placements/placement-:id/nudges (Connection: keep-alive)
- 96 x vite (:9411) | GET /api/contacts/contact-:id (Connection: keep-alive)
- 91 x vite (:9411) | GET /api/contacts/contact-:id/suggestions (Connection: keep-alive)
- 84 x app (:9401) | GET /api/contacts/contact-:id/suggestions (Connection: keep-alive)
- 81 x vite (:9411) | GET /api/tours/tour-:id/activity?… (Connection: keep-alive)

Accepted connections by outcome:
- 706 x app (:9401) | all responses finished
- 2132 x app (:9401) | had an unfinished response
- 8 x app (:9401) | zero-request
- 14 x fake-twilio (:9421) | all responses finished
- 530 x vite (:9411) | all responses finished
- 2860 x vite (:9411) | had an unfinished response
- 342 x vite (:9411) | zero-request

Unfinished responses on accepted connections (the client went away mid-response), by path:
- TOTAL 2860 x vite (:9411) | proxied
- TOTAL 2132 x app (:9401) | proxied
- 321 x vite (:9411) | proxied | GET /api/events
- 321 x app (:9401) | proxied | GET /api/events
- 230 x vite (:9411) | proxied | GET /api/inbox/unread-count
- 225 x vite (:9411) | proxied | GET /api/unmatched-email?…
- 193 x app (:9401) | proxied | GET /api/inbox/unread-count
- 168 x vite (:9411) | proxied | GET /api/conversations/conv-:id/members
- 160 x app (:9401) | proxied | GET /api/unmatched-email?…
- 144 x app (:9401) | proxied | GET /api/conversations/conv-:id/members
- 135 x vite (:9411) | proxied | GET /api/placements/placement-:id/roster
- 135 x app (:9401) | proxied | GET /api/placements/placement-:id/roster
- 133 x vite (:9411) | proxied | GET /api/contacts/contact-:id/timeline
- 133 x app (:9401) | proxied | GET /api/contacts/contact-:id/timeline
- 129 x vite (:9411) | proxied | GET /api/contacts/contact-:id/relay-groups
- 126 x app (:9401) | proxied | GET /api/contacts/contact-:id/relay-groups
- 125 x vite (:9411) | proxied | GET /api/placements/placement-:id/history?…
- 118 x vite (:9411) | proxied | GET /api/conversations/conv-:id/scheduled
- 115 x vite (:9411) | proxied | GET /api/conversations/conv-:id/messages?…
- 113 x app (:9401) | proxied | GET /api/placements/placement-:id/history?…
- 110 x vite (:9411) | proxied | GET /api/contacts?…
- 108 x vite (:9411) | proxied | GET /api/placements/placement-:id/nudges
- 104 x vite (:9411) | proxied | GET /api/placements/placement-:id
- 100 x vite (:9411) | proxied | GET /api/contacts/contact-:id/listings-sent
- 93 x vite (:9411) | proxied | GET /api/tours/tour-:id/reminders
- 93 x app (:9401) | proxied | GET /api/tours/tour-:id/reminders
- 91 x vite (:9411) | proxied | GET /api/contacts/contact-:id/group-threads
- 85 x vite (:9411) | proxied | GET /api/conversations/conv-:id
- 75 x app (:9401) | proxied | GET /api/placements/placement-:id/nudges
- 74 x vite (:9411) | proxied | GET /api/tours/tour-:id/roster
- 74 x app (:9401) | proxied | GET /api/tours/tour-:id/roster
- 72 x app (:9401) | proxied | GET /api/contacts/contact-:id/group-threads
