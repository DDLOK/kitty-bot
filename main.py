"""
kitty-bot — Python Discord bot
Moderation + Music (via Lavalink) + Utility + Fun
"""
import os
import json
import random
import asyncio
import datetime as dt
from pathlib import Path
from typing import Optional

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
        # Prefer env-provided node, but always include serenetia (known working) as backup
        nodes = [wavelink.Node(uri=LAVALINK_URI, password=LAVALINK_PASSWORD)]
        if LAVALINK_URI != "https://lavalinkv4.serenetia.com:443":
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

    @discord.ui.button(emoji="🔀", style=discord.ButtonStyle.secondary, row=0)
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

@bot.event
async def on_wavelink_track_start(payload: wavelink.TrackStartEventPayload):
    print(f"[track_start] fired for {payload.track.title}")
    player: wavelink.Player = payload.player
    channel = getattr(player, "home_channel", None)
    if not channel:
        print("[track_start] no home_channel set — skipping UI")
        return
    # Delete the previous now-playing message if any
    prev = getattr(player, "now_playing_msg", None)
    if prev:
        try: await prev.delete()
        except: pass
    try:
        view = MusicControls(player)
        msg = await channel.send(embed=make_now_playing_embed(player), view=view)
        player.now_playing_msg = msg
        print(f"[track_start] UI sent to #{channel.name}")
    except Exception as e:
        print(f"[track_start] send failed: {e}")

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
        started_new = False
        if isinstance(tracks, wavelink.Playlist):
            added = await player.queue.put_wait(tracks)
            await interaction.followup.send(f"✅ queued **{added}** tracks from **{tracks.name}**")
            if not player.playing:
                await player.play(player.queue.get())
                started_new = True
        else:
            track = tracks[0]
            if not player.playing:
                await interaction.followup.send(f"▶️ playing **{track.title}**")
                await player.play(track)
                started_new = True
            else:
                await player.queue.put_wait(track)
                await interaction.followup.send(f"✅ queued **{track.title}**")
        # Send the UI directly — don't rely on track_start event
        if started_new:
            await asyncio.sleep(1)  # let Lavalink register the track
            prev = getattr(player, "now_playing_msg", None)
            if prev:
                try: await prev.delete()
                except: pass
            try:
                view = MusicControls(player)
                msg = await interaction.channel.send(embed=make_now_playing_embed(player), view=view)
                player.now_playing_msg = msg
            except Exception as e:
                print(f"[slash_play] UI send failed: {e}")
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

    if first_track:
        await asyncio.sleep(1)
        prev = getattr(player, "now_playing_msg", None)
        if prev:
            try: await prev.delete()
            except: pass
        try:
            view = MusicControls(player)
            msg = await interaction.channel.send(embed=make_now_playing_embed(player), view=view)
            player.now_playing_msg = msg
        except: pass

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

# =============== RUN ===============

if __name__ == "__main__":
    bot.run(TOKEN)
