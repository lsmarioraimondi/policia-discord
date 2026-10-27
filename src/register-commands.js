'use strict';

require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { loadConfig } = require('./config');
const { buildCommandJSON } = require('./discord/commands');

/** Registra (reemplaza) los slash commands SOLO en el servidor configurado. */
async function main() {
  const config = loadConfig(process.env, { needRuntime: false });
  const body = buildCommandJSON();
  const rest = new REST({ version: '10' }).setToken(config.token);
  const result = await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  console.log(`Comandos registrados en el servidor ${config.guildId}: ${result.map((c) => `/${c.name}`).join(', ')}`);
}

main().catch((err) => {
  // Nunca imprimir el token: solo el mensaje del error.
  console.error(`No se pudieron registrar los comandos: ${err.message}`);
  process.exit(1);
});
