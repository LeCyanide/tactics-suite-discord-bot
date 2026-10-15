/**
 * Entry point. Opens the database, connects to Discord, and serves the
 * endpoints the suite talks to.
 *
 * It exists so that a copy of the suite can sign in with Discord and post a
 * plan into a channel, only ever where the person sharing could post
 * themselves. Its one slash command, /release, posts the suite's patch notes.
 * It reads no messages.
 */

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { release } from './commands/release.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { startHttpServer } from './http.ts';
import { log } from './log.ts';

/** View Channel, Send Messages, Embed Links and Attach Files: what a plan post needs. */
const INVITE_PERMISSIONS = 1024 + 2048 + 16384 + 32768;

const config = loadConfig();
const db = openDatabase(config.dbPath);

// Guilds is the only intent: it keeps servers and channels cached for the
// permission checks. Members are fetched one at a time when someone signs in
// or shares, which needs no privileged intent.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  log.info(`connected as ${ready.user.tag} (${ready.user.id})`);

  // Registered on every start, globally, so there is no separate step and
  // every server the bot is in has it. Setting the same list again is a no-op.
  try {
    await ready.application.commands.set([release.data.toJSON()]);
  } catch (error) {
    log.error('could not register /release', error);
  }

  for (const guild of ready.guilds.cache.values()) {
    log.info(`serving ${guild.name} (${guild.id})`);
  }

  if (client.guilds.cache.size === 0) {
    const invite = new URL('https://discord.com/oauth2/authorize');
    invite.search = new URLSearchParams({
      client_id: config.appId,
      scope: 'bot',
      permissions: String(INVITE_PERMISSIONS),
    }).toString();
    log.info(`not in any server yet. Add it with: ${invite.toString()}`);
  }
});

client.on(Events.GuildCreate, (guild) => {
  log.info(`added to ${guild.name} (${guild.id})`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== release.data.name) return;
  try {
    await release.execute(interaction, config);
  } catch (error) {
    // Without this the person sees only "The application did not respond".
    log.error('/release failed', error);
    const body = { content: 'That did not work. The error has been logged.', flags: MessageFlags.Ephemeral } as const;
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(body);
      else await interaction.reply(body);
    } catch (nested) {
      log.error('could not report the failure', nested);
    }
  }
});

const http = startHttpServer(client, config, db);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`${signal} received, shutting down`);
  http.close();
  await client.destroy();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  log.error('uncaught exception; exiting so the supervisor restarts it', error);
  process.exit(1);
});

await client.login(config.token);
