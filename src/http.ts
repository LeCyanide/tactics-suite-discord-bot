/**
 * The endpoints the suite talks to: linking a copy of the app to a Discord
 * account (see link.ts), and pushing plans.
 *
 * The direction matters: the bot runs on the VPS and the app's projects live
 * in a store on someone's own machine, so the bot cannot fetch a plan. The
 * app renders its Konva stage to a PNG and posts it here.
 *
 * A plan arrives with the token a linked app was given, and may be posted
 * only where that app's owner could post it themselves.
 *
 * Bound to localhost by default: a reverse proxy in front terminates TLS, and
 * there is no reason for this to face the internet directly.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { Server } from 'node:net';
import { AttachmentBuilder, EmbedBuilder, type Client } from 'discord.js';
import type { Config } from './config.ts';
import type { Database } from './db.ts';
import { Linker, type LinkedUser } from './link.ts';
import { log } from './log.ts';

/** Discord accepts larger, but a tactical map that big is a mistake. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4);

/** Crude but sufficient: one bot serves one community's copies of the app. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

interface PlanRequest {
  readonly channelId: string;
  readonly title: string;
  readonly note?: string;
  readonly image: string;
}

function limiter(limit: number): () => boolean {
  let recent: number[] = [];
  return () => {
    const now = Date.now();
    recent = recent.filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= limit) return true;
    recent.push(now);
    return false;
  };
}

const planLimited = limiter(RATE_LIMIT);
/** Sign-ins and channel lists are small, and one sign-in is several requests. */
const linkLimited = limiter(RATE_LIMIT * 6);

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

/** For the one case with no app to send the browser back to. */
function sendPage(response: ServerResponse, status: number, heading: string, text: string): void {
  const payload =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>WoWs Tactics Suite</title><body style="font:16px system-ui;background:#0d1117;color:#e6edf3;' +
    'display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:28em;padding:24px">' +
    `<h1 style="font-size:20px">${heading}</h1><p style="color:#9aa7b4">${text}</p></main>`;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function parsePlan(raw: string): PlanRequest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'body is not JSON';
  }

  if (typeof parsed !== 'object' || parsed === null) return 'body is not an object';
  const body = parsed as Record<string, unknown>;

  if (typeof body.channelId !== 'string' || !/^\d{5,25}$/.test(body.channelId)) return 'channelId is missing or not an id';
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return 'title is missing';
  if (typeof body.image !== 'string' || body.image.length === 0) return 'image is missing';
  if (body.note !== undefined && typeof body.note !== 'string') return 'note must be text';

  return {
    channelId: body.channelId,
    title: body.title.trim().slice(0, 240),
    note: typeof body.note === 'string' ? body.note.slice(0, 1800) : undefined,
    image: body.image,
  };
}

function decodeImage(image: string): Buffer | string {
  const base64 = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const buffer = Buffer.from(base64, 'base64');

  if (buffer.length === 0) return 'image did not decode';
  if (buffer.length > MAX_IMAGE_BYTES) return `image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`;

  // PNG magic number. Anything else is not something to hand to Discord.
  const png = buffer.subarray(0, 8);
  if (!png.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image is not a PNG';

  return buffer;
}

async function postPlan(
  client: Client,
  plan: PlanRequest,
  image: Buffer,
  sharedBy: LinkedUser,
): Promise<string | null> {
  const channel = await client.channels.fetch(plan.channelId).catch(() => null);
  if (channel === null || !channel.isTextBased() || !('send' in channel)) return null;

  const file = new AttachmentBuilder(image, { name: 'plan.png' });

  const embed = new EmbedBuilder()
    .setTitle(plan.title)
    .setColor(0x2f3136)
    .setImage('attachment://plan.png')
    .setFooter({ text: `Shared by ${sharedBy.name} from the WoWs Tactics Suite` });

  if (plan.note !== undefined && plan.note.length > 0) embed.setDescription(plan.note);

  const message = await channel.send({ embeds: [embed], files: [file] });
  return message.url;
}

export function startHttpServer(
  client: Client,
  config: Config,
  db: Database,
  linker: Linker = Linker.fromConfig(client, db, config),
): Server {
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch((error: unknown) => {
      log.error('http endpoint threw', error);
      if (!response.headersSent) send(response, 500, { error: 'internal error' });
    });
  };

  // HTTPS itself only where nothing in front terminates it: on a hosting
  // panel behind Cloudflare, with an origin certificate.
  const server =
    config.tls === null
      ? createServer(listener)
      : createTlsServer({ cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }, listener);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /health') {
      send(response, 200, { ok: true, ready: client.isReady(), linking: true });
      return;
    }

    if (url.pathname.startsWith('/link/')) {
      await handleLink(route, url, request, response);
      return;
    }

    if (route !== 'POST /plan') {
      send(response, 404, { error: 'not found' });
      return;
    }

    const user = linker.userFor(bearer(request));
    if (user === null) {
      // Not logged with the request body: a wrong token is usually a
      // misconfigured client, and the body may be a megabyte of image.
      log.warn('plan endpoint: rejected a request with a bad or missing token');
      send(response, 401, { error: 'unauthorised' });
      return;
    }

    if (planLimited()) {
      send(response, 429, { error: 'too many requests' });
      return;
    }

    const raw = await readBody(request);
    if (raw === null) {
      send(response, 413, { error: 'body too large' });
      return;
    }

    const plan = parsePlan(raw);
    if (typeof plan === 'string') {
      send(response, 400, { error: plan });
      return;
    }

    const image = decodeImage(plan.image);
    if (typeof image === 'string') {
      send(response, 400, { error: image });
      return;
    }

    if (!client.isReady()) {
      send(response, 503, { error: 'not connected to Discord yet' });
      return;
    }

    if (!(await linker.canPost(user.id, plan.channelId))) {
      send(response, 403, { error: 'you cannot post in that channel' });
      return;
    }

    const posted = await postPlan(client, plan, image, user);
    if (posted === null) {
      send(response, 404, { error: 'I cannot post in that channel' });
      return;
    }

    log.info(`posted a plan to channel ${plan.channelId} for ${user.name} (${Math.round(image.length / 1024)}kb)`);
    send(response, 200, { ok: true, url: posted });
  }

  async function handleLink(
    route: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (linkLimited()) {
      send(response, 429, { error: 'too many requests' });
      return;
    }

    if (route === 'GET /link/start') {
      const location = linker.begin(Number(url.searchParams.get('port')), url.searchParams.get('challenge') ?? '');
      if (location === null) {
        sendPage(response, 400, 'That did not come from the app', 'Press Connect Discord in the suite to start again.');
        return;
      }
      redirect(response, location);
      return;
    }

    if (route === 'GET /link/callback') {
      if (!client.isReady()) {
        sendPage(response, 503, 'The bot is still starting', 'Give it a moment, then press Connect Discord again.');
        return;
      }
      const outcome = await linker.complete(url.searchParams);
      if (outcome.kind === 'expired') {
        sendPage(response, 400, 'This sign-in has expired', 'Press Connect Discord in the suite to start again.');
        return;
      }
      redirect(response, outcome.location);
      return;
    }

    if (route === 'POST /link/finish') {
      const raw = await readBody(request);
      let body: { grant?: unknown; verifier?: unknown } | null = null;
      try {
        body = JSON.parse(raw ?? '') as { grant?: unknown; verifier?: unknown } | null;
      } catch {
        /* falls through to the refusal below */
      }
      const linked =
        typeof body?.grant === 'string' && typeof body.verifier === 'string'
          ? linker.finish(body.grant, body.verifier)
          : null;
      if (linked === null) {
        send(response, 400, { error: 'that sign-in is not valid any more' });
        return;
      }
      send(response, 200, { ok: true, ...linked });
      return;
    }

    if (route === 'GET /link/me' || route === 'POST /link/revoke') {
      const token = bearer(request);
      const user = linker.userFor(token);
      if (user === null) {
        send(response, 401, { error: 'unauthorised' });
        return;
      }

      if (route === 'POST /link/revoke') {
        linker.revoke(token);
        log.info(`link: ${user.name} (${user.id}) unlinked a copy of the suite`);
        send(response, 200, { ok: true });
        return;
      }

      if (!client.isReady()) {
        send(response, 503, { error: 'not connected to Discord yet' });
        return;
      }
      send(response, 200, { ok: true, user, guilds: await linker.postable(user.id) });
      return;
    }

    send(response, 404, { error: 'not found' });
  }

  server.listen(config.httpPort, config.httpHost, () => {
    const scheme = config.tls === null ? 'http' : 'https';
    log.info(`plan endpoint listening on ${scheme}://${config.httpHost}:${config.httpPort}`);
  });

  return server;
}
