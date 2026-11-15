# Self-hosted Lavalink on bot-hosting.net

Public Lavalink nodes are unreliable — half go dark every month. Fix: run your own on a second bot-hosting server. Takes ~10 minutes.

## 1. Create a Java server on bot-hosting

1. Go to bot-hosting.net dashboard → **Create server**
2. **Software / Egg**: Pick **Java Generic** (or any Java-based egg)
3. Resources: 512MB RAM minimum (1GB is better)
4. Create → opens panel

## 2. Download Lavalink

In the new server's **Console** tab, run:

```
wget -O Lavalink.jar https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar
```

## 3. Create `application.yml`

In **Files** tab → **New File** → name it `application.yml`. Paste this (change `youshallnotpass` to a random string — write it down):

```yaml
server:
  port: 2333
  address: 0.0.0.0

lavalink:
  server:
    password: "youshallnotpass"
    sources:
      youtube: true
      bandcamp: true
      soundcloud: true
      twitch: true
      vimeo: true
      http: true
      local: false
    bufferDurationMs: 400
    frameBufferDurationMs: 5000
    opusEncodingQuality: 10
    resamplingQuality: LOW
    trackStuckThresholdMs: 10000
    useSeekGhosting: true
    youtubePlaylistLoadLimit: 6
    playerUpdateInterval: 5
    youtubeSearchEnabled: true
    soundcloudSearchEnabled: true
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:1.11.5"
      repository: "https://maven.lavalink.dev/releases"

plugins:
  youtube:
    enabled: true
    clients: ["MUSIC", "ANDROID_VR", "WEB", "WEBEMBEDDED"]

logging:
  level:
    root: INFO
    lavalink: INFO
```

Save.

## 4. Startup settings

**Startup** tab:
- **Startup command**: `java -Xmx512M -jar Lavalink.jar`
- **Java version**: 17 or higher

**Start** the server. In console you should see:

```
Started Launcher in XX.XXX seconds
Lavalink is ready to accept connections.
```

## 5. Get the connection info

- **IP / Port**: In bot-hosting, the server's **Allocation** shows the IP + port. Default port in config is 2333, but bot-hosting may map it (e.g., external port `12345`). Look at the "Server Address" shown in the server's overview.
- **Password**: Whatever you put in `application.yml`

## 6. Point the music bot at it

On your **main (Python) bot-hosting server** → Variables tab → add/edit:

```
LAVALINK_URI = http://<ip-from-allocation>:<port-from-allocation>
LAVALINK_PASSWORD = youshallnotpass
```

Note: use `http://` not `https://` (self-hosted = no SSL cert).

Restart the Python bot. Console should show:

```
Lavalink node ready: http://your-ip:port
```

Done — you own your own Lavalink. No more public-node outages.

## Troubleshooting

- **"connection refused"**: Java server isn't running or port mismatch. Check Java server console is showing "Lavalink is ready".
- **"unauthorized"**: `LAVALINK_PASSWORD` doesn't match `application.yml` `password`.
- **"Out of memory"**: Bump bot-hosting resources to 1GB RAM, and raise `-Xmx512M` to `-Xmx768M`.
- **YouTube errors**: YouTube's anti-bot measures sometimes break the plugin. Update to the newest `youtube-plugin` version in `application.yml`.
