// kitty-songs — Cloudflare Worker
// POST /create           { title, author, uri, thumbnail, duration_ms, requested_by } → { id, url }
// GET  /s/:id            → HTML page (Discord login required)
// GET  /auth/login       → redirects to Discord OAuth
// GET  /auth/callback    → OAuth code exchange + session cookie
// GET  /auth/logout      → clears session, redirects home
//
// Env bindings:
//   SONGS                   — KV namespace (also stores sessions + states)
//   SECRET                  — bot-worker auth secret (wrangler secret put SECRET)
//   DISCORD_CLIENT_ID       — bot's Application ID (wrangler secret put DISCORD_CLIENT_ID)
//   DISCORD_CLIENT_SECRET   — OAuth2 client secret from dev portal (wrangler secret put DISCORD_CLIENT_SECRET)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- Create a new song page ----
    if (request.method === 'POST' && url.pathname === '/create') {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SECRET}`) {
        return new Response('unauthorized', { status: 401 });
      }
      let data;
      try { data = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!data.title) return json({ error: 'title required' }, 400);

      const id = randId(8);
      await env.SONGS.put(id, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 7 });
      return json({ id, url: `${url.origin}/s/${id}` });
    }

    // ---- OAuth2 login ----
    if (url.pathname === '/auth/login') {
      return handleAuthLogin(env, url);
    }
    if (url.pathname === '/auth/callback') {
      return handleAuthCallback(request, env, url);
    }
    if (url.pathname === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          'Set-Cookie': 'kitty_sid=; HttpOnly; Secure; Max-Age=0; Path=/; SameSite=Lax',
          'Location': '/',
        },
      });
    }

    // ---- Fetch a song page (requires Discord auth, one-time use) ----
    if (url.pathname.startsWith('/s/')) {
      const id = url.pathname.slice(3);
      const raw = await env.SONGS.get(id);
      if (!raw) return htmlPage(expiredPage(), 410);

      const ua = (request.headers.get('User-Agent') || '').toLowerCase();
      const isBot = /discordbot|twitterbot|facebookexternalhit|slackbot|telegrambot|whatsapp|linkedinbot|bot\/|crawler|spider/.test(ua);

      // Bots skip auth AND skip consumption (for link previews)
      if (isBot) {
        try {
          const song = JSON.parse(raw);
          return htmlPage(renderPage(song, id, url.origin, null));
        } catch { return htmlPage(expiredPage(), 500); }
      }

      // Humans: require login
      const session = await getSession(request, env);
      if (!session) {
        return Response.redirect(`${url.origin}/auth/login?next=${encodeURIComponent(url.pathname)}`, 302);
      }

      try {
        const song = JSON.parse(raw);
        // Burn the link (one-time use)
        await env.SONGS.delete(id);
        return htmlPage(renderPage(song, id, url.origin, session));
      } catch {
        return htmlPage(expiredPage(), 500);
      }
    }

    // ---- Sync endpoint (bot → worker) ----
    if (request.method === 'POST' && url.pathname === '/sync') {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SECRET}`) return new Response('unauthorized', { status: 401 });
      let data;
      try { data = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      // { user_id, playlists }  OR  { user_id, queue, current }
      if (!data.user_id) return json({ error: 'user_id required' }, 400);
      if (data.playlists !== undefined) {
        await env.SONGS.put(`user:${data.user_id}:playlists`, JSON.stringify(data.playlists), { expirationTtl: 60 * 60 * 24 * 30 });
      }
      if (data.queue !== undefined) {
        await env.SONGS.put(`user:${data.user_id}:queue`, JSON.stringify({ queue: data.queue, current: data.current || null }), { expirationTtl: 60 * 60 * 24 * 7 });
      }
      return json({ ok: true });
    }

    // ---- Dashboard (requires login) ----
    if (url.pathname === '/dashboard' || url.pathname === '/d') {
      const session = await getSession(request, env);
      if (!session) return Response.redirect(`${url.origin}/auth/login?next=/dashboard`, 302);
      const plRaw = await env.SONGS.get(`user:${session.id}:playlists`);
      const qRaw = await env.SONGS.get(`user:${session.id}:queue`);
      const playlists = plRaw ? JSON.parse(plRaw) : {};
      const qData = qRaw ? JSON.parse(qRaw) : { queue: [], current: null };
      return htmlPage(renderDashboard(session, playlists, qData, url.origin));
    }

    // ---- Background image proxy (Wikipedia Bliss) — cached forever ----
    if (url.pathname === '/bg') {
      const cache = caches.default;
      const cacheKey = new Request('https://cache.local/bg-bliss', request);
      let cached = await cache.match(cacheKey);
      if (cached) return cached;
      try {
        const upstream = await fetch('https://upload.wikimedia.org/wikipedia/en/f/f2/XP_Bliss_authentic.png', {
          headers: { 'User-Agent': 'kitty-discplayer/1.0' },
        });
        if (!upstream.ok) {
          // Fallback to commons
          const fb = await fetch('https://upload.wikimedia.org/wikipedia/commons/8/8d/Bliss_%28Windows_XP%29.png', {
            headers: { 'User-Agent': 'kitty-discplayer/1.0' },
          });
          if (!fb.ok) return new Response('', { status: 502 });
          const img = await fb.arrayBuffer();
          const resp = new Response(img, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
          await cache.put(cacheKey, resp.clone());
          return resp;
        }
        const img = await upstream.arrayBuffer();
        const resp = new Response(img, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
        await cache.put(cacheKey, resp.clone());
        return resp;
      } catch (e) { return new Response('', { status: 502 }); }
    }

    // ---- Bot control endpoint (web → worker queue → bot) ----
    if (request.method === 'POST' && url.pathname === '/control') {
      const session = await getSession(request, env);
      if (!session) return json({ error: 'not logged in' }, 401);
      let data;
      try { data = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const { guild_id, action, value } = data;
      if (!guild_id || !action) return json({ error: 'guild_id + action required' }, 400);
      const cmd = {
        id: randId(8),
        guild_id: String(guild_id),
        user_id: session.id,
        action, value,
        created_at: Date.now(),
      };
      // Append to pending queue (overwrites if same id — fine, random)
      await env.SONGS.put(`cmd:${cmd.id}`, JSON.stringify(cmd), { expirationTtl: 60 });
      return json({ ok: true, id: cmd.id });
    }

    // ---- Bot pending commands drain ----
    if (url.pathname === '/pending') {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SECRET}`) return new Response('unauthorized', { status: 401 });
      const list = await env.SONGS.list({ prefix: 'cmd:' });
      const commands = [];
      for (const key of list.keys) {
        const raw = await env.SONGS.get(key.name);
        if (raw) {
          commands.push(JSON.parse(raw));
          await env.SONGS.delete(key.name);
        }
      }
      return json({ commands });
    }

    if (url.pathname === '/') return htmlPage(landingPage(url.origin));
    return new Response('404', { status: 404 });
  },
};

// ---- OAuth helpers ----

async function handleAuthLogin(env, url) {
  if (!env.DISCORD_CLIENT_ID) return new Response('Discord OAuth not configured', { status: 500 });
  const next = url.searchParams.get('next') || '/';
  const state = randId(32);
  await env.SONGS.put(`state:${state}`, next, { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: 'identify',
    state: state,
    prompt: 'none',
  });
  return Response.redirect(`https://discord.com/api/oauth2/authorize?${params}`, 302);
}

async function handleAuthCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('missing code or state', { status: 400 });

  const next = await env.SONGS.get(`state:${state}`);
  if (!next) return new Response('invalid or expired state', { status: 400 });
  await env.SONGS.delete(`state:${state}`);

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return new Response(`token exchange failed: ${txt}`, { status: 500 });
  }
  const { access_token } = await tokenRes.json();

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { 'Authorization': `Bearer ${access_token}` },
  });
  if (!userRes.ok) return new Response('failed to fetch user', { status: 500 });
  const user = await userRes.json();

  const sid = randId(32);
  const sessionData = {
    id: user.id,
    username: user.username,
    global_name: user.global_name || user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(parseInt(user.id) >> 22) % 6}.png`,
  };
  await env.SONGS.put(`session:${sid}`, JSON.stringify(sessionData), { expirationTtl: 60 * 60 * 24 * 7 });

  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': `kitty_sid=${sid}; HttpOnly; Secure; Max-Age=604800; Path=/; SameSite=Lax`,
      'Location': next,
    },
  });
}

async function getSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/kitty_sid=([^;]+)/);
  if (!m) return null;
  const raw = await env.SONGS.get(`session:${m[1]}`);
  return raw ? JSON.parse(raw) : null;
}

// ---- helpers ----

function randId(n) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlPage(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function extractYtId(uri) {
  if (!uri) return null;
  const m = uri.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function buildYtSearchQuery(song) {
  // Fallback for Spotify/SoundCloud/etc — build a YouTube search string
  return encodeURIComponent(`${song.title || ''} ${song.author || ''}`.trim());
}

function renderPage(song, id, origin, session) {
  const title = esc(song.title);
  const author = esc(song.author || '');
  const uri = esc(song.uri || '');
  const thumb = esc(song.thumbnail || '');
  const duration = fmtDuration(song.duration_ms);
  const requestedBy = esc(song.requested_by || '');
  const share = esc(`${origin}/s/${id}`);
  const ytId = extractYtId(song.uri);
  const searchQ = buildYtSearchQuery(song);
  const userName = session ? esc(session.global_name) : '';
  const userAvatar = session ? esc(session.avatar) : '';
  const guildId = esc(song.guild_id || '');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — kitty discplayer</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${author}${duration ? ' • ' + duration : ''}">
${thumb ? `<meta property="og:image" content="${thumb}">` : ''}
<meta name="theme-color" content="#ff66cc">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Frutiger&family=Segoe+UI&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --aqua-pink-top: #b8f5c9;
    --aqua-pink: #4dd680;
    --aqua-pink-dark: #1a8e4a;
    --chrome-light: #f8fff8;
    --chrome-mid: #d0e8d8;
    --chrome-dark: #80a090;
    --glass: rgba(240, 255, 245, 0.55);
    --glass-ring: rgba(120, 220, 160, 0.8);
    --text-dark: #0a2a18;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: 'Segoe UI', 'Frutiger', Tahoma, sans-serif;
    background:
      url('/bg') center/cover no-repeat,
      linear-gradient(180deg, #4a95e8 0%, #7bc96f 60%, #4e9c38 100%);
    background-attachment: fixed;
    min-height: 100vh;
    color: var(--text-dark);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    overflow-x: hidden;
  }
  /* Floating bubbles */
  body::before, body::after {
    content: '';
    position: fixed;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.9), rgba(180,240,200,0.3) 60%, transparent);
    pointer-events: none;
    animation: float 12s ease-in-out infinite;
  }
  body::before { width: 180px; height: 180px; top: 8%; left: 5%; }
  body::after { width: 120px; height: 120px; bottom: 10%; right: 8%; animation-delay: -6s; }
  @keyframes float {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: translateY(-30px) scale(1.05); }
  }
  /* Main glass panel — Frutiger Aero */
  .player {
    position: relative;
    width: 100%;
    max-width: 620px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0.4) 48%, rgba(240,255,245,0.35) 52%, rgba(200,245,215,0.5) 100%),
      linear-gradient(180deg, var(--aqua-pink-top), var(--aqua-pink));
    border: 1px solid rgba(255,255,255,0.9);
    border-radius: 20px;
    padding: 18px;
    box-shadow:
      inset 0 2px 0 rgba(255,255,255,1),
      inset 0 -2px 0 rgba(50,180,100,0.4),
      0 20px 60px rgba(77,214,128,0.35),
      0 8px 20px rgba(0,0,0,0.15);
    backdrop-filter: blur(20px) saturate(140%);
    overflow: hidden;
  }
  /* Gloss sheen overlay */
  .player::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 48%;
    background: linear-gradient(180deg, rgba(255,255,255,0.65), rgba(255,255,255,0) 100%);
    border-radius: 20px 20px 50% 50% / 20px 20px 100% 100%;
    pointer-events: none;
  }
  .player > * { position: relative; z-index: 1; }

  /* Spinning CD disc */
  .disc-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 10px 0 18px;
    position: relative;
  }
  .disc {
    position: relative;
    width: 220px;
    height: 220px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 50% 50%, #e0e0e8 24%, transparent 24.5%),
      radial-gradient(circle at 50% 50%, #fff 23%, transparent 23.5%),
      conic-gradient(from 0deg,
        #c0c0d0, #f0f0f8, #a0a0b8, #e8e8f0, #b8b8c8,
        #f8f8ff, #c8c8d8, #e0e0e8, #b0b0c0, #f0f0f8, #c0c0d0);
    box-shadow:
      0 0 0 1px rgba(0,0,0,0.3),
      inset 0 0 30px rgba(0,0,0,0.25),
      0 10px 30px rgba(0,0,0,0.3);
    animation: spin 6s linear infinite;
    animation-play-state: paused;
  }
  .disc.playing { animation-play-state: running; }
  .disc::before {
    content: '';
    position: absolute;
    inset: 24%;
    border-radius: 50%;
    background-image: url('${thumb}');
    background-size: cover;
    background-position: center;
    box-shadow: inset 0 0 0 2px rgba(255,255,255,0.8), 0 0 0 1px rgba(0,0,0,0.3);
  }
  .disc::after {
    content: '';
    position: absolute;
    top: 50%; left: 50%;
    width: 18px; height: 18px;
    margin: -9px 0 0 -9px;
    border-radius: 50%;
    background: radial-gradient(circle, #fff 30%, #888 100%);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5);
    z-index: 2;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Hidden YouTube player for audio */
  #yt-player {
    position: absolute;
    width: 1px; height: 1px;
    opacity: 0; pointer-events: none;
  }

  /* Meta */
  .meta {
    text-align: center;
    padding: 6px 12px 14px;
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-dark);
    text-shadow: 0 1px 0 rgba(255,255,255,0.9), 0 -1px 0 rgba(0,0,0,0.05);
    line-height: 1.2;
    margin-bottom: 4px;
  }
  .author {
    font-size: 13px;
    color: var(--aqua-pink-dark);
    font-weight: 500;
  }

  /* Progress bar — aqua glossy */
  .progress-wrap {
    padding: 4px 8px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .time {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dark);
    min-width: 36px;
    text-align: center;
    text-shadow: 0 1px 0 rgba(255,255,255,0.8);
  }
  .progress {
    flex: 1;
    height: 14px;
    background:
      linear-gradient(180deg, rgba(0,0,0,0.15), rgba(255,255,255,0.1) 50%, rgba(0,0,0,0.05));
    border: 1px solid rgba(0,0,0,0.3);
    border-radius: 999px;
    cursor: pointer;
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 2px 3px rgba(0,0,0,0.25);
  }
  .progress-bar {
    height: 100%;
    width: 0%;
    background:
      linear-gradient(180deg, #b8f5c9 0%, #4dd680 50%, #1a8e4a 100%);
    border-radius: 999px;
    transition: width 0.3s linear;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
    position: relative;
  }
  .progress-bar::after {
    content: '';
    position: absolute;
    inset: 1px 1px 50% 1px;
    background: linear-gradient(180deg, rgba(255,255,255,0.6), rgba(255,255,255,0));
    border-radius: 999px;
  }

  /* Chrome control buttons */
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 6px 8px 12px;
  }
  .ctrl {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 50% 30%, var(--chrome-light), var(--chrome-mid) 60%, var(--chrome-dark));
    color: var(--text-dark);
    border: 1px solid rgba(0,0,0,0.4);
    cursor: pointer;
    font-size: 16px;
    transition: transform 0.1s ease;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.9),
      inset 0 -2px 2px rgba(0,0,0,0.2),
      0 2px 6px rgba(0,0,0,0.2);
  }
  .ctrl:hover { transform: translateY(-1px); }
  .ctrl:active { transform: translateY(1px); box-shadow: inset 0 1px 3px rgba(0,0,0,0.3); }
  .ctrl.primary {
    width: 62px; height: 62px;
    background:
      radial-gradient(circle at 50% 25%, #d9ffe6, #4dd680 55%, #0a6633);
    color: #fff;
    font-size: 24px;
    text-shadow: 0 1px 1px rgba(0,0,0,0.3);
    border: 1px solid rgba(0,60,30,0.5);
    box-shadow:
      inset 0 2px 0 rgba(255,255,255,0.7),
      inset 0 -3px 3px rgba(0,60,30,0.4),
      0 4px 12px rgba(50,180,100,0.5),
      0 2px 4px rgba(0,0,0,0.3);
  }

  /* Volume slider */
  .vol-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 10px;
    padding: 6px 10px;
    background: linear-gradient(180deg, rgba(255,255,255,0.4), rgba(255,255,255,0.1));
    border: 1px solid rgba(255,255,255,0.6);
    border-radius: 999px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
  }
  .vol-slider {
    -webkit-appearance: none;
    width: 80px;
    height: 6px;
    background: linear-gradient(180deg, rgba(0,0,0,0.2), rgba(0,0,0,0.05));
    border: 1px solid rgba(0,0,0,0.2);
    border-radius: 999px;
    outline: none;
    cursor: pointer;
  }
  .vol-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 30%, #fff, #4dd680 70%, #1a8e4a);
    border: 1px solid rgba(0,60,30,0.5);
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  .vol-slider::-moz-range-thumb {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 30%, #fff, #4dd680 70%, #1a8e4a);
    border: 1px solid rgba(0,60,30,0.5);
    cursor: pointer;
  }

  /* Extra actions row */
  .actions {
    display: flex;
    gap: 8px;
    padding: 4px 8px 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 999px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.85), rgba(220,255,230,0.6));
    color: var(--text-dark);
    text-decoration: none;
    font-weight: 600;
    font-size: 12px;
    border: 1px solid rgba(50,180,100,0.5);
    cursor: pointer;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.9),
      inset 0 -1px 0 rgba(0,0,0,0.05),
      0 2px 4px rgba(0,0,0,0.1);
    transition: transform 0.1s;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(1px); }

  .footer {
    padding: 10px 8px 2px;
    font-size: 10px;
    opacity: 0.75;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    color: var(--text-dark);
    text-shadow: 0 1px 0 rgba(255,255,255,0.7);
  }
  .share {
    font-family: 'Consolas', Monaco, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 55%;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.5px;
  }
  .brand::before { content: '♪ '; color: var(--aqua-pink); }

  /* Speed row */
  .speed-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 2px 8px 10px;
    flex-wrap: wrap;
  }
  .speed-label {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-dark);
    opacity: 0.6;
    letter-spacing: 1px;
    text-transform: uppercase;
    margin-right: 4px;
  }
  .speed-btn {
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: linear-gradient(180deg, rgba(255,255,255,0.7), rgba(220,255,230,0.5));
    border: 1px solid rgba(50,180,100,0.4);
    color: var(--text-dark);
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  }
  .speed-btn.active {
    background: linear-gradient(180deg, #d9ffe6, #4dd680 70%, #1a8e4a);
    color: #fff;
    text-shadow: 0 1px 1px rgba(0,0,0,0.3);
  }

  /* Visualizer bars under disc */
  .viz {
    display: flex;
    gap: 3px;
    justify-content: center;
    align-items: flex-end;
    height: 24px;
    margin: 0 auto 8px;
    opacity: 0.5;
  }
  .viz-bar {
    width: 3px;
    background: linear-gradient(180deg, #4dd680, #1a8e4a);
    border-radius: 2px;
    animation: viz-pulse 0.8s ease-in-out infinite;
  }
  .viz-bar:nth-child(1) { animation-delay: 0s; height: 60%; }
  .viz-bar:nth-child(2) { animation-delay: 0.1s; height: 80%; }
  .viz-bar:nth-child(3) { animation-delay: 0.2s; height: 100%; }
  .viz-bar:nth-child(4) { animation-delay: 0.3s; height: 70%; }
  .viz-bar:nth-child(5) { animation-delay: 0.15s; height: 90%; }
  .viz-bar:nth-child(6) { animation-delay: 0.25s; height: 50%; }
  .viz-bar:nth-child(7) { animation-delay: 0.35s; height: 85%; }
  .viz.paused .viz-bar { animation-play-state: paused; }
  @keyframes viz-pulse {
    0%, 100% { transform: scaleY(0.4); }
    50% { transform: scaleY(1); }
  }

  /* Bot control row */
  .bot-ctrl {
    margin: 10px 8px 4px;
    padding: 10px 14px;
    background: linear-gradient(180deg, rgba(255,255,255,0.7), rgba(220,255,230,0.4));
    border: 1px solid rgba(50,180,100,0.5);
    border-radius: 14px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  }
  .bot-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1.5px;
    color: var(--green-dark, #1a8e4a);
    text-align: center;
    margin-bottom: 8px;
    opacity: 0.8;
  }
  .bot-buttons {
    display: flex;
    justify-content: center;
    gap: 8px;
  }
  .bot-btn {
    width: 40px; height: 40px;
    border-radius: 50%;
    border: 1px solid rgba(0,60,30,0.5);
    background: radial-gradient(circle at 50% 25%, #d9ffe6, #4dd680 55%, #0a6633);
    color: #fff;
    font-size: 14px;
    cursor: pointer;
    text-shadow: 0 1px 1px rgba(0,0,0,0.3);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.6),
      inset 0 -2px 2px rgba(0,60,30,0.3),
      0 2px 6px rgba(50,180,100,0.4);
    transition: transform 0.1s;
  }
  .bot-btn:hover { transform: translateY(-1px); }
  .bot-btn:active { transform: translateY(1px); }
  .bot-status {
    text-align: center;
    font-size: 10px;
    min-height: 14px;
    margin-top: 6px;
    color: var(--green-dark);
    font-weight: 600;
  }

  /* User bar */
  .user-bar {
    position: absolute;
    top: 12px;
    right: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 4px;
    background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(220,255,230,0.6));
    border: 1px solid rgba(50,180,100,0.5);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 4px rgba(0,0,0,0.1);
    z-index: 2;
  }
  .user-avatar {
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.9);
  }
  .user-name {
    color: var(--text-dark);
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .user-logout {
    color: var(--aqua-pink-dark);
    text-decoration: none;
    font-size: 13px;
    padding: 0 4px;
  }
  .user-logout:hover { color: #000; }

  @media (max-width: 480px) {
    .disc { width: 170px; height: 170px; }
    .controls { gap: 6px; }
    .ctrl { width: 42px; height: 42px; font-size: 14px; }
    .ctrl.primary { width: 54px; height: 54px; font-size: 20px; }
    .vol-slider { width: 50px; }
    h1 { font-size: 18px; }
    .user-bar { top: 8px; right: 10px; font-size: 10px; }
    .user-avatar { width: 18px; height: 18px; }
    .user-name { max-width: 60px; }
  }
</style>
</head>
<body>
  <div class="player">
    <div class="disc-wrap">
      <div class="disc" id="disc"></div>
      <div id="yt-player"></div>
    </div>

    <div class="meta">
      <h1>${title}</h1>
      <div class="author">${author}${duration ? ' • ' + duration : ''}</div>
    </div>

    <div class="viz paused" id="viz">
      <div class="viz-bar"></div>
      <div class="viz-bar"></div>
      <div class="viz-bar"></div>
      <div class="viz-bar"></div>
      <div class="viz-bar"></div>
      <div class="viz-bar"></div>
      <div class="viz-bar"></div>
    </div>

    <div class="progress-wrap">
      <span class="time" id="time-cur">0:00</span>
      <div class="progress" id="progress"><div class="progress-bar" id="bar"></div></div>
      <span class="time" id="time-tot">0:00</span>
    </div>

    <div class="controls">
      <button class="ctrl" id="back10" title="Back 10s">⏪</button>
      <button class="ctrl primary" id="playpause" title="Play/Pause">⏸</button>
      <button class="ctrl" id="fwd10" title="Forward 10s">⏩</button>
      <button class="ctrl" id="mute" title="Mute / Unmute">🔇</button>
      <div class="vol-wrap">
        <span id="vol-icon">🔊</span>
        <input type="range" min="0" max="100" value="80" class="vol-slider" id="vol">
      </div>
    </div>

    <div class="speed-row">
      <span class="speed-label">Speed</span>
      <button class="speed-btn" data-rate="0.5">0.5×</button>
      <button class="speed-btn active" data-rate="1">1×</button>
      <button class="speed-btn" data-rate="1.25">1.25×</button>
      <button class="speed-btn" data-rate="1.5">1.5×</button>
      <button class="speed-btn" data-rate="2">2×</button>
    </div>

    <div class="actions">
      ${uri ? `<a class="btn" href="${uri}" target="_blank">▶ Open source</a>` : ''}
      <button class="btn" onclick="navigator.clipboard.writeText('${share}').then(()=>this.textContent='✓ copied')">🔗 Copy link</button>
    </div>

    ${session && guildId ? `
    <div class="bot-ctrl">
      <div class="bot-label">🤖 CONTROL THE BOT</div>
      <div class="bot-buttons">
        <button class="bot-btn" data-action="pause" title="Pause/Resume">⏯</button>
        <button class="bot-btn" data-action="skip" title="Skip">⏭</button>
        <button class="bot-btn" data-action="stop" title="Stop & leave">⏹</button>
        <button class="bot-btn" data-action="shuffle" title="Shuffle queue">🔀</button>
        <button class="bot-btn" data-action="loop" title="Toggle loop">🔁</button>
      </div>
      <div class="bot-status" id="bot-status"></div>
    </div>
    ` : ''}

    <div class="footer">
      <span class="brand">kitty discplayer</span>
      <span class="share">${share}</span>
    </div>

    ${session ? `
    <div class="user-bar">
      <img src="${userAvatar}" alt="" class="user-avatar">
      <span class="user-name">${userName}</span>
      <a href="/auth/logout" class="user-logout" title="Log out">⎋</a>
    </div>
    ` : ''}
  </div>

  <script>
    let player;
    const disc = document.getElementById('disc');
    const HAS_YT_ID = ${ytId ? 'true' : 'false'};
    const YT_ID = '${ytId || ''}';
    const SEARCH_Q = '${searchQ}';

    function onYouTubeIframeAPIReady() {
      const config = {
        playerVars: {
          autoplay: 1,
          mute: 1, // start muted — autoplay requires this in most browsers
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: onReady,
          onStateChange: onStateChange,
        },
      };
      if (HAS_YT_ID) {
        config.videoId = YT_ID;
      } else {
        config.playerVars.listType = 'search';
        config.playerVars.list = SEARCH_Q;
      }
      player = new YT.Player('yt-player', config);
    }

    function onReady(e) {
      e.target.setVolume(80);
      const d = e.target.getDuration();
      if (d) document.getElementById('time-tot').textContent = fmt(d);
      setInterval(updateProgress, 500);
    }

    // Bot control buttons
    const GUILD_ID = '${guildId}';
    document.querySelectorAll('.bot-btn').forEach(b => {
      b.onclick = async () => {
        const status = document.getElementById('bot-status');
        status.textContent = '⏳ sending...';
        try {
          const r = await fetch('/control', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ guild_id: GUILD_ID, action: b.dataset.action }),
          });
          const j = await r.json();
          status.textContent = r.ok ? '✓ sent' : ('⚠ ' + (j.error || 'failed'));
          setTimeout(() => status.textContent = '', 2500);
        } catch (e) {
          status.textContent = '⚠ ' + e.message;
        }
      };
    });

    // Mute toggle
    document.getElementById('mute').onclick = () => {
      if (!player) return;
      const btn = document.getElementById('mute');
      if (player.isMuted()) {
        player.unMute();
        btn.textContent = '🔊';
      } else {
        player.mute();
        btn.textContent = '🔇';
      }
    };

    // Playback speed
    document.querySelectorAll('.speed-btn').forEach(b => {
      b.onclick = () => {
        if (!player) return;
        const rate = parseFloat(b.dataset.rate);
        player.setPlaybackRate(rate);
        document.querySelectorAll('.speed-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
    });

    function onStateChange(e) {
      const btn = document.getElementById('playpause');
      const viz = document.getElementById('viz');
      if (e.data === YT.PlayerState.PLAYING) {
        btn.textContent = '⏸';
        disc.classList.add('playing');
        viz.classList.remove('paused');
      } else if (e.data === YT.PlayerState.PAUSED) {
        btn.textContent = '▶';
        disc.classList.remove('playing');
        viz.classList.add('paused');
      } else if (e.data === YT.PlayerState.ENDED) {
        btn.textContent = '↻';
        disc.classList.remove('playing');
        viz.classList.add('paused');
      }
    }

    function updateProgress() {
      if (!player || !player.getCurrentTime) return;
      try {
        const cur = player.getCurrentTime();
        const tot = player.getDuration();
        if (!tot) return;
        document.getElementById('bar').style.width = ((cur / tot) * 100) + '%';
        document.getElementById('time-cur').textContent = fmt(cur);
        document.getElementById('time-tot').textContent = fmt(tot);
      } catch (e) {}
    }

    function fmt(s) {
      s = Math.floor(s);
      const m = Math.floor(s / 60);
      return m + ':' + String(s % 60).padStart(2, '0');
    }

    document.getElementById('playpause').onclick = () => {
      if (!player) return;
      const state = player.getPlayerState();
      if (state === YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    };
    document.getElementById('back10').onclick = () => {
      if (!player) return;
      player.seekTo(Math.max(0, player.getCurrentTime() - 10), true);
    };
    document.getElementById('fwd10').onclick = () => {
      if (!player) return;
      player.seekTo(Math.min(player.getDuration(), player.getCurrentTime() + 10), true);
    };
    document.getElementById('vol').oninput = (e) => {
      if (player) player.setVolume(e.target.value);
    };
    document.getElementById('progress').onclick = (e) => {
      if (!player) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      player.seekTo(pct * player.getDuration(), true);
    };

    // Load YT API
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);
  </script>
</body>
</html>`;
}

function renderDashboard(session, playlists, qData, origin) {
  const name = esc(session.global_name);
  const avatar = esc(session.avatar);
  const plEntries = Object.entries(playlists);
  const plHtml = plEntries.length
    ? plEntries.map(([n, tracks]) => `
      <div class="pl-card">
        <div class="pl-head">
          <h3>${esc(n)}</h3>
          <span class="pl-count">${tracks.length} tracks</span>
        </div>
        <div class="pl-tracks">
          ${tracks.slice(0, 5).map((t, i) => `<div class="pl-track">${i+1}. <a href="${esc(t)}" target="_blank">${esc(t)}</a></div>`).join('')}
          ${tracks.length > 5 ? `<div class="pl-more">+${tracks.length - 5} more</div>` : ''}
        </div>
      </div>
    `).join('')
    : `<div class="empty">No playlists yet. In Discord: <code>/playlist create name:yours</code></div>`;

  const queueHtml = qData.current
    ? `<div class="current">
         <div class="current-label">▶ NOW PLAYING</div>
         <div class="current-title">${esc(qData.current.title || 'Unknown')}</div>
         <div class="current-author">${esc(qData.current.author || '')}</div>
       </div>`
    : '';
  const upcomingHtml = (qData.queue || []).length
    ? `<div class="queue-list">
         ${qData.queue.slice(0, 20).map((t, i) => `
           <div class="queue-item"><span class="q-num">${i+1}.</span> ${esc(t.title || 'Unknown')} <span class="q-author">— ${esc(t.author || '')}</span></div>
         `).join('')}
         ${qData.queue.length > 20 ? `<div class="pl-more">+${qData.queue.length - 20} more</div>` : ''}
       </div>`
    : `<div class="empty">Queue empty.</div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>kitty discplayer — dashboard</title>
<meta name="theme-color" content="#4dd680">
<style>
  :root { color-scheme: light; --green: #4dd680; --green-dark: #1a8e4a; --text: #0a2a18; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Tahoma, sans-serif;
    background:
      url('/bg') center/cover no-repeat,
      linear-gradient(180deg, #4a95e8 0%, #7bc96f 60%);
    background-attachment: fixed;
    color: var(--text);
    min-height: 100vh;
    padding: 20px;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: linear-gradient(180deg, rgba(255,255,255,0.85), rgba(240,255,245,0.6));
    border: 1px solid rgba(255,255,255,0.9);
    border-radius: 18px;
    padding: 14px 20px;
    box-shadow: inset 0 2px 0 rgba(255,255,255,1), 0 10px 30px rgba(0,0,0,0.2);
    margin-bottom: 20px;
    backdrop-filter: blur(20px);
  }
  .brand {
    font-size: 22px;
    font-weight: 700;
    color: var(--green-dark);
    text-shadow: 0 1px 0 rgba(255,255,255,0.9);
  }
  .brand::before { content: '♪ '; color: var(--green); }
  .user {
    display: flex; align-items: center; gap: 10px;
    padding: 4px 12px 4px 4px;
    background: linear-gradient(180deg, #fff, #e8ffee);
    border: 1px solid rgba(50,180,100,0.5);
    border-radius: 999px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 4px rgba(0,0,0,0.1);
  }
  .user img { width: 32px; height: 32px; border-radius: 50%; }
  .user a { color: var(--green-dark); text-decoration: none; font-size: 12px; }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: linear-gradient(180deg, rgba(255,255,255,0.85), rgba(240,255,245,0.6));
    border: 1px solid rgba(255,255,255,0.9);
    border-radius: 18px;
    padding: 18px;
    box-shadow: inset 0 2px 0 rgba(255,255,255,1), 0 10px 30px rgba(0,0,0,0.2);
    backdrop-filter: blur(20px);
  }
  .panel h2 {
    font-size: 18px;
    color: var(--green-dark);
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(50,180,100,0.3);
    text-shadow: 0 1px 0 rgba(255,255,255,0.9);
  }

  .pl-card {
    background: rgba(255,255,255,0.5);
    border: 1px solid rgba(50,180,100,0.3);
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .pl-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .pl-head h3 { font-size: 15px; color: var(--green-dark); }
  .pl-count { font-size: 11px; opacity: 0.6; }
  .pl-track, .queue-item, .pl-more {
    font-size: 12px;
    padding: 3px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pl-track a { color: #1a8e4a; text-decoration: none; }
  .pl-track a:hover { text-decoration: underline; }
  .pl-more, .empty { opacity: 0.5; font-style: italic; font-size: 12px; }
  .empty { padding: 20px; text-align: center; }
  .empty code { background: rgba(0,0,0,0.08); padding: 1px 6px; border-radius: 4px; font-size: 11px; }

  .current {
    background: linear-gradient(180deg, #d9ffe6, #a8f5c0);
    border: 1px solid rgba(50,180,100,0.5);
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 12px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  }
  .current-label { font-size: 10px; font-weight: 700; color: var(--green-dark); letter-spacing: 1px; margin-bottom: 4px; }
  .current-title { font-size: 15px; font-weight: 600; }
  .current-author { font-size: 12px; opacity: 0.7; margin-top: 2px; }

  .queue-item { padding: 5px 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
  .q-num { color: var(--green-dark); font-weight: 600; margin-right: 6px; }
  .q-author { opacity: 0.5; }
</style>
</head><body>
<div class="wrap">
  <header>
    <div class="brand">kitty discplayer</div>
    <div class="user">
      <img src="${avatar}" alt="">
      <span>${name}</span>
      <a href="/auth/logout">logout</a>
    </div>
  </header>

  <div class="grid">
    <div class="panel">
      <h2>🎵 Your Playlists</h2>
      ${plHtml}
    </div>
    <div class="panel">
      <h2>📋 Now Playing & Queue</h2>
      ${queueHtml}
      ${upcomingHtml}
    </div>
  </div>

  <div style="text-align:center; margin-top: 20px; font-size: 11px; opacity: 0.6; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.5);">
    Playlists update when you run <code>/playlist</code> commands in Discord. Queue updates on every <code>/play</code>.
  </div>
</div>
</body></html>`;
}

function landingPage(origin) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>kitty discplayer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Tahoma, sans-serif;
    background:
      url('/bg') center/cover no-repeat,
      linear-gradient(180deg, #4a95e8 0%, #7bc96f 60%);
    background-attachment: fixed;
    color: #0a2a18;
    display: grid; place-items: center;
    min-height: 100vh;
    padding: 20px;
  }
  .card {
    background: linear-gradient(180deg, rgba(255,255,255,0.85), rgba(240,255,245,0.6));
    border: 1px solid rgba(255,255,255,0.9);
    border-radius: 24px;
    padding: 40px 50px;
    text-align: center;
    box-shadow: inset 0 2px 0 rgba(255,255,255,1), 0 20px 60px rgba(0,0,0,0.3);
    backdrop-filter: blur(20px);
    max-width: 500px;
  }
  h1 {
    color: #1a8e4a;
    font-size: 48px;
    text-shadow: 0 2px 0 rgba(255,255,255,0.9);
    margin-bottom: 8px;
  }
  .tagline {
    font-size: 14px;
    opacity: 0.8;
    margin-bottom: 24px;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    background: linear-gradient(180deg, #d9ffe6, #4dd680 70%, #1a8e4a);
    color: #fff;
    text-decoration: none;
    border-radius: 999px;
    font-weight: 600;
    border: 1px solid rgba(0,60,30,0.5);
    box-shadow: inset 0 2px 0 rgba(255,255,255,0.7), 0 4px 12px rgba(50,180,100,0.5);
    text-shadow: 0 1px 1px rgba(0,0,0,0.3);
  }
  .foot { font-size: 11px; opacity: 0.6; margin-top: 20px; }
</style></head>
<body>
  <div class="card">
    <h1>♪ kitty discplayer</h1>
    <div class="tagline">one-time music share links · from a frutiger past</div>
    <a href="/dashboard" class="cta">🎵 Open Dashboard</a>
    <div class="foot">served from <code>${origin}</code></div>
  </div>
</body></html>`;
}

function notFoundPage() {
  return `<!doctype html><html><body style="font-family:system-ui;background:#0a0514;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="color:#ff66cc;font-size:72px">404</h1><p>Song not found.</p></div>
</body></html>`;
}

function expiredPage() {
  return `<!doctype html><html><body style="font-family:system-ui;background:#0a0514;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:400px;padding:20px">
<h1 style="color:#ff66cc;font-size:56px;margin-bottom:12px">💨</h1>
<h2 style="font-size:20px;margin-bottom:8px">one-time link</h2>
<p style="opacity:0.6">This link has been used. Ask the bot to play again for a new one.</p>
</div></body></html>`;
}
