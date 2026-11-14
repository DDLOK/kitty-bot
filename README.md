# kitty-bot-py

Python Discord bot — moderation + music (Lavalink) + utility + fun.

**Prefix:** `]` — also exposes slash commands for music.

## Why this exists

The Node version ran into Discord voice UDP being blocked on free hosts. This version uses **Lavalink** — the bot talks to a Lavalink server via WebSocket (TCP only), and Lavalink handles the Discord voice UDP on its own clean network. So **voice works even on hosts that block UDP out**.

## Setup

```bash
pip install -r requirements.txt
```

Copy `.env.example` → `.env` and fill:

```
DISCORD_TOKEN=your_bot_token
GUILD_ID=your_server_id       # optional, speeds up slash command registration
LAVALINK_URI=https://lava-v4.ajieblogs.eu.org:443
LAVALINK_PASSWORD=https://dsc.gg/ajidevserver
```

Those Lavalink defaults point at a free public node — works out of the box.

Run:

```bash
python main.py
```

## Commands

### Moderation
`]clear [n]` `]ban @u [reason]` `]unban <id>` `]kick @u [reason]` `]mute @u <dur> [reason]` `]unmute @u` `]warn @u <reason>` `]lock` `]unlock` `]slowmode <sec>`

### Music
`]play <url or search>` `]skip` `]stop` `]pause` `]resume` `]queue` `]nowplaying` `]volume 0-200` `]loop` `]shuffle` `]join` `]leave`

Slash versions of core music: `/play` `/skip` `/stop` `/queue`.

### Utility
`]help` `]ping` `]userinfo` `]serverinfo` `]avatar` `]banner` `]embed <title> | <desc>` `]say <text>` `]announce <text>` `]botinfo` `]invite` `]members`

### Fun
`]snipe` `]editsnipe` `]afk [reason]` `]8ball <question>` `]coinflip` `]dice [sides]` `]choose a | b | c` `]poll <question>` `]gay [@u]` `]ship @a @b` `]hug @u` `]slap @u` `]kiss @u` `]pat @u` `]bonk @u`

## Hosting

Works on **bot-hosting.net** (free), Discloud, Fly.io, Railway, Oracle Cloud, your own VPS, etc.

For bot-hosting:

1. Create server → **Python** egg
2. Upload this folder (or point at GitHub repo)
3. Startup: `pip install -r requirements.txt && python main.py`
4. Set `DISCORD_TOKEN` + `GUILD_ID` in variables
5. Start
