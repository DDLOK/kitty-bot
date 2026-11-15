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

function ytEmbed(uri) {
  if (!uri) return '';
  const m = uri.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!m) return '';
  return `<iframe class="player" src="https://www.youtube.com/embed/${m[1]}?autoplay=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
}

function renderPage(song, id, origin) {
  const title = esc(song.title);
  const author = esc(song.author || '');
  const uri = esc(song.uri || '');
  const thumb = esc(song.thumbnail || '');
  const duration = fmtDuration(song.duration_ms);
  const requestedBy = esc(song.requested_by || '');
  const share = esc(`${origin}/s/${id}`);
  const embed = ytEmbed(song.uri);

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
  :root { color-scheme: dark; }
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
    border: 1px solid rgba(255, 102, 204, 0.3);
    border-radius: 24px;
    max-width: 540px;
    width: 100%;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(255, 102, 204, 0.15);
  }
  .art {
    width: 100%;
    aspect-ratio: 16/9;
    background-size: cover;
    background-position: center;
    position: relative;
  }
  .art::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(0,0,0,0.7), transparent 50%);
  }
  .player {
    width: 100%;
    aspect-ratio: 16/9;
    border: none;
    display: block;
  }
  .meta {
    padding: 24px 28px;
  }
  h1 {
    font-size: 24px;
    margin-bottom: 6px;
    color: #ff66cc;
  }
  .author {
    font-size: 15px;
    opacity: 0.7;
    margin-bottom: 18px;
  }
  .row {
    display: flex;
    gap: 12px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 999px;
    background: rgba(255, 102, 204, 0.15);
    color: #ff66cc;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border: 1px solid rgba(255, 102, 204, 0.4);
    transition: all 0.15s;
  }
  .btn:hover { background: rgba(255, 102, 204, 0.3); transform: translateY(-1px); }
  .btn.primary { background: #ff66cc; color: #000; }
  .footer {
    padding: 14px 28px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 12px;
    opacity: 0.5;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .share {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 11px;
    opacity: 0.6;
  }
</style>
</head>
<body>
  <div class="card">
    ${embed || (thumb ? `<div class="art" style="background-image: url('${thumb}')"></div>` : '')}
    <div class="meta">
      <h1>${title}</h1>
      <div class="author">${author}${duration ? ' • ' + duration : ''}</div>
      <div class="row">
        ${uri ? `<a class="btn primary" href="${uri}" target="_blank">▶ Open source</a>` : ''}
        <a class="btn" href="javascript:navigator.clipboard.writeText('${share}').then(()=>this.textContent='✓ copied')">🔗 Copy link</a>
      </div>
    </div>
    <div class="footer">
      <span>${requestedBy ? 'queued by ' + requestedBy : ''}</span>
      <span class="share">${share}</span>
    </div>
  </div>
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
