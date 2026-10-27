'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');

/**
 * Niveles de permiso (la verificación en tiempo de ejecución es la autoritativa;
 * `setDefaultMemberPermissions` solo oculta el comando en la interfaz para quien no corresponde):
 *  - admin: ManageGuild                       (iniciar / finalizar patrulla)
 *  - mod:   MuteMembers o ManageGuild         (vigilar, dejar de vigilar, estado)
 *  - null:  cualquiera                        (pedir la palabra; el núcleo exige que esté vigilado)
 * Quien tenga el permiso global de Administrador pasa todos los niveles automáticamente.
 */
const definitions = [
  {
    name: 'policia-iniciar',
    level: 'admin',
    build: (b) =>
      b
        .setDescription('Inicia una patrulla vigilando a un usuario')
        .addUserOption((o) => o.setName('usuario').setDescription('Primer usuario a vigilar').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  },
  {
    name: 'vigilar',
    level: 'mod',
    build: (b) =>
      b
        .setDescription('Agrega un usuario a la patrulla activa')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a vigilar').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),
  },
  {
    name: 'dejar-vigilar',
    level: 'mod',
    build: (b) =>
      b
        .setDescription('Quita a un usuario de la patrulla')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a dejar de vigilar').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),
  },
  {
    name: 'policia-finalizar',
    level: 'admin',
    build: (b) =>
      b.setDescription('Finaliza la patrulla y deja de vigilar a todos').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  },
  {
    name: 'policia-estado',
    level: 'mod',
    build: (b) =>
      b
        .setDescription('Muestra el estado de la patrulla')
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
  if (level === 'admin') return permissions.has(PermissionFlagsBits.ManageGuild);
  return permissions.has(PermissionFlagsBits.MuteMembers) || permissions.has(PermissionFlagsBits.ManageGuild);
}

module.exports = { definitions, buildCommandJSON, levelByCommand, hasPermissionLevel };
