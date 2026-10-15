/**
 * Linking a copy of the suite to a Discord account.
 *
 * The sign-in people already know: a button in the app opens Discord's
 * consent page, and the app ends up holding a token of its own that stands
 * for one person rather than for the whole bot.
 *
 * The route, with the app listening on a loopback port it picked:
 *
 *   browser  GET /link/start?port&challenge   -> 302 to Discord
 *   Discord  GET /link/callback?code&state    -> 302 to 127.0.0.1:port?grant
 *   app      POST /link/finish {grant, verifier}  -> the token
 *
 * The answer goes back through the browser to 127.0.0.1 rather than being
 * polled for, so the person who approved and the app that is linked have to
 * be on the same machine: a link sent to somebody else leads their browser to
 * their own loopback, where nothing is listening. The challenge is the hash of
 * a verifier only the app knows, so a grant read off that redirect by another
 * program is worth nothing either.
 *
 * What a linked app may do is exactly what its owner may do in Discord: post
 * in channels where they can send messages and attach files themselves.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildMember } from 'discord.js';
import type { Config } from './config.ts';
import type { Database } from './db.ts';
import { log } from './log.ts';

const DISCORD_API = 'https://discord.com/api/v10';

/** Long enough to find a password manager, short enough not to pile up. */
const PENDING_TTL_MS = 10 * 60_000;
/** The app redeems a grant within a second of the redirect that carries it. */
const GRANT_TTL_MS = 2 * 60_000;
const MAX_PENDING = 500;

const MEMBER_NEEDS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
] as const;
const BOT_NEEDS = [...MEMBER_NEEDS, PermissionFlagsBits.EmbedLinks] as const;

export interface LinkedUser {
  readonly id: string;
  readonly name: string;
}

export interface LinkChannel {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
}

export interface LinkGuild {
  readonly id: string;
  readonly name: string;
  readonly channels: LinkChannel[];
}

/** Why a sign-in did not end in a link, as the app is told on its loopback. */
export type LinkFailure = 'denied' | 'discord' | 'not_member';

export type CallbackOutcome =
  | { readonly kind: 'redirect'; readonly location: string }
  /** No loopback to send anyone to: the state is unknown or has expired. */
  | { readonly kind: 'expired' };

interface Pending {
  readonly port: number;
  readonly challenge: string;
  readonly expires: number;
}

interface Grant {
  readonly user: LinkedUser;
  readonly challenge: string;
  readonly expires: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function prune<T extends { readonly expires: number }>(map: Map<string, T>): void {
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expires <= now) map.delete(key);
  }
}

export class Linker {
  private readonly pending = new Map<string, Pending>();
  private readonly grants = new Map<string, Grant>();
  private readonly redirectUri: string;
  private readonly client: Client;
  private readonly db: Database;
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;

  // Spelled out rather than parameter properties: Node runs these files by
  // stripping types, and a parameter property is code, not a type.
  constructor(
    client: Client,
    db: Database,
    appId: string,
    clientSecret: string,
    publicUrl: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = client;
    this.db = db;
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.fetchImpl = fetchImpl;
    this.redirectUri = `${publicUrl.replace(/\/+$/, '')}/link/callback`;
  }

  static fromConfig(client: Client, db: Database, config: Config): Linker {
    return new Linker(client, db, config.appId, config.clientSecret, config.publicUrl);
  }

  /**
   * Where to send the browser to sign in, or why the app's request was not
   * one this could have come from.
   */
  begin(port: number, challenge: string): string | null {
    // An unprivileged loopback port and a SHA-256 in base64url: anything else
    // did not come from the app.
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;

    prune(this.pending);
    if (this.pending.size >= MAX_PENDING) return null;

    const state = secret();
    this.pending.set(state, { port, challenge, expires: Date.now() + PENDING_TTL_MS });

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.appId,
      scope: 'identify',
      state,
      redirect_uri: this.redirectUri,
    });
    return `https://discord.com/oauth2/authorize?${query.toString()}`;
  }

  /** Discord sending the browser back, approved or not. */
  async complete(query: URLSearchParams): Promise<CallbackOutcome> {
    prune(this.pending);

    const state = query.get('state') ?? '';
    const pending = this.pending.get(state);
    if (pending === undefined) return { kind: 'expired' };
    // One use: a second visit to the same callback URL gets nothing.
    this.pending.delete(state);

    const back = (params: Record<string, string>): CallbackOutcome => ({
      kind: 'redirect',
      location: `http://127.0.0.1:${pending.port}/callback?${new URLSearchParams(params).toString()}`,
    });
    const failed = (reason: LinkFailure): CallbackOutcome => back({ error: reason });

    const code = query.get('code');
    if (code === null || code === '') return failed('denied');

    let user: LinkedUser | null;
    try {
      user = await this.identify(code);
    } catch (error) {
      log.error('link: could not exchange the code with Discord', error);
      return failed('discord');
    }
    if (user === null) return failed('discord');

    if ((await this.memberships(user.id)).length === 0) {
      log.warn(`link: ${user.name} (${user.id}) is in no server this bot serves`);
      return failed('not_member');
    }

    prune(this.grants);
    const grant = secret();
    this.grants.set(grant, { user, challenge: pending.challenge, expires: Date.now() + GRANT_TTL_MS });
    return back({ grant });
  }

  /** The app trading its grant, and proof it started the sign-in, for a token. */
  finish(grant: string, verifier: string): { token: string; user: LinkedUser } | null {
    prune(this.grants);

    const held = this.grants.get(grant);
    if (held === undefined) return null;
    this.grants.delete(grant);
    if (!sameText(sha256(verifier), held.challenge)) return null;

    // Only the hash is kept, so a copy of the database is not a set of logins.
    const token = secret();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO app_link (token_hash, user_id, user_name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), held.user.id, held.user.name, now, now);

    log.info(`link: ${held.user.name} (${held.user.id}) linked a copy of the suite`);
    return { token, user: held.user };
  }

  /** Whose token this is, if it is one. */
  userFor(token: string): LinkedUser | null {
    if (token === '') return null;
    const hash = sha256(token);
    const row = this.db.prepare('SELECT user_id, user_name FROM app_link WHERE token_hash = ?').get(hash) as
      | { user_id: string; user_name: string }
      | undefined;
    if (row === undefined) return null;

    this.db.prepare('UPDATE app_link SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), hash);
    return { id: row.user_id, name: row.user_name };
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM app_link WHERE token_hash = ?').run(sha256(token));
  }

  /** Every channel this person could post a plan in, by server. */
  async postable(userId: string): Promise<LinkGuild[]> {
    const guilds: LinkGuild[] = [];

    for (const { guild, member } of await this.memberships(userId)) {
      const me = guild.members.me;
      if (me === null) continue;

      const channels = [...guild.channels.cache.values()]
        .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
        .filter(
          (channel) =>
            channel.permissionsFor(member).has(MEMBER_NEEDS) && channel.permissionsFor(me).has(BOT_NEEDS),
        )
        // The order the server's own channel list shows them in.
        .sort(
          (a, b) =>
            (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition,
        )
        .map((channel) => ({ id: channel.id, name: channel.name, category: channel.parent?.name ?? null }));

      guilds.push({ id: guild.id, name: guild.name, channels });
    }

    return guilds.sort((a, b) => a.name.localeCompare(b.name));
  }

  async canPost(userId: string, channelId: string): Promise<boolean> {
    const guilds = await this.postable(userId);
    return guilds.some((guild) => guild.channels.some((channel) => channel.id === channelId));
  }

  /**
   * The servers this bot is in that the person is in too.
   *
   * Fetched fresh each time. Without the members intent nothing tells the
   * cache that someone lost a role or left, and this is the permission check.
   */
  private async memberships(userId: string): Promise<{ guild: Guild; member: GuildMember }[]> {
    const found: { guild: Guild; member: GuildMember }[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
      if (member !== null) found.push({ guild, member });
    }
    return found;
  }

  /** Trades Discord's code for who signed in, then gives the access back. */
  private async identify(code: string): Promise<LinkedUser | null> {
    const credentials = { client_id: this.appId, client_secret: this.clientSecret };

    const exchange = await this.fetchImpl(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...credentials,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!exchange.ok) {
      log.warn(`link: Discord refused the code (${exchange.status})`);
      return null;
    }
    const { access_token: access } = (await exchange.json()) as { access_token?: unknown };
    if (typeof access !== 'string') return null;

    const who = await this.fetchImpl(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15_000),
    });

    // Nothing after this needs to act as the user, so do not keep the means to.
    void this.fetchImpl(`${DISCORD_API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...credentials, token: access }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);

    if (!who.ok) return null;
    const profile = (await who.json()) as { id?: unknown; username?: unknown; global_name?: unknown };
    if (typeof profile.id !== 'string' || !/^\d{5,25}$/.test(profile.id)) return null;

    const name =
      typeof profile.global_name === 'string' && profile.global_name.trim() !== ''
        ? profile.global_name
        : typeof profile.username === 'string'
          ? profile.username
          : 'Unknown';
    return { id: profile.id, name: name.slice(0, 80) };
  }
}
