'use strict';

/**
 * Tiny JSON-file store for accounts, posters, invites and payments.
 *
 * Chats themselves are never stored. This only keeps who owns which poster,
 * how many scans they have left, and which invites were used.
 *
 * It survives a process restart as long as DATA_DIR is on a disk that survives
 * too. On hosts with throw-away disks (like Render's free plan) it resets when
 * the server is rebuilt or put to sleep. Swap this file for a database to fix that.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomId } = require('./util');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function openStore(dir) {
  const file = dir ? path.join(dir, 'blip-data.json') : null;
  let data = { v: 1, founders: 0, accounts: {}, posters: {}, invites: {}, payments: {} };
  let persistent = false;
  let timer = null;

  if (file) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      persistent = true;
    } catch {
      console.error('store: data folder is not writable, keeping data in memory only');
    }
    if (persistent) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && raw.v === 1) data = { ...data, ...raw };
      } catch (e) {
        if (e.code !== 'ENOENT') {
          // Keep the unreadable file instead of overwriting it with an empty one.
          try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* noop */ }
          console.error('store: could not read the data file, started empty and kept a copy');
        }
      }
    }
  }

  function writeNow() {
    clearTimeout(timer);
    timer = null;
    if (!persistent) return;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch {
      console.error('store: could not save data');
    }
  }

  function save() {
    if (!persistent || timer) return;
    timer = setTimeout(writeNow, 300);
    timer.unref();
  }

  function createAccount() {
    let id;
    do id = randomId(10);
    while (data.accounts[id]);
    const secret = crypto.randomBytes(24).toString('base64url');
    data.accounts[id] = {
      id,
      secretHash: sha(secret),
      createdAt: Date.now(),
      credits: 0,
      starter: null, // 'founder' | 'invite' once a free starter pack was claimed
      founderNo: null,
      invitesLeft: 0,
      invitedBy: null,
    };
    save();
    return { id, secret: `${id}.${secret}` };
  }

  /** Check an "id.secret" credential. Returns the account or null. */
  function verify(credential) {
    const s = String(credential || '');
    const dot = s.indexOf('.');
    if (dot < 1) return null;
    const acct = data.accounts[s.slice(0, dot)];
    if (!acct) return null;
    const a = Buffer.from(sha(s.slice(dot + 1)));
    const b = Buffer.from(acct.secretHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? acct : null;
  }

  return {
    data,
    get persistent() { return persistent; },
    save,
    flush: writeNow,
    createAccount,
    verify,
  };
}

module.exports = { openStore };
