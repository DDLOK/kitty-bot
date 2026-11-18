# EZLARP — Discord login (bot side)

This bot now runs a small aiohttp web server alongside the Discord gateway. The site at
https://ezlarp.pages.dev hits `/login` → the user signs in with Discord → the bot adds
them to your server and redirects back to the site with a signed JWT.

## 1. Discord dev portal (one-time)

1. https://discord.com/developers/applications → your bot app
2. **OAuth2** → **General**
   - **Redirects** → **Add Redirect** → `<PUBLIC_URL>/callback`  (replace with your actual public URL)
   - Save
3. **Reset Client Secret** → copy the new value → you'll paste it into `CLIENT_SECRET` env below.
4. **OAuth2** → **URL Generator** / scopes used: `identify`, `guilds.join` (the bot requests these at login time, no further setup needed here).
5. **Bot** tab → make sure the bot has **Create Instant Invite** permission in the server.
6. If `MEMBER_ROLE_ID` is set, the bot's own role must sit **above** that member role in the server's role list (Server Settings → Roles → drag).

## 2. Env vars (bot-hosting Variables tab, or local `.env`)

```
BOT_TOKEN=           # leave blank → uses DISCORD_TOKEN
CLIENT_ID=1566881552833712198
CLIENT_SECRET=<fresh secret from step 3>
GUILD_ID=1567611617762476136
MEMBER_ROLE_ID=      # optional
AUTH_SECRET=<MUST be identical to AUTH_SECRET on Cloudflare side>
PUBLIC_URL=https://<your-public-bot-url>   # no trailing slash
PORT=8080
```

Generate a strong `AUTH_SECRET` with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Put the **same value** on the Cloudflare Workers side so JWTs verify.

## 3. Make the bot's web server reachable over HTTPS

The web server binds to `0.0.0.0:$PORT` (default 8080) **inside bot-hosting's container**.
Bot-hosting doesn't give you a public HTTPS URL out of the box, so you need to tunnel.
Easiest: **Cloudflare Tunnel** (free).

### Cloudflare Tunnel (recommended)

1. https://one.dash.cloudflare.com → **Access** → **Tunnels** → **Create a tunnel**
2. Pick connector: **Cloudflared**, name it `ezlarp-bot`, save.
3. Install on bot-hosting: in the bot-hosting server console (the Python one), run:
   ```
   curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
   chmod +x cloudflared
   ./cloudflared tunnel run --token <TOKEN_FROM_CLOUDFLARE>
   ```
   Run this in the **background** (or as a second server with a shell egg).
4. In the Cloudflare tunnel dashboard → **Public Hostnames** → add one:
   - Subdomain: `kitty`
   - Domain: pick one of yours (or a free `pages.dev` domain)
   - Service: `http://localhost:8080`
5. Final URL: `https://kitty.<yourdomain>` → that goes in `PUBLIC_URL`.

### Alternatives

- If bot-hosting ever gives you a direct HTTP allocation (`http://1.2.3.4:12345`), use that
  for `PUBLIC_URL` — but Discord REQUIRES https for OAuth redirect URIs, so Tunnel is the real path.
- Deploy the bot to Fly.io / Railway / a VPS — any of those give you https out of the box.

## 4. Paste into Cloudflare (the website side)

Give the Cloudflare side this value:

```
BOT_LOGIN_URL = <PUBLIC_URL>/login
```

Example: `BOT_LOGIN_URL=https://kitty.example.com/login`

That's the URL EZLARP's "Log in with Discord" button points at.

## 5. Health check

Hit `https://<PUBLIC_URL>/` in a browser. You should see:

```
EZLARP login OK
```

If you get a 502 or a timeout, the tunnel/network isn't set up right.

## 6. Test the JWT minting

In a terminal inside the bot folder:

```bash
pip install -r requirements.txt
```

```bash
AUTH_SECRET=whatever python test_auth.py
```

(Windows PowerShell: `$env:AUTH_SECRET='whatever'; python test_auth.py`)

Expected output:

```
test_payload_shape: OK
test_header_alg: OK
test_name_truncation: OK
test_avatar_none_ok: OK
test_signature_rejects_tamper: OK

All tests passed.
```

## 7. End-to-end sanity

In a browser, hit:

```
https://<PUBLIC_URL>/login?return=https://ezlarp.pages.dev/auth/done
```

You should be bounced to Discord → authorize → bounced back to
`https://ezlarp.pages.dev/auth/done?token=<jwt>`. The site decodes + verifies the JWT.

If something's off along the way, the redirect carries `?error=<short message>` instead
and the bot logs the real cause to its console.
