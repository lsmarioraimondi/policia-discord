'use strict';

const { Events, MessageFlags } = require('discord.js');
const { runCommand } = require('./commandRunner');
const { replies } = require('../messages');

/** Conecta los eventos de discord.js con el núcleo. Ningún handler deja una promesa sin capturar. */
function registerHandlers({ client, service, config, logger }) {
  const guard = (label, promise) => promise.catch((err) => logger.error(`Error en ${label}:`, err));

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    guard(`comando ${interaction.commandName}`, handleCommand(interaction, service, config, logger));
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (newState.guild.id !== config.guildId) return;
    guard(
      'voiceStateUpdate',
      service.onVoiceStateUpdate({
        userId: newState.id,
        oldChannelId: oldState.channelId ?? null,
        newChannelId: newState.channelId ?? null,
        oldMute: typeof oldState.serverMute === 'boolean' ? oldState.serverMute : null,
        newMute: typeof newState.serverMute === 'boolean' ? newState.serverMute : null,
      }),
    );
  });

  const onReaction = (reaction, user) => {
    if (user.bot) return; // incluye las reacciones del propio bot
    if (reaction.message.channelId !== config.votingChannelId) return;
    guard('reacción', service.onReactionChange(reaction.message.id));
  };
  client.on(Events.MessageReactionAdd, onReaction);
  client.on(Events.MessageReactionRemove, onReaction);

  client.on(Events.MessageDelete, (message) => {
    if (message.channelId !== config.votingChannelId) return;
    guard('messageDelete', service.onMessageDeleted(message.id));
  });
  client.on(Events.MessageBulkDelete, (messages) => {
    for (const id of messages.keys()) guard('messageDeleteBulk', service.onMessageDeleted(id));
  });
}

async function handleCommand(interaction, service, config, logger) {
  const name = interaction.commandName;
  if (interaction.guildId !== config.guildId) {
    return interaction.reply({ content: replies.WRONG_GUILD, flags: MessageFlags.Ephemeral });
  }
  // Discord exige responder en 3 s; las operaciones pueden tardar más (mutex + API), por eso se difiere.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let text;
  try {
    const user = interaction.options.getUser('usuario');
    const member = user ? interaction.options.getMember('usuario') : null;
    text = await runCommand(
      {
        name,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        permissions: interaction.memberPermissions,
        target: user ? { id: user.id, bot: user.bot, isMember: !!member } : undefined,
      },
      service,
      config,
    );
  } catch (err) {
    logger.error(`Fallo ejecutando /${name}:`, err);
    text = replies.INTERNAL;
  }
  await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
}

module.exports = { registerHandlers };
