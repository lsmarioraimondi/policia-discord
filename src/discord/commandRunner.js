'use strict';

const { levelByCommand, hasPermissionLevel } = require('./commands');
const { messages, replies, formatStatus } = require('../messages');

const MAX_REPLY = 1900;

function truncate(text) {
  return text.length <= MAX_REPLY ? text : `${text.slice(0, MAX_REPLY)}\n… (respuesta recortada)`;
}

const reply = (code) => replies[code] ?? replies.INTERNAL;

function announcedNote(res) {
  return res.announced === false ? '\n⚠️ No pude publicar el anuncio en el canal configurado (revisá los permisos del bot).' : '';
}

/**
 * Lógica de cada slash command, independiente de discord.js (recibe datos simples y
 * devuelve el texto de la respuesta efímera). Así es totalmente testeable.
 *
 * @param {object} input
 * @param {string} input.name           nombre del comando
 * @param {string} input.guildId        servidor de la interacción
 * @param {string} input.userId         quien ejecuta
 * @param {{has(flag: bigint): boolean}|null} input.permissions  permisos del ejecutor
 * @param {{ id: string, bot: boolean, isMember: boolean }} [input.target]  opción `usuario`
 */
async function runCommand(input, service, config) {
  const { name, guildId, userId, permissions, target } = input;
  if (guildId !== config.guildId) return reply('WRONG_GUILD');
  if (!(name in levelByCommand)) return reply('INTERNAL');
  if (!hasPermissionLevel(permissions, levelByCommand[name])) return reply('NO_PERMISSION');

  switch (name) {
    case 'policia-iniciar': {
      if (!target.isMember) return reply('NOT_IN_GUILD');
      const res = await service.startPatrol({ by: userId, targetId: target.id, targetIsBot: target.bot });
      if (!res.ok) return reply(res.code);
      return `🚔 Patrulla iniciada. ${messages.user(target.id)}: ${messages.describeMute(res.mute)}.${announcedNote(res)}`;
    }
    case 'vigilar': {
      if (!target.isMember) return reply('NOT_IN_GUILD');
      const res = await service.watch({ by: userId, targetId: target.id, targetIsBot: target.bot });
      if (!res.ok) return reply(res.code);
      return `👀 ${messages.user(target.id)} agregado a la patrulla: ${messages.describeMute(res.mute)}.${announcedNote(res)}`;
    }
    case 'dejar-vigilar': {
      const res = await service.unwatch({ by: userId, targetId: target.id });
      if (!res.ok) return reply(res.code);
      return `🟢 ${messages.user(target.id)} ya no está vigilado.${announcedNote(res)}`;
    }
    case 'policia-finalizar': {
      const res = await service.finalize({ by: userId });
      if (!res.ok) return reply(res.code);
      return `🏁 Patrulla finalizada.${announcedNote(res.summary)}`;
    }
    case 'policia-estado':
      return truncate(formatStatus(await service.getStatus()));
    case 'pedir-palabra': {
      const res = await service.requestFloor({ userId });
      if (!res.ok) return reply(res.code);
      const warn = res.reactionsFailed
        ? '\n⚠️ No pude agregar las reacciones automáticamente; agregá ✅ y ❌ a mano en el mensaje.'
        : '';
      return `🗳️ Solicitud publicada en <#${config.votingChannelId}>. Votan ${res.poll.roster.length} persona(s) de tu canal.${warn}`;
    }
    default:
      return reply('INTERNAL');
  }
}

module.exports = { runCommand };
