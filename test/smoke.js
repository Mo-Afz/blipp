'use strict';

// End-to-end smoke test: starts the real server with a short timer and drives it
// with real WebSocket clients and HTTP uploads.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-reports-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let server;
let passed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ok   ${name}`);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push(`  FAIL ${name}\n       ${e && e.message}`);
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
    process.exitCode = 1;
  }
}

function client(roomId, join = {}, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: headers || { Origin: BASE } });
  const c = { ws, msgs: [] };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  c.ready = new Promise((res, rej) => {
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: roomId, ...join })); res(); });
    ws.on('error', rej);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = c.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for message (have: ${c.msgs.map((m) => m.t).join(',')})`);
      await sleep(25);
    }
  };
  return c;
}

async function createRoom() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
  return { status: r.status, body: await r.json() };
}

async function upload(roomId, token, kind, body, extra = '') {
  return fetch(`${BASE}/api/rooms/${roomId}/upload?token=${token}&kind=${kind}${extra}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
}

async function main() {
  server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CHAT_SECONDS: '6',
      LOBBY_MINUTES: '0.05',
      CREATE_PER_HOUR: '9',
      REPORT_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const room = (await createRoom()).body.id;
  let a;
  let b;
  let aTok;
  let bTok;
  let png;
  let aId;
  let liveEnds;

  await test('static page and security headers', async () => {
    const r = await fetch(`${BASE}/r/${room}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('Blip'));
    assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(/noindex/.test(r.headers.get('x-robots-tag')));
  });

  await test('QR code endpoint returns SVG for a live room only', async () => {
    const ok = await fetch(`${BASE}/qr/${room}`);
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.headers.get('content-type').includes('image/svg+xml'));
    assert.ok((await ok.text()).includes('<svg'));
    assert.strictEqual((await fetch(`${BASE}/qr/zzzzzzzzzzzz`)).status, 404);
  });

  await test('room lookup reports waiting state', async () => {
    const j = await (await fetch(`${BASE}/api/rooms/${room}`)).json();
    assert.deepStrictEqual([j.exists, j.status, j.people], [true, 'waiting', 0]);
  });

  await test('creator joins with a chosen name and sees a waiting room', async () => {
    a = client(room, { anon: false, name: '  Mo​  ' });
    await a.ready;
    const w = await a.waitFor((m) => m.t === 'welcome');
    aTok = w.token;
    aId = w.you.id;
    assert.strictEqual(w.you.alias, 'Mo');
    assert.strictEqual(w.you.anon, false);
    assert.strictEqual(w.state.status, 'waiting');
  });

  await test('typing is blocked until someone joins', async () => {
    a.send({ t: 'msg', text: 'anyone?' });
    await sleep(150);
    assert.ok(!a.msgs.some((m) => m.t === 'msg'));
  });

  await test('guest joins anonymously and the 60s clock starts for both', async () => {
    b = client(room, { anon: true });
    await b.ready;
    const w = await b.waitFor((m) => m.t === 'welcome');
    bTok = w.token;
    assert.strictEqual(w.you.anon, true);
    assert.ok(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(w.you.alias), `alias ${w.you.alias}`);
    const live = await a.waitFor((m) => m.t === 'state' && m.status === 'live');
    liveEnds = live.endsAt;
    const left = live.endsAt - live.now;
    assert.ok(left > 5000 && left <= 6000, `remaining ${left}`);
    await b.waitFor((m) => m.t === 'state' && m.status === 'live');
  });

  await test('text messages reach everyone, sender included', async () => {
    a.send({ t: 'msg', text: 'hello <b>there</b>' });
    const got = await b.waitFor((m) => m.t === 'msg' && m.text);
    assert.strictEqual(got.text, 'hello <b>there</b>');
    await a.waitFor((m) => m.t === 'msg' && m.text);
  });

  await test('image upload is sniffed, broadcast and served with safe headers', async () => {
    const r = await upload(room, aTok, 'image', PNG, '&name=evil.html');
    assert.strictEqual(r.status, 200);
    const m = await b.waitFor((x) => x.t === 'msg' && x.file && x.file.kind === 'image');
    assert.strictEqual(m.file.mime, 'image/png');
    assert.strictEqual(m.file.name, 'photo.png');
    png = m.file.id;
    const f = await fetch(`${BASE}/f/${room}/${png}`);
    assert.strictEqual(f.status, 200);
    assert.strictEqual(f.headers.get('content-type'), 'image/png');
    assert.strictEqual(f.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(f.headers.get('content-security-policy').includes('sandbox'));
    assert.deepStrictEqual(Buffer.from(await f.arrayBuffer()), PNG);
  });

  await test('voice note upload supports byte ranges (needed by Safari)', async () => {
    const r = await upload(room, bTok, 'audio', WEBM, '&dur=7');
    assert.strictEqual(r.status, 200);
    const m = await a.waitFor((x) => x.t === 'msg' && x.file && x.file.kind === 'audio');
    assert.strictEqual(m.file.dur, 7);
    const part = await fetch(`${BASE}/f/${room}/${m.file.id}`, { headers: { Range: 'bytes=0-9' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers.get('content-range'), `bytes 0-9/${WEBM.length}`);
    assert.strictEqual((await part.arrayBuffer()).byteLength, 10);
  });

  await test('PDF upload downloads as an attachment', async () => {
    const r = await upload(room, aTok, 'pdf', PDF, '&name=../../notes.pdf');
    assert.strictEqual(r.status, 200);
    const m = await b.waitFor((x) => x.t === 'msg' && x.file && x.file.kind === 'pdf');
    assert.ok(!m.file.name.includes('/'));
    const f = await fetch(`${BASE}/f/${room}/${m.file.id}`);
    assert.ok(f.headers.get('content-disposition').startsWith('attachment'));
  });

  await test('uploads that lie about their type are rejected', async () => {
    assert.strictEqual((await upload(room, aTok, 'image', Buffer.from('<script>alert(1)</script> padding padding'))).status, 415);
    assert.strictEqual((await upload(room, aTok, 'image', PDF)).status, 415);
    assert.strictEqual((await upload(room, aTok, 'pdf', PNG)).status, 415);
  });

  await test('oversized uploads are refused', async () => {
    const big = Buffer.concat([WEBM, Buffer.alloc(3 * 1024 * 1024)]);
    assert.strictEqual((await upload(room, bTok, 'audio', big)).status, 413);
  });

  await test('uploads without a valid token are refused', async () => {
    assert.strictEqual((await upload(room, 'nope', 'image', PNG)).status, 404);
  });

  await test('extending too early is refused', async () => {
    a.msgs.length = 0;
    a.send({ t: 'extend' });
    const e = await a.waitFor((m) => m.t === 'error');
    assert.strictEqual(e.code, 'extend_early');
  });

  await test('extending near the end adds time for everyone', async () => {
    const before = liveEnds;
    for (;;) {
      if (before - Date.now() < 2800) break;
      await sleep(50);
    }
    b.msgs.length = 0;
    b.send({ t: 'extend' });
    const s = await b.waitFor((m) => m.t === 'state' && m.endsAt > before);
    assert.ok(s.endsAt - before === 6000, `added ${s.endsAt - before}`);
    await a.waitFor((m) => m.t === 'sys' && /added 6 seconds/.test(m.text));
  });

  await test('message flood is rate limited', async () => {
    a.msgs.length = 0;
    for (let i = 0; i < 15; i++) a.send({ t: 'msg', text: `spam ${i}` });
    await a.waitFor((m) => m.t === 'error' && m.code === 'slow');
  });

  await test('a report is saved with the last text messages and no files', async () => {
    b.send({ t: 'report', reason: 'scam', target: aId });
    await b.waitFor((m) => m.t === 'reported');
    await sleep(150);
    const line = fs.readFileSync(path.join(REPORT_DIR, 'reports.jsonl'), 'utf8').trim().split('\n').pop();
    const rec = JSON.parse(line);
    assert.strictEqual(rec.reason, 'scam');
    assert.ok(rec.lastTextMessages.some((m) => m.text === 'hello <b>there</b>'));
    assert.ok(!JSON.stringify(rec).includes('photo.png'));
  });

  await test('a dropped guest can rejoin as the same person', async () => {
    const c = client(room, { anon: true });
    await c.ready;
    const w = await c.waitFor((m) => m.t === 'welcome');
    c.ws.close();
    await sleep(300);
    const c2 = client(room, { token: w.token });
    await c2.ready;
    const w2 = await c2.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(w2.you.id, w.you.id);
    assert.strictEqual(w2.you.alias, w.you.alias);
    c2.send({ t: 'leave' });
  });

  await test('chat ends on time, notifies everyone and erases files', async () => {
    const ended = await a.waitFor((m) => m.t === 'ended', 12000);
    assert.strictEqual(ended.reason, 'time');
    await b.waitFor((m) => m.t === 'ended');
    assert.strictEqual((await fetch(`${BASE}/f/${room}/${png}`)).status, 404);
    assert.strictEqual((await fetch(`${BASE}/qr/${room}`)).status, 404);
    assert.strictEqual((await (await fetch(`${BASE}/api/rooms/${room}`)).json()).exists, false);
    const late = client(room, { anon: true });
    await late.ready;
    assert.strictEqual((await late.waitFor((m) => m.t === 'ended')).reason, 'gone');
  });

  await test('a QR nobody scans expires', async () => {
    const id = (await createRoom()).body.id;
    const c = client(id, { anon: true });
    await c.ready;
    await c.waitFor((m) => m.t === 'welcome');
    assert.strictEqual((await c.waitFor((m) => m.t === 'ended', 6000)).reason, 'lobby');
  });

  await test('rooms cap out at 8 people', async () => {
    const id = (await createRoom()).body.id;
    const cs = [];
    for (let i = 0; i < 8; i++) {
      const c = client(id, { anon: true });
      await c.ready;
      await c.waitFor((m) => m.t === 'welcome');
      cs.push(c);
    }
    const ninth = client(id, { anon: true });
    await ninth.ready;
    const e = await ninth.waitFor((m) => m.t === 'error');
    assert.strictEqual(e.code, 'full');
    cs.forEach((c) => c.ws.close());
  });

  await test('cross-site websocket connections are rejected', async () => {
    const id = (await createRoom()).body.id;
    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'https://evil.example' } });
    const outcome = await new Promise((res) => {
      evil.on('open', () => res('open'));
      evil.on('unexpected-response', (_, r) => res(r.statusCode));
      evil.on('error', () => res('error'));
    });
    assert.notStrictEqual(outcome, 'open');
    void id;
  });

  await test('starting too many chats from one address is rate limited', async () => {
    let limited = false;
    for (let i = 0; i < 6; i++) {
      if ((await createRoom()).status === 429) { limited = true; break; }
    }
    assert.ok(limited);
  });

  console.log(`\n${passed}/${results.length} passed`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { if (server) server.kill('SIGTERM'); setTimeout(() => process.exit(process.exitCode || 0), 300); });
