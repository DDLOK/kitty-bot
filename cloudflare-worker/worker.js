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

function renderPage(song, id, origin) {
  const title = esc(song.title);
  const author = esc(song.author || '');
  const uri = esc(song.uri || '');
  const thumb = esc(song.thumbnail || '');
  const duration = fmtDuration(song.duration_ms);
  const requestedBy = esc(song.requested_by || '');
  const share = esc(`${origin}/s/${id}`);
  const ytId = extractYtId(song.uri);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — kitty</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${author}${duration ? ' • ' + duration : ''}">
${thumb ? `<meta property="og:image" content="${thumb}">` : ''}
<meta name="theme-color" content="#ff66cc">
<style>
  :root { color-scheme: dark; --pink: #ff66cc; --pink-soft: rgba(255,102,204,0.15); --pink-ring: rgba(255,102,204,0.4); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: radial-gradient(ellipse at top, #2a1030 0%, #0a0514 60%, #000 100%);
    min-height: 100vh;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(20px);
    border: 1px solid var(--pink-ring);
    border-radius: 24px;
    max-width: 560px;
    width: 100%;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(255, 102, 204, 0.2);
  }
  .player-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 16/9;
    background: #000;
  }
  #yt-player, .art-fallback {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
    background-size: cover;
    background-position: center;
  }
  .meta { padding: 20px 24px 8px; }
  h1 { font-size: 22px; margin-bottom: 4px; color: var(--pink); line-height: 1.2; }
  .author { font-size: 14px; opacity: 0.7; margin-bottom: 14px; }

  /* Progress bar */
  .progress-wrap {
    padding: 0 24px 10px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .time {
    font-size: 11px;
    font-family: 'SF Mono', Monaco, monospace;
    opacity: 0.6;
    min-width: 36px;
  }
  .progress {
    flex: 1;
    height: 5px;
    background: rgba(255,255,255,0.08);
    border-radius: 999px;
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    width: 0%;
    background: var(--pink);
    border-radius: 999px;
    transition: width 0.3s linear;
  }

  /* Controls */
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 4px 24px 18px;
  }
  .ctrl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--pink-soft);
    color: var(--pink);
    border: 1px solid var(--pink-ring);
    cursor: pointer;
    font-size: 16px;
    transition: all 0.15s;
  }
  .ctrl:hover { background: rgba(255,102,204,0.3); transform: scale(1.08); }
  .ctrl.primary {
    width: 56px; height: 56px;
    background: var(--pink);
    color: #000;
    font-size: 20px;
  }
  .ctrl.primary:hover { background: #ff80d9; }

  .vol-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 12px;
  }
  .vol-slider {
    -webkit-appearance: none;
    width: 70px;
    height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 999px;
    outline: none;
  }
  .vol-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--pink);
    cursor: pointer;
  }
  .vol-slider::-moz-range-thumb {
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--pink);
    cursor: pointer;
    border: none;
  }

  /* Extra actions */
  .actions {
    display: flex;
    gap: 10px;
    padding: 0 24px 16px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--pink-soft);
    color: var(--pink);
    text-decoration: none;
    font-weight: 600;
    font-size: 12px;
    border: 1px solid var(--pink-ring);
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { background: rgba(255,102,204,0.3); }

  .footer {
    padding: 12px 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 11px;
    opacity: 0.5;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .share {
    font-family: 'SF Mono', Monaco, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 480px) {
    .controls { gap: 4px; }
    .ctrl { width: 40px; height: 40px; }
    .ctrl.primary { width: 50px; height: 50px; }
    .vol-wrap { margin-left: 4px; }
    .vol-slider { width: 50px; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="player-wrap">
      ${ytId
        ? `<div id="yt-player"></div>`
        : `<div class="art-fallback" style="background-image: url('${thumb}')"></div>`
      }
    </div>

    <div class="meta">
      <h1>${title}</h1>
      <div class="author">${author}${duration ? ' • ' + duration : ''}</div>
    </div>

    ${ytId ? `
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
    ` : ''}

    <div class="actions">
      ${uri ? `<a class="btn" href="${uri}" target="_blank">▶ Open source</a>` : ''}
      <button class="btn" onclick="navigator.clipboard.writeText('${share}').then(()=>this.textContent='✓ copied')">🔗 Copy link</button>
      ${ytId ? `<button class="btn" id="fullscreen">⛶ Fullscreen</button>` : ''}
    </div>

    <div class="footer">
      <span>${requestedBy ? 'queued by ' + requestedBy : 'kitty webplay'}</span>
      <span class="share">${share}</span>
    </div>
  </div>

  ${ytId ? `
  <script>
    let player;
    let progressTimer;

    function onYouTubeIframeAPIReady() {
      player = new YT.Player('yt-player', {
        videoId: '${ytId}',
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          showinfo: 0,
          iv_load_policy: 3,
        },
        events: {
          onReady: onReady,
          onStateChange: onStateChange,
        },
      });
    }

    function onReady(e) {
      e.target.setVolume(80);
      document.getElementById('time-tot').textContent = fmt(e.target.getDuration());
      progressTimer = setInterval(updateProgress, 500);
    }

    function onStateChange(e) {
      const btn = document.getElementById('playpause');
      if (e.data === YT.PlayerState.PLAYING) btn.textContent = '⏸';
      else if (e.data === YT.PlayerState.PAUSED) btn.textContent = '▶';
      else if (e.data === YT.PlayerState.ENDED) btn.textContent = '↻';
    }

    function updateProgress() {
      if (!player || !player.getCurrentTime) return;
      const cur = player.getCurrentTime();
      const tot = player.getDuration();
      if (!tot) return;
      const pct = (cur / tot) * 100;
      document.getElementById('bar').style.width = pct + '%';
      document.getElementById('time-cur').textContent = fmt(cur);
    }

    function fmt(s) {
      s = Math.floor(s);
      const m = Math.floor(s / 60);
      return m + ':' + String(s % 60).padStart(2, '0');
    }

    document.getElementById('playpause').onclick = () => {
      const state = player.getPlayerState();
      if (state === YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    };
    document.getElementById('back10').onclick = () => {
      player.seekTo(Math.max(0, player.getCurrentTime() - 10), true);
    };
    document.getElementById('fwd10').onclick = () => {
      player.seekTo(Math.min(player.getDuration(), player.getCurrentTime() + 10), true);
    };
    document.getElementById('vol').oninput = (e) => {
      player.setVolume(e.target.value);
    };
    document.getElementById('progress').onclick = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      player.seekTo(pct * player.getDuration(), true);
    };
    const fsBtn = document.getElementById('fullscreen');
    if (fsBtn) fsBtn.onclick = () => {
      const el = document.getElementById('yt-player');
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    };

    // Load YT API
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);
  </script>
  ` : ''}
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
