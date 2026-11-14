# discord-clear-bot

Prefix-based Discord moderation bot. Prefix: **`]`**

## Setup

1. Make the bot at https://discord.com/developers/applications
   - **Bot** tab → reset token, copy it.
   - **Bot** tab → turn ON **MESSAGE CONTENT INTENT** and **SERVER MEMBERS INTENT** (both required).
   - Invite with scopes `bot` + `applications.commands` and permission integer `1099780074743` (or just Administrator for testing).
2. Copy `.env.example` → `.env`, fill `DISCORD_TOKEN` and `CLIENT_ID` (GUILD_ID is optional, only needed if you also want slash commands — this bot doesn't register any by default).
3. Run:

```bash
cd discord-clear-bot
npm install
npm start
```

## Commands

Type `]help` in your server to see them all. Full list:

### Moderation
| Command | Usage | Perm |
|---|---|---|
| `]clear` / `]purge` / `]c` | `]clear [amount]` | Manage Messages |
| `]ban` | `]ban @user [reason]` | Ban Members |
| `]unban` | `]unban <userId> [reason]` | Ban Members |
| `]softban` | `]softban @user [reason]` | Ban Members |
| `]kick` | `]kick @user [reason]` | Kick Members |
| `]mute` / `]timeout` / `]to` | `]mute @user 10m [reason]` | Moderate Members |
| `]unmute` | `]unmute @user` | Moderate Members |
| `]warn` | `]warn @user <reason>` | Moderate Members |

### Channel
| Command | Usage | Perm |
|---|---|---|
| `]lock` | `]lock` | Manage Channels |
| `]unlock` | `]unlock` | Manage Channels |
| `]hide` | `]hide` | Manage Channels |
| `]unhide` / `]show` | `]unhide` | Manage Channels |
| `]slowmode` / `]slow` | `]slowmode 30s` | Manage Channels |
| `]nuke` | `]nuke` (clones channel, deletes old) | Manage Channels |

### Roles
| Command | Usage | Perm |
|---|---|---|
| `]role add` | `]role add @user @role` | Manage Roles |
| `]role remove` | `]role remove @user @role` | Manage Roles |
| `]role create` | `]role create <name>` | Manage Roles |
| `]role delete` | `]role delete @role` | Manage Roles |

### Member
| Command | Usage |
|---|---|
| `]nick` | `]nick @user <nick>` (Manage Nicknames) |
| `]resetnick` | `]resetnick @user` |
| `]avatar` / `]av` / `]pfp` | `]avatar [@user]` |
| `]banner` | `]banner [@user]` |
| `]userinfo` / `]ui` / `]whois` | `]userinfo [@user]` |

### Server
| Command | Usage |
|---|---|
| `]serverinfo` / `]si` | `]serverinfo` |
| `]icon` | `]icon` |
| `]members` | `]members` |
| `]roles-list` | `]roles-list` |

### Utility
| Command | Usage |
|---|---|
| `]say` | `]say <text>` (Manage Messages) |
| `]embed` | `]embed <title> \| <description>` (Manage Messages) |
| `]ping` | `]ping` |
| `]uptime` | `]uptime` |
| `]invite` | `]invite` |
| `]help` | `]help` |

## Duration format

Where duration is accepted: `30s`, `10m`, `2h`, `1d`, `1w`. Max timeout is 28 days.

## Notes

- Bulk delete only works on messages ≤14 days old. Older messages fall back to single-delete (slower).
- The bot's role must be **above** any role it's trying to moderate.

## Hosting (so it runs 24/7)

Running `npm start` on your PC works, but the bot dies the second you close the terminal. For always-on hosting:

### Free / cheap options

| Host | Price | Pros | Cons |
|---|---|---|---|
| **Railway** | Free trial ($5 credit/mo) → ~$5/mo after | Dead simple — connect GitHub repo, set env vars, deploy | Trial runs out |
| **Fly.io** | Generous free tier (3 small VMs) | Fast, free, global | CLI-based, slightly technical |
| **Render** | Free (sleeps) / $7/mo always-on | GitHub integration | Free tier spins down |
| **Replit** | Free with "Always On" paid add-on | Browser IDE, zero setup | Free tier sleeps |
| **Oracle Cloud Free Tier** | Permanently free 2 ARM VMs | Real VPS, powerful, forever | Complex setup |
| **Hetzner Cloud** | ~€4/mo (CX11) | Cheapest real VPS, fast | Linux skills needed |
| **Raspberry Pi at home** | One-time ~$50 | Yours forever | Your power/wifi |

### Recommended: Railway (easiest)

1. Push this folder to a **GitHub repo** (private is fine).
2. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**.
3. Pick the repo.
4. Go to **Variables** → add `DISCORD_TOKEN` and `CLIENT_ID` (and `GUILD_ID` if you want).
5. Done. It auto-deploys on every git push.

### Recommended: Oracle Cloud (free forever)

1. Make an Oracle Cloud account (needs a credit card for verification, won't be charged).
2. Spin up a free ARM Ampere VM (Ubuntu).
3. SSH in, install Node 20: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install nodejs`
4. `git clone` your repo, `cd` in, `npm install`.
5. Make a `.env` file with your tokens.
6. Install pm2: `sudo npm i -g pm2` — then `pm2 start index.js --name kitty && pm2 save && pm2 startup`.
7. Bot survives reboots forever.

### ⚠️ Don't

- Don't host on **Heroku** free tier (dead).
- Don't commit your `.env` file to GitHub — add it to `.gitignore` (already done).
- Don't share your bot token. Ever. If you leak it, reset it on the dev portal.

