# Tactics Suite Discord bot

A Discord bot you host yourself, so the WoWs Tactics Suite can share plans to
your own server.

Members press **Connect Discord** in the suite's Settings once, sign in with
Discord, and can then share a plan straight into a channel. The bot posts it
under their name, and only in channels where they could post themselves.
`/release` posts the suite's latest patch notes in the channel it is used in.

## What you need

- A server reachable on ports 80 and 443 (any small VPS).
- A hostname pointing at it (`bot.example.com` below). Without a domain,
  `bot.<ip-with-dashes>.sslip.io` works with no DNS setup, for example
  `bot.203-0-113-10.sslip.io`.

## 1. Create the Discord application

At <https://discord.com/developers/applications>, create a **New Application** and copy:

- the **Application ID** (General Information)
- the bot **Token** (Bot → Reset Token)
- the **Client Secret** (OAuth2), and add `https://bot.example.com/link/callback` under **Redirects** on the same tab

Recommended: make the bot private so only you can add it to a server. Set
**Installation → Install Link** to **None**, then turn off **Bot → Public
Bot**.

## 2. Run it

Pick one option. Commands assume a fresh Debian or Ubuntu server and a user
with `sudo`. Replace `bot.example.com` with your host.

### Option A: Docker (recommended)

1. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   ```
2. Get the bot and fill in `.env` (see [the values](#the-env-values)):
   ```bash
   git clone https://github.com/LeCyanide/tactics-suite-discord-bit.git
   cd tactics-suite-discord-bit
   cp .env.example .env
   nano .env
   ```
3. Start it. Caddy starts alongside and gets the HTTPS certificate itself:
   ```bash
   sudo docker compose up -d --build
   ```
4. Check it:
   ```bash
   curl https://bot.example.com/health    # {"ok":true,"ready":true,...}
   sudo docker compose logs -f bot
   ```

To update: `git pull && sudo docker compose up -d --build`

### Option B: Node.js and Caddy, without Docker

1. Install Node.js 24 and Caddy:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
   sudo apt install -y nodejs git caddy
   ```
   If `caddy` is not found, add its repository first:
   [caddyserver.com/docs/install](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
2. Get and build the bot:
   ```bash
   sudo git clone https://github.com/LeCyanide/tactics-suite-discord-bit.git /opt/tactics-bot
   cd /opt/tactics-bot
   sudo npm ci && sudo npm run build
   ```
3. Create its user and data folder, and fill in `.env` (see [the values](#the-env-values)):
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin tacticsbot
   sudo install -d -o tacticsbot -g tacticsbot -m 700 data
   sudo cp .env.example .env
   sudo nano .env
   sudo chown root:tacticsbot .env && sudo chmod 640 .env
   ```
4. Run it as a service:
   ```bash
   sudo cp deploy/tactics-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now tactics-bot
   ```
5. Put HTTPS in front with Caddy (this replaces Caddy's default config):
   ```bash
   sed 's/{\$BOT_DOMAIN}/bot.example.com/' deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
6. Check it:
   ```bash
   curl https://bot.example.com/health    # {"ok":true,"ready":true,...}
   journalctl -u tactics-bot -f
   ```

To update:
`cd /opt/tactics-bot && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart tactics-bot`

### The `.env` values

| Variable | What it is |
| --- | --- |
| `DISCORD_TOKEN` | The bot token |
| `DISCORD_APP_ID` | The application ID |
| `DISCORD_CLIENT_SECRET` | The OAuth2 client secret |
| `PUBLIC_URL` | `https://bot.example.com` |
| `BOT_DOMAIN` | `bot.example.com` (Docker only) |
| `UPDATE_URL`, `UPDATE_TOKEN` | Optional, for `/release`: the suite's update server. Without them `/release` says it is not set up. |

Keep `.env` private: it holds the bot token and client secret.

## 3. Add the bot to your server

On first start the bot logs an invite link. Or use:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=52224
```

That grants View Channel, Send Messages, Embed Links and Attach Files, which
is all it needs. `/release` is limited to members who can manage messages; a
server can change that under Server Settings → Integrations.

## 4. Point the suite at it

Each member enters `https://bot.example.com` under **Settings → Share to Discord →
Bot** in the suite, then presses **Connect Discord**.

## How it works

The sign-in asks Discord only who the person is. The answer goes back through
their browser to their own machine, and that copy of the app gets a token of
its own. The bot keeps only a hash of it. Every share is checked against the
person's current roles in Discord.

| File | What it does |
| --- | --- |
| `src/index.ts` | Entry point: opens the database, connects, registers `/release` |
| `src/http.ts` | The endpoints: `/health`, `/plan` and `/link/*` |
| `src/link.ts` | The Connect Discord sign-in and the per-person permission checks |
| `src/release.ts`, `src/commands/release.ts` | `/release`: fetching the patch notes and posting them |
| `src/db.ts`, `src/migrations.ts` | One SQLite file holding which app tokens belong to whom |
| `src/config.ts` | Reads and checks `.env` |

## Development

```bash
npm run typecheck
npm run selftest    # endpoints, sign-in and patch notes, against stubs
npm run dev         # runs from source, restarts on changes
```

## License

MIT. See `LICENSE`.
