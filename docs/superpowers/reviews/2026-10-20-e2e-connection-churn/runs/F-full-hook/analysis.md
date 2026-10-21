window: 1298 s, 1269 series rows; endpoint records in window: 9299 connections paired
peak TIME_WAIT (whole machine): 1882; loopback TW at that moment: 1817

## OS view: connections per hop (paired endpoints, both closer sides)
| hop (client -> service) | connections | per min | closed by client | closed by server | no TW seen | peak TW client-side | peak TW server-side |
|---|---|---|---|---|---|---|---|
| chromium -> vite | 5808 | 268.6 | 4194 | 6 | 1608 | 997 | 59 |
| vite -> app | 2293 | 106.0 | 2152 | 0 | 141 | 765 | 2 |
| app -> dynamodb | 832 | 38.5 | 0 | 822 | 10 | 5 | 213 |
| ? -> app | 120 | 5.5 | 120 | 0 | 0 | 765 | 2 |
| app -> fake-twilio | 62 | 2.9 | 55 | 5 | 2 | 13 | 6 |
| node.exe -> vite | 61 | 2.8 | 0 | 60 | 1 | 997 | 59 |
| app -> minio | 37 | 1.7 | 0 | 37 | 0 | 9 | 14 |
| ? -> vite | 17 | 0.8 | 17 | 0 | 0 | 997 | 59 |
| fake-twilio -> app | 15 | 0.7 | 13 | 0 | 2 | 765 | 2 |
| chromium -> minio | 10 | 0.5 | 10 | 0 | 0 | 9 | 14 |
| worker -> dynamodb | 6 | 0.3 | 0 | 3 | 3 | 5 | 213 |
| chromium -> fake-twilio | 6 | 0.3 | 6 | 0 | 0 | 13 | 6 |
| node.exe -> app | 5 | 0.2 | 0 | 5 | 0 | 765 | 2 |
| ? -> dynamodb | 4 | 0.2 | 4 | 0 | 0 | 5 | 213 |
| fake-twilio -> minio | 4 | 0.2 | 1 | 3 | 0 | 9 | 14 |
| playwright -> vite | 3 | 0.1 | 2 | 1 | 0 | 997 | 59 |
| ? -> fake-twilio | 3 | 0.1 | 0 | 3 | 0 | 13 | 6 |
| launcher -> app | 2 | 0.1 | 2 | 0 | 0 | 765 | 2 |
| ? -> minio | 2 | 0.1 | 2 | 0 | 0 | 9 | 14 |
| node.exe -> minio | 2 | 0.1 | 0 | 2 | 0 | 9 | 14 |
| launcher -> dynamodb | 1 | 0.0 | 1 | 0 | 0 | 5 | 213 |
| launcher -> minio | 1 | 0.0 | 1 | 0 | 0 | 9 | 14 |
| launcher -> fake-twilio | 1 | 0.0 | 1 | 0 | 0 | 13 | 6 |
| playwright -> app | 1 | 0.0 | 1 | 0 | 0 | 765 | 2 |
| playwright -> fake-twilio | 1 | 0.0 | 1 | 0 | 0 | 13 | 6 |
| node.exe -> fake-twilio | 1 | 0.0 | 0 | 0 | 1 | 13 | 6 |
| worker -> app | 1 | 0.0 | 0 | 0 | 1 | 765 | 2 |

Peak TIME_WAIT by service port (over the whole window, not simultaneous):
- app :9301 - client-side 765, server-side 2
- vite :9311 - client-side 997, server-side 59
- fake-twilio :9321 - client-side 13, server-side 6
- publicBase :9331 - client-side 0, server-side 0
- dynamodb :8000 - client-side 5, server-side 213
- minio :9000 - client-side 9, server-side 14

## Hook view: outbound connections opened, by process and destination
| process -> service | opened | requests | reqs/conn | closed locally (destroy) | closed locally (end) | closed by peer | conns whose last request was aborted |
|---|---|---|---|---|---|---|---|
| vite -> app | 2426 | 28061 | 11.6 | 2420 | 0 | 0 | 1863 |
| app -> dynamodb | 832 | 127586 | 153.3 | 822 | 0 | 0 | 0 |
| playwright -> vite | 61 | 2216 | 36.3 | 60 | 0 | 0 | 0 |
| app -> :undefined | 58 | 484 | 8.3 | 50 | 0 | 7 | 4 |
| app -> minio | 37 | 91 | 2.5 | 37 | 0 | 0 | 0 |
| fake-twilio -> app | 15 | 0 | 0.0 | 13 | 0 | 0 | 0 |
| app -> fake-twilio | 7 | 3 | 0.4 | 6 | 0 | 0 | 0 |
| worker -> dynamodb | 6 | 833 | 138.8 | 3 | 0 | 0 | 0 |
| playwright -> app | 5 | 156 | 31.2 | 5 | 0 | 0 | 0 |
| fake-twilio -> minio | 4 | 5 | 1.3 | 4 | 0 | 0 | 0 |
| playwright -> vite | 3 | 0 | 0.0 | 3 | 0 | 0 | 0 |
| other:W:\tmp\e2e-strictmode-aborts\app\scripts\s3-create.ts -> minio | 2 | 0 | 0.0 | 2 | 0 | 0 | 0 |
| playwright -> minio | 2 | 3 | 1.5 | 2 | 0 | 0 | 0 |
| launcher -> app | 2 | 0 | 0.0 | 2 | 0 | 0 | 0 |
| other:W:\tmp\e2e-strictmode-aborts\app\scripts\db-seed.ts -> dynamodb | 2 | 31 | 15.5 | 0 | 0 | 0 | 0 |
| other:W:\tmp\e2e-strictmode-aborts\app\scripts\db-update-gsis.ts -> dynamodb | 1 | 21 | 21.0 | 1 | 0 | 0 | 0 |
| playwright -> app | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 1033 | 1033.0 | 0 | 0 | 0 | 0 |
| launcher -> dynamodb | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| launcher -> minio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| launcher -> fake-twilio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| worker -> app | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 |
| other:W:\tmp\e2e-strictmode-aborts\app\scripts\db-create.ts -> dynamodb | 1 | 25 | 25.0 | 1 | 0 | 0 | 0 |

Top first-request paths of FRESH outbound connections (what made the process open a new socket):
- 513 x vite -> app | (no http request)
- 284 x app -> dynamodb | POST / [UpdateItem]
- 199 x app -> dynamodb | POST / [PutItem]
- 192 x vite -> app | GET /api/contacts?...
- 142 x app -> dynamodb | POST / [DescribeTable]
- 142 x app -> dynamodb | POST / [BatchWriteItem]
- 135 x vite -> app | GET /api/placements?...
- 115 x vite -> app | GET /api/events
- 107 x vite -> app | GET /api/units?...
- 105 x vite -> app | GET /api/contacts/contact-:id/group-threads
- 99 x vite -> app | GET /api/contacts/contact-:id/relay-groups
- 98 x vite -> app | GET /api/unmatched-email?...
- 92 x vite -> app | GET /api/contacts/contact-:id/listings-sent
- 86 x vite -> app | POST /api/inbox/contact-:id/read
- 83 x vite -> app | GET /api/contacts/contact-:id
- 66 x vite -> app | GET /auth/me
- 62 x vite -> app | GET /app-identity/config.json
- 57 x playwright -> vite | DELETE /api/contacts/contact-:id
- 55 x vite -> app | GET /api/inbox/unread-count
- 52 x vite -> app | GET /api/tours/tour-:id/reminders
- 51 x vite -> app | GET /api/tours/tour-:id/activity?...
- 49 x vite -> app | DELETE /api/contacts/contact-:id
- 47 x vite -> app | GET /api/contacts/vocabulary
- 36 x vite -> app | GET /api/conversations/conv-:id/members
- 32 x app -> dynamodb | POST / [Query]
- 31 x vite -> app | GET /api/contacts/contact-:id/suggestions
- 30 x app -> :undefined | POST /:n-04-01/Accounts/:tok/Messages.json
- 30 x vite -> app | GET /api/unread-counts?...
- 29 x vite -> app | GET /api/contacts/contact-:id/timeline
- 24 x vite -> app | GET /api/users/me
- 23 x vite -> app | GET /api/tours?...
- 23 x vite -> app | GET /api/units/unit-:id
- 20 x app -> dynamodb | POST / [GetItem]
- 17 x vite -> app | GET /api/conversations/conv-:id/scheduled
- 16 x app -> minio | PUT /hc-local-media-3/media/cast/call-recordings/:tok.mp3?...
- 16 x vite -> app | POST /api/contacts
- 16 x vite -> app | GET /api/contacts/contact-tenant-0001/listings-sent
- 15 x fake-twilio -> app | (no http request)
- 13 x vite -> app | GET /api/tours/tour-:id/roster
- 9 x app -> :undefined | (no http request)

Outbound connections destroyed with an unfinished request (aborted in flight), by path:
- 781 x vite -> app | GET /api/events
- 225 x vite -> app | GET /api/contacts/contact-:id/relay-groups
- 199 x vite -> app | GET /api/contacts/contact-:id/group-threads
- 186 x vite -> app | GET /api/contacts/contact-:id/listings-sent
- 154 x vite -> app | GET /api/today?...
- 60 x vite -> app | GET /api/tours/tour-:id/reminders
- 49 x vite -> app | GET /api/tours/tour-:id/roster
- 27 x vite -> app | GET /api/units?...
- 27 x vite -> app | GET /api/contacts/contact-:id/timeline
- 19 x vite -> app | GET /api/placements?...
- 19 x vite -> app | POST /api/inbox/contact-:id/read
- 13 x vite -> app | GET /api/tours?...
- 7 x vite -> app | GET /api/contacts/contact-tenant-0001/listings-sent
- 7 x vite -> app | GET /api/contacts/contact-tenant-0001/relay-groups
- 7 x vite -> app | GET /api/contacts/contact-tenant-0001/group-threads
- 7 x vite -> app | GET /api/units/unit-:id
- 6 x vite -> app | GET /api/units/unit-mx-tourable-05
- 6 x vite -> app | GET /api/units/unit-mx-tourable-02
- 6 x vite -> app | GET /api/units/unit-mx-tourable-01
- 5 x vite -> app | GET /api/inbox/unread-count
- 5 x vite -> app | GET /api/unread-counts?...
- 4 x app -> :undefined | POST /:n-04-01/Accounts/:tok/Messages.json
- 4 x vite -> app | GET /api/unmatched-email?...
- 4 x vite -> app | GET /api/contacts/contact-:id
- 4 x vite -> app | GET /api/contacts?...

## Hook view: inbound connections accepted, by server process
| server (port) | accepted | requests | reqs/conn | closed by peer | closed by server (destroy) | closed by server (end) | zero-request conns |
|---|---|---|---|---|---|---|---|
| app (:9301) | 2454 | 31615 | 12.9 | 0 | 158 | 2288 | 4 |
| fake-twilio (:9321) | 74 | 1620 | 21.9 | 0 | 9 | 63 | 1 |
| vite (:9311) | 5894 | 620436 | 105.3 | 0 | 74 | 5812 | 1578 |

Top first-request paths of ACCEPTED connections:
- 1578 x vite (:9311) | (no http request)
- 487 x app (:9301) | GET /api/events (Connection: keep-alive)
- 468 x vite (:9311) | GET /src/routes/contacts/CaseworkersList.tsx (Connection: keep-alive)
- 449 x app (:9301) | GET /api/contacts?... (Connection: keep-alive)
- 398 x vite (:9311) | GET /api/contacts?... (Connection: keep-alive)
- 377 x vite (:9311) | GET /src/main.tsx (Connection: keep-alive)
- 366 x vite (:9311) | GET /@react-refresh (Connection: keep-alive)
- 356 x vite (:9311) | GET / (Connection: keep-alive)
- 340 x vite (:9311) | GET /node_modules/.vite/deps/react-router-dom.js?... (Connection: keep-alive)
- 285 x app (:9301) | GET /api/unmatched-email?... (Connection: keep-alive)
- 280 x vite (:9311) | GET /src/App.tsx (Connection: keep-alive)
- 248 x app (:9301) | GET /api/placements?... (Connection: keep-alive)
- 231 x vite (:9311) | GET /node_modules/.vite/deps/react-dom_client.js?... (Connection: keep-alive)
- 195 x vite (:9311) | GET /src/index.css (Connection: keep-alive)
- 186 x app (:9301) | GET /api/inbox/unread-count (Connection: keep-alive)
- 158 x vite (:9311) | GET /src/routes/conversation/ConversationDetail.tsx (Connection: keep-alive)
- 156 x vite (:9311) | GET /api/contacts/contact-:id/media?... (Connection: keep-alive)
- 151 x app (:9301) | GET /api/contacts/contact-:id/media?... (Connection: keep-alive)
- 149 x vite (:9311) | GET /src/routes/contacts/ContactsList.tsx (Connection: keep-alive)
- 135 x vite (:9311) | GET /src/routes/today/Today.tsx (Connection: keep-alive)
- 110 x vite (:9311) | GET /src/routes/contact/ContactDetail.tsx (Connection: keep-alive)
- 101 x vite (:9311) | GET /src/routes/listings/ListingsList.tsx (Connection: keep-alive)
- 86 x app (:9301) | POST /api/contacts (Connection: keep-alive)
- 68 x app (:9301) | GET /api/tours/tour-:id/reminders (Connection: keep-alive)
- 67 x vite (:9311) | GET /src/routes/Placeholder.tsx (Connection: keep-alive)
- 66 x app (:9301) | GET /api/tours/tour-:id/activity?... (Connection: keep-alive)
- 62 x vite (:9311) | GET /src/routes/listing/ListingDetail.tsx (Connection: keep-alive)
- 59 x vite (:9311) | POST /api/contacts (Connection: keep-alive)
- 51 x vite (:9311) | GET /@fs/W:/tmp/:tok/node_modules/vite/dist/client/env.mjs (Connection: keep-alive)
- 49 x vite (:9311) | GET /src/app/EnvironmentIdentity.tsx (Connection: keep-alive)

Accepted connections by outcome:
- 223 x app (:9301) | all responses finished
- 2227 x app (:9301) | had an unfinished response
- 4 x app (:9301) | zero-request
- 65 x fake-twilio (:9321) | all responses finished
- 8 x fake-twilio (:9321) | had an unfinished response
- 1 x fake-twilio (:9321) | zero-request
- 1935 x vite (:9311) | all responses finished
- 2381 x vite (:9311) | had an unfinished response
- 1578 x vite (:9311) | zero-request

Unfinished responses on accepted connections (the client went away mid-response), by path:
- TOTAL 2227 x app (:9301) | proxied
- TOTAL 8 x fake-twilio (:9321) | module/static
- TOTAL 2381 x vite (:9311) | proxied
- 1269 x app (:9301) | proxied | GET /api/events
- 1268 x vite (:9311) | proxied | GET /api/events
- 225 x vite (:9311) | proxied | GET /api/contacts/contact-:id/relay-groups
- 222 x app (:9301) | proxied | GET /api/contacts/contact-:id/relay-groups
- 201 x vite (:9311) | proxied | GET /api/contacts/contact-:id/group-threads
- 189 x vite (:9311) | proxied | GET /api/contacts/contact-:id/listings-sent
- 154 x app (:9301) | proxied | GET /api/contacts/contact-:id/listings-sent
- 154 x vite (:9311) | proxied | GET /api/today?...
- 153 x app (:9301) | proxied | GET /api/today?...
- 151 x app (:9301) | proxied | GET /api/contacts/contact-:id/group-threads
- 68 x vite (:9311) | proxied | GET /api/tours/tour-:id/reminders
- 63 x app (:9301) | proxied | GET /api/tours/tour-:id/reminders
- 50 x vite (:9311) | proxied | GET /api/tours/tour-:id/roster
- 49 x app (:9301) | proxied | GET /api/tours/tour-:id/roster
- 28 x app (:9301) | proxied | GET /api/contacts/contact-:id/timeline
- 28 x vite (:9311) | proxied | GET /api/units?...
- 28 x vite (:9311) | proxied | GET /api/contacts/contact-:id/timeline
- 24 x vite (:9311) | proxied | GET /api/placements?...
- 19 x vite (:9311) | proxied | POST /api/inbox/contact-:id/read
- 17 x app (:9301) | proxied | GET /api/units?...
- 15 x app (:9301) | proxied | POST /api/inbox/contact-:id/read
- 13 x app (:9301) | proxied | GET /api/placements?...
- 13 x vite (:9311) | proxied | GET /api/tours?...
- 9 x app (:9301) | proxied | GET /api/tours?...
- 7 x app (:9301) | proxied | GET /api/contacts/contact-tenant-0001/relay-groups
- 7 x app (:9301) | proxied | GET /api/contacts/contact-tenant-0001/group-threads
- 7 x fake-twilio (:9321) | module/static | POST /:n-04-01/Accounts/:tok/Messages.json
- 7 x vite (:9311) | proxied | GET /api/contacts/contact-tenant-0001/listings-sent
- 7 x vite (:9311) | proxied | GET /api/contacts/contact-tenant-0001/group-threads
- 7 x vite (:9311) | proxied | GET /api/contacts/contact-tenant-0001/relay-groups
