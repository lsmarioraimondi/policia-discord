'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');

/**
 * Niveles de permiso (la verificación en tiempo de ejecución es la autoritativa;
 * `setDefaultMemberPermissions` solo oculta el comando en la interfaz para quien no corresponde):
 *  - mod:   MuteMembers o ManageGuild         (vigilar, dejar de vigilar, estado)
 *  - null:  cualquiera                        (pedir la palabra; el núcleo exige que esté vigilado)
 * Quien tenga el permiso global de Administrador pasa todos los niveles automáticamente.
 */
const definitions = [
  {
    name: 'vigilar',
    level: 'mod',
    build: (b) =>
      b
        .setDescription('Propone vigilar (castigar temporalmente) a un usuario conectado a voz; se vota')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a vigilar').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),
  },
  {
    name: 'dejar-vigilar',
    level: 'mod',
    build: (b) =>
      b
        .setDescription('Propone terminar antes de tiempo la vigilancia de un usuario; se vota')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a dejar de vigilar').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),
  },
  {
    name: 'policia-estado',
    level: 'mod',
    build: (b) =>
      b
        .setDescription('Muestra las vigilancias activas, sus vencimientos y las votaciones pendientes')
        .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),
  },
  {
    name: 'pedir-palabra',
    level: null,
    build: (b) => b.setDescription('Pide autorización para hablar (votan quienes están en tu canal de voz)'),
  },
];

function buildCommandJSON() {
  return definitions.map((def) => {
    const builder = new SlashCommandBuilder().setName(def.name).setContexts([InteractionContextType.Guild]);
    return def.build(builder).toJSON();
  });
}

const levelByCommand = Object.fromEntries(definitions.map((d) => [d.name, d.level]));

/** @param {{ has(flag: bigint): boolean } | null} permissions */
function hasPermissionLevel(permissions, level) {
  if (level === null) return true;
  if (!permissions) return false;
  return permissions.has(PermissionFlagsBits.MuteMembers) || permissions.has(PermissionFlagsBits.ManageGuild);
}

module.exports = { definitions, buildCommandJSON, levelByCommand, hasPermissionLevel };
