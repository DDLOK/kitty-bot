# kitty-songs — Cloudflare Worker

A tiny worker that hosts song pages for the bot. Each song gets a pretty shareable URL like `https://kitty-songs.<your-subdomain>.workers.dev/s/x7kp2qa9`.

## Setup (one-time, ~5 min)

Prereqs: a Cloudflare account + Node 18+.

1. Install wrangler globally:
   ```
   npm install -g wrangler
   ```

2. Log in:
   ```
   wrangler login
   ```

3. From this folder, create a KV namespace:
   ```
   wrangler kv:namespace create SONGS
   ```
   Copy the returned `id = "..."` value.

4. Open `wrangler.toml`, paste that id in place of `PASTE_KV_NAMESPACE_ID_HERE`.

5. Set the auth secret (any random string — the bot needs to match this):
   ```
   wrangler secret put SECRET
   ```
   Paste a random 32+ char string when prompted (e.g. `openssl rand -hex 24`).

6. Deploy:
   ```
   wrangler deploy
   ```
   Output shows your URL — something like `https://kitty-songs.YOUR-SUBDOMAIN.workers.dev`.

## Wire up the bot

In the bot's `.env` (or Pterodactyl variables on bot-hosting), set:

```
CLOUDFLARE_WORKER_URL=https://kitty-songs.YOUR-SUBDOMAIN.workers.dev
CLOUDFLARE_WORKER_SECRET=the_same_secret_from_step_5
```

Restart the bot. From now on, every song played shows a `🔗 Share: https://kitty-songs.../s/xxxxxx` link on the music panel. Visit that URL in a browser to see a pretty page with the song embedded.

## Endpoints

- `POST /create` with `Authorization: Bearer <SECRET>` + JSON body `{ title, author, uri, thumbnail, duration_ms, requested_by }` → `{ id, url }`
- `GET /s/:id` → pretty HTML page with embedded player
- Song entries auto-expire after 7 days (KV TTL).
