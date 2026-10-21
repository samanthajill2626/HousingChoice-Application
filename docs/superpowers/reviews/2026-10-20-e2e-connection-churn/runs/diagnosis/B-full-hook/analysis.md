window: 1255 s, 1228 series rows; endpoint records in window: 23614 connections paired
peak TIME_WAIT (whole machine): 4784; loopback TW at that moment: 4705

## OS view: connections per hop (paired endpoints, both closer sides)
| hop (client -> service) | connections | per min | closed by client | closed by server | no TW seen | peak TW client-side | peak TW server-side |
|---|---|---|---|---|---|---|---|
| chromium -> vite | 13038 | 623.1 | 10067 | 3 | 2968 | 2760 | 59 |
| vite -> app | 7572 | 361.9 | 5457 | 0 | 2115 | 1897 | 2 |
| ? -> app | 1209 | 57.8 | 1207 | 0 | 2 | 1897 | 2 |
| app -> dynamodb | 865 | 41.3 | 0 | 853 | 12 | 6 | 204 |
| ? -> vite | 689 | 32.9 | 689 | 0 | 0 | 2760 | 59 |
| app -> fake-twilio | 66 | 3.2 | 59 | 5 | 2 | 13 | 6 |
| node.exe -> vite | 62 | 3.0 | 0 | 60 | 2 | 2760 | 59 |
| app -> minio | 37 | 1.8 | 0 | 37 | 0 | 8 | 13 |
| fake-twilio -> app | 15 | 0.7 | 13 | 0 | 2 | 1897 | 2 |
| chromium -> minio | 10 | 0.5 | 10 | 0 | 0 | 8 | 13 |
| worker -> dynamodb | 9 | 0.4 | 0 | 5 | 4 | 6 | 204 |
| node.exe -> app | 7 | 0.3 | 0 | 6 | 1 | 1897 | 2 |
| chromium -> fake-twilio | 6 | 0.3 | 6 | 0 | 0 | 13 | 6 |
| ? -> dynamodb | 4 | 0.2 | 4 | 0 | 0 | 6 | 204 |
| fake-twilio -> minio | 4 | 0.2 | 1 | 3 | 0 | 8 | 13 |
| playwright -> vite | 3 | 0.1 | 2 | 1 | 0 | 2760 | 59 |
| ? -> fake-twilio | 3 | 0.1 | 0 | 3 | 0 | 13 | 6 |
| ? -> minio | 2 | 0.1 | 2 | 0 | 0 | 8 | 13 |
| launcher -> app | 2 | 0.1 | 2 | 0 | 0 | 1897 | 2 |
| node.exe -> fake-twilio | 2 | 0.1 | 0 | 0 | 2 | 13 | 6 |
| node.exe -> minio | 2 | 0.1 | 0 | 2 | 0 | 8 | 13 |
| worker -> app | 2 | 0.1 | 1 | 0 | 1 | 1897 | 2 |
| launcher -> dynamodb | 1 | 0.0 | 1 | 0 | 0 | 6 | 204 |
| launcher -> minio | 1 | 0.0 | 1 | 0 | 0 | 8 | 13 |
| launcher -> fake-twilio | 1 | 0.0 | 1 | 0 | 0 | 13 | 6 |
| playwright -> app | 1 | 0.0 | 1 | 0 | 0 | 1897 | 2 |
| playwright -> fake-twilio | 1 | 0.0 | 1 | 0 | 0 | 13 | 6 |

Peak TIME_WAIT by service port (over the whole window, not simultaneous):
- app :9401 - client-side 1897, server-side 2
- vite :9411 - client-side 2760, server-side 59
- fake-twilio :9421 - client-side 13, server-side 6
- publicBase :9431 - client-side 0, server-side 0
- dynamodb :8000 - client-side 6, server-side 204
- minio :9000 - client-side 8, server-side 13

## Hook view: outbound connections opened, by process and destination
| process -> service | opened | requests | reqs/conn | closed locally (destroy) | closed locally (end) | closed by peer | conns whose last request was aborted |
|---|---|---|---|---|---|---|---|
| vite -> app | 9020 | 31457 | 3.5 | 9016 | 0 | 0 | 6918 |
| app -> dynamodb | 865 | 161049 | 186.2 | 853 | 0 | 0 | 0 |
| app -> :undefined | 62 | 481 | 7.8 | 54 | 0 | 7 | 4 |
| playwright -> vite | 61 | 1771 | 29.0 | 60 | 0 | 0 | 0 |
| app -> minio | 37 | 91 | 2.5 | 37 | 0 | 0 | 0 |
| fake-twilio -> app | 15 | 0 | 0.0 | 13 | 0 | 0 | 0 |
| worker -> dynamodb | 9 | 881 | 97.9 | 5 | 0 | 1 | 2 |
| app -> fake-twilio | 7 | 3 | 0.4 | 6 | 0 | 0 | 0 |
| playwright -> app | 5 | 96 | 19.2 | 5 | 0 | 0 | 0 |
| fake-twilio -> minio | 4 | 5 | 1.3 | 4 | 0 | 0 | 0 |
| playwright -> vite | 3 | 0 | 0.0 | 3 | 0 | 0 | 0 |
| playwright -> minio | 2 | 3 | 1.5 | 2 | 0 | 0 | 0 |
| launcher -> app | 2 | 0 | 0.0 | 2 | 0 | 0 | 0 |
| worker -> app | 2 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| playwright -> app | 2 | 58 | 29.0 | 1 | 0 | 0 | 0 |
| other:claude\worktrees\reverent-jang-0c0c1d\app\scripts\db-seed.ts -> dynamodb | 2 | 31 | 15.5 | 0 | 0 | 0 | 0 |
| other:aude\worktrees\reverent-jang-0c0c1d\app\scripts\s3-create.ts -> minio | 2 | 0 | 0.0 | 2 | 0 | 0 | 0 |
| other:aude\worktrees\reverent-jang-0c0c1d\app\scripts\db-create.ts -> dynamodb | 1 | 51 | 51.0 | 1 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 768 | 768.0 | 0 | 0 | 0 | 0 |
| launcher -> dynamodb | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| launcher -> minio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| launcher -> fake-twilio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| other:worktrees\reverent-jang-0c0c1d\app\scripts\db-update-gsis.ts -> dynamodb | 1 | 21 | 21.0 | 1 | 0 | 0 | 0 |
| playwright -> vite | 1 | 444 | 444.0 | 0 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 265 | 265.0 | 0 | 0 | 0 | 0 |
| playwright -> app | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |
| playwright -> fake-twilio | 1 | 0 | 0.0 | 1 | 0 | 0 | 0 |

Top first-request paths of FRESH outbound connections (what made the process open a new socket):
- 2090 x vite -> app | (no http request)
- 622 x vite -> app | GET /api/contacts?…
- 463 x vite -> app | GET /app-identity/config.json
- 414 x vite -> app | GET /api/placements?…
- 383 x vite -> app | GET /api/inbox/unread-count
- 370 x vite -> app | GET /api/contacts/contact-:id
- 362 x vite -> app | GET /api/units?…
- 284 x app -> dynamodb | POST / [UpdateItem]
- 278 x vite -> app | GET /auth/me
- 268 x vite -> app | GET /api/contacts/contact-:id/listings-sent
- 242 x vite -> app | GET /api/units/unit-:id
- 237 x vite -> app | GET /api/unmatched-email?…
- 224 x vite -> app | GET /api/contacts/contact-:id/timeline
- 207 x vite -> app | GET /api/users/me
- 200 x app -> dynamodb | POST / [PutItem]
- 193 x vite -> app | GET /api/placements/placement-:id/history?…
- 186 x vite -> app | GET /api/contacts/contact-:id/relay-groups
- 164 x vite -> app | GET /api/tours?…
- 164 x vite -> app | POST /api/inbox/contact-:id/read
- 142 x app -> dynamodb | POST / [DescribeTable]
- 142 x app -> dynamodb | POST / [BatchWriteItem]
- 130 x vite -> app | GET /api/events
- 128 x vite -> app | GET /api/conversations/conv-:id/members
- 127 x vite -> app | GET /api/tours/tour-:id/reminders
- 102 x vite -> app | GET /api/unread-counts?…
- 101 x vite -> app | GET /api/contacts/contact-:id/group-threads
- 87 x vite -> app | POST /api/placements/placement-:id/transition
- 73 x vite -> app | GET /api/contacts/contact-:id/suggestions
- 73 x vite -> app | GET /api/placements/placement-:id
- 69 x vite -> app | GET /api/tours/tour-:id/activity?…
- 68 x vite -> app | GET /api/conversations/conv-:id
- 65 x app -> dynamodb | POST / [Query]
- 64 x vite -> app | GET /api/tours/tour-:id/roster
- 60 x vite -> app | POST /api/contacts
- 57 x playwright -> vite | DELETE /api/contacts/contact-:id
- 57 x vite -> app | GET /api/placements/placement-:id/nudges
- 56 x vite -> app | PATCH /api/tours/tour-:id
- 55 x vite -> app | GET /api/contacts/contact-:id/media?…
- 46 x vite -> app | GET /api/contacts/contact-tenant-0001/timeline
- 44 x vite -> app | DELETE /api/contacts/contact-:id

Outbound connections destroyed with an unfinished request (aborted in flight), by path:
- 639 x vite -> app | GET /api/events
- 609 x vite -> app | GET /api/inbox/unread-count
- 415 x vite -> app | GET /api/contacts?…
- 374 x vite -> app | GET /api/contacts/contact-:id/timeline
- 372 x vite -> app | GET /api/today?…
- 341 x vite -> app | GET /api/contacts/contact-:id/listings-sent
- 321 x vite -> app | GET /api/unmatched-email?…
- 275 x vite -> app | GET /api/contacts/contact-:id/relay-groups
- 249 x vite -> app | GET /api/tours?…
- 246 x vite -> app | GET /api/users/me
- 231 x vite -> app | GET /__dev/ping
- 187 x vite -> app | GET /api/contacts/contact-:id/suggestions
- 170 x vite -> app | GET /api/tours/tour-:id/reminders
- 163 x vite -> app | GET /api/contacts/contact-:id/group-threads
- 161 x vite -> app | GET /api/tours/tour-:id/roster
- 148 x vite -> app | GET /api/placements?…
- 145 x vite -> app | GET /api/placements/placement-:id/roster
- 137 x vite -> app | GET /api/units?…
- 136 x vite -> app | GET /api/placements/placement-:id/history?…
- 131 x vite -> app | GET /api/conversations/conv-:id/members
- 126 x vite -> app | GET /api/placements/placement-:id
- 125 x vite -> app | GET /api/placements/placement-:id/nudges
- 121 x vite -> app | GET /api/conversations/conv-:id/scheduled
- 120 x vite -> app | GET /api/conversations/conv-:id/messages?…
- 119 x vite -> app | GET /api/tours/tour-:id

## Hook view: inbound connections accepted, by server process
| server (port) | accepted | requests | reqs/conn | closed by peer | closed by server (destroy) | closed by server (end) | zero-request conns |
|---|---|---|---|---|---|---|---|
| app (:9401) | 9076 | 41622 | 4.6 | 0 | 2388 | 6679 | 23 |
| fake-twilio (:9421) | 79 | 1622 | 20.5 | 0 | 10 | 67 | 1 |
| vite (:9411) | 13811 | 630073 | 45.6 | 0 | 271 | 13534 | 1586 |

Top first-request paths of ACCEPTED connections:
- 1586 x vite (:9411) | (no http request)
- 1352 x app (:9401) | GET /api/unmatched-email?… (Connection: keep-alive)
- 1025 x vite (:9411) | GET /api/contacts?… (Connection: keep-alive)
- 1000 x app (:9401) | GET /api/contacts?… (Connection: keep-alive)
- 894 x app (:9401) | GET /api/inbox/unread-count (Connection: keep-alive)
- 795 x vite (:9411) | GET /api/unmatched-email?… (Connection: keep-alive)
- 730 x vite (:9411) | GET /api/events (Connection: keep-alive)
- 629 x app (:9401) | GET /api/events (Connection: keep-alive)
- 623 x vite (:9411) | GET /src/routes/contacts/CaseworkersList.tsx (Connection: keep-alive)
- 619 x app (:9401) | GET /api/tours?… (Connection: keep-alive)
- 590 x vite (:9411) | GET /api/tours?… (Connection: keep-alive)
- 478 x vite (:9411) | GET /api/inbox/unread-count (Connection: keep-alive)
- 383 x app (:9401) | GET /api/units?… (Connection: keep-alive)
- 373 x vite (:9411) | GET /src/main.tsx (Connection: keep-alive)
- 372 x vite (:9411) | GET /@react-refresh (Connection: keep-alive)
- 356 x vite (:9411) | GET / (Connection: keep-alive)
- 349 x vite (:9411) | GET /node_modules/.vite/deps/react-router-dom.js?… (Connection: keep-alive)
- 319 x vite (:9411) | GET /api/today?… (Connection: keep-alive)
- 319 x vite (:9411) | GET /src/routes/conversation/ConversationDetail.tsx (Connection: keep-alive)
- 318 x vite (:9411) | GET /api/contacts/contact-:id (Connection: keep-alive)
- 317 x app (:9401) | GET /api/today?… (Connection: keep-alive)
- 289 x vite (:9411) | GET /api/contacts/contact-:id/suggestions (Connection: keep-alive)
- 279 x app (:9401) | GET /api/contacts/contact-:id/suggestions (Connection: keep-alive)
- 260 x vite (:9411) | GET /api/tours/tour-:id/activity?… (Connection: keep-alive)
- 257 x vite (:9411) | GET /api/unread-counts?… (Connection: keep-alive)
- 254 x app (:9401) | GET /api/tours/tour-:id/activity?… (Connection: keep-alive)
- 253 x app (:9401) | GET /api/unread-counts?… (Connection: keep-alive)
- 253 x vite (:9411) | GET /node_modules/.vite/deps/react-dom_client.js?… (Connection: keep-alive)
- 238 x vite (:9411) | GET /src/App.tsx (Connection: keep-alive)
- 237 x vite (:9411) | GET /src/index.css (Connection: keep-alive)

Accepted connections by outcome:
- 2421 x app (:9401) | all responses finished
- 6632 x app (:9401) | had an unfinished response
- 23 x app (:9401) | zero-request
- 70 x fake-twilio (:9421) | all responses finished
- 8 x fake-twilio (:9421) | had an unfinished response
- 1 x fake-twilio (:9421) | zero-request
- 3117 x vite (:9411) | all responses finished
- 9108 x vite (:9411) | had an unfinished response
- 1586 x vite (:9411) | zero-request

Unfinished responses on accepted connections (the client went away mid-response), by path:
- TOTAL 6632 x app (:9401) | proxied
- TOTAL 8 x fake-twilio (:9421) | module/static
- TOTAL 9108 x vite (:9411) | proxied
- 1268 x app (:9401) | proxied | GET /api/events
- 1268 x vite (:9411) | proxied | GET /api/events
- 863 x vite (:9411) | proxied | GET /api/inbox/unread-count
- 836 x vite (:9411) | proxied | GET /api/unmatched-email?…
- 763 x app (:9401) | proxied | GET /api/inbox/unread-count
- 688 x app (:9401) | proxied | GET /api/unmatched-email?…
- 499 x vite (:9411) | proxied | GET /api/contacts?…
- 438 x app (:9401) | proxied | GET /api/contacts/contact-:id/timeline
- 438 x vite (:9411) | proxied | GET /api/contacts/contact-:id/timeline
- 397 x vite (:9411) | proxied | GET /api/today?…
- 395 x app (:9401) | proxied | GET /api/today?…
- 350 x vite (:9411) | proxied | GET /api/contacts/contact-:id/listings-sent
- 307 x vite (:9411) | proxied | GET /api/tours?…
- 276 x vite (:9411) | proxied | GET /api/contacts/contact-:id/relay-groups
- 274 x app (:9401) | proxied | GET /api/contacts/contact-:id/listings-sent
- 265 x app (:9401) | proxied | GET /api/contacts/contact-:id/relay-groups
- 260 x vite (:9411) | proxied | GET /api/tours/tour-:id/reminders
- 258 x app (:9401) | proxied | GET /api/tours/tour-:id/reminders
- 257 x vite (:9411) | proxied | GET /api/users/me
- 234 x vite (:9411) | proxied | GET /__dev/ping
- 213 x vite (:9411) | proxied | GET /api/placements?…
- 205 x vite (:9411) | proxied | GET /api/conversations/conv-:id/members
- 205 x vite (:9411) | proxied | GET /api/tours/tour-:id/roster
- 203 x app (:9401) | proxied | GET /api/tours/tour-:id/roster
- 188 x vite (:9411) | proxied | GET /api/contacts/contact-:id/suggestions
- 168 x vite (:9411) | proxied | GET /api/contacts/contact-:id/group-threads
- 160 x app (:9401) | proxied | GET /api/conversations/conv-:id/members
- 151 x vite (:9411) | proxied | GET /api/unread-counts?…
- 148 x app (:9401) | proxied | GET /api/unread-counts?…
- 145 x app (:9401) | proxied | GET /api/placements/placement-:id/roster
