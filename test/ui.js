'use strict';
// Drives the real client (public/app.js) in jsdom against the real server.
// jsdom can't render CSS or use the microphone, so those need a real-browser check.
const path = require('path');
const os = require('os');
const { JSDOM } = require('jsdom');
const { spawn } = require('child_process');
const assert = require('assert');

const PORT = 4100 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

async function until(fn, ms = 4000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(40);
  }
}

async function open(path) {
  const errors = [];
  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.fetch = (u, o) => fetch(new URL(u, BASE), o);
      w.URL.createObjectURL = () => '/blank';
      w.URL.revokeObjectURL = () => {};
      w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
      w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
      w.HTMLElement.prototype.scrollTo = () => {};
      w.scrollTo = () => {};
      w.__printed = 0;
      w.print = () => { w.__printed++; };
      w.confirm = () => true;
      w.addEventListener('error', (e) => errors.push(e.message));
    },
  });
  const w = dom.window;
  await until(() => w.document.readyState === 'complete', 5000, 'page load');
  await sleep(150);
  const $ = (s) => w.document.querySelector(s);
  const click = (s) => $(s).click();
  const check = (s) => { const el = $(s); el.checked = true; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const visible = (s) => !$(s).hidden;
  return { dom, w, $, click, check, visible, errors };
}

async function passGate(c, { named, prechecked } = {}) {
  if (named) {
    const r = c.$('input[name="idmode"][value="named"]');
    r.checked = true;
    r.dispatchEvent(new c.w.Event('change', { bubbles: true }));
    if (prechecked) assert.ok(c.$('#gateGo').disabled, 'named mode with an empty name stays disabled');
    const n = c.$('#nameInput');
    n.value = named;
    n.dispatchEvent(new c.w.Event('input', { bubbles: true }));
  }
  if (!prechecked) {
    assert.ok(c.$('#gateGo').disabled, 'Continue must start disabled');
    c.check('#ageOk');
    assert.ok(c.$('#gateGo').disabled, 'needs both checkboxes');
    c.check('#termsOk');
  }
  assert.ok(!c.$('#gateGo').disabled, 'enabled after both boxes');
  c.click('#gateGo');
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CHAT_SECONDS: '8', REPORT_DIR: path.join(os.tmpdir(), 'blip-ui-reports') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* wait */ } await sleep(100); }

  let A; let B; let roomId; let tokenA;

  await test('home page renders with the live clock and both actions', async () => {
    A = await open('/');
    assert.ok(A.visible('#screen-home'));
    assert.ok(/Talk for 60 seconds/.test(A.$('h1').textContent));
    const n0 = A.$('#homeNum').textContent;
    await sleep(1300);
    assert.notStrictEqual(A.$('#homeNum').textContent, n0, 'clock should tick');
    assert.ok(A.$('#btnShare') && A.$('#btnPrint'));
  });

  await test('Share QR code opens the warning gate before anything is created', async () => {
    A.click('#btnShare');
    assert.ok(A.visible('#screen-gate'));
    assert.ok(/Start a chat/.test(A.$('#gateTitle').textContent));
    assert.ok(/anonymous/i.test(A.$('#screen-gate').textContent));
    assert.ok(/18 or older/.test(A.$('#screen-gate').textContent));
  });

  await test('named identity needs a name; then creator lands in a waiting room with a QR code', async () => {
    A.check('#ageOk'); A.check('#termsOk');
    await passGate(A, { named: 'Mo', prechecked: true });
    await until(() => A.visible('#screen-room'), 4000, 'room screen');
    await until(() => A.visible('#waiting'), 4000, 'waiting panel');
    roomId = A.w.location.pathname.split('/').pop();
    assert.match(roomId, /^[a-z0-9]{12}$/);
    await until(() => A.$('#qrImg').getAttribute('src'), 4000, 'QR image src');
    assert.ok(A.$('#timerNum').textContent.trim() === '–', 'timer idle while waiting');
    assert.ok(A.$('#composer').hasAttribute('data-off'), 'composer disabled while waiting');
    tokenA = JSON.parse(A.w.sessionStorage.getItem('blip.session')).token;
    assert.ok(tokenA);
  });

  await test('the share action ran automatically and told the user what to do', async () => {
    await until(() => /QR code is ready|Tap Share|Link copied/.test(A.$('#toast').textContent), 3000, 'toast');
  });

  await test('guest opens the link, sees the gate, joins anonymously', async () => {
    B = await open(`/r/${roomId}`);
    assert.ok(B.visible('#screen-gate'));
    assert.ok(/invited/.test(B.$('#gateTitle').textContent));
    await until(() => /60 seconds start as soon as you join/.test(B.$('#gateSub').textContent), 3000, 'join subtitle');
    await passGate(B);
    await until(() => B.visible('#screen-room'), 4000, 'guest room');
  });

  await test('both screens go live: waiting panel hides and the countdown runs', async () => {
    await until(() => !A.visible('#waiting') || A.$('#waiting').hidden, 4000, 'A leaves waiting');
    await until(() => /^0:0[5-8]$/.test(A.$('#timerNum').textContent.trim()), 4000, 'A countdown');
    await until(() => /^0:0[5-8]$/.test(B.$('#timerNum').textContent.trim()), 4000, 'B countdown');
    assert.ok(!A.$('#composer').hasAttribute('data-off'));
    assert.ok(/Quiet|Brave|Sunny|Mellow|Swift|Cosmic|Gentle|Plucky|Velvet|Zesty|Cozy|Nimble|Witty|Lucky|Breezy|Fuzzy/.test(
      [...A.w.document.querySelectorAll('.sysmsg')].map((e) => e.textContent).join(' ')), 'anonymous alias announced');
  });

  await test('messages appear on the other screen as plain text (no HTML injection)', async () => {
    const input = B.$('#msgInput');
    input.value = '<img src=x onerror="window.pwned=1"> hi';
    B.$('#composer').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => [...A.w.document.querySelectorAll('.msg')].some((m) => m.textContent.includes('hi')), 3000, 'A sees message');
    assert.ok(!A.w.document.querySelector('#log img'), 'must not create an <img>');
    assert.ok(!A.w.pwned);
    assert.ok(B.$('.msg.mine'), 'own bubble marked mine');
  });

  await test('shared picture is hidden until tapped; PDF and voice note render', async () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
    const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 5)]);
    const up = (kind, body, extra = '') => fetch(`${BASE}/api/rooms/${roomId}/upload?token=${tokenA}&kind=${kind}${extra}`, { method: 'POST', body });
    assert.strictEqual((await up('image', PNG)).status, 200);
    assert.strictEqual((await up('pdf', PDF, '&name=report.pdf')).status, 200);
    assert.strictEqual((await up('audio', WEBM, '&dur=5')).status, 200);
    await until(() => B.w.document.querySelector('#log .pic.veiled'), 3000, 'veiled picture');
    const pic = B.w.document.querySelector('#log .pic');
    assert.ok(pic.classList.contains('veiled'));
    pic.click();
    assert.ok(!pic.classList.contains('veiled'), 'tap reveals');
    await until(() => B.w.document.querySelector('#log a.filecard'), 3000, 'pdf card');
    assert.ok(/report\.pdf/.test(B.w.document.querySelector('a.filecard').textContent));
    assert.ok(B.w.document.querySelector('a.filecard').hasAttribute('download'));
    await until(() => B.w.document.querySelector('#log audio'), 3000, 'audio');
    assert.ok(B.w.document.querySelector('#log audio').getAttribute('src').startsWith(`/f/${roomId}/`));
  });

  await test('people list shows both, with hide and report controls for the other person', async () => {
    B.click('#peopleBtn');
    assert.ok(B.$('#peopleDlg').hasAttribute('open'));
    assert.strictEqual(B.w.document.querySelectorAll('#peopleList li').length, 2);
    assert.ok(B.$('#peopleList').textContent.includes('Mo'));
    assert.ok(B.$('#peopleList').textContent.includes('(you)'));
    B.$('#peopleList button.btn').click(); // hide Mo
    await sleep(50);
    assert.ok([...B.w.document.querySelectorAll('#log .msg')].every((m) => m.dataset.from !== undefined));
    B.$('#peopleDlg').close();
  });

  await test('the extend bar appears near the end and adding time works', async () => {
    await until(() => A.visible('#extendBar'), 8000, 'extend bar');
    const before = A.$('#timerNum').textContent.trim();
    A.click('#extendBtn');
    await until(() => !A.visible('#extendBar') || A.$('#extendBar').hidden, 3000, 'extend bar hides');
    await until(() => [...A.w.document.querySelectorAll('.sysmsg')].some((e) => /added 8 seconds/.test(e.textContent)), 3000, 'system note');
    assert.ok(/^0:(0[5-9]|1[0-6])$/.test(A.$('#timerNum').textContent.trim()), `timer ${before} -> ${A.$('#timerNum').textContent}`);
  });

  await test('leaving shows the ended screen and clears the stored session', async () => {
    B.click('#leaveBtn');
    await until(() => B.visible('#screen-ended'), 3000, 'B ended');
    assert.ok(/You left/.test(B.$('#endedTitle').textContent));
    assert.strictEqual(B.w.sessionStorage.getItem('blip.session'), null);
    assert.strictEqual(B.w.document.querySelectorAll('#log .msg').length, 0, 'messages cleared from the page');
  });

  await test('the other person is told when the room runs out of time', async () => {
    await until(() => A.visible('#screen-ended'), 20000, 'A ended');
    assert.ok(/Time|Everyone left/.test(A.$('#endedTitle').textContent), A.$('#endedTitle').textContent);
    assert.ok(/erased/.test(A.$('#endedText').textContent));
    assert.strictEqual(A.w.location.pathname, '/');
  });

  await test('Print QR code flow opens the print dialog once the code is ready', async () => {
    const C = await open('/');
    C.click('#btnPrint');
    await passGate(C);
    await until(() => C.visible('#screen-room'), 4000, 'room');
    await until(() => C.w.__printed > 0, 5000, 'print called');
    assert.ok(/\/r\/[a-z0-9]{12}$/.test(C.$('#printUrl').textContent));
    assert.ok(C.$('#printQr').getAttribute('src'));
  });

  await test('visiting a dead link explains what happened', async () => {
    const D = await open('/r/zzzzzzzzzzzz');
    await until(() => D.visible('#screen-ended'), 4000, 'dead link');
    assert.ok(/ended/.test(D.$('#endedTitle').textContent));
  });

  await test('no uncaught script errors on any page', async () => {
    for (const c of [A, B]) assert.deepStrictEqual(c.errors, []);
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  server.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
