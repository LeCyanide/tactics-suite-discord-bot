/**
 * Everything the bot reads from its environment, read once at startup.
 *
 * A missing required value stops the process with a message naming it,
 * rather than failing later on the first sign-in.
 */

import { log } from './log.ts';

export interface Config {
  /** The bot token, from the application's Bot tab. */
  readonly token: string;
  /** The application id, from its General Information tab. */
  readonly appId: string;
  /** The OAuth2 client secret, which the Connect Discord sign-in needs. */
  readonly clientSecret: string;
  /** Where the bot is reached from outside, with no path: https://bot.example.com */
  readonly publicUrl: string;
  readonly dbPath: string;
  readonly httpPort: number;
  readonly httpHost: string;
  /**
   * The suite's update server, where /release reads the patch notes. Both
   * null leaves /release answering that it is not set up.
   */
  readonly updateUrl: string | null;
  readonly updateToken: string | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  const publicUrl = required('PUBLIC_URL').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    log.error(`PUBLIC_URL is not an address: ${publicUrl}`);
    process.exit(1);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    // The app's link token travels to this address. Over plain HTTP anyone
    // on the way could read it and post as that person.
    log.error('PUBLIC_URL must start with https:// (plain http is only allowed for localhost)');
    process.exit(1);
  }

  return {
    token: required('DISCORD_TOKEN'),
    appId: required('DISCORD_APP_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
    publicUrl,
    dbPath: process.env.DB_PATH?.trim() || './data/bot.db',
    httpPort: Number(process.env.HTTP_PORT?.trim() || 8787),
    // Meant to sit behind a reverse proxy that terminates TLS, so by default
    // it is not reachable from anywhere else. The Docker image sets 0.0.0.0.
    httpHost: process.env.HTTP_HOST?.trim() || '127.0.0.1',
    updateUrl: process.env.UPDATE_URL?.trim() || null,
    updateToken: process.env.UPDATE_TOKEN?.trim() || null,
  };
}
