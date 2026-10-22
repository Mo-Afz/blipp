'use strict';

/**
 * Blip — 60-second anonymous-by-choice chats you join by scanning a QR code.
 *
 * Everything lives in memory. When a chat ends (or the process restarts) the
 * messages, photos, PDFs and voice notes are gone. Nothing is written to disk
 * except the optional abuse reports a participant chooses to send.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

/* ------------------------------------------------------------------ config */

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const PORT = num(process.env.PORT, 3000);
const CHAT_MS = num(process.env.CHAT_SECONDS, 60) * 1000; // base length + each extension
const EXTEND_WINDOW_MS = Math.min(30000, Math.floor(CHAT_MS / 2)); // extend only near the end
const MAX_TOTAL_MS = num(process.env.MAX_TOTAL_MINUTES, 30) * 60000; // hard cap per chat
const LOBBY_MS = num(process.env.LOBBY_MINUTES, 15) * 60000; // how long a QR waits for a first guest
const RECONNECT_GRACE_MS = 15000;
const MAX_PEOPLE = num(process.env.MAX_PEOPLE, 8);
const MAX_ROOMS = num(process.env.MAX_ROOMS, 500);
const MAX_TEXT = 1000;
const MB = 1024 * 1024;
const LIMITS = { image: 5 * MB, pdf: 10 * MB, audio: 3 * MB };
const MAX_ROOM_BYTES = 30 * MB;
const MAX_STORE_BYTES = num(process.env.MAX_STORE_MB, 400) * MB;
const CREATE_PER_HOUR = num(process.env.CREATE_PER_HOUR, 12);
const REPORT_DIR = process.env.REPORT_DIR || path.join(__dirname, 'reports');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY ? num(process.env.TRUST_PROXY, 1) : 0;
const PUBLIC_DIR = path.join(__dirname, 'public');

const REPORT_REASONS = new Set([
  'harassment',
  'explicit',
  'scam',
  'child-safety',
  'other',
]);

/* --------------------------------------------------------------- utilities */

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789'; // no look-alike characters
function randomId(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}
const randomToken = () => crypto.randomBytes(18).toString('base64url');

function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000)).unref();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.n += 1;
    return e.n <= max;
  };
}
const createLimiter = makeLimiter(CREATE_PER_HOUR, 3600e3);
const lookupLimiter = makeLimiter(120, 60e3);
const socketLimiter = makeLimiter(60, 60e3);

function allow(person, key, max, windowMs) {
  const now = Date.now();
  const arr = (person.rl[key] || []).filter((t) => now - t < windowMs);
  const ok = arr.length < max;
  if (ok) arr.push(now);
  person.rl[key] = arr;
  return ok;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (TRUST_PROXY && xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - TRUST_PROXY)];
  }
  return req.socket.remoteAddress || 'unknown';
}

// Zero-width, bidi-override and control characters are stripped from anything
// a stranger types so they can't spoof names or hide text.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;

function cleanName(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function cleanText(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

const ADJECTIVES = ['Quiet', 'Brave', 'Sunny', 'Mellow', 'Swift', 'Cosmic', 'Gentle', 'Plucky', 'Velvet', 'Zesty', 'Cozy', 'Nimble', 'Witty', 'Lucky', 'Breezy', 'Fuzzy'];
const ANIMALS = ['Otter', 'Heron', 'Fox', 'Panda', 'Gecko', 'Lynx', 'Finch', 'Koala', 'Newt', 'Walrus', 'Badger', 'Moth', 'Orca', 'Ibis', 'Quokka', 'Lemur'];
const pick = (arr) => arr[crypto.randomInt(arr.length)];

function uniqueLabel(room, wanted) {
  const taken = new Set([...room.people.values()].map((p) => p.alias.toLowerCase()));
  let label = wanted;
  let n = 2;
  while (taken.has(label.toLowerCase())) label = `${wanted.slice(0, 20)} ${n++}`;
  return label;
}

function randomAlias(room) {
  for (let i = 0; i < 30; i++) {
    const a = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
    if (![...room.people.values()].some((p) => p.alias === a)) return a;
  }
  return uniqueLabel(room, 'Guest');
}

/* ------------------------------------------------------- file type sniffing */

// Never trust the browser's claimed type: look at the bytes.
function sniff(b) {
  if (b.length < 12) return null;
  const ascii = (s, e) => b.toString('latin1', s, e);
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (ascii(0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'audio', mime: 'audio/webm', ext: 'webm' };
  if (ascii(0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
  if (ascii(4, 8) === 'ftyp') return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

function safeFileName(raw, fallback) {
  const base = String(raw || '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return base || fallback;
}

/* -------------------------------------------------------------------- rooms */

/** @type {Map<string, any>} */
const rooms = new Map();
let storeBytes = 0;

function createRoom() {
  let id;
  do id = randomId(12);
  while (rooms.has(id));
  const room = {
    id,
    createdAt: Date.now(),
    status: 'waiting', // waiting -> live -> ended
    startedAt: 0,
    endsAt: 0,
    extensions: 0,
    people: new Map(), // personId -> person
    byToken: new Map(),
    files: new Map(),
    bytes: 0,
    recent: [], // last text messages, kept only so a report can include them
    endTimer: null,
    lobbyTimer: null,
    lobbyEndsAt: Date.now() + LOBBY_MS,
    reports: 0,
  };
  room.lobbyTimer = setTimeout(() => {
    if (room.status === 'waiting') endRoom(room, 'lobby');
  }, LOBBY_MS);
  rooms.set(id, room);
  return room;
}

const PALETTE_SIZE = 8;

function newPerson(room, name) {
  const alias = name ? uniqueLabel(room, name) : randomAlias(room);
  return {
    id: randomId(8),
    token: randomToken(),
    alias,
    anon: !name,
    color: room.people.size % PALETTE_SIZE,
    ws: null,
    offlineTimer: null,
    rl: {},
    reportsSent: 0,
  };
}

const pub = (p) => ({ id: p.id, alias: p.alias, anon: p.anon, color: p.color, online: !!p.ws });
const publicPeople = (room) => [...room.people.values()].map(pub);
const onlineCount = (room) => [...room.people.values()].filter((p) => p.ws).length;

function stateOf(room) {
  return {
    t: 'state',
    status: room.status,
    endsAt: room.endsAt,
    maxEndsAt: room.startedAt ? room.startedAt + MAX_TOTAL_MS : 0,
    lobbyEndsAt: room.lobbyEndsAt,
    extensions: room.extensions,
    chatMs: CHAT_MS,
    extendWindowMs: EXTEND_WINDOW_MS,
    now: Date.now(),
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of room.people.values()) {
    if (p.id !== exceptId && p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

const sys = (room, text) => broadcast(room, { t: 'sys', text, ts: Date.now() });

function scheduleEnd(room) {
  clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => endRoom(room, 'time'), Math.max(0, room.endsAt - Date.now()));
}

function maybeGoLive(room) {
  if (room.status !== 'waiting' || onlineCount(room) < 2) return;
  room.status = 'live';
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + CHAT_MS;
  clearTimeout(room.lobbyTimer);
  scheduleEnd(room);
  broadcast(room, stateOf(room));
  sys(room, `The chat is live. ${Math.round(CHAT_MS / 1000)} seconds on the clock.`);
}

function removePerson(room, person, how) {
  if (!room.people.has(person.id)) return;
  clearTimeout(person.offlineTimer);
  room.people.delete(person.id);
  room.byToken.delete(person.token);
  const ws = person.ws;
  person.ws = null;
  if (ws && how === 'left') {
    try { ws.close(1000, 'left'); } catch { /* already closed */ }
  }
  if (room.status === 'ended') return;
  if (room.people.size === 0) return endRoom(room, 'empty');
  broadcast(room, { t: 'leave', id: person.id });
  sys(room, `${person.alias} left`);
}

function endRoom(room, reason) {
  if (room.status === 'ended') return;
  room.status = 'ended';
  clearTimeout(room.endTimer);
  clearTimeout(room.lobbyTimer);
  const data = JSON.stringify({ t: 'ended', reason });
  const sockets = [];
  for (const p of room.people.values()) {
    clearTimeout(p.offlineTimer);
    if (p.ws) {
      if (p.ws.readyState === 1) p.ws.send(data);
      sockets.push(p.ws);
    }
  }
  storeBytes = Math.max(0, storeBytes - room.bytes);
  room.bytes = 0;
  room.files.clear(); // drops the only references to every uploaded file
  room.recent.length = 0;
  room.people.clear();
  room.byToken.clear();
  rooms.delete(room.id);
  setTimeout(() => sockets.forEach((s) => { try { s.close(1000, 'ended'); } catch { /* noop */ } }), 250);
}

/* --------------------------------------------------------------- web server */

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// Create a chat room. Called when someone taps "Share QR code" or "Print QR code".
app.post('/api/rooms', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!createLimiter(clientIp(req))) {
    return res.status(429).json({ error: 'rate', message: 'Too many chats started from this network. Try again later.' });
  }
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'busy', message: 'Blip is at capacity right now. Try again in a minute.' });
  }
  const room = createRoom();
  res.status(201).json({ id: room.id });
});

// Lets the join page show whether a chat exists before the visitor commits.
app.get('/api/rooms/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!lookupLimiter(clientIp(req))) return res.status(429).json({ error: 'rate' });
  const room = rooms.get(req.params.id);
  if (!room || room.status === 'ended') return res.json({ exists: false });
  res.json({
    exists: true,
    status: room.status,
    people: room.people.size,
    full: room.people.size >= MAX_PEOPLE,
    chatSeconds: Math.round(CHAT_MS / 1000),
  });
});

// QR code for a live room only, so this can't be used as a generic QR generator.
app.get('/qr/:id', async (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room || room.status === 'ended') return res.status(404).end();
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const svg = await QRCode.toString(`${base}/r/${room.id}`, {
      type: 'svg',
      margin: 2,
      width: 640,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1033', light: '#ffffff' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch {
    res.status(500).end();
  }
});

// Upload one image, PDF or voice note into a live room as a raw request body.
app.post('/api/rooms/:id/upload', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const room = rooms.get(req.params.id);
  const person = room && room.byToken.get(String(req.query.token || ''));
  if (!room || !person || room.status === 'ended') return res.status(404).json({ error: 'gone' });
  if (room.status !== 'live') return res.status(409).json({ error: 'not_live' });

  const kind = String(req.query.kind || '');
  const limit = LIMITS[kind];
  if (!limit) return res.status(400).json({ error: 'bad_kind' });
  if (!allow(person, 'upload', 6, 60000)) return res.status(429).json({ error: 'rate' });

  const declared = Number(req.headers['content-length']);
  const tooBig = () => {
    res.once('finish', () => req.destroy());
    res.set('Connection', 'close').status(413).json({ error: 'too_big' });
  };
  if (Number.isFinite(declared) && declared > limit) return tooBig();

  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    total += c.length;
    if (total > limit) {
      aborted = true;
      chunks.length = 0;
      tooBig();
    } else {
      chunks.push(c);
    }
  });
  req.on('error', () => { aborted = true; });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    const live = rooms.get(room.id);
    if (!live || live.status !== 'live' || !live.people.has(person.id)) {
      return res.status(404).json({ error: 'gone' });
    }
    const type = sniff(buf);
    if (!type || type.kind !== kind) return res.status(415).json({ error: 'bad_type' });
    if (room.bytes + buf.length > MAX_ROOM_BYTES || storeBytes + buf.length > MAX_STORE_BYTES) {
      return res.status(503).json({ error: 'storage_full' });
    }

    const fid = randomId(20);
    const fallback = kind === 'pdf' ? 'document.pdf' : kind === 'audio' ? `voice-note.${type.ext}` : `photo.${type.ext}`;
    let name = safeFileName(req.query.name, fallback);
    if (kind === 'pdf' && !/\.pdf$/i.test(name)) name += '.pdf';
    if (kind !== 'pdf') name = fallback; // photos and voice notes don't need a user-chosen name
    room.files.set(fid, { buf, mime: type.mime, kind, name });
    room.bytes += buf.length;
    storeBytes += buf.length;

    const dur = kind === 'audio' ? Math.min(180, Math.max(0, Math.round(Number(req.query.dur) || 0))) : 0;
    broadcast(room, {
      t: 'msg',
      id: randomId(10),
      from: person.id,
      ts: Date.now(),
      file: { id: fid, kind, mime: type.mime, size: buf.length, name, dur },
    });
    res.json({ ok: true });
  });
});

// Serve an uploaded file. The id is unguessable and exists only while the room does.
app.get('/f/:room/:fid', (req, res) => {
  const room = rooms.get(req.params.room);
  const file = room && room.files.get(req.params.fid);
  if (!file) return res.status(404).end();

  const size = file.buf.length;
  const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.set({
    'Content-Type': file.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `${file.kind === 'pdf' ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });

  // Safari will not play audio without byte-range support.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? NaN : Number(range[1]);
    let end = range[2] === '' ? NaN : Number(range[2]);
    if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, size - end); end = size - 1; }
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (Number.isNaN(start) || start > end || start >= size) {
      return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return res.end(file.buf.subarray(start, end + 1));
  }
  res.set('Content-Length', size);
  res.end(file.buf);
});

app.use(express.static(PUBLIC_DIR, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

app.get(['/', '/r/:id'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if (req.path.startsWith('/r/')) res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

const server = http.createServer(app);

/* ---------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* bad url */ }
  if (pathname !== '/ws') return socket.destroy();

  // Same-origin only, so other websites can't open chats from a visitor's browser.
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
  }
  const ip = clientIp(req);
  if (!socketLimiter(ip)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function doJoin(ws, m) {
  const room = rooms.get(String(m.room || ''));
  if (!room || room.status === 'ended') {
    send(ws, { t: 'ended', reason: 'gone' });
    ws.close();
    return null;
  }

  let person = m.token ? room.byToken.get(String(m.token)) : null;
  let isNew = false;

  if (person) {
    // Same person coming back after a dropped connection.
    clearTimeout(person.offlineTimer);
    const old = person.ws;
    person.ws = ws;
    if (old && old !== ws) { try { old.close(4001, 'replaced'); } catch { /* noop */ } }
    broadcast(room, { t: 'presence', id: person.id, online: true }, person.id);
  } else {
    if (room.people.size >= MAX_PEOPLE) {
      send(ws, { t: 'error', code: 'full' });
      ws.close();
      return null;
    }
    const wantsName = m.anon === false;
    const name = wantsName ? cleanName(m.name) : '';
    person = newPerson(room, name || '');
    person.ws = ws;
    room.people.set(person.id, person);
    room.byToken.set(person.token, person);
    isNew = true;
  }

  send(ws, {
    t: 'welcome',
    you: pub(person),
    token: person.token,
    people: publicPeople(room),
    state: stateOf(room),
    now: Date.now(),
  });

  if (isNew) {
    broadcast(room, { t: 'join', person: pub(person) }, person.id);
    sys(room, `${person.alias} joined`);
    maybeGoLive(room);
  }
  return { room, person };
}

function handle(ctx, ws, m) {
  const { room, person } = ctx;
  if (room.status === 'ended' || !room.people.has(person.id)) return;

  switch (m.t) {
    case 'msg': {
      if (room.status !== 'live') return;
      if (!allow(person, 'msg', 8, 5000)) return send(ws, { t: 'error', code: 'slow' });
      const text = cleanText(m.text);
      if (!text) return;
      const id = randomId(10);
      room.recent.push({ ts: Date.now(), from: person.alias, text });
      if (room.recent.length > 20) room.recent.shift();
      broadcast(room, { t: 'msg', id, from: person.id, ts: Date.now(), text });
      break;
    }
    case 'extend': {
      if (room.status !== 'live') return;
      const remaining = room.endsAt - Date.now();
      if (remaining > EXTEND_WINDOW_MS) return send(ws, { t: 'error', code: 'extend_early' });
      const cap = room.startedAt + MAX_TOTAL_MS;
      const next = Math.min(room.endsAt + CHAT_MS, cap);
      if (next <= room.endsAt) return send(ws, { t: 'error', code: 'max' });
      const added = Math.round((next - room.endsAt) / 1000);
      room.endsAt = next;
      room.extensions += 1;
      scheduleEnd(room);
      broadcast(room, stateOf(room));
      sys(room, `${person.alias} added ${added} seconds`);
      break;
    }
    case 'leave':
      removePerson(room, person, 'left');
      break;
    case 'report': {
      if (person.reportsSent >= 3) return send(ws, { t: 'error', code: 'slow' });
      const reason = REPORT_REASONS.has(m.reason) ? m.reason : 'other';
      const target = m.target ? room.people.get(String(m.target)) : null;
      person.reportsSent += 1;
      const record = {
        at: new Date().toISOString(),
        room: room.id,
        reporter: person.alias,
        target: target ? target.alias : null,
        reason,
        participants: [...room.people.values()].map((p) => p.alias),
        lastTextMessages: room.recent.slice(-20).map((r) => ({ at: new Date(r.ts).toISOString(), from: r.from, text: r.text })),
      };
      fs.mkdir(REPORT_DIR, { recursive: true }, (err) => {
        if (err) return console.error('report: could not create report dir');
        fs.appendFile(path.join(REPORT_DIR, 'reports.jsonl'), `${JSON.stringify(record)}\n`, (e) => {
          if (e) console.error('report: could not save report');
        });
      });
      console.log(`report received (${reason}) for a chat with ${record.participants.length} people`);
      send(ws, { t: 'reported' });
      break;
    }
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let ctx = null;
  const joinTimer = setTimeout(() => { if (!ctx) ws.close(4000, 'join timeout'); }, 5000);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!ctx) {
      if (m.t === 'join') ctx = doJoin(ws, m);
      return;
    }
    handle(ctx, ws, m);
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (!ctx) return;
    const { room, person } = ctx;
    if (person.ws !== ws) return; // replaced by a newer connection or already removed
    person.ws = null;
    if (room.status === 'ended' || !room.people.has(person.id)) return;
    broadcast(room, { t: 'presence', id: person.id, online: false });
    person.offlineTimer = setTimeout(() => removePerson(room, person, 'dropped'), RECONNECT_GRACE_MS);
  });

  ws.on('error', () => { /* handled by close */ });
});

// Keep idle proxies from closing sockets and clear out dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, 25000).unref();

/* ----------------------------------------------------------------- startup */

function shutdown() {
  for (const room of [...rooms.values()]) endRoom(room, 'server');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Blip is running on http://localhost:${PORT}`));
}

module.exports = { server };
