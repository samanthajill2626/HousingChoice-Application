# Plan research findings - S1/S2 (app server)

Writer: plan section writer for S1 + S2, 2026-10-12. Scope: places where the
code shows the APPROVED spec (revision 4) is inaccurate. Code is cited by
file:line; the worktree has no node_modules yet, so the Express router source
is cited from the main checkout's install (express 5.2.1, router 2.2.0 - the
versions `app/package.json:36` resolves to).

## F1 (LOW) - D2: an OPTIONS request to the list path does not fall through

Spec D2 says the new router defines only `GET /housing-authorities` and
"Every other request falls through to the existing mount and its shared
5-per-minute limiter, exactly as today".

The mechanism delivers that for every method except OPTIONS on that one
path. Express's router answers an OPTIONS request itself when a route in it
matches the path but no handler responds: `node_modules/router/index.js:176-179`
wraps `done` with an OPTIONS responder for every OPTIONS request, `:263-265`
collects the matched route's methods, and `:461-468` / `:698-714` send
`200` with `Allow: GET, HEAD` (text/plain). So after this change
`OPTIONS /public/housing-authorities` is answered by the list router with
200, without passing either limiter; today it passes the shared limiter
(`app/src/app.ts:165-171`) and ends in a 404 because no `/public` route
matches it (`app/src/routes/public.ts:209`, `:344` are the only routes).

Impact: none found. The OPTIONS answer reads nothing (no storage, no
handler), CloudFront's `/public/*` behavior already allows OPTIONS with
caching disabled (`infra/modules/cloudfront/main.tf:157-166`), and no client
sends it (same-origin pages, no CORS).

Proposed resolution: accept, and if the spec is touched again, narrow the
D2 sentence to "Every other request (except an OPTIONS on that one path,
which Express answers itself with `Allow: GET, HEAD`, reading nothing) falls
through ...". No plan task depends on it; the plan's tests pin only GET and
a POST fall-through.
