// Diagnostic preload (NODE_OPTIONS=--import=<this file>) for the e2e
// connection-churn diagnosis. Records, per process, every TCP connection it
// opens or accepts, which HTTP requests rode each one, and which side closed it.
// Buffered in memory and appended to CHURN_HOOK_DIR/hook-<pid>.jsonl once a
// second, so the per-request cost is an object push. Inert without the env var.
import dc from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.CHURN_HOOK_DIR;
if (dir) {
  const file = path.join(dir, `hook-${process.pid}.jsonl`);
  const t0 = Date.now();
  let buf = [
    JSON.stringify({ e: 'proc', pid: process.pid, ppid: process.ppid, t: t0, argv: process.argv.slice(1).join(' ').slice(0, 400) }),
  ];
  let nextId = 1;
  const flush = () => {
    if (buf.length === 0) return;
    const out = buf.join('\n') + '\n';
    buf = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, out);
    } catch {
      /* a diagnostic must never take the process down */
    }
  };
  setInterval(flush, 1000).unref();
  process.on('exit', flush);

  const rec = (o) => {
    o.t = Date.now();
    buf.push(JSON.stringify(o));
  };
  const trimPath = (p) => {
    if (typeof p !== 'string') return '';
    const q = p.indexOf('?');
    return (q >= 0 ? p.slice(0, q) + '?' : p).slice(0, 160);
  };

  const track = (s, dirn) => {
    if (s.__churn) return s.__churn;
    const st = { id: nextId++, dirn, peerFirst: false, localFirst: false, nReq: 0, lp: 0, rp: 0 };
    s.__churn = st;
    const origEnd = s.end;
    const origDestroy = s.destroy;
    s.end = function (...a) {
      if (!st.peerFirst && !st.localFirst) st.localFirst = 'end';
      return origEnd.apply(this, a);
    };
    s.destroy = function (...a) {
      if (!st.peerFirst && !st.localFirst) st.localFirst = a[0] ? 'destroy-err' : 'destroy';
      return origDestroy.apply(this, a);
    };
    s.on('end', () => {
      if (!st.localFirst) st.peerFirst = true;
    });
    s.once('close', (hadError) => {
      rec({
        e: 'x',
        id: st.id,
        d: dirn,
        lp: st.lp || s.localPort,
        rp: st.rp || s.remotePort,
        closer: st.peerFirst ? 'peer' : st.localFirst || '?',
        err: hadError ? 1 : 0,
        n: st.nReq,
      });
    });
    return st;
  };

  dc.subscribe('net.client.socket', ({ socket }) => {
    const st = track(socket, 'out');
    socket.once('connect', () => {
      st.lp = socket.localPort;
      st.rp = socket.remotePort;
      rec({ e: 'oc', id: st.id, lp: st.lp, rp: st.rp, ra: socket.remoteAddress });
    });
  });
  dc.subscribe('net.server.socket', ({ socket }) => {
    const st = track(socket, 'in');
    st.lp = socket.localPort;
    st.rp = socket.remotePort;
    rec({ e: 'ic', id: st.id, lp: st.lp, rp: st.rp });
  });

  dc.subscribe('http.client.request.start', ({ request }) => {
    const m = request.method;
    const p = trimPath(request.path);
    const target = request.getHeader?.('x-amz-target');
    // 'start' is published once the request is being written, so the socket is
    // usually attached already; fall back to the event if it is not.
    const onSock = (socket) => {
      const st = track(socket, 'out');
      st.nReq++;
      const idx = st.nReq;
      rec({ e: 'rq', id: st.id, i: idx, m, p, a: target ? String(target).split('.').pop() : undefined, reused: request.reusedSocket ? 1 : 0 });
      request.once('close', () => {
        const res = request.res;
        rec({ e: 'rqc', id: st.id, i: idx, s: res?.statusCode ?? 0, done: res?.complete ? 1 : 0 });
      });
    };
    if (request.socket) onSock(request.socket);
    else request.once('socket', onSock);
  });

  dc.subscribe('http.server.request.start', ({ request, response, socket }) => {
    const st = track(socket, 'in');
    st.nReq++;
    const idx = st.nReq;
    rec({ e: 'sr', id: st.id, i: idx, m: request.method, p: trimPath(request.url), c: request.headers.connection });
    response.once('close', () => {
      rec({ e: 'src', id: st.id, i: idx, s: response.statusCode, done: response.writableFinished ? 1 : 0 });
    });
  });
}
