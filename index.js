import 'dotenv/config';
import dns from 'node:dns';
// Force Cloudflare + Google DNS — bypasses ISP/router DNS blocks
dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4']);
dns.setDefaultResultOrder('ipv4first');

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  Collection,
} from 'discord.js';
import Tesseract from 'tesseract.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
  StreamType,
} from '@discordjs/voice';
import play from 'play-dl';
import ffmpegStatic from 'ffmpeg-static';
process.env.FFMPEG_PATH = ffmpegStatic;

// Spotify auth for play-dl (optional — enables playlist/album URLs)
if (process.env.SPOTIFY_ID && process.env.SPOTIFY_SECRET) {
  try {
    await play.setToken({
      spotify: {
        client_id: process.env.SPOTIFY_ID,
        client_secret: process.env.SPOTIFY_SECRET,
        refresh_token: process.env.SPOTIFY_REFRESH || '',
        market: 'US',
      },
    });
    console.log('Spotify auth loaded.');
  } catch (e) { console.warn('Spotify auth failed:', e.message); }
}

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const PREFIX = ']';
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const PINK = 0xff66cc;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
});

// ---------- in-memory state ----------
const snipes = new Map();      // channelId -> { content, author, time }
const editSnipes = new Map();  // channelId -> { before, after, author, time }
const afk = new Map();         // userId -> { reason, since }

// ---------- helpers ----------

const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, sec && `${sec}s`].filter(Boolean).join(' ') || '0s';
};

const parseDuration = (raw) => {
  if (!raw) return null;
  const m = /^(\d+)\s*(s|sec|m|min|h|hr|d|day|w|wk)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  const mult =
    unit.startsWith('s') ? 1000 :
    unit.startsWith('m') ? 60_000 :
    unit.startsWith('h') ? 3_600_000 :
    unit.startsWith('d') ? 86_400_000 :
    unit.startsWith('w') ? 604_800_000 : 60_000;
  return n * mult;
};

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Fuzzy single-token match
const fuzzyMemberMatch = (guild, token) => {
  const needle = normalize(token);
  if (!needle) return null;
  const members = guild.members.cache;
  // exact username
  let hit = members.find(m => m.user.username.toLowerCase() === token.toLowerCase());
  if (hit) return hit;
  // exact displayName
  hit = members.find(m => m.displayName.toLowerCase() === token.toLowerCase());
  if (hit) return hit;
  // normalized exact
  hit = members.find(m => normalize(m.user.username) === needle || normalize(m.displayName) === needle);
  if (hit) return hit;
  // startsWith
  hit = members.find(m => normalize(m.user.username).startsWith(needle) || normalize(m.displayName).startsWith(needle));
  if (hit) return hit;
  // includes
  hit = members.find(m => normalize(m.user.username).includes(needle) || normalize(m.displayName).includes(needle));
  return hit ?? null;
};

// Greedy: try longest join of args first, so "! KVN" matches "! KVN"
// Returns { member, consumed } or null.
const resolveMemberGreedy = async (msg, args) => {
  if (!args.length || !msg.guild) return null;

  // Mention / ID shortcut on first token
  const first = args[0];
  const idTry = first.replace(/[<@!&>]/g, '');
  if (/^\d{15,22}$/.test(idTry)) {
    const m = await msg.guild.members.fetch(idTry).catch(() => null);
    if (m) return { member: m, consumed: 1 };
  }

  // Try greedy name match — longest first
  for (let k = Math.min(args.length, 5); k >= 1; k--) {
    const joined = args.slice(0, k).join(' ');
    const hit = fuzzyMemberMatch(msg.guild, joined);
    if (hit) return { member: hit, consumed: k };
  }
  return null;
};

const resolveUserId = (token) => {
  if (!token) return null;
  const id = token.replace(/[<@!&>]/g, '');
  return /^\d{15,22}$/.test(id) ? id : null;
};

const resolveRole = (msg, token) => {
  if (!token || !msg.guild) return null;
  const id = token.replace(/[<@&>]/g, '');
  if (/^\d{15,22}$/.test(id)) return msg.guild.roles.cache.get(id) ?? null;
  const n = normalize(token);
  return msg.guild.roles.cache.find(r => normalize(r.name) === n)
      ?? msg.guild.roles.cache.find(r => normalize(r.name).includes(n))
      ?? null;
};

const needPerm = (msg, perm, label) => {
  if (!msg.member?.permissions.has(perm)) {
    msg.reply(`nope, you need **${label}** for that, babe.`).catch(() => {});
    return false;
  }
  const me = msg.guild?.members?.me;
  if (!me?.permissions.has(perm)) {
    msg.reply(`i can't — missing **${label}** on my end. bump my perms.`).catch(() => {});
    return false;
  }
  return true;
};

const ok = (msg, text) => msg.reply(text).catch(() => {});
const bad = (msg, text) => msg.reply(text).catch(() => {});
const notFound = (msg) => bad(msg, "couldn't find that user, oll — try `@mention` or part of their name.");

const randPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const fetchJSON = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'kitty-bot' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Anime action gifs — no auth needed
const waifu = async (category) => {
  const j = await fetchJSON(`https://api.waifu.pics/sfw/${category}`);
  return j.url;
};

// Action command factory: "X does Y to Z" + gif
const actionCmd = (names, category, line) => alias(names, {
  category: 'Actions',
  desc: `${names[0]} someone (with gif)`,
  usage: `]${names[0]} @user`,
  run: async (msg, args) => {
    const f = await resolveMemberGreedy(msg, args);
    if (!f) return notFound(msg);
    const a = msg.author.username;
    const b = f.member.user.username;
    try {
      const url = await waifu(category);
      const embed = new EmbedBuilder()
        .setDescription(line(a, b))
        .setImage(url)
        .setColor(PINK);
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch {
      msg.reply(line(a, b)).catch(() => {});
    }
  },
});

// Solo action (no target): gif + line about self
const soloCmd = (names, category, line) => alias(names, {
  category: 'Actions',
  desc: `${names[0]} (with gif)`,
  usage: `]${names[0]}`,
  run: async (msg) => {
    const a = msg.author.username;
    try {
      const url = await waifu(category);
      const embed = new EmbedBuilder().setDescription(line(a)).setImage(url).setColor(PINK);
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch {
      msg.reply(line(a)).catch(() => {});
    }
  },
});

// ---------- command registry ----------

const commands = new Map();
const meta = [];
const alias = (names, data) => {
  meta.push({ primary: names[0], aliases: names.slice(1), ...data });
  for (const n of names) commands.set(n, data);
};

// ========== HELP ==========
alias(['help', 'h', 'commands', 'cmds'], {
  category: 'Utility',
  desc: 'List all commands',
  usage: ']help [command]',
  run: async (msg, args) => {
    if (args[0]) {
      const c = commands.get(args[0].toLowerCase());
      if (!c) return bad(msg, `no command called \`${args[0]}\`.`);
      const embed = new EmbedBuilder()
        .setTitle(`\`${PREFIX}${args[0]}\``)
        .setColor(PINK)
        .setDescription(c.desc)
        .addFields({ name: 'Usage', value: `\`${c.usage}\`` });
      return msg.reply({ embeds: [embed] }).catch(() => {});
    }
    const grouped = {};
    for (const m of meta) {
      (grouped[m.category] ||= []).push(`\`${m.primary}\``);
    }
    const embed = new EmbedBuilder()
      .setTitle(`kitty's commands — prefix \`${PREFIX}\``)
      .setColor(PINK)
      .setDescription(Object.entries(grouped).map(([k, v]) => `**${k}**\n${v.join(' ')}`).join('\n\n'))
      .setFooter({ text: `${PREFIX}help <command> for details  •  built by the best jew` });
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

// ========== MODERATION ==========

alias(['clear', 'purge', 'c'], {
  category: 'Moderation',
  desc: 'Delete N messages (default 100, max 1000)',
  usage: ']clear [amount]',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
    const amount = args[0] ? parseInt(args[0], 10) : 100;
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
      return bad(msg, 'amount must be 1–1000, hun.');
    }
    await msg.delete().catch(() => {});
    let deleted = 0;
    const cutoff = Date.now() - FOURTEEN_DAYS_MS;
    try {
      while (deleted < amount) {
        const take = Math.min(100, amount - deleted);
        const fetched = await msg.channel.messages.fetch({ limit: take });
        if (fetched.size === 0) break;
        const fresh = fetched.filter(m => m.createdTimestamp > cutoff && !m.pinned);
        const old = fetched.filter(m => m.createdTimestamp <= cutoff && !m.pinned);
        if (fresh.size > 0) {
          const res = await msg.channel.bulkDelete(fresh, true);
          deleted += res.size;
        } else if (old.size > 0) {
          for (const m of old.values()) {
            if (deleted >= amount) break;
            await m.delete().catch(() => {});
            deleted += 1;
          }
        } else break;
      }
      const note = await msg.channel.send(`swept **${deleted}** 🧹✨`);
      setTimeout(() => note.delete().catch(() => {}), 4000);
    } catch (err) {
      console.error(err);
      bad(msg, `mid-sweep hiccup after ${deleted}.`);
    }
  },
});

alias(['ban'], {
  category: 'Moderation',
  desc: 'Ban a member',
  usage: ']ban @user [reason]',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
    const found = await resolveMemberGreedy(msg, args);
    const idFallback = resolveUserId(args[0]);
    const reason = args.slice(found ? found.consumed : 1).join(' ') || 'no reason given';
    if (!found && !idFallback) return notFound(msg);
    try {
      if (found) {
        if (!found.member.bannable) return bad(msg, `can't ban **${found.member.user.tag}** — they outrank me.`);
        await found.member.ban({ reason, deleteMessageSeconds: 0 });
        ok(msg, `🔨 banned **${found.member.user.tag}** — ${reason}`);
      } else {
        await msg.guild.bans.create(idFallback, { reason });
        ok(msg, `🔨 banned \`${idFallback}\` — ${reason}`);
      }
    } catch (e) { bad(msg, `ban flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['unban'], {
  category: 'Moderation',
  desc: 'Unban by user ID',
  usage: ']unban <userId>',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
    const id = resolveUserId(args[0]);
    if (!id) return bad(msg, 'need a user ID, bestie.');
    try {
      await msg.guild.bans.remove(id, args.slice(1).join(' ') || 'no reason');
      ok(msg, `🕊️ unbanned \`${id}\`.`);
    } catch (e) { bad(msg, `unban flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['softban'], {
  category: 'Moderation',
  desc: 'Ban then immediately unban (clears their recent messages)',
  usage: ']softban @user [reason]',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    const reason = args.slice(found.consumed).join(' ') || 'softban';
    try {
      if (!found.member.bannable) return bad(msg, `can't touch **${found.member.user.tag}**.`);
      await found.member.ban({ reason, deleteMessageSeconds: 7 * 24 * 60 * 60 });
      await msg.guild.bans.remove(found.member.id, 'softban');
      ok(msg, `🧼 softbanned **${found.member.user.tag}** — mess cleaned.`);
    } catch (e) { bad(msg, `softban flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['kick'], {
  category: 'Moderation',
  desc: 'Kick a member',
  usage: ']kick @user [reason]',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.KickMembers, 'Kick Members')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    const reason = args.slice(found.consumed).join(' ') || 'no reason';
    try {
      if (!found.member.kickable) return bad(msg, `can't kick them — outranked.`);
      await found.member.kick(reason);
      ok(msg, `👢 kicked **${found.member.user.tag}** — ${reason}`);
    } catch (e) { bad(msg, `kick flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['mute', 'timeout', 'to'], {
  category: 'Moderation',
  desc: 'Timeout a member',
  usage: ']mute @user <duration> [reason]  (10m, 2h, 1d — max 28d)',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ModerateMembers, 'Moderate Members')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    const rest = args.slice(found.consumed);
    const ms = parseDuration(rest[0]);
    if (!ms) return bad(msg, 'give a duration like `10m`, `2h`, `1d`.');
    if (ms > 28 * 86_400_000) return bad(msg, 'max is 28 days, sorry babe.');
    const reason = rest.slice(1).join(' ') || 'no reason';
    try {
      if (!found.member.moderatable) return bad(msg, 'can\'t timeout them — outranked.');
      await found.member.timeout(ms, reason);
      ok(msg, `🤫 **${found.member.user.tag}** on ice for ${fmtDuration(ms)} — ${reason}`);
    } catch (e) { bad(msg, `mute flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['unmute', 'untimeout'], {
  category: 'Moderation',
  desc: 'Remove timeout',
  usage: ']unmute @user',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ModerateMembers, 'Moderate Members')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    try {
      await found.member.timeout(null);
      ok(msg, `🔊 **${found.member.user.tag}** off the ice.`);
    } catch (e) { bad(msg, `unmute flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['warn'], {
  category: 'Moderation',
  desc: 'Warn a member',
  usage: ']warn @user <reason>',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ModerateMembers, 'Moderate Members')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    const reason = args.slice(found.consumed).join(' ');
    if (!reason) return bad(msg, 'give a reason, hun — no silent warns.');
    try { await found.member.send(`⚠️ you got warned in **${msg.guild.name}** — ${reason}`); } catch {}
    ok(msg, `⚠️ warned **${found.member.user.tag}** — ${reason}`);
  },
});

// ========== CHANNEL ==========

alias(['lock'], {
  category: 'Channel',
  desc: 'Lock current channel',
  usage: ']lock',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
    try {
      await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: false });
      ok(msg, '🔒 locked. zip it, everyone.');
    } catch (e) { bad(msg, `lock flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['unlock'], {
  category: 'Channel',
  desc: 'Unlock current channel',
  usage: ']unlock',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
    try {
      await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: null });
      ok(msg, '🔓 unlocked. yap away.');
    } catch (e) { bad(msg, `unlock flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['hide'], {
  category: 'Channel',
  desc: 'Hide channel from @everyone',
  usage: ']hide',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
    try {
      await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { ViewChannel: false });
      ok(msg, '🙈 hidden.');
    } catch (e) { bad(msg, `hide flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['unhide', 'show'], {
  category: 'Channel',
  desc: 'Unhide channel',
  usage: ']unhide',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
    try {
      await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { ViewChannel: null });
      ok(msg, '👀 visible.');
    } catch (e) { bad(msg, `unhide flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['slowmode', 'slow'], {
  category: 'Channel',
  desc: 'Set slowmode (0 to clear, max 6h)',
  usage: ']slowmode <seconds|30s|5m>',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
    let seconds;
    if (/^\d+$/.test(args[0] || '')) seconds = parseInt(args[0], 10);
    else { const ms = parseDuration(args[0]); seconds = ms ? Math.floor(ms / 1000) : NaN; }
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 21600) {
      return bad(msg, 'give 0–21600 seconds (or `30s`, `5m`, `1h`).');
    }
    try {
      await msg.channel.setRateLimitPerUser(seconds);
      ok(msg, seconds === 0 ? '⏱️ slowmode off.' : `⏱️ slowmode: ${seconds}s.`);
    } catch (e) { bad(msg, `slowmode flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['nuke'], {
  category: 'Channel',
  desc: 'Clone channel + delete old',
  usage: ']nuke',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
    const ch = msg.channel;
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
      return bad(msg, 'only text channels, babe.');
    }
    try {
      const position = ch.position;
      const clone = await ch.clone();
      await clone.setPosition(position);
      await ch.delete('nuke');
      clone.send('💥 fresh slate, bitches.');
    } catch (e) { bad(msg, `nuke flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['pin'], {
  category: 'Channel',
  desc: 'Pin the replied-to message',
  usage: ']pin (reply to a message)',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
    const ref = msg.reference?.messageId;
    if (!ref) return bad(msg, 'reply to the message you want pinned.');
    try {
      const m = await msg.channel.messages.fetch(ref);
      await m.pin();
      ok(msg, '📌 pinned.');
    } catch (e) { bad(msg, `pin flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['unpin'], {
  category: 'Channel',
  desc: 'Unpin the replied-to message',
  usage: ']unpin (reply to a message)',
  run: async (msg) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
    const ref = msg.reference?.messageId;
    if (!ref) return bad(msg, 'reply to the message you want unpinned.');
    try {
      const m = await msg.channel.messages.fetch(ref);
      await m.unpin();
      ok(msg, '📍 unpinned.');
    } catch (e) { bad(msg, `unpin flopped: \`${e.code ?? e.message}\``); }
  },
});

// ========== ROLES ==========

alias(['role'], {
  category: 'Roles',
  desc: 'Role actions: add / remove / create / delete',
  usage: ']role add @user @role  |  ]role remove @user @role  |  ]role create <name>  |  ]role delete @role',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageRoles, 'Manage Roles')) return;
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'add' || sub === 'remove') {
      const found = await resolveMemberGreedy(msg, args.slice(1));
      if (!found) return notFound(msg);
      const role = resolveRole(msg, args[1 + found.consumed]);
      if (!role) return bad(msg, 'role not found.');
      try {
        if (sub === 'add') await found.member.roles.add(role);
        else await found.member.roles.remove(role);
        ok(msg, `${sub === 'add' ? '✅ gave' : '❌ took'} **${role.name}** ${sub === 'add' ? 'to' : 'from'} **${found.member.user.tag}**.`);
      } catch (e) { bad(msg, `role ${sub} flopped: \`${e.code ?? e.message}\``); }
    } else if (sub === 'create') {
      const name = args.slice(1).join(' ');
      if (!name) return bad(msg, 'give a name.');
      try {
        const r = await msg.guild.roles.create({ name });
        ok(msg, `✨ made role **${r.name}**.`);
      } catch (e) { bad(msg, `create flopped: \`${e.code ?? e.message}\``); }
    } else if (sub === 'delete') {
      const role = resolveRole(msg, args[1]);
      if (!role) return bad(msg, 'role not found.');
      try {
        await role.delete();
        ok(msg, `🗑️ nuked role **${role.name}**.`);
      } catch (e) { bad(msg, `delete flopped: \`${e.code ?? e.message}\``); }
    } else bad(msg, 'try: `add`, `remove`, `create`, or `delete`.');
  },
});

// ========== MEMBER ==========

alias(['nick', 'nickname'], {
  category: 'Member',
  desc: 'Set a member nickname (empty = clear)',
  usage: ']nick @user [new nick]',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageNicknames, 'Manage Nicknames')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    const newNick = args.slice(found.consumed).join(' ') || null;
    try {
      await found.member.setNickname(newNick);
      ok(msg, newNick ? `✏️ **${found.member.user.tag}** is now **${newNick}**.` : '✏️ nick wiped.');
    } catch (e) { bad(msg, `nick flopped: \`${e.code ?? e.message}\``); }
  },
});

alias(['avatar', 'av', 'pfp'], {
  category: 'Member',
  desc: "Show a user's avatar",
  usage: ']avatar [@user]',
  run: async (msg, args) => {
    let user = msg.author;
    if (args.length) {
      const f = await resolveMemberGreedy(msg, args);
      if (f) user = f.member.user;
      else {
        const id = resolveUserId(args[0]);
        if (id) user = await client.users.fetch(id).catch(() => msg.author);
      }
    }
    const embed = new EmbedBuilder()
      .setTitle(`${user.tag}`)
      .setImage(user.displayAvatarURL({ size: 4096 }))
      .setColor(PINK);
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['banner'], {
  category: 'Member',
  desc: "Show a user's banner",
  usage: ']banner [@user]',
  run: async (msg, args) => {
    let id = msg.author.id;
    if (args.length) {
      const f = await resolveMemberGreedy(msg, args);
      id = f?.member.id ?? resolveUserId(args[0]) ?? msg.author.id;
    }
    try {
      const u = await client.users.fetch(id, { force: true });
      if (!u.banner) return bad(msg, 'no banner, womp.');
      const embed = new EmbedBuilder()
        .setTitle(`${u.tag}'s banner`)
        .setImage(u.bannerURL({ size: 4096 }))
        .setColor(PINK);
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `failed: \`${e.code ?? e.message}\``); }
  },
});

alias(['userinfo', 'ui', 'whois'], {
  category: 'Member',
  desc: 'Info about a user',
  usage: ']userinfo [@user]',
  run: async (msg, args) => {
    let target = msg.member;
    if (args.length) {
      const f = await resolveMemberGreedy(msg, args);
      if (!f) return notFound(msg);
      target = f.member;
    }
    const u = target.user;
    const roles = target.roles.cache.filter(r => r.id !== msg.guild.id).map(r => `<@&${r.id}>`).join(' ') || 'None';
    const embed = new EmbedBuilder()
      .setTitle(u.tag)
      .setThumbnail(u.displayAvatarURL({ size: 512 }))
      .setColor(target.displayHexColor || PINK)
      .addFields(
        { name: 'ID', value: u.id, inline: true },
        { name: 'Account made', value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Joined', value: target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : '?', inline: true },
        { name: `Roles [${target.roles.cache.size - 1}]`, value: roles.length > 1024 ? roles.slice(0, 1020) + '…' : roles },
      );
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

// ========== SERVER ==========

alias(['serverinfo', 'si', 'guildinfo'], {
  category: 'Server',
  desc: 'Info about the server',
  usage: ']serverinfo',
  run: async (msg) => {
    const g = msg.guild;
    const owner = await g.fetchOwner().catch(() => null);
    const embed = new EmbedBuilder()
      .setTitle(g.name)
      .setThumbnail(g.iconURL({ size: 512 }) ?? null)
      .setColor(PINK)
      .addFields(
        { name: 'ID', value: g.id, inline: true },
        { name: 'Owner', value: owner ? `<@${owner.id}>` : '?', inline: true },
        { name: 'Made', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Members', value: `${g.memberCount}`, inline: true },
        { name: 'Channels', value: `${g.channels.cache.size}`, inline: true },
        { name: 'Roles', value: `${g.roles.cache.size}`, inline: true },
        { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (Tier ${g.premiumTier})`, inline: true },
      );
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['icon'], {
  category: 'Server',
  desc: "Server icon",
  usage: ']icon',
  run: async (msg) => {
    const url = msg.guild?.iconURL({ size: 4096 });
    if (!url) return bad(msg, 'no icon set.');
    msg.reply({ embeds: [new EmbedBuilder().setTitle(msg.guild.name).setImage(url).setColor(PINK)] }).catch(() => {});
  },
});

alias(['members', 'membercount'], {
  category: 'Server',
  desc: 'Member count',
  usage: ']members',
  run: async (msg) => ok(msg, `👥 **${msg.guild.memberCount}** of your finest.`),
});

alias(['roles-list', 'roleslist', 'rolelist'], {
  category: 'Server',
  desc: 'List all roles',
  usage: ']roles-list',
  run: async (msg) => {
    const list = msg.guild.roles.cache
      .sort((a, b) => b.position - a.position)
      .map(r => `<@&${r.id}>`)
      .join(' ');
    const chunks = list.match(/[\s\S]{1,1900}/g) ?? ['none'];
    for (const c of chunks) await msg.channel.send(c).catch(() => {});
  },
});

// ========== UTILITY ==========

alias(['say'], {
  category: 'Utility',
  desc: 'Make the bot say something',
  usage: ']say <text>',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
    const text = args.join(' ');
    if (!text) return bad(msg, 'give me words.');
    await msg.delete().catch(() => {});
    msg.channel.send(text).catch(() => {});
  },
});

alias(['embed'], {
  category: 'Utility',
  desc: 'Send a pink embed',
  usage: ']embed <title> | <description>',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
    const text = args.join(' ');
    const [title, ...rest] = text.split('|');
    const description = rest.join('|').trim();
    if (!title) return bad(msg, 'usage: `]embed Title | Description`');
    await msg.delete().catch(() => {});
    const embed = new EmbedBuilder().setTitle(title.trim()).setColor(PINK);
    if (description) embed.setDescription(description);
    msg.channel.send({ embeds: [embed] }).catch(() => {});
  },
});

alias(['ping'], {
  category: 'Utility',
  desc: 'Latency check',
  usage: ']ping',
  run: async (msg) => {
    const sent = await msg.reply('pinging...');
    const rt = sent.createdTimestamp - msg.createdTimestamp;
    sent.edit(`🏓 **${rt}ms** roundtrip • **${client.ws.ping}ms** ws`).catch(() => {});
  },
});

alias(['uptime'], {
  category: 'Utility',
  desc: 'How long i\'ve been up',
  usage: ']uptime',
  run: async (msg) => ok(msg, `⏰ up for **${fmtDuration(client.uptime ?? 0)}** without a nap.`),
});

alias(['invite'], {
  category: 'Utility',
  desc: 'Bot invite link',
  usage: ']invite',
  run: async (msg) => ok(msg, `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot+applications.commands&permissions=1099780074743`),
});

alias(['botinfo', 'bi'], {
  category: 'Utility',
  desc: 'Info about the bot',
  usage: ']botinfo',
  run: async (msg) => {
    const embed = new EmbedBuilder()
      .setTitle(`${client.user.tag}`)
      .setThumbnail(client.user.displayAvatarURL({ size: 512 }))
      .setColor(PINK)
      .addFields(
        { name: 'Guilds', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Users', value: `${client.users.cache.size}`, inline: true },
        { name: 'Uptime', value: fmtDuration(client.uptime ?? 0), inline: true },
        { name: 'Commands', value: `${meta.length}`, inline: true },
        { name: 'Built by', value: 'kvn ofc 💅', inline: true },
      );
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

// ========== FUN ==========

alias(['snipe'], {
  category: 'Fun',
  desc: 'Show the last deleted message in this channel',
  usage: ']snipe',
  run: async (msg) => {
    const s = snipes.get(msg.channel.id);
    if (!s) return bad(msg, "nothing to snipe, chat's innocent.");
    const embed = new EmbedBuilder()
      .setAuthor({ name: s.author.tag, iconURL: s.author.displayAvatarURL() })
      .setDescription(s.content || '*(no content)*')
      .setColor(PINK)
      .setFooter({ text: `deleted • ${new Date(s.time).toLocaleTimeString()}` });
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['editsnipe', 'esnipe'], {
  category: 'Fun',
  desc: 'Show the last edited message in this channel',
  usage: ']editsnipe',
  run: async (msg) => {
    const s = editSnipes.get(msg.channel.id);
    if (!s) return bad(msg, 'no edits to snipe.');
    const embed = new EmbedBuilder()
      .setAuthor({ name: s.author.tag, iconURL: s.author.displayAvatarURL() })
      .setColor(PINK)
      .addFields(
        { name: 'Before', value: s.before || '*(empty)*' },
        { name: 'After', value: s.after || '*(empty)*' },
      )
      .setFooter({ text: `edited • ${new Date(s.time).toLocaleTimeString()}` });
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['afk'], {
  category: 'Fun',
  desc: 'Set yourself AFK — pings you get while gone will notify',
  usage: ']afk [reason]',
  run: async (msg, args) => {
    const reason = args.join(' ') || 'afk';
    afk.set(msg.author.id, { reason, since: Date.now() });
    ok(msg, `💤 set afk — ${reason}`);
  },
});

alias(['8ball', '8', 'eightball'], {
  category: 'Fun',
  desc: 'Ask the magic 8ball',
  usage: ']8ball <question>',
  run: async (msg, args) => {
    if (!args.length) return bad(msg, 'ask me something, hun.');
    const answers = [
      'absolutely babe', 'no chance', 'yeah probably', 'girl... no',
      'ask again when sober', 'the stars say yes', 'the stars say absolutely not',
      '100%', 'lmao no', 'maybe. flip a coin.', 'you already know', 'nope nope nope',
    ];
    ok(msg, `🎱 ${randPick(answers)}`);
  },
});

alias(['coinflip', 'flip', 'cf'], {
  category: 'Fun',
  desc: 'Flip a coin',
  usage: ']coinflip',
  run: async (msg) => ok(msg, Math.random() < 0.5 ? '🪙 heads.' : '🪙 tails.'),
});

alias(['dice', 'roll'], {
  category: 'Fun',
  desc: 'Roll a die (default d6)',
  usage: ']roll [sides]',
  run: async (msg, args) => {
    const sides = Math.max(2, Math.min(1000, parseInt(args[0], 10) || 6));
    ok(msg, `🎲 ${Math.floor(Math.random() * sides) + 1} (d${sides})`);
  },
});

alias(['choose', 'pick'], {
  category: 'Fun',
  desc: 'Pick one — separate with |',
  usage: ']choose a | b | c',
  run: async (msg, args) => {
    const opts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
    if (opts.length < 2) return bad(msg, 'give me 2+ options separated by `|`.');
    ok(msg, `✨ ${randPick(opts)}`);
  },
});

alias(['poll'], {
  category: 'Fun',
  desc: 'Simple yes/no poll',
  usage: ']poll <question>',
  run: async (msg, args) => {
    if (!args.length) return bad(msg, 'give me a question.');
    const m = await msg.channel.send({
      embeds: [new EmbedBuilder().setTitle('📊 poll').setDescription(args.join(' ')).setColor(PINK).setFooter({ text: `by ${msg.author.tag}` })],
    });
    await m.react('✅');
    await m.react('❌');
    msg.delete().catch(() => {});
  },
});

alias(['gay'], {
  category: 'Fun',
  desc: 'How gay is someone (very scientific)',
  usage: ']gay [@user]',
  run: async (msg, args) => {
    let target = msg.author;
    if (args.length) {
      const f = await resolveMemberGreedy(msg, args);
      if (f) target = f.member.user;
    }
    const pct = Math.floor(Math.random() * 101);
    const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
    ok(msg, `🌈 **${target.username}** is **${pct}%** gay\n\`${bar}\``);
  },
});

alias(['ship'], {
  category: 'Fun',
  desc: 'Ship two people',
  usage: ']ship @user1 @user2',
  run: async (msg, args) => {
    const a = await resolveMemberGreedy(msg, args);
    if (!a) return notFound(msg);
    const b = await resolveMemberGreedy(msg, args.slice(a.consumed));
    if (!b) return notFound(msg);
    const pct = Math.floor(Math.random() * 101);
    const name = a.member.user.username.slice(0, Math.ceil(a.member.user.username.length / 2)) +
                 b.member.user.username.slice(Math.floor(b.member.user.username.length / 2));
    ok(msg, `💕 **${a.member.user.username}** + **${b.member.user.username}** = **${name}** — ${pct}%`);
  },
});

// ========== ACTIONS (with gifs via waifu.pics) ==========

actionCmd(['hug'],      'hug',      (a, b) => `🫂 **${a}** hugs **${b}** tight.`);
actionCmd(['slap'],     'slap',     (a, b) => `👋 **${a}** slaps **${b}** clean across the face.`);
actionCmd(['kiss'],     'kiss',     (a, b) => `💋 **${a}** kisses **${b}**. scandalous.`);
actionCmd(['pat'],      'pat',      (a, b) => `🫶 **${a}** pats **${b}** softly.`);
actionCmd(['poke'],     'poke',     (a, b) => `👉 **${a}** pokes **${b}**. stop it.`);
actionCmd(['bite'],     'bite',     (a, b) => `🦷 **${a}** bites **${b}**. feral.`);
actionCmd(['cuddle'],   'cuddle',   (a, b) => `💞 **${a}** cuddles up to **${b}**.`);
actionCmd(['bonk'],     'bonk',     (a, b) => `🔨 **${a}** bonks **${b}**. go to horny jail.`);
actionCmd(['bully'],    'bully',    (a, b) => `😈 **${a}** is bullying **${b}**.`);
actionCmd(['yeet'],     'yeet',     (a, b) => `🚀 **${a}** yeets **${b}** into orbit.`);
actionCmd(['nom'],      'nom',      (a, b) => `😋 **${a}** noms on **${b}**.`);
actionCmd(['highfive', 'hf'], 'highfive', (a, b) => `🙏 **${a}** high-fives **${b}**!`);
actionCmd(['handhold'], 'handhold', (a, b) => `🤝 **${a}** holds **${b}**'s hand. lewd.`);
actionCmd(['lick'],     'lick',     (a, b) => `👅 **${a}** licks **${b}**.`);
actionCmd(['kill'],     'kill',     (a, b) => `🔪 **${a}** ends **${b}**. rip.`);
actionCmd(['kickk'],    'kick',     (a, b) => `🦵 **${a}** kicks **${b}**.`); // 'kick' is moderation

// Solo action commands
soloCmd(['dance'],  'dance',  a => `💃 **${a}** hits the dancefloor.`);
soloCmd(['cry'],    'cry',    a => `😭 **${a}** is sobbing.`);
soloCmd(['wave'],   'wave',   a => `👋 **${a}** waves hello.`);
soloCmd(['blush'],  'blush',  a => `😊 **${a}** is blushing.`);
soloCmd(['smile'],  'smile',  a => `😊 **${a}** smiles.`);
soloCmd(['smug'],   'smug',   a => `😏 **${a}** looks smug.`);
soloCmd(['wink'],   'wink',   a => `😉 **${a}** winks.`);
soloCmd(['cringe'], 'cringe', a => `😬 **${a}** cringes hard.`);
soloCmd(['happy'],  'happy',  a => `😄 **${a}** is happy.`);

// ========== PICTURES ==========

alias(['cat'], {
  category: 'Pictures',
  desc: 'Random cat picture',
  usage: ']cat',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://api.thecatapi.com/v1/images/search');
      const url = j[0]?.url;
      if (!url) throw new Error('no cat');
      msg.reply({ embeds: [new EmbedBuilder().setImage(url).setColor(PINK).setFooter({ text: '🐱 meow' })] }).catch(() => {});
    } catch { bad(msg, 'cats are hiding, try again.'); }
  },
});

alias(['dog'], {
  category: 'Pictures',
  desc: 'Random dog picture',
  usage: ']dog',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://dog.ceo/api/breeds/image/random');
      msg.reply({ embeds: [new EmbedBuilder().setImage(j.message).setColor(PINK).setFooter({ text: '🐶 woof' })] }).catch(() => {});
    } catch { bad(msg, 'dogs ran off, try again.'); }
  },
});

alias(['fox'], {
  category: 'Pictures',
  desc: 'Random fox picture',
  usage: ']fox',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://randomfox.ca/floof/');
      msg.reply({ embeds: [new EmbedBuilder().setImage(j.image).setColor(PINK).setFooter({ text: '🦊' })] }).catch(() => {});
    } catch { bad(msg, 'no foxes today.'); }
  },
});

alias(['duck'], {
  category: 'Pictures',
  desc: 'Random duck picture',
  usage: ']duck',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://random-d.uk/api/v2/random');
      msg.reply({ embeds: [new EmbedBuilder().setImage(j.url).setColor(PINK).setFooter({ text: '🦆 quack' })] }).catch(() => {});
    } catch { bad(msg, 'ducks flew south.'); }
  },
});

// ========== TEXT TOYS ==========

alias(['mock'], {
  category: 'Text',
  desc: 'sPoNgEbOb mOcK tExT',
  usage: ']mock <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'give me text to mock.');
    ok(msg, text.split('').map((c, i) => i % 2 ? c.toLowerCase() : c.toUpperCase()).join(''));
  },
});

alias(['reverse', 'rev'], {
  category: 'Text',
  desc: 'Reverse text',
  usage: ']reverse <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'give me text to flip.');
    ok(msg, text.split('').reverse().join(''));
  },
});

alias(['caps', 'upper'], {
  category: 'Text',
  desc: 'YELL',
  usage: ']caps <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'words?');
    ok(msg, text.toUpperCase());
  },
});

alias(['lower'], {
  category: 'Text',
  desc: 'whisper',
  usage: ']lower <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'words?');
    ok(msg, text.toLowerCase());
  },
});

alias(['clap'], {
  category: 'Text',
  desc: 'add 👏 claps 👏 between 👏 words',
  usage: ']clap <text>',
  run: async (msg, args) => {
    if (!args.length) return bad(msg, 'words?');
    ok(msg, args.join(' 👏 '));
  },
});

alias(['owo', 'uwu'], {
  category: 'Text',
  desc: 'owoify text',
  usage: ']owo <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'say somethwing');
    const owo = text
      .replace(/[rl]/g, 'w').replace(/[RL]/g, 'W')
      .replace(/n([aeiou])/g, 'ny$1').replace(/N([aeiou])/g, 'Ny$1')
      .replace(/ove/g, 'uv');
    const faces = [' owo', ' uwu', ' ^w^', ' >w<', ' :3'];
    ok(msg, owo + randPick(faces));
  },
});

alias(['base64', 'b64'], {
  category: 'Text',
  desc: 'Base64 encode/decode',
  usage: ']base64 encode|decode <text>',
  run: async (msg, args) => {
    const mode = (args[0] || '').toLowerCase();
    const text = args.slice(1).join(' ');
    if (!text) return bad(msg, 'usage: `]base64 encode hello` or `]base64 decode aGVsbG8=`');
    try {
      if (mode === 'encode' || mode === 'e') ok(msg, '```\n' + Buffer.from(text).toString('base64') + '\n```');
      else if (mode === 'decode' || mode === 'd') ok(msg, '```\n' + Buffer.from(text, 'base64').toString('utf-8') + '\n```');
      else bad(msg, 'mode must be `encode` or `decode`.');
    } catch { bad(msg, 'invalid input.'); }
  },
});

// ========== MISC ==========

alias(['color', 'colour', 'hex'], {
  category: 'Misc',
  desc: 'Preview a hex color',
  usage: ']color #ff66cc',
  run: async (msg, args) => {
    let hex = (args[0] || '').replace('#', '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return bad(msg, 'give a 6-digit hex like `ff66cc`.');
    const int = parseInt(hex, 16);
    const img = `https://singlecolorimage.com/get/${hex}/400x200.png`;
    const embed = new EmbedBuilder()
      .setTitle(`#${hex.toUpperCase()}`)
      .setColor(int)
      .setImage(img)
      .addFields(
        { name: 'R', value: `${(int >> 16) & 255}`, inline: true },
        { name: 'G', value: `${(int >> 8) & 255}`, inline: true },
        { name: 'B', value: `${int & 255}`, inline: true },
      );
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['firstmsg', 'first'], {
  category: 'Misc',
  desc: "Jump to this channel's first message",
  usage: ']firstmsg',
  run: async (msg) => {
    try {
      const batch = await msg.channel.messages.fetch({ after: '0', limit: 1 });
      const first = batch.first();
      if (!first) return bad(msg, 'no messages found.');
      ok(msg, `first message: ${first.url}`);
    } catch (e) { bad(msg, `failed: \`${e.message}\``); }
  },
});

alias(['qr'], {
  category: 'Misc',
  desc: 'Generate a QR code',
  usage: ']qr <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'what should the QR encode?');
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
    msg.reply({ embeds: [new EmbedBuilder().setImage(url).setColor(PINK).setFooter({ text: text.slice(0, 100) })] }).catch(() => {});
  },
});

alias(['rate'], {
  category: 'Misc',
  desc: 'Rate something /10',
  usage: ']rate <thing>',
  run: async (msg, args) => {
    const thing = args.join(' ') || 'that';
    ok(msg, `i'd rate **${thing}** a **${Math.floor(Math.random() * 11)}/10**.`);
  },
});

alias(['reverse-ping', 'rp'], {
  category: 'Misc',
  desc: 'Who pinged me last?',
  usage: ']rp',
  run: async (msg) => {
    try {
      const batch = await msg.channel.messages.fetch({ limit: 100 });
      const ping = batch.find(m => m.mentions.users.has(msg.author.id) && m.author.id !== msg.author.id);
      if (!ping) return bad(msg, "nobody's pinged you recently.");
      ok(msg, `**${ping.author.tag}** pinged you: ${ping.url}`);
    } catch (e) { bad(msg, `failed: \`${e.message}\``); }
  },
});

// ========== OCR — picture to text ==========

const findImage = async (msg, args) => {
  // 1. attachment on current msg
  const att = msg.attachments.find(a => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.name || ''));
  if (att) return att.url;
  // 2. reply to a message with attachment / embed image
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      const a = ref.attachments.find(a => (a.contentType || '').startsWith('image/'));
      if (a) return a.url;
      const em = ref.embeds.find(e => e.image || e.thumbnail);
      if (em) return (em.image || em.thumbnail).url;
      // URL in replied message content
      const m = ref.content.match(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif|bmp)/i);
      if (m) return m[0];
    } catch {}
  }
  // 3. URL in args
  const urlArg = args.find(a => /^https?:\/\//i.test(a));
  if (urlArg) return urlArg;
  return null;
};

alias(['ocr', 'read', 'readpic'], {
  category: 'OCR',
  desc: 'Pull text out of an image (attach, reply, or URL)',
  usage: ']ocr  (with image attached, reply, or URL)',
  run: async (msg, args) => {
    const url = await findImage(msg, args);
    if (!url) return bad(msg, 'attach an image, reply to one, or paste a URL.');
    const working = await msg.reply('🔍 reading...').catch(() => null);
    try {
      const result = await Tesseract.recognize(url, 'eng');
      const text = (result.data.text || '').trim();
      if (!text) return working?.edit('🫥 no text found in that image.');
      const chunks = text.match(/[\s\S]{1,1900}/g) ?? [text];
      await working?.edit({ content: `📖 **got it:**\n\`\`\`\n${chunks[0]}\n\`\`\`` });
      for (let i = 1; i < chunks.length; i++) {
        await msg.channel.send(`\`\`\`\n${chunks[i]}\n\`\`\``).catch(() => {});
      }
    } catch (e) {
      console.error(e);
      working?.edit(`💀 ocr failed: \`${e.message}\``);
    }
  },
});

// ========== FACTS / JOKES / QUOTES ==========

alias(['joke'], {
  category: 'Fun',
  desc: 'Tell a joke',
  usage: ']joke',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://v2.jokeapi.dev/joke/Any?safe-mode');
      const text = j.type === 'single' ? j.joke : `${j.setup}\n\n|| ${j.delivery} ||`;
      ok(msg, `🎭 ${text}`);
    } catch { bad(msg, 'joke api ghosted me.'); }
  },
});

alias(['dadjoke', 'dad'], {
  category: 'Fun',
  desc: 'A dad joke',
  usage: ']dadjoke',
  run: async (msg) => {
    try {
      const r = await fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json', 'User-Agent': 'kitty-bot' } });
      const j = await r.json();
      ok(msg, `👨 ${j.joke}`);
    } catch { bad(msg, 'dad is out buying milk.'); }
  },
});

alias(['fact'], {
  category: 'Fun',
  desc: 'Useless fact',
  usage: ']fact',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
      ok(msg, `🧠 ${j.text}`);
    } catch { bad(msg, 'facts machine broke.'); }
  },
});

alias(['advice'], {
  category: 'Fun',
  desc: 'Random advice',
  usage: ']advice',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://api.adviceslip.com/advice');
      ok(msg, `💡 ${j.slip.advice}`);
    } catch { bad(msg, 'no advice left to give.'); }
  },
});

alias(['quote'], {
  category: 'Fun',
  desc: 'Inspirational quote',
  usage: ']quote',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://zenquotes.io/api/random');
      ok(msg, `💬 *"${j[0].q}"* — **${j[0].a}**`);
    } catch { bad(msg, 'muses are on strike.'); }
  },
});

alias(['meme'], {
  category: 'Fun',
  desc: 'Random meme',
  usage: ']meme',
  run: async (msg) => {
    try {
      const j = await fetchJSON('https://meme-api.com/gimme');
      const embed = new EmbedBuilder()
        .setTitle(j.title?.slice(0, 256) || 'meme')
        .setURL(j.postLink)
        .setImage(j.url)
        .setColor(PINK)
        .setFooter({ text: `r/${j.subreddit} • ⬆ ${j.ups}` });
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch { bad(msg, 'meme supply chain disrupted.'); }
  },
});

// ========== DEFINITIONS / LOOKUPS ==========

alias(['define', 'def'], {
  category: 'Lookups',
  desc: 'Dictionary definition',
  usage: ']define <word>',
  run: async (msg, args) => {
    const word = args.join(' ').trim();
    if (!word) return bad(msg, 'what word?');
    try {
      const j = await fetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const entry = j[0];
      const fields = entry.meanings.slice(0, 4).map(m => ({
        name: m.partOfSpeech,
        value: m.definitions.slice(0, 3).map((d, i) => `${i + 1}. ${d.definition}`).join('\n').slice(0, 1024),
      }));
      const embed = new EmbedBuilder().setTitle(entry.word).setColor(PINK).addFields(fields);
      if (entry.phonetic) embed.setDescription(`*${entry.phonetic}*`);
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch { bad(msg, `no entry for **${word}**.`); }
  },
});

alias(['wiki'], {
  category: 'Lookups',
  desc: 'Wikipedia summary',
  usage: ']wiki <topic>',
  run: async (msg, args) => {
    const topic = args.join(' ').trim();
    if (!topic) return bad(msg, 'topic?');
    try {
      const j = await fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`);
      if (j.type === 'disambiguation') return bad(msg, 'too ambiguous, be more specific.');
      const embed = new EmbedBuilder()
        .setTitle(j.title)
        .setURL(j.content_urls?.desktop?.page)
        .setDescription(j.extract?.slice(0, 2000) || 'no summary.')
        .setColor(PINK);
      if (j.thumbnail?.source) embed.setThumbnail(j.thumbnail.source);
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch { bad(msg, 'wikipedia had no answer.'); }
  },
});

alias(['github', 'gh'], {
  category: 'Lookups',
  desc: 'GitHub user info',
  usage: ']github <username>',
  run: async (msg, args) => {
    const name = args[0];
    if (!name) return bad(msg, 'give me a username.');
    try {
      const j = await fetchJSON(`https://api.github.com/users/${encodeURIComponent(name)}`);
      const embed = new EmbedBuilder()
        .setTitle(j.login)
        .setURL(j.html_url)
        .setThumbnail(j.avatar_url)
        .setColor(PINK)
        .setDescription(j.bio || '*no bio*')
        .addFields(
          { name: 'Repos', value: `${j.public_repos}`, inline: true },
          { name: 'Followers', value: `${j.followers}`, inline: true },
          { name: 'Following', value: `${j.following}`, inline: true },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch { bad(msg, 'user not found.'); }
  },
});

alias(['npm'], {
  category: 'Lookups',
  desc: 'npm package info',
  usage: ']npm <package>',
  run: async (msg, args) => {
    const name = args[0];
    if (!name) return bad(msg, 'package name?');
    try {
      const j = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      const latest = j['dist-tags']?.latest;
      const v = j.versions?.[latest];
      const embed = new EmbedBuilder()
        .setTitle(`${j.name} @ ${latest}`)
        .setURL(`https://www.npmjs.com/package/${j.name}`)
        .setDescription(j.description || '*no description*')
        .setColor(PINK)
        .addFields(
          { name: 'Latest', value: latest || '?', inline: true },
          { name: 'License', value: v?.license || '?', inline: true },
          { name: 'Author', value: v?.author?.name || j.author?.name || '?', inline: true },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch { bad(msg, 'package not found.'); }
  },
});

alias(['coin', 'crypto'], {
  category: 'Lookups',
  desc: 'Crypto price',
  usage: ']coin bitcoin',
  run: async (msg, args) => {
    const id = args[0]?.toLowerCase();
    if (!id) return bad(msg, 'try `]coin bitcoin` or `]coin ethereum`.');
    try {
      const j = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`);
      const d = j[id];
      if (!d) return bad(msg, `no coin "${id}".`);
      const arrow = d.usd_24h_change >= 0 ? '📈' : '📉';
      ok(msg, `${arrow} **${id}** — **$${d.usd.toLocaleString()}** (${d.usd_24h_change.toFixed(2)}% 24h)`);
    } catch { bad(msg, 'coingecko is napping.'); }
  },
});

alias(['weather'], {
  category: 'Lookups',
  desc: 'Weather for a city',
  usage: ']weather <city>',
  run: async (msg, args) => {
    const city = args.join(' ').trim();
    if (!city) return bad(msg, 'what city?');
    try {
      const geo = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
      if (!geo.results?.[0]) return bad(msg, 'city not found.');
      const g = geo.results[0];
      const w = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=celsius`);
      const c = w.current;
      const embed = new EmbedBuilder()
        .setTitle(`🌤️ ${g.name}, ${g.country}`)
        .setColor(PINK)
        .addFields(
          { name: 'Temperature', value: `${c.temperature_2m}°C`, inline: true },
          { name: 'Humidity', value: `${c.relative_humidity_2m}%`, inline: true },
          { name: 'Wind', value: `${c.wind_speed_10m} km/h`, inline: true },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch { bad(msg, 'weather is down.'); }
  },
});

// ========== ENCODE / DECODE ==========

alias(['morse'], {
  category: 'Text',
  desc: 'Morse encode/decode',
  usage: ']morse encode|decode <text>',
  run: async (msg, args) => {
    const mode = args[0]?.toLowerCase();
    const text = args.slice(1).join(' ');
    if (!text) return bad(msg, 'usage: `]morse encode hello` or `]morse decode .... . .-.. .-.. ---`');
    const map = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
    const inv = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
    if (mode === 'encode' || mode === 'e') {
      ok(msg, text.toUpperCase().split('').map(c => c === ' ' ? '/' : map[c] || '').filter(Boolean).join(' '));
    } else if (mode === 'decode' || mode === 'd') {
      ok(msg, text.split(/\s+/).map(c => c === '/' ? ' ' : inv[c] || '').join(''));
    } else bad(msg, 'mode: `encode` or `decode`.');
  },
});

alias(['binary', 'bin'], {
  category: 'Text',
  desc: 'Binary encode/decode',
  usage: ']binary encode|decode <text>',
  run: async (msg, args) => {
    const mode = args[0]?.toLowerCase();
    const text = args.slice(1).join(' ');
    if (!text) return bad(msg, 'usage: `]binary encode hi`');
    if (mode === 'encode' || mode === 'e') {
      ok(msg, text.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' '));
    } else if (mode === 'decode' || mode === 'd') {
      try { ok(msg, text.split(/\s+/).map(b => String.fromCharCode(parseInt(b, 2))).join('')); }
      catch { bad(msg, 'invalid binary.'); }
    } else bad(msg, 'mode: `encode` or `decode`.');
  },
});

alias(['rot13'], {
  category: 'Text',
  desc: 'ROT13 cipher',
  usage: ']rot13 <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'text?');
    ok(msg, text.replace(/[a-zA-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() < 'n' ? 13 : -13))));
  },
});

alias(['hex'], {
  category: 'Text',
  desc: 'Hex encode/decode',
  usage: ']hex encode|decode <text>',
  run: async (msg, args) => {
    const mode = args[0]?.toLowerCase();
    const text = args.slice(1).join(' ');
    if (!text) return bad(msg, 'text?');
    try {
      if (mode === 'encode' || mode === 'e') ok(msg, Buffer.from(text).toString('hex'));
      else if (mode === 'decode' || mode === 'd') ok(msg, Buffer.from(text, 'hex').toString('utf-8'));
      else bad(msg, 'mode: `encode` or `decode`.');
    } catch { bad(msg, 'bad input.'); }
  },
});

// ========== MATH / RNG ==========

alias(['math', 'calc'], {
  category: 'Math',
  desc: 'Evaluate a math expression (safe: numbers + - * / % ** parens)',
  usage: ']math 2+2*3',
  run: async (msg, args) => {
    const expr = args.join(' ').trim();
    if (!/^[\d\s+\-*/().%*]+$/.test(expr)) return bad(msg, 'only numbers and `+ - * / % ** ( )` allowed.');
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      ok(msg, `🧮 \`${expr}\` = **${result}**`);
    } catch { bad(msg, 'invalid expression.'); }
  },
});

alias(['random', 'rand'], {
  category: 'Math',
  desc: 'Random integer in range',
  usage: ']random <min> <max>',
  run: async (msg, args) => {
    const a = parseInt(args[0], 10);
    const b = parseInt(args[1], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return bad(msg, 'usage: `]random 1 100`');
    const [lo, hi] = a < b ? [a, b] : [b, a];
    ok(msg, `🎲 ${Math.floor(Math.random() * (hi - lo + 1)) + lo}`);
  },
});

alias(['pwgen', 'password'], {
  category: 'Misc',
  desc: 'Generate a random password',
  usage: ']pwgen [length]',
  run: async (msg, args) => {
    const len = Math.max(4, Math.min(128, parseInt(args[0], 10) || 20));
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
    let pw = '';
    for (let i = 0; i < len; i++) pw += charset[Math.floor(Math.random() * charset.length)];
    msg.author.send(`🔑 \`${pw}\``).then(() => ok(msg, '🔑 sent to your DMs.')).catch(() => ok(msg, `🔑 (couldn't DM, posting here)\n\`${pw}\``));
  },
});

// ========== DISCORD UTILS ==========

alias(['snowflake', 'sf'], {
  category: 'Discord',
  desc: 'Decode a Discord snowflake ID',
  usage: ']snowflake <id>',
  run: async (msg, args) => {
    const id = args[0];
    if (!/^\d{15,22}$/.test(id || '')) return bad(msg, 'give a valid ID.');
    const ts = Number(BigInt(id) >> 22n) + 1420070400000;
    ok(msg, `🆔 \`${id}\` → <t:${Math.floor(ts / 1000)}:F> (<t:${Math.floor(ts / 1000)}:R>)`);
  },
});

alias(['timestamp', 'ts'], {
  category: 'Discord',
  desc: 'Discord timestamp helpers',
  usage: ']timestamp now  |  ]timestamp 2025-12-25',
  run: async (msg, args) => {
    const input = args.join(' ') || 'now';
    const date = input.toLowerCase() === 'now' ? new Date() : new Date(input);
    if (isNaN(date)) return bad(msg, 'invalid date — try `2025-12-25` or `now`.');
    const t = Math.floor(date.getTime() / 1000);
    ok(msg, [
      `\`<t:${t}>\` → <t:${t}>`,
      `\`<t:${t}:F>\` → <t:${t}:F>`,
      `\`<t:${t}:R>\` → <t:${t}:R>`,
      `\`<t:${t}:D>\` → <t:${t}:D>`,
    ].join('\n'));
  },
});

alias(['enlarge', 'bigemoji', 'jumbo'], {
  category: 'Discord',
  desc: 'Enlarge a custom emoji',
  usage: ']enlarge :emoji:',
  run: async (msg, args) => {
    const m = args.join(' ').match(/<(a?):\w+:(\d+)>/);
    if (!m) return bad(msg, 'give me a custom emoji.');
    const ext = m[1] ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/emojis/${m[2]}.${ext}?size=512`;
    msg.reply({ embeds: [new EmbedBuilder().setImage(url).setColor(PINK)] }).catch(() => {});
  },
});

alias(['announce'], {
  category: 'Utility',
  desc: 'Announcement embed with @everyone',
  usage: ']announce <message>',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.MentionEveryone, 'Mention Everyone')) return;
    const text = args.join(' ');
    if (!text) return bad(msg, 'what\'s the announcement?');
    await msg.delete().catch(() => {});
    const embed = new EmbedBuilder().setTitle('📢 Announcement').setDescription(text).setColor(PINK).setFooter({ text: `by ${msg.author.tag}` });
    msg.channel.send({ content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } }).catch(() => {});
  },
});

alias(['steal'], {
  category: 'Utility',
  desc: 'Steal a custom emoji into this server',
  usage: ']steal :emoji: [new_name]',
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageGuildExpressions, 'Manage Expressions')) return;
    const m = args[0]?.match(/<(a?):(\w+):(\d+)>/);
    if (!m) return bad(msg, 'give me a custom emoji.');
    const ext = m[1] ? 'gif' : 'png';
    const name = args[1] || m[2];
    try {
      const emoji = await msg.guild.emojis.create({ attachment: `https://cdn.discordapp.com/emojis/${m[3]}.${ext}`, name });
      ok(msg, `✨ stolen as ${emoji.toString()} \`:${emoji.name}:\``);
    } catch (e) { bad(msg, `steal failed: \`${e.code ?? e.message}\``); }
  },
});

alias(['length', 'len'], {
  category: 'Text',
  desc: 'Count characters and words',
  usage: ']length <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'text?');
    const chars = text.length;
    const words = text.trim().split(/\s+/).length;
    ok(msg, `📏 **${chars}** chars • **${words}** words`);
  },
});

alias(['spoiler'], {
  category: 'Text',
  desc: 'Spoiler-tag text',
  usage: ']spoiler <text>',
  run: async (msg, args) => {
    const text = args.join(' ');
    if (!text) return bad(msg, 'text?');
    await msg.delete().catch(() => {});
    msg.channel.send(`||${text}||`).catch(() => {});
  },
});

alias(['shorten'], {
  category: 'Misc',
  desc: 'Shorten a URL (via is.gd)',
  usage: ']shorten <url>',
  run: async (msg, args) => {
    const url = args[0];
    if (!/^https?:\/\//.test(url || '')) return bad(msg, 'give a full URL.');
    try {
      const r = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`);
      const short = await r.text();
      if (!short.startsWith('http')) return bad(msg, `failed: ${short}`);
      ok(msg, `🔗 ${short}`);
    } catch { bad(msg, 'shortener down.'); }
  },
});

// ========== RECON & OSINT ==========

alias(['iplookup', 'ip'], {
  category: 'Recon',
  desc: 'Geolocate an IP address',
  usage: ']iplookup <ip>',
  run: async (msg, args) => {
    const ip = args[0];
    if (!ip || !/^[\d.a-f:]+$/i.test(ip)) return bad(msg, 'give me a valid IP.');
    try {
      const j = await fetchJSON(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting`);
      if (j.status !== 'success') return bad(msg, `lookup failed: ${j.message}`);
      const embed = new EmbedBuilder()
        .setTitle(`🌍 ${j.query}`)
        .setColor(PINK)
        .addFields(
          { name: 'Country', value: j.country || '?', inline: true },
          { name: 'Region', value: j.regionName || '?', inline: true },
          { name: 'City', value: j.city || '?', inline: true },
          { name: 'ZIP', value: j.zip || '?', inline: true },
          { name: 'Timezone', value: j.timezone || '?', inline: true },
          { name: 'Coords', value: `${j.lat}, ${j.lon}`, inline: true },
          { name: 'ISP', value: j.isp || '?', inline: true },
          { name: 'Org', value: j.org || '?', inline: true },
          { name: 'ASN', value: j.as || '?', inline: true },
          { name: 'Proxy/VPN', value: j.proxy ? 'yes' : 'no', inline: true },
          { name: 'Hosting', value: j.hosting ? 'yes' : 'no', inline: true },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `lookup failed: \`${e.message}\``); }
  },
});

alias(['dns'], {
  category: 'Recon',
  desc: 'DNS records for a domain',
  usage: ']dns <domain> [A|AAAA|MX|TXT|NS|CNAME]',
  run: async (msg, args) => {
    const domain = args[0];
    const type = (args[1] || 'A').toUpperCase();
    if (!domain) return bad(msg, 'give a domain, like `]dns google.com`.');
    try {
      const j = await fetchJSON(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`);
      const records = j.Answer || [];
      if (!records.length) return bad(msg, `no ${type} records for **${domain}**.`);
      const lines = records.slice(0, 20).map(r => `\`${r.data}\` (TTL ${r.TTL})`);
      const embed = new EmbedBuilder()
        .setTitle(`🌐 ${type} records — ${domain}`)
        .setColor(PINK)
        .setDescription(lines.join('\n').slice(0, 4000));
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `dns query failed: \`${e.message}\``); }
  },
});

alias(['subbrute', 'subs', 'subdomains'], {
  category: 'Recon',
  desc: 'Find subdomains via certificate transparency (crt.sh)',
  usage: ']subbrute <domain>',
  run: async (msg, args) => {
    const domain = args[0];
    if (!domain) return bad(msg, 'give a root domain.');
    const working = await msg.reply(`🔍 digging through crt.sh for **${domain}**...`).catch(() => null);
    try {
      const j = await fetchJSON(`https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`);
      const set = new Set();
      for (const row of j) {
        const names = (row.name_value || '').split(/\n/);
        for (const n of names) {
          const clean = n.trim().toLowerCase();
          if (clean && !clean.startsWith('*') && clean.endsWith(domain)) set.add(clean);
        }
      }
      const subs = [...set].sort();
      if (!subs.length) return working?.edit(`💀 no subdomains found for **${domain}**.`);
      const list = subs.join('\n');
      const header = `🎯 **${subs.length}** subdomains for **${domain}**`;
      if (list.length < 1800) {
        await working?.edit(`${header}\n\`\`\`\n${list}\n\`\`\``);
      } else {
        await working?.edit({
          content: header,
          files: [{ attachment: Buffer.from(list, 'utf8'), name: `${domain}-subs.txt` }],
        });
      }
    } catch (e) { working?.edit(`💀 subbrute failed: \`${e.message}\``); }
  },
});

alias(['whois'], {
  category: 'Recon',
  desc: 'Basic WHOIS-style info (via dns + rdap)',
  usage: ']whois <domain>',
  run: async (msg, args) => {
    const domain = args[0];
    if (!domain) return bad(msg, 'give a domain.');
    try {
      const j = await fetchJSON(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
      const events = (j.events || []).map(e => `${e.eventAction}: ${e.eventDate?.slice(0, 10)}`).join('\n') || '?';
      const ns = (j.nameservers || []).map(n => n.ldhName).join('\n') || '?';
      const status = (j.status || []).join(', ') || '?';
      const embed = new EmbedBuilder()
        .setTitle(`🔎 whois — ${domain}`)
        .setColor(PINK)
        .addFields(
          { name: 'Events', value: events.slice(0, 1024), inline: false },
          { name: 'Nameservers', value: ns.slice(0, 1024), inline: false },
          { name: 'Status', value: status.slice(0, 1024), inline: false },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `whois failed: \`${e.message}\``); }
  },
});

alias(['reverseip', 'rip'], {
  category: 'Recon',
  desc: 'Reverse DNS lookup',
  usage: ']reverseip <ip>',
  run: async (msg, args) => {
    const ip = args[0];
    if (!ip) return bad(msg, 'give an IP.');
    try {
      // Build reverse DNS name
      const parts = ip.split('.');
      const reverseName = parts.length === 4 ? `${parts.reverse().join('.')}.in-addr.arpa` : ip;
      const j = await fetchJSON(`https://dns.google/resolve?name=${encodeURIComponent(reverseName)}&type=PTR`);
      const ptr = j.Answer?.[0]?.data;
      if (!ptr) return bad(msg, 'no PTR record.');
      ok(msg, `🔄 ${ip} → \`${ptr}\``);
    } catch (e) { bad(msg, `reverse lookup failed: \`${e.message}\``); }
  },
});

// ========== GIVEROLE / TAKEROLE SHORTCUTS ==========

const roleShortcut = (names, sub, verb) => alias(names, {
  category: 'Roles',
  desc: `${verb} a role ${sub === 'add' ? 'to' : 'from'} a member`,
  usage: `]${names[0]} @user @role`,
  run: async (msg, args) => {
    if (!needPerm(msg, PermissionFlagsBits.ManageRoles, 'Manage Roles')) return;
    const found = await resolveMemberGreedy(msg, args);
    if (!found) return notFound(msg);
    const role = resolveRole(msg, args[found.consumed]);
    if (!role) return bad(msg, 'role not found.');
    try {
      if (sub === 'add') await found.member.roles.add(role);
      else await found.member.roles.remove(role);
      ok(msg, `${sub === 'add' ? '✅ gave' : '❌ took'} **${role.name}** ${sub === 'add' ? 'to' : 'from'} **${found.member.user.tag}**.`);
    } catch (e) { bad(msg, `failed: \`${e.code ?? e.message}\``); }
  },
});

roleShortcut(['giverole', 'gr'], 'add', 'Give');
roleShortcut(['takerole', 'tr'], 'remove', 'Take');

// ========== IMAGE DESCRIBE (vision captioning) ==========

alias(['describe', 'caption', 'vision'], {
  category: 'OCR',
  desc: 'Describe an image (Groq Llama vision if GROQ_KEY set, else Pollinations)',
  usage: ']describe [prompt]  (with image attached, reply, or URL)',
  run: async (msg, args) => {
    const url = await findImage(msg, args);
    if (!url) return bad(msg, 'attach an image, reply to one, or paste a URL.');
    const prompt = args.filter(a => !/^https?:\/\//i.test(a)).join(' ') || 'Describe this image in one detailed sentence.';
    const working = await msg.reply('👀 looking...').catch(() => null);
    try {
      const imgRes = await fetch(url);
      if (!imgRes.ok) throw new Error(`image fetch failed ${imgRes.status}`);
      const mime = imgRes.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

      const payload = (model) => JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 500,
      });

      let caption;
      const errors = [];

      // OpenRouter — free tier with multiple vision models
      if (process.env.OPENROUTER_KEY) {
        const orModels = [
          'google/gemini-2.0-flash-exp:free',
          'meta-llama/llama-3.2-11b-vision-instruct:free',
          'qwen/qwen2.5-vl-72b-instruct:free',
          'mistralai/mistral-small-3.2-24b-instruct:free',
        ];
        for (const m of orModels) {
          try {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENROUTER_KEY}`,
                'HTTP-Referer': 'https://github.com/kitty-bot',
                'X-Title': 'kitty-bot',
              },
              body: payload(m),
            });
            if (r.ok) {
              const j = await r.json();
              caption = j.choices?.[0]?.message?.content?.trim();
              if (caption) break;
              errors.push(`or ${m}: empty`);
            } else {
              errors.push(`or ${m}: ${r.status} ${(await r.text()).slice(0, 120)}`);
            }
          } catch (e) { errors.push(`or ${m}: ${e.message}`); }
        }
      }

      // Groq fallback if key available
      if (!caption && process.env.GROQ_KEY) {
        try {
          const list = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${process.env.GROQ_KEY}` },
          });
          if (list.ok) {
            const data = await list.json();
            const visionModels = (data.data || [])
              .map(x => x.id)
              .filter(id => /vision|scout|maverick|llava|vl/i.test(id));
            for (const m of visionModels) {
              const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_KEY}` },
                body: payload(m),
              });
              if (r.ok) {
                const j = await r.json();
                caption = j.choices?.[0]?.message?.content?.trim();
                if (caption) break;
              } else {
                errors.push(`groq ${m}: ${r.status}`);
              }
            }
          }
        } catch (e) { errors.push(`groq list: ${e.message}`); }
      }

      if (!caption && !process.env.OPENROUTER_KEY && !process.env.GROQ_KEY) {
        errors.push('no OPENROUTER_KEY or GROQ_KEY in .env');
      }

      // Fallback: Pollinations (rate-limited, shared IP)
      if (!caption) {
        const models = ['openai', 'gemini', 'claude-hybridspace'];
        for (const m of models) {
          let r = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload(m),
          });
          if (r.status === 402) {
            const txt = await r.text();
            const match = txt.match(/Retry after (\d+)s/i);
            const wait = Math.min(60, (parseInt(match?.[1], 10) || 10)) * 1000;
            await working?.edit(`⏳ rate-limited, waiting ${wait / 1000}s...`);
            await new Promise(res => setTimeout(res, wait + 500));
            r = await fetch('https://text.pollinations.ai/openai', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: payload(m),
            });
          }
          if (r.ok) {
            const j = await r.json();
            caption = j.choices?.[0]?.message?.content?.trim();
            if (caption) break;
            errors.push(`pollinations ${m}: empty response`);
          } else {
            errors.push(`pollinations ${m}: ${r.status}`);
          }
        }
      }

      if (!caption) {
        console.error('describe failed, backend errors:', errors);
        throw new Error(`all backends failed. first: ${errors[0] ?? 'unknown'}`);
      }
      await working?.edit(`🖼️ ${caption.slice(0, 1900)}`);
    } catch (e) {
      console.error(e);
      working?.edit(`💀 describe failed: \`${e.message}\``);
    }
  },
});

// ========== WEBSITE / DOMAIN TOOLS ==========

const normalizeUrl = (raw) => {
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try { return new URL(raw).toString(); } catch { return null; }
};

alias(['whoowns', 'siteowner'], {
  category: 'Recon',
  desc: 'Who owns a website (RDAP + registrar info)',
  usage: ']whoowns <domain>',
  run: async (msg, args) => {
    const raw = args[0];
    if (!raw) return bad(msg, 'give a domain.');
    const domain = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    try {
      const j = await fetchJSON(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
      const events = (j.events || []).reduce((acc, e) => {
        acc[e.eventAction] = e.eventDate?.slice(0, 10);
        return acc;
      }, {});
      const entities = (j.entities || []).map(ent => {
        const roles = ent.roles?.join(', ') || '?';
        const name = ent.vcardArray?.[1]?.find(f => f[0] === 'fn')?.[3] || ent.handle || '?';
        return `• **${roles}** — ${name}`;
      }).join('\n').slice(0, 1024) || '*(none disclosed)*';
      const ns = (j.nameservers || []).map(n => n.ldhName).join('\n').slice(0, 1024) || '?';
      const embed = new EmbedBuilder()
        .setTitle(`🔎 ${j.ldhName || domain}`)
        .setColor(PINK)
        .addFields(
          { name: 'Registered', value: events.registration || '?', inline: true },
          { name: 'Expires', value: events.expiration || '?', inline: true },
          { name: 'Last changed', value: events['last changed'] || events['last update of RDAP database'] || '?', inline: true },
          { name: 'Owners / Entities', value: entities, inline: false },
          { name: 'Nameservers', value: ns, inline: false },
          { name: 'Status', value: (j.status || []).join(', ').slice(0, 512) || '?', inline: false },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      bad(msg, `whoowns failed — most domains hide owner info behind privacy. \`${e.message}\``);
    }
  },
});

alias(['headers'], {
  category: 'Recon',
  desc: 'HTTP response headers',
  usage: ']headers <url>',
  run: async (msg, args) => {
    const url = normalizeUrl(args[0]);
    if (!url) return bad(msg, 'give a URL.');
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const lines = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`📡 ${r.status} — ${url}`)
        .setColor(PINK)
        .setDescription('```\n' + lines.slice(0, 3900) + '\n```');
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `fetch failed: \`${e.message}\``); }
  },
});

alias(['status', 'http'], {
  category: 'Recon',
  desc: 'Is a site up? Status + latency.',
  usage: ']status <url>',
  run: async (msg, args) => {
    const url = normalizeUrl(args[0]);
    if (!url) return bad(msg, 'give a URL.');
    const start = Date.now();
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const ms = Date.now() - start;
      const emoji = r.ok ? '✅' : (r.status < 500 ? '⚠️' : '💀');
      ok(msg, `${emoji} **${r.status}** ${r.statusText} — ${ms}ms — \`${r.url}\``);
    } catch (e) {
      ok(msg, `💀 down — \`${e.message}\``);
    }
  },
});

alias(['screenshot', 'ss'], {
  category: 'Recon',
  desc: 'Screenshot a website',
  usage: ']screenshot <url>',
  run: async (msg, args) => {
    const url = normalizeUrl(args[0]);
    if (!url) return bad(msg, 'give a URL.');
    const working = await msg.reply('📸 snapping...').catch(() => null);
    const shot = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;
    working?.edit({
      content: `📸 ${url}`,
      embeds: [new EmbedBuilder().setImage(shot).setColor(PINK)],
    });
  },
});

alias(['ssl', 'cert'], {
  category: 'Recon',
  desc: 'SSL certificate info for a domain',
  usage: ']ssl <domain>',
  run: async (msg, args) => {
    const domain = args[0]?.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!domain) return bad(msg, 'give a domain.');
    try {
      const j = await fetchJSON(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`);
      if (!j.length) return bad(msg, 'no certs found.');
      const latest = j.sort((a, b) => new Date(b.not_before) - new Date(a.not_before))[0];
      const embed = new EmbedBuilder()
        .setTitle(`🔒 ${domain}`)
        .setColor(PINK)
        .addFields(
          { name: 'Issuer', value: latest.issuer_name?.slice(0, 1024) || '?', inline: false },
          { name: 'Valid from', value: latest.not_before?.slice(0, 10) || '?', inline: true },
          { name: 'Valid until', value: latest.not_after?.slice(0, 10) || '?', inline: true },
          { name: 'Serial', value: `\`${latest.serial_number?.slice(0, 40) || '?'}\``, inline: false },
          { name: 'Covers', value: (latest.name_value || '').split('\n').slice(0, 10).join('\n').slice(0, 1024) || '?' },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `ssl lookup failed: \`${e.message}\``); }
  },
});

alias(['tech', 'stack'], {
  category: 'Recon',
  desc: 'Detect server tech via response headers',
  usage: ']tech <url>',
  run: async (msg, args) => {
    const url = normalizeUrl(args[0]);
    if (!url) return bad(msg, 'give a URL.');
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const h = Object.fromEntries(r.headers);
      const body = (await r.text()).slice(0, 50_000);
      const hints = [];
      const sig = (label, pattern) => { if (pattern.test(body) || pattern.test(JSON.stringify(h))) hints.push(label); };
      sig('Cloudflare', /cloudflare/i);
      sig('nginx', /nginx/i);
      sig('Apache', /apache/i);
      sig('WordPress', /wp-(content|includes|json)/i);
      sig('React', /_next|react(-dom)?|__NEXT_DATA__/i);
      sig('Next.js', /__NEXT_DATA__|next\.js/i);
      sig('Vue', /vue(?:\.js)?|__VUE/i);
      sig('Angular', /ng-version|angular/i);
      sig('Shopify', /cdn\.shopify|shopify/i);
      sig('Wix', /wix\.com|wixstatic/i);
      sig('Squarespace', /squarespace/i);
      sig('Cloudflare Workers', /cf-ray/i);
      sig('Vercel', /vercel/i);
      sig('Netlify', /netlify/i);
      sig('PHP', /\bphp\b/i);
      sig('Express', /x-powered-by.*express/i);
      sig('Google Analytics', /google-analytics|gtag|UA-\d{4,}/i);
      const embed = new EmbedBuilder()
        .setTitle(`🧪 ${url}`)
        .setColor(PINK)
        .addFields(
          { name: 'Server', value: h.server || '?', inline: true },
          { name: 'Powered by', value: h['x-powered-by'] || '?', inline: true },
          { name: 'CDN', value: h['cf-ray'] ? 'Cloudflare' : h['x-vercel-id'] ? 'Vercel' : h['x-nf-request-id'] ? 'Netlify' : '?', inline: true },
          { name: 'Detected', value: hints.length ? hints.join(', ') : 'nothing obvious', inline: false },
        );
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `tech probe failed: \`${e.message}\``); }
  },
});

alias(['siteinfo'], {
  category: 'Recon',
  desc: 'Metadata about a site (title, description, favicon)',
  usage: ']siteinfo <url>',
  run: async (msg, args) => {
    const url = normalizeUrl(args[0]);
    if (!url) return bad(msg, 'give a URL.');
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const body = (await r.text()).slice(0, 100_000);
      const pick = (re) => body.match(re)?.[1]?.trim();
      const title = pick(/<title[^>]*>([^<]+)<\/title>/i) || '?';
      const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)
                || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
                || '?';
      const ogImg = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
      const embed = new EmbedBuilder()
        .setTitle(title.slice(0, 256))
        .setURL(r.url)
        .setDescription(desc.slice(0, 1800))
        .setColor(PINK)
        .setFooter({ text: new URL(r.url).hostname });
      if (ogImg) embed.setImage(ogImg.startsWith('http') ? ogImg : new URL(ogImg, r.url).toString());
      msg.reply({ embeds: [embed] }).catch(() => {});
    } catch (e) { bad(msg, `siteinfo failed: \`${e.message}\``); }
  },
});

// ========== MUSIC / VOICE ==========

const players = new Map(); // guildId -> { connection, player, queue, loop, volume, textChannel }

const getPlayer = (guildId) => players.get(guildId);

const destroyPlayer = (guildId) => {
  const p = players.get(guildId);
  if (!p) return;
  try { p.player.stop(); } catch {}
  try {
    if (p.connection.state.status !== VoiceConnectionStatus.Destroyed) p.connection.destroy();
  } catch {}
  players.delete(guildId);
};

const playNext = async (guildId) => {
  const state = players.get(guildId);
  if (!state) return;
  const track = state.queue[0];
  if (!track) {
    state.textChannel?.send('🎵 queue empty — leaving.').catch(() => {});
    destroyPlayer(guildId);
    return;
  }
  try {
    let resource;
    if (track.isFile) {
      // Direct file URL (mp3/wav/etc from attachment or direct link)
      resource = createAudioResource(track.url, { inlineVolume: true, inputType: StreamType.Arbitrary });
    } else {
      const stream = await play.stream(track.url, { quality: 2 });
      resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
    }
    resource.volume?.setVolume(state.volume);
    state.player.play(resource);
    state.current = track;
    state.textChannel?.send(`🎶 now playing: **${track.title}** — ${track.duration}`).catch(() => {});
  } catch (e) {
    console.error(e);
    state.textChannel?.send(`💀 couldn't play **${track.title}** — \`${e.message}\``).catch(() => {});
    state.queue.shift();
    playNext(guildId);
  }
};

const ensureVoice = async (msg) => {
  const vc = msg.member?.voice?.channel;
  if (!vc) { bad(msg, 'join a voice channel first, hun.'); return null; }
  const perms = vc.permissionsFor(msg.guild.members.me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    bad(msg, 'i need **Connect** and **Speak** perms in that voice channel.');
    return null;
  }

  let state = players.get(msg.guild.id);
  if (state && state.connection.joinConfig.channelId === vc.id) return state;

  if (state) destroyPlayer(msg.guild.id);

  const connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: msg.guild.id,
    adapterCreator: msg.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('error', e => console.error('voice conn error:', e));
  connection.on('stateChange', (o, n) => {
    if (n.status !== o.status) console.log(`voice: ${o.status} → ${n.status}`);
  });

  // Handle disconnect: try to reconnect once, else destroy
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyPlayer(msg.guild.id);
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (e) {
    console.error('voice connect failed:', e?.message);
    try {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    } catch {}
    bad(msg, `couldn't connect to voice — \`${e?.message ?? 'timeout'}\`\n\nIf this is Windows, check firewall: Node.js may need outbound UDP allowed (Discord voice uses UDP).`);
    return null;
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  state = { connection, player, queue: [], loop: false, volume: 0.5, textChannel: msg.channel, current: null };
  players.set(msg.guild.id, state);

  player.on(AudioPlayerStatus.Idle, () => {
    const s = players.get(msg.guild.id);
    if (!s) return;
    if (s.loop && s.current) s.queue.push(s.current);
    s.queue.shift();
    playNext(msg.guild.id);
  });

  player.on('error', (err) => {
    console.error('player error:', err);
    state.textChannel?.send(`💀 player error: \`${err.message}\``).catch(() => {});
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => destroyPlayer(msg.guild.id));

  return state;
};

const fmtDur = (sec) => {
  if (!sec || sec === Infinity) return 'live';
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Resolve a Spotify track URL to "Artist - Title" via oembed (no auth needed)
const spotifyOembed = async (url) => {
  const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error('spotify oembed failed');
  const j = await r.json();
  return j.title; // "Artist - Title"
};

// Parse "track" | "playlist" | "album" and the id from a Spotify URL
const parseSpotifyUrl = (url) => {
  const m = url.match(/open\.spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
  return m ? { kind: m[1], id: m[2] } : null;
};

// Scrape track list from Spotify's public embed page (no auth)
const spotifyScrape = async (kind, id) => {
  const url = `https://open.spotify.com/embed/${kind}/${id}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`spotify embed ${r.status}`);
  const html = await r.text();

  // Embed page ships hydration data inside a <script id="__NEXT_DATA__"> tag
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('could not read embed data');
  let data;
  try { data = JSON.parse(m[1]); } catch { throw new Error('embed json parse failed'); }

  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('entity missing in embed data');

  const extractArtists = (artists) => (artists || []).map(a => a.name).filter(Boolean).join(' ');

  if (kind === 'track') {
    return [{ name: entity.title || entity.name, artists: extractArtists(entity.artists || entity.subtitle_artists) || entity.subtitle }];
  }
  // playlist / album
  const items = entity.trackList || entity.tracks?.items || [];
  const tracks = items.map(t => {
    const name = t.title || t.name || t.track?.name;
    const artists = extractArtists(t.artists) || t.subtitle || extractArtists(t.track?.artists);
    return name ? { name, artists } : null;
  }).filter(Boolean);
  if (!tracks.length) throw new Error('no tracks in embed');
  return tracks;
};

// Search YouTube for a track and return a queue entry
const ytSearchTrack = async (query, requestedBy) => {
  const results = await play.search(query, { source: { youtube: 'video' }, limit: 1 });
  if (!results[0]) throw new Error(`nothing on youtube for: ${query}`);
  const r = results[0];
  return {
    url: r.url,
    title: r.title || query,
    duration: fmtDur(r.durationInSec),
    thumb: r.thumbnails?.[0]?.url,
    requestedBy,
  };
};

alias(['play', 'p'], {
  category: 'Music',
  desc: 'Play from YouTube, Spotify, SoundCloud, mp3 attachment, or search',
  usage: ']play <url, playlist, search> OR attach an mp3/audio file',
  run: async (msg, args) => {
    const query = args.join(' ').trim();

    // Check for audio attachment first (mp3/wav/ogg/m4a/flac/webm/opus)
    const audioAtt = msg.attachments.find(a => {
      const ct = (a.contentType || '').toLowerCase();
      const name = (a.name || '').toLowerCase();
      return ct.startsWith('audio/') || ct === 'video/mp4' || /\.(mp3|wav|ogg|m4a|flac|webm|opus|aac)$/.test(name);
    });

    if (!query && !audioAtt) return bad(msg, 'give me a url, search terms, or attach an audio file.');

    const state = await ensureVoice(msg);
    if (!state) return;

    const working = await msg.reply('🔍 searching...').catch(() => null);
    try {
      const added = [];

      // ---- Audio attachment ----
      if (audioAtt) {
        added.push({
          url: audioAtt.url,
          title: audioAtt.name || 'audio file',
          duration: 'file',
          thumb: null,
          requestedBy: msg.author.tag,
          isFile: true,
        });
      }
      else

      if (false) {} // keep the chain structure
      // ---- Spotify (no auth needed — scrapes public embed pages) ----
      else if (parseSpotifyUrl(query)) {
        const sp = parseSpotifyUrl(query);
        const tracks = await spotifyScrape(sp.kind, sp.id);
        if (sp.kind === 'track') {
          const t = tracks[0];
          added.push(await ytSearchTrack(`${t.name} ${t.artists}`, msg.author.tag));
        } else {
          working?.edit(`🎵 found **${tracks.length}** tracks on spotify, queuing...`);
          const first = tracks.shift();
          added.push(await ytSearchTrack(`${first.name} ${first.artists}`, msg.author.tag));
          // Fire-and-forget the rest so playback starts immediately
          (async () => {
            let done = 0, failed = 0;
            for (const t of tracks) {
              try {
                const track = await ytSearchTrack(`${t.name} ${t.artists}`, msg.author.tag);
                state.queue.push(track);
                done++;
              } catch { failed++; }
            }
            state.textChannel?.send(`✅ queued **${done + 1}** tracks from spotify${failed ? ` (${failed} couldn't be matched)` : ''}.`).catch(() => {});
          })();
        }
      }
      // ---- YouTube playlist ----
      else if (query && play.yt_validate(query) === 'playlist') {
        const pl = await play.playlist_info(query, { incomplete: true });
        const vids = await pl.all_videos();
        working?.edit(`🎵 queuing **${vids.length}** youtube videos...`);
        for (const v of vids) {
          added.push({
            url: v.url,
            title: v.title || 'unknown',
            duration: fmtDur(v.durationInSec),
            thumb: v.thumbnails?.[0]?.url,
            requestedBy: msg.author.tag,
          });
        }
      }
      // ---- YouTube video ----
      else if (query && play.yt_validate(query) === 'video') {
        const info = (await play.video_info(query)).video_details;
        added.push({
          url: query,
          title: info.title || 'unknown',
          duration: fmtDur(info.durationInSec),
          thumb: info.thumbnails?.[0]?.url,
          requestedBy: msg.author.tag,
        });
      }
      // ---- SoundCloud ----
      else if (query && play.so_validate(query) === 'track') {
        const info = await play.soundcloud(query);
        added.push({
          url: query,
          title: info.name || 'unknown',
          duration: fmtDur(info.durationInSec),
          thumb: info.thumbnail,
          requestedBy: msg.author.tag,
        });
      }
      // ---- Search ----
      else if (query) {
        added.push(await ytSearchTrack(query, msg.author.tag));
      }

      for (const t of added) state.queue.push(t);

      if (state.player.state.status !== AudioPlayerStatus.Playing && state.queue.length) {
        const first = state.queue[0];
        playNext(msg.guild.id);
        working?.edit(added.length === 1
          ? `▶️ playing **${first.title}**`
          : `▶️ playing **${first.title}** • queued **${added.length - 1}** more`);
      } else {
        working?.edit(added.length === 1
          ? `✅ queued **${added[0].title}** (position ${state.queue.length - 1})`
          : `✅ queued **${added.length}** tracks`);
      }
    } catch (e) {
      console.error(e);
      working?.edit(`💀 play failed: \`${e.message}\``);
    }
  },
});

alias(['skip', 's', 'next'], {
  category: 'Music',
  desc: 'Skip current song',
  usage: ']skip',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing playing.');
    state.player.stop();
    ok(msg, '⏭️ skipped.');
  },
});

alias(['stop'], {
  category: 'Music',
  desc: 'Stop playback and clear queue',
  usage: ']stop',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing playing.');
    state.queue = [];
    state.player.stop();
    destroyPlayer(msg.guild.id);
    ok(msg, '⏹️ stopped and left.');
  },
});

alias(['pause'], {
  category: 'Music',
  desc: 'Pause playback',
  usage: ']pause',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing playing.');
    state.player.pause();
    ok(msg, '⏸️ paused.');
  },
});

alias(['resume', 'unpause'], {
  category: 'Music',
  desc: 'Resume playback',
  usage: ']resume',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing to resume.');
    state.player.unpause();
    ok(msg, '▶️ resumed.');
  },
});

alias(['queue', 'q'], {
  category: 'Music',
  desc: 'Show the queue',
  usage: ']queue',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state || !state.queue.length) return bad(msg, 'queue empty.');
    const lines = state.queue.slice(0, 15).map((t, i) =>
      `${i === 0 ? '🎵' : `**${i}.**`} ${t.title} — \`${t.duration}\` • by ${t.requestedBy}`);
    const extra = state.queue.length > 15 ? `\n*…and ${state.queue.length - 15} more*` : '';
    const embed = new EmbedBuilder()
      .setTitle('📋 queue')
      .setDescription(lines.join('\n') + extra)
      .setColor(PINK)
      .setFooter({ text: `loop: ${state.loop ? 'on' : 'off'} • volume: ${Math.round(state.volume * 100)}%` });
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['nowplaying', 'np'], {
  category: 'Music',
  desc: 'Show current song',
  usage: ']nowplaying',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state?.current) return bad(msg, 'nothing playing.');
    const t = state.current;
    const embed = new EmbedBuilder()
      .setTitle('🎶 now playing')
      .setDescription(`**${t.title}** — \`${t.duration}\`\n[source](${t.url})`)
      .setColor(PINK)
      .setFooter({ text: `requested by ${t.requestedBy}` });
    if (t.thumb) embed.setThumbnail(t.thumb);
    msg.reply({ embeds: [embed] }).catch(() => {});
  },
});

alias(['volume', 'vol'], {
  category: 'Music',
  desc: 'Set volume (0-200)',
  usage: ']volume <0-200>',
  run: async (msg, args) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing playing.');
    const v = parseInt(args[0], 10);
    if (!Number.isFinite(v) || v < 0 || v > 200) return bad(msg, '0–200, hun.');
    state.volume = v / 100;
    state.player.state.resource?.volume?.setVolume(state.volume);
    ok(msg, `🔊 volume: ${v}%`);
  },
});

alias(['loop'], {
  category: 'Music',
  desc: 'Toggle queue loop',
  usage: ']loop',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing playing.');
    state.loop = !state.loop;
    ok(msg, `🔁 loop ${state.loop ? 'on' : 'off'}.`);
  },
});

alias(['shuffle'], {
  category: 'Music',
  desc: 'Shuffle the queue',
  usage: ']shuffle',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state || state.queue.length < 3) return bad(msg, 'need at least 2 songs queued.');
    // Keep current song at index 0, shuffle the rest
    const [head, ...rest] = state.queue;
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.queue = [head, ...rest];
    ok(msg, '🔀 shuffled.');
  },
});

alias(['remove', 'rm'], {
  category: 'Music',
  desc: 'Remove a song from the queue (by position)',
  usage: ']remove <position>',
  run: async (msg, args) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing queued.');
    const pos = parseInt(args[0], 10);
    if (!Number.isFinite(pos) || pos < 1 || pos >= state.queue.length) return bad(msg, 'bad position.');
    const [removed] = state.queue.splice(pos, 1);
    ok(msg, `🗑️ removed **${removed.title}**.`);
  },
});

alias(['clearqueue', 'cq'], {
  category: 'Music',
  desc: 'Clear the queue (keeps current song)',
  usage: ']clearqueue',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state) return bad(msg, 'nothing queued.');
    state.queue = state.current ? [state.current] : [];
    ok(msg, '🧹 queue cleared.');
  },
});

alias(['join'], {
  category: 'Music',
  desc: 'Join your voice channel',
  usage: ']join',
  run: async (msg) => {
    const state = await ensureVoice(msg);
    if (state) ok(msg, `👋 joined <#${state.connection.joinConfig.channelId}>.`);
  },
});

alias(['leave', 'disconnect', 'dc'], {
  category: 'Music',
  desc: 'Leave the voice channel',
  usage: ']leave',
  run: async (msg) => {
    const existing = getVoiceConnection(msg.guild.id);
    if (!existing) return bad(msg, "i'm not in voice.");
    destroyPlayer(msg.guild.id);
    ok(msg, '👋 left voice.');
  },
});

alias(['seek'], {
  category: 'Music',
  desc: 'Restart current song (full seek requires rebuffer)',
  usage: ']seek',
  run: async (msg) => {
    const state = getPlayer(msg.guild.id);
    if (!state?.current) return bad(msg, 'nothing playing.');
    state.queue.unshift(state.current);
    state.player.stop();
    ok(msg, '⏮️ restarting song.');
  },
});

// ---------- dispatcher + listeners ----------

// ---------- Slash command registration ----------
const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play music from YouTube, Spotify, SoundCloud, or an uploaded audio file')
    .addStringOption(o => o.setName('query').setDescription('URL or search terms (YouTube / Spotify / SoundCloud)').setRequired(false))
    .addAttachmentOption(o => o.setName('file').setDescription('Audio file (mp3, wav, m4a, etc)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song').toJSON(),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and leave').toJSON(),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback').toJSON(),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback').toJSON(),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue').toJSON(),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song').toJSON(),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel').toJSON(),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle queue loop').toJSON(),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue').toJSON(),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set volume (0-200)')
    .addIntegerOption(o => o.setName('level').setDescription('0 to 200').setMinValue(0).setMaxValue(200).setRequired(true))
    .toJSON(),
];

client.once(Events.ClientReady, async c => {
  console.log(`Ready as ${c.user.tag} — prefix "${PREFIX}" — ${meta.length} commands`);
  c.user.setActivity(`${PREFIX}help or /play`, { type: 3 });
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, process.env.GUILD_ID), { body: slashCommands });
      console.log(`Registered ${slashCommands.length} slash commands to guild ${process.env.GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(c.user.id), { body: slashCommands });
      console.log(`Registered ${slashCommands.length} slash commands globally (may take up to 1 hour to appear).`);
    }
  } catch (e) { console.error('Slash register failed:', e); }
});

// ---------- Slash command → prefix command shim ----------
const slashToPrefix = {
  skip: ['skip'],
  stop: ['stop'],
  pause: ['pause'],
  resume: ['resume'],
  queue: ['queue'],
  nowplaying: ['nowplaying'],
  leave: ['leave'],
  loop: ['loop'],
  shuffle: ['shuffle'],
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  // Build a message-like shim so existing prefix command handlers work
  await interaction.deferReply().catch(() => {});

  const shim = {
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    mentions: { users: new Collection() },
    reference: null,
    attachments: new Collection(),
    content: '',
    reply: (payload) => interaction.editReply(typeof payload === 'string' ? { content: payload } : payload).catch(() => {}),
    delete: () => Promise.resolve(),
  };

  try {
    if (name === 'play') {
      const query = interaction.options.getString('query') || '';
      const file = interaction.options.getAttachment('file');
      if (file) shim.attachments.set(file.id, file);
      const args = query ? query.split(/\s+/) : [];
      await commands.get('play').run(shim, args);
    } else if (name === 'volume') {
      const level = interaction.options.getInteger('level');
      await commands.get('volume').run(shim, [String(level)]);
    } else if (slashToPrefix[name]) {
      await commands.get(slashToPrefix[name][0]).run(shim, []);
    } else {
      await interaction.editReply('unknown command.');
    }
  } catch (err) {
    console.error('slash error:', err);
    interaction.editReply(`crashed: \`${err.message}\``).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild) return;

  // AFK clear
  if (afk.has(msg.author.id)) {
    const { since } = afk.get(msg.author.id);
    afk.delete(msg.author.id);
    msg.reply(`👋 welcome back — you were afk for ${fmtDuration(Date.now() - since)}.`).catch(() => {});
  }
  // AFK mention
  for (const u of msg.mentions.users.values()) {
    if (afk.has(u.id)) {
      const { reason, since } = afk.get(u.id);
      msg.reply(`💤 **${u.username}** is afk: ${reason} (since ${fmtDuration(Date.now() - since)} ago)`).catch(() => {});
    }
  }

  if (!msg.content.startsWith(PREFIX)) return;
  const body = msg.content.slice(PREFIX.length).trim();
  if (!body) return;
  const parts = body.split(/\s+/);
  const name = parts.shift().toLowerCase();
  const cmd = commands.get(name);
  if (!cmd) return;

  try { await cmd.run(msg, parts); }
  catch (err) {
    console.error(`[${name}]`, err);
    bad(msg, `command crashed: \`${err.code ?? err.message}\``);
  }
});

// snipe tracking
client.on(Events.MessageDelete, (m) => {
  if (!m.guild || m.author?.bot) return;
  snipes.set(m.channel.id, { content: m.content, author: m.author, time: Date.now() });
});
client.on(Events.MessageUpdate, (oldM, newM) => {
  if (!newM.guild || newM.author?.bot) return;
  if (oldM.content === newM.content) return;
  editSnipes.set(newM.channel.id, { before: oldM.content, after: newM.content, author: newM.author, time: Date.now() });
});

client.login(DISCORD_TOKEN);
