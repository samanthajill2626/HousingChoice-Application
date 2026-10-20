// Playwright MCP `browser_run_code_unsafe` body, as run on 2026-10-20 against
// lane 4 of a hook-free e2e:session (never the live :5174 / :8080 stack).
// Four identical navigation tours (dev-login + 24 page loads), each in a FRESH
// context: baseline, then an init script that emulates the proposed client.ts
// change (defer fetch dispatch one microtask; drop it if the signal aborted in
// the meantime), then both again. Count wire-level connections per window with
// oswindow.mjs over a passive sampler run.
async (page) => {
  const BASE = 'http://127.0.0.1:9411';
  const results = {};
  for (const variant of ['baseline', 'deferred-dispatch', 'baseline-2', 'deferred-dispatch-2']) {
    const ctx = await page.context().browser().newContext();
    if (variant.startsWith('deferred')) {
      await ctx.addInitScript(() => {
        const orig = window.fetch;
        window.fetch = function (input, init) {
          const signal = init && init.signal;
          if (!signal) return orig.call(window, input, init);
          return Promise.resolve().then(() =>
            signal.aborted
              ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
              : orig.call(window, input, init),
          );
        };
      });
    }
    const p = await ctx.newPage();
    const cancelled = [];
    let apiRequests = 0;
    const consoleErrors = [];
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });
    p.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) apiRequests++; });
    p.on('requestfailed', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) cancelled.push(u.pathname);
    });
    const tStart = Date.now();
    await p.goto(BASE + '/');
    await p.getByRole('button', { name: 'Continue as dev user' }).click();
    await p.getByRole('heading', { name: 'Today' }).first().waitFor({ timeout: 30000 });
    const urls = ['/', '/contacts', '/inbox', '/placements', '/tours', '/properties', '/contacts', '/'];
    let rendered = 0;
    for (let round = 0; round < 3; round++) {
      for (const u of urls) {
        await p.goto(BASE + u);
        await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        if (await p.getByRole('main').count()) rendered++;
      }
    }
    await ctx.close();
    const tEnd = Date.now();
    const sse = cancelled.filter((x) => x === '/api/events').length;
    results[variant] = { tStart, tEnd, pageLoads: urls.length * 3 + 1, rendered, apiRequestsIssued: apiRequests, cancelledApi: cancelled.length, cancelledSse: sse, cancelledNonSse: cancelled.length - sse, consoleErrors: consoleErrors.length, consoleSample: consoleErrors.slice(0, 3) };
    await new Promise((r) => setTimeout(r, 3000));
  }
  return JSON.stringify(results, null, 1);
}
