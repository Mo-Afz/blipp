# Blip

60-second chats you join by scanning a QR code. Anyone can visit the site, tap **Share QR code** or **Print QR code**, and whoever scans it joins a live chat. Everyone chooses whether to stay anonymous. Text, photos, PDFs and voice notes work. Nothing is saved.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # server smoke test + client flow test
```

Needs Node 20 or newer. Open it in two browser windows to try a chat. The microphone only works on `https://` pages (or `localhost`).

## Put it online

Blip keeps chats in memory and talks over WebSockets, so it needs a host that runs a long-lived Node process. Vercel and other serverless platforms won't work.

- **Render:** push this folder to a Git repo, then New > Blueprint. `render.yaml` does the rest. Use a paid always-on instance, because free instances sleep and that ends live chats.
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

## How a chat works

1. A visitor taps Share or Print, accepts the warning (18+, rules), and picks anonymous or a name.
2. Blip makes a room and a one-time QR code. Share opens the phone's share sheet; Print opens a printable poster.
3. The first person to scan and join starts the 60 seconds for everyone.
4. In the last 30 seconds anyone can add 60 more, up to 30 minutes in total.
5. When time runs out, everyone is told, the room is deleted, and every file is dropped from memory.

If nobody joins within 15 minutes the QR code expires. If everyone leaves, the room is deleted straight away.

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
- **Real-device check.** Automated tests cover the server and the page logic. Try voice notes, the share sheet and printing on actual phones before sharing the link widely.

## Files

- `server.js`: rooms, timer, WebSocket chat, uploads, QR codes, reports
- `public/`: the single-page app (`index.html`, `style.css`, `app.js`) and the self-hosted font
- `test/`: `smoke.js` drives the real server; `ui.js` drives the real page in jsdom

The font is Bricolage Grotesque by Mathieu Triay and collaborators, licensed under the SIL Open Font License 1.1.
