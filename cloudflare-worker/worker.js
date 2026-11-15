// kitty-songs — Cloudflare Worker
// POST /create  { title, author, uri, thumbnail, duration_ms, requested_by }
//   → { id, url }
// GET /s/:id    → HTML page
//
// Env bindings:
//   SONGS    — KV namespace
//   SECRET   — auth secret (set via: wrangler secret put SECRET)

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
      await env.SONGS.put(id, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 7 }); // 7 days
      return json({ id, url: `${url.origin}/s/${id}` });
    }

    // ---- Fetch a song page (ONE-TIME USE) ----
    if (url.pathname.startsWith('/s/')) {
      const id = url.pathname.slice(3);
      const raw = await env.SONGS.get(id);
      if (!raw) return htmlPage(expiredPage(), 410);
      try {
        const song = JSON.parse(raw);
        // Skip consumption for link preview bots (Discord, Twitter, etc)
        // so first real human click still gets the page.
        const ua = (request.headers.get('User-Agent') || '').toLowerCase();
        const isBot = /discordbot|twitterbot|facebookexternalhit|slackbot|telegrambot|whatsapp|linkedinbot|bot\/|crawler|spider/.test(ua);
        if (!isBot) {
          // Burn the link — one-time use
          await env.SONGS.delete(id);
        }
        return htmlPage(renderPage(song, id, url.origin));
      } catch {
        return htmlPage(expiredPage(), 500);
      }
    }

    // ---- Root ----
    if (url.pathname === '/') {
      return htmlPage(landingPage(url.origin));
    }

    return new Response('404', { status: 404 });
  },
};

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

function renderPage(song, id, origin) {
  const title = esc(song.title);
  const author = esc(song.author || '');
  const uri = esc(song.uri || '');
  const thumb = esc(song.thumbnail || '');
  const duration = fmtDuration(song.duration_ms);
  const requestedBy = esc(song.requested_by || '');
  const share = esc(`${origin}/s/${id}`);
  const ytId = extractYtId(song.uri);
  const searchQ = buildYtSearchQuery(song);

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
    --aqua-pink-top: #ffb3e6;
    --aqua-pink: #ff66cc;
    --aqua-pink-dark: #cc3399;
    --chrome-light: #f8f8ff;
    --chrome-mid: #d0d0e0;
    --chrome-dark: #808090;
    --glass: rgba(255, 245, 252, 0.55);
    --glass-ring: rgba(255, 180, 230, 0.8);
    --text-dark: #2a1830;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: 'Segoe UI', 'Frutiger', Tahoma, sans-serif;
    background:
      radial-gradient(ellipse at 20% 20%, rgba(180, 230, 255, 0.6), transparent 50%),
      radial-gradient(ellipse at 80% 70%, rgba(255, 180, 230, 0.7), transparent 50%),
      radial-gradient(ellipse at 50% 100%, rgba(170, 255, 200, 0.4), transparent 60%),
      linear-gradient(180deg, #a5e3ff 0%, #ffd9f0 50%, #ffeefe 100%);
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
    background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.9), rgba(255,180,230,0.2) 60%, transparent);
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
      linear-gradient(180deg, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0.4) 48%, rgba(255,240,250,0.35) 52%, rgba(255,210,240,0.5) 100%),
      linear-gradient(180deg, var(--aqua-pink-top), var(--aqua-pink));
    border: 1px solid rgba(255,255,255,0.9);
    border-radius: 20px;
    padding: 18px;
    box-shadow:
      inset 0 2px 0 rgba(255,255,255,1),
      inset 0 -2px 0 rgba(255,100,200,0.4),
      0 20px 60px rgba(255,102,204,0.35),
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
      linear-gradient(180deg, #ffb3e6 0%, #ff66cc 50%, #cc3399 100%);
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
      radial-gradient(circle at 50% 25%, #ffd9f0, #ff66cc 55%, #99266b);
    color: #fff;
    font-size: 24px;
    text-shadow: 0 1px 1px rgba(0,0,0,0.3);
    border: 1px solid rgba(100,0,50,0.5);
    box-shadow:
      inset 0 2px 0 rgba(255,255,255,0.7),
      inset 0 -3px 3px rgba(100,0,50,0.4),
      0 4px 12px rgba(200,0,100,0.5),
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
    background: radial-gradient(circle at 50% 30%, #fff, #ff66cc 70%, #cc3399);
    border: 1px solid rgba(100,0,50,0.5);
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  .vol-slider::-moz-range-thumb {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 30%, #fff, #ff66cc 70%, #cc3399);
    border: 1px solid rgba(100,0,50,0.5);
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
      linear-gradient(180deg, rgba(255,255,255,0.85), rgba(255,220,240,0.6));
    color: var(--text-dark);
    text-decoration: none;
    font-weight: 600;
    font-size: 12px;
    border: 1px solid rgba(255,100,200,0.5);
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

  @media (max-width: 480px) {
    .disc { width: 170px; height: 170px; }
    .controls { gap: 6px; }
    .ctrl { width: 42px; height: 42px; font-size: 14px; }
    .ctrl.primary { width: 54px; height: 54px; font-size: 20px; }
    .vol-slider { width: 50px; }
    h1 { font-size: 18px; }
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

    <div class="progress-wrap">
      <span class="time" id="time-cur">0:00</span>
      <div class="progress" id="progress"><div class="progress-bar" id="bar"></div></div>
      <span class="time" id="time-tot">0:00</span>
    </div>

    <div class="controls">
      <button class="ctrl" id="back10" title="Back 10s">⏪</button>
      <button class="ctrl primary" id="playpause" title="Play/Pause">⏸</button>
      <button class="ctrl" id="fwd10" title="Forward 10s">⏩</button>
      <div class="vol-wrap">
        <span>🔊</span>
        <input type="range" min="0" max="100" value="80" class="vol-slider" id="vol">
      </div>
    </div>

    <div class="actions">
      ${uri ? `<a class="btn" href="${uri}" target="_blank">▶ Open source</a>` : ''}
      <button class="btn" onclick="navigator.clipboard.writeText('${share}').then(()=>this.textContent='✓ copied')">🔗 Copy link</button>
    </div>

    <div class="footer">
      <span class="brand">kitty discplayer</span>
      <span class="share">${share}</span>
    </div>
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
        // Fallback: search YouTube for the song, play first result
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

    function onStateChange(e) {
      const btn = document.getElementById('playpause');
      if (e.data === YT.PlayerState.PLAYING) {
        btn.textContent = '⏸';
        disc.classList.add('playing');
      } else if (e.data === YT.PlayerState.PAUSED) {
        btn.textContent = '▶';
        disc.classList.remove('playing');
      } else if (e.data === YT.PlayerState.ENDED) {
        btn.textContent = '↻';
        disc.classList.remove('playing');
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

function landingPage(origin) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>kitty songs</title>
<style>
  body { font-family: system-ui; background: #0a0514; color: #fff; display:grid; place-items:center; height:100vh; margin:0; }
  h1 { color: #ff66cc; font-size: 48px; }
  p { opacity: 0.6; }
</style></head>
<body><div style="text-align:center">
<h1>🎵 kitty songs</h1>
<p>Share links to songs the bot is playing.</p>
<p style="font-size:12px; margin-top:20px">Served from <code>${origin}</code></p>
</div></body></html>`;
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
