// Drive the running control window over the Chrome DevTools Protocol so the
// restructured UI can actually be exercised against the real card, rather than
// only checked for "it loaded without throwing".
const EXPR = process.argv[2];

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json');
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && /control\.html/.test(t.url || ''));
  if (!page) {
    console.error('control window not found. targets:', targets.map((t) => t.url).join(', '));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  const out = await new Promise((resolve, reject) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== 1) return;
      if (msg.result && msg.result.exceptionDetails) {
        reject(new Error(JSON.stringify(msg.result.exceptionDetails.exception || msg.result.exceptionDetails)));
      } else {
        resolve(msg.result && msg.result.result ? msg.result.result.value : null);
      }
    };
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: EXPR, awaitPromise: true, returnByValue: true },
    }));
    setTimeout(() => reject(new Error('timeout')), 20000);
  });
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  ws.close();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
