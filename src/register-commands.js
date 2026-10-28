'use strict';

require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { loadConfig } = require('./config');
const { buildCommandJSON } = require('./discord/commands');

/**
 * Registra los slash commands SOLO en el servidor configurado. `PUT` reemplaza el conjunto completo:
 * cualquier comando que ya no exista en el código (p. ej. /policia-iniciar y /policia-finalizar, de cuando
 * había una patrulla general) queda eliminado de Discord. Se informa qué se agregó, qué se quitó y si
 * hay comandos globales de esta aplicación (el bot no usa comandos globales).
 */
async function main() {
  const config = loadConfig(process.env, { needRuntime: false });
  const body = buildCommandJSON();
  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);

  const before = await rest.get(route);
  const result = await rest.put(route, { body });

  const names = (list) => list.map((c) => `/${c.name}`);
  const kept = new Set(result.map((c) => c.name));
  const removed = before.filter((c) => !kept.has(c.name));
  console.log(`Comandos registrados en el servidor ${config.guildId}: ${names(result).join(', ')}`);
  if (removed.length) console.log(`Comandos eliminados (ya no existen en el código): ${names(removed).join(', ')}`);

  const globals = await rest.get(Routes.applicationCommands(config.clientId));
  if (globals.length) {
    console.warn(
      `Atención: esta aplicación tiene comandos GLOBALES (${names(globals).join(', ')}) que el bot no gestiona. ` +
        'Si quedaron de pruebas anteriores, eliminalos desde el Developer Portal o con la API.',
    );
  }
}

main().catch((err) => {
  // Nunca imprimir el token: solo el mensaje del error.
  console.error(`No se pudieron registrar los comandos: ${err.message}`);
  process.exit(1);
});
