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
        // Persistent link — no deletion, link stays usable until KV TTL (7 days)
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

    // ---- Background image proxy (Bliss) — cached forever with UA + mirror fallbacks ----
    if (url.pathname === '/bg') {
      const cache = caches.default;
      const cacheKey = new Request('https://cache.local/bg-bliss-v3', request);
      let cached = await cache.match(cacheKey);
      if (cached) return cached;
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
      const mirrors = [
        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Bliss_%28Windows_XP%29.png/2560px-Bliss_%28Windows_XP%29.png',
        'https://upload.wikimedia.org/wikipedia/en/f/f2/XP_Bliss_authentic.png',
        'https://upload.wikimedia.org/wikipedia/commons/8/8d/Bliss_%28Windows_XP%29.png',
      ];
      for (const src of mirrors) {
        try {
          const r = await fetch(src, { headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*' } });
          if (r.ok) {
            const img = await r.arrayBuffer();
            const resp = new Response(img, {
              headers: {
                'Content-Type': r.headers.get('Content-Type') || 'image/jpeg',
                'Cache-Control': 'public, max-age=31536000, immutable',
              },
            });
            await cache.put(cacheKey, resp.clone());
            return resp;
          }
        } catch {}
      }
      return new Response('', { status: 502 });
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
    color-scheme: dark;
    --accent: #4dd680;
    --accent-dim: #2a9e5a;
    --bg-panel: rgba(12, 14, 12, 0.72);
    --bg-raise: rgba(255, 255, 255, 0.04);
    --border: rgba(255, 255, 255, 0.08);
    --border-accent: rgba(77, 214, 128, 0.35);
    --text: #e8f5ec;
    --text-dim: rgba(232, 245, 236, 0.55);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, 'SF Pro Display', 'Inter', 'Segoe UI', sans-serif;
    background:
      linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.75)),
      url('/bg') center/cover no-repeat,
      #000;
    background-attachment: fixed;
    min-height: 100vh;
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow-x: hidden;
  }
  /* Main slim black panel */
  .player {
    position: relative;
    width: 100%;
    max-width: 420px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 18px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.05) inset;
    backdrop-filter: blur(24px) saturate(140%);
    overflow: hidden;
  }

  /* Album art — compact square with slow rotate */
  .disc-wrap {
    display: flex;
    justify-content: center;
    padding: 4px 0 14px;
  }
  .disc {
    position: relative;
    width: 180px;
    height: 180px;
    border-radius: 12px;
    background-image: url('${thumb}');
    background-size: cover;
    background-position: center;
    box-shadow:
      0 8px 24px rgba(0,0,0,0.5),
      0 0 0 1px rgba(255,255,255,0.08),
      0 0 40px rgba(77,214,128,0.1);
    transition: transform 0.4s;
  }
  .disc.playing { animation: subtle-pulse 4s ease-in-out infinite; }
  @keyframes subtle-pulse {
    0%, 100% { box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08), 0 0 40px rgba(77,214,128,0.1); }
    50%      { box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08), 0 0 60px rgba(77,214,128,0.35); }
  }
  /* Hidden YouTube player */
  #yt-player { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

  /* Hidden YouTube player for audio */
  /* Meta */
  .meta {
    text-align: center;
    padding: 0 8px 12px;
  }
  h1 {
    font-size: 17px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .author {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 500;
  }

  /* Thin progress bar */
  .progress-wrap {
    padding: 2px 4px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .time {
    font-size: 10px;
    font-weight: 500;
    color: var(--text-dim);
    min-width: 32px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .progress {
    flex: 1;
    height: 3px;
    background: rgba(255,255,255,0.08);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
    transition: height 0.15s;
  }
  .progress:hover { height: 5px; }
  .progress-bar {
    height: 100%;
    width: 0%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s linear;
  }

  /* Slim flat control buttons */
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 2px 4px 10px;
  }
  .ctrl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 999px;
    background: var(--bg-raise);
    color: var(--text);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .ctrl:hover { background: rgba(77,214,128,0.1); border-color: var(--border-accent); color: var(--accent); }
  .ctrl:active { transform: scale(0.95); }
  .ctrl.primary {
    width: 48px; height: 48px;
    background: var(--accent);
    color: #000;
    font-size: 18px;
    border: none;
    box-shadow: 0 2px 8px rgba(77,214,128,0.35);
  }
  .ctrl.primary:hover { background: #65e096; transform: scale(1.05); }
  .ctrl.danger { color: #ff6b6b; }
  .ctrl.danger:hover { background: rgba(255,107,107,0.12); border-color: rgba(255,107,107,0.4); color: #ff6b6b; }

  /* Volume */
  .vol-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .vol-slider {
    -webkit-appearance: none;
    width: 60px;
    height: 3px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .vol-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }
  .vol-slider::-moz-range-thumb {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
  }

  /* Extra actions */
  .actions {
    display: flex;
    gap: 6px;
    padding: 4px 4px 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border-radius: 999px;
    background: var(--bg-raise);
    color: var(--text-dim);
    text-decoration: none;
    font-weight: 500;
    font-size: 11px;
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .btn:hover { color: var(--accent); border-color: var(--border-accent); }

  .footer {
    padding: 10px 4px 0;
    font-size: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .share {
    font-family: 'SF Mono', Consolas, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
    opacity: 0.6;
  }
  .brand {
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--accent);
  }
  .brand::before { content: '♪ '; opacity: 0.7; }

  /* Sub-controls row (local-only) */
  .sub-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 2px 4px 10px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--text-dim);
  }
  .divider { opacity: 0.25; }
  .speed-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
  .speed-btn {
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 500;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    cursor: pointer;
  }
  .speed-btn:hover { color: var(--accent); border-color: var(--border-accent); }
  .speed-btn.active { background: var(--accent); color: #000; border-color: var(--accent); }
  .ctrl.small { width: 28px; height: 28px; font-size: 11px; }

  .bot-status-row {
    text-align: center;
    padding: 6px 8px 4px;
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  #bot-status {
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.3px;
  }

  /* Visualizer bars under disc */
  .viz {
    display: flex;
    gap: 2px;
    justify-content: center;
    align-items: flex-end;
    height: 16px;
    margin: 0 auto 6px;
    opacity: 0.5;
  }
  .viz-bar {
    width: 2px;
    background: var(--accent);
    border-radius: 1px;
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

  /* User chip */
  .user-bar {
    position: absolute;
    top: 10px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 3px;
    background: var(--bg-raise);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 10px;
    font-weight: 500;
    z-index: 2;
  }
  .user-avatar { width: 18px; height: 18px; border-radius: 50%; }
  .user-name {
    color: var(--text-dim);
    max-width: 70px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .user-logout {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 11px;
    padding: 0 3px;
  }
  .user-logout:hover { color: #ff6b6b; }

  @media (max-width: 480px) {
    .disc { width: 150px; height: 150px; }
    .player { max-width: 100%; padding: 14px; }
    .vol-slider { width: 44px; }
    h1 { font-size: 15px; }
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
      <button class="ctrl" id="bot-shuffle" title="Shuffle queue (bot)">🔀</button>
      <button class="ctrl primary" id="playpause" title="Pause / Resume (bot)">⏸</button>
      <button class="ctrl" id="bot-skip" title="Skip song (bot)">⏭</button>
      <button class="ctrl" id="bot-loop" title="Toggle loop (bot)">🔁</button>
      <button class="ctrl danger" id="bot-stop" title="Stop & leave (bot)">⏹</button>
    </div>

    <div class="sub-controls">
      <button class="ctrl small" id="mute" title="Mute local playback (just you)">🔇</button>
      <div class="vol-wrap">
        <span id="vol-icon">🔊</span>
        <input type="range" min="0" max="100" value="80" class="vol-slider" id="vol">
      </div>
      <span class="divider">·</span>
      <span class="speed-label">Speed:</span>
      <button class="speed-btn" data-rate="0.5">0.5×</button>
      <button class="speed-btn active" data-rate="1">1×</button>
      <button class="speed-btn" data-rate="1.5">1.5×</button>
      <button class="speed-btn" data-rate="2">2×</button>
    </div>

    <div class="bot-status-row">
      <span id="bot-status">🤖 These controls play for everyone in the voice call</span>
    </div>

    <div class="actions">
      ${uri ? `<a class="btn" href="${uri}" target="_blank">▶ Open source</a>` : ''}
      <button class="btn" onclick="navigator.clipboard.writeText('${share}').then(()=>this.textContent='✓ copied')">🔗 Copy link</button>
    </div>


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

    // ===== BOT control (affects everyone in the voice call) =====
    const GUILD_ID = '${guildId}';
    const DEFAULT_STATUS = '🤖 These controls play for everyone in the voice call';
    async function botAction(action) {
      const status = document.getElementById('bot-status');
      if (!GUILD_ID) { status.textContent = '⚠ no voice session'; return; }
      status.textContent = '⏳ sending to bot...';
      try {
        const r = await fetch('/control', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ guild_id: GUILD_ID, action }),
        });
        const j = await r.json();
        status.textContent = r.ok ? '✓ ' + action + ' sent to bot' : ('⚠ ' + (j.error || 'failed'));
        setTimeout(() => { status.textContent = DEFAULT_STATUS; }, 2500);
      } catch (e) {
        status.textContent = '⚠ ' + e.message;
      }
    }

    // Play/Pause — controls BOT + local iframe
    document.getElementById('playpause').onclick = async () => {
      const btn = document.getElementById('playpause');
      // Mirror locally
      if (player) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) { player.pauseVideo(); btn.textContent = '▶'; }
        else { player.playVideo(); btn.textContent = '⏸'; }
      }
      // Send to bot
      await botAction('pause');
    };

    // Skip — bot only (local iframe would just stop)
    document.getElementById('bot-skip').onclick = () => botAction('skip');

    // Shuffle — bot only
    document.getElementById('bot-shuffle').onclick = () => botAction('shuffle');

    // Loop — bot only
    document.getElementById('bot-loop').onclick = () => botAction('loop');

    // Stop — bot only (also stops local iframe)
    document.getElementById('bot-stop').onclick = async () => {
      if (player) player.stopVideo();
      await botAction('stop');
    };

    // ===== LOCAL-only controls (just the viewer's browser) =====
    document.getElementById('mute').onclick = () => {
      if (!player) return;
      const btn = document.getElementById('mute');
      if (player.isMuted()) { player.unMute(); btn.textContent = '🔊'; }
      else { player.mute(); btn.textContent = '🔇'; }
    };
    document.getElementById('vol').oninput = (e) => { if (player) player.setVolume(e.target.value); };
    document.getElementById('progress').onclick = (e) => {
      if (!player) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      player.seekTo(pct * player.getDuration(), true);
    };
    document.querySelectorAll('.speed-btn').forEach(b => {
      b.onclick = () => {
        if (!player) return;
        player.setPlaybackRate(parseFloat(b.dataset.rate));
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
