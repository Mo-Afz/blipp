'use strict';

const crypto = require('crypto');

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789'; // no look-alike characters

function randomId(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
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

/** Positive integer from an env var, or the default. */
function num(v, d) {
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d;
}

/** Integer from an env var where 0 is a real answer. */
function int0(v, d) {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : d;
}

module.exports = { ID_ALPHABET, randomId, INVISIBLE, cleanName, num, int0 };
