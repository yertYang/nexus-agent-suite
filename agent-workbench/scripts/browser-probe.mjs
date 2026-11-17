// Probe the exact, private loopback endpoint before advertising Chromium as ready.
export function browserSocketReady(address, timeout = 900) {
  if (typeof address !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d{1,5}\/[a-f0-9]+$/.test(address)) return Promise.resolve(false);
  return new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(address); } catch { resolve(false); return; }
    const done = ready => { clearTimeout(timer); resolve(ready); ws.close(); };
    const timer = setTimeout(() => done(false), timeout);
    ws.addEventListener('open', () => done(true), { once:true });
    ws.addEventListener('error', () => done(false), { once:true });
  });
}
