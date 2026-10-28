'use strict';

const { levelByCommand, hasPermissionLevel } = require('./commands');
const { messages, replies, formatStatus } = require('../messages');

const MAX_REPLY = 1900;

function truncate(text) {
  return text.length <= MAX_REPLY ? text : `${text.slice(0, MAX_REPLY)}\n… (respuesta recortada)`;
}

const reply = (code) => replies[code] ?? replies.INTERNAL;

/** Respuesta de una solicitud que publicó una votación. */
function pollReply(label, res, config, tail = ' La acción ocurre solo si se aprueba.') {
  const warn = res.reactionsFailed
    ? '\n⚠️ No pude agregar las reacciones automáticamente; agregá ✅ y ❌ a mano en el mensaje.'
    : '';
  return `🗳️ ${label} publicada en <#${config.votingChannelId}>. Votan ${res.poll.roster.length} persona(s).${tail}${warn}`;
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
    case 'vigilar': {
      if (!target.isMember) return reply('NOT_IN_GUILD');
      const res = await service.requestWatch({ by: userId, targetId: target.id, targetIsBot: target.bot });
      return res.ok ? pollReply(`Votación para vigilar a ${messages.user(target.id)}`, res, config) : reply(res.code);
    }
    case 'dejar-vigilar': {
      const res = await service.requestUnwatch({ by: userId, targetId: target.id });
      return res.ok ? pollReply(`Votación para dejar de vigilar a ${messages.user(target.id)}`, res, config) : reply(res.code);
    }
    case 'policia-estado':
      return truncate(formatStatus(await service.getStatus()));
    case 'pedir-palabra': {
      const res = await service.requestFloor({ userId });
      return res.ok ? pollReply('Solicitud', res, config, '') : reply(res.code);
    }
    default:
      return reply('INTERNAL');
  }
}

module.exports = { runCommand };
