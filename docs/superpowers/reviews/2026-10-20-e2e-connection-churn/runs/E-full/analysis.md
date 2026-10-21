window: 1298 s, 1270 series rows; endpoint records in window: 9239 connections paired
peak TIME_WAIT (whole machine): 1776; loopback TW at that moment: 1776

## OS view: connections per hop (paired endpoints, both closer sides)
| hop (client -> service) | connections | per min | closed by client | closed by server | no TW seen | peak TW client-side | peak TW server-side |
|---|---|---|---|---|---|---|---|
| chromium -> vite | 5771 | 266.8 | 4161 | 5 | 1605 | 971 | 59 |
| vite -> app | 2234 | 103.3 | 2118 | 0 | 116 | 750 | 2 |
| app -> dynamodb | 839 | 38.8 | 0 | 829 | 10 | 5 | 220 |
| ? -> app | 129 | 6.0 | 129 | 0 | 0 | 750 | 2 |
| app -> fake-twilio | 64 | 3.0 | 57 | 5 | 2 | 12 | 6 |
| node.exe -> vite | 61 | 2.8 | 0 | 60 | 1 | 971 | 59 |
| app -> minio | 37 | 1.7 | 0 | 37 | 0 | 9 | 14 |
| worker -> dynamodb | 31 | 1.4 | 0 | 27 | 4 | 5 | 220 |
| fake-twilio -> app | 14 | 0.6 | 12 | 0 | 2 | 750 | 2 |
| ? -> vite | 12 | 0.6 | 12 | 0 | 0 | 971 | 59 |
| chromium -> minio | 10 | 0.5 | 10 | 0 | 0 | 9 | 14 |
| node.exe -> app | 5 | 0.2 | 0 | 5 | 0 | 750 | 2 |
| chromium -> fake-twilio | 5 | 0.2 | 5 | 0 | 0 | 12 | 6 |
| ? -> dynamodb | 4 | 0.2 | 4 | 0 | 0 | 5 | 220 |
| fake-twilio -> minio | 4 | 0.2 | 1 | 3 | 0 | 9 | 14 |
| playwright -> vite | 3 | 0.1 | 2 | 1 | 0 | 971 | 59 |
| ? -> fake-twilio | 3 | 0.1 | 0 | 3 | 0 | 12 | 6 |
| launcher -> app | 2 | 0.1 | 2 | 0 | 0 | 750 | 2 |
| ? -> minio | 2 | 0.1 | 2 | 0 | 0 | 9 | 14 |
| node.exe -> minio | 2 | 0.1 | 0 | 2 | 0 | 9 | 14 |
| launcher -> dynamodb | 1 | 0.0 | 1 | 0 | 0 | 5 | 220 |
| launcher -> minio | 1 | 0.0 | 1 | 0 | 0 | 9 | 14 |
| launcher -> fake-twilio | 1 | 0.0 | 1 | 0 | 0 | 12 | 6 |
| playwright -> app | 1 | 0.0 | 1 | 0 | 0 | 750 | 2 |
| playwright -> fake-twilio | 1 | 0.0 | 1 | 0 | 0 | 12 | 6 |
| node.exe -> fake-twilio | 1 | 0.0 | 0 | 0 | 1 | 12 | 6 |
| worker -> app | 1 | 0.0 | 0 | 0 | 1 | 750 | 2 |

Peak TIME_WAIT by service port (over the whole window, not simultaneous):
- app :9301 - client-side 750, server-side 2
- vite :9311 - client-side 971, server-side 59
- fake-twilio :9321 - client-side 12, server-side 6
- publicBase :9331 - client-side 0, server-side 0
- dynamodb :8000 - client-side 5, server-side 220
- minio :9000 - client-side 9, server-side 14
