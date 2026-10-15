# Tactics Suite Discord bot

A Discord bot you host yourself, so the WoWs Tactics Suite can share plans to
your own server.

Members press **Connect Discord** in the suite's Settings once, sign in with
Discord, and can then share a plan straight into a channel. The bot posts it
under their name, and only in channels where they could post themselves.
`/release` posts the suite's latest patch notes in the channel it is used in.

## What you need

- A server reachable on ports 80 and 443 (any small VPS), with Docker.
- A hostname pointing at it. Without a domain,
  `bot.<ip-with-dashes>.sslip.io` works with no DNS setup, for example
  `bot.203-0-113-10.sslip.io`.

## 1. Create the Discord application

At <https://discord.com/developers/applications>, create a **New Application** and copy:

- the **Application ID** (General Information)
- the bot **Token** (Bot → Reset Token)
- the **Client Secret** (OAuth2), and add `https://<your-host>/link/callback` under **Redirects** on the same tab

Recommended: make the bot private so only you can add it to a server. Set
**Installation → Install Link** to **None**, then turn off **Bot → Public
Bot**.

## 2. Configure and start

```bash
git clone https://github.com/LeCyanide/tactics-suite-discord-bit.git
cd tactics-suite-discord-bit
cp .env.example .env    # fill it in
docker compose up -d --build
```

| Variable | What it is |
| --- | --- |
| `DISCORD_TOKEN` | The bot token |
| `DISCORD_APP_ID` | The application ID |
| `DISCORD_CLIENT_SECRET` | The OAuth2 client secret |
| `PUBLIC_URL` | `https://<your-host>` |
| `BOT_DOMAIN` | `<your-host>` |
| `UPDATE_URL`, `UPDATE_TOKEN` | Optional, for `/release`: the suite's update server. Without them `/release` says it is not set up. |

Caddy, started alongside the bot, gets the HTTPS certificate on its own.
Check that it is up with `curl https://<your-host>/health`, and watch the log
with `docker compose logs -f bot`. To update later:
`git pull && docker compose up -d --build`.

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

Each member enters `https://<your-host>` under **Settings → Share to Discord →
Bot** in the suite, then presses **Connect Discord**.

## Without Docker

Node.js 24 or newer:

```bash
npm ci && npm run build && npm start
```

Put an HTTPS reverse proxy in front: `deploy/Caddyfile` is a ready-made site
block, and only `/plan`, `/health` and `/link/*` need to be public.
`deploy/tactics-bot.service` runs it under systemd. Set `HTTP_HOST`,
`HTTP_PORT` and `DB_PATH` in `.env` if the defaults don't suit.

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
