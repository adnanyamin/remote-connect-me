/**
 * Protocol regression test for the host "reject" relay (session approval).
 *
 * Boots the real signaling server on an ephemeral port, connects a fake host
 * and viewer with valid JWTs, and asserts:
 *   1. peer-online is delivered to both sides
 *   2. host {type:'reject'} -> viewer gets {type:'error'} + close 4003, host stays open
 *   3. a non-host 'reject' is refused and doesn't disturb the host
 *   4. a host 'reject' with no reason applies the default message
 *
 * Run: node signaling/test/reject.test.js   (exit 0 = pass, 1 = fail)
 */
const PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.PORT = PORT;
process.env.SIGNALING_SECRET = 'test-secret-for-signaling-integration';

require('../server.js');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const SECRET = process.env.SIGNALING_SECRET;
const tokenFor = (role) =>
  jwt.sign({ sub: 'u_test', role, deviceId: 'd_test' }, SECRET, { expiresIn: 300 });

function connect(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    const received = [];
    let closeInfo = null;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: tokenFor(role) })));
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    ws.on('close', (code, reason) => { closeInfo = { code, reason: reason.toString() }; });
    ws.on('error', reject);
    const t = setInterval(() => {
      if (received.some((m) => m.type === 'ready')) {
        clearInterval(t);
        resolve({ ws, received, getClose: () => closeInfo });
      }
    }, 5);
    setTimeout(() => { clearInterval(t); reject(new Error('hello timeout: ' + role)); }, 2000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok -', msg); }

(async () => {
  const host = await connect('host');
  const viewer = await connect('viewer');
  await wait(50);
  assert(host.received.some((m) => m.type === 'peer-online'), 'host sees peer-online');
  assert(viewer.received.some((m) => m.type === 'peer-online'), 'viewer sees peer-online');

  host.ws.send(JSON.stringify({ type: 'reject', reason: 'host declined the connection' }));
  await wait(100);
  const err = viewer.received.find((m) => m.type === 'error');
  assert(err && err.message === 'host declined the connection', 'viewer got reject error with reason');
  assert(host.ws.readyState === WebSocket.OPEN, 'host socket stays open after reject');
  await wait(30);
  assert(viewer.getClose() && viewer.getClose().code === 4003, 'viewer closed with code 4003');

  const viewer2 = await connect('viewer');
  await wait(50);
  viewer2.received.length = 0;
  viewer2.ws.send(JSON.stringify({ type: 'reject' }));
  await wait(40);
  const refused = viewer2.received.find((m) => m.type === 'error');
  assert(refused && /only the host/.test(refused.message), 'non-host reject refused');
  assert(host.ws.readyState === WebSocket.OPEN, 'host unaffected by non-host reject');

  try { viewer2.ws.close(); } catch {}
  await wait(40);
  const viewer3 = await connect('viewer');
  await wait(50);
  host.ws.send(JSON.stringify({ type: 'reject' }));
  await wait(100);
  const def = viewer3.received.find((m) => m.type === 'error');
  assert(def && def.message === 'host declined the connection', 'default reject reason applied');

  try { host.ws.close(); } catch {}
  await wait(50);
  console.log('\n[OK] reject relay protocol test passed');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
