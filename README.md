# Tactics Suite Discord bot

A small Discord bot you host yourself, so the WoWs Tactics Suite can share
plans to your own Discord server.

It does two things:

- **Connect Discord.** The suite's Settings has a Connect Discord button. It
  signs the person in with Discord, and that copy of the app gets its own
  token from this bot.
- **Share to Discord.** The app renders a plan and sends the image here. The
  bot posts it in the chosen channel, under the name of the person who shared
  it.

A linked app can only post where its owner could post themselves. That means
channels where the person can view, send messages and attach files, and where
the bot can as well. Membership and roles are checked fresh on every request.
The bot has no slash commands and doesn't read messages.

## What you need

- A machine reachable from the internet on ports 80 and 443, such as a small
  VPS.
- A hostname that points at it, for example `bot.example.com`. If you don't
  have a domain, `<anything>.<ip-with-dashes>.sslip.io` resolves to that IP
  with no DNS setup: `bot.203-0-113-10.sslip.io`.
- Either Docker with Compose, or Node.js 24 or newer plus a reverse proxy
  that terminates HTTPS.

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and choose
   **New Application**.
2. **General Information**: copy the **Application ID**.
3. **Bot**: choose **Reset Token** and copy the token. No privileged intents
   are needed, so leave all three off.
4. **OAuth2**: copy the **Client Secret**. Under **Redirects**, add
   `https://<your-host>/link/callback`.
5. Recommended: make the bot private, so nobody else can add your instance
   to their server. On **Installation**, set **Install Link** to **None**
   (Discord won't turn off Public Bot while an install link is set). Then on
   **Bot**, turn off **Public Bot**. After that, only you (or members of the
   application's team) can add the bot to a server.

## 2. Configure

```bash
git clone https://github.com/LeCyanide/tactics-suite-discord-bot.git
cd tactics-suite-discord-bot
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
| --- | --- |
| `DISCORD_TOKEN` | The bot token |
| `DISCORD_APP_ID` | The application ID |
| `DISCORD_CLIENT_SECRET` | The OAuth2 client secret |
| `PUBLIC_URL` | `https://<your-host>`, with no path |
| `BOT_DOMAIN` | `<your-host>`. Only Docker Compose reads this |

`.env` holds the bot token and the client secret. Keep it out of version
control (it's already gitignored) and readable only by you.

## 3. Run it

### With Docker Compose (recommended)

```bash
docker compose up -d --build
docker compose logs -f bot
```

This runs the bot and Caddy. Caddy fetches the HTTPS certificate for
`BOT_DOMAIN` and renews it on its own. The bot's data is kept in a Docker
volume, so it survives rebuilds.

To update later:

```bash
git pull && docker compose up -d --build
```

### Without Docker

```bash
npm ci
npm run build
npm start
```

`deploy/tactics-bot.service` is a systemd unit for running it as a service,
with the setup steps at the top of the file. Put a reverse proxy with HTTPS
in front of it. `deploy/Caddyfile` is a ready-made site block: set
`BOT_DOMAIN` in Caddy's environment, or replace it with your hostname. Only
`/plan`, `/health` and `/link/*` need to be public.

### Check it is up

```bash
curl -s https://<your-host>/health
# {"ok":true,"ready":true,"linking":true}
```

## 4. Add the bot to your server

When the bot first starts and isn't in any server yet, it logs an invite
link. You can also build the link yourself:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=52224
```

`52224` is View Channel, Send Messages, Embed Links and Attach Files, which
is all a plan post needs. Channel overrides decide where it can actually
post.

## 5. Point the suite at it

In the suite, open **Settings**. Under **Discord**, enter `https://<your-host>`
as the bot address, then press **Connect Discord**. Everyone in your
community does this once on their own copy.

## How it is put together

| File | What it does |
| --- | --- |
| `src/index.ts` | Entry point: opens the database and connects |
| `src/http.ts` | The endpoints: `/health`, `/plan` and `/link/*` |
| `src/link.ts` | The Connect Discord sign-in and the per-person permission checks |
| `src/db.ts`, `src/migrations.ts` | One SQLite file holding which app tokens belong to whom |
| `src/config.ts` | Reads and checks `.env` |

The sign-in, step by step:

1. The app picks a loopback port and opens the browser at
   `/link/start?port=…&challenge=…`. That redirects to Discord's consent page,
   asking for `identify` and nothing else.
2. Discord sends the browser back to `/link/callback`. The bot swaps the code
   for the person's id and checks they share a server with the bot. It then
   gives the Discord access token back and redirects to
   `http://127.0.0.1:<port>/callback` with a one-time grant.
3. The app posts the grant and its verifier to `/link/finish` and gets its
   token. Only a SHA-256 of that token is stored.

The answer goes through the browser to the person's own machine. So a
sign-in link sent to someone else links nothing, and the grant is useless
without the verifier only the app knows. `POST /link/revoke` is the app's
Disconnect button.

## Development

```bash
npm run typecheck
npm run selftest    # headless checks of the endpoints and the sign-in, against stubs
npm run dev         # runs from source and restarts on changes
```

## License

MIT. See `LICENSE`.
