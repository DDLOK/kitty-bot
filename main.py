"""
kitty-bot — Python Discord bot
Moderation + Music (via Lavalink) + Utility + Fun
"""
import os
import json
import random
import asyncio
import datetime as dt
import re
import base64 as b64lib
from pathlib import Path
from typing import Optional

import aiohttp
import discord
from discord.ext import commands
from discord import app_commands
import wavelink
from dotenv import load_dotenv

load_dotenv()
TOKEN = os.environ["DISCORD_TOKEN"]
GUILD_ID = int(os.environ["GUILD_ID"]) if os.environ.get("GUILD_ID") else None
LAVALINK_URI = os.environ.get("LAVALINK_URI", "https://lavalinkv4.serenetia.com:443")
LAVALINK_PASSWORD = os.environ.get("LAVALINK_PASSWORD", "https://dsc.gg/ajidevserver")
PREFIX = "]"
PINK = 0xff66cc

intents = discord.Intents.all()

PLAYLIST_FILE = Path("playlists.json")

def load_playlists() -> dict:
    if PLAYLIST_FILE.exists():
        try: return json.loads(PLAYLIST_FILE.read_text())
        except: return {}
    return {}

def save_playlists(data: dict):
    PLAYLIST_FILE.write_text(json.dumps(data, indent=2))

class KittyBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix=PREFIX, intents=intents, help_command=None)
        self.snipes: dict[int, discord.Message] = {}
        self.edit_snipes: dict[int, tuple[discord.Message, discord.Message]] = {}
        self.afk: dict[int, tuple[str, dt.datetime]] = {}
        self.playlists = load_playlists()  # {user_id_str: {playlist_name: [urls...]}}

    async def setup_hook(self):
        # Hardcoded known-working node (serenetia). Env vars are ignored if they
        # point at the dead ajieblogs node — that one always 404/429s now.
        BLACKLISTED = {"lava-v4.ajieblogs.eu.org"}
        nodes = []
        if LAVALINK_URI and not any(b in LAVALINK_URI for b in BLACKLISTED):
            nodes.append(wavelink.Node(uri=LAVALINK_URI, password=LAVALINK_PASSWORD))
        # Always add serenetia as backup (and primary if env is blacklisted)
        if not any("serenetia" in (n.uri or "") for n in nodes):
            nodes.append(wavelink.Node(
                uri="https://lavalinkv4.serenetia.com:443",
                password="https://dsc.gg/ajidevserver",
            ))
        try:
            await wavelink.Pool.connect(nodes=nodes, client=self, cache_capacity=100)
            print(f"Connecting to {len(nodes)} Lavalink node(s)...")
        except Exception as e:
            print(f"Lavalink connect failed: {e}")
        # Register slash commands
        if GUILD_ID:
            guild = discord.Object(id=GUILD_ID)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

bot = KittyBot()

# =============== HELPERS ===============

def pink_embed(title: str = "", desc: str = "") -> discord.Embed:
    e = discord.Embed(color=PINK)
    if title: e.title = title
    if desc: e.description = desc
    return e

def fmt_duration(ms: int) -> str:
    s = ms // 1000
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

async def ok(ctx, text: str):
    await ctx.send(text)

async def bad(ctx, text: str):
    await ctx.send(text)

# =============== EVENTS ===============

@bot.event
async def on_ready():
    print(f"Ready as {bot.user} — prefix \"{PREFIX}\"")
    await bot.change_presence(activity=discord.Activity(type=discord.ActivityType.listening, name=f"{PREFIX}help"))

@bot.event
async def on_wavelink_node_ready(payload: wavelink.NodeReadyEventPayload):
    print(f"Lavalink node ready: {payload.node.uri}")

@bot.event
async def on_wavelink_track_end(payload: wavelink.TrackEndEventPayload):
    player: wavelink.Player = payload.player
    if not player:
        return
    # Push ended track to history for the back button
    history = getattr(player, "history_list", None)
    if history is None:
        history = []
        player.history_list = history
    if payload.track:
        history.append(payload.track)
        # Keep last 50 only
        if len(history) > 50:
            history.pop(0)
    try:
        if player.queue:
            next_track = player.queue.get()
            await player.play(next_track)
        else:
            await asyncio.sleep(60)
            if player.connected and not player.playing:
                await player.disconnect()
    except Exception as e:
        print(f"track end error: {e}")

def make_progress_bar(position: int, length: int, size: int = 15) -> str:
    """Return a progress bar like '0:42 ▬▬▬🔘▬▬▬▬ 3:21'"""
    if not length:
        return "`🔴 LIVE`"
    pct = min(1.0, position / length)
    filled = int(pct * size)
    bar = "▬" * filled + "🔘" + "▬" * (size - filled - 1)
    return f"`{fmt_duration(position)}` {bar} `{fmt_duration(length)}`"

def make_now_playing_embed(player: wavelink.Player) -> discord.Embed:
    t = player.current
    e = pink_embed("🎶 Now Playing")
    e.description = f"### [{t.title}]({t.uri or ''})\n**{t.author}**\n\n{make_progress_bar(player.position, t.length)}"
    if t.artwork:
        e.set_thumbnail(url=t.artwork)
    # Footer with mode + volume
    loop_mode = "🔁" if player.queue.mode == wavelink.QueueMode.loop_all else ("🔂" if player.queue.mode == wavelink.QueueMode.loop else "")
    e.set_footer(text=f"vol {player.volume}% • queue: {len(player.queue)} {loop_mode}")
    return e

class MusicControls(discord.ui.View):
    def __init__(self, player: wavelink.Player):
        super().__init__(timeout=None)
        self.player = player

    async def update_display(self, interaction: discord.Interaction):
        if self.player.current:
            try:
                await interaction.message.edit(embed=make_now_playing_embed(self.player), view=self)
            except Exception as e:
                print(f"display update failed: {e}")

    @discord.ui.button(emoji="⏮️", style=discord.ButtonStyle.secondary, row=0)
    async def back_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        history = getattr(self.player, "history_list", [])
        if not history:
            return await interaction.response.send_message("no previous track in history.", ephemeral=True)
        prev = history.pop()
        # Put current track back at front of queue, then play the previous
        if self.player.current:
            self.player.queue.put_at(0, self.player.current)
        await interaction.response.defer()
        await self.player.play(prev)

    @discord.ui.button(emoji="⏯️", style=discord.ButtonStyle.primary, row=0)
    async def pause_resume(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.player.pause(not self.player.paused)
        await interaction.response.defer()
        await self.update_display(interaction)

    @discord.ui.button(emoji="⏭️", style=discord.ButtonStyle.secondary, row=0)
    async def skip_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.player.skip(force=True)
        await interaction.response.send_message("⏭️ skipped.", ephemeral=True)

    @discord.ui.button(emoji="⏹️", style=discord.ButtonStyle.danger, row=0)
    async def stop_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.player.queue.clear()
        await self.player.disconnect()
        for item in self.children: item.disabled = True
        await interaction.response.edit_message(view=self)
        await interaction.followup.send("⏹️ stopped.", ephemeral=True)

    @discord.ui.button(emoji="🔁", style=discord.ButtonStyle.secondary, row=0)
    async def loop_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.player.queue.mode == wavelink.QueueMode.loop_all:
            self.player.queue.mode = wavelink.QueueMode.normal
        else:
            self.player.queue.mode = wavelink.QueueMode.loop_all
        await interaction.response.defer()
        await self.update_display(interaction)

    @discord.ui.button(emoji="🔀", style=discord.ButtonStyle.secondary, row=1)
    async def shuffle_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if len(self.player.queue) >= 2:
            self.player.queue.shuffle()
        await interaction.response.defer()
        await self.update_display(interaction)

    @discord.ui.button(emoji="🔉", style=discord.ButtonStyle.secondary, row=1)
    async def vol_down(self, interaction: discord.Interaction, button: discord.ui.Button):
        new = max(0, self.player.volume - 10)
        await self.player.set_volume(new)
        await interaction.response.defer()
        await self.update_display(interaction)

    @discord.ui.button(emoji="🔊", style=discord.ButtonStyle.secondary, row=1)
    async def vol_up(self, interaction: discord.Interaction, button: discord.ui.Button):
        new = min(200, self.player.volume + 10)
        await self.player.set_volume(new)
        await interaction.response.defer()
        await self.update_display(interaction)

    @discord.ui.button(emoji="📋", label="Queue", style=discord.ButtonStyle.secondary, row=1)
    async def queue_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.player.queue:
            return await interaction.response.send_message("queue empty.", ephemeral=True)
        lines = [f"**{i}.** {t.title}" for i, t in enumerate(list(self.player.queue)[:15], start=1)]
        extra = f"\n*…and {len(self.player.queue) - 15} more*" if len(self.player.queue) > 15 else ""
        await interaction.response.send_message(embed=pink_embed("📋 Queue", "\n".join(lines) + extra), ephemeral=True)

    @discord.ui.button(emoji="🔄", label="Refresh", style=discord.ButtonStyle.secondary, row=1)
    async def refresh_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        await self.update_display(interaction)

async def send_music_panel(player: wavelink.Player, channel: discord.TextChannel):
    """Send/refresh the music control panel. Safe to call anywhere."""
    if not player or not player.current or not channel:
        return None
    prev = getattr(player, "now_playing_msg", None)
    if prev:
        try: await prev.delete()
        except: pass
    try:
        view = MusicControls(player)
        msg = await channel.send(embed=make_now_playing_embed(player), view=view)
        player.now_playing_msg = msg
        return msg
    except Exception as e:
        print(f"panel send failed: {e}")
        return None

@bot.event
async def on_wavelink_track_start(payload: wavelink.TrackStartEventPayload):
    print(f"[track_start] fired for {payload.track.title}")
    player: wavelink.Player = payload.player
    channel = getattr(player, "home_channel", None)
    if not channel:
        print("[track_start] no home_channel set — skipping UI")
        return
    await send_music_panel(player, channel)
    print(f"[track_start] UI sent to #{channel.name}")

@bot.event
async def on_message_delete(msg: discord.Message):
    if msg.author.bot or not msg.guild:
        return
    bot.snipes[msg.channel.id] = msg

@bot.event
async def on_message_edit(before: discord.Message, after: discord.Message):
    if after.author.bot or not after.guild or before.content == after.content:
        return
    bot.edit_snipes[after.channel.id] = (before, after)

@bot.event
async def on_message(msg: discord.Message):
    if msg.author.bot or not msg.guild:
        return
    # AFK clear
    if msg.author.id in bot.afk:
        _, since = bot.afk.pop(msg.author.id)
        delta = dt.datetime.now(dt.timezone.utc) - since
        try: await msg.reply(f"👋 welcome back — afk for {int(delta.total_seconds())}s")
        except: pass
    # AFK mention
    for u in msg.mentions:
        if u.id in bot.afk:
            reason, since = bot.afk[u.id]
            try: await msg.reply(f"💤 **{u.name}** is afk: {reason}")
            except: pass
    await bot.process_commands(msg)

@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CommandNotFound):
        return
    if isinstance(error, commands.MissingPermissions):
        await ctx.send(f"you need **{', '.join(error.missing_permissions)}** for that.")
        return
    if isinstance(error, commands.BotMissingPermissions):
        await ctx.send(f"i'm missing **{', '.join(error.missing_permissions)}**.")
        return
    if isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"missing argument: `{error.param.name}`")
        return
    if isinstance(error, commands.MemberNotFound):
        await ctx.send(f"couldn't find that member, hun.")
        return
    print(f"error in {ctx.command}: {error}")
    try: await ctx.send(f"💀 crashed: `{error}`")
    except: pass

# =============== HELP ===============

@bot.command(name="help", aliases=["h", "commands"])
async def help_cmd(ctx):
    groups = {
        "Moderation": ["clear", "ban", "unban", "kick", "mute", "unmute", "warn", "lock", "unlock", "slowmode"],
        "Music": ["play", "skip", "stop", "pause", "resume", "queue", "nowplaying", "volume", "loop", "shuffle", "leave", "join"],
        "Utility": ["ping", "userinfo", "serverinfo", "avatar", "banner", "embed", "say", "announce", "botinfo", "invite", "members"],
        "Fun": ["snipe", "editsnipe", "afk", "8ball", "coinflip", "dice", "choose", "poll", "gay", "ship", "hug", "slap", "kiss", "pat", "bonk"],
    }
    e = pink_embed(f"kitty's commands — prefix `{PREFIX}`")
    for k, v in groups.items():
        e.add_field(name=k, value=" ".join(f"`{c}`" for c in v), inline=False)
    e.set_footer(text=f"{PREFIX}help <command> for details  •  built by olivia")
    await ctx.send(embed=e)

# =============== MODERATION ===============

@bot.command(name="clear", aliases=["purge", "c"])
@commands.has_permissions(manage_messages=True)
@commands.bot_has_permissions(manage_messages=True)
async def clear(ctx, amount: int = 100):
    if amount < 1 or amount > 1000:
        return await bad(ctx, "amount must be 1–1000.")
    await ctx.message.delete()
    deleted = 0
    while deleted < amount:
        take = min(100, amount - deleted)
        chunk = await ctx.channel.purge(limit=take)
        if not chunk: break
        deleted += len(chunk)
    note = await ctx.send(f"swept **{deleted}** 🧹✨")
    await asyncio.sleep(4)
    try: await note.delete()
    except: pass

@bot.command(name="ban")
@commands.has_permissions(ban_members=True)
@commands.bot_has_permissions(ban_members=True)
async def ban(ctx, member: discord.Member, *, reason: str = "no reason given"):
    await member.ban(reason=reason)
    await ok(ctx, f"🔨 banned **{member}** — {reason}")

@bot.command(name="unban")
@commands.has_permissions(ban_members=True)
async def unban(ctx, user_id: int, *, reason: str = "no reason"):
    user = await bot.fetch_user(user_id)
    await ctx.guild.unban(user, reason=reason)
    await ok(ctx, f"🕊️ unbanned **{user}**.")

@bot.command(name="kick")
@commands.has_permissions(kick_members=True)
@commands.bot_has_permissions(kick_members=True)
async def kick(ctx, member: discord.Member, *, reason: str = "no reason given"):
    await member.kick(reason=reason)
    await ok(ctx, f"👢 kicked **{member}** — {reason}")

def parse_duration(raw: str) -> Optional[int]:
    """Returns seconds."""
    import re
    m = re.match(r"^(\d+)\s*(s|m|h|d|w)?$", raw.strip().lower())
    if not m: return None
    n = int(m.group(1))
    unit = m.group(2) or "m"
    mult = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
    return n * mult.get(unit, 60)

@bot.command(name="mute", aliases=["timeout", "to"])
@commands.has_permissions(moderate_members=True)
@commands.bot_has_permissions(moderate_members=True)
async def mute(ctx, member: discord.Member, duration: str, *, reason: str = "no reason"):
    sec = parse_duration(duration)
    if not sec: return await bad(ctx, "give a duration like `10m`, `2h`, `1d`.")
    if sec > 28*86400: return await bad(ctx, "max 28 days.")
    await member.timeout(dt.timedelta(seconds=sec), reason=reason)
    await ok(ctx, f"🤫 **{member}** on ice for {duration} — {reason}")

@bot.command(name="unmute", aliases=["untimeout"])
@commands.has_permissions(moderate_members=True)
@commands.bot_has_permissions(moderate_members=True)
async def unmute(ctx, member: discord.Member):
    await member.timeout(None)
    await ok(ctx, f"🔊 **{member}** off the ice.")

@bot.command(name="warn")
@commands.has_permissions(moderate_members=True)
async def warn(ctx, member: discord.Member, *, reason: str):
    try: await member.send(f"⚠️ you got warned in **{ctx.guild.name}** — {reason}")
    except: pass
    await ok(ctx, f"⚠️ warned **{member}** — {reason}")

@bot.command(name="lock")
@commands.has_permissions(manage_channels=True)
@commands.bot_has_permissions(manage_channels=True)
async def lock(ctx):
    await ctx.channel.set_permissions(ctx.guild.default_role, send_messages=False)
    await ok(ctx, "🔒 locked.")

@bot.command(name="unlock")
@commands.has_permissions(manage_channels=True)
@commands.bot_has_permissions(manage_channels=True)
async def unlock(ctx):
    await ctx.channel.set_permissions(ctx.guild.default_role, send_messages=None)
    await ok(ctx, "🔓 unlocked.")

@bot.command(name="slowmode", aliases=["slow"])
@commands.has_permissions(manage_channels=True)
@commands.bot_has_permissions(manage_channels=True)
async def slowmode(ctx, seconds: int = 0):
    if seconds < 0 or seconds > 21600: return await bad(ctx, "0–21600 seconds.")
    await ctx.channel.edit(slowmode_delay=seconds)
    await ok(ctx, "⏱️ slowmode off." if seconds == 0 else f"⏱️ slowmode: {seconds}s.")

# =============== MUSIC (Lavalink) ===============

async def ensure_player(ctx) -> Optional[wavelink.Player]:
    if not ctx.author.voice:
        await bad(ctx, "join a voice channel first, hun.")
        return None
    player: wavelink.Player = ctx.voice_client
    if not player:
        player = await ctx.author.voice.channel.connect(cls=wavelink.Player, self_deaf=True)
    elif player.channel != ctx.author.voice.channel:
        await player.move_to(ctx.author.voice.channel)
    player.home_channel = ctx.channel
    return player

@bot.command(name="play", aliases=["p"])
async def play(ctx, *, query: str):
    player = await ensure_player(ctx)
    if not player: return
    try:
        tracks: wavelink.Search = await wavelink.Playable.search(query)
        if not tracks:
            return await bad(ctx, "nothing found.")

        if isinstance(tracks, wavelink.Playlist):
            added = await player.queue.put_wait(tracks)
            await ok(ctx, f"✅ queued **{added}** tracks from **{tracks.name}**")
        else:
            track = tracks[0]
            await player.queue.put_wait(track)
            await ok(ctx, f"✅ queued **{track.title}** — `{fmt_duration(track.length)}`")

        if not player.playing:
            next_track = player.queue.get()
            await player.play(next_track)
    except Exception as e:
        await bad(ctx, f"💀 play failed: `{e}`")

@bot.command(name="skip", aliases=["s", "next"])
async def skip(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "nothing playing.")
    await player.skip(force=True)
    await ok(ctx, "⏭️ skipped.")

@bot.command(name="stop")
async def stop(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "nothing playing.")
    player.queue.clear()
    await player.stop()
    await player.disconnect()
    await ok(ctx, "⏹️ stopped and left.")

@bot.command(name="pause")
async def pause(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "nothing playing.")
    await player.pause(True)
    await ok(ctx, "⏸️ paused.")

@bot.command(name="resume", aliases=["unpause"])
async def resume(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "nothing to resume.")
    await player.pause(False)
    await ok(ctx, "▶️ resumed.")

@bot.command(name="queue", aliases=["q"])
async def queue(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player or not player.queue: return await bad(ctx, "queue empty.")
    lines = []
    if player.current:
        lines.append(f"🎵 **now:** {player.current.title}")
    for i, t in enumerate(list(player.queue)[:15], start=1):
        lines.append(f"**{i}.** {t.title} — `{fmt_duration(t.length)}`")
    extra = f"\n*…and {len(player.queue) - 15} more*" if len(player.queue) > 15 else ""
    await ctx.send(embed=pink_embed("📋 queue", "\n".join(lines) + extra))

@bot.command(name="nowplaying", aliases=["np"])
async def nowplaying(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player or not player.current: return await bad(ctx, "nothing playing.")
    t = player.current
    e = pink_embed("🎶 now playing", f"**{t.title}**\nby {t.author} — `{fmt_duration(t.length)}`")
    if t.artwork: e.set_thumbnail(url=t.artwork)
    await ctx.send(embed=e)

@bot.command(name="volume", aliases=["vol"])
async def volume(ctx, level: int):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "nothing playing.")
    if level < 0 or level > 200: return await bad(ctx, "0–200.")
    await player.set_volume(level)
    await ok(ctx, f"🔊 volume: {level}%")

@bot.command(name="loop")
async def loop_cmd(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "nothing playing.")
    player.queue.mode = wavelink.QueueMode.loop_all if player.queue.mode != wavelink.QueueMode.loop_all else wavelink.QueueMode.normal
    await ok(ctx, f"🔁 loop {'on' if player.queue.mode == wavelink.QueueMode.loop_all else 'off'}.")

@bot.command(name="shuffle")
async def shuffle(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player or len(player.queue) < 2: return await bad(ctx, "need 2+ in queue.")
    player.queue.shuffle()
    await ok(ctx, "🔀 shuffled.")

@bot.command(name="join")
async def join(ctx):
    player = await ensure_player(ctx)
    if player: await ok(ctx, f"👋 joined <#{player.channel.id}>.")

@bot.command(name="leave", aliases=["disconnect", "dc"])
async def leave(ctx):
    player: wavelink.Player = ctx.voice_client
    if not player: return await bad(ctx, "i'm not in voice.")
    await player.disconnect()
    await ok(ctx, "👋 left voice.")

# =============== UTILITY ===============

@bot.command(name="ping")
async def ping(ctx):
    await ok(ctx, f"🏓 **{round(bot.latency * 1000)}ms** ws.")

@bot.command(name="userinfo", aliases=["ui", "whois"])
async def userinfo(ctx, member: discord.Member = None):
    m = member or ctx.author
    roles = " ".join(r.mention for r in m.roles if r.id != ctx.guild.id) or "None"
    e = pink_embed(str(m))
    e.set_thumbnail(url=m.display_avatar.url)
    e.add_field(name="ID", value=m.id, inline=True)
    e.add_field(name="Account made", value=f"<t:{int(m.created_at.timestamp())}:R>", inline=True)
    e.add_field(name="Joined", value=f"<t:{int(m.joined_at.timestamp())}:R>" if m.joined_at else "?", inline=True)
    e.add_field(name=f"Roles [{len(m.roles)-1}]", value=roles[:1024], inline=False)
    await ctx.send(embed=e)

@bot.command(name="serverinfo", aliases=["si"])
async def serverinfo(ctx):
    g = ctx.guild
    e = pink_embed(g.name)
    if g.icon: e.set_thumbnail(url=g.icon.url)
    e.add_field(name="ID", value=g.id, inline=True)
    e.add_field(name="Owner", value=g.owner.mention if g.owner else "?", inline=True)
    e.add_field(name="Created", value=f"<t:{int(g.created_at.timestamp())}:R>", inline=True)
    e.add_field(name="Members", value=g.member_count, inline=True)
    e.add_field(name="Channels", value=len(g.channels), inline=True)
    e.add_field(name="Roles", value=len(g.roles), inline=True)
    e.add_field(name="Boosts", value=f"{g.premium_subscription_count} (Tier {g.premium_tier})", inline=True)
    await ctx.send(embed=e)

@bot.command(name="avatar", aliases=["av", "pfp"])
async def avatar(ctx, member: discord.Member = None):
    m = member or ctx.author
    e = pink_embed(str(m))
    e.set_image(url=m.display_avatar.url)
    await ctx.send(embed=e)

@bot.command(name="banner")
async def banner(ctx, member: discord.Member = None):
    m = member or ctx.author
    u = await bot.fetch_user(m.id)
    if not u.banner: return await bad(ctx, "no banner.")
    e = pink_embed(f"{m}'s banner")
    e.set_image(url=u.banner.url)
    await ctx.send(embed=e)

@bot.command(name="embed")
@commands.has_permissions(manage_messages=True)
async def embed_cmd(ctx, *, text: str):
    parts = text.split("|", 1)
    title = parts[0].strip()
    desc = parts[1].strip() if len(parts) > 1 else ""
    await ctx.message.delete()
    await ctx.send(embed=pink_embed(title, desc))

@bot.command(name="say")
@commands.has_permissions(manage_messages=True)
async def say(ctx, *, text: str):
    await ctx.message.delete()
    await ctx.send(text)

@bot.command(name="announce")
@commands.has_permissions(mention_everyone=True)
async def announce(ctx, *, text: str):
    await ctx.message.delete()
    e = pink_embed("📢 Announcement", text)
    await ctx.send(content="@everyone", embed=e, allowed_mentions=discord.AllowedMentions(everyone=True))

@bot.command(name="botinfo", aliases=["bi"])
async def botinfo(ctx):
    e = pink_embed(f"{bot.user}")
    e.set_thumbnail(url=bot.user.display_avatar.url)
    e.add_field(name="Guilds", value=len(bot.guilds), inline=True)
    e.add_field(name="Latency", value=f"{round(bot.latency*1000)}ms", inline=True)
    e.add_field(name="Built by", value="olivia 💅", inline=True)
    await ctx.send(embed=e)

@bot.command(name="invite")
async def invite(ctx):
    await ok(ctx, f"https://discord.com/oauth2/authorize?client_id={bot.user.id}&scope=bot+applications.commands&permissions=1099780074743")

@bot.command(name="members", aliases=["membercount"])
async def members(ctx):
    await ok(ctx, f"👥 **{ctx.guild.member_count}** of your finest.")

# =============== FUN ===============

@bot.command(name="snipe")
async def snipe(ctx):
    s = bot.snipes.get(ctx.channel.id)
    if not s: return await bad(ctx, "nothing to snipe.")
    e = pink_embed(desc=s.content or "*(no content)*")
    e.set_author(name=str(s.author), icon_url=s.author.display_avatar.url)
    e.set_footer(text=f"deleted {dt.datetime.now().strftime('%H:%M:%S')}")
    await ctx.send(embed=e)

@bot.command(name="editsnipe", aliases=["esnipe"])
async def editsnipe(ctx):
    pair = bot.edit_snipes.get(ctx.channel.id)
    if not pair: return await bad(ctx, "no edits to snipe.")
    before, after = pair
    e = pink_embed()
    e.set_author(name=str(after.author), icon_url=after.author.display_avatar.url)
    e.add_field(name="Before", value=before.content or "*(empty)*", inline=False)
    e.add_field(name="After", value=after.content or "*(empty)*", inline=False)
    await ctx.send(embed=e)

@bot.command(name="afk")
async def afk_cmd(ctx, *, reason: str = "afk"):
    bot.afk[ctx.author.id] = (reason, dt.datetime.now(dt.timezone.utc))
    await ok(ctx, f"💤 set afk — {reason}")

@bot.command(name="8ball", aliases=["8", "eightball"])
async def eightball(ctx, *, question: str):
    answers = ["absolutely babe", "no chance", "yeah probably", "girl... no", "ask again when sober",
               "the stars say yes", "the stars say absolutely not", "100%", "lmao no",
               "maybe. flip a coin.", "you already know", "nope nope nope"]
    await ok(ctx, f"🎱 {random.choice(answers)}")

@bot.command(name="coinflip", aliases=["flip", "cf"])
async def coinflip(ctx):
    await ok(ctx, "🪙 heads." if random.random() < 0.5 else "🪙 tails.")

@bot.command(name="dice", aliases=["roll"])
async def dice(ctx, sides: int = 6):
    sides = max(2, min(1000, sides))
    await ok(ctx, f"🎲 {random.randint(1, sides)} (d{sides})")

@bot.command(name="choose", aliases=["pick"])
async def choose(ctx, *, text: str):
    opts = [s.strip() for s in text.split("|") if s.strip()]
    if len(opts) < 2: return await bad(ctx, "2+ options separated by `|`.")
    await ok(ctx, f"✨ {random.choice(opts)}")

@bot.command(name="poll")
async def poll(ctx, *, question: str):
    e = pink_embed("📊 poll", question)
    e.set_footer(text=f"by {ctx.author}")
    m = await ctx.send(embed=e)
    await m.add_reaction("✅")
    await m.add_reaction("❌")
    await ctx.message.delete()

@bot.command(name="gay")
async def gay(ctx, member: discord.Member = None):
    m = member or ctx.author
    pct = random.randint(0, 100)
    bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
    await ok(ctx, f"🌈 **{m.name}** is **{pct}%** gay\n`{bar}`")

@bot.command(name="ship")
async def ship(ctx, a: discord.Member, b: discord.Member):
    pct = random.randint(0, 100)
    name = a.name[:len(a.name)//2+1] + b.name[len(b.name)//2:]
    await ok(ctx, f"💕 **{a.name}** + **{b.name}** = **{name}** — {pct}%")

async def _action(ctx, target: discord.Member, verb: str, emoji: str):
    await ok(ctx, f"{emoji} **{ctx.author.name}** {verb} **{target.name}**.")

@bot.command(name="hug")
async def hug(ctx, member: discord.Member): await _action(ctx, member, "hugs", "🫂")

@bot.command(name="slap")
async def slap(ctx, member: discord.Member): await _action(ctx, member, "slaps", "👋")

@bot.command(name="kiss")
async def kiss(ctx, member: discord.Member): await _action(ctx, member, "kisses", "💋")

@bot.command(name="pat")
async def pat(ctx, member: discord.Member): await _action(ctx, member, "pats", "🫶")

@bot.command(name="bonk")
async def bonk(ctx, member: discord.Member): await _action(ctx, member, "bonks", "🔨")

# =============== SLASH COMMANDS (music subset) ===============

@bot.tree.command(name="play", description="Play from YouTube, Spotify, SoundCloud, or search")
@app_commands.describe(query="URL or search terms")
async def slash_play(interaction: discord.Interaction, query: str):
    await interaction.response.defer()
    ctx = await bot.get_context(interaction.message) if interaction.message else None
    # Minimal shim for slash command
    if not interaction.user.voice:
        return await interaction.followup.send("join a voice channel first, hun.")
    channel = interaction.user.voice.channel
    player: wavelink.Player = interaction.guild.voice_client
    if not player:
        player = await channel.connect(cls=wavelink.Player, self_deaf=True)
    elif player.channel != channel:
        await player.move_to(channel)
    player.home_channel = interaction.channel

    try:
        tracks: wavelink.Search = await wavelink.Playable.search(query)
        if not tracks:
            return await interaction.followup.send("nothing found.")
        if isinstance(tracks, wavelink.Playlist):
            added = await player.queue.put_wait(tracks)
            await interaction.followup.send(f"✅ queued **{added}** tracks from **{tracks.name}**")
            if not player.playing:
                await player.play(player.queue.get())
        else:
            track = tracks[0]
            if not player.playing:
                await interaction.followup.send(f"▶️ playing **{track.title}**")
                await player.play(track)
            else:
                await player.queue.put_wait(track)
                await interaction.followup.send(f"✅ queued **{track.title}**")
        # Always ensure the music panel is visible after /play
        await asyncio.sleep(1)
        await send_music_panel(player, interaction.channel)
    except Exception as e:
        print(f"[slash_play] error: {e}")
        await interaction.followup.send(f"💀 play failed: `{e}`")

@bot.tree.command(name="skip", description="Skip the current song")
async def slash_skip(interaction: discord.Interaction):
    player: wavelink.Player = interaction.guild.voice_client
    if not player: return await interaction.response.send_message("nothing playing.")
    await player.skip(force=True)
    await interaction.response.send_message("⏭️ skipped.")

@bot.tree.command(name="stop", description="Stop and leave voice")
async def slash_stop(interaction: discord.Interaction):
    player: wavelink.Player = interaction.guild.voice_client
    if not player: return await interaction.response.send_message("nothing playing.")
    player.queue.clear()
    await player.disconnect()
    await interaction.response.send_message("⏹️ stopped and left.")

@bot.tree.command(name="join", description="Join your voice channel")
async def slash_join(interaction: discord.Interaction):
    if not interaction.user.voice:
        return await interaction.response.send_message("join a voice channel first, hun.")
    channel = interaction.user.voice.channel
    player: wavelink.Player = interaction.guild.voice_client
    if not player:
        player = await channel.connect(cls=wavelink.Player, self_deaf=True)
    elif player.channel != channel:
        await player.move_to(channel)
    player.home_channel = interaction.channel
    await interaction.response.send_message(f"👋 joined <#{channel.id}>.")

@bot.tree.command(name="leave", description="Leave the voice channel")
async def slash_leave(interaction: discord.Interaction):
    player: wavelink.Player = interaction.guild.voice_client
    if not player:
        return await interaction.response.send_message("i'm not in voice.")
    await player.disconnect()
    await interaction.response.send_message("👋 left voice.")

# ===== Playlist slash commands =====

playlist_group = app_commands.Group(name="playlist", description="Manage your personal playlists")

@playlist_group.command(name="create", description="Create a new empty playlist")
@app_commands.describe(name="Playlist name")
async def pl_create(interaction: discord.Interaction, name: str):
    uid = str(interaction.user.id)
    user_pls = bot.playlists.setdefault(uid, {})
    if name in user_pls:
        return await interaction.response.send_message(f"playlist **{name}** already exists.", ephemeral=True)
    user_pls[name] = []
    save_playlists(bot.playlists)
    await interaction.response.send_message(f"✅ created playlist **{name}**.", ephemeral=True)

@playlist_group.command(name="add", description="Add a track (URL or search) to a playlist")
@app_commands.describe(name="Playlist name", query="URL or search terms")
async def pl_add(interaction: discord.Interaction, name: str, query: str):
    await interaction.response.defer(ephemeral=True)
    uid = str(interaction.user.id)
    user_pls = bot.playlists.get(uid, {})
    if name not in user_pls:
        user_pls = bot.playlists.setdefault(uid, {})
        user_pls[name] = []
    try:
        tracks = await wavelink.Playable.search(query)
        if not tracks:
            return await interaction.followup.send("nothing found.", ephemeral=True)
        if isinstance(tracks, wavelink.Playlist):
            added = 0
            for t in tracks.tracks:
                user_pls[name].append(t.uri or t.identifier)
                added += 1
            save_playlists(bot.playlists)
            await interaction.followup.send(f"✅ added **{added}** tracks from **{tracks.name}** to **{name}**.", ephemeral=True)
        else:
            track = tracks[0]
            user_pls[name].append(track.uri or track.identifier)
            save_playlists(bot.playlists)
            await interaction.followup.send(f"✅ added **{track.title}** to **{name}**.", ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"💀 add failed: `{e}`", ephemeral=True)

@playlist_group.command(name="play", description="Load one of your playlists into the queue")
@app_commands.describe(name="Playlist name")
async def pl_play(interaction: discord.Interaction, name: str):
    uid = str(interaction.user.id)
    user_pls = bot.playlists.get(uid, {})
    if name not in user_pls or not user_pls[name]:
        return await interaction.response.send_message(f"playlist **{name}** is empty or doesn't exist.", ephemeral=True)
    if not interaction.user.voice:
        return await interaction.response.send_message("join a voice channel first.", ephemeral=True)
    await interaction.response.defer()

    channel = interaction.user.voice.channel
    player: wavelink.Player = interaction.guild.voice_client
    if not player:
        player = await channel.connect(cls=wavelink.Player, self_deaf=True)
    elif player.channel != channel:
        await player.move_to(channel)
    player.home_channel = interaction.channel

    added = 0
    first_track = None
    for url in user_pls[name]:
        try:
            results = await wavelink.Playable.search(url)
            if not results: continue
            t = results[0] if not isinstance(results, wavelink.Playlist) else results.tracks[0]
            if first_track is None and not player.playing:
                first_track = t
            else:
                await player.queue.put_wait(t)
            added += 1
        except Exception as e:
            print(f"pl_play search error for {url}: {e}")
    if first_track and not player.playing:
        await player.play(first_track)
    await interaction.followup.send(f"▶️ loaded **{added}** tracks from **{name}**.")
    await asyncio.sleep(1)
    await send_music_panel(player, interaction.channel)

@playlist_group.command(name="list", description="List your playlists")
async def pl_list(interaction: discord.Interaction):
    uid = str(interaction.user.id)
    user_pls = bot.playlists.get(uid, {})
    if not user_pls:
        return await interaction.response.send_message("you have no playlists. make one with `/playlist create`.", ephemeral=True)
    lines = [f"**{name}** — {len(tracks)} tracks" for name, tracks in user_pls.items()]
    await interaction.response.send_message(embed=pink_embed("🎵 Your Playlists", "\n".join(lines)), ephemeral=True)

@playlist_group.command(name="show", description="Show tracks in a playlist")
@app_commands.describe(name="Playlist name")
async def pl_show(interaction: discord.Interaction, name: str):
    uid = str(interaction.user.id)
    user_pls = bot.playlists.get(uid, {})
    if name not in user_pls:
        return await interaction.response.send_message(f"no playlist **{name}**.", ephemeral=True)
    tracks = user_pls[name]
    if not tracks:
        return await interaction.response.send_message(f"**{name}** is empty.", ephemeral=True)
    lines = [f"**{i+1}.** <{t}>" for i, t in enumerate(tracks[:20])]
    extra = f"\n*…and {len(tracks) - 20} more*" if len(tracks) > 20 else ""
    await interaction.response.send_message(embed=pink_embed(f"🎵 {name}", "\n".join(lines) + extra), ephemeral=True)

@playlist_group.command(name="remove", description="Remove a track from a playlist (by position)")
@app_commands.describe(name="Playlist name", position="Track position (1-based)")
async def pl_remove(interaction: discord.Interaction, name: str, position: int):
    uid = str(interaction.user.id)
    user_pls = bot.playlists.get(uid, {})
    if name not in user_pls:
        return await interaction.response.send_message(f"no playlist **{name}**.", ephemeral=True)
    if position < 1 or position > len(user_pls[name]):
        return await interaction.response.send_message("invalid position.", ephemeral=True)
    removed = user_pls[name].pop(position - 1)
    save_playlists(bot.playlists)
    await interaction.response.send_message(f"🗑️ removed track #{position} from **{name}**.", ephemeral=True)

@playlist_group.command(name="delete", description="Delete a playlist")
@app_commands.describe(name="Playlist name")
async def pl_delete(interaction: discord.Interaction, name: str):
    uid = str(interaction.user.id)
    user_pls = bot.playlists.get(uid, {})
    if name not in user_pls:
        return await interaction.response.send_message(f"no playlist **{name}**.", ephemeral=True)
    del user_pls[name]
    save_playlists(bot.playlists)
    await interaction.response.send_message(f"🗑️ deleted playlist **{name}**.", ephemeral=True)

bot.tree.add_command(playlist_group)

# Standalone /back slash command
@bot.tree.command(name="panel", description="Show the music control panel")
async def slash_panel(interaction: discord.Interaction):
    player: wavelink.Player = interaction.guild.voice_client
    if not player or not player.current:
        return await interaction.response.send_message("nothing playing.", ephemeral=True)
    player.home_channel = interaction.channel
    await interaction.response.send_message("🎛️ panel coming up...", ephemeral=True)
    await send_music_panel(player, interaction.channel)

@bot.tree.command(name="back", description="Play the previous track")
async def slash_back(interaction: discord.Interaction):
    player: wavelink.Player = interaction.guild.voice_client
    if not player:
        return await interaction.response.send_message("nothing playing.")
    history = getattr(player, "history_list", [])
    if not history:
        return await interaction.response.send_message("no previous track.")
    prev = history.pop()
    if player.current:
        player.queue.put_at(0, player.current)
    await player.play(prev)
    await interaction.response.send_message(f"⏮️ going back to **{prev.title}**")

@bot.tree.command(name="queue", description="Show the queue")
async def slash_queue(interaction: discord.Interaction):
    player: wavelink.Player = interaction.guild.voice_client
    if not player or not player.queue: return await interaction.response.send_message("queue empty.")
    lines = []
    if player.current: lines.append(f"🎵 **now:** {player.current.title}")
    for i, t in enumerate(list(player.queue)[:15], start=1):
        lines.append(f"**{i}.** {t.title}")
    await interaction.response.send_message(embed=pink_embed("📋 queue", "\n".join(lines)))

# =============== HTTP HELPER ===============

async def fetch_json(url: str, headers: dict = None):
    async with aiohttp.ClientSession(headers=headers or {}) as s:
        async with s.get(url) as r:
            r.raise_for_status()
            return await r.json()

async def fetch_text(url: str, headers: dict = None):
    async with aiohttp.ClientSession(headers=headers or {}) as s:
        async with s.get(url) as r:
            return await r.text()

# =============== MORE MODERATION ===============

@bot.command(name="softban")
@commands.has_permissions(ban_members=True)
@commands.bot_has_permissions(ban_members=True)
async def softban(ctx, member: discord.Member, *, reason: str = "softban"):
    await member.ban(reason=reason, delete_message_days=7)
    await ctx.guild.unban(member, reason="softban-complete")
    await ok(ctx, f"🧼 softbanned **{member}** — mess cleaned.")

@bot.command(name="hide")
@commands.has_permissions(manage_channels=True)
@commands.bot_has_permissions(manage_channels=True)
async def hide(ctx):
    await ctx.channel.set_permissions(ctx.guild.default_role, view_channel=False)
    await ok(ctx, "🙈 hidden.")

@bot.command(name="unhide", aliases=["show"])
@commands.has_permissions(manage_channels=True)
@commands.bot_has_permissions(manage_channels=True)
async def unhide(ctx):
    await ctx.channel.set_permissions(ctx.guild.default_role, view_channel=None)
    await ok(ctx, "👀 visible.")

@bot.command(name="nuke")
@commands.has_permissions(manage_channels=True)
@commands.bot_has_permissions(manage_channels=True)
async def nuke(ctx):
    if not isinstance(ctx.channel, discord.TextChannel):
        return await bad(ctx, "only text channels.")
    position = ctx.channel.position
    new_ch = await ctx.channel.clone()
    await new_ch.edit(position=position)
    await ctx.channel.delete(reason="nuke")
    await new_ch.send("💥 fresh slate.")

@bot.command(name="pin")
@commands.has_permissions(manage_messages=True)
@commands.bot_has_permissions(manage_messages=True)
async def pin_cmd(ctx):
    if not ctx.message.reference:
        return await bad(ctx, "reply to the message you want pinned.")
    msg = await ctx.channel.fetch_message(ctx.message.reference.message_id)
    await msg.pin()
    await ok(ctx, "📌 pinned.")

@bot.command(name="unpin")
@commands.has_permissions(manage_messages=True)
async def unpin_cmd(ctx):
    if not ctx.message.reference:
        return await bad(ctx, "reply to the message you want unpinned.")
    msg = await ctx.channel.fetch_message(ctx.message.reference.message_id)
    await msg.unpin()
    await ok(ctx, "📍 unpinned.")

# =============== ROLES ===============

@bot.group(name="role", invoke_without_command=True)
@commands.has_permissions(manage_roles=True)
@commands.bot_has_permissions(manage_roles=True)
async def role_group(ctx):
    await bad(ctx, "try: `add`, `remove`, `create`, `delete`")

@role_group.command(name="add")
async def role_add(ctx, member: discord.Member, *, role: discord.Role):
    await member.add_roles(role)
    await ok(ctx, f"✅ gave **{role.name}** to **{member}**.")

@role_group.command(name="remove")
async def role_remove(ctx, member: discord.Member, *, role: discord.Role):
    await member.remove_roles(role)
    await ok(ctx, f"❌ took **{role.name}** from **{member}**.")

@role_group.command(name="create")
async def role_create(ctx, *, name: str):
    r = await ctx.guild.create_role(name=name)
    await ok(ctx, f"✨ made role **{r.name}**.")

@role_group.command(name="delete")
async def role_delete(ctx, *, role: discord.Role):
    name = role.name
    await role.delete()
    await ok(ctx, f"🗑️ nuked role **{name}**.")

@bot.command(name="giverole", aliases=["gr"])
@commands.has_permissions(manage_roles=True)
@commands.bot_has_permissions(manage_roles=True)
async def giverole(ctx, member: discord.Member, *, role: discord.Role):
    await member.add_roles(role)
    await ok(ctx, f"✅ gave **{role.name}** to **{member}**.")

@bot.command(name="takerole", aliases=["tr"])
@commands.has_permissions(manage_roles=True)
@commands.bot_has_permissions(manage_roles=True)
async def takerole(ctx, member: discord.Member, *, role: discord.Role):
    await member.remove_roles(role)
    await ok(ctx, f"❌ took **{role.name}** from **{member}**.")

# =============== MEMBER ===============

@bot.command(name="nick", aliases=["nickname"])
@commands.has_permissions(manage_nicknames=True)
@commands.bot_has_permissions(manage_nicknames=True)
async def nick(ctx, member: discord.Member, *, new_nick: str = None):
    await member.edit(nick=new_nick)
    await ok(ctx, f"✏️ **{member}** is now **{new_nick or '(cleared)'}**.")

@bot.command(name="resetnick")
@commands.has_permissions(manage_nicknames=True)
async def resetnick(ctx, member: discord.Member):
    await member.edit(nick=None)
    await ok(ctx, "✏️ nick wiped.")

# =============== SERVER ===============

@bot.command(name="icon")
async def icon(ctx):
    if not ctx.guild.icon:
        return await bad(ctx, "no icon set.")
    e = pink_embed(ctx.guild.name)
    e.set_image(url=ctx.guild.icon.url)
    await ctx.send(embed=e)

@bot.command(name="roleslist", aliases=["rolelist", "roles-list"])
async def roleslist(ctx):
    sorted_roles = sorted(ctx.guild.roles, key=lambda r: r.position, reverse=True)
    text = " ".join(r.mention for r in sorted_roles)
    for chunk in [text[i:i+1900] for i in range(0, len(text), 1900)]:
        await ctx.send(chunk)

# =============== UTILITY ===============

@bot.command(name="uptime")
async def uptime(ctx):
    delta = dt.datetime.now(dt.timezone.utc) - bot.start_time
    await ok(ctx, f"⏰ up for **{int(delta.total_seconds())}s** without a nap.")

# =============== FUN ACTIONS (waifu.pics API) ===============

async def waifu_gif(category: str) -> Optional[str]:
    try:
        j = await fetch_json(f"https://api.waifu.pics/sfw/{category}")
        return j.get("url")
    except: return None

async def action_cmd(ctx, target: discord.Member, verb: str, emoji: str, category: str):
    url = await waifu_gif(category)
    text = f"{emoji} **{ctx.author.name}** {verb} **{target.name}**."
    if url:
        e = pink_embed(desc=text)
        e.set_image(url=url)
        await ctx.send(embed=e)
    else:
        await ctx.send(text)

async def solo_action(ctx, verb: str, emoji: str, category: str):
    url = await waifu_gif(category)
    text = f"{emoji} **{ctx.author.name}** {verb}."
    if url:
        e = pink_embed(desc=text)
        e.set_image(url=url)
        await ctx.send(embed=e)
    else:
        await ctx.send(text)

@bot.command(name="poke")
async def poke(ctx, member: discord.Member): await action_cmd(ctx, member, "pokes", "👉", "poke")

@bot.command(name="bite")
async def bite(ctx, member: discord.Member): await action_cmd(ctx, member, "bites", "🦷", "bite")

@bot.command(name="cuddle")
async def cuddle(ctx, member: discord.Member): await action_cmd(ctx, member, "cuddles with", "💞", "cuddle")

@bot.command(name="bully")
async def bully(ctx, member: discord.Member): await action_cmd(ctx, member, "is bullying", "😈", "bully")

@bot.command(name="yeet")
async def yeet(ctx, member: discord.Member): await action_cmd(ctx, member, "yeets", "🚀", "yeet")

@bot.command(name="nom")
async def nom(ctx, member: discord.Member): await action_cmd(ctx, member, "noms on", "😋", "nom")

@bot.command(name="highfive", aliases=["hf"])
async def highfive(ctx, member: discord.Member): await action_cmd(ctx, member, "high-fives", "🙏", "highfive")

@bot.command(name="handhold")
async def handhold(ctx, member: discord.Member): await action_cmd(ctx, member, "holds hands with", "🤝", "handhold")

@bot.command(name="lick")
async def lick(ctx, member: discord.Member): await action_cmd(ctx, member, "licks", "👅", "lick")

@bot.command(name="kill")
async def kill(ctx, member: discord.Member): await action_cmd(ctx, member, "ends", "🔪", "kill")

@bot.command(name="dance")
async def dance(ctx): await solo_action(ctx, "hits the dancefloor", "💃", "dance")

@bot.command(name="cry")
async def cry(ctx): await solo_action(ctx, "is sobbing", "😭", "cry")

@bot.command(name="wave")
async def wave(ctx): await solo_action(ctx, "waves hello", "👋", "wave")

@bot.command(name="blush")
async def blush(ctx): await solo_action(ctx, "is blushing", "😊", "blush")

@bot.command(name="smile")
async def smile(ctx): await solo_action(ctx, "smiles", "😊", "smile")

@bot.command(name="smug")
async def smug(ctx): await solo_action(ctx, "looks smug", "😏", "smug")

@bot.command(name="wink")
async def wink(ctx): await solo_action(ctx, "winks", "😉", "wink")

@bot.command(name="cringe")
async def cringe(ctx): await solo_action(ctx, "cringes hard", "😬", "cringe")

@bot.command(name="happy")
async def happy(ctx): await solo_action(ctx, "is happy", "😄", "happy")

# =============== PICTURES ===============

@bot.command(name="cat")
async def cat(ctx):
    try:
        j = await fetch_json("https://api.thecatapi.com/v1/images/search")
        e = pink_embed()
        e.set_image(url=j[0]["url"])
        e.set_footer(text="🐱 meow")
        await ctx.send(embed=e)
    except: await bad(ctx, "cats are hiding.")

@bot.command(name="dog")
async def dog(ctx):
    try:
        j = await fetch_json("https://dog.ceo/api/breeds/image/random")
        e = pink_embed()
        e.set_image(url=j["message"])
        e.set_footer(text="🐶 woof")
        await ctx.send(embed=e)
    except: await bad(ctx, "dogs ran off.")

@bot.command(name="fox")
async def fox(ctx):
    try:
        j = await fetch_json("https://randomfox.ca/floof/")
        e = pink_embed()
        e.set_image(url=j["image"])
        e.set_footer(text="🦊")
        await ctx.send(embed=e)
    except: await bad(ctx, "no foxes today.")

@bot.command(name="duck")
async def duck(ctx):
    try:
        j = await fetch_json("https://random-d.uk/api/v2/random")
        e = pink_embed()
        e.set_image(url=j["url"])
        e.set_footer(text="🦆 quack")
        await ctx.send(embed=e)
    except: await bad(ctx, "ducks flew south.")

# =============== TEXT TOYS ===============

@bot.command(name="mock")
async def mock(ctx, *, text: str):
    result = "".join(c.lower() if i % 2 else c.upper() for i, c in enumerate(text))
    await ok(ctx, result)

@bot.command(name="reverse", aliases=["rev"])
async def reverse(ctx, *, text: str):
    await ok(ctx, text[::-1])

@bot.command(name="caps", aliases=["upper"])
async def caps(ctx, *, text: str):
    await ok(ctx, text.upper())

@bot.command(name="lower")
async def lower(ctx, *, text: str):
    await ok(ctx, text.lower())

@bot.command(name="clap")
async def clap(ctx, *, text: str):
    await ok(ctx, " 👏 ".join(text.split()))

@bot.command(name="owo", aliases=["uwu"])
async def owo(ctx, *, text: str):
    owoified = text.replace("r", "w").replace("l", "w").replace("R", "W").replace("L", "W")
    owoified = re.sub(r"n([aeiou])", r"ny\1", owoified)
    owoified = re.sub(r"N([aeiou])", r"Ny\1", owoified)
    faces = [" owo", " uwu", " ^w^", " >w<", " :3"]
    await ok(ctx, owoified + random.choice(faces))

@bot.command(name="base64", aliases=["b64"])
async def base64_cmd(ctx, mode: str, *, text: str):
    try:
        if mode.lower() in ("encode", "e"):
            await ok(ctx, "```\n" + b64lib.b64encode(text.encode()).decode() + "\n```")
        elif mode.lower() in ("decode", "d"):
            await ok(ctx, "```\n" + b64lib.b64decode(text).decode() + "\n```")
        else:
            await bad(ctx, "mode: `encode` or `decode`.")
    except: await bad(ctx, "invalid input.")

MORSE_MAP = {
    "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".", "F": "..-.", "G": "--.",
    "H": "....", "I": "..", "J": ".---", "K": "-.-", "L": ".-..", "M": "--", "N": "-.",
    "O": "---", "P": ".--.", "Q": "--.-", "R": ".-.", "S": "...", "T": "-", "U": "..-",
    "V": "...-", "W": ".--", "X": "-..-", "Y": "-.--", "Z": "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
    "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
}
MORSE_INV = {v: k for k, v in MORSE_MAP.items()}

@bot.command(name="morse")
async def morse(ctx, mode: str, *, text: str):
    if mode.lower() in ("encode", "e"):
        result = " ".join("/" if c == " " else MORSE_MAP.get(c.upper(), "") for c in text).strip()
        await ok(ctx, result or "nothing to encode.")
    elif mode.lower() in ("decode", "d"):
        result = "".join(" " if c == "/" else MORSE_INV.get(c, "") for c in text.split())
        await ok(ctx, result)
    else:
        await bad(ctx, "mode: `encode` or `decode`.")

@bot.command(name="binary", aliases=["bin"])
async def binary(ctx, mode: str, *, text: str):
    try:
        if mode.lower() in ("encode", "e"):
            await ok(ctx, " ".join(format(ord(c), "08b") for c in text))
        elif mode.lower() in ("decode", "d"):
            await ok(ctx, "".join(chr(int(b, 2)) for b in text.split()))
        else: await bad(ctx, "mode: `encode` or `decode`.")
    except: await bad(ctx, "invalid binary.")

@bot.command(name="rot13")
async def rot13(ctx, *, text: str):
    import codecs
    await ok(ctx, codecs.encode(text, "rot_13"))

@bot.command(name="hexencode")
async def hex_cmd(ctx, mode: str, *, text: str):
    try:
        if mode.lower() in ("encode", "e"):
            await ok(ctx, text.encode().hex())
        elif mode.lower() in ("decode", "d"):
            await ok(ctx, bytes.fromhex(text).decode())
        else: await bad(ctx, "mode: `encode` or `decode`.")
    except: await bad(ctx, "bad input.")

@bot.command(name="length", aliases=["len"])
async def length(ctx, *, text: str):
    await ok(ctx, f"📏 **{len(text)}** chars • **{len(text.split())}** words")

@bot.command(name="spoiler")
async def spoiler(ctx, *, text: str):
    await ctx.message.delete()
    await ctx.send(f"||{text}||")

# =============== MATH / RNG ===============

@bot.command(name="math", aliases=["calc"])
async def math_cmd(ctx, *, expr: str):
    if not re.fullmatch(r"[\d\s+\-*/().%*]+", expr):
        return await bad(ctx, "only numbers and `+ - * / % ** ( )` allowed.")
    try:
        result = eval(expr, {"__builtins__": {}}, {})
        await ok(ctx, f"🧮 `{expr}` = **{result}**")
    except: await bad(ctx, "invalid expression.")

@bot.command(name="random", aliases=["rand"])
async def random_num(ctx, lo: int, hi: int):
    if lo > hi: lo, hi = hi, lo
    await ok(ctx, f"🎲 {random.randint(lo, hi)}")

@bot.command(name="pwgen", aliases=["password"])
async def pwgen(ctx, length: int = 20):
    length = max(4, min(128, length))
    charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*"
    pw = "".join(random.choice(charset) for _ in range(length))
    try:
        await ctx.author.send(f"🔑 `{pw}`")
        await ok(ctx, "🔑 sent to your DMs.")
    except:
        await ok(ctx, f"🔑 (DMs closed, posting here)\n`{pw}`")

# =============== DISCORD UTILS ===============

@bot.command(name="snowflake", aliases=["sf"])
async def snowflake(ctx, sf: str):
    if not re.fullmatch(r"\d{15,22}", sf):
        return await bad(ctx, "give a valid ID.")
    ts = (int(sf) >> 22) + 1420070400000
    await ok(ctx, f"🆔 `{sf}` → <t:{ts // 1000}:F> (<t:{ts // 1000}:R>)")

@bot.command(name="timestamp", aliases=["ts"])
async def timestamp_cmd(ctx, *, when: str = "now"):
    try:
        if when.lower() == "now":
            d = dt.datetime.now(dt.timezone.utc)
        else:
            d = dt.datetime.fromisoformat(when)
        t = int(d.timestamp())
        await ok(ctx, f"`<t:{t}>` → <t:{t}>\n`<t:{t}:F>` → <t:{t}:F>\n`<t:{t}:R>` → <t:{t}:R>")
    except: await bad(ctx, "invalid date — try `2025-12-25` or `now`.")

@bot.command(name="enlarge", aliases=["bigemoji", "jumbo"])
async def enlarge(ctx, emoji: str):
    m = re.match(r"<(a?):\w+:(\d+)>", emoji)
    if not m: return await bad(ctx, "give me a custom emoji.")
    ext = "gif" if m.group(1) else "png"
    url = f"https://cdn.discordapp.com/emojis/{m.group(2)}.{ext}?size=512"
    e = pink_embed()
    e.set_image(url=url)
    await ctx.send(embed=e)

@bot.command(name="steal")
@commands.has_permissions(manage_emojis=True)
@commands.bot_has_permissions(manage_emojis=True)
async def steal(ctx, emoji: str, name: str = None):
    m = re.match(r"<(a?):(\w+):(\d+)>", emoji)
    if not m: return await bad(ctx, "give me a custom emoji.")
    ext = "gif" if m.group(1) else "png"
    emoji_name = name or m.group(2)
    url = f"https://cdn.discordapp.com/emojis/{m.group(3)}.{ext}"
    async with aiohttp.ClientSession() as s:
        async with s.get(url) as r:
            img = await r.read()
    new_emoji = await ctx.guild.create_custom_emoji(name=emoji_name, image=img)
    await ok(ctx, f"✨ stolen as {new_emoji} `:{new_emoji.name}:`")

# =============== MISC ===============

@bot.command(name="color", aliases=["colour", "hex"])
async def color(ctx, hex_code: str):
    hex_code = hex_code.replace("#", "").lower()
    if not re.fullmatch(r"[0-9a-f]{6}", hex_code):
        return await bad(ctx, "give a 6-digit hex like `ff66cc`.")
    i = int(hex_code, 16)
    e = discord.Embed(title=f"#{hex_code.upper()}", color=i)
    e.set_image(url=f"https://singlecolorimage.com/get/{hex_code}/400x200.png")
    e.add_field(name="R", value=(i >> 16) & 255, inline=True)
    e.add_field(name="G", value=(i >> 8) & 255, inline=True)
    e.add_field(name="B", value=i & 255, inline=True)
    await ctx.send(embed=e)

@bot.command(name="firstmsg", aliases=["first"])
async def firstmsg(ctx):
    async for m in ctx.channel.history(limit=1, oldest_first=True):
        return await ok(ctx, f"first message: {m.jump_url}")
    await bad(ctx, "no messages found.")

@bot.command(name="qr")
async def qr(ctx, *, text: str):
    import urllib.parse as up
    url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={up.quote(text)}"
    e = pink_embed()
    e.set_image(url=url)
    e.set_footer(text=text[:100])
    await ctx.send(embed=e)

@bot.command(name="rate")
async def rate(ctx, *, thing: str = "that"):
    await ok(ctx, f"i'd rate **{thing}** a **{random.randint(0, 10)}/10**.")

@bot.command(name="shorten")
async def shorten(ctx, url: str):
    if not re.match(r"^https?://", url):
        return await bad(ctx, "give a full URL.")
    import urllib.parse as up
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"https://is.gd/create.php?format=simple&url={up.quote(url)}") as r:
                short = (await r.text()).strip()
        if not short.startswith("http"):
            return await bad(ctx, f"failed: {short}")
        await ok(ctx, f"🔗 {short}")
    except: await bad(ctx, "shortener down.")

# =============== LOOKUPS ===============

@bot.command(name="joke")
async def joke(ctx):
    try:
        j = await fetch_json("https://v2.jokeapi.dev/joke/Any?safe-mode")
        text = j["joke"] if j["type"] == "single" else f"{j['setup']}\n\n|| {j['delivery']} ||"
        await ok(ctx, f"🎭 {text}")
    except: await bad(ctx, "joke api ghosted me.")

@bot.command(name="dadjoke", aliases=["dad"])
async def dadjoke(ctx):
    try:
        j = await fetch_json("https://icanhazdadjoke.com/", headers={"Accept": "application/json", "User-Agent": "kitty-bot"})
        await ok(ctx, f"👨 {j['joke']}")
    except: await bad(ctx, "dad is out buying milk.")

@bot.command(name="fact")
async def fact(ctx):
    try:
        j = await fetch_json("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en")
        await ok(ctx, f"🧠 {j['text']}")
    except: await bad(ctx, "facts machine broke.")

@bot.command(name="advice")
async def advice(ctx):
    try:
        j = await fetch_json("https://api.adviceslip.com/advice")
        await ok(ctx, f"💡 {j['slip']['advice']}")
    except: await bad(ctx, "no advice left.")

@bot.command(name="quote")
async def quote(ctx):
    try:
        j = await fetch_json("https://zenquotes.io/api/random")
        await ok(ctx, f"💬 *\"{j[0]['q']}\"* — **{j[0]['a']}**")
    except: await bad(ctx, "muses on strike.")

@bot.command(name="meme")
async def meme(ctx):
    try:
        j = await fetch_json("https://meme-api.com/gimme")
        e = pink_embed(j.get("title", "meme")[:256])
        e.url = j.get("postLink")
        e.set_image(url=j["url"])
        e.set_footer(text=f"r/{j['subreddit']} • ⬆ {j['ups']}")
        await ctx.send(embed=e)
    except: await bad(ctx, "meme supply disrupted.")

@bot.command(name="define", aliases=["def"])
async def define(ctx, *, word: str):
    try:
        j = await fetch_json(f"https://api.dictionaryapi.dev/api/v2/entries/en/{word}")
        entry = j[0]
        e = pink_embed(entry["word"])
        if entry.get("phonetic"): e.description = f"*{entry['phonetic']}*"
        for m in entry["meanings"][:4]:
            defs = "\n".join(f"{i+1}. {d['definition']}" for i, d in enumerate(m["definitions"][:3]))
            e.add_field(name=m["partOfSpeech"], value=defs[:1024], inline=False)
        await ctx.send(embed=e)
    except: await bad(ctx, f"no entry for **{word}**.")

@bot.command(name="wiki")
async def wiki(ctx, *, topic: str):
    try:
        j = await fetch_json(f"https://en.wikipedia.org/api/rest_v1/page/summary/{topic.replace(' ', '_')}")
        if j.get("type") == "disambiguation":
            return await bad(ctx, "too ambiguous, be more specific.")
        e = pink_embed(j["title"])
        e.url = j.get("content_urls", {}).get("desktop", {}).get("page")
        e.description = j.get("extract", "no summary.")[:2000]
        if j.get("thumbnail"): e.set_thumbnail(url=j["thumbnail"]["source"])
        await ctx.send(embed=e)
    except: await bad(ctx, "wikipedia had no answer.")

@bot.command(name="github", aliases=["gh"])
async def github(ctx, username: str):
    try:
        j = await fetch_json(f"https://api.github.com/users/{username}")
        e = pink_embed(j["login"])
        e.url = j["html_url"]
        e.set_thumbnail(url=j["avatar_url"])
        e.description = j.get("bio") or "*no bio*"
        e.add_field(name="Repos", value=j["public_repos"], inline=True)
        e.add_field(name="Followers", value=j["followers"], inline=True)
        e.add_field(name="Following", value=j["following"], inline=True)
        await ctx.send(embed=e)
    except: await bad(ctx, "user not found.")

@bot.command(name="npm")
async def npm(ctx, pkg: str):
    try:
        j = await fetch_json(f"https://registry.npmjs.org/{pkg}")
        latest = j["dist-tags"]["latest"]
        v = j["versions"][latest]
        e = pink_embed(f"{j['name']} @ {latest}")
        e.url = f"https://www.npmjs.com/package/{j['name']}"
        e.description = j.get("description", "*no description*")
        e.add_field(name="License", value=v.get("license", "?"), inline=True)
        e.add_field(name="Author", value=v.get("author", {}).get("name") if isinstance(v.get("author"), dict) else "?", inline=True)
        await ctx.send(embed=e)
    except: await bad(ctx, "package not found.")

@bot.command(name="coin", aliases=["crypto"])
async def coin(ctx, coin_id: str):
    try:
        j = await fetch_json(f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id.lower()}&vs_currencies=usd&include_24hr_change=true")
        d = j.get(coin_id.lower())
        if not d: return await bad(ctx, f"no coin \"{coin_id}\".")
        arrow = "📈" if d["usd_24h_change"] >= 0 else "📉"
        await ok(ctx, f"{arrow} **{coin_id}** — **${d['usd']:,}** ({d['usd_24h_change']:.2f}% 24h)")
    except: await bad(ctx, "coingecko napping.")

@bot.command(name="weather")
async def weather(ctx, *, city: str):
    try:
        geo = await fetch_json(f"https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1")
        if not geo.get("results"): return await bad(ctx, "city not found.")
        g = geo["results"][0]
        w = await fetch_json(f"https://api.open-meteo.com/v1/forecast?latitude={g['latitude']}&longitude={g['longitude']}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&temperature_unit=celsius")
        c = w["current"]
        e = pink_embed(f"🌤️ {g['name']}, {g['country']}")
        e.add_field(name="Temp", value=f"{c['temperature_2m']}°C", inline=True)
        e.add_field(name="Humidity", value=f"{c['relative_humidity_2m']}%", inline=True)
        e.add_field(name="Wind", value=f"{c['wind_speed_10m']} km/h", inline=True)
        await ctx.send(embed=e)
    except: await bad(ctx, "weather down.")

# =============== RECON / OSINT ===============

@bot.command(name="iplookup", aliases=["ip"])
async def iplookup(ctx, ip: str):
    try:
        j = await fetch_json(f"http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting")
        if j.get("status") != "success": return await bad(ctx, f"lookup failed: {j.get('message')}")
        e = pink_embed(f"🌍 {j['query']}")
        e.add_field(name="Country", value=j.get("country", "?"), inline=True)
        e.add_field(name="Region", value=j.get("regionName", "?"), inline=True)
        e.add_field(name="City", value=j.get("city", "?"), inline=True)
        e.add_field(name="ZIP", value=j.get("zip", "?"), inline=True)
        e.add_field(name="Timezone", value=j.get("timezone", "?"), inline=True)
        e.add_field(name="Coords", value=f"{j.get('lat')}, {j.get('lon')}", inline=True)
        e.add_field(name="ISP", value=j.get("isp", "?"), inline=True)
        e.add_field(name="Org", value=j.get("org", "?"), inline=True)
        e.add_field(name="ASN", value=j.get("as", "?"), inline=True)
        e.add_field(name="Proxy/VPN", value="yes" if j.get("proxy") else "no", inline=True)
        e.add_field(name="Hosting", value="yes" if j.get("hosting") else "no", inline=True)
        await ctx.send(embed=e)
    except Exception as ex: await bad(ctx, f"lookup failed: `{ex}`")

@bot.command(name="dns")
async def dns_cmd(ctx, domain: str, record_type: str = "A"):
    try:
        j = await fetch_json(f"https://dns.google/resolve?name={domain}&type={record_type.upper()}")
        records = j.get("Answer", [])
        if not records: return await bad(ctx, f"no {record_type} records for **{domain}**.")
        lines = [f"`{r['data']}` (TTL {r['TTL']})" for r in records[:20]]
        e = pink_embed(f"🌐 {record_type.upper()} records — {domain}")
        e.description = "\n".join(lines)[:4000]
        await ctx.send(embed=e)
    except Exception as ex: await bad(ctx, f"dns query failed: `{ex}`")

@bot.command(name="subbrute", aliases=["subs", "subdomains"])
async def subbrute(ctx, domain: str):
    working = await ctx.send(f"🔍 digging through crt.sh for **{domain}**...")
    try:
        j = await fetch_json(f"https://crt.sh/?q=%25.{domain}&output=json")
        subs = set()
        for row in j:
            for n in (row.get("name_value") or "").split("\n"):
                clean = n.strip().lower()
                if clean and not clean.startswith("*") and clean.endswith(domain):
                    subs.add(clean)
        subs = sorted(subs)
        if not subs:
            return await working.edit(content=f"💀 no subdomains for **{domain}**.")
        header = f"🎯 **{len(subs)}** subdomains for **{domain}**"
        text = "\n".join(subs)
        if len(text) < 1800:
            await working.edit(content=f"{header}\n```\n{text}\n```")
        else:
            file = discord.File(fp=__import__("io").BytesIO(text.encode()), filename=f"{domain}-subs.txt")
            await working.edit(content=header, attachments=[file])
    except Exception as ex: await working.edit(content=f"💀 subbrute failed: `{ex}`")

@bot.command(name="domain", aliases=["rdap"])
async def whois_cmd(ctx, domain: str):
    try:
        j = await fetch_json(f"https://rdap.org/domain/{domain}")
        events = "\n".join(f"{e['eventAction']}: {e.get('eventDate', '')[:10]}" for e in j.get("events", []))
        ns = "\n".join(n["ldhName"] for n in j.get("nameservers", []))
        status = ", ".join(j.get("status", []))
        e = pink_embed(f"🔎 whois — {domain}")
        e.add_field(name="Events", value=(events or "?")[:1024], inline=False)
        e.add_field(name="Nameservers", value=(ns or "?")[:1024], inline=False)
        e.add_field(name="Status", value=(status or "?")[:1024], inline=False)
        await ctx.send(embed=e)
    except Exception as ex: await bad(ctx, f"whois failed: `{ex}`")

@bot.command(name="reverseip", aliases=["rip"])
async def reverseip(ctx, ip: str):
    try:
        parts = ip.split(".")
        rev = ".".join(reversed(parts)) + ".in-addr.arpa"
        j = await fetch_json(f"https://dns.google/resolve?name={rev}&type=PTR")
        ptr = (j.get("Answer") or [{}])[0].get("data")
        if not ptr: return await bad(ctx, "no PTR record.")
        await ok(ctx, f"🔄 {ip} → `{ptr}`")
    except Exception as ex: await bad(ctx, f"failed: `{ex}`")

@bot.command(name="headers")
async def headers(ctx, url: str):
    if not re.match(r"^https?://", url): url = "https://" + url
    try:
        async with aiohttp.ClientSession() as s:
            async with s.head(url, allow_redirects=True) as r:
                lines = "\n".join(f"{k}: {v}" for k, v in r.headers.items())
                e = pink_embed(f"📡 {r.status} — {url}")
                e.description = "```\n" + lines[:3900] + "\n```"
                await ctx.send(embed=e)
    except Exception as ex: await bad(ctx, f"fetch failed: `{ex}`")

@bot.command(name="status", aliases=["http"])
async def http_status(ctx, url: str):
    if not re.match(r"^https?://", url): url = "https://" + url
    start = dt.datetime.now()
    try:
        async with aiohttp.ClientSession() as s:
            async with s.head(url, allow_redirects=True) as r:
                ms = int((dt.datetime.now() - start).total_seconds() * 1000)
                emoji = "✅" if r.status < 400 else "⚠️" if r.status < 500 else "💀"
                await ok(ctx, f"{emoji} **{r.status}** — {ms}ms — `{r.url}`")
    except Exception as ex: await ok(ctx, f"💀 down — `{ex}`")

# =============== RUN ===============

@bot.event
async def setup_hook_patch():
    bot.start_time = dt.datetime.now(dt.timezone.utc)

@bot.event
async def on_connect():
    if not hasattr(bot, "start_time"):
        bot.start_time = dt.datetime.now(dt.timezone.utc)

if __name__ == "__main__":
    bot.run(TOKEN)
