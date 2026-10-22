# Blip

60-second chats you join by scanning a QR code. Anyone can visit the site, tap **Share QR code** or **Print QR code**, and whoever scans it joins a live chat. Everyone chooses whether to stay anonymous. Text, photos, PDFs and voice notes work. Nothing is saved.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # server smoke test, poster/payment tests, client flow test
```

Needs Node 20 or newer. Open it in two browser windows to try a chat. The microphone only works on `https://` pages (or `localhost`).

## Put it online

Blip keeps chats in memory and talks over WebSockets, so it needs a host that runs a long-lived Node process. Vercel and other serverless platforms won't work.

- **Render:** push this folder to a Git repo, then New > Blueprint. `render.yaml` does the rest. Use a paid always-on instance with a persistent disk (see "Posters and scans" below), because free instances sleep and that ends live chats.
- **Fly.io, Railway, any VPS:** use the included `Dockerfile` (listens on `PORT`, default 8080). Put it behind HTTPS.
- Run **one instance only**. Chats live in that process's memory, so scaling out would split people into different rooms.

Set `TRUST_PROXY=1` when behind a proxy so rate limits see real visitor addresses. Set `PUBLIC_URL=https://your-domain` if the QR codes should point at a fixed address.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on |
| `PUBLIC_URL` | from the request | Address printed in the QR code |
| `TRUST_PROXY` | off | Number of proxies in front (use `1` on Render, Fly, Railway) |
| `CHAT_SECONDS` | 60 | Chat length, and the time added by each extension |
| `MAX_TOTAL_MINUTES` | 30 | Hard cap on one chat, however many extensions |
| `LOBBY_MINUTES` | 15 | How long a QR code waits for a first person to join |
| `MAX_PEOPLE` | 8 | People per chat |
| `MAX_ROOMS` | 500 | Chats running at once |
| `MAX_STORE_MB` | 400 | Memory budget for shared files across all chats |
| `CREATE_PER_HOUR` | 12 | Chats one network address can start per hour |
| `REPORT_DIR` | `./reports` | Where reports are written |
| `DATA_DIR` | `./data` | Where accounts, posters and scan balances are saved (`blip-data.json`) |
| `DATA_DURABLE` | off | Set to `1` once `DATA_DIR` is on a persistent disk. Until then the app warns owners that balances can reset |
| `FOUNDER_LIMIT` | 100 | How many people can claim a free founder spot |
| `FREE_SCANS` | 20 | Free scans for a founder, and for each invited friend |
| `FOUNDER_INVITES` | 2 | Single-use invite links each founder can make |
| `INVITEE_INVITES` | 0 | Invite links an invited friend gets (set to `2` to let invites chain) |
| `MAX_POSTERS` | 5 | Posters one account can have |
| `MAX_PENDING` | 5 | Scans of one poster allowed to wait for the owner at once |
| `POSTER_LOBBY_SECONDS` | 180 | How long a scan waits for the owner before it closes and is refunded |
| `DEVICE_PER_HOUR` / `CLAIMS_PER_HOUR` | 8 / 6 | New accounts and claims per network address per hour |
| `STRIPE_SECRET_KEY` | off | Stripe secret key. Buying is switched off until this and the next one are set |
| `STRIPE_WEBHOOK_SECRET` | off | Signing secret of the Stripe webhook |
| `PACKS` | 20/$2, 100/$7, 500/$25 | JSON list like `[{"id":"s20","scans":20,"cents":200}]`. **The default prices are placeholders** |
| `CURRENCY` | usd | Currency for packs |

## How a chat works

1. A visitor taps Share or Print, accepts the warning (18+, rules), and picks anonymous or a name.
2. Blip makes a room and a one-time QR code. Share opens the phone's share sheet; Print opens a printable poster.
3. The first person to scan and join starts the 60 seconds for everyone.
4. In the last 30 seconds anyone can add 60 more, up to 30 minutes in total.
5. When time runs out, everyone is told, the room is deleted, and every file is dropped from memory.

If nobody joins within 15 minutes the QR code expires. If everyone leaves, the room is deleted straight away.

## Posters, scans and invites

Share-QR chats (above) stay free and open to everyone. **Poster QR codes** are the growth feature:

- **My Blip** (`/me`) is each person's page. There are no emails or passwords. The browser keeps a random device ID and secret, and Blip stores only a hash of the secret. **Copy recovery link** is the only way back if the browser is cleared, so tell people to save it.
- **Founder spots:** the first 100 people who tap **Claim** get 20 free scans and 2 invite links. Visiting the site alone claims nothing.
- **Invite links** work once. The friend gets 20 free scans, and by default no invite links of their own.
- **Posters:** each account can make up to 5. A poster has one stable QR code, so printed copies keep working. Each scan spends one scan from the owner and opens a separate one-to-one chat. The same person can scan again and again, and different people can each open their own chat, until the scans run out.
- **Owner inbox:** while My Blip is open, the owner sees waiting scans (checked every 3 seconds) and taps **Join chat**. There are no push notifications. If nobody is waiting when a scan closes (scanner left, or the owner didn't join in 3 minutes), the scan is refunded.
- **Out of scans:** scanners see "This poster is out of scans". They never see the owner's balance.
- **Buying more:** Stripe Checkout, three packs. The price comes from the server's `PACKS`, never the browser. Scans are added only by the signed webhook (idempotent), not by the page people return to after paying.

### Turning payments on

1. In Stripe, create an account and copy the secret key (start with the **test** key `sk_test_...`).
2. Add a webhook endpoint at `https://YOUR-SITE/api/stripe/webhook` for the event `checkout.session.completed`, and copy its signing secret.
3. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in your host's environment settings (never in the repo), and set `PACKS` to the real prices.
4. Pay with Stripe's test card `4242 4242 4242 4242` and check that the scans appear.

### Saving data

Accounts, posters and balances are saved to `DATA_DIR/blip-data.json` (written atomically; a damaged file is set aside, not overwritten). On a host without a persistent disk (Render's free plan, for example) that file disappears whenever the server restarts or sleeps, which wipes balances and posters, **including paid ones**. Before taking real money, move to a paid instance with a disk mounted at `DATA_DIR`, then set `DATA_DURABLE=1`.

### Limits to know about

- A device ID is not an identity. Someone who clears their browser can claim another founder spot, and the rate limits above only slow that down.
- The founder counter is global, so it resets if the data file is lost.
- Run one instance only; accounts and chats live in that process.

## Safety choices already built in

- Anonymous users get random names like "Quiet Otter". Names people type are cleaned of invisible and look-alike characters.
- Links in messages are not clickable. Pictures from other people start blurred until tapped.
- Photos are re-drawn in the sender's browser, which removes location and camera data.
- Uploads are checked by their actual bytes, not the file name or claimed type. Only images, PDFs and audio are accepted, with size limits. Files are served with a sandbox policy and PDFs always download.
- Rate limits on starting chats, messages, uploads and connections. Cross-site WebSocket connections are refused.
- **Hide** removes a person's messages from your screen. **Report** sends the chat's names and last 20 text messages (never files) to `reports/reports.jsonl`. Someone has to read that file.

## Before you launch publicly

- **The host can see everything.** Messages and files pass through the server and sit in its memory until the chat ends. "Anonymous" means anonymous to other chat members, not to you. Don't describe it as end-to-end encrypted.
- **Have a lawyer review the in-app notice and rules** (`public/index.html`, "Read this first" and "Rules and privacy"). The 18+ check is a self-declared tick box. Depending on where you operate, running an anonymous chat service can carry duties around age checks, illegal content, takedowns and reporting (for example to NCMEC in the US).
- **Plan for moderation.** Nothing watches chats live. Decide who reads reports and what you do about repeat abusers. Blocking by address is the next feature to add, if you need it.
- **Payments.** Check Stripe's rules for your business type (anonymous chat services can get extra review), decide refund and sales-tax handling, and add terms for buying scans. Replace the placeholder prices.
- **Real-device check.** Automated tests cover the server and the page logic. Try voice notes, the share sheet and printing on actual phones before sharing the link widely.

## Files

- `server.js`: rooms, timer, WebSocket chat, uploads, QR codes, reports
- `lib/`: `api.js` (accounts, posters, invites, checkout, webhook), `store.js` (saved data), `payments.js` (Stripe), `util.js`
- `public/`: the single-page app (`index.html`, `style.css`, `app.js`) and the self-hosted font
- `test/`: `smoke.js` and `posters.js` drive the real server (posters.js uses a fake Stripe); `ui.js` drives the real page in jsdom

The font is Bricolage Grotesque by Mathieu Triay and collaborators, licensed under the SIL Open Font License 1.1.
