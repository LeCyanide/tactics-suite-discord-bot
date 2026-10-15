import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { fetchPatchNotes, releaseMessages, rolePing } from '../release.ts';

/**
 * Posts the suite's latest patch notes in the channel the command is used
 * in. The channel is whichever one the person is standing in, so there is no
 * channel id to configure anywhere.
 *
 * Limited to people who can manage messages by default, since it posts for
 * everyone to see and can ping a role; a server can widen that under
 * Integrations.
 */
export const release = {
  data: new SlashCommandBuilder()
    .setName('release')
    .setDescription('Post the latest suite patch notes in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild)
    .addRoleOption((o) => o.setName('ping').setDescription('A role to ping with the notes').setRequired(false)),

  async execute(interaction: ChatInputCommandInteraction, config: Config): Promise<void> {
    const { updateUrl, updateToken } = config;
    if (updateUrl === null || updateToken === null) {
      await interaction.reply({
        content: 'Patch notes are not set up: UPDATE_URL and UPDATE_TOKEN are missing from my .env.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Privately at first, so a failure is told to the person who asked and
    // not to the whole channel.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let notes;
    try {
      notes = await fetchPatchNotes(updateUrl, updateToken);
    } catch (error) {
      log.warn(`/release could not fetch the patch notes: ${error instanceof Error ? error.message : String(error)}`);
      await interaction.editReply(error instanceof Error ? error.message : 'I could not fetch the patch notes.');
      return;
    }

    const role = interaction.options.getRole('ping');
    const ping = role === null || interaction.guildId === null ? null : rolePing(role.id, interaction.guildId);

    // The first follow-up to a deferred reply takes its place and its
    // privacy, so the private answer is settled before the public post.
    await interaction.editReply(`Posting the patch notes for ${notes.version}.`);

    // Only the chosen role may be pinged, and only by the message that carries
    // it: the notes are text from a file, and an @ in one must stay text.
    const messages = releaseMessages(notes, ping?.content ?? null);
    for (const [at, content] of messages.entries()) {
      const allowedMentions = at === 0 && ping !== null ? ping.allowedMentions : { parse: [] };
      await interaction.followUp({ content, allowedMentions });
    }

    log.info(
      `posted patch notes for ${notes.version} in channel ${interaction.channelId}` +
        (role === null ? '' : `, pinging role ${role.id}`),
    );
  },
};
