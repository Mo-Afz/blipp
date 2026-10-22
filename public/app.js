(() => {
  'use strict';

  /* ------------------------------------------------------------ helpers */

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const screens = {
    home: $('#screen-home'),
    gate: $('#screen-gate'),
    room: $('#screen-room'),
    ended: $('#screen-ended'),
  };

  const COLORS = ['#2f36f5', '#d91c47', '#0f9d9a', '#d98a00', '#7c4dff', '#2e9e48', '#d6338f', '#5f6b85'];
  const MB = 1024 * 1024;
  const LIMITS = { image: 5 * MB, pdf: 10 * MB, audio: 3 * MB };
  const MAX_VOICE_S = 45;
  const SESSION_KEY = 'blip.session';

  const S = {
    roomId: null,
    token: null,
    you: null,
    people: new Map(),
    ws: null,
    joined: false,
    status: 'waiting',
    endsAt: 0,
    maxEndsAt: 0,
    lobbyEndsAt: 0,
    chatMs: 60000,
    extendWindowMs: 30000,
    offset: 0,
    mode: 'create',
    pendingAction: null,
    identity: { anon: true, name: '' },
    blocked: new Set(),
    ended: false,
    left: false,
    retries: 0,
    lastFrom: null,
    lastAt: 0,
    qrBlobUrl: null,
    qrFile: null,
    qrReady: null,
    rec: null,
    reportTarget: null,
    reconnectTimer: null,
  };

  function show(name) {
    for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
    window.scrollTo(0, 0);
  }

  let toastTimer;
  function toast(msg, ms = 3400) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  const fmtClock = (ms) => {
    const secs = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  };
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`);
  const joinUrl = () => `${location.origin}/r/${S.roomId}`;

  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ room: S.roomId, token: S.token, identity: S.identity })); } catch { /* storage blocked */ }
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
  }

  /* ---------------------------------------------------------- home clock */

  function startHomeClock() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const num = $('#homeNum');
    const bar = $('#homeBar');
    const total = 60000;
    const t0 = performance.now();
    setInterval(() => {
      if (screens.home.hidden) return;
      const rem = total - ((performance.now() - t0) % total);
      num.textContent = String(Math.ceil(rem / 1000));
      bar.style.setProperty('--p', String(rem / total));
    }, 200);
  }

  /* ----------------------------------------------------------------- gate */

  const gate = {
    go: $('#gateGo'),
    age: $('#ageOk'),
    terms: $('#termsOk'),
    name: $('#nameInput'),
    nameRow: $('#nameRow'),
    err: $('#gateError'),
  };
  const idMode = () => $('input[name="idmode"]:checked').value;

  function gateValid() {
    const nameOk = idMode() !== 'named' || gate.name.value.trim().length > 0;
    gate.go.disabled = !(gate.age.checked && gate.terms.checked && nameOk);
  }

  function openGate(mode, sub) {
    S.mode = mode;
    $('#gateTitle').textContent = mode === 'create' ? 'Start a chat' : 'You’re invited to a chat';
    $('#gateSub').textContent = sub || (mode === 'create'
      ? 'Pick how you want to appear. Then Blip makes your QR code.'
      : 'Pick how you want to appear, then read the warnings.');
    gate.go.textContent = mode === 'create' ? 'Make my QR code' : 'Join chat';
    $('#gateBack').hidden = mode !== 'create';
    gate.age.checked = false;
    gate.terms.checked = false;
    gate.err.hidden = true;
    gateValid();
    show('gate');
  }

  async function onGateGo() {
    S.identity = { anon: idMode() !== 'named', name: gate.name.value.trim() };
    gate.go.disabled = true;
    gate.err.hidden = true;

    if (S.mode === 'create') {
      try {
        const r = await fetch('/api/rooms', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || 'Blip couldn’t start a chat. Try again in a moment.');
        S.roomId = j.id;
        history.replaceState(null, '', `/r/${j.id}`);
      } catch (e) {
        gate.err.textContent = e.message || 'Blip couldn’t start a chat. Check your connection and try again.';
        gate.err.hidden = false;
        gateValid();
        return;
      }
    }
    prepareRoomScreen();
    connect();
    show('room');
  }

  /* ------------------------------------------------------------ websocket */

  function wsSend(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  }

  function connect() {
    clearTimeout(S.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        t: 'join',
        room: S.roomId,
        token: S.token,
        anon: S.identity.anon,
        name: S.identity.name,
      }));
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onServer(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws || S.ended || S.left) return;
      if (S.retries >= 12) return endChat('lost');
      S.retries += 1;
      if (S.joined) $('#reconnect').hidden = false;
      S.reconnectTimer = setTimeout(connect, S.retries < 3 ? 800 : 2000);
    };
  }

  function onServer(m) {
    switch (m.t) {
      case 'welcome': {
        const first = !S.joined;
        S.joined = true;
        S.retries = 0;
        S.you = m.you;
        S.token = m.token;
        S.people = new Map(m.people.map((p) => [p.id, p]));
        saveSession();
        $('#reconnect').hidden = true;
        applyState(m.state, m.now);
        renderPeopleCount();
        if (first) {
          setupQr();
          if (S.pendingAction) {
            const a = S.pendingAction;
            S.pendingAction = null;
            setTimeout(() => runAction(a, true), 200);
          }
        }
        break;
      }
      case 'state':
        applyState(m, m.now);
        break;
      case 'join':
        S.people.set(m.person.id, m.person);
        renderPeopleCount();
        break;
      case 'leave':
        S.people.delete(m.id);
        renderPeopleCount();
        updateView();
        break;
      case 'presence': {
        const p = S.people.get(m.id);
        if (p) p.online = m.online;
        updateView();
        break;
      }
      case 'sys':
        addSystem(m.text);
        break;
      case 'msg':
        addMessage(m);
        break;
      case 'ended':
        endChat(m.reason);
        break;
      case 'reported':
        toast('Report sent. Thank you.');
        break;
      case 'error':
        onServerError(m.code);
        break;
      default:
        break;
    }
  }

  function onServerError(code) {
    const text = {
      slow: 'You’re sending too fast. Wait a moment.',
      extend_early: 'You can add time in the last 30 seconds.',
      max: 'This chat has reached its 30 minute limit.',
    }[code];
    if (code === 'full') return endChat('full');
    if (text) toast(text);
  }

  /* ----------------------------------------------------------- room state */

  const onlineOthers = () => [...S.people.values()].filter((p) => p.online && S.you && p.id !== S.you.id).length;

  function applyState(s, now) {
    S.status = s.status;
    S.endsAt = s.endsAt;
    S.maxEndsAt = s.maxEndsAt;
    S.lobbyEndsAt = s.lobbyEndsAt;
    S.chatMs = s.chatMs;
    S.extendWindowMs = s.extendWindowMs;
    S.offset = (now || s.now) - Date.now();
    updateView();
    tick();
  }

  function updateView() {
    const waiting = S.status === 'waiting' && onlineOthers() === 0;
    $('#waiting').hidden = !waiting;
    $('#log').hidden = waiting;
    $('#composer').toggleAttribute('data-off', S.status !== 'live');
    $('#msgInput').placeholder = S.status === 'live' ? 'Message' : 'Waiting for someone to join';
  }

  function tick() {
    if (screens.room.hidden) return;
    const now = Date.now() + S.offset;
    const rbar = $('.rbar');
    if (S.status === 'live') {
      const rem = Math.max(0, S.endsAt - now);
      const hot = rem <= 10000;
      $('#timerNum').textContent = fmtClock(rem);
      $('#timerBar').style.setProperty('--p', String(Math.min(1, rem / S.chatMs)));
      $('#timer').classList.toggle('hot', hot);
      rbar.classList.toggle('hot', hot);
      $('#extendBar').hidden = !(rem > 0 && rem <= S.extendWindowMs && S.endsAt < S.maxEndsAt);
    } else {
      $('#timerNum').textContent = '–';
      $('#timerBar').style.setProperty('--p', '0');
      $('#timer').classList.remove('hot');
      rbar.classList.remove('hot');
      $('#extendBar').hidden = true;
      const left = Math.max(0, S.lobbyEndsAt - now);
      $('#lobbyLeft').textContent = left ? `This code expires in ${fmtClock(left)} if nobody joins.` : '';
    }
  }
  setInterval(tick, 250);

  function prepareRoomScreen() {
    $('#log').replaceChildren();
    S.people = new Map();
    S.lastFrom = null;
    S.blocked = new Set();
    S.status = 'waiting';
    S.joined = false;
    S.retries = 0;
    $('#reconnect').hidden = true;
    $('#timerNum').textContent = '–';
    updateView();
  }

  /* ------------------------------------------------------------- messages */

  function stageStick() {
    const st = $('#stage');
    return st.scrollHeight - st.scrollTop - st.clientHeight < 160;
  }
  function stageToBottom() {
    const st = $('#stage');
    st.scrollTop = st.scrollHeight;
  }

  function addSystem(text) {
    const stick = stageStick();
    const li = document.createElement('li');
    li.className = 'sysmsg';
    li.textContent = text;
    $('#log').append(li);
    S.lastFrom = null;
    if (stick) stageToBottom();
  }

  function addMessage(m) {
    const mine = !!S.you && m.from === S.you.id;
    if (!mine && S.blocked.has(m.from)) return;
    const person = S.people.get(m.from) || { alias: 'Someone', color: 0 };
    const stick = stageStick() || mine;

    const li = document.createElement('li');
    li.className = `msg${mine ? ' mine' : ''}${m.file ? ' media' : ''}`;
    li.dataset.from = m.from;

    const cont = S.lastFrom === m.from && m.ts - S.lastAt < 60000;
    if (!cont) li.classList.add('first');
    if (!cont && !mine) {
      const who = document.createElement('div');
      who.className = 'who';
      who.style.setProperty('--c', COLORS[person.color % COLORS.length]);
      who.textContent = person.alias;
      li.append(who);
    }

    if (m.file) li.append(renderFile(m.file, mine, person, stick));
    else li.append(document.createTextNode(m.text));

    $('#log').append(li);
    S.lastFrom = m.from;
    S.lastAt = m.ts;
    if (stick) stageToBottom();
  }

  function renderFile(f, mine, person, stick) {
    const url = `/f/${S.roomId}/${f.id}`;

    if (f.kind === 'image') {
      const pic = document.createElement('div');
      pic.className = `pic${mine ? '' : ' veiled'}`;
      const img = document.createElement('img');
      img.src = url;
      img.alt = `Picture from ${mine ? 'you' : person.alias}`;
      img.decoding = 'async';
      img.addEventListener('load', () => { if (stick) stageToBottom(); });
      pic.append(img);
      if (!mine) {
        const note = document.createElement('div');
        note.className = 'veil-note';
        note.innerHTML = '<svg class="ico"><use href="#i-eye-off"/></svg>';
        const t = document.createElement('span');
        t.textContent = 'Tap to view';
        const s = document.createElement('small');
        s.textContent = 'Pictures from others start hidden';
        note.append(t, s);
        pic.append(note);
      }
      pic.addEventListener('click', () => {
        if (pic.classList.contains('veiled')) pic.classList.remove('veiled');
        else openLightbox(url, img.alt);
      });
      return pic;
    }

    if (f.kind === 'pdf') {
      const a = document.createElement('a');
      a.className = 'filecard';
      a.href = url;
      a.download = f.name;
      a.rel = 'noopener';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.innerHTML = '<svg class="ico"><use href="#i-file"/></svg>';
      const body = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = f.name;
      const s = document.createElement('small');
      s.textContent = `PDF, ${fmtBytes(f.size)}. Tap to download.`;
      body.append(b, s);
      a.append(badge, body);
      return a;
    }

    const wrap = document.createElement('div');
    wrap.className = 'voice';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    const s = document.createElement('small');
    s.textContent = `Voice note${f.dur ? `, ${fmtClock(f.dur * 1000)}` : ''}`;
    wrap.append(audio, s);
    return wrap;
  }

  function openLightbox(src, alt) {
    const img = $('#lightImg');
    img.src = src;
    img.alt = alt;
    $('#lightbox').showModal();
  }

  /* -------------------------------------------------------------- sending */

  const msgInput = $('#msgInput');
  const finePointer = matchMedia('(pointer: fine)').matches;
  msgInput.enterKeyHint = 'send';

  function autosize() {
    msgInput.style.height = 'auto';
    msgInput.style.height = `${Math.min(msgInput.scrollHeight, 120)}px`;
  }

  function sendText() {
    const text = msgInput.value.trim();
    if (!text || S.status !== 'live') return;
    wsSend({ t: 'msg', text });
    msgInput.value = '';
    autosize();
    if (finePointer) msgInput.focus();
  }

  const uploadErrors = {
    too_big: 'That file is too big. Limits: pictures 5 MB, PDFs 10 MB, voice notes 3 MB.',
    bad_type: 'That file type isn’t allowed. Send pictures, PDFs or voice notes.',
    not_live: 'The chat isn’t live yet.',
    rate: 'Slow down. Too many files in a row.',
    storage_full: 'Blip is full right now. Try again in a moment.',
    gone: 'This chat has ended.',
  };

  async function upload(blob, kind, name, dur) {
    if (S.status !== 'live') return toast('Wait until someone has joined.');
    const stick = stageStick();
    const ph = document.createElement('li');
    ph.className = 'msg mine pending';
    ph.textContent = kind === 'audio' ? 'Sending voice note…' : kind === 'pdf' ? 'Sending PDF…' : 'Sending picture…';
    $('#log').append(ph);
    if (stick) stageToBottom();
    try {
      const q = new URLSearchParams({ token: S.token, kind, name: name || '', dur: String(dur || 0) });
      const r = await fetch(`/api/rooms/${S.roomId}/upload?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'failed');
      }
    } catch (e) {
      toast(uploadErrors[e.message] || 'That didn’t send. Check your connection and try again.');
    } finally {
      ph.remove();
    }
  }

  // Re-drawing a photo to a canvas removes its location and camera metadata.
  async function prepImage(file) {
    if (file.type === 'image/gif') return file.size <= LIMITS.image ? file : null;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    } catch {
      return file.size <= LIMITS.image ? file : null;
    }
  }

  async function handleFile(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (file.size > LIMITS.pdf) return toast(uploadErrors.too_big);
      return upload(file, 'pdf', file.name, 0);
    }
    if (file.type.startsWith('image/')) {
      const blob = await prepImage(file);
      if (!blob || blob.size > LIMITS.image) return toast(uploadErrors.too_big);
      return upload(blob, 'image', 'photo', 0);
    }
    toast(uploadErrors.bad_type);
  }

  /* ---------------------------------------------------------- voice notes */

  async function startRecording() {
    if (S.status !== 'live') return toast('Wait until someone has joined.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return toast('Voice notes aren’t supported in this browser.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast('Blip needs microphone access to record. Allow it in your browser settings.');
    }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    const r = { rec, stream, chunks: [], startedAt: Date.now(), timer: null, cancelled: false };
    S.rec = r;

    rec.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (r.cancelled) return;
      const secs = Math.round((Date.now() - r.startedAt) / 1000);
      if (secs < 1) return toast('That was too short. Hold on a little longer.');
      upload(new Blob(r.chunks, { type: rec.mimeType || 'audio/webm' }), 'audio', 'voice', secs);
    };
    rec.start();

    $('#composer').hidden = true;
    $('#recbar').hidden = false;
    $('#recTime').textContent = '0:00';
    r.timer = setInterval(() => {
      const secs = Math.floor((Date.now() - r.startedAt) / 1000);
      $('#recTime').textContent = fmtClock(secs * 1000);
      if (secs >= MAX_VOICE_S) stopRecording(false);
    }, 250);
  }

  function stopRecording(cancel) {
    const r = S.rec;
    if (!r) return;
    S.rec = null;
    clearInterval(r.timer);
    r.cancelled = cancel;
    if (r.rec.state !== 'inactive') r.rec.stop();
    else r.stream.getTracks().forEach((t) => t.stop());
    $('#recbar').hidden = true;
    $('#composer').hidden = false;
  }

  /* ---------------------------------------------------------- QR actions */

  function setupQr() {
    const imgs = ['qrImg', 'inviteQr', 'printQr'].map((id) => $(`#${id}`));
    $('#printUrl').textContent = joinUrl();
    S.qrReady = fetch(`/qr/${S.roomId}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('qr'); return r.blob(); })
      .then(async (blob) => {
        if (S.qrBlobUrl) URL.revokeObjectURL(S.qrBlobUrl);
        S.qrBlobUrl = URL.createObjectURL(blob);
        imgs.forEach((img) => { img.src = S.qrBlobUrl; });
        // A PNG copy lets phones share the code itself, not just the link.
        try {
          const probe = new Image();
          probe.src = S.qrBlobUrl;
          await probe.decode();
          const c = document.createElement('canvas');
          c.width = 800;
          c.height = 800;
          c.getContext('2d').drawImage(probe, 0, 0, 800, 800);
          const png = await new Promise((res) => c.toBlob(res, 'image/png'));
          if (png) S.qrFile = new File([png], 'blip-chat-qr.png', { type: 'image/png' });
        } catch { /* sharing the link still works */ }
      })
      .catch(() => toast('Couldn’t load the QR code. Copy the link instead.'));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl());
      toast('Link copied.');
    } catch {
      toast(`Copy this link: ${joinUrl()}`, 8000);
    }
  }

  async function shareQr(auto) {
    const url = joinUrl();
    const text = 'Join my 60-second chat on Blip. Scan the code or tap the link.';
    if (navigator.share) {
      try {
        const canFile = !auto && S.qrFile && navigator.canShare && navigator.canShare({ files: [S.qrFile] });
        if (canFile) await navigator.share({ files: [S.qrFile], title: 'Join my Blip chat', text: `${text} ${url}` });
        else await navigator.share({ title: 'Join my Blip chat', text, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        if (auto) return toast('Tap Share to send your QR code.');
      }
    } else if (auto) {
      return toast('Your QR code is ready. Share it, print it, or let someone scan this screen.');
    }
    await copyLink();
  }

  async function printQr() {
    if (S.qrReady) await S.qrReady;
    const img = $('#printQr');
    try { await img.decode(); } catch { /* print anyway */ }
    window.print();
  }

  function runAction(act, auto) {
    switch (act) {
      case 'share': return shareQr(!!auto);
      case 'print': return printQr();
      case 'copy': return copyLink();
      case 'invite': return $('#inviteDlg').showModal();
      case 'rules': return $('#rulesDlg').showModal();
      default: return undefined;
    }
  }

  /* --------------------------------------------------- people and reports */

  function renderPeopleCount() {
    $('#peopleCount').textContent = String(S.people.size);
    updateView();
    if ($('#peopleDlg').open) renderPeopleList();
  }

  function renderPeopleList() {
    const ul = $('#peopleList');
    ul.replaceChildren();
    for (const p of S.people.values()) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--c', COLORS[p.color % COLORS.length]);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.id === S.you.id ? `${p.alias} (you)` : p.alias;
      const sub = document.createElement('small');
      sub.textContent = `${p.anon ? 'Anonymous' : 'Using a name'}${p.online ? '' : ', reconnecting'}`;
      nm.append(sub);
      li.append(dot, nm);

      if (p.id !== S.you.id) {
        const hide = document.createElement('button');
        hide.type = 'button';
        hide.className = 'btn quiet small';
        hide.textContent = S.blocked.has(p.id) ? 'Show' : 'Hide';
        hide.addEventListener('click', () => {
          const nowHidden = !S.blocked.has(p.id);
          if (nowHidden) S.blocked.add(p.id); else S.blocked.delete(p.id);
          $$(`#log .msg[data-from="${p.id}"]`).forEach((el) => el.classList.toggle('blocked', nowHidden));
          renderPeopleList();
        });
        const rep = document.createElement('button');
        rep.type = 'button';
        rep.className = 'icon-btn';
        rep.setAttribute('aria-label', `Report ${p.alias}`);
        rep.innerHTML = '<svg class="ico"><use href="#i-flag"/></svg>';
        rep.addEventListener('click', () => openReport(p));
        li.append(hide, rep);
      }
      ul.append(li);
    }
  }

  function openReport(person) {
    S.reportTarget = person ? person.id : null;
    $('#reportTitle').textContent = person ? `Report ${person.alias}` : 'Report this chat';
    $('#reportOk').checked = false;
    $('#reportSend').disabled = true;
    $('#peopleDlg').close();
    $('#reportDlg').showModal();
  }

  /* ------------------------------------------------------------- ending */

  const endCopy = {
    time: ['Time’s up.', 'This chat and everything shared in it has been erased.'],
    lobby: ['Nobody joined.', 'The QR code expired and the chat was erased. Start a new one whenever you’re ready.'],
    empty: ['Everyone left.', 'This chat and everything shared in it has been erased.'],
    left: ['You left the chat.', 'Nothing from it is saved.'],
    gone: ['This chat has ended.', 'The link no longer works. Chats disappear when their timer runs out.'],
    full: ['This chat is full.', 'It has reached its limit of people. Ask the host to start a new one.'],
    lost: ['Connection lost.', 'Blip couldn’t reconnect. The chat may still be running without you.'],
    server: ['Blip restarted.', 'Chats are cleared whenever the server restarts.'],
  };

  function endChat(reason) {
    if (S.ended) return;
    S.ended = true;
    clearSession();
    stopRecording(true);
    clearTimeout(S.reconnectTimer);
    try { if (S.ws) S.ws.close(); } catch { /* already closed */ }
    for (const d of $$('dialog')) if (d.open) d.close();
    $('#log').replaceChildren();
    $('#lightImg').removeAttribute('src');
    ['qrImg', 'inviteQr', 'printQr'].forEach((id) => $(`#${id}`).removeAttribute('src'));
    if (S.qrBlobUrl) URL.revokeObjectURL(S.qrBlobUrl);
    S.qrBlobUrl = null;
    S.qrFile = null;
    const [title, text] = endCopy[reason] || endCopy.gone;
    $('#endedTitle').textContent = title;
    $('#endedText').textContent = text;
    history.replaceState(null, '', '/');
    show('ended');
  }

  function resetForNewChat() {
    Object.assign(S, {
      roomId: null, token: null, you: null, people: new Map(), ws: null, joined: false,
      status: 'waiting', ended: false, left: false, retries: 0, lastFrom: null,
      pendingAction: null, blocked: new Set(),
    });
    history.replaceState(null, '', '/');
    show('home');
  }

  /* ------------------------------------------------------------ wiring */

  function bind() {
    $('#btnShare').addEventListener('click', () => { S.pendingAction = 'share'; openGate('create'); });
    $('#btnPrint').addEventListener('click', () => { S.pendingAction = 'print'; openGate('create'); });
    $('#gateBack').addEventListener('click', () => { S.pendingAction = null; show('home'); });
    $('#newChat').addEventListener('click', resetForNewChat);

    $$('input[name="idmode"]').forEach((r) => r.addEventListener('change', () => {
      const named = idMode() === 'named';
      gate.nameRow.hidden = !named;
      if (named) gate.name.focus();
      gateValid();
    }));
    [gate.age, gate.terms].forEach((c) => c.addEventListener('change', gateValid));
    gate.name.addEventListener('input', gateValid);
    gate.name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !gate.go.disabled) onGateGo(); });
    gate.go.addEventListener('click', onGateGo);

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (el) runAction(el.dataset.act, false);
    });

    $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
    $('#lightbox').addEventListener('close', () => $('#lightImg').removeAttribute('src'));

    $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
    msgInput.addEventListener('input', autosize);
    msgInput.addEventListener('keydown', (e) => {
      if (finePointer && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendText();
      }
    });
    $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      handleFile(f);
    });
    $('#micBtn').addEventListener('click', startRecording);
    $('#recCancel').addEventListener('click', () => stopRecording(true));
    $('#recSend').addEventListener('click', () => stopRecording(false));

    $('#extendBtn').addEventListener('click', () => wsSend({ t: 'extend' }));

    $('#leaveBtn').addEventListener('click', () => {
      if (!window.confirm('Leave this chat? Everything you’ve seen here stays only on your screen until you close it.')) return;
      S.left = true;
      wsSend({ t: 'leave' });
      endChat('left');
    });

    $('#peopleBtn').addEventListener('click', () => { renderPeopleList(); $('#peopleDlg').showModal(); });
    $('#reportChatBtn').addEventListener('click', () => openReport(null));
    $('#reportOk').addEventListener('change', (e) => { $('#reportSend').disabled = !e.target.checked; });
    $('#reportSend').addEventListener('click', () => {
      wsSend({ t: 'report', reason: $('#reportReason').value, target: S.reportTarget });
      $('#reportDlg').close();
    });
  }

  /* -------------------------------------------------------------- start */

  async function start() {
    bind();
    startHomeClock();

    const m = location.pathname.match(/^\/r\/([a-z0-9]{6,32})\/?$/i);
    if (!m) return show('home');

    S.roomId = m[1].toLowerCase();
    const saved = loadSession();
    if (saved && saved.room === S.roomId && saved.token) {
      // Same tab, refreshed or reconnected: slip back in as the same person.
      S.token = saved.token;
      S.identity = saved.identity || S.identity;
      S.mode = 'join';
      prepareRoomScreen();
      $('#reconnect').hidden = false;
      connect();
      return show('room');
    }

    openGate('join');
    try {
      const r = await fetch(`/api/rooms/${S.roomId}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.exists) return endChat('gone');
      if (j.full) return endChat('full');
      $('#gateSub').textContent = j.status === 'live'
        ? 'This chat is already running. You’ll join with the time that’s left.'
        : 'Someone made this chat for you. Your 60 seconds start as soon as you join.';
    } catch {
      $('#gateSub').textContent = 'Pick how you want to appear, then read the warnings.';
    }
  }

  start();
})();
