import http from 'node:http';
const srv = http.createServer((req, res) => { res.end('ok'); }).listen(9990, '127.0.0.1', async () => {
  await new Promise(r => setTimeout(r, 1500));
  const noKa = new http.Agent({ keepAlive: false });
  for (let i = 0; i < 50; i++) await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9990, agent: noKa, headers: { connection: 'close' } }, r => { r.resume(); r.on('end', res); }).on('error', rej));
  const ka = new http.Agent({ keepAlive: true });
  for (let i = 0; i < 50; i++) await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9990, agent: ka, path: '/ka' }, r => { r.resume(); r.on('end', res); }).on('error', rej));
  await new Promise(r => setTimeout(r, 1500));
  ka.destroy(); srv.close(); console.log('selftest done');
});
