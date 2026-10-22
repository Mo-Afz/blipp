'use strict';

/**
 * Scan-pack payments through Stripe Checkout.
 *
 * Off until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set. Prices come only
 * from the PACKS setting on the server, never from the browser. Scans are added
 * by the signed webhook, never by the page that people return to after paying.
 */

const Stripe = require('stripe');

// Placeholder prices. Change them with the PACKS setting before taking real money.
const DEFAULT_PACKS = [
  { id: 's20', scans: 20, cents: 200 },
  { id: 's100', scans: 100, cents: 700 },
  { id: 's500', scans: 500, cents: 2500 },
];

function parsePacks(raw) {
  let list = DEFAULT_PACKS;
  if (raw) {
    try { list = JSON.parse(raw); } catch { throw new Error('PACKS must be valid JSON'); }
  }
  if (!Array.isArray(list) || !list.length) throw new Error('PACKS must be a non-empty list');
  const seen = new Set();
  return list.map((p) => {
    const ok = p && /^[a-z0-9_-]{1,16}$/i.test(String(p.id))
      && Number.isInteger(p.scans) && p.scans > 0 && p.scans <= 100000
      && Number.isInteger(p.cents) && p.cents >= 50 && p.cents <= 500000;
    if (!ok || seen.has(p.id)) throw new Error(`PACKS has an invalid or repeated entry: ${JSON.stringify(p)}`);
    seen.add(p.id);
    return { id: String(p.id), scans: p.scans, cents: p.cents };
  });
}

function createPayments({ secretKey, webhookSecret, packs, currency = 'usd', apiHost }) {
  const enabled = !!(secretKey && webhookSecret);
  let stripe = null;
  if (enabled) {
    const opts = {};
    if (apiHost) { // tests point this at a local fake Stripe
      const u = new URL(apiHost);
      Object.assign(opts, { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') });
    }
    stripe = new Stripe(secretKey, opts);
  }

  const byId = new Map(packs.map((p) => [p.id, p]));

  return {
    enabled,
    currency,
    packs,
    pack: (id) => byId.get(String(id)) || null,

    async createCheckout({ accountId, pack, baseUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency,
            unit_amount: pack.cents,
            product_data: { name: `Blip poster scans: ${pack.scans}` },
          },
        }],
        client_reference_id: accountId,
        metadata: { accountId, packId: pack.id },
        success_url: `${baseUrl}/me?paid=1`,
        cancel_url: `${baseUrl}/me`,
      });
      return session.url;
    },

    /** Throws if the signature is wrong or the body was changed. */
    verifyEvent(rawBody, signature) {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}

module.exports = { parsePacks, createPayments, DEFAULT_PACKS };
