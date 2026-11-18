"""
EZLARP Discord OAuth2 web server — runs alongside the bot in the same process.

Endpoints:
  GET /           -> health check
  GET /login      -> redirects to Discord OAuth
  GET /callback   -> code exchange, add to guild, mint JWT, redirect to return URL

Config (env vars):
  BOT_TOKEN           — bot's token (falls back to DISCORD_TOKEN)
  CLIENT_ID           — Discord application ID
  CLIENT_SECRET       — Discord OAuth2 client secret (falls back to DISCORD_CLIENT_SECRET)
  GUILD_ID            — server to add the user to
  MEMBER_ROLE_ID      — optional role ID to apply on join
  AUTH_SECRET         — HS256 signing secret (must match Cloudflare side)
  PUBLIC_URL          — public https URL the bot server is reachable at
  PORT                — port to bind the web server to (default 8080)
"""
import os
import secrets as secrets_mod
import time
import logging

import aiohttp
from aiohttp import web
import jwt

log = logging.getLogger("ezlarp")

ALLOWED_RETURNS = {"https://ezlarp.pages.dev/auth/done"}

DISCORD_API = "https://discord.com/api/v10"


def _cfg():
    return {
        "bot_token": os.environ.get("BOT_TOKEN") or os.environ.get("DISCORD_TOKEN", ""),
        "client_id": os.environ.get("CLIENT_ID", ""),
        "client_secret": os.environ.get("CLIENT_SECRET") or os.environ.get("DISCORD_CLIENT_SECRET", ""),
        "guild_id": os.environ.get("GUILD_ID", ""),
        "member_role_id": os.environ.get("MEMBER_ROLE_ID", ""),
        "auth_secret": os.environ.get("AUTH_SECRET", ""),
        "public_url": (os.environ.get("PUBLIC_URL") or "").rstrip("/"),
        "port": int(os.environ.get("PORT", 8080)),
    }


def mint_token(user_id: str, name: str, avatar, joined: bool, auth_secret: str) -> str:
    """Build the HS256 JWT exactly as the spec demands."""
    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "name": (name or "")[:64],
        "avatar": avatar,  # hash string or None
        "joined": bool(joined),
        "aud": "ezlarp",
        "iat": now,
        "exp": now + 120,   # 2 minutes — well under the 600s hard cap
        "jti": secrets_mod.token_urlsafe(16),
    }
    return jwt.encode(payload, auth_secret, algorithm="HS256", headers={"alg": "HS256", "typ": "JWT"})


def _redirect_with_error(return_url: str, msg: str) -> web.Response:
    # Short error message in a query param
    from urllib.parse import quote
    return web.HTTPFound(f"{return_url}?error={quote(msg[:120])}")


async def handle_health(request: web.Request) -> web.Response:
    return web.Response(text="EZLARP login OK", content_type="text/plain")


async def handle_login(request: web.Request) -> web.Response:
    cfg = _cfg()
    ret = request.query.get("return", "")
    if ret not in ALLOWED_RETURNS:
        return web.Response(text="bad return", status=400)
    if not cfg["client_id"] or not cfg["public_url"]:
        return web.Response(text="server not configured", status=500)

    state = secrets_mod.token_urlsafe(32)
    cookie_val = f"{state}|{ret}"

    from urllib.parse import urlencode
    params = {
        "client_id": cfg["client_id"],
        "response_type": "code",
        "scope": "identify guilds.join",
        "redirect_uri": f"{cfg['public_url']}/callback",
        "state": state,
        "prompt": "none",
    }
    resp = web.HTTPFound(f"https://discord.com/oauth2/authorize?{urlencode(params)}")
    resp.set_cookie(
        "ezlarp_state", cookie_val,
        max_age=600,          # 10 minutes
        httponly=True,
        secure=True,
        samesite="Lax",
        path="/",
    )
    return resp


async def handle_callback(request: web.Request) -> web.Response:
    cfg = _cfg()
    cookie = request.cookies.get("ezlarp_state", "")
    if "|" not in cookie:
        return web.Response(text="missing state cookie", status=400)
    saved_state, saved_return = cookie.split("|", 1)
    if saved_return not in ALLOWED_RETURNS:
        return web.Response(text="bad return in cookie", status=400)

    # Prepare a response we can attach a cookie-clear header to
    def finalize(resp: web.Response) -> web.Response:
        resp.del_cookie("ezlarp_state", path="/")
        return resp

    # User cancelled or Discord errored
    discord_err = request.query.get("error")
    if discord_err:
        return finalize(_redirect_with_error(saved_return, discord_err))

    state = request.query.get("state", "")
    code = request.query.get("code", "")
    if not state or state != saved_state:
        return finalize(_redirect_with_error(saved_return, "state mismatch"))
    if not code:
        return finalize(_redirect_with_error(saved_return, "missing code"))
    if not cfg["client_id"] or not cfg["client_secret"] or not cfg["auth_secret"]:
        return finalize(_redirect_with_error(saved_return, "server not configured"))

    try:
        async with aiohttp.ClientSession() as s:
            # 1. Exchange code → access token
            token_body = {
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": f"{cfg['public_url']}/callback",
            }
            async with s.post(
                f"{DISCORD_API}/oauth2/token",
                data=token_body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            ) as r:
                if r.status != 200:
                    log.warning("token exchange failed %s: %s", r.status, await r.text())
                    return finalize(_redirect_with_error(saved_return, "token exchange failed"))
                tok = await r.json()
            access_token = tok.get("access_token")
            if not access_token:
                return finalize(_redirect_with_error(saved_return, "no access token"))

            # 2. Fetch user info
            async with s.get(
                f"{DISCORD_API}/users/@me",
                headers={"Authorization": f"Bearer {access_token}"},
            ) as r:
                if r.status != 200:
                    log.warning("user fetch failed %s", r.status)
                    return finalize(_redirect_with_error(saved_return, "user fetch failed"))
                user = await r.json()
            user_id = str(user.get("id", ""))
            display_name = user.get("global_name") or user.get("username") or ""
            avatar = user.get("avatar")  # hash string or None

            # 3. Try to add user to guild
            joined = False
            if cfg["guild_id"] and cfg["bot_token"]:
                add_body = {"access_token": access_token}
                if cfg["member_role_id"]:
                    add_body["roles"] = [cfg["member_role_id"]]
                async with s.put(
                    f"{DISCORD_API}/guilds/{cfg['guild_id']}/members/{user_id}",
                    json=add_body,
                    headers={
                        "Authorization": f"Bot {cfg['bot_token']}",
                        "Content-Type": "application/json",
                    },
                ) as r:
                    # 201 = joined, 204 = already in
                    if r.status in (201, 204):
                        joined = True
                    else:
                        log.warning("guild add failed %s: %s", r.status, await r.text())
                        joined = False

        # 4. Mint JWT
        token = mint_token(user_id, display_name, avatar, joined, cfg["auth_secret"])
        from urllib.parse import quote
        return finalize(web.HTTPFound(f"{saved_return}?token={quote(token)}"))

    except Exception as e:
        log.exception("callback error")
        return finalize(_redirect_with_error(saved_return, f"server error: {e}"))


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", handle_health)
    app.router.add_get("/login", handle_login)
    app.router.add_get("/callback", handle_callback)
    return app


async def start_web_server() -> web.AppRunner:
    cfg = _cfg()
    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", cfg["port"])
    await site.start()
    log.info("EZLARP auth server listening on 0.0.0.0:%d (public: %s)", cfg["port"], cfg["public_url"] or "NOT SET")
    print(f"EZLARP auth server listening on 0.0.0.0:{cfg['port']} (public: {cfg['public_url'] or 'NOT SET'})")
    return runner
