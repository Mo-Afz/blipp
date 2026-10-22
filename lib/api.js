'use strict';

/**
 * Accounts, founder spots, invites, posters, scan credits and payments.
 *
 * An "account" is just a random ID plus a secret kept in the person's browser.
 * There are no emails or passwords. Whoever holds the secret owns the scans,
 * which is why the app offers a recovery link.
 */

const express = require('express');
const { randomId, cleanName } = require('./util');

function registerApi(app, ctx) {
  const { store, payments, rooms, createRoom, makeLimiter, clientIp, config } = ctx;
  const db = store.data;
  const json = express.json({ limit: '4kb' });
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const publicBase = (req) => config.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  /* ---------------------------------------------------------- payments */

  const logPayment = (msg) => console.log(`payments: ${msg}`);

  function creditPurchase(session) {
    const key = session.id;
    if (!key || db.payments[key]) return; // already counted: Stripe retries webhooks
    const meta = session.metadata || {};
    const acct = db.accounts[meta.accountId];
    const pack = payments.pack(meta.packId);
    if (!acct || !pack) return logPayment('paid session ignored, unknown account or pack');
    // Trust our own price list, not the metadata: the amount paid must match.
    if (session.amount_total !== pack.cents || String(session.currency).toLowerCase() !== payments.currency) {
      return logPayment('paid session ignored, amount did not match the pack');
    }
    acct.credits += pack.scans;
    db.payments[key] = { at: Date.now(), accountId: acct.id, packId: pack.id, scans: pack.scans };
    store.save();
    logPayment(`added ${pack.scans} scans`);
  }

  // Needs the raw body for the signature check, so it comes before the JSON parser.
  app.post('/api/stripe/webhook', express.raw({ type: () => true, limit: '64kb' }), (req, res) => {
    if (!payments.enabled) return res.status(503).json({ error: 'payments_off' });
    let event;
    try {
      event = payments.verifyEvent(req.body, req.headers['stripe-signature']);
    } catch {
      return res.status(400).json({ error: 'bad_signature' });
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid') creditPurchase(session);
    }
    return res.json({ received: true });
  });

  /* ------------------------------------------------------------ helpers */

  const apiLimiter = makeLimiter(600, 60e3);
  app.use('/api', (req, res, next) => {
    if (!apiLimiter(clientIp(req))) return res.status(429).json({ error: 'rate' });
    return next();
  });

  const newDeviceLimiter = makeLimiter(config.DEVICE_PER_HOUR, 3600e3);
  const claimLimiter = makeLimiter(config.CLAIMS_PER_HOUR, 3600e3);
  const scanLimiter = makeLimiter(20, 600e3);
  const checkoutLimiter = makeLimiter(10, 3600e3);

  const credentialOf = (req) => {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  };

  function requireAuth(req, res, next) {
    noStore(res);
    const acct = store.verify(credentialOf(req));
    if (!acct) return res.status(401).json({ error: 'unknown_account' });
    req.acct = acct;
    return next();
  }

  const ownedPosters = (acct) => Object.values(db.posters).filter((p) => p.ownerId === acct.id);

  function profile(acct) {
    return {
      id: acct.id,
      credits: acct.credits,
      starter: acct.starter,
      founderNo: acct.founderNo,
      invitesLeft: acct.invitesLeft,
      invites: Object.values(db.invites)
        .filter((i) => i.inviterId === acct.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((i) => ({ code: i.code, used: !!i.usedBy })),
      posters: ownedPosters(acct)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((p) => ({ id: p.id, label: p.label, scansUsed: p.scansUsed })),
      spots: { limit: config.FOUNDER_LIMIT, left: Math.max(0, config.FOUNDER_LIMIT - db.founders) },
      freeScans: config.FREE_SCANS,
      founderInvites: config.FOUNDER_INVITES,
      paymentsEnabled: payments.enabled,
      packs: payments.packs.map((p) => ({ id: p.id, scans: p.scans, cents: p.cents })),
      currency: payments.currency,
      durable: config.DURABLE,
    };
  }

  /** A scan that never turned into a chat gives its credit back. */
  function refundScan(room) {
    const owner = db.accounts[room.ownerId];
    if (owner) owner.credits += 1;
    const poster = room.poster && db.posters[room.poster.id];
    if (poster && poster.scansUsed > 0) poster.scansUsed -= 1;
    store.save();
  }

  /* ----------------------------------------------------------- accounts */

  app.post('/api/device', (req, res) => {
    noStore(res);
    if (!newDeviceLimiter(clientIp(req))) return res.status(429).json({ error: 'rate' });
    const { id, secret } = store.createAccount();
    return res.status(201).json({ id, secret });
  });

  app.get('/api/spots', (req, res) => {
    noStore(res);
    res.json({ limit: config.FOUNDER_LIMIT, left: Math.max(0, config.FOUNDER_LIMIT - db.founders) });
  });

  app.get('/api/me', requireAuth, (req, res) => res.json(profile(req.acct)));

  // Claim one of the first free spots. Done on purpose, never just by visiting.
  app.post('/api/me/claim', requireAuth, (req, res) => {
    if (!claimLimiter(clientIp(req))) return res.status(429).json({ error: 'rate' });
    const acct = req.acct;
    if (acct.starter) return res.status(409).json({ error: 'already_claimed' });
    if (db.founders >= config.FOUNDER_LIMIT) return res.status(409).json({ error: 'spots_gone' });
    db.founders += 1;
    acct.starter = 'founder';
    acct.founderNo = db.founders;
    acct.credits += config.FREE_SCANS;
    acct.invitesLeft = config.FOUNDER_INVITES;
    store.save();
    return res.json(profile(acct));
  });

  /* ------------------------------------------------------------ invites */

  app.post('/api/me/invites', requireAuth, (req, res) => {
    const acct = req.acct;
    if (acct.invitesLeft < 1) return res.status(409).json({ error: 'no_invites_left' });
    let code;
    do code = randomId(10);
    while (db.invites[code]);
    db.invites[code] = { code, inviterId: acct.id, createdAt: Date.now(), usedBy: null };
    acct.invitesLeft -= 1;
    store.save();
    return res.status(201).json(profile(acct));
  });

  app.get('/api/invites/:code', (req, res) => {
    noStore(res);
    const inv = db.invites[req.params.code];
    res.json({ valid: !!inv && !inv.usedBy, freeScans: config.FREE_SCANS });
  });

  app.post('/api/invites/:code/redeem', requireAuth, (req, res) => {
    if (!claimLimiter(clientIp(req))) return res.status(429).json({ error: 'rate' });
    const acct = req.acct;
    const inv = db.invites[req.params.code];
    if (!inv || inv.usedBy) return res.status(404).json({ error: 'invite_invalid' });
    if (inv.inviterId === acct.id) return res.status(409).json({ error: 'own_invite' });
    if (acct.starter) return res.status(409).json({ error: 'already_claimed' });
    inv.usedBy = acct.id;
    acct.starter = 'invite';
    acct.invitedBy = inv.inviterId;
    acct.credits += config.FREE_SCANS;
    acct.invitesLeft = config.INVITEE_INVITES;
    store.save();
    return res.json(profile(acct));
  });

  /* ------------------------------------------------------------ posters */

  app.post('/api/posters', requireAuth, json, (req, res) => {
    const acct = req.acct;
    if (ownedPosters(acct).length >= config.MAX_POSTERS) return res.status(409).json({ error: 'too_many_posters' });
    const label = cleanName(req.body && req.body.label) || 'My Blip';
    let id;
    do id = randomId(12);
    while (db.posters[id]);
    db.posters[id] = { id, ownerId: acct.id, label, scansUsed: 0, createdAt: Date.now() };
    store.save();
    return res.status(201).json(profile(acct));
  });

  app.delete('/api/posters/:id', requireAuth, (req, res) => {
    const poster = db.posters[req.params.id];
    if (!poster || poster.ownerId !== req.acct.id) return res.status(404).json({ error: 'gone' });
    delete db.posters[poster.id];
    store.save();
    return res.json(profile(req.acct));
  });

  // What a visitor sees before choosing to scan. Never reveals the owner's balance.
  app.get('/api/posters/:id', (req, res) => {
    noStore(res);
    const poster = db.posters[req.params.id];
    if (!poster) return res.json({ exists: false });
    const owner = db.accounts[poster.ownerId];
    return res.json({ exists: true, label: poster.label, open: !!owner && owner.credits > 0 });
  });

  // One scan = one separate chat with the poster's owner, and one scan credit.
  app.post('/api/posters/:id/scan', (req, res) => {
    noStore(res);
    if (!scanLimiter(clientIp(req))) return res.status(429).json({ error: 'rate' });
    const poster = db.posters[req.params.id];
    if (!poster) return res.status(404).json({ error: 'gone' });
    const owner = db.accounts[poster.ownerId];
    if (!owner || owner.credits < 1) return res.status(409).json({ error: 'out_of_scans' });

    let waiting = 0;
    for (const r of rooms.values()) {
      if (r.poster && r.poster.id === poster.id && r.status === 'waiting') waiting += 1;
    }
    if (waiting >= config.MAX_PENDING) return res.status(429).json({ error: 'busy' });
    if (rooms.size >= config.MAX_ROOMS) return res.status(503).json({ error: 'busy' });

    owner.credits -= 1;
    poster.scansUsed += 1;
    store.save();
    const room = createRoom({
      poster: { id: poster.id, label: poster.label },
      ownerId: owner.id,
      maxPeople: 2,
      lobbyMs: config.POSTER_LOBBY_MS,
    });
    return res.status(201).json({ room: room.id, label: poster.label });
  });

  // The owner's inbox: chats that are waiting for them or still running.
  app.get('/api/me/sessions', requireAuth, (req, res) => {
    const list = [];
    for (const r of rooms.values()) {
      if (r.ownerId !== req.acct.id || r.status === 'ended') continue;
      list.push({
        room: r.id,
        label: r.poster.label,
        status: r.status,
        since: r.createdAt,
        expiresAt: r.status === 'waiting' ? r.lobbyEndsAt : r.endsAt,
        guestOnline: [...r.people.values()].some((p) => !p.host && p.ws),
      });
    }
    list.sort((a, b) => b.since - a.since);
    res.json({ sessions: list, now: Date.now() });
  });

  /* ----------------------------------------------------------- checkout */

  app.post('/api/checkout', requireAuth, json, async (req, res) => {
    if (!payments.enabled) return res.status(503).json({ error: 'payments_off' });
    if (!checkoutLimiter(req.acct.id)) return res.status(429).json({ error: 'rate' });
    const pack = payments.pack(req.body && req.body.pack);
    if (!pack) return res.status(400).json({ error: 'bad_pack' });
    try {
      const url = await payments.createCheckout({ accountId: req.acct.id, pack, baseUrl: publicBase(req) });
      return res.json({ url });
    } catch {
      console.error('payments: could not create a checkout session');
      return res.status(502).json({ error: 'payments_unavailable' });
    }
  });

  return { refundScan, verifyCredential: (c) => store.verify(c) };
}

module.exports = { registerApi };
