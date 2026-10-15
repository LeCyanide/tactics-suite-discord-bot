/**
 * Everything the bot reads from its environment, read once at startup.
 *
 * A missing required value stops the process with a message naming it,
 * rather than failing later on the first sign-in.
 */

import { existsSync } from 'node:fs';
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
   * Certificate and key files, when the bot serves HTTPS itself. Null when a
   * reverse proxy in front does it, which is the usual case.
   */
  readonly tls: { readonly cert: string; readonly key: string } | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function tlsFiles(): Config['tls'] {
  const cert = process.env.TLS_CERT_FILE?.trim() || '';
  const key = process.env.TLS_KEY_FILE?.trim() || '';
  if (cert === '' && key === '') return null;
  if (cert === '' || key === '') {
    log.error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.');
    process.exit(1);
  }
  for (const file of [cert, key]) {
    if (!existsSync(file)) {
      log.error(`${file} does not exist (from TLS_CERT_FILE / TLS_KEY_FILE).`);
      process.exit(1);
    }
  }
  return { cert, key };
}

export function loadConfig(): Config {
  // Bot hosting panels start `node index.js` with no --env-file, so a .env
  // beside it is read here. Values already in the environment win.
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env: everything comes from the environment */
  }

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
    tls: tlsFiles(),
  };
}
