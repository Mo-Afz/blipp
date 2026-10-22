'use strict';

// Drives the real server: accounts, founder spots, invites, poster scans, refunds,
// payments (against a fake Stripe) and restarts.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const WebSocket = require('ws');
const Stripe = require('stripe');

const PORT = 4300 + Math.floor(Math.random() * 90);
const MOCK_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-data-'));
const REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-rep-'));
const WEBHOOK_SECRET = 'whsec_test_secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

/* ---- a fake Stripe that records what the server asks it to create ---- */
const stripeCalls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/checkout/sessions')) {
      const params = Object.fromEntries(new URLSearchParams(body));
      stripeCalls.push({ auth: req.headers.authorization, params });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ id: `cs_test_${stripeCalls.length}`, object: 'checkout.session', url: `https://checkout.stripe.test/pay/cs_test_${stripeCalls.length}` }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
});

/* ---- helpers ---- */
let server;
let serverLog = '';
function startServer(extraEnv = {}, dir = DATA_DIR) {
  server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dir,
      REPORT_DIR,
      FOUNDER_LIMIT: '3',
      FREE_SCANS: '3',
      DEVICE_PER_HOUR: '50',
      CLAIMS_PER_HOUR: '50',
      CHAT_SECONDS: '6',
      POSTER_LOBBY_SECONDS: '3',
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_HOST: `http://127.0.0.1:${MOCK_PORT}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
}
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((r) => { s.on('exit', r); s.kill('SIGTERM'); setTimeout(r, 3000); });
}

async function call(method, url, { auth, body, headers } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
const newDevice = async () => (await call('POST', '/api/device')).body; // { id, secret: "id.secret" }
const me = async (dev) => (await call('GET', '/api/me', { auth: dev.secret })).body;

function client(roomId, join = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: BASE } });
  const c = { ws, msgs: [] };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  c.ready = new Promise((res, rej) => {
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: roomId, ...join })); res(); });
    ws.on('error', rej);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = c.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for message (have: ${c.msgs.map((m) => m.t + (m.code ? `:${m.code}` : '') + (m.reason ? `:${m.reason}` : '')).join(',')})`);
      await sleep(25);
    }
  };
  return c;
}

const stripeLib = new Stripe('sk_test_abc');
function signedWebhook(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripeLib.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload });
}
const paidEvent = (id, accountId, packId, cents, over = {}) => ({
  id: `evt_${id}`,
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id, object: 'checkout.session', payment_status: 'paid', amount_total: cents, currency: 'usd', metadata: { accountId, packId }, ...over } },
});

/* ---- the tests ---- */
async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  startServer();
  await waitUp();

  let A; let B; let C; let D; let E; let F;
  let posterId; let invite1; let invite2;

  await test('free spots start at 3 of 3 (limit set for the test)', async () => {
    const r = await call('GET', '/api/spots');
    assert.deepStrictEqual(r.body, { limit: 3, left: 3 });
  });

  await test('a new device gets an ID and secret, and has nothing yet', async () => {
    A = await newDevice();
    assert.ok(A.id && A.secret.startsWith(`${A.id}.`));
    const p = await me(A);
    assert.strictEqual(p.credits, 0);
    assert.strictEqual(p.starter, null);
    assert.strictEqual(p.paymentsEnabled, true);
  });

  await test('bad or missing credentials are refused', async () => {
    assert.strictEqual((await call('GET', '/api/me')).status, 401);
    assert.strictEqual((await call('GET', '/api/me', { auth: `${A.id}.wrong` })).status, 401);
    assert.strictEqual((await call('GET', '/api/me', { auth: 'nope' })).status, 401);
  });

  await test('claiming a free spot gives scans and 2 invites, once', async () => {
    const r = await call('POST', '/api/me/claim', { auth: A.secret });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.starter, 'founder');
    assert.strictEqual(r.body.founderNo, 1);
    assert.strictEqual(r.body.credits, 3);
    assert.strictEqual(r.body.invitesLeft, 2);
    assert.strictEqual((await call('POST', '/api/me/claim', { auth: A.secret })).body.error, 'already_claimed');
  });

  await test('only the first N people can claim; the next one is told the spots are gone', async () => {
    B = await newDevice(); C = await newDevice(); D = await newDevice();
    assert.strictEqual((await call('POST', '/api/me/claim', { auth: B.secret })).status, 200);
    assert.strictEqual((await call('POST', '/api/me/claim', { auth: C.secret })).body.founderNo, 3);
    const late = await call('POST', '/api/me/claim', { auth: D.secret });
    assert.strictEqual(late.status, 409);
    assert.strictEqual(late.body.error, 'spots_gone');
    assert.strictEqual((await me(D)).credits, 0);
    assert.deepStrictEqual((await call('GET', '/api/spots')).body, { limit: 3, left: 0 });
  });

  await test('creating a poster cleans the name and caps how many one person can have', async () => {
    const r = await call('POST', '/api/posters', { auth: A.secret, body: { label: '  Cafe​   Luna  ' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.posters[0].label, 'Cafe Luna');
    posterId = r.body.posters[0].id;
    for (let i = 0; i < 4; i++) assert.strictEqual((await call('POST', '/api/posters', { auth: A.secret, body: { label: `P${i}` } })).status, 201);
    assert.strictEqual((await call('POST', '/api/posters', { auth: A.secret, body: { label: 'six' } })).body.error, 'too_many_posters');
    // tidy up so later numbers stay simple
    const list = (await me(A)).posters;
    for (const p of list.filter((x) => x.id !== posterId)) await call('DELETE', `/api/posters/${p.id}`, { auth: A.secret });
    assert.strictEqual((await me(A)).posters.length, 1);
  });

  await test('anyone can look up a poster without seeing the owner’s balance', async () => {
    const r = await call('GET', `/api/posters/${posterId}`);
    assert.deepStrictEqual(r.body, { exists: true, label: 'Cafe Luna', open: true });
    assert.deepStrictEqual((await call('GET', '/api/posters/zzzzzzzzzzzz')).body, { exists: false });
  });

  let roomId1;
  let guest1;
  let host1;
  let hostTab;
  await test('a scan opens its own chat, costs one scan, and shows in the owner’s inbox', async () => {
    const r = await call('POST', `/api/posters/${posterId}/scan`);
    assert.strictEqual(r.status, 201);
    roomId1 = r.body.room;
    assert.match(roomId1, /^[a-z0-9]{12}$/);
    const p = await me(A);
    assert.strictEqual(p.credits, 2);
    assert.strictEqual(p.posters[0].scansUsed, 1);
    const s = await call('GET', '/api/me/sessions', { auth: A.secret });
    assert.strictEqual(s.body.sessions.length, 1);
    assert.strictEqual(s.body.sessions[0].room, roomId1);
    assert.strictEqual(s.body.sessions[0].status, 'waiting');
    assert.strictEqual((await call('GET', '/api/me/sessions', { auth: B.secret })).body.sessions.length, 0, 'other people see nothing');
  });

  await test('the scanner joins and waits; nobody else can take the second seat', async () => {
    guest1 = client(roomId1, { anon: true });
    await guest1.ready;
    const w = await guest1.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(w.state.poster.label, 'Cafe Luna');
    assert.strictEqual(w.state.status, 'waiting');
    assert.strictEqual(w.you.host, false);
    const second = client(roomId1, { anon: true });
    await second.ready;
    assert.strictEqual((await second.waitFor((m) => m.t === 'error')).code, 'full');
    const pretender = client(roomId1, { owner: `${A.id}.not-the-secret`, anon: true });
    await pretender.ready;
    assert.strictEqual((await pretender.waitFor((m) => m.t === 'error')).code, 'full', 'a wrong secret does not make you the host');
    const other = client(roomId1, { owner: B.secret });
    await other.ready;
    assert.strictEqual((await other.waitFor((m) => m.t === 'error')).code, 'full', 'another account is not the host either');
  });

  await test('the owner joins with their secret as host and the clock starts', async () => {
    host1 = client(roomId1, { owner: A.secret });
    await host1.ready;
    const w = await host1.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(w.you.host, true);
    assert.strictEqual(w.you.alias, 'Cafe Luna');
    await host1.waitFor((m) => m.t === 'state' && m.status === 'live');
    await guest1.waitFor((m) => m.t === 'state' && m.status === 'live');
    host1.send({ t: 'msg', text: 'hi there' });
    assert.strictEqual((await guest1.waitFor((m) => m.t === 'msg' && m.text)).text, 'hi there');
  });

  await test('the same owner on a second tab takes over the same seat', async () => {
    const tab2 = client(roomId1, { owner: A.secret });
    await tab2.ready;
    const w = await tab2.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(w.you.id, (await host1.waitFor((m) => m.t === 'welcome')).you.id);
    assert.strictEqual(w.people.length, 2);
    // the first tab is closed by the server: only one tab holds the seat at a time
    await sleep(200);
    assert.notStrictEqual(host1.ws.readyState, WebSocket.OPEN);
    hostTab = tab2;
  });

  await test('when the owner leaves a live chat, the scanner is told and the scan is not refunded', async () => {
    hostTab.send({ t: 'leave' });
    const e = await guest1.waitFor((m) => m.t === 'ended');
    assert.strictEqual(e.reason, 'peer_left');
    assert.strictEqual((await me(A)).credits, 2);
  });

  const rooms = [];
  await test('the same person can scan again and again until the scans run out', async () => {
    const r2 = await call('POST', `/api/posters/${posterId}/scan`);
    const r3 = await call('POST', `/api/posters/${posterId}/scan`);
    assert.strictEqual(r2.status, 201);
    assert.strictEqual(r3.status, 201);
    assert.notStrictEqual(r2.body.room, r3.body.room);
    rooms.push(r2.body.room, r3.body.room);
    const r4 = await call('POST', `/api/posters/${posterId}/scan`);
    assert.strictEqual(r4.status, 409);
    assert.strictEqual(r4.body.error, 'out_of_scans');
    assert.strictEqual((await call('GET', `/api/posters/${posterId}`)).body.open, false);
    assert.strictEqual((await me(A)).credits, 0);
  });

  await test('a scan that never becomes a chat is given back (scanner leaves, or owner never shows)', async () => {
    const g = client(rooms[0], { anon: true });
    await g.ready;
    await g.waitFor((m) => m.t === 'welcome');
    g.send({ t: 'leave' });
    g.ws.close();
    // the second scan is left alone until its 3 second wait runs out
    const e = client(rooms[1], { anon: true });
    await e.ready;
    await e.waitFor((m) => m.t === 'welcome');
    assert.strictEqual((await e.waitFor((m) => m.t === 'ended', 6000)).reason, 'lobby');
    await sleep(150);
    const p = await me(A);
    assert.strictEqual(p.credits, 2, `credits ${p.credits}`);
    assert.strictEqual(p.posters[0].scansUsed, 1);
  });

  await test('a poster only lets a handful of chats wait at once', async () => {
    // Give the owner a bigger balance with a purchase so only the waiting cap can stop them.
    const ev = await signedWebhook(paidEvent('cs_big', A.id, 's100', 700));
    assert.strictEqual(ev.status, 200);
    const made = [];
    for (let i = 0; i < 5; i++) made.push((await call('POST', `/api/posters/${posterId}/scan`)).status);
    assert.deepStrictEqual(made, [201, 201, 201, 201, 201]);
    const sixth = await call('POST', `/api/posters/${posterId}/scan`);
    assert.strictEqual(sixth.status, 429);
    assert.strictEqual(sixth.body.error, 'busy');
    await sleep(3500); // let them expire so they refund
  });

  await test('founders can make 2 invite links and no more', async () => {
    const r1 = await call('POST', '/api/me/invites', { auth: A.secret });
    const r2 = await call('POST', '/api/me/invites', { auth: A.secret });
    assert.strictEqual(r1.status, 201);
    invite1 = r1.body.invites[0].code;
    invite2 = r2.body.invites[1].code;
    assert.strictEqual(r2.body.invitesLeft, 0);
    assert.strictEqual((await call('POST', '/api/me/invites', { auth: A.secret })).body.error, 'no_invites_left');
    assert.deepStrictEqual((await call('GET', `/api/invites/${invite1}`)).body, { valid: true, freeScans: 3 });
  });

  await test('an invite gives a new person free scans once; it can’t be used on yourself or twice', async () => {
    assert.strictEqual((await call('POST', `/api/invites/${invite1}/redeem`, { auth: A.secret })).body.error, 'own_invite');
    E = await newDevice();
    const ok = await call('POST', `/api/invites/${invite1}/redeem`, { auth: E.secret });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.starter, 'invite');
    assert.strictEqual(ok.body.credits, 3);
    assert.strictEqual(ok.body.invitesLeft, 0, 'invited people don’t get invites by default');
    F = await newDevice();
    assert.strictEqual((await call('POST', `/api/invites/${invite1}/redeem`, { auth: F.secret })).body.error, 'invite_invalid');
    assert.deepStrictEqual((await call('GET', `/api/invites/${invite1}`)).body.valid, false);
    assert.strictEqual((await call('POST', `/api/invites/${invite2}/redeem`, { auth: E.secret })).body.error, 'already_claimed');
    assert.strictEqual((await call('GET', `/api/invites/${invite2}`)).body.valid, true, 'a refused redeem doesn’t burn the link');
    assert.strictEqual((await call('POST', '/api/me/invites', { auth: E.secret })).body.error, 'no_invites_left');
  });

  await test('someone who already took a founder spot can’t also take an invite', async () => {
    assert.strictEqual((await call('POST', `/api/invites/${invite2}/redeem`, { auth: B.secret })).body.error, 'already_claimed');
  });

  await test('only the owner can delete a poster; scans then stop working', async () => {
    assert.strictEqual((await call('DELETE', `/api/posters/${posterId}`, { auth: B.secret })).status, 404);
    assert.strictEqual((await call('DELETE', `/api/posters/${posterId}`, { auth: A.secret })).status, 200);
    assert.strictEqual((await call('GET', `/api/posters/${posterId}`)).body.exists, false);
    assert.strictEqual((await call('POST', `/api/posters/${posterId}/scan`)).status, 404);
  });

  await test('the poster QR image works for a real poster and 404s otherwise', async () => {
    const p = (await call('POST', '/api/posters', { auth: A.secret, body: { label: 'Stall' } })).body.posters[0];
    const r = await fetch(`${BASE}/qr/p/${p.id}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<svg'));
    assert.strictEqual((await fetch(`${BASE}/qr/p/zzzzzzzzzzzz`)).status, 404);
  });

  await test('the page routes for posters, invites and the dashboard all serve the app', async () => {
    for (const p of ['/me', '/recover', '/p/abcdefghjkmn', '/i/abcdefghjk']) {
      const r = await fetch(BASE + p);
      assert.strictEqual(r.status, 200, p);
      assert.ok((await r.text()).includes('<title>Blip'));
      assert.ok(/noindex/.test(r.headers.get('x-robots-tag')));
    }
  });

  /* ---------------- payments ---------------- */
  await test('checkout needs a sign-in and a real pack', async () => {
    assert.strictEqual((await call('POST', '/api/checkout', { body: { pack: 's100' } })).status, 401);
    assert.strictEqual((await call('POST', '/api/checkout', { auth: A.secret, body: { pack: 'free-lunch' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/checkout', { auth: A.secret, body: { pack: 's100', cents: 1 } })).status, 200, 'extra fields from the browser are ignored');
  });

  await test('checkout asks Stripe for the server’s price, not one from the browser', async () => {
    stripeCalls.length = 0;
    const r = await call('POST', '/api/checkout', { auth: A.secret, body: { pack: 's100', cents: 1, amount: 1 } });
    assert.strictEqual(r.status, 200);
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_/);
    assert.strictEqual(stripeCalls.length, 1);
    const { auth, params } = stripeCalls[0];
    assert.strictEqual(auth, 'Bearer sk_test_abc');
    assert.strictEqual(params.mode, 'payment');
    assert.strictEqual(params['line_items[0][price_data][unit_amount]'], '700');
    assert.strictEqual(params['line_items[0][price_data][currency]'], 'usd');
    assert.strictEqual(params['metadata[accountId]'], A.id);
    assert.strictEqual(params['metadata[packId]'], 's100');
    assert.strictEqual(params.client_reference_id, A.id);
    assert.ok(params.success_url.endsWith('/me?paid=1'));
    assert.ok(params.cancel_url.endsWith('/me'));
  });

  await test('the webhook refuses unsigned, wrongly signed and tampered requests', async () => {
    const ev = paidEvent('cs_x1', A.id, 's20', 200);
    const before = (await me(A)).credits;
    const none = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
    assert.strictEqual(none.status, 400);
    assert.strictEqual((await signedWebhook(ev, 'whsec_someone_else')).status, 400);
    const payload = JSON.stringify(ev);
    const header = stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const tampered = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload.replace('"s20"', '"s500"') });
    assert.strictEqual(tampered.status, 400);
    assert.strictEqual((await me(A)).credits, before);
  });

  await test('a paid, signed purchase adds the scans exactly once, even if Stripe retries', async () => {
    const before = (await me(A)).credits;
    const ev = paidEvent('cs_ok1', A.id, 's20', 200);
    assert.strictEqual((await signedWebhook(ev)).status, 200);
    assert.strictEqual((await me(A)).credits, before + 20);
    assert.strictEqual((await signedWebhook(ev)).status, 200);
    assert.strictEqual((await signedWebhook(ev)).status, 200);
    assert.strictEqual((await me(A)).credits, before + 20, 'replays don’t add again');
  });

  await test('purchases with the wrong amount, an unknown pack, an unknown account or no payment are ignored', async () => {
    const before = (await me(A)).credits;
    await signedWebhook(paidEvent('cs_bad1', A.id, 's500', 1));
    await signedWebhook(paidEvent('cs_bad2', A.id, 'made-up', 200));
    await signedWebhook(paidEvent('cs_bad3', 'nobody', 's20', 200));
    await signedWebhook(paidEvent('cs_bad4', A.id, 's20', 200, { payment_status: 'unpaid' }));
    await signedWebhook(paidEvent('cs_bad5', A.id, 's20', 200, { currency: 'eur' }));
    assert.strictEqual((await me(A)).credits, before);
    // unrelated event types are accepted and ignored
    assert.strictEqual((await signedWebhook({ id: 'evt_other', object: 'event', type: 'charge.refunded', data: { object: {} } })).status, 200);
    assert.strictEqual((await me(A)).credits, before);
  });

  /* ---------------- saving and restarts ---------------- */
  let snapshot;
  await test('accounts, posters, credits, invites and the spot count survive a restart', async () => {
    snapshot = await me(A);
    const spotsBefore = (await call('GET', '/api/spots')).body;
    await stopServer();
    const file = path.join(DATA_DIR, 'blip-data.json');
    assert.ok(fs.existsSync(file), 'data file written on shutdown');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(A.secret.split('.')[1]), 'the secret itself is never stored, only its hash');
    startServer();
    await waitUp();
    const after = await me(A);
    assert.deepStrictEqual(after, snapshot);
    assert.deepStrictEqual((await call('GET', '/api/spots')).body, spotsBefore);
    assert.strictEqual((await me(E)).starter, 'invite');
    // a payment already counted is still remembered after the restart
    const credits = after.credits;
    assert.strictEqual((await signedWebhook(paidEvent('cs_ok1', A.id, 's20', 200))).status, 200);
    assert.strictEqual((await me(A)).credits, credits);
  });

  await test('a damaged data file is set aside, not overwritten, and the server still starts', async () => {
    await stopServer();
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-data2-'));
    fs.writeFileSync(path.join(dir2, 'blip-data.json'), '{ this is not json');
    startServer({}, dir2);
    await waitUp();
    assert.strictEqual((await call('GET', '/api/spots')).body.left, 3);
    assert.ok(fs.readdirSync(dir2).some((f) => f.includes('.corrupt-')), 'kept a copy of the broken file');
    await stopServer();
  });

  await test('with no Stripe keys, buying is switched off and says so', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-data3-'));
    startServer({ STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }, dir3);
    await waitUp();
    const dev = await newDevice();
    assert.strictEqual((await me(dev)).paymentsEnabled, false);
    assert.strictEqual((await call('POST', '/api/checkout', { auth: dev.secret, body: { pack: 's20' } })).body.error, 'payments_off');
    const w = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(w.status, 503);
    // the invite-only and founder parts still work with payments off
    assert.strictEqual((await call('POST', '/api/me/claim', { auth: dev.secret })).status, 200);
  });

  await test('bad JSON from the browser gets a tidy error, not a crash', async () => {
    const dev = await newDevice();
    const r = await fetch(`${BASE}/api/posters`, { method: 'POST', headers: { Authorization: `Bearer ${dev.secret}`, 'Content-Type': 'application/json' }, body: '{oops' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await r.json(), { error: 'bad_request' });
    assert.ok((await fetch(`${BASE}/healthz`)).ok);
  });

  await test('the server log never contains a secret', async () => {
    assert.ok(!serverLog.includes(A.secret.split('.')[1]));
    assert.ok(!serverLog.includes('sk_test_abc'));
    assert.ok(!serverLog.includes(WEBHOOK_SECRET));
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  await stopServer();
  mock.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
